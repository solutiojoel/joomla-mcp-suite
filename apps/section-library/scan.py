#!/usr/bin/env python3
"""
Section Layout Scanner
======================
Navigates every configured site page once and maps how Gantry 5 particles
are seated together inside sections, capturing the full structural hierarchy:

    section > .g-container > .g-grid > .g-block > particle

For every section found it records:
  - Section identity: id, extra classes, CSS
  - Container: classes, CSS (max-width, padding, etc.)
  - Grid rows: classes + CSS (display, grid-template-columns, gap, flex)
  - Each block: size class, extra classes, CSS (width, padding, position)
  - Each particle in the block: type, id, text hint
  - Layout fingerprint: e.g. "100", "66|33", "33|33|33" — the column widths
  - Screenshot of the entire section

Output:
  output/
    {site-slug}/
      sections.json
      sections.md
      screenshots/
        {section-id}.png
    combined.md    <- cross-site index grouped by layout fingerprint
    combined.json

Usage:
  python scan.py                       # reads ../particle-inventory/sites.json
  python scan.py --sites sites.json    # explicit site list
  python scan.py --output ./out        # custom output dir
  python scan.py --site "Trinity"      # filter to one site
  python scan.py --dry-run             # print plan only
"""

import argparse
import asyncio
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright

# ---------------------------------------------------------------------------
# CSS properties captured at each structural level
# ---------------------------------------------------------------------------
LAYOUT_PROPS = [
    "display", "position", "width", "height", "min-height", "max-width",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin", "margin-top", "margin-bottom",
    "flex-direction", "flex-wrap", "justify-content", "align-items",
    "grid-template-columns", "grid-template-rows", "gap", "column-gap", "row-gap",
    "background-color", "background-image", "background-size", "background-position",
    "color", "font-size",
    "border", "border-radius", "box-shadow",
    "overflow", "z-index", "opacity",
]

# JS injected into every page — LAYOUT_PROPS substituted at runtime
SECTION_JS = r"""
(layoutProps) => {
    // --- helpers -----------------------------------------------------------

    function computedSubset(el, props) {
        if (!el) return {};
        const cs = window.getComputedStyle(el);
        const out = {};
        for (const p of props) out[p] = cs.getPropertyValue(p).trim();
        return out;
    }

    function matchedRules(el) {
        if (!el) return [];
        const results = [];
        const seen = new Set();
        for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules || sheet.rules; }
            catch (e) { continue; }
            if (!rules) continue;
            for (const rule of rules) {
                if (rule.type !== 1) continue;
                const parts = (rule.selectorText || '').split(',').map(s => s.trim());
                for (const part of parts) {
                    if (seen.has(part)) continue;
                    let hit = false;
                    try { hit = el.matches(part); } catch(e) {}
                    if (!hit) { try { hit = !!el.querySelector(part); } catch(e) {} }
                    if (hit) {
                        seen.add(part);
                        const props = {};
                        for (const p of rule.style) props[p] = rule.style.getPropertyValue(p);
                        if (Object.keys(props).length) results.push({ selector: part, properties: props });
                        break;
                    }
                }
            }
        }
        return results;
    }

    function particleTypeFromId(id) {
        const m = (id || '').match(/^(.+?)-\d+-particle$/);
        return m ? m[1] : 'unknown';
    }

    function textHint(el) {
        const t = (el ? el.innerText || '' : '').replace(/\s+/g, ' ').trim();
        return t.length > 100 ? t.slice(0, 97) + '...' : t;
    }

    // Extract size number from class list (size-33, size-66, size-100, size-33-3, etc.)
    function sizeClass(classList) {
        for (const c of classList) {
            const m = c.match(/^size-(\d+(?:-\d+)?)$/);
            if (m) return m[1].replace('-', '.');
        }
        return null;
    }

    function extraClasses(el, excludePrefixes) {
        return Array.from(el.classList).filter(c => {
            for (const p of excludePrefixes) if (c.startsWith(p)) return false;
            return true;
        });
    }

    // --- process one section -----------------------------------------------

    function processSection(section) {
        const sectionClasses = extraClasses(section, ['g-']);
        const sectionId = section.id || null;

        const container = section.querySelector(':scope > .g-container');

        // g-grid elements (may be direct children of section or container)
        const gridEls = section.querySelectorAll(
            ':scope > .g-container > .g-grid, :scope > .g-grid'
        );

        const grids = [];
        for (const grid of gridEls) {
            const blockEls = grid.querySelectorAll(':scope > .g-block');
            if (!blockEls.length) continue;

            const blocks = [];
            for (const block of blockEls) {
                const blockClasses = Array.from(block.classList).filter(c => c !== 'g-block');
                const particleEl = block.querySelector('.g-content.g-particle');

                let particle = null;
                if (particleEl) {
                    particle = {
                        id: particleEl.id || null,
                        type: particleTypeFromId(particleEl.id),
                        extra_classes: Array.from(particleEl.classList)
                            .filter(c => c !== 'g-content' && c !== 'g-particle'),
                        text_hint: textHint(particleEl),
                    };
                }

                blocks.push({
                    size: sizeClass(block.classList),
                    block_classes: blockClasses,
                    computed: computedSubset(block, layoutProps),
                    css_rules: matchedRules(block),
                    particle,
                });
            }

            const sizes = blocks.map(b => b.size || '?');
            const gridFingerprint = sizes.join('|');

            grids.push({
                fingerprint: gridFingerprint,
                grid_classes: Array.from(grid.classList).filter(c => c !== 'g-grid'),
                computed: computedSubset(grid, layoutProps),
                css_rules: matchedRules(grid),
                blocks,
            });
        }

        if (!grids.length) return null;

        // Overall section fingerprint = all grid fingerprints joined with "/"
        const sectionFingerprint = grids.map(g => g.fingerprint).join('/');

        return {
            section_id: sectionId,
            section_classes: sectionClasses,
            section_fingerprint: sectionFingerprint,
            computed_section: computedSubset(section, layoutProps),
            css_rules_section: matchedRules(section),
            computed_container: computedSubset(container, layoutProps),
            css_rules_container: matchedRules(container),
            grids,
        };
    }

    // --- main --------------------------------------------------------------

    const sections = document.querySelectorAll('section');
    const results = [];
    for (const section of sections) {
        const data = processSection(section);
        if (data) results.push(data);
    }
    return results;
}
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slugify(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def normalize_path(p):
    return p if p.startswith('/') else '/' + p


def now_str():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------

async def navigate_page(page, url, site_host):
    try:
        await page.goto(url, wait_until='domcontentloaded', timeout=30_000)
    except Exception:
        try:
            await page.goto(url, wait_until='commit', timeout=20_000)
        except Exception as e:
            print(f'    x nav failed: {e}')
            return False
    final = page.url or ''
    if site_host not in final:
        print(f'    x redirected away ({final[:60]})')
        return False
    return True


# ---------------------------------------------------------------------------
# Per-page scan
# ---------------------------------------------------------------------------

async def scan_page(page, url, site_host, screenshot_dir):
    print(f'    loading {url}')
    if not await navigate_page(page, url, site_host):
        return []

    try:
        sections = await page.evaluate(SECTION_JS, LAYOUT_PROPS)
    except Exception as e:
        print(f'    x JS failed: {e}')
        return []

    print(f'      {len(sections)} sections found')

    for sec in sections:
        sec['source_url'] = url
        sid = sec.get('section_id') or 'unknown'
        # Screenshot the section element
        try:
            el = await page.query_selector(f'section#{sid}' if sid != 'unknown' else 'section')
            if el:
                shot_path = screenshot_dir / f'{slugify(sid)}.png'
                await el.screenshot(path=str(shot_path))
                sec['screenshot'] = shot_path.name
        except Exception as e:
            sec['screenshot'] = None

    return sections


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def deduplicate(sections):
    """Merge sections with identical fingerprint + section_id across pages."""
    groups = {}
    for s in sections:
        key = (s.get('section_id') or 'unknown', s.get('section_fingerprint', ''))
        if key not in groups:
            groups[key] = dict(s)
            groups[key]['source_urls'] = [s['source_url']]
            groups[key].pop('source_url', None)
        else:
            url = s['source_url']
            if url not in groups[key]['source_urls']:
                groups[key]['source_urls'].append(url)
    return list(groups.values())


# ---------------------------------------------------------------------------
# Markdown writers
# ---------------------------------------------------------------------------

def block_summary(block):
    p = block.get('particle')
    p_str = f"`{p['type']}`" if p else '_(empty)_'
    cls = ' '.join(f'`.{c}`' for c in block['block_classes'] if c and not re.match(r'^size-', c))
    size = block.get('size') or '?'
    return f"size-{size} {cls or ''} → {p_str}"


def write_site_markdown(sections, site, out_path, page_url=None):
    lines = [
        f"# Section Layout Inventory — {site['name']}",
        '',
        f"**URL:** {site['url']}  ",
        f"**Scanned:** {now_str()}  ",
        f"**Sections:** {len(sections)}",
        '',
        '---',
        '',
    ]

    by_fp = defaultdict(list)
    for s in sections:
        by_fp[s.get('section_fingerprint', '?')].append(s)

    for fp, secs in sorted(by_fp.items()):
        lines.append(f'## Layout: `{fp}`')
        lines.append('')
        for s in secs:
            sid = s.get('section_id') or 'unknown'
            lines += [
                f"### `{sid}`",
                '',
                f"**Fingerprint:** `{fp}`  ",
                f"**Section classes:** {' '.join('`.'+c+'`' for c in s.get('section_classes', [])) or '_(none)_'}  ",
                f"**Pages:** {', '.join(s.get('source_urls', []))}  ",
            ]
            if s.get('screenshot'):
                lines.append(f"![section screenshot](screenshots/{s['screenshot']})")
            lines.append('')
            for i, grid in enumerate(s.get('grids', [])):
                lines.append(f"**Grid {i+1}** `{grid['fingerprint']}`")
                for block in grid['blocks']:
                    lines.append(f"  - {block_summary(block)}")
            lines.append('')
            # Computed section styles
            c = s.get('computed_section', {})
            style_bits = []
            if c.get('min-height') and c['min-height'] not in ('0px', 'none', 'auto', ''):
                style_bits.append(f"min-height: {c['min-height']}")
            if c.get('background-color') and c['background-color'] not in ('rgba(0, 0, 0, 0)', 'transparent', ''):
                style_bits.append(f"background: {c['background-color']}")
            if c.get('background-image') and c['background-image'] != 'none':
                style_bits.append('background-image: (set)')
            if style_bits:
                lines.append('**Section styles:** ' + ' | '.join(style_bits))
                lines.append('')
            cc = s.get('computed_container', {})
            if cc.get('max-width') and cc['max-width'] not in ('none', ''):
                lines.append(f"**Container max-width:** {cc['max-width']}")
                lines.append('')
            if s.get('css_rules_section'):
                lines += [
                    '<details><summary>Section CSS rules</summary>',
                    '',
                    '```css',
                ]
                for rule in s['css_rules_section']:
                    props_str = '; '.join(f"{k}: {v}" for k, v in rule['properties'].items())
                    lines.append(f"{rule['selector']} {{ {props_str} }}")
                lines += ['```', '</details>', '']

    out_path.write_text('\n'.join(lines), encoding='utf-8')


def write_combined_markdown(all_results, out_root):
    """Cross-site table grouped by layout fingerprint.
    all_results: {site_slug: {page_slug: [sections]}}
    """
    # fingerprint -> {site_slug/page_slug -> list of section ids}
    fp_map = defaultdict(lambda: defaultdict(list))
    fp_examples = {}

    for site_slug, pages in all_results.items():
        for page_slug, sections in pages.items():
            key = f"{site_slug}/{page_slug}"
            for s in sections:
                fp = s.get('section_fingerprint', '?')
                fp_map[fp][key].append(s.get('section_id') or 'unknown')
                if fp not in fp_examples:
                    fp_examples[fp] = s

    site_slugs = sorted(all_results.keys())

    lines = [
        '# Section Layout Cross-Site Index',
        '',
        f'_Generated {now_str()}_',
        f'_{len(all_results)} site(s) scanned_',
        '',
        '## Layout Fingerprint Key',
        '',
        'Each fingerprint describes the column widths in a grid row.',
        'e.g. `66|33` = one 66%-wide block beside one 33%-wide block.',
        'Multiple rows separated by `/`.',
        '',
        '---',
        '',
        '## Layouts by Fingerprint',
        '',
    ]

    for fp in sorted(fp_map.keys()):
        site_usage = fp_map[fp]
        total_sites = len(site_usage)
        example = fp_examples.get(fp, {})
        ex_grids = example.get('grids', [])

        lines += [
            f'### `{fp}` — {total_sites} site(s)',
            '',
        ]

        # Grid structure detail
        for i, grid in enumerate(ex_grids):
            lines.append(f'**Grid {i+1}:**')
            for block in grid['blocks']:
                p = block.get('particle')
                p_type = p['type'] if p else '(empty)'
                cls = ' '.join(f'`.{c}`' for c in block['block_classes']
                               if c and not re.match(r'^size-', c))
                lines.append(f'  - size-{block.get("size","?")} {cls} → `{p_type}`')
        lines.append('')

        # Site × section table
        lines.append('| Site / Page | Sections |')
        lines.append('|-------------|----------|')
        for key in sorted(site_usage.keys()):
            sids = ', '.join(f'`{sid}`' for sid in site_usage[key])
            lines.append(f'| {key} | {sids} |')
        lines.append('')

    lines += ['---', '_Built by section-library/scan.py_', '']
    (out_root / 'combined.md').write_text('\n'.join(lines), encoding='utf-8')


# ---------------------------------------------------------------------------
# Core runner
# ---------------------------------------------------------------------------

def path_to_slug(path):
    """Convert a URL path to a safe folder name. / -> home, /school-cl -> school-cl."""
    clean = path.strip('/')
    return slugify(clean) if clean else 'home'


async def scan_site(page, site, out_root):
    """
    Scans every configured page for a site.
    Each page gets its own subfolder:
      output/{site-slug}/{page-slug}/
        sections.json
        sections.md
        screenshots/
    Returns (site_slug, {page_slug: [sections]}) for the combined index.
    """
    slug = slugify(site['name'])
    base = site['url'].rstrip('/')
    site_host = site['url'].split('/')[2]

    pages = [normalize_path(site.get('path', '/'))]
    for ep in site.get('extra_pages', []):
        pages.append(normalize_path(ep))

    site_dir = out_root / slug
    site_dir.mkdir(parents=True, exist_ok=True)

    page_results = {}

    for path in pages:
        page_slug = path_to_slug(path)
        url = base + path

        page_dir = site_dir / page_slug
        shot_dir = page_dir / 'screenshots'
        shot_dir.mkdir(parents=True, exist_ok=True)

        found = await scan_page(page, url, site_host, shot_dir)

        inv = {
            'site': site,
            'page': path,
            'url': url,
            'scanned': now_iso(),
            'section_count': len(found),
            'sections': found,
        }
        (page_dir / 'sections.json').write_text(
            json.dumps(inv, indent=2, ensure_ascii=False), encoding='utf-8'
        )
        write_site_markdown(found, site, page_dir / 'sections.md', page_url=url)
        print(f'    {page_slug}: {len(found)} sections -> {page_dir}')

        page_results[page_slug] = found

    total = sum(len(v) for v in page_results.values())
    print(f'  ok  {total} sections total across {len(pages)} page(s)')
    return slug, page_results


async def run(sites_path, out_root, dry_run, site_filter):
    config = json.loads(sites_path.read_text(encoding='utf-8'))
    sites = config['sites']

    if site_filter:
        sites = [s for s in sites
                 if site_filter.lower() in s['name'].lower()
                 or site_filter.lower() in s['url'].lower()]
        if not sites:
            print(f"No sites matched '{site_filter}'")
            sys.exit(1)

    out_root.mkdir(parents=True, exist_ok=True)
    print(f'Sites:  {len(sites)}')
    print(f'Output: {out_root.resolve()}')

    if dry_run:
        print('\nDRY RUN\n')
        for site in sites:
            pages = [normalize_path(site.get('path', '/'))] + [
                normalize_path(p) for p in site.get('extra_pages', [])
            ]
            for p in pages:
                print(f"  would load: {site['url'].rstrip('/')}{p}")
        return

    all_results = {}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={'width': 1440, 'height': 900},
            user_agent=(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
                'AppleWebKit/537.36 (KHTML, like Gecko) '
                'Chrome/124.0 Safari/537.36'
            ),
        )
        page = await context.new_page()

        for site in sites:
            print(f"\n>> {site['name']} ({site['url']})")
            slug, page_results = await scan_site(page, site, out_root)
            all_results[slug] = page_results

        await browser.close()

    (out_root / 'combined.json').write_text(
        json.dumps(all_results, indent=2, ensure_ascii=False), encoding='utf-8'
    )
    write_combined_markdown(all_results, out_root)

    total = sum(len(secs) for pages in all_results.values() for secs in pages.values())
    print(f'\nDone -- {total} total sections across {len(sites)} site(s)')
    print(f"  Index: {(out_root / 'combined.md').resolve()}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description='Map Gantry 5 section layouts across sites'
    )
    parser.add_argument(
        '--sites',
        default=str(Path(__file__).parent.parent / 'particle-inventory' / 'sites.json'),
        help='Path to sites JSON (default: ../particle-inventory/sites.json)',
    )
    parser.add_argument('--output', default='output')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--site', default=None, help='Filter by site name or URL')
    args = parser.parse_args()

    asyncio.run(run(
        sites_path=Path(args.sites),
        out_root=Path(args.output),
        dry_run=args.dry_run,
        site_filter=args.site,
    ))


if __name__ == '__main__':
    main()
