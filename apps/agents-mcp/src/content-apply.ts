import { ContentSchematic, SchematicEntry } from "./schematic.js";

/**
 * Deterministic apply stage — no LLM anywhere in this file.
 *
 * Takes entries the content-writer left in status "written", reads their HTML
 * from the workspace, and pushes it into the matching Joomla article through
 * the bridge executor. Safety model (auto-apply has no human gate, so the
 * guards live here):
 *   - the target article is fetched first and its title must match the entry;
 *   - an article that already has real (non-placeholder) content is skipped
 *     unless `force` is set;
 *   - `dry_run` reports the full plan without touching Joomla.
 * Success stamps status "done" + applied_at; failures leave the entry
 * "written" so a re-run picks it up.
 */

export type Executor = (name: string, args: Record<string, any>) => Promise<any>;

export interface ApplyOptions {
  executor: Executor;
  /** Workspace filename to persist the schematic to. Empty string = don't persist. */
  schematic_filename: string;
  /** Explicit subset (also unlocks re-applying "done" entries). */
  node_keys?: string[];
  /** Overwrite articles that already have real content. */
  force?: boolean;
  /** Report the plan without writing anything. */
  dry_run?: boolean;
  now?: Date;
}

export interface ApplyItem {
  node_key: string;
  title: string;
  article_id?: string;
  outcome: "applied" | "would_apply" | "skipped" | "failed";
  detail?: string;
}

export interface ApplyReport {
  applied: ApplyItem[];
  would_apply: ApplyItem[];
  skipped: ApplyItem[];
  failed: ApplyItem[];
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

/** The bridge executor THROWS on downstream isError results (e.g. a get-by-title
 *  miss) — normalize both shapes to a JoomlaResult so lookups can fall through. */
async function callSafe(executor: Executor, name: string, args: Record<string, any>): Promise<JoomlaResult> {
  try {
    return asResult(await executor(name, args));
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Visible text length of an article body, ignoring markup and whitespace. */
function strippedLength(html: string): number {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, "")
    .length;
}

/** Skeleton articles are empty or carry a stub — anything beyond this is
 *  treated as real content the apply must not clobber. Exported for tests. */
export function isPlaceholderContent(html: string | undefined): boolean {
  if (!html) return true;
  if (/placeholder/i.test(html)) return true;
  return strippedLength(html) < 40;
}

/** Article titles the entry legitimately matches — Phase 4 titles grid
 *  landing articles "{title} (landing)". */
function acceptableTitles(entry: SchematicEntry): string[] {
  const titles = [entry.title];
  if (entry.kind === "grid_landing") titles.push(`${entry.title} (landing)`);
  return titles;
}

async function resolveArticle(
  entry: SchematicEntry,
  executor: Executor
): Promise<{ id: string; title: string; content?: string } | { error: string }> {
  // Stamped ID first (post-Phase-4 re-derive), title lookup as fallback.
  if (entry.joomla_article_id) {
    const res = await callSafe(executor, "joomla_article", { action: "get", id: entry.joomla_article_id });
    if (res.success === false) {
      return { error: `get by stamped id ${entry.joomla_article_id} failed: ${res.message}` };
    }
    const art = res.data ?? {};
    const title = String(art.title ?? "");
    if (!acceptableTitles(entry).includes(title)) {
      return {
        error: `stamped id ${entry.joomla_article_id} is titled "${title}", expected "${entry.title}" — re-derive to restamp IDs`,
      };
    }
    return { id: entry.joomla_article_id, title, content: art.content as string | undefined };
  }

  for (const title of acceptableTitles(entry)) {
    const res = await callSafe(executor, "joomla_article", { action: "get", title });
    if (res.success === false) continue;
    const data = res.data;
    if (Array.isArray(data)) {
      // Multiple matches — accept only an unambiguous exact-title hit.
      const exact = data.filter((a: any) => String(a.title ?? "") === title);
      if (exact.length !== 1) continue;
      const full = await callSafe(executor, "joomla_article", { action: "get", id: String(exact[0].id) });
      if (full.success === false) continue;
      const art = full.data ?? {};
      return { id: String(exact[0].id), title, content: art.content as string | undefined };
    }
    if (data && data.id !== undefined) {
      return { id: String(data.id), title: String(data.title ?? title), content: data.content as string | undefined };
    }
  }
  return {
    error: `no article found titled "${acceptableTitles(entry).join('" or "')}"${entry.category ? ` (category ${entry.category})` : ""}`,
  };
}

/**
 * Apply written HTML to the Joomla skeleton. Mutates entry statuses and
 * persists the schematic (unless dry_run / no filename). Returns the report.
 */
export async function applyContent(
  schematic: ContentSchematic,
  opts: ApplyOptions
): Promise<ApplyReport> {
  const { executor } = opts;
  const report: ApplyReport = { applied: [], would_apply: [], skipped: [], failed: [] };
  const explicit = Array.isArray(opts.node_keys) && opts.node_keys.length > 0;
  const wanted = explicit ? new Set(opts.node_keys) : null;

  const candidates = schematic.entries.filter((e) => {
    if (wanted && !wanted.has(e.node_key)) return false;
    if (e.status === "written") return !!e.content_file;
    // Explicit selection may re-apply an already-done entry (with force).
    return explicit && e.status === "done" && !!e.content_file;
  });

  let changed = false;

  for (const entry of candidates) {
    const base: ApplyItem = { node_key: entry.node_key, title: entry.title, outcome: "failed" };

    // Read the HTML first — a missing file should fail before any Joomla call.
    let html: string;
    try {
      const res = await executor("joomla_workspace_read", { path: entry.content_file });
      html = typeof res === "string" ? res : JSON.stringify(res);
      if (!html.trim()) throw new Error("file is empty");
    } catch (err: unknown) {
      report.failed.push({
        ...base,
        detail: `content_file "${entry.content_file}" unreadable: ${err instanceof Error ? err.message : err}`,
      });
      continue;
    }

    const resolved = await resolveArticle(entry, executor);
    if ("error" in resolved) {
      report.failed.push({ ...base, detail: resolved.error });
      continue;
    }
    base.article_id = resolved.id;

    if (!isPlaceholderContent(resolved.content) && !opts.force) {
      report.skipped.push({
        ...base,
        outcome: "skipped",
        detail: `article ${resolved.id} already has real content (${strippedLength(resolved.content ?? "")} chars) — pass force to overwrite`,
      });
      continue;
    }

    if (opts.dry_run) {
      report.would_apply.push({
        ...base,
        outcome: "would_apply",
        detail: `would update article ${resolved.id} ("${resolved.title}") from ${entry.content_file}${
          !isPlaceholderContent(resolved.content) ? " (FORCE overwrite of real content)" : ""
        }`,
      });
      continue;
    }

    try {
      const res = asResult(
        await executor("joomla_article", { action: "update", id: resolved.id, content: html })
      );
      if (res.success === false) throw new Error(res.message ?? "update reported failure");
    } catch (err: unknown) {
      report.failed.push({
        ...base,
        detail: `update failed: ${err instanceof Error ? err.message : err}`,
      });
      continue;
    }

    entry.joomla_article_id = resolved.id;
    entry.status = "done";
    entry.applied_at = (opts.now ?? new Date()).toISOString();
    changed = true;
    report.applied.push({ ...base, outcome: "applied" });
  }

  if (changed && opts.schematic_filename && !opts.dry_run) {
    await executor("joomla_workspace_write", {
      path: opts.schematic_filename,
      content: JSON.stringify(schematic, null, 2),
    });
  }

  return report;
}
