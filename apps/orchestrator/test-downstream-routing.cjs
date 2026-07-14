'use strict';

// Phase 3 acceptance test — four-server registry routing through the orchestrator.
// Requires a running orchestrator wired to live joomla-mcp, gantry-mcp,
// freshdesk-mcp, and ftp-mcp instances.
//
// Run: node apps/orchestrator/test-downstream-routing.cjs [orchestratorUrl] [siteUrl]
//   orchestratorUrl defaults to http://127.0.0.1:9302/mcp (override for a test instance)
//   siteUrl defaults to https://shannon.forge.solutiosoftware.com

const fs   = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ORCH_URL = process.argv[2] || 'http://127.0.0.1:9302/mcp';
const SITE_URL = process.argv[3] || 'https://shannon.forge.solutiosoftware.com';

// The test exercises tools across all four downstreams, so it needs a token
// whose agent has unrestricted scope. super_shannon (allow: ["*"]) is that agent.
// config/users.json stores sha256 digests, not plaintext tokens, so the token
// must be supplied via ORCHESTRATOR_TEST_TOKEN (any leftover plaintext
// super_shannon key in users.json still works as a fallback).
function privilegedToken() {
  if (process.env.ORCHESTRATOR_TEST_TOKEN) return process.env.ORCHESTRATOR_TEST_TOKEN;
  const usersPath = path.join(__dirname, '..', '..', 'config', 'users.json');
  const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
  const entry = Object.entries(users).find(
    ([k, v]) => v.agent === 'super_shannon' && !k.startsWith('sha256:')
  );
  if (!entry) {
    throw new Error(
      'set ORCHESTRATOR_TEST_TOKEN to a super_shannon bearer token (users.json keys are hashed)'
    );
  }
  return entry[0];
}

let failures = 0;
function report(label, ok, detail) {
  if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

function text(result) {
  return result?.content?.[0]?.text || '';
}

function parsed(result) {
  try { return JSON.parse(text(result)); } catch { return null; }
}

(async () => {
  const client = new Client({ name: 'routing-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(ORCH_URL), {
    requestInit: { headers: { Authorization: `Bearer ${privilegedToken()}` } },
  }));
  console.log(`connected to ${ORCH_URL}`);

  // ── ListTools: all four servers represented, no duplicates ──
  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  report('no duplicate tool names', dupes.length === 0, dupes.length ? `dupes: ${[...new Set(dupes)].join(', ')}` : `${names.length} tools`);
  for (const expected of ['freshdesk_get_ticket', 'ftp_site_config', 'joomla_article', 'gantry_outlines_list', 'gantry_css_asset_smoke_test', 'knowledge_universal']) {
    report(`tool listed: ${expected}`, names.includes(expected));
  }

  // ── freshdesk-mcp: no active site required ──
  const fd = await client.callTool({ name: 'freshdesk_list_tickets', arguments: { status: 'open' } });
  const fdParsed = parsed(fd);
  report('freshdesk_list_tickets (no active site)', !!fdParsed && fdParsed.success === true,
    fdParsed ? `${fdParsed.itemCount ?? '?'} open tickets` : text(fd).slice(0, 120));

  // ── knowledge-gateway-mcp: no active site required ──
  const kg = await client.callTool({ name: 'knowledge_universal', arguments: { action: 'list' } });
  const kgParsed = parsed(kg);
  report('knowledge_universal list (no active site)', !!kgParsed && kgParsed.success === true,
    kgParsed ? `${kgParsed.itemCount ?? '?'} entries` : text(kg).slice(0, 120));

  // ── site-scoped tool without active site → guard error ──
  const guard = await client.callTool({ name: 'ftp_site_config', arguments: {} });
  report('ftp_site_config without site is rejected', /No active site/i.test(text(guard)), text(guard).slice(0, 80));

  // ── set_active_site (auto joomla_login through joomla-mcp) ──
  const sas = await client.callTool({ name: 'set_active_site', arguments: { url: SITE_URL } });
  report('set_active_site', /Active site set to/.test(text(sas)), text(sas).split('\n')[0]);

  // ── ftp-mcp: site_url injection → domain resolution ──
  const ftpConf = await client.callTool({ name: 'ftp_site_config', arguments: {} });
  const ftpParsed = parsed(ftpConf);
  report('ftp_site_config via active site', !!ftpParsed && ftpParsed.success === true,
    ftpParsed?.data?.host ? `host: ${ftpParsed.data.host}` : text(ftpConf).slice(0, 120));

  // ── joomla-mcp: site_url injection ──
  const art = await client.callTool({ name: 'joomla_article', arguments: { action: 'list', limit: 1 } });
  const artParsed = parsed(art);
  report('joomla_article list via joomla-mcp', !!artParsed && artParsed.success === true,
    artParsed ? artParsed.message : text(art).slice(0, 120));

  // ── gantry-mcp: site injection ──
  const out = await client.callTool({ name: 'gantry_outlines_list', arguments: {} });
  const outText = text(out);
  report('gantry_outlines_list via gantry-mcp', !out.isError && outText.length > 0,
    out.isError ? outText.slice(0, 120) : `${outText.length} bytes`);

  await client.close().catch(() => {});
  console.log(failures === 0 ? '\nAll routing checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
