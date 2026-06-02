#!/usr/bin/env node
'use strict';

/**
 * site-builder-server.js
 *
 * Express server that wraps the static site-builder.html with:
 *   GET  /               → serves exports/site-builder.html
 *   GET  /api/sites      → searchable list of all Solutio sites
 *   GET  /api/outlines   → standard Gantry outline options
 *   POST /api/deploy     → applies a composite YAML to a live site via gantry-mcp
 *   POST /api/rebuild    → re-runs build-site-builder.js to regenerate the HTML
 *
 * Port: SITE_BUILDER_PORT env var (default 18303)
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { execSync, spawn } = require('child_process');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ROOT          = __dirname;
const EXPORTS_DIR   = path.join(ROOT, 'exports');
const HTML_FILE     = path.join(EXPORTS_DIR, 'site-builder.html');
const FTP_SITES     = path.join(ROOT, '../joomla-mcp/ftp-sites.json');

const PORT         = Number(process.env.SITE_BUILDER_PORT || 18303);
const GANTRY_URL   = process.env.GANTRY_MCP_URL || 'http://127.0.0.1:9301/mcp';

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Static: serve exports/ directory (section shots, CSS) ────────────────────
app.use(express.static(EXPORTS_DIR));

// ── Main page ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (!fs.existsSync(HTML_FILE)) {
    return res.status(503).send(
      '<h2>Site builder not yet generated.</h2>' +
      '<p>Run <code>node build-site-builder.js</code> in the gantry-mcp directory, then refresh.</p>'
    );
  }
  res.sendFile(HTML_FILE);
});

// ── API: site list ─────────────────────────────────────────────────────────────
app.get('/api/sites', (req, res) => {
  try {
    const raw   = JSON.parse(fs.readFileSync(FTP_SITES, 'utf8'));
    const q     = (req.query.q || '').toLowerCase();
    const sites = Object.keys(raw)
      .map(domain => ({
        domain,
        url:   `https://${domain}`,
        slug:  domain.replace('.solutiosoftware.com', ''),
        label: domain.replace('.solutiosoftware.com', '').replace(/-/g, ' '),
      }))
      .filter(s => !q || s.slug.includes(q) || s.label.includes(q))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    res.json(sites);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: outline list ──────────────────────────────────────────────────────────
app.get('/api/outlines', (req, res) => {
  res.json([
    { id: '33',      label: 'Parish Home (outline 33)',      type: 'parish' },
    { id: '72',      label: 'School Home (outline 72)',       type: 'school' },
    { id: 'default', label: 'Default Outline',                type: 'default' },
  ]);
});

// ── API: deploy composite YAML to a live site ─────────────────────────────────
app.post('/api/deploy', async (req, res) => {
  const { yaml: yamlContent, siteUrl, outlineId, dryRun = false } = req.body;

  if (!yamlContent)  return res.status(400).json({ error: 'yaml is required' });
  if (!siteUrl)      return res.status(400).json({ error: 'siteUrl is required' });
  if (!outlineId)    return res.status(400).json({ error: 'outlineId is required' });

  let client;
  try {
    client = new Client({ name: 'site-builder', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(GANTRY_URL));
    await client.connect(transport);

    const result = await client.callTool({
      name: 'gantry_layout_import',
      arguments: {
        site:    siteUrl,
        outline: String(outlineId),
        input:   yamlContent,
        dryRun:  Boolean(dryRun),
      },
    });

    client.close().catch(() => {});

    const text = result?.content?.[0]?.text || 'Done.';
    res.json({ success: true, message: text });

  } catch (err) {
    if (client) client.close().catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── API: rebuild the site-builder HTML ────────────────────────────────────────
app.post('/api/rebuild', (req, res) => {
  const script = path.join(ROOT, 'build-site-builder.js');
  if (!fs.existsSync(script)) {
    return res.status(404).json({ error: 'build-site-builder.js not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const child = spawn('node', [script], { cwd: ROOT });

  child.stdout.on('data', d => res.write(`data: ${d.toString().trim()}\n\n`));
  child.stderr.on('data', d => res.write(`data: [stderr] ${d.toString().trim()}\n\n`));
  child.on('close', code => {
    res.write(`data: BUILD ${code === 0 ? 'COMPLETE' : 'FAILED (exit ' + code + ')'}\n\n`);
    res.end();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`[site-builder] Server ready on http://0.0.0.0:${PORT}\n`);
  process.stderr.write(`[site-builder] HTML: ${HTML_FILE}\n`);
  process.stderr.write(`[site-builder] Gantry MCP: ${GANTRY_URL}\n`);
});
