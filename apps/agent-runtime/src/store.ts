import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite persistence at apps/agent-runtime/data/runtime.db.
 * Uses Node's built-in node:sqlite (same synchronous API shape as
 * better-sqlite3, no native build step — matters on boxes without a
 * compiler toolchain). Sessions/jobs rows are written by Phases 2–3;
 * the schema exists from Phase 1 so the store is stable from day one.
 */

/** Data root (SQLite, transcripts, SDK cwd). Override for tests/relocation. */
export function dataDir(): string {
  return process.env.AGENT_RUNTIME_DATA_DIR || path.resolve(__dirname, "..", "data");
}

const DATA_DIR = dataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "runtime.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    user_email       TEXT NOT NULL,
    agent            TEXT NOT NULL,
    site_url         TEXT,
    title            TEXT,
    status           TEXT NOT NULL DEFAULT 'active',  -- active | idle | closed
    sdk_session_id   TEXT,                            -- Agent SDK resume handle
    seq              INTEGER NOT NULL DEFAULT 0,      -- per-session monotonic event counter
    created_at       TEXT NOT NULL,
    last_activity_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_email, created_at DESC);

  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    user_email    TEXT NOT NULL,
    type          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'queued',  -- queued | running | succeeded | failed | stopped
    input_json    TEXT,
    run_id        TEXT,                            -- agents-mcp run id, once known
    progress_json TEXT,
    result_json   TEXT,
    error_json    TEXT,
    seq           INTEGER NOT NULL DEFAULT 0,      -- per-job monotonic event counter
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs (user_email, created_at DESC);

  CREATE TABLE IF NOT EXISTS files (
    id           TEXT PRIMARY KEY,
    user_email   TEXT NOT NULL,
    name         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    path         TEXT NOT NULL,
    uploaded_at  TEXT NOT NULL
  );
`);

// Phase-1 databases predate the jobs.seq column — add it in place.
try {
  db.exec("ALTER TABLE jobs ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
} catch {
  /* column already exists */
}

export function newId(prefix: "sess" | "job" | "file"): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

/** Atomically bump and return a session's event sequence counter. */
export function nextSeq(sessionId: string): number {
  const row = db
    .prepare("UPDATE sessions SET seq = seq + 1 WHERE id = ? RETURNING seq")
    .get(sessionId) as { seq: number } | undefined;
  if (!row) throw new Error(`unknown session: ${sessionId}`);
  return Number(row.seq);
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ── Sessions ────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  user_email: string;
  agent: string;
  site_url: string | null;
  title: string | null;
  status: "active" | "idle" | "closed";
  sdk_session_id: string | null;
  seq: number;
  created_at: string;
  last_activity_at: string | null;
}

export function createSessionRow(params: {
  userEmail: string;
  agent: string;
  siteUrl?: string | null;
  title?: string | null;
}): SessionRow {
  const id = newId("sess");
  const now = nowIso();
  db.prepare(
    `INSERT INTO sessions (id, user_email, agent, site_url, title, status, seq, created_at, last_activity_at)
     VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)`
  ).run(id, params.userEmail, params.agent, params.siteUrl ?? null, params.title ?? null, now, now);
  return getSessionRow(id)!;
}

export function getSessionRow(id: string): SessionRow | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  return (row as unknown as SessionRow) ?? null;
}

export function listSessionRows(userEmail: string, openOnly: boolean): SessionRow[] {
  const sql = openOnly
    ? "SELECT * FROM sessions WHERE user_email = ? AND status != 'closed' ORDER BY created_at DESC"
    : "SELECT * FROM sessions WHERE user_email = ? ORDER BY created_at DESC";
  return db.prepare(sql).all(userEmail) as unknown as SessionRow[];
}

export function countOpenSessions(userEmail: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_email = ? AND status != 'closed'")
    .get(userEmail) as { n: number };
  return Number(row.n);
}

export function setSessionStatus(id: string, status: SessionRow["status"]): void {
  db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
}

export function setSdkSessionId(id: string, sdkSessionId: string | null): void {
  db.prepare("UPDATE sessions SET sdk_session_id = ? WHERE id = ?").run(sdkSessionId, id);
}

export function touchSession(id: string): void {
  db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?").run(nowIso(), id);
}

/** Open (non-closed) sessions whose last activity is older than the cutoff. */
export function listStaleSessions(cutoffIso: string, statuses: string[]): SessionRow[] {
  const placeholders = statuses.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM sessions WHERE status IN (${placeholders}) AND last_activity_at < ?`
    )
    .all(...statuses, cutoffIso) as unknown as SessionRow[];
}

// ── Jobs ────────────────────────────────────────────────────────────────────

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "stopped";

export interface JobRow {
  id: string;
  user_email: string;
  type: string;
  status: JobStatus;
  input_json: string | null;
  run_id: string | null;
  progress_json: string | null;
  result_json: string | null;
  error_json: string | null;
  seq: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function createJobRow(params: {
  userEmail: string;
  type: string;
  input: Record<string, unknown>;
}): JobRow {
  const id = newId("job");
  db.prepare(
    `INSERT INTO jobs (id, user_email, type, status, input_json, seq, created_at)
     VALUES (?, ?, ?, 'queued', ?, 0, ?)`
  ).run(id, params.userEmail, params.type, JSON.stringify(params.input), nowIso());
  return getJobRow(id)!;
}

export function getJobRow(id: string): JobRow | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
  return (row as unknown as JobRow) ?? null;
}

export function listJobRows(filter: {
  userEmail?: string; // omit for admin "everyone's jobs"
  status?: string;
  type?: string;
}): JobRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.userEmail) {
    where.push("user_email = ?");
    args.push(filter.userEmail);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  if (filter.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  const sql = `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
  return db.prepare(sql).all(...(args as never[])) as unknown as JobRow[];
}

/** Queued or running jobs for the per-user limit (1 active job per user). */
export function countActiveJobs(userEmail: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_email = ? AND status IN ('queued','running')")
    .get(userEmail) as { n: number };
  return Number(row.n);
}

export function updateJob(
  id: string,
  fields: Partial<{
    status: JobStatus;
    run_id: string | null;
    progress_json: string | null;
    result_json: string | null;
    error_json: string | null;
    started_at: string | null;
    finished_at: string | null;
  }>
): void {
  const keys = Object.keys(fields) as Array<keyof typeof fields>;
  if (keys.length === 0) return;
  const sql = `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  db.prepare(sql).run(...(keys.map((k) => fields[k]) as never[]), id);
}

/** Atomically bump and return a job's event sequence counter. */
export function nextJobSeq(jobId: string): number {
  const row = db
    .prepare("UPDATE jobs SET seq = seq + 1 WHERE id = ? RETURNING seq")
    .get(jobId) as { seq: number } | undefined;
  if (!row) throw new Error(`unknown job: ${jobId}`);
  return Number(row.seq);
}

/** Jobs left queued/running by a previous process (runtime restart mid-job). */
export function listOrphanedJobs(): JobRow[] {
  return db
    .prepare("SELECT * FROM jobs WHERE status IN ('queued','running')")
    .all() as unknown as JobRow[];
}

// ── Files ───────────────────────────────────────────────────────────────────

export interface FileRow {
  id: string;
  user_email: string;
  name: string;
  size: number;
  content_type: string;
  path: string;
  uploaded_at: string;
}

export function insertFileRow(params: {
  id: string;
  userEmail: string;
  name: string;
  size: number;
  contentType: string;
  path: string;
}): FileRow {
  db.prepare(
    `INSERT INTO files (id, user_email, name, size, content_type, path, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(params.id, params.userEmail, params.name, params.size, params.contentType, params.path, nowIso());
  return getFileRow(params.id, params.userEmail)!;
}

export function getFileRow(id: string, userEmail: string): FileRow | null {
  const row = db
    .prepare("SELECT * FROM files WHERE id = ? AND user_email = ?")
    .get(id, userEmail);
  return (row as unknown as FileRow) ?? null;
}
