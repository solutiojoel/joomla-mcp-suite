#!/usr/bin/env python3
"""
Particle Inventory Scanner
==========================
Feed it a list of sites and it crawls every configured page, auto-discovers
every Gantry 5 particle block in the DOM, and records:

  * particle type    (parsed from the DOM id, e.g. "contentarray", "swiper")
  * block classes   (the .g-block extra classes -- your CSS anchors)
  * CSS selectors   (all stylesheet rules that match the block or its children)
  * content hint    (first ~120 chars of visible text -- tells you what it's for)
  * data attributes (swiper config, AOS settings, etc.)
  * section context (which Gantry section the block lives in)

Nothing needs to be pre-configured -- discovery is fully automatic.

Output per site:
  output/{site-slug}/
    inventory.json       <- machine-readable, all particles across all pages
    inventory.md         <- human-readable summary table
  output/
    combined.json        <- all sites merged, keyed by site slug
    combined.md          <- cross-site comparison table

Usage:
  python scan.py                     # use sites.json in same dir
  python scan.py --sites sites.json  # explicit config path
  python scan.py --output ./reports  # custom output dir
  python scan.py --dry-run           # print plan, no browser
  python scan.py --site "Parish"     # filter to one site by name/url
  python scan.py --pages 3           # crawl up to N pages per site
"""

import argparse
import asyncio
import json
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

VISUAL_PROPS = [
    "display", "position", "width", "max-width", "min-height",
    "padding", "padding-top", "padding-bottom",
    "margin", "margin-top", "margin-bottom",
    "background-color", "background-image",
    "color", "font-size", "font-weight", "text-align",
    "border", "border-radius", "box-shadow",
    "flex-direction", "justify-content", "align-items",
    "grid-template-columns", "gap",
    "opacity", "overflow", "z-index",
]

# ---------------------------------------------------------------------------
# Discovery JS -- VISUAL_PROPS substituted at runtime via %s
# ---------------------------------------------------------------------------
DISCOVERY_JS = r"""
() => {
    const VISUAL_PROPS = %s;

    function particleTypeFromId(id) {
        const m = (id || '').match(/^(.+?)-\d+-particle$/);
        return m ? m[1] : 'unknown';
    }

    function getComputedSubset(el) {
        const cs = window.getComputedStyle(el);
        const out = {};
        for (const p of VISUAL_PROPS) { out[p] = cs.getPropertyValue(p); }
        return out;
    }

    function getMatchedRules(el) {
        const matched = [];
        for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules || sheet.rules; }
            catch (e) { continue; }
            if (!rules) continue;
            for (const rule of rules) {
                if (rule.type !== 1) continue;
                const parts = rule.selectorText
                    ? rule.selectorText.split(',').map(s => s.trim())
                    : [];
                for (const part of parts) {
                    let matches = false;
                    try { matches = el.matches(part); } catch(e) {}
                    if (!matches) {
                        try { matches = !!el.querySelector(part); } catch(e) {}
                    }
                    if (matches) {
                        const props = {};
                        for (const prop of rule.style) {
                            props[prop] = rule.style.getPropertyValue(prop);
                        }
                        if (Object.keys(props).length) {
                            matched.push({ selector: part, properties: props });
                        }
                        break;
                    }
                }
            }
        }
        return matched;
    }

    function sectionOf(el) {
        let cur = el.parentElement;
        while (cur) {
            if (cur.id && /^g-/.test(cur.id)) return cur.id;
            if (cur.dataset && cur.dataset.section) return cur.dataset.section;
            cur = cur.parentElement;
        }
        return null;
    }

    function dataAttrs(el) {
        const out = {};
        for (const attr of el.attributes) {
            if (attr.name.startsWith('data-')) out[attr.name] = attr.value;
        }
        return out;
    }

    function textHint(el) {
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        return text.length > 120 ? text.slice(0, 117) + '...' : text;
    }

    const results = [];
    const seen = new Set();

    for (const block of document.querySelectorAll('.g-block')) {
        const particleEl = block.querySelector('.g-content.g-particle');
        if (!particleEl) continue;

        const particleId = particleEl.id || '';
        const blockClasses = Array.from(block.classList).filter(c => c !== 'g-block');
        const key = blockClasses.slice().sort().join('|') + '::' + particleId;

        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
            particle_id: particleId,
            type: particleTypeFromId(particleId),
            section: sectionOf(block),
            block_classes: blockClasses,
            selectors: blockClasses
                .filter(c => !/^size-\d+$/.test(c))
                .map(c => '.' + c)
                .concat(particleId ? ['#' + particleId] : []),
            css_rules: getMatchedRules(block),
            computed: getComputedSubset(block),
            data_attrs: dataAttrs(particleEl),
            text_hint: textHint(particleEl),
        });
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
# Core scanner
# ---------------------------------------------------------------------------

async def scan_page(page, url):
    try:
        await page.goto(url, wait_until='domcontentloaded', timeout=30_000)
    except Exception as e:
        try:
            await page.goto(url, wait_until='commit', timeout=20_000)
        except Exception as e2:
            print(f'    x Navigation failed: {e2}')
            return []

    final_url = page.url or ''
    expected_host = url.split('/')[2]
    if expected_host not in final_url:
        print(f'    x Redirected away from site -- skipping ({final_url[:60]})')
        return []

    js = DISCOVERY_JS % json.dumps(VISUAL_PROPS)
    try:
        particles = await page.evaluate(js)
    except Exception as e:
        print(f'    x JS evaluation failed: {e}')
        return []

    for p in particles:
        p['source_url'] = url
    return particles


def deduplicate(particles):
    groups = {}
    for p in particles:
        key = p['type'] + '::' + '|'.join(sorted(p['block_classes']))
        if key not in groups:
            groups[key] = dict(p)
            groups[key]['source_urls'] = [p['source_url']]
            groups[key].pop('source_url', None)
        else:
            g = groups[key]
            if p['source_url'] not in g['source_urls']:
                g['source_urls'].append(p['source_url'])
            existing = {r['selector'] for r in g['css_rules']}
            for rule in p['css_rules']:
                if rule['selector'] not in existing:
                    g['css_rules'].append(rule)
                    existing.add(rule['selector'])
            if len(p.get('text_hint', '')) > len(g.get('text_hint', '')):
                g['text_hint'] = p['text_hint']
    return list(groups.values())


def write_site_markdown(particles, site, path):
    lines = [
        f"# Particle Inventory -- {site['name']}",
        '',
        f"**URL:** {site['url']}  ",
        f'**Scanned:** {now_str()}  ',
        f'**Particles found:** {len(particles)}',
        '',
        '---',
        '',
    ]

    by_section = defaultdict(list)
    for p in sorted(particles, key=lambda x: (x.get('section') or 'zzz', x['type'])):
        by_section[p.get('section') or 'unknown'].append(p)

    for section, items in by_section.items():
        lines.append(f'## Section: `{section}`')
        lines.append('')
        for p in items:
            block_cls = ' '.join(
                f'`.{c}`' for c in p['block_classes']
                if c and not re.match(r'^size-\d+$', c)
            )
            lines += [
                f"### `{p['type']}` {('-- ' + block_cls) if block_cls else ''}",
                '',
                f"**Particle ID:** `{p.get('particle_id', 'n/a')}`  ",
                f"**Block classes:** `{' '.join(p['block_classes']) or '(none)'}`  ",
                f"**Selectors:** {', '.join('`' + s + '`' for s in p['selectors']) or '(none)'}  ",
                f"**Pages:** {', '.join(p.get('source_urls', []))}  ",
            ]
            if p.get('text_hint'):
                lines.append(f"**Content hint:** _{p['text_hint']}_  ")
            for k, v in (p.get('data_attrs') or {}).items():
                lines.append(f'**{k}:** `{v}`  ')
            if p.get('css_rules'):
                lines += [
                    '',
                    f"**CSS rules matched:** {len(p['css_rules'])}  ",
                    '',
                    '<details><summary>Show rules</summary>',
                    '',
                    '```css',
                ]
                for rule in p['css_rules']:
                    props_str = '; '.join(f"{k}: {v}" for k, v in rule['properties'].items())
                    lines.append(f"{rule['selector']} {{ {props_str} }}")
                lines += ['```', '</details>']
            lines.append('')

    path.write_text('\n'.join(lines), encoding='utf-8')


def write_combined_markdown(all_results, out_root):
    matrix = defaultdict(dict)
    hints = {}

    for site_slug, particles in all_results.items():
        for p in particles:
            key = (p['type'], '|'.join(sorted(p['block_classes'])))
            matrix[key][site_slug] = True
            if not hints.get(key) and p.get('text_hint'):
                hints[key] = p['text_hint']

    site_slugs = sorted(all_results.keys())
    lines = [
        '# Combined Particle Inventory',
        '',
        f'_Generated {now_str()}_',
        f'_{len(all_results)} site(s) scanned_',
        '',
        '| Type | Block classes | ' + ' | '.join(site_slugs) + ' | Content hint |',
        '|------|--------------|' + '|'.join(['---'] * len(site_slugs)) + '|------|',
    ]

    for key in sorted(matrix.keys()):
        ptype, bkey = key
        block_cls = bkey.replace('|', ' ') if bkey else '(none)'
        cols = ' | '.join('yes' if s in matrix[key] else '-' for s in site_slugs)
        hint = (hints.get(key) or '')[:60]
        lines.append(f'| `{ptype}` | `{block_cls}` | {cols} | {hint} |')

    lines += ['', '---', '_Built by particle-inventory/scan.py_', '']
    (out_root / 'combined.md').write_text('\n'.join(lines), encoding='utf-8')


async def scan_site(page, site, max_pages):
    pages_to_scan = [normalize_path(site.get('path', '/'))]
    extra = [normalize_path(p) for p in site.get('extra_pages', [])]
    if max_pages:
        extra = extra[: max_pages - 1]
    pages_to_scan += extra

    all_particles = []
    base = site['url'].rstrip('/')

    for path in pages_to_scan:
        url = base + path
        print(f'    scanning {url}')
        found = await scan_page(page, url)
        print(f'      {len(found)} particle blocks found')
        all_particles.extend(found)

    return deduplicate(all_particles)


async def run(sites_path, out_root, dry_run, site_filter, max_pages):
    config = json.loads(sites_path.read_text(encoding='utf-8'))
    sites = config['sites']

    if site_filter:
        sites = [
            s for s in sites
            if site_filter.lower() in s['name'].lower()
            or site_filter.lower() in s['url'].lower()
        ]
        if not sites:
            print(f"No sites matched filter '{site_filter}'")
            sys.exit(1)

    out_root.mkdir(parents=True, exist_ok=True)
    print(f'Sites:  {len(sites)}')
    print(f'Output: {out_root.resolve()}')

    if dry_run:
        print('\nDRY RUN -- no browser will open\n')
        for site in sites:
            pages = [normalize_path(site.get('path', '/'))] + [
                normalize_path(p) for p in site.get('extra_pages', [])
            ]
            for p in pages:
                print(f"  would scan: {site['url'].rstrip('/')}{p}")
        return

    from playwright.async_api import async_playwright

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
            slug = slugify(site['name'])
            print(f"\n>> {site['name']} ({site['url']})")
            particles = await scan_site(page, site, max_pages)
            all_results[slug] = particles

            site_dir = out_root / slug
            site_dir.mkdir(parents=True, exist_ok=True)

            inv = {
                'site': site,
                'scanned': now_iso(),
                'particle_count': len(particles),
                'particles': particles,
            }
            (site_dir / 'inventory.json').write_text(
                json.dumps(inv, indent=2, ensure_ascii=False), encoding='utf-8'
            )
            write_site_markdown(particles, site, site_dir / 'inventory.md')
            print(f'  ok  {len(particles)} unique entries -> {site_dir}')

        await browser.close()

    (out_root / 'combined.json').write_text(
        json.dumps(all_results, indent=2, ensure_ascii=False), encoding='utf-8'
    )
    write_combined_markdown(all_results, out_root)

    total = sum(len(v) for v in all_results.values())
    print(f'\nDone -- {total} total particle entries across {len(sites)} site(s)')
    print(f"  Combined index: {(out_root / 'combined.md').resolve()}")


def main():
    parser = argparse.ArgumentParser(
        description='Auto-discover Gantry 5 particles across sites'
    )
    parser.add_argument('--sites', default='sites.json',
                        help='Path to sites JSON (default: sites.json)')
    parser.add_argument('--output', default='output',
                        help='Output directory (default: ./output)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Print what would be scanned without opening a browser')
    parser.add_argument('--site', default=None,
                        help='Filter to sites whose name or URL contains this string')
    parser.add_argument('--pages', type=int, default=None,
                        help='Max pages to crawl per site (default: all configured pages)')
    args = parser.parse_args()

    asyncio.run(run(
        sites_path=Path(args.sites),
        out_root=Path(args.output),
        dry_run=args.dry_run,
        site_filter=args.site,
        max_pages=args.pages,
    ))


if __name__ == '__main__':
    main()
