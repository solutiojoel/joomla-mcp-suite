import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { runMenuInterpreter } from "./agents/menu-interpreter.js";

/**
 * Standalone CLI runner for the menu-interpreter sub-agent.
 *
 * Lets you watch a full interpretation run live (assistant text, tool calls,
 * turn progress) without going through the orchestrator — for debugging and
 * tuning the interpreter until it's trusted.
 *
 * Usage (from apps/agents-mcp, or repo root with -w apps/agents-mcp):
 *   npm run interpret -- --site https://example.com --pdf "C:\path\to\Menu.pdf"
 *   npm run interpret -- --site https://example.com --text menu.txt
 *
 * Options:
 *   --site <url>       Active site URL (required)
 *   --pdf <path>       Path to the menu PDF (sub-agent reads it itself)
 *   --text <path>      Path to a plain-text menu document (read here, passed as text)
 *   --source <name>    Source filename recorded in the spec
 *   --out <path>       Also write the returned spec locally (default: ./<slug>-menu-spec.json)
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
  const textPath = getArg("text");
  const source = getArg("source");

  if (!site || (!pdf && !textPath)) {
    console.error(
      'Usage: npm run interpret -- --site <url> (--pdf <menu.pdf> | --text <menu.txt>) [--source <name>] [--out <spec.json>]'
    );
    process.exit(1);
  }

  const slug = new URL(site).hostname.replace(/^www\./, "").split(".")[0];
  const outPath = getArg("out") || path.resolve(process.cwd(), `${slug}-menu-spec.json`);

  let menu_text: string | undefined;
  if (textPath) {
    menu_text = fs.readFileSync(path.resolve(textPath), "utf8");
  }
  const pdf_path = pdf ? path.resolve(pdf) : undefined;
  if (pdf_path && !fs.existsSync(pdf_path)) {
    console.error(`PDF not found: ${pdf_path}`);
    process.exit(1);
  }

  console.log(`── menu-interpreter ─────────────────────────────────`);
  console.log(`site:   ${site}`);
  console.log(`source: ${pdf_path ?? textPath}`);
  console.log(`─────────────────────────────────────────────────────\n`);

  const started = Date.now();
  const result = await runMenuInterpreter(
    { site_url: site, menu_text, pdf_path, source_filename: source },
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
    for (const e of result.schema_errors ?? []) console.error(`  schema: ${e}`);
    for (const e of result.lint_errors ?? []) console.error(`  lint:   ${e}`);
    if (result.partial_spec) {
      const partialPath = outPath.replace(/\.json$/, ".partial.json");
      fs.writeFileSync(partialPath, JSON.stringify(result.partial_spec, null, 2));
      console.error(`partial spec written to ${partialPath}`);
    }
    process.exit(2);
  }

  fs.writeFileSync(outPath, JSON.stringify(result.spec, null, 2));
  const spec = result.spec as Record<string, unknown>;
  const oq = (spec.open_questions as string[]) ?? [];
  const assumptions = (spec.assumptions as string[]) ?? [];
  console.log(`spec written to ${outPath}`);
  console.log(`open questions (${oq.length}):`);
  for (const q of oq) console.log(`  ? ${q}`);
  console.log(`assumptions (${assumptions.length}):`);
  for (const a of assumptions) console.log(`  - ${a}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
