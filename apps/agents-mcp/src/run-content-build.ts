import "dotenv/config";
import { connectDownstreams } from "./bridge.js";
import { runContentWriter } from "./agents/content-writer.js";
import { applyContent, ApplyReport } from "./content-apply.js";
import { ContentSchematic } from "./schematic.js";

/**
 * Standalone CLI runner for the content-build write + apply stages.
 *
 * Streams the content-writer sub-agent live (assistant text, tool calls, batch
 * progress) and runs the deterministic auto-apply after each batch — the same
 * flow as the run_content_build MCP tool, without the orchestrator.
 *
 * Usage (from apps/agents-mcp, or repo root with -w apps/agents-mcp):
 *   npm run build-content -- --site https://example.com
 *   npm run build-content -- --site https://example.com --dry-run
 *   npm run build-content -- --site https://example.com --keys "mainmenu:About Us/Welcome"
 *
 * Options:
 *   --site <url>        Active site URL (required)
 *   --batch-size <n>    Entries per writer run (default 8)
 *   --keys <k1,k2>      Explicit node_keys (comma-separated)
 *   --no-apply          Write HTML files only, skip the Joomla apply
 *   --force             Apply over articles that already have real content
 *   --dry-run           Print the batch/apply plan without running anything
 *   --schematic <name>  Workspace schematic filename override
 *
 * Auth: uses your Claude Code credentials — either the local `claude` login or
 * CLAUDE_CODE_OAUTH_TOKEN (mint with `claude setup-token`). No API key needed.
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
      "Usage: npm run build-content -- --site <url> [--batch-size <n>] [--keys <k1,k2>] [--no-apply] [--force] [--dry-run] [--schematic <name>]"
    );
    process.exit(1);
  }

  const slug = new URL(site).hostname.replace(/^www\./, "").split(".")[0];
  const filename = getArg("schematic") || `${slug}-content-schematic.json`;
  const dryRun = hasFlag("dry-run");
  const doApply = !hasFlag("no-apply") && !dryRun;

  const { executor } = await connectDownstreams(["joomla-mcp"], site, [
    "joomla_workspace_read",
    "joomla_workspace_write",
    "joomla_article",
  ]);
  const schematic = (await executor("joomla_workspace_read", { path: filename })) as ContentSchematic;
  if (!Array.isArray(schematic.entries)) {
    console.error(`Workspace file '${filename}' is not a Content Schematic`);
    process.exit(1);
  }

  console.log(`── content-build ────────────────────────────────────`);
  console.log(`site:      ${site}`);
  console.log(`schematic: ${filename} (${schematic.entries.length} entries)`);
  console.log(`apply:     ${doApply ? (hasFlag("force") ? "yes (FORCE)" : "yes") : "no"}${dryRun ? " (dry run)" : ""}`);
  console.log(`─────────────────────────────────────────────────────\n`);

  const applyReports: ApplyReport[] = [];
  const started = Date.now();

  const result = await runContentWriter(
    {
      site_url: site,
      schematic,
      schematic_filename: filename,
      batch_size: getArg("batch-size") ? Number(getArg("batch-size")) : undefined,
      node_keys: getArg("keys")?.split(",").map((k) => k.trim()),
      dry_run: dryRun,
    },
    async (progress, total) => {
      /* batch progress printed via events below */
    },
    (event) => {
      switch (event.type) {
        case "text":
          console.log(`  ${event.text}`);
          break;
        case "tool_use": {
          const input = JSON.stringify(event.toolInput ?? {});
          console.log(`  → tool: ${event.toolName} ${input.slice(0, 160)}`);
          break;
        }
        case "system":
          if (event.text === "init") console.log(`  (writer session started)`);
          break;
      }
    },
    doApply
      ? async (writtenKeys, batch, total) => {
          if (writtenKeys.length === 0) return;
          console.log(`\n[apply batch ${batch}/${total}] ${writtenKeys.length} entries`);
          const report = await applyContent(schematic, {
            executor,
            schematic_filename: filename,
            node_keys: writtenKeys,
            force: hasFlag("force"),
          });
          applyReports.push(report);
          for (const i of report.applied) console.log(`  applied  ${i.node_key} → article ${i.article_id}`);
          for (const i of report.skipped) console.log(`  skipped  ${i.node_key} — ${i.detail}`);
          for (const i of report.failed) console.log(`  FAILED   ${i.node_key} — ${i.detail}`);
        }
      : undefined
  );

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n── result (${seconds}s) ─────────────────────────────`);

  if (dryRun) {
    for (const b of result.batches) {
      console.log(`batch ${b.batch}: ${b.node_keys.length} entries`);
      for (const k of b.node_keys) console.log(`  ${k}`);
    }
    for (const nw of result.not_writable) console.log(`not writable: ${nw.node_key} — ${nw.reason}`);
    return;
  }

  console.log(`written: ${result.written.length}, drafts: ${result.drafts.length}, write failures: ${result.failed.length}`);
  for (const f of result.failed) console.log(`  write FAILED  ${f.node_key} — ${f.error}`);
  for (const nw of result.not_writable) console.log(`  not writable  ${nw.node_key} — ${nw.reason}`);
  for (const d of result.drafts) console.log(`  draft (review) ${d}`);
  if (result.not_attempted.length > 0) {
    console.log(`  not attempted (run aborted): ${result.not_attempted.join(", ")}`);
  }

  const applied = applyReports.flatMap((r) => r.applied).length;
  const applyFailed = applyReports.flatMap((r) => r.failed).length;
  const applySkipped = applyReports.flatMap((r) => r.skipped).length;
  if (doApply) console.log(`applied: ${applied}, apply skipped: ${applySkipped}, apply failures: ${applyFailed}`);

  const byStatus = new Map<string, number>();
  for (const e of schematic.entries) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  console.log(`statuses: ${[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(", ")}`);

  if (!result.success) {
    console.error(`\nFAILED: ${result.error}`);
    process.exit(2);
  }
  if (result.failed.length > 0 || applyFailed > 0) process.exit(2);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
