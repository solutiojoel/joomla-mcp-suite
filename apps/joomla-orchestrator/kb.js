'use strict';

/**
 * KB accessor module — the only place that touches the docs filesystem.
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

const DOCS_AGENTS_DIR   = path.join(__dirname, '..', '..', 'docs', 'agents');
const JOOMLA_AGENTS_DIR = path.join(__dirname, '..', 'joomla-mcp', 'docs', 'agents');
const AGENTS_CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'agents');
const ALLOWED_DOC_DIRS  = [DOCS_AGENTS_DIR, JOOMLA_AGENTS_DIR];

// ─── Doc discovery ────────────────────────────────────────────────────────────

function buildAllDocs() {
  const docs = [];

  function scanDir(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanDir(path.join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        docs.push((prefix ? `${prefix}/` : '') + entry.name.slice(0, -3));
      }
    }
  }

  scanDir(DOCS_AGENTS_DIR, '');
  scanDir(JOOMLA_AGENTS_DIR, '');

  const seen = new Set();
  return docs.filter(d => { if (seen.has(d)) return false; seen.add(d); return true; }).sort();
}

// ─── Pattern matching ─────────────────────────────────────────────────────────
// Supports trailing * wildcard only (e.g. "joomla_menu*", "global/*", "*").

function matchesPattern(name, pattern) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

// ─── Access checks ────────────────────────────────────────────────────────────

function isDocAllowed(agentDef, docName) {
  if (!agentDef || !agentDef.docs) return true;
  const { allow = ['*'] } = agentDef.docs;
  if (allow.includes('*')) return true;
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * List doc names available to the agent (filtered by docs.allow).
 * Called on every ListTools request so new files appear without a restart.
 */
function listDocs(agentDef) {
  return buildAllDocs().filter(d => isDocAllowed(agentDef, d));
}

/**
 * Read a doc by name.
 * Throws Error with .code === 'PERMISSION_DENIED' or 'NOT_FOUND'.
 */
function readDoc(agentDef, docName) {
  if (!isDocAllowed(agentDef, docName)) {
    const err = new Error(
      `Doc '${docName}' is not available to the ${agentDef?.name || 'current'} agent.`
    );
    err.code = 'PERMISSION_DENIED';
    throw err;
  }

  for (const base of ALLOWED_DOC_DIRS) {
    const candidate = path.resolve(base, `${docName}.md`);
    // Path-traversal guard: relative path must not escape the base dir
    if (path.relative(base, candidate).startsWith('..')) continue;
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
  }

  const err = new Error(`Doc not found: "${docName}"`);
  err.code = 'NOT_FOUND';
  throw err;
}

/**
 * Read the agent's instruction file.
 * The instructions path in the agent definition is relative to config/agents/
 * (the same directory as the agent JSON — keeps scope rules and instruction text together).
 * Falls back to the project-root AGENTS.md when the per-agent file doesn't exist.
 */
function readInstructions(agentDef) {
  if (agentDef && agentDef.instructions) {
    const instrPath = path.resolve(AGENTS_CONFIG_DIR, agentDef.instructions);
    // Path-traversal guard
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

module.exports = { listDocs, readDoc, readInstructions, isToolAllowed, isDocAllowed };
