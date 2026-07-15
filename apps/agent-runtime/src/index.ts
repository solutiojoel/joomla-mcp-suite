import "./env";
import path from "node:path";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { authRouter, authMiddleware, meRouter } from "./auth";
import { catalogRouter } from "./catalog";
import { sessionsRouter } from "./sessions/routes";
import { shutdownAllSessions, startSessionLifecycle } from "./sessions/manager";
import { filesRouter } from "./files";
import { jobsRouter } from "./jobs/routes";
import { startJobLifecycle } from "./jobs/manager";
import { knowledgeRouter } from "./knowledge";
import { runsRouter } from "./runs-proxy";
import { ApiError, sendError } from "./http";
import { orchestratorUrl } from "./mcp";
import "./store"; // opens the SQLite database and ensures the schema exists

const VERSION = "0.1.0";
const PORT = Number(process.env.AGENT_RUNTIME_PORT || 18310);
// Localhost-only by design: the sole user path is Cloudflare Tunnel → localhost.
const HOST = process.env.AGENT_RUNTIME_HOST || "127.0.0.1";
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// ── Health (no auth) — aggregates the dependencies per API doc §9 ──────────

function healthzUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/mcp\/?$/, "/healthz");
}

async function probe(url: string): Promise<"up" | "down"> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const body = (await resp.json()) as { ok?: boolean };
    return resp.ok && body?.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

app.get("/healthz", async (_req: Request, res: Response) => {
  const [orchestrator, agentsMcp, knowledgeGateway] = await Promise.all([
    probe(healthzUrl(orchestratorUrl())),
    probe(healthzUrl(process.env.AGENTS_MCP_URL || "http://127.0.0.1:3506/mcp")),
    probe(healthzUrl(process.env.KNOWLEDGE_GATEWAY_MCP_URL || "http://127.0.0.1:9306/mcp")),
  ]);
  const ok = orchestrator === "up" && agentsMcp === "up" && knowledgeGateway === "up";
  // Always HTTP 200 — ok:false signals degraded mode to the frontend banner.
  res.json({ ok, orchestrator, agentsMcp, knowledgeGateway, version: VERSION });
});

// ── API ─────────────────────────────────────────────────────────────────────

app.use(authRouter); // POST /api/auth/login (public)
app.use("/api", (req, res, next) => authMiddleware(req, res, next));
app.use(meRouter);
app.use(catalogRouter);
app.use(sessionsRouter);
app.use(filesRouter);
app.use(jobsRouter);
app.use(knowledgeRouter);
app.use(runsRouter);

// Unknown /api routes get the JSON envelope, not the SPA fallback.
app.use("/api", (req: Request, res: Response) => {
  sendError(res, 404, "not_found", `No such endpoint: ${req.method} ${req.originalUrl}`);
});

// ── Static frontend (built dashboard dropped into public/), SPA fallback ───

app.use(express.static(PUBLIC_DIR));
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ── Error envelope ──────────────────────────────────────────────────────────

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof ApiError) {
    return sendError(res, err.status, err.code, err.message, err.extra);
  }
  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && "body" in (err as object)) {
    return sendError(res, 400, "validation", "Malformed JSON body");
  }
  console.error("[agent-runtime] unhandled error:", err);
  sendError(res, 500, "internal", "Internal server error");
});

app.listen(PORT, HOST, () => {
  console.log(`[agent-runtime] v${VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`[agent-runtime] orchestrator: ${orchestratorUrl()}`);
  if (!process.env.RUNTIME_JWT_SECRET) {
    console.warn("[agent-runtime] WARNING: RUNTIME_JWT_SECRET is not set — logins will fail");
  }
  startSessionLifecycle();
  startJobLifecycle();
});

// Sessions survive restarts via SDK resume; just stop the subprocesses cleanly.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    shutdownAllSessions();
    process.exit(0);
  });
}
