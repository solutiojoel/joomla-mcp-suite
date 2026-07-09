/**
 * Content Schematic derivation — the deterministic half of the content pass.
 *
 * `collectContentNodes(spec)` walks an approved Menu Spec and produces the
 * canonical set of content-bearing entries (the scaffold). Because the entry
 * set is a pure function of the spec, the schematic can never drift from the
 * skeleton: after any spec edit, `deriveContentSchematic(spec, existing)`
 * reconciles — new nodes become `todo` entries, removed nodes go `orphaned`
 * (content preserved), and all interpreter/human-filled fields survive.
 *
 * The schematic-validator's cross-lint reuses `collectContentNodes` as its
 * source of truth, so derivation and lint cannot disagree.
 *
 * Field ownership and lifecycle: docs/kb/content-schematic-schema.md.
 * Schema: config/agents/content-build/content-schematic.schema.json.
 */

export interface SchematicEntry {
  node_key: string;
  kind: "single_article" | "grid_landing" | "grid_member" | "category_landing" | "docman";
  title: string;
  menu_path?: string;
  category?: string;
  content_source: string;
  joomla_article_id?: string;
  spec_notes?: string;
  instructions?: string;
  source_url?: string;
  copy?: string;
  assets?: string[];
  features?: Array<{ kind: string; kb_ref?: string; notes?: string }>;
  /** Workspace path of the fetched source markdown (fetch_source_content). */
  source_file?: string;
  /** Workspace path of the final page HTML (content-writer harness). */
  content_file?: string;
  /** True when the writer generated the page from scratch — flag for review. */
  draft?: boolean;
  /** ISO timestamp the HTML was applied to the Joomla article (apply_content). */
  applied_at?: string;
  status: "todo" | "filled" | "needs_input" | "blocked" | "written" | "done" | "orphaned";
  notes?: string;
}

export interface ContentSchematic {
  site: string;
  source?: string;
  menu_spec_file?: string;
  generated?: string;
  derived_at?: string;
  entries: SchematicEntry[];
  open_questions?: string[];
  assumptions?: string[];
}

export interface DeriveChanges {
  added: string[];
  updated: string[];
  orphaned: string[];
}

export interface DeriveResult {
  schematic: ContentSchematic;
  changes: DeriveChanges;
}

/** Fields owned by the derivation — refreshed from the spec on every merge.
 *  Everything else on an entry (instructions, source_url, copy, assets,
 *  features, notes, status) is preserved. */
const DERIVE_OWNED = [
  "kind",
  "title",
  "menu_path",
  "category",
  "content_source",
  "spec_notes",
  "joomla_article_id",
] as const;

type Spec = Record<string, unknown>;
type SpecItem = Record<string, unknown>;

interface GridDef {
  page?: string;
  menu_ref?: string;
  category?: string;
  members?: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asRec(entry: SchematicEntry): Record<string, unknown> {
  return entry as unknown as Record<string, unknown>;
}

/** Scaffold entry skeleton: derive-owned fields only, no content fields. */
export function collectContentNodes(spec: Spec): SchematicEntry[] {
  const entries: SchematicEntry[] = [];
  const seen = new Set<string>();
  const grids = (Array.isArray(spec.grids) ? spec.grids : []) as GridDef[];
  const articleIds = ((spec.joomla_ids as Record<string, unknown> | undefined)?.articles ??
    {}) as Record<string, unknown>;

  // A grid's menu_ref (falling back to page) names the menu item that renders
  // it — that node becomes a grid_landing, even if its spec type is heading.
  const gridByMenuRef = new Map<string, GridDef>();
  for (const grid of grids) {
    const ref = str(grid.menu_ref) ?? str(grid.page);
    if (ref) gridByMenuRef.set(ref, grid);
  }

  function articleId(title: string): string | undefined {
    // Phase 4 titles grid landing articles "{title} (landing)".
    const hit = articleIds[title] ?? articleIds[`${title} (landing)`];
    return hit === undefined || hit === null ? undefined : String(hit);
  }

  function push(entry: SchematicEntry): void {
    if (seen.has(entry.node_key)) return;
    seen.add(entry.node_key);
    // Drop keys set to undefined — the schema walker (and JSON round-trips)
    // must see optional fields as absent, not present-but-undefined.
    for (const [k, v] of Object.entries(entry)) {
      if (v === undefined) delete asRec(entry)[k];
    }
    entries.push(entry);
  }

  function walk(items: unknown[], menuName: string, titlePath: string[]): void {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const item = raw as SpecItem;
      const title = String(item.title ?? "");
      const type = String(item.type ?? "");
      const pathSegs = [...titlePath, title];
      const nodeKey = `${menuName}:${pathSegs.join("/")}`;
      const menuPath = pathSegs.join(" / ");
      const grid = gridByMenuRef.get(title);

      if (type === "category_grid" || (type === "heading" && grid)) {
        // Grid landing page — Phase 4 builds "{title} (landing)" in Page Content.
        push({
          node_key: nodeKey,
          kind: "grid_landing",
          title,
          menu_path: menuPath,
          category: "Page Content",
          content_source: str(item.content_source) ?? "generate",
          joomla_article_id: articleId(title),
          spec_notes: str(item.notes),
          status: "todo",
        });
      } else if (type === "single_article") {
        push({
          node_key: nodeKey,
          kind: "single_article",
          title,
          menu_path: menuPath,
          category: str(item.category) ?? "Page Content",
          content_source: str(item.content_source) ?? "generate",
          joomla_article_id: articleId(title),
          spec_notes: str(item.notes),
          status: "todo",
        });
      } else if (type === "category_blog" || type === "category_list") {
        push({
          node_key: nodeKey,
          kind: "category_landing",
          title,
          menu_path: menuPath,
          category: str(item.category),
          content_source: str(item.content_source) ?? "generate",
          joomla_article_id: articleId(title),
          spec_notes: str(item.notes),
          status: "todo",
        });
      } else if (type === "docman") {
        push({
          node_key: nodeKey,
          kind: "docman",
          title,
          menu_path: menuPath,
          category: str(item.category),
          content_source: str(item.content_source) ?? "none",
          spec_notes: str(item.notes),
          status: "blocked",
        });
      }
      // heading (without a grid), external_url, alias: no content of their own.

      if (Array.isArray(item.children)) {
        walk(item.children, menuName, pathSegs);
      }
    }
  }

  const menus = (spec.menus ?? {}) as Record<string, unknown[]>;
  for (const [menuName, items] of Object.entries(menus)) {
    walk(items as unknown[], menuName, []);
  }

  // Grid members: articles in the grid's named category, keyed by the grid page.
  for (const grid of grids) {
    const page = str(grid.page) ?? str(grid.menu_ref);
    if (!page) continue;
    const menuRef = str(grid.menu_ref) ?? page;
    // Inherit content_source from the grid's menu node when it has one.
    const landing = entries.find((e) => e.kind === "grid_landing" && e.title === menuRef);
    for (const member of grid.members ?? []) {
      const memberTitle = String(member);
      push({
        node_key: `grid:${page}/${memberTitle}`,
        kind: "grid_member",
        title: memberTitle,
        menu_path: landing?.menu_path ?? page,
        category: str(grid.category),
        content_source: landing?.content_source ?? "generate",
        joomla_article_id: articleId(memberTitle),
        status: "todo",
      });
    }
  }

  return entries;
}

/** Spec nodes that intentionally get NO schematic entry (external redirects,
 *  aliases, plain separators). Passed to the content-interpreter so it can
 *  tell "intentionally excluded" from "removed from the menu" when the PDF
 *  mentions these pages. */
export function collectExcludedNodes(spec: Spec): Array<{ title: string; type: string }> {
  const excluded: Array<{ title: string; type: string }> = [];
  const grids = (Array.isArray(spec.grids) ? spec.grids : []) as GridDef[];
  const gridRefs = new Set(
    grids.map((g) => str(g.menu_ref) ?? str(g.page)).filter((v): v is string => !!v)
  );

  function walk(items: unknown[]): void {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      const item = raw as SpecItem;
      const title = String(item.title ?? "");
      const type = String(item.type ?? "");
      if (type === "external_url" || type === "alias" || (type === "heading" && !gridRefs.has(title))) {
        excluded.push({ title, type });
      }
      if (Array.isArray(item.children)) walk(item.children);
    }
  }

  const menus = (spec.menus ?? {}) as Record<string, unknown[]>;
  for (const items of Object.values(menus)) walk(items as unknown[]);
  return excluded;
}

/**
 * Derive a fresh schematic from the spec, or merge into an existing one.
 *
 * Merge rules (see kb/content-schematic-schema):
 * - derive-owned fields are refreshed from the spec;
 * - interpreter/human fields are preserved verbatim;
 * - new nodes → `todo` (docman → `blocked`);
 * - existing nodes keep their status (a previously-orphaned node that
 *   reappears goes back to `filled`/`todo` based on whether it has content);
 * - nodes gone from the spec → `orphaned`, content kept for salvage.
 */
export function deriveContentSchematic(
  spec: Spec,
  existing?: ContentSchematic | null,
  opts?: { source?: string; menu_spec_file?: string; now?: Date }
): DeriveResult {
  const scaffold = collectContentNodes(spec);
  const now = opts?.now ?? new Date();
  const changes: DeriveChanges = { added: [], updated: [], orphaned: [] };

  const existingByKey = new Map<string, SchematicEntry>();
  for (const entry of existing?.entries ?? []) {
    existingByKey.set(entry.node_key, entry);
  }

  const merged: SchematicEntry[] = [];
  const liveKeys = new Set<string>();

  for (const fresh of scaffold) {
    liveKeys.add(fresh.node_key);
    const prev = existingByKey.get(fresh.node_key);
    if (!prev) {
      changes.added.push(fresh.node_key);
      merged.push(fresh);
      continue;
    }

    const entry: SchematicEntry = { ...prev };
    let changed = false;
    for (const field of DERIVE_OWNED) {
      const nextVal = asRec(fresh)[field];
      const prevVal = asRec(entry)[field];
      if (nextVal === undefined) {
        if (prevVal !== undefined && field !== "joomla_article_id") {
          // A derive-owned field the spec no longer supplies is cleared —
          // except a previously stamped article ID, which stays.
          delete asRec(entry)[field];
          changed = true;
        }
      } else if (nextVal !== prevVal) {
        asRec(entry)[field] = nextVal;
        changed = true;
      }
    }
    if (entry.status === "orphaned") {
      entry.status = entry.instructions || entry.copy ? "filled" : "todo";
      changed = true;
    }
    if (changed) changes.updated.push(entry.node_key);
    merged.push(entry);
  }

  for (const prev of existing?.entries ?? []) {
    if (liveKeys.has(prev.node_key)) continue;
    if (prev.status !== "orphaned") changes.orphaned.push(prev.node_key);
    merged.push({ ...prev, status: "orphaned" });
  }

  const schematic: ContentSchematic = {
    site: String(spec.site ?? existing?.site ?? ""),
    source: opts?.source ?? existing?.source ?? str(spec.source),
    menu_spec_file: opts?.menu_spec_file ?? existing?.menu_spec_file,
    generated: existing?.generated ?? now.toISOString().slice(0, 10),
    derived_at: now.toISOString(),
    entries: merged,
    open_questions: existing?.open_questions ?? [],
    assumptions: existing?.assumptions ?? [],
  };
  if (!schematic.source) delete schematic.source;
  if (!schematic.menu_spec_file) delete schematic.menu_spec_file;

  return { schematic, changes };
}
