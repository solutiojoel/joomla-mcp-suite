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

Standard opening blocks (always present in this order):

html body.site-home {
    --section-above-bg: var(--secondary-color);
    /* additional section-bg overrides as needed */
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

SECTION BACKGROUND VARIABLES (in html body.site-home {}):
  --section-{id}-bg: var(--primary-color);   e.g. --section-slideshow-bg, --section-expanded-bg

NAVIGATION BACKGROUND (standard pattern):
#g-navigation {
    background: url('/images/template/bg-header.jpg') 50% 50% no-repeat;
    background-size: cover;
    position: relative;
}
#g-navigation:before {
    content: '';
    background: rgba(var(--primary-color-rgb), .85);
    backdrop-filter: blur(7px);
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    z-index: 1;
}
#g-navigation > .g-container {
    position: relative; z-index: 2;
}

School nav uses: /images/template/school26/bg-header.jpg

RESPONSIVE BREAKPOINTS (always use these exact values):
  Desktop: @media only screen and (min-width: 50.99rem)
  Mobile:  @media only screen and (max-width: 50.99rem)

SIZING CONVENTION: min(Nvw, Nrem) where both values match:
  min(1vw, 1rem)  min(1.25vw, 1.25rem)  min(1.5vw, 1.5rem)
  min(2vw, 2rem)  min(3vw, 3rem)  min(4vw, 4rem)

CSS VARIABLES (use these — never hardcode hex values):
  --primary-color          Site primary brand color
  --secondary-color        Secondary brand color
  --tertiary-color         Accent color
  --default-white          White (#ffffff or equivalent)
  --default-black          Black
  --background-color       Page background
  --footer-color           Footer background
  --primary-color-rgb      RGB values of primary (for rgba())
  --title-font-family      Heading font
  --body-font-family       Body font
  --default-box-shadow     Standard box shadow

CSS SECTION ID SELECTORS: #g-{section-id}
  e.g. #g-navigation, #g-slideshow, #g-expanded, #g-footer

BODY CLASS TARGETING:
  html body.site-home {}    Homepage only
  html body.site-sub {}     Subpages only
  html body {}              All pages
  html body.withmaxwidth {} When max-width container is active

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

  inherit_rules: `
These sections ALWAYS inherit from the default outline — never build fresh content in them unless editing the base default outline:
  navigation, footer, copyright, bottom

Inherit config: { outline: "default", include: ["attributes", "block", "children"] }
`.trim(),

  css: `
Standard CSS pattern:
- File: /content/override.css
- Starts with: /* ARTWORK NOTES ----------- */
- Always includes: .g-array-item-text { margin: 0!important; padding: 0!important; }
- Breakpoints: min-width: 50.99rem (desktop), max-width: 50.99rem (mobile)
- Sizing: min(Nvw, Nrem) — values always match (e.g. min(1.5vw, 1.5rem))
- Colors: always CSS variables (--primary-color, --secondary-color, --default-white, etc.)
- Section backgrounds: --section-{id}-bg variables in html body.site-home {}
- Navigation background: bg-header.jpg with rgba primary color overlay + backdrop-filter blur
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
