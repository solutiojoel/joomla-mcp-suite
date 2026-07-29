// Regression test: the orchestrator's tool list is not static — switch_agent
// changes the agent scope and reload_tools re-reads the downstream registry.
// Both must tell the client to re-fetch, or the client keeps the catalog it
// pulled at session start and advertises tools the current scope cannot call.
//
// That was a real bug: capabilities.tools.listChanged was never declared, so
// reload_tools' notification was silently dropped by spec-compliant clients and
// switch_agent sent none at all.
//
// Note: downstream servers (ftp-mcp, joomla-mcp, gantry-mcp) are unreachable in
// a bare local checkout — they need *_URL entries in apps/orchestrator/.env — so
// this exercises own-tool scope filtering only. The notification plumbing it
// verifies is shared by both paths.

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { ToolListChangedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');
const { buildServer } = require('./orchestrator.js');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${label}\n       ${err.message}`);
  }
}

(async () => {
  const server = buildServer({ user: 'test', agent: 'super_shannon' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });

  let notifications = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notifications++; });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const settle = () => new Promise(r => setTimeout(r, 200));

  console.log('— capability negotiation —');
  const caps = client.getServerCapabilities().tools;
  check('server advertises tools.listChanged', () => {
    if (!caps || caps.listChanged !== true) {
      throw new Error(`expected { listChanged: true }, got ${JSON.stringify(caps)}`);
    }
  });

  console.log('— reload_tools —');
  await client.callTool({ name: 'reload_tools', arguments: {} });
  await settle();
  const afterReload = notifications;
  check('reload_tools sends tools/list_changed', () => {
    if (afterReload < 1) throw new Error('no notification received');
  });

  console.log('— switch_agent —');
  const before = (await client.listTools()).tools.map(t => t.name);
  await client.callTool({ name: 'switch_agent', arguments: { agent: 'support' } });
  await settle();
  check('switch_agent sends tools/list_changed', () => {
    if (notifications <= afterReload) throw new Error('no notification received');
  });

  const after = (await client.listTools()).tools.map(t => t.name);
  check('re-fetched list is actually scope-filtered', () => {
    if (after.length >= before.length) {
      throw new Error(`support should expose fewer tools than super_shannon (${before.length} -> ${after.length})`);
    }
  });
  check('tools dropped by the switch are gone from the re-fetch', () => {
    const dropped = before.filter(n => !after.includes(n));
    if (dropped.length === 0) throw new Error('no tools were dropped — scope filtering did not apply');
    console.log(`       dropped for 'support': ${dropped.join(', ')}`);
  });

  await client.close();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => {
  console.error('ERROR', err.message);
  process.exit(1);
});
