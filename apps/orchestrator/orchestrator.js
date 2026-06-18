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
const kb   = require('./kb.js');

// ─── Config ───────────────────────────────────────────────────────────────────

const ORCHESTRATOR_TOKEN = process.env.ORCHESTRATOR_TOKEN || '';

// ─── Downstream registry ──────────────────────────────────────────────────────
// Routing is config-driven: config/downstreams.json (optional) overrides these
// defaults. `inject` names the argument that carries the active site on every
// call — 'site_url' (joomla-mcp, ftp-mcp), 'site' (gantry-mcp), or null for
// servers that need no site context (freshdesk-mcp).
// Order matters: the first server whose tool map contains a tool name wins, so
// the single-purpose servers come before joomla-mcp during migration overlap.
// Per-server URL/token env vars (e.g. FTP_MCP_URL, FTP_MCP_TOKEN — label
// uppercased, dashes → underscores) override both defaults and the JSON file.

const DEFAULT_DOWNSTREAMS = [
  { label: 'freshdesk-mcp', url: 'http://host.docker.internal:9303/mcp', inject: null },
  { label: 'ftp-mcp',       url: 'http://host.docker.internal:9304/mcp', inject: 'site_url' },
  { label: 'joomla-mcp',    url: 'http://host.docker.internal:9300/mcp', inject: 'site_url' },
  { label: 'gantry-mcp',    url: 'http://host.docker.internal:9301/mcp', inject: 'site' },
  { label: 'agents-mcp',    url: 'http://host.docker.internal:9305/mcp', inject: 'site_url' },
];

function loadDownstreams() {
  const cfgPath = path.join(__dirname, '..', '..', 'config', 'downstreams.json');
  let defs = DEFAULT_DOWNSTREAMS;
  if (fs.existsSync(cfgPath)) {
    try {
      defs = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      log(`WARNING: failed to parse config/downstreams.json, using defaults - ${err.message}`);
    }
  }
  return defs.map(d => {
    const envPrefix = d.label.toUpperCase().replace(/-/g, '_');
    return {
      label:  d.label,
      url:    process.env[`${envPrefix}_URL`]   || d.url,
      token:  process.env[`${envPrefix}_TOKEN`] || d.token || '',
      inject: d.inject !== undefined ? d.inject : 'site_url',
      toolMap: new Map(), // tool name → tool definition
    };
  });
}

const DOWNSTREAMS = loadDownstreams();

function getDownstream(label) {
  return DOWNSTREAMS.find(d => d.label === label);
}

// ─── User registry ────────────────────────────────────────────────────────────
// config/users.json maps bearer tokens → { user, agent }.
// If the file is absent, falls back to the single ORCHESTRATOR_TOKEN env var.

const USERS_JSON_PATH = path.join(__dirname, '..', '..', 'config', 'users.json');

function loadUsersRegistry() {
  if (!fs.existsSync(USERS_JSON_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(USERS_JSON_PATH, 'utf8'));
  } catch (err) {
    log(`WARNING: failed to parse config/users.json - ${err.message}`);
    return null;
  }
}

let usersRegistry = loadUsersRegistry();

// Resolve an inbound Authorization header → session context { user, agent }.
// Returns null if the token is invalid (caller should 401).
function resolveSessionContext(authHeader) {
  const provided = (authHeader || '').startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (usersRegistry) {
    const entry = usersRegistry[provided];
    if (!entry) return null;
    return { user: entry.user, agent: entry.agent || 'super_shannon' };
  }

  // Fallback: single-token mode (no users.json)
  if (ORCHESTRATOR_TOKEN && provided !== ORCHESTRATOR_TOKEN) return null;
  return { user: 'local', agent: 'super_shannon' };
}

// ─── Session state ────────────────────────────────────────────────────────────
// activeSiteUrl lives inside buildServer() — each HTTP session gets its own.

// ─── Agent definitions ────────────────────────────────────────────────────────
// config/agents/<name>.json bundles tool allow/deny + doc allow + instruction path.
// Falls back to unrestricted super_shannon scope when the file is missing.

const AGENTS_CONFIG_DIR = path.join(__dirname, '..', '..', 'config', 'agents');

function loadAgentDef(agentName) {
  // Try flat: config/agents/<name>.json, then subfolder: config/agents/<name>/<name>.json
  let defPath = path.join(AGENTS_CONFIG_DIR, `${agentName}.json`);
  if (!fs.existsSync(defPath)) defPath = path.join(AGENTS_CONFIG_DIR, agentName, `${agentName}.json`);
  if (!fs.existsSync(defPath)) {
    log(`WARNING: no agent definition found for '${agentName}', defaulting to super_shannon scope`);
    return { name: agentName, tools: { allow: ['*'] }, docs: { allow: ['*'] } };
  }
  try {
    const def = JSON.parse(fs.readFileSync(defPath, 'utf8'));
    def._dir = path.dirname(defPath);
    return def;
  } catch (err) {
    log(`WARNING: failed to parse config/agents/${agentName}.json - ${err.message}`);
    return { name: agentName, tools: { allow: ['*'] }, docs: { allow: ['*'] } };
  }
}

function listAvailableAgents() {
  if (!fs.existsSync(AGENTS_CONFIG_DIR)) return [];
  const results = [];
  const seen = new Set();
  function addJson(jsonPath) {
    try {
      const def = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const name = def.name || path.basename(jsonPath, '.json');
      if (seen.has(name)) return;
      seen.add(name);
      results.push({ name, description: def.description || '' });
    } catch { /* skip */ }
  }
  for (const entry of fs.readdirSync(AGENTS_CONFIG_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      addJson(path.join(AGENTS_CONFIG_DIR, entry.name));
    } else if (entry.isDirectory()) {
      const sub = path.join(AGENTS_CONFIG_DIR, entry.name, `${entry.name}.json`);
      if (fs.existsSync(sub)) addJson(sub);
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Hidden tools ─────────────────────────────────────────────────────────────
// joomla_login is internal plumbing — the orchestrator calls it automatically
// via set_active_site and on auth error recovery. Hiding it prevents the AI
// from calling it directly, which would bypass activeSiteUrl tracking.
// Enforced in both ListTools (filtered from the list) and CallTool (blocked by name).

const HIDDEN_JOOMLA_TOOLS = new Set(['joomla_login']);

// ─── Global tool policy ───────────────────────────────────────────────────────
// config/tool-policy.json — globalDeny array blocks tools across ALL agents.
// Re-read on every ListTools/CallTool request so edits take effect without restart.
// Per-agent deny lists live in config/agents/<name>.json under tools.deny.

const TOOL_POLICY_PATH = path.join(__dirname, '..', '..', 'config', 'tool-policy.json');

function loadGlobalPolicy() {
  try {
    const policy = JSON.parse(fs.readFileSync(TOOL_POLICY_PATH, 'utf8'));
    return {
      globalDeny: Array.isArray(policy.globalDeny) ? policy.globalDeny : [],
      toolRules:  (policy.toolRules && typeof policy.toolRules === 'object') ? policy.toolRules : {},
    };
  } catch {
    return { globalDeny: [], toolRules: {} };
  }
}

// Own tools that every agent can call regardless of agent definition.
// These implement the session protocol and changelog discipline; they are not
// configurable via agent JSON. Everything else goes through scope enforcement.
const MANDATORY_OWN_TOOLS = new Set([
  'set_active_site', 'get_active_site',
  'get_site_notes', 'append_site_note', 'write_site_notes',
  'gantry_reconnect', 'reload_tools',
  'get_agent_instructions', 'read_agent_doc',
  'get_current_agent', 'switch_agent',
]);

// ─── Downstream clients ───────────────────────────────────────────────────────
// We create a fresh MCP client per call rather than holding a persistent
// connection. Persistent StreamableHTTP connections time out after inactivity
// and don't auto-reconnect, which makes the proxy flaky. Fresh-per-call is
// slightly slower (one extra round-trip for initialize) but always reliable.

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
 * Call a tool on a downstream server (registry entry).
 * Creates a fresh client, calls the tool, then closes cleanly.
 * Retries once automatically on any transport/connection error.
 *
 * agents-mcp tools run LLM agentic loops that can take several minutes.
 * We raise the timeout to 10 min and enable resetTimeoutOnProgress so
 * that each progress notification emitted by agents-mcp resets the clock.
 */
async function callDownstream(ds, toolName, toolArgs) {
  const isAgentCall = ds.label === 'agents-mcp';
  const callOptions = isAgentCall
    ? { timeout: 600_000, resetTimeoutOnProgress: true, maxTotalTimeout: 900_000 }
    : undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let client;
    try {
      client = await createClient(ds.label, ds.url, ds.token);
      const result = await client.callTool({ name: toolName, arguments: toolArgs }, undefined, callOptions);
      client.close().catch(() => {});
      return result;
    } catch (err) {
      if (client) client.close().catch(() => {});
      if (attempt === 2) throw err;
      log(`${ds.label} call failed (attempt ${attempt}), retrying - ${err.message}`);
    }
  }
}

/** Refresh one downstream's tool map. Throws on connection failure. */
async function loadToolMap(ds) {
  const client = await createClient(ds.label, ds.url, ds.token);
  const { tools = [] } = await client.listTools();
  client.close().catch(() => {});
  ds.toolMap.clear();
  tools.forEach(t => ds.toolMap.set(t.name, t));
  log(`loaded ${ds.toolMap.size} tools from ${ds.label}`);
}

async function loadDownstreamTools() {
  await Promise.all(DOWNSTREAMS.map(ds =>
    loadToolMap(ds).catch(err => log(`WARNING: could not load ${ds.label} tools - ${err.message}`))
  ));
}

/** Find the registry entry that owns a tool name (first match wins). */
function findToolDownstream(name) {
  return DOWNSTREAMS.find(d => d.toolMap.has(name));
}

/**
 * Call a downstream tool and parse its text payload.
 * Throws when the downstream reports isError; returns parsed JSON (or the raw
 * text when not JSON) otherwise.
 */
async function callDownstreamParsed(ds, toolName, toolArgs) {
  const result = await callDownstream(ds, toolName, toolArgs);
  const text = result?.content?.[0]?.text || '';
  if (result?.isError) throw new Error(text || `${toolName} failed`);
  try { return JSON.parse(text); } catch { return text; }
}

// ─── Composite tool: FTP → Gantry CSS smoke test ─────────────────────────────
// Validates the full pipeline: FTP upload → Gantry Page Settings link → live
// page emission. Spans ftp-mcp and gantry-mcp, so it lives in the orchestrator
// rather than in either downstream server (replaces the old gantry-mcp tool
// that opened its own MCP client to joomla-mcp for ftp_* calls).

async function runCssAssetSmokeTest(site, args) {
  site = (site || '').replace(/\/+$/, '');
  const targetPath = args.targetPath || '/';
  const filename = args.remoteFilename || 'smoke-test.css';
  const cleanup = !!args.cleanup;
  const steps = [];
  const ftp = getDownstream('ftp-mcp');
  const gantry = getDownstream('gantry-mcp');

  // Step 1: FTP config — resolve upload_path and public URL
  let uploadPath = null;
  let publicUrl = null;
  try {
    const conf = await callDownstreamParsed(ftp, 'ftp_site_config', { site_url: site });
    const d = (conf && conf.data && typeof conf.data === 'object') ? conf.data : conf;
    uploadPath = (d && d.upload_path) ? d.upload_path : null;
    const pubUrl = ((d && d.pub_url) ? d.pub_url : '').replace(/\/$/, '');
    publicUrl = pubUrl ? `${pubUrl}/${filename}` : `${site}/images/pub/${filename}`;
    steps.push({ step: 'ftp_config', ok: !!uploadPath, uploadPath, publicUrl });
    if (!uploadPath) return { pass: false, steps };
  } catch (e) {
    steps.push({ step: 'ftp_config', ok: false, error: e.message });
    return { pass: false, steps };
  }

  // Step 2: upload sentinel CSS file
  try {
    const remotePath = uploadPath.replace(/\/$/, '') + '/' + filename;
    const up = await callDownstreamParsed(ftp, 'ftp_upload_file', {
      site_url: site,
      path: remotePath,
      content: '/* gantry css smoke test -- safe to delete */\n',
    });
    if (up && up.success === false) throw new Error(up.message || 'upload failed');
    steps.push({ step: 'ftp_upload', ok: true, remotePath });
  } catch (e) {
    steps.push({ step: 'ftp_upload', ok: false, error: e.message });
    return { pass: false, steps };
  }

  // Step 3: detect which outline serves the target page
  let outlineId = null;
  try {
    const det = await callDownstreamParsed(gantry, 'gantry_get_outline_for_page', { site, path: targetPath });
    outlineId = det && det.outlineId;
    if (!outlineId) throw new Error('No outline-N class found in page body -- is this a Gantry 5 page?');
    steps.push({ step: 'detect_outline', ok: true, outlineId, outlineTitle: (det && det.title) || null });
  } catch (e) {
    steps.push({ step: 'detect_outline', ok: false, error: e.message });
    return { pass: false, steps };
  }

  // Step 4: link the file into that outline's Page Settings
  try {
    await callDownstreamParsed(gantry, 'gantry_page_asset_files_edit', {
      site,
      outline: String(outlineId),
      cssActions: [{ action: 'add', item: { name: 'smoke-test', location: publicUrl, priority: '0' } }],
    });
    steps.push({ step: 'link_asset', ok: true, outline: outlineId, assetUrl: publicUrl });
  } catch (e) {
    steps.push({ step: 'link_asset', ok: false, error: e.message });
    return { pass: false, steps };
  }

  // Step 5: verify the stylesheet is emitted on the live page
  let emitted = false;
  try {
    const url = targetPath.startsWith('http')
      ? targetPath
      : site + (targetPath.startsWith('/') ? '' : '/') + targetPath;
    const res = await fetch(url, { redirect: 'follow' });
    const html = await res.text();
    emitted = html.includes(filename);
    steps.push({ step: 'verify_emission', ok: emitted, searched: filename, emitted });
  } catch (e) {
    steps.push({ step: 'verify_emission', ok: false, error: e.message });
  }

  // Step 6: cleanup (optional) — remove the asset row; FTP file is left in place
  if (cleanup && emitted) {
    try {
      await callDownstreamParsed(gantry, 'gantry_page_asset_files_edit', {
        site,
        outline: String(outlineId),
        cssActions: [{ action: 'remove', location: publicUrl }],
      });
      steps.push({ step: 'cleanup', ok: true, removed: publicUrl });
    } catch (e) {
      steps.push({ step: 'cleanup', ok: false, error: e.message });
    }
  }

  return { pass: emitted && steps.every(s => s.ok !== false), steps };
}

// ─── Server builder ───────────────────────────────────────────────────────────

function buildServer(sessionCtx) {
  const { user = 'local', agent = 'super_shannon' } = sessionCtx || {};
  let currentAgent = agent;
  let agentDef = loadAgentDef(agent);
  let activeSiteUrl = null;

  const server = new Server(
    { name: 'orchestrator', version: '1.0.0' },
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
    // Re-read the agent definition from disk so per-agent scope edits
    // (tools.allow/deny/rules, docs.allow) take effect without a session
    // restart — matching the hot-reload of the global policy below.
    agentDef = loadAgentDef(currentAgent);

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
      (() => {
        const availableDocs = kb.listDocs(agentDef);
        return {
          name: 'read_agent_doc',
          description:
            'Read any workflow guide or KB article referenced in the agent instructions. ' +
            'Use this whenever the session protocol says to read a doc — it works for agents ' +
            'that do not have the repository mounted locally. ' +
            'Pass the doc name exactly as listed (e.g. "editing-rules", "kb/staff-grid"). ' +
            `Available docs: ${availableDocs.join(', ')}.`,
          inputSchema: {
            type: 'object',
            properties: {
              doc: {
                type: 'string',
                enum: availableDocs,
                description: 'Doc name to read',
              },
            },
            required: ['doc'],
          },
        };
      })(),
      {
        name: 'get_agent_instructions',
        description:
          'REQUIRED — call this immediately after get_active_site confirms the active site. ' +
          'Returns the full AGENTS.md file: the master session protocol, workflow guide index, ' +
          'KB article index, tool reference, and all mandatory conventions. ' +
          'Any agent that does not have this repository mounted locally MUST call this tool ' +
          'to obtain the complete operating instructions before doing any work.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_current_agent',
        description:
          'Return the current agent scope name, its description, and all available agents ' +
          'that can be switched to with switch_agent.',
        inputSchema: { type: 'object', properties: {} },
      },
      (() => {
        const agents = listAvailableAgents();
        const agentNames = agents.map(a => a.name);
        return {
          name: 'switch_agent',
          description:
            'Switch to a different agent scope for this session. ' +
            'Changes which tools and docs are available without reconnecting. ' +
            `Current agent: ${currentAgent}. ` +
            `Available: ${agentNames.join(', ')}.`,
          inputSchema: {
            type: 'object',
            properties: {
              agent: {
                type: 'string',
                enum: agentNames,
                description: 'Agent name to switch to',
              },
            },
            required: ['agent'],
          },
        };
      })(),
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
      {
        name: 'gantry_css_asset_smoke_test',
        description:
          'End-to-end smoke test for the FTP to Gantry CSS pipeline. Uploads a sentinel CSS file via FTP, ' +
          "detects which outline is serving the target page, links the file into that outline's Page Settings, " +
          'and verifies the stylesheet is emitted on the live page. Returns a structured pass/fail result for ' +
          'each step. Use before any custom page build or after a server migration to confirm the pipeline works. ' +
          'Runs against the active site.',
        inputSchema: {
          type: 'object',
          properties: {
            targetPath: {
              type: 'string',
              description: 'Frontend path to test against, e.g. "/" or "/about-us".',
            },
            remoteFilename: {
              type: 'string',
              description: 'Filename for the sentinel CSS file, e.g. "smoke-test.css". Defaults to "smoke-test.css".',
            },
            cleanup: {
              type: 'boolean',
              description: 'If true, remove the asset row from Page Settings after a successful test. The FTP file is left in place. Defaults to false.',
            },
          },
          required: ['targetPath'],
        },
      },
    ];

    const { globalDeny } = loadGlobalPolicy();

    // Filter own tools: mandatory tools always included; others checked against global deny then agent scope
    const filteredOwnTools = ownTools.filter(
      t => MANDATORY_OWN_TOOLS.has(t.name) ||
           (!kb.isGloballyDenied(t.name, globalDeny) && kb.isToolAllowed(agentDef, t.name))
    );

    // Aggregate downstream tools in registry order; first server to expose a
    // name wins (handles freshdesk/ftp overlap with joomla-mcp during migration).
    const seen = new Set(filteredOwnTools.map(t => t.name));
    const downstreamTools = [];
    for (const ds of DOWNSTREAMS) {
      for (const t of ds.toolMap.values()) {
        if (HIDDEN_JOOMLA_TOOLS.has(t.name) || seen.has(t.name)) continue;
        if (kb.isGloballyDenied(t.name, globalDeny)) continue;
        if (!kb.isToolAllowed(agentDef, t.name)) continue;
        seen.add(t.name);
        downstreamTools.push(t);
      }
    }

    return { tools: [...filteredOwnTools, ...downstreamTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Re-read the agent definition so per-agent scope/rule edits apply mid-session.
    agentDef = loadAgentDef(currentAgent);

    // ── Own tools ──

    if (name === 'set_active_site') {
      activeSiteUrl = args.url;

      // Auto-login: immediately prime the joomla-mcp session for this site.
      // This avoids the first tool call failing because no session exists yet.
      // We fire-and-forget (non-fatal if it fails - credentials may not be set).
      let loginNote = '';
      try {
        const loginResult = await callDownstream(
          getDownstream('joomla-mcp'),
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
          text: `Active site set to: ${activeSiteUrl}${loginNote}\n\nNEXT STEP (required): Call get_agent_instructions to load the full session protocol and workflow guide index. Then call get_site_notes to review site history before making any changes.`,
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
          ? `\n${note.trim()}\n_Logged by: ${user}_\n`
          : `\n**[${new Date().toISOString().replace('T', ' ').substring(0, 16)} UTC | ${user}]** ${note.trim()}\n`;
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
      const gantry = getDownstream('gantry-mcp');
      let msg = '';
      try {
        // Pass a force-refresh hint via a no-op style tool call
        await callDownstream(gantry, 'gantry_outlines_list', { site: activeSiteUrl });
        msg = 'Gantry session is alive and responding.';
      } catch (e) {
        msg = `Gantry session appears stale (${e.message}). Reloading tool map…`;
      }
      // Always reload the tool map on reconnect
      try {
        await loadToolMap(gantry);
        msg += ` Tool map reloaded (${gantry.toolMap.size} tools).`;
      } catch (e) {
        msg += ` Tool map reload failed: ${e.message}`;
      }
      return { content: [{ type: 'text', text: msg }] };
    }

    if (name === 'reload_tools') {
      await loadDownstreamTools();
      usersRegistry = loadUsersRegistry();
      const counts = DOWNSTREAMS.map(d => `${d.label}: ${d.toolMap.size} tools`).join(', ');
      // Notify the client to re-fetch its tool list so newly loaded downstream
      // tools (joomla-mcp, gantry-mcp) become callable without a session restart.
      try { server.notification({ method: 'notifications/tools/list_changed' }); } catch { /* best-effort */ }
      return {
        content: [{
          type: 'text',
          text: `Tools reloaded - ${counts}. User registry: ${usersRegistry ? Object.keys(usersRegistry).length + ' token(s)' : 'not found (single-token fallback)'}.`,
        }],
      };
    }

    if (name === 'read_agent_doc') {
      const doc = args.doc;
      if (!doc) {
        return { isError: true, content: [{ type: 'text', text: 'doc is required' }] };
      }
      try {
        return { content: [{ type: 'text', text: kb.readDoc(agentDef, doc) }] };
      } catch (err) {
        if (err.code === 'PERMISSION_DENIED') {
          return { isError: true, content: [{ type: 'text', text: err.message }] };
        }
        if (err.code === 'NOT_FOUND') {
          const available = kb.listDocs(agentDef).join(', ');
          return { isError: true, content: [{ type: 'text', text: `${err.message}. Available docs: ${available}` }] };
        }
        throw err;
      }
    }

    if (name === 'get_agent_instructions') {
      try {
        return { content: [{ type: 'text', text: kb.readInstructions(agentDef) }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: err.message }] };
      }
    }

    if (name === 'get_current_agent') {
      const agents = listAvailableAgents();
      const lines = agents.map(a =>
        `- **${a.name}**${a.name === currentAgent ? ' ← current' : ''}: ${a.description}`
      );
      return {
        content: [{
          type: 'text',
          text: `Current agent: **${currentAgent}**\n\n**Available agents:**\n${lines.join('\n')}`,
        }],
      };
    }

    if (name === 'switch_agent') {
      const targetAgent = args.agent;
      if (!targetAgent) {
        return { isError: true, content: [{ type: 'text', text: 'agent is required' }] };
      }
      let defPath = path.join(AGENTS_CONFIG_DIR, `${targetAgent}.json`);
      if (!fs.existsSync(defPath)) defPath = path.join(AGENTS_CONFIG_DIR, targetAgent, `${targetAgent}.json`);
      if (!fs.existsSync(defPath)) {
        const available = listAvailableAgents().map(a => a.name).join(', ');
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown agent: '${targetAgent}'. Available: ${available}` }],
        };
      }
      currentAgent = targetAgent;
      agentDef = loadAgentDef(targetAgent);
      log(`session switched agent: ${user} → ${currentAgent}`);
      return {
        content: [{
          type: 'text',
          text: `Switched to agent: **${currentAgent}**\n${agentDef.description || ''}\n\nCall ListTools to see the updated tool and doc set.`,
        }],
      };
    }

    // ── Guard: hidden tools cannot be called by name ──
    // Internal plumbing (joomla_login) — blocked for every agent ahead of scope
    // and own-tool routing.
    if (HIDDEN_JOOMLA_TOOLS.has(name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool '${name}' is internal and cannot be called directly.` }],
      };
    }

    // ── Guard: globally disabled tools ──
    // Re-read each call so config/tool-policy.json edits apply without restart.
    // Checked before agent scope so the "currently disabled" hint isn't masked
    // by a per-agent "not available" message, and so it covers own scoped tools.
    const { globalDeny: callGlobalDeny, toolRules } = loadGlobalPolicy();
    if (kb.isGloballyDenied(name, callGlobalDeny)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool '${name}' is currently disabled. Check config/tool-policy.json to re-enable it.` }],
      };
    }

    // ── Agent scope enforcement ───────────────────────────────────────────────
    // Mandatory own tools (handled above) always pass. All remaining tool calls —
    // own scoped tools (solutio_*) and all downstream tools — are checked against
    // the session's agent definition before routing.
    if (!kb.isToolAllowed(agentDef, name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Tool '${name}' is not available to the '${currentAgent}' agent.` }],
      };
    }

    if (name === 'solutio_style_guide') {
      const section = args.section || 'full';
      const content = section === 'full' ? STYLE_GUIDE : (SECTIONS[section] || STYLE_GUIDE);
      return { content: [{ type: 'text', text: content }] };
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
      try {
        return { content: [{ type: 'text', text: kb.readDoc(agentDef, 'gantry-design-agent') }] };
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `Design workflow guide unavailable: ${err.message}` }] };
      }
    }

    // ── Composite: FTP → Gantry CSS smoke test ──
    // Lives in the orchestrator because it spans two downstream servers
    // (ftp-mcp for upload, gantry-mcp for outline/asset work). This replaces
    // the old gantry-mcp tool that opened its own MCP client to joomla-mcp —
    // the suite's one tool-to-tool dependency.
    if (name === 'gantry_css_asset_smoke_test') {
      if (!activeSiteUrl) {
        return { isError: true, content: [{ type: 'text', text: 'No active site is set. Please call set_active_site with the site URL before using any tools.' }] };
      }
      const result = await runCssAssetSmokeTest(activeSiteUrl, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: !result.pass };
    }

    // ── Guard: tool-level argument rules ──
    // Tool is visible and allowed; this blocks only specific argument values
    // (e.g. creating certain menu item types) per global + per-agent rules.
    const ruleViolation = kb.checkToolRules(agentDef, name, args, toolRules);
    if (ruleViolation) {
      return { isError: true, content: [{ type: 'text', text: ruleViolation }] };
    }

    // ── Route downstream via the registry ──
    let ds = findToolDownstream(name);

    // Lazy reload: a downstream may have started after us (startup race) or
    // been restarted with new tools. If the name is unknown and any tool map
    // is empty, refresh those maps once and re-check.
    if (!ds && DOWNSTREAMS.some(d => d.toolMap.size === 0)) {
      log(`tool ${name} unknown and some tool maps empty — lazy reloading…`);
      await Promise.all(DOWNSTREAMS.filter(d => d.toolMap.size === 0).map(d =>
        loadToolMap(d).catch(err => log(`lazy reload of ${d.label} failed: ${err.message}`))
      ));
      ds = findToolDownstream(name);
    }

    if (!ds) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }

    // ── Servers with inject: null need no active site (e.g. freshdesk-mcp) ──
    if (ds.inject === null) {
      try {
        return await callDownstream(ds, name, args);
      } catch (err) {
        return { isError: true, content: [{ type: 'text', text: `${ds.label} error: ${err.message}` }] };
      }
    }

    // ── Guard: site must be set before routing site-scoped tools ──
    if (!activeSiteUrl) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'No active site is set. Please call set_active_site with the site URL before using any tools.',
        }],
      };
    }

    const dsArgs = { ...args, [ds.inject]: activeSiteUrl };
    try {
      return await callDownstream(ds, name, dsArgs);
    } catch (err) {
      // joomla-mcp auth error → re-login and retry once
      if (ds.label === 'joomla-mcp' && /401|403|login|csrf|cookie|session/i.test(err.message)) {
        log(`joomla-mcp auth error, re-logging in and retrying: ${err.message}`);
        try { await callDownstream(ds, 'joomla_login', { site_url: activeSiteUrl }); } catch {}
        try {
          return await callDownstream(ds, name, dsArgs);
        } catch (err2) {
          return { isError: true, content: [{ type: 'text', text: `joomla-mcp error (after re-login): ${err2.message}` }] };
        }
      }
      // Transport/connection error - callDownstream already retried once.
      // Refresh this server's tool map so the next call sees fresh data.
      log(`${ds.label} transport error on ${name}, reloading tool map: ${err.message}`);
      loadToolMap(ds).catch(() => {});
      return { isError: true, content: [{ type: 'text', text: `${ds.label} error: ${err.message}` }] };
    }
  });

  return server;
}

// ─── HTTP transport ───────────────────────────────────────────────────────────

async function startHttp(port) {
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    // ── CORS - must be set on every response including errors ─────────────────
    res.setHeader('Access-Control-Allow-Origin',  process.env.CORS_ORIGIN || 'http://localhost');
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

    // ── Auth: resolve session context from bearer token ───────────────────────
    const sessionCtx = resolveSessionContext(req.headers['authorization'] || '');
    if (sessionCtx === null) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    // ── end auth ──────────────────────────────────────────────────────────────

    const urlPath = new URL(req.url, `http://localhost:${port}`).pathname;
    if (urlPath !== '/mcp') { res.writeHead(404); res.end(); return; }

    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST') {
      let transport = sessions.get(sessionId);
      if (!transport) {
        const server = buildServer(sessionCtx);
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
    const server    = buildServer({ user: 'local', agent: 'super_shannon' });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('stdio ready');
  }
})();
