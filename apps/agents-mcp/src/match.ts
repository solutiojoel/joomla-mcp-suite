/**
 * Trailing-`*` glob matcher, mirroring the orchestrator's kb.matchesPattern so
 * sub-agent allow-lists use the same semantics as main-agent agent scopes:
 *   "*"            → matches everything
 *   "joomla_menu*" → matches any name starting with "joomla_menu"
 *   "joomla_article" → exact match only
 */
export function matchPattern(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Is `name` permitted by an allow-list? An empty/absent list means "no
 * restriction" (allow all) — back-compat for callers that pass no allow-list.
 */
export function isToolAllowed(name: string, allow?: string[]): boolean {
  if (!allow || allow.length === 0) return true;
  return allow.some((p) => matchPattern(name, p));
}
