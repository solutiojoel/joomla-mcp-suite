# The AI-first Studius kit

Ten files that replace the css2 stylesheet set. Eight CSS files are shared
and identical on every site; two files (one CSS, one per-site) ship inside
each site's forge clone.

The kit is **not wired into any tool yet.** Nothing in this repository reads
these files, and no live site loads them. See *Not done yet* at the bottom.

---

## The files

| File | Scope | Layer | What it holds |
|------|-------|-------|---------------|
| `tokens.css` | shared | `kit.tokens` | Every design value. No rule that styles anything. |
| `typography.css` | shared | `kit.typography` | The HTML a person types into an article, plus the author classes. |
| `boilerplate.css` | shared | `kit.boilerplate` | Corrections to Gantry's own framework behaviour. |
| `sections.css` | shared | `kit.sections` | One background rule per `#g-<section>`. Nothing else. |
| `blocks.css` | shared | `kit.blocks` | The composite patterns built on particle or component markup nobody can restructure. No look, no design default — see the file header. |
| `vendor.css` | shared | `kit.vendor` | DOCman and FILEman (Koowa) markup. |
| `features.css` | shared | `kit.features` | Alert, bulletin, ads, sponsorship, PWA chrome. |
| `a11y-print.css` | shared | `kit.a11y-print` | Focus ring, skip link, sr-only, print, and the reduced-motion backstop. Written fresh — nothing in css2 to migrate. |
| `site-tokens.css` | per site | none — unlayered | This site's brand values. The only file a build edits for brand. |
| `editor.css` | per site | none | TinyMCE chrome. Declares no design values. |

---

## Cascade order

`tokens.css` opens with an `@layer` statement that fixes the order of all eight
layers before any of them loads. Asset row priority therefore controls *when a
file arrives*, never *what beats what*. Reordering an asset row in the Gantry
admin can no longer change how the site looks.

Later beats earlier:

```
kit.tokens → kit.typography → kit.boilerplate → kit.sections
           → kit.blocks → kit.vendor → kit.features → kit.a11y-print
```

`kit.a11y-print` is last on purpose: a focus ring must never lose to a
component's own hover state, and `@media print` inside it has to be able to
hide anything any layer before it showed.

Everything a build writes per page stays **unlayered**, so it beats all eight
without needing to know any of this. `site-tokens.css` is unlayered for the same
reason: it must win over `kit.tokens` regardless of specificity.

---

## Front end — Base outline CSS asset rows

Add these to the **Base outline** only, so every outline inherits them.

| Priority | Location |
|----------|----------|
| 1 | `https://shared.solutiocdn.com/content/shared/kit/tokens.css` |
| 1 | `https://shared.solutiocdn.com/content/shared/kit/typography.css` |
| 1 | `https://shared.solutiocdn.com/content/shared/kit/boilerplate.css` |
| 1 | `https://shared.solutiocdn.com/content/shared/kit/sections.css` |
| 1 | `https://shared.solutiocdn.com/content/shared/kit/blocks.css` |
| 1 | `https://shared.solutiocdn.com/content/shared/kit/vendor.css` |
| 1 | `https://shared.solutiocdn.com/content/shared/kit/features.css` |
| 1 | `https://shared.solutiocdn.com/content/shared/kit/a11y-print.css` |
| 2 | `/content/site-tokens.css` |
| 3 | `/images/pub/override.css` |

Priorities only need to keep the per-site files after the shared ones. The
`@layer` statement handles the rest.

`vendor.css` and `features.css` can be dropped from a site that has no DOCman
and no alert. Nothing else is optional — `a11y-print.css` least of all.

---

## Editor — Plugins > Editor - TinyMCE > Custom CSS Classes

One line, comma separated, no spaces after the commas:

```
https://shared.solutiocdn.com/content/shared/kit/tokens.css,https://shared.solutiocdn.com/content/shared/kit/typography.css,/content/site-tokens.css,/content/editor.css,/images/pub/editor.css
```

The editor deliberately loads **only** tokens and typography from the shared
set. The other five style Gantry sections, particles and extension markup, none
of which exists inside the TinyMCE iframe. `editor.css` explains the rest.

---

## Where a new rule goes

Ask the questions in this order and stop at the first yes.

1. **Is it a value — a colour, size, radius, duration?**
   → `tokens.css`. Never declare a token anywhere else.

2. **Does it style HTML a person types into an article?**
   → `typography.css`, and it must render identically in the editor.

3. **Does it correct something Gantry itself does wrong on every site?**
   → `boilerplate.css`. It has to fail all three of its own tests to belong
   elsewhere; read the header.

4. **Is it a `#g-<section>` background?**
   → `sections.css`, as a token binding. Nothing else goes in that file.

5. **Does the CSS have to know markup the build cannot restructure — a particle
   nest, a component's blog layout, a third-party embed?**
   → `blocks.css`, and only if it is genuinely reused.

6. **Is it DOCman, FILEman or another extension's markup?**
   → `vendor.css`.

7. **Is it a feature every site carries — the alert, the bulletin, ads?**
   → `features.css`.

8. **Otherwise** → it is this design, on this site. Write it fresh in the
   site's own CSS. That is the normal answer, and it is the point of the kit:
   the AI writes a design's CSS faster than a person finds the right variant
   class. `kb/quicklinks-particle` and `kb/rotator-particle` are the model —
   they describe what the particle needs and ship no CSS recipe at all.

A page-specific rule written into a shared file is how a 21,000-line stylesheet
gets built, one reasonable decision at a time.

---

## What css2 became

| css2 file | Where it went |
|-----------|---------------|
| `base.2.0.css` | Split across `typography`, `boilerplate`, `features`, `vendor`. |
| `studius.2.0.css` | Split across `boilerplate`, `blocks`, `features`. |
| `widgets.2.0.css` | `blocks.css` — widget row and staff grid. |
| `headlines.2.0.css` | Dropped from CSS entirely. `kb/news-grid-particle` — a requirements guide, no recipe. |
| `slideshow.2.0.css` | `blocks.css` — the two-rule rotator default only. Its six named looks (`modern-dots`, `round-swiper-buttons`, `fullwidth-swiper`, `grand-entry`, `floatator`, `ql-swiper-sidelinks`) are dropped, per `kb/rotator-particle`. |
| `section.css` | `sections.css`, with the column fixes parked into `boilerplate.css`. |
| `footer.css`, `local-images.css` | Absorbed into `sections.css`. |
| `solutio-font.css` | Absorbed into `typography.css`, so the editor sees icons too. |
| `editor-base.css` | Absorbed into `typography.css`. |
| `fonts2.css` dark mode | Dropped. Every declaration in it was invalid. |
| *(nothing)* | `a11y-print.css` — focus, skip link, sr-only, print. css2 had zero rules in any of these categories; nothing to absorb, written fresh. |

Roughly 21,000 lines became roughly 4,000. Most of the difference was design
variation — padding ladders, height ladders, and named card variants — which
the kit deliberately does not carry.

---

## Not done yet

* No tool reads this directory. The files are not uploaded to the CDN, not
  referenced by `gantry-mcp`, and not in any site's asset rows.
* `workflows/gantry-section-css` still documents the css2 model. It names
  `--site-container-max-width` (now `--site-max-width`), the `.withmaxwidth`
  body class (the cap is unconditional now), and puts the section background
  tokens on `body` (they are on `:root`). Update it in the same change that
  ships the kit, not before — it is the live authority for CSS work on sites
  that still run css2.
* The `boilerplate.css` subpage column block is reconstructed from behaviour,
  not copied: the old `section.css` is no longer served from the shared CDN.
  It is scoped to `body[class*="-sub"]:not(.sponsorshippage)`, matching the
  original. Check it against a live subpage with a sidebar before shipping —
  it is the one block in the kit with no source to diff against.
* Two default-image tokens still have no consumer of any kind:
  `--default-rotator-image` and `--default-hero-image`. Both are bound JS-side
  in `studius2.js` from `body` `data-` attributes. Either move that binding
  into CSS or delete the tokens; leaving them is how `--slideshow-height` sat
  dead in `site-tokens.css` while a build believed it was working.
* `--section-padding-block` and `--section-padding-inline` have no consumer
  either. That is defensible — `sections.css` styles only backgrounds, and
  `workflows/gantry-section-css` puts section padding on `.g-container` per
  build — but nothing in the kit applies them, so treat them as vocabulary for
  a build, not as a working default.
* A "restyle Swiper's own bullets and arrows" baseline is still unwritten, on
  purpose. It needs Swiper's actual unstyled output to diff against. Do not
  guess at it; that guess is what produced the six variants above.
