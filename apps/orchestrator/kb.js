'use strict';

/**
 * KB accessor module — the only place that touches the docs filesystem.
 *
 * Docs live under docs/workflows/ and docs/kb/ (and any other topic dirs added
 * under docs/ except docs/sites/, which is managed by get_site_notes).
 *
 * A doc's name is its path relative to docs/, without the .md extension:
 *   e.g. "workflows/editing-rules", "kb/user-accounts"
 *
 * Agent docs.allow patterns support trailing-* wildcards, so you can grant
 * access by folder ("kb/*", "workflows/*") or by explicit name ("workflows/editing-rules").
 *
 * Exports:
 *   listDocs(agentDef)          → string[]        doc names visible to the agent
 *   readDoc(agentDef, name)     → string           throws with .code on error
 *   readInstructions(agentDef)  → string           agent instruction file
 *   isToolAllowed(agentDef, toolName) → boolean
 *   isDocAllowed(agentDef, docName)   → boolean
 *
 * Error codes thrown by readDoc / readInstructions:
 *   'PERMISSION_DENIED'  — agent's docs.allow doesn't include this doc
 *   'NOT_FOUND'          — file not on disk
 */

const fs   = require('fs');
const path = require('path');

const DOCS_DIR          = path.join(__dirname, '..', '..', 'docs');
const AGENTS_CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'agents');

// Top-level dirs under docs/ that are excluded from the doc index.
// sites/ is managed by get_site_notes / write_site_notes, not read_agent_doc.
const EXCLUDED_DIRS = new Set(['sites']);

// ─── Doc discovery ────────────────────────────────────────────────────────────

/**
 * Scan docs/ and build the doc index.
 * Returns Map<name, { name, file }> where name is the path relative to docs/
 * without the .md extension (e.g. "workflows/editing-rules", "kb/user-accounts").
 * Re-scanned on every call so new files appear without a restart.
 */
function buildDocIndex() {
  const index = new Map();

  function scanDir(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryName = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!prefix && EXCLUDED_DIRS.has(entry.name)) continue;
        scanDir(path.join(dir, entry.name), entryName);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const name = entryName.slice(0, -3);
        if (index.has(name)) {
          console.error(`[kb] WARNING: doc name collision on '${name}': keeping ${index.get(name).file}, ignoring ${path.join(dir, entry.name)}`);
          continue;
        }
        index.set(name, { name, file: path.join(dir, entry.name) });
      }
    }
  }

  scanDir(DOCS_DIR, '');
  return index;
}

// ─── Pattern matching ─────────────────────────────────────────────────────────
// Supports trailing * wildcard only (e.g. "joomla_menu*", "global/*", "*").

function matchesPattern(name, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

// ─── Access checks ────────────────────────────────────────────────────────────

function docMatchesAllow(doc, allow) {
  return allow.some(p => matchesPattern(doc.name, p));
}

/**
 * Returns true if the agent definition permits reading the named doc.
 * Unknown names are checked against the patterns directly (so NOT_FOUND,
 * not PERMISSION_DENIED, is reported for files that simply don't exist).
 */
function isDocAllowed(agentDef, docName) {
  if (!agentDef || !agentDef.docs) return true;
  const { allow = ['*'] } = agentDef.docs;
  if (allow.includes('*')) return true;
  const doc = buildDocIndex().get(docName);
  if (doc) return docMatchesAllow(doc, allow);
  return allow.some(p => matchesPattern(docName, p));
}

/**
 * Returns true if the agent definition permits calling the named tool.
 * deny beats allow; * in allow matches everything not denied.
 */
function isToolAllowed(agentDef, toolName) {
  if (!agentDef || !agentDef.tools) return true;
  const { allow = ['*'], deny = [] } = agentDef.tools;
  if (deny.some(p => matchesPattern(toolName, p))) return false;
  return allow.some(p => matchesPattern(toolName, p));
}

/**
 * Returns true if the tool name matches any pattern in the global deny list.
 * Used by the orchestrator to block tools across all agents regardless of agent scope.
 */
function isGloballyDenied(toolName, globalDeny = []) {
  return globalDeny.some(p => matchesPattern(toolName, p));
}

// ─── Access-control constants ─────────────────────────────────────────────────
// Kept here (the access module) so resolveToolAccess and its callers — the
// orchestrator's ListTools/CallTool handlers and the scope-enforcement test —
// all share one definition.

// Internal plumbing: joomla_login is called automatically by the orchestrator
// via set_active_site and on auth-error recovery. Hiding it prevents the AI from
// calling it directly, which would bypass activeSiteUrl tracking. Enforced in
// both ListTools (filtered from the list) and CallTool (blocked by name).
const HIDDEN_JOOMLA_TOOLS = new Set(['joomla_login']);

// Own tools every agent can call regardless of its agent definition. These
// implement the session protocol and changelog discipline; they are not
// configurable via agent JSON. Everything else goes through scope enforcement.
// NOTE: switch_agent is intentionally NOT here — it is controlled per-agent
// so restricted scopes (support, menu-build) cannot self-elevate.
const MANDATORY_OWN_TOOLS = new Set([
  'set_active_site', 'get_active_site',
  'get_site_notes', 'append_site_note', 'write_site_notes',
  'gantry_reconnect', 'reload_tools',
  'get_agent_instructions', 'read_agent_doc',
  'get_current_agent',
]);

/**
 * Single source of truth for tool-access precedence, shared by the orchestrator's
 * ListTools (silent filter) and CallTool (error message) handlers so the two can
 * never drift.
 *
 * Precedence (first match wins):
 *   1. hidden     → denied  (internal plumbing, e.g. joomla_login — never callable)
 *   2. mandatory  → allowed (session-protocol own tools — bypass global deny + scope)
 *   3. globalDeny → denied  (config/tool-policy.json globalDeny — all agents)
 *   4. agent scope → isToolAllowed(agentDef) (per-agent allow/deny)
 *
 * @param {object}   agentDef             agent definition ({ tools: { allow, deny } })
 * @param {string}   toolName
 * @param {object}   opts
 * @param {string[]} [opts.globalDeny]    global deny patterns
 * @param {Set}      [opts.mandatory]     tool names always allowed
 * @param {Set}      [opts.hidden]        tool names never allowed
 * @returns {{ allowed: boolean, code: 'hidden'|'global_deny'|'scope'|null }}
 *          code identifies the denying rule so the caller can format the right
 *          message; null when allowed.
 */
function resolveToolAccess(agentDef, toolName, { globalDeny = [], mandatory, hidden } = {}) {
  if (hidden && hidden.has(toolName)) return { allowed: false, code: 'hidden' };
  if (mandatory && mandatory.has(toolName)) return { allowed: true, code: null };
  if (isGloballyDenied(toolName, globalDeny)) return { allowed: false, code: 'global_deny' };
  if (!isToolAllowed(agentDef, toolName)) return { allowed: false, code: 'scope' };
  return { allowed: true, code: null };
}

/**
 * Check argument-level rules for a tool call.
 * Returns an error message string if the call should be blocked, or null if allowed.
 *
 * Rule format (inside toolRules[toolName].argDeny):
 *   {
 *     when?:    { argName: value, ... }   // all conditions must match; omit to always apply
 *     field:    string                     // argument to inspect; supports dotted paths
 *     values:   string[]                  // denied values (trailing * wildcard supported)
 *     message?: string                    // optional override for the error text
 *   }
 *
 * Matching is case-insensitive and whitespace-trimmed. Both `field` and the keys
 * of `when` support dotted paths into nested objects (e.g. "request.id"); when a
 * path crosses an array, every element is inspected, so batch/nested payloads
 * cannot slip a denied value past the rule.
 *
 * Checks globalToolRules first, then agentDef.tools.rules.
 * Either layer can block the call independently.
 */
function checkToolRules(agentDef, toolName, args, globalToolRules = {}) {
  const norm = v => String(v ?? '').trim().toLowerCase();

  // Resolve a (possibly dotted) field path to the list of leaf values found.
  // Descends through nested objects and fans out across arrays.
  function resolveValues(root, fieldPath) {
    let nodes = [root];
    for (const seg of String(fieldPath).split('.')) {
      const next = [];
      for (const node of nodes) {
        if (node == null) continue;
        if (Array.isArray(node)) {
          for (const el of node) {
            if (el && typeof el === 'object' && seg in el) next.push(el[seg]);
          }
        } else if (typeof node === 'object' && seg in node) {
          next.push(node[seg]);
        }
      }
      nodes = next;
    }
    // Flatten any array leaves so each scalar is checked individually.
    const out = [];
    for (const n of nodes) Array.isArray(n) ? out.push(...n) : out.push(n);
    return out;
  }

  function valueMatches(value, pattern) {
    const nv = norm(value);
    const np = norm(pattern);
    if (np === '*') return true;
    if (np.endsWith('*')) return nv.startsWith(np.slice(0, -1));
    return nv === np;
  }

  function whenMatches(when) {
    return Object.entries(when).every(([k, v]) => {
      const found = resolveValues(args, k);
      return found.some(fv => norm(fv) === norm(v));
    });
  }

  function applyRuleSet(toolRules) {
    if (!toolRules) return null;
    for (const rule of (toolRules.argDeny || [])) {
      if (rule.when && !whenMatches(rule.when)) continue;
      const found = resolveValues(args, rule.field);
      const candidates = found.length ? found : [undefined];  // absent field → matches '' / '*'
      for (const fieldVal of candidates) {
        if ((rule.values || []).some(v => valueMatches(fieldVal, v))) {
          return rule.message ||
            `Tool '${toolName}': '${rule.field}' value '${norm(fieldVal)}' is not permitted.`;
        }
      }
    }
    return null;
  }

  return applyRuleSet(globalToolRules[toolName]) ||
         applyRuleSet(agentDef?.tools?.rules?.[toolName]) ||
         null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List doc names available to the agent (filtered by docs.allow).
 * Called on every ListTools request so new files appear without a restart.
 */
function listDocs(agentDef) {
  const allow = (agentDef && agentDef.docs && agentDef.docs.allow) || ['*'];
  const names = [];
  for (const doc of buildDocIndex().values()) {
    if (allow.includes('*') || docMatchesAllow(doc, allow)) names.push(doc.name);
  }
  return names.sort();
}

/**
 * Read a doc by name (path relative to docs/, without .md extension).
 * Throws Error with .code === 'PERMISSION_DENIED' or 'NOT_FOUND'.
 */
function readDoc(agentDef, docName) {
  const doc = buildDocIndex().get(docName);

  if (!doc) {
    const err = new Error(`Doc not found: "${docName}"`);
    err.code = 'NOT_FOUND';
    throw err;
  }

  if (!isDocAllowed(agentDef, docName)) {
    const err = new Error(
      `Doc '${docName}' is not available to the ${agentDef?.name || 'current'} agent.`
    );
    err.code = 'PERMISSION_DENIED';
    throw err;
  }

  return fs.readFileSync(doc.file, 'utf8');
}

/**
 * Read the agent's instruction file.
 * The instructions path in the agent definition is relative to config/agents/
 * (the same directory as the agent JSON — keeps scope rules and instruction text together).
 * Falls back to the project-root AGENTS.md when the per-agent file doesn't exist.
 */
function readInstructions(agentDef) {
  if (agentDef && agentDef.instructions) {
    // Resolve relative to the agent def's own directory (supports subfolder layout)
    const baseDir = agentDef._dir || AGENTS_CONFIG_DIR;
    const instrPath = path.resolve(baseDir, agentDef.instructions);
    // Path-traversal guard: must stay within config/agents/
    if (!path.relative(AGENTS_CONFIG_DIR, instrPath).startsWith('..') && fs.existsSync(instrPath)) {
      return fs.readFileSync(instrPath, 'utf8');
    }
  }

  // Fallback: monolithic AGENTS.md (used by admin and any agent without its own file)
  const fallback = path.join(__dirname, '..', '..', 'AGENTS.md');
  if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf8');

  const err = new Error('No agent instructions file found (expected AGENTS.md at project root)');
  err.code = 'NOT_FOUND';
  throw err;
}

module.exports = { listDocs, readDoc, readInstructions, isToolAllowed, isDocAllowed, isGloballyDenied, resolveToolAccess, matchesPattern, checkToolRules, HIDDEN_JOOMLA_TOOLS, MANDATORY_OWN_TOOLS };
