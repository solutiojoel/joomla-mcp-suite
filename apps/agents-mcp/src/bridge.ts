import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages.js";

interface DownstreamConfig {
  label: string;
  url: string;
  token?: string;
  inject: string | null;
}

const DEFAULTS: Record<string, { port: number; inject: string | null }> = {
  "joomla-mcp": { port: 9300, inject: "site_url" },
  "gantry-mcp": { port: 9301, inject: "site" },
  "freshdesk-mcp": { port: 9303, inject: null },
  "ftp-mcp": { port: 9304, inject: "site_url" },
};

export interface BridgeContext {
  tools: AnthropicTool[];
  executor: (name: string, args: Record<string, any>) => Promise<any>;
}

export async function connectDownstreams(labels: string[], siteUrl: string): Promise<BridgeContext> {
  const clients = new Map<string, { client: Client; inject: string | null }>();
  const anthropicTools: AnthropicTool[] = [];
  const toolRegistry = new Map<string, string>(); // toolName -> downstream label

  for (const label of labels) {
    const def = DEFAULTS[label];
    if (!def) {
      console.warn(`[bridge] unknown downstream label: ${label}`);
      continue;
    }

    const envPrefix = label.toUpperCase().replace(/-/g, "_");
    const url = process.env[`${envPrefix}_URL`] || `http://127.0.0.1:${def.port}/mcp`;
    const token = process.env[`${envPrefix}_TOKEN`] || "";

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
        if (!toolRegistry.has(t.name)) {
          toolRegistry.set(t.name, label);
          anthropicTools.push({
            name: t.name,
            description: t.description || "",
            input_schema: t.inputSchema as any,
          });
        }
      }
      console.error(`[bridge] loaded ${tools.length} tools from ${label}`);
    } catch (err: any) {
      throw new Error(`Failed to connect to downstream ${label} at ${url}: ${err.message}`);
    }
  }

  const executor = async (name: string, args: Record<string, any>) => {
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

  return { tools: anthropicTools, executor };
}
