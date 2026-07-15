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

const DATA_DIR = path.resolve(__dirname, "..", "data");
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
