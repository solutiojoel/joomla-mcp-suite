#!/usr/bin/env node
'use strict';
/**
 * migrate-override-css.js
 *
 * Reformats every override.css in exports/override-css/ to the standard
 * template layout:
 *
 *   1. Template HEAD   (globals + NAVIGATION standard styles)
 *   2. Site globals    (any non-section rules from the original file)
 *   3. *** INSERTION ZONE ***
 *      /*SLIDESHOW*\/  ... section CSS in canonical order ...
 *   4. Template TAIL   (BOTTOM + utilities)
 *
 * Original files are backed up as <name>.bak before overwriting.
 * Run: node migrate-override-css.js [--dry-run]
 */

const fs   = require('fs');
const path = require('path');

const CSS_DIR  = path.join(__dirname, 'exports', 'override-css');
const TEMPLATE = path.join(CSS_DIR, '_template.css');
const DRY_RUN  = process.argv.includes('--dry-run');

// Canonical section order for insertion zone
const SECTION_ORDER = [
  'top','navigation','slideshow','header','above','feature','showcase',
  'utility','sidebar','mainbar','aside','expanded','extension','footer','copyright',
];
// Map section id -> marker label used in CSS comments
const SECTION_LABEL = {
  top: 'TOP', navigation: 'NAVIGATION', slideshow: 'SLIDESHOW',
  header: 'HEADER', above: 'ABOVE', feature: 'FEATURE', showcase: 'SHOWCASE',
  utility: 'UTILITY', sidebar: 'SIDEBAR', mainbar: 'MAIN', aside: 'ASIDE',
  expanded: 'EXPANDED', extension: 'EXTENSION', footer: 'FOOTER', copyright: 'COPYRIGHT',
};

// ── minimal CSS tokeniser (same logic as build-site-builder.js) ────────────
function tokenizeCss(css) {
  const tokens = [];
  let i = 0;
  function skipWs() { while (i < css.length && /\s/.test(css[i])) i++; }
  function readComment() {
    const start = i; i += 2;
    while (i < css.length && !(css[i-1] === '*' && css[i] === '/')) i++;
    i++;
    return { type: 'comment', raw: css.slice(start, i) };
  }
  function readString(q) {
    let s = q; i++;
    while (i < css.length && css[i] !== q) {
      if (css[i] === '\\') { s += css[i] + css[i+1]; i += 2; } else { s += css[i++]; }
    }
    return s + (css[i++] || '');
  }
  function readBlock() {
    let depth = 0, s = '';
    while (i < css.length) {
      if (css[i] === '"' || css[i] === "'") { s += readString(css[i]); continue; }
      if (css[i] === '/' && css[i+1] === '*') { const c = readComment(); s += c.raw; continue; }
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { s += css[i++]; break; } }
      s += css[i++];
    }
    return s;
  }
  while (i < css.length) {
    skipWs();
    if (i >= css.length) break;
    if (css[i] === '/' && css[i+1] === '*') { tokens.push(readComment()); continue; }
    if (css[i] === '@') {
      const start = i++;
      while (i < css.length && css[i] !== '{' && css[i] !== ';') i++;
      const prelude = css.slice(start, i).trim();
      if (css[i] === '{') {
        const inner = readBlock();
        const nameMatch = prelude.match(/^@(\S+)/);
        tokens.push({ type: 'atrule', name: nameMatch?.[1] || '', prelude: prelude.slice((nameMatch?.[0]||'').length).trim(), inner: inner.slice(1,-1), raw: prelude + inner });
      } else {
        tokens.push({ type: 'atrule', name: '', prelude: '', inner: '', raw: prelude + (css[i]||'') }); if (css[i]) i++;
      }
      continue;
    }
    // rule or junk
    let sel = '';
    while (i < css.length && css[i] !== '{' && css[i] !== '}') {
      if (css[i] === '"' || css[i] === "'") sel += readString(css[i]);
      else if (css[i] === '/' && css[i+1] === '*') { const c = readComment(); sel += c.raw; }
      else sel += css[i++];
    }
    if (i < css.length && css[i] === '{') {
      const block = readBlock();
      tokens.push({ type: 'rule', selector: sel.trim(), raw: sel.trim() + block });
    } else if (sel.trim()) {
      tokens.push({ type: 'junk', raw: sel });
    }
  }
  return tokens;
}

function sectionsInSelector(sel) {
  const found = [];
  for (const sid of SECTION_ORDER) {
    if (new RegExp('#g-' + sid + '(?![\\w-])').test(sel)) found.push(sid);
  }
  return found;
}

function splitTokens(tokens) {
  const bySection = {};
  const global    = [];
  for (const tok of tokens) {
    if (tok.type === 'comment') continue; // drop plain comments
    if (tok.type === 'rule') {
      const secs = sectionsInSelector(tok.selector);
      if (secs.length) secs.forEach(s => (bySection[s] ||= []).push(tok.raw));
      else global.push(tok.raw);
    } else if (tok.type === 'atrule') {
      if (tok.name === 'media' || tok.name === 'supports') {
        const sub = splitTokens(tokenizeCss(tok.inner));
        if (Object.keys(sub.bySection).length) {
          for (const [s, chunks] of Object.entries(sub.bySection)) {
            (bySection[s] ||= []).push('@' + tok.name + ' ' + tok.prelude + ' {' + chunks.join('\n') + '\n}');
          }
          if (sub.global.length) global.push('@' + tok.name + ' ' + tok.prelude + ' {' + sub.global.join('\n') + '\n}');
        } else {
          global.push(tok.raw);
        }
      } else {
        global.push(tok.raw);
      }
    }
  }
  return { bySection, global };
}

// ── split template into HEAD / TAIL ─────────────────────────────────────────
const templateText = fs.readFileSync(TEMPLATE, 'utf8');
const INSERT_OPEN  = '/******************************************/\n/*INSERT ALL SECTIONS IN ORDER WITHIN HERE*/\n/******************************************/';
const INSERT_CLOSE = '/******************************************/\n/******************************************/\n/******************************************/';

const openIdx  = templateText.indexOf(INSERT_OPEN);
const closeIdx = templateText.indexOf(INSERT_CLOSE);
if (openIdx === -1 || closeIdx === -1) {
  console.error('Template missing insertion zone markers'); process.exit(1);
}
const TEMPLATE_HEAD = templateText.slice(0, openIdx + INSERT_OPEN.length);
const TEMPLATE_TAIL = templateText.slice(closeIdx);

// ── process each CSS file ────────────────────────────────────────────────────
const cssFiles = fs.readdirSync(CSS_DIR)
  .filter(f => f.endsWith('.css') && !f.startsWith('_'))
  .sort();

console.log(`Processing ${cssFiles.length} files${DRY_RUN ? ' (DRY RUN)' : ''}...\n`);

for (const fname of cssFiles) {
  const fpath = path.join(CSS_DIR, fname);
  const original = fs.readFileSync(fpath, 'utf8');

  // Parse
  const tokens    = tokenizeCss(original);
  const { bySection, global: globalChunks } = splitTokens(tokens);

  // Build insertion zone content
  const insertLines = [];
  for (const sid of SECTION_ORDER) {
    const chunks = bySection[sid];
    if (!chunks || !chunks.length) continue;
    insertLines.push('\n/*' + SECTION_LABEL[sid] + '*/');
    insertLines.push(chunks.join('\n\n'));
  }

  // Compose new file
  const siteGlobals = globalChunks.join('\n\n');
  const parts = [TEMPLATE_HEAD];
  if (siteGlobals.trim()) {
    parts.push('\n\n/* ---- site-specific globals ---- */\n' + siteGlobals.trim());
  }
  parts.push('\n' + insertLines.join('\n'));
  parts.push('\n\n' + TEMPLATE_TAIL);
  const newContent = parts.join('');

  const sectionCount = Object.keys(bySection).length;
  const globalCount  = globalChunks.length;
  console.log(`${fname}: ${sectionCount} section block(s), ${globalCount} global rule(s)`);

  if (!DRY_RUN) {
    fs.writeFileSync(fpath + '.bak', original);
    fs.writeFileSync(fpath, newContent);
    console.log(`  -> written (backup: ${fname}.bak)`);
  }
}
console.log('\nDone.');
