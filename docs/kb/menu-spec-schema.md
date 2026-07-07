# KB — Menu Spec Schema & Classification Rules

The **Menu Spec** is the canonical intermediate artifact for a menu build. The PDF→spec
interpretation is the only step where an LLM has discretion, so it is isolated in the
**menu-interpreter sub-agent** (invoked via the `run_menu_interpretation` tool) and
constrained hard: fixed field names, fixed enum values, preserved source ordering, and
mandatory `open_questions` / `assumptions`. Everything downstream (validate, lint,
build) is mechanical and testable.

- **Format:** JSON. Schema: [config/agents/menu-build/menu-spec.schema.json](../../../../config/agents/menu-build/menu-spec.schema.json).
- **Validator/lint:** `run_menu_interpretation` validates automatically; for hand edits run `npm run validate -w apps/agents-mcp -- <spec.json>` (exit 0 = valid). `test-menu-spec.cjs` only regression-tests the validator against fixtures — it does not read your spec.
- **Persist** each site's spec with `joomla_workspace_write` so it is the durable
  contract between the structure build (Phases 1–4) and the content pass (Phase 5).

Produce the spec deterministically: same PDF in → same JSON out. Do not editorialize,
reorder, or invent items. When the PDF is silent on something, **flag it in
`open_questions`** — never fill it with a quiet guess.

---

## Top-level shape

```jsonc
{
  "site": "https://...",          // required — active site URL
  "source": "menu.pdf",           // source document filename
  "generated": "YYYY-MM-DD",
  "menus": {                      // required — keyed by menu name
    "mainmenu": [ /* menuItem */ ],
    "hiddenmenu": [ /* menuItem */ ]
  },
  "modules": {                    // homepage quicklinks
    "toplinks": { "items": [ /* moduleItem */ ] },
    "under_rotator": { "items": [ /* moduleItem */ ] }
  },
  "grids": [ /* grid */ ],        // grid pages; each may carry a "members" array of article titles
  "open_questions": [ "..." ],    // every guess / missing fact — MANDATORY when anything is TBD
  "assumptions": [ "..." ],       // defaults applied, made reviewable
  "joomla_ids": { }               // filled during Pre-Phase-4/Phase 4 — created menu/category/item IDs (not from the interpreter)
}
```

`mainmenu` = the visible nav. `hiddenmenu` = items that need a routable URL but are not
shown in nav — the common home for redirect/external targets that a quicklink points at.

---

## `type` enum — valid values

`heading` · `single_article` · `category_grid` · `external_url` · `docman` · `category_blog` · `category_list` · `alias`

Classification rules (which type to assign and when) live in the **Phase 1 Classification Rules** section of `menu-build-workflow.md`. This doc covers output format only.

### `content_source` (Phase-5 metadata, set now, build later)
`pull` (copy from existing site) · `generate` (write new — e.g. "principal retiring") ·
`redirect` (external target) · `existing` (already on the new site) · `none`.

---

## Quicklinks (modules)

TopLinks and the "Under Rotator" quicklinks are **homepage modules, not menu trees**.
Each `moduleItem` is either:
- a raw external link → set `target`, or
- a pointer to a menu item (often on `hiddenmenu`) → set `menu_item` to that item's title.

---

## Lint invariants (enforced by the test)

A spec must pass all of these — fix or flag before building:
1. Every `type` / `content_source` / `particle` is a valid enum value (schema).
2. No unexpected fields; required fields present (schema).
3. `external_url` items have a `target`; a `TBD` target requires a matching `open_questions` entry.
4. `category_grid` names a `category`.
5. `category_grid` has **no `single_article` children** (grid members self-route).
6. `heading` items have children.
7. No duplicate titles among siblings at the same level.
8. Module quicklinks have a `target` or a `menu_item`.

---

## Worked example (Sacred Heart, Emporia — abridged)

```json
{
  "site": "https://<sacred-heart-emporia>",
  "source": "SH-Emporia School Menu & Content.pdf",
  "generated": "2026-06-15",
  "menus": {
    "mainmenu": [
      { "title": "About Sacred Heart School", "type": "heading", "children": [
        { "title": "Welcome from the Principal", "type": "single_article", "category": "Page Content", "content_source": "generate", "notes": "principal retiring" },
        { "title": "Faculty & Staff", "type": "category_grid", "category": "Staff", "content_source": "pull", "notes": "no teacher pages — staff pages are always grids" }
      ]},
      { "title": "News & Events", "type": "heading", "children": [
        { "title": "Calendar", "type": "single_article", "content_source": "pull" },
        { "title": "Parish News", "type": "external_url", "target": "TBD", "content_source": "redirect" }
      ]}
    ],
    "hiddenmenu": [
      { "title": "Church", "type": "external_url", "target": "TBD", "content_source": "redirect" }
    ]
  },
  "modules": {
    "toplinks": { "items": [
      { "label": "Contact Us", "type": "external_url", "target": "TBD" },
      { "label": "Apply", "type": "external_url", "target": "TBD" }
    ]},
    "under_rotator": { "items": [
      { "label": "Schedule a Tour", "type": "external_url", "target": "https://www.shsemporia.org/request-information", "notes": "make into google form" },
      { "label": "Church", "type": "external_url", "menu_item": "Church" }
    ]}
  },
  "grids": [
    { "page": "Faculty & Staff", "menu_ref": "Faculty & Staff", "type": "category_grid", "category": "Staff", "particle": "joomla_articles", "member_menu_items": "none" },
    { "page": "All News", "menu_ref": "News & Events", "type": "category_grid", "category": "News", "particle": "joomla_articles", "member_menu_items": "none" }
  ],
  "open_questions": [
    "Parish News redirect target URL?",
    "Capital Campaign — which church URL?",
    "TopLinks targets for Contact Us / Giving / Apply?"
  ],
  "assumptions": [
    "\"Pull from website\" leaves default to single_article in the Page Content category",
    "Faculty & Staff classified as category_grid — staff pages are always grids, never single_article",
    "All News is a category_grid with no per-article menu items"
  ]
}
```

Related: [kb/grid-layout](grid-layout.md), [kb/staff-grid](staff-grid.md), [menu-build-workflow](../menu-build-workflow.md).
