import { Router, type NextFunction, type Request, type Response } from "express";
import { ApiError, sendError } from "../http";
import { agentIdsForUser } from "../catalog";
import { handleStream } from "../sessions/sse";
import { apiJob, createJob, getOwnedJob, listJobs, stopJob } from "./manager";

// Job endpoints per docs/agent-runtime-api.md §5.

export const jobsRouter = Router();

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

jobsRouter.post(
  "/api/jobs",
  wrap((req, res) => {
    const { type, input } = (req.body || {}) as Record<string, unknown>;
    if (typeof type !== "string" || !type) {
      throw new ApiError(400, "validation", "type is required (a catalog job id)");
    }
    if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
      throw new ApiError(400, "validation", "input must be an object");
    }
    const row = createJob(
      req.user!,
      type,
      (input as Record<string, unknown>) || {},
      agentIdsForUser(req.user!)
    );
    res.status(202).json({
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.created_at,
    });
  })
);

jobsRouter.get(
  "/api/jobs",
  wrap((req, res) => {
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    const type = typeof req.query.type === "string" && req.query.type ? req.query.type : undefined;
    res.json(listJobs(req.user!, { status, type }).map((row) => apiJob(row)));
  })
);

jobsRouter.get(
  "/api/jobs/:id",
  wrap((req, res) => {
    res.json(apiJob(getOwnedJob(req.user!, String(req.params.id)), { includeRaw: true }));
  })
);

jobsRouter.get(
  "/api/jobs/:id/stream",
  wrap((req, res) => {
    const row = getOwnedJob(req.user!, String(req.params.id));
    handleStream(req, res, row.id, { closeAfterEvent: "done" });
  })
);

jobsRouter.post(
  "/api/jobs/:id/stop",
  wrap((req, res) => {
    stopJob(req.user!, String(req.params.id));
    res.status(202).json({ stopping: true });
  })
);
