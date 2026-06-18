#!/usr/bin/env python3
"""
Mockup Analyzer
===============
Takes a website mockup image and maps it to a Gantry 5 layout plan using
the design vocabulary built by the synthesizer.

Steps:
  1. Load design-vocabulary.json (from apps/synthesizer/output/)
  2. Condense it into a prompt-sized reference (fingerprints + block options)
  3. Call Claude vision API with the image + reference
  4. Parse the structured response into layout-plan.json

Output layout-plan.json is consumed by apps/gantry-builder/build.py to
actually construct the Gantry outline via MCP tools.

Usage:
  python analyze.py mockup.png
  python analyze.py mockup.png --out my-plan.json
  python analyze.py mockup.png --vocab ../synthesizer/output/design-vocabulary.json
  python analyze.py mockup.png --model claude-opus-4-5
  python analyze.py mockup.png --dry-run     # print prompt only, no API call

Requirements:
  pip install anthropic
  ANTHROPIC_API_KEY environment variable set
"""

import argparse
import base64
import json
import os
import re
import sys
from pathlib import Path

BASE = Path(__file__).parent.parent

DEFAULT_VOCAB = BASE / "synthesizer" / "output" / "design-vocabulary.json"
DEFAULT_MODEL = "claude-sonnet-4-5"

# ---------------------------------------------------------------------------
# Vocabulary condenser
# ---------------------------------------------------------------------------

# Standard Gantry section IDs in top-to-bottom order
GANTRY_SECTIONS = [
    ("g-container-top",  "Top bar — above navigation. Usually holds alert/popup and contact info."),
    ("g-navigation",     "Navigation header — logo, main nav menu, social icons, mobile menu."),
    ("g-slideshow",      "Hero/slider section — the main visual banner. Typically the tallest section."),
    ("g-feature",        "Feature section — immediately below hero. CTAs, key stats, or promo content."),
    ("g-above",          "Above-main — sits just above the main content area. Utility content."),
    ("g-showcase",       "Showcase — prominent content display, often news or events grid."),
    ("g-utility",        "Utility row — compact horizontal content band. Widgets, mass times, alerts."),
    ("g-container-main", "Main content area — full-width or split article/sidebar layout."),
    ("g-expanded",       "Expanded content row — wide full-bleed section below main."),
    ("g-extension",      "Extension — additional content band, often a widget row or CTA strip."),
    ("g-bottom",         "Bottom section — news/events feed, or final CTA before footer."),
    ("g-container-footer","Footer — address, links, social icons."),
    ("g-copyright",      "Copyright bar — small bottom strip with copyright text."),
]

# Human-readable particle type descriptions
PARTICLE_DESC = {
    "swiper":       "Slider/carousel (hero images with text overlays)",
    "blockcontent": "Quicklinks panel (icon links, action buttons, or a sidebar nav)",
    "contentarray": "Content list/grid (news, events, mass times, calendar, widgets, mission text)",
    "custom":       "Custom HTML block (alerts, popup scaffolds, headings, standalone buttons)",
    "logo":         "Site logo image",
    "menu":         "Navigation menu (horizontal top-nav or mobile hamburger)",
    "social":       "Social media icon links",
    "search":       "Search input bar",
    "timeline":     "Events timeline (horizontal scroll or stacked list)",
    "video":        "Video embed or background video",
}

def condense_vocabulary(vocab):
    """
    Turn the full vocabulary into a compact reference for the prompt.
    Groups fingerprints into three categories and summarises each slot's options.
    Target: ~4000 tokens.
    """
    nav_fps    = {}   # navigation headers
    hero_fps   = {}   # hero/slideshow sections
    content_fps = {}  # all other content sections

    for fp, data in vocab.items():
        sec_ids = {o["section_id"] for o in data["occurrences"]}
        has_nav = any("navigation" in (s or "") for s in sec_ids)
        has_hero = any(s in ("g-slideshow",) for s in sec_ids)

        # Navigation: always multi-row and contains logo+menu
        types_in = {v["particle_type"]
                    for slot in data["block_slots"]
                    for v in slot["variants"]
                    if v.get("particle_type")}
        is_nav = has_nav or ("logo" in types_in and "menu" in types_in)

        if is_nav:
            nav_fps[fp] = data
        elif has_hero:
            hero_fps[fp] = data
        else:
            content_fps[fp] = data

    lines = []

    def fmt_slots(data, fp):
        slots = sorted(data["block_slots"], key=lambda s: (s["grid_idx"], s["block_idx"]))
        grids = fp.split("/")
        for g_idx, grid_fp in enumerate(grids):
            grid_slots = [s for s in slots if s["grid_idx"] == g_idx]
            cols = grid_fp.split("|")
            lines.append(f"    Grid row {g_idx+1} [{grid_fp}]: {len(cols)} col(s)")
            for slot in grid_slots:
                variants_seen = {}
                for v in slot["variants"]:
                    pt = v.get("particle_type") or "?"
                    bc = " ".join(v.get("extra_classes", [])) or "(no extra classes)"
                    key = f"{pt}:{bc}"
                    if key not in variants_seen:
                        variants_seen[key] = (pt, bc, v.get("description",""))
                for pt, bc, desc in variants_seen.values():
                    d = f" — {desc}" if desc else ""
                    lines.append(f"      col {slot['block_idx']+1} (size-{slot['size']}): "
                                 f"particle={pt}, blockClass='{bc}'{d}")

    lines.append("=== NAVIGATION HEADER PATTERNS ===")
    lines.append("(Use for the navigation/header region at the top of the page)")
    lines.append("")
    for fp, data in sorted(nav_fps.items(), key=lambda x: -len(x[1]["occurrences"])):
        occs = len(data["occurrences"])
        lines.append(f"  Fingerprint '{fp}' ({occs} site(s)):")
        fmt_slots(data, fp)
        lines.append("")

    lines.append("=== HERO / SLIDESHOW PATTERNS ===")
    lines.append("(Use for the main visual banner section below the nav)")
    lines.append("")
    for fp, data in sorted(hero_fps.items(), key=lambda x: -len(x[1]["occurrences"])):
        occs = len(data["occurrences"])
        tokens = data.get("visual_tokens", [{}])[0]
        avg_h = int(sum(t.get("height_px",0) for t in data["visual_tokens"]) /
                    max(len(data["visual_tokens"]),1))
        lines.append(f"  Fingerprint '{fp}' ({occs} site(s), ~{avg_h}px tall):")
        fmt_slots(data, fp)
        lines.append("")

    lines.append("=== CONTENT SECTION PATTERNS ===")
    lines.append("(Use for news feeds, mass times, calendars, widgets, CTAs, etc.)")
    lines.append("")
    for fp, data in sorted(content_fps.items(), key=lambda x: -len(x[1]["occurrences"])):
        occs = len(data["occurrences"])
        sec_ids = sorted({o["section_id"] for o in data["occurrences"] if o.get("section_id")})
        avg_h = int(sum(t.get("height_px",0) for t in data["visual_tokens"]) /
                    max(len(data["visual_tokens"]),1))
        lines.append(f"  Fingerprint '{fp}' ({occs} site(s), ~{avg_h}px, typical sections={sec_ids[:3]}):")
        fmt_slots(data, fp)
        lines.append("")

    return "\n".join(lines)

# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """\
You are a Gantry 5 layout architect for Catholic parish and school websites.
Your job is to analyze a website mockup image and produce a precise Gantry 5
layout plan that maps every visible section to the correct Gantry section ID,
layout fingerprint, and particle block classes.

## Gantry structure primer

A Gantry 5 page is a vertical stack of <section> elements, each with an ID
like g-navigation, g-slideshow, g-feature, etc.

Inside each section:
  section > .g-container > .g-grid > .g-block > [particle]

A layout fingerprint describes the column widths within a section's grid rows,
e.g. "70|30" means one 70%-wide block and one 30%-wide block side-by-side.
Multiple grid rows in one section are joined with "/", e.g. "100/100/60|40/100".

Block classes are the CSS hooks on each .g-block that control its visual style.
The size class (size-100, size-70, etc.) is always present; extra classes like
"fullwidth-swiper rotate-wide" or "ql-toplinks-studius" are the variant anchors.

## Output format

Respond ONLY with a JSON object — no markdown, no explanation.

{
  "analysis": "2-3 sentence description of the overall design",
  "sections": [
    {
      "gantry_section": "g-slideshow",
      "label": "Hero with sidebar quicklinks",
      "fingerprint": "70|30",
      "confidence": 0.9,
      "grids": [
        {
          "grid_row": 1,
          "blocks": [
            {
              "col": 1,
              "size": 70,
              "particle_type": "swiper",
              "block_classes": ["fullwidth-swiper", "rotate-wide"],
              "notes": "Hero carousel, 70% width"
            },
            {
              "col": 2,
              "size": 30,
              "particle_type": "blockcontent",
              "block_classes": ["ql-toplinks-studius"],
              "notes": "Vertical quicklinks sidebar"
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- List sections top to bottom as they appear in the mockup
- Use ONLY the Gantry section IDs and fingerprints from the reference below
- Use ONLY the block_classes options listed for each slot in the reference
- If you are unsure about a block class, use an empty array []
- confidence: 0.0–1.0 (how confident you are this is the right fingerprint)
- Every section must have at least one grid with at least one block
"""

def build_user_prompt(vocab_condensed):
    gantry_sec_ref = "\n".join(
        f"  {sid}: {desc}" for sid, desc in GANTRY_SECTIONS
    )
    particle_ref = "\n".join(
        f"  {k}: {v}" for k, v in PARTICLE_DESC.items()
    )
    return f"""\
Analyze the mockup image and produce a Gantry 5 layout plan.

## Available Gantry section IDs (top to bottom)
{gantry_sec_ref}

## Particle types
{particle_ref}

## Design vocabulary (available fingerprints and block class options)
{vocab_condensed}

Now analyze the mockup and output the JSON layout plan.
"""

# ---------------------------------------------------------------------------
# API call
# ---------------------------------------------------------------------------

def encode_image(path):
    with open(path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("utf-8")

def call_claude(image_path, system_prompt, user_prompt, model):
    try:
        import anthropic
    except ImportError:
        print("ERROR: anthropic package not installed. Run: pip install anthropic")
        sys.exit(1)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable not set")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    img_data  = encode_image(image_path)
    img_path  = Path(image_path)
    mime_type = "image/png" if img_path.suffix.lower() == ".png" else "image/jpeg"

    print(f"Calling {model} with image ({img_path.name}, "
          f"{len(img_data)//1024}KB encoded)...")

    response = client.messages.create(
        model=model,
        max_tokens=4096,
        system=system_prompt,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type":       "base64",
                            "media_type": mime_type,
                            "data":       img_data,
                        },
                    },
                    {
                        "type": "text",
                        "text": user_prompt,
                    },
                ],
            }
        ],
    )

    return response.content[0].text

# ---------------------------------------------------------------------------
# Response parser
# ---------------------------------------------------------------------------

def parse_response(raw_text):
    """Extract JSON from Claude's response, tolerating minor noise."""
    # Try direct parse first
    try:
        return json.loads(raw_text.strip())
    except json.JSONDecodeError:
        pass

    # Strip markdown code fences
    cleaned = re.sub(r"```(?:json)?", "", raw_text).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Find first { ... } block
    m = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not parse JSON from response:\n{raw_text[:500]}")

# ---------------------------------------------------------------------------
# Post-process plan
# ---------------------------------------------------------------------------

def enrich_plan(plan, vocab):
    """
    Add a 'css_hints' field to each block summarising the key CSS rules
    for that variant from the vocabulary.
    """
    for sec in plan.get("sections", []):
        fp = sec.get("fingerprint", "")
        vdata = vocab.get(fp, {})
        slots = vdata.get("block_slots", [])

        for g_idx, grid in enumerate(sec.get("grids", [])):
            for b_idx, block in enumerate(grid.get("blocks", [])):
                # Find matching slot
                slot = next((s for s in slots
                             if s["grid_idx"] == g_idx and s["block_idx"] == b_idx), None)
                if not slot:
                    continue
                # Find variant whose extra_classes match block_classes
                bc_set = set(block.get("block_classes", []))
                for v in slot.get("variants", []):
                    ec_set = set(v.get("extra_classes", []))
                    if ec_set and ec_set.issubset(bc_set | {""}):
                        if v.get("screenshot"):
                            block["_particle_screenshot"] = v["screenshot"]
                        if v.get("description"):
                            block["_description"] = v["description"]
                        break
    return plan

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Analyze a mockup image into a Gantry 5 layout plan")
    parser.add_argument("image", help="Path to mockup image (PNG or JPEG)")
    parser.add_argument("--out",   default=None, help="Output JSON path (default: layout-plan.json next to image)")
    parser.add_argument("--vocab", default=str(DEFAULT_VOCAB), help="Path to design-vocabulary.json")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--dry-run", action="store_true", help="Print prompt only, no API call")
    args = parser.parse_args()

    image_path = Path(args.image)
    if not image_path.exists():
        print(f"ERROR: image not found: {image_path}")
        sys.exit(1)

    vocab_path = Path(args.vocab)
    if not vocab_path.exists():
        print(f"ERROR: vocabulary not found: {vocab_path}")
        print("Run apps/synthesizer/build.py first.")
        sys.exit(1)

    out_path = Path(args.out) if args.out else image_path.parent / "layout-plan.json"

    print("Loading design vocabulary...")
    vocab = json.loads(vocab_path.read_text(encoding="utf-8"))
    print(f"  {len(vocab)} fingerprints loaded")

    print("Condensing vocabulary for prompt...")
    vocab_condensed = condense_vocabulary(vocab)
    print(f"  condensed to {len(vocab_condensed)} chars")

    system_prompt = SYSTEM_PROMPT
    user_prompt   = build_user_prompt(vocab_condensed)

    if args.dry_run:
        print("\n--- SYSTEM PROMPT ---")
        print(system_prompt)
        print("\n--- USER PROMPT ---")
        print(user_prompt)
        print(f"\n--- IMAGE: {image_path} ---")
        print("(dry run — no API call made)")
        return

    raw_response = call_claude(image_path, system_prompt, user_prompt, args.model)

    print("Parsing response...")
    try:
        plan = parse_response(raw_response)
    except ValueError as e:
        print(f"ERROR: {e}")
        # Save raw response for debugging
        raw_out = out_path.with_suffix(".raw.txt")
        raw_out.write_text(raw_response, encoding="utf-8")
        print(f"Raw response saved to: {raw_out}")
        sys.exit(1)

    # Enrich with CSS hints from vocabulary
    plan = enrich_plan(plan, vocab)

    # Add metadata
    plan["_meta"] = {
        "image":  str(image_path),
        "model":  args.model,
        "vocab":  str(vocab_path),
    }

    out_path.write_text(json.dumps(plan, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nDone.")
    print(f"  Sections in plan: {len(plan.get('sections', []))}")
    if plan.get("analysis"):
        print(f"  Analysis: {plan['analysis'][:120]}")
    print(f"  Layout plan: {out_path}")

    # Human-readable summary
    for sec in plan.get("sections", []):
        fp = sec.get("fingerprint", "?")
        label = sec.get("label", "")
        conf = sec.get("confidence", 0)
        print(f"  [{conf:.0%}] {sec['gantry_section']} ({fp}) — {label}")


if __name__ == "__main__":
    main()
