'use strict';

// Tool-scope enforcement test — exercises kb.resolveToolAccess, the single
// precedence helper backing the orchestrator's ListTools and CallTool handlers.
// Uses the live agent definitions, the live config/tool-policy.json globalDeny,
// and the shared MANDATORY_OWN_TOOLS / HIDDEN_JOOMLA_TOOLS sets — so this asserts
// the real enforcement path, not a copy of it.
// Run: node apps/orchestrator/test-scope-enforcement.cjs

const fs   = require('fs');
const path = require('path');
const kb   = require('./kb.js');

const ROOT       = path.join(__dirname, '..', '..');
const AGENTS_DIR = path.join(ROOT, 'config', 'agents');

function loadAgent(name) {
  let p = path.join(AGENTS_DIR, name, `${name}.json`);
  if (!fs.existsSync(p)) p = path.join(AGENTS_DIR, `${name}.json`);
  const def = JSON.parse(fs.readFileSync(p, 'utf8'));
  def._dir = path.dirname(p);
  return def;
}

function loadGlobalDeny() {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'tool-policy.json'), 'utf8'));
    return Array.isArray(policy.globalDeny) ? policy.globalDeny : [];
  } catch { return []; }
}

const superShannon = loadAgent('super_shannon'); // tools.allow: ["*"]
const support      = loadAgent('support');
const menuBuild    = loadAgent('menu-build');

const globalDeny = loadGlobalDeny();
const OPTS = { globalDeny, mandatory: kb.MANDATORY_OWN_TOOLS, hidden: kb.HIDDEN_JOOMLA_TOOLS };

let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (err) { failures++; console.error(`FAIL  ${label} — ${err.message}`); }
}
// Assert resolveToolAccess(agent, tool) === { allowed, code }.
function expectAccess(agentDef, agentName, tool, allowed, code) {
  const res = kb.resolveToolAccess(agentDef, tool, OPTS);
  if (res.allowed !== allowed) {
    throw new Error(`${agentName} '${tool}': expected allowed=${allowed}, got ${res.allowed} (code=${res.code})`);
  }
  if (code !== undefined && res.code !== code) {
    throw new Error(`${agentName} '${tool}': expected code=${code}, got ${res.code}`);
  }
}

// Sanity: the policy fixtures this test relies on are present.
console.log('— preconditions —');
check("globalDeny contains 'joomla_get_frontend_page'", () => {
  if (!globalDeny.includes('joomla_get_frontend_page')) throw new Error(`globalDeny = ${JSON.stringify(globalDeny)}`);
});
check("HIDDEN contains 'joomla_login', MANDATORY contains 'get_current_agent', switch_agent NOT mandatory", () => {
  if (!kb.HIDDEN_JOOMLA_TOOLS.has('joomla_login'))     throw new Error('joomla_login not hidden');
  if (!kb.MANDATORY_OWN_TOOLS.has('get_current_agent')) throw new Error('get_current_agent not mandatory');
  if (kb.MANDATORY_OWN_TOOLS.has('switch_agent'))       throw new Error('switch_agent should NOT be mandatory — it must be scope-controlled');
});

console.log('— precedence 1: hidden beats everything —');
// joomla_login is hidden for every agent, even super_shannon (allow: *).
check('super_shannon DENIED joomla_login (hidden)', () => expectAccess(superShannon, 'super_shannon', 'joomla_login', false, 'hidden'));
check('support DENIED joomla_login (hidden)',        () => expectAccess(support, 'support', 'joomla_login', false, 'hidden'));

console.log('— precedence 2: mandatory bypasses scope —');
// These are NOT in support/menu-build allow-lists but must always pass.
check('support ALLOWED gantry_reconnect (mandatory)',    () => expectAccess(support,   'support',    'gantry_reconnect',  true,  null));
check('support ALLOWED get_current_agent (mandatory)',   () => expectAccess(support,   'support',    'get_current_agent', true,  null));
check('menu-build ALLOWED gantry_reconnect (mandatory)', () => expectAccess(menuBuild, 'menu-build', 'gantry_reconnect',  true,  null));

console.log('— precedence 3: global deny beats agent allow —');
// support allows joomla_get_frontend_* and menu-build too, but globalDeny wins.
check('super_shannon DENIED joomla_get_frontend_page (global)', () => expectAccess(superShannon, 'super_shannon', 'joomla_get_frontend_page', false, 'global_deny'));
check('support DENIED joomla_get_frontend_page (global, despite allow joomla_get_frontend_*)', () => expectAccess(support, 'support', 'joomla_get_frontend_page', false, 'global_deny'));
check('menu-build DENIED joomla_get_frontend_page (global)', () => expectAccess(menuBuild, 'menu-build', 'joomla_get_frontend_page', false, 'global_deny'));

console.log('— precedence 4: per-agent scope —');
// support: the headline invariant — a support session cannot reach admin/design tools.
check('support ALLOWED joomla_user (joomla_user* in allow)', () => expectAccess(support, 'support', 'joomla_user', true, null));
check('support DENIED joomla_workspace_write (deny)', () => expectAccess(support, 'support', 'joomla_workspace_write', false, 'scope'));
check('support DENIED gantry_layout_edit (scope)',    () => expectAccess(support, 'support', 'gantry_layout_edit', false, 'scope'));
check('support DENIED joomla_submit_admin_form (deny)', () => expectAccess(support, 'support', 'joomla_submit_admin_form', false, 'scope'));
check('support ALLOWED joomla_article',     () => expectAccess(support, 'support', 'joomla_article', true, null));
check('support ALLOWED joomla_menu_item (joomla_menu* wildcard)', () => expectAccess(support, 'support', 'joomla_menu_item', true, null));
check('support ALLOWED freshdesk_get_ticket (freshdesk_* wildcard)', () => expectAccess(support, 'support', 'freshdesk_get_ticket', true, null));

// menu-build: can write workspace + run the sub-agent; cannot touch users/admin/design.
check('menu-build ALLOWED joomla_workspace_write',     () => expectAccess(menuBuild, 'menu-build', 'joomla_workspace_write', true, null));
check('menu-build ALLOWED run_menu_interpretation',    () => expectAccess(menuBuild, 'menu-build', 'run_menu_interpretation', true, null));
check('menu-build ALLOWED run_menu_build',             () => expectAccess(menuBuild, 'menu-build', 'run_menu_build', true, null));
check('menu-build ALLOWED joomla_docman_category (joomla_docman_* wildcard)', () => expectAccess(menuBuild, 'menu-build', 'joomla_docman_category', true, null));
check('menu-build DENIED joomla_user (deny)',          () => expectAccess(menuBuild, 'menu-build', 'joomla_user', false, 'scope'));
check('menu-build DENIED gantry_layout_add (scope)',   () => expectAccess(menuBuild, 'menu-build', 'gantry_layout_add', false, 'scope'));
check('menu-build DENIED freshdesk_get_ticket (scope)', () => expectAccess(menuBuild, 'menu-build', 'freshdesk_get_ticket', false, 'scope'));

console.log('— switch_agent scope enforcement —');
// switch_agent is no longer mandatory — restricted agents must be blocked from re-switching.
check('support DENIED switch_agent (scope)',        () => expectAccess(support,      'support',       'switch_agent', false, 'scope'));
check('menu-build DENIED switch_agent (scope)',     () => expectAccess(menuBuild,    'menu-build',    'switch_agent', false, 'scope'));
check('super_shannon ALLOWED switch_agent (allow *)', () => expectAccess(superShannon, 'super_shannon', 'switch_agent', true,  null));

console.log('— super_shannon (allow: *) reaches scoped tools —');
check('super_shannon ALLOWED gantry_layout_edit', () => expectAccess(superShannon, 'super_shannon', 'gantry_layout_edit', true, null));
check('super_shannon ALLOWED joomla_user',        () => expectAccess(superShannon, 'super_shannon', 'joomla_user', true, null));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
