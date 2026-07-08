import fs from "node:fs";
import path from "node:path";
import { walkSchema } from "./spec-validator.js";
import { collectContentNodes, ContentSchematic, SchematicEntry } from "./schematic.js";

/**
 * Content Schematic validation — structural JSON-Schema check, intra-schematic
 * lint, and (when the Menu Spec is supplied) the cross-lint that guarantees
 * the schematic lines up 1:1 with the skeleton.
 *
 * The cross-lint reuses collectContentNodes() from schematic.ts — the same
 * walk the derivation uses — so derivation and lint cannot disagree.
 * Lint rules mirror the "Lint invariants" section of
 * docs/kb/content-schematic-schema.md — if you change one, change both.
 */

const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "config",
  "agents",
  "content-build",
  "content-schematic.schema.json"
);

let cachedSchema: any = null;
function loadSchema(): any {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  }
  return cachedSchema;
}

/** Validate against the Content Schematic JSON schema. Empty array = valid. */
export function validateSchematicSchema(schematic: Record<string, unknown>): string[] {
  const schema = loadSchema();
  const errors: string[] = [];
  walkSchema(schematic, schema, schema, "schematic", errors);
  return errors;
}

/** Intra-schematic lint plus, when a spec is provided, the cross-lint against
 *  the derivation walk. Empty array = valid. */
export function lintSchematic(
  schematic: Record<string, unknown>,
  spec?: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  const entries = (Array.isArray(schematic.entries) ? schematic.entries : []) as SchematicEntry[];
  const openQuestions = ((schematic.open_questions as string[] | undefined) ?? []).map((q) =>
    String(q).toLowerCase()
  );

  function hasOpenQuestion(title: string): boolean {
    const t = title.toLowerCase();
    return openQuestions.some((q) => q.includes(t));
  }

  // #2 — unique node_key
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = String(entry.node_key ?? "");
    const label = `entry "${key}"`;

    if (keys.has(key)) {
      errors.push(`${label}: duplicate node_key`);
    }
    keys.add(key);

    // #3 — filled pull entries need a source_url
    if (entry.status === "filled" && entry.content_source === "pull" && !entry.source_url) {
      errors.push(`${label}: status "filled" with content_source "pull" but no source_url`);
    }

    // #4 — TBD source_url needs a matching open question
    if (entry.source_url === "TBD" && !hasOpenQuestion(String(entry.title ?? ""))) {
      errors.push(
        `${label}: source_url is "TBD" but no matching open_questions entry (add one referencing "${entry.title}")`
      );
    }

    // #5 — needs_input needs a matching open question
    if (entry.status === "needs_input" && !hasOpenQuestion(String(entry.title ?? ""))) {
      errors.push(
        `${label}: status "needs_input" but no matching open_questions entry (add one referencing "${entry.title}")`
      );
    }
  }

  // Cross-lint (#6–#8): compare against what the derivation would emit.
  if (spec) {
    const expected = collectContentNodes(spec);
    const expectedByKey = new Map(expected.map((e) => [e.node_key, e]));
    const liveEntries = entries.filter((e) => e.status !== "orphaned");
    const liveByKey = new Map(liveEntries.map((e) => [String(e.node_key), e]));

    // #6 — every content-bearing spec node has a non-orphaned entry
    for (const exp of expected) {
      if (!liveByKey.has(exp.node_key)) {
        errors.push(`spec node "${exp.node_key}" has no non-orphaned schematic entry — re-derive`);
      }
    }

    // #7 — every non-orphaned entry maps to a live spec node
    for (const entry of liveEntries) {
      const key = String(entry.node_key ?? "");
      const exp = expectedByKey.get(key);
      if (!exp) {
        errors.push(`entry "${key}": no matching spec node — mark orphaned or re-derive`);
        continue;
      }
      // #8 — derive-owned fields match the derivation
      for (const field of ["kind", "category", "content_source"] as const) {
        const want = exp[field];
        const got = entry[field];
        if (want !== undefined && got !== want) {
          errors.push(`entry "${key}": ${field} is "${got}" but the spec derives "${want}" — re-derive`);
        }
      }
    }
  }

  return errors;
}

export interface SchematicValidationResult {
  valid: boolean;
  schema_errors: string[];
  lint_errors: string[];
}

/** Full validation with the same crash-safe envelope as validateSpec. */
export function validateSchematic(
  schematic: Record<string, unknown>,
  spec?: Record<string, unknown>
): SchematicValidationResult {
  let schema_errors: string[];
  try {
    schema_errors = validateSchematicSchema(schematic);
  } catch (err: unknown) {
    schema_errors = [`schema validation crashed: ${err instanceof Error ? err.message : err}`];
  }
  let lint_errors: string[];
  try {
    lint_errors = lintSchematic(schematic, spec);
  } catch (err: unknown) {
    lint_errors = [`lint crashed on malformed schematic: ${err instanceof Error ? err.message : err}`];
  }
  return {
    valid: schema_errors.length === 0 && lint_errors.length === 0,
    schema_errors,
    lint_errors,
  };
}

/** Node-key-set equality between a returned schematic and the scaffold the
 *  harness derived — the structure lock for run_content_interpretation.
 *  Returns human-readable diff lines; empty = structures match. */
export function diffNodeKeys(
  returned: ContentSchematic | Record<string, unknown>,
  scaffold: ContentSchematic
): string[] {
  const returnedKeys = new Set(
    ((returned.entries as SchematicEntry[] | undefined) ?? []).map((e) => String(e.node_key))
  );
  const scaffoldKeys = new Set(scaffold.entries.map((e) => e.node_key));
  const diff: string[] = [];
  for (const key of scaffoldKeys) {
    if (!returnedKeys.has(key)) diff.push(`missing entry: "${key}"`);
  }
  for (const key of returnedKeys) {
    if (!scaffoldKeys.has(key)) diff.push(`unexpected entry: "${key}"`);
  }
  return diff;
}
