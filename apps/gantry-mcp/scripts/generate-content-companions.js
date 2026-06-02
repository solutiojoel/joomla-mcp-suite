#!/usr/bin/env node
'use strict';

/**
 * generate-content-companions.js
 *
 * Reads each templates/homepages/{slug}-*.json blueprint and extracts
 * article + category content organised by Gantry section.
 *
 * Article introtext is overridden with canonical HTML from
 * templates/homepage-articles-export/{sourceSlug}/{id}-{alias}.html
 * when available (mirrors how CSS is mapped from templates/css-patterns/).
 *
 * Output: exports/home-outlines/{slug}-content.json
 *
 * Run:  node scripts/generate-content-companions.js
 */

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'templates', 'homepages');
const ARTICLES_DIR  = path.join(ROOT, 'templates', 'homepage-articles-export');
const OUT_DIR       = path.join(ROOT, 'exports', 'home-outlines');

// ── Load HTML article exports ─────────────────────────────────────────────────
// articleHtmlIndex[sourceSlug][articleId] = { title, alias, categoryId, categoryTitle, html }
const articleHtmlIndex = {};
if (fs.existsSync(ARTICLES_DIR)) {
  const slugDirs = fs.readdirSync(ARTICLES_DIR)
    .filter(d => fs.statSync(path.join(ARTICLES_DIR, d)).isDirectory());
  for (const slug of slugDirs) {
    const manifestPath = path.join(ARTICLES_DIR, slug, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      articleHtmlIndex[slug] = {};
      for (const art of (manifest.articles || [])) {
        const htmlPath = path.join(ARTICLES_DIR, slug, art.file_name);
        const html     = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8').trim() : '';
        articleHtmlIndex[slug][String(art.id)] = {
          title:         art.title,
          alias:         art.alias         || '',
          categoryId:    String(art.category_id   || ''),
          categoryTitle: art.category_name || '',
          html,
        };
      }
    } catch (err) {
      console.warn(`  WARN: could not read article export for ${slug}: ${err.message}`);
    }
  }
  const total = Object.values(articleHtmlIndex)
    .reduce((n, m) => n + Object.keys(m).length, 0);
  console.log(`Loaded HTML article exports: ${total} articles across ${Object.keys(articleHtmlIndex).length} sources.`);
} else {
  console.log('(no templates/homepage-articles-export/ — article HTML overrides unavailable)');
}

// Known Gantry section IDs
const KNOWN_SECTIONS = new Set([
  'top', 'navigation', 'slideshow',
  'header', 'above', 'feature', 'showcase', 'utility',
  'sidebar', 'mainbar', 'aside',
  'expanded', 'extension', 'bottom',
  'footer', 'copyright', 'offcanvas',
]);

function sectionFromPath(filterPath) {
  if (!filterPath) return 'unknown';
  const parts = filterPath.split(' > ');
  for (const p of parts) {
    const token = p.split('.')[0];
    if (KNOWN_SECTIONS.has(token)) return token;
  }
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

function processBlueprint(filePath, sourceSlug) {
  const raw  = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const data = raw.data || raw;
  const bp   = (data && data.blueprint) ? data.blueprint : data;

  const refs    = bp && bp.references ? bp.references : {};
  const filters = refs.particleFilters || [];
  if (!filters.length) return null;

  const source     = bp.source     || {};
  const exportedAt = bp.exportedAt || null;

  const categoryMap    = {};
  const articleMap     = {};
  const sectionContent = {};

  // HTML exports for this source (may be empty if not yet exported)
  const htmlExports = (sourceSlug && articleHtmlIndex[sourceSlug]) || {};

  for (const pf of filters) {
    const section = sectionFromPath(pf.filterPath || '');

    const catIds = [];
    for (const cat of (pf.categories || [])) {
      categoryMap[String(cat.id)] = { id: String(cat.id), title: cat.title };
      catIds.push(String(cat.id));
    }

    const artIds = [];
    for (const art of (pf.articles || [])) {
      const id       = String(art.id);
      const exported = htmlExports[id];
      articleMap[id] = {
        id,
        title:         exported ? exported.title         : art.title,
        alias:         exported ? exported.alias         : (art.alias || ''),
        categoryId:    exported ? exported.categoryId    : String(art.categoryId || ''),
        categoryTitle: exported ? exported.categoryTitle : (art.categoryTitle || ''),
        // Canonical content: HTML export file takes precedence over blueprint introtext
        introtext:     exported ? exported.html          : (art.introtext || ''),
        fulltext:      art.fulltext || '',
        state:         art.state  != null ? String(art.state)  : '1',
        access:        art.access != null ? String(art.access) : '1',
        htmlExport:    !!(exported && exported.html),
      };
      artIds.push(id);
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
    source:   source.site   || '',
    outline:  source.outline || '',
    theme:    source.theme   || 'rt_studius',
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
  const slug = file.replace(/\.json$/, '');
  // Strip "-home" / "-school-home" suffix to get the HTML export source slug
  const sourceSlug = slug
    .replace(/-school-home$/, '')
    .replace(/-home$/, '');

  const inPath  = path.join(TEMPLATES_DIR, file);
  const outPath = path.join(OUT_DIR, slug + '-content.json');

  let result;
  try {
    result = processBlueprint(inPath, sourceSlug);
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
  const artCount  = Object.keys(result.articleMap).length;
  const htmlCount = Object.values(result.articleMap).filter(a => a.htmlExport).length;
  const catCount  = Object.keys(result.categoryMap).length;
  const secCount  = Object.keys(result.sectionContent).length;
  const htmlNote  = htmlCount ? `, ${htmlCount} from HTML export` : '';
  console.log(`  OK   ${slug}-content.json  (${artCount} articles${htmlNote}, ${catCount} cats, ${secCount} sections)`);
  saved++;
}

console.log(`\nDone: ${saved} companions written, ${skipped} skipped.`);
