#!/usr/bin/env node
'use strict';

const express = require('express');
const jsyaml  = require('js-yaml');
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const ROOT        = __dirname;
const EXPORTS_DIR = path.join(ROOT, 'exports');
const HTML_FILE   = path.join(EXPORTS_DIR, 'site-builder.html');
const FTP_SITES   = path.join(ROOT, '../joomla-mcp/ftp-sites.json');

const PORT        = Number(process.env.SITE_BUILDER_PORT || 18303);
const GANTRY_URL  = process.env.GANTRY_MCP_URL  || 'http://127.0.0.1:9301/mcp';
const JOOMLA_URL  = process.env.JOOMLA_MCP_URL  || 'http://127.0.0.1:9300/mcp';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(EXPORTS_DIR));

// ── helpers ───────────────────────────────────────────────────────────────────

async function mcpClient(url) {
  const client = new Client({ name: 'site-builder', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result?.content?.[0]?.text || '';
  // Many joomla-mcp tools return JSON strings
  try { return JSON.parse(text); } catch { return text; }
}

// Extract domain from a site URL  (https://foo.solutiosoftware.com/ → foo.solutiosoftware.com)
function domainOf(siteUrl) {
  try { return new URL(siteUrl).hostname; } catch { return siteUrl; }
}

// ── Main page ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  if (!fs.existsSync(HTML_FILE))
    return res.status(503).send('<h2>Site builder not yet generated.</h2><p>Run <code>node build-site-builder.js</code>, then refresh.</p>');
  res.sendFile(HTML_FILE);
});

// ── API: site list ─────────────────────────────────────────────────────────────
app.get('/api/sites', (req, res) => {
  try {
    const raw = JSON.parse(fs.readFileSync(FTP_SITES, 'utf8'));
    const q   = (req.query.q || '').toLowerCase();
    const sites = Object.keys(raw)
      .map(domain => ({
        domain,
        url:   'https://' + domain,
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
    { id: '33',      label: 'Parish Home (outline 33)',  type: 'parish'  },
    { id: '72',      label: 'School Home (outline 72)',  type: 'school'  },
    { id: 'default', label: 'Default Outline',           type: 'default' },
  ]);
});

// ── API: deploy ───────────────────────────────────────────────────────────────
app.post('/api/deploy', async (req, res) => {
  const { yaml: yamlContent, siteUrl, outlineId, dryRun = false,
          css: cssContent, cssBase } = req.body;

  if (!yamlContent) return res.status(400).json({ error: 'yaml is required' });
  if (!siteUrl)     return res.status(400).json({ error: 'siteUrl is required' });
  if (!outlineId)   return res.status(400).json({ error: 'outlineId is required' });

  // Parse YAML -> layout array
  let layoutArray;
  try {
    const doc = jsyaml.load(yamlContent);
    if (!doc || !Array.isArray(doc.layout))
      throw new Error('No top-level layout array in YAML');
    layoutArray = doc.layout;
  } catch (parseErr) {
    return res.status(400).json({ error: 'YAML parse error: ' + parseErr.message });
  }

  const steps = [];
  let gantry, joomla;

  try {
    // ── Step 1: import layout ──────────────────────────────────────────────────
    gantry = await mcpClient(GANTRY_URL);
    const importResult = await callTool(gantry, 'gantry_layout_import', {
      site:    siteUrl,
      outline: String(outlineId),
      layout:  layoutArray,
      dryRun:  Boolean(dryRun),
    });
    steps.push('[LAYOUT] ' + (typeof importResult === 'string'
      ? importResult
      : (importResult?.message || (importResult?.imported ? 'Imported OK' : JSON.stringify(importResult)))));

    // ── Step 2: CSS upload + page settings ────────────────────────────────────
    if (cssContent) {
      const domain    = domainOf(siteUrl);
      const cssFile   = 'site-builder-composite.css';
      const marker    = '<!-- site-builder-css -->';
      const endMarker = '<!-- /site-builder-css -->';

      if (dryRun) {
        steps.push('[CSS DRY RUN] Would upload ' + cssFile + ' via FTP and link in page[head][head_bottom] for ' + domain);
      } else {
        // 2a. Get FTP config to find pub_path / pub_url
        joomla = await mcpClient(JOOMLA_URL);
        let pubPath = '/home/' + domain.split('.')[0] + '/public_html/images/pub';
        let pubUrl  = 'https://' + domain + '/images/pub';

        try {
          const ftpConf = await callTool(joomla, 'ftp_site_config', { domain });
          if (ftpConf && typeof ftpConf === 'object') {
            // upload_path is the FTP write-user's allowed directory — prefer it over pub_path
            // which is the read-user's filesystem path and may differ.
            if (ftpConf.upload_path) pubPath = ftpConf.upload_path;
            else if (ftpConf.pub_path) pubPath = ftpConf.pub_path;
            if (ftpConf.pub_url) pubUrl = ftpConf.pub_url.replace(/\/$/, '');
          }
        } catch (e) {
          steps.push('[CSS WARN] Could not read ftp_site_config (' + e.message + ') — using default paths');
        }

        const remotePath = pubPath.replace(/\/$/, '') + '/' + cssFile;
        const cssUrl     = pubUrl + '/' + cssFile;

        // 2b. Upload CSS via FTP (write user)
        const uploadResult = await callTool(joomla, 'ftp_upload_file', {
          domain,
          path:    remotePath,
          content: cssContent,
        });
        const uploadMsg = typeof uploadResult === 'string'
          ? uploadResult
          : (uploadResult?.message || JSON.stringify(uploadResult));
        const uploadOk = uploadResult?.success !== false &&
                         !uploadMsg.toLowerCase().includes('refused') &&
                         !uploadMsg.toLowerCase().includes('failed') &&
                         !uploadMsg.toLowerCase().includes('error');
        steps.push('[CSS UPLOAD] ' + remotePath + (uploadOk ? ' — OK' : ' — FAILED: ' + uploadMsg));

        if (!uploadOk) {
          steps.push('[CSS SKIP] Page settings not updated because upload failed.');
          // Skip page settings update — jump to closing
        } else {
        // 2c. Get current page head_bottom, replace/inject site-builder link
        let headBottom = '';
        try {
          const pageList = await callTool(gantry, 'gantry_page_list', {
            site:    siteUrl,
            outline: String(outlineId),
          });
          // gantry_page_list returns a flat map of field->value
          const fields = typeof pageList === 'object' ? pageList : {};
          headBottom = fields['page[head][head_bottom]'] || '';
        } catch (e) {
          steps.push('[CSS WARN] Could not read current page settings: ' + e.message);
        }

        // Strip any previous site-builder block, then append fresh one
        const linkTag = '<link rel="stylesheet" href="' + cssUrl + '?v=' + Date.now() + '">';
        const block   = marker + '\n' + linkTag + '\n' + endMarker;
        const re      = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                                   '[\\s\\S]*?' +
                                   endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const newHeadBottom = re.test(headBottom)
          ? headBottom.replace(re, block)
          : (headBottom ? headBottom.trimEnd() + '\n' + block : block);

        // 2d. Save page settings
        const pageEditResult = await callTool(gantry, 'gantry_page_edit', {
          site:    siteUrl,
          outline: String(outlineId),
          edits:   { 'page[head][head_bottom]': newHeadBottom },
        });
        steps.push('[CSS LINKED] ' + cssUrl + ' → page[head][head_bottom]');
        } // end uploadOk
      }
    }

    if (gantry) gantry.close().catch(() => {});
    if (joomla) joomla.close().catch(() => {});

    res.json({ success: true, message: steps.join('\n') });

  } catch (err) {
    if (gantry) gantry.close().catch(() => {});
    if (joomla) joomla.close().catch(() => {});
    res.status(500).json({ success: false, error: err.message, steps });
  }
});

// ── API: rebuild ──────────────────────────────────────────────────────────────

// -- API: presets --
const PRESETS_FILE = path.join(EXPORTS_DIR, 'presets.json');
function readPresets() {
  try { return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')); } catch { return []; }
}
function writePresets(list) {
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(list, null, 2));
}
app.get('/api/presets', (req, res) => { res.json(readPresets()); });
app.post('/api/presets', (req, res) => {
  const { name, slots, parishName } = req.body;
  if (!name)  return res.status(400).json({ error: 'name is required' });
  if (!slots) return res.status(400).json({ error: 'slots is required' });
  const list = readPresets();
  const idx  = list.findIndex(p => p.name === name);
  const entry = { name, parishName: parishName || '', slots, savedAt: new Date().toISOString() };
  if (idx >= 0) list[idx] = entry; else list.unshift(entry);
  writePresets(list);
  res.json({ saved: true, name });
});
app.delete('/api/presets/:name', (req, res) => {
  const name = decodeURIComponent(req.params.name);
  const list = readPresets().filter(p => p.name !== name);
  writePresets(list);
  res.json({ deleted: true, name });
});

app.post('/api/rebuild', (req, res) => {
  const script = path.join(ROOT, 'build-site-builder.js');
  if (!fs.existsSync(script)) return res.status(404).json({ error: 'build-site-builder.js not found' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();
  const child = spawn('node', [script], { cwd: ROOT });
  child.stdout.on('data', d => res.write('data: ' + d.toString().trim() + '\n\n'));
  child.stderr.on('data', d => res.write('data: [stderr] ' + d.toString().trim() + '\n\n'));
  child.on('close', code => {
    res.write('data: BUILD ' + (code === 0 ? 'COMPLETE' : 'FAILED (exit ' + code + ')') + '\n\n');
    res.end();
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  process.stderr.write('[site-builder] ready on http://0.0.0.0:' + PORT + '\n');
  process.stderr.write('[site-builder] Gantry MCP: ' + GANTRY_URL + '\n');
  process.stderr.write('[site-builder] Joomla MCP: ' + JOOMLA_URL + '\n');
});
