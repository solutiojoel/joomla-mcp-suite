# Joomla MCP — Menu Agent Guide

**Scope:** Building menus, category structures, menu items, and module assignments for new or restructured navigation. For editing article text and SEO fields only, use `content-agent` instead. For pages requiring custom CSS/JS styling, use `custom-page-agent` instead.

**Process:** Follow the [menu-build](menu-build.md) workflow — PDF → Menu Spec → validate → review → build. This file covers category conventions, pitfalls, and the build checklist only.

---

## Category Conventions

Categories control what appears in Gantry 5 Joomla Articles particles. The rule:

- **Page Content** — articles that are not grid members (standalone pages, section landing pages that aren't grids)
- **Named section category** (e.g. `News & Events`, `Parents`, `Faculty & Staff`) — articles that appear as tiles in a grid; the category name matches the grid's `category` field in the spec's `grids` array
- Articles must not be in the wrong category or they will appear (or fail to appear) in the wrong grid

When in doubt, check the spec's `grids` array: if a menu section has a grids entry, its child articles belong in that grid's named category, not `Page Content`.

---

## Common Pitfalls

| Issue | Resolution |
|---|---|
| Article creation returns unverified but no error | Search by title with `joomla_article(action: "list", search: "...")` to confirm; article usually created but landed in wrong category — update category ID |
| Articles appearing in the wrong grid | Check category assignment — grid members must be in the grid's named category, not Page Content |
| Top-level articles appearing in a section particle grid | Move them to `Page Content` so the section category only contains grid member articles |
| Menu items land at wrong parent or come back unpublished | Joomla's nested set (`lft`/`rgt`) corrupts under concurrent INSERTs. The tool serializes creates automatically and self-heals wrong parents, but if you still see this: finish ALL creates before any manual fix attempts, then `joomla_menu_item(action: "update")` on each affected item to set the correct `parentId` — Joomla recomputes the tree on save. Never mix parallel creates with parent-fix updates in the same pass. |
| Menu item create returns "not verified" (empty ID, `foundInList: false`), or lands with a mangled alias | The alias is already held. Joomla aliases are **globally unique across all menus**, and **trashed** items keep their aliases reserved — so the holder may be a live item, an item in another menu, or a trashed leftover from a previous attempt. Do not retry the same alias. Search with `joomla_menu_item(action: "list", search: "<title>")` to find live conflicts; if none appear but creates still fail, assume a trashed leftover. Either way, retry with a fresh site-specific suffix (e.g. `news-events-sh`, `sponsors-htl`). Never delete live shared items. Children created while the parent was unverified land orphaned at root — after the parent is confirmed, re-parent them with `joomla_menu_item(action: "update", parentId: <newId>)`, then check their `state` and republish any that were trashed. |

---

## Checklist

- [ ] Site confirmed via `get_active_site` before any edits
- [ ] Menu Spec validated (zero schema + lint errors) before Phase 4
- [ ] Pre-Phase 4 confirmation presented and approved (menus, categories, item count)
- [ ] Categories created with correct names and parent assignments
- [ ] All articles created and assigned to correct categories
- [ ] Grid member articles in named section category, not Page Content
- [ ] Top-level menu items created (note IDs for parentId assignment)
- [ ] Sub-menu items created with correct `parentId`
- [ ] Heading items with a `grids` entry built as navigable Single Article (not plain heading)
- [ ] `hiddenmenu` items created for quicklink targets
- [ ] Under Rotator quicklinks wired to correct menu items
- [ ] Template style / Gantry outline assigned to all menu items
- [ ] `append_site_note` called after Phase 4 completes
