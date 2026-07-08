import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { runContentInterpreter } from "./agents/content-interpreter.js";
import { ContentSchematic } from "./schematic.js";

/**
 * Standalone CLI runner for the content-interpreter sub-agent.
 *
 * Lets you watch a full content-interpretation run live (assistant text, tool
 * calls, turn progress) without going through the orchestrator — for debugging
 * and tuning the interpreter until it's trusted.
 *
 * Usage (from apps/agents-mcp, or repo root with -w apps/agents-mcp):
 *   npm run interpret-content -- --site https://example.com --pdf "C:\path\to\Menu.pdf" --spec ./example-menu-spec.json
 *
 * Options:
 *   --site <url>         Active site URL (required)
 *   --pdf <path>         Path to the client menu/content PDF (required)
 *   --spec <path>        Path to the approved Menu Spec JSON (required)
 *   --schematic <path>   Existing schematic to merge into (preserves filled content)
 *   --source <name>      Source filename recorded in the schematic
 *   --out <path>         Also write the returned schematic locally (default: ./<slug>-content-schematic.json)
 *
 * Auth: uses your Claude Code credentials — either the local `claude` login or
 * CLAUDE_CODE_OAUTH_TOKEN (mint with `claude setup-token`). No API key needed.
 * The joomla-mcp downstream must be running (JOOMLA_MCP_URL / default port).
 */

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const site = getArg("site");
  const pdf = getArg("pdf");
  const specPath = getArg("spec");

  if (!site || !pdf || !specPath) {
    console.error(
      "Usage: npm run interpret-content -- --site <url> --pdf <menu.pdf> --spec <spec.json> [--schematic <existing.json>] [--source <name>] [--out <schematic.json>]"
    );
    process.exit(1);
  }

  const slug = new URL(site).hostname.replace(/^www\./, "").split(".")[0];
  const outPath = getArg("out") || path.resolve(process.cwd(), `${slug}-content-schematic.json`);

  const pdf_path = path.resolve(pdf);
  if (!fs.existsSync(pdf_path)) {
    console.error(`PDF not found: ${pdf_path}`);
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), "utf8"));
  const schematicPath = getArg("schematic");
  const schematic = schematicPath
    ? (JSON.parse(fs.readFileSync(path.resolve(schematicPath), "utf8")) as ContentSchematic)
    : undefined;

  console.log(`── content-interpreter ──────────────────────────────`);
  console.log(`site:   ${site}`);
  console.log(`pdf:    ${pdf_path}`);
  console.log(`spec:   ${specPath}`);
  if (schematicPath) console.log(`merge:  ${schematicPath}`);
  console.log(`─────────────────────────────────────────────────────\n`);

  const started = Date.now();
  const result = await runContentInterpreter(
    { site_url: site, pdf_path, spec, schematic, source_filename: getArg("source") },
    async (progress, total) => {
      console.log(`\n[turn ${progress}/${total}]`);
    },
    (event) => {
      switch (event.type) {
        case "text":
          console.log(`  ${event.text}`);
          break;
        case "tool_use":
          console.log(
            `  → tool: ${event.toolName} ${JSON.stringify(event.toolInput ?? {}).slice(0, 200)}`
          );
          break;
        case "system":
          if (event.text === "init") console.log(`  (session initialized)`);
          break;
      }
    }
  );

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n── result (${seconds}s) ─────────────────────────────`);

  if (result.run_log) console.log(`run log: ${result.run_log}`);

  if (!result.success) {
    console.error(`FAILED: ${result.error}`);
    for (const e of result.schema_errors ?? []) console.error(`  schema:    ${e}`);
    for (const e of result.lint_errors ?? []) console.error(`  lint:      ${e}`);
    for (const e of result.structure_errors ?? []) console.error(`  structure: ${e}`);
    if (result.partial_schematic) {
      const partialPath = outPath.replace(/\.json$/, ".partial.json");
      fs.writeFileSync(partialPath, JSON.stringify(result.partial_schematic, null, 2));
      console.error(`partial schematic written to ${partialPath}`);
    }
    process.exit(2);
  }

  fs.writeFileSync(outPath, JSON.stringify(result.schematic, null, 2));
  const filled = result.schematic!;
  const byStatus = new Map<string, number>();
  for (const e of filled.entries) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  console.log(`schematic written to ${outPath}`);
  console.log(
    `entries: ${filled.entries.length} (${[...byStatus.entries()].map(([s, n]) => `${n} ${s}`).join(", ")})`
  );
  const oq = filled.open_questions ?? [];
  const assumptions = filled.assumptions ?? [];
  console.log(`open questions (${oq.length}):`);
  for (const q of oq) console.log(`  ? ${q}`);
  console.log(`assumptions (${assumptions.length}):`);
  for (const a of assumptions) console.log(`  - ${a}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
