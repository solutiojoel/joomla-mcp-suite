'use strict';

/**
 * MCP Client wrapper — connects to the Joomla orchestrator via StreamableHTTP.
 *
 * Maintains a single persistent connection. Callers use:
 *   callTool(name, args)  → Promise<{ content, isError }>
 *   listTools()           → Promise<Tool[]>
 *   getClient()           → the raw SDK Client (for advanced use)
 */

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://127.0.0.1:9302/mcp';

let _client = null;
let _toolCache = null;
let _connecting = null;

async function connect() {
  if (_client) return _client;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    const client = new Client(
      { name: 'joomla-dashboard', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    const transport = new StreamableHTTPClientTransport(new URL(ORCHESTRATOR_URL));
    await client.connect(transport);
    _client = client;
    _connecting = null;
    console.log(`[mcp-client] Connected to orchestrator at ${ORCHESTRATOR_URL}`);
    return client;
  })();

  return _connecting;
}

async function listTools() {
  if (_toolCache) return _toolCache;
  const client = await connect();
  const result = await client.listTools();
  _toolCache = result.tools || [];
  return _toolCache;
}

function invalidateToolCache() {
  _toolCache = null;
}

async function callTool(name, args = {}) {
  const client = await connect();
  try {
    const result = await client.callTool({ name, arguments: args });
    return {
      content: result.content,
      isError: result.isError || false,
      text: extractText(result.content),
    };
  } catch (err) {
    // On transport error, reset and let the caller retry
    _client = null;
    _toolCache = null;
    throw err;
  }
}

function extractText(content) {
  if (!Array.isArray(content)) return String(content || '');
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');
}

function getClient() {
  return _client;
}

module.exports = { connect, listTools, callTool, invalidateToolCache, getClient };
