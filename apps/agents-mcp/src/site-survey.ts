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

/**
 * Resolving the redesign parent category.
 *
 * The name is not fixed — it might be "Redesign", "New Site", "Rebuild 2026",
 * or the site code. Defaulting to a literal "Redesign" is actively unsafe: on
 * an install where the parent is called something else it would create a SECOND
 * parent and split the build across two trees.
 *
 * So it is resolved from evidence, and an ambiguous result is reported rather
 * than guessed. The strongest signal is structural: a redesign parent is the
 * category whose children recreate the fleet skeleton, because that is exactly
 * what a redesign is — the standard category set, nested one level down.
 */
export interface RedesignRootCandidate {
  id: number;
  title: string;
  score: number;
  children: string[];
  evidence: string[];
}

export interface RedesignRootResolution {
  resolved: { id: number; title: string } | null;
  candidates: RedesignRootCandidate[];
  ambiguous: boolean;
  reason: string;
}

const REDESIGN_NAME_RE = /\b(re-?design|new\s*site|rebuild|refresh|new\s*look)\b/i;

export function resolveRedesignRoot(
  cats: any[],
  opts: { explicit?: string; explicitId?: number | null; site_notes?: string } = {}
): RedesignRootResolution {
  const norm2 = (v: unknown) => String(v ?? "").trim().toLowerCase();

  // 1. An explicit id always wins — it came from a previous survey or a human.
  if (opts.explicitId) {
    const row = cats.find((c) => toId(c.id) === opts.explicitId);
    if (row) {
      return {
        resolved: { id: opts.explicitId, title: String(row.title) },
        candidates: [], ambiguous: false,
        reason: `resolved from the id supplied by the caller`,
      };
    }
  }

  // 2. An explicit title, matched exactly.
  if (opts.explicit) {
    const hits = cats.filter((c) => norm2(c.title) === norm2(opts.explicit));
    if (hits.length === 1) {
      return {
        resolved: { id: toId(hits[0].id)!, title: String(hits[0].title) },
        candidates: [], ambiguous: false,
        reason: `matched the name '${opts.explicit}' supplied by the caller`,
      };
    }
    if (hits.length > 1) {
      return {
        resolved: null,
        candidates: hits.map((c) => ({
          id: toId(c.id)!, title: String(c.title), score: 0, children: [], evidence: ["duplicate title"],
        })),
        ambiguous: true,
        reason: `${hits.length} categories are titled '${opts.explicit}' — name the id instead`,
      };
    }
    // Not found: the caller named a parent that does not exist yet. That is a
    // legitimate first-run state, so it is resolvable-by-creation, not ambiguous.
    return {
      resolved: null, candidates: [], ambiguous: false,
      reason: `no category named '${opts.explicit}' exists yet — it will be created`,
    };
  }

  // 3. Infer. Only categories that actually have children can be a parent.
  const childrenOf = new Map<string, any[]>();
  for (const c of cats) {
    const p = norm2(c.parent);
    if (!p) continue;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(c);
  }

  const notes = norm2(opts.site_notes);
  const candidates: RedesignRootCandidate[] = [];

  for (const c of cats) {
    const id = toId(c.id);
    if (!id) continue;
    const kids = childrenOf.get(norm2(c.title)) ?? [];
    if (!kids.length) continue;

    const evidence: string[] = [];
    let score = 0;

    const fleetKids = kids.filter((k) =>
      FLEET_CATEGORIES.some((f) => norm2(f) === norm2(k.title))
    );
    if (fleetKids.length) {
      score += fleetKids.length * 3;
      evidence.push(
        `${fleetKids.length} child categor${fleetKids.length === 1 ? "y" : "ies"} from the fleet skeleton (${fleetKids
          .map((k) => k.title).join(", ")})`
      );
    }

    if (REDESIGN_NAME_RE.test(String(c.title))) {
      score += 5;
      evidence.push(`the name reads like a redesign parent`);
    }

    if (notes && notes.includes(norm2(c.title)) && /re-?design/.test(notes)) {
      score += 6;
      evidence.push(`named in the site notes alongside "redesign"`);
    }

    if (kids.length >= 3) {
      score += 1;
      evidence.push(`${kids.length} child categories`);
    }

    if (score > 0) {
      candidates.push({
        id, title: String(c.title), score,
        children: kids.map((k) => String(k.title)),
        evidence,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (!candidates.length) {
    return {
      resolved: null, candidates: [], ambiguous: false,
      reason: "no category looks like a redesign parent — name it explicitly, or one will be created",
    };
  }

  const [top, second] = candidates;
  // A clear winner needs real evidence and daylight over the runner-up.
  if (top.score >= 5 && (!second || top.score >= second.score + 3)) {
    return {
      resolved: { id: top.id, title: top.title },
      candidates, ambiguous: false,
      reason: `'${top.title}' — ${top.evidence.join("; ")}`,
    };
  }

  return {
    resolved: null, candidates, ambiguous: true,
    reason:
      `${candidates.length} categories could be the redesign parent (` +
      candidates.slice(0, 3).map((c) => `'${c.title}' [${c.score}]`).join(", ") +
      `). Name it explicitly — guessing would split the build across two trees.`,
  };
}

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
  /** redesign only: the resolved parent, or null when it must be named/created. */
  redesign_root?: { title: string; id: number } | null;
  /** redesign only: how the parent was resolved, and the runners-up. */
  redesign_root_resolution?: RedesignRootResolution;
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
  /** redesign only: the parent category title, when you know it. Omitted, the
   *  survey infers it from the category tree — the name varies per build. */
  redesign_root?: string;
  /** redesign only: the parent id, when a previous survey already resolved it. */
  redesign_root_id?: number | null;
  /** Site notes text. Passing it lets the resolver use a name recorded there. */
  site_notes?: string;
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

  let resolution: RedesignRootResolution | undefined;

  if (build_type === "redesign") {
    // The parent's name varies per build, so it is resolved from evidence
    // rather than assumed. An ambiguous result is surfaced, never guessed —
    // picking the wrong parent splits the build across two category trees.
    resolution = resolveRedesignRoot(cats, {
      explicit: opts.redesign_root,
      explicitId: opts.redesign_root_id,
      site_notes: opts.site_notes,
    });

    if (resolution.resolved) {
      redesignRoot = resolution.resolved;
      // Everything under the root, one level of nesting (the fleet convention).
      scopeIds.add(redesignRoot.id);
      for (const c of cats) {
        if (norm(c.parent) === norm(redesignRoot.title)) {
          const cid = toId(c.id);
          if (cid) scopeIds.add(cid);
        }
      }
    } else if (resolution.ambiguous) {
      warnings.push(
        `Could not resolve the redesign parent category: ${resolution.reason} Pass redesign_root (or redesign_root_id) before the substrate stage runs — it refuses to proceed while this is unresolved.`
      );
    } else {
      warnings.push(
        `${resolution.reason}. Every category this build needs will be nested under it.`
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
    redesign_root_resolution: build_type === "redesign" ? resolution : undefined,
    prepared,
    missing,
    will_copy,
    warnings,
  };
}
