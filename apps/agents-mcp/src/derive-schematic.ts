import fs from "node:fs";
import path from "node:path";
import { deriveContentSchematic, ContentSchematic } from "./schematic.js";
import { validateSchematic } from "./schematic-validator.js";

/**
 * CLI for deriving/merging a Content Schematic from a Menu Spec — the
 * deterministic sync step. Run it to create the scaffold after spec approval,
 * and again after ANY spec edit or after Phase 4 (stamps joomla_article_ids).
 *
 * Usage (from repo root):
 *   npm run derive-schematic -w apps/agents-mcp -- --spec <spec.json> [--schematic <existing.json>] [--out <path>]
 *
 * Without --out, writes next to the spec as <site-slug>-content-schematic.json
 * (or overwrites --schematic in place when given).
 *
 * Exit codes: 0 = derived + valid, 1 = usage/read error, 2 = validation errors.
 */

function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson(label: string, p: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), "utf8"));
  } catch (err: unknown) {
    console.error(`Failed to read/parse ${label} ${p}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function main() {
  const specArg = getArg("spec");
  if (!specArg) {
    console.error(
      "Usage: npm run derive-schematic -w apps/agents-mcp -- --spec <spec.json> [--schematic <existing.json>] [--out <path>]"
    );
    process.exit(1);
  }

  const spec = readJson("spec", specArg);
  const schematicArg = getArg("schematic");
  const existing = schematicArg
    ? (readJson("schematic", schematicArg) as unknown as ContentSchematic)
    : null;

  const specPath = path.resolve(specArg);
  const defaultName = path
    .basename(specPath)
    .replace(/-menu-spec\.json$/, "-content-schematic.json");
  const outPath = path.resolve(
    getArg("out") ??
      schematicArg ??
      path.join(path.dirname(specPath), defaultName === path.basename(specPath) ? "content-schematic.json" : defaultName)
  );

  const { schematic, changes } = deriveContentSchematic(spec, existing, {
    menu_spec_file: path.basename(specPath),
  });

  console.log(`── derive-schematic ${path.basename(specPath)} ──`);
  console.log(`entries: ${schematic.entries.length}`);
  console.log(`added (${changes.added.length}):`);
  for (const k of changes.added) console.log(`  + ${k}`);
  console.log(`updated (${changes.updated.length}):`);
  for (const k of changes.updated) console.log(`  ~ ${k}`);
  console.log(`orphaned (${changes.orphaned.length}):`);
  for (const k of changes.orphaned) console.log(`  - ${k}`);

  const { valid, schema_errors, lint_errors } = validateSchematic(
    schematic as unknown as Record<string, unknown>,
    spec
  );
  for (const e of schema_errors) console.error(`  schema: ${e}`);
  for (const e of lint_errors) console.error(`  lint:   ${e}`);

  fs.writeFileSync(outPath, JSON.stringify(schematic, null, 2));
  console.log(`schematic written to ${outPath}`);

  if (!valid) {
    console.error(
      `\nINVALID — ${schema_errors.length} schema error(s), ${lint_errors.length} lint error(s)`
    );
    process.exit(2);
  }
}

main();
