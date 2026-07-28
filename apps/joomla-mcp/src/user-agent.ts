/**
 * Outbound identity policy for every request this server makes.
 *
 * Hosts we control can allowlist us, so by default we say who we are: a valid
 * browser UA with a `Solutio-MCP/<v>` product token appended. That is trivially
 * greppable in an access log while still carrying the browser tokens edge
 * filters look for — the origin 403s bare tool UAs such as curl's, which is why
 * this was a spoofed string in the first place.
 *
 * Sites outside our infrastructure may never allowlist us, so `stealth` drops
 * the product token and sends a plain browser UA.
 *
 * Env:
 *   SOLUTIO_USER_AGENT        full override; wins over everything
 *   SOLUTIO_UA_MODE           "identified" (default) | "stealth"
 *   SOLUTIO_UA_STEALTH_HOSTS  comma-separated host suffixes forced to stealth,
 *                             e.g. "example.org,cdn.partner.net"
 */

/** A real, complete Chrome UA. The previous string was truncated mid-token. */
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const VERSION = process.env.SOLUTIO_MCP_VERSION || "1.0";

/** Appended to the browser UA so our traffic is identifiable in an access log. */
export const PRODUCT_TOKEN = `Solutio-MCP/${VERSION} (+https://solutiosoftware.com)`;

const IDENTIFIED_UA = `${CHROME_UA} ${PRODUCT_TOKEN}`;

const STEALTH_HOSTS = (process.env.SOLUTIO_UA_STEALTH_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MODE_IS_STEALTH =
  (process.env.SOLUTIO_UA_MODE || "identified").toLowerCase() === "stealth";

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** True when we should identify ourselves to this URL's host. */
export function isIdentified(url?: string): boolean {
  if (process.env.SOLUTIO_USER_AGENT) return false;
  if (MODE_IS_STEALTH) return false;
  const host = url ? hostOf(url) : "";
  if (!host) return true;
  return !STEALTH_HOSTS.some((s) => host === s || host.endsWith(`.${s}`));
}

/** The User-Agent to send to this URL. */
export function userAgentFor(url?: string): string {
  return process.env.SOLUTIO_USER_AGENT || (isIdentified(url) ? IDENTIFIED_UA : CHROME_UA);
}

/**
 * UA plus, when identifying, a header an allowlist rule can match on without
 * having to parse the UA string. Omitted in stealth so nothing gives us away.
 */
export function outboundHeaders(url?: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": userAgentFor(url) };
  if (isIdentified(url)) headers["X-Solutio-Agent"] = `joomla-mcp/${VERSION}`;
  return headers;
}
