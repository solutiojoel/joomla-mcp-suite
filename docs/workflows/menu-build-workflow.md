# Menu Build — PDF → Joomla Skeleton

**Scope:** Phases 1–4 only — Menu Spec interpretation, validation, user review, and Joomla skeleton build (categories, placeholder articles, menu items). Building content is out of scope; hand off to the content agent when the skeleton is approved.

The contract between phases is the **Menu Spec** — see `kb/menu-spec-schema` for the schema, lint invariants, and a worked example.

**Phase 1 is delegated.** Interpretation runs in the **menu-interpreter sub-agent** via the `run_menu_interpretation` tool — a separate context window that reads the PDF, classifies it, and returns a validated spec. Do **not** interpret the PDF yourself in-session; your job is to hand off the document, then review the returned spec, resolve its open questions with the user, and build. (Manual interpretation per the Classification Reference below is the fallback only if the interpreter is unavailable.)

**Phase 4 is also delegated.** Once the spec is approved and the Pre-Phase-4 confirmation is done, the actual build runs in the **menu-builder sub-agent** via the `run_menu_build` tool — a separate context window (Haiku) that mechanically creates categories, articles, and menu items from the spec. By Phase 4 every interpretation decision is already made, so this is pure execution, not judgment.

**Structure first, content second.** Phases 1–4 produce the menu skeleton. The spec carries `content_source` annotations, and **Phase 3.5** turns the approved spec into a **Content Schematic** — the content agent's Phase 5 input contract. The schematic's structure is *derived deterministically from the spec* (never authored), so it always lines up 1:1 with the finished skeleton; the content-interpreter sub-agent (`run_content_interpretation`) then fills it with the per-page content details from the same client PDF. See `kb/content-schematic-schema`.

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

1. **Menu targets** — call `joomla_menu list` to see what exists, then **create fresh menus for this build — never use or alter any existing menus on the site.** Propose client-derived names (e.g. `School Menu` / `School Hidden Menu` for a school site, `Church Menu` / `Church Hidden Menu` for a church site) and create them before building any items. Map spec keys (`mainmenu`, `hiddenmenu`) to the new menus' `menuType` slugs in **`joomla_ids.menu_map`** (e.g. `{ "mainmenu": "school-menu", "hiddenmenu": "school-hidden-menu" }`) and persist the spec with `joomla_workspace_write`. **This mapping is required** — `run_menu_build` (Phase 4) refuses to run without it and never creates menus itself.
2. **Category targets** — list every distinct category in the spec and whether it already exists in Joomla. Flag any that need to be created.
3. **Alias collision check** — Joomla aliases are **globally unique across all menus**, including trashed items. Call `joomla_menu_item(action: "list")` on all existing menus (not just the new ones) and scan for titles matching spec items. Any match means the default alias is already taken — those creates will need an explicit `alias` param with a site-specific suffix (e.g. `news-events-she`). Derive the suffix from the site URL or a short site code.
4. **Summary item count** — e.g. "30 menu items, 28 placeholder articles, 1 grid."

Ask: *"Confirm targets above and approve Phase 4 build?"* Do not proceed until the user says yes (or gives corrections).

---

## Phase 3.5 — Content Schematic (derive + interpret; parallel with Phase 4)

The spec's structure is now frozen — Phase 4 only fills `joomla_ids` and never adds or removes nodes. That makes this the moment to produce the **Content Schematic** (see `kb/content-schematic-schema` for the schema, node keys, status lifecycle, and lint invariants).

1. **Derive the scaffold** (deterministic, instant):

   ```
   derive_content_schematic { site_url, spec: { ...approved spec... } }
   ```

   One entry per content-bearing node (single articles, grid landings, grid members, category landings, docman). Persists `{site-slug}-content-schematic.json` to the workspace and returns the add/update/orphan diff plus validation.

2. **Fill it from the PDF** — launch the content-interpreter sub-agent with the **same PDF from Phase 1**; it can run in parallel with `run_menu_build` since both consume the frozen spec:

   ```
   run_content_interpretation {
     site_url,
     pdf_path: "C:\\path\\to\\Client-Menu.pdf",   ← the Phase 1 document
     spec: { ...approved spec... }
   }
   ```

   The sub-agent re-reads the PDF in its own context window and fills each entry's `instructions`, `source_url`, `copy`, `assets`, and `features`. It **cannot change structure** — the scaffold is derived internally from the spec you pass, and the harness hard-fails the run on any node-key mismatch. The result is schema/lint/cross-lint validated before being returned. Standalone runner for tuning/debugging: `npm run interpret-content -w apps/agents-mcp`.

3. **Review** the schematic's `open_questions` with the user alongside (or after) the Phase 4 result — missing pull URLs and `needs_input` entries are content facts the client must supply. They do **not** block Phase 4.

**The sync rule (standing, not optional):** any time the menu spec is edited after a schematic exists — reclassification, added/removed pages, resolved TBDs — re-run `derive_content_schematic` with the updated spec and the existing schematic. The merge preserves everything the interpreter/human filled in, adds new nodes as `todo`, and marks removed nodes `orphaned`. A title rename shows up as orphaned + new `todo`; copy the content across by hand. Hand-edited schematics are re-checked with `npm run validate-schematic -w apps/agents-mcp -- <schematic.json> <spec.json>`.

**Gate:** `run_content_interpretation` returned `success: true`; schematic `open_questions` presented to the user (resolution can defer to Phase 5).

---

## Phase 4 — Build the Menu Skeleton (delegated to `run_menu_build`)

**Phase 4 is delegated.** Once the Pre-Phase-4 confirmation is approved and `joomla_ids.menu_map` is populated, hand the spec to the **menu-builder sub-agent** via `run_menu_build` — a separate context window (Claude Agent SDK, Haiku) that mechanically creates categories, placeholder articles, and menu items. Do **not** build these one tool call at a time in-session; by this point every interpretation decision is already made, so Phase 4 is pure execution and well suited to a cheaper, faster model.

```
run_menu_build {
  site_url: "https://example.com",
  spec: { ...the approved spec JSON... },
  spec_filename: "example-menu-spec.json",       ← optional, defaults from site hostname
  default_template_style_id: "12"                 ← optional, Gantry outline applied to items without their own
}
```

The builder applies these rules (full detail in its system prompt, `config/agents/menu-builder/menu-builder-system.md`):

- `heading` → menu item, `itemType: "heading"` — the tool converts this to Joomla's Separator type automatically. **Exception:** if a `grids` entry names this item as its `menu_ref`, it builds a navigable Single Article instead — the grid landing page article is what the heading links to. Children still nest under it as sub-items.
- `single_article` → **Single Article** menu item; ensures the article exists in its category (empty placeholder is fine — content is Phase 5).
- `category_grid` → Single Article menu item pointing to a landing article titled `"{title} (landing)"` in `Page Content` (never the grid's own category). Grid `members` are created as articles in the grid's named category — **no menu items** unless `member_menu_items: "listed"`. The builder does **not** create the grid's particle module — that stays a manual step; every grid needing one is listed in the returned `build_notes` (see `kb/grid-layout`).
- `external_url` → **External URL** menu item, or skipped (logged in `build_notes`) if `target` is still `"TBD"`.
- `docman` → skipped — out of the builder's scope; logged in `build_notes` for manual DOCman setup per the DOCman convention.

It is idempotent — it searches for an existing category/article/menu item by title before creating, so a re-run after a partial failure resumes cleanly. It never creates or alters menus (only the Pre-Phase-4 step does that) and never touches quicklink/particle modules.

**Grid article categories:** articles that are grid members go in their grid's named category — not `Page Content`. Check the spec's `grids` array and each item's `category` field.

**Quicklinks (`modules.toplinks`, `modules.under_rotator`) are NOT built in Phase 4.** These entries describe homepage module content, not menu structure. Phase 4's only job regarding a quicklink is to make sure its `menu_item` target exists — i.e. build the `hiddenmenu` item it points to (the builder does this as an ordinary menu item). Do **not** create or update a `TopLinks` (or any other) Joomla module, and do not touch `joomla_module` for this spec block. The quicklink modules themselves are built later, in the Gantry design/homepage build (see `workflows/gantry-design-agent`), once real targets exist.

**Alias collisions:** the builder retries once with a site-specific alias suffix on an unverified create, per its Handling Failures rules — mirrors the Common Pitfalls entry below. It never deletes a live or trashed item to resolve a collision; unresolved cases are logged in `build_notes`.

**Read the result:** `run_menu_build` returns `{ success: true, joomla_ids, summary, build_notes }` or `{ success: false, error, joomla_ids?, build_notes?, partial?, run_log }`. Review `build_notes` for anything skipped (TBD targets, docman items) and for grids still needing a particle module — build those manually per `kb/grid-layout` before calling Phase 4 complete. `joomla_ids` (categories/articles/menu_items) is persisted back into the spec's workspace file automatically.

**Mandatory post-Phase-4 re-derive:** once `run_menu_build` returns, call `derive_content_schematic` again with the post-build spec (now carrying `joomla_ids.articles`) and the existing schematic. This stamps each entry's `joomla_article_id` so the content agent can target articles by ID instead of title search. It is deterministic and near-free — do not skip it.

**Gate:** every spec node exists in Joomla (or is accounted for in `build_notes`); grids render once their particle modules are added; the schematic has been re-derived against the post-build spec.

---

## Common Pitfalls

The menu-builder sub-agent (`run_menu_build`) applies the alias-collision and nested-set guidance below automatically and logs anything it can't resolve to `build_notes`. This table is the reference for **manual follow-up** on those logged items, or for direct tool use outside the builder (Phase 5 content work, one-off fixes).

| Issue | Resolution |
|---|---|
| Article creation returns unverified but no error | Search by title with `joomla_article(action: "list", search: "...")` to confirm; article usually created but landed in wrong category — update category ID |
| Articles appearing in the wrong grid | Check category assignment — grid members must be in the grid's named category, not Page Content |
| Top-level articles appearing in a section particle grid | Move them to `Page Content` so the section category only contains grid member articles |
| Menu items land at wrong parent or come back unpublished | Joomla's nested set (`lft`/`rgt`) corrupts under concurrent INSERTs. The tool serializes creates automatically and self-heals wrong parents, but if you still see this: finish ALL creates before any manual fix attempts, then `joomla_menu_item(action: "update")` on each affected item to set the correct `parentId` — Joomla recomputes the tree on save. Never mix parallel creates with parent-fix updates in the same pass. |
| Menu item create returns "not verified" (empty ID, `foundInList: false`), or lands with a mangled alias | The alias is already held. Joomla aliases are **globally unique across all menus**, and **trashed** items keep their aliases reserved — so the holder may be a live item, an item in another menu, or a trashed leftover from a previous attempt. Do not retry the same alias. Search with `joomla_menu_item(action: "list", search: "<title>")` to find live conflicts; if none appear but creates still fail, assume a trashed leftover. Either way, retry with a fresh site-specific suffix (e.g. `news-events-sh`, `sponsors-htl`). Never delete live shared items. Children created while the parent was unverified land orphaned at root — after the parent is confirmed, re-parent them with `joomla_menu_item(action: "update", parentId: <newId>)`, then check their `state` and republish any that were trashed. |

---

## Phase 5 — Hand Off (out of scope for this agent)

This agent's scope ends when Phase 4 is complete, the skeleton is approved, and the Content Schematic has been re-derived against the post-build spec. The hand-off artifact set is **two workspace files**: `{site-slug}-menu-spec.json` (structure + `joomla_ids`) and `{site-slug}-content-schematic.json` (per-page content plan). Switch to the content agent to drive Phase 5 from the schematic — each entry carries the article ID, category, `content_source`, and the PDF's per-page `instructions`/`copy`/`source_url`:

- `pull` → copy from the `source_url`
- `generate` → write new copy per `instructions`
- `redirect` / `existing` / `none` → no article work (these nodes have no schematic entry or arrive `blocked`)

**Quicklink modules are a separate, later step** — not this agent's and not the content agent's. Once `hiddenmenu` targets are real, the `modules.toplinks` / `modules.under_rotator` entries get built as homepage modules during the Gantry design/build workflow (`workflows/gantry-design-agent`), not during Phase 4 or Phase 5.

---

## Logging

Call `append_site_note` after Phase 4 completes, recording the spec filename, the schematic filename, the `run_menu_build` summary, and any deferred `build_notes` / `open_questions` (from both the spec and the schematic).

---

## Checklist

- [ ] Site confirmed via `get_active_site` before any edits
- [ ] PDF saved locally and interpreted via `run_menu_interpretation` (not in-session)
- [ ] `open_questions` resolved with the user; spec updated and re-validated
- [ ] Menu Spec validated (zero schema + lint errors) before Phase 4
- [ ] Pre-Phase 4 confirmation presented and approved (menus created, `joomla_ids.menu_map` populated, categories, item count)
- [ ] Content Schematic derived (`derive_content_schematic`) after Pre-Phase-4 approval
- [ ] `run_content_interpretation` called with the same Phase-1 PDF (parallel with the build is fine); returned `success: true`
- [ ] `run_menu_build` called with the approved spec (not built one tool call at a time in-session)
- [ ] `run_menu_build` returned `success: true`; `build_notes` reviewed for skipped items (TBD targets, docman)
- [ ] Every grid in `build_notes` has its particle module built manually per `kb/grid-layout`
- [ ] Heading items with a `grids` entry built as navigable Single Article (not plain heading) — verify in the result
- [ ] Quicklinks NOT built as modules — only their `hiddenmenu` targets created
- [ ] Schematic re-derived after Phase 4 (`joomla_article_id`s stamped) — and after ANY later spec edit
- [ ] `append_site_note` called after Phase 4 completes
- [ ] Phase 5 handed off to content agent with both workspace files (menu spec + content schematic)

---

## Why this is consistent & testable

- Interpretation is isolated in one specialized sub-agent with a hard-constrained system prompt; the schema removes interpretation degrees of freedom and the worked example anchors output.
- `open_questions` / `assumptions` surface guesses instead of letting them vary silently.
- Phase 4 is isolated the same way: the menu-builder sub-agent (`run_menu_build`) has no interpretation discretion — it executes a fixed procedure (search-then-create, per-type build steps, alias-collision retry) against an already-approved spec, on Haiku since there's no classification judgment left to make.
- All determinism lives in validate/lint/build — the interpreter self-validates, `run_menu_interpretation` re-validates, `npm run validate -w apps/agents-mcp` re-checks hand-edited specs, `test-menu-spec.cjs` is the regression net for the validator itself, and the builder's idempotent search-before-create makes a partial-failure re-run safe.
- The Content Schematic follows the same split: its structure is a pure function of the spec (`derive_content_schematic` — no LLM), only the PDF content extraction is delegated to the content-interpreter sub-agent, and the harness enforces the structure lock (node-key-set equality) plus schema/lint/cross-lint on every run (`schematic.test.ts` and `test-content-schematic.cjs` are the regression nets).
- Every run leaves a JSONL transcript (`apps/agents-mcp/logs/`), and the standalone runners (`npm run interpret`, `npm run build-menu`) reproduce any run outside the orchestrator.
- Bit-for-bit LLM reproducibility is not guaranteed; these levers are what make the output consistent enough to trust.
