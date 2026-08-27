import { BuildType, FLEET_CONTENT, FLEET_CATEGORIES } from "./design-spec.js";

/**
 * Phase 0 — survey the install before anything is designed or built.
 *
 * NO LLM. Answers three questions a site build cannot proceed safely without:
 *
 *   1. Is this a new build or a redesign?  A redesign shares its Joomla install
 *      with a LIVE site, so the substrate stage's rules change completely.
 *   2. What content is already prepared?   Menu-build and content-build usually
 *      run first, so most bindings should resolve to rows that already exist.
 *   3. What is genuinely missing?          Only that gets created.
 *
 * This runs BEFORE Gate 1 on purpose. Reviewing the spec without knowing which
 * sections reuse prepared content and which create new is reviewing half the
 * decision.
 */

export type Executor = (name: string, args: Record<string, any>) => Promise<any>;

/** Templates still in use. Anything else is a strong redesign signal — the
 *  fleet block classes are written against Studius and have no CSS elsewhere. */
const CURRENT_THEMES = ["studius", "rt_studius", "g5_studius"];

export interface SurveySignal {
  name: string;
  value: string | number;
  points_to: BuildType | "unclear";
  note: string;
}

export interface PreparedItem {
  role: string;
  kind: "article" | "category";
  title: string;
  id: number;
  category?: string;
  /** redesign only: is this row inside the redesign scope, or live content? */
  in_scope?: boolean;
}

export interface SurveyReport {
  build_type: BuildType;
  confidence: "high" | "low";
  signals: SurveySignal[];
  counts: { categories: number; articles: number; nested_categories: number };
  /** redesign only. */
  redesign_root?: { title: string; id: number } | null;
  /** Fleet roles that already have a row, ready to bind. */
  prepared: PreparedItem[];
  /** Fleet roles with no row anywhere — the substrate stage will create these. */
  missing: string[];
  /** Live rows a redesign will COPY rather than bind to. */
  will_copy: PreparedItem[];
  warnings: string[];
}

interface JoomlaResult { success?: boolean; message?: string; data?: any }

async function callSafe(ex: Executor, name: string, args: Record<string, any>): Promise<JoomlaResult> {
  try {
    const res = await ex(name, args);
    if (typeof res === "object" && res !== null) return res as JoomlaResult;
    return { success: true, message: typeof res === "string" ? res : undefined };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function rows(res: JoomlaResult): any[] {
  const d = res?.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.items)) return d.items;
  return [];
}

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();
const toId = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export interface SurveyOptions {
  executor: Executor;
  /** Override the inference — the operator usually knows. */
  build_type?: BuildType;
  /** redesign only: the parent category title. Default "Redesign". */
  redesign_root?: string;
  /** Theme in use, when the caller already knows it. */
  theme?: string;
}

export async function surveySite(opts: SurveyOptions): Promise<SurveyReport> {
  const { executor, theme } = opts;
  const warnings: string[] = [];
  const signals: SurveySignal[] = [];

  const catRes = await callSafe(executor, "joomla_category", { action: "list", limit: 500 });
  const cats = rows(catRes);
  const artRes = await callSafe(executor, "joomla_article", { action: "list", limit: 500 });
  const arts = rows(artRes);

  // A stock forge install is flat: every category sits at root.
  const nested = cats.filter((c) => String(c.parent ?? "").trim() !== "").length;

  // ── infer the build type ────────────────────────────────────────────────
  // Measured against shannon.forge, the canonical new-build starting point:
  // 13 categories (all root), 41 articles, the fleet skeleton present.
  signals.push({
    name: "category_count",
    value: cats.length,
    points_to: cats.length > 30 ? "redesign" : cats.length > 0 ? "new" : "unclear",
    note: "a forge install carries ~13; a live site accumulates many more",
  });
  signals.push({
    name: "article_count",
    value: arts.length,
    points_to: arts.length > 150 ? "redesign" : arts.length > 0 ? "new" : "unclear",
    note: "a forge install carries ~41; a live parish site usually has hundreds",
  });
  signals.push({
    name: "nested_categories",
    value: nested,
    points_to: nested > 3 ? "redesign" : "new",
    note: "the forge skeleton is flat — nesting means a real content tree",
  });

  const fleetPresent = FLEET_CATEGORIES.filter((f) =>
    cats.some((c) => norm(c.title) === norm(f))
  ).length;
  signals.push({
    name: "fleet_skeleton",
    value: `${fleetPresent}/${FLEET_CATEGORIES.length}`,
    points_to: fleetPresent >= 5 ? "new" : "unclear",
    note: "the standard forge categories (Rotator, Alert, Homepage Articles…)",
  });

  if (theme) {
    const current = CURRENT_THEMES.some((t) => norm(theme).includes(t));
    signals.push({
      name: "theme",
      value: theme,
      points_to: current ? "new" : "redesign",
      note: current
        ? "a current fleet theme"
        : "a legacy template — fleet block classes have no CSS here, so plan a CSS pass",
    });
    if (!current) {
      warnings.push(
        `Theme '${theme}' is not a current fleet theme. Block classes from the pattern catalogue will have ruleCount 0 — plan the CSS pass from the start.`
      );
    }
  }

  const votes = signals.filter((s) => s.points_to !== "unclear");
  const redesignVotes = votes.filter((s) => s.points_to === "redesign").length;
  const inferred: BuildType = redesignVotes > votes.length / 2 ? "redesign" : "new";
  const build_type = opts.build_type ?? inferred;
  const confidence =
    opts.build_type || redesignVotes === 0 || redesignVotes === votes.length ? "high" : "low";

  if (opts.build_type && opts.build_type !== inferred) {
    warnings.push(
      `Told this is a '${opts.build_type}' build, but the install looks like '${inferred}' (${cats.length} categories, ${arts.length} articles). Proceeding as told — confirm this is right.`
    );
  }
  if (confidence === "low") {
    warnings.push(
      "Build type is ambiguous from the install alone. Confirm before the substrate stage runs — a redesign has different safety rules."
    );
  }

  // ── redesign scope ──────────────────────────────────────────────────────
  let redesignRoot: { title: string; id: number } | null = null;
  let scopeIds = new Set<number>();

  if (build_type === "redesign") {
    const wanted = opts.redesign_root ?? "Redesign";
    const match = cats.find((c) => norm(c.title) === norm(wanted));
    const id = toId(match?.id);
    if (id) {
      redesignRoot = { title: String(match.title), id };
      // Everything under the root, one level of nesting (the fleet convention).
      scopeIds.add(id);
      for (const c of cats) {
        if (norm(c.parent) === norm(match.title)) {
          const cid = toId(c.id);
          if (cid) scopeIds.add(cid);
        }
      }
    } else {
      warnings.push(
        `No '${wanted}' parent category exists yet. The substrate stage will create it, and every category this build needs will be nested under it.`
      );
    }
  }

  // ── what is already prepared ────────────────────────────────────────────
  const prepared: PreparedItem[] = [];
  const missing: string[] = [];
  const will_copy: PreparedItem[] = [];

  for (const [role, want] of Object.entries(FLEET_CONTENT)) {
    if (want.kind === "category") {
      const hits = cats.filter((c) => norm(c.title) === norm(want.title));
      const inScope = hits.find((c) => scopeIds.has(toId(c.id) ?? -1));
      const anyHit = inScope ?? hits[0];
      const id = toId(anyHit?.id);
      if (!id) {
        missing.push(role);
        continue;
      }
      const item: PreparedItem = {
        role, kind: "category", title: String(anyHit.title), id,
        in_scope: build_type === "redesign" ? !!inScope : undefined,
      };
      if (build_type === "redesign" && !inScope) will_copy.push(item);
      else prepared.push(item);
    } else {
      const hits = arts.filter((a) => norm(a.title) === norm(want.title));
      const inScope = hits.find((a) => scopeIds.has(toId(a.categoryId) ?? -1));
      const anyHit = inScope ?? hits[0];
      const id = toId(anyHit?.id);
      if (!id) {
        missing.push(role);
        continue;
      }
      const item: PreparedItem = {
        role, kind: "article", title: String(anyHit.title), id,
        category: String(anyHit.category ?? ""),
        in_scope: build_type === "redesign" ? !!inScope : undefined,
      };
      if (build_type === "redesign" && !inScope) will_copy.push(item);
      else prepared.push(item);
    }
  }

  if (build_type === "redesign" && will_copy.length) {
    warnings.push(
      `${will_copy.length} role(s) match LIVE content outside the redesign scope. They will be COPIED into the redesign categories, never bound to — the live rows are not touched.`
    );
  }

  return {
    build_type,
    confidence,
    signals,
    counts: { categories: cats.length, articles: arts.length, nested_categories: nested },
    redesign_root: build_type === "redesign" ? redesignRoot : undefined,
    prepared,
    missing,
    will_copy,
    warnings,
  };
}
