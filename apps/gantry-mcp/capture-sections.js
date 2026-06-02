#!/usr/bin/env node
'use strict';

/**
 * capture-sections.js
 *
 * Screenshots every Gantry section of every parish backup site at a 1440px
 * viewport. Site URLs are read from the `source.host` field of each YAML in
 * exports/home-outlines/, so this stays in sync with whatever you've exported.
 *
 * Output:
 *   exports/section-shots/<parish>/<sectionId>.png
 *   exports/section-shots/manifest.json
 *
 * Then re-run `node build-site-builder.js` — it picks up these screenshots and
 * shows a real image on each section variant card (falling back to the SVG
 * schematic where no screenshot exists).
 *
 * Run:  node capture-sections.js
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const puppeteer = require('puppeteer');

const ROOT = __dirname;
const SRC_DIR = path.join(ROOT, 'exports', 'home-outlines');
const OUT_DIR = path.join(ROOT, 'exports', 'section-shots');
const VIEWPORT_WIDTH = 1440;

// Canonical Gantry section ids. Front-end element is `#g-<id>`.
// offcanvas is intentionally excluded (hidden mobile drawer — never visible
// on a desktop render).
const SECTION_IDS = [
  'top', 'navigation', 'slideshow', 'header', 'above', 'feature', 'showcase',
  'utility', 'sidebar', 'mainbar', 'aside', 'expanded', 'extension', 'bottom',
  'footer', 'copyright',
];

// --- Derive the site list from the YAML exports ---
if (!fs.existsSync(SRC_DIR)) {
  console.error(`Source directory not found: ${SRC_DIR}`);
  process.exit(1);
}
// --only-missing : skip any site that already has at least one section shot
const ONLY_MISSING = process.argv.includes('--only-missing');

let allSites = fs
  .readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => {
    let parsed;
    try {
      parsed = yaml.load(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    } catch {
      return null;
    }
    const id = f.replace(/-(?:school-)?home\.yaml$/, '').replace(/-1$/, '');
    let url = parsed?.source?.host || null;
    // source.host is often stored without a scheme — Puppeteer needs a full URL.
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    return { id, url };
  })
  .filter((s) => s && s.url);

// Deduplicate by id (same site may have home + school-home YAMLs)
const seen = new Set();
allSites = allSites.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });

const sites = ONLY_MISSING
  ? allSites.filter(s => {
      const dir = path.join(OUT_DIR, s.id);
      return !fs.existsSync(dir) || fs.readdirSync(dir).filter(f => f.endsWith('.png')).length === 0;
    })
  : allSites;

if (!sites.length) {
  console.log('No sites to capture (all already have screenshots). Use without --only-missing to re-capture.');
  process.exit(0);
}

if (ONLY_MISSING) {
  console.log(`--only-missing: ${allSites.length - sites.length} sites already have shots, capturing ${sites.length} new.\n`);
} else {
  console.log(`Capturing sections from ${sites.length} sites at ${VIEWPORT_WIDTH}px wide...\n`);
}

// A real Chrome UA — many backup sites' WAF/.htaccess blocks "HeadlessChrome".
const REAL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Removes navigator.webdriver and the "automation" tells some WAFs sniff.
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const manifest = [];

  for (const site of sites) {
    const page = await browser.newPage();
    await page.setUserAgent(REAL_UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 1200, deviceScaleFactor: 1 });
    const rec = { site: site.id, url: site.url, ok: false, sections: {} };

    try {
      console.log(`-> ${site.id}  ${site.url}`);
      await page.goto(site.url, { waitUntil: 'networkidle2', timeout: 60000 });
      // Trigger lazy-loaded images: scroll to the bottom, then back to top.
      await autoScroll(page);
      await sleep(1200);

      const dir = path.join(OUT_DIR, site.id);
      fs.mkdirSync(dir, { recursive: true });

      // Diagnostics — what is actually on the page?
      const diag = await page.evaluate(() => ({
        title: document.title,
        bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        gSectionCount: document.querySelectorAll('[id^="g-"]').length,
        hasGPage: !!document.querySelector('#g-page, .g-page, body.gantry'),
        hasLoginForm: !!document.querySelector('form#login-form, input[name="username"], input[name="passwd"]'),
        finalUrl: location.href,
      }));
      rec.diag = diag;
      console.log(`   title="${diag.title}"  g-ids=${diag.gSectionCount}  login=${diag.hasLoginForm}`);

      for (const sid of SECTION_IDS) {
        const el = await page.$(`#g-${sid}`);
        if (!el) {
          rec.sections[sid] = null;
          continue;
        }
        const box = await el.boundingBox();
        if (!box || box.width < 20 || box.height < 16) {
          // section absent / collapsed / zero-height — nothing meaningful to shoot
          rec.sections[sid] = null;
          continue;
        }
        const file = path.join(dir, `${sid}.png`);
        try {
          await el.screenshot({ path: file });
          // store path relative to ROOT, forward slashes
          rec.sections[sid] = path.relative(ROOT, file).replace(/\\/g, '/');
        } catch (e) {
          rec.sections[sid] = null;
        }
      }
      rec.ok = true;
      const n = Object.values(rec.sections).filter(Boolean).length;
      console.log(`   captured ${n} sections`);
      // If nothing captured, save a full-page debug screenshot so we can see why.
      if (n === 0) {
        try {
          const dbg = path.join(dir, '_debug.png');
          await page.screenshot({ path: dbg, fullPage: true });
          console.log(`   (0 sections — saved debug screenshot ${path.relative(ROOT, dbg)})`);
        } catch {}
      }
    } catch (err) {
      rec.error = err.message;
      console.log(`   FAILED: ${err.message}`);
    }

    await page.close();
    manifest.push(rec);
  }

  await browser.close();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const totalShots = manifest.reduce(
    (a, b) => a + Object.values(b.sections).filter(Boolean).length,
    0
  );
  const okSites = manifest.filter((m) => m.ok).length;
  console.log(
    `\nDone. ${totalShots} section screenshots across ${okSites}/${sites.length} sites.`
  );
  console.log(`Manifest: ${path.join(OUT_DIR, 'manifest.json')}`);
})();

/** Scroll the whole page to force lazy images to load, then return to top. */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const dist = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, dist);
        total += dist;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
