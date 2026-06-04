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

Every category used in a grid must also have a display menu item in either `secondary-menu` or `hidden-menu` so articles have a landing page.

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
2. Title: `[Page Name] - Side Menu`. Show Title: **Hide**. Position: `SideBar A` (under Clarity).
3. Click **Pick a Particle** → select **Block Content**.
4. **Settings tab:** Change Content Source to **Joomla**.
5. **Articles tab:** Select the category. Clear "Number of Articles". Order by: **Ordering**.
6. **Article Display tab:** Image → None. Title → Show. Article Text → Hide. Click **Apply**.
7. **Menu Assignment tab:** Only on pages selected → check the category blog menu item.
8. **Advanced tab:** Module Class Suffix: `side-menu-particle`.
9. Save and close.

---

## Verify the Grid Outline

Before starting, confirm the Grid Outline exists in Gantry. It should be a named outline (e.g., "Grid") with the appropriate layout. If it doesn't exist, create it before building the module.
