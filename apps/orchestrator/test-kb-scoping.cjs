'use strict';

// Phase 2.5 acceptance test — doc reorganization + agent scoping.
// Run: node apps/orchestrator/test-kb-scoping.cjs

const fs   = require('fs');
const path = require('path');
const kb   = require('./kb.js');

const AGENTS_DIR = path.join(__dirname, '..', '..', 'config', 'agents');
const loadAgent = name => JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, `${name}.json`), 'utf8'));

const admin       = loadAgent('admin');
const support     = loadAgent('support');
const menuContent = loadAgent('menu-content');

// Every doc name CLAUDE.md / AGENTS.md references (pre-reorg legacy names).
const CLAUDE_MD_DOC_NAMES = [
  'editing-rules', 'freshdesk-agent', 'menu-agent', 'content-agent',
  'custom-page-agent', 'gantry-section-css', 'gantry-particle-map',
  'gantry-visual-qa', 'ftp-css-smoke-test', 'gantry-design-agent', 'improvements',
  'kb/staff-grid', 'kb/staff-pages', 'kb/teacher-pages', 'kb/grid-layout',
  'kb/content-standards', 'kb/css-table-classes', 'kb/site-config',
  'kb/business-directory', 'kb/user-accounts', 'kb/quick-galleries',
  'kb/ministry-platform-widget', 'kb/popup', 'kb/podcasting', 'kb/calendar-feed',
  'kb/elfsight', 'kb/acymail', 'kb/dns-launching', 'kb/redesign-launch',
  'kb/pre-training-audit', 'kb/project-closeout', 'kb/error-pages',
  'kb/animate-on-scroll', 'kb/subpage-backgrounds', 'kb/site-history',
];

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${label} — ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function expectCode(fn, code) {
  try { fn(); } catch (err) {
    assert(err.code === code, `expected ${code}, got ${err.code || err.message}`);
    return;
  }
  throw new Error(`expected ${code}, but call succeeded`);
}

console.log('— legacy names keep resolving —');
for (const name of CLAUDE_MD_DOC_NAMES) {
  check(`admin reads '${name}'`, () => {
    assert(kb.readDoc(admin, name).length > 0, 'empty doc');
  });
}

console.log('— canonical (scoped) names also resolve —');
check(`admin reads 'support/kb/user-accounts'`, () => {
  assert(
    kb.readDoc(admin, 'support/kb/user-accounts') === kb.readDoc(admin, 'kb/user-accounts'),
    'canonical and public reads differ'
  );
});
check(`admin reads 'global/editing-rules'`, () => {
  assert(kb.readDoc(admin, 'global/editing-rules').length > 0, 'empty doc');
});

console.log('— support agent scope —');
check('support reads freshdesk-agent', () => kb.readDoc(support, 'freshdesk-agent'));
check('support reads kb/user-accounts', () => kb.readDoc(support, 'kb/user-accounts'));
check('support reads editing-rules (global)', () => kb.readDoc(support, 'editing-rules'));
check('support DENIED gantry-design-agent', () =>
  expectCode(() => kb.readDoc(support, 'gantry-design-agent'), 'PERMISSION_DENIED'));
check('support DENIED kb/staff-grid (menu-content scope)', () =>
  expectCode(() => kb.readDoc(support, 'kb/staff-grid'), 'PERMISSION_DENIED'));
check('support DENIED kb/dns-launching (launch scope)', () =>
  expectCode(() => kb.readDoc(support, 'kb/dns-launching'), 'PERMISSION_DENIED'));
check('support cannot call gantry_layout_edit', () =>
  assert(!kb.isToolAllowed(support, 'gantry_layout_edit'), 'tool was allowed'));
check('support can call freshdesk_get_ticket', () =>
  assert(kb.isToolAllowed(support, 'freshdesk_get_ticket'), 'tool was denied'));

console.log('— menu-content agent scope —');
check('menu-content reads menu-agent', () => kb.readDoc(menuContent, 'menu-agent'));
check('menu-content reads kb/staff-grid', () => kb.readDoc(menuContent, 'kb/staff-grid'));
check('menu-content DENIED freshdesk-agent', () =>
  expectCode(() => kb.readDoc(menuContent, 'freshdesk-agent'), 'PERMISSION_DENIED'));
check('menu-content DENIED gantry-section-css (design scope)', () =>
  expectCode(() => kb.readDoc(menuContent, 'gantry-section-css'), 'PERMISSION_DENIED'));
check('menu-content can call joomla_article', () =>
  assert(kb.isToolAllowed(menuContent, 'joomla_article'), 'tool was denied'));
check('menu-content cannot call gantry_layout_add', () =>
  assert(!kb.isToolAllowed(menuContent, 'gantry_layout_add'), 'tool was allowed'));

console.log('— listDocs filtering —');
check('admin listDocs covers every CLAUDE.md name', () => {
  const docs = new Set(kb.listDocs(admin));
  const missing = CLAUDE_MD_DOC_NAMES.filter(n => !docs.has(n));
  assert(missing.length === 0, `missing: ${missing.join(', ')}`);
});
check('support listDocs excludes design/launch docs', () => {
  const docs = kb.listDocs(support);
  const leaked = docs.filter(d =>
    ['gantry-design-agent', 'gantry-section-css', 'kb/dns-launching', 'kb/staff-grid'].includes(d));
  assert(leaked.length === 0, `leaked: ${leaked.join(', ')}`);
  assert(docs.includes('freshdesk-agent') && docs.includes('editing-rules'), 'own docs missing');
});
check('unknown doc → NOT_FOUND (not permission error)', () =>
  expectCode(() => kb.readDoc(support, 'no-such-doc'), 'NOT_FOUND'));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
