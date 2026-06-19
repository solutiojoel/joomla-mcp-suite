import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages.js";
import { isToolAllowed } from "./match.js";
import {
  getDownstreamDef,
  resolveUrl,
  resolveToken,
} from "@solutio/mcp-downstream-client";

// Minimal slice of the MCP Client surface the executor depends on, so it can be
// unit-tested with a mock (no network).
export interface ToolCaller {
  callTool(req: { name: string; arguments: Record<string, any> }): Promise<any>;
}

export interface DownstreamHandle {
  client: ToolCaller;
  inject: string | null;
}

export interface BridgeContext {
  tools: AnthropicTool[];
  executor: (name: string, args: Record<string, any>) => Promise<any>;
}

/**
 * Build the tool executor handed to the sub-agent loop.
 *
 * SECURITY: the allow-list is enforced HERE, at execution, not only when tools
 * are advertised to the model. A tool call outside `allow` is rejected before it
 * reaches any downstream — so a hallucinated or injected call to an
 * unadvertised tool cannot run. Empty/absent `allow` means no restriction.
 *
 * Exported for unit testing with mock clients.
 */
export function buildExecutor(
  clients: Map<string, DownstreamHandle>,
  toolRegistry: Map<string, string>, // toolName -> downstream label
  siteUrl: string,
  allow?: string[]
): (name: string, args: Record<string, any>) => Promise<any> {
  return async (name: string, args: Record<string, any>) => {
    if (!isToolAllowed(name, allow)) {
      throw new Error(`Tool '${name}' is not in this sub-agent's allow-list`);
    }

    const label = toolRegistry.get(name);
    if (!label) throw new Error(`Tool ${name} not found in connected downstreams`);

    const downstream = clients.get(label);
    if (!downstream) throw new Error(`Downstream ${label} client missing`);

    // Inject site context if required
    const payload = { ...args };
    if (downstream.inject && siteUrl) {
      payload[downstream.inject] = siteUrl;
    }

    const result = await downstream.client.callTool({ name, arguments: payload });

    if (result.isError) {
      const content = result.content as any[];
      const text = content?.[0]?.type === "text" ? content[0].text : "Unknown error";
      throw new Error(`[${label}] ${name} failed: ${text}`);
    }

    const content = result.content as any[];
    const text = content?.[0]?.type === "text" ? content[0].text : "";
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
}

export async function connectDownstreams(
  labels: string[],
  siteUrl: string,
  allow?: string[]
): Promise<BridgeContext> {
  const clients = new Map<string, DownstreamHandle>();
  const anthropicTools: AnthropicTool[] = [];
  const toolRegistry = new Map<string, string>(); // toolName -> downstream label

  for (const label of labels) {
    const def = getDownstreamDef(label);
    if (!def) {
      console.warn(`[bridge] unknown downstream label: ${label}`);
      continue;
    }

    // agents-mcp reaches the other servers on localhost by default; resolveUrl
    // honors a <LABEL>_URL env override (label uppercased, dashes → underscores).
    const url = resolveUrl(label);
    const token = resolveToken(label);

    const client = new Client(
      { name: `agents-mcp->${label}`, version: "0.1.0" },
      { capabilities: {} }
    );

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    });

    try {
      await client.connect(transport);
      const { tools = [] } = await client.listTools();

      clients.set(label, { client, inject: def.inject });

      for (const t of tools) {
        if (toolRegistry.has(t.name)) continue;
        // Registry tracks every connected tool (first label wins) so routing and
        // error messages can distinguish "not connected" from "not allowed".
        toolRegistry.set(t.name, label);
        // Advertise to the model only what the allow-list permits; the executor
        // enforces the same list at call time.
        if (isToolAllowed(t.name, allow)) {
          anthropicTools.push({
            name: t.name,
            description: t.description || "",
            input_schema: t.inputSchema as any,
          });
        }
      }
      console.error(`[bridge] loaded ${tools.length} tools from ${label} (${anthropicTools.length} advertised after allow-list)`);
    } catch (err: any) {
      throw new Error(`Failed to connect to downstream ${label} at ${url}: ${err.message}`);
    }
  }

  const executor = buildExecutor(clients, toolRegistry, siteUrl, allow);

  return { tools: anthropicTools, executor };
}
