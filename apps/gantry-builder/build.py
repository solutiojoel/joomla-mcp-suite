#!/usr/bin/env python3
"""
Gantry Builder
==============
Takes a layout-plan.json (from mockup-analyzer) and builds a Gantry 5
outline blueprint JSON that can be imported via:
  mcp__joomla__joomla_gantry5_import_outline_blueprint

Matching logic (in priority order):
  1. section_id match: layout plan gantry_section -> template section_id
  2. particle_type match: disambiguates templates with same section_id
  3. block_class match: further disambiguation or override

Outputs:
  output/build-plan.json     — full plan with matched templates, open variables
  output/blueprint.json      — importable Gantry 5 outline blueprint
  output/BUILD-SUMMARY.md    — human-readable build summary

Usage:
  python build.py [--plan layout-plan.json] [--lib ../template-indexer/template-library.json]
  python build.py --help
"""

import argparse
import json
import random
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import yaml
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'pyyaml', '--break-system-packages', '-q'])
    import yaml

# ---------------------------------------------------------------------------
# Section ID mapping: mockup-analyzer uses "g-slideshow" etc; templates use
# the bare id "slideshow", "navigation", etc.
# ---------------------------------------------------------------------------
GANTRY_SECTION_MAP = {
    'g-container-top': 'container-top',
    'g-top': 'top',
    'g-navigation': 'navigation',
    'g-slideshow': 'slideshow',
    'g-header': 'header',
    'g-utility': 'utility',
    'g-container-main': 'container-main',
    'g-above': 'above',
    'g-sidebar': 'sidebar',
    'g-mainbar': 'mainbar',
    'g-aside': 'aside',
    'g-below': 'below',
    'g-expanded': 'expanded',
    'g-extension': 'extension',
    'g-container-footer': 'container-footer',
    'g-footer': 'footer',
    'g-copyright': 'copyright',
    'g-offcanvas': 'offcanvas',
}

# Particle subtypes that need {{context_var}} resolved before import
CONTEXT_VAR_PROMPTS = {
    'mass_times_article_id': 'Joomla article ID containing mass times content',
    'alert_category_id':     'Joomla category ID for alerts/announcements',
    'footer_article_id':     'Joomla article ID for footer contact/logo content',
    'mission_article_id':    'Joomla article ID for the parish mission statement',
    'news_category_id':      'Joomla category ID for News & Events articles',
    'social_article_id':     'Joomla article ID for social feed (Facebook) widget shell',
    'parish_name':           'Full parish name, e.g. "St. Joseph Catholic Church"',
}


def uid(prefix: str) -> str:
    """Generate a unique Gantry-style node ID like contentarray-4591."""
    return f"{prefix}-{random.randint(1000, 9999)}"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Template matching
# ---------------------------------------------------------------------------

def resolve_section_id(gantry_section: str) -> str:
    """Map 'g-slideshow' -> 'slideshow' etc."""
    return GANTRY_SECTION_MAP.get(gantry_section, gantry_section.lstrip('g-'))


def score_template(template: dict, plan_section: dict) -> float:
    """
    Score how well a template matches a plan section.
    Returns 0.0–1.0.
    """
    score = 0.0
    plan_particles = set()
    plan_block_classes = set()

    for grid in plan_section.get('grids', []):
        for block in grid.get('blocks', []):
            plan_particles.add(block.get('particle_type', ''))
            plan_block_classes.update(block.get('block_classes', []))

    tmpl_particles = set(template['particles'])
    tmpl_block_classes = set(template['block_classes'])

    # Particle overlap
    if plan_particles and tmpl_particles:
        overlap = plan_particles & tmpl_particles
        score += 0.6 * (len(overlap) / max(len(plan_particles), len(tmpl_particles)))

    # Block class overlap (strong signal)
    if plan_block_classes and tmpl_block_classes:
        overlap = plan_block_classes & tmpl_block_classes
        if overlap:
            score += 0.4 * (len(overlap) / max(len(plan_block_classes), len(tmpl_block_classes)))

    return round(score, 3)


def match_template(plan_section: dict, library: dict) -> tuple[str | None, float, list[str]]:
    """
    Returns (template_name, confidence, match_reasons).
    """
    gantry_section = plan_section.get('gantry_section', '')
    section_id = resolve_section_id(gantry_section)

    candidates = library['section_id_index'].get(section_id, [])
    reasons = [f'section_id:{section_id}']

    if not candidates:
        return None, 0.0, [f'no_template_for:{section_id}']

    if len(candidates) == 1:
        name = candidates[0]
        tmpl = library['templates'][name]
        score = score_template(tmpl, plan_section)
        return name, max(0.5, score), reasons + [f'only_candidate']

    # Score all candidates
    scored = []
    for name in candidates:
        tmpl = library['templates'][name]
        s = score_template(tmpl, plan_section)
        scored.append((name, s))

    scored.sort(key=lambda x: -x[1])
    best_name, best_score = scored[0]
    reasons.append(f'scored:{best_score:.2f}')
    if best_score > 0:
        reasons.append(f'over_{len(scored)}_candidates')
    return best_name, best_score, reasons


# ---------------------------------------------------------------------------
# Blueprint JSON generation
# ---------------------------------------------------------------------------

def resolve_context(value, context: dict):
    """Replace {{var}} placeholders with values from context dict."""
    if isinstance(value, str):
        def replace(m):
            var = m.group(1)
            return str(context.get(var, f'{{{{{var}}}}}'))
        return re.sub(r'\{\{(\w+)\}\}', replace, value)
    if isinstance(value, dict):
        return {k: resolve_context(v, context) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve_context(item, context) for item in value]
    return value


def block_to_node(block: dict, context: dict) -> dict:
    """Convert a YAML template block definition to a blueprint block node."""
    particle_type = block.get('particle', 'custom')
    attrs = resolve_context(block.get('attributes', {}), context)

    # Ensure enabled=1 on all particles
    if isinstance(attrs, dict) and 'enabled' not in attrs:
        attrs['enabled'] = 1

    particle_node = {
        'id': uid(particle_type),
        'type': 'particle',
        'subtype': particle_type,
        'title': resolve_context(block.get('title', particle_type.title()), context),
        'attributes': attrs,
    }

    block_attrs = {'size': block.get('size', 100)}
    bc = block.get('blockClass', '')
    if bc:
        block_attrs['class'] = bc
        # Gantry also uses camelCase 'id' for the first class
        first_class = bc.split()[0]
        camel = re.sub(r'[-_](.)', lambda m: m.group(1).upper(), first_class)
        block_attrs['id'] = camel

    return {
        'id': uid('block'),
        'type': 'block',
        'subtype': 'block',
        'layout': True,
        'attributes': block_attrs,
        'children': [particle_node],
    }


def grid_to_node(grid: dict, context: dict) -> dict:
    """Convert a YAML template grid definition to a blueprint grid node."""
    return {
        'id': uid('grid'),
        'type': 'grid',
        'subtype': 'grid',
        'layout': True,
        'attributes': {},
        'children': [block_to_node(b, context) for b in grid.get('blocks', [])],
    }


def section_yaml_to_blueprint(template_raw: dict, context: dict) -> list[dict]:
    """
    Convert a YAML section template to blueprint JSON section node(s).
    Returns a list because multi-section templates (like footer-3col) produce
    multiple section nodes.
    """
    nodes = []

    def build_section_node(sec_data: dict, sec_id: str | None = None) -> dict:
        sid = sec_id or sec_data.get('id', 'section')
        attrs = sec_data.get('attributes', {})
        return {
            'id': sid,
            'type': 'section',
            'subtype': 'section',
            'layout': True,
            'title': sid.replace('-', ' ').title(),
            'attributes': {
                'boxed': attrs.get('boxed', '0'),
                'class': resolve_context(attrs.get('class', ''), context),
                'variations': '',
            },
            'children': [grid_to_node(g, context) for g in sec_data.get('grids', [])],
        }

    if 'sections' in template_raw:
        for sec_id, sec_data in template_raw['sections'].items():
            nodes.append(build_section_node(sec_data, sec_id))
    else:
        nodes.append(build_section_node(template_raw))

    return nodes


def wrap_section_in_container(section_nodes: list[dict], container_id: str = None) -> dict:
    """Wrap section nodes in container > grid > block(100) structure."""
    cid = container_id or uid('container')

    # Each section gets its own wrapping grid+block inside the container
    container_children = []
    for sec_node in section_nodes:
        wrapper_grid = {
            'id': uid('grid'),
            'type': 'grid',
            'subtype': 'grid',
            'layout': True,
            'attributes': {},
            'children': [{
                'id': uid('block'),
                'type': 'block',
                'subtype': 'block',
                'layout': True,
                'attributes': {'size': 100},
                'children': [sec_node],
            }],
        }
        container_children.append(wrapper_grid)

    return {
        'id': cid,
        'type': 'container',
        'subtype': 'container',
        'layout': True,
        'title': cid.replace('-', ' ').title(),
        'attributes': {'boxed': '', 'class': '', 'extra': []},
        'children': container_children,
    }


# ---------------------------------------------------------------------------
# Blueprint assembly
# ---------------------------------------------------------------------------

CONTAINER_GROUPS = {
    'container-top': ['top', 'navigation', 'slideshow', 'header', 'utility'],
    'container-main': ['above', 'sidebar', 'mainbar', 'aside', 'below', 'expanded', 'extension'],
    'container-footer': ['footer', 'copyright'],
}

def assign_container(section_id: str) -> str:
    for cid, ids in CONTAINER_GROUPS.items():
        if section_id in ids:
            return cid
    return 'container-main'


def build_blueprint(build_plan: dict, outline_id: str = '33', theme: str = 'rt_studius') -> dict:
    """
    Assemble a full Gantry 5 outline blueprint from matched templates.
    """
    sections_by_container: dict[str, list] = {}

    for entry in build_plan['sections']:
        tmpl_raw = entry.get('template_raw')
        if not tmpl_raw:
            continue

        context = entry.get('resolved_context', {})
        section_nodes = section_yaml_to_blueprint(tmpl_raw, context)

        # Determine which container this goes in
        primary_id = section_nodes[0].get('id', 'section')
        cid = assign_container(primary_id)
        sections_by_container.setdefault(cid, [])
        sections_by_container[cid].extend(section_nodes)

    # Build root
    root = []
    for cid in ['container-top', 'container-main', 'container-footer']:
        sec_nodes = sections_by_container.get(cid, [])
        if sec_nodes:
            root.append(wrap_section_in_container(sec_nodes, cid))

    # Collect particleFilters references
    particle_filters = []
    for entry in build_plan['sections']:
        particle_filters.extend(entry.get('particle_filter_hints', []))

    return {
        'success': True,
        'message': 'Gantry outline blueprint generated by gantry-builder',
        'data': {
            'format': 'json',
            'theme': theme,
            'outline': str(outline_id),
            'blueprint': {
                'kind': 'gantry5-outline-blueprint',
                'version': 1,
                'exportedAt': now_iso(),
                'source': {
                    'theme': theme,
                    'outline': str(outline_id),
                },
                'references': {
                    'particleFilters': particle_filters,
                },
                'layout': {
                    'preset': {
                        'image': 'gantry-admin://images/layouts/default.png',
                        'name': 'home_-_particles',
                        'timestamp': int(__import__('time').time()),
                    },
                    'root': root,
                },
            },
        },
    }


# ---------------------------------------------------------------------------
# Build plan
# ---------------------------------------------------------------------------

def build_plan_from_layout(layout_plan: dict, library: dict, context_overrides: dict = None) -> dict:
    if context_overrides is None:
        context_overrides = {}

    matched_sections = []
    all_unresolved = {}

    for plan_section in layout_plan.get('sections', []):
        gantry_section = plan_section.get('gantry_section', '')
        tmpl_name, confidence, reasons = match_template(plan_section, library)

        entry = {
            'gantry_section': gantry_section,
            'label': plan_section.get('label', ''),
            'fingerprint': plan_section.get('fingerprint', ''),
            'plan_confidence': plan_section.get('confidence', 1.0),
            'template_name': tmpl_name,
            'template_confidence': confidence,
            'match_reasons': reasons,
            'needs_resolution': [],
            'resolved_context': {},
            'template_raw': None,
            'particle_filter_hints': [],
        }

        if tmpl_name:
            tmpl = library['templates'][tmpl_name]
            entry['template_raw'] = tmpl['raw']
            entry['section_class'] = tmpl['section_class']

            # Identify what needs resolving
            for var in tmpl['context_vars']:
                if var in context_overrides:
                    entry['resolved_context'][var] = context_overrides[var]
                else:
                    desc = CONTEXT_VAR_PROMPTS.get(var, f'Value for {var}')
                    entry['needs_resolution'].append({'var': var, 'description': desc})
                    all_unresolved[var] = desc

        matched_sections.append(entry)

    return {
        'generated': now_iso(),
        'image': layout_plan.get('_meta', {}).get('image', ''),
        'analysis': layout_plan.get('analysis', ''),
        'sections': matched_sections,
        'all_unresolved': all_unresolved,
        'stats': {
            'total_sections': len(matched_sections),
            'matched': sum(1 for s in matched_sections if s['template_name']),
            'unmatched': sum(1 for s in matched_sections if not s['template_name']),
            'needs_resolution': len(all_unresolved),
        },
    }


# ---------------------------------------------------------------------------
# Markdown summary
# ---------------------------------------------------------------------------

def write_summary(build_plan: dict, out_path: Path):
    lines = [
        '# Gantry Builder — Build Summary',
        '',
        f"_Generated {build_plan['generated']}_",
        '',
        f"**Image:** `{build_plan['image']}`",
        f"**Analysis:** {build_plan['analysis']}",
        '',
        '## Section Matches',
        '',
        '| Section | Template | Confidence | Match |',
        '|---------|----------|:----------:|-------|',
    ]
    for s in build_plan['sections']:
        tmpl = s['template_name'] or '*(no match)*'
        conf = f"{s['template_confidence']:.0%}" if s['template_name'] else '—'
        reasons = ', '.join(s['match_reasons'][:2])
        lines.append(f"| `{s['gantry_section']}` | {tmpl} | {conf} | {reasons} |")

    unresolved = build_plan['all_unresolved']
    if unresolved:
        lines += [
            '',
            '## Required Information',
            '',
            'These context variables must be filled in before importing the blueprint:',
            '',
        ]
        for var, desc in unresolved.items():
            lines.append(f'- **`{{{{{var}}}}}`** — {desc}')
    else:
        lines += ['', '✓ No context variables required — blueprint is ready to import.']

    stats = build_plan['stats']
    lines += [
        '',
        '## Stats',
        '',
        f"- {stats['total_sections']} sections in layout plan",
        f"- {stats['matched']} matched to templates",
        f"- {stats['unmatched']} unmatched",
        f"- {stats['needs_resolution']} context variables need resolution",
        '',
        '---',
        '_Generated by apps/gantry-builder/build.py_',
        '',
    ]

    out_path.write_text('\n'.join(lines), encoding='utf-8')


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Build a Gantry 5 outline blueprint from a layout plan')
    parser.add_argument('--plan', default='../mockup-analyzer/output/layout-plan.json',
                        help='Path to layout-plan.json from mockup-analyzer')
    parser.add_argument('--lib', default='../template-indexer/template-library.json',
                        help='Path to template-library.json from template-indexer')
    parser.add_argument('--context', default=None,
                        help='JSON string or file path with context variable overrides')
    parser.add_argument('--outline', default='33',
                        help='Gantry outline ID to target (default: 33)')
    parser.add_argument('--output', default='output',
                        help='Output directory')
    args = parser.parse_args()

    plan_path = Path(args.plan)
    lib_path = Path(args.lib)

    if not plan_path.exists():
        print(f"ERROR: layout plan not found: {plan_path}", file=sys.stderr)
        sys.exit(1)
    if not lib_path.exists():
        print(f"ERROR: template library not found: {lib_path}", file=sys.stderr)
        sys.exit(1)

    layout_plan = json.loads(plan_path.read_text(encoding='utf-8'))
    library = json.loads(lib_path.read_text(encoding='utf-8'))

    # Optional context overrides
    context_overrides = {}
    if args.context:
        ctx_path = Path(args.context)
        if ctx_path.exists():
            context_overrides = json.loads(ctx_path.read_text(encoding='utf-8'))
        else:
            context_overrides = json.loads(args.context)

    print(f"Plan:    {plan_path.resolve()}")
    print(f"Library: {lib_path.resolve()}")
    print(f"Outline: #{args.outline}")

    # Build the plan
    build_plan = build_plan_from_layout(layout_plan, library, context_overrides)

    # Generate blueprint
    blueprint = build_blueprint(build_plan, outline_id=args.outline)

    # Write outputs
    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    plan_out = out_dir / 'build-plan.json'
    bp_out = out_dir / 'blueprint.json'
    summary_out = out_dir / 'BUILD-SUMMARY.md'

    with open(plan_out, 'w', encoding='utf-8') as f:
        json.dump(build_plan, f, indent=2, ensure_ascii=False)
    with open(bp_out, 'w', encoding='utf-8') as f:
        json.dump(blueprint, f, indent=2, ensure_ascii=False)
    write_summary(build_plan, summary_out)

    stats = build_plan['stats']
    print(f"\nResults:")
    print(f"  {stats['matched']}/{stats['total_sections']} sections matched to templates")
    if stats['unmatched']:
        print(f"  {stats['unmatched']} sections have no template match")
    if stats['needs_resolution']:
        print(f"\n  ⚠ {stats['needs_resolution']} context variable(s) need resolution:")
        for var, desc in build_plan['all_unresolved'].items():
            print(f"    {{{{ {var} }}}} — {desc}")
    else:
        print(f"  ✓ No context variables needed — blueprint ready to import")

    print(f"\nOutputs:")
    print(f"  {plan_out.resolve()}")
    print(f"  {bp_out.resolve()}")
    print(f"  {summary_out.resolve()}")


if __name__ == '__main__':
    main()
