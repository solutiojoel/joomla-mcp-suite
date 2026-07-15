/**
 * Thin fetch client for the Knowledge Gateway REST API (shannon-data).
 * The X-Api-Key stays server-side; every request is attributed to the acting
 * dashboard user via X-Tool-Name ("dashboard:<email>" — the gateway tags audit
 * entries with it) plus an X-On-Behalf-Of header.
 *
 * Shared by the /api/knowledge proxy and the KB bridge (job artifact records).
 */

export interface GatewayResult {
  status: number;
  body: unknown;
}

export function gatewayBaseUrl(): string {
  return (process.env.KNOWLEDGE_GATEWAY_BASE_URL || "https://shannon-data.replit.app/api").replace(
    /\/+$/,
    ""
  );
}

export function gatewayConfigured(): boolean {
  return !!process.env.KNOWLEDGE_GATEWAY_API_KEY;
}

export async function gatewayFetch(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  pathname: string,
  opts: {
    userEmail: string;
    params?: Record<string, string | number | undefined>;
    body?: unknown;
  }
): Promise<GatewayResult> {
  const apiKey = process.env.KNOWLEDGE_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error("KNOWLEDGE_GATEWAY_API_KEY is not set");
  }
  const url = new URL(gatewayBaseUrl() + pathname);
  for (const [k, v] of Object.entries(opts.params || {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, {
    method,
    headers: {
      "X-Api-Key": apiKey,
      "X-Tool-Name": `dashboard:${opts.userEmail}`,
      "X-On-Behalf-Of": opts.userEmail,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let body: unknown = null;
  const text = await resp.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: resp.status, body };
}
