import { Router, type Request, type Response } from "express";
import { sendError } from "./http";

/**
 * Read-only proxy of the agents-mcp run monitor (port 3507) per API doc §8 —
 * shows ALL sub-agent runs on the box, including ones started from Claude
 * Code. The monitor itself is localhost-only and unauthenticated; the
 * dashboard reaches it only through this authenticated proxy. Stop for
 * dashboard jobs goes through POST /api/jobs/:id/stop, never through here.
 */

export function monitorBaseUrl(): string {
  return (process.env.AGENTS_DASHBOARD_URL || "http://127.0.0.1:3507").replace(/\/+$/, "");
}

interface MonitorRun {
  runId: string;
  agentName: string;
  [k: string]: unknown;
}

/** Contract shape: runId → id, agentName → agent (other fields pass through). */
function apiRun(run: MonitorRun): Record<string, unknown> {
  const { runId, agentName, ...rest } = run;
  return { id: runId, agent: agentName, ...rest };
}

async function monitorGet(pathname: string): Promise<unknown> {
  const resp = await fetch(monitorBaseUrl() + pathname, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) {
    const err = new Error(`run monitor returned ${resp.status}`) as Error & { status?: number };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export const runsRouter = Router();

runsRouter.get("/api/runs", async (req: Request, res: Response) => {
  try {
    const runs = (await monitorGet("/api/runs")) as MonitorRun[];
    res.json(runs.map(apiRun));
  } catch (err) {
    sendError(res, 502, "upstream_unavailable", `Run monitor unavailable: ${(err as Error).message}`);
  }
});

runsRouter.get("/api/runs/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!/^[A-Za-z0-9-]+$/.test(id)) {
    return sendError(res, 400, "validation", "Invalid run id");
  }
  try {
    const detail = (await monitorGet(`/api/runs/${id}`)) as {
      summary: MonitorRun | null;
      timeline: unknown[];
    };
    res.json({
      summary: detail.summary ? apiRun(detail.summary) : null,
      timeline: detail.timeline,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) {
      return sendError(res, 404, "not_found", `No such run: ${id}`);
    }
    sendError(res, 502, "upstream_unavailable", `Run monitor unavailable: ${(err as Error).message}`);
  }
});
