#!/usr/bin/env node
'use strict';

/**
 * generate-content-companions.js
 *
 * Reads each templates/homepages/{slug}-*.json blueprint and extracts
 * article + category content organised by Gantry section.
 *
 * Output: exports/home-outlines/{slug}-content.json
 * Shape:
 * {
 *   source: "https://...",
 *   slug:   "stlaw-alex",
 *   type:   "home" | "school_home",
 *   categoryMap: { "9": { id:"9", title:"Alert" }, ... },
 *   articleMap:  { "55": { id:"55", title:"...", alias:"...", categoryId:"24",
 *                           categoryTitle:"Homepage Articles",
 *                           introtext:"...", fulltext:"...", state:"1", access:"1" }, ... },
 *   sectionContent: {
 *     "top": [
 *       { particleId:"contentarray-4541", particleTitle:"Alert", particleType:"contentarray",
 *         categories:["9"], articles:[] }
 *     ],
 *     "header": [ ... ],
 *     ...
 *   }
 * }
 *
 * Run:  node scripts/generate-content-companions.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'templates', 'homepages');
const OUT_DIR       = path.join(ROOT, 'exports', 'home-outlines');

// Known Gantry section IDs — used to extract section name from filterPath
const KNOWN_SECTIONS = new Set([
  'top', 'navigation', 'slideshow',
  'header', 'above', 'feature', 'showcase', 'utility',
  'sidebar', 'mainbar', 'aside',
  'expanded', 'extension', 'bottom',
  'footer', 'copyright', 'offcanvas',
]);

/**
 * Extract the Gantry section name from a particleFilter filterPath.
 * e.g. "container-top > grid-3508 > block-9112 > top > ..."  →  "top"
 *      "expanded > grid-4284 > ..."                           →  "expanded"
 */
function sectionFromPath(filterPath) {
  if (!filterPath) return 'unknown';
  const parts = filterPath.split(' > ');
  for (const p of parts) {
    const token = p.split('.')[0]; // strip ".attributes...." suffix
    if (KNOWN_SECTIONS.has(token)) return token;
  }
  // Fallback: first non-container/grid/block token
  for (const p of parts) {
    const token = p.split('.')[0];
    if (!token.startsWith('container-') &&
        !token.startsWith('grid-') &&
        !token.startsWith('block-')) {
      return token;
    }
  }
  return 'unknown';
}

function processBlueprint(filePath) {
  const raw  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const data = raw.data || raw;
  const bp   = (data && data.blueprint) ? data.blueprint : data;

  const refs   = bp && bp.references ? bp.references : {};
  const filters = refs.particleFilters || [];
  if (!filters.length) return null; // empty blueprint

  const source        = bp.source        || {};
  const exportedAt    = bp.exportedAt    || null;

  const categoryMap   = {};
  const articleMap    = {};
  const sectionContent = {};

  for (const pf of filters) {
    const section = sectionFromPath(pf.filterPath || '');

    // Collect categories
    const catIds = [];
    for (const cat of (pf.categories || [])) {
      categoryMap[String(cat.id)] = { id: String(cat.id), title: cat.title };
      catIds.push(String(cat.id));
    }

    // Collect articles
    const artIds = [];
    for (const art of (pf.articles || [])) {
      articleMap[String(art.id)] = {
        id:            String(art.id),
        title:         art.title,
        alias:         art.alias  || '',
        categoryId:    String(art.categoryId || ''),
        categoryTitle: art.categoryTitle || '',
        introtext:     art.introtext || '',
        fulltext:      art.fulltext  || '',
        state:         art.state  != null ? String(art.state)  : '1',
        access:        art.access != null ? String(art.access) : '1',
      };
      artIds.push(String(art.id));
    }

    if (!sectionContent[section]) sectionContent[section] = [];
    sectionContent[section].push({
      particleId:    pf.particleId    || '',
      particleTitle: pf.particleTitle || '',
      particleType:  pf.particleType  || '',
      filterPath:    pf.filterPath    || '',
      categories:    catIds,
      articles:      artIds,
    });
  }

  return {
    source:      source.site || '',
    outline:     source.outline || '',
    theme:       source.theme   || 'rt_studius',
    exportedAt,
    categoryMap,
    articleMap,
    sectionContent,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

const jsonFiles = fs.readdirSync(TEMPLATES_DIR)
  .filter(f => f.endsWith('.json'))
  .sort();

let saved = 0, skipped = 0;

for (const file of jsonFiles) {
  const slug    = file.replace(/\.json$/, '');          // e.g. "stlaw-alex-home"
  const inPath  = path.join(TEMPLATES_DIR, file);
  const outPath = path.join(OUT_DIR, slug + '-content.json');

  let result;
  try {
    result = processBlueprint(inPath);
  } catch (err) {
    console.warn(`  SKIP ${file}: ${err.message}`);
    skipped++;
    continue;
  }

  if (!result) {
    console.warn(`  SKIP ${file}: blueprint is empty (0 particleFilters)`);
    skipped++;
    continue;
  }

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  const artCount = Object.keys(result.articleMap).length;
  const catCount = Object.keys(result.categoryMap).length;
  const secCount = Object.keys(result.sectionContent).length;
  console.log(`  OK   ${slug}-content.json  (${artCount} articles, ${catCount} cats, ${secCount} sections)`);
  saved++;
}

console.log(`\nDone: ${saved} companions written, ${skipped} skipped.`);
