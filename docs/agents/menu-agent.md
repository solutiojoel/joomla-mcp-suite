# Joomla MCP — Menu Agent Guide

**Scope:** Building menus, category structures, menu items, and module assignments for new or restructured navigation. For editing article text and SEO fields only, use `content-agent` instead. For pages requiring custom CSS/JS styling, use `custom-page-agent` instead.

## Overview

This documents the standard process for building a new menu with structured article content on a Joomla / Gantry 5 site.

---

## Category Structure

Categories organize articles so Gantry 5 Joomla Articles particles can filter by category without mixing top-level page articles into sub-item grids.

### Standard categories to create

| Category | Parent | Purpose |
|---|---|---|
| Page Content [Site] | Root or site parent | Holds top-level landing page articles |
| [Section] Items | Site parent category | Holds sub-page articles for each section |
| Staff Items [Site] | Site parent category | Holds individual staff bio articles |

**Naming rules:**
- Section categories always end with " Items" (e.g., "About EEC Items", "Admission Items")
- Staff and specialty categories follow the same " Items [Abbreviation]" pattern
- Page Content category holds any article that serves as a section landing page

---

## Article Organization

| Article type | Category |
|---|---|
| Top-level section landing pages (About, Admission, etc.) | Page Content [Site] |
| Sub-page articles (sub-menu items) | Their section's "Items" category |
| Staff bio articles | Staff Items [Site] |

**Why top-level articles go in Page Content:** When a Gantry 5 Joomla Articles particle filters by a section's "Items" category, the landing page article itself should not appear in that grid. Keeping it in Page Content isolates it.

---

## Build Order

### 1. Confirm site
- Call `set_active_site` with the target URL if not already set
- Call `get_active_site` to confirm before any edits

### 2. Create the menu
- `joomla_create_menu` — set a descriptive title and a clean type slug (e.g., `shannon-eec`)

### 3. Create section categories
- Create all "Items" categories under the site's parent category
- Create any specialty categories (Staff Items, etc.)
- Note each category ID for article assignment

### 4. Create articles

**Create in this order:**
1. Top-level section articles (About, Admission, Academics, etc.) — assign to Page Content category
2. Sub-page articles — assign to their section's Items category
3. Staff/specialty articles — assign to their specialty category

**Content rules:**
- No placeholder content — leave body empty unless the source document provides actual content
- Google Form links: wrap in a simple `<a href="...">` anchor
- Any link styled as a button must have `class="button"` on the anchor — e.g. `<a class="button" href="...">Label</a>`
- Staff articles: fetch `joomla-docs://agents/kb/staff-grid.md` for the required article body format

### 5. Create top-level menu items
- Type: **Single Article**
- Point each to its corresponding landing page article
- Note the returned menu item ID — sub-items use it as their `parentId`

### 6. Create sub-menu items
- Type: **Single Article**
- Set `parentId` to the appropriate top-level menu item ID
- Point each to its corresponding sub-page article

### 7. Assign template style to all menu items
- Call `joomla_get_menu_item` on any one item to see the `templateStyleOptions` list and find the correct style ID
- Call `joomla_update_menu_item` on all items in one parallel batch, setting `templateStyleId` to the target outline

### 8. Add Gantry 5 subtitles to top-level menu items (bilingual sites)

Gantry 5 supports a subtitle line rendered below each menu label in the Menu particle. Set it via the `gantry-subtitle` param on `joomla_update_menu_item`:

```
joomla_update_menu_item(id, params: { "gantry-subtitle": "Spanish translation" })
```

- Only set on **top-level** (root-level) menu items — sub-items do not typically show subtitles
- If the item title was previously bilingual (e.g. `"Sacraments | Sacramentos"`), clean the title to English-only and move the Spanish text into `gantry-subtitle` — both changes can be made in a single call
- Whether the subtitle renders depends on the active Gantry 5 outline's Menu particle settings — verify on the frontend after saving

### 9. Create the staff grid module (if page has a staff/team section)

Fetch `joomla-docs://agents/kb/staff-grid.md` for the full module config, article body format, ordering steps, and photo upload notes.

---

## Common Pitfalls

| Issue | Resolution |
|---|---|
| Article creation returns unverified but no error | Search by title with `joomla_article(action: "list", search: "...")` to confirm; article usually created but landed in wrong category — update category ID |
| Staff articles land in wrong category | Create them, confirm IDs via search, then `joomla_article(action: "update", ...)` to correct the category |
| Top-level articles appearing in particle grid | Move them to the Page Content category so the section "Items" category only contains sub-articles |
| Menu items land at wrong parent or come back unpublished | Joomla's nested set (`lft`/`rgt`) corrupts under concurrent INSERTs. The tool now serializes creates automatically and self-heals wrong parents, but if you still see this: (1) finish ALL creates before any manual fix attempts, (2) then run `joomla_menu_item(action: "update")` on each affected item to set the correct `parentId` — Joomla recomputes the tree on save. Never mix parallel creates with parent-fix updates in the same pass. |
| Alias conflict on create | Joomla aliases are globally unique across all menus. If a create fails silently or lands with a mangled alias, check if the alias is already taken by an item in another menu — use a site-specific suffix (e.g., `sponsors-htl`) to avoid the conflict. |

---

## Checklist

- [ ] Site confirmed via `get_active_site` before any edits
- [ ] Menu created with correct title and slug
- [ ] Section categories created with "Items" suffix
- [ ] Page Content category exists for landing page articles
- [ ] All articles created with correct category assignments
- [ ] Top-level articles are in Page Content, not in the section Items category
- [ ] Top-level menu items created (note IDs)
- [ ] Sub-menu items created with correct `parentId`
- [ ] Template style assigned to all menu items
- [ ] Admin review: Menus → [Menu Name] → confirm nesting and item count
- [ ] Staff grid module created and assigned to correct menu item (if applicable)
- [ ] Staff article ordering set correctly within category
- [ ] User notified if staff photos are missing
