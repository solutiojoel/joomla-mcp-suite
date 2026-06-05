#!/usr/bin/env node
'use strict';

/**
 * Joomla Orchestrator - MCP server that routes tool calls to downstream servers.
 *
 * Content tools (articles, categories, menus, modules) → joomla-mcp
 * Design tools  (gantry layouts, outlines, styles)      → gantry-mcp
 *
 * Workflow:
 *   1. User says "I want to work on a site"
 *   2. Orchestrator asks for the site URL
 *   3. User provides URL → set_active_site is called
 *   4. Subsequent tool calls are routed to the right downstream server
 *
 * This is the foundation - routing logic, intent classification, multi-site
 * support, and credential management can all be extended here.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { STYLE_GUIDE, SECTIONS, PARTICLES } = require('./solutio-conventions.js');

const { Server }   = require('@modelcontextprotocol/sdk/server/index.js');
const { Client }   = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { StdioServerTransport }          = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');
const { randomUUID } = require('crypto');
const fs   = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const JOOMLA_MCP_URL   = process.env.JOOMLA_MCP_URL   || 'http://host.docker.internal:9300/mcp';
const JOOMLA_MCP_TOKEN = process.env.JOOMLA_MCP_TOKEN || '';
const GANTRY_MCP_URL   = process.env.GANTRY_MCP_URL   || 'http://host.docker.internal:9301/mcp';
const GANTRY_MCP_TOKEN = process.env.GANTRY_MCP_TOKEN || '';

// ─── Session state ────────────────────────────────────────────────────────────
// TODO: move into per-session scope when multi-tenant support is needed

let activeSiteUrl = null;

// ─── Auto-URL extraction ──────────────────────────────────────────────────────
// If activeSiteUrl is not set but a tool argument looks like a site URL, use it.

function extractSiteUrlFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && /^https?:\/\//.test(val)) {
      // Return the origin (scheme + host) only
      try { return new URL(val).origin; } catch {}
    }
  }
  return null;
}

// ─── Downstream clients ───────────────────────────────────────────────────────
// We create a fresh MCP client per call rather than holding a persistent
// connection. Persistent StreamableHTTP connections time out after inactivity
// and don't auto-reconnect, which makes the proxy flaky. Fresh-per-call is
// slightly slower (one extra round-trip for initialize) but always reliable.

const joomlaToolMap = new Map(); // tool name → tool definition
const gantryToolMap = new Map();

async function createClient(label, url, token) {
  const client = new Client(
    { name: `orchestrator→${label}`, version: '1.0.0' },
    { capabilities: {} }
  );
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  await client.connect(transport);
  return client;
}

/**
 * Call a tool on a downstream server.
 * Creates a fresh client, calls the tool, then closes cleanly.
 * Retries once automatically on any transport/connection error.
 */
async function callDownstream(label, url, token, toolName, toolArgs) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let client;
    try {
      client = await createClient(label, url, token);
      const result = await client.callTool({ name: toolName, arguments: toolArgs });
      client.close().catch(() => {});
      return result;
    } catch (err) {
      if (client) client.close().catch(() => {});
      if (attempt === 2) throw err;
      log(`${label} call failed (attempt ${attempt}), retrying - ${err.message}`);
    }
  }
}

async function loadDownstreamTools() {
  for (const [label, url, token, toolMap] of [
    ['joomla-mcp', JOOMLA_MCP_URL, JOOMLA_MCP_TOKEN, joomlaToolMap],
    ['gantry-mcp', GANTRY_MCP_URL, GANTRY_MCP_TOKEN, gantryToolMap],
  ]) {
    try {
      const client = await createClient(label, url, token);
      const { tools = [] } = await client.listTools();
      client.close().catch(() => {});
      toolMap.clear();
      tools.forEach(t => toolMap.set(t.name, t));
      log(`loaded ${toolMap.size} tools from ${label}`);
    } catch (err) {
      log(`WARNING: could not load ${label} tools - ${err.message}`);
    }
  }
}

// ─── Server builder ───────────────────────────────────────────────────────────

function buildServer() {
  const server = new Server(
    { name: 'joomla-orchestrator', version: '1.0.0' },
    { capabilities: { tools: {}, prompts: {} } }
  );

  // ── Prompts ──────────────────────────────────────────────────────────────────
  // Prompts are conversation starters. When a user says "I want to work on a
  // site", the client surfaces the work_on_site prompt which guides the LLM to
  // ask for a URL before doing anything else.

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'work_on_site',
        description: 'Start a Joomla working session. Use this when the user wants to work on a site.',
      },
      {
        name: 'build_solutio_site',
        description:
          'Start a full site build following Solutio conventions. ' +
          'Loads the complete style guide and guides the LLM through building a parish or school home outline correctly.',
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === 'build_solutio_site') {
      return {
        description: 'Solutio site build session',
        messages: [
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: [
                '## Solutio Site Build',
                '',
                'I\'ll help you build this site the Solutio way. Before we start, here are the house conventions I\'ll follow:',
                '',
                '**Theme:** rt_studius',
                '**Standard outlines:** Parish Home (outline 33) | School Home (outline 72)',
                '',
                '**Non-negotiable structural rules:**',
                '- `navigation`, `footer`, `copyright`, `bottom` always inherit from the default outline',
                '- Every site has `system/messages` + Alert contentarray in the `top` section',
                '- Exactly one swiper particle in `slideshow`',
                '- Offcanvas always has `mobile-menu` + subsite-navigation HTML',
                '- Footer always has `footer-a/b/c` positions (33.3% each) + footer article',
                '- Copyright always has the Solutio admin footer HTML',
                '- CSS uses min(Nvw, Nrem) sizing, 50.99rem breakpoints, CSS variables only',
                '',
                '**Design workflow - required tool call order:**',
                '1. `solutio_design_workflow` - load the full design process guide (do this now)',
                '2. `gantry_outline_conventions` - load outline/subsite inheritance rules before creating or rewiring outlines',
                '3. `gantry_design_patterns` - load the pattern knowledge base (why each particle+CSS choice is made)',
                '4. `gantry_design_plan_from_brief(brief: "...")` - generate a plan with required IDs and guardrails before writing any YAML',
                '5. `gantry_homepage_examples` - find a similar site and decompile it as a starting point',
                '6. Resolve all content IDs via `joomla_list_categories` / `joomla_list_articles`',
                '7. `gantry_validate_design_contract` - validate design YAML before applying',
                '8. `gantry_layout_design(dryRun: true)` - dry run, then apply',
                '',
                'Call `solutio_style_guide` for structural conventions, `solutio_particles` for particle field schemas.',
                '',
                'Which site are we building, and is it a **parish home**, **school home**, or another page type?',
              ].join('\n'),
            },
          },
        ],
      };
    }

    if (request.params.name !== 'work_on_site') {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    const siteNote = activeSiteUrl
      ? `The currently active site is **${activeSiteUrl}**.`
      : 'No site is currently active.';

    return {
      description: 'Joomla site working session starter',
      messages: [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: [
              `I can help you work on your Joomla site. ${siteNote}`,
              '',
              'Which site would you like to work on? Please provide the full site URL (e.g. `https://example.com`).',
              '',
              'Once I have the site, tell me what you\'d like to do:',
              '- **Content** - articles, categories, menus, modules',
              '- **Design** - Gantry layouts, outlines, styles, particles',
              '',
              'For builds and design work, use `solutio_style_guide` to load the Solutio house conventions, or start with the `build_solutio_site` prompt.',
            ].join('\n'),
          },
        },
      ],
    };
  });

  // ── Tools ─────────────────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Own management tools come first so the LLM encounters them early
    const ownTools = [
      {
        name: 'set_active_site',
        description:
          'Set the active Joomla site URL for this session. ' +
          'Always call this as soon as the user provides a site URL before using any other tools.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Site URL, e.g. https://example.com' },
          },
          required: ['url'],
        },
      },
      {
        name: 'get_active_site',
        description: 'Get the currently active Joomla site URL.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_site_notes',
        description:
          'REQUIRED at session start — read the active site\'s history file before making any changes. ' +
          'Contains persistent site facts (key IDs, quirks, integrations) and a full changelog of past changes. ' +
          'Call immediately after set_active_site is confirmed.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'append_site_note',
        description:
          'REQUIRED after every session that makes changes to a site. ' +
          'Appends a structured changelog entry to the active site\'s history file in docs/sites/. ' +
          'Call this immediately after completing work — do not wait until the end of the conversation. ' +
          'Format the note as a structured markdown entry:\n' +
          '### YYYY-MM-DD — [Ticket #XXXXX | ][Brief title]\n' +
          '**Requested by:** [Name / email / \'internal\'] | **Ticket:** [#XXXXX or \'none\']\n' +
          '**Changes:**\n' +
          '- [specific change with IDs]\n' +
          '**Notes:** [anything non-obvious, or \'No follow-up needed\']\n\n' +
          'Also call this when you discover a persistent site fact (quirk, key ID, integration) — ' +
          'use a plain paragraph instead of the ### header for those entries.',
        inputSchema: {
          type: 'object',
          properties: {
            note: { type: 'string', description: 'The full changelog entry or discovery note to append.' },
          },
          required: ['note'],
        },
      },
      {
        name: 'write_site_notes',
        description: 'Overwrite the entire notes file for the active site. Always read current notes first.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Full markdown content to write (replaces entire file).' },
          },
          required: ['content'],
        },
      },
      {
        name: 'gantry_reconnect',
        description:
          'Force gantry-mcp to drop its cached session for the active site and re-authenticate. ' +
          'Call this if gantry tools are returning auth errors, stale session errors, or ' +
          'unexpected failures after a period of inactivity.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'reload_tools',
        description:
          'Reload the tool lists from both joomla-mcp and gantry-mcp. ' +
          'Call this if tools appear missing or if either downstream server was restarted.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'solutio_style_guide',
        description:
          'Return the Solutio Software house style guide for Gantry 5 site builds. ' +
          'Call this at the start of any build or design task to ensure consistency with ' +
          'the established conventions across the client fleet. ' +
          'Use the "section" parameter to request a focused part of the guide, or omit it for the full reference. ' +
          'Available sections: overview, outline_structure, inherit_rules, css, css_rendering, page_targeting, parish, school, checklist, naming.',
        inputSchema: {
          type: 'object',
          properties: {
            section: {
              type: 'string',
              enum: ['full', 'overview', 'outline_structure', 'inherit_rules', 'css', 'css_rendering', 'page_targeting', 'parish', 'school', 'checklist', 'naming'],
              description: 'Which part of the guide to return. Omit or use "full" for the complete reference.',
            },
          },
        },
      },
      {
        name: 'solutio_particles',
        description:
          'Return the Solutio particle reference - every particle type with purpose, visual role, ' +
          'complete field schema, standard configurations, and a decision guide for choosing the right particle. ' +
          'Call this before adding or editing any Gantry particle. ' +
          'Use the particle parameter to look up a specific type.',
        inputSchema: {
          type: 'object',
          properties: {
            particle: {
              type: 'string',
              enum: ['all', 'contentarray', 'swiper', 'blockcontent', 'custom', 'logo',
                     'menu', 'mobile-menu', 'social', 'timeline', 'position', 'spacer',
                     'copyright', 'horizmenu', 'search', 'video', 'system'],
              description: 'Particle type to look up. Omit or "all" for the full reference.',
            },
          },
        },
      },
      {
        name: 'solutio_design_workflow',
        description:
          'Return the Solutio Gantry design workflow guide - the step-by-step process for ' +
          'building or rebuilding a homepage layout correctly. ' +
          'Covers: required tool call order (patterns -> plan -> examples -> resolve IDs -> ' +
          'validate -> dry run -> apply -> verify), brief format, particle decision rules, ' +
          'and the most common mistakes to avoid. ' +
          'CALL THIS at the start of any homepage build or major layout change. ' +
          'Works alongside solutio_style_guide (structural rules) and gantry_design_patterns ' +
          '(per-section design knowledge).',
        inputSchema: { type: 'object', properties: {} },
      },
    ];

    // joomla_login is internal plumbing - the orchestrator calls it automatically
    // via set_active_site and on auth error recovery. Hiding it prevents the AI
    // from calling it directly, which would bypass activeSiteUrl tracking.
    const HIDDEN_JOOMLA_TOOLS = new Set(['joomla_login']);

    return {
      tools: [
        ...ownTools,
        ...Array.from(joomlaToolMap.values()).filter(t => !HIDDEN_JOOMLA_TOOLS.has(t.name)),
        ...Array.from(gantryToolMap.values()),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // ── Own tools ──

    if (name === 'set_active_site') {
      activeSiteUrl = args.url;

      // Auto-login: immediately prime the joomla-mcp session for this site.
      // This avoids the first tool call failing because no session exists yet.
      // We fire-and-forget (non-fatal if it fails - credentials may not be set).
      let loginNote = '';
      try {
        const loginResult = await callDownstream(
          'joomla-mcp', JOOMLA_MCP_URL, JOOMLA_MCP_TOKEN,
          'joomla_login', { site_url: activeSiteUrl }
        );
        const loginText = loginResult?.content?.[0]?.text || '';
        let parsed = null;
        try { parsed = JSON.parse(loginText); } catch {}
        if (parsed?.success === false) {
          loginNote = `\n\nNote: auto-login attempt returned: ${parsed.message || loginText.slice(0, 120)}`;
        } else {
          loginNote = '\n\nJoomla session established automatically.';
        }
      } catch (e) {
        loginNote = `\n\nNote: auto-login attempt failed (${e.message}) - check credentials or call set_active_site again.`;
      }

      return {
        content: [{
          type: 'text',
          text: `Active site set to: ${activeSiteUrl}${loginNote}\n\nYou can now use content tools (articles, categories, menus, modules) or design tools (Gantry layouts, outlines, styles).`,
        }],
      };
    }

    if (name === 'get_active_site') {
      return {
        content: [{
          type: 'text',
          text: activeSiteUrl
            ? `Active site: ${activeSiteUrl}`
            : 'No active site set. Call set_active_site with the site URL first.',
        }],
      };
    }

    if (name === 'get_site_notes' || name === 'append_site_note' || name === 'write_site_notes') {
      if (!activeSiteUrl) {
        return { isError: true, content: [{ type: 'text', text: 'No active site set. Call set_active_site first.' }] };
      }
      const hostname = (() => { try { return new URL(activeSiteUrl).hostname; } catch { return activeSiteUrl; } })();
      const notesPath = path.join(__dirname, '..', '..', 'docs', 'sites', `${hostname}.md`);

      if (name === 'get_site_notes') {
        if (!fs.existsSync(notesPath)) {
          return { content: [{ type: 'text', text: `No notes yet for ${hostname}.` }] };
        }
        return { content: [{ type: 'text', text: fs.readFileSync(notesPath, 'utf8') }] };
      }

      if (name === 'append_site_note') {
        const note = args.note;
        if (!note) return { isError: true, content: [{ type: 'text', text: 'note is required' }] };
        // If the note is a structured changelog entry (starts with ###), append it
        // directly — it already has its own date header. Otherwise wrap it with a
        // legacy timestamp for backwards compatibility with plain discovery notes.
        const isStructured = note.trimStart().startsWith('###');
        const entry = isStructured
          ? `\n${note.trim()}\n`
          : `\n**[${new Date().toISOString().replace('T', ' ').substring(0, 16)} UTC]** ${note.trim()}\n`;
        if (!fs.existsSync(notesPath)) {
          fs.mkdirSync(path.dirname(notesPath), { recursive: true });
          fs.writeFileSync(notesPath, `# Site Notes: ${hostname}\n\nNotes logged by AI agents.\n`);
        }
        fs.appendFileSync(notesPath, entry);
        return { content: [{ type: 'text', text: `Changelog entry appended to ${hostname}` }] };
      }

      if (name === 'write_site_notes') {
        const content = args.content;
        if (!content) return { isError: true, content: [{ type: 'text', text: 'content is required' }] };
        // Guard against stale-write: if the file already exists, verify the incoming
        // content contains every ### changelog entry header that is currently on disk.
        // This catches the pattern where an agent reads early, appends mid-session via
        // append_site_note, then calls write_site_notes with the stale pre-append read.
        if (fs.existsSync(notesPath)) {
          const existing = fs.readFileSync(notesPath, 'utf8');
          const existingHeaders = existing.match(/^### .+$/gm) || [];
          const missingHeaders = existingHeaders.filter(h => !content.includes(h));
          if (missingHeaders.length > 0) {
            return {
              isError: true,
              content: [{ type: 'text', text: `write_site_notes rejected: incoming content is missing ${missingHeaders.length} changelog entry(s) already on disk. Re-read the file with get_site_notes, merge your changes into the current content, then call write_site_notes again.\n\nMissing entries:\n${missingHeaders.join('\n')}` }]
            };
          }
        }
        fs.mkdirSync(path.dirname(notesPath), { recursive: true });
        fs.writeFileSync(notesPath, content, 'utf8');
        return { content: [{ type: 'text', text: `Site notes updated for ${hostname}` }] };
      }
    }

    if (name === 'gantry_reconnect') {
      if (!activeSiteUrl) {
        return { isError: true, content: [{ type: 'text', text: 'No active site set. Call set_active_site first.' }] };
      }
      // Ask gantry-mcp to drop its cached ctx by calling a lightweight tool
      // that will fail gracefully, then reload the tool map to confirm connectivity.
      let msg = '';
      try {
        // Pass a force-refresh hint via a no-op style tool call
        await callDownstream('gantry-mcp', GANTRY_MCP_URL, GANTRY_MCP_TOKEN,
          'gantry_outlines_list', { site: activeSiteUrl });
        msg = 'Gantry session is alive and responding.';
      } catch (e) {
        msg = `Gantry session appears stale (${e.message}). Reloading tool map…`;
      }
      // Always reload the tool map on reconnect
      try {
        const c = await createClient('gantry-mcp', GANTRY_MCP_URL, GANTRY_MCP_TOKEN);
        const { tools = [] } = await c.listTools();
        c.close().catch(() => {});
        gantryToolMap.clear();
        tools.forEach(t => gantryToolMap.set(t.name, t));
        msg += ` Tool map reloaded (${gantryToolMap.size} tools).`;
      } catch (e) {
        msg += ` Tool map reload failed: ${e.message}`;
      }
      return { content: [{ type: 'text', text: msg }] };
    }

    if (name === 'reload_tools') {
      await loadDownstreamTools();
      return {
        content: [{
          type: 'text',
          text: `Tools reloaded - joomla-mcp: ${joomlaToolMap.size} tools, gantry-mcp: ${gantryToolMap.size} tools.`,
        }],
      };
    }

    if (name === 'solutio_style_guide') {
      const section = args.section || 'full';
      const content = section === 'full' ? STYLE_GUIDE : (SECTIONS[section] || STYLE_GUIDE);
      return {
        content: [{
          type: 'text',
          text: content,
        }],
      };
    }

    if (name === 'solutio_particles') {
      const particle = args.particle || 'all';
      let out = PARTICLES;
      if (particle !== 'all') {
        const heading = '## ' + particle;
        const start = out.indexOf(heading);
        if (start !== -1) {
          const next = out.indexOf('\n## ', start + 4);
          out = next !== -1 ? out.slice(start, next) : out.slice(start);
        }
      }
      return { content: [{ type: 'text', text: out }] };
    }

    if (name === 'solutio_design_workflow') {
      const docPath = path.join(__dirname, '..', 'joomla-mcp', 'docs', 'agents', 'gantry-design-agent.md');
      if (!fs.existsSync(docPath)) {
        return { isError: true, content: [{ type: 'text', text: `Design workflow guide not found at ${docPath}` }] };
      }
      return { content: [{ type: 'text', text: fs.readFileSync(docPath, 'utf8') }] };
    }

    // ── Freshdesk tools - no active site required ──
    // These tools only need Freshdesk API credentials; they never touch Joomla.
    if (name.startsWith('freshdesk_')) {
      if (!joomlaToolMap.has(name)) {
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      }
      try {
        return await callDownstream('joomla-mcp', JOOMLA_MCP_URL, JOOMLA_MCP_TOKEN, name, args);
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `freshdesk error: ${err.message}` }] };
      }
    }

    // ── Guard: site must be set before routing downstream ──
    // Auto-detect site URL from tool arguments if not yet set.

    if (!activeSiteUrl) {
      const detected = extractSiteUrlFromArgs(args);
      if (detected) {
        activeSiteUrl = detected;
        log(`auto-detected site URL from tool args: ${activeSiteUrl}`);
      } else {
        return {
          isError: true,
          content: [{
            type: 'text',
            text: 'No active site is set. Please call set_active_site with the site URL before using any tools.',
          }],
        };
      }
    }

    // ── Route to joomla-mcp (content tools) ──
    // Inject site_url so joomla-mcp switches to the active site before each call.
    // joomla-mcp handles site_url at the top of its CallTool handler.

    if (joomlaToolMap.has(name)) {
      try {
        return await callDownstream('joomla-mcp', JOOMLA_MCP_URL, JOOMLA_MCP_TOKEN, name, { ...args, site_url: activeSiteUrl });
      } catch (err) {
        // Auth error → re-login and retry once
        if (/401|403|login|csrf|cookie|session/i.test(err.message)) {
          log(`joomla-mcp auth error, re-logging in and retrying: ${err.message}`);
          try { await callDownstream('joomla-mcp', JOOMLA_MCP_URL, JOOMLA_MCP_TOKEN, 'joomla_login', { site_url: activeSiteUrl }); } catch {}
          try {
            return await callDownstream('joomla-mcp', JOOMLA_MCP_URL, JOOMLA_MCP_TOKEN, name, { ...args, site_url: activeSiteUrl });
          } catch (err2) {
            return { isError: true, content: [{ type: 'text', text: `joomla-mcp error (after re-login): ${err2.message}` }] };
          }
        }
        return { isError: true, content: [{ type: 'text', text: `joomla-mcp error: ${err.message}` }] };
      }
    }

    // ── Route to gantry-mcp (design tools) ──
    // gantry-mcp expects a `site` argument on every call, so we inject it.
    // If the tool map is empty (startup race) or the tool isn't found, attempt
    // a lazy reload once before giving up.

    if (gantryToolMap.has(name) || gantryToolMap.size === 0) {
      // Lazy reload if tool map is empty - gantry-mcp may have started after us
      if (gantryToolMap.size === 0) {
        log(`gantryToolMap empty, attempting lazy reload before routing ${name}…`);
        try {
          const c = await createClient('gantry-mcp', GANTRY_MCP_URL, GANTRY_MCP_TOKEN);
          const { tools = [] } = await c.listTools();
          c.close().catch(() => {});
          gantryToolMap.clear();
          tools.forEach(t => gantryToolMap.set(t.name, t));
          log(`lazy reload: ${gantryToolMap.size} gantry tools loaded`);
        } catch (reloadErr) {
          log(`lazy reload failed: ${reloadErr.message}`);
        }
      }

      if (!gantryToolMap.has(name)) {
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name} (gantry-mcp tool map has ${gantryToolMap.size} entries)` }] };
      }

      const gantryArgs = { ...args, site: activeSiteUrl };
      try {
        return await callDownstream('gantry-mcp', GANTRY_MCP_URL, GANTRY_MCP_TOKEN, name, gantryArgs);
      } catch (err) {
        // Transport/connection error - callDownstream already retried once.
        // Force a tool-map reload so next call gets fresh session data.
        log(`gantry-mcp transport error on ${name}, will reload tool map: ${err.message}`);
        try {
          const c = await createClient('gantry-mcp', GANTRY_MCP_URL, GANTRY_MCP_TOKEN);
          const { tools = [] } = await c.listTools();
          c.close().catch(() => {});
          gantryToolMap.clear();
          tools.forEach(t => gantryToolMap.set(t.name, t));
        } catch {}
        return { isError: true, content: [{ type: 'text', text: `gantry-mcp error: ${err.message}` }] };
      }
    }

    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    };
  });

  return server;
}

// ─── HTTP transport ───────────────────────────────────────────────────────────

async function startHttp(port) {
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    // ── CORS - must be set on every response including errors ─────────────────
    res.setHeader('Access-Control-Allow-Origin',  process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    // Reflect whatever headers the client asks for - handles mcp-protocol-version
    // and any future MCP headers without needing further changes here.
    res.setHeader('Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] ||
      'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, ' +
      'X-Requested-With, Last-Event-Id, Cache-Control');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
    // Disable buffering for SSE streams (nginx / reverse proxies)
    res.setHeader('X-Accel-Buffering', 'no');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    // ── end CORS ──────────────────────────────────────────────────────────────

    const urlPath = new URL(req.url, `http://localhost:${port}`).pathname;
    if (urlPath !== '/mcp') { res.writeHead(404); res.end(); return; }

    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST') {
      let transport = sessions.get(sessionId);
      if (!transport) {
        const server = buildServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, transport),
        });
        transport.onclose = () => sessions.delete(sessionId);
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    } else if (req.method === 'GET') {
      const transport = sessions.get(sessionId);
      if (!transport) { res.writeHead(404); res.end(); return; }
      await transport.handleRequest(req, res);
    } else if (req.method === 'DELETE') {
      sessions.delete(sessionId); res.writeHead(200); res.end();
    } else {
      res.writeHead(405); res.end();
    }
  });

  const host = process.env.HTTP_HOST || '0.0.0.0';
  await new Promise((resolve) => httpServer.listen(port, host, resolve));
  log(`HTTP server ready on port ${port} (${host})`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[orchestrator] ${msg}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  log('loading tools from downstream servers...');
  await loadDownstreamTools();

  const rawPort  = process.env.HTTP_PORT || process.env.PORT;
  const httpPort = rawPort ? parseInt(rawPort, 10) : null;

  if (httpPort) {
    await startHttp(httpPort);
  } else {
    const server    = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('stdio ready');
  }
})();
