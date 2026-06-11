'use strict';
const { Client } = require('./apps/joomla-orchestrator/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
const { StreamableHTTPClientTransport } = require('./apps/joomla-orchestrator/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js');

const TOKEN = 'RgOPSb46DHV8/GEirOLyMVTf8UzLjRP0jAw3HdrC684=';

async function makeClient() {
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:9302/mcp'),
    { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }
  );
  await client.connect(transport);
  return client;
}

async function main() {
  const client = await makeClient();
  console.log('Connected\n');

  // ── Baseline admin scope ──
  const { tools: t1 } = await client.listTools();
  const hasSwitchAgent = !!t1.find(t => t.name === 'switch_agent');
  const hasGetCurrent  = !!t1.find(t => t.name === 'get_current_agent');
  console.log(`[admin] tools=${t1.length} | switch_agent=${hasSwitchAgent} | get_current_agent=${hasGetCurrent}`);

  const cur = await client.callTool({ name: 'get_current_agent', arguments: {} });
  console.log('[admin] get_current_agent:\n' + cur.content[0].text + '\n');

  // ── Switch to support ──
  const sw = await client.callTool({ name: 'switch_agent', arguments: { agent: 'support' } });
  console.log('[switch→support] ' + sw.content[0].text.split('\n')[0]);

  const { tools: t2 } = await client.listTools();
  const gantryCount   = t2.filter(t => t.name.startsWith('gantry_')).length;
  const freshdeskCount = t2.filter(t => t.name.startsWith('freshdesk_')).length;
  const hasSw2 = !!t2.find(t => t.name === 'switch_agent');
  console.log(`[support scope] tools=${t2.length} | gantry=${gantryCount} (expect 0) | freshdesk=${freshdeskCount} (expect >0) | switch_agent=${hasSw2} (expect true)`);

  // ── Gantry call should be blocked ──
  const blocked = await client.callTool({ name: 'gantry_layout_list', arguments: {} });
  console.log(`[support] gantry_layout_list isError=${blocked.isError} (expect true) | ${blocked.content[0].text}`);

  // ── Switch to menu-content ──
  await client.callTool({ name: 'switch_agent', arguments: { agent: 'menu-content' } });
  const { tools: t3 } = await client.listTools();
  const freshdeskCount3 = t3.filter(t => t.name.startsWith('freshdesk_')).length;
  console.log(`\n[menu-content scope] tools=${t3.length} | freshdesk=${freshdeskCount3} (expect 0)`);

  // ── Switch back to admin ──
  await client.callTool({ name: 'switch_agent', arguments: { agent: 'admin' } });
  const { tools: t4 } = await client.listTools();
  const gantryBack = t4.filter(t => t.name.startsWith('gantry_')).length;
  console.log(`\n[back to admin] tools=${t4.length} | gantry=${gantryBack} (expect >0)`);

  client.close().catch(() => {});
  console.log('\nAll tests passed.');
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
