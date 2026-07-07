import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runServer } from "@solutio/mcp-transport";
import { createLogger } from "@solutio/logging";
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
      "Phase 1–2 of the menu build workflow: interprets a menu document and produces a validated Menu Spec JSON. " +
      "Runs the menu-interpreter sub-agent in a separate context window (Claude Agent SDK on the operator's subscription). " +
      "It applies the Phase 1 classification rules, self-checks the 8 lint invariants, persists the spec to the workspace " +
      "via joomla_workspace_write, and the result is re-validated (JSON schema + lint) before being returned. " +
      "Provide either pdf_path (preferred — the sub-agent reads the PDF itself, keeping it out of your context) or menu_text. " +
      "Returns { success: true, spec, run_log } or { success: false, error, schema_errors?, lint_errors?, partial_spec?, run_log }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: {
          type: "string",
          description: "The active site URL (e.g. https://example.com). Used to persist the spec to the correct workspace.",
        },
        pdf_path: {
          type: "string",
          description: "Absolute path to the menu PDF on this host (e.g. C:\\Users\\...\\Church-Menu.pdf). The sub-agent reads it directly.",
        },
        menu_text: {
          type: "string",
          description: "Raw text of the menu document, if already extracted. Include all headings, page names, and sub-items. Ignored when pdf_path is set.",
        },
        source_filename: {
          type: "string",
          description: "Original filename of the source document (e.g. \"Church-Menu.pdf\"). Used as the spec's source field. Defaults to the pdf_path basename.",
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
            menu_text: request.params.arguments?.menu_text as string | undefined,
            pdf_path: request.params.arguments?.pdf_path as string | undefined,
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

runServer({
  buildServer,
  logger: createLogger("agents-mcp"),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
