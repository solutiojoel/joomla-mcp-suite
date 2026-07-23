import { Router, type NextFunction, type Request, type Response } from "express";
import { ApiError, sendError } from "../http";
import { getFileRow } from "../store";
import { agentIdsForUser } from "../catalog";
import { readEvents } from "./transcript";
import { handleStream } from "./sse";
import {
  apiSession,
  closeSession,
  createSession,
  getOwnedSession,
  interruptSession,
  listSessions,
  sendMessage,
} from "./manager";

// Chat session endpoints per docs/agent-runtime-api.md §4.

export const sessionsRouter = Router();

function wrap(fn: (req: Request, res: Response) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err instanceof ApiError) {
        return sendError(res, err.status, err.code, err.message, err.extra);
      }
      next(err);
    });
  };
}

sessionsRouter.post(
  "/api/sessions",
  wrap(async (req, res) => {
    const { agent, siteUrl, title } = (req.body || {}) as Record<string, unknown>;
    if (typeof agent !== "string" || !agent) {
      throw new ApiError(400, "validation", "agent is required");
    }
    if (siteUrl !== undefined && siteUrl !== null) {
      if (typeof siteUrl !== "string" || !/^https?:\/\//.test(siteUrl)) {
        throw new ApiError(400, "validation", "siteUrl must be an http(s) URL");
      }
    }
    if (title !== undefined && typeof title !== "string") {
      throw new ApiError(400, "validation", "title must be a string");
    }
    const row = await createSession(
      req.user!,
      { agent, siteUrl: (siteUrl as string) || null, title: (title as string) || null },
      agentIdsForUser(req.user!)
    );
    res.status(201).json(apiSession(row));
  })
);

sessionsRouter.get(
  "/api/sessions",
  wrap((req, res) => {
    // status=active → open sessions (active + idle, i.e. resumable without
    // the "closed" archive); status=all / omitted → everything.
    const openOnly = req.query.status === "active";
    res.json(listSessions(req.user!, openOnly).map(apiSession));
  })
);

sessionsRouter.get(
  "/api/sessions/:id",
  wrap((req, res) => {
    res.json(apiSession(getOwnedSession(req.user!, String(req.params.id))));
  })
);

sessionsRouter.get(
  "/api/sessions/:id/messages",
  wrap((req, res) => {
    const row = getOwnedSession(req.user!, String(req.params.id));
    const afterSeq = Number(req.query.afterSeq) || 0;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const messages: Record<string, unknown>[] = [];
    for (const evt of readEvents(row.id, afterSeq)) {
      if (messages.length >= limit) break;
      const d = evt.data;
      if (evt.event === "message") {
        messages.push(d);
      } else if (evt.event === "tool_use") {
        messages.push({ seq: evt.seq, ts: evt.ts, role: "assistant", type: "tool_use", ...d });
      } else if (evt.event === "tool_result") {
        messages.push({ seq: evt.seq, ts: evt.ts, role: "tool", type: "tool_result", ...d });
      }
    }
    res.json({ messages, nextSeq: row.seq + 1 });
  })
);

sessionsRouter.post(
  "/api/sessions/:id/messages",
  wrap(async (req, res) => {
    const { text, fileIds } = (req.body || {}) as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) {
      throw new ApiError(400, "validation", "text is required");
    }
    const attachmentPaths: string[] = [];
    if (fileIds !== undefined) {
      if (!Array.isArray(fileIds) || fileIds.some((f) => typeof f !== "string")) {
        throw new ApiError(400, "validation", "fileIds must be an array of file ids");
      }
      for (const fileId of fileIds as string[]) {
        const file = getFileRow(fileId, req.user!.email);
        if (!file) throw new ApiError(400, "validation", `Unknown file id: ${fileId}`);
        attachmentPaths.push(file.path);
      }
    }
    const seq = await sendMessage(req.user!, String(req.params.id), text, attachmentPaths);
    res.status(202).json({ accepted: true, seq });
  })
);

sessionsRouter.get(
  "/api/sessions/:id/stream",
  wrap((req, res) => {
    const row = getOwnedSession(req.user!, String(req.params.id));
    handleStream(req, res, row.id);
  })
);

sessionsRouter.post(
  "/api/sessions/:id/interrupt",
  wrap(async (req, res) => {
    const interrupted = await interruptSession(req.user!, String(req.params.id));
    res.json({ interrupted });
  })
);

sessionsRouter.delete(
  "/api/sessions/:id",
  wrap((req, res) => {
    closeSession(req.user!, String(req.params.id), "closed");
    res.json({ closed: true });
  })
);
