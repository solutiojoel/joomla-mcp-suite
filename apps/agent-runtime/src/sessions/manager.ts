import { ApiError } from "../http";
import type { RuntimeUser } from "../users";
import {
  countOpenSessions,
  createSessionRow,
  getSessionRow,
  listSessionRows,
  listStaleSessions,
  nextSeq,
  nowIso,
  setSdkSessionId,
  setSessionStatus,
  touchSession,
  type SessionRow,
} from "../store";
import { appendEvent } from "./transcript";
import { broadcast } from "./sse";
import { ChatDriver } from "./driver";

/**
 * Session registry + lifecycle. A session row lives in SQLite forever; a
 * ChatDriver (SDK subprocess) exists only while the session is live in THIS
 * process. Any message to a session without a live driver starts one with
 * `resume`, so restarts and closed sessions are transparent to the user.
 *
 * Lifecycle: active → idle after IDLE_MINUTES without activity → closed after
 * CLOSE_MINUTES (driver shut down, `session.closed` emitted). Limits: 2 open
 * sessions per user, 5 concurrent SDK loops globally (the box's real capacity
 * constraint — each loop is a subprocess).
 */

const MAX_OPEN_PER_USER = Number(process.env.AGENT_RUNTIME_MAX_SESSIONS_PER_USER || 2);
const MAX_GLOBAL_LOOPS = Number(process.env.AGENT_RUNTIME_MAX_GLOBAL_LOOPS || 5);
const IDLE_MINUTES = Number(process.env.AGENT_RUNTIME_IDLE_MINUTES || 15);
const CLOSE_MINUTES = Number(process.env.AGENT_RUNTIME_CLOSE_MINUTES || 60);
const SWEEP_SECONDS = Number(process.env.AGENT_RUNTIME_SWEEP_SECONDS || 60);

const liveDrivers = new Map<string, ChatDriver>();

/** Assign a seq, persist to the transcript, broadcast to SSE subscribers. */
function emit(sessionId: string, event: string, data: Record<string, unknown>): number {
  const seq = nextSeq(sessionId);
  const ts = nowIso();
  let payload = data;
  if (event === "message") payload = { seq, ts, ...data };
  if (event === "done") payload = { ...data, turnSeq: seq };
  appendEvent(sessionId, { seq, ts, event, data: payload });
  broadcast(sessionId, seq, event, payload);
  return seq;
}

export function apiSession(row: SessionRow): Record<string, unknown> {
  return {
    id: row.id,
    agent: row.agent,
    siteUrl: row.site_url,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    seq: row.seq,
  };
}

function startDriver(row: SessionRow, user: RuntimeUser): Promise<void> {
  if (liveDrivers.size >= MAX_GLOBAL_LOOPS) {
    throw new ApiError(
      429,
      "limit_exceeded",
      `The server is at its concurrent-session capacity (${MAX_GLOBAL_LOOPS}). Try again shortly.`
    );
  }
  const resumeId = row.sdk_session_id;
  const driver = new ChatDriver({
    sessionId: row.id,
    user,
    agent: row.agent,
    siteUrl: row.site_url,
    resumeSdkSessionId: resumeId,
    callbacks: {
      emit: (event, data) => emit(row.id, event, data),
      onSdkSessionId: (sdkId) => setSdkSessionId(row.id, sdkId),
      onTurnDone: () => touchSession(row.id),
      onExit: (error) => {
        liveDrivers.delete(row.id);
        if (error) {
          console.warn(`[chat] session ${row.id} loop exited: ${error}`);
          // A resume that never completed bootstrap is a broken resume handle
          // (e.g. SDK session files gone) — clear it so the next attempt
          // starts fresh instead of failing forever.
          if (resumeId && driver.bootstrapping) {
            console.warn(`[chat] clearing unusable resume handle for ${row.id}`);
            setSdkSessionId(row.id, null);
          }
        }
      },
    },
  });
  liveDrivers.set(row.id, driver);
  return driver.start().catch((err) => {
    liveDrivers.delete(row.id);
    throw new ApiError(502, "upstream_unavailable", `Could not start the agent session: ${err.message}`);
  });
}

export async function createSession(
  user: RuntimeUser,
  params: { agent: string; siteUrl?: string | null; title?: string | null },
  allowedAgentIds: string[]
): Promise<SessionRow> {
  if (!allowedAgentIds.includes(params.agent)) {
    throw new ApiError(403, "forbidden", `You cannot start a session as agent "${params.agent}"`);
  }
  if (countOpenSessions(user.email) >= MAX_OPEN_PER_USER) {
    const open = listSessionRows(user.email, true).map(apiSession);
    throw new ApiError(
      429,
      "limit_exceeded",
      `You already have ${open.length} open sessions (limit ${MAX_OPEN_PER_USER}) — close one first`,
      { activeSessions: open }
    );
  }
  const row = createSessionRow({
    userEmail: user.email,
    agent: params.agent,
    siteUrl: params.siteUrl,
    title:
      params.title ||
      `${params.agent}${params.siteUrl ? ` — ${new URL(params.siteUrl).hostname}` : ""}`,
  });
  // Eager bootstrap: by the time the user types their first message the
  // agent/site setup turn is usually already done (visible on the stream).
  await startDriver(row, user);
  return getSessionRow(row.id)!;
}

export function getOwnedSession(user: RuntimeUser, id: string): SessionRow {
  const row = getSessionRow(id);
  if (!row || row.user_email.toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(404, "not_found", `No such session: ${id}`);
  }
  return row;
}

export function listSessions(user: RuntimeUser, openOnly: boolean): SessionRow[] {
  return listSessionRows(user.email, openOnly);
}

export async function sendMessage(
  user: RuntimeUser,
  id: string,
  text: string,
  attachmentPaths: string[]
): Promise<number> {
  let row = getOwnedSession(user, id);
  let driver = liveDrivers.get(id);
  if (driver?.busy) {
    throw new ApiError(409, "busy", "Session is processing the previous turn");
  }
  if (!driver) {
    // Resume: restart after idle-close, archive, or a runtime restart.
    await startDriver(row, user);
    driver = liveDrivers.get(id)!;
  }
  if (row.status !== "active") {
    setSessionStatus(id, "active");
    row = getSessionRow(id)!;
  }

  let promptText = text;
  if (attachmentPaths.length > 0) {
    promptText +=
      `\n\n[Attached file${attachmentPaths.length > 1 ? "s" : ""} — open with the Read tool]\n` +
      attachmentPaths.map((p) => `- ${p}`).join("\n");
  }

  const seq = emit(id, "message", { role: "user", type: "text", text });
  emit(id, "status", { state: "thinking" });
  touchSession(id);
  driver.pushUserTurn(promptText);
  return seq;
}

export async function interruptSession(user: RuntimeUser, id: string): Promise<boolean> {
  getOwnedSession(user, id);
  const driver = liveDrivers.get(id);
  if (!driver) return false;
  return driver.interrupt();
}

export function closeSession(user: RuntimeUser, id: string, reason: "closed" | "idle_timeout"): void {
  const row = getOwnedSession(user, id);
  const driver = liveDrivers.get(id);
  if (driver) {
    driver.stop();
    liveDrivers.delete(id);
  }
  if (row.status !== "closed") {
    setSessionStatus(id, "closed");
    emit(id, "session.closed", { reason });
  }
}

// ── Lifecycle sweeper ───────────────────────────────────────────────────────

function sweep(): void {
  const now = Date.now();
  const idleCutoff = new Date(now - IDLE_MINUTES * 60_000).toISOString();
  const closeCutoff = new Date(now - CLOSE_MINUTES * 60_000).toISOString();

  for (const row of listStaleSessions(idleCutoff, ["active"])) {
    setSessionStatus(row.id, "idle");
  }
  for (const row of listStaleSessions(closeCutoff, ["active", "idle"])) {
    const driver = liveDrivers.get(row.id);
    if (driver?.busy) continue; // never kill a session mid-turn
    if (driver) {
      driver.stop();
      liveDrivers.delete(row.id);
    }
    setSessionStatus(row.id, "closed");
    emit(row.id, "session.closed", { reason: "idle_timeout" });
  }
}

let sweeper: NodeJS.Timeout | null = null;

export function startSessionLifecycle(): void {
  if (sweeper) return;
  sweeper = setInterval(sweep, SWEEP_SECONDS * 1000);
  sweeper.unref();
}

/** Best-effort shutdown: stop every live SDK loop (sessions resume on restart). */
export function shutdownAllSessions(): void {
  for (const [id, driver] of liveDrivers) {
    driver.stop();
    liveDrivers.delete(id);
  }
}

export function liveLoopCount(): number {
  return liveDrivers.size;
}
