/**
 * download-css-patterns.js
 *
 * Downloads override CSS files from every Gantry 5 template site via HTTPS.
 * URL pattern: https://{sitecode}.solutiosoftware.com/content/{filename}
 *
 * Downloads every CSS_CANDIDATES filename that exists for each site
 * to css-patterns/{sitename}/{filename}
 *
 * Usage:
 *   node index.js
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '../..');
const OUT_DIR   = join(ROOT, 'css-patterns');

const TEMPLATE_SITES = [
  'assumption-center',
  'olmc-fairfield',
  'sd-cemetery',
  'seas-ontario',
  'sh-emporia',
  'shelbyville',
  'stagnes-concord',
  'stbarnabas-indy',
  'stbern-levit',
  'stbon-antonio',
  'stcats-wichita',
  'stchris-speed',
  'stgertrude-bay',
  'stlaw-alex',
  'stliz-melville',
  'stmary-wood',
  'stpats-par',
  'stwen-dick',
];

// Every filename to check — all matches are downloaded
const CSS_CANDIDATES = [
  'override.css',
  'override-school.css',
  'override2026.css',
  'custom.css',
  'user.css',
];

// ── Fetch all matching CSS files for one site ─────────────────────────────────

async function fetchAllCSS(siteName) {
  const base = `https://${siteName}.solutiosoftware.com/content`;
  const found = [];

  for (const filename of CSS_CANDIDATES) {
    const url = `${base}/${filename}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const text = await res.text();
        if (text.trim().length > 0) {
          found.push({ filename, bytes: text.length, content: text, url });
        }
      }
    } catch {
      // timeout or network error — skip this candidate
    }
  }

  return { siteName, found };
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n  CSS Pattern Downloader');
console.log(`  Sites     : ${TEMPLATE_SITES.length}`);
console.log(`  Candidates: ${CSS_CANDIDATES.join(', ')}`);
console.log(`  Output    : ${OUT_DIR}\n`);

mkdirSync(OUT_DIR, { recursive: true });

const results = [];
let totalFiles = 0;

for (const siteName of TEMPLATE_SITES) {
  console.log(`  ${siteName}`);
  const { found } = await fetchAllCSS(siteName);

  if (found.length > 0) {
    const siteDir = join(OUT_DIR, siteName);
    mkdirSync(siteDir, { recursive: true });
    for (const { filename, bytes, content, url } of found) {
      writeFileSync(join(siteDir, filename), content, 'utf8');
      console.log(`    OK  ${filename}  (${bytes.toLocaleString()} bytes)  ${url}`);
      totalFiles++;
    }
  } else {
    console.log('    --  no CSS files found');
  }

  results.push({ siteName, files: found.map(f => ({ file: f.filename, bytes: f.bytes, url: f.url })) });
}

console.log('\n  ─────────────────────────────────────');
console.log(`  Total files downloaded: ${totalFiles} across ${results.filter(r => r.files.length > 0).length} sites`);
console.log('  ─────────────────────────────────────\n');

const manifest = {
  downloadedAt: new Date().toISOString(),
  candidates: CSS_CANDIDATES,
  sites: results,
};
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('  Manifest written to css-patterns/manifest.json\n');
