'use strict';

/**
 * KB accessor module — the only place that touches the docs filesystem.
 *
 * Docs live under docs/agents/<scope>/, where <scope> is one of SCOPE_DIRS
 * (global, support, menu-content, menu-build, design, launch). A doc has two names:
 *
 *   canonical — its path relative to docs/agents (e.g. "support/kb/user-accounts")
 *   public    — the canonical name with the scope segment stripped
 *               (e.g. "kb/user-accounts") — this is the name agents use and
 *               the name all pre-reorg references (CLAUDE.md, instruction
 *               files) were written against. Both names resolve.
 *
 * Agent docs.allow patterns are matched against BOTH names, so scope globs
 * ("global/*", "support/*") and legacy explicit names ("editing-rules") work.
 *
 * Exports:
 *   listDocs(agentDef)          → string[]        public doc names visible to the agent
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

const DOCS_GLOBAL_DIR   = path.join(__dirname, '..', '..', 'docs', 'global');
const DOCS_AGENTS_DIR   = path.join(__dirname, '..', '..', 'docs', 'agents');
const AGENTS_CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'agents');

// Top-level dirs under docs/agents that act as permission scopes. A doc's
// public name strips this segment; anything outside these dirs keeps its
// full relative path as both canonical and public name.
const SCOPE_DIRS = new Set(['global', 'support', 'menu-content', 'menu-build', 'design', 'launch']);

// ─── Doc discovery ────────────────────────────────────────────────────────────

/**
 * Scan docs/agents and build the doc index.
 * Returns Map<lookupName, { canonical, publicName, file }> where lookupName
 * covers both the canonical and public spellings of every doc.
 * Re-scanned on every call so new files appear without a restart.
 */
function buildDocIndex() {
  const index = new Map();

  function register(lookupName, entry) {
    if (index.has(lookupName) && index.get(lookupName).file !== entry.file) {
      console.error(
        `[kb] WARNING: doc name collision on '${lookupName}': ` +
        `keeping ${index.get(lookupName).canonical}, ignoring ${entry.canonical}`
      );
      return;
    }
    index.set(lookupName, entry);
  }

  function scanDir(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanDir(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const canonical = (prefix ? `${prefix}/` : '') + entry.name.slice(0, -3);
        const firstSeg  = canonical.split('/')[0];
        const publicName = SCOPE_DIRS.has(firstSeg)
          ? canonical.slice(firstSeg.length + 1)
          : canonical;
        const doc = { canonical, publicName, file: path.join(dir, entry.name) };
        register(canonical, doc);
        if (publicName !== canonical) register(publicName, doc);
      }
    }
  }

  // docs/global/ is scanned with the 'global' prefix so canonical names remain
  // 'global/...' and public names (scope stripped) stay unchanged.
  scanDir(DOCS_GLOBAL_DIR, 'global');
  scanDir(DOCS_AGENTS_DIR, '');
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
  return allow.some(p => matchesPattern(doc.canonical, p) || matchesPattern(doc.publicName, p));
}

/**
 * Returns true if the agent definition permits reading the named doc.
 * Accepts either the canonical or public name; unknown names are checked
 * against the patterns directly (so NOT_FOUND, not PERMISSION_DENIED, is
 * reported for files that simply don't exist in an allowed scope).
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
 * List public doc names available to the agent (filtered by docs.allow).
 * Called on every ListTools request so new files appear without a restart.
 */
function listDocs(agentDef) {
  const allow = (agentDef && agentDef.docs && agentDef.docs.allow) || ['*'];
  const names = new Set();
  for (const doc of buildDocIndex().values()) {
    if (allow.includes('*') || docMatchesAllow(doc, allow)) names.add(doc.publicName);
  }
  return Array.from(names).sort();
}

/**
 * Read a doc by canonical or public name.
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

module.exports = { listDocs, readDoc, readInstructions, isToolAllowed, isDocAllowed, isGloballyDenied, checkToolRules };
