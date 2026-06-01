#!/usr/bin/env node
/**
 * cdp-inspector — MCP server
 *
 * Transport modes (set MCP_TRANSPORT in .env):
 *
 *   stdio  (default) — classic Claude Code local usage via stdin/stdout.
 *                      Bridge server still starts on BRIDGE_PORT for the extension.
 *
 *   http             — Streamable HTTP transport, accessible over the network.
 *                      Bridge + MCP both served from a single Express app on MCP_PORT.
 *                      Use this for Docker / Tailscale.
 *
 * CORS is always applied so browser-origin UIs (e.g. localhost:8090) can reach
 * the server across origins. Set CORS_ORIGIN to restrict (default: '*').
 */

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { browserManager } from './lib/browser.js';
import { inspector } from './lib/inspector.js';
import { ftpClient } from './lib/ftp-client.js';

// ── Config ────────────────────────────────────────────────────────────────────

const MCP_TRANSPORT = process.env.MCP_TRANSPORT || 'stdio';
const MCP_PORT      = Number(process.env.MCP_PORT  || 3100);
const MCP_HOST      = process.env.MCP_HOST  || '0.0.0.0';
const BRIDGE_PORT   = Number(process.env.BRIDGE_PORT || 9224);
const BRIDGE_HOST   = process.env.BRIDGE_HOST || '0.0.0.0';
const CORS_ORIGIN   = process.env.CORS_ORIGIN || '*';

// ── CORS middleware ────────────────────────────────────────────────────────────
// Applied to every Express route so browser-origin MCP clients don't get blocked.

function corsMiddleware(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin',  CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, Mcp-Session-Id, X-Requested-With, Last-Event-Id, Cache-Control');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  // SSE responses must not be cached
  if (req.headers.accept?.includes('text/event-stream')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering for SSE
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// ── Element bridge (shared by both transport modes) ────────────────────────────
// The Chrome extension POSTs right-clicked element data here.

let lastCapturedElement = null;
const waiters = [];

function buildBridgeApp() {
  const app = express();
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));

  app.post('/element', (req, res) => {
    lastCapturedElement = { ...req.body, capturedAt: new Date().toISOString() };
    while (waiters.length) waiters.shift()(lastCapturedElement);
    res.json({ ok: true });
  });

  app.get('/status', (_req, res) => {
    res.json({
      ok:              true,
      transport:       MCP_TRANSPORT,
      lastCapture:     lastCapturedElement?.capturedAt ?? null,
      browserConnected: !!browserManager.page,
    });
  });

  return app;
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  // ── Browser ────────────────────────────────────────────────────────────────
  {
    name: 'browser_connect',
    description:
      'Connect to Chrome. Attempts to attach to a running Chrome instance (requires --remote-debugging-port launch flag). Falls back to launching headless Chrome automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        port:     { type: 'number',  description: 'Chrome remote debugging port (default: 9222)' },
        headless: { type: 'boolean', description: 'Use headless mode when launching a new instance (default: true)' },
      },
    },
  },
  {
    name: 'browser_disconnect',
    description: 'Disconnect from Chrome. Closes the browser if it was launched by this server.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'page_navigate',
    description: 'Navigate to a URL and wait for the page to fully load.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
    },
  },
  {
    name: 'page_screenshot',
    description: 'Take a screenshot of the current viewport. Returns a base64-encoded PNG image.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_evaluate',
    description:
      'Evaluate a JavaScript expression in the live page and return the result. Pass a JS expression (not a statement), e.g. "document.title".',
    inputSchema: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: { type: 'string', description: 'JS expression to evaluate' },
      },
    },
  },

  // ── Element inspection ──────────────────────────────────────────────────────
  {
    name: 'element_inspect',
    description: 'Full snapshot of a DOM element: tag name, id, classes, attributes, dimensions, page position, child count, and text content.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: { selector: { type: 'string', description: 'CSS selector targeting the element' } },
    },
  },
  {
    name: 'element_get_styles',
    description:
      'Get computed CSS property values for an element (resolved to px, rgb, etc). Returns a curated set of ~30 layout/visual props by default, or specific ones if you pass a list.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector:   { type: 'string' },
        properties: {
          type:  'array',
          items: { type: 'string' },
          description: 'Specific CSS property names to return. Omit for the default set.',
        },
      },
    },
  },
  {
    name: 'element_get_css_rules',
    description:
      'Get every CSS rule that applies to an element — inline styles, matched stylesheet rules, and inherited rules — with selectors and all property:value pairs.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: { selector: { type: 'string' } },
    },
  },
  {
    name: 'element_get_selector',
    description: 'Generate a unique, minimal CSS selector path that reliably targets a specific element.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: { selector: { type: 'string', description: 'Starting selector (can be approximate)' } },
    },
  },
  {
    name: 'dom_query',
    description: 'Run querySelector (single) or querySelectorAll (all) on the page. Returns element summaries with tag, id, classes, text, and visibility.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector: { type: 'string' },
        all:      { type: 'boolean', description: 'Return all matches (default: false)' },
      },
    },
  },

  // ── CSS / FTP ───────────────────────────────────────────────────────────────
  {
    name: 'css_upload_ftp',
    description: 'Upload CSS content to a file on the FTP server. "replace" overwrites, "append" adds to the end.',
    inputSchema: {
      type: 'object',
      required: ['css'],
      properties: {
        css:        { type: 'string', description: 'CSS content to upload' },
        remotePath: { type: 'string', description: 'Remote file path. Falls back to FTP_DEFAULT_CSS_PATH.' },
        mode:       { type: 'string', enum: ['replace', 'append'], description: 'Default: replace' },
      },
    },
  },
  {
    name: 'css_test_ftp',
    description: 'Test the FTP connection and list the root directory.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Extension bridge ────────────────────────────────────────────────────────
  {
    name: 'extension_get_element',
    description:
      'Get element data captured by the browser extension "Inspect with Claude" context menu. Returns selector, classes, computed styles, dimensions, and page URL.',
    inputSchema: {
      type: 'object',
      properties: {
        wait: { type: 'boolean', description: 'Wait up to 30 s for a new capture (default: false)' },
      },
    },
  },
];

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'cdp-inspector', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'browser_connect': {
        const r = await browserManager.connect(args);
        return ok(`Connected (${r.mode}).\nURL : ${r.url}\nTitle: ${r.title}`);
      }
      case 'browser_disconnect': {
        await browserManager.disconnect();
        return ok('Disconnected.');
      }
      case 'page_navigate': {
        const r = await browserManager.navigate(args.url);
        return ok(`Navigated to: ${r.url}\nTitle: ${r.title}`);
      }
      case 'page_screenshot': {
        const b64 = await browserManager.screenshot();
        return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
      }
      case 'browser_evaluate': {
        const result = await browserManager.evaluate(args.expression);
        return ok(JSON.stringify(result, null, 2));
      }
      case 'element_inspect': {
        const info = await inspector.inspect(browserManager.getPage(), args.selector);
        return ok(JSON.stringify(info, null, 2));
      }
      case 'element_get_styles': {
        const styles = await inspector.getComputedStyles(
          browserManager.getCDP(), browserManager.getPage(), args.selector, args.properties
        );
        return ok(JSON.stringify(styles, null, 2));
      }
      case 'element_get_css_rules': {
        const rules = await inspector.getCSSRules(
          browserManager.getCDP(), browserManager.getPage(), args.selector
        );
        return ok(JSON.stringify(rules, null, 2));
      }
      case 'element_get_selector': {
        const sel = await inspector.getUniqueSelector(browserManager.getPage(), args.selector);
        return ok(sel ?? 'Could not build unique selector.');
      }
      case 'dom_query': {
        const results = await inspector.query(
          browserManager.getPage(), args.selector, args.all ?? false
        );
        return ok(JSON.stringify(results, null, 2));
      }
      case 'css_upload_ftp': {
        const msg = await ftpClient.upload(args.css, args.remotePath, args.mode ?? 'replace');
        return ok(msg);
      }
      case 'css_test_ftp': {
        const r = await ftpClient.testConnection();
        return ok(JSON.stringify(r, null, 2));
      }
      case 'extension_get_element': {
        if (args.wait) {
          const captured = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(resolve), 1);
              reject(new Error('Timed out waiting for extension capture (30 s)'));
            }, 30_000);
            waiters.push((el) => { clearTimeout(timer); resolve(el); });
          });
          return ok(JSON.stringify(captured, null, 2));
        }
        if (!lastCapturedElement) {
          return ok('No element captured yet. Right-click an element → "Inspect with Claude".');
        }
        return ok(JSON.stringify(lastCapturedElement, null, 2));
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

function ok(text) {
  return { content: [{ type: 'text', text }] };
}

// ── Transport startup ─────────────────────────────────────────────────────────

if (MCP_TRANSPORT === 'http') {
  // ── HTTP mode: single Express app serves both /mcp and /element ─────────────
  // Use this for Docker and Tailscale.
  //
  //   MCP endpoint : http://HOST:MCP_PORT/mcp
  //   Bridge       : http://HOST:MCP_PORT/element  (for browser extension)
  //   Status       : http://HOST:MCP_PORT/status

  const app = buildBridgeApp();

  // Sessions map: sessionId → StreamableHTTPServerTransport
  const sessions = new Map();

  // MCP endpoint — handles initialize (POST), SSE stream (GET), close (DELETE)
  app.all('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];

      if (req.method === 'POST' && !sessionId) {
        // New session — create a fresh transport
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            process.stderr.write(`[cdp-inspector] MCP session started: ${id}\n`);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
            process.stderr.write(`[cdp-inspector] MCP session closed: ${transport.sessionId}\n`);
          }
        };

        // Connect the shared MCP server to this transport
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Existing session
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: `Session not found: ${sessionId}` });
        return;
      }
      await transport.handleRequest(req, res, req.body);

    } catch (err) {
      process.stderr.write(`[cdp-inspector] MCP handler error: ${err.message}\n`);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  app.listen(MCP_PORT, MCP_HOST, () => {
    process.stderr.write(
      `[cdp-inspector] HTTP transport ready\n` +
      `  MCP    → http://${MCP_HOST}:${MCP_PORT}/mcp\n` +
      `  Bridge → http://${MCP_HOST}:${MCP_PORT}/element\n` +
      `  Status → http://${MCP_HOST}:${MCP_PORT}/status\n`
    );
  });

} else {
  // ── Stdio mode: local Claude Code usage ────────────────────────────────────
  // Bridge still starts so the browser extension works alongside stdio.

  const bridgeApp = buildBridgeApp();
  bridgeApp.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
    process.stderr.write(
      `[cdp-inspector] Stdio transport active\n` +
      `  Bridge → http://${BRIDGE_HOST}:${BRIDGE_PORT}/element\n`
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
