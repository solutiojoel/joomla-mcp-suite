'use strict';

// Doc-scope acceptance test — readDoc / listDocs against the current
// docs/{workflows,kb}/ layout and the live agent definitions.
// Tool-scope (resolveToolAccess) lives in test-scope-enforcement.cjs.
// Run: node apps/orchestrator/test-kb-scoping.cjs

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
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (err) { failures++; console.error(`FAIL  ${label} — ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function expectCode(fn, code) {
  try { fn(); } catch (err) {
    assert(err.code === code, `expected ${code}, got ${err.code || err.message}`);
    return;
  }
  throw new Error(`expected ${code}, but call succeeded`);
}

console.log('— super_shannon (docs.allow: *) reads everything —');
for (const name of ['workflows/editing-rules', 'workflows/freshdesk-agent', 'kb/user-accounts', 'kb/dns-launching']) {
  check(`super_shannon reads '${name}'`, () =>
    assert(kb.readDoc(superShannon, name).length > 0, 'empty doc'));
}

console.log('— support (docs.allow: workflows/*, kb/*) —');
check('support reads workflows/freshdesk-agent', () => kb.readDoc(support, 'workflows/freshdesk-agent'));
check('support reads kb/user-accounts',          () => kb.readDoc(support, 'kb/user-accounts'));
check('support reads workflows/editing-rules',   () => kb.readDoc(support, 'workflows/editing-rules'));

console.log('— menu-build (docs.allow: explicit list) —');
check('menu-build reads workflows/menu-build-workflow', () => kb.readDoc(menuBuild, 'workflows/menu-build-workflow'));
check('menu-build reads kb/staff-grid',                 () => kb.readDoc(menuBuild, 'kb/staff-grid'));
check('menu-build reads kb/menu-spec-schema',           () => kb.readDoc(menuBuild, 'kb/menu-spec-schema'));
check('menu-build DENIED workflows/freshdesk-agent', () =>
  expectCode(() => kb.readDoc(menuBuild, 'workflows/freshdesk-agent'), 'PERMISSION_DENIED'));
check('menu-build DENIED workflows/gantry-section-css', () =>
  expectCode(() => kb.readDoc(menuBuild, 'workflows/gantry-section-css'), 'PERMISSION_DENIED'));
check('menu-build DENIED kb/dns-launching', () =>
  expectCode(() => kb.readDoc(menuBuild, 'kb/dns-launching'), 'PERMISSION_DENIED'));
check('menu-build DENIED kb/user-accounts', () =>
  expectCode(() => kb.readDoc(menuBuild, 'kb/user-accounts'), 'PERMISSION_DENIED'));

console.log('— listDocs filtering —');
check('super_shannon listDocs includes workflows + kb docs', () => {
  const docs = new Set(kb.listDocs(superShannon));
  assert(docs.has('workflows/freshdesk-agent') && docs.has('kb/user-accounts'), 'expected docs missing');
});
check('menu-build listDocs is exactly its allow list', () => {
  const docs = kb.listDocs(menuBuild);
  const leaked = docs.filter(d => ['workflows/freshdesk-agent', 'workflows/gantry-section-css', 'kb/dns-launching', 'kb/user-accounts'].includes(d));
  assert(leaked.length === 0, `leaked: ${leaked.join(', ')}`);
  assert(docs.includes('workflows/menu-build-workflow') && docs.includes('kb/staff-grid'), 'own docs missing');
});

console.log('— error codes —');
check('unknown doc → NOT_FOUND (not permission error)', () =>
  expectCode(() => kb.readDoc(support, 'no-such-doc'), 'NOT_FOUND'));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
