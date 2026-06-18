import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runMenuInterpreter } from "./agents/menu-interpreter.js";

const TOOLS = [
  {
    name: "agent_ping",
    description:
      "Phase-0 transport spike. Sleeps 90 seconds, emitting a progress notification every 10s, then returns { ok: true }. Used to validate that the orchestrator timeout + resetTimeoutOnProgress config works before any real sub-agent logic is built.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_menu_interpretation",
    description:
      "Phase 1–2 of the menu build workflow: interprets a raw menu document and produces a validated Menu Spec JSON. " +
      "Runs a Sonnet sub-agent that applies Phase 1 classification rules, produces the spec, validates it against the 8 lint invariants, " +
      "and persists it to the workspace via joomla_workspace_write. " +
      "Returns { success: true, spec: {...} } on success or { success: false, error, lint_errors?, partial_spec? } on failure.",
    inputSchema: {
      type: "object",
      required: ["site_url", "menu_text"],
      properties: {
        site_url: {
          type: "string",
          description: "The active site URL (e.g. https://example.com). Used to persist the spec to the correct workspace.",
        },
        menu_text: {
          type: "string",
          description: "Raw text extracted from the menu document (PDF, Word doc, etc.). Include all headings, page names, and sub-items.",
        },
        source_filename: {
          type: "string",
          description: "Original filename of the source document (e.g. \"Church-Menu.pdf\"). Used as the spec's source field.",
        },
      },
    },
  },
];

function buildServer(): Server {
  const server = new Server(
    { name: "agents-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  console.error(`[buildServer] registering ${TOOLS.length} tools`);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(`[ListToolsRequestSchema] handler called`);
    const result = { tools: TOOLS };
    console.error(`[ListToolsRequestSchema] returning`, JSON.stringify(result));
    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, _meta } = request.params;
    const progressToken = _meta?.progressToken;

    const sendProgress = async (progress: number, total: number) => {
      if (progressToken === undefined) return;
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total },
      });
    };

    switch (name) {
      case "agent_ping": {
        const TOTAL_SECS = 90;
        const INTERVAL_SECS = 10;
        const steps = TOTAL_SECS / INTERVAL_SECS;

        console.error(`[agent_ping] starting 90s sleep (${steps} intervals)`);
        for (let i = 0; i < steps; i++) {
          await new Promise<void>((res) => setTimeout(res, INTERVAL_SECS * 1000));
          console.error(`[agent_ping] step ${i + 1}/${steps}`);
          await sendProgress((i + 1) * INTERVAL_SECS, TOTAL_SECS);
        }
        console.error("[agent_ping] done");

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
        };
      }

      case "run_menu_interpretation": {
        console.error(`[run_menu_interpretation] starting`);
        let iterCount = 0;
        const result = await runMenuInterpreter(
          {
            site_url: request.params.arguments?.site_url as string,
            menu_text: request.params.arguments?.menu_text as string,
            source_filename: request.params.arguments?.source_filename as string | undefined,
          },
          async (progress, total) => {
            iterCount = progress;
            console.error(`[run_menu_interpretation] iteration ${progress}/${total}`);
            await sendProgress(progress, total);
          }
        );
        console.error(`[run_menu_interpretation] done after ${iterCount} iterations, success=${result.success}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  return server;
}

async function startHttp(port: number): Promise<void> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    console.error(`[HTTP] ${req.method} ${req.url} (session: ${req.headers["mcp-session-id"]})`);
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (reqUrl.pathname !== "/mcp") {
      console.error(`[HTTP] wrong path: ${reqUrl.pathname}`);
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      const mcpServer = buildServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
        },
      });
      await mcpServer.connect(transport);
    }

    let body: unknown;
    if (req.method === "POST") {
      body = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk: Buffer) => (data += chunk.toString()));
        req.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(undefined);
          }
        });
        req.on("error", reject);
      });
    }

    await transport.handleRequest(req, res, body);
    if (req.method === "DELETE" && sessionId) {
      sessions.delete(sessionId);
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.error(`agents-mcp running on HTTP port ${port}`);
}

async function main() {
  const rawPort = process.env.HTTP_PORT || process.env.PORT;
  const httpPort = rawPort ? parseInt(rawPort, 10) : null;

  if (httpPort) {
    await startHttp(httpPort);
  } else {
    const mcpServer = buildServer();
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("agents-mcp running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
