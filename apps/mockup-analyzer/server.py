#!/usr/bin/env python3
"""
Mockup Analyzer — MCP Server
=============================
Exposes four tools that let any vision-capable LLM (Claude, Gemini, GPT-4o,
Codex) analyze a mockup image and produce a Gantry 5 layout plan.

The LLM does the actual vision analysis — this server handles data plumbing:
  - Serving the design vocabulary so the LLM understands available patterns
  - Loading mockup images as base64 vision content
  - Saving the resulting layout plan and running the gantry-builder

Tools:
  get_analysis_instructions  → system prompt + gantry section + particle reference
  get_design_vocabulary      → condensed design vocabulary (~26KB)
  load_mockup_image          → base64 image content for vision
  save_layout_plan           → persist plan, run gantry-builder, return blueprint path

Typical usage sequence:
  1. Call get_analysis_instructions  (once — tells the LLM how to think)
  2. Call get_design_vocabulary      (once — loads available fingerprints)
  3. Call load_mockup_image          (passes image to LLM vision)
  4. LLM reasons → produces layout plan JSON
  5. Call save_layout_plan           (saves + builds blueprint)
"""

import base64
import json
import os
import subprocess
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
HERE = Path(__file__).parent

# ---------------------------------------------------------------------------
# Transport: HTTP if HTTP_PORT / MOCKUP_MCP_PORT is set, else stdio.
# Pass host and port directly to the FastMCP constructor.
# ---------------------------------------------------------------------------
_http_port_str = os.environ.get('HTTP_PORT') or os.environ.get('MOCKUP_MCP_PORT')
_mcp_port = int(_http_port_str) if _http_port_str else 8000
_mcp_host = '0.0.0.0'

VOCAB_PATH = HERE.parent / 'synthesizer' / 'output' / 'design-vocabulary.json'
LIB_PATH   = HERE.parent / 'template-indexer' / 'template-library.json'
BUILDER    = HERE.parent / 'gantry-builder' / 'build.py'
OUT_DIR    = HERE / 'output'

mcp = FastMCP(
    name='mockup-analyzer',
    instructions=(
        'Gantry 5 mockup analysis tools. Call get_analysis_instructions first, '
        'then get_design_vocabulary, then load_mockup_image, then analyze the '
        'image yourself and call save_layout_plan with the result.'
    ),
    host=_mcp_host,
    port=_mcp_port,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_vocab() -> dict:
    if not VOCAB_PATH.exists():
        raise FileNotFoundError(
            f'Design vocabulary not found at {VOCAB_PATH}. '
            'Run apps/synthesizer/build.py first.'
        )
    return json.loads(VOCAB_PATH.read_text(encoding='utf-8'))


def _condense_vocab(vocab: dict) -> str:
    """Compress 300KB+ vocabulary to ~26KB prompt-friendly string."""
    nav_fps, hero_fps, content_fps = [], [], []

    for fp, data in vocab.get('fingerprints', {}).items():
        particle_types = set()
        for occ in data.get('occurrences', []):
            for slot in occ.get('block_slots', []):
                if slot.get('particle_type'):
                    particle_types.add(slot['particle_type'])

        if 'logo' in particle_types or 'menu' in particle_types:
            nav_fps.append((fp, data, particle_types))
        elif 'swiper' in particle_types or data.get('avg_height_px', 0) > 350:
            hero_fps.append((fp, data, particle_types))
        else:
            content_fps.append((fp, data, particle_types))

    def fmt_group(name: str, items: list) -> str:
        lines = [f'\n### {name} fingerprints']
        for fp, data, ptypes in items:
            occ = data.get('occurrence_count', 0)
            h = data.get('avg_height_px', 0)
            lines.append(f'\nfingerprint: {fp}  (seen {occ}x, avg {h:.0f}px)')
            # Show slot options per grid row
            slot_map: dict = {}
            for occ_item in data.get('occurrences', []):
                for slot in occ_item.get('block_slots', []):
                    size = slot.get('size', '?')
                    ptype = slot.get('particle_type', '?')
                    variant = slot.get('variant', '')
                    bc = slot.get('block_classes', [])
                    key = str(size)
                    slot_map.setdefault(key, set())
                    label = f'{ptype}'
                    if variant:
                        label += f'/{variant}'
                    if bc:
                        label += f' [{",".join(bc[:2])}]'
                    slot_map[key].add(label)
            for size_key, options in slot_map.items():
                opts = ', '.join(sorted(options)[:4])
                lines.append(f'  col {size_key}%: {opts}')
        return '\n'.join(lines)

    return (
        fmt_group('NAVIGATION / HEADER', nav_fps) +
        fmt_group('HERO / SLIDESHOW', hero_fps) +
        fmt_group('CONTENT / FOOTER', content_fps)
    )


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@mcp.tool()
def get_analysis_instructions() -> str:
    """
    Returns the system-level instructions for analyzing a mockup image.
    Call this first before analyzing any image.
    """
    gantry_sections = [
        ('g-top',           'Topmost strip — alerts, popup overlays, system messages'),
        ('g-navigation',    'Site header — logo, top links, main menu bar'),
        ('g-slideshow',     'Hero area — full-width slider or large banner image'),
        ('g-header',        'Sub-header row — info boxes, mass times, tagline'),
        ('g-utility',       'Utility strip — quicklinks icons, welcome text, CTAs'),
        ('g-mainbar',       'Primary content — news feed, social widgets, ad column'),
        ('g-sidebar',       'Left or right sidebar — news list, calendar, feeds'),
        ('g-expanded',      'Wide content band — link boxes, ministry cards, mission text'),
        ('g-extension',     'Special feature — timeline, podcast player, map embed'),
        ('g-footer',        'Site footer — contact info, module positions, logo'),
        ('g-copyright',     'Bottom bar — admin link, "Site by Solutio", privacy policy'),
        ('g-offcanvas',     'Mobile slide-out menu (always include for mobile nav)'),
    ]

    particle_types = {
        'swiper':       'Hero image slider / rotator',
        'contentarray': 'Joomla article content display (most common particle)',
        'blockcontent': 'Icon/image card grid — quicklinks, ministry cards, toplinks',
        'custom':       'Raw HTML — welcome heading, popup markup, copyright bar',
        'menu':         'Site navigation menu',
        'logo':         'Site logo / image',
        'position':     'Joomla module position — ads, footer columns, sidebar modules',
        'spacer':       'Empty spacer block',
        'timeline':     'Vertical event timeline',
    }

    sections_text = '\n'.join(f'  {k}: {v}' for k, v in gantry_sections)
    particles_text = '\n'.join(f'  {k}: {v}' for k, v in particle_types.items())

    return f"""# Gantry 5 Mockup Analysis Instructions

## Your task
Analyze the mockup image and produce a JSON layout plan describing which Gantry 5
sections and particles to use. Use the design vocabulary (from get_design_vocabulary)
to select real fingerprints from deployed sites rather than inventing new ones.

## Gantry 5 page structure
A page is a vertical stack of named sections. Each section contains one or more
grid rows. Each grid row contains blocks sized as percentages (must sum to 100).
Each block holds exactly one particle.

## Available section positions (top to bottom)
{sections_text}

## Particle types
{particles_text}

## Fingerprint notation
A fingerprint encodes column widths per grid row, rows separated by /
  "100"        — one full-width block
  "70|30"      — 70% block + 30% block in one row
  "100/70|30"  — two rows: full-width, then 70+30

## Output format (JSON)
{{
  "analysis": "2-3 sentence description of the mockup",
  "sections": [
    {{
      "gantry_section": "g-slideshow",
      "label": "Hero slider with mass times sidebar",
      "fingerprint": "70|30",
      "confidence": 0.9,
      "grids": [
        {{
          "grid_row": 1,
          "blocks": [
            {{
              "col": 1,
              "size": 70,
              "particle_type": "swiper",
              "block_classes": ["fullwidth-swiper", "rotate-wide"],
              "notes": "full-width hero slider"
            }},
            {{
              "col": 2,
              "size": 30,
              "particle_type": "contentarray",
              "block_classes": ["mass-times-block"],
              "notes": "mass times sidebar"
            }}
          ]
        }}
      ]
    }}
  ]
}}

## Rules
- Include g-top (alert), g-navigation, g-copyright, g-offcanvas in every layout
- Prefer fingerprints that appear in the vocabulary (higher occurrence count = safer choice)
- Block classes come from the vocabulary slot options — use them exactly as shown
- sizes in each grid row must sum to 100
- Respond with ONLY the JSON object, no markdown fences
"""


@mcp.tool()
def get_design_vocabulary() -> str:
    """
    Returns the condensed Gantry 5 design vocabulary — fingerprints, particle
    variants, and block classes extracted from deployed parish sites.
    Use this to select real, proven patterns when analyzing a mockup.
    """
    try:
        vocab = _load_vocab()
        return _condense_vocab(vocab)
    except FileNotFoundError as e:
        return f'VOCABULARY NOT AVAILABLE: {e}'


@mcp.tool()
def load_mockup_image(image_path: str) -> list:
    """
    Load a mockup image file and return it as base64 image content for vision analysis.
    Accepts absolute paths or paths relative to the mockup-analyzer directory.
    Supports PNG, JPG, JPEG, WEBP.
    """
    from mcp.types import ImageContent, TextContent

    path = Path(image_path)
    if not path.is_absolute():
        path = HERE / image_path
    if not path.exists():
        return [TextContent(type='text', text=f'ERROR: Image not found: {path}')]

    ext = path.suffix.lower()
    mime_map = {'.png': 'image/png', '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg', '.webp': 'image/webp'}
    mime = mime_map.get(ext, 'image/png')

    data = base64.standard_b64encode(path.read_bytes()).decode('ascii')
    size_kb = path.stat().st_size // 1024
    return [
        TextContent(type='text', text=f'Loaded: {path.name} ({size_kb}KB, {mime})'),
        ImageContent(type='image', data=data, mimeType=mime),
    ]


@mcp.tool()
def save_layout_plan(
    layout_plan: dict,
    outline_id: str = '33',
    context_vars: dict = None,
) -> dict:
    """
    Save a layout plan JSON and run the gantry-builder to produce a Gantry 5
    blueprint that can be imported via joomla_gantry5_import_outline_blueprint.

    Args:
        layout_plan:  The JSON layout plan produced by your mockup analysis.
        outline_id:   Gantry outline ID to target (default '33' = standard #Home).
        context_vars: Optional dict of resolved Joomla IDs, e.g.
                      {"alert_category_id": "9", "parish_name": "St. Joseph ..."}

    Returns dict with:
        plan_path:     Path to saved layout-plan.json
        blueprint_path: Path to importable blueprint.json
        summary_path:  Path to BUILD-SUMMARY.md
        unresolved:    Context variables still needing Joomla IDs
        stats:         Match counts
    """
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    plan_path = OUT_DIR / 'layout-plan.json'
    plan_path.write_text(json.dumps(layout_plan, indent=2, ensure_ascii=False),
                         encoding='utf-8')

    # Build the blueprint
    cmd = [
        sys.executable, str(BUILDER),
        '--plan', str(plan_path),
        '--lib', str(LIB_PATH),
        '--outline', str(outline_id),
        '--output', str(OUT_DIR),
    ]
    if context_vars:
        cmd += ['--context', json.dumps(context_vars)]

    result = subprocess.run(cmd, capture_output=True, text=True)

    if result.returncode != 0:
        return {
            'error': result.stderr or result.stdout,
            'plan_path': str(plan_path),
        }

    # Read the build plan to extract unresolved vars
    build_plan_path = OUT_DIR / 'build-plan.json'
    unresolved = {}
    stats = {}
    if build_plan_path.exists():
        bp = json.loads(build_plan_path.read_text(encoding='utf-8'))
        unresolved = bp.get('all_unresolved', {})
        stats = bp.get('stats', {})

    return {
        'plan_path':      str(plan_path),
        'blueprint_path': str(OUT_DIR / 'blueprint.json'),
        'summary_path':   str(OUT_DIR / 'BUILD-SUMMARY.md'),
        'unresolved':     unresolved,
        'stats':          stats,
        'builder_output': result.stdout.strip(),
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    transport = 'streamable-http' if _http_port_str else 'stdio'
    print(f'mockup-analyzer starting ({transport})', file=sys.stderr)
    mcp.run(transport=transport)
