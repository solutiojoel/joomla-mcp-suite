#!/usr/bin/env python3
"""
Particle Library Builder
========================
Crawls a list of Gantry 5 / Solutio sites and builds a visual reference
library for each particle type and variant.

For each site in config.json it navigates to the configured page(s) ONCE,
then screenshots every particle selector that matches on that page.

Output layout:
  output/
    {particle-type}/
      {variant}/
        {site-slug}/
          screenshot.png
          styles.json       <- matched rules + computed key properties
          card.md           <- human-readable reference card
    INDEX.md                <- master index of all captured patterns
"""

import argparse
import asyncio
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright

# ---------------------------------------------------------------------------
# Visual CSS properties we always extract from getComputedStyle
# ---------------------------------------------------------------------------
VISUAL_PROPS = [
    "display", "position", "width", "height", "min-height", "max-width",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "flex-direction", "flex-wrap", "justify-content", "align-items",
    "grid-template-columns", "grid-template-rows", "gap", "column-gap", "row-gap",
    "background", "background-color", "background-image", "background-size",
    "background-position", "background-repeat", "background-attachment",
    "color", "font-family", "font-size", "font-weight", "font-style",
    "line-height", "letter-spacing", "text-align", "text-transform",
    "text-decoration",
    "border", "border-top", "border-right", "border-bottom", "border-left",
    "border-radius", "box-shadow", "outline",
    "opacity", "visibility", "overflow", "z-index",
]

STYLE_EXTRACT_JS = """
([selectors, props]) => {
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
                        const ps = {};
                        for (const p of rule.style) {
                            ps[p] = rule.style.getPropertyValue(p);
                        }
                        if (Object.keys(ps).length) {
                            matched.push({ selector: part, properties: ps });
                        }
                        break;
                    }
                }
            }
        }
        return matched;
    }

    function getComputed(el, props) {
        const cs = window.getComputedStyle(el);
        const out = {};
        for (const p of props) { out[p] = cs.getPropertyValue(p); }
        return out;
    }

    const allRules = [];
    const computed = {};
    const primary = document.querySelector(selectors[0]);
    if (!primary) return { matched_rules: [], computed_visual: {} };

    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
            const rules = getMatchedRules(el);
            const existing = new Set(allRules.map(r => r.selector));
            for (const r of rules) {
                if (!existing.has(r.selector)) { allRules.push(r); existing.add(r.selector); }
            }
        }
    }

    return {
        matched_rules: allRules,
        computed_visual: getComputed(primary, props),
    };
}
"""


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def now_str():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def write_card(card_path: Path, entry: dict, site: dict):
    lines = [
        f"# {entry['type']} / {entry['variant']}",
        "",
        f"**Site:** {site['name']} (`{site['url']}`)",
        f"**Page:** `{site.get('path', '/')}`",
        f"**Captured:** {now_str()}",
        "",
        "## Selectors",
        "",
    ]
    for sel in entry.get("selectors", []):
        lines.append(f"- `{sel}`")
    lines += [
        "",
        "## Description",
        "",
        entry.get("description", "_No description provided._"),
        "",
        "## Screenshot",
        "",
        "![screenshot](screenshot.png)",
        "",
        "## Applied Styles",
        "",
        "See [styles.json](styles.json) for the full rule dump.",
        "",
        "## Notes",
        "",
        entry.get("notes", "_None._"),
        "",
    ]
    card_path.write_text("\n".join(lines), encoding="utf-8")


async def navigate_page(page, url, site_host):
    """Navigate with domcontentloaded + redirect guard. Returns True on success."""
    try:
        await page.goto(url, wait_until='domcontentloaded', timeout=30_000)
    except Exception:
        try:
            await page.goto(url, wait_until='commit', timeout=20_000)
        except Exception as e:
            print(f"    x Nav failed: {e}")
            return False
    if site_host not in (page.url or ''):
        print(f"    x Redirected away ({page.url[:60]})")
        return False
    return True


async def capture_on_page(page, url, site, particles, out_root, results):
    """Navigate to url once, then screenshot every matching particle selector."""
    site_host = site['url'].split('/')[2]
    print(f"  loading {url}")
    if not await navigate_page(page, url, site_host):
        return

    site_slug = slugify(site['name'])

    for entry in particles:
        primary_sel = entry['selectors'][0]

        # Quick non-blocking check — skip if element not in DOM at all
        present = await page.evaluate(
            '(sel) => !!document.querySelector(sel)', primary_sel
        )
        if not present:
            continue

        print(f"    + {entry['type']}/{entry['variant']} ({primary_sel})")

        type_slug = slugify(entry['type'])
        variant_slug = slugify(entry['variant'])
        dest = out_root / type_slug / variant_slug / site_slug
        dest.mkdir(parents=True, exist_ok=True)

        # Screenshot the element
        screenshot_path = dest / 'screenshot.png'
        try:
            el = await page.query_selector(primary_sel)
            if el:
                await el.screenshot(path=str(screenshot_path))
        except Exception as e:
            print(f"      screenshot failed: {e}")

        # Extract CSS + computed
        try:
            styles = await page.evaluate(
                STYLE_EXTRACT_JS,
                [entry['selectors'], VISUAL_PROPS]
            )
        except Exception as e:
            print(f"      style extract failed: {e}")
            styles = {'matched_rules': [], 'computed_visual': {}}

        styles_data = {
            'particle': entry['type'],
            'variant': entry['variant'],
            'site': site['url'],
            'page': url,
            'captured': now_iso(),
            **styles,
        }
        (dest / 'styles.json').write_text(
            json.dumps(styles_data, indent=2, ensure_ascii=False), encoding='utf-8'
        )
        write_card(dest / 'card.md', entry, site)

        results.append({
            'type': entry['type'],
            'variant': entry['variant'],
            'site': site['name'],
            'path': str(dest.relative_to(out_root)),
            'rules': len(styles.get('matched_rules', [])),
            'selector': primary_sel,
        })


def write_index(out_root: Path, results: list):
    lines = [
        "# Particle Visual Library — Index",
        "",
        f"_Generated {now_str()}_",
        "",
        "| Type | Variant | Site | Rules | Card |",
        "|------|---------|------|------:|------|",
    ]
    for r in sorted(results, key=lambda x: (x['type'], x['variant'], x['site'])):
        link = f"[card]({r['path']}/card.md)"
        lines.append(f"| `{r['type']}` | {r['variant']} | {r['site']} | {r['rules']} | {link} |")
    lines += ["", "---", "_Built by particle-library/build.py_", ""]
    (out_root / 'INDEX.md').write_text("\n".join(lines), encoding='utf-8')


async def run(config_path: Path, out_root: Path, dry_run: bool, site_filter: str | None):
    config = json.loads(config_path.read_text(encoding='utf-8'))
    sites = config['sites']
    particles = config['particles']

    if site_filter:
        sites = [s for s in sites
                 if site_filter.lower() in s['name'].lower()
                 or site_filter.lower() in s['url'].lower()]
        if not sites:
            print(f"No sites matched filter '{site_filter}'")
            sys.exit(1)

    out_root.mkdir(parents=True, exist_ok=True)
    print(f"Sites:     {len(sites)}")
    print(f"Particles: {len(particles)}")
    print(f"Output:    {out_root.resolve()}")

    if dry_run:
        print("DRY RUN\n")
        for site in sites:
            pages = [site.get('path', '/')] + list(site.get('extra_pages', []))
            for p in pages:
                print(f"  would load: {site['url'].rstrip('/')}{p}")
        return

    results = []
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
            print(f"\n>> {site['name']}")
            base = site['url'].rstrip('/')
            pages = [site.get('path', '/')] + list(site.get('extra_pages', []))
            for path in pages:
                path = path if path.startswith('/') else '/' + path
                url = base + path
                await capture_on_page(page, url, site, particles, out_root, results)

        await browser.close()

    write_index(out_root, results)
    print(f"\nDone -- {len(results)} entries captured")
    print(f"  Index: {(out_root / 'INDEX.md').resolve()}")


def main():
    parser = argparse.ArgumentParser(description='Build a Gantry 5 particle visual library')
    parser.add_argument('--config', default='config.json')
    parser.add_argument('--output', default='output')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--site', default=None)
    args = parser.parse_args()

    asyncio.run(run(
        config_path=Path(args.config),
        out_root=Path(args.output),
        dry_run=args.dry_run,
        site_filter=args.site,
    ))


if __name__ == '__main__':
    main()
