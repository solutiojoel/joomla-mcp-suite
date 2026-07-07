import fs from "node:fs";
import path from "node:path";

/**
 * Menu Spec validation — structural JSON-Schema check + the 8 semantic lint
 * invariants, in one module.
 *
 * The schema file at config/agents/menu-build/menu-spec.schema.json is the
 * single structural source of truth (also consumed by
 * apps/orchestrator/test-menu-spec.cjs, the Path-A CLI gate). The lint rules
 * here mirror the "Lint invariants" section of docs/kb/menu-spec-schema.md —
 * if you change one, change both.
 */

const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "config",
  "agents",
  "menu-build",
  "menu-spec.schema.json"
);

let cachedSchema: any = null;
function loadSchema(): any {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  }
  return cachedSchema;
}

// ─── Minimal JSON Schema (draft-07 subset) walker ────────────────────────────
// Supports: type, required, properties, additionalProperties:false, items,
// enum, minProperties, minItems, and local $ref — the subset the Menu Spec
// schema actually uses. Mirrors the walker in test-menu-spec.cjs.

function resolveRef(ref: string, root: any): any {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((node, key) => node?.[key], root);
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function walkSchema(node: any, sch: any, root: any, pathStr: string, errors: string[]): void {
  if (!sch) return;
  if (sch.$ref) {
    walkSchema(node, resolveRef(sch.$ref, root), root, pathStr, errors);
    return;
  }

  if (sch.type) {
    const t = typeOf(node);
    const want = sch.type === "integer" ? "number" : sch.type;
    if (t !== want) {
      errors.push(`${pathStr}: expected ${sch.type}, got ${t}`);
      return;
    }
  }

  if (sch.enum && !sch.enum.includes(node)) {
    errors.push(`${pathStr}: '${node}' not in [${sch.enum.join(", ")}]`);
  }

  if (typeOf(node) === "object") {
    const obj = node as Record<string, unknown>;
    if (sch.required) {
      for (const r of sch.required) {
        if (!(r in obj)) errors.push(`${pathStr}: missing required '${r}'`);
      }
    }
    if (typeof sch.minProperties === "number" && Object.keys(obj).length < sch.minProperties) {
      errors.push(`${pathStr}: needs >= ${sch.minProperties} properties`);
    }
    for (const [key, val] of Object.entries(obj)) {
      const childPath = `${pathStr}.${key}`;
      if (sch.properties && key in sch.properties) {
        walkSchema(val, sch.properties[key], root, childPath, errors);
      } else if (sch.additionalProperties === false) {
        errors.push(`${childPath}: unexpected field`);
      } else if (sch.additionalProperties && typeof sch.additionalProperties === "object") {
        walkSchema(val, sch.additionalProperties, root, childPath, errors);
      }
    }
  }

  if (typeOf(node) === "array") {
    const arr = node as unknown[];
    if (typeof sch.minItems === "number" && arr.length < sch.minItems) {
      errors.push(`${pathStr}: needs >= ${sch.minItems} items`);
    }
    if (sch.items) {
      arr.forEach((item, i) => walkSchema(item, sch.items, root, `${pathStr}[${i}]`, errors));
    }
  }
}

/** Validate a spec against the Menu Spec JSON schema. Empty array = valid. */
export function validateSchema(spec: Record<string, unknown>): string[] {
  const schema = loadSchema();
  const errors: string[] = [];
  walkSchema(spec, schema, schema, "spec", errors);
  return errors;
}

// ─── The 8 lint invariants (cross-field rules the schema can't express) ──────

const VALID_TYPES = new Set([
  "heading",
  "single_article",
  "category_grid",
  "category_blog",
  "category_list",
  "external_url",
  "docman",
  "alias",
]);

const VALID_CONTENT_SOURCES = new Set(["pull", "generate", "redirect", "existing", "none"]);

const VALID_PARTICLES = new Set(["joomla_articles", "block_content", "contentarray"]);

/** Validate a Menu Spec against the 8 lint invariants. Empty array = valid. */
export function lintSpec(spec: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const openQuestions = (spec.open_questions as string[] | undefined) || [];

  function walkItems(items: unknown[], parentPath: string) {
    if (!Array.isArray(items)) return;
    const titles = new Set<string>();

    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const title = String(item.title ?? "");
      const type = String(item.type ?? "");
      const fullPath = `${parentPath} > "${title}"`;

      // #1 — valid type enum
      if (!VALID_TYPES.has(type)) {
        errors.push(`${fullPath}: invalid type "${type}"`);
      }

      // #1 — valid content_source enum (when present)
      if (item.content_source && !VALID_CONTENT_SOURCES.has(String(item.content_source))) {
        errors.push(`${fullPath}: invalid content_source "${item.content_source}"`);
      }

      // #2 — required fields
      if (!item.title) errors.push(`${fullPath}: missing required field "title"`);
      if (!item.type) errors.push(`${fullPath}: missing required field "type"`);

      // #3 — external_url needs target; TBD needs open_questions entry
      if (type === "external_url") {
        if (!item.target) {
          errors.push(`${fullPath}: external_url is missing "target"`);
        } else if (item.target === "TBD") {
          const covered = openQuestions.some((q) =>
            q.toLowerCase().includes(title.toLowerCase())
          );
          if (!covered) {
            errors.push(
              `${fullPath}: target is "TBD" but no matching open_questions entry (add one referencing "${title}")`
            );
          }
        }
      }

      // #4 — category_grid must name a category
      if (type === "category_grid" && !item.category) {
        errors.push(`${fullPath}: category_grid is missing "category"`);
      }

      // #5 — category_grid must not have single_article children
      if (type === "category_grid" && Array.isArray(item.children)) {
        const bad = (item.children as Record<string, unknown>[]).filter(
          (c) => c.type === "single_article"
        );
        if (bad.length > 0) {
          errors.push(
            `${fullPath}: category_grid has single_article children [${bad.map((c) => `"${c.title}"`).join(", ")}] — grid members go in the grids array, not as children`
          );
        }
      }

      // #6 — heading must have children
      if (type === "heading") {
        const kids = item.children as unknown[] | undefined;
        if (!kids || kids.length === 0) {
          errors.push(`${fullPath}: heading has no children`);
        }
      }

      // #7 — no duplicate sibling titles
      if (titles.has(title)) {
        errors.push(`Duplicate sibling title "${title}" at ${parentPath}`);
      }
      titles.add(title);

      if (Array.isArray(item.children)) {
        walkItems(item.children, fullPath);
      }
    }
  }

  const menus = spec.menus as Record<string, unknown> | undefined;
  if (!menus || typeof menus !== "object") {
    errors.push('Top-level "menus" object is missing or not an object');
  } else {
    for (const [menuName, items] of Object.entries(menus)) {
      if (!Array.isArray(items)) {
        errors.push(`menus.${menuName} is not an array`);
      } else {
        walkItems(items, menuName);
      }
    }
  }

  const grids = spec.grids as Record<string, unknown>[] | undefined;
  if (grids && Array.isArray(grids)) {
    for (const grid of grids) {
      const gPath = `grids["${grid.page}"]`;
      if (!grid.page) errors.push(`${gPath}: missing "page"`);
      if (!grid.category) errors.push(`${gPath}: missing "category"`);
      if (grid.particle && !VALID_PARTICLES.has(String(grid.particle))) {
        errors.push(`${gPath}: invalid particle "${grid.particle}"`);
      }
    }
  }

  // #8 — module quicklinks need a target or a menu_item
  const modules = spec.modules as
    | Record<string, { items?: Record<string, unknown>[] }>
    | undefined;
  if (modules && typeof modules === "object") {
    for (const [modKey, mod] of Object.entries(modules)) {
      for (const item of mod.items || []) {
        if (!item.target && !item.menu_item) {
          errors.push(
            `modules.${modKey} item "${item.label}": must have either "target" or "menu_item"`
          );
        }
      }
    }
  }

  return errors;
}

export interface SpecValidationResult {
  valid: boolean;
  schema_errors: string[];
  lint_errors: string[];
}

/** Full validation: structural schema check + the 8 lint invariants. */
export function validateSpec(spec: Record<string, unknown>): SpecValidationResult {
  const schema_errors = validateSchema(spec);
  const lint_errors = lintSpec(spec);
  return {
    valid: schema_errors.length === 0 && lint_errors.length === 0,
    schema_errors,
    lint_errors,
  };
}
