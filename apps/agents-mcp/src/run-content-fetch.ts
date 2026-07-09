import "dotenv/config";
import { connectDownstreams } from "./bridge.js";
import { fetchSourceContent, discoverSourceUrls } from "./content-fetch.js";
import { ContentSchematic } from "./schematic.js";

/**
 * Standalone CLI runner for the deterministic fetch/discover stages.
 *
 * Operates on the schematic in the site workspace (same as the MCP tools) —
 * for eyeballing markdown extraction quality and sitemap matching before
 * trusting a full run.
 *
 * Usage (from apps/agents-mcp, or repo root with -w apps/agents-mcp):
 *   npm run fetch-content -- --site https://example.com               # fetch
 *   npm run fetch-content -- --site https://example.com --refetch
 *   npm run fetch-content -- --site https://example.com --discover https://old-site.org
 *
 * Options:
 *   --site <url>        Active site URL (required)
 *   --discover <url>    Discover mode: scan this OLD site's sitemap/nav for
 *                       source-URL candidates instead of fetching
 *   --refetch           Re-fetch entries that already have a source_file
 *   --schematic <name>  Workspace schematic filename override
 *
 * The joomla-mcp downstream must be running (JOOMLA_MCP_URL / default port).
 */

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const site = getArg("site");
  if (!site) {
    console.error(
      "Usage: npm run fetch-content -- --site <url> [--discover <old-site-url>] [--refetch] [--schematic <name>]"
    );
    process.exit(1);
  }

  const slug = new URL(site).hostname.replace(/^www\./, "").split(".")[0];
  const filename = getArg("schematic") || `${slug}-content-schematic.json`;

  const { executor } = await connectDownstreams(["joomla-mcp"], site, [
    "joomla_workspace_read",
    "joomla_workspace_write",
  ]);
  const schematic = (await executor("joomla_workspace_read", { path: filename })) as ContentSchematic;
  if (!Array.isArray(schematic.entries)) {
    console.error(`Workspace file '${filename}' is not a Content Schematic`);
    process.exit(1);
  }
  console.log(`schematic: ${filename} (${schematic.entries.length} entries)\n`);

  const discoverBase = getArg("discover");
  if (discoverBase) {
    const { proposals, source, pages_scanned } = await discoverSourceUrls(schematic, discoverBase);
    console.log(`scanned ${pages_scanned} pages via ${source}\n`);
    for (const p of proposals) {
      console.log(`${p.node_key}  ("${p.title}")`);
      if (p.candidates.length === 0) console.log(`  (no candidates)`);
      for (const c of p.candidates) {
        console.log(`  ${(c.score * 100).toFixed(0).padStart(3)}%  ${c.url}  [${c.matched}]`);
      }
    }
    return;
  }

  const report = await fetchSourceContent(schematic, {
    slug,
    refetch: hasFlag("refetch"),
    writeWorkspaceFile: async (path, content) => {
      await executor("joomla_workspace_write", { path, content });
      console.log(`  wrote ${path} (${content.length} chars)`);
    },
  });
  await executor("joomla_workspace_write", {
    path: filename,
    content: JSON.stringify(schematic, null, 2),
  });

  console.log(`\nfetched (${report.fetched.length}):`);
  for (const i of report.fetched) console.log(`  ok  ${i.node_key} → ${i.source_file}`);
  console.log(`failed (${report.failed.length}):`);
  for (const i of report.failed) console.log(`  X   ${i.node_key} — ${i.detail}`);
  console.log(`skipped (${report.skipped.length}):`);
  for (const i of report.skipped) console.log(`  -   ${i.node_key} — ${i.detail}`);
  console.log(`\nschematic persisted to ${filename}`);
  process.exit(report.failed.length > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
