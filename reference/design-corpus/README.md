# Design Corpus — scraped reference data

Read-only reference data captured from the live Solutio fleet in June 2026.
**No code here.** The Python scrapers that produced these files targeted a tool
(`joomla_gantry5_import_outline_blueprint`) that no longer exists and were
removed; the data they produced is still accurate and still useful.

| Directory | What it holds | Size |
|---|---|---|
| `particle-inventory/` | Every block class in use across the fleet, per site | 12M |
| `particle-library/` | Screenshot + computed CSS per particle type and variant | 29M |
| `section-library/` | Section structure (`section > container > grid > block > particle`) with layout fingerprints like `66\|33`, plus section screenshots | 133M |
| `synthesizer/` | `design-vocabulary.json` — the three sets above joined into one queryable vocabulary, keyed by layout fingerprint | 748K |
| `template-indexer/` | `template-library.json` — index of section templates by block class, section id, and particle type | 56K |

## What reads this

Nothing, yet. This is the raw material for the **site-build** vision stage:
the `design-vocabulary.json` fingerprint index is how a mockup's visual rows
(`66|33`, `33|33|33`) get mapped to section templates that already exist in
`apps/gantry-mcp/templates/sections/`.

## What is authoritative instead

For anything an agent reads at build time, prefer the live tool surface — it is
maintained, this corpus is a snapshot:

- `gantry_reference { topic: "particles" }` — particle attribute schemas
- `gantry_reference { topic: "patterns" }` — named section patterns
- `gantry_reference { topic: "section_templates" }` — section YAML starters
- `gantry_reference { topic: "homepage_examples" }` — captured `#Home` outlines

## Refreshing

There is no scraper any more. If this data needs to be regenerated, write the
capture against the current tool surface rather than restoring the old scripts —
they were built for a pre-consolidation API.
