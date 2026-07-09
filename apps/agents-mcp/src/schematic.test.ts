// Content Schematic derive/merge + validator tests against the REAL
// implementation (schematic.ts / schematic-validator.ts).
// Run: npx tsx src/schematic.test.ts   (or: npm test)
//
// (apps/orchestrator/test-content-schematic.cjs is the dep-free fixture net
// for the schema file + intra-lint mirror; cross-lint and merge semantics are
// tested here where the real code can be imported.)

import {
  collectContentNodes,
  collectExcludedNodes,
  deriveContentSchematic,
  ContentSchematic,
} from "./schematic.js";
import { validateSchematic, diffNodeKeys } from "./schematic-validator.js";

let failures = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err: any) {
    failures++;
    console.error(`FAIL  ${label} — ${err.message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Representative spec: headings, single articles, a grid with members, the
// heading-with-grid edge case, docman, external/alias skipped, hiddenmenu.
const SPEC: Record<string, unknown> = {
  site: "https://stmarys.org",
  source: "StMarys-Menu.pdf",
  menus: {
    mainmenu: [
      {
        title: "About Us",
        type: "heading",
        children: [
          {
            title: "Welcome",
            type: "single_article",
            category: "Page Content",
            content_source: "generate",
            notes: "principal retiring",
          },
          { title: "Our Staff", type: "category_grid", category: "Staff Items", content_source: "pull" },
        ],
      },
      {
        // heading that is also a grid landing page (grids entry names it via menu_ref)
        title: "Ministries",
        type: "heading",
        children: [{ title: "Volunteer", type: "single_article", content_source: "pull" }],
      },
      { title: "Bulletins", type: "docman", notes: "weekly bulletins" },
      { title: "Blog", type: "category_blog", category: "News", content_source: "existing" },
      { title: "Diocese", type: "external_url", target: "https://dio.example.org", content_source: "redirect" },
    ],
    hiddenmenu: [{ title: "Give", type: "external_url", target: "TBD", content_source: "redirect" }],
  },
  grids: [
    {
      page: "Our Staff",
      menu_ref: "Our Staff",
      type: "category_grid",
      category: "Staff Items",
      particle: "joomla_articles",
      member_menu_items: "none",
      members: ["Fr. John", "Jane Smith"],
    },
    {
      page: "Ministries",
      menu_ref: "Ministries",
      type: "category_grid",
      category: "Ministries Items",
      particle: "joomla_articles",
      member_menu_items: "none",
      members: ["Choir"],
    },
  ],
  open_questions: ["Give target URL?"],
};

console.log("— collectContentNodes —");

const nodes = collectContentNodes(SPEC);
const byKey = new Map(nodes.map((n) => [n.node_key, n]));

check("single_article emitted with category + path", () => {
  const n = byKey.get("mainmenu:About Us/Welcome");
  assert(!!n, "missing Welcome entry");
  assert(n!.kind === "single_article", `kind ${n!.kind}`);
  assert(n!.category === "Page Content", `category ${n!.category}`);
  assert(n!.menu_path === "About Us / Welcome", `menu_path ${n!.menu_path}`);
  assert(n!.spec_notes === "principal retiring", `spec_notes ${n!.spec_notes}`);
});

check("category_grid node emitted once, as grid_landing in Page Content", () => {
  const n = byKey.get("mainmenu:About Us/Our Staff");
  assert(!!n, "missing Our Staff entry");
  assert(n!.kind === "grid_landing", `kind ${n!.kind}`);
  assert(n!.category === "Page Content", `landing goes in Page Content, got ${n!.category}`);
  assert(nodes.filter((x) => x.title === "Our Staff").length === 1, "double-emitted");
});

check("heading named by a grid menu_ref becomes grid_landing", () => {
  const n = byKey.get("mainmenu:Ministries");
  assert(!!n, "missing Ministries entry");
  assert(n!.kind === "grid_landing", `kind ${n!.kind}`);
});

check("grid members emitted in the grid's category", () => {
  const n = byKey.get("grid:Our Staff/Jane Smith");
  assert(!!n, "missing member entry");
  assert(n!.kind === "grid_member", `kind ${n!.kind}`);
  assert(n!.category === "Staff Items", `category ${n!.category}`);
  assert(n!.content_source === "pull", `member inherits grid landing content_source, got ${n!.content_source}`);
});

check("docman emitted as blocked; category_blog as category_landing", () => {
  const d = byKey.get("mainmenu:Bulletins");
  assert(d?.kind === "docman" && d.status === "blocked", `docman: ${d?.kind}/${d?.status}`);
  const b = byKey.get("mainmenu:Blog");
  assert(b?.kind === "category_landing", `blog kind ${b?.kind}`);
});

check("heading-without-grid, external_url, alias, hiddenmenu external all skipped", () => {
  assert(!byKey.has("mainmenu:About Us"), "plain heading emitted");
  assert(!byKey.has("mainmenu:Diocese"), "external_url emitted");
  assert(!byKey.has("hiddenmenu:Give"), "hidden external emitted");
});

check("collectExcludedNodes lists exactly the intentionally skipped pages", () => {
  const excluded = collectExcludedNodes(SPEC);
  const titles = excluded.map((n) => n.title);
  assert(titles.includes("About Us"), "plain heading missing");
  assert(titles.includes("Diocese"), "external_url missing");
  assert(titles.includes("Give"), "hidden external missing");
  assert(!titles.includes("Ministries"), "grid-ref heading wrongly excluded");
  assert(!titles.includes("Welcome"), "content page wrongly excluded");
});

console.log("— deriveContentSchematic: fresh derive —");

const fresh = deriveContentSchematic(SPEC, null, {
  source: "StMarys-Menu.pdf",
  menu_spec_file: "stmarys-menu-spec.json",
  now: new Date("2026-07-08T12:00:00Z"),
});

check("fresh derive: all entries added, none orphaned, all todo/blocked", () => {
  assert(fresh.changes.added.length === fresh.schematic.entries.length, "added != entries");
  assert(fresh.changes.orphaned.length === 0, "orphaned on fresh derive");
  assert(
    fresh.schematic.entries.every((e) => e.status === "todo" || e.status === "blocked"),
    "non-scaffold status on fresh derive"
  );
});

check("fresh derive passes schema + cross-lint", () => {
  const v = validateSchematic(fresh.schematic as unknown as Record<string, unknown>, SPEC);
  assert(v.valid, [...v.schema_errors, ...v.lint_errors].join("; "));
});

console.log("— deriveContentSchematic: merge —");

// Simulate the content-interpreter filling an entry, then a Phase-3-style edit:
// Welcome removed, a new page added, and Phase 4 stamping article IDs.
const filled: ContentSchematic = JSON.parse(JSON.stringify(fresh.schematic));
const welcome = filled.entries.find((e) => e.node_key === "mainmenu:About Us/Welcome")!;
welcome.instructions = "Write a fresh welcome — principal retiring.";
welcome.status = "filled";
const staffLanding = filled.entries.find((e) => e.node_key === "mainmenu:About Us/Our Staff")!;
staffLanding.instructions = "Intro paragraph above the grid.";
staffLanding.source_url = "https://old.stmarys.org/staff";
staffLanding.status = "filled";

const editedSpec: Record<string, unknown> = JSON.parse(JSON.stringify(SPEC));
const menus = (editedSpec.menus as any).mainmenu;
menus[0].children = menus[0].children.filter((c: any) => c.title !== "Welcome");
menus[0].children.push({ title: "History", type: "single_article", content_source: "pull" });
(editedSpec as any).joomla_ids = {
  articles: { "Our Staff (landing)": 101, "Fr. John": 102, "Jane Smith": 103, History: 104 },
};

const merged = deriveContentSchematic(editedSpec, filled, { now: new Date("2026-07-08T13:00:00Z") });
const mergedByKey = new Map(merged.schematic.entries.map((e) => [e.node_key, e]));

check("merge: removed node goes orphaned, content preserved", () => {
  const e = mergedByKey.get("mainmenu:About Us/Welcome");
  assert(!!e, "orphaned entry dropped");
  assert(e!.status === "orphaned", `status ${e!.status}`);
  assert(e!.instructions === "Write a fresh welcome — principal retiring.", "content lost");
  assert(merged.changes.orphaned.includes("mainmenu:About Us/Welcome"), "not reported orphaned");
});

check("merge: new node appears as todo", () => {
  const e = mergedByKey.get("mainmenu:About Us/History");
  assert(!!e && e.status === "todo", `missing/wrong status`);
  assert(merged.changes.added.includes("mainmenu:About Us/History"), "not reported added");
});

check("merge: filled fields preserved, derive-owned refreshed with article IDs", () => {
  const e = mergedByKey.get("mainmenu:About Us/Our Staff")!;
  assert(e.instructions === "Intro paragraph above the grid.", "instructions lost");
  assert(e.source_url === "https://old.stmarys.org/staff", "source_url lost");
  assert(e.status === "filled", `status ${e.status}`);
  assert(e.joomla_article_id === "101", `landing ID via "(landing)" fallback, got ${e.joomla_article_id}`);
  const m = mergedByKey.get("grid:Our Staff/Jane Smith")!;
  assert(m.joomla_article_id === "103", `member ID ${m.joomla_article_id}`);
});

check("merge: content-build stage fields and 'written'/'done' statuses survive re-derive", () => {
  const staged: ContentSchematic = JSON.parse(JSON.stringify(merged.schematic));
  const w = staged.entries.find((e) => e.node_key === "mainmenu:About Us/Our Staff")!;
  w.source_file = "stmarys-source/02-our-staff.md";
  w.content_file = "stmarys-html/02-our-staff.html";
  w.status = "written";
  const d = staged.entries.find((e) => e.node_key === "mainmenu:About Us/History")!;
  d.content_file = "stmarys-html/03-history.html";
  d.draft = true;
  d.applied_at = "2026-07-09T12:00:00Z";
  d.status = "done";

  const again = deriveContentSchematic(editedSpec, staged, { now: new Date("2026-07-09T13:00:00Z") });
  const byKey2 = new Map(again.schematic.entries.map((e) => [e.node_key, e]));
  const w2 = byKey2.get("mainmenu:About Us/Our Staff")!;
  assert(w2.source_file === "stmarys-source/02-our-staff.md", "source_file lost");
  assert(w2.content_file === "stmarys-html/02-our-staff.html", "content_file lost");
  assert(w2.status === "written", `status ${w2.status}`);
  const d2 = byKey2.get("mainmenu:About Us/History")!;
  assert(d2.draft === true, "draft flag lost");
  assert(d2.applied_at === "2026-07-09T12:00:00Z", "applied_at lost");
  assert(d2.status === "done", `status ${d2.status}`);
  const v = validateSchematic(again.schematic as unknown as Record<string, unknown>, editedSpec);
  assert(v.valid, [...v.schema_errors, ...v.lint_errors].join("; "));
});

check("merge result passes cross-lint against the edited spec", () => {
  const v = validateSchematic(merged.schematic as unknown as Record<string, unknown>, editedSpec);
  assert(v.valid, [...v.schema_errors, ...v.lint_errors].join("; "));
});

check("merge is idempotent (re-derive changes nothing)", () => {
  const again = deriveContentSchematic(editedSpec, merged.schematic, { now: new Date("2026-07-08T14:00:00Z") });
  assert(again.changes.added.length === 0, `re-added ${again.changes.added.join(", ")}`);
  assert(again.changes.updated.length === 0, `re-updated ${again.changes.updated.join(", ")}`);
  assert(again.changes.orphaned.length === 0, `re-orphaned ${again.changes.orphaned.join(", ")}`);
});

console.log("— cross-lint catches drift —");

check("stale schematic (missing new node) fails cross-lint", () => {
  const v = validateSchematic(fresh.schematic as unknown as Record<string, unknown>, editedSpec);
  assert(!v.valid, "expected cross-lint errors, got none");
  assert(
    v.lint_errors.some((e) => e.includes("mainmenu:About Us/History")),
    `expected History error, got: ${v.lint_errors.join("; ")}`
  );
});

check("derive-owned field drift fails cross-lint", () => {
  const drifted = JSON.parse(JSON.stringify(merged.schematic));
  drifted.entries.find((e: any) => e.node_key === "grid:Our Staff/Jane Smith").category = "Page Content";
  const v = validateSchematic(drifted, editedSpec);
  assert(v.lint_errors.some((e) => e.includes("re-derive")), `expected drift error, got: ${v.lint_errors.join("; ")}`);
});

console.log("— structure lock (diffNodeKeys) —");

check("added/removed entries are diffed", () => {
  const tampered = JSON.parse(JSON.stringify(fresh.schematic));
  tampered.entries.pop();
  tampered.entries.push({ ...fresh.schematic.entries[0], node_key: "mainmenu:Invented Page" });
  const diff = diffNodeKeys(tampered, fresh.schematic);
  assert(diff.length === 2, `expected 2 diffs, got ${diff.length}: ${diff.join("; ")}`);
});

check("intact structure produces no diff", () => {
  assert(diffNodeKeys(filled, fresh.schematic).length === 0, "false positive diff");
});

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
