# KB — Grid Layout Setup

How to build a grid layout page using a Gantry 5 Joomla Articles or Block Content particle module.

---

## Overview

A grid layout has two parts:
1. A **Single Article** menu item pointing to an article with the same title as the page (no content required unless a leading article is requested — it just displays the page title).
2. A **Gantry 5 Particle module** placed in position `CONTENT-BOTTOM-A` that renders the grid below the page content.

**Particle types:**
- Use **Joomla Articles** particle when the grid pulls from a category of articles.
- Use **Block Content** particle when the grid links to specific menu items instead of articles.

**Grid items do not need their own menu items.** The Joomla Articles particle generates links directly to the article URL — no menu item is required for routing. Do not create menu items for individual grid cards; keep them as articles only in the appropriate category.

---

## Inspecting an Existing Grid's Particle Settings

Grids on this platform are always **Gantry 5 Particle modules** — never layout-embedded particles. To read an existing grid's configuration (category, display settings, class suffix) before copying its pattern for a new grid, use `joomla_module get` with the module's ID. The full particle config comes back as JSON in `params.particle`.

Do **not** use `gantry_particle{action:"inspect"}` for this — it looks up a particle by outline id + particle name/position inside a layout design, and has no path for looking up a particle by Joomla module ID. Passing a `moduleId` to it fails with `Particle "undefined" not found in outline "..."`. Reserve `gantry_particle{action:"inspect"}` for particles placed directly in an outline's layout (e.g. via `gantry_design{action:"compile"}`), not for grid modules.

---

## Prerequisites — Confirm or Create a Category

The grid's particle module must point at a category. Before building the module, check whether an appropriate category already exists:

- If an existing category is the right fit (e.g., a Staff category already scoped to this grid), use it — note its ID.
- If no suitable category exists, create a new one: **Content → Categories → New**. Title it descriptively (e.g., `Ministries Items`, `Staff Items`), parent root (`/`), and note the new category ID.

Do **not** create a new category if one already serves this purpose — duplicate categories cause articles to appear in the wrong places.

---

## Step-by-Step: Create the Grid Module

1. Go to **Module Manager** → New → **Gantry 5 Particle**.
2. **Module tab:**
   - Title: descriptive name of the category being shown.
   - Show Title: **Hide**.
   - Position: `CONTENT-BOTTOM-A`.
3. **Menu Assignment tab:**
   - Set to **Only on the pages selected** → deselect all → select the target menu item.
4. **Advanced tab:**
   - Module Class Suffix: add the grid style classes selected from the Styles site (e.g., `grid-tiles grid-square grid-tiles-mobile`).
5. Back on **Module tab** → click **Edit Particle / Pick a Particle**.
6. Select **Joomla Articles** (or **Block Content** for menu-item links).

### Joomla Articles Particle Settings

- **Articles tab:** Set the category. Adjust number of articles as needed.
- **Display tab:** Follow site standard display settings.
- **Read More tab:** Follow site standard read-more settings.
- **Extras tab:** Follow site standard extras settings.

---

## Step-by-Step: Create the Side Menu Module

Used on grid pages where a secondary navigation sidebar is needed.

1. Go to **Module Manager** → New → **Gantry 5 Particle**.
2. Title: `[Page Name] - Side Menu`. Show Title: **Hide**. Position: `SideBar A` (position name may vary by template — check the site's active Gantry template for the correct sidebar position).
3. Click **Pick a Particle** → select **Block Content**.
4. **Settings tab:** Change Content Source to **Joomla**.
5. **Articles tab:** Select the category. Clear "Number of Articles". Order by: **Ordering**.
6. **Article Display tab:** Image → None. Title → Show. Article Text → Hide. Click **Apply**.
7. **Menu Assignment tab:** Only on pages selected → check the category blog menu item.
8. **Advanced tab:** Module Class Suffix: `side-menu-particle`.
9. Save and close.

---

## Verify the Grid Outline

Before starting, confirm that a Grid-type outline exists in Gantry for this site. The outline name varies by site template — for example, it may be named `Studius - #Grid`, `Grid`, or similar. Check **Gantry → Outlines** to find the correct name.

Assign the correct `templateStyleId` for this outline when creating the Single Article menu item (do not rely on the default template style — the grid position `CONTENT-BOTTOM-A` only renders correctly under the grid outline). If no grid outline exists, create one before building the module.
