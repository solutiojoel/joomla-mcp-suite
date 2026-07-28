# cf-fortwayne.solutiosoftware.com — Site Notes

**Site:** Catholic Community Foundation of Northeast Indiana
**Theme:** `rt_clarity` (not the default `studius` — always pass `theme: "rt_clarity"` to Gantry tools on this site)

## Key IDs

**Menus:**
- `mainmenu` (id 1) — live Main Menu
- `hidden-menu` (id 2)
- `secondary-menu` (id 3)
- `quickgalleries` (id 4)
- `preview-menu` (id 5) — **draft/preview menu, built 2026-07-21**, isolated (no module assignment, invisible on live site). Not approved. All 4 top-level sections (About, Impact, Give, Receive) have content. **23 items total** (verified via `joomla_menu_item list`, menuId `preview-menu` — an earlier audit note/site-notes version incorrectly said 27; that was a counting error, corrected 2026-07-21). Structure:
  - Home (210) → category blog id=15, outline 21 "Site Home Draft"
  - About (206, heading) → About Us (211→420), History (212→422), Our Leadership (213→423), Financial Information (214→425), Contact Us (215→424) — all outline 22, all in category 48
  - Impact (207, heading) → Our Pillars (216→427), Impact Reports (217→428) — outline 22
  - Give (208, heading) → Give Now (218→429, empty body — live source article 66 is also empty; real content is Gantry-rendered on live outline 20 "Foundations", not migrated), Creating a Fund (219→430, dup of live art. 25), Methods of Giving (220→431, dup of live art. 54), Planned Giving (221→435, dup of live art. 55, internal link repointed to Itemid 220), Magnificat Bequest Society (222→432, dup of live art. 17, member roster omitted with a note), Support Our Mission (223→433, dup of live art. 9), Resources (224→434, assembled from live "Donors" art. 36 — live "Parishes, Schools and Ministries" art. 56 has empty body so wasn't usable) — all outline 22
  - Receive (209, heading) → **Grant Opportunities (225→436) — fully built as a "fancy page" 2026-07-21, see below.** → **child:** Legacy of Faith (226→437, plain-HTML placeholder so far, built from live fund articles 190-193, still needs the fancy-page treatment) → **child:** Legacy of Faith Grants (227→438, plain-HTML placeholder, needs fancy-page treatment + a timeline/dates-graphic component). Endowment Distributions (228→439, plain-HTML placeholder, direct child of Receive, sibling of Grant Opportunities, needs fancy-page treatment — content itself is still "not ready" per the client's own July 2026 doc, only build the structural shell when tackled) — all outline 22
  - All `-preview` aliased items collide with existing live mainmenu items by title. Live "Giving" mainmenu section (161) has real articles behind every Give-section blue wireframe item — check there first before assuming new content is needed for any future preview-menu work in this section.

**Wireframe convention (confirmed 2026-07-21, applies to all future preview-menu wireframes from this user):** green=top-level heading, blue=existing live page (duplicate verbatim), orange solid=existing page being moved/edited (rebuild/consolidate, ok to author new copy if live source is empty/Gantry-rendered), yellow solid=brand-new page (author new content, use any real related content found on the live site rather than fabricating), gray=in-page content/heading (NOT a menu item — becomes an H3/H4 section inside the parent article), pink-outlined "DOC:"/"CURRENT:"/"VARIED:" and orange-outlined "LINK:"/"Request..." = inline links/references within the parent page's body content (also NOT menu items). Only solid blue/orange/yellow bubbles become actual Joomla menu items — this holds regardless of nesting depth (e.g. Receive's "Legacy of Faith Grants" is 3 levels deep and still became a real menu item because it's yellow).

**Cross-page links inside preview content:** use `index.php?Itemid=N` pointing at the preview menu item's own Itemid, not relative content-alias paths (those only resolve correctly under their original live menu). When a new preview page needs to link to a sibling/child preview page created in the same batch, build the hierarchy top-down (parent menu item before child), then patch the linking article's placeholder href with the real Itemid once known.

**Preview content category:** "Preview Menu Content" (com_content category id 48) — all preview-build articles go here (ids 420, 422-439 as of 2026-07-21). Do NOT use category id 12 "Preview" (pre-existing, unrelated, left empty intentionally — user rejected it for this build).

## "Fancy page" infrastructure (Receive section build, started 2026-07-21)

Claire Smith (CCFNEI) sent a detailed July 2026 content/format doc for the 4 Receive pages, referencing real designed components (tile grids, "Chapter" accordions, contact tiles, colored CTA blocks) — this required standing up the site's first-ever "fancy page" setup (see `workflows/custom-page-agent`). Nothing here existed before this session — pub folder was empty, no Raw Tags module, no style-guide.json.

- **FTP `pub/` folder** (`/nra/cf-fortwayne/pub/`, public URL `https://cf-fortwayne.solutiosoftware.com/images/pub/`):
  - `style-guide.json` — primary navy `rgb(28,58,82)`, secondary olive `rgb(124,143,61)`, tertiary cream `rgb(247,244,235)`, fonts Playfair Display (display) / Open Sans (body). **Estimated visually from the live homepage screenshot** — no override.css exists on this site and `gantry_styles{action:"list"}` errored (`fetch failed`) when queried for outline `default`/theme `rt_clarity`. Revise if exact hex/fonts are ever confirmed.
  - `sc-components.css` — shared frontend component library: `.sc-page`/`.sc-section` scaffold, `.sc-tile-grid`/`.sc-tile`, `.sc-contact-tile`, `.sc-cta-block`, `.sc-btn`/`.sc-btn--primary`/`.sc-btn--outline`, `.sc-link-list`, `.sc-accordion`/`.sc-accordion-item` (built for Legacy of Faith/Legacy of Faith Grants, not yet used), `.sc-animate` scroll fade-in. **This is the base for all 4 Receive pages** — extend it rather than writing page-specific CSS when a new component is needed by more than one page.
  - `sc-components.mce.css` — same components scoped under `.mce-content-body`, for TinyMCE editor-preview parity. **Uploaded but NOT wired into the site's global TinyMCE config** — see Quirks below.
  - `sc-scroll.js` — IntersectionObserver fade-in (`.sc-animate`/`.sc-in`) + accordion click-toggle (`.sc-accordion-trigger` → toggles `.sc-is-open` on `.sc-accordion-item`).
  - **`html-templates/` subfolder** (added 2026-07-22, public URL `.../images/pub/html-templates/`) — reference copies of article body HTML, uploaded any time a fancy-page article is built/changed so the markup is version-tracked outside Joomla. Contains `grant-opportunities.html` (exact copy of article 436's body) and `sc-components-reference.html` (generic, content-agnostic markup for every `sc-*` component — the starting point for the remaining 3 Receive pages). Keep this synced when article bodies change.
- **Raw Tags module id 134** ("Receive Section (Preview) — CSS/JS"), position `ganalytics`, assigned only to Itemids 225-228 (never touches live pages). Loads Font Awesome 6 CDN + `sc-components.css` + `sc-scroll.js`.
- **Article markup convention:** `<section class="sc-section sc-section--*">` tags are used (confirmed permitted by this site's TinyMCE config, per user 2026-07-21 — overrides the more conservative div-only guidance in the general `custom-page-agent` doc, which predates this confirmation). Still no inline `style`, `<script>`, or `<style>` in article bodies — those get stripped on next TinyMCE save regardless.
- **Grant Opportunities (article 436, Itemid 225) is the completed prototype** — Overview copy, 1-tile grid → Legacy of Faith (Itemid 226), "Other Area Funders" list (4 orgs, no real URLs available — rendered as plain text with an honest "(link to be added)" placeholder), Claire Smith contact tile, "Your Legacy of Faith" CTA block (Donate Now → Itemid 218, Start Planning → Itemid 221), and a hero image (`featuredImage` = `/images/stories/27SeminarianMass-7-scaled-2306x700.jpg`, an existing site asset reused since no client photo exists yet — Gantry renders `featuredImage` natively as a full-width hero, no custom markup needed). Verified via desktop + mobile screenshots — renders correctly with real site colors/icons/responsive layout.
- **Remaining work:** Legacy of Faith, Legacy of Faith Grants, Endowment Distributions still need the same fancy-page treatment (currently plain-HTML placeholders from an earlier session). Legacy of Faith needs the accordion component put to use (4 fund sections); Legacy of Faith Grants additionally needs a timeline/dates-graphic component not yet built. Other items from Claire's July 2026 doc — News & Events → footer move, Resources section obsolete/move, Impact Reports "Current Edition" highlight — are separate, smaller tasks, not fancy-page builds.

**Gantry outlines (theme rt_clarity):**
- `default` / `17` "Site Outline / Base" — primary base outline (both flagged isDefault)
- `13` "Site Home"
- `16` "Site Grid"
- `18` "Site Calendar"
- `20` "Foundations" — subsite family; also used by live "Give Now" menu item (172) — that page's real content is Gantry-rendered, not in the article body
- `15` / `19` "Landing" / "landing outline" — subsite family
- `21` "Site Home Draft" — draft outline for preview homepage. Assigned to preview-menu item 210. Its Navigation menu particle (`menu-8169`) previously pointed at `mainmenu` — as of the 2026-07-21 screenshot check the live nav now shows Give/Receive on preview pages, suggesting the user has since made this switch themselves.
- `22` "Site Outline draft" — draft outline for preview subpages. Assigned to all preview-menu sub-items (211-228). Same likely-switched status as outline 21 above — not independently confirmed, just inferred from the nav bar rendering correctly in the 2026-07-21 Grant Opportunities screenshot.

**DOCman reference (used in Financial Information / Impact Reports preview content):**
- Category id 1 "Other Documents" (slug `other`) — includes doc id 29 "Condensed Combined Financial Statements, 2023-2024"
- Category id 2 "Impact Reports" (slug `impact-reports`) — Annual Reports 2015–2025, latest is doc id 37 "2025 Impact Report". This is what the LIVE "Financial Information" mainmenu item (170) actually displays today (a DOCman list filtered to this category) — a pre-existing site quirk, not something this session changed.
- No "Investment Policy" or "Distribution Policy" documents exist in DOCman yet.
- Blog category (com_content category id 2) holds news posts like "Introducing 2025 Impact Report - A Letter from Bishop Rhoades" (article 405) — used as the "News & Events" target in preview content.

**Legacy of Faith fund content (category id 14 "- Legacy of Faith", under Fund Categories):** 4 real fund description articles already exist live but are not surfaced in any menu — id 193 Religious Education, 192 Hispanic Ministry, 191 Elementary Schools, 190 Catholic Charities. Each has a short description + a "fund" donate button linking to `ccfni.fcsuite.com/erp/donate/create?funit_id=...`. Used verbatim as the in-page sections of the new preview "Legacy of Faith" article.

## Quirks

- **`com_plugins` (Extensions → Plugins) returns a hard 403 for the MCP service account** — it isn't even present in the admin nav (Extensions menu only exposes Modules). This blocks any plugin-level config change (e.g. wiring custom CSS into the global TinyMCE editor profile) via `joomla_inspect_admin_form`/`joomla_submit_admin_form`. The Solutio `com_siteconfig` panel does not expose editor/TinyMCE settings as an alternative. Needs either a human with full admin access or an account permission grant.
- `gantry_styles{action:"list"}` returned `fetch failed` for outline `default`/theme `rt_clarity` (2026-07-21) — not investigated further, worth retrying in a future session.
- Existing mainmenu top-level items mix Joomla "Menu Heading" type (About, Resources, News & Events) and "Separator" system-link type (Giving) — inconsistent on this site already.
- Alias "about" is taken by mainmenu item 111 ("About") — any new "About"-titled item elsewhere needs an explicit alias suffix.
- Live "Financial Information" (mainmenu item 170) is a DOCman list pointed at the "Impact Reports" category (slug impact-reports) — it shows annual reports, not financial statements. Source of the About-section preview reorg.
- Article "The Four Pillars" (id 27, com_content category 11) is published but orphaned — no live menu item points to it. Content matches the "Our Pillars" preview concept (Parish Life / Catholic Education / Community / Vocations).
- Live "Give Now" (article 66, menu item 172) and "Parishes, Schools and Ministries" (article 56, menu item 178) both have **empty article bodies** — their real page content is rendered entirely through Gantry particles/sections on their assigned outline, not the article. Any future work duplicating these pages needs Gantry access to capture the real content (out of scope for article-level duplication).
- Joomla article title for live menu item "Creating a Fund" (174) is actually "Create a Fund" (id 25) — title mismatch between menu item and article on the live site.
- Live article "​Supporting our Mission" (id 9) has a leading zero-width space character in its title — cosmetic quirk, harmless but shows up in raw title strings.

## Active Integrations

None documented yet.
