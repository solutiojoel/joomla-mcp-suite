import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runServer } from "@solutio/mcp-transport";
import { createLogger } from "@solutio/logging";
import { GatewayClient, GatewayResponse } from "./gateway-client.js";

// Knowledge Gateway client (optional — tools fail gracefully if not configured)
const gatewayConfig = {
  apiKey: process.env.KNOWLEDGE_GATEWAY_API_KEY ?? "",
  baseUrl: process.env.KNOWLEDGE_GATEWAY_BASE_URL ?? "https://shannon-data.replit.app/api",
};
const gateway = gatewayConfig.apiKey
  ? new GatewayClient(gatewayConfig)
  : null;

function formatResult(response: GatewayResponse): string {
  const result: Record<string, unknown> = {
    success: response.success,
    message: response.message,
  };
  if (response.data !== undefined) {
    result.data = response.data;
    result.dataType = Array.isArray(response.data) ? "array" : typeof response.data;
    if (Array.isArray(response.data)) {
      result.itemCount = response.data.length;
    }
  }
  return JSON.stringify(result, null, 2);
}

function ok(response: GatewayResponse) {
  return { content: [{ type: "text" as const, text: formatResult(response) }], isError: !response.success };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, message }) }], isError: true };
}

const NOT_CONFIGURED = {
  content: [{ type: "text" as const, text: JSON.stringify({ success: false, message: "Knowledge Gateway not configured: set KNOWLEDGE_GATEWAY_API_KEY in .env" }) }],
  isError: true,
};

const tools = [
  {
    name: "knowledge_universal",
    description: "Manage universal (cross-client) knowledge in the AI Knowledge Gateway. action: list|get|create|update|delete.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "delete"],
          description: "list: filter entries; get: by id; create: new entry; update: edit fields; delete: remove",
        },
        id: { type: "number", description: "Entry id — required for get/update/delete" },
        topic: { type: "string", description: "Topic label (filter on list; field on create/update)" },
        tag: { type: "string", description: "Single tag to filter by (list only)" },
        search: { type: "string", description: "Full-text search filter (list only)" },
        content: { type: "string", description: "Entry body (markdown or HTML) — create/update" },
        tags: { type: "array", items: { type: "string" }, description: "Tag list — create/update" },
        contentType: { type: "string", enum: ["markdown", "html"], description: "Defaults to markdown — create/update" },
      },
      required: ["action"],
    },
  },
  {
    name: "knowledge_client",
    description: "Manage client-scoped knowledge (per site) in the AI Knowledge Gateway. action: list|get|create|update|delete. Pass site_code to scope.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "delete"],
          description: "list: filter entries; get: by id; create: new entry; update: edit fields; delete: remove",
        },
        id: { type: "number", description: "Entry id — required for get/update/delete" },
        site_code: { type: "string", description: "Client site code, e.g. 'SITE001' (filter on list; required on create)" },
        topic: { type: "string", description: "Topic label (filter on list; field on create/update)" },
        tag: { type: "string", description: "Single tag to filter by (list only)" },
        search: { type: "string", description: "Full-text search filter (list only)" },
        content: { type: "string", description: "Entry body (markdown or HTML) — create/update" },
        tags: { type: "array", items: { type: "string" }, description: "Tag list — create/update" },
        contentType: { type: "string", enum: ["markdown", "html"], description: "Defaults to markdown — create/update" },
      },
      required: ["action"],
    },
  },
  {
    name: "knowledge_self_improving",
    description: "Manage per-tool self-improving AI instructions in the Knowledge Gateway. action: list|get|create|update|delete. version auto-increments on update.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "delete"],
          description: "list: filter entries; get: by id; create: new instruction; update: revise (bumps version); delete: remove",
        },
        id: { type: "number", description: "Entry id — required for get/update/delete" },
        tool_name: { type: "string", description: "Tool the instruction applies to (filter on list; required on create)" },
        search: { type: "string", description: "Full-text search filter (list only)" },
        instruction: { type: "string", description: "Instruction text — create/update" },
        notes: { type: "string", description: "Optional context note — create/update" },
        change_reason: { type: "string", description: "Why the instruction changed — update only" },
      },
      required: ["action"],
    },
  },
  {
    name: "knowledge_audit",
    description: "Read the Knowledge Gateway audit log (read-only record of all create/update/delete changes). action: list.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list"], description: "Only 'list' is supported (the audit log is read-only)" },
        table_name: { type: "string", enum: ["knowledge", "client_knowledge", "self_improving"], description: "Filter by source table" },
        tool_name: { type: "string", description: "Filter by the tool that made the change" },
        change_action: { type: "string", enum: ["create", "update", "delete"], description: "Filter by change type" },
        limit: { type: "number", description: "Page size (default 50)" },
        offset: { type: "number", description: "Page offset (default 0)" },
      },
      required: ["action"],
    },
  },
];

function buildServer(): Server {
  const server = new Server(
    { name: "knowledge-gateway-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const { name, arguments: args = {} } = request.params;

    if (!gateway) return NOT_CONFIGURED;

    const action = args.action as string | undefined;
    const id = args.id as number | undefined;
    const needsId = (a: string) => ["get", "update", "delete"].includes(a);

    try {
      switch (name) {
        case "knowledge_universal": {
          if (!action) return err("Error: action is required");
          if (needsId(action) && id === undefined) return err(`Error: id is required for action '${action}'`);
          switch (action) {
            case "list":
              return ok(await gateway.listKnowledge({
                topic: args.topic as string | undefined,
                tag: args.tag as string | undefined,
                search: args.search as string | undefined,
              }));
            case "get":
              return ok(await gateway.getKnowledge(id as number));
            case "create":
              return ok(await gateway.createKnowledge({
                topic: args.topic as string | undefined,
                content: args.content as string | undefined,
                tags: args.tags as string[] | undefined,
                content_type: args.contentType as string | undefined,
              }));
            case "update":
              return ok(await gateway.updateKnowledge(id as number, {
                topic: args.topic as string | undefined,
                content: args.content as string | undefined,
                tags: args.tags as string[] | undefined,
                content_type: args.contentType as string | undefined,
              }));
            case "delete":
              return ok(await gateway.deleteKnowledge(id as number));
            default:
              return err(`Unknown action: ${action}`);
          }
        }

        case "knowledge_client": {
          if (!action) return err("Error: action is required");
          if (needsId(action) && id === undefined) return err(`Error: id is required for action '${action}'`);
          switch (action) {
            case "list":
              return ok(await gateway.listClientKnowledge({
                site_code: args.site_code as string | undefined,
                topic: args.topic as string | undefined,
                tag: args.tag as string | undefined,
                search: args.search as string | undefined,
              }));
            case "get":
              return ok(await gateway.getClientKnowledge(id as number));
            case "create":
              return ok(await gateway.createClientKnowledge({
                site_code: args.site_code as string | undefined,
                topic: args.topic as string | undefined,
                content: args.content as string | undefined,
                tags: args.tags as string[] | undefined,
                content_type: args.contentType as string | undefined,
              }));
            case "update":
              return ok(await gateway.updateClientKnowledge(id as number, {
                site_code: args.site_code as string | undefined,
                topic: args.topic as string | undefined,
                content: args.content as string | undefined,
                tags: args.tags as string[] | undefined,
                content_type: args.contentType as string | undefined,
              }));
            case "delete":
              return ok(await gateway.deleteClientKnowledge(id as number));
            default:
              return err(`Unknown action: ${action}`);
          }
        }

        case "knowledge_self_improving": {
          if (!action) return err("Error: action is required");
          if (needsId(action) && id === undefined) return err(`Error: id is required for action '${action}'`);
          switch (action) {
            case "list":
              return ok(await gateway.listSelfImproving({
                tool_name: args.tool_name as string | undefined,
                search: args.search as string | undefined,
              }));
            case "get":
              return ok(await gateway.getSelfImproving(id as number));
            case "create":
              return ok(await gateway.createSelfImproving({
                tool_name: args.tool_name as string | undefined,
                instruction: args.instruction as string | undefined,
                notes: args.notes as string | undefined,
              }));
            case "update":
              return ok(await gateway.updateSelfImproving(id as number, {
                instruction: args.instruction as string | undefined,
                notes: args.notes as string | undefined,
                change_reason: args.change_reason as string | undefined,
              }));
            case "delete":
              return ok(await gateway.deleteSelfImproving(id as number));
            default:
              return err(`Unknown action: ${action}`);
          }
        }

        case "knowledge_audit": {
          if (action && action !== "list") return err("knowledge_audit only supports action 'list'");
          return ok(await gateway.listAudit({
            table_name: args.table_name as string | undefined,
            tool_name: args.tool_name as string | undefined,
            action: args.change_action as string | undefined,
            limit: args.limit as number | undefined,
            offset: args.offset as number | undefined,
          }));
        }

        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, message: error instanceof Error ? error.message : String(error) }) }],
        isError: true,
      };
    }
  });

  return server;
}

runServer({
  buildServer,
  logger: createLogger("knowledge-gateway-mcp"),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
