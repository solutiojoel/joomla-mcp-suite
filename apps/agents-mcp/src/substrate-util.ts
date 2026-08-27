import { DesignSpec } from "./design-spec.js";

/**
 * Phase 2 — provision the Joomla article/category substrate a Design Spec's
 * bindings require, then stamp the real ids back into the spec.
 *
 * NO LLM. There is no judgement in the job — for each binding: look inside the
 * build's scope, create or copy if missing, stamp the id. Every decision was
 * made in the spec and approved at Gate 1.
 *
 * ── The two build types have different rules, and this is the whole point ──
 *
 * `new` — a forge install with no live site. Categories sit at root and the
 *   fleet skeleton already carries most of what a homepage needs (Mass Times,
 *   Mission Statement, Footer, Rotator, Headlines / News…). Bindings resolve to
 *   those existing rows; usually nothing is created at all.
 *
 * `redesign` — the new site shares its Joomla install with a LIVE one. Two hard
 *   rules follow, and breaking either is how you damage a live site:
 *     1. Every row this build touches lives under the redesign parent category.
 *        Lookups NEVER match outside that scope, so a homepage can never be
 *        bound to a live category that happens to share a title.
 *     2. When a role's content exists live but not in scope, it is COPIED into
 *        the redesign scope. The live row is read and never written.
 *
 * Safety model, both types:
 *   - search always precedes create, so a re-run creates nothing;
 *   - an existing article's body is NEVER updated — it holds real client work;
 *   - nothing is ever deleted, unpublished, or re-parented;
 *   - an ambiguous match inside the scope is an error, never a guess;
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
  outcome: "created" | "would_create" | "reused" | "copied" | "would_copy" | "failed";
  detail?: string;
  /** copied only: the live row the content came from. Never modified. */
  copied_from?: number;
}

export interface SubstrateReport {
  build_type: "new" | "redesign";
  /** redesign only: the parent every created row nests under. */
  redesign_root_id?: number | null;
  /** redesign only: its title, as resolved. */
  redesign_root?: string | null;
  created: SubstrateItem[];
  would_create: SubstrateItem[];
  reused: SubstrateItem[];
  /** redesign only: live content duplicated into the redesign scope. */
  copied: SubstrateItem[];
  errors: SubstrateItem[];
  /** True once every binding in the spec carries a real id. */
  substrate_resolved: boolean;
}

interface JoomlaResult {
  success?: boolean;
  message?: string;
  data?: any;
}

export function asResult(res: unknown): JoomlaResult {
  if (typeof res === "object" && res !== null) return res as JoomlaResult;
  return { success: true, message: typeof res === "string" ? res : undefined };
}

/** The bridge executor throws on downstream isError (e.g. a get-by-title miss),
 *  so normalize both shapes and let lookups fall through to "not found". */
export async function callSafe(
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

export function rows(res: JoomlaResult): any[] {
  const d = res?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.rows)) return d.rows;
  return [];
}

export function toId(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Exact, case- and whitespace-insensitive title match. Deliberately strict:
 *  a fuzzy match here would silently bind a section to the wrong article. */
export function titleEq(a: unknown, b: unknown): boolean {
  return String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
}

/** Seed content is optional in the spec; an empty article renders as a broken
 *  section, so every created article gets at least a visible placeholder. */
export function seedOrPlaceholder(seed: string | undefined, title: string): string {
  const trimmed = (seed ?? "").trim();
  if (trimmed) return trimmed;
  return `<p>${title} content to be added.</p>`;
}

