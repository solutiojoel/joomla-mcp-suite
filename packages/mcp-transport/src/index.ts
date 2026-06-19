/**
 * Shared MCP server bootstrap for the Joomla MCP suite.
 *
 * Every server in the suite (orchestrator, joomla-mcp, freshdesk-mcp, ftp-mcp,
 * agents-mcp) had its own near-identical copy of the StreamableHTTP session
 * loop + stdio fallback. This package is the one implementation.
 *
 * Shipped ESM-only: the package imports the MCP SDK's `exports`-mapped subpaths,
 * which a classic CJS TypeScript build can't resolve. The CommonJS orchestrator
 * consumes it via Node's `require(ESM)` support (Node >= 22.12), so no separate
 * CJS build is needed.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Minimal structural view of an MCP `Server` — just the one method this package
 * calls. Typing against this instead of the SDK's `Server` keeps the package
 * decoupled from whether a consumer resolved the SDK as ESM or CJS (those are
 * distinct nominal types and would otherwise fail to assign).
 */
export interface ConnectableServer {
  connect(transport: unknown): Promise<void>;
}

export type BuildServer = (context?: unknown) => ConnectableServer;

export type Logger = (msg: string) => void;

export interface CorsOptions {
  /** Access-Control-Allow-Origin. Defaults to process.env.CORS_ORIGIN || "http://localhost". */
  origin?: string;
}

export interface StartHttpOptions {
  port: number;
  /** Bind host. Defaults to process.env.HTTP_HOST || "0.0.0.0". */
  host?: string;
  /** MCP endpoint path. Defaults to "/mcp". */
  path?: string;
  /**
   * Build a fresh MCP Server for a new session. Receives the value returned by
   * `authenticate` (or undefined when there is no auth), so a server can scope
   * the session to the caller.
   */
  buildServer: BuildServer;
  /**
   * Optional auth gate. Return a context object to proceed, or null/undefined to
   * respond 401. The returned context is passed to `buildServer`.
   */
  authenticate?: (req: http.IncomingMessage) => unknown;
  /** Enable CORS (orchestrator uses this; downstream servers do not). */
  cors?: boolean | CorsOptions;
  logger?: Logger;
  /** Hook run once before the server starts listening (e.g. warm caches). */
  onStart?: () => Promise<void> | void;
}

function applyCors(req: http.IncomingMessage, res: http.ServerResponse, opts: CorsOptions): boolean {
  res.setHeader("Access-Control-Allow-Origin", opts.origin ?? process.env.CORS_ORIGIN ?? "http://localhost");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // Reflect requested headers so future MCP headers work without changes here.
  res.setHeader(
    "Access-Control-Allow-Headers",
    (req.headers["access-control-request-headers"] as string) ||
      "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, " +
        "X-Requested-With, Last-Event-Id, Cache-Control"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
  // Disable buffering for SSE streams (nginx / reverse proxies).
  res.setHeader("X-Accel-Buffering", "no");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/**
 * Start an MCP server over StreamableHTTP. One transport per session id; created
 * on the initializing POST, reused for follow-up POST/GET, torn down on DELETE.
 */
export async function startHttpServer(options: StartHttpOptions): Promise<http.Server> {
  const { port, buildServer } = options;
  const path = options.path ?? "/mcp";
  const host = options.host ?? process.env.HTTP_HOST ?? "0.0.0.0";
  const log: Logger = options.logger ?? (() => {});
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  if (options.onStart) await options.onStart();

  const httpServer = http.createServer(async (req, res) => {
    if (options.cors) {
      const preflightHandled = applyCors(req, res, options.cors === true ? {} : options.cors);
      if (preflightHandled) return;
    }

    let context: unknown;
    if (options.authenticate) {
      context = options.authenticate(req);
      if (context === null || context === undefined) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    const urlPath = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (urlPath !== path) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        const server = buildServer(context);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        transport.onclose = () => {
          if (transport!.sessionId) sessions.delete(transport!.sessionId);
        };
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    } else if (req.method === "GET") {
      const transport = sessionId ? sessions.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(404);
        res.end();
        return;
      }
      await transport.handleRequest(req, res);
    } else if (req.method === "DELETE") {
      if (sessionId) sessions.delete(sessionId);
      res.writeHead(200);
      res.end();
    } else {
      res.writeHead(405);
      res.end();
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, host, () => resolve()));
  log(`HTTP server ready on port ${port} (${host})`);
  return httpServer;
}

/** Start an MCP server over stdio. */
export async function startStdioServer(
  buildServer: BuildServer,
  context?: unknown
): Promise<void> {
  const server = buildServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface RunServerOptions extends Omit<StartHttpOptions, "port"> {
  /** Context passed to buildServer when running over stdio. */
  stdioContext?: unknown;
}

/**
 * Pick the transport from the environment: HTTP when HTTP_PORT/PORT is set,
 * otherwise stdio. This is the shared `main()` every server had.
 */
export async function runServer(options: RunServerOptions): Promise<void> {
  const raw = process.env.HTTP_PORT || process.env.PORT;
  const port = raw ? parseInt(raw, 10) : null;
  const log: Logger = options.logger ?? (() => {});

  if (port) {
    await startHttpServer({ ...options, port });
  } else {
    if (options.onStart) await options.onStart();
    await startStdioServer(options.buildServer, options.stdioContext);
    log("stdio ready");
  }
}
