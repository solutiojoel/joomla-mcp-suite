# Workflow — PDF → Menu Build

The repeatable, testable process for turning a client menu document (PDF) into a built
Joomla menu. The contract between phases is the **Menu Spec** — see
[kb/menu-spec-schema](kb/menu-spec-schema.md) for the schema, classification rules, and a
worked example. Read that KB doc before doing any interpretation.

**Structure first, content second.** Phases 1–4 produce and build the menu skeleton. Phase 5
(content) is a separate pass; the spec carries `content_source` annotations so no
re-interpretation is needed when you get there.

---

## Phase 1 — Interpret (PDF → Menu Spec)

1. Read the source document and [kb/menu-spec-schema](kb/menu-spec-schema.md).
2. Produce the Menu Spec JSON, applying the classification ruleset. Preserve the
   document's ordering. Do not invent, reorder, or editorialize.
3. Push every guess into `open_questions` and every applied default into `assumptions`.
   When the PDF is silent (redirect targets, ambiguous item types, the TopLinks vs.
   hidden-menu split), **flag — do not quietly fill**.
4. Persist the spec with `joomla_workspace_write` (e.g. `menu-spec.json`).

**Gate:** spec is saved and conforms to the schema.

---

## Phase 2 — Validate & lint

Run the invariants before showing the draft:

```
node apps/orchestrator/test-menu-spec.cjs
```

(or validate the live spec against [config/menu-spec.schema.json](../../../config/menu-spec.schema.json)
and the lint rules listed in the KB doc).

**Gate:** zero schema errors; every lint error either fixed or represented by an
`open_questions` entry.

---

## Phase 3 — Review with the user

Present the spec plus its `open_questions` and `assumptions`. The user edits the JSON
directly (it is the artifact, not prose) and/or answers the open questions. Re-run Phase 2
after edits. Loop until the user approves.

**Gate:** explicit user approval; `open_questions` resolved or accepted as deferred.

---

## Pre-Phase 4 Confirmation (required — do not skip)

Before writing a single menu item, present the following to the user and wait for explicit
go-ahead:

1. **Menu targets** — list every menu in the spec (`mainmenu`, `hiddenmenu`, etc.) alongside
   the matching Joomla menu name/type found on the active site (call `joomla_menu list`).
   On forge sites, `mainmenu` is a **shared template menu** — do not use it for site builds.
   The spec's `mainmenu` maps to the site-specific menu (e.g. `shannon` for the Shannon
   build); use that slug for all creates. If any spec menu has no match, propose creating it
   and name the `menuType` slug.
2. **Category targets** — list every distinct category in the spec and whether it already
   exists in Joomla. Flag any that need to be created.
3. **Existing item check** — call `joomla_menu_item(action: "list")` on each target menu
   and scan for titles matching spec items. Flag any matches — these are pre-existing items
   (often shared template items active on other sites). **Do not delete them.** Use them as
   a signal: those creates will need an explicit `alias` param with a site-specific suffix
   (e.g. `news-events-she`). Derive the suffix from the site URL or a short site code.
4. **Summary item count** — e.g. "30 menu items, 28 placeholder articles, 1 grid."

Ask: *"Confirm targets above and approve Phase 4 build?"* Do not proceed until the user
says yes (or gives corrections).

---

## Phase 4 — Build the menu skeleton

Build from the approved spec — mechanical, no interpretation:

- `heading` → menu item, type **Menu Heading** (separator/parent). **Exception:** if a
  `grids` entry names this item as its `menu_ref`, build it as a navigable Single Article
  instead — the grid landing page article is what the heading links to. Children still nest
  under it as sub-items.
- `single_article` → **Single Article** menu item; ensure the article exists in its category.
  Empty placeholder article is fine until Phase 5.
- `category_grid` → Single Article menu item for the page title **plus** the grid particle
  module per [kb/grid-layout](kb/grid-layout.md) (or [kb/staff-grid](kb/staff-grid.md) for
  staff). **Do not** create menu items for grid members unless `member_menu_items: "listed"`.
- `external_url` → **External URL** menu item; place on `hiddenmenu` when it is only a
  quicklink target.
- `docman` → DOCman category/page per the DOCman convention.
- `modules` → homepage quicklink modules; wire `menu_item` references to the
  `hiddenmenu` items created above.

**Grid article categories:** articles that are grid members go in their grid's named category
(e.g. `News & Events`, `Parents`) — not `Page Content`. `Page Content` is for articles that
are not pulled into any grid. Check the spec's `grids` array and each item's `category` field.

Preserve parent/child nesting and ordering from the spec.

**Alias collisions:** For any item flagged in the Pre-Phase 4 existing item check (step 3),
pass an explicit `alias` with a site-specific suffix on create (e.g. `news-events-she`).
If a create returns "not verified" (empty ID), do not retry the same call — see the
alias-collision row in the [menu-agent](menu-agent.md) pitfall table for the full recovery
procedure.

**Gate:** every spec node exists in Joomla; grids render; quicklinks resolve.

---

## Phase 5 — Content (separate pass)

Drive off each node's `content_source`: `pull` → copy from the existing site; `generate`
→ write new copy; `redirect`/`existing`/`none` → no article work. Follow
[kb/content-standards](kb/content-standards.md).

---

## Logging

Per the changelog rule, call `append_site_note` after Phase 4 (skeleton built) and again
after Phase 5 (content), recording the spec filename and any deferred `open_questions`.

---

## Why this is consistent & testable

- The schema removes interpretation degrees of freedom; the worked example anchors output.
- `open_questions` / `assumptions` surface guesses instead of letting them vary silently.
- All determinism lives in validate/lint/build — `test-menu-spec.cjs` is the regression net.
- Bit-for-bit LLM reproducibility is not guaranteed; these four levers are what make the
  output consistent enough to trust.
