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
    const layoutMsg = typeof importResult === 'string'
      ? importResult
      : (importResult?.message || (importResult?.imported ? 'Imported OK' : JSON.stringify(importResult)));
    if (/error|failed|refused/i.test(layoutMsg) && !importResult?.imported) {
      throw new Error('Layout import failed: ' + layoutMsg);
    }
    steps.push('[LAYOUT] ' + layoutMsg);

    // ── Step 2: CSS upload + page settings ────────────────────────────────────
    if (cssContent) {
      const domain    = domainOf(siteUrl);
      const cssFile   = '_template.css';
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
                    // ftp_site_config returns { data: { upload_path, pub_path, pub_url } }
          const ftpData = (ftpConf?.data && typeof ftpConf.data === 'object') ? ftpConf.data : ftpConf;
          if (ftpData && typeof ftpData === 'object') {
            if (ftpData.upload_path && !String(ftpData.upload_path).includes('not set'))
              pubPath = ftpData.upload_path;
            else if (ftpData.pub_path) pubPath = ftpData.pub_path;
            if (ftpData.pub_url) pubUrl = ftpData.pub_url.replace(/\/$/, '');
          }
        } catch (e) {
          steps.push('[CSS WARN] Could not read ftp_site_config (' + e.message + ') — using default paths');
        }

        const remotePath = pubPath.replace(/\/$/, '') + '/' + cssFile;
        // Use a root-relative path so the link works regardless of domain
        let pubWebPath = pubUrl;
        try { pubWebPath = new URL(pubUrl).pathname; } catch (_) {}
        const cssUrl     = pubWebPath.replace(/\/$/, '') + '/' + cssFile;

        // 2b. Upload CSS via FTP (write user)
        try { await callTool(joomla, 'ftp_mkdir', { domain, path: pubPath.replace(/\/$/, '') }); } catch (_) { /* may exist */ }
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
        // 2c. Get current page head_bottom, prepend/replace site-builder link
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

        // Strip any previous site-builder block, then prepend fresh one at top
        const linkTag = '<link rel="stylesheet" href="' + cssUrl + '">';
        const block   = marker + '\n' + linkTag + '\n' + endMarker;
        const re      = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                                   '[\\s\\S]*?' +
                                   endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const newHeadBottom = re.test(headBottom)
          ? headBottom.replace(re, block)
          : (headBottom ? block + '\n' + headBottom.trimStart() : block);

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


// ── API: deploy-with-content ──────────────────────────────────────────────────
//
// Like /api/deploy but first creates categories + articles on the target site,
// remaps old IDs in the YAML to the new IDs, then imports the layout.
//
// Body: { yaml, siteUrl, outlineId, dryRun?, css?, cssBase?, variantContent }
// variantContent: [
//   { sectionId, sourceId,
//     particles: { [particleId]: { articles:[...], categories:[...] } } }
// ]

app.post('/api/deploy-with-content', async (req, res) => {
  const { yaml: yamlContent, siteUrl, outlineId, dryRun = false,
          css: cssContent, cssBase, variantContent = [] } = req.body;

  if (!yamlContent) return res.status(400).json({ error: 'yaml is required' });
  if (!siteUrl)     return res.status(400).json({ error: 'siteUrl is required' });
  if (!outlineId)   return res.status(400).json({ error: 'outlineId is required' });

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

  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

  function walkParticles(nodes, visitor) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (n.type === 'particle') visitor(n);
      if (Array.isArray(n.children)) walkParticles(n.children, visitor);
    }
  }

  function remapIds(idStr, idMap) {
    if (!idStr) return idStr;
    return idStr.split(',').map(id => idMap[id.trim()] || id.trim()).join(',');
  }

  try {
    joomla = await mcpClient(JOOMLA_URL);

    // ── Build particle content index ────────────────────────────────────────────
    const particleIndex = {};
    for (const vc of variantContent) {
      for (const [particleId, pdata] of Object.entries(vc.particles || {})) {
        if (!particleIndex[particleId]) particleIndex[particleId] = { articles: [], categories: [] };
        const ex = particleIndex[particleId];
        for (const art of (pdata.articles  || [])) { if (!ex.articles.find(a => a.id === art.id)) ex.articles.push(art); }
        for (const cat of (pdata.categories || [])) { if (!ex.categories.find(c => c.id === cat.id)) ex.categories.push(cat); }
      }
    }

    // ── Collect unique categories needed ────────────────────────────────────────
    const catTitleToOldIds = {};
    const catOldToNew = {};

    for (const pdata of Object.values(particleIndex)) {
      for (const cat of pdata.categories) {
        (catTitleToOldIds[cat.title] ||= []).push(cat.id);
      }
      for (const art of pdata.articles) {
        if (art.categoryTitle && art.categoryId)
          (catTitleToOldIds[art.categoryTitle] ||= []).push(art.categoryId);
      }
    }
    for (const title of Object.keys(catTitleToOldIds))
      catTitleToOldIds[title] = [...new Set(catTitleToOldIds[title])];

    const totalArts = Object.values(particleIndex).reduce((n, p) => n + p.articles.length, 0);
    steps.push(`[CONTENT] ${Object.keys(catTitleToOldIds).length} categories, ${totalArts} articles to create`);

    if (!dryRun) {
      // Log in to the target site before any write operations
      const loginResult = await callTool(joomla, 'joomla_login', { site_url: siteUrl });
      const loginOk = loginResult?.success !== false &&
        !(String(loginResult?.message || '')).toLowerCase().includes('failed');
      steps.push(`[LOGIN] ${siteUrl} — ${loginOk ? 'OK' : (loginResult?.message || JSON.stringify(loginResult))}`);
      if (!loginOk) throw new Error('Login failed: ' + (loginResult?.message || JSON.stringify(loginResult)));
    }

    if (dryRun) {
      for (const title of Object.keys(catTitleToOldIds))
        steps.push(`[DRY RUN] Would create category: "${title}"`);
      for (const [particleId, pdata] of Object.entries(particleIndex))
        for (const art of pdata.articles)
          steps.push(`[DRY RUN] Would create article: "${art.title}" (cat: "${art.categoryTitle}") → particle ${particleId}`);
    } else {
      // ── Find-or-create categories ────────────────────────────────────────────────
      // Search first — avoids duplicates and works even when post-create
      // verification fails (forge sites, unusual admin layouts).
      async function findOrCreateCategory(title, oldIds) {
        const search1 = await callTool(joomla, 'joomla_list_categories', {
          extension: 'com_content', search: title,
        });
        const match1 = (search1?.data || []).find(
          c => String(c.title || '').trim().toLowerCase() === title.trim().toLowerCase()
        );
        if (match1) {
          const id = String(match1.id);
          for (const oldId of oldIds) catOldToNew[oldId] = id;
          steps.push(`[CATEGORY] Existing "${title}" → ID ${id}`);
          return;
        }
        // Not found — create it
        await callTool(joomla, 'joomla_create_category', { title, extension: 'com_content' });
        // Search again to get the real ID (bypasses broken internal verification)
        const search2 = await callTool(joomla, 'joomla_list_categories', {
          extension: 'com_content', search: title,
        });
        const match2 = (search2?.data || []).find(
          c => String(c.title || '').trim().toLowerCase() === title.trim().toLowerCase()
        );
        if (match2) {
          const id = String(match2.id);
          for (const oldId of oldIds) catOldToNew[oldId] = id;
          steps.push(`[CATEGORY] Created "${title}" → ID ${id}`);
        } else {
          steps.push(`[CATEGORY WARN] "${title}": created but could not retrieve ID`);
        }
      }
      for (const [title, oldIds] of Object.entries(catTitleToOldIds)) {
        try { await findOrCreateCategory(title, oldIds); }
        catch (err) { steps.push(`[CATEGORY WARN] "${title}": ${err.message}`); }
      }

      // ── Find-or-create articles ──────────────────────────────────────────────────
      const artOldToNew = {};
      for (const [particleId, pdata] of Object.entries(particleIndex)) {
        artOldToNew[particleId] = {};
        for (const art of pdata.articles) {
          const catId = catOldToNew[art.categoryId] || art.categoryId || '';
          try {
            // 1. Search for existing article by exact title
            const search1 = await callTool(joomla, 'joomla_article', {
              action: 'list', search: art.title,
            });
            const match1 = (search1?.data || []).find(
              a => String(a.title || '').trim().toLowerCase() === art.title.trim().toLowerCase()
            );
            if (match1) {
              const newId = String(match1.id);
              artOldToNew[particleId][art.id] = newId;
              // Update the existing article's content to match the section's canonical HTML
              const articleContent = [art.introtext || '', art.fulltext || ''].filter(Boolean).join('\n');
              if (articleContent) {
                try {
                  await callTool(joomla, 'joomla_article', {
                    action:  'update',
                    id:      newId,
                    content: articleContent,
                  });
                  steps.push(`[ARTICLE] Updated "${art.title}" (ID ${newId}) with section content [${particleId}]`);
                } catch (updateErr) {
                  steps.push(`[ARTICLE] Found "${art.title}" → ID ${newId} (update failed: ${updateErr.message}) [${particleId}]`);
                }
              } else {
                steps.push(`[ARTICLE] Existing "${art.title}" → ID ${newId} [${particleId}]`);
              }
              continue;
            }
            // 2. Create it
            const articleContent = [art.introtext || '', art.fulltext || ''].filter(Boolean).join('\n');
            await callTool(joomla, 'joomla_article', {
              action:     'create',
              title:      art.title,
              // alias omitted — Joomla auto-generates from title, avoids alias conflicts
              categoryId: catId,
              content:    articleContent,
              state:      String(Number(art.state)  || 1),
              access:     String(Number(art.access) || 1),
            });
            // 3. Search again for real ID
            const search2 = await callTool(joomla, 'joomla_article', {
              action: 'list', search: art.title,
            });
            const match2 = (search2?.data || []).find(
              a => String(a.title || '').trim().toLowerCase() === art.title.trim().toLowerCase()
            );
            if (match2) {
              const newId = String(match2.id);
              artOldToNew[particleId][art.id] = newId;
              steps.push(`[ARTICLE] Created "${art.title}" cat=${catId} → ID ${newId} [${particleId}]`);
            } else {
              steps.push(`[ARTICLE WARN] "${art.title}" [${particleId}]: created but could not retrieve ID`);
            }
          } catch (err) {
            steps.push(`[ARTICLE WARN] "${art.title}" [${particleId}]: ${err.message}`);
          }
        }
      }

      // ── Patch layout IDs ─────────────────────────────────────────────────────
      const patchedLayout = deepClone(layoutArray);
      let patchCount = 0;
      walkParticles(patchedLayout, node => {
        const pid    = node.id || '';
        const filter = node.attributes?.article?.filter;
        if (!filter) return;
        if (filter.categories) {
          const p = remapIds(String(filter.categories), catOldToNew);
          if (p !== String(filter.categories)) { filter.categories = p; patchCount++; }
        }
        if (filter.articles && artOldToNew[pid]) {
          const p = remapIds(String(filter.articles), artOldToNew[pid]);
          if (p !== String(filter.articles)) { filter.articles = p; patchCount++; }
        }
      });
      steps.push(`[PATCH] Remapped ${patchCount} filter(s)`);
      layoutArray = patchedLayout;
    }

    if (joomla) { joomla.close().catch(() => {}); joomla = null; }

    // ── Import patched layout ────────────────────────────────────────────────────
    gantry = await mcpClient(GANTRY_URL);
    const importResult = await callTool(gantry, 'gantry_layout_import', {
      site: siteUrl, outline: String(outlineId), layout: layoutArray, dryRun: Boolean(dryRun),
    });
    const layoutMsg = typeof importResult === 'string'
      ? importResult
      : (importResult?.message || (importResult?.imported ? 'Imported OK' : JSON.stringify(importResult)));
    if (/error|failed|refused/i.test(layoutMsg) && !importResult?.imported) {
      throw new Error('Layout import failed: ' + layoutMsg);
    }
    steps.push('[LAYOUT] ' + layoutMsg);

    // ── CSS (mirrors /api/deploy logic) ──────────────────────────────────────────
    if (cssContent) {
      const domain    = domainOf(siteUrl);
      const cssFile   = '_template.css';
      const marker    = '<!-- site-builder-css -->';
      const endMarker = '<!-- /site-builder-css -->';
      if (dryRun) {
        steps.push('[CSS DRY RUN] Would upload and link ' + domain + '/images/pub/' + cssFile);
      } else {
        // Reuse existing joomla client (already logged in), or open a new one if closed
        if (!joomla) joomla = await mcpClient(JOOMLA_URL);
        let pubPath = '/home/' + domain.split('.')[0] + '/public_html/images/pub';
        let pubUrl  = 'https://' + domain + '/images/pub';
        try {
          const ftpConf = await callTool(joomla, 'ftp_site_config', { domain });
                    // ftp_site_config returns { data: { upload_path, pub_path, pub_url } }
          const ftpData = (ftpConf?.data && typeof ftpConf.data === 'object') ? ftpConf.data : ftpConf;
          if (ftpData && typeof ftpData === 'object') {
            if (ftpData.upload_path && !String(ftpData.upload_path).includes('not set'))
              pubPath = ftpData.upload_path;
            else if (ftpData.pub_path) pubPath = ftpData.pub_path;
            if (ftpData.pub_url) pubUrl = ftpData.pub_url.replace(/\/$/, '');
          }
        } catch (e) { steps.push('[CSS WARN] ' + e.message); }
        const remotePath = pubPath.replace(/\/$/, '') + '/' + cssFile;
        // Use a root-relative path so the link works regardless of domain
        let pubWebPath = pubUrl;
        try { pubWebPath = new URL(pubUrl).pathname; } catch (_) {}
        const cssUrl     = pubWebPath.replace(/\/$/, '') + '/' + cssFile;
        try { await callTool(joomla, 'ftp_mkdir', { domain, path: pubPath.replace(/\/$/, '') }); } catch (_) { /* may exist */ }
        const uploadResult = await callTool(joomla, 'ftp_upload_file', {
          domain, path: remotePath, content: cssContent,
        });
        const uploadMsg = typeof uploadResult === 'string'
          ? uploadResult : (uploadResult?.message || JSON.stringify(uploadResult));
        const uploadOk = uploadResult?.success !== false &&
          !uploadMsg.toLowerCase().includes('refused') &&
          !uploadMsg.toLowerCase().includes('failed') &&
          !uploadMsg.toLowerCase().includes('error');
        steps.push('[CSS UPLOAD] ' + remotePath + (uploadOk ? ' — OK' : ' — FAILED: ' + uploadMsg));
        if (uploadOk) {
          let headBottom = '';
          try {
            const pageList = await callTool(gantry, 'gantry_page_list', {
              site: siteUrl, outline: String(outlineId),
            });
            headBottom = (typeof pageList === 'object' ? pageList : {})['page[head][head_bottom]'] || '';
          } catch (e) { /* ignore */ }
          const linkTag = '<link rel="stylesheet" href="' + cssUrl + '">';
          const block   = marker + '\n' + linkTag + '\n' + endMarker;
          const re      = new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                                     '[\\s\\S]*?' +
                                     endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          const newHeadBottom = re.test(headBottom)
            ? headBottom.replace(re, block)
            : (headBottom ? block + '\n' + headBottom.trimStart() : block);
          await callTool(gantry, 'gantry_page_edit', {
            site: siteUrl, outline: String(outlineId),
            edits: { 'page[head][head_bottom]': newHeadBottom },
          });
          steps.push('[CSS LINKED] ' + cssUrl);
        }
      }
    }

    if (gantry) gantry.close().catch(() => {});
    if (joomla)  joomla.close().catch(() => {});
    res.json({ success: true, message: steps.join('\n') });

  } catch (err) {
    if (gantry) gantry.close().catch(() => {});
    if (joomla)  joomla.close().catch(() => {});
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
