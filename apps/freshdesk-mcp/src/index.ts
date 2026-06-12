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
import { FreshdeskClient, FreshdeskResponse } from "./freshdesk-client.js";

// Freshdesk client (optional — tools fail gracefully if not configured)
const freshdeskConfig = {
  domain: process.env.FRESHDESK_DOMAIN ?? "",
  apiKey: process.env.FRESHDESK_API_KEY ?? "",
};
const freshdesk =
  freshdeskConfig.domain && freshdeskConfig.apiKey
    ? new FreshdeskClient(freshdeskConfig)
    : null;

function formatResult(response: FreshdeskResponse): string {
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

const NOT_CONFIGURED = {
  content: [{ type: "text" as const, text: JSON.stringify({ success: false, message: "Freshdesk not configured: set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env" }) }],
  isError: true,
};

const tools = [
  {
    name: "freshdesk_get_ticket",
    description: "Fetch a Freshdesk ticket. Returns subject, description, status, priority, tags, requester_id, company_id.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "number" },
      },
      required: ["ticket_id"],
    },
  },
  {
    name: "freshdesk_get_contact",
    description: "Fetch a Freshdesk contact by ID. Returns name, email, phone, company_id.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "number", description: "Use requester_id from ticket" },
      },
      required: ["contact_id"],
    },
  },
  {
    name: "freshdesk_get_company",
    description: "Fetch a Freshdesk company by ID. Returns name, domains, and derived site_url for joomla_login.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: { type: "number" },
      },
      required: ["company_id"],
    },
  },
  {
    name: "freshdesk_get_conversations",
    description: "Fetch all replies and notes for a ticket in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "number" },
      },
      required: ["ticket_id"],
    },
  },
  {
    name: "freshdesk_add_note",
    description: "Add a private internal note to a ticket. Server prepends '— Shannon (AI Assistant)' automatically.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "number" },
        body: { type: "string", description: "Note body (HTML supported). Describe what was checked and changed." },
      },
      required: ["ticket_id", "body"],
    },
  },
  {
    name: "freshdesk_list_tickets",
    description: "List tickets by status. Default: unresolved (open+pending+waiting). Returns 30/page.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "pending", "waiting", "resolved", "closed", "unresolved", "all"],
          description: "open=2, pending=3, waiting=6+7, resolved=4, closed=5, unresolved=default",
        },
        company_id: { type: "number" },
        page: { type: "number", description: "Default: 1, 30 per page" },
      },
      required: [],
    },
  },
  {
    name: "freshdesk_update_ticket",
    description: "Update ticket status, priority, or tags. Confirm with user before changing status.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "number" },
        status: { type: "number", enum: [2, 3, 4, 5], description: "2=Open, 3=Pending, 4=Resolved, 5=Closed" },
        priority: { type: "number", enum: [1, 2, 3, 4], description: "1=Low, 2=Medium, 3=High, 4=Urgent" },
        tags: { type: "array", items: { type: "string" }, description: "Replaces full tag list" },
      },
      required: ["ticket_id"],
    },
  },
];

function buildServer(): Server {
  const server = new Server(
    { name: "freshdesk-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const { name, arguments: args } = request.params;

    if (!freshdesk) return NOT_CONFIGURED;

    try {
      switch (name) {
        case "freshdesk_get_ticket": {
          const ticketId = args?.ticket_id as number | undefined;
          if (!ticketId) return { content: [{ type: "text", text: "Error: ticket_id is required" }], isError: true };
          const result = await freshdesk.getTicket(ticketId);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "freshdesk_get_contact": {
          const contactId = args?.contact_id as number | undefined;
          if (!contactId) return { content: [{ type: "text", text: "Error: contact_id is required" }], isError: true };
          const result = await freshdesk.getContact(contactId);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "freshdesk_get_company": {
          const companyId = args?.company_id as number | undefined;
          if (!companyId) return { content: [{ type: "text", text: "Error: company_id is required" }], isError: true };
          const result = await freshdesk.getCompany(companyId);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "freshdesk_get_conversations": {
          const ticketId = args?.ticket_id as number | undefined;
          if (!ticketId) return { content: [{ type: "text", text: "Error: ticket_id is required" }], isError: true };
          const result = await freshdesk.getConversations(ticketId);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "freshdesk_add_note": {
          const ticketId = args?.ticket_id as number | undefined;
          const body = args?.body as string | undefined;
          if (!ticketId || !body) return { content: [{ type: "text", text: "Error: ticket_id and body are required" }], isError: true };
          const taggedBody = `<p>— Shannon (AI Assistant)</p>${body}`;
          const result = await freshdesk.addNote(ticketId, taggedBody, true);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "freshdesk_list_tickets": {
          const result = await freshdesk.listTickets({
            status: args?.status as "open" | "pending" | "waiting" | "resolved" | "closed" | "unresolved" | "all" | undefined,
            company_id: args?.company_id as number | undefined,
            page: args?.page as number | undefined,
          });
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "freshdesk_update_ticket": {
          const ticketId = args?.ticket_id as number | undefined;
          if (!ticketId) return { content: [{ type: "text", text: "Error: ticket_id is required" }], isError: true };
          const result = await freshdesk.updateTicket(ticketId, {
            status: args?.status as number | undefined,
            priority: args?.priority as number | undefined,
            tags: args?.tags as string[] | undefined,
          });
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
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

async function startHttp(port: number): Promise<void> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (reqUrl.pathname !== "/mcp") {
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
          try { resolve(JSON.parse(data)); } catch { resolve(undefined); }
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
  console.error(`Freshdesk MCP Server running on HTTP port ${port}`);
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
    console.error("Freshdesk MCP Server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
