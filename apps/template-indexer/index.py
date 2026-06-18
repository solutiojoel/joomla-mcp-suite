#!/usr/bin/env python3
"""
Template Indexer
================
Reads all section YAML templates from gantry-mcp/templates/sections/
and all homepage meta YAMLs from gantry-mcp/templates/homepages/

Outputs: template-library.json
  - templates:        every section template with metadata
  - block_class_index: block_class -> [template_names]
  - section_id_index:  section_id  -> [template_names]
  - particle_index:    particle_type -> [template_names]
  - usage_stats:       block_class -> count of sites using it
"""

import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'pyyaml', '--break-system-packages', '-q'])
    import yaml


SECTIONS_DIR = Path(__file__).parent.parent / 'gantry-mcp' / 'templates' / 'sections'
HOMEPAGES_DIR = Path(__file__).parent.parent / 'gantry-mcp' / 'templates' / 'homepages'
OUT_PATH = Path(__file__).parent / 'template-library.json'


def extract_block_classes(template: dict) -> list[str]:
    """Collect every blockClass value mentioned in a template's grids."""
    classes = []
    # template may have top-level grids or nested under sections:
    grids_sources = []
    if 'grids' in template:
        grids_sources.extend(template['grids'])
    if 'sections' in template:
        for sec in template['sections'].values():
            grids_sources.extend(sec.get('grids', []))
    for grid in grids_sources:
        for block in grid.get('blocks', []):
            bc = block.get('blockClass', '')
            if bc:
                for cls in bc.split():
                    cls = cls.strip()
                    if cls:
                        classes.append(cls)
    return list(dict.fromkeys(classes))  # deduplicated, order-preserving


def extract_particles(template: dict) -> list[str]:
    """Collect every particle type mentioned in a template."""
    particles = []
    grids_sources = []
    if 'grids' in template:
        grids_sources.extend(template['grids'])
    if 'sections' in template:
        for sec in template['sections'].values():
            grids_sources.extend(sec.get('grids', []))
    for grid in grids_sources:
        for block in grid.get('blocks', []):
            p = block.get('particle', '')
            if p and p not in particles:
                particles.append(p)
    return particles


def extract_context_vars(template: dict) -> list[str]:
    """Find all {{variable_name}} placeholders in the template."""
    raw = yaml.dump(template)
    return list(dict.fromkeys(re.findall(r'\{\{(\w+)\}\}', raw)))


def extract_section_id(template: dict) -> str:
    """Get the primary section id."""
    if 'id' in template:
        return template['id']
    if 'sections' in template:
        return list(template['sections'].keys())[0]
    return 'unknown'


def extract_section_class(template: dict) -> str:
    """Get section attributes.class if present."""
    if 'attributes' in template:
        return template['attributes'].get('class', '')
    if 'sections' in template:
        first = list(template['sections'].values())[0]
        return first.get('attributes', {}).get('class', '')
    return ''


def load_templates() -> dict:
    templates = {}
    for yaml_file in sorted(SECTIONS_DIR.glob('*.yaml')):
        name = yaml_file.stem
        with open(yaml_file, encoding='utf-8') as f:
            data = yaml.safe_load(f)
        if not data:
            continue

        templates[name] = {
            'file': f'sections/{yaml_file.name}',
            'section_id': extract_section_id(data),
            'section_class': extract_section_class(data),
            'particles': extract_particles(data),
            'block_classes': extract_block_classes(data),
            'context_vars': extract_context_vars(data),
            'multi_section': 'sections' in data,
            'raw': data,
        }

        # If multi-section, also expose sub-section ids
        if 'sections' in data:
            templates[name]['sub_section_ids'] = list(data['sections'].keys())

    return templates


def load_usage_stats() -> dict[str, int]:
    """Count how many sites use each block_class (from meta YAMLs)."""
    counts: dict[str, int] = {}
    for meta_file in HOMEPAGES_DIR.glob('*-meta.yaml'):
        with open(meta_file, encoding='utf-8') as f:
            meta = yaml.safe_load(f)
        if not meta:
            continue
        for cls in meta.get('block_classes', []):
            counts[cls] = counts.get(cls, 0) + 1
    return counts


def build_library():
    print(f"Loading templates from {SECTIONS_DIR}")
    templates = load_templates()
    print(f"  {len(templates)} templates loaded")

    print(f"Loading usage stats from {HOMEPAGES_DIR}")
    usage = load_usage_stats()
    print(f"  {len(usage)} block classes with usage data")

    # Build reverse indexes
    block_class_index: dict[str, list[str]] = {}
    section_id_index: dict[str, list[str]] = {}
    particle_index: dict[str, list[str]] = {}

    for name, tmpl in templates.items():
        # section_id_index
        ids_to_index = [tmpl['section_id']]
        if 'sub_section_ids' in tmpl:
            ids_to_index.extend(tmpl['sub_section_ids'])
        for sid in ids_to_index:
            section_id_index.setdefault(sid, [])
            if name not in section_id_index[sid]:
                section_id_index[sid].append(name)

        # block_class_index
        for bc in tmpl['block_classes']:
            block_class_index.setdefault(bc, [])
            if name not in block_class_index[bc]:
                block_class_index[bc].append(name)

        # particle_index
        for p in tmpl['particles']:
            particle_index.setdefault(p, [])
            if name not in particle_index[p]:
                particle_index[p].append(name)

    # Add usage to each template's block classes
    for name, tmpl in templates.items():
        tmpl['block_class_usage'] = {
            bc: usage.get(bc, 0) for bc in tmpl['block_classes']
        }

    library = {
        'generated': __import__('datetime').datetime.utcnow().isoformat() + 'Z',
        'stats': {
            'template_count': len(templates),
            'block_classes_indexed': len(block_class_index),
            'section_ids_indexed': len(section_id_index),
            'particle_types_indexed': len(particle_index),
        },
        'templates': templates,
        'block_class_index': block_class_index,
        'section_id_index': section_id_index,
        'particle_index': particle_index,
        'usage_stats': usage,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(library, f, indent=2, ensure_ascii=False)

    print(f"\nOutput: {OUT_PATH.resolve()}")
    print(f"  Templates:     {library['stats']['template_count']}")
    print(f"  Block classes: {library['stats']['block_classes_indexed']}")
    print(f"  Section IDs:   {library['stats']['section_ids_indexed']}")
    print(f"  Particle types:{library['stats']['particle_types_indexed']}")


if __name__ == '__main__':
    build_library()
