# Gantry Visual QA Workflow

Use this guide after any session involving particle placement, layout changes, or CSS work. The core principle: **build one section, verify one section, move on.** Do not place all particles first and fix CSS at the end — problems compound and become harder to isolate.

---

## When to Run This Workflow

- After adding or repositioning particles in any outline
- After writing or editing custom CSS for a section or particle
- After applying a layout template or outline blueprint to a new site
- Any time a client reports a visual issue ("the homepage looks wrong", "broken on mobile")
- After a generated layout build — always, without exception

---

## Tools

| Tool | Purpose |
|------|---------|
| `joomla_get_frontend_screenshot` | Full-page or element-targeted screenshots |
| `joomla_inspect_frontend` | **Why** a section looks wrong — box-model geometry and the CSS rules that actually match. See below |
| `gantry_particle{action:"html"}` | Returns rendered particle HTML — real selectors and structure |
| `gantry_layout{action:"tree"}` | Full layout structure — section IDs and particle positions |
| `gantry_layout{action:"sections"}` | Lists section IDs — the stable targets for CSS and screenshots |
| `gantry_particle{action:"edit"}` | Set block classes on particles without opening the UI |
| `gantry_styles{action:"edit"}` | Update Gantry style variables only — not for site CSS rules |
| `ftp_read_file` | Read the existing custom CSS file before appending new rules |
| `ftp_upload_file` | Write updated CSS back to `/templates/g5_clarity/custom/css/custom.css` |
| `mcp__Claude_in_Chrome__navigate` + `mcp__Claude_in_Chrome__javascript_tool` | Live DOM inspection, computed styles, element bounding boxes |

---

## Diagnosing a Section: `joomla_inspect_frontend`

A screenshot tells you *that* something is wrong. It never tells you why. When
spacing is off, a rule will not apply, or you are about to guess at a cause,
inspect the live page instead of theorising.

**Never guess at a box-model or specificity problem. Measure it.** One call is
cheaper than a wrong fix.

### Unexplained spacing

```
joomla_inspect_frontend {
  path: "/gala", selector: "#g-expanded", include: ["box"], depth: 4
}
```

Returns each node's rect plus its margin/padding, so asymmetric spacing shows up
as a number. A common Gantry cause: a module that renders nothing visible still
has a `.platform-content` wrapper with padding, which offsets everything below it.

### A rule that will not apply

```
joomla_inspect_frontend {
  path: "/gala", selector: "#g-expanded",
  include: ["css"], cssFor: ".gala-prayer-title",
  properties: ["color", "margin-top"]
}
```

Returns the matching rules ranked by specificity and a `winners` map naming the
selector and stylesheet that won each property — which is the answer to "why is
my rule losing". Always pass `properties` when chasing one thing; it cuts the
output sharply.

### Keeping the output small

The tool is scoped and truncated on purpose. Prefer it over fetching whole pages
or stylesheets.

- `include` defaults to `["box"]` — add `"css"`/`"text"` only when needed
- `properties` restricts CSS output to the properties you care about
- `depth` / `maxNodes` / `maxMatches` cap the tree
- `includeInactiveMedia: true` shows rules whose media query does *not* currently
  match — use it to work out why a mobile rule is not firing at desktop width

### Cross-origin stylesheets

On Solutio sites most CSS is served from CloudFront and `shared.solutiocdn.com`,
so it is cross-origin to the page and the browser refuses to expose its rules.
The tool re-fetches those sheets server-side and re-parses them in document
order, so CDN rules **are** included. The `recoveredStylesheets` note lists what
was recovered; anything in `opaqueStylesheets` is genuinely missing from the
results. Set `fetchCrossOrigin: false` to skip the refetch.

---

## Gantry Standard Section Selectors

Gantry 5 renders sections with predictable IDs. These are the stable targets for both CSS and element-level screenshots:

| Section | CSS Selector | Typical use |
|---------|-------------|-------------|
| Navigation | `#g-navigation` | Main menu, logo |
| Header | `#g-header` | Hero image, swiper, page title |
| Slideshow | `#g-slideshow` | Dedicated slideshow/swiper area |
| Utility | `#g-utility` | Utility/top bar |
| Above | `#g-above` | Above main content — alerts, breadcrumbs |
| Expanded | `#g-expanded` | Main content + sidebar area |
| Sidebar | `#g-sidebar` | Side navigation, ads |
| Below | `#g-below` | Below content — quicklinks, feature blocks |
| Extension | `#g-extension` | Extension section |
| Footer | `#g-footer` | Footer columns |
| Bottom | `#g-bottom` | Copyright bar |
| Offcanvas | `#g-offcanvas` | Mobile slide-out menu |

Custom sections added in Gantry get their own IDs based on the section key set during creation (e.g., a section keyed `features` becomes `#g-features`). Find these with `gantry_layout{action:"sections"}`.

---

## The Section-by-Section Loop

### For each section, in top-to-bottom order:

```
1. Add particles to the section
   → assign a unique block class to each particle (block[extra-class])

2. Get the rendered HTML to confirm selectors
   → gantry_particle(action: "html", particleId: "...")

3. Screenshot just this section at all three widths
   → joomla_get_frontend_screenshot(url: "...", element: "#g-header", width: 1440)
   → joomla_get_frontend_screenshot(url: "...", element: "#g-header", width: 768)
   → joomla_get_frontend_screenshot(url: "...", element: "#g-header", width: 390)

4. Run the section-specific checklist

5. Write CSS targeting block classes, not particle IDs
   → screenshot the section again to verify

6. Repeat steps 3–5 until the section passes

7. Move to the next section
```

### Final pass (after all sections are done individually):

```
Full-page screenshot at all three widths
  → check section-to-section spacing and transitions
  → check nothing is collapsing or overlapping at the seams
  → confirm the page reads well as a whole
```

---

## Section Screenshots

### Using the element parameter (preferred)

If `joomla_get_frontend_screenshot` supports element targeting, pass the section's CSS selector directly:

```
joomla_get_frontend_screenshot(
  url: "https://sitecode.solutiosoftware.com/",
  element: "#g-header",
  width: 1440
)
```

This clips the screenshot to just that section — no scrolling, no cropping noise from adjacent sections.

### Using Claude in Chrome (fallback or for live inspection)

When element targeting isn't available or you need to inspect computed styles:

```javascript
// In mcp__Claude_in_Chrome__javascript_tool:
// Scroll the section into view and return its bounding rect
const el = document.querySelector('#g-header');
el.scrollIntoView();
const rect = el.getBoundingClientRect();
return { top: rect.top, height: rect.height, width: rect.width };
```

Then take a screenshot with the computer use tool, or use `get_page_text` to read the rendered DOM of that element.

---

## Section-Specific Checklists

Check these after screenshotting each section. Each section type has different concerns.

### Navigation (`#g-navigation`)
- [ ] Logo displays at correct size — not too large, not missing
- [ ] Menu items all visible, no wrapping to a second line
- [ ] Dropdown menus (if any) not cut off by z-index issues
- [ ] Mobile: hamburger visible and positioned correctly
- [ ] Active/hover state colors match site palette

### Hero / Header (`#g-header`, `#g-slideshow`)
- [ ] **Swiper block class is `fullwidth-swiper`** — verify via `gantry_layout{action:"tree"}` or `gantry_particle{action:"html"}`
- [ ] **Swiper particle ID is `rotate-addpic`** — verify in particle settings; required for rotator JS and CSS
- [ ] Hero image fills the section — no gap, no overflow
- [ ] Text overlay readable against the image — sufficient contrast
- [ ] CTA buttons visible and correctly styled
- [ ] Mobile: hero not taller than the viewport; heads not cropped
- [ ] Swiper controls (arrows, dots) visible if applicable
- [ ] Section height intentional — not collapsed, not excessively tall

### Feature / Content Sections (`#g-above`, `#g-below`, custom sections)
- [ ] Grid shows correct column count at desktop (2-up, 3-up, 4-up as designed)
- [ ] Equal height columns where expected
- [ ] Images properly sized — not stretched, not cropped oddly
- [ ] Card/tile borders, shadows, hover states correct
- [ ] Tablet: columns reduce appropriately (3-up → 2-up, 4-up → 2-up)
- [ ] Mobile: everything stacks to a single column; no items hidden

### Main Content (`#g-expanded`)
- [ ] Content readable — correct font size, line height, paragraph spacing
- [ ] Sidebar (if any) at expected width and not overlapping content
- [ ] Module positions (content-top-a, content-bottom-a, sidebar-a) populated correctly
- [ ] Page title visible
- [ ] Breadcrumbs present if expected

### Footer (`#g-footer`, `#g-bottom`)
- [ ] Columns display correctly at desktop — text not overflowing columns
- [ ] Links all visible and correctly colored
- [ ] Social media icons present and properly sized
- [ ] Copyright bar visible below footer columns
- [ ] Mobile: columns stack cleanly — nothing overlapping

### Global (every section, every width)
- [ ] Section background (color, image, gradient) rendering as designed
- [ ] No unexpected horizontal scrollbar
- [ ] Section padding/spacing looks intentional — not collapsed, not excessive
- [ ] Nothing cut off at the right edge

---

## Establishing Selectors Before Writing CSS

Before touching CSS, get the real rendered HTML to confirm what selectors exist:

```
gantry_particle(action: "html", outlineId: ..., particleId: "contentarray-XXXX")
```

From the returned HTML, identify:
- The particle wrapper ID (generated, e.g., `#contentarray-6848`) — fragile, avoid targeting this
- Block classes applied via `block[extra-class]` — stable, use these
- Internal structure: `.g-grid`, `.g-block`, item containers, link elements

**Always set a unique block class on every particle at creation time:**

```
gantry_particle(action: "edit",
  outlineId: ...,
  particleId: "contentarray-XXXX",
  changes: { "block[extra-class]": "quicklinks-bar" }
)
```

CSS then targets `.quicklinks-bar`, which survives layout rebuilds. The generated particle ID does not.

---

## Writing and Deploying CSS

> **Before touching Page Settings assets:** run `gantry_outline{action:"for_page"}` on the target page first. The live page may be served by a child outline (e.g., outline `33`) that has its own local Assets — changes to Base Outline will have no effect there. Always edit the outline that is actually serving the page.

CSS goes in the **active outline's Page Settings CSS asset rows** — not the Gantry Styles textarea. Three approaches depending on FTP access; see `read_agent_doc(doc: "gantry-section-css")` for the full reference.

**Quick decision:**

| FTP access | Use |
|-----------|-----|
| Can write to `/templates/` | FTP `custom.css` → register in Base Outline CSS rows |
| Locked to `/pub` | FTP to `content/override.css` (already registered on most sites) |
| No FTP / fast iteration | Inline CSS directly in a Page Settings asset row via `gantry_page{action:"edit"}` |

### Inline approach (fastest — no file upload)

Read the current CSS rows first, then append to the inline field of an existing row (or add a new one):

```
1. gantry_page(action: "list", site: "...", outline: "default", all: true)
   → find page[assets][css][_json] — note the existing rows array

2. Modify the inline field of the target row (e.g. "To Merge" or "Override")
   → or add a new row: {"location": "", "inline": "/* css */", "priority": "1", "name": "Agent Custom"}

3. gantry_page(action: "edit", site: "...", outline: "default", edits: {
     "page[assets][css][_json]": "[...complete updated array...]"
   })
   → always write the full array, not just the changed row

4. Screenshot the section → verify the fix
```

Always pass the **complete array** back — `gantry_page{action:"edit"}` replaces the whole field. Read first, modify, write all rows.

### CSS patterns

Target block classes and section IDs. Check `read_agent_doc(doc: "gantry-section-css")` for the full selector reference and authoring rules before writing new rules.

```css
/* Section padding */
html body.site-home #g-below .quicklinks-bar > .g-container {
  padding: min(3vw, 3rem) min(2vw, 2rem) !important;
}

/* Fix grid gap */
.services-grid .g-joomla-articles > .g-grid { gap: 1.5rem; }

/* Equal-height cards */
.services-grid .g-grid { align-items: stretch; }
.services-grid .g-block { display: flex; flex-direction: column; }

/* Responsive stack */
@media (max-width: 50.99rem) {
  .services-grid .g-block { width: 100% !important; }
}

/* Use CSS variables — never hardcode colors */
.section-hero h2 { color: var(--primary-color); }
```

Always verify current color values from the site's Styles page before writing any color rules.

---

## When to Escalate to Chrome Inspection

Screenshots show the result. Chrome inspection shows why. Switch to Chrome tools when:
- A section looks wrong but you can't tell why from the screenshot
- Hover or focus states need to be verified
- A JavaScript-driven component (swiper, popup, accordion) needs testing
- You need the computed value of a CSS property

```
mcp__Claude_in_Chrome__navigate(url: "https://sitecode.solutiosoftware.com/")

// Get computed styles for a specific element
mcp__Claude_in_Chrome__javascript_tool(
  script: "getComputedStyle(document.querySelector('.quicklinks-bar')).padding"
)

// Get element dimensions
mcp__Claude_in_Chrome__javascript_tool(
  script: "document.querySelector('#g-header').getBoundingClientRect()"
)
```

---

## Agent7 Sandbox Convention

`agent7.forge.solutiosoftware.com` is the layout and CSS development sandbox:

- Add a unique block class to **every** particle — this is the CSS hook
- Build and verify **one section at a time** — never place all particles first
- Extract CSS patterns that work here into `apps/gantry-mcp/templates/sections/` as reusable templates
- Screenshot naming convention when saving patterns: `[section-name]-[desktop|tablet|mobile]-[pass|fail].png`

---

## Summary: The Full Loop

```
For each section (top to bottom):
  ├── Add particles → assign block classes → get_particle_html
  ├── Screenshot section at 1440 / 768 / 390 (element-targeted)
  ├── Run section checklist → note all issues
  ├── Write CSS targeting block classes
  ├── Screenshot section again → verify fixes
  └── Repeat until section passes → move to next section

After all sections:
  ├── Full-page screenshot at 1440 / 768 / 390
  ├── Check section-to-section spacing and transitions
  └── Confirm page reads well as a whole

Extract reusable CSS patterns → section templates
```

A section is not done until its element-targeted screenshot passes the checklist at all three widths. A page is not done until the full-page pass is clean.
