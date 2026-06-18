#!/usr/bin/env python3
"""
Design Vocabulary Synthesizer
==============================
Joins the three reference datasets into a single queryable design vocabulary:

  particle-inventory  →  what block classes exist across the fleet
  particle-library    →  what each particle variant looks like + its CSS
  section-library     →  how particles are arranged in sections + structural CSS

Output:
  output/
    design-vocabulary.json   ← machine-readable, used by mockup analyzer
    design-vocabulary.md     ← human-readable reference with image links
    fingerprints/
      {fingerprint-slug}/
        index.md             ← all occurrences, screenshots, CSS for this layout
        sections/            ← symlinked or copied section screenshots

Usage:
  python build.py
  python build.py --out ./output
  python build.py --particle-lib ../../particle-library/output
  python build.py --section-lib  ../../section-library/output
  python build.py --inventory    ../../particle-inventory/output
"""

import argparse
import json
import re
import shutil
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths (relative to this script)
# ---------------------------------------------------------------------------
BASE = Path(__file__).parent.parent

DEFAULT_PARTICLE_LIB  = BASE / "particle-library" / "output"
DEFAULT_SECTION_LIB   = BASE / "section-library"  / "output"
DEFAULT_INVENTORY     = BASE / "particle-inventory" / "output"
DEFAULT_PARTICLE_CFG  = BASE / "particle-library"  / "config.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")

def now_str():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

def non_default(d, skip=("none","auto","normal","0px","","rgba(0, 0, 0, 0)",
                         "transparent","nowrap","visible","static","0",
                         "rgb(0, 0, 0)","start")):
    return {k: v for k, v in d.items() if v and v not in skip}

# ---------------------------------------------------------------------------
# Load particle-library config → selector-to-variant map
# ---------------------------------------------------------------------------

def load_particle_config(cfg_path):
    """
    Returns two dicts:
      selector_map : ".block-class" -> {"type", "variant", "description", "notes"}
      variant_map  : "type/variant" -> same dict
    """
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    selector_map = {}
    variant_map  = {}
    for entry in cfg["particles"]:
        info = {
            "type":        entry["type"],
            "variant":     entry["variant"],
            "description": entry.get("description", ""),
            "notes":       entry.get("notes", ""),
            "selectors":   entry["selectors"],
        }
        for sel in entry["selectors"]:
            # primary selector class  e.g. ".swiper-ql-overlay"
            selector_map[sel] = info
        variant_map[f"{entry['type']}/{entry['variant']}"] = info
    return selector_map, variant_map

# ---------------------------------------------------------------------------
# Load particle-library output → variant screenshots + CSS
# ---------------------------------------------------------------------------

def load_particle_library(lib_root):
    """
    Walks lib_root for styles.json files.
    Returns dict keyed "type/variant/site-slug" → {screenshot_path, styles_data}
    """
    entries = {}
    for styles_path in lib_root.rglob("styles.json"):
        parts = styles_path.relative_to(lib_root).parts
        if len(parts) < 4:
            continue
        ptype, variant, site_slug = parts[0], parts[1], parts[2]
        key = f"{ptype}/{variant}/{site_slug}"
        screenshot = styles_path.parent / "screenshot.png"
        data = json.loads(styles_path.read_text(encoding="utf-8"))
        entries[key] = {
            "screenshot_path": screenshot if screenshot.exists() else None,
            "matched_rules":   data.get("matched_rules", []),
            "computed_visual": data.get("computed_visual", {}),
        }
    return entries

# ---------------------------------------------------------------------------
# Load particle-inventory → block-class → type + css summary
# ---------------------------------------------------------------------------

def load_inventory(inv_root):
    """
    Reads combined.json from the inventory scanner.
    Returns dict: block_class_key -> {type, css_rules, text_hint, source_urls}
    """
    combined_path = inv_root / "combined.json"
    if not combined_path.exists():
        return {}
    combined = json.loads(combined_path.read_text(encoding="utf-8"))
    index = {}
    for site_slug, particles in combined.items():
        for p in particles:
            for bc in p.get("block_classes", []):
                if re.match(r"^size-", bc):
                    continue
                if bc not in index:
                    index[bc] = {
                        "type":        p["type"],
                        "css_rules":   p.get("css_rules", []),
                        "text_hint":   p.get("text_hint", ""),
                        "source_urls": p.get("source_urls", []),
                    }
    return index

# ---------------------------------------------------------------------------
# Load section-library → all sections across all sites/pages
# ---------------------------------------------------------------------------

def load_sections(sec_root):
    """
    Walks sec_root for sections.json files.
    Returns list of section dicts, each augmented with:
      _site_slug, _page_slug, _screenshot_abs_path
    """
    all_sections = []
    for sjson in sec_root.rglob("sections.json"):
        parts = sjson.relative_to(sec_root).parts
        if len(parts) < 3:
            continue
        site_slug, page_slug = parts[0], parts[1]
        data = json.loads(sjson.read_text(encoding="utf-8"))
        shot_dir = sjson.parent / "screenshots"
        for s in data.get("sections", []):
            s["_site_slug"] = site_slug
            s["_page_slug"] = page_slug
            shot_name = s.get("screenshot")
            s["_screenshot_abs"] = (
                shot_dir / shot_name if shot_name and (shot_dir / shot_name).exists() else None
            )
            all_sections.append(s)
    return all_sections

# ---------------------------------------------------------------------------
# Core join: for each block in a section, resolve variant + screenshot
# ---------------------------------------------------------------------------

def resolve_block(block, selector_map, inv_index, lib_entries, site_slug):
    """
    Given a section block, return enriched info:
      - variant info from particle config (if selector matches)
      - screenshot path from particle library (if available)
      - css summary from inventory (fallback)
    """
    extra_classes = [c for c in block.get("block_classes", [])
                     if not re.match(r"^size-", c)]

    variant_info = None
    lib_key      = None

    # Try to match any block class against selector_map
    for bc in extra_classes:
        sel = "." + bc
        if sel in selector_map:
            variant_info = selector_map[sel]
            break

    # Find particle library screenshot: type/variant/site-slug
    screenshot_path = None
    if variant_info:
        ptype   = variant_info["type"]
        variant = variant_info["variant"]
        # prefer same site, then any site
        for candidate_key in [
            f"{ptype}/{variant}/{site_slug}",
        ]:
            if candidate_key in lib_entries and lib_entries[candidate_key]["screenshot_path"]:
                screenshot_path = lib_entries[candidate_key]["screenshot_path"]
                lib_key = candidate_key
                break
        if not screenshot_path:
            # fallback: any site that has this variant
            prefix = f"{ptype}/{variant}/"
            for k, v in lib_entries.items():
                if k.startswith(prefix) and v["screenshot_path"]:
                    screenshot_path = v["screenshot_path"]
                    lib_key = k
                    break

    # CSS from inventory as fallback
    inv_info = None
    for bc in extra_classes:
        if bc in inv_index:
            inv_info = inv_index[bc]
            break

    return {
        "size":          block.get("size"),
        "block_classes": block.get("block_classes", []),
        "extra_classes": extra_classes,
        "particle":      block.get("particle"),
        "variant_info":  variant_info,
        "lib_key":       lib_key,
        "screenshot_path": screenshot_path,
        "inv_info":      inv_info,
        "computed":      block.get("computed", {}),
    }

# ---------------------------------------------------------------------------
# Extract visual tokens from a section for mockup matching
# ---------------------------------------------------------------------------

def extract_visual_tokens(section):
    """Pull the most useful visual signals from computed section/container styles."""
    cs = section.get("computed_section", {})
    cc = section.get("computed_container", {})

    tokens = {}

    # Height category
    h = cs.get("height", "")
    try:
        px = float(re.sub(r"[^0-9.]", "", h))
        if px >= 400:
            tokens["height_category"] = "hero"
        elif px >= 100:
            tokens["height_category"] = "row"
        else:
            tokens["height_category"] = "band"
        tokens["height_px"] = round(px)
    except Exception:
        pass

    # Background
    bg_img = cs.get("background-image", "none")
    bg_col = cs.get("background-color", "")
    if bg_img and bg_img != "none":
        tokens["background"] = "image"
    elif bg_col and bg_col not in ("rgba(0, 0, 0, 0)", "transparent", ""):
        tokens["background"] = "color"
        tokens["background_color"] = bg_col
    else:
        tokens["background"] = "none"

    # Container max-width
    mw = cc.get("max-width", "")
    if mw and mw not in ("none", ""):
        tokens["container_max_width"] = mw

    # Column structure from fingerprint
    fp = section.get("section_fingerprint", "")
    grids = fp.split("/") if fp else []
    tokens["grid_count"] = len(grids)
    tokens["column_patterns"] = grids

    # Primary particle types (first grid only)
    first_grid = section.get("grids", [{}])[0] if section.get("grids") else {}
    types = [b.get("particle", {}).get("type") if b.get("particle") else None
             for b in first_grid.get("blocks", [])]
    tokens["primary_particle_types"] = [t for t in types if t]

    return tokens

# ---------------------------------------------------------------------------
# Build the vocabulary
# ---------------------------------------------------------------------------

def build_vocabulary(sections, selector_map, inv_index, lib_entries):
    """
    Groups sections by fingerprint.
    For each fingerprint, accumulates occurrences and resolves block variants.
    Returns vocabulary dict keyed by fingerprint.
    """
    vocab = {}

    for sec in sections:
        fp = sec.get("section_fingerprint", "?")
        if fp not in vocab:
            vocab[fp] = {
                "fingerprint":    fp,
                "occurrences":    [],
                "block_slots":    [],   # one entry per grid×block position
                "visual_tokens":  [],   # one per occurrence
            }
        entry = vocab[fp]

        site_slug = sec.get("_site_slug", "")
        page_slug = sec.get("_page_slug", "")
        tokens    = extract_visual_tokens(sec)

        occ = {
            "site":         site_slug,
            "page":         page_slug,
            "section_id":   sec.get("section_id"),
            "classes":      sec.get("section_classes", []),
            "screenshot":   str(sec["_screenshot_abs"]) if sec.get("_screenshot_abs") else None,
            "visual_tokens": tokens,
            "css_summary":   non_default(sec.get("computed_section", {})),
        }
        entry["occurrences"].append(occ)
        entry["visual_tokens"].append(tokens)

        # Accumulate block slots (indexed by grid_idx, block_idx)
        for g_idx, grid in enumerate(sec.get("grids", [])):
            for b_idx, block in enumerate(grid.get("blocks", [])):
                slot_key = (g_idx, b_idx)
                # find existing slot entry or create
                slot = next((s for s in entry["block_slots"]
                             if s["grid_idx"] == g_idx and s["block_idx"] == b_idx), None)
                if not slot:
                    slot = {
                        "grid_idx":   g_idx,
                        "block_idx":  b_idx,
                        "size":       block.get("size"),
                        "variants":   [],
                    }
                    entry["block_slots"].append(slot)

                resolved = resolve_block(block, selector_map, inv_index, lib_entries, site_slug)
                # Only add a new variant entry if this variant isn't already recorded
                vi = resolved.get("variant_info")
                variant_key = (
                    f"{vi['type']}/{vi['variant']}" if vi else
                    "/".join(resolved["extra_classes"]) if resolved["extra_classes"] else
                    resolved.get("particle", {}).get("type", "unknown") if resolved.get("particle") else "empty"
                )
                if not any(v["variant_key"] == variant_key for v in slot["variants"]):
                    slot["variants"].append({
                        "variant_key":   variant_key,
                        "block_classes": resolved["block_classes"],
                        "extra_classes": resolved["extra_classes"],
                        "particle_type": resolved["particle"]["type"] if resolved.get("particle") else None,
                        "variant_name":  vi["variant"] if vi else None,
                        "description":   vi["description"] if vi else "",
                        "screenshot":    str(resolved["screenshot_path"]) if resolved.get("screenshot_path") else None,
                        "lib_key":       resolved.get("lib_key"),
                    })

    return vocab

# ---------------------------------------------------------------------------
# Markdown output
# ---------------------------------------------------------------------------

def rel_path(path_str, from_dir):
    """Make a path relative to from_dir for markdown links, using forward slashes."""
    if not path_str:
        return None
    try:
        return Path(path_str).relative_to(from_dir).as_posix()
    except ValueError:
        return path_str.replace("\\", "/")

def write_fingerprint_md(fp, entry, fp_dir, out_root):
    """Write index.md for one fingerprint."""
    fp_dir.mkdir(parents=True, exist_ok=True)
    occs = entry["occurrences"]
    slots = sorted(entry["block_slots"], key=lambda s: (s["grid_idx"], s["block_idx"]))

    lines = [
        f"# Layout: `{fp}`",
        "",
        f"**{len(occs)} occurrence(s) across the fleet**",
        "",
        "## Column structure",
        "",
    ]

    grids = fp.split("/")
    for i, grid_fp in enumerate(grids):
        cols = grid_fp.split("|")
        lines.append(f"**Grid row {i+1}:** {len(cols)} column(s) — {grid_fp}")
        for slot in [s for s in slots if s["grid_idx"] == i]:
            lines.append(f"  - Column {slot['block_idx']+1}: size-{slot['size']}")
    lines.append("")

    # Block slot details
    lines += ["## Block slots", ""]
    for slot in slots:
        lines.append(f"### Grid {slot['grid_idx']+1}, Column {slot['block_idx']+1} (size-{slot['size']})")
        lines.append("")
        for v in slot["variants"]:
            bc_str = " ".join(f"`.{c}`" for c in v["extra_classes"]) if v["extra_classes"] else "_(no extra classes)_"
            lines += [
                f"#### `{v['variant_key']}`",
                "",
                f"**Block classes:** {bc_str}  ",
                f"**Particle type:** `{v['particle_type'] or '(unknown)'}`  ",
            ]
            if v.get("description"):
                lines.append(f"**Description:** {v['description']}  ")
            if v.get("screenshot"):
                rel = rel_path(v["screenshot"], out_root)
                lines.append(f"**Particle screenshot:**  ")
                lines.append(f"![{v['variant_key']}]({rel})")
            lines.append("")

    # Occurrences with section screenshots
    lines += ["## Occurrences", ""]
    for occ in occs:
        sid = occ.get("section_id") or "unknown"
        cls_str = " ".join(f"`.{c}`" for c in occ["classes"]) if occ["classes"] else "_(none)_"
        lines += [
            f"### `{occ['site']}/{occ['page']}` — `{sid}`",
            "",
            f"**Section classes:** {cls_str}  ",
        ]
        t = occ.get("visual_tokens", {})
        if t.get("height_category"):
            lines.append(f"**Height:** {t.get('height_px','?')}px ({t['height_category']})  ")
        if t.get("background"):
            bg = t["background"]
            if bg == "color":
                lines.append(f"**Background:** solid `{t.get('background_color','')}`  ")
            elif bg == "image":
                lines.append(f"**Background:** image  ")
        if t.get("container_max_width"):
            lines.append(f"**Container max-width:** {t['container_max_width']}  ")
        if occ.get("screenshot"):
            rel = rel_path(occ["screenshot"], fp_dir)
            lines.append(f"")
            lines.append(f"![section screenshot]({rel})")
        lines.append("")

    (fp_dir / "index.md").write_text("\n".join(lines), encoding="utf-8")


def write_vocabulary_md(vocab, out_root):
    """Top-level human-readable index."""
    lines = [
        "# Solutio Design Vocabulary",
        "",
        f"_Generated {now_str()}_",
        "",
        "This document maps every layout pattern found across the fleet to:",
        "- Its structural fingerprint (column widths per grid row)",
        "- The particle variants that appear in each block position",
        "- Visual tokens (height, background) for mockup matching",
        "- Links to section screenshots and particle screenshots",
        "",
        "---",
        "",
        "## Quick reference: layout fingerprints",
        "",
        "| Fingerprint | Sites | Grids | Typical content |",
        "|-------------|------:|------:|-----------------|",
    ]

    for fp, entry in sorted(vocab.items(), key=lambda x: (-len(x[1]["occurrences"]), x[0])):
        sites = len({o["site"] for o in entry["occurrences"]})
        grids = len(fp.split("/"))
        # summarise typical particles
        all_types = []
        for slot in entry["block_slots"]:
            for v in slot["variants"]:
                if v.get("particle_type"):
                    all_types.append(v["particle_type"])
        typical = ", ".join(sorted(set(all_types)))[:60]
        fp_slug = slugify(fp)
        lines.append(f"| [`{fp}`](fingerprints/{fp_slug}/index.md) | {sites} | {grids} | {typical} |")

    lines += [
        "",
        "---",
        "",
        "## Fingerprint detail pages",
        "",
    ]
    for fp, entry in sorted(vocab.items(), key=lambda x: (-len(x[1]["occurrences"]), x[0])):
        fp_slug = slugify(fp)
        sites = sorted({o["site"] for o in entry["occurrences"]})
        lines += [
            f"### [`{fp}`](fingerprints/{fp_slug}/index.md)",
            "",
            f"**{len(entry['occurrences'])} occurrence(s)** across: {', '.join(sites[:6])}{'...' if len(sites) > 6 else ''}",
            "",
        ]
        for slot in sorted(entry["block_slots"], key=lambda s: (s["grid_idx"], s["block_idx"])):
            for v in slot["variants"]:
                bc_str = " ".join(f"`.{c}`" for c in v["extra_classes"]) if v["extra_classes"] else ""
                lines.append(f"- Grid {slot['grid_idx']+1} col {slot['block_idx']+1}: `{v.get('particle_type','?')}` {bc_str}")
        lines.append("")

    (out_root / "design-vocabulary.md").write_text("\n".join(lines), encoding="utf-8")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Build Solutio design vocabulary")
    parser.add_argument("--out",          default="output")
    parser.add_argument("--particle-lib", default=str(DEFAULT_PARTICLE_LIB))
    parser.add_argument("--section-lib",  default=str(DEFAULT_SECTION_LIB))
    parser.add_argument("--inventory",    default=str(DEFAULT_INVENTORY))
    parser.add_argument("--particle-cfg", default=str(DEFAULT_PARTICLE_CFG))
    args = parser.parse_args()

    out_root    = Path(args.out)
    lib_root    = Path(args.particle_lib)
    sec_root    = Path(args.section_lib)
    inv_root    = Path(args.inventory)
    cfg_path    = Path(args.particle_cfg)

    out_root.mkdir(parents=True, exist_ok=True)

    print("Loading particle config...")
    selector_map, variant_map = load_particle_config(cfg_path)
    print(f"  {len(selector_map)} selectors, {len(variant_map)} variants")

    print("Loading particle library...")
    lib_entries = load_particle_library(lib_root)
    print(f"  {len(lib_entries)} library entries")

    print("Loading particle inventory...")
    inv_index = load_inventory(inv_root)
    print(f"  {len(inv_index)} block classes indexed")

    print("Loading section library...")
    sections = load_sections(sec_root)
    print(f"  {len(sections)} sections loaded")

    print("Building vocabulary...")
    vocab = build_vocabulary(sections, selector_map, inv_index, lib_entries)
    print(f"  {len(vocab)} unique fingerprints")

    print("Writing outputs...")

    # Per-fingerprint markdown pages
    fp_root = out_root / "fingerprints"
    for fp, entry in vocab.items():
        fp_slug = slugify(fp)
        fp_dir  = fp_root / fp_slug
        write_fingerprint_md(fp, entry, fp_dir, out_root)

    # Top-level vocabulary markdown
    write_vocabulary_md(vocab, out_root)

    # Full JSON export (strip Path objects for serialisation)
    def make_serialisable(obj):
        if isinstance(obj, Path):
            return str(obj)
        if isinstance(obj, dict):
            return {k: make_serialisable(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [make_serialisable(i) for i in obj]
        return obj

    (out_root / "design-vocabulary.json").write_text(
        json.dumps(make_serialisable(vocab), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    total_occs = sum(len(e["occurrences"]) for e in vocab.values())
    total_variants = sum(
        len(v["variants"])
        for e in vocab.values()
        for v in e["block_slots"]
    )
    print(f"\nDone.")
    print(f"  {len(vocab)} fingerprints")
    print(f"  {total_occs} section occurrences mapped")
    print(f"  {total_variants} block variants resolved")
    print(f"  Output: {out_root.resolve()}")
    print(f"  Main reference: {(out_root / 'design-vocabulary.md').resolve()}")


if __name__ == "__main__":
    main()
