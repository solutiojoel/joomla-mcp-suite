import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../store";

/**
 * Per-session JSONL transcripts at data/transcripts/<sessionId>.jsonl —
 * the same append-only idiom as agents-mcp run logs, but synchronous so
 * seq assignment and disk order can never diverge within the process.
 *
 * One line = one SSE event: { seq, ts, event, data }. The SSE hub replays
 * from here on reconnect (Last-Event-ID), and GET /messages derives chat
 * history from the message/tool_use/tool_result events.
 */

export interface TranscriptEvent {
  seq: number;
  ts: string;
  event: string;
  data: Record<string, unknown>;
}

const TRANSCRIPTS_DIR = path.join(dataDir(), "transcripts");

function fileFor(sessionId: string): string {
  // Session ids are runtime-generated (sess_<hex>), but never trust a path segment.
  return path.join(TRANSCRIPTS_DIR, `${sessionId.replace(/[^\w-]/g, "_")}.jsonl`);
}

export function appendEvent(sessionId: string, event: TranscriptEvent): void {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  fs.appendFileSync(fileFor(sessionId), JSON.stringify(event) + "\n");
}

export function readEvents(sessionId: string, afterSeq = 0): TranscriptEvent[] {
  const file = fileFor(sessionId);
  if (!fs.existsSync(file)) return [];
  const events: TranscriptEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as TranscriptEvent;
      if (typeof parsed.seq === "number" && parsed.seq > afterSeq) events.push(parsed);
    } catch {
      /* skip torn lines (crash mid-append) */
    }
  }
  return events;
}
