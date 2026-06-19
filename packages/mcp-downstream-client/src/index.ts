/**
 * Canonical downstream registry for the Joomla MCP suite.
 *
 * This is the SINGLE source of truth for the per-server `inject` argument and
 * default port. It is consumed by:
 *   - the orchestrator (apps/orchestrator/orchestrator.js), which routes the
 *     main agent's tool calls to downstream MCP servers, and
 *   - the agents-mcp bridge (apps/agents-mcp/src/bridge.ts), which lets a
 *     sub-agent reach the same downstreams.
 *
 * Before this package the inject map lived in both places and had already
 * drifted (different hosts, missing servers). Keep all downstream identity here.
 *
 * Connection mechanics deliberately stay in each consumer: the orchestrator
 * opens a fresh client per call (with retry); the bridge holds persistent
 * clients and maps tools into Anthropic's schema. Only the *registry* is shared.
 */

/** The argument name that carries the active site on each call to a downstream,
 *  or null for servers that need no site context. */
export type InjectArg = "site_url" | "site" | null;

export interface DownstreamDef {
  label: string;
  port: number;
  inject: InjectArg;
}

/**
 * Registry order matters for the orchestrator: the first server whose tool map
 * contains a tool name wins, so single-purpose servers come before joomla-mcp
 * (which overlaps during migration).
 */
export const DOWNSTREAM_DEFAULTS: readonly DownstreamDef[] = Object.freeze([
  { label: "freshdesk-mcp", port: 9303, inject: null },
  { label: "ftp-mcp", port: 9304, inject: "site_url" },
  { label: "mockup-analyzer", port: 9305, inject: null },
  { label: "joomla-mcp", port: 9300, inject: "site_url" },
  { label: "gantry-mcp", port: 9301, inject: "site" },
  { label: "agents-mcp", port: 3506, inject: "site_url" },
]);

const BY_LABEL: Map<string, DownstreamDef> = new Map(
  DOWNSTREAM_DEFAULTS.map((d) => [d.label, d])
);

/** Look up a downstream definition by label, or undefined if unknown. */
export function getDownstreamDef(label: string): DownstreamDef | undefined {
  return BY_LABEL.get(label);
}

/** The inject arg for a label (null if none / unknown label). */
export function getInject(label: string): InjectArg {
  return BY_LABEL.get(label)?.inject ?? null;
}

/** Env var prefix for a label, e.g. "ftp-mcp" -> "FTP_MCP". */
export function envPrefix(label: string): string {
  return label.toUpperCase().replace(/-/g, "_");
}

export interface ResolveUrlOptions {
  /** Host to use when building the default URL. Defaults to "127.0.0.1". */
  host?: string;
  /** Environment bag to read `<PREFIX>_URL` overrides from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Resolve a downstream's MCP URL. Honors a `<PREFIX>_URL` env override first,
 * otherwise builds `http://<host>:<port>/mcp` from the registry port.
 */
export function resolveUrl(label: string, opts: ResolveUrlOptions = {}): string {
  const env = opts.env ?? process.env;
  const override = env[`${envPrefix(label)}_URL`];
  if (override) return override;
  const def = BY_LABEL.get(label);
  if (!def) throw new Error(`Unknown downstream label: ${label}`);
  const host = opts.host ?? "127.0.0.1";
  return `http://${host}:${def.port}/mcp`;
}

/** Bearer token for a label from `<PREFIX>_TOKEN`, or "" if unset. */
export function resolveToken(label: string, env: Record<string, string | undefined> = process.env): string {
  return env[`${envPrefix(label)}_TOKEN`] || "";
}

/**
 * Return a shallow copy of `args` with the label's inject arg set to `siteUrl`.
 * No-op when the label has no inject arg or `siteUrl` is empty. Pure — never
 * mutates the input.
 */
export function applyInject<T extends Record<string, any>>(
  label: string,
  args: T,
  siteUrl: string | undefined
): T {
  const inject = getInject(label);
  if (!inject || !siteUrl) return { ...args };
  return { ...args, [inject]: siteUrl };
}
