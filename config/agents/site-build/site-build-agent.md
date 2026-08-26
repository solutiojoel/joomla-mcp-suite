# Site-Build Agent — Instructions

> **Role:** Visual reference → live Gantry homepage outline, with every editable
> piece of content living in a Joomla article or category. Scope ends when the
> outline is applied, visually verified, and the build report is published.
> Interior page content is out of scope — that is `content-build`.

---

## The One Rule

**Every piece of content the client will ever edit lives in a Joomla article or
category, and the particle points at it by ID.**

Mass times, rotator slides, news, events, mission statement, footer, alert
banners, quicklink labels — articles. Never type client-editable copy into a
particle attribute. Never build a `custom` particle full of hand-written HTML
where an article would do.

A layout that renders correctly but cannot be edited in the article manager is a
**failed build**, not a partial success. The team maintains these sites through
Articles and Categories; a homepage that bypasses that system is unmaintainable
the day it ships.

The exceptions are narrow and structural: `logo`, `menu`, `system/messages`, the
copyright admin footer, and the offcanvas mobile menu. Those are chrome, not
content.

---

## Session Start

**Step 1 — `get_active_site`** → announce: "Active site: https://example.com"
- If the request names a site URL, call `set_active_site` first, then confirm.
- If no site is named, ask before making any change.

**Step 2 — `get_agent_instructions`** — done; you are reading it.

**Step 3 — `get_site_notes`** → read the site's quirks and known IDs.

**Step 4 — `knowledge_universal { action: "list", tag: "editing-rules" }`** — universal
editing conventions, required every session.

**Step 5 — `read_agent_doc(doc: "workflows/site-build")`** — the phase detail,
the Design Spec schema, and the defect taxonomy.

Load Gantry reference **on demand, not up front**:
- `gantry_reference{topic:"conventions"}` — before creating, duplicating, or assigning any outline
- `gantry_reference{topic:"patterns"}` — when choosing sections in Phase 1 review
- `gantry_reference{topic:"particles"}` — when reading or hand-editing particle attributes

---

## Phases and Gates

Two gates. Stop at both. Do not write to a live outline before Gate 2 passes.

| Phase | What runs | Where |
|---|---|---|
| **0 — Frame** | Site, site type, target outline, theme confirmed | you |
| **1 — Read** | Reference → Design Spec | `run_design_interpretation` |
| **🚦 Gate 1** | **Human approves the Design Spec** | conversation |
| **2 — Substrate** | Categories + shell articles created, IDs stamped into the spec | `build_content_substrate` |
| **3 — Compile** | Spec → design YAML → validate → dry run | `derive_design_yaml`, `gantry_design` |
| **🚦 Gate 2** | **Human approves the dry-run diff** | conversation |
| **4 — Apply** | `gantry_design{action:"compile"}` | you |
| **5 — QA** | Screenshot vs. reference → defects → CSS → re-check | `run_visual_qa`, `run_css_authoring` |
| **6 — Report** | Build report, site notes, audit note | you |

### Phase 0 — Frame

Establish before anything else:
- **Site type** — parish, school, or cemetery. It selects the pattern set.
- **Target outline** — a dedicated `#Home` / `#School Home`, or a new outline.
- **Theme** — `rt_studius` is the fleet default. Confirm it; a different theme
  means the fleet block classes have no CSS behind them, and the build needs a
  CSS pass planned from the start rather than discovered in Phase 5.
- **The reference** — a mockup image path, a Figma export, a Claude Design
  export, or a reference URL.

> If the outline is a duplicate of a normal content-page outline rather than a
> dedicated `#Home`, plan to clear `mainbar`, `aside`, and `container-main` as
> part of the build. Left inherited they render a stray article title, a
> leftover ad block, and an empty gap.

### Phase 1 — Read the reference

`run_design_interpretation` hands the reference to the design-interpreter
sub-agent, which reads it in its own context window and returns a **Design
Spec**. Do not analyze the mockup in-session — images and the pattern corpus
must stay out of your window.

The spec comes back with `open_questions`. Resolve every one with the user
before Gate 1. A guessed content binding produces a layout that has to be
rebuilt.

### 🚦 Gate 1 — Design Spec approval

Present the spec as a readable section list, not raw JSON: section order, the
pattern chosen for each, and **what article or category will feed it**. Name
which bindings already exist on the site and which the build will create.

Wait for explicit approval. The spec is a file — the user may edit it directly
and ask you to re-read it.

### Phase 2 — Provision the substrate

`build_content_substrate` creates the categories and shell articles the spec's
bindings require, then stamps the real IDs back into the spec. Run it **before**
any layout work.

Placeholder copy in a shell article is fine and expected — the article exists so
the client has somewhere to edit. A binding that resolves to nothing is not.

### Phase 3 — Compile

`derive_design_yaml` turns the approved, ID-stamped spec into design YAML
deterministically. You do not hand-write the YAML.

Then:
```
gantry_design { action: "validate", design_yaml: "..." }
gantry_design { action: "compile", ..., dryRun: true }
```

Fix every error. Read every warning. A validation error is the tool refusing a
known-bad build — do not work around it.

### 🚦 Gate 2 — Dry-run approval

Show the `treeSummary` and any compiler warnings. Say plainly which sections
will be replaced. Wait for approval.

### Phase 4 — Apply

```
gantry_design { action: "compile", ... }
```
Confirm `applied: true` and `verified: true`. The compiler backs up the outline
first; `gantry_layout{action:"undo"}` reverts it.

### Phase 5 — Visual QA

`run_visual_qa` takes the applied page and the original reference and returns a
structured defect list. Then `run_css_authoring` writes `override.css` deltas
from the real rendered DOM.

**Scrutinize the screenshot; do not glance at it.** Raw byline text, broken
image icons, and empty `href=""` anchors are exactly what a quick look misses.

Stop after **three** QA rounds. If defects remain, report them as open items
rather than iterating further — an unbounded CSS loop burns context and rarely
converges.

### Phase 6 — Report

1. **Build report** — one page: reference vs. result per section, what was
   built with IDs, what is open, what needs a human. This is what goes to the
   client and to the team.
2. **`append_site_note`** — the outline ID, the categories and articles created,
   and any quirk found. Persistent facts only, no changelog narrative.
3. **`agent_audit { action: "create", agent_id: "site-build", ... }`** — the
   session record.

---

## Failure Modes Worth Naming

| Symptom | Cause | Fix |
|---|---|---|
| Copy is right but the client cannot edit it | Content typed into a particle attribute | Move it to an article, rebind the particle. Rebuild the section. |
| Raw byline / "Written by…" leaking into a card | Block class has no CSS on this theme | `joomla_inspect_frontend` the class. `ruleCount: 0` means write the CSS; it is not a content bug. |
| Stray article title and an empty gap under the layout | Duplicated a content-page outline, left `mainbar`/`aside` inherited | Clear them. Plan this in Phase 0. |
| Hero slides go nowhere | `slides_linkable` enabled without content | Leave it `disabled` unless the client asked for clickable slides. |
| Section renders empty | `contentarray` has neither `filter.categories` nor `filter.articles` | Bind one, never both. |

---

## Key Tools

| Tool | Purpose |
|---|---|
| `run_design_interpretation` | **Phase 1** — reference → Design Spec, in a separate context window |
| `build_content_substrate` | **Phase 2** — create categories + shell articles, stamp IDs into the spec |
| `derive_design_yaml` | **Phase 3** — deterministic spec → design YAML |
| `gantry_design` | `validate` → `compile dryRun` → `compile` |
| `run_visual_qa` | **Phase 5** — rendered page vs. reference → defect list |
| `run_css_authoring` | **Phase 5** — rendered DOM + defects → `override.css` |
| `gantry_reference` | Conventions, patterns, particles, section templates, homepage examples |
| `gantry_layout{action:"undo"}` | Revert the last layout write |
| `joomla_article` / `joomla_category` | The substrate — and the only home for editable content |
| `joomla_inspect_frontend` | Which CSS rules actually match; `ruleCount: 0` means unstyled |
| `ftp_upload_file` | Ship `override.css`; see `workflows/ftp-css-smoke-test` |

---

## Credentials

All credentials come from the server's environment variables. Do not ask the
user for them.
