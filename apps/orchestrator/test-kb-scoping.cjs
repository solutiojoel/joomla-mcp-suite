'use strict';

// Doc-scope acceptance test — readDoc / listDocs against the gateway-hosted docs
// and the live agent definitions. Needs KNOWLEDGE_GATEWAY_BASE_URL and
// KNOWLEDGE_GATEWAY_API_KEY (loaded from the repo-root .env below).
// Tool-scope (resolveToolAccess) lives in test-scope-enforcement.cjs.
// Run: node apps/orchestrator/test-kb-scoping.cjs

require('@solutio/env').loadEnv({ from: __dirname, label: 'test-kb-scoping' });

const fs   = require('fs');
const path = require('path');
const kb   = require('./kb.js');

const AGENTS_DIR = path.join(__dirname, '..', '..', 'config', 'agents');

// Agents live in subfolders (config/agents/<name>/<name>.json); fall back to a
// flat path for any legacy definition.
function loadAgent(name) {
  let p = path.join(AGENTS_DIR, name, `${name}.json`);
  if (!fs.existsSync(p)) p = path.join(AGENTS_DIR, `${name}.json`);
  const def = JSON.parse(fs.readFileSync(p, 'utf8'));
  def._dir = path.dirname(p);
  return def;
}

const superShannon = loadAgent('super_shannon'); // docs.allow: ["*"]
const support      = loadAgent('support');       // docs.allow: ["workflows/*", "kb/*"]
const menuBuild    = loadAgent('menu-build');    // docs.allow: explicit list

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok  ${label}`); }
  catch (err) { failures++; console.error(`FAIL  ${label} — ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function expectCode(fn, code) {
  try { await fn(); } catch (err) {
    assert(err.code === code, `expected ${code}, got ${err.code || err.message}`);
    return;
  }
  throw new Error(`expected ${code}, but call succeeded`);
}

(async () => {
  console.log('— super_shannon (docs.allow: *) reads everything —');
  for (const name of ['workflows/menu-build-workflow', 'workflows/gantry-visual-qa', 'kb/user-accounts', 'kb/dns-launching']) {
    await check(`super_shannon reads '${name}'`, async () =>
      assert((await kb.readDoc(superShannon, name)).length > 0, 'empty doc'));
  }

  console.log('— support (docs.allow: workflows/*, kb/*) —');
  await check('support reads workflows/content-agent', () => kb.readDoc(support, 'workflows/content-agent'));
  await check('support reads kb/user-accounts',        () => kb.readDoc(support, 'kb/user-accounts'));
  await check('support reads kb/site-history',         () => kb.readDoc(support, 'kb/site-history'));

  console.log('— menu-build (docs.allow: explicit list) —');
  await check('menu-build reads workflows/menu-build-workflow', () => kb.readDoc(menuBuild, 'workflows/menu-build-workflow'));
  await check('menu-build reads kb/staff-grid',                 () => kb.readDoc(menuBuild, 'kb/staff-grid'));
  await check('menu-build reads kb/menu-spec-schema',           () => kb.readDoc(menuBuild, 'kb/menu-spec-schema'));
  await check('menu-build DENIED workflows/gantry-section-css', () =>
    expectCode(() => kb.readDoc(menuBuild, 'workflows/gantry-section-css'), 'PERMISSION_DENIED'));
  await check('menu-build DENIED workflows/gantry-visual-qa', () =>
    expectCode(() => kb.readDoc(menuBuild, 'workflows/gantry-visual-qa'), 'PERMISSION_DENIED'));
  await check('menu-build DENIED kb/dns-launching', () =>
    expectCode(() => kb.readDoc(menuBuild, 'kb/dns-launching'), 'PERMISSION_DENIED'));
  await check('menu-build DENIED kb/user-accounts', () =>
    expectCode(() => kb.readDoc(menuBuild, 'kb/user-accounts'), 'PERMISSION_DENIED'));

  console.log('— listDocs filtering —');
  await check('super_shannon listDocs includes workflows + kb docs', async () => {
    const docs = new Set(await kb.listDocs(superShannon));
    assert(docs.has('workflows/menu-build-workflow') && docs.has('kb/user-accounts'), 'expected docs missing');
  });
  await check('menu-build listDocs is exactly its allow list', async () => {
    const docs = await kb.listDocs(menuBuild);
    const leaked = docs.filter(d => ['workflows/gantry-section-css', 'workflows/gantry-visual-qa', 'kb/dns-launching', 'kb/user-accounts'].includes(d));
    assert(leaked.length === 0, `leaked: ${leaked.join(', ')}`);
    assert(docs.includes('workflows/menu-build-workflow') && docs.includes('kb/staff-grid'), 'own docs missing');
  });

  console.log('— retired docs are gone, not silently served —');
  for (const dead of ['workflows/editing-rules', 'workflows/freshdesk-agent', 'workflows/improvements']) {
    await check(`'${dead}' → NOT_FOUND`, () =>
      expectCode(() => kb.readDoc(superShannon, dead), 'NOT_FOUND'));
  }

  console.log('— error codes —');
  await check('unknown doc → NOT_FOUND (not permission error)', () =>
    expectCode(() => kb.readDoc(support, 'no-such-doc'), 'NOT_FOUND'));

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
