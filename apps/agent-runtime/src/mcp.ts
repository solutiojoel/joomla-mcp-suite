import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Per-user orchestrator MCP access. A FRESH client per call, mirroring the
 * orchestrator's own downstream policy (no stale connections, no shared
 * sessions between users). Originally adapted from the retired apps/dashboard
 * (superseded by this app), with the per-user Authorization header added.
 */

export function orchestratorUrl(): string {
  return process.env.ORCHESTRATOR_URL || "http://127.0.0.1:9302/mcp";
}

export async function withOrchestrator<T>(
  bearerToken: string,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client(
    { name: "agent-runtime", version: "0.1.0" },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(orchestratorUrl()), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}
