#!/usr/bin/env node
'use strict';

/**
 * build-site-builder.js
 *
 * Reads every parish home outline YAML in exports/home-outlines/ and emits a
 * self-contained drag-and-drop SECTION COMPOSER at exports/site-builder.html.
 *
 * Concept:
 *   - Every top-level section (#g-navigation, #g-slideshow, #g-utility, …) from
 *     every exported parish becomes a reusable "section variant".
 *   - The right-hand palette groups variants by section id.
 *   - The build column has one slot per canonical section, in Gantry order.
 *   - Drag a variant onto its slot to fill it. Mix navigation from parish A,
 *     slideshow from parish B, expanded content from parish C, etc.
 *   - Export the assembled composite as a YAML ready for `gantry layout import`.
 *
 * Run:  node build-site-builder.js
 * Then open exports/site-builder.html
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'exports', 'home-outlines');
const CSS_DIR = path.join(ROOT, 'exports', 'override-css');
const OUT_FILE = path.join(ROOT, 'exports', 'site-builder.html');
const SHOTS_MANIFEST = path.join(ROOT, 'exports', 'section-shots', 'manifest.json');

if (!fs.existsSync(SRC_DIR)) {
  console.error(`Source directory not found: ${SRC_DIR}`);
  process.exit(1);
}

// --- Optional: section screenshots (run capture-sections.js to generate) ---
// shotLookup[parishId][sectionId] = path relative to the site-builder.html file
const shotLookup = {};
if (fs.existsSync(SHOTS_MANIFEST)) {
  try {
    const shots = JSON.parse(fs.readFileSync(SHOTS_MANIFEST, 'utf8'));
    for (const rec of shots) {
      shotLookup[rec.site] = {};
      for (const [sid, relPath] of Object.entries(rec.sections || {})) {
        if (!relPath) continue;
        // manifest stores paths relative to ROOT (e.g. "exports/section-shots/x/nav.png");
        // site-builder.html lives in exports/, so strip the leading "exports/".
        shotLookup[rec.site][sid] = String(relPath).replace(/^exports[\/\\]/, '');
      }
    }
    const shotCount = Object.values(shotLookup).reduce(
      (a, b) => a + Object.keys(b).length,
      0
    );
    console.log(`Found ${shotCount} section screenshots in section-shots/manifest.json`);
  } catch (err) {
    console.warn(`Could not read section-shots manifest: ${err.message}`);
  }
} else {
  console.log('(no section-shots/manifest.json — run capture-sections.js for real thumbnails)');
}

// --- Optional: per-parish override.css (a composite is assembled on export) ---
// cssRaw[parishId] = raw CSS text of that parish's override.css.
// The parish id is normalised the same way the YAML source ids are, so the two
// line up (e.g. "stlaw-alex-1-home.override.css" -> "stlaw-alex").
const cssRaw = {};
if (fs.existsSync(CSS_DIR)) {
  const cssFiles = fs.readdirSync(CSS_DIR).filter((f) => f.endsWith('.css'));
  for (const f of cssFiles) {
    const parishId = f
      .replace(/-home\.override\.css$/, '')
      .replace(/\.override\.css$/, '')
      .replace(/-home\.css$/, '')
      .replace(/\.css$/, '')
      .replace(/-1$/, '');
    try {
      cssRaw[parishId] = fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
    } catch (err) {
      console.warn(`Could not read ${f}: ${err.message}`);
    }
  }
  console.log(
    `Found override.css for ${Object.keys(cssRaw).length} parishes in override-css/`
  );
} else {
  console.log('(no exports/override-css/ — composite CSS export will be unavailable)');
}

const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.yaml')).sort();
if (!files.length) {
  console.error('No .yaml files found in', SRC_DIR);
  process.exit(1);
}

// Canonical Gantry section order + which container each lives in.
const ZONES = [
  { container: 'container-top', sections: ['top', 'navigation', 'slideshow'] },
  { container: null, sections: ['header', 'above', 'feature', 'showcase', 'utility'] },
  { container: 'container-main', sections: ['sidebar', 'mainbar', 'aside'] },
  { container: null, sections: ['expanded', 'extension', 'bottom'] },
  { container: 'container-footer', sections: ['footer', 'copyright'] },
  { container: null, sections: ['offcanvas'] },
];
const SECTION_ORDER = ZONES.flatMap((z) => z.sections);

// --- Extract sections + container templates from each source ---

const sectionLibrary = {};   // sectionId -> [{ sourceId, sourceName, host, type, node, summary }]
const containerTemplates = {}; // container-top / container-main / container-footer
const sources = [];

for (const filename of files) {
  const raw = fs.readFileSync(path.join(SRC_DIR, filename), 'utf8');
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    console.error(`Skipping ${filename}: ${err.message}`);
    continue;
  }
  const sourceId = filename.replace(/-home\.yaml$/, '').replace(/-1$/, '');
  const sourceName = sourceId
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
  const host = parsed.source?.host || '';
  sources.push({ id: sourceId, name: sourceName, host });

  const layout = parsed.layout || [];
  walkExtract(layout, null);

  function walkExtract(nodes, insideContainer) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      const type = n.type;
      if (type === 'container') {
        // Save a container template (attributes only — children rebuilt on export)
        if (!containerTemplates[n.id]) {
          containerTemplates[n.id] = {
            id: n.id,
            type: 'container',
            subtype: n.subtype ?? false,
            title: n.title || n.id,
            attributes: n.attributes || {},
            inherit: {},
          };
        }
        walkExtract(n.children, n.id);
      } else if (type === 'grid' || type === 'block') {
        walkExtract(n.children, insideContainer);
      } else if (type === 'section' || type === 'offcanvas') {
        const summary = summarizeSection(n);
        (sectionLibrary[n.id] ||= []).push({
          sourceId,
          sourceName,
          host,
          type,
          node: n,
          summary,
          shot: shotLookup[sourceId]?.[n.id] || null,
        });
        // sections don't nest sections, but be safe
        // (we intentionally don't recurse into the section's own grids here)
      }
    }
  }
}

function summarizeSection(node) {
  // Collect particle rows: each grid -> [{subtype, title, size, enabled}]
  const rows = [];
  let particleCount = 0;
  const subtypes = {};
  for (const grid of node.children || []) {
    if (grid.type !== 'grid') continue;
    const row = [];
    for (const block of grid.children || []) {
      if (block.type !== 'block') continue;
      const size = Number(block.attributes?.size) || 0;
      for (const p of block.children || []) {
        if (['grid', 'block'].includes(p.type)) continue;
        const enabled = p.attributes?.enabled !== 0 && p.attributes?.enabled !== '0';
        row.push({
          type: p.type,
          subtype: p.subtype || '',
          title: p.title || `${p.type}/${p.subtype}`,
          size,
          enabled,
        });
        particleCount++;
        const key = `${p.type}/${p.subtype || '?'}`;
        subtypes[key] = (subtypes[key] || 0) + 1;
      }
    }
    if (row.length) rows.push(row);
  }
  const inherited = !!(node.inherit && Object.keys(node.inherit).length);
  return {
    rows,
    particleCount,
    subtypes,
    inherited,
    attributes: node.attributes || {},
  };
}

const libCount = Object.values(sectionLibrary).reduce((a, b) => a + b.length, 0);
console.log(
  `Loaded ${sources.length} sources, ${Object.keys(sectionLibrary).length} section ids, ${libCount} section variants.`
);

// --- Emit HTML ---

const html = renderPage();
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, html);
console.log(`Wrote ${OUT_FILE} (${html.length.toLocaleString()} bytes)`);

// =============================================================================

function renderPage() {
  const dataJs = `
const SECTION_LIBRARY = ${JSON.stringify(sectionLibrary)};
const CONTAINER_TEMPLATES = ${JSON.stringify(containerTemplates)};
const SOURCES = ${JSON.stringify(sources)};
const ZONES = ${JSON.stringify(ZONES)};
const SECTION_ORDER = ${JSON.stringify(SECTION_ORDER)};
const CSS_RAW = ${JSON.stringify(cssRaw)};
`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solutio Site Builder — Section Composer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Source+Sans+3:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js"></script>
<style>
  :root {
    --bg: #f1f5f9; --panel: #ffffff; --dark: #1e293b; --darker: #0f172a;
    --text: #1e293b; --soft: #64748b; --inv: #f8fafc; --border: #e2e8f0;
    --accent: #d97706; --accent-soft: #fef3c7; --emerald: #059669; --sky: #0ea5e9;
    --serif: 'Cormorant Garamond', Georgia, serif;
    --sans: 'Source Sans 3', system-ui, sans-serif;
    --mono: 'JetBrains Mono', ui-monospace, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; }
  body { font-family: var(--sans); color: var(--text); background: var(--bg); display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  h1,h2,h3,h4 { font-family: var(--serif); font-weight: 600; line-height: 1.15; margin: 0; }
  code, pre { font-family: var(--mono); }

  header {
    background: var(--dark); color: var(--inv);
    padding: 0.85rem 1.25rem; display: flex; align-items: center; gap: 1.5rem;
    flex-shrink: 0;
  }
  header h1 { font-size: 1.4rem; }
  header .sub { font-size: 0.82rem; opacity: 0.7; }
  header .toolbar { margin-left: auto; display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  header input, header select {
    background: #334155; color: var(--inv); border: 1px solid #475569;
    border-radius: 7px; padding: 0.4rem 0.6rem; font-family: var(--sans); font-size: 0.82rem;
  }
  header input::placeholder { color: #94a3b8; }
  .btn {
    appearance: none; border: 1px solid #475569; background: #334155; color: var(--inv);
    font-family: var(--sans); font-size: 0.82rem; font-weight: 500;
    padding: 0.4rem 0.8rem; border-radius: 7px; cursor: pointer;
  }
  .btn:hover { background: #475569; }
  .btn-accent { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-accent:hover { background: #b45309; }
  .btn-ghost { background: transparent; }

  .layout { display: flex; flex: 1; min-height: 0; }

  /* ---- build column (left, main) ---- */
  .build {
    flex: 1; overflow-y: auto; padding: 1.25rem 1.5rem 4rem;
  }
  .build-intro { color: var(--soft); font-size: 0.88rem; margin-bottom: 1rem; max-width: 70ch; }
  .zone { margin-bottom: 0.4rem; }
  .zone-label {
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--soft); font-weight: 700; margin: 0.9rem 0 0.3rem; padding-left: 0.2rem;
  }
  .slot {
    background: var(--panel); border: 1.5px dashed var(--border); border-radius: 10px;
    margin-bottom: 0.4rem; min-height: 54px; transition: border-color 0.12s, background 0.12s;
    display: flex; align-items: stretch;
  }
  .slot.dragover { border-color: var(--accent); background: var(--accent-soft); }
  .slot.filled { border-style: solid; border-color: var(--border); }
  .slot-tag {
    width: 130px; flex-shrink: 0; padding: 0.55rem 0.7rem;
    font-family: var(--mono); font-size: 0.78rem; color: var(--soft);
    border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 0.15rem;
    justify-content: center;
  }
  .slot.filled .slot-tag { color: var(--text); }
  .slot-tag .ztype { font-size: 0.62rem; opacity: 0.6; font-family: var(--sans); text-transform: uppercase; letter-spacing: 0.04em; }
  .slot-content { flex: 1; padding: 0.5rem 0.7rem; display: flex; align-items: center; gap: 0.7rem; }
  .slot-empty-hint { color: #94a3b8; font-size: 0.82rem; font-style: italic; }
  .slot-filled-info { flex: 1; display: flex; align-items: center; gap: 0.7rem; }
  .slot-filled-info .src { font-size: 0.85rem; }
  .slot-filled-info .src strong { font-weight: 600; }
  .slot-filled-info .src .host { font-family: var(--mono); font-size: 0.7rem; color: var(--soft); }
  .slot-mini { width: 180px; flex-shrink: 0; }
  .slot-actions { margin-left: auto; display: flex; gap: 0.3rem; }
  .icon-btn {
    appearance: none; border: 1px solid var(--border); background: var(--panel);
    width: 28px; height: 28px; border-radius: 7px; cursor: pointer; color: var(--soft);
    font-size: 0.9rem; display: inline-flex; align-items: center; justify-content: center;
  }
  .icon-btn:hover { background: var(--bg); color: var(--text); }

  /* ---- palette (right) ---- */
  .palette {
    width: 360px; flex-shrink: 0; background: var(--panel);
    border-left: 1px solid var(--border); overflow-y: auto; padding: 1rem 1rem 4rem;
  }
  .palette h2 { font-size: 1.1rem; margin-bottom: 0.15rem; }
  .palette .phint { color: var(--soft); font-size: 0.8rem; margin-bottom: 0.85rem; }
  .palette-search {
    width: 100%; border: 1px solid var(--border); border-radius: 7px;
    padding: 0.45rem 0.65rem; font-family: var(--sans); font-size: 0.85rem; margin-bottom: 0.75rem;
  }
  .group { border: 1px solid var(--border); border-radius: 10px; margin-bottom: 0.5rem; overflow: hidden; }
  .group-head {
    padding: 0.5rem 0.75rem; background: var(--bg); cursor: pointer;
    display: flex; align-items: center; gap: 0.5rem; user-select: none;
  }
  .group-head:hover { background: #e2e8f0; }
  .group-head .gname { font-family: var(--mono); font-size: 0.85rem; font-weight: 500; }
  .group-head .gcount {
    margin-left: auto; font-size: 0.7rem; color: var(--soft);
    background: var(--panel); border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.45rem;
  }
  .group-head .chevron { color: var(--accent); transition: transform 0.15s; }
  .group.open .group-head .chevron { transform: rotate(90deg); }
  .group-body { display: none; padding: 0.4rem; gap: 0.4rem; flex-direction: column; }
  .group.open .group-body { display: flex; }

  .variant {
    border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem;
    cursor: grab; background: var(--panel); transition: border-color 0.1s, box-shadow 0.1s;
  }
  .variant:hover { border-color: #94a3b8; box-shadow: 0 2px 8px -4px rgba(15,23,42,0.2); }
  .variant:active { cursor: grabbing; }
  .variant.dragging { opacity: 0.4; }
  .variant-head { display: flex; align-items: baseline; gap: 0.4rem; margin-bottom: 0.35rem; }
  .variant-src { font-size: 0.82rem; font-weight: 600; }
  .variant-host { font-family: var(--mono); font-size: 0.64rem; color: var(--soft); margin-left: auto; }
  .variant-badges { display: flex; gap: 0.25rem; margin-bottom: 0.3rem; flex-wrap: wrap; }
  .badge {
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700;
    padding: 0.04rem 0.4rem; border-radius: 999px;
  }
  .badge.inherit { background: #e2e8f0; color: #475569; }
  .badge.empty { background: var(--accent-soft); color: #92400e; }
  .badge.count { background: #dbeafe; color: #1e40af; }
  .badge.rehomed { background: #fae8ff; color: #86198f; }
  .mini { width: 100%; height: 64px; background: #f8fafc; border-radius: 5px; border: 1px solid var(--border); }
  .mini svg { width: 100%; height: 100%; display: block; }
  .thumb {
    width: 100%; max-height: 150px; overflow: hidden;
    border-radius: 5px; border: 1px solid var(--border); background: #f8fafc;
  }
  .thumb img { width: 100%; display: block; object-fit: cover; object-position: top; }
  .slot-mini .thumb { max-height: 88px; }

  /* ---- export modal ---- */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(15,23,42,0.6);
    display: none; align-items: center; justify-content: center; z-index: 200;
  }
  .modal-overlay.open { display: flex; }
  .modal {
    background: var(--panel); border-radius: 14px; width: min(820px, 92vw);
    max-height: 86vh; overflow: hidden; display: flex; flex-direction: column;
  }
  .modal-head { padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); display: flex; align-items: center; }
  .modal-head h2 { font-size: 1.25rem; }
  .modal-head .close { margin-left: auto; }
  .modal-body { padding: 1rem 1.25rem; overflow-y: auto; }
  .modal pre {
    background: var(--darker); color: #e2e8f0; border-radius: 8px;
    padding: 0.75rem 0.9rem; font-size: 0.74rem; line-height: 1.5;
    max-height: 50vh; overflow: auto; white-space: pre; tab-size: 2;
  }
  .modal-actions { display: flex; gap: 0.5rem; margin-top: 0.85rem; flex-wrap: wrap; }
  .summary-line { color: var(--soft); font-size: 0.85rem; margin-bottom: 0.6rem; }

  .modal-tabs { display: flex; gap: 0.25rem; padding: 0 1.25rem; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .modal-tabs .tab {
    appearance: none; border: none; background: transparent; cursor: pointer;
    font-family: var(--sans); font-size: 0.85rem; font-weight: 600; color: var(--soft);
    padding: 0.6rem 0.9rem; border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .modal-tabs .tab:hover { color: var(--text); }
  .modal-tabs .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-pane[hidden] { display: none; }
  .css-controls {
    display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.6rem;
    font-size: 0.85rem; color: var(--soft); flex-wrap: wrap;
  }
  .css-controls select {
    border: 1px solid var(--border); border-radius: 7px; padding: 0.35rem 0.5rem;
    font-family: var(--sans); font-size: 0.85rem; color: var(--text); background: var(--panel);
  }

  /* ---- deploy tab ---- */
  .deploy-form { display: flex; flex-direction: column; gap: 1rem; }
  .deploy-field { display: flex; flex-direction: column; gap: 0.3rem; }
  .deploy-field label { font-size: 0.8rem; font-weight: 600; color: var(--soft); text-transform: uppercase; letter-spacing: 0.04em; }
  .deploy-field input, .deploy-field select {
    border: 1px solid var(--border); border-radius: 7px; padding: 0.45rem 0.6rem;
    font-family: var(--sans); font-size: 0.9rem; color: var(--text); background: var(--panel);
    width: 100%;
  }
  .deploy-field input:focus, .deploy-field select:focus { outline: 2px solid var(--accent); border-color: transparent; }
  .site-results { border: 1px solid var(--border); border-radius: 7px; max-height: 160px; overflow-y: auto; margin-top: 0.25rem; }
  .site-result {
    padding: 0.45rem 0.7rem; cursor: pointer; font-size: 0.88rem;
    border-bottom: 1px solid var(--border); transition: background 0.1s;
  }
  .site-result:last-child { border-bottom: none; }
  .site-result:hover, .site-result.selected { background: var(--accent); color: #fff; }
  .deploy-status {
    border-radius: 8px; padding: 0.75rem 0.9rem; font-size: 0.85rem; line-height: 1.5;
    white-space: pre-wrap; font-family: var(--mono, monospace); margin-top: 0.5rem;
    display: none;
  }
  .deploy-status.visible { display: block; }
  .deploy-status.running { background: #1e293b; color: #94a3b8; }
  .deploy-status.ok  { background: #052e16; color: #86efac; }
  .deploy-status.err { background: #450a0a; color: #fca5a5; }
  .btn-deploy { background: #0f766e; color: #fff; }
  .btn-deploy:hover { background: #0d9488; }
  .btn-deploy:disabled { opacity: 0.5; cursor: not-allowed; }

  .toast {
    position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%);
    background: var(--darker); color: var(--inv); padding: 0.6rem 1.1rem; border-radius: 8px;
    font-size: 0.85rem; z-index: 300; opacity: 0; transition: opacity 0.2s;
  }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <div>
    <h1>Solutio Site Builder</h1>
    <div class="sub">Section composer — mix sections from any parish into one layout</div>
  </div>
  <div class="toolbar">
    <input id="parish-name" placeholder="New parish name" size="18" />
    <input id="target-host" placeholder="https://new-site.com" size="20" />
    <input id="target-outline" placeholder="outline" value="default" size="7" />
    <button class="btn btn-ghost" id="btn-reset">Reset</button>
    <button class="btn" id="btn-prefill">Prefill from a parish…</button>
    <button class="btn btn-accent" id="btn-export">Export / Deploy ▸</button>
    <button class="btn btn-ghost" id="btn-rebuild" title="Re-run build-site-builder.js to pick up new exports">↺ Rebuild</button>
  </div>
</header>

<div class="layout">
  <div class="build" id="build">
    <div class="build-intro">
      Each slot below is a Gantry section in canonical order. Drag <strong>any</strong>
      variant from the palette onto <strong>any</strong> slot — sections are re-homed
      automatically (the section's id / type / title get rewritten to match the slot it
      lands in, so e.g. a slideshow's content can become your expanded section). Mix
      freely across parishes, then export the composite — a <strong>layout YAML</strong>
      for <code>gantry layout import</code> and a matching <strong>override.css</strong>
      that pulls each section's styling from whichever parish that section came from
      (selectors re-homed to match). Empty slots are omitted (the new outline
      inherits them from its base). Double-click a variant to drop it in its original
      home slot.
    </div>
    <div id="zones"></div>
  </div>

  <aside class="palette">
    <h2>Section library</h2>
    <div class="phint">Variants pulled from ${sources.length} parish exports. Drag onto a slot.</div>
    <input class="palette-search" id="palette-search" placeholder="Filter by parish or section…" />
    <div id="groups"></div>
  </aside>
</div>

<div class="modal-overlay" id="export-modal">
  <div class="modal">
    <div class="modal-head">
      <h2>Composite export</h2>
      <button class="btn btn-ghost close" id="modal-close">✕ Close</button>
    </div>
    <div class="modal-tabs">
      <button class="tab active" data-tab="yaml">Layout YAML</button>
      <button class="tab" data-tab="css">override.css</button>
      <button class="tab" data-tab="deploy">🚀 Deploy Live</button>
    </div>
    <div class="modal-body">
      <div class="summary-line" id="export-summary"></div>

      <div class="tab-pane" data-pane="yaml">
        <pre id="export-yaml"></pre>
        <div class="modal-actions">
          <button class="btn btn-accent" id="dl-yaml">Download YAML</button>
          <button class="btn" id="dl-sh">Download apply.sh</button>
          <button class="btn" id="copy-yaml">Copy to clipboard</button>
        </div>
      </div>

      <div class="tab-pane" data-pane="css" hidden>
        <div class="css-controls">
          <label for="css-base">Shell / global CSS base:</label>
          <select id="css-base"></select>
          <span>— section CSS always travels with each section.</span>
        </div>
        <div class="summary-line" id="css-summary"></div>
        <pre id="export-css"></pre>
        <div class="modal-actions">
          <button class="btn btn-accent" id="dl-css">Download override.css</button>
          <button class="btn" id="copy-css">Copy to clipboard</button>
        </div>
      </div>

      <div class="tab-pane" data-pane="deploy" hidden>
        <div class="deploy-form">
          <div class="deploy-field">
            <label>Target site</label>
            <input type="search" id="deploy-site-search" placeholder="Search sites…" autocomplete="off" />
            <div class="site-results" id="deploy-site-results" hidden></div>
            <input type="hidden" id="deploy-site-url" />
          </div>
          <div class="deploy-field">
            <label>Outline</label>
            <select id="deploy-outline">
              <option value="">Loading…</option>
            </select>
          </div>
          <div class="deploy-field">
            <label><input type="checkbox" id="deploy-dry-run" checked /> Dry run (preview only — no changes written)</label>
          </div>
          <div class="modal-actions">
            <button class="btn btn-deploy" id="btn-deploy-live" disabled>Deploy to site ▸</button>
          </div>
          <pre class="deploy-status" id="deploy-status"></pre>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
${dataJs}

// ============================================================
//  State: which variant fills each section slot
//  filled[sectionId] = { sourceId, sourceName, host, type, node, summary }
// ============================================================
const filled = {};

// ---------- helpers ----------
function escXml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function escHtml(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function freshId(prefix){return prefix+'-'+Math.floor(1000+Math.random()*9000);}
function toast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),2200);}

// ---------- section schematic (mini SVG) ----------
function renderSectionMini(summary) {
  const W = 200, H = 64, pad = 3;
  const rows = summary.rows;
  if (!rows.length) {
    const label = summary.inherited ? 'inherits' : 'empty';
    return '<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg">'
      + '<rect x="0" y="0" width="'+W+'" height="'+H+'" fill="#f8fafc"/>'
      + '<text x="'+(W/2)+'" y="'+(H/2+3)+'" text-anchor="middle" font-family="Source Sans 3,sans-serif" font-size="9" fill="#94a3b8">'+label+'</text>'
      + '</svg>';
  }
  const rowH = (H - pad*2) / rows.length;
  const colorFor = (sub) => {
    if (/swiper|slider|rotator/.test(sub)) return '#0ea5e9';
    if (/menu/.test(sub)) return '#334155';
    if (/logo/.test(sub)) return '#1e293b';
    if (/contentarray|articles|news/.test(sub)) return '#10b981';
    if (/custom|blockcontent|simplecontent/.test(sub)) return '#d97706';
    if (/module|position/.test(sub)) return '#8b5cf6';
    if (/spacer/.test(sub)) return '#cbd5e1';
    if (/system|messages|content/.test(sub)) return '#64748b';
    return '#94a3b8';
  };
  let svg = '<svg viewBox="0 0 '+W+' '+H+'" xmlns="http://www.w3.org/2000/svg">';
  svg += '<rect x="0" y="0" width="'+W+'" height="'+H+'" fill="#f8fafc"/>';
  rows.forEach((row, ri) => {
    const y = pad + ri*rowH;
    const totalSize = row.reduce((a,b)=>a+(b.size||0),0) || row.length;
    let x = pad;
    row.forEach(p => {
      const w = ((p.size || (100/row.length)) / (totalSize||100)) * (W - pad*2);
      svg += '<rect x="'+x.toFixed(1)+'" y="'+y.toFixed(1)+'" width="'+Math.max(2,w-1).toFixed(1)+'" height="'+(rowH-1.5).toFixed(1)+'" fill="'+colorFor(p.subtype||p.type)+'" rx="1.5" opacity="'+(p.enabled?1:0.4)+'"/>';
      if (w > 28 && rowH > 9) {
        svg += '<text x="'+(x+3).toFixed(1)+'" y="'+(y+rowH/2+2).toFixed(1)+'" font-family="JetBrains Mono,monospace" font-size="6" fill="#fff">'+escXml((p.subtype||p.type).slice(0,Math.floor(w/4)))+'</text>';
      }
      x += w;
    });
  });
  svg += '</svg>';
  return svg;
}

// ============================================================
//  Build column — render slots grouped by zone
// ============================================================
function renderZones() {
  const host = document.getElementById('zones');
  host.innerHTML = ZONES.map(zone => {
    const zlabel = zone.container
      ? zone.container.replace('container-', '') + ' container'
      : 'root sections';
    const slots = zone.sections.map(sid => renderSlot(sid, zone)).join('');
    return '<div class="zone"><div class="zone-label">'+escHtml(zlabel)+'</div>'+slots+'</div>';
  }).join('');
  // wire drag targets
  host.querySelectorAll('.slot').forEach(slot => {
    slot.addEventListener('dragover', e => { e.preventDefault(); slot.classList.add('dragover'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('dragover'));
    slot.addEventListener('drop', e => {
      e.preventDefault(); slot.classList.remove('dragover');
      const payload = e.dataTransfer.getData('text/plain');
      if (!payload) return;
      const [origSectionId, sourceId] = payload.split('|');
      const targetSlot = slot.dataset.section;
      const variant = (SECTION_LIBRARY[origSectionId]||[]).find(v => v.sourceId === sourceId);
      if (!variant) return;
      // Any variant into any slot — the section is re-homed on export.
      filled[targetSlot] = variant;
      renderZones();
      if (variant.node.id !== targetSlot) {
        toast(variant.node.id + ' from ' + variant.sourceName + ' → re-homed as ' + targetSlot);
      }
    });
  });
  host.querySelectorAll('[data-clear]').forEach(btn => {
    btn.addEventListener('click', () => { delete filled[btn.dataset.clear]; renderZones(); });
  });
}

function renderSlot(sectionId, zone) {
  const variant = filled[sectionId];
  const available = (SECTION_LIBRARY[sectionId]||[]).length;
  const ztype = zone.container ? zone.container.replace('container-','') : 'root';
  let content;
  if (variant) {
    const rehomed = variant.node.id !== sectionId;
    content = '<div class="slot-filled-info">'
      + '<div class="slot-mini">'+renderThumb(variant)+'</div>'
      + '<div class="src"><strong>'+escHtml(variant.sourceName)+'</strong>'
      + (rehomed ? ' <span class="badge rehomed">was '+escHtml(variant.node.id)+'</span>' : '')
      + '<div class="host">'+escHtml(variant.host)+'</div>'
      + '<div style="font-size:0.72rem;color:var(--soft)">'+variant.summary.particleCount+' particles · '
      + variant.summary.rows.length+' rows'+(variant.summary.inherited?' · inherits':'')+'</div>'
      + '</div>'
      + '<div class="slot-actions"><button class="icon-btn" data-clear="'+sectionId+'" title="Clear">✕</button></div>'
      + '</div>';
  } else {
    content = '<div class="slot-empty-hint">'
      + (available ? 'drag a '+sectionId+' variant here ('+available+' available)' : 'no variants exported for this section')
      + '</div>';
  }
  return '<div class="slot'+(variant?' filled':'')+'" data-section="'+sectionId+'">'
    + '<div class="slot-tag">'+escHtml(sectionId)+'<span class="ztype">'+escHtml(ztype)+'</span></div>'
    + '<div class="slot-content">'+content+'</div>'
    + '</div>';
}

// ============================================================
//  Palette — groups of section variants
// ============================================================
function renderGroups(filter) {
  const q = (filter||'').toLowerCase().trim();
  const host = document.getElementById('groups');
  // Order groups by canonical section order
  const ids = Object.keys(SECTION_LIBRARY).sort(
    (a,b) => SECTION_ORDER.indexOf(a) - SECTION_ORDER.indexOf(b)
  );
  host.innerHTML = ids.map(sid => {
    let variants = SECTION_LIBRARY[sid];
    if (q) {
      variants = variants.filter(v =>
        sid.toLowerCase().includes(q) ||
        v.sourceName.toLowerCase().includes(q) ||
        v.host.toLowerCase().includes(q)
      );
      if (!variants.length) return '';
    }
    const cards = variants.map(v => renderVariant(sid, v)).join('');
    const openClass = q ? ' open' : '';
    return '<div class="group'+openClass+'" data-group="'+sid+'">'
      + '<div class="group-head"><span class="chevron">▸</span>'
      + '<span class="gname">'+escHtml(sid)+'</span>'
      + '<span class="gcount">'+variants.length+'</span></div>'
      + '<div class="group-body">'+cards+'</div>'
      + '</div>';
  }).join('');
  // wire group toggles
  host.querySelectorAll('.group-head').forEach(h => {
    h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
  });
  // wire drag sources
  host.querySelectorAll('.variant').forEach(card => {
    card.addEventListener('dragstart', e => {
      card.classList.add('dragging');
      e.dataTransfer.setData('text/plain', card.dataset.section + '|' + card.dataset.source);
      e.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    // double-click to fill directly
    card.addEventListener('dblclick', () => {
      const sid = card.dataset.section, srcId = card.dataset.source;
      const v = (SECTION_LIBRARY[sid]||[]).find(x => x.sourceId === srcId);
      if (v) { filled[sid] = v; renderZones(); toast('Filled '+sid+' from '+v.sourceName); }
    });
  });
}

// Real screenshot if capture-sections.js produced one; otherwise the SVG schematic.
function renderThumb(v) {
  if (v.shot) {
    return '<div class="thumb"><img src="' + escHtml(v.shot) + '" loading="lazy" alt="'
      + escHtml(v.sourceName + ' ' + v.type) + '" /></div>';
  }
  return '<div class="mini">' + renderSectionMini(v.summary) + '</div>';
}

function renderVariant(sectionId, v) {
  const s = v.summary;
  const badges = [];
  if (s.inherited) badges.push('<span class="badge inherit">inherits</span>');
  if (!s.inherited && s.particleCount === 0) badges.push('<span class="badge empty">empty</span>');
  if (s.particleCount) badges.push('<span class="badge count">'+s.particleCount+' particles</span>');
  if (v.shot) badges.push('<span class="badge count" style="background:#dcfce7;color:#166534">photo</span>');
  return '<div class="variant" draggable="true" data-section="'+sectionId+'" data-source="'+escHtml(v.sourceId)+'" title="Double-click to fill, or drag onto the slot">'
    + '<div class="variant-head"><span class="variant-src">'+escHtml(v.sourceName)+'</span>'
    + '<span class="variant-host">'+escHtml(v.host.replace(/^https?:\\/\\//,''))+'</span></div>'
    + '<div class="variant-badges">'+badges.join('')+'</div>'
    + renderThumb(v)
    + '</div>';
}

// ============================================================
//  Assemble composite layout
// ============================================================
function wrapSection(node) {
  return {
    id: freshId('grid'), type: 'grid', subtype: false, title: 'Untitled',
    attributes: {}, inherit: {},
    children: [{
      id: freshId('block'), type: 'block', subtype: false, title: 'Untitled',
      attributes: { size: 100 }, inherit: {},
      children: [node],
    }],
  };
}

// Re-home a variant's section node into a target slot: deep-clone, then rewrite
// id / type / title so the section is valid wherever it was dropped.
function rehomeNode(variant, slotId) {
  const node = JSON.parse(JSON.stringify(variant.node));
  node.id = slotId;
  node.type = slotId === 'offcanvas' ? 'offcanvas' : 'section';
  node.subtype = node.type === 'offcanvas' ? 'offcanvas' : 'section';
  node.title = slotId.charAt(0).toUpperCase() + slotId.slice(1);
  return node;
}

function assembleLayout() {
  const layout = [];
  for (const zone of ZONES) {
    const present = zone.sections.filter(s => filled[s]);
    if (!present.length) continue;
    if (zone.container) {
      const tmpl = CONTAINER_TEMPLATES[zone.container] || {
        id: zone.container, type: 'container', subtype: false,
        title: zone.container, attributes: {}, inherit: {},
      };
      layout.push({
        id: tmpl.id, type: 'container', subtype: tmpl.subtype ?? false,
        title: tmpl.title, attributes: tmpl.attributes || {}, inherit: {},
        children: present.map(sid => wrapSection(rehomeNode(filled[sid], sid))),
      });
    } else {
      for (const sid of present) layout.push(rehomeNode(filled[sid], sid));
    }
  }
  return layout;
}

function buildExportDoc() {
  const parish = document.getElementById('parish-name').value.trim();
  const host = document.getElementById('target-host').value.trim();
  return {
    schema: 1,
    source: {
      builtBy: 'Solutio Site Builder — section composer',
      parish: parish || null,
      host: host || null,
      composedFrom: Object.entries(filled).map(([sid, v]) =>
        sid + ' ← ' + v.sourceId + (v.node.id !== sid ? ' (re-homed from ' + v.node.id + ')' : '')
      ),
    },
    exportedAt: new Date().toISOString(),
    layout: assembleLayout(),
  };
}

// ============================================================
//  override.css — parse each parish's CSS, attribute every rule
//  to a section by its #g-<id> selectors, then reassemble a
//  composite that pulls each section's CSS from wherever that
//  section came from (re-homing #g-<orig> -> #g-<slot> as needed).
// ============================================================

// Walk past a quoted string starting at p (css[p] is the quote). Returns index
// just after the closing quote.
function skipCssString(css, p) {
  const q = css[p]; p++;
  while (p < css.length) {
    if (css[p] === '\\\\') { p += 2; continue; }
    if (css[p] === q) { p++; break; }
    p++;
  }
  return p;
}

// Given css[openIdx] === '{', return the index of the matching '}'.
function matchCssBrace(css, openIdx) {
  let depth = 0, p = openIdx;
  while (p < css.length) {
    const c = css[p];
    if (c === '/' && css[p+1] === '*') {
      const e = css.indexOf('*/', p+2); p = e === -1 ? css.length : e+2; continue;
    }
    if (c === '"' || c === "'") { p = skipCssString(css, p); continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return p; }
    p++;
  }
  return css.length - 1;
}

// Tokenise a CSS string into top-level items: rule / atrule / atrule-statement
// / comment / junk. Handles nested braces, strings and comments.
function tokenizeCss(css) {
  const items = [];
  let i = 0; const n = css.length;
  while (i < n) {
    while (i < n && /\\s/.test(css[i])) i++;
    if (i >= n) break;

    // comment
    if (css[i] === '/' && css[i+1] === '*') {
      const e = css.indexOf('*/', i+2);
      const stop = e === -1 ? n : e + 2;
      items.push({ type: 'comment', raw: css.slice(i, stop) });
      i = stop; continue;
    }

    // at-rule
    if (css[i] === '@') {
      let name = '', k = i + 1;
      while (k < n && /[a-zA-Z-]/.test(css[k])) { name += css[k]; k++; }
      let p = i, brace = -1, semi = -1;
      while (p < n) {
        const c = css[p];
        if (c === '/' && css[p+1] === '*') {
          const e = css.indexOf('*/', p+2); p = e === -1 ? n : e+2; continue;
        }
        if (c === '"' || c === "'") { p = skipCssString(css, p); continue; }
        if (c === '{') { brace = p; break; }
        if (c === ';') { semi = p; break; }
        p++;
      }
      if (brace !== -1 && (semi === -1 || brace < semi)) {
        const prelude = css.slice(i + 1 + name.length, brace).trim();
        const end = matchCssBrace(css, brace);
        items.push({
          type: 'atrule', name: name.toLowerCase(), prelude,
          inner: css.slice(brace + 1, end), raw: css.slice(i, end + 1),
        });
        i = end + 1;
      } else if (semi !== -1) {
        items.push({ type: 'atrule-statement', name: name.toLowerCase(), raw: css.slice(i, semi + 1) });
        i = semi + 1;
      } else {
        items.push({ type: 'atrule-statement', name: name.toLowerCase(), raw: css.slice(i) });
        i = n;
      }
      continue;
    }

    // ordinary rule
    let p = i, brace = -1;
    while (p < n) {
      const c = css[p];
      if (c === '/' && css[p+1] === '*') {
        const e = css.indexOf('*/', p+2); p = e === -1 ? n : e+2; continue;
      }
      if (c === '"' || c === "'") { p = skipCssString(css, p); continue; }
      if (c === '{') { brace = p; break; }
      if (c === '}') break; // stray close brace
      p++;
    }
    if (brace === -1) {
      const junk = css.slice(i).trim();
      if (junk) items.push({ type: 'junk', raw: junk });
      break;
    }
    const end = matchCssBrace(css, brace);
    items.push({
      type: 'rule', selector: css.slice(i, brace).trim(),
      body: css.slice(brace + 1, end), raw: css.slice(i, end + 1),
    });
    i = end + 1;
  }
  return items;
}

// Which canonical sections does this selector reference (via #g-<id>)?
function sectionsInSelector(selector) {
  const found = [];
  for (const sid of SECTION_ORDER) {
    if (new RegExp('#g-' + sid + '(?![\\\\w-])').test(selector)) found.push(sid);
  }
  return found;
}

// Split a list of tokenised items into { bySection, global }, recursing into
// @media / @supports blocks so each section gets its own scoped wrapper.
function splitCssItems(items) {
  const bySection = {};
  const global = [];
  for (const item of items) {
    if (item.type === 'rule') {
      const secs = sectionsInSelector(item.selector);
      if (secs.length) {
        for (const s of secs) (bySection[s] ||= []).push(item.raw);
      } else {
        global.push(item.raw);
      }
    } else if (item.type === 'atrule') {
      if (item.name === 'media' || item.name === 'supports') {
        const sub = splitCssItems(tokenizeCss(item.inner));
        for (const [s, chunks] of Object.entries(sub.bySection)) {
          (bySection[s] ||= []).push(
            '@' + item.name + ' ' + item.prelude + ' {\\n' + chunks.join('\\n') + '\\n}'
          );
        }
        if (sub.global.length) {
          global.push('@' + item.name + ' ' + item.prelude + ' {\\n' + sub.global.join('\\n') + '\\n}');
        }
      } else {
        global.push(item.raw); // @font-face, @keyframes, @import, ...
      }
    }
    // comment / junk items are dropped from the composite
  }
  return { bySection, global };
}

// CSS_LIBRARY[parishId] = { bySection: { sid: [chunk,...] }, global: [chunk,...] }
const CSS_LIBRARY = {};
for (const [pid, raw] of Object.entries(CSS_RAW || {})) {
  try {
    CSS_LIBRARY[pid] = splitCssItems(tokenizeCss(raw));
  } catch (e) {
    CSS_LIBRARY[pid] = { bySection: {}, global: [], error: e.message };
  }
}

// Rewrite a CSS chunk so a section's styling works in a different slot:
// #g-<orig> -> #g-<slot> and the --section-<orig>- custom-property prefix.
function rehomeCss(chunk, origId, slotId) {
  if (origId === slotId) return chunk;
  return chunk
    .replace(new RegExp('#g-' + origId + '(?![\\\\w-])', 'g'), '#g-' + slotId)
    .replace(new RegExp('--section-' + origId + '-', 'g'), '--section-' + slotId + '-');
}

// Assemble the composite override.css for the current composition.
function assembleCss(baseParish) {
  const baseSrc = SOURCES.find(s => s.id === baseParish);
  const baseName = baseSrc ? baseSrc.name : baseParish;
  const baseLib = CSS_LIBRARY[baseParish] || { bySection: {}, global: [] };
  const seen = new Set();
  const norm = (c) => c.replace(/\\s+/g, ' ').trim();

  const sectionLines = [];
  const sectionBlocks = [];
  let sectionChunkCount = 0, missingCss = 0;

  for (const sid of SECTION_ORDER) {
    const v = filled[sid];
    if (!v) continue;
    const lib = CSS_LIBRARY[v.sourceId];
    const origId = v.node.id;
    const rehomed = origId !== sid;

    if (!lib) {
      missingCss++;
      sectionLines.push(' *   #g-' + sid + '  <- ' + v.sourceId + '  (no override.css for this parish)');
      sectionBlocks.push('/* ---- #g-' + sid + '  (from ' + v.sourceName + ' — no override.css available) ---- */');
      continue;
    }

    let chunks = (lib.bySection[origId] || []).slice();
    if (rehomed) chunks = chunks.map(c => rehomeCss(c, origId, sid));

    const kept = [];
    for (const c of chunks) {
      const key = norm(c);
      if (seen.has(key)) continue;
      seen.add(key); kept.push(c);
    }

    sectionLines.push(
      ' *   #g-' + sid + '  <- ' + v.sourceId +
      (rehomed ? '  (re-homed from #g-' + origId + ')' : '') +
      (kept.length ? '' : '  (no section CSS found)')
    );
    const header = '/* ---- #g-' + sid + '  (from ' + v.sourceName +
      (rehomed ? ', re-homed from #g-' + origId : '') + ') ---- */';
    if (!kept.length) {
      sectionBlocks.push(header + '\\n/* (no section-specific rules found in source) */');
    } else {
      sectionBlocks.push(header + '\\n' + kept.join('\\n\\n'));
      sectionChunkCount += kept.length;
    }
  }

  const out = [];
  out.push('/* ====================================================================');
  out.push(' * Composite override.css  —  Solutio Site Builder (section composer)');
  out.push(' * Generated: ' + new Date().toISOString());
  out.push(' * Shell / global CSS base: ' + baseName);
  out.push(' *');
  out.push(' * Sections:');
  for (const line of sectionLines) out.push(line);
  out.push(' *');
  out.push(' * NOTE: image url() paths (e.g. /images/template/...) point at the');
  out.push(' * source parish. Upload matching assets to the new site or edit paths.');
  out.push(' * Drop this in place of the theme\\'s override.css.');
  out.push(' * ==================================================================== */');
  out.push('');

  const globalKept = [];
  for (const c of baseLib.global) {
    const key = norm(c);
    if (seen.has(key)) continue;
    seen.add(key); globalKept.push(c);
  }
  out.push('/* ===== GLOBAL / SHELL CSS  (from ' + baseName + ') ===== */');
  out.push(globalKept.length ? globalKept.join('\\n\\n') : '/* (none) */');
  out.push('');

  for (const block of sectionBlocks) { out.push(block); out.push(''); }

  const stats = Object.keys(filled).length + ' section(s) · ' + sectionChunkCount +
    ' section CSS block(s) · ' + globalKept.length + ' global block(s)' +
    (missingCss ? ' · ' + missingCss + ' parish(es) without override.css' : '');
  return { css: out.join('\\n'), stats };
}

// ============================================================
//  Export modal
// ============================================================
function switchTab(name) {
  document.querySelectorAll('.modal-tabs .tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.hidden = p.dataset.pane !== name;
  });
  if (name === 'css') renderCssTab();
}

function renderCssTab() {
  const pre = document.getElementById('export-css');
  const sel = document.getElementById('css-base');
  const cssParishes = Object.keys(CSS_LIBRARY);
  if (!cssParishes.length) {
    pre.textContent = '/* No override.css files found in exports/override-css/.\\n   Run the CSS export step to populate them, then re-run build-site-builder.js. */';
    document.getElementById('css-summary').textContent = '';
    return;
  }
  if (!sel.dataset.ready) {
    sel.innerHTML = cssParishes.map(p => {
      const src = SOURCES.find(s => s.id === p);
      return '<option value="' + escHtml(p) + '">' + escHtml(src ? src.name : p) + '</option>';
    }).join('');
    sel.dataset.ready = '1';
    sel.addEventListener('change', () => { sel.dataset.touched = '1'; renderCssTab(); });
  }
  // Default the base to whichever filled parish (with CSS) appears most often.
  if (!sel.dataset.touched) {
    const counts = {};
    for (const v of Object.values(filled)) {
      if (CSS_LIBRARY[v.sourceId]) counts[v.sourceId] = (counts[v.sourceId] || 0) + 1;
    }
    let best = cssParishes[0], bestN = -1;
    for (const [p, c] of Object.entries(counts)) if (c > bestN) { bestN = c; best = p; }
    sel.value = best;
  }
  const { css, stats } = assembleCss(sel.value);
  pre.textContent = css;
  document.getElementById('css-summary').textContent = stats;
  document.getElementById('dl-css').onclick = () => {
    downloadFile(css, 'override.css', 'text/css');
  };
  document.getElementById('copy-css').onclick = () => {
    navigator.clipboard.writeText(css).then(() => toast('CSS copied'));
  };
}

function openExport() {
  const filledCount = Object.keys(filled).length;
  if (!filledCount) { toast('Fill at least one section slot first.'); return; }
  const doc = buildExportDoc();
  const yamlText = jsyaml.dump(doc, { lineWidth: -1, noRefs: true });
  document.getElementById('export-yaml').textContent = yamlText;
  document.getElementById('export-summary').textContent =
    filledCount + ' section(s) composed: ' + Object.keys(filled).join(', ');
  // recompute the default CSS base for this composition unless user picked one
  const cssBase = document.getElementById('css-base');
  delete cssBase.dataset.touched;
  switchTab('yaml');
  document.getElementById('export-modal').classList.add('open');
  // wire buttons (re-wire each open)
  document.getElementById('dl-yaml').onclick = () => {
    const parish = document.getElementById('parish-name').value.trim() || 'composite';
    downloadFile(yamlText, slug(parish)+'-home.yaml', 'text/yaml');
  };
  document.getElementById('dl-sh').onclick = () => downloadShellScript(yamlText);
  document.getElementById('copy-yaml').onclick = () => {
    navigator.clipboard.writeText(yamlText).then(()=>toast('YAML copied'));
  };
}

function downloadShellScript(yamlText) {
  const parish = document.getElementById('parish-name').value.trim() || 'New Parish';
  const host = document.getElementById('target-host').value.trim() || 'https://your-site.com';
  const outline = document.getElementById('target-outline').value.trim() || 'default';
  const yamlName = slug(parish) + '-home.yaml';
  let sh = '#!/bin/bash\\n';
  sh += '# Composite home layout for ' + parish + '\\n';
  sh += '# Generated by Solutio Site Builder — section composer\\n\\n';
  sh += 'SITE="' + host + '"\\n';
  sh += 'OUTLINE="' + outline + '"\\n\\n';
  sh += '# 1. Save the composite YAML next to this script as ' + yamlName + '\\n';
  sh += '# 2. Run:\\n';
  sh += 'node gantry.js -s "$SITE" --dry-run layout import -o "$OUTLINE" --input "' + yamlName + '"   # preview\\n';
  sh += 'node gantry.js -s "$SITE" layout import -o "$OUTLINE" --input "' + yamlName + '"             # apply\\n\\n';
  sh += 'echo "Imported. Visit $SITE to preview. Auto-backup was taken before the write."\\n';
  downloadFile(sh, 'apply-' + slug(parish) + '.sh', 'application/x-sh');
}

function slug(s){return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'composite';}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

// ============================================================
//  Prefill — load every section from one parish at once
// ============================================================
function prefillFrom() {
  const names = SOURCES.map(s => s.id);
  const pick = prompt('Prefill all slots from which parish?\\n\\n' + names.join('\\n'));
  if (!pick) return;
  const src = SOURCES.find(s => s.id === pick.trim());
  if (!src) { toast('No parish "' + pick + '"'); return; }
  let n = 0;
  for (const [sid, variants] of Object.entries(SECTION_LIBRARY)) {
    const v = variants.find(x => x.sourceId === src.id);
    if (v) { filled[sid] = v; n++; }
  }
  renderZones();
  toast('Prefilled ' + n + ' sections from ' + src.name);
}

// ============================================================
//  Bootstrap
// ============================================================
renderZones();
renderGroups('');
document.getElementById('palette-search').addEventListener('input', e => renderGroups(e.target.value));
document.getElementById('btn-export').addEventListener('click', openExport);
document.getElementById('btn-reset').addEventListener('click', () => {
  for (const k of Object.keys(filled)) delete filled[k];
  renderZones(); toast('Cleared all slots');
});
document.getElementById('btn-prefill').addEventListener('click', prefillFrom);
document.getElementById('btn-rebuild').addEventListener('click', () => {
  const btn = document.getElementById('btn-rebuild');
  btn.disabled = true;
  btn.textContent = '↺ Rebuilding…';
  const es = new EventSource('/api/rebuild');
  const msgs = [];
  es.onmessage = e => { msgs.push(e.data); };
  es.onerror = () => {
    es.close();
    btn.disabled = false;
    btn.textContent = '↺ Rebuild';
    const last = msgs[msgs.length - 1] || '';
    if (last.includes('COMPLETE')) {
      toast('Rebuild complete — reloading…');
      setTimeout(() => location.reload(), 800);
    } else {
      toast('Rebuild finished (check console for errors)');
    }
  };
});
document.getElementById('modal-close').addEventListener('click', () =>
  document.getElementById('export-modal').classList.remove('open'));
document.getElementById('export-modal').addEventListener('click', e => {
  if (e.target.id === 'export-modal') e.target.classList.remove('open');
});
document.querySelectorAll('.modal-tabs .tab').forEach(t =>
  t.addEventListener('click', () => {
    switchTab(t.dataset.tab);
    if (t.dataset.tab === 'deploy') initDeployTab();
  }));

// ============================================================
//  Deploy Live tab
// ============================================================
let _deployTabReady = false;
let _deployYaml = '';

function initDeployTab() {
  if (_deployTabReady) return;
  _deployTabReady = true;

  // Load outline list
  fetch('/api/outlines')
    .then(r => r.json())
    .then(list => {
      const sel = document.getElementById('deploy-outline');
      sel.innerHTML = list.map(o =>
        '<option value="' + escHtml(o.id) + '">' + escHtml(o.label) + '</option>'
      ).join('');
    })
    .catch(() => {
      document.getElementById('deploy-outline').innerHTML =
        '<option value="default">default</option>' +
        '<option value="33">Parish Home (33)</option>' +
        '<option value="72">School Home (72)</option>';
    });

  // Site search input
  const searchEl   = document.getElementById('deploy-site-search');
  const resultsEl  = document.getElementById('deploy-site-results');
  const siteUrlEl  = document.getElementById('deploy-site-url');
  const deployBtn  = document.getElementById('btn-deploy-live');
  let searchTimer;

  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchEl.value.trim();
    if (!q) { resultsEl.hidden = true; resultsEl.innerHTML = ''; return; }
    searchTimer = setTimeout(() => {
      fetch('/api/sites?q=' + encodeURIComponent(q))
        .then(r => r.json())
        .then(sites => {
          if (!sites.length) {
            resultsEl.innerHTML = '<div class="site-result" style="color:var(--soft)">No matches</div>';
          } else {
            resultsEl.innerHTML = sites.slice(0, 12).map(s =>
              '<div class="site-result" data-url="' + escHtml(s.url) + '" data-label="' + escHtml(s.label) + '">' +
              escHtml(s.label) + ' <span style="opacity:.5;font-size:.78rem">' + escHtml(s.domain) + '</span></div>'
            ).join('');
            resultsEl.querySelectorAll('.site-result[data-url]').forEach(el => {
              el.addEventListener('click', () => {
                siteUrlEl.value = el.dataset.url;
                searchEl.value  = el.dataset.label;
                resultsEl.hidden = true;
                deployBtn.disabled = false;
              });
            });
          }
          resultsEl.hidden = false;
        })
        .catch(() => {
          resultsEl.innerHTML = '<div class="site-result" style="color:var(--soft)">API unavailable — enter URL manually</div>';
          resultsEl.hidden = false;
        });
    }, 220);
  });

  // Hide dropdown when clicking outside
  document.addEventListener('click', e => {
    if (!resultsEl.contains(e.target) && e.target !== searchEl) resultsEl.hidden = true;
  });

  // Allow typing a URL directly into search field as fallback
  searchEl.addEventListener('change', () => {
    const v = searchEl.value.trim();
    if (v.startsWith('http')) {
      siteUrlEl.value = v;
      deployBtn.disabled = false;
    }
  });
}

document.getElementById('btn-deploy-live').addEventListener('click', async () => {
  const siteUrl   = document.getElementById('deploy-site-url').value.trim()
    || document.getElementById('deploy-site-search').value.trim();
  const outlineId = document.getElementById('deploy-outline').value;
  const dryRun    = document.getElementById('deploy-dry-run').checked;
  const statusEl  = document.getElementById('deploy-status');

  if (!siteUrl) { toast('Select or enter a target site first.'); return; }

  // Build YAML from current composition
  const filledCount = Object.keys(filled).length;
  if (!filledCount) { toast('Fill at least one section slot before deploying.'); return; }
  const doc = buildExportDoc();
  _deployYaml = jsyaml.dump(doc, { lineWidth: -1, noRefs: true });

  const btn = document.getElementById('btn-deploy-live');
  btn.disabled = true;
  statusEl.className = 'deploy-status visible running';
  statusEl.textContent = (dryRun ? '[DRY RUN] ' : '') + 'Deploying to ' + siteUrl + ' (outline ' + outlineId + ')…';

  try {
    const resp = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ yaml: _deployYaml, siteUrl, outlineId, dryRun }),
    });
    const data = await resp.json();
    if (data.success) {
      statusEl.className = 'deploy-status visible ok';
      statusEl.textContent = (dryRun ? '[DRY RUN COMPLETE]\\n' : '[DEPLOYED]\\n') + (data.message || 'Done.');
    } else {
      statusEl.className = 'deploy-status visible err';
      statusEl.textContent = '[ERROR]\\\n' + (data.error || JSON.stringify(data));
    }
  } catch (err) {
    statusEl.className = 'deploy-status visible err';
    statusEl.textContent = '[NETWORK ERROR]\\\n' + err.message +
      '\\n\\nMake sure site-builder-server.js is running on port 18303.';
  } finally {
    btn.disabled = false;
  }
});
</script>
</body>
</html>`;
}
