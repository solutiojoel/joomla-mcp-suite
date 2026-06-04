'use strict';

/**
 * solutio-conventions.js
 *
 * Encodes the Solutio Software house style for Joomla + Gantry 5 site builds.
 * Derived from analysis of 17 parish and 15 school homepage blueprints plus
 * CSS override files across the full client fleet.
 *
 * Exposed as MCP tool data so the LLM always builds consistently.
 */

// ─── Full style guide (returned by solutio_style_guide tool) ─────────────────

const STYLE_GUIDE = `
# Solutio Software — Gantry 5 Site Build Conventions

## Theme
Always: rt_studius. Never deviate unless the site record explicitly says otherwise.
Blueprint export format uses data.blueprint.layout (not data.blueprint.root).

---

## Outline Structure

Standard outline IDs:
- Parish Home   → outline 33  (menu Itemid=101)
- School Home   → outline 72  (assigned via templateStyleId, no dedicated menu item)

Naming: title-case, e.g. "Parish Home", "School Home", "About", "Staff Directory"

Primary site outline family:
- Base Outline owns primary site Page Settings and cannot be assigned directly.
- #Outline is the assignable subpage outline and should fully inherit layout and
  Page Settings from Base Outline.
- #Home inherits Navigation, Bottom, Footer, Copyright, and Offcanvas from Base
  Outline; all other sections are homepage design sections. Body Classes:
  gantry site-home withmaxwidth.
- #Grid inherits from Base Outline except Utility and Main. Body Id: site-grid.
  Main/Sidebar/Aside widths are 90/5/5 and Content Bottom A uses CSS ID grid-addpic.
- #Sponsors inherits from Base Outline except Aside, where Side Menu is removed or
  disabled and only the SideBar A module position remains.

Subsite outline family:
- Use #<Subsite> Outline, #<Subsite> Home, #<Subsite> Grid, and #<Subsite> Sponsors.
- #<Subsite> Outline replaces Base Outline for that subsite and must not inherit
  Page Settings from the primary Base Outline.
- #<Subsite> Outline must receive a full local clone of Base Outline layout before
  #<Subsite> Home/Grid/Sponsors inherit from it. In tools, use
  gantry_layout_clone_all_from. If done manually, Clone means Section Attributes,
  Block Attributes, and Particles within Section are all checked.
- #<Subsite> Outline Page Settings should be copied locally from the intended source
  with gantry_page_copy_from, then edited as a fresh subsite.
- #<Subsite> Home/Grid/Sponsors do not use entangled Page Settings. They copy
  Page Settings locally from #<Subsite> Outline with origin blank, then apply only
  the expected Body Classes/Body Id tweak.
- Head Properties and Assets on #<Subsite> Home/Grid/Sponsors must match
  #<Subsite> Outline.
- #<Subsite> Home/Grid/Sponsors inherit shared layout sections from #<Subsite>
  Outline, not Base Outline.
- #<Subsite> Home Body Classes: gantry site-home withmaxwidth.
- #<Subsite> Grid Body Id: site-grid.

---

## UNIVERSAL SECTION SEQUENCE

Every site follows this exact order. Do not add, remove, or reorder:

  container-top
    top
    navigation        ← ALWAYS inherits from default outline
    slideshow
  [end container-top]
  header
  above
  feature
  showcase
  utility
  container-main
    sidebar
    mainbar
    aside
  [end container-main]
  expanded
  extension
  bottom             ← ALWAYS inherits from default outline
  container-footer
    footer            ← ALWAYS inherits from default outline
    copyright         ← ALWAYS inherits from default outline
  [end container-footer]
  offcanvas

---

## INHERIT RULES (non-negotiable)

These sections ALWAYS inherit from the default outline. Never define fresh content in them unless you are editing the base default outline itself:
  - navigation
  - footer
  - copyright
  - bottom (15/17 sites — treat as universal)

Inherit config: { outline: "default", include: ["attributes", "block", "children"] }

Sections that NEVER inherit: top, slideshow, header, above, feature, showcase,
utility, sidebar, mainbar, aside, expanded, extension

---

## BOXED ATTRIBUTE VALUES (per section)

container-top:    ""
top:              "0"
navigation:       "2"
slideshow:        "2"
header–extension: "2"
expanded:         "2"
bottom:           "2"
container-footer: "2"
footer:           "2"
copyright:        ""

---

## SECTION CLASSES (set on the section's class attribute)

NAVIGATION STYLES — always append "stock" to the style word:
  crawl-space stock         Most common; school home standard
  free-menu stock           Open layout
  center-of-attention stock Centered logo
  ole-faithful stock        Traditional banner

SLIDESHOW:
  grand-entry slideshow-spacing    School home standard (12/15 schools)
  floatator slideshow-spacing      Parish variant (6/17 parishes)

CONTENT SECTIONS:
  news-to-me headlines-spacing     sidebar, mainbar, aside (standard)
  headlines-rounded-square         mainbar alternative

UTILITY:
  standard-ql                      When quicklinks are present

WIDGET SECTIONS:
  widget-parthenon-alt             expanded — school home standard (12/15 schools)

PADDING:
  s-padding-2                      above, footer
  s-vertical-padding-2             bottom
  slideshow-spacing                slideshow section

---

## BLOCK CSS CLASSES (set on the block wrapping a particle)

Navigation bar blocks:
  hidden-phone       Desktop-only row (logo, toplinks)
  show-mobile        Mobile-only row (mobile logo)
  ql-toplinks-studius   Toplinks blockcontent block (size: 25)

Slideshow blocks:
  fullwidth-swiper        Main swiper block (size: 100 or 70)
  rotate-wide             Wide rotation variant
  rotate-sw               Side-west rotation
  swiper-overlay-title    Title overlay row
  swiper-ql-overlay       Quicklinks overlay row
  mass-times-block        Mass times sidebar (size: 30)

Content area blocks:
  news-button          "View All" button below news grid
  welcome-title        Welcome heading (utility)
  ql-united            Quicklinks strip (utility, size: 100)
  modern-alert         Alert bar (top section)
  ads-901 side-ads ads-902 ads-903   Ad position block (aside)

Widget blocks (in expanded/extension/sidebar):
  facebook-widget-container widget-container
  calendar-widget-container widget-container
  instagram-widget-container
  formed-widget-container widget-container
  daily-readings-widget-container widget-container
  flocknote-widget-container widget-container
  bulletin-widget-container
  homily-widget-container
  hallow-widget-container
  widget-container            (generic)
  calendar-button / calendar-title    (school)
  ec-vert                     (school events column)

Photo header styles (on contentarray blocks):
  ph-sideway-stack  ph-sidenews  ph-rounded-square  ph-wide
  ph-imgcard  ph-shadowbox2  ph-side-circles  ph-titlestack  ph-accordian-list

Quicklinks styles (on blockcontent blocks):
  ql-united  ql-sbound  ql-ilinks  ql-dm  ql-square-1  ql-height-13vw
  ql-portraitbox  ql-boxtitle  ql-circle-row  ql-windowsill  ql-buttons
  ql-icon-links  link-boxes

Responsive visibility:
  hidden-phone    hide on mobile
  show-mobile     show on mobile only

---

## UNIVERSAL PARTICLES (every site must have these)

1. top section — row 1: system/messages
   top section — row 2: contentarray "Alert" (category-filtered, class: modern-alert)

2. navigation — logo (desktop hidden-phone, size 65) + spacer (size 10) + blockcontent toplinks (size 25, class: ql-toplinks-studius) + menu (size 100)

3. slideshow — exactly one swiper particle per site

4. offcanvas — mobile-menu + custom particle with:
   <div class="ql-toplinks-studius"><jdoc:include type="modules" name="subsite-navigation" /></div>

5. aside section — position:module home-ads (class: ads-901 side-ads ads-902 ads-903)

6. bottom section — position:module bottom-ads (inherits in most cases)

7. footer section — row 1: footer-a (33.3) + footer-b (33.3) + footer-c (33.3)
                    row 2: contentarray "Footer" (single article by ID, size 100)

8. copyright section — custom particle with admin footer HTML (see template below)

---

## ADMIN FOOTER HTML TEMPLATE (copyright section — every site)

<div class="adminfootericon" style="font-size: x-small; line-height: 1.3; text-shadow: 2px 2px #000000;">
  <a style="font-size: large;" href="https://{SITECODE}.solutiosoftware.com/administrator/" target="_blank">
    <i class="fa fa-lock"></i></a>
  <br><br><a style="color: #ffffff;" href="http://solutiosoftware.com/" target="_blank">Site by Solutio</a>
  <br><a style="color: #ffffff;" href="https://solutiosoftware.com/web-policy" target="_blank" rel="noopener noreferrer">Analytics Privacy Policy</a>
</div>

Replace {SITECODE} with the site's slug (e.g. stgertrude-bay).

---

## STANDARD SWIPER CONFIG

autoplayTimeout: "8000"
speed: "800"
effect: slide
loop: enabled
largedesktopslides: "1"
largedesktopgroup: "1"
largedesktopspace: "0"
source: joomla
image: img

---

## STANDARD TOPLINKS (blockcontent, navigation bar)

source: particle
3 items standard:
  1. label: Bulletin   icon: fas fa-newspaper        buttontarget: _self
  2. label: Giving     icon: fas fa-hand-holding-heart  buttontarget: _blank
  3. label: Contact    icon: fas fa-phone            buttontarget: _self

---

## STANDARD QUICKLINKS (blockcontent, utility section)

Image paths: gantry-media://stories/template/quicklinks/ql1.jpg through ql5.jpg
4–6 items, common buttons: Bulletin, I'm New, Online Giving, Faith Formation, Calendar
accent: none  icon: ""  subtitle: ""  description: ""  buttonclass: ""

---

## GRID / BLOCK SIZE CONVENTIONS

container-main layout:
  Parish: sidebar 5 + mainbar 80 + aside 15   (most common)
          sidebar 5 + mainbar 90 + aside 5     (minimal sidebar)
  School: sidebar 55 + mainbar 30 + aside 15  (STANDARD — 11/15 schools)

Footer positions: 33.3 + 33.3 + 33.3 (always equal thirds)

Navigation rows (3-row standard):
  Row 0: 100 — show-mobile (mobile logo)
  Row 1: 65(logo hidden-phone) + 10(spacer) + 25(toplinks ql-toplinks-studius)
  Row 2: 100 — menu

---

## PARISH HOME vs SCHOOL HOME DIFFERENCES

PARISH HOME:
  - Slideshow: full-width (100) OR mass-times sidebar split (70 swiper + 30 mass-times-block)
  - Slideshow section class: floatator slideshow-spacing OR grand-entry slideshow-spacing
  - container-main: sidebar 5 + mainbar 80 + aside 15
  - Utility: standard-ql class with ql-united quicklinks
  - mainbar: contentarray news article grid + news-button
  - Extended: Facebook + Calendar widgets (sidebar area)
  - No timeline particle
  - Social particle: optional (8/17)

SCHOOL HOME:
  - Slideshow: always 3 stacked rows: (1) fullwidth-swiper, (2) swiper-overlay-title, (3) swiper-ql-overlay
  - Slideshow section class: grand-entry slideshow-spacing (almost always)
  - Navigation: always includes social particle
  - container-main: sidebar 55 + mainbar 30 + aside 15
  - mainbar: TIMELINE particle (events list) — signature school feature
  - expanded: widget-parthenon-alt class, 3 equal columns:
      facebook-widget-container | daily-readings-widget-container | formed-widget-container
  - School grid class on contentarray blocks:
      grid grid-articles grid-wide grid-sideways grid-bg-primary grid-text-white
      grid-title-tertiary grid-hover-scale grid-mobile-horizontal-scroll
      grid-mobile-stacked grid-image-border-radius-1
      grid-g-grid-border-radius-1-point-5 grid-g-grid-box-shadow grid-img-border-2-tertiary
  - Calendar blocks: calendar-button + calendar-title
  - ec-vert block class for events column

---

## CSS OVERRIDE CONVENTIONS

File location: /content/override.css (parish), /content/override-school.css (school)

File always starts with:
/* ARTWORK NOTES
--------------------------------------------

--------------------------------------------
*/

---

## PAGE TARGETING RULES — CRITICAL

This is the most important scoping rule in override CSS. The wrong selector is the
most common CSS mistake on Solutio sites.

### html body.site-home {}
Homepage ONLY. Put here:
- Section background color variables (--section-slideshow-bg, --section-expanded-bg, etc.)
- Slideshow sizing and spacing
- Homepage hero/utility section visual treatments
- Any style that only applies to the front page and would look wrong on subpages

### html body.site-sub {}
Subpages ONLY. Put here:
- Subpage banner/header styles
- Content area typography and spacing tweaks for article pages
- Subpage-specific section treatments
- Styles for sections that appear differently on inner pages
NOTE: Most homepage section overrides (slideshow colours, utility backgrounds, etc.)
must NOT go in .site-sub. The subpage has none of those sections.

### html body {} (all pages)
Put here:
- Side menu variables (--side-menu-bg, --side-menu-font-size-desktop, etc.)
- Global font/colour tokens that apply everywhere
- Anything that must be consistent across home AND subpages

### html body #g-navigation {} and html body #g-footer {} (all pages)
Navigation and footer CSS always goes here — NOT inside .site-home or .site-sub.
These sections are inherited from the default outline and appear on every page.
Scoping their styles inside .site-home would break the navigation on subpages.

### Practical decision rule:
Ask: "Does this section appear on subpages?"
  YES (navigation, footer, copyright, side menu) → html body {} or html body #g-{id} {}
  NO  (slideshow, utility, expanded, header, above) → html body.site-home {}
  SUBPAGE ONLY (inner banner, article layout) → html body.site-sub {}

---

## STANDARD OPENING BLOCK ORDER (always written in this sequence)

/* ARTWORK NOTES ----------- */

html body.site-home {
    --section-above-bg: var(--secondary-color);
    /* section-specific bg overrides for homepage sections */
}

html body {
    --side-menu-bg: var(--primary-color);
    --side-menu-bg-hover: var(--secondary-color);
    --side-menu-font-size-desktop: min(1.25vw, 1.25rem);
    --side-menu-font-family: var(--body-font-family);
    --side-menu-font-weight: 400;
}

html body #g-navigation {
    --main-menu-text-color: var(--primary-color);
    --main-menu-text-color-hover: var(--primary-color);
    --main-menu-bg: var(--default-white);
    --main-menu-bg-color: var(--default-white);
    --navigation-floating-social-padding: min(1vw, 1rem);
}

.g-array-item-text {
    margin: 0!important;
    padding: 0!important;
}

---

## SECTION BACKGROUND VARIABLES

Set in html body.site-home {} (homepage only — these sections don't exist on subpages):
  --section-slideshow-bg
  --section-header-bg
  --section-above-bg       ← always set, default: var(--secondary-color)
  --section-utility-bg
  --section-container-main-bg
  --section-expanded-bg
  --section-extension-bg
  --section-bottom-bg

Set in html body {} (all pages — navigation and footer appear everywhere):
  --section-navigation-bg  (if needed — usually handled in #g-navigation directly)
  --section-footer-bg      (if needed — usually handled in #g-footer directly)
  --section-copyright-bg   (if needed)

---

## NAVIGATION BACKGROUND (standard pattern — in html body #g-navigation, NOT .site-home)

html body #g-navigation {
    background: url('/images/template/bg-header.jpg') 50% 50% no-repeat;
    background-size: cover;
    position: relative;
}
html body #g-navigation:before {
    content: '';
    background: rgba(var(--primary-color-rgb), .85);
    backdrop-filter: blur(7px);
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    z-index: 1;
}
html body #g-navigation > .g-container {
    position: relative; z-index: 2;
}

School nav uses: /images/template/school26/bg-header.jpg

---

## RESPONSIVE BREAKPOINTS (always use these exact values)

Desktop: @media only screen and (min-width: 50.99rem)
Mobile:  @media only screen and (max-width: 50.99rem)

---

## SIZING CONVENTION

min(Nvw, Nrem) where both values always match:
  min(1vw, 1rem)  min(1.25vw, 1.25rem)  min(1.5vw, 1.5rem)
  min(2vw, 2rem)  min(3vw, 3rem)  min(4vw, 4rem)

---

## CSS VARIABLES (never hardcode hex values)

  --primary-color          Site primary brand color
  --secondary-color        Secondary brand color
  --tertiary-color         Accent color
  --default-white          White
  --default-black          Black
  --background-color       Page background
  --footer-color           Footer background
  --primary-color-rgb      RGB tuple for use in rgba()
  --title-font-family      Heading font
  --body-font-family       Body font
  --default-box-shadow     Standard box shadow

---

## CSS SECTION ID SELECTORS

#g-{section-id} — e.g. #g-navigation, #g-slideshow, #g-expanded, #g-footer

Always scope with body class for specificity:
  html body.site-home #g-slideshow {}    ← slideshow on homepage only
  html body #g-navigation {}             ← navigation on ALL pages
  html body #g-footer {}                 ← footer on ALL pages

---

## BUILD CHECKLIST

Before marking a site build complete, verify:
[ ] navigation, footer, copyright, bottom all inherit from default outline
[ ] Every site has system/messages in top section row 1
[ ] Alert contentarray in top section row 2 (class: modern-alert)
[ ] Exactly one swiper in slideshow
[ ] offcanvas has mobile-menu + subsite-navigation custom HTML
[ ] home-ads position in aside section
[ ] footer has 3 equal position columns (footer-a, footer-b, footer-c) + footer article
[ ] copyright has admin footer HTML with correct site URL
[ ] School home: timeline in mainbar, social in navigation, widget-parthenon-alt on expanded
[ ] CSS override file starts with ARTWORK NOTES comment block
[ ] CSS uses min(Nvw, Nrem) sizing, 50.99rem breakpoints, CSS variables only
[ ] .g-array-item-text { margin: 0!important; padding: 0!important; } present in CSS
`.trim();

// ─── Focused sections for targeted queries ────────────────────────────────────

const SECTIONS = {
  overview: `
Solutio builds Joomla sites using the rt_studius Gantry 5 theme.
All sites follow an identical section structure and inherit rules.
Parish (outline 33) and School Home (outline 72) are the two standard homepage types.
`.trim(),

  outline_structure: `
Primary site outline family:
- Base Outline owns primary Page Settings and cannot be assigned directly.
- #Outline is the assignable subpage outline and fully inherits layout/Page Settings from Base Outline.
- #Home inherits Navigation, Bottom, Footer, Copyright, and Offcanvas from Base Outline; Body Classes are "gantry site-home withmaxwidth".
- #Grid inherits from Base Outline except Utility and Main; Body Id is "site-grid"; Main/Sidebar/Aside widths are 90/5/5; Content Bottom A uses CSS ID "grid-addpic".
- #Sponsors inherits from Base Outline except Aside, where Side Menu is removed/disabled and SideBar A module position remains.

Subsite outline family:
- Use #<Subsite> Outline, #<Subsite> Home, #<Subsite> Grid, #<Subsite> Sponsors.
- #<Subsite> Outline replaces Base Outline for that subsite and must not inherit Page Settings from primary Base Outline.
- #<Subsite> Outline must locally clone the full Base Outline layout before other subsite outlines inherit from it; in tools, use gantry_layout_clone_all_from.
- Manual section Clone means the Gantry Clone option with Section Attributes, Block Attributes, and Particles within Section all checked.
- #<Subsite> Outline Page Settings should be copied locally with gantry_page_copy_from and then edited as a fresh subsite.
- #<Subsite> Home/Grid/Sponsors copy Page Settings locally from #<Subsite> Outline without entanglement/origin; Head Properties and Assets must match #<Subsite> Outline.
- #<Subsite> Home Body Classes are "gantry site-home withmaxwidth"; #<Subsite> Grid Body Id is "site-grid".
- For full operational steps, call gantry_outline_conventions before duplicating or rewiring outlines.
`.trim(),

  inherit_rules: `
These sections ALWAYS inherit from the default outline — never build fresh content in them unless editing the base default outline:
  navigation, footer, copyright, bottom

Inherit config: { outline: "default", include: ["attributes", "block", "children"] }
`.trim(),

  css: `
Standard CSS pattern:
- File: /content/override.css (parish), /content/override-school.css (school)
- Starts with: /* ARTWORK NOTES ----------- */
- Always includes: .g-array-item-text { margin: 0!important; padding: 0!important; }
- Breakpoints: min-width: 50.99rem (desktop), max-width: 50.99rem (mobile)
- Sizing: min(Nvw, Nrem) — values always match (e.g. min(1.5vw, 1.5rem))
- Colors: always CSS variables — never hardcode hex values

PAGE SCOPING RULES:
  html body.site-home {}     Homepage sections ONLY (slideshow, utility, expanded, etc.)
  html body.site-sub {}      Subpages ONLY (inner banner, article layout)
  html body {}               All pages (side menu vars, global tokens)
  html body #g-navigation {} All pages — navigation is NEVER scoped to .site-home
  html body #g-footer {}     All pages — footer is NEVER scoped to .site-home

KEY RULE: Navigation and footer CSS goes in html body {} or html body #g-navigation/footer {}.
Scoping it inside .site-home breaks the navigation and footer on every subpage.

Section backgrounds for homepage: --section-{id}-bg in html body.site-home {}
Section backgrounds for nav/footer: in html body {} or directly on #g-navigation/#g-footer
Navigation background: bg-header.jpg with rgba primary color overlay + backdrop-filter blur
`.trim(),

  page_targeting: `
## Solutio CSS Page Targeting Rules

### The core question before writing any CSS rule:
Does this section appear on subpages?

  YES → use  html body {}  or  html body #g-{id} {}
  NO  → use  html body.site-home #g-{id} {}  or  html body.site-home {}
  SUBPAGE VARIANT → use  html body.site-sub #g-{id} {}

### Sections that appear on EVERY page (scope to html body or #g-id):
  navigation, footer, copyright, offcanvas, side menu

### Sections that are HOMEPAGE ONLY (scope to html body.site-home):
  slideshow, header, above, feature, showcase, utility,
  container-main, sidebar, mainbar, aside, expanded, extension, bottom

### Sections that are SUBPAGE ONLY (scope to html body.site-sub):
  Subpage hero banner, breadcrumbs, article content area

### Common mistakes to avoid:
  WRONG: html body.site-home #g-navigation {}   ← breaks nav on subpages
  RIGHT: html body #g-navigation {}

  WRONG: html body #g-slideshow {}              ← bleeds onto subpages
  RIGHT: html body.site-home #g-slideshow {}

  WRONG: html body.site-home #g-footer {}       ← footer broken on subpages
  RIGHT: html body #g-footer {}

### Standard scoping for each section:

  /* All pages */
  html body #g-navigation { ... }
  html body #g-footer { ... }
  html body #g-copyright { ... }

  /* Homepage only */
  html body.site-home #g-slideshow { ... }
  html body.site-home #g-utility { ... }
  html body.site-home #g-expanded { ... }
  html body.site-home #g-container-main { ... }
  html body.site-home { --section-above-bg: ...; --section-slideshow-bg: ...; }

  /* Subpages only */
  html body.site-sub #g-header { ... }
  html body.site-sub #g-container-main { ... }
`.trim(),

  parish: `
Parish Home (outline 33) standards:
- Slideshow: full-width swiper OR 70(swiper rotate-wide) + 30(mass-times-block) split
- Slideshow class: floatator slideshow-spacing OR grand-entry slideshow-spacing
- container-main: 5(sidebar) + 80(mainbar) + 15(aside)
- Utility section: standard-ql class, ql-united blockcontent quicklinks
- Extended: Facebook + Calendar widgets in sidebar/expanded
- Toplinks: Bulletin + Online Giving + Contact Us
`.trim(),

  school: `
School Home (outline 72) standards:
- Slideshow: 3 stacked rows: fullwidth-swiper → swiper-overlay-title → swiper-ql-overlay
- Slideshow class: grand-entry slideshow-spacing
- Navigation: includes social particle
- container-main: 55(sidebar) + 30(mainbar) + 15(aside)
- mainbar: timeline particle (school events) — mandatory
- expanded: widget-parthenon-alt class, 3 equal columns: Facebook | Daily Readings | Formed
- School grid class: grid grid-articles grid-wide grid-sideways grid-bg-primary grid-text-white grid-title-tertiary grid-hover-scale grid-mobile-horizontal-scroll grid-mobile-stacked grid-image-border-radius-1 grid-g-grid-border-radius-1-point-5 grid-g-grid-box-shadow grid-img-border-2-tertiary
`.trim(),

  checklist: `
Pre-launch build checklist:
[ ] navigation, footer, copyright, bottom inherit from default outline
[ ] system/messages in top row 1
[ ] Alert contentarray in top row 2 (class: modern-alert)
[ ] One swiper in slideshow
[ ] offcanvas: mobile-menu + <div class="ql-toplinks-studius"><jdoc:include type="modules" name="subsite-navigation" /></div>
[ ] home-ads position in aside
[ ] footer: 3x33.3 positions (footer-a/b/c) + footer article
[ ] copyright: admin footer HTML with site URL
[ ] School: timeline in mainbar, social in nav, widget-parthenon-alt on expanded
[ ] CSS: ARTWORK NOTES header, min() sizing, 50.99rem breakpoints, CSS variables only
[ ] .g-array-item-text rule present in CSS
`.trim(),

  naming: `
Naming conventions:
- Section classes: compound kebab-case, semantic groups (ql-*, ph-*, widget-*)
- Navigation styles: {style} stock (always append "stock")
- Quicklinks blocks: ql-{variant} (ql-united, ql-sbound, ql-ilinks, ql-dm, etc.)
- Photo styles: ph-{variant} (ph-rounded-square, ph-imgcard, ph-sideway-stack, etc.)
- Widget containers: {name}-widget-container widget-container
- Responsive: hidden-phone (hide mobile), show-mobile (show mobile)
- Section CSS IDs: #g-{section-id} (e.g. #g-navigation, #g-footer)
`.trim(),
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { STYLE_GUIDE, SECTIONS };

// ─── Particle reference (added from fleet analysis) ───────────────────────────

const PARTICLES = `
# Solutio Particle Reference

Every particle type used across the Solutio fleet, with purpose, visual role,
complete field schema, standard configurations, and what must be site-specific.

---

## STANDARD ARTICLE IDs (same across all template sites — use as defaults)

| ID  | Purpose |
|-----|---------|
| 9   | Alert category (category filter for alert bar) |
| 10  | Slideshow category (swiper source) |
| 8   | News & Events category |
| 36  | Footer article (single article in footer section) |
| 55  | Mass Times article |
| 74  | Google Calendar embed article |
| 75  | Formed embed article |
| 76  | Facebook embed article |
| 77  | Instagram embed article |
| 79  | Daily Readings embed article |

These IDs apply on template/forge sites. Production sites always have their own IDs.
Always check the site's actual article IDs before configuring — never hardcode fleet defaults onto a client site.

---

## contentarray

### What it is
The primary content particle. Pulls Joomla articles and renders them — as a single embedded widget (social, calendar, mass times), as a news grid with photos and teasers, or as a single utility article (footer content, announcements). It is NOT a particle you write HTML into; it reads from the Joomla article database.

### Why it exists over custom
Use contentarray when content must be managed by the site admin through the Joomla backend — articles the client updates themselves (mass times, news, bulletins, footer address). Use custom instead when the HTML is structural/layout (a heading, a button, a wrapper div).

### Key fields

source/filter (what to pull):
  filter.categories: "8"       Single category ID — pulls all articles in that category
  filter.articles:   "76"      Comma-separated article IDs — pulls specific articles
  filter.featured:   "include" | "exclude" | "only"
  — Use categories for news feeds; use articles for single embed widgets (Facebook, Footer, Mass Times)
  — featured: "include" is standard. "exclude" only if you want non-featured articles only.
  — NEVER set both categories and articles — use one or the other.

limit:
  total:   "1"   Single article widget (Mass Times, Facebook, Footer, Calendar, Formed, etc.)
  total:   "3"   Standard news grid
  total:   "4"   Larger news grid (stgertrude-bay, seas-ontario)
  total:   "10"  Alert bar (shows up to 10 alerts)
  columns: "1"   Always 1 — never use multi-column layout on these sites
  start:   "0"   Always 0 — never offset

display:
  image.enabled: "full"        Show full image (news grid, slideshow source)
  image.enabled: "intro"       Show intro image (rare)
  image.enabled: ""            No image (widget embeds, alert bar, footer)
  text.type: "intro"           Show intro text
  text.type: ""                No text excerpt (widget embeds)
  text.limit: "90"             Truncate at 90 chars (range: 90–200 across fleet)
  title.enabled: "show"        Show article title
  read_more.enabled: "show"    Show "Read More" link

sort:
  orderby: "ordering"          Manual ordering — standard for alerts and featured content
  orderby: "publish_up"        Date ordering — use for news feeds
  ordering: "ASC"              Always ASC

pagination_buttons: ""         Always empty — never enable pagination

### Named configurations

ALERT (top section, all sites)
  Purpose: Site-wide announcement banner, managed from Joomla articles in a dedicated category.
  Visual: Thin colored bar above navigation, dismissible. Shows article title.
  Config: categories: "9", total: "10", columns: "1", title.enabled: "show", orderby: "ordering"
  Block class: modern-alert

MASS TIMES (slideshow sidebar, parish only)
  Purpose: Displays a single article containing the parish's mass schedule.
  Visual: Right sidebar next to the swiper, styled as a schedule panel.
  Config: articles: "55", total: "1", no image, no text excerpt
  Block class: mass-times-block, block size: 30

NEWS & EVENTS (sidebar/mainbar, parish)
  Purpose: Latest news feed with photos and teasers. The primary content area.
  Visual: Vertical list of article cards with photo, title, excerpt, read more link.
  Config: categories: "8", total: "3" or "4", image: "full", text.type: "intro", text.limit: "90", title: "show", read_more: "show", orderby: "publish_up"
  Block class: ph-{variant} (e.g. ph-sideway-stack, ph-rounded-square)

FACEBOOK (mainbar, most sites)
  Purpose: Embeds the parish/school Facebook page feed inside a Joomla article.
  Visual: Facebook Page Plugin widget (iframe embed stored in the article body).
  Config: articles: "76", total: "1", no image, no text
  Block class: facebook-widget-container widget-container

CALENDAR (extension/sidebar)
  Purpose: Embeds a Google Calendar or similar calendar in a Joomla article.
  Visual: Month-view calendar widget.
  Config: articles: "74", total: "1"
  Block class: calendar-widget-container widget-container

FOOTER (footer section, all sites)
  Purpose: Displays parish contact info, address, office hours.
  Visual: Footer address block — name, address, phone, email, hours.
  Config: articles: "36", total: "1", no image
  Section: footer, row 2, size: 100

DAILY READINGS (school expanded section)
  Purpose: Links to the USCCB daily scripture readings for today.
  Visual: Card with USCCB logo and "Daily Readings" link.
  Config: articles: "79", total: "1"
  Block class: daily-readings-widget-container widget-container

FORMED (expanded/sidebar)
  Purpose: Embeds/links to Formed.org (Catholic faith formation streaming).
  Visual: Formed logo with embed or link.
  Config: articles: "75", total: "1"
  Block class: formed-widget-container widget-container

INSTAGRAM (extension)
  Purpose: Embeds parish/school Instagram feed.
  Visual: Instagram feed widget.
  Config: articles: "77", total: "1"
  Block class: instagram-widget-container

BULLETINS (extension)
  Purpose: Shows downloadable parish bulletins (PDF links via DocMan or custom article).
  Visual: Bulletin covers with dates and download links.
  Config: articles: site-specific, total: "1"
  Block class: bulletin-widget-container

---

## swiper

### What it is
The hero slideshow particle. Pulls articles from a Joomla category and renders them as
full-width or fixed-height slides with autoplay, navigation arrows, and optional pagination dots.
Slides use the article's full-text or intro image as the slide visual.

### Why it exists
All sites need a hero slideshow on the homepage. Images and slide content are managed
through Joomla articles in the slideshow category (default cat ID 10), so clients can
add/remove slides without touching the template.

### Key fields

source: "joomla"             Always — slides come from Joomla articles
image: "img"                 Always — uses article image field
article.filter.categories: "10"   The slideshow category (site-specific ID)
article.limit.total: ""      Empty = unlimited (all articles in category)
autoplayTimeout: "8000"      8 seconds per slide (standard)
speed: "800"                 Transition speed in ms
effect: "slide"              Always slide — never fade or cube
loop: "enabled"              Always enabled
nav: "enabled"               Arrow nav — disable on sites with overlay quicklinks obscuring them
pagination: "bullets"        Dot indicators — optional
overlaycolor:
  "rgba(255,255,255,0)"      Transparent — parish sites with HTML text in slide articles
  "rgba(0,0,0,0.6)"          Dark overlay — school homes
height: "100%"               Full viewport height (most sites)
height: "36vw"               Fixed ratio height (sites with mass-times sidebar)
heightMobile: "56vw"         Mobile height when desktop is "36vw"

article.display:
  image.enabled: "full"      Always — shows the article's full image
  text.type: "full"          Parish with HTML overlay text in slide articles
  text.type: ""              School/clean slides with no text
  render_html_tags: "1"      Must be "1" when text.type is "full"

### Standard configurations

PARISH FULL-WIDTH (no mass times):
  height: "100%", overlaycolor: transparent, text.type: "full", render_html_tags: "1"
  nav: "enabled", pagination: "bullets", block size: 100

PARISH WITH MASS TIMES SIDEBAR (floatator style):
  height: "36vw", heightMobile: "56vw", overlaycolor: transparent
  nav: "enabled", block size: 70, paired with Mass Times contentarray at 30

SCHOOL HOME (grand-entry style):
  height: "100%", overlaycolor: "rgba(0,0,0,0.6)", text.type: ""
  nav: "enabled", pagination: "bullets"
  Placed in row 1 of 3 stacked slideshow rows

### Important
The swiper particle itself does not contain slide content — it reads from Joomla articles.
Slide management happens in the Joomla admin under the slideshow category, not in Gantry.

---

## blockcontent

### What it is
A configurable list of link items, each with an image, icon, label, and button URL.
Used for two distinct purposes: toplinks (icon buttons in the navigation bar) and
quicklinks (image-card strips in the utility section or slideshow overlays).

### Why it exists over custom
blockcontent items are structured and managed through the Gantry particle settings UI —
clients can update link labels, URLs, and images without touching HTML.
Use custom for one-off HTML; use blockcontent for any repeating link list.

### Key fields

source: "particle"           Always — items defined in the particle, not from Joomla
subcontents: [...]           The array of link items (see item structure below)

Each item:
  name: "Bulletin"           Display/internal name
  button: "Bulletin"         Visible button text
  buttonlink: "/bulletin"    URL — always site-relative or absolute
  buttontarget: "_self"      "_blank" for external links (e.g. Online Giving)
  img: "gantry-media://..."  Image path for image-card quicklinks; empty for toplinks
  icon: "fas fa-newspaper"   Font Awesome icon class; used for toplinks, not ql-united
  accent: "none"             Always "none"
  subtitle: ""               Always empty
  description: ""            Always empty
  buttonclass: ""            Always empty

### Named configurations

TOPLINKS (navigation section, row 1 block, size 25, class: ql-toplinks-studius)
  Purpose: Quick-access utility links in the navigation bar above the main menu.
  Visual: Small icon buttons aligned top-right of the header — Bulletin, Online Giving, Contact Us.
  Standard items (parish): Bulletin (fas fa-newspaper), Online Giving (fas fa-hand-holding-heart, _blank), Contact Us (fas fa-phone)
  Standard items (school): may add Calendar, Parishes link, Search
  Note: buttonlink values are always site-specific URLs — never use "#" in production.

QUICKLINKS — ql-united (utility section, size 100, class: ql-united)
  Purpose: Image-card navigation strip below the welcome heading.
  Visual: Row of 4-6 cards with background photos and text labels — key parish entry points.
  Standard items: I'm New / Bulletin / Online Giving / Faith Formation / Calendar / Contact
  Images: gantry-media://stories/template/quicklinks/ql1.jpg through ql5.jpg (or ql6.jpg)
  Note: img paths point to stock template images — replace with site-specific photos when possible.

OVERLAY QUICKLINKS (slideshow section, swiper overlay row)
  Purpose: Quicklinks displayed over or below the hero swiper.
  Visual: Row of text-only buttons overlaid on the slideshow bottom area.
  Typically 6 placeholder items at build time — configure per site.

LINK-BOXES (expanded section, class: link-boxes)
  Purpose: Two or three external resource links displayed as branded cards.
  Visual: Side-by-side cards with logos — Catholic Faith Network (CFN), Daily Readings, Formed.
  Usually 2-3 items; images are the partner organization logos.

---

## custom

### What it is
A free-form HTML particle. Renders whatever HTML you put in it.
Used for structural/layout elements that are not article-driven.

### Why it exists
When no dedicated particle covers the need (a heading, a button, a module inject,
a popup overlay, a specific HTML structure), custom provides raw HTML output.
NOT for content that clients will update — use contentarray for that.

### Named configurations

POP UP (top section, row 3, every site — enabled: 1)
  Purpose: Injects the popup overlay modal (driven by a Joomla module in the pop-up position).
  Visual: A dismissible modal popup — used for announcements, special events.
  HTML: FIXED — never modify this HTML:
    <div id="pop-up-overlay-2"></div>
    <div id="pop-up-container-2">
    <div id="popup-2">
    <jdoc:include type="modules" name="pop-up" />
    </div>
    <button id="close-popup-button-2"><i class="fas fa-times-circle"></i></button>
    </div>

ADMIN FOOTER (copyright section, every site — enabled: 1)
  Purpose: Provides admin login link and Solutio branding.
  Visual: Tiny dark text in the footer — admin lock icon, "Site by Solutio", privacy policy link.
  HTML: Replace SITECODE with the site's slug (e.g. stgertrude-bay):
    <div class="adminfootericon" style="font-size: x-small; line-height: 1.3; text-shadow: 2px 2px #000000;">
      <a style="font-size: large;" href="https://SITECODE.solutiosoftware.com/administrator/" target="_blank"><i class="fa fa-lock"></i></a>
      <br><br><a style="color: #ffffff;" href="http://solutiosoftware.com/" target="_blank">Site by Solutio</a>
      <br><a style="color: #ffffff;" href="https://solutiosoftware.com/web-policy" target="_blank" rel="noopener noreferrer">Analytics Privacy Policy</a>
    </div>

SUBSITE NAVIGATION (offcanvas, every site — enabled: 1)
  Purpose: Injects the subsite navigation module into the mobile offcanvas drawer.
  Visual: Links to related subsites (school, cemetery, etc.) in the mobile menu.
  HTML: FIXED — never modify:
    <div class="ql-toplinks-studius"><jdoc:include type="modules" name="subsite-navigation" /></div>

WELCOME TITLE (utility section, row 1)
  Purpose: Section heading above the quicklinks strip.
  Visual: Large decorative heading — "Welcome to the Church of St. Gertrude".
  HTML pattern: <h3 class="g-title">Welcome to [Parish Name]</h3>
  Block class: welcome-title

VIEW ALL BUTTON (below news section)
  Purpose: "View All News" link below the news grid.
  Visual: Styled button linking to the news/events page.
  HTML pattern: <a href="news" class="button">View All News &amp; Events</a>
  Standard href values: "news", "/news", "news-events" — site-specific

CALENDAR TITLE (school — mainbar, above timeline)
  Purpose: Section heading above the school events timeline.
  Visual: "Calendar" or "Upcoming Events" heading.
  HTML: <h2 class="g-title">Calendar</h2>

VIEW FULL CALENDAR BUTTON (school — below timeline)
  Purpose: Link to full calendar page.
  Visual: Button below the events list.
  HTML pattern: <a class="button" href="/news/calendar">View Full Calendar</a>

SWIPER OVERLAY TITLE (school slideshow — enabled on school, disabled on parish)
  Purpose: White text overlaid on the school hero swiper.
  Visual: "Welcome!" heading over the hero image.
  HTML: <h1>Welcome!</h1>

---

## logo

### What it is
Renders the site logo image. Used twice in every navigation: once in the mobile row
(show-mobile) and once in the desktop row (hidden-phone).

### Why two instances
The mobile logo (show-mobile row, size 100) and desktop logo (hidden-phone row, size 65)
can have different images — the mobile version is often smaller or a square/icon variant.

### Key fields

enabled: 1                   Always
image: "gantry-media://..."  Optional — overrides the theme default logo
url: "/"                     Optional — override the click destination
                              School logos use url: "/school" to stay within the school section

### Standard behavior
- Parish: both desktop and mobile logos use the theme default (no explicit image field)
  unless the site has a custom logo file
- School: adds image: "gantry-media://template/school26/logo.png" + url: "/school"
- Mobile-specific logos: some sites set image: "gantry-media://logo/logo-mobile.svg"
  for a compact version

---

## menu

### What it is
Renders the Joomla navigation menu. Uses the Gantry menu system which pulls from Joomla's
menu manager.

### Key fields

menu: ""                     Empty = use theme default (mainmenu) — standard for parish
menu: "main-menu-st"         Named menu — some sites use separate menus for parish vs school
menu: "school-menu-st"       School-specific menu name
enabled: 1 | 0               Disabled on one site (stpats-par) which uses a contentarray article
                              to build its navigation — unusual exception

### Placement
Always the last row of the navigation section (full width, size 100).

---

## mobile-menu

### What it is
Renders the hamburger/slide-out mobile navigation. Always placed in the offcanvas section.
Has no configuration — it uses the Gantry menu system automatically.

### Fields
{enabled: 1}  — that is literally all. No other configuration ever.

### Rule
One mobile-menu particle per site, always in offcanvas, always paired with the subsite
navigation custom particle.

---

## social

### What it is
Renders social media icon links — typically in the navigation bar on school sites,
or in the header area on some parish sites.

### Key fields

enabled: 1 | 0
items:
  - icon: "fab fa-facebook-square"   Font Awesome brand icon class
    link: "https://facebook.com/..."  Full URL to social profile
    name: "Facebook"                  Label (usually hidden in display)

### Standard icons
  Facebook:  fab fa-facebook-square  or  fab fa-facebook
  Instagram: fab fa-instagram
  YouTube:   fab fa-youtube
  Search:    fas fa-search  (links to site search page — not a true social platform)
  Phone:     fas fa-phone   (tel: link for mobile click-to-call)
  Email:     fas fa-envelope-square  (mailto: link)

### Usage pattern
- School homes: almost always enabled, 2 items minimum (FB + IG), placed in navigation row 1
- Parish homes: optional; when used, placed in navigation row 1 alongside toplinks
- Always use real URLs in production — never leave placeholder https://www.facebook.com/

---

## timeline

### What it is
Renders an upcoming events list from the Gantry/Joomla calendar system.
The signature particle of school home pages — shows upcoming school events in a compact list.

### Key fields

enabled: 1
calendar: ""                 Empty = use all calendars (school standard)
calendar: "parish-calendar"  Named calendar slug — filter to specific calendar
timeline: "arrows"           Display mode with navigation arrows
events_pane: "3"             Events per pane (rare — stpats uses "3")

### Usage pattern
- School homes: ALWAYS present in mainbar section (12/15 schools)
  Minimal config: {enabled: 1} — no calendar slug, no display mode
- Parish homes: occasionally in extension or mainbar (sh-emporia, stchris-speed)
  With explicit calendar slug when used on parish side

### Paired elements (school mainbar always has all three)
  1. custom "Calendar Title" — <h2 class="g-title">Calendar</h2>
  2. timeline particle
  3. custom "View Full Calendar Button" — <a class="button" href="/news/calendar">View Full Calendar</a>

---

## position (module position)

### What it is
A placeholder that renders whatever Joomla modules are assigned to a named position.
Not a Gantry particle per se — it outputs whatever the Joomla module manager provides.

### Named positions used

home-ads (aside section, all sites)
  Purpose: Display paid advertising banners beside the news content.
  Visual: Stack of ad images in the right-side column.
  Config: type: position, subtype: module, title: "Home Ads"
  Block class: ads-901 side-ads ads-902 ads-903

bottom-ads (bottom section, most sites)
  Purpose: Full-width ad banner below main content.
  Config: type: position, subtype: module, title: "Bottom Ads"

footer-a, footer-b, footer-c (footer section, all sites)
  Purpose: Three columns of footer content — address, quick links, mass times summary.
  Visual: Three equal-width columns in the footer area.
  Config: three position particles at 33.3% each in footer row 1
  Note: These are module positions, not particles with content — content comes from
        Joomla modules assigned to these positions in the module manager.

---

## system/messages

### What it is
Gantry system particle that outputs Joomla system messages (success/error/notice alerts
from form submissions, logins, etc.).

### Fields
No configuration at all. Its presence is mandatory.

### Rule
Always the FIRST particle in the top section (row 1). Never remove it.
If system messages have nowhere to render, Joomla will break on form submissions.

---

## PARTICLE DECISION GUIDE

When building a new section, choose the right particle:

  Content admin must update in Joomla backend → contentarray (articles)
  Fixed HTML structure/layout → custom
  Repeating link list with images → blockcontent
  Hero slideshow → swiper
  Site logo → logo
  Main navigation menu → menu
  Mobile navigation → mobile-menu (offcanvas only)
  Social media icons → social
  School events calendar list → timeline
  Joomla module output → position
  Joomla system notices → system/messages (always first in top)

DO NOT use custom for content clients will edit.
DO NOT use contentarray for structural HTML.
DO NOT put toplinks in a contentarray — use blockcontent.
DO NOT skip system/messages — it is always in the top section.
`.trim();

module.exports = { STYLE_GUIDE, SECTIONS, PARTICLES };
