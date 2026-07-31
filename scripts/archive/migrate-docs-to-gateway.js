#!/usr/bin/env node
'use strict';

/**
 * One-shot migration: docs/workflows/*.md + docs/kb/*.md  ->  Knowledge Gateway /knowledge
 *
 * Each doc becomes one /knowledge row, identified by an exact tag:
 *
 *   doc:<name>        e.g. "doc:kb/staff-grid"   ← the lookup key read_agent_doc uses
 *   agent-doc                                    ← marks the row as a read_agent_doc doc
 *   doc-group:<dir>   e.g. "doc-group:kb"        ← folder grouping
 *
 * Bare tags already in use by the support agent's session start ("workflow",
 * "triage", "editing-rules", "support", "reference", "improvements") are
 * deliberately NOT used here — adding them would pollute those queries.
 *
 * Idempotent: a row whose doc:<name> tag already exists is PATCHed, not duplicated.
 * Every write is read back and compared by SHA256 before it is reported as done.
 *
 * Usage:
 *   node scripts/archive/migrate-docs-to-gateway.js --dry-run
 *   node scripts/archive/migrate-docs-to-gateway.js --only kb/staff-grid
 *   node scripts/archive/migrate-docs-to-gateway.js
 *   node scripts/archive/migrate-docs-to-gateway.js --verify-only
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT      = path.join(__dirname, '..', '..');
const DOCS_DIR  = path.join(ROOT, 'docs');
const MIGRATE_DIRS = ['workflows', 'kb'];

// Dead files — deleted rather than migrated. Their content already lives in the
// gateway under its own tags:
//   editing-rules   -> id 11, tag "editing-rules"
//   freshdesk-agent -> ids 5 / 14 / 15, tags "triage" / "workflow"
//   improvements    -> tag "improvements" (the live queue)
const SKIP = new Set([
  'workflows/editing-rules',
  'workflows/freshdesk-agent',
  'workflows/improvements',
]);

const args       = process.argv.slice(2);
const DRY_RUN    = args.includes('--dry-run');
const VERIFY_ONLY = args.includes('--verify-only');
const ONLY       = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? args[i + 1] : null;
})();

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const env = {
  ...loadEnvFile(path.join(ROOT, '.env')),
  ...loadEnvFile(path.join(ROOT, 'apps', 'knowledge-gateway-mcp', '.env')),
  ...process.env,
};

const BASE_URL = (env.KNOWLEDGE_GATEWAY_BASE_URL || '').replace(/\/+$/, '');
const API_KEY  = env.KNOWLEDGE_GATEWAY_API_KEY || '';

if (!BASE_URL || !API_KEY) {
  console.error('Missing KNOWLEDGE_GATEWAY_BASE_URL or KNOWLEDGE_GATEWAY_API_KEY.');
  process.exit(2);
}

// ── gateway calls ─────────────────────────────────────────────────────────────

async function gw(method, urlPath, body) {
  const res = await fetch(BASE_URL + urlPath, {
    method,
    headers: {
      'X-Api-Key': API_KEY,
      'X-Tool-Name': 'docs-migration',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
  }
  return parsed;
}

/** List endpoints return a bare array; some wrap it in { data }. */
const rows = r => (Array.isArray(r) ? r : (r && r.data) || []);

/** Single-row endpoints return a bare object; unwrap array/{data} forms too. */
function one(r) {
  if (Array.isArray(r)) return r[0];
  if (r && r.data !== undefined) return one(r.data);
  return r;
}

/** Every row currently in the gateway, so we match doc: tags locally (one call). */
async function fetchAllRows() {
  return rows(await gw('GET', '/knowledge'));
}

// ── local docs ────────────────────────────────────────────────────────────────

function collectDocs() {
  const out = [];
  for (const dir of MIGRATE_DIRS) {
    const abs = path.join(DOCS_DIR, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (!f.endsWith('.md')) continue;
      const name = `${dir}/${f.slice(0, -3)}`;
      if (SKIP.has(name)) continue;
      if (ONLY && name !== ONLY) continue;
      const content = fs.readFileSync(path.join(abs, f), 'utf8');
      const heading = /^#\s+(.+)$/m.exec(content);
      out.push({
        name,
        group: dir,
        file: path.join(abs, f),
        content,
        topic: heading ? heading[1].trim() : name,
        sha: sha256(content),
      });
    }
  }
  return out;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

const docTag = name => `doc:${name}`;

// ── main ──────────────────────────────────────────────────────────────────────

(async () => {
  const docs = collectDocs();
  if (!docs.length) {
    console.error(ONLY ? `No local doc matched --only ${ONLY}` : 'No docs found to migrate.');
    process.exit(2);
  }

  const existing = await fetchAllRows();
  const byDocTag = new Map();
  for (const r of existing) {
    for (const t of r.tags || []) {
      if (t.startsWith('doc:')) byDocTag.set(t, r);
    }
  }

  console.log(`Gateway: ${existing.length} rows, ${byDocTag.size} already tagged doc:*`);
  console.log(`Local:   ${docs.length} doc(s) to process${DRY_RUN ? '  [DRY RUN]' : ''}\n`);

  let created = 0, updated = 0, unchanged = 0, failed = 0;

  for (const doc of docs) {
    const tag  = docTag(doc.name);
    const prev = byDocTag.get(tag);
    const tags = ['agent-doc', tag, `doc-group:${doc.group}`];
    const label = `${doc.name} (${doc.content.split('\n').length} lines)`;

    try {
      if (VERIFY_ONLY) {
        if (!prev) { console.log(`  MISSING   ${label}`); failed++; continue; }
        const body = one(await gw('GET', `/knowledge/${prev.id}`));
        const ok = sha256(body.content) === doc.sha;
        console.log(`  ${ok ? 'OK       ' : 'MISMATCH '} ${label}  id=${prev.id}`);
        ok ? unchanged++ : failed++;
        continue;
      }

      if (prev && sha256(prev.content || '') === doc.sha) {
        console.log(`  SAME      ${label}  id=${prev.id}`);
        unchanged++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ${prev ? 'WOULD PATCH' : 'WOULD POST '} ${label}${prev ? `  id=${prev.id}` : ''}`);
        prev ? updated++ : created++;
        continue;
      }

      const payload = { topic: doc.topic, content: doc.content, tags, contentType: 'markdown' };
      const res  = prev
        ? await gw('PATCH', `/knowledge/${prev.id}`, payload)
        : await gw('POST', '/knowledge', payload);
      const row  = one(res);
      const id   = (row && row.id) || (prev && prev.id);

      // Read back and compare bytes — a matching length is not verification.
      const body = one(await gw('GET', `/knowledge/${id}`));
      if (sha256(body.content) !== doc.sha) {
        console.log(`  FAIL      ${label}  id=${id}  content hash mismatch after write`);
        failed++;
        continue;
      }

      console.log(`  ${prev ? 'PATCHED  ' : 'CREATED  '} ${label}  id=${id}  verified`);
      prev ? updated++ : created++;
    } catch (e) {
      console.log(`  ERROR     ${label}  ${e.message}`);
      failed++;
    }
  }

  console.log(`\ncreated=${created} updated=${updated} unchanged=${unchanged} failed=${failed}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
