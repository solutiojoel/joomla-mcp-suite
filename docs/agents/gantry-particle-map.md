# Gantry Particle Map

Use this guide before adding particles to sections, writing design YAML, or deciding CSS selectors for particle output. It complements `gantry-section-css.md`.

---

## Source of Truth

Particle schemas live in:

```text
apps/gantry-mcp/particles/
```

The `gantry_particle_catalog` tool reads those YAML files directly. If a particle setting appears in exported layouts, it should be represented in the matching YAML file so future designs can build it intentionally.

Fleet inventory sources checked:

- `apps/gantry-mcp/exports/home-outlines/`
- `apps/gantry-mcp/templates/homepages/`
- `apps/gantry-mcp/templates/sections/`
- `apps/gantry-mcp/design-patterns/`
- Live Forge sampling on `https://agent6.forge.solutiosoftware.com/`, homepage outline `33`

---

## ⚠️ Known Tool Limitations & Workarounds

### Adding Particles to Empty Sections (Bug — needs dev fix)

`gantry_layout_add` crashes with `Cannot read properties of undefined (reading 'push')` when targeting any section that has no existing particles. Empty sections have no `children` key in the layout JSON, and the tool tries to call `.push()` on `undefined`.

**Affected sections:** `above`, `feature`, `showcase`, `sidebar`, `mainbar`, `aside`, `expanded`, `extension` — any section with zero particles on a fresh or cleared outline.

**Workaround — export → patch → import:**

1. Export the current layout:
   ```
   gantry_layout_export(site: "...", outline: "33")
   ```

2. In the exported JSON, find the empty section node. It will look like:
   ```json
   {
     "type": "section",
     "id": "above",
     "layout": true,
     "subtype": "section",
     "title": "Above",
     "attributes": { ... }
   }
   ```
   Note: no `children` key at all.

3. Add a `children` array with the full `grid → block → particle` structure. Use IDs in the format `grid-NNNN`, `block-NNNN`, `subtype-NNNN` with 4-digit numbers not already in the layout:
   ```json
   {
     "type": "section",
     "id": "above",
     "layout": true,
     "subtype": "section",
     "title": "Above",
     "attributes": { ... },
     "children": [
       {
         "id": "grid-7701",
         "type": "grid",
         "subtype": "grid",
         "layout": true,
         "attributes": {},
         "children": [
           {
             "id": "block-7702",
             "type": "block",
             "subtype": "block",
             "layout": true,
             "attributes": { "size": 100, "class": "your-block-class" },
             "children": [
               {
                 "id": "custom-7703",
                 "type": "particle",
                 "subtype": "custom",
                 "title": "Particle Title",
                 "attributes": { "html": "<p>content</p>", "enabled": 1 }
               }
             ]
           }
         ]
       }
     ]
   }
   ```

4. **Critical:** Keep every other section and particle exactly as exported — do not truncate or simplify any particle attributes or you will overwrite live content.

5. Import the full modified layout:
   ```
   gantry_layout_import(site: "...", outline: "33", layout: [...full patched array...], dryRun: true)
   ```
   Verify the diff shows only your new particle as added and nothing else changed. Then remove `dryRun` to save.

6. After import, verify the particle is visible:
   ```
   gantry_layout_list(site: "...", outline: "33", editable: true)
   ```
   Your new particle ID should appear. Use that confirmed ID for any subsequent `gantry_layout_edit` calls.

---

### Editing Particles — ID Resolution Rules

`gantry_layout_edit` only resolves particles from the **editable (non-inherited) set**. Two things cause "Particle X not found":

1. **The particle is inherited** from a parent outline — edit it on the source outline instead (usually Base Outline `default`).
2. **The particle was just created** and the layout state hasn't refreshed — call `gantry_layout_list(editable: true)` first, confirm the ID appears, then call `gantry_layout_edit`.

Always use IDs returned by `gantry_layout_list(editable: true)` as the source of truth before editing. Never assume an ID is resolvable just because it appears in `gantry_layout_tree` — inherited particles appear in the tree but not in the editable list.

---

## Rendered Targeting Rule

Most particles render inside:

```css
#g-section > .g-container > .g-grid > .g-block.{blockClass} > .g-content.g-particle
```

Use the custom block class on `.g-block` as the primary CSS anchor.

If a particle has no unique block class, `gantry_particle_html` may not be able to isolate it from the frontend HTML. For those particles, either inspect the full page DOM or temporarily assign a unique block class on a test outline.

---

## Particle Families Found Across Sites

| Type/subtype | Fleet count | Purpose | Key CSS anchor |
|---|---:|---|---|
| `particle/contentarray` | 960 | Joomla article output: news, alerts, widgets, footer, mass times | `.g-content-array`, `.g-array-item`, block class |
| `particle/custom` | 779 | Raw HTML: headings, buttons, popup, admin footer | the HTML itself plus block class |
| `position/position` | 397 | Named module positions like footer-a/b/c | `.platform-content`, module classes |
| `position/module` | 335 | Direct module slots like Home Ads, Bottom Ads | module output plus block class |
| `particle/blockcontent` | 316 | Repeating quicklinks/cards/logos/buttons | `.g-blockcontent` |
| `particle/logo` | 273 | Logo link/image in navigation | `.g-logo` |
| `particle/swiper` | 144 | Hero carousel | `.g-swiper`, `.swiper-slide`, `data-swiper-*` |
| `particle/mobile-menu` | 139 | Offcanvas mobile navigation | offcanvas/mobile menu markup |
| `particle/menu` | 130 | Main Gantry/Joomla menu | `.g-main-nav` / menu markup |
| `system/messages` | 112 | Joomla system messages | system message output when present |
| `spacer/spacer` | 108 | Empty horizontal layout width | `.g-block.size-N` only |
| `particle/social` | 82 | Icon link row | `.g-social`, `.g-social-items` |
| `particle/timeline` | 68 | Gantry calendar timeline/events | timeline event markup |
| `particle/copyright` | 10 | Gantry generated copyright | `.g-copyright` |
| `particle/horizmenu` | 10 | Manual horizontal link list | horizontal menu output |
| `particle/search` | 9 | Search form/trigger | search form output |
| `particle/video` | 9 | Local/remote video particle | video markup |

Counts are from local exported templates, not a live production census.

---

## Core Particles

### contentarray

Use for content managed in Joomla articles: alerts, news/events, Mass Times, footer article, Facebook/Instagram/Formed/calendar shell articles, bulletins, homilies, and welcome text.

Settings to account for:

- `title`, `enabled`
- `css.class`
- `extra[]`, especially `data-aos` and `data-aos-once`
- `article.filter.categories`, `article.filter.articles`, `article.filter.featured`
- `article.limit.total`, `article.limit.columns`, `article.limit.start`
- `article.display.pagination_buttons`
- `article.display.image.enabled`
- `article.display.title.enabled`
- `article.display.text.type`, `limit`, `formatting`, `prepare`
- `article.display.read_more.enabled`, `label`
- `article.display.date.enabled`
- `article.sort.orderby`, `ordering`

Live Forge sample:

```css
.mass-times-block .g-content-array.g-joomla-articles
.mass-times-block .g-array-item
.mass-times-block .g-array-item-text
```

The article body is inserted inside `.g-array-item-text`.

### blockcontent

Use for static/repeating link sets: quicklinks, toplinks, image-card grids, partner/resource cards, button groups.

Settings to account for:

- Particle-level: `source`, `class`, `title`, `icon`, `image`, `headline`, `description`, `linktext`, `link`, `linkclass`, `linktarget`, `enabled`
- Repeater: `subcontents[].name`, `button`, `buttonlink`, `buttontarget`, `buttonclass`, `icon`, `img`, `rokboximage`, `rokboxcaption`, `subtitle`, `description`, `class`, `accent`
- Article-source fallback fields: `article.filter.*`, `article.limit.*`, `article.sort.*`, `article.display.image/title/text/link.*`

Live Forge sample:

```css
.ql-title-overlay .g-blockcontent
.ql-title-overlay .g-blockcontent-subcontent
.ql-title-overlay .g-blockcontent-subcontent-block
.ql-title-overlay .g-blockcontent-subcontent-img
.ql-title-overlay .g-blockcontent-subcontent-title-text
.ql-title-overlay .g-blockcontent-buttons a
```

### custom

Use for raw HTML only when the structure is not client-managed content: section headings, standalone buttons, popup scaffolding, admin footer, module include wrappers.

Settings to account for:

- `html`
- `enabled`

Live Forge sample:

```html
<div class="g-block size-100 news-button">
  <div id="custom-4753-particle" class="g-content g-particle">
    <a href="/news" class="button">View All</a>
  </div>
</div>
```

### swiper

Use for hero sliders and image carousels. Standard Solutio homepage sliders usually use `source: joomla`.

**Required conventions for the homepage swiper — always set both:**
- **Block class** (`block[extra-class]`): `fullwidth-swiper`
- **Particle ID** (set in particle settings as `id`): `rotate-addpic`

These are used by the site's rotator JS and CSS across all Solutio sites. If either is missing or different, the rotator behavior and CSS targeting will break. Verify both whenever creating or editing the homepage swiper particle.

Settings to account for:

- Core: `enabled`, `class`, `source`, `image`, `height`, `heightMobile`
- Behavior: `nav`, `pagination`, `autoplay`, `autoplayTimeout`, `loop`, `speed`, `effect`, `direction`, `touchmove`, `slides_linkable`, `overlaycolor`
- Responsive: `largedesktopslides/group/space`, `desktopslides/group/space`, `tabletslides/group/space`, `mobileslides/group/space`
- Thumbnails: `thumbs`, `thumbslayout`, `thumbsnav`, `thumbsHeight`, `thumbsMobileHeight`, `largedesktopthumbs/thumbspace`, `desktopthumbs/thumbspace`, `tabletthumbs/thumbspace`, `mobilethumbs/thumbspace`
- Joomla source: `article.filter.*`, `article.limit.*`, `article.sort.*`, `article.display.image/title/text/link/render_html_tags`
- Manual source: `items[].image`, `title`, `description`, `link`, `linktext`

Live Forge sample:

```css
.fullwidth-swiper .g-swiper
.fullwidth-swiper .g-swiper-slider.swiper-wrapper
.fullwidth-swiper .swiper-slide
.fullwidth-swiper .swiper-navigation
```

Most behavior settings render as `data-swiper-*` attributes on `.g-swiper`.

### social

Use for compact icon links, not embedded feeds.

Settings to account for:

- `enabled`
- `items[].name`, `items[].text`, `items[].icon`, `items[].link`

Live Forge sample:

```css
.nav-social-icons .g-social
.nav-social-icons .g-social-items
.nav-social-icons .g-social-items a
.nav-social-icons .g-social-items span.fab
```

---

## Navigation and Layout Particles

### logo

Settings found across exports:

- `enabled`, `image`, `url`, `link`, `target`, `text`, `title`, `svg`

Live Forge sample:

```css
.hidden-phone .g-logo
.hidden-phone .g-logo img
.hidden-phone .g-logo span
```

Most Solutio logo image changes still belong in Gantry style settings, but particle-level image fields exist and must not be dropped when cloning/decompiling.

### menu

Settings:

- `enabled`
- `menu`

The menu particle often has no custom block class, so isolate it through full-page DOM selectors such as `#g-navigation .g-main-nav` unless a test block class is assigned.

### mobile-menu

Settings:

- `enabled`

Usually inherited in `offcanvas`. It often has no unique block class and may not be locatable by `gantry_particle_html` without a temporary test class.

### position and module positions

Settings:

- `key`
- `chrome`
- `enabled`
- `module_id`

Live Forge `Home Ads` sample:

```css
.ads-903.side-ads.ads-901.ads-902 .platform-content
.ads-903.side-ads.ads-901.ads-902 .moduletable
```

### spacer

Settings:

- `enabled`

The visible behavior is the wrapper block size. It renders little or no internal markup.

### system/messages

Settings:

- `enabled`

Required in the top section so Joomla messages can render. It may have no visible frontend output when there are no messages.

---

## Less-Common Particles

### timeline

Settings:

- `enabled`
- `calendar`
- `timeline`
- `events_pane`

Use mainly for school homepage events lists. Use contentarray instead when the calendar is embedded in a Joomla article.

### copyright

Settings:

- `enabled`
- `owner`
- `date.start`
- `date.end`

Rare; Solutio sites usually use custom admin footer HTML instead.

### horizmenu

Settings:

- `enabled`
- `items[].title`, `items[].link`, `items[].target`, `items[].icon`

Rare/manual. Use `menu` for Joomla-managed navigation and `blockcontent` for styled link groups.

### search

Settings:

- `enabled`
- `title`
- `placeholder`

Rare in homepage exports.

### video

Settings:

- `enabled`, `class`, `title`, `headertext`, `description`, `columns`
- `items[].title`, `source`, `video`, `posterimage`, `caption`, `info`, `autoplay`, `controls`, `loop`, `muted`, `related`, `start`
- `items[].local[].title`, `items[].local[].file`

Use when the video should be managed as a Gantry particle. Use contentarray when the embed lives in a Joomla article.

---

## Build Rule

Before adding a particle to a section:

1. Call `gantry_particle_catalog(subtype: "...")`.
2. Use a block class on the `.g-block` for any particle that needs CSS.
3. Dry-run the section/layout apply.
4. After applying on a test outline, call `gantry_particle_html` for the new particle ID.
5. Write CSS from the rendered HTML, not from guessed particle internals.
