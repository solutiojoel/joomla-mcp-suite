import fs from "node:fs";
import path from "node:path";
import { validateSchematic } from "./schematic-validator.js";

/**
 * CLI validator for a Content Schematic file. Passing the Menu Spec as the
 * second argument enables the cross-lint (entry set must match the spec's
 * content-bearing nodes 1:1).
 *
 * Usage (from repo root):
 *   npm run validate-schematic -w apps/agents-mcp -- <schematic.json> [<spec.json>]
 *
 * Exit codes: 0 = valid, 1 = usage/read error, 2 = validation errors.
 */

function readJson(p: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
  } catch (err: unknown) {
    console.error(`Failed to read/parse ${p}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function main() {
  const schematicArg = process.argv[2];
  if (!schematicArg) {
    console.error(
      "Usage: npm run validate-schematic -w apps/agents-mcp -- <schematic.json> [<spec.json>]"
    );
    process.exit(1);
  }

  const schematic = readJson(schematicArg);
  const spec = process.argv[3] ? readJson(process.argv[3]) : undefined;

  const { valid, schema_errors, lint_errors } = validateSchematic(schematic, spec);

  console.log(
    `── validate-schematic ${path.basename(schematicArg)}${spec ? ` × ${path.basename(process.argv[3])}` : " (no cross-lint — pass the spec to enable)"} ──`
  );
  for (const e of schema_errors) console.error(`  schema: ${e}`);
  for (const e of lint_errors) console.error(`  lint:   ${e}`);

  if (!valid) {
    console.error(
      `\nINVALID — ${schema_errors.length} schema error(s), ${lint_errors.length} lint error(s)`
    );
    process.exit(2);
  }

  const oq = (schematic.open_questions as string[]) ?? [];
  console.log(`VALID — 0 errors. ${oq.length} open question(s) remaining:`);
  for (const q of oq) console.log(`  ? ${q}`);
}

main();
