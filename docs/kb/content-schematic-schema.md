# KB — Content Schematic Schema & Lifecycle

The **Content Schematic** is the input contract for the content-build pass (Phase 5). It
lists every content-bearing page the finished menu skeleton contains, enriched with the
per-page content instructions from the client PDF that the Menu Spec deliberately
compresses to a `content_source` enum.

Its defining property: **structure is derived, never authored.** A deterministic
function walks the *approved* Menu Spec and emits exactly one entry per content-bearing
node. Because the entry set is a pure function of the spec, the schematic can never
drift from the skeleton — any spec edit is reconciled by re-running the derivation,
which preserves all filled-in content fields.

- **Format:** JSON. Schema: [config/agents/content-build/content-schematic.schema.json](../../config/agents/content-build/content-schematic.schema.json).
- **Derive/merge:** `derive_content_schematic` orchestrator tool, or `npm run derive-schematic -w apps/agents-mcp -- --spec <spec.json> [--schematic <existing.json>]`.
- **Enrich:** `run_content_interpretation` orchestrator tool (content-interpreter sub-agent reads the client PDF), or `npm run interpret-content -w apps/agents-mcp`.
- **Validate:** `npm run validate-schematic -w apps/agents-mcp -- <schematic.json> [<spec.json>]` — passing the spec as the second argument enables the cross-lint.
- **Persist** to the site workspace as `{site-slug}-content-schematic.json` via `joomla_workspace_write`.

---

## Lifecycle

1. **Derive (after Phase 3 approval / Pre-Phase-4 confirmation).** The spec's structure
   is frozen; the derivation emits the scaffold — one `todo` entry per content-bearing
   node, with all derive-owned fields filled and all content fields empty.
2. **Interpret (parallel with the Phase 4 build).** The content-interpreter sub-agent
   reads the **same client PDF** the menu build started from, in its own context
   window, and fills each entry's content fields. It may never add, remove, or rekey
   entries — the harness re-derives after the run and hard-fails on any node-key
   mismatch.
3. **Re-derive after Phase 4 (mandatory).** Deterministic and near-free. Stamps
   `joomla_article_id` from `spec.joomla_ids.articles` onto each entry.
4. **Re-derive after ANY later spec edit (standing rule).** New spec nodes appear as
   `todo` entries; removed nodes become `orphaned` (content preserved for salvage).
5. **Content build (Phase 5, future content-build agent).** Works the entries,
   flipping `status` to `done`.

## Which spec nodes get entries

| Spec node | Entry `kind` | Notes |
|---|---|---|
| `single_article` menu item | `single_article` | Category from the node (default `Page Content`). |
| `category_grid` menu item (or `heading` named by a grid's `menu_ref`) | `grid_landing` | The landing article Phase 4 creates (`"{title} (landing)"` in `Page Content`). |
| Grid `members` array entries | `grid_member` | One per member title, in the grid's named category. Key: `grid:<page>/<member>`. |
| `category_blog` / `category_list` menu item | `category_landing` | |
| `docman` menu item | `docman` | Created `blocked` — document setup is manual/human per the DOCman convention. |
| `heading` (no grid), `external_url`, `alias`, `modules` quicklinks | — | No content of their own; skipped. |

**Node keys** are `"<menu>:<title path>"` for menu nodes (path segments joined with
`/`, e.g. `mainmenu:About Us/Our Staff`) and `"grid:<page>/<member title>"` for grid
members. Keys are assigned by the derivation and are the join column for the
cross-lint — never edit them.

## Field ownership

| Owner | Fields | Merge behavior |
|---|---|---|
| **Derivation** | `node_key`, `kind`, `title`, `menu_path`, `category`, `content_source`, `spec_notes`, `joomla_article_id` | Refreshed from the spec on every re-derive. |
| **content-interpreter / human** | `instructions`, `source_url`, `copy`, `assets`, `features`, `notes` | Preserved verbatim by every re-derive. |
| **All stages** | `status` | New → `todo` (`docman` → `blocked`); existing → preserved; node removed from spec → `orphaned`. |

`status` values: `todo` (scaffold only) · `filled` (interpreter populated it) ·
`needs_input` (has an unresolved open question) · `blocked` (can't be built by the
content agent — docman, missing prerequisite) · `done` (content-build pass complete) ·
`orphaned` (spec node no longer exists; content kept for human salvage or deletion).

**Known limitation — renames:** a Phase-3 title rename looks like remove+add to the
merge: the old entry goes `orphaned` (content intact), the new one appears as `todo`.
Copy the content across by hand. Renames after content fill are rare.

## Lint invariants (enforced by the validator)

Intra-schematic (always):
1. Every `kind` / `status` / `content_source` is a valid enum value; required fields present; no unexpected fields (schema).
2. `node_key` values are unique.
3. A `filled` entry with `content_source: "pull"` must have a `source_url`.
4. `source_url: "TBD"` requires a matching `open_questions` entry (referencing the title).
5. `status: "needs_input"` requires a matching `open_questions` entry.

Cross-lint (when the Menu Spec is provided):
6. Every content-bearing spec node has exactly one non-orphaned entry with a matching `node_key`.
7. Every non-orphaned entry maps to a live content-bearing spec node (else it must be `orphaned`).
8. Derive-owned fields (`kind`, `category`, `content_source`) match what the derivation would emit.

The cross-lint reuses the derivation walk itself (`collectContentNodes`), so the two
can never disagree. Rules here mirror `apps/agents-mcp/src/schematic-validator.ts` —
if you change one, change both.

---

## Abridged example

```json
{
  "site": "https://shsemporia.org",
  "source": "SH-Emporia School Menu & Content.pdf",
  "menu_spec_file": "shsemporia-menu-spec.json",
  "generated": "2026-07-08",
  "derived_at": "2026-07-08T16:40:00Z",
  "entries": [
    {
      "node_key": "mainmenu:About Sacred Heart School/Welcome from the Principal",
      "kind": "single_article",
      "title": "Welcome from the Principal",
      "menu_path": "About Sacred Heart School / Welcome from the Principal",
      "category": "Page Content",
      "content_source": "generate",
      "joomla_article_id": "482",
      "spec_notes": "principal retiring",
      "instructions": "Write a fresh welcome letter — the current principal is retiring; do not pull the old bio.",
      "status": "filled"
    },
    {
      "node_key": "mainmenu:About Sacred Heart School/Faculty & Staff",
      "kind": "grid_landing",
      "title": "Faculty & Staff",
      "category": "Page Content",
      "content_source": "pull",
      "source_url": "https://old-site.org/faculty",
      "instructions": "Intro paragraph above the staff grid; pull from the current faculty page.",
      "features": [{ "kind": "staff-grid", "kb_ref": "kb/staff-grid" }],
      "status": "filled"
    },
    {
      "node_key": "grid:Faculty & Staff/Mrs. Jane Smith",
      "kind": "grid_member",
      "title": "Mrs. Jane Smith",
      "menu_path": "About Sacred Heart School / Faculty & Staff",
      "category": "Staff Items",
      "content_source": "pull",
      "source_url": "TBD",
      "status": "needs_input"
    }
  ],
  "open_questions": [
    "Mrs. Jane Smith — no bio on the current site; ask client for bio and photo"
  ],
  "assumptions": [
    "Grid members without their own content_source inherit the grid page's"
  ]
}
```

Related: [kb/menu-spec-schema](menu-spec-schema.md), [menu-build-workflow](../workflows/menu-build-workflow.md).
