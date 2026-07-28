import "./env.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runServer } from "@solutio/mcp-transport";
import { createLogger } from "@solutio/logging";
import { FreshdeskClient, FreshdeskResponse } from "./freshdesk-client.js";

// Freshdesk client (optional — tools fail gracefully if not configured)
// Accept FRESHDESK_DOMAIN as a bare subdomain ("yourcompany"), a full
// hostname ("yourcompany.freshdesk.com"), or a URL, and normalize to the
// full hostname the API client expects (it builds https://<domain>/api/v2).
function normalizeFreshdeskDomain(raw: string): string {
  const host = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  if (!host) return "";
  return host.includes(".") ? host : `${host}.freshdesk.com`;
}
const freshdeskConfig = {
  domain: normalizeFreshdeskDomain(process.env.FRESHDESK_DOMAIN ?? ""),
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
    description: "Fetch a Freshdesk ticket. Returns subject, description, status, priority, tags, requester_id, company_id, attachments (name, content_type, size, attachment_url — note the URL is a short-lived signed link), and inline_images (URLs of images embedded in the body).",
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
    description: "Fetch all replies and notes for a ticket in chronological order. Each message includes any attachments (name, content_type, size, attachment_url — the URL is a short-lived signed link) and inline_images (URLs of images embedded in the message body).",
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

export function buildServer(): Server {
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

// Only auto-start a transport when executed directly (node dist/index.js).
// The orchestrator requires this module for in-process hosting and calls
// buildServer() itself.
if (require.main === module) runServer({
  buildServer,
  serverInfo: { name: "freshdesk-mcp", version: "1.0.0" },
  logger: createLogger("freshdesk-mcp"),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
