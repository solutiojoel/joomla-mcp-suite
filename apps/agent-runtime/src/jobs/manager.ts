import { ApiError } from "../http";
import { withOrchestrator } from "../mcp";
import { findUser, type RuntimeUser } from "../users";
import { gatewayConfigured, gatewayFetch } from "../gateway";
import { monitorBaseUrl } from "../runs-proxy";
import { requireOwnedFile } from "../files";
import {
  createJobRow,
  countActiveJobs,
  getJobRow,
  listJobRows,
  listOrphanedJobs,
  nextJobSeq,
  nowIso,
  updateJob,
  type JobRow,
} from "../store";
import { appendEvent } from "../sessions/transcript";
import { broadcast } from "../sessions/sse";
import { jobDef, type JobDef } from "./catalog";

/**
 * Async job wrapper over the long-synchronous agents-mcp tools (API doc §5).
 *
 * One job = one fresh orchestrator MCP session under the OWNER's bearer token:
 * adopt the right agent scope (switch_agent), set the active site, then call
 * the tool with a progress token. The orchestrator relays agents-mcp progress
 * notifications upstream, so our resetTimeoutOnProgress mirrors its downstream
 * policy end-to-end: 10-min idle reset on progress, 30-min hard cap, and —
 * critically — NO retry: our timeout abandons the call, it does not cancel the
 * run server-side, and retrying is how a menu build once produced duplicates.
 *
 * Limits: 1 active (queued|running) job per user — enforced at POST, the job
 * is NOT queued — and a global concurrency cap; excess jobs queue FIFO.
 * Job events reuse the session SSE/transcript machinery keyed by job id
 * (ids are prefix-disjoint: sess_… vs job_…); job streams close after `done`.
 */

const MAX_GLOBAL_RUNNING = Number(process.env.AGENT_RUNTIME_MAX_GLOBAL_JOBS || 2);
const AGENT_CALL_OPTIONS = {
  timeout: 600_000,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 1_800_000,
};
/** Tolerated clock skew when matching a monitor run to a job start. */
const RUN_MATCH_SKEW_MS = 90_000;

interface ActiveJob {
  stopRequested: boolean;
  resolvingRunId: boolean;
  runId: string | null;
}

const queue: string[] = [];
const active = new Map<string, ActiveJob>();

function emitJob(jobId: string, event: string, data: Record<string, unknown>): void {
  const seq = nextJobSeq(jobId);
  const ts = nowIso();
  appendEvent(jobId, { seq, ts, event, data });
  broadcast(jobId, seq, event, data);
}

function siteSlug(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return "unknown-site";
  }
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function apiJob(row: JobRow, opts?: { includeRaw?: boolean }): Record<string, unknown> {
  const result = parseJson<Record<string, unknown>>(row.result_json);
  if (result && !opts?.includeRaw) delete result.raw;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    input: parseJson(row.input_json),
    runId: row.run_id,
    progress: parseJson(row.progress_json),
    result,
    error: parseJson(row.error_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

// ── Creation ────────────────────────────────────────────────────────────────

function validateInput(def: JobDef, input: Record<string, unknown>, userEmail: string): void {
  const props = def.inputSchema.properties || {};
  for (const key of def.inputSchema.required || []) {
    if (input[key] === undefined || input[key] === null || input[key] === "") {
      throw new ApiError(400, "validation", `input.${key} is required`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = props[key];
    if (!prop) throw new ApiError(400, "validation", `input.${key} is not a valid field for ${def.id}`);
    if (value === undefined || value === null) continue;
    const t = prop.type;
    const ok =
      t === "string" ? typeof value === "string"
      : t === "number" ? typeof value === "number"
      : t === "boolean" ? typeof value === "boolean"
      : t === "object" ? typeof value === "object" && !Array.isArray(value)
      : t === "array" ? Array.isArray(value)
      : true;
    if (!ok) throw new ApiError(400, "validation", `input.${key} must be a ${t}`);
    if (prop.format === "runtime-file-id") {
      requireOwnedFile(userEmail, value as string); // 400 on unknown id
    }
  }
}

/** The agent scope the worker adopts for this job, or a 403 if the user has none. */
function scopeFor(def: JobDef, user: RuntimeUser, userAgents: string[]): string {
  if (userAgents.includes("super_shannon")) return def.agentScopes[0];
  const scope = def.agentScopes.find((s) => userAgents.includes(s));
  if (!scope) {
    throw new ApiError(
      403,
      "forbidden",
      `Job "${def.id}" needs the ${def.agentScopes.join(" or ")} agent, which your account does not have`
    );
  }
  return scope;
}

export function createJob(
  user: RuntimeUser,
  type: string,
  input: Record<string, unknown>,
  userAgents: string[]
): JobRow {
  const def = jobDef(type);
  if (!def) throw new ApiError(400, "validation", `Unknown job type: ${type}`);
  if (def.hidden && user.role !== "admin") {
    throw new ApiError(403, "forbidden", `Job "${type}" is admin-only`);
  }
  scopeFor(def, user, userAgents); // 403 before any state is created
  validateInput(def, input, user.email);
  if (countActiveJobs(user.email) >= 1) {
    throw new ApiError(
      429,
      "limit_exceeded",
      "You already have a job queued or running (limit 1) — the job was NOT queued"
    );
  }
  const row = createJobRow({ userEmail: user.email, type, input });
  emitJob(row.id, "status", { status: "queued" });
  queue.push(row.id);
  pump();
  return getJobRow(row.id)!;
}

export function getOwnedJob(user: RuntimeUser, id: string): JobRow {
  const row = getJobRow(id);
  if (!row || (user.role !== "admin" && row.user_email.toLowerCase() !== user.email.toLowerCase())) {
    throw new ApiError(404, "not_found", `No such job: ${id}`);
  }
  return row;
}

export function listJobs(user: RuntimeUser, filter: { status?: string; type?: string }): JobRow[] {
  return listJobRows({
    userEmail: user.role === "admin" ? undefined : user.email,
    status: filter.status,
    type: filter.type,
  });
}

// ── Queue ───────────────────────────────────────────────────────────────────

function pump(): void {
  while (queue.length > 0 && active.size < MAX_GLOBAL_RUNNING) {
    const id = queue.shift()!;
    const row = getJobRow(id);
    if (!row || row.status !== "queued") continue; // stopped while queued
    void runJob(row).catch((err) => {
      console.error(`[jobs] ${id} worker crashed:`, err);
    });
  }
}

// ── Worker ──────────────────────────────────────────────────────────────────

function contentText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const block = Array.isArray(content) ? content.find((b) => b?.type === "text") : undefined;
  return block?.text ?? "";
}

/** input → tool arguments: runtime-file-id fields become absolute host paths. */
function buildToolArgs(
  def: JobDef,
  input: Record<string, unknown>,
  userEmail: string
): Record<string, unknown> {
  const props = def.inputSchema.properties || {};
  const args: Record<string, unknown> = {};
  let uploadedName: string | null = null;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const prop = props[key];
    if (prop?.format === "runtime-file-id") {
      const file = requireOwnedFile(userEmail, value as string);
      args[prop["x-tool-arg"] || key] = file.path;
      uploadedName = file.name;
    } else {
      args[key] = value;
    }
  }
  if (uploadedName && props.source_filename && !args.source_filename) {
    args.source_filename = uploadedName;
  }
  return args;
}

async function runJob(row: JobRow): Promise<void> {
  const def = jobDef(row.type)!;
  const state: ActiveJob = { stopRequested: false, resolvingRunId: false, runId: null };
  active.set(row.id, state);
  updateJob(row.id, { status: "running", started_at: nowIso() });
  emitJob(row.id, "status", { status: "running" });

  let failure: { message: string; detail?: unknown } | null = null;
  let parsed: Record<string, unknown> | null = null;

  try {
    const user = findUser(row.user_email);
    if (!user) throw new Error(`runtime user ${row.user_email} no longer exists`);
    const input = parseJson<Record<string, unknown>>(row.input_json) || {};
    const scope = scopeFor(def, user, [
      ...(user.allowedAgents || []),
      user.defaultAgent || "super_shannon",
    ]);
    const toolArgs = buildToolArgs(def, input, user.email);

    const onprogress = (p: { progress: number; total?: number; message?: string }) => {
      const progress = {
        message: p.message ?? `turn ${p.progress}${p.total ? `/${p.total}` : ""}`,
        lastHeartbeatAt: nowIso(),
      };
      updateJob(row.id, { progress_json: JSON.stringify(progress) });
      emitJob(row.id, "progress", progress);
      if (def.subAgent && !state.runId && !state.resolvingRunId) {
        state.resolvingRunId = true;
        void resolveRunId(row, def, state).finally(() => {
          state.resolvingRunId = false;
        });
      }
    };

    const result = await withOrchestrator(user.orchestratorToken, async (client) => {
      // Fresh MCP session: adopt the job's agent scope and site before the
      // tool call — the orchestrator injects ITS session's active site into
      // agents-mcp calls and enforces the current agent's tool allowlist.
      const cur = await client.callTool({ name: "get_current_agent", arguments: {} });
      const currentAgent = /Current agent: \*\*(.+?)\*\*/.exec(contentText(cur))?.[1];
      if (currentAgent !== scope) {
        const sw = await client.callTool({ name: "switch_agent", arguments: { agent: scope } });
        if (sw.isError) {
          throw new Error(`could not adopt agent scope '${scope}': ${contentText(sw).slice(0, 200)}`);
        }
      }
      if (typeof toolArgs.site_url === "string") {
        const sa = await client.callTool(
          { name: "set_active_site", arguments: { url: toolArgs.site_url } },
          undefined,
          { timeout: 120_000 } // includes the orchestrator's Joomla auto-login
        );
        if (sa.isError) {
          throw new Error(`could not set the active site: ${contentText(sa).slice(0, 200)}`);
        }
      }
      return client.callTool({ name: def.id, arguments: toolArgs }, undefined, {
        ...AGENT_CALL_OPTIONS,
        onprogress,
      });
    });

    const text = contentText(result);
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { raw_text: text };
    }
    if ((result as { isError?: boolean }).isError || parsed.success === false) {
      failure = {
        message: (parsed.error as string) || text.slice(0, 300) || "Tool reported an error",
        detail: parsed,
      };
    }
  } catch (err) {
    failure = {
      message: (err as Error).message,
      detail:
        def.kind === "llm"
          ? { note: "Transport error or timeout — the agents-mcp run may still be executing server-side; check /api/runs before re-running." }
          : undefined,
    };
  }

  // ── Finalize ──
  const finishedAt = nowIso();
  const current = getJobRow(row.id)!;
  if (failure) {
    const status = state.stopRequested ? "stopped" : "failed";
    updateJob(row.id, {
      status,
      error_json: JSON.stringify(failure),
      finished_at: finishedAt,
    });
    emitJob(row.id, "status", { status });
    emitJob(row.id, "done", { status, error: failure });
  } else {
    const input = parseJson<Record<string, unknown>>(current.input_json) || {};
    const result = {
      summary: summarize(def, parsed || {}),
      artifacts: buildArtifacts(def, input, parsed || {}),
      raw: parsed,
    };
    // KB bridge Phase A: best-effort reference records; never fails the job.
    await recordArtifactsInKb(row, def, input, result).catch((err) => {
      console.warn(`[jobs] ${row.id} KB bridge failed: ${(err as Error).message}`);
    });
    updateJob(row.id, {
      status: "succeeded",
      result_json: JSON.stringify(result),
      finished_at: finishedAt,
    });
    emitJob(row.id, "status", { status: "succeeded" });
    const resultForEvent = { ...result } as Record<string, unknown>;
    delete resultForEvent.raw; // keep the SSE/transcript event small
    emitJob(row.id, "done", { status: "succeeded", result: resultForEvent });
  }
  active.delete(row.id);
  pump();
}

// ── Result shaping ──────────────────────────────────────────────────────────

function count(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.length;
  return null;
}

function summarize(def: JobDef, parsed: Record<string, unknown>): string {
  if (typeof parsed.summary === "string" && parsed.summary) return parsed.summary;
  const changes = parsed.changes as Record<string, unknown> | undefined;
  const report = parsed.report as Record<string, unknown> | undefined;
  switch (def.id) {
    case "run_menu_interpretation": {
      const spec = parsed.spec as Record<string, unknown> | undefined;
      const oq = count(spec?.open_questions);
      return `Menu Spec produced${oq ? ` — ${oq} open question(s)` : ""}`;
    }
    case "derive_content_schematic":
    case "run_content_interpretation":
      if (changes) {
        return `Schematic ${def.id === "derive_content_schematic" ? "derived" : "interpreted"} — ${count(changes.added) ?? 0} added, ${count(changes.updated) ?? 0} updated, ${count(changes.orphaned) ?? 0} orphaned`;
      }
      break;
    case "discover_source_urls":
      return `${count(parsed.proposals) ?? 0} URL proposal(s) from ${parsed.pages_scanned ?? "?"} page(s) scanned — confirm before writing into the schematic`;
    case "fetch_source_content":
      if (report) {
        return `Fetched ${count(report.fetched) ?? 0}, failed ${count(report.failed) ?? 0}, skipped ${count(report.skipped) ?? 0}`;
      }
      break;
    case "run_content_build": {
      const write = parsed.write as Record<string, unknown> | undefined;
      const apply = parsed.apply as Record<string, unknown> | undefined;
      if (write) {
        return `Wrote ${count(write.written) ?? 0} page(s) (${count(write.drafts) ?? 0} draft(s), ${count(write.failed) ?? 0} failed); applied ${count(apply?.applied) ?? 0}`;
      }
      break;
    }
    case "apply_content":
      if (report) {
        return `Applied ${count(report.applied) ?? 0}, skipped ${count(report.skipped) ?? 0}, failed ${count(report.failed) ?? 0}`;
      }
      break;
    case "agent_ping":
      return "Transport ping completed";
  }
  return "Completed";
}

interface Artifact {
  kind: string;
  path: string;
  kbRecordId: number | null;
}

function buildArtifacts(
  def: JobDef,
  input: Record<string, unknown>,
  parsed: Record<string, unknown>
): Artifact[] {
  const slug = siteSlug(String(input.site_url || ""));
  const schematicFile =
    (parsed.schematic_filename as string) ||
    (input.schematic_filename as string) ||
    `${slug}-content-schematic.json`;
  const specFile = (input.spec_filename as string) || `${slug}-menu-spec.json`;
  const paths: Record<string, string> = {
    "menu-spec": `workspace/${specFile}`,
    "content-schematic": `workspace/${schematicFile}`,
    "source-md": `workspace/${slug}-source/`,
    "article-html": `workspace/${slug}-html/`,
  };
  return def.produces
    .filter((kind) => paths[kind])
    .map((kind) => ({ kind, path: paths[kind], kbRecordId: null }));
}

// ── KB bridge Phase A ───────────────────────────────────────────────────────

async function recordArtifactsInKb(
  row: JobRow,
  def: JobDef,
  input: Record<string, unknown>,
  result: { summary: string; artifacts: Artifact[] }
): Promise<void> {
  if (result.artifacts.length === 0) return;
  if (!gatewayConfigured()) {
    console.warn("[jobs] KNOWLEDGE_GATEWAY_API_KEY not set — skipping KB artifact records");
    return;
  }
  const slug = siteSlug(String(input.site_url || ""));
  const runId = getJobRow(row.id)?.run_id || null;
  const date = nowIso().slice(0, 10);
  for (const artifact of result.artifacts) {
    const { status, body } = await gatewayFetch("POST", "/client-knowledge", {
      userEmail: row.user_email,
      body: {
        siteCode: slug,
        topic: `artifact: ${artifact.kind} — ${slug} — ${date}`,
        content: [
          `Reference record for a dashboard job artifact (the content lives on the box).`,
          ``,
          `- **Artifact:** ${artifact.kind}`,
          `- **Path (box):** ${artifact.path}`,
          `- **Site:** ${input.site_url || slug}`,
          `- **Job:** ${row.id} (${def.id}), requested by ${row.user_email}`,
          `- **agents-mcp run:** ${runId || "—"}`,
          ``,
          `**Result:** ${result.summary}`,
        ].join("\n"),
        tags: ["job-artifact", `artifact:${artifact.kind}`, `site:${slug}`, ...(runId ? [`run:${runId}`] : [])],
        contentType: "markdown",
      },
    });
    if (status < 400) {
      const data = body as { id?: number; data?: { id?: number } } | null;
      artifact.kbRecordId = data?.id ?? data?.data?.id ?? null;
    } else {
      console.warn(`[jobs] ${row.id} KB record for ${artifact.kind} failed (HTTP ${status})`);
    }
  }
}

// ── runId resolution + stop ─────────────────────────────────────────────────

/**
 * agents-mcp progress notifications carry no run id, so match the monitor's
 * run list instead: a running run of this job's sub-agent that started at or
 * after the job did (with skew) and is not already claimed by another job.
 */
async function resolveRunId(row: JobRow, def: JobDef, state: ActiveJob): Promise<void> {
  try {
    const resp = await fetch(`${monitorBaseUrl()}/api/runs`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return;
    const runs = (await resp.json()) as Array<{
      runId: string;
      agentName: string;
      status: string;
      startedAt: string;
    }>;
    const jobStart = new Date(getJobRow(row.id)?.started_at || row.created_at).getTime();
    const claimed = new Set(
      listJobRows({}).map((j) => j.run_id).filter((r): r is string => !!r)
    );
    const candidates = runs
      .filter(
        (r) =>
          r.agentName === def.subAgent &&
          ["running", "stalled", "stopping"].includes(r.status) &&
          !claimed.has(r.runId) &&
          new Date(r.startedAt).getTime() >= jobStart - RUN_MATCH_SKEW_MS
      )
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const match = candidates[0];
    if (!match) return;
    state.runId = match.runId;
    updateJob(row.id, { run_id: match.runId });
    if (state.stopRequested) void postMonitorStop(match.runId);
  } catch {
    /* monitor down — runId stays null; resolution retries on the next heartbeat */
  }
}

async function postMonitorStop(runId: string): Promise<void> {
  try {
    await fetch(`${monitorBaseUrl()}/api/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[jobs] stop request for run ${runId} failed: ${(err as Error).message}`);
  }
}

export function stopJob(user: RuntimeUser, id: string): void {
  const row = getOwnedJob(user, id);
  if (row.status === "queued") {
    const qi = queue.indexOf(id);
    if (qi >= 0) queue.splice(qi, 1);
    updateJob(id, { status: "stopped", finished_at: nowIso() });
    emitJob(id, "status", { status: "stopped" });
    emitJob(id, "done", { status: "stopped", error: { message: "Stopped before it started" } });
    return;
  }
  if (row.status === "running") {
    const state = active.get(id);
    if (state) {
      state.stopRequested = true;
      const runId = state.runId || row.run_id;
      if (runId) void postMonitorStop(runId);
      // No runId yet → the next heartbeat's resolution fires the stop.
    } else if (row.run_id) {
      // Running row without a worker (shouldn't happen post-recovery) — still
      // forward the stop to the monitor so the underlying run gets the signal.
      void postMonitorStop(row.run_id);
    }
    return;
  }
  throw new ApiError(409, "busy", `Job already ${row.status}`);
}

// ── Boot recovery ───────────────────────────────────────────────────────────

/** Jobs left queued/running by a previous process can never complete — the MCP
 *  call died with it. Fail them; the run monitor still shows any underlying run. */
export function startJobLifecycle(): void {
  for (const row of listOrphanedJobs()) {
    const error = {
      message:
        "The runtime restarted while this job was in flight. Check /api/runs for the underlying agents-mcp run before re-running.",
    };
    updateJob(row.id, {
      status: "failed",
      error_json: JSON.stringify(error),
      finished_at: nowIso(),
    });
    emitJob(row.id, "status", { status: "failed" });
    emitJob(row.id, "done", { status: "failed", error });
    console.warn(`[jobs] marked orphaned job ${row.id} (${row.type}) as failed after restart`);
  }
}
