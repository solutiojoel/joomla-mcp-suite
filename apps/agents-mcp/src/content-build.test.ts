// Content-build pipeline tests — deterministic stages only (fetch/extract,
// URL discovery, batch partitioning, apply) with mocked HTTP + executor.
// Run: npx tsx src/content-build.test.ts   (or: npm test)

import {
  extractPageContent,
  fetchSourceContent,
  discoverSourceUrls,
  matchScore,
  slugify,
} from "./content-fetch.js";
import { partitionWritableEntries, unwritableReason } from "./agents/content-writer.js";
import { applyContent, isPlaceholderContent, Executor } from "./content-apply.js";
import { ContentSchematic, SchematicEntry } from "./schematic.js";

let failures = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${label}`))
    .catch((err) => {
      failures++;
      console.error(`FAIL  ${label} — ${err.message}`);
    });
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Response-shaped mock for the fetch override. */
function mockResponse(body: string, opts: { status?: number; contentType?: string } = {}) {
  return {
    ok: (opts.status ?? 200) < 400,
    status: opts.status ?? 200,
    statusText: opts.status && opts.status >= 400 ? "Error" : "OK",
    headers: { get: () => opts.contentType ?? "text/html; charset=utf-8" },
    text: async () => body,
  };
}
function mockFetch(routes: Record<string, ReturnType<typeof mockResponse>>): typeof fetch {
  return (async (url: any) => {
    const key = String(url);
    if (routes[key]) return routes[key];
    return mockResponse("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

function entry(overrides: Partial<SchematicEntry>): SchematicEntry {
  return {
    node_key: "mainmenu:X",
    kind: "single_article",
    title: "X",
    content_source: "pull",
    status: "filled",
    ...overrides,
  } as SchematicEntry;
}

function schematicOf(entries: SchematicEntry[]): ContentSchematic {
  return { site: "https://stmarys.org", entries, open_questions: [], assumptions: [] };
}

const PAGE_HTML = `<!doctype html><html><head><title>Our History - St Marys</title></head><body>
<nav><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>
<div id="content" class="main">
  <h1>Our History</h1>
  <p>St. Mary's Parish was founded in 1885 by immigrant families who settled along the
  river valley. The first wooden church was built by hand over two summers, and the
  parish school opened its doors in 1902 with three Benedictine sisters teaching
  forty students in a single room.</p>
  <p>The present church was dedicated in 1954 after a decade of fundraising. Its
  stained glass windows were imported from Munich and remain a centerpiece of the
  building today. Contact the office at 555-123-4567 for tours.</p>
  <img src="/images/history/church-1954.jpg" alt="The church in 1954">
  <img src="https://cdn.example.org/window.jpg" alt="Stained glass">
</div>
<footer><p>Copyright 2020 St Marys. <a href="/privacy">Privacy</a></p></footer>
</body></html>`;

async function main() {
  console.log("— extractPageContent —");

  await check("extracts main content to markdown, strips nav/footer chrome", () => {
    const page = extractPageContent(PAGE_HTML, "https://old.stmarys.org/history");
    assert(page.markdown.includes("founded in 1885"), "main text missing");
    assert(page.markdown.includes("dedicated in 1954"), "second paragraph missing");
    assert(!page.markdown.includes("Privacy"), "footer leaked into markdown");
  });

  await check("nav-heavy page with small content: menu excluded, content kept", () => {
    // Models the sksphila.com failure: a huge sitemap-style <ul> of links in a
    // plain <div> (not <nav>) dwarfs the actual page copy.
    const menu =
      "<ul>" +
      Array.from({ length: 80 }, (_, i) => `<li><a href="/page-${i}">Menu Item Number ${i} With Words</a></li>`).join("") +
      "</ul>";
    const html = `<html><head><title>Admissions - St K</title></head><body>
      <div class="sidebar-menu">${menu}</div>
      <main><h2>New Student Enrollment</h2>
      <p>Families interested in enrolling a new student should contact the school
      office to schedule a tour. Applications are accepted beginning in January,
      and placement testing is held each spring.</p></main>
      </body></html>`;
    const page = extractPageContent(html, "https://old.example.org/admissions");
    assert(page.markdown.includes("placement testing"), "content missing");
    assert(!page.markdown.includes("Menu Item Number 40"), "menu leaked into markdown");
  });

  await check("collects absolute image URLs (relative resolved against page)", () => {
    const page = extractPageContent(PAGE_HTML, "https://old.stmarys.org/history");
    assert(
      page.imageUrls.includes("https://old.stmarys.org/images/history/church-1954.jpg"),
      `relative img not resolved: ${page.imageUrls.join(", ")}`
    );
    assert(page.imageUrls.includes("https://cdn.example.org/window.jpg"), "absolute img missing");
  });

  console.log("— slugify / matchScore —");

  await check("slugify normalizes titles for filenames", () => {
    assert(slugify("Fr. José & Staff") === "fr-jose-staff", `got ${slugify("Fr. José & Staff")}`);
    assert(slugify("Mass Times") === "mass-times", `got ${slugify("Mass Times")}`);
  });

  await check("matchScore ranks slug/title overlap", () => {
    assert(matchScore("Our History", "our-history") === 1, "exact slug should be 1.0");
    assert(matchScore("Parish Staff", "staff") === 0.5, "half overlap should be 0.5");
    assert(matchScore("Faith Formation", "contact-us") === 0, "no overlap should be 0");
  });

  console.log("— fetchSourceContent —");

  await check("fetch success writes markdown, stamps source_file + assets", async () => {
    const e = entry({
      node_key: "mainmenu:About/Our History",
      title: "Our History",
      source_url: "https://old.stmarys.org/history",
    });
    const s = schematicOf([e]);
    const files: Record<string, string> = {};
    const report = await fetchSourceContent(s, {
      slug: "stmarys",
      fetchImpl: mockFetch({ "https://old.stmarys.org/history": mockResponse(PAGE_HTML) }),
      writeWorkspaceFile: async (p, c) => {
        files[p] = c;
      },
    });
    assert(report.fetched.length === 1, `fetched ${report.fetched.length}`);
    assert(e.source_file === "stmarys-source/01-our-history.md", `source_file ${e.source_file}`);
    assert(!!files[e.source_file!], "markdown file not written");
    assert(files[e.source_file!].includes("founded in 1885"), "markdown content missing");
    assert((e.assets ?? []).some((a) => a.includes("church-1954.jpg")), "asset not recorded");
    assert(e.status === "filled", "status should not change on success");
  });

  await check("fetch failure flips entry to needs_input with an open question", async () => {
    const e = entry({
      node_key: "mainmenu:Gone",
      title: "Gone Page",
      source_url: "https://old.stmarys.org/gone",
    });
    const s = schematicOf([e]);
    const report = await fetchSourceContent(s, {
      slug: "stmarys",
      fetchImpl: mockFetch({}),
      writeWorkspaceFile: async () => {},
    });
    assert(report.failed.length === 1, "not reported failed");
    assert(e.status === "needs_input", `status ${e.status}`);
    assert(
      (s.open_questions ?? []).some((q) => q.includes("Gone Page")),
      "no open question added"
    );
  });

  await check("already-fetched entries are skipped unless refetch", async () => {
    const e = entry({
      node_key: "mainmenu:Done",
      title: "Done",
      source_url: "https://old.stmarys.org/history",
      source_file: "stmarys-source/01-done.md",
    });
    const s = schematicOf([e]);
    let writes = 0;
    const report = await fetchSourceContent(s, {
      slug: "stmarys",
      fetchImpl: mockFetch({ "https://old.stmarys.org/history": mockResponse(PAGE_HTML) }),
      writeWorkspaceFile: async () => {
        writes++;
      },
    });
    assert(report.skipped.length === 1 && writes === 0, "should skip without refetch");
  });

  await check("generate/todo entries are not fetch candidates", async () => {
    const s = schematicOf([
      entry({ node_key: "a", content_source: "generate", status: "filled" }),
      entry({ node_key: "b", status: "todo", source_url: "https://old.stmarys.org/history" }),
    ]);
    const report = await fetchSourceContent(s, {
      slug: "stmarys",
      fetchImpl: mockFetch({}),
      writeWorkspaceFile: async () => {},
    });
    assert(report.fetched.length === 0 && report.failed.length === 0, "nothing should be attempted");
  });

  console.log("— discoverSourceUrls —");

  const SITEMAP = `<?xml version="1.0"?><urlset>
    <url><loc>https://old.stmarys.org/our-history</loc></url>
    <url><loc>https://old.stmarys.org/parish-staff</loc></url>
    <url><loc>https://old.stmarys.org/contact-us</loc></url>
  </urlset>`;

  await check("sitemap candidates proposed for entries missing a URL", async () => {
    const s = schematicOf([
      entry({ node_key: "mainmenu:Our History", title: "Our History", source_url: "TBD" }),
      entry({ node_key: "mainmenu:Welcome", title: "Welcome", content_source: "generate" }),
    ]);
    const { proposals, source } = await discoverSourceUrls(s, "https://old.stmarys.org", {
      fetchImpl: mockFetch({
        "https://old.stmarys.org/sitemap.xml": mockResponse(SITEMAP, { contentType: "application/xml" }),
      }),
    });
    assert(source === "sitemap", `source ${source}`);
    assert(proposals.length === 1, `generate entry should be excluded; got ${proposals.length}`);
    assert(
      proposals[0].candidates[0]?.url === "https://old.stmarys.org/our-history",
      `top candidate ${proposals[0].candidates[0]?.url}`
    );
  });

  await check("homepage nav fallback when sitemap is missing", async () => {
    const HOME = `<html><body><nav>
      <a href="/our-history">Our History</a>
      <a href="/contact-us">Contact</a>
      <a href="https://elsewhere.org/x">External</a>
    </nav></body></html>`;
    const s = schematicOf([entry({ node_key: "k", title: "Our History", source_url: "TBD" })]);
    const { proposals, source } = await discoverSourceUrls(s, "https://old.stmarys.org", {
      fetchImpl: mockFetch({ "https://old.stmarys.org": mockResponse(HOME) }),
    });
    assert(source === "homepage", `source ${source}`);
    assert(
      proposals[0].candidates[0]?.url === "https://old.stmarys.org/our-history",
      "nav link not matched"
    );
  });

  console.log("— partitionWritableEntries —");

  await check("writable rules: filled+source/copy or generate+instructions", () => {
    assert(unwritableReason(entry({ source_file: "f.md" }), false) === null, "pull+source_file");
    assert(unwritableReason(entry({ copy: "verbatim" }), false) === null, "pull+copy");
    assert(unwritableReason(entry({}), false) !== null, "pull without source should be unwritable");
    assert(
      unwritableReason(entry({ content_source: "generate", instructions: "draft it" }), false) === null,
      "generate+instructions"
    );
    assert(
      unwritableReason(entry({ content_source: "generate" }), false) !== null,
      "bare generate should be unwritable"
    );
    assert(unwritableReason(entry({ status: "todo", source_file: "f" }), false) !== null, "todo");
    assert(
      unwritableReason(entry({ kind: "docman", status: "filled", source_file: "f" }), false) !== null,
      "docman"
    );
    assert(
      unwritableReason(entry({ status: "written", source_file: "f" }), true) === null,
      "explicit keys unlock re-writing written entries"
    );
  });

  await check("batches preserve order and split at batch_size", () => {
    const entries = Array.from({ length: 19 }, (_, i) =>
      entry({ node_key: `k${i}`, title: `T${i}`, source_file: `s/${i}.md` })
    );
    const { batches } = partitionWritableEntries(schematicOf(entries), 8);
    assert(batches.length === 3, `expected 3 batches, got ${batches.length}`);
    assert(batches[0].length === 8 && batches[2].length === 3, "batch sizes wrong");
    assert(batches[0][0].node_key === "k0" && batches[2][2].node_key === "k18", "order broken");
  });

  await check("node_keys filter selects only the named entries", () => {
    const s = schematicOf([
      entry({ node_key: "a", source_file: "s/a.md" }),
      entry({ node_key: "b", source_file: "s/b.md" }),
    ]);
    const { batches } = partitionWritableEntries(s, 8, ["b"]);
    assert(batches.length === 1 && batches[0].length === 1 && batches[0][0].node_key === "b", "filter failed");
  });

  console.log("— applyContent —");

  await check("isPlaceholderContent: empty/stub/placeholder yes, real content no", () => {
    assert(isPlaceholderContent(undefined), "undefined");
    assert(isPlaceholderContent(""), "empty");
    assert(isPlaceholderContent("<p>Placeholder — content coming soon.</p>"), "placeholder text");
    assert(isPlaceholderContent("<p>&nbsp;</p>\n<p> </p>"), "whitespace html");
    assert(!isPlaceholderContent("<p>" + "Real parish content. ".repeat(10) + "</p>"), "real content");
  });

  /** Executor mock backed by a tiny article store + workspace. */
  function mockJoomla(articles: Record<string, { title: string; content?: string }>, files: Record<string, string>) {
    const updates: Array<{ id: string; content: string }> = [];
    const executor: Executor = async (name, args) => {
      if (name === "joomla_workspace_read") {
        if (files[args.path] === undefined) throw new Error(`no file at ${args.path}`);
        return files[args.path];
      }
      if (name === "joomla_workspace_write") {
        files[args.path] = args.content;
        return { success: true };
      }
      if (name === "joomla_article" && args.action === "get") {
        if (args.id) {
          const a = articles[args.id];
          if (!a) throw new Error(`[joomla-mcp] joomla_article failed: not found`);
          return { success: true, data: { id: args.id, ...a } };
        }
        const hits = Object.entries(articles).filter(([, a]) => a.title === args.title);
        // The real bridge executor THROWS on a get-by-title miss (isError result).
        if (hits.length === 0) throw new Error(`[joomla-mcp] joomla_article failed: No article found matching title '${args.title}'`);
        const [id, a] = hits[0];
        return { success: true, data: { id, ...a } };
      }
      if (name === "joomla_article" && args.action === "update") {
        if (!articles[args.id]) return { success: false, message: "not found" };
        updates.push({ id: args.id, content: args.content });
        articles[args.id].content = args.content;
        return { success: true, message: "updated" };
      }
      throw new Error(`unexpected executor call ${name} ${JSON.stringify(args)}`);
    };
    return { executor, updates };
  }

  await check("applies via stamped id, stamps done + applied_at, persists schematic", async () => {
    const e = entry({
      node_key: "k",
      title: "Our History",
      joomla_article_id: "42",
      content_file: "stmarys-html/01-our-history.html",
      status: "written",
    });
    const s = schematicOf([e]);
    const files = { "stmarys-html/01-our-history.html": "<p>New page content for the parish history page.</p>" };
    const { executor, updates } = mockJoomla({ "42": { title: "Our History", content: "" } }, files);
    const report = await applyContent(s, {
      executor,
      schematic_filename: "stmarys-content-schematic.json",
      now: new Date("2026-07-09T15:00:00Z"),
    });
    assert(report.applied.length === 1, `applied ${JSON.stringify(report)}`);
    assert(updates.length === 1 && updates[0].id === "42", "article not updated");
    assert(e.status === "done" && e.applied_at === "2026-07-09T15:00:00.000Z", "not stamped");
    assert(!!files["stmarys-content-schematic.json"], "schematic not persisted");
  });

  await check("grid landing resolves by '{title} (landing)' title fallback", async () => {
    const e = entry({
      node_key: "k",
      kind: "grid_landing",
      title: "Our Staff",
      content_file: "h.html",
      status: "written",
    });
    const s = schematicOf([e]);
    const { executor, updates } = mockJoomla(
      { "7": { title: "Our Staff (landing)", content: "" } },
      { "h.html": "<p>Staff intro.</p>" }
    );
    const report = await applyContent(s, { executor, schematic_filename: "" });
    assert(report.applied.length === 1, JSON.stringify(report.failed));
    assert(updates[0].id === "7" && e.joomla_article_id === "7", "landing id not resolved/stamped");
  });

  await check("refuses stamped id whose title doesn't match the entry", async () => {
    const e = entry({
      node_key: "k",
      title: "Our History",
      joomla_article_id: "42",
      content_file: "h.html",
      status: "written",
    });
    const s = schematicOf([e]);
    const { executor, updates } = mockJoomla(
      { "42": { title: "A Different Article", content: "" } },
      { "h.html": "<p>x</p>" }
    );
    const report = await applyContent(s, { executor, schematic_filename: "" });
    assert(report.failed.length === 1 && updates.length === 0, "should refuse mismatched title");
    assert(e.status === "written", "status must stay written on failure");
  });

  await check("skips article with real content unless force", async () => {
    const real = "<p>" + "Hand-written content the client already approved. ".repeat(5) + "</p>";
    const e = entry({
      node_key: "k",
      title: "T",
      joomla_article_id: "1",
      content_file: "h.html",
      status: "written",
    });
    const s = schematicOf([e]);
    const store = { "1": { title: "T", content: real } };
    const files = { "h.html": "<p>Overwrite attempt.</p>" };
    const first = mockJoomla(store, files);
    const r1 = await applyContent(s, { executor: first.executor, schematic_filename: "" });
    assert(r1.skipped.length === 1 && first.updates.length === 0, "should skip without force");
    assert(e.status === "written", "status unchanged on skip");

    const second = mockJoomla(store, files);
    const r2 = await applyContent(s, { executor: second.executor, schematic_filename: "", force: true });
    assert(r2.applied.length === 1 && second.updates.length === 1, "force should apply");
  });

  await check("dry_run reports the plan without updating or stamping", async () => {
    const e = entry({
      node_key: "k",
      title: "T",
      joomla_article_id: "1",
      content_file: "h.html",
      status: "written",
    });
    const s = schematicOf([e]);
    const { executor, updates } = mockJoomla({ "1": { title: "T", content: "" } }, { "h.html": "<p>x</p>" });
    const report = await applyContent(s, { executor, schematic_filename: "f.json", dry_run: true });
    assert(report.would_apply.length === 1, JSON.stringify(report));
    assert(updates.length === 0 && e.status === "written" && !e.applied_at, "dry_run mutated state");
  });

  await check("missing content_file fails cleanly before any Joomla call", async () => {
    const e = entry({
      node_key: "k",
      title: "T",
      joomla_article_id: "1",
      content_file: "missing.html",
      status: "written",
    });
    const s = schematicOf([e]);
    const { executor, updates } = mockJoomla({ "1": { title: "T", content: "" } }, {});
    const report = await applyContent(s, { executor, schematic_filename: "" });
    assert(report.failed.length === 1 && updates.length === 0, "should fail on missing file");
  });

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
