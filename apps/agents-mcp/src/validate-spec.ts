import fs from "node:fs";
import path from "node:path";
import { validateSpec } from "./spec-validator.js";

/**
 * CLI validator for a Menu Spec file — the Phase 2/3 gate for hand-edited
 * specs. Runs the same schema walk + 8 lint invariants that
 * run_menu_interpretation applies to interpreter output.
 *
 * Usage (from repo root):
 *   npm run validate -w apps/agents-mcp -- path/to/site-menu-spec.json
 *
 * Exit codes: 0 = valid, 1 = usage/read error, 2 = validation errors.
 *
 * (apps/orchestrator/test-menu-spec.cjs is different: it regression-tests the
 * validator itself against fixtures and never reads your spec file.)
 */

function main() {
  const specArg = process.argv[2];
  if (!specArg) {
    console.error("Usage: npm run validate -w apps/agents-mcp -- <spec.json>");
    process.exit(1);
  }

  const specPath = path.resolve(specArg);
  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (err: unknown) {
    console.error(`Failed to read/parse ${specPath}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const { valid, schema_errors, lint_errors } = validateSpec(spec!);

  console.log(`── validate ${path.basename(specPath)} ──`);
  for (const e of schema_errors) console.error(`  schema: ${e}`);
  for (const e of lint_errors) console.error(`  lint:   ${e}`);

  if (!valid) {
    console.error(`\nINVALID — ${schema_errors.length} schema error(s), ${lint_errors.length} lint error(s)`);
    process.exit(2);
  }

  const oq = (spec!.open_questions as string[]) ?? [];
  console.log(`VALID — 0 errors. ${oq.length} open question(s) remaining:`);
  for (const q of oq) console.log(`  ? ${q}`);
}

main();
