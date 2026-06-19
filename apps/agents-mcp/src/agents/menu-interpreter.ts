import { loadSubAgentConfig } from "../config.js";
import { connectDownstreams } from "../bridge.js";
import { runSubAgent } from "../runtime.js";


// ─── Schema-aware lint helpers ────────────────────────────────────────────────

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

const VALID_CONTENT_SOURCES = new Set([
  "pull",
  "generate",
  "redirect",
  "existing",
  "none",
]);

const VALID_PARTICLES = new Set([
  "joomla_articles",
  "block_content",
  "contentarray",
]);

export interface MenuInterpreterArgs {
  site_url: string;
  menu_text: string;
  source_filename?: string;
}

export interface MenuInterpreterResult {
  success: boolean;
  spec?: Record<string, unknown>;
  error?: string;
  lint_errors?: string[];
  partial_spec?: unknown;
}

/**
 * Validate a Menu Spec against the 8 lint invariants.
 * Returns an array of error strings (empty = valid).
 */
function lintSpec(spec: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const openQuestions = (spec.open_questions as string[] | undefined) || [];

  // ── Walk menu items recursively ──
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
      if (!item.type)  errors.push(`${fullPath}: missing required field "type"`);

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

      // Recurse
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

  // ── Grids ─────────────────────────────────────────────────────────────────
  const grids = spec.grids as Record<string, unknown>[] | undefined;
  if (grids && Array.isArray(grids)) {
    for (const grid of grids) {
      const gPath = `grids["${grid.page}"]`;
      if (!grid.page)     errors.push(`${gPath}: missing "page"`);
      if (!grid.category) errors.push(`${gPath}: missing "category"`);
      if (grid.particle && !VALID_PARTICLES.has(String(grid.particle))) {
        errors.push(`${gPath}: invalid particle "${grid.particle}"`);
      }
    }
  }

  // ── Module quicklinks — #8 ────────────────────────────────────────────────
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

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Run the menu-interpreter sub-agent.
 *
 * Receives raw menu document text, runs Phase 1 (classify) and Phase 2
 * (lint/validate) via a Sonnet agentic loop, and returns a validated
 * Menu Spec JSON or a structured error.
 */
export async function runMenuInterpreter(
  args: MenuInterpreterArgs,
  sendProgress: (progress: number, total: number) => Promise<void>
): Promise<MenuInterpreterResult> {
  const { site_url, menu_text, source_filename = "menu document" } = args;

  // Load config (system prompt + model + tool allow list + downstreams)
  const config = await loadSubAgentConfig("menu-interpreter");

  // Connect to the declared downstreams (e.g. joomla-mcp for joomla_workspace_write).
  // The allow-list is passed through so the bridge advertises only permitted tools
  // AND enforces the same list at execution time (see buildExecutor) — no separate
  // filter is needed here.
  const { tools: allowedTools, executor } = await connectDownstreams(
    config.downstreams,
    site_url,
    config.allow
  );

  const today = new Date().toISOString().slice(0, 10);

  const userMessage = [
    `Interpret the following menu document for site: ${site_url}`,
    `Source document: ${source_filename}`,
    `Today's date: ${today}`,
    "",
    "--- MENU DOCUMENT START ---",
    menu_text.trim(),
    "--- MENU DOCUMENT END ---",
    "",
    "Produce the Menu Spec JSON following the rules in your system prompt.",
    "1. Persist the spec with joomla_workspace_write.",
    "2. Then return the complete spec JSON as your final text response (no prose, no code fences).",
  ].join("\n");

  // Run the sub-agent agentic loop
  const result = await runSubAgent({
    systemPrompt: config.instructions,
    tools: allowedTools,
    toolExecutor: executor,
    userMessage,
    model: config.model,
    maxIterations: 20,
    onIteration: async (current, max) => {
      await sendProgress(current, max);
    },
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Parse the result — runtime.ts already tries JSON.parse on end_turn text
  const rawResult = result.result;
  let spec: Record<string, unknown> | null = null;

  if (typeof rawResult === "object" && rawResult !== null) {
    spec = rawResult as Record<string, unknown>;
  } else if (typeof rawResult === "string") {
    try {
      spec = JSON.parse(rawResult);
    } catch {
      return {
        success: false,
        error: "Sub-agent returned non-JSON final response",
        partial_spec: rawResult,
      };
    }
  }

  if (!spec) {
    return { success: false, error: "Sub-agent returned an empty result" };
  }

  // Check for error envelope from the sub-agent itself
  if (spec.success === false && typeof spec.error === "string") {
    return { success: false, error: spec.error, partial_spec: spec };
  }

  // Run the 8 lint invariants
  const lintErrors = lintSpec(spec);
  if (lintErrors.length > 0) {
    return {
      success: false,
      error: `Spec failed ${lintErrors.length} lint check(s)`,
      lint_errors: lintErrors,
      partial_spec: spec,
    };
  }

  return { success: true, spec };
}
