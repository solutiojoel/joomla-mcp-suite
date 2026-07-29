#!/usr/bin/env node
'use strict';

/**
 * One-shot migration: docs/sites/<hostname>.md  ->  Knowledge Gateway /client-knowledge
 *
 * Each site's notes become one /client-knowledge row:
 *
 *   siteCode  short code (first hostname label for *.solutiosoftware.com,
 *             otherwise the hostname minus a leading "www.") — matches the
 *             site_code used by agent_audit
 *   topic     "Site Notes"
 *   tags      ["site-notes", "host:<hostname>"]
 *             host:<hostname> is the exact lookup key get_site_notes uses, so the
 *             lookup never depends on how the short code was derived.
 *
 * Empty stub files (a header and no facts) are skipped — they carry no content,
 * and get_site_notes returns its own "no notes yet" message when no row exists.
 *
 * Idempotent: a row whose host:<hostname> tag already exists is PATCHed.
 * Every write is read back and compared by SHA256.
 *
 * Usage:
 *   node scripts/migrate-site-notes-to-gateway.js --dry-run
 *   node scripts/migrate-site-notes-to-gateway.js
 *   node scripts/migrate-site-notes-to-gateway.js --verify-only
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const ROOT      = path.join(__dirname, '..');
const SITES_DIR = path.join(ROOT, 'docs', 'sites');

const args        = process.argv.slice(2);
const DRY_RUN     = args.includes('--dry-run');
const VERIFY_ONLY = args.includes('--verify-only');

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

async function gw(method, urlPath, body) {
  const res = await fetch(BASE_URL + urlPath, {
    method,
    headers: {
      'X-Api-Key': API_KEY,
      'X-Tool-Name': 'site-notes-migration',
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

const rows = r => (Array.isArray(r) ? r : (r && r.data) || []);
function one(r) {
  if (Array.isArray(r)) return r[0];
  if (r && r.data !== undefined) return one(r.data);
  return r;
}
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/** Short site code from a hostname. Mirrors siteCodeFromHost() in the orchestrator. */
function siteCodeFromHost(hostname) {
  const h = hostname.toLowerCase();
  if (h.endsWith('.solutiosoftware.com')) return h.split('.')[0];
  return h.replace(/^www\./, '');
}

/**
 * A stub file carries no facts: every non-blank line is a heading, a blockquote,
 * the "Notes logged by AI agents." placeholder, or a "(none recorded yet)" marker.
 */
function isStub(content) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.every(l =>
    l.startsWith('#') ||
    l.startsWith('>') ||
    l === '---' ||
    /^notes logged by ai agents\b/i.test(l) ||
    /^[-*]?\s*\*?\(?(none|nothing)\b/i.test(l)
  );
}

function collectSites() {
  const out = [];
  if (!fs.existsSync(SITES_DIR)) return out;
  for (const f of fs.readdirSync(SITES_DIR).sort()) {
    if (!f.endsWith('.md')) continue;
    const hostname = f.slice(0, -3);
    const content  = fs.readFileSync(path.join(SITES_DIR, f), 'utf8');
    out.push({
      hostname,
      siteCode: siteCodeFromHost(hostname),
      content,
      sha: sha256(content),
      stub: isStub(content),
      lines: content.split('\n').length,
    });
  }
  return out;
}

(async () => {
  const sites = collectSites();
  const real  = sites.filter(s => !s.stub);
  const stubs = sites.filter(s => s.stub);

  const existing = rows(await gw('GET', '/client-knowledge'));
  const byHostTag = new Map();
  for (const r of existing) {
    for (const t of r.tags || []) if (t.startsWith('host:')) byHostTag.set(t, r);
  }

  console.log(`Local:   ${sites.length} site file(s) — ${real.length} with facts, ${stubs.length} empty stub(s)`);
  console.log(`Gateway: ${existing.length} client-knowledge row(s), ${byHostTag.size} tagged host:*`);
  console.log(`Skipping stubs: ${stubs.map(s => s.siteCode).join(', ') || '(none)'}\n`);

  let created = 0, updated = 0, unchanged = 0, failed = 0;

  for (const site of real) {
    const tag   = `host:${site.hostname}`;
    const prev  = byHostTag.get(tag);
    const label = `${site.siteCode} (${site.lines} lines)`;
    const tags  = ['site-notes', tag];

    try {
      if (VERIFY_ONLY) {
        if (!prev) { console.log(`  MISSING   ${label}`); failed++; continue; }
        const body = one(await gw('GET', `/client-knowledge/${prev.id}`));
        const ok = sha256(body.content) === site.sha;
        console.log(`  ${ok ? 'OK       ' : 'MISMATCH '} ${label}  id=${prev.id}`);
        ok ? unchanged++ : failed++;
        continue;
      }

      if (prev && sha256(prev.content || '') === site.sha) {
        console.log(`  SAME      ${label}  id=${prev.id}`);
        unchanged++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ${prev ? 'WOULD PATCH' : 'WOULD POST '} ${label}  siteCode=${site.siteCode}  tag=${tag}`);
        prev ? updated++ : created++;
        continue;
      }

      const payload = {
        siteCode: site.siteCode,
        topic: 'Site Notes',
        content: site.content,
        tags,
        contentType: 'markdown',
      };
      const res = prev
        ? await gw('PATCH', `/client-knowledge/${prev.id}`, payload)
        : await gw('POST', '/client-knowledge', payload);
      const id = (one(res) && one(res).id) || (prev && prev.id);

      const body = one(await gw('GET', `/client-knowledge/${id}`));
      if (sha256(body.content) !== site.sha) {
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
