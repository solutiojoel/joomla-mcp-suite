# Menu Build — PDF → Joomla Skeleton

**Scope:** Phases 1–4 only — Menu Spec interpretation, validation, user review, and Joomla skeleton build (categories, placeholder articles, menu items). Building content is out of scope; hand off to the content agent when the skeleton is approved.

The contract between phases is the **Menu Spec** — see `kb/menu-spec-schema` for the schema, classification rules, and a worked example. Read that KB doc before doing any interpretation.

**Structure first, content second.** Phases 1–4 produce the menu skeleton. The spec carries `content_source` annotations so the content agent can drive Phase 5 without re-interpretation.

---

## PDF menu build interpretation guide

Use your best judgment; add questions to `open_questions` when anything is unclear. Category names and menu item names vary from site to site.

Most pages are single article menu items. The articles for each menu item get placed in a category named Page Content or something similar. Sub-sites have similarly named categories — create them if they don't exist (e.g. "School Page Content", "Church Page Content").

**Grid pages** use Joomla Articles particle modules. Articles that appear on grid pages belong in their own named categories (e.g. "Sacrament Grid Items", "Staff Grid Items"). Grid pages are used when items will be changed frequently or added to by the client. Staff pages and All News pages are almost always grids.

**Grid sub-items:** If the PDF labels a parent item as a grid, any items listed beneath it are **articles that belong in the grid's category — not sub-menu items**. Do not create menu items for them. Capture them in the `grids.members` array (or just note the category) and set `member_menu_items: "none"`.

Top-level parent items with real sub-pages beneath them are separators (`heading` type in the spec). They may also be external URLs or aliases.

Pages such as sacraments, ministries, clubs, staff, faculty, and councils — or any section whose items will need to be changed or added to by the client — are typically grid pages.

Bulletin pages are single article menu items. Some bulletin pages will have widgets or DOCman modules added in Phase 5.

**Terminology — separator / heading / Menu Heading:**
The team uses the word "separator" for non-navigable parent items. In the spec these are `heading` type. In Joomla's admin UI the type is called "Menu Heading" (under System Links → Menu Heading). When the PDF or a conversation says "separator", map it to `heading` in the spec and "Menu Heading" when building in Phase 4. Do not confuse this with Joomla's "Text Separator" type, which is a visual-only divider — that is not used here.

Categories control what appears in Gantry 5 Joomla Articles particles:

- **Page Content** — articles that are not grid members (standalone pages, section landing pages that aren't grids)
- **Named section category** (e.g. `Ministries`, `Sponsors`) — articles that appear as tiles in a grid; the category name matches the grid's `category` field in the spec's `grids` array

Articles must not be in the wrong category or they will appear (or fail to appear) in the wrong grid. When in doubt, check the spec's `grids` array: if a menu section has a `grids` entry, its child articles belong in that grid's named category, not `Page Content`.

---

## Phase 1 — Interpret (PDF → Menu Spec)

1. Read the source document and `kb/menu-spec-schema` (output format, lint rules, worked example).
2. Classify each item using the rules below. Preserve the document's ordering. Do not invent, reorder, or editorialize.
3. Push every guess into `open_questions` and every applied default into `assumptions`. When the PDF is silent (redirect targets, ambiguous item types), **flag — do not quietly fill**.
4. Persist the spec with `joomla_workspace_write` (e.g. `menu-spec.json`).

**Gate:** spec is saved and conforms to the schema.

### Classification Rules

Decide each node's `type` using these rules, in priority order:

| Signal in the source doc | `type` | Notes |
|---|---|---|
| Parent item with real sub-pages, labeled "separator", not itself a grid landing page | `heading` | "Separator" in team vocab → `heading` in spec → "Menu Heading" in Joomla. No content of its own. |
| Parent item **labeled "grid"** with sub-items that are articles, not sub-pages | `category_grid` | Sub-items go into the grid's named category — **not menu items**. See `grids` construction below. |
| **Staff / team / faculty page** — any page listing people | `category_grid` | **Always a grid.** Read `kb/staff-grid` and `kb/staff-pages` before classifying; flag open questions about layout variant |
| **News page** — "All News", any page listing news articles as cards | `category_grid` | **Always a grid.** Default category name `News` unless the site uses another |
| Any other section of cards/tiles that clients will add to or change | `category_grid` | Grid members self-route via their category — no child menu items |
| Plain leaf, "pull from website", normal page | `single_article` | **Default.** Article goes in the `Page Content` category |
| "Redirect", "link to church", any off-site destination | `external_url` | Requires `target` |
| Bulletin-style document list | `docman` | DOCman category/page |
| Category blog/list page (rare, explicit) | `category_blog` / `category_list` | Only when the doc clearly calls for a blog/list, not a grid |
| Alias to another menu item | `alias` | Only when explicitly a duplicate link |

**Defaults (list each applied default in `assumptions`):**
- Any leaf with no other signal → `single_article`, category `Page Content`
- Staff / faculty / team pages → `category_grid` — never `single_article` even if the PDF says "pull from website"
- News pages → `category_grid` — almost never `single_article`
- Grid member articles → no menu items; they self-route via their category
- Top-level parents with real sub-pages → `heading`

**When classification is ambiguous:** consult the relevant KB doc before flagging in `open_questions` — `kb/staff-pages` for staff layout variants, `kb/grid-layout` for general grids. Flag in `open_questions` only if the KB doc doesn't resolve it.

---

### `grids` Array Construction

Every `category_grid` item must have a corresponding entry in the top-level `grids` array. Build it at the same time you classify the item — do not defer.

| Field | Value |
|---|---|
| `page` | The menu item title |
| `menu_ref` | The menu item title (same as `page`) |
| `type` | Always `category_grid` |
| `category` | Derive from the section name — e.g. "Ministries" → `"Ministries"`, "All News" → `"News"`. This is the Joomla category the particle filters on. |
| `particle` | Always `joomla_articles` — all grids use the Joomla Articles particle |
| `member_menu_items` | See rule below |

**`member_menu_items` rule:**

- PDF labels the parent as a grid and lists items beneath it → `"none"`. Those listed items are articles for the category, not sub-menu items.
- Staff, news, events, or any tile grid where items have no independent nav presence → `"none"` (the default).
- A grid member explicitly needs its own Joomla menu item (rare) → `"listed"`. Flag this in `open_questions` when you use it.

**Edge case — parent that is both a grid landing page and has real sub-pages in the menu:** Use `heading` type with a `grids` entry (set `menu_ref` to the heading title). Phase 4 will build it as a navigable Single Article rather than a plain separator, and its children will still nest under it as sub-items. Flag this in `assumptions`.

---

## Phase 2 — Validate & Lint

Run the invariants before showing the draft:

```
node apps/orchestrator/test-menu-spec.cjs
```

Or validate the live spec directly against `config/agents/menu-build/menu-spec.schema.json` and the lint rules in the KB doc.

**Gate:** zero schema errors; every lint error either fixed or represented by an `open_questions` entry.

---

## Phase 3 — Review with the User

Present the spec plus its `open_questions` and `assumptions`. The user edits the JSON directly (it is the artifact, not prose) and/or answers the open questions. Re-run Phase 2 after edits. Loop until the user approves.

**Gate:** explicit user approval; `open_questions` resolved or accepted as deferred.

---

## Pre-Phase 4 Confirmation (required — do not skip)

Before writing a single menu item, present the following to the user and wait for explicit go-ahead:

1. **Menu targets** — list every menu in the spec (`mainmenu`, `hiddenmenu`, etc.) alongside the matching Joomla menu name/type found on the active site (call `joomla_menu list`). On forge sites, `mainmenu` is a **shared template menu** — do not use it for site builds. The spec's `mainmenu` maps to the site-specific menu (e.g. `shannon` for the Shannon build); use that slug for all creates. If any spec menu has no match, propose creating it and name the `menuType` slug.
2. **Category targets** — list every distinct category in the spec and whether it already exists in Joomla. Flag any that need to be created.
3. **Existing item check** — call `joomla_menu_item(action: "list")` on each target menu and scan for titles matching spec items. Flag any matches — these are pre-existing items (often shared template items active on other sites). **Do not delete them.** Use them as a signal: those creates will need an explicit `alias` param with a site-specific suffix (e.g. `news-events-she`). Derive the suffix from the site URL or a short site code.
4. **Summary item count** — e.g. "30 menu items, 28 placeholder articles, 1 grid."

Ask: *"Confirm targets above and approve Phase 4 build?"* Do not proceed until the user says yes (or gives corrections).

---

## Phase 4 — Build the Menu Skeleton

Build from the approved spec — mechanical, minimal interpretation:

- `heading` → menu item, type **Menu Heading** (separator/parent). **Exception:** if a `grids` entry names this item as its `menu_ref`, build it as a navigable Single Article instead — the grid landing page article is what the heading links to. Children still nest under it as sub-items.
- `single_article` → **Single Article** menu item; ensure the article exists in its category. Empty placeholder article is fine — content is Phase 5.
- `category_grid` → Single Article menu item for the page title **plus** a Joomla Articles particle module per `kb/grid-layout`. **Do not** create menu items for grid members unless `member_menu_items: "listed"`.
- `external_url` → **External URL** menu item.
- `docman` → DOCman category/page per the DOCman convention.

**Grid article categories:** articles that are grid members go in their grid's named category — not `Page Content`. Check the spec's `grids` array and each item's `category` field.

Preserve parent/child nesting and ordering from the spec.

**Alias collisions:** For any item flagged in the Pre-Phase 4 existing item check (step 3), pass an explicit `alias` with a site-specific suffix on create. If a create returns "not verified" (empty ID), do not retry the same call — see Common Pitfalls below.

**Gate:** every spec node exists in Joomla; grids render.

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

## Phase 5 — Hand Off (out of scope for this agent)

This agent's scope ends when Phase 4 is complete and the skeleton is approved. Switch to the content agent to drive Phase 5 using each node's `content_source` field:

- `pull` → copy from the existing site
- `generate` → write new copy
- `redirect` / `existing` / `none` → no article work

---

## Logging

Call `append_site_note` after Phase 4 completes, recording the spec filename and any deferred `open_questions`.

---

## Checklist

- [ ] Site confirmed via `get_active_site` before any edits
- [ ] `kb/menu-spec-schema` read before Phase 1
- [ ] Menu Spec validated (zero schema + lint errors) before Phase 4
- [ ] Pre-Phase 4 confirmation presented and approved (menus, categories, item count)
- [ ] Categories created with correct names and parent assignments
- [ ] All placeholder articles created and assigned to correct categories
- [ ] Grid member articles in named section category, not Page Content
- [ ] Top-level menu items created (note IDs for parentId assignment)
- [ ] Sub-menu items created with correct `parentId`
- [ ] Heading items with a `grids` entry built as navigable Single Article (not plain heading)
- [ ] Template style / Gantry outline assigned to all menu items
- [ ] `append_site_note` called after Phase 4 completes
- [ ] Phase 5 handed off to content agent

---

## Why this is consistent & testable

- The schema removes interpretation degrees of freedom; the worked example anchors output.
- `open_questions` / `assumptions` surface guesses instead of letting them vary silently.
- All determinism lives in validate/lint/build — `test-menu-spec.cjs` is the regression net.
- Bit-for-bit LLM reproducibility is not guaranteed; these four levers are what make the output consistent enough to trust.
