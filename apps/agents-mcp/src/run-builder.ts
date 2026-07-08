import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { runMenuBuilder } from "./agents/menu-builder.js";

/**
 * Standalone CLI runner for the menu-builder sub-agent.
 *
 * Lets you watch a full Phase 4 build run live (assistant text, tool calls,
 * turn progress) without going through the orchestrator — for debugging and
 * tuning the builder until it's trusted.
 *
 * Usage (from apps/agents-mcp, or repo root with -w apps/agents-mcp):
 *   npm run build-menu -- --site https://example.com --spec ./example-menu-spec.json
 *
 * Options:
 *   --site <url>            Active site URL (required)
 *   --spec <path>           Path to the approved Menu Spec JSON (required)
 *   --spec-filename <name>  Workspace filename to persist the updated spec to
 *   --style-id <id>         Default Gantry template style ID
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
  const specPath = getArg("spec");
  const specFilename = getArg("spec-filename");
  const styleId = getArg("style-id");

  if (!site || !specPath) {
    console.error(
      "Usage: npm run build-menu -- --site <url> --spec <spec.json> [--spec-filename <name>] [--style-id <id>]"
    );
    process.exit(1);
  }

  const resolvedSpecPath = path.resolve(specPath);
  if (!fs.existsSync(resolvedSpecPath)) {
    console.error(`Spec not found: ${resolvedSpecPath}`);
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(resolvedSpecPath, "utf8"));

  console.log(`── menu-builder ─────────────────────────────────────`);
  console.log(`site: ${site}`);
  console.log(`spec: ${resolvedSpecPath}`);
  console.log(`─────────────────────────────────────────────────────\n`);

  const started = Date.now();
  const result = await runMenuBuilder(
    { site_url: site, spec, spec_filename: specFilename, default_template_style_id: styleId },
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
    for (const n of result.build_notes ?? []) console.error(`  note: ${n}`);
    process.exit(2);
  }

  console.log(`summary: ${JSON.stringify(result.summary, null, 2)}`);
  const notes = result.build_notes ?? [];
  console.log(`build notes (${notes.length}):`);
  for (const n of notes) console.log(`  - ${n}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
