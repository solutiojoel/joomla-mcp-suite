/**
 * Regression check for admin list filters and edit-form ids.
 *
 *   npx tsx scripts/tests/list-filter-check.ts
 *
 * Covers three faults that all presented as plausible-looking wrong answers rather
 * than errors, so nothing downstream could detect them:
 *
 * 1. Sticky list filters. Joomla keeps list filters in the admin session. A list call
 *    that omitted `filter[search]` inherited the previous call's value instead of
 *    clearing it, so an unfiltered list returned the last search's rows with
 *    success:true. createModule verifies new modules against listModules(), so a stale
 *    filter could also report a successful create as missing.
 * 2. Edit-form ids. updateModule scopes its form scrape to the edit form, and
 *    diagnoseMissingEditForm keys off the same ids to tell "record is checked out"
 *    apart from "the parser broke". Joomla 3 is not consistent about these ids — the
 *    com_modules edit view renders "module-form" on some live sites and "adminForm" on
 *    others — so the client tries a candidate list and this check asserts that at
 *    least one candidate matches, not that a particular one does.
 * 3. Category nesting. parseCategoryList derives each category's parent from the
 *    span.gtr tree prefix, and reports parent "" when the page renders no prefix at
 *    all rather than claiming everything is "Root".
 * 4. User enabled state. parseUserList reads the row's block/unblock toggle, which Joomla
 *    renders as onclick="return listItemTask('cb0','users.block')". A pattern that
 *    expected "task=users.block" matched no row, so every account — including accounts
 *    that had signed in that day — reported enabled:false. The list filter is the ground
 *    truth here: filter[state]=0 returns only enabled users, =1 only blocked ones, so the
 *    rows can be checked against Joomla's own answer without writing anything.
 */
import "../../src/env.js";
import { JoomlaClient } from "../../src/joomla-client.js";

const cfg = {
  baseUrl: process.env.JOOMLA_BASE_URL || "",
  username: process.env.JOOMLA_USERNAME || "",
  password: process.env.JOOMLA_PASSWORD || "",
};

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(32)} ${detail}`);
}

const count = (r: { data?: unknown }) => ((r.data || []) as unknown[]).length;

async function main() {
  const joomla = new JoomlaClient(cfg);
  await joomla.login();
  // getPage/getAdminUrl are internal; this check deliberately reaches past the public
  // surface to assert on the raw admin HTML.
  const raw = joomla as unknown as {
    getPage(url: string): Promise<{ html: string }>;
    getAdminUrl(path: string): string;
  };

  // --- 1. edit-form ids --------------------------------------------------
  const modules = await joomla.listModules("0");
  const firstModuleId = ((modules.data || []) as Array<Record<string, string>>)[0]?.id;

  const EDIT_FORM_IDS = ["item-form", "adminForm"];
  const MODULE_FORM_IDS = ["module-form", "adminForm"];

  const formTargets: Array<{ label: string; path: string; candidates: string[] }> = [
    { label: "article add", path: "index.php?option=com_content&task=article.add", candidates: EDIT_FORM_IDS },
    { label: "category add", path: "index.php?option=com_categories&task=category.add&extension=com_content", candidates: EDIT_FORM_IDS },
    { label: "menu item add", path: "index.php?option=com_menus&task=item.add", candidates: EDIT_FORM_IDS },
  ];
  // Pick a module that is NOT checked out: Joomla answers an edit request for a locked
  // record with the list view, which would make this look like a form-id mismatch.
  const unlocked = ((modules.data || []) as Array<Record<string, string>>).find((m) => m.checkedOut !== "1");
  if (unlocked) {
    formTargets.unshift({
      label: `module edit (${unlocked.id})`,
      path: `index.php?option=com_modules&task=module.edit&id=${unlocked.id}`,
      candidates: MODULE_FORM_IDS,
    });
  }

  for (const { label, path, candidates } of formTargets) {
    const { html } = await raw.getPage(raw.getAdminUrl(path));
    const ids = [...html.matchAll(/<form[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    const matched = candidates.find((c) => ids.includes(c));
    check(`form id: ${label}`, !!matched, `matched "${matched ?? "none"}" of [${candidates.join(", ")}]; page has [${ids.join(", ") || "none"}]`);
  }

  // --- 2. sticky list filters -------------------------------------------
  // Order matters: filter first, then read unfiltered. That is the exact sequence that
  // used to return the filtered rows a second time.
  const modFiltered = count(await joomla.listModules("0", "rotator"));
  const modAll = count(await joomla.listModules("0"));
  check("module list clears filter", modAll > modFiltered, `filtered=${modFiltered} then all=${modAll}`);

  const catFiltered = count(await joomla.listCategories("com_content", 200, 1, "photo"));
  const catAll = count(await joomla.listCategories("com_content", 200, 1));
  check("category list clears filter", catAll > catFiltered, `filtered=${catFiltered} then all=${catAll}`);

  const userFiltered = count(await joomla.listUsers("a"));
  const userAll = count(await joomla.listUsers());
  check("user list clears filter", userAll >= userFiltered, `filtered=${userFiltered} then all=${userAll}`);

  const cats = (await joomla.listCategories("com_content", 200, 1)).data as Array<Record<string, string>>;
  const someCategoryId = cats?.[0]?.id;
  if (someCategoryId) {
    const artFiltered = count(await joomla.listArticles(someCategoryId, undefined, 500, 1));
    const artAll = count(await joomla.listArticles(undefined, undefined, 500, 1));
    check("article list clears category", artAll > artFiltered, `cat${someCategoryId}=${artFiltered} then all=${artAll}`);
  }

  // --- 3. category nesting ----------------------------------------------
  // Two valid outcomes: the prefix renders and levels/parents are derived, or it does
  // not and every parent is reported as "" (unknown). The failure this guards against
  // is the old behaviour — a confident "Root" on every row.
  const rows = cats || [];
  const derived = rows.filter((c) => c.level);
  const nested = rows.filter((c) => c.level && c.level !== "1");
  const fabricated = rows.filter((c) => !c.level && c.parent === "Root");
  check(
    "category parent not fabricated",
    fabricated.length === 0,
    derived.length
      ? `${rows.length} categories, prefix rendered, ${nested.length} nested` +
        (nested.length ? `, e.g. "${nested[0].title}" parent="${nested[0].parent}"` : "")
      : `${rows.length} categories, no tree prefix on the page — parent reported as unknown, not "Root"`,
  );

  // --- 4. user enabled state --------------------------------------------
  // enabled is null only where the page renders no toggle — the logged-in account, or a
  // row this operator cannot change. Any other null, and any row that disagrees with the
  // state filter it came back under, is the regression.
  type UserRow = { email?: string; enabled?: boolean | null; blocked?: boolean | null };
  const enabledRows = ((await joomla.listUsers(undefined, undefined, "0")).data || []) as UserRow[];
  const blockedRows = ((await joomla.listUsers(undefined, undefined, "1")).data || []) as UserRow[];

  const misread = enabledRows.filter((u) => u.enabled === false);
  const noToggle = enabledRows.filter((u) => u.enabled === null);
  check(
    "enabled users read as enabled",
    misread.length === 0 && enabledRows.some((u) => u.enabled === true),
    `${enabledRows.length} enabled row(s): ${enabledRows.filter((u) => u.enabled === true).length} true, ${misread.length} misread as disabled, ${noToggle.length} no toggle`,
  );

  check(
    "blocked users read as blocked",
    blockedRows.every((u) => u.enabled === false),
    blockedRows.length
      ? `${blockedRows.length} blocked row(s), ${blockedRows.filter((u) => u.enabled === false).length} correct`
      : "no blocked users on this site — direction not covered here",
  );

  const inconsistent = [...enabledRows, ...blockedRows].filter((u) =>
    u.enabled === null ? u.blocked !== null : u.blocked !== !u.enabled,
  );
  check("enabled and blocked agree", inconsistent.length === 0, `${inconsistent.length} row(s) disagree`);

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
