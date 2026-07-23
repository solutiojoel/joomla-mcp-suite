import type { Request, Response } from "express";
import { readEvents } from "./transcript";

/**
 * SSE hub. Every event carries `id: <seq>`; on reconnect the browser sends
 * Last-Event-ID and we replay everything newer from the transcript before
 * going live. Quiet streams get `: ping` comment keepalives (~25 s) so the
 * Cloudflare proxy doesn't idle them out (API doc §1).
 */

const PING_MS = 25_000;

interface Subscriber {
  res: Response;
  /** Frames arriving while the transcript replay runs are held back here. */
  holdback: Array<{ seq: number; event: string; frame: string }> | null;
  replayedUpTo: number;
  /** End the stream after this event is delivered (job streams close on `done`). */
  closeOn?: string;
}

const subscribers = new Map<string, Set<Subscriber>>();

function frame(seq: number, event: string, data: unknown): string {
  return `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function broadcast(sessionId: string, seq: number, event: string, data: unknown): void {
  const subs = subscribers.get(sessionId);
  if (!subs) return;
  const payload = frame(seq, event, data);
  for (const sub of subs) {
    if (sub.holdback) sub.holdback.push({ seq, event, frame: payload });
    else {
      sub.res.write(payload);
      if (sub.closeOn === event) sub.res.end();
    }
  }
}

export function subscriberCount(sessionId: string): number {
  return subscribers.get(sessionId)?.size ?? 0;
}

export function handleStream(
  req: Request,
  res: Response,
  sessionId: string,
  opts?: { closeAfterEvent?: string }
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const lastIdRaw = req.headers["last-event-id"] ?? req.query.lastEventId;
  const lastEventId = Number(Array.isArray(lastIdRaw) ? lastIdRaw[0] : lastIdRaw) || 0;

  // Subscribe FIRST (buffering) so nothing emitted during replay is lost.
  const sub: Subscriber = {
    res,
    holdback: [],
    replayedUpTo: lastEventId,
    closeOn: opts?.closeAfterEvent,
  };
  let subs = subscribers.get(sessionId);
  if (!subs) subscribers.set(sessionId, (subs = new Set()));
  subs.add(sub);

  const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
  req.on("close", () => {
    clearInterval(ping);
    subs!.delete(sub);
    if (subs!.size === 0) subscribers.delete(sessionId);
  });

  let closed = false;
  for (const evt of readEvents(sessionId, lastEventId)) {
    res.write(frame(evt.seq, evt.event, evt.data));
    sub.replayedUpTo = Math.max(sub.replayedUpTo, evt.seq);
    if (sub.closeOn === evt.event) {
      closed = true;
      break;
    }
  }
  if (!closed) {
    for (const held of sub.holdback!) {
      if (held.seq > sub.replayedUpTo) {
        res.write(held.frame);
        if (sub.closeOn === held.event) {
          closed = true;
          break;
        }
      }
    }
  }
  sub.holdback = null; // live from here on
  if (closed) res.end();
}
