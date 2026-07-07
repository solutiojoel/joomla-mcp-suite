# Menu Build — PDF → Joomla Skeleton

**Scope:** Phases 1–4 only — Menu Spec interpretation, validation, user review, and Joomla skeleton build (categories, placeholder articles, menu items). Building content is out of scope; hand off to the content agent when the skeleton is approved.

The contract between phases is the **Menu Spec** — see `kb/menu-spec-schema` for the schema, lint invariants, and a worked example.

**Phase 1 is delegated.** Interpretation runs in the **menu-interpreter sub-agent** via the `run_menu_interpretation` tool — a separate context window that reads the PDF, classifies it, and returns a validated spec. Do **not** interpret the PDF yourself in-session; your job is to hand off the document, then review the returned spec, resolve its open questions with the user, and build. (Manual interpretation per the Classification Reference below is the fallback only if the interpreter is unavailable.)

**Structure first, content second.** Phases 1–4 produce the menu skeleton. The spec carries `content_source` annotations so the content agent can drive Phase 5 without re-interpretation.

---

## PDF menu build interpretation guide

Use your best judgment; add questions to `open_questions` when anything is unclear. Category names and menu item names vary from site to site.

Most pages are single article menu items. The articles for each menu item get placed in a category named Page Content or something similar. Sub-sites have similarly named categories — create them if they don't exist (e.g. "School Page Content", "Church Page Content").

**Grid pages** use Joomla Articles particle modules. Articles that appear on grid pages belong in their own named categories, following the pattern **"{Section} Items"** — e.g. "Sacraments Items", "Council Items", "Staff Items". Never use the word "Grid" in a category name. Grid pages are used when items will be changed frequently or added to by the client. Staff pages and All News pages are almost always grids.

**Grid sub-items:** If the PDF labels a parent item as a grid, any items listed beneath it are **articles that belong in the grid's category — not sub-menu items**. Do not create menu items for them. Capture their titles in the grid's `members` array and set `member_menu_items: "none"` — Phase 4 creates them as articles in the grid's category.

Top-level parent items with real sub-pages beneath them are separators (`heading` type in the spec). They may also be external URLs or aliases.

Pages such as sacraments, ministries, clubs, staff, faculty, and councils — or any section whose items will need to be changed or added to by the client — are typically grid pages.

Bulletin pages are single article menu items. Some bulletin pages will have widgets or DOCman modules added in Phase 5.

**Terminology — separator / heading / Separator:**
The team uses the word "separator" for non-navigable parent items. In the spec these are `heading` type. In Joomla's admin UI the type displays as "Separator" (the "Text Separator" system link). When building in Phase 4, pass `itemType: "heading"` — the tool converts it to the correct Joomla type automatically. Do not pass "Menu Heading"; that is a different Joomla type with different rendering behavior.

Categories control what appears in Gantry 5 Joomla Articles particles:

- **Page Content** — articles that are not grid members (standalone pages, section landing pages that aren't grids)
- **Named section category** (e.g. `Ministries Items`, `Sponsors Items`) — articles that appear as tiles in a grid; the category name matches the grid's `category` field in the spec's `grids` array. Always suffix `" Items"` — never the word "Grid" — in the category name.

Articles must not be in the wrong category or they will appear (or fail to appear) in the wrong grid. When in doubt, check the spec's `grids` array: if a menu section has a `grids` entry, its child articles belong in that grid's named category, not `Page Content`.

---

## Phase 1 — Interpret (PDF → Menu Spec, via `run_menu_interpretation`)

1. **Get the PDF onto this host.** Menu docs arrive as ticket/Dropbox/email attachments — download the file and note its absolute path. Do not paste the PDF contents into your own context; the whole point of the sub-agent is that the document is interpreted in a separate context window.
2. **Call the interpreter:**

   ```
   run_menu_interpretation {
     site_url: "https://example.com",
     pdf_path: "C:\\path\\to\\Client-Menu.pdf",     ← preferred
     source_filename: "Client-Menu.pdf"              ← optional
   }
   ```

   Pass `menu_text` instead of `pdf_path` only when the document is already plain text. The sub-agent (Claude Agent SDK, operator subscription auth) reads the PDF, classifies every item per its system prompt, self-checks the lint invariants, and persists the spec to the site workspace via `joomla_workspace_write`.
3. **Read the result.** Success returns `{ success: true, spec, run_log }` — the spec is already schema- and lint-validated. Failure returns `{ success: false, error, schema_errors?, lint_errors?, partial_spec?, run_log }`.
   - On lint/schema failures: inspect `partial_spec` and the errors; usually a re-run fixes it. If it fails twice, fix the spec by hand (small errors) or fall back to manual interpretation using the Classification Reference below.
   - The run is long (a few minutes) — the tool emits progress notifications while it works.
4. **Observability.** Every run writes a JSONL transcript to `apps/agents-mcp/logs/<runId>.jsonl` (path returned as `run_log`). To watch a run live or debug the interpreter outside the orchestrator, use the standalone runner:

   ```
   npm run interpret -w apps/agents-mcp -- --site https://example.com --pdf "C:\path\to\Menu.pdf"
   ```

   It streams the sub-agent's text and tool calls to the terminal, writes the spec locally, and prints open questions/assumptions. Use this while tuning the interpreter.

**Gate:** interpreter returned `success: true` and the spec is saved in the workspace.

---

## Phase 2 — Validate & Lint

The interpreter output is already validated (schema + the 8 lint invariants — see `kb/menu-spec-schema`). Re-validate **after any hand edit** to the spec by running the same validator against the edited file:

```
npm run validate -w apps/agents-mcp -- path/to/site-menu-spec.json
```

Exit 0 = valid; it prints every schema and lint error plus the remaining `open_questions`. (`node apps/orchestrator/test-menu-spec.cjs` is different — it regression-tests the validator itself against fixtures and never reads your spec.)

**Gate:** zero schema errors; every lint error either fixed or represented by an `open_questions` entry.

---

## Phase 3 — Resolve Open Questions & Review

The spec arrives with `open_questions` (facts the document didn't provide — redirect targets, ambiguous classifications) and `assumptions` (defaults the interpreter applied). This phase turns the draft into the approved build plan:

1. Present `open_questions` and `assumptions` to the user as a numbered list.
2. Apply the user's answers directly to the spec JSON — fill `TBD` targets, reclassify items, adjust categories. The JSON is the artifact; edit it, don't paraphrase it in prose.
3. Remove each resolved entry from `open_questions`; keep `assumptions` the user confirmed.
4. Re-run Phase 2 validation after edits. Loop until the user approves.

**Gate:** explicit user approval; `open_questions` resolved or accepted as deferred.

---

## Classification Reference (fallback / review aid)

> The **canonical copy of these rules lives in the interpreter's system prompt** (`config/agents/menu-interpreter/menu-interpreter-system.md`) — if you change classification behavior, change it there and mirror it here. Use this section to sanity-check a returned spec or to interpret manually when the sub-agent is unavailable.

Decide each node's `type` using these rules, in priority order:

| Signal in the source doc | `type` | Notes |
|---|---|---|
| Parent item with real sub-pages, labeled "separator", not itself a grid landing page | `heading` | "Separator" in team vocab → `heading` in spec → "Menu Heading" in Joomla. No content of its own. |
| Parent item **labeled "grid"** with sub-items that are articles, not sub-pages | `category_grid` | Sub-items go into the grid's named category — **not menu items**. See `grids` construction below. |
| **Staff / team / faculty page** — any page listing people | `category_grid` | **Always a grid.** Read `kb/staff-grid` and `kb/staff-pages` before classifying; flag open questions about layout variant |
| **News page** — "All News", any page listing news articles as cards | `category_grid` | **Always a grid.** Default category name `News Items` unless the site uses another |
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
| `category` | Derive from the section name + `" Items"` — e.g. "Ministries" → `"Ministries Items"`, "All News" → `"News Items"`, "Sacraments" → `"Sacraments Items"`. **Never use the word "Grid"** in a category name. This is the Joomla category the particle filters on. |
| `particle` | Always `joomla_articles` — all grids use the Joomla Articles particle |
| `member_menu_items` | See rule below |
| `members` | Article titles listed under the grid in the source doc (optional) — built as articles in the grid's category in Phase 4, never as menu items |

**`member_menu_items` rule:**

- PDF labels the parent as a grid and lists items beneath it → `"none"`. Those listed items are articles for the category, not sub-menu items.
- Staff, news, events, or any tile grid where items have no independent nav presence → `"none"` (the default).
- A grid member explicitly needs its own Joomla menu item (rare) → `"listed"`. Flag this in `open_questions` when you use it.

**Edge case — parent that is both a grid landing page and has real sub-pages in the menu:** Use `heading` type with a `grids` entry (set `menu_ref` to the heading title). Phase 4 will build it as a navigable Single Article rather than a plain separator, and its children will still nest under it as sub-items. Flag this in `assumptions`.

---

## Pre-Phase 4 Confirmation (required — do not skip)

Before writing a single menu item, present the following to the user and wait for explicit go-ahead:

1. **Menu targets** — call `joomla_menu list` to see what exists, then **create fresh menus for this build — never use or alter any existing menus on the site.** Propose client-derived names (e.g. `School Menu` / `School Hidden Menu` for a school site, `Church Menu` / `Church Hidden Menu` for a church site) and create them before building any items. Map spec keys (`mainmenu`, `hiddenmenu`) to the new menus' `menuType` slugs and record the IDs in the spec's `joomla_ids` block.
2. **Category targets** — list every distinct category in the spec and whether it already exists in Joomla. Flag any that need to be created.
3. **Alias collision check** — Joomla aliases are **globally unique across all menus**, including trashed items. Call `joomla_menu_item(action: "list")` on all existing menus (not just the new ones) and scan for titles matching spec items. Any match means the default alias is already taken — those creates will need an explicit `alias` param with a site-specific suffix (e.g. `news-events-she`). Derive the suffix from the site URL or a short site code.
4. **Summary item count** — e.g. "30 menu items, 28 placeholder articles, 1 grid."

Ask: *"Confirm targets above and approve Phase 4 build?"* Do not proceed until the user says yes (or gives corrections).

---

## Phase 4 — Build the Menu Skeleton

Build from the approved spec — mechanical, minimal interpretation:

- `heading` → menu item, `itemType: "heading"` — the tool converts this to Joomla's Separator type automatically. **Exception:** if a `grids` entry names this item as its `menu_ref`, build it as a navigable Single Article instead — the grid landing page article is what the heading links to. Children still nest under it as sub-items.
- `single_article` → **Single Article** menu item; ensure the article exists in its category. Empty placeholder article is fine — content is Phase 5.
- `category_grid` → Single Article menu item for the page title **plus** a Joomla Articles particle module per `kb/grid-layout`. **Do not** create menu items for grid members unless `member_menu_items: "listed"`.
- `external_url` → **External URL** menu item.
- `docman` → DOCman category/page per the DOCman convention.

**Grid article categories:** articles that are grid members go in their grid's named category — not `Page Content`. Check the spec's `grids` array and each item's `category` field.

**Quicklinks (`modules.toplinks`, `modules.under_rotator`) are NOT built in Phase 4.** These entries describe homepage module content, not menu structure. Phase 4's only job regarding a quicklink is to make sure its `menu_item` target exists — i.e. build the `hiddenmenu` item it points to. Do **not** create or update a `TopLinks` (or any other) Joomla module, and do not touch `joomla_module` for this spec block. The quicklink modules themselves are built later, in the Gantry design/homepage build (see `workflows/gantry-design-agent`), once real targets exist.

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

**Quicklink modules are a separate, later step** — not this agent's and not the content agent's. Once `hiddenmenu` targets are real, the `modules.toplinks` / `modules.under_rotator` entries get built as homepage modules during the Gantry design/build workflow (`workflows/gantry-design-agent`), not during Phase 4 or Phase 5.

---

## Logging

Call `append_site_note` after Phase 4 completes, recording the spec filename and any deferred `open_questions`.

---

## Checklist

- [ ] Site confirmed via `get_active_site` before any edits
- [ ] PDF saved locally and interpreted via `run_menu_interpretation` (not in-session)
- [ ] `open_questions` resolved with the user; spec updated and re-validated
- [ ] Menu Spec validated (zero schema + lint errors) before Phase 4
- [ ] Pre-Phase 4 confirmation presented and approved (menus, categories, item count)
- [ ] Categories created with correct names and parent assignments
- [ ] All placeholder articles created and assigned to correct categories
- [ ] Grid member articles in named section category, not Page Content
- [ ] Top-level menu items created (note IDs for parentId assignment)
- [ ] Sub-menu items created with correct `parentId`
- [ ] Heading items with a `grids` entry built as navigable Single Article (not plain heading)
- [ ] Template style / Gantry outline assigned to all menu items
- [ ] Quicklinks NOT built as modules — only their `hiddenmenu` targets created
- [ ] `append_site_note` called after Phase 4 completes
- [ ] Phase 5 handed off to content agent

---

## Why this is consistent & testable

- Interpretation is isolated in one specialized sub-agent with a hard-constrained system prompt; the schema removes interpretation degrees of freedom and the worked example anchors output.
- `open_questions` / `assumptions` surface guesses instead of letting them vary silently.
- All determinism lives in validate/lint/build — the interpreter self-validates, `run_menu_interpretation` re-validates, `npm run validate -w apps/agents-mcp` re-checks hand-edited specs, and `test-menu-spec.cjs` is the regression net for the validator itself.
- Every run leaves a JSONL transcript (`apps/agents-mcp/logs/`), and the standalone runner (`npm run interpret`) reproduces any run outside the orchestrator.
- Bit-for-bit LLM reproducibility is not guaranteed; these levers are what make the output consistent enough to trust.
