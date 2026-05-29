#!/usr/bin/env node
/**
 * cdp-inspector — MCP server
 *
 * Exposes 11 tools across 3 categories:
 *   Browser  : connect, disconnect, navigate, screenshot, evaluate
 *   Inspector: element_inspect, element_get_styles, element_get_css_rules,
 *              element_get_selector, dom_query
 *   CSS/FTP  : css_upload_ftp, css_test_ftp
 *   Bridge   : extension_get_element   (populated by browser extension via HTTP)
 *
 * Also runs a tiny Express bridge server (default :9224) so the Chrome
 * extension can POST captured element data to this process.
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { browserManager } from './lib/browser.js';
import { inspector } from './lib/inspector.js';
import { ftpClient } from './lib/ftp-client.js';

// ── Bridge HTTP server ────────────────────────────────────────────────────────
// The browser extension POSTs element data here; we serve it to Claude via MCP.

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 9224);

let lastCapturedElement = null;
const waiters = [];           // resolve functions for extension_get_element(wait:true)

const bridge = express();
bridge.use(express.json({ limit: '1mb' }));

bridge.post('/element', (req, res) => {
  lastCapturedElement = { ...req.body, capturedAt: new Date().toISOString() };
  // Wake up any callers waiting for a capture
  while (waiters.length) waiters.shift()(lastCapturedElement);
  res.json({ ok: true });
});

bridge.get('/status', (_req, res) => {
  res.json({
    ok: true,
    lastCapture: lastCapturedElement?.capturedAt ?? null,
    browserConnected: !!browserManager.page,
  });
});

bridge.listen(BRIDGE_PORT, '127.0.0.1', () => {
  process.stderr.write(`[cdp-inspector] Bridge listening on http://127.0.0.1:${BRIDGE_PORT}\n`);
});

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
        port: {
          type: 'number',
          description: 'Chrome remote debugging port (default: 9222)',
        },
        headless: {
          type: 'boolean',
          description: 'Use headless mode when launching a new instance (default: true)',
        },
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
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
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
      'Evaluate a JavaScript expression in the live page and return the result. Useful for reading DOM state, checking variables, or running custom queries. Pass a JS expression (not a statement).',
    inputSchema: {
      type: 'object',
      required: ['expression'],
      properties: {
        expression: {
          type: 'string',
          description: 'JS expression to evaluate (e.g. "document.title" or "[...document.querySelectorAll(\'h1\')].map(h=>h.textContent)")',
        },
      },
    },
  },

  // ── Element inspection ──────────────────────────────────────────────────────
  {
    name: 'element_inspect',
    description:
      'Full snapshot of a DOM element: tag name, id, classes, attributes, dimensions, page position, child count, and text content.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector: { type: 'string', description: 'CSS selector targeting the element' },
      },
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
        selector: { type: 'string' },
        properties: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific CSS property names to return (e.g. ["color","font-size"]). Omit for the default set.',
        },
      },
    },
  },
  {
    name: 'element_get_css_rules',
    description:
      'Get every CSS rule that applies to an element — inline styles, matched stylesheet rules, and inherited rules — with selectors and all property:value pairs. Essential for understanding specificity and knowing what to override.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector: { type: 'string' },
      },
    },
  },
  {
    name: 'element_get_selector',
    description:
      'Generate a unique, minimal CSS selector path that reliably targets a specific element. Useful when you have a rough selector and need the exact one to write CSS for.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector: { type: 'string', description: 'Starting selector (can be approximate)' },
      },
    },
  },
  {
    name: 'dom_query',
    description:
      'Run querySelector (single) or querySelectorAll (all) on the page. Returns element summaries with tag, id, classes, text, and visibility.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        selector: { type: 'string' },
        all: {
          type: 'boolean',
          description: 'Return all matches via querySelectorAll (default: false)',
        },
      },
    },
  },

  // ── CSS / FTP ───────────────────────────────────────────────────────────────
  {
    name: 'css_upload_ftp',
    description:
      'Upload CSS content to a file on the configured FTP server. Use "replace" to overwrite, or "append" to add to the end of the existing file.',
    inputSchema: {
      type: 'object',
      required: ['css'],
      properties: {
        css: { type: 'string', description: 'CSS content to upload' },
        remotePath: {
          type: 'string',
          description: 'Remote file path (e.g. /templates/g5_hydrogen/custom/css/custom.css). Falls back to FTP_DEFAULT_CSS_PATH env var.',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: '"replace" overwrites the file; "append" adds to it (default: replace)',
        },
      },
    },
  },
  {
    name: 'css_test_ftp',
    description: 'Test the FTP connection and list the root directory to verify credentials.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Extension bridge ────────────────────────────────────────────────────────
  {
    name: 'extension_get_element',
    description:
      'Get element data captured by the browser extension. The user right-clicks an element in Chrome and chooses "Inspect with Claude" — the extension captures tag, classes, computed styles, unique selector, dimensions, and page URL, then sends it here. Returns the most recently captured element.',
    inputSchema: {
      type: 'object',
      properties: {
        wait: {
          type: 'boolean',
          description: 'Wait up to 30 s for a new capture before returning (default: false)',
        },
      },
    },
  },
];

// ── MCP server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'cdp-inspector', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {

      // ── Browser tools ─────────────────────────────────────────────────────

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

      // ── Inspector tools ───────────────────────────────────────────────────

      case 'element_inspect': {
        const info = await inspector.inspect(browserManager.getPage(), args.selector);
        return ok(JSON.stringify(info, null, 2));
      }

      case 'element_get_styles': {
        const styles = await inspector.getComputedStyles(
          browserManager.getCDP(),
          browserManager.getPage(),
          args.selector,
          args.properties
        );
        return ok(JSON.stringify(styles, null, 2));
      }

      case 'element_get_css_rules': {
        const rules = await inspector.getCSSRules(
          browserManager.getCDP(),
          browserManager.getPage(),
          args.selector
        );
        return ok(JSON.stringify(rules, null, 2));
      }

      case 'element_get_selector': {
        const sel = await inspector.getUniqueSelector(browserManager.getPage(), args.selector);
        return ok(sel ?? 'Could not build unique selector for that element.');
      }

      case 'dom_query': {
        const results = await inspector.query(
          browserManager.getPage(),
          args.selector,
          args.all ?? false
        );
        return ok(JSON.stringify(results, null, 2));
      }

      // ── CSS / FTP tools ───────────────────────────────────────────────────

      case 'css_upload_ftp': {
        const msg = await ftpClient.upload(
          args.css,
          args.remotePath,
          args.mode ?? 'replace'
        );
        return ok(msg);
      }

      case 'css_test_ftp': {
        const r = await ftpClient.testConnection();
        return ok(JSON.stringify(r, null, 2));
      }

      // ── Extension bridge ──────────────────────────────────────────────────

      case 'extension_get_element': {
        if (args.wait) {
          // Block until the extension sends something (or timeout)
          const captured = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              const idx = waiters.indexOf(resolve);
              if (idx !== -1) waiters.splice(idx, 1);
              reject(new Error('Timed out waiting for extension capture (30 s)'));
            }, 30_000);

            waiters.push((el) => {
              clearTimeout(timer);
              resolve(el);
            });
          });
          return ok(JSON.stringify(captured, null, 2));
        }

        if (!lastCapturedElement) {
          return ok(
            'No element captured yet.\n' +
            'Right-click any element in Chrome and choose "Inspect with Claude".'
          );
        }
        return ok(JSON.stringify(lastCapturedElement, null, 2));
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

/** Wrap a string as a successful MCP text response */
function ok(text) {
  return { content: [{ type: 'text', text }] };
}

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
