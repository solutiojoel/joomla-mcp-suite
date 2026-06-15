# Workflow — PDF → Menu Build

The repeatable, testable process for turning a client menu document (PDF) into a built
Joomla menu. The contract between phases is the **Menu Spec** — see
[kb/menu-spec-schema](kb/menu-spec-schema.md) for the schema, classification rules, and a
worked example. Read that KB doc before doing any interpretation.

**Structure first, content second.** Phase 1–3 build the menu skeleton. Phase 5 (content)
is a separate pass; the spec carries `content_source` annotations so no re-interpretation
is needed when you get there.

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

## Phase 4 — Build the menu skeleton

Build from the approved spec — mechanical, no interpretation:

- `heading` → menu item, type **Menu Heading** (separator/parent).
- `single_article` → **Single Article** menu item; ensure the article exists in its
  category (`Page Articles` / `Page Content` by default). Empty placeholder article is fine
  until Phase 5.
- `category_grid` → Single Article menu item for the page title **plus** the grid particle
  module per [kb/grid-layout](kb/grid-layout.md) (or [kb/staff-grid](kb/staff-grid.md) for
  staff). **Do not** create menu items for grid members.
- `external_url` → **External URL** menu item; place on `hiddenmenu` when it is only a
  quicklink target.
- `docman` → DOCman category/page per the DOCman convention.
- `modules` → homepage quicklink modules; wire `menu_item` references to the
  `hiddenmenu` items created above.

Preserve parent/child nesting and ordering from the spec.

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
