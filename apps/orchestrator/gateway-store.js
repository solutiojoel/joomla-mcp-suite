'use strict';

/**
 * Knowledge Gateway store — the orchestrator's own HTTP client for the two
 * containers that used to be flat files under docs/.
 *
 *   docs      workflow guides and KB articles, formerly docs/{workflows,kb}/*.md
 *             One /knowledge row per doc, keyed by an exact tag: doc:<name>
 *             e.g. "doc:kb/staff-grid". Rows also carry "agent-doc" and
 *             "doc-group:<folder>".
 *
 *   siteNotes per-site persistent facts, formerly docs/sites/<hostname>.md
 *             One /client-knowledge row per site, keyed by tag host:<hostname>.
 *             The host tag — not siteCode — is the lookup key, so a lookup never
 *             depends on how the short code was derived.
 *
 * Why the gateway and not the filesystem: the docs used to ship inside the
 * deploy, so a doc edit needed a redeploy, and any site note written in
 * production lived on the container disk instead of in the database. One source
 * of truth removes both problems. Bare tags already used by the support agent's
 * session start ("workflow", "triage", "editing-rules") are deliberately not
 * reused here.
 *
 * Reads are cached for CACHE_TTL_MS. A refresh failure falls back to the last
 * good snapshot so a gateway blip cannot empty an agent's doc list; only a cold
 * start with no snapshot surfaces GATEWAY_UNAVAILABLE.
 */

const BASE_URL = () => (process.env.KNOWLEDGE_GATEWAY_BASE_URL || '').replace(/\/+$/, '');
const API_KEY  = () => process.env.KNOWLEDGE_GATEWAY_API_KEY || '';

const CACHE_TTL_MS = 60_000;
const DOC_TAG_PREFIX  = 'doc:';
const HOST_TAG_PREFIX = 'host:';

let logger = null;
/** Optional logger injection so this module stays testable standalone. */
function setLogger(l) { logger = l; }
function warn(msg) { if (logger && logger.warn) logger.warn(msg); else console.error(`[gateway-store] ${msg}`); }

function gatewayError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function gw(method, urlPath, body) {
  const base = BASE_URL();
  const key  = API_KEY();
  if (!base || !key) {
    throw gatewayError(
      'Knowledge Gateway is not configured — set KNOWLEDGE_GATEWAY_BASE_URL and KNOWLEDGE_GATEWAY_API_KEY.',
      'GATEWAY_UNAVAILABLE',
    );
  }

  let res;
  try {
    res = await fetch(base + urlPath, {
      method,
      headers: {
        'X-Api-Key': key,
        'X-Tool-Name': 'orchestrator',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw gatewayError(`Knowledge Gateway request failed: ${e.message}`, 'GATEWAY_UNAVAILABLE');
  }

  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }

  if (!res.ok) {
    const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    throw gatewayError(`Knowledge Gateway ${method} ${urlPath} -> ${res.status}: ${detail}`, 'GATEWAY_ERROR');
  }
  return parsed;
}

/** List endpoints return a bare array; some wrap it in { data }. */
const asRows = r => (Array.isArray(r) ? r : (r && r.data) || []);

/** Single-row endpoints return a bare object; unwrap array/{data} forms too. */
function asRow(r) {
  if (Array.isArray(r)) return r[0];
  if (r && r.data !== undefined) return asRow(r.data);
  return r;
}

const tagsOf = row => (Array.isArray(row && row.tags) ? row.tags : []);

// ─── Docs ─────────────────────────────────────────────────────────────────────

let docCache = { at: 0, index: null };
let docRefresh = null;    // in-flight refetch, shared so concurrent readers issue one request
let docGeneration = 0;    // bumped by invalidateDocs so a slow in-flight fetch cannot
                          // overwrite the cache with rows read before the invalidation

async function fetchDocIndex() {
  const generation = docGeneration;
  const rows = asRows(await gw('GET', '/knowledge'));
  const index = new Map();
  for (const row of rows) {
    for (const tag of tagsOf(row)) {
      if (!tag.startsWith(DOC_TAG_PREFIX)) continue;
      const name = tag.slice(DOC_TAG_PREFIX.length);
      if (index.has(name)) {
        warn(`doc name collision on '${name}': keeping row ${index.get(name).id}, ignoring row ${row.id}`);
        continue;
      }
      index.set(name, row);
    }
  }
  if (generation === docGeneration) docCache = { at: Date.now(), index };
  return index;
}

/**
 * Start (or join) a refresh. Resolves to the cached snapshot when the fetch
 * fails and one exists; rejects only on a cold start with nothing to serve.
 */
function refreshDocIndex() {
  if (!docRefresh) {
    docRefresh = fetchDocIndex()
      .catch(err => {
        if (docCache.index) {
          warn(`doc index refresh failed (${err.message}); serving the cached snapshot.`);
          return docCache.index;
        }
        throw err;
      })
      .finally(() => { docRefresh = null; });
  }
  return docRefresh;
}

/**
 * Map<docName, row> for every /knowledge row carrying a doc:<name> tag.
 *
 * Stale-while-revalidate: an expired snapshot is returned immediately and
 * refreshed in the background. GET /knowledge pulls every row with its full
 * body (~1.8s measured), and this runs inside the ListTools handler — blocking
 * on it put that stall in front of the first tools/list after every TTL lapse.
 * Only a cold start with no snapshot waits for the network.
 */
async function docIndex({ force = false } = {}) {
  if (force || !docCache.index) return refreshDocIndex();
  if (Date.now() - docCache.at >= CACHE_TTL_MS) {
    refreshDocIndex().catch(() => { }); // fire-and-forget; the snapshot below still serves
  }
  return docCache.index;
}

/** Doc names present in the gateway, sorted. */
async function listDocNames(opts) {
  return [...(await docIndex(opts)).keys()].sort();
}

/** Doc body, or null when no row carries that doc:<name> tag. */
async function getDocContent(name, opts) {
  const row = (await docIndex(opts)).get(name);
  return row ? (row.content || '') : null;
}

/** Drop the cached snapshot so the next read refetches. Used by reload_tools. */
function invalidateDocs() {
  docGeneration++;
  docCache = { at: 0, index: null };
}

// ─── Site notes ───────────────────────────────────────────────────────────────

/**
 * Short site code from a hostname, matching the site_code used by agent_audit.
 * Mirrors siteCodeFromHost() in scripts/migrate-site-notes-to-gateway.js.
 */
function siteCodeFromHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h.endsWith('.solutiosoftware.com')) return h.split('.')[0];
  return h.replace(/^www\./, '');
}

/** The /client-knowledge row for a hostname, or null. Never cached — notes are written mid-session. */
async function getSiteNotesRow(hostname) {
  const tag  = HOST_TAG_PREFIX + hostname;
  const rows = asRows(await gw('GET', `/client-knowledge?tag=${encodeURIComponent(tag)}`));
  // Filter locally too: a server-side tag filter that is ignored would otherwise
  // return every site's notes and we would hand back the wrong site's facts.
  const matches = rows.filter(r => tagsOf(r).includes(tag));
  if (matches.length > 1) warn(`${matches.length} site-notes rows carry ${tag}; using the lowest id.`);
  return matches.sort((a, b) => a.id - b.id)[0] || null;
}

/** Create or replace a site's notes row. Returns { id, created }. */
async function writeSiteNotes(hostname, content) {
  const existing = await getSiteNotesRow(hostname);
  const payload  = {
    siteCode: siteCodeFromHost(hostname),
    topic: 'Site Notes',
    content,
    tags: ['site-notes', HOST_TAG_PREFIX + hostname],
    contentType: 'markdown',
  };
  const res = existing
    ? await gw('PATCH', `/client-knowledge/${existing.id}`, payload)
    : await gw('POST', '/client-knowledge', payload);
  const row = asRow(res);
  return { id: (row && row.id) || (existing && existing.id), created: !existing };
}

module.exports = {
  setLogger,
  // docs
  docIndex,
  listDocNames,
  getDocContent,
  invalidateDocs,
  // site notes
  siteCodeFromHost,
  getSiteNotesRow,
  writeSiteNotes,
  // exposed for tests
  _internal: { asRows, asRow, DOC_TAG_PREFIX, HOST_TAG_PREFIX },
};
