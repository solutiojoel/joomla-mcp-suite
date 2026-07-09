import { z } from "zod";
import { loadSubAgentConfig } from "../config.js";
import { connectDownstreams } from "../bridge.js";
import { runSubAgent, SubAgentEvent } from "../runtime.js";
import { ContentSchematic, SchematicEntry } from "../schematic.js";
import { slugify } from "../content-fetch.js";

/**
 * Content-writer harness — the only LLM stage of the content build.
 *
 * Partitions the schematic's writable entries into small batches and runs the
 * content-writer sub-agent once per batch in a FRESH context window: the
 * prompt carries only that batch's entries, the writer reads source markdown
 * via joomla_workspace_read and writes finished HTML via
 * joomla_workspace_write — page content never flows through the caller's
 * context. The harness (not the LLM) validates the result and stamps
 * content_file / draft / status "written" into the schematic, mirroring the
 * structure-lock philosophy of the content-interpreter.
 */

export interface ContentWriterArgs {
  site_url: string;
  schematic: ContentSchematic;
  /** Workspace filename to persist the schematic to after each batch. */
  schematic_filename?: string;
  /** Entries per sub-agent run. Default 8. */
  batch_size?: number;
  /** Explicit subset to write (also unlocks re-writing "written" entries). */
  node_keys?: string[];
  /** Report the batch plan without running the sub-agent. */
  dry_run?: boolean;
}

export interface BatchFailure {
  node_key: string;
  error: string;
}

export interface BatchResult {
  batch: number;
  node_keys: string[];
  written: string[];
  failed: BatchFailure[];
  run_log?: string;
}

export interface ContentWriterResult {
  success: boolean;
  error?: string;
  batches: BatchResult[];
  written: string[];
  failed: BatchFailure[];
  /** Writable-entry keys never attempted (earlier batch hard-failed). */
  not_attempted: string[];
  /** Entries that matched no writability rule, with the reason. */
  not_writable: Array<{ node_key: string; reason: string }>;
  drafts: string[];
}

/** Why an entry can't be written, or null if it can. Exported for tests. */
export function unwritableReason(entry: SchematicEntry, explicit: boolean): string | null {
  const okStatus = entry.status === "filled" || (explicit && entry.status === "written");
  if (!okStatus) return `status is "${entry.status}"`;
  if (entry.kind === "docman") return "docman pages have no article content";
  if (entry.content_source === "pull" || entry.content_source === "existing") {
    if (!entry.source_file && !entry.copy) return "no source_file (run fetch_source_content) and no copy";
    return null;
  }
  if (entry.content_source === "generate") {
    if (!entry.instructions && !entry.copy && !entry.spec_notes) {
      return "generate page with no instructions/copy/spec_notes to draft from";
    }
    return null;
  }
  return `content_source "${entry.content_source}" is not written by this stage`;
}

/** Partition writable entries into batches, preserving schematic order.
 *  Exported for unit testing. */
export function partitionWritableEntries(
  schematic: ContentSchematic,
  batchSize: number,
  nodeKeys?: string[]
): { batches: SchematicEntry[][]; notWritable: Array<{ node_key: string; reason: string }> } {
  const explicit = Array.isArray(nodeKeys) && nodeKeys.length > 0;
  const wanted = explicit ? new Set(nodeKeys) : null;
  const writable: SchematicEntry[] = [];
  const notWritable: Array<{ node_key: string; reason: string }> = [];

  for (const entry of schematic.entries) {
    if (wanted && !wanted.has(entry.node_key)) continue;
    const reason = unwritableReason(entry, explicit);
    if (reason) {
      // Without an explicit key list, silently pass over entries that simply
      // aren't this stage's business (todo, done, blocked, redirect...).
      if (explicit) notWritable.push({ node_key: entry.node_key, reason });
      else if (entry.status === "filled") notWritable.push({ node_key: entry.node_key, reason });
      continue;
    }
    writable.push(entry);
  }

  const batches: SchematicEntry[][] = [];
  for (let i = 0; i < writable.length; i += batchSize) {
    batches.push(writable.slice(i, i + batchSize));
  }
  return { batches, notWritable };
}

/** The per-entry payload the sub-agent sees — content fields only, plus the
 *  harness-assigned output path. */
function batchPayload(entries: SchematicEntry[], schematic: ContentSchematic, slug: string) {
  const indexByKey = new Map(schematic.entries.map((e, i) => [e.node_key, i]));
  return entries.map((e) => {
    const nn = String((indexByKey.get(e.node_key) ?? 0) + 1).padStart(2, "0");
    return {
      node_key: e.node_key,
      title: e.title,
      kind: e.kind,
      menu_path: e.menu_path,
      category: e.category,
      content_source: e.content_source,
      instructions: e.instructions,
      copy: e.copy,
      source_file: e.source_file,
      content_file: `${slug}-html/${nn}-${slugify(e.title)}.html`,
      assets: e.assets,
      spec_notes: e.spec_notes,
      notes: e.notes,
    };
  });
}

interface WriterReturnItem {
  node_key?: string;
  content_file?: string;
  draft?: boolean;
  notes?: string;
  error?: string;
}

export async function runContentWriter(
  args: ContentWriterArgs,
  sendProgress: (progress: number, total: number) => Promise<void>,
  onEvent?: (event: SubAgentEvent) => void,
  /** Invoked after each batch is validated, stamped, and persisted — the
   *  run_content_build tool hooks auto-apply here. */
  onBatchComplete?: (writtenKeys: string[], batch: number, totalBatches: number) => Promise<void>
): Promise<ContentWriterResult> {
  const { site_url, schematic } = args;
  const empty: Omit<ContentWriterResult, "success" | "error"> = {
    batches: [],
    written: [],
    failed: [],
    not_attempted: [],
    not_writable: [],
    drafts: [],
  };

  if (!site_url) return { success: false, error: "site_url is required", ...empty };
  if (!schematic || !Array.isArray(schematic.entries)) {
    return { success: false, error: "schematic is required (with an entries array)", ...empty };
  }

  const slug = new URL(site_url).hostname.replace(/^www\./, "").split(".")[0];
  const schematicFilename = args.schematic_filename || `${slug}-content-schematic.json`;
  const batchSize = args.batch_size && args.batch_size > 0 ? args.batch_size : 8;

  const { batches, notWritable } = partitionWritableEntries(schematic, batchSize, args.node_keys);
  const result: ContentWriterResult = { success: true, ...empty, not_writable: notWritable };

  if (batches.length === 0) {
    result.error = "No writable entries (need status 'filled' with source_file/copy, or generate with instructions)";
    result.success = notWritable.length === 0; // nothing to do ≠ failure unless entries were blocked
    return result;
  }

  if (args.dry_run) {
    result.batches = batches.map((entries, i) => ({
      batch: i + 1,
      node_keys: entries.map((e) => e.node_key),
      written: [],
      failed: [],
    }));
    return result;
  }

  const config = await loadSubAgentConfig("content-writer");
  const { executor } = await connectDownstreams(config.downstreams, site_url, config.allow);

  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const wrap = (name: string, description: string, schema: Record<string, z.ZodType>) =>
    tool(name, description, schema, async (input: Record<string, unknown>) => {
      const res = await executor(name, input as Record<string, any>);
      return {
        content: [{ type: "text" as const, text: typeof res === "string" ? res : JSON.stringify(res) }],
      };
    });
  const joomlaServer = createSdkMcpServer({
    name: "joomla",
    tools: [
      wrap("joomla_workspace_read", "Read a file from the site workspace (the batch's source markdown).", {
        path: z.string().describe("Workspace path exactly as given in the batch entry, e.g. stmarys-source/03-welcome.md"),
      }),
      wrap("joomla_workspace_write", "Write a file to the site workspace (the finished page HTML).", {
        path: z.string().describe("The entry's content_file path exactly as given, e.g. stmarys-html/03-welcome.html"),
        content: z.string().describe("The complete Joomla article body HTML"),
      }),
    ],
  });

  const persistSchematic = () =>
    executor("joomla_workspace_write", {
      path: schematicFilename,
      content: JSON.stringify(schematic, null, 2),
    });

  const entriesByKey = new Map(schematic.entries.map((e) => [e.node_key, e]));
  const maxTurns = Math.max(40, batchSize * 6);
  const totalBatches = batches.length;

  for (let b = 0; b < totalBatches; b++) {
    const batchEntries = batches[b];
    const payload = batchPayload(batchEntries, schematic, slug);
    const batchKeys = new Set(batchEntries.map((e) => e.node_key));
    const batchResult: BatchResult = {
      batch: b + 1,
      node_keys: [...batchKeys],
      written: [],
      failed: [],
    };
    result.batches.push(batchResult);

    const promptLines = [
      `Write final Joomla article HTML for site: ${site_url}`,
      `Workspace output folder: ${slug}-html/`,
      "",
      "--- BATCH START ---",
      JSON.stringify(payload),
      "--- BATCH END ---",
      "",
      "For each entry: read its source_file with joomla_workspace_read when present,",
      "write the finished HTML to its content_file path with joomla_workspace_write,",
      "then return the compact JSON status array per your system prompt (no prose).",
    ];

    await sendProgress(b, totalBatches);
    const run = await runSubAgent({
      agentName: "content-writer",
      systemPrompt: config.instructions,
      userMessage: promptLines.join("\n"),
      mcpServers: { joomla: joomlaServer },
      allowedTools: ["mcp__joomla__joomla_workspace_read", "mcp__joomla__joomla_workspace_write"],
      model: config.model,
      maxTurns,
      onIteration: async (current, max) => {
        await sendProgress(b + Math.min(current / (max + 1), 0.99), totalBatches);
      },
      onEvent,
    });
    batchResult.run_log = run.runLogPath;

    if (!run.success) {
      // A hard batch failure (SDK error, stop) aborts the run; completed
      // batches are already stamped and persisted, so a re-run resumes.
      batchResult.failed = [...batchKeys].map((k) => ({ node_key: k, error: run.error ?? "run failed" }));
      result.failed.push(...batchResult.failed);
      result.not_attempted = batches.slice(b + 1).flatMap((es) => es.map((e) => e.node_key));
      result.success = false;
      result.error = `Batch ${b + 1}/${totalBatches} failed: ${run.error}`;
      return result;
    }

    let items: WriterReturnItem[];
    if (Array.isArray(run.result)) {
      items = run.result as WriterReturnItem[];
    } else if (typeof run.result === "object" && run.result !== null && (run.result as any).success === false) {
      items = [];
      batchResult.failed = [...batchKeys].map((k) => ({
        node_key: k,
        error: String((run.result as any).error ?? "writer reported failure"),
      }));
    } else {
      items = [];
      batchResult.failed = [...batchKeys].map((k) => ({
        node_key: k,
        error: "writer returned no status array",
      }));
    }

    const expectedFileByKey = new Map(payload.map((p) => [p.node_key, p.content_file]));
    const reported = new Set<string>();

    for (const item of items) {
      const key = String(item.node_key ?? "");
      if (!batchKeys.has(key)) {
        // Batch lock: ignore (but surface) anything outside the batch.
        batchResult.failed.push({ node_key: key, error: "writer reported an entry outside its batch" });
        continue;
      }
      reported.add(key);
      const entry = entriesByKey.get(key)!;

      if (item.error || !item.content_file) {
        batchResult.failed.push({ node_key: key, error: item.error ?? "no content_file reported" });
        continue;
      }
      const expected = expectedFileByKey.get(key);
      if (item.content_file !== expected) {
        batchResult.failed.push({
          node_key: key,
          error: `writer wrote to "${item.content_file}" instead of the assigned "${expected}"`,
        });
        continue;
      }
      // Verify the file actually exists in the workspace and is non-empty.
      try {
        const content = await executor("joomla_workspace_read", { path: item.content_file });
        const text = typeof content === "string" ? content : JSON.stringify(content);
        if (!text || text.trim().length === 0) throw new Error("file is empty");
      } catch (err: unknown) {
        batchResult.failed.push({
          node_key: key,
          error: `claimed content_file not readable: ${err instanceof Error ? err.message : err}`,
        });
        continue;
      }

      // Harness-owned stamping — the LLM never edits the schematic.
      entry.content_file = item.content_file;
      if (item.draft === true || entry.content_source === "generate") {
        entry.draft = true;
        result.drafts.push(key);
      }
      if (item.notes) {
        entry.notes = entry.notes ? `${entry.notes} | writer: ${item.notes}` : `writer: ${item.notes}`;
      }
      entry.status = "written";
      batchResult.written.push(key);
    }

    for (const key of batchKeys) {
      if (!reported.has(key) && !batchResult.failed.some((f) => f.node_key === key)) {
        batchResult.failed.push({ node_key: key, error: "writer returned no status for this entry" });
      }
    }

    result.written.push(...batchResult.written);
    result.failed.push(...batchResult.failed);

    await persistSchematic();
    if (onBatchComplete) await onBatchComplete(batchResult.written, b + 1, totalBatches);
    await sendProgress(b + 1, totalBatches);
  }

  return result;
}
