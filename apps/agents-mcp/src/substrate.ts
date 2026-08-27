import { DesignSpec, ContentBinding, collectBindings } from "./design-spec.js";

/**
 * Phase 2 — provision the Joomla article/category substrate a Design Spec's
 * bindings require, then stamp the real ids back into the spec.
 *
 * NO LLM. The draft made this a Haiku sub-agent; implementing it showed there
 * is no judgment in the job — for each binding: search by exact title, create
 * if missing, stamp the id. Every decision was already made in the spec and
 * approved at Gate 1, so a model here would only add variance to a loop.
 *
 * Safety model (this runs before any layout work, against a live site):
 *   - search always precedes create, so a re-run creates nothing;
 *   - an existing article's body is NEVER touched — it holds real client work;
 *   - an ambiguous title match is reported as an error, never guessed;
 *   - dry_run reports the full plan without writing.
 */

export type Executor = (name: string, args: Record<string, any>) => Promise<any>;

export interface SubstrateOptions {
  executor: Executor;
  spec: DesignSpec;
  dry_run?: boolean;
}

export interface SubstrateItem {
  role: string;
  kind: "article" | "category";
  title: string;
  id?: number;
  outcome: "created" | "would_create" | "reused" | "failed";
  detail?: string;
}

export interface SubstrateReport {
  created: SubstrateItem[];
  would_create: SubstrateItem[];
  reused: SubstrateItem[];
  errors: SubstrateItem[];
  /** True once every binding in the spec carries a real id. */
  substrate_resolved: boolean;
}

interface JoomlaResult {
  success?: boolean;
  message?: string;
  data?: any;
}

function asResult(res: unknown): JoomlaResult {
  if (typeof res === "object" && res !== null) return res as JoomlaResult;
  return { success: true, message: typeof res === "string" ? res : undefined };
}

/** The bridge executor throws on downstream isError (e.g. a get-by-title miss),
 *  so normalize both shapes and let lookups fall through to "not found". */
async function callSafe(
  executor: Executor,
  name: string,
  args: Record<string, any>
): Promise<JoomlaResult> {
  try {
    return asResult(await executor(name, args));
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function rows(res: JoomlaResult): any[] {
  const d = res?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.rows)) return d.rows;
  return [];
}

function toId(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Exact, case- and whitespace-insensitive title match. Deliberately strict:
 *  a fuzzy match here would silently bind a section to the wrong article. */
function titleEq(a: unknown, b: unknown): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** Seed content is optional in the spec; an empty article renders as a broken
 *  section, so every created article gets at least a visible placeholder. */
export function seedOrPlaceholder(seed: string | undefined, title: string): string {
  const trimmed = (seed ?? "").trim();
  if (trimmed) return trimmed;
  return `<p>${title} content to be added.</p>`;
}

export async function buildSubstrate(opts: SubstrateOptions): Promise<SubstrateReport> {
  const { executor, spec, dry_run = false } = opts;
  const report: SubstrateReport = {
    created: [],
    would_create: [],
    reused: [],
    errors: [],
    substrate_resolved: false,
  };

  // Category cache: several bindings usually share one parent, and article
  // creation needs its parent's id resolved first.
  const categoryIds = new Map<string, number>();

  const findCategory = async (title: string): Promise<number | undefined | "ambiguous"> => {
    const key = title.trim().toLowerCase();
    if (categoryIds.has(key)) return categoryIds.get(key);
    const res = await callSafe(executor, "joomla_category", { action: "list" });
    const matches = rows(res).filter((r) => titleEq(r.title, title));
    if (matches.length > 1) return "ambiguous";
    const id = toId(matches[0]?.id);
    if (id) categoryIds.set(key, id);
    return id;
  };

  const ensureCategory = async (
    title: string,
    parentTitle: string | undefined,
    role: string
  ): Promise<number | undefined> => {
    const found = await findCategory(title);
    if (found === "ambiguous") {
      report.errors.push({
        role,
        kind: "category",
        title,
        outcome: "failed",
        detail: `two or more categories are titled '${title}' — resolve by hand and set existing_id in the spec`,
      });
      return undefined;
    }
    if (found) {
      report.reused.push({ role, kind: "category", title, id: found, outcome: "reused" });
      return found;
    }

    let parentId: number | undefined;
    if (parentTitle) {
      const p = await findCategory(parentTitle);
      if (p === "ambiguous") {
        report.errors.push({
          role,
          kind: "category",
          title,
          outcome: "failed",
          detail: `parent category '${parentTitle}' is ambiguous`,
        });
        return undefined;
      }
      parentId = p;
      if (!parentId && !dry_run) {
        // Create the parent so the child can hang off it.
        const pRes = await callSafe(executor, "joomla_category", {
          action: "create",
          title: parentTitle,
        });
        parentId = toId(pRes?.data?.id ?? pRes?.data?.categoryId);
        if (parentId) {
          categoryIds.set(parentTitle.trim().toLowerCase(), parentId);
          report.created.push({
            role: `${role}__parent`,
            kind: "category",
            title: parentTitle,
            id: parentId,
            outcome: "created",
          });
        }
      }
    }

    if (dry_run) {
      report.would_create.push({ role, kind: "category", title, outcome: "would_create" });
      return undefined;
    }

    const args: Record<string, any> = { action: "create", title };
    if (parentId) args.parent_id = String(parentId);
    const res = await callSafe(executor, "joomla_category", args);
    const id = toId(res?.data?.id ?? res?.data?.categoryId);
    if (!id) {
      report.errors.push({
        role,
        kind: "category",
        title,
        outcome: "failed",
        detail: res.message || "create returned no id",
      });
      return undefined;
    }
    categoryIds.set(title.trim().toLowerCase(), id);
    report.created.push({ role, kind: "category", title, id, outcome: "created" });
    return id;
  };

  const ensureArticle = async (
    binding: ContentBinding
  ): Promise<number | undefined> => {
    const create = binding.create;
    const title = create?.title ?? "";
    const role = binding.role;

    const search = await callSafe(executor, "joomla_article", { action: "list", search: title });
    const matches = rows(search).filter((r) => titleEq(r.title, title));
    if (matches.length > 1) {
      report.errors.push({
        role,
        kind: "article",
        title,
        outcome: "failed",
        detail: `two or more articles are titled '${title}' (ids ${matches
          .map((m) => m.id)
          .join(", ")}) — resolve by hand and set existing_id in the spec`,
      });
      return undefined;
    }
    const existing = toId(matches[0]?.id);
    if (existing) {
      // Never touch the body: an existing article holds real client content.
      report.reused.push({ role, kind: "article", title, id: existing, outcome: "reused" });
      return existing;
    }

    // Resolve the article's category before creating it.
    let categoryId: number | undefined;
    if (create?.category) {
      categoryId = await ensureCategory(create.category, create.parent, `${role}__category`);
      if (!categoryId && !dry_run) {
        report.errors.push({
          role,
          kind: "article",
          title,
          outcome: "failed",
          detail: `could not resolve category '${create.category}'`,
        });
        return undefined;
      }
    }

    if (dry_run) {
      report.would_create.push({ role, kind: "article", title, outcome: "would_create" });
      return undefined;
    }

    const res = await callSafe(executor, "joomla_article", {
      action: "create",
      title,
      categoryId: categoryId ? String(categoryId) : undefined,
      content: seedOrPlaceholder(create?.seed_content, title),
      state: "1",
    });
    const id = toId(res?.data?.id ?? res?.data?.articleId);
    if (!id) {
      report.errors.push({
        role,
        kind: "article",
        title,
        outcome: "failed",
        detail: res.message || "create returned no id",
      });
      return undefined;
    }
    report.created.push({ role, kind: "article", title, id, outcome: "created" });
    return id;
  };

  // ── walk the spec in section order ────────────────────────────────────────
  for (const { binding } of collectBindings(spec)) {
    if (binding.existing_id) continue; // already resolved — leave it alone

    const create = binding.create;
    if (!create?.title) {
      report.errors.push({
        role: binding.role,
        kind: binding.kind,
        title: "(none)",
        outcome: "failed",
        detail: "binding has neither existing_id nor create.title",
      });
      continue;
    }

    const id =
      binding.kind === "category"
        ? await ensureCategory(create.title, create.parent, binding.role)
        : await ensureArticle(binding);

    if (id) {
      binding.existing_id = id;
      binding.created_by_build = report.created.some(
        (c) => c.role === binding.role && c.id === id
      );
    }
  }

  const all = collectBindings(spec);
  report.substrate_resolved =
    all.length > 0 && all.every((b) => !!b.binding.existing_id);
  return report;
}
