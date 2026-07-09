# Content-Build Workflow — Schematic → Written Pages (Phase 5)

Takes an interpreted Content Schematic from `filled`/`needs_input` to `done` on the live Joomla skeleton. Prerequisites: menu-build Phases 1–4 complete (skeleton exists, `joomla_ids` populated in the spec) and Phase 3.5 complete (schematic derived and interpreted). Schema and lifecycle reference: `kb/content-schematic-schema`.

**Architecture rule — where the tokens go:** only the write stage uses an LLM (the content-writer sub-agent, batched, fresh context per batch). URL discovery, fetching, and applying are deterministic tools. Never fetch old-site pages yourself, never write page HTML in-session, and don't pass or read the full schematic when a tool's `status_summary`/report answers the question — the schematic stays in the workspace.

---

## Phase 1 — Load & Verify

1. Read the menu spec from the workspace (`{slug}-menu-spec.json` via `joomla_workspace_read`).
2. Run `derive_content_schematic` with that spec (and the existing schematic loads/merges server-side by passing it — or pass nothing and let the tool read the workspace file). This is the **sync check**: any spec edit since interpretation reconciles now (new nodes → `todo`, removed → `orphaned`), and `joomla_article_id`s are stamped from the post-Phase-4 spec's `joomla_ids.articles`.
3. Announce the state from `status_summary`, e.g.: "51 entries — 38 filled, 9 needs_input, 2 todo, 2 blocked; 13 open questions."
4. If most entries are `todo` (never interpreted) stop and run Phase 3.5 first (`run_content_interpretation` with the client PDF).

**Gate:** most entries with `joomla_article_id` stamped. If none are stamped, Phase 4 of the menu build didn't populate `joomla_ids` — fix that first (apply falls back to title lookup, but stamped IDs are the safe path).

## Phase 2 — Resolve Open Questions (human loop)

1. Read the schematic's `open_questions` and the `needs_input` entries (this is the one time reading schematic sections into context is expected — read the file with `joomla_workspace_read` and summarize; don't quote it wholesale).
2. Group them for the user: missing source URLs, missing copy, ambiguous instructions, client-only decisions.
3. For the missing-URL group, run `discover_source_urls` with the OLD site's base URL. Present candidates with scores — **never write a proposal into the schematic without the user confirming it**.
4. Patch confirmed answers into the schematic (read file → edit content fields only → write back):
   - confirmed URL → `source_url`, status → `filled`, remove the matching `open_questions` item
   - supplied copy → `copy`, status → `filled`, remove the question
   - Never touch `node_key` or derive-owned fields (`kind`, `title`, `menu_path`, `category`, `content_source`, `spec_notes`, `joomla_article_id`).
5. Questions only the client can answer stay `needs_input` with their `open_questions` entries — the build proceeds without those pages.

## Phase 3 — Fetch

1. Run `fetch_source_content`. For every `filled` pull/existing entry with a real URL it fetches the page, extracts main content (Readability), converts to markdown (Turndown), saves `{slug}-source/{nn}-{title}.md`, stamps `source_file`, and records page image URLs in `assets`. Failures flip to `needs_input` with an open question.
2. Review the manifest with the user: fetched / failed / skipped. Failed entries loop back to Phase 2 (wrong URL? bot-blocked? content supplied another way?).
3. Optional quality check: `joomla_workspace_read` one or two of the markdown files and confirm the extraction looks sane before spending writer tokens on all of them.
4. Re-runs skip already-fetched entries; pass `refetch: true` to redo them.

## Phase 4 — Write + Apply

1. Optionally preview: `run_content_build` with `dry_run: true` shows the batch plan and any not-writable entries with reasons.
2. Run `run_content_build`. Per batch of ~8 the content-writer sub-agent reads the batch's markdown, writes final house-style HTML files (`{slug}-html/…`), and the harness validates + stamps `content_file`/`draft`/status `written`; then the deterministic apply updates each Joomla article and flips it to `done`. The safety guard **skips any article that already has real (non-placeholder) content** — those are reported, and only a deliberate `apply_content` with `node_keys` + `force` overwrites them.
3. `generate` pages are drafted from their instructions and flagged `draft: true` — collect these for the review list.
4. Report to the user after the run: written/applied counts, skipped-needs-force list, failures, drafts. Statuses persist per batch, so an interrupted run resumes exactly where it stopped — just call `run_content_build` again.
5. Apply failures stay `written`; fix the cause and re-run `apply_content` (use `dry_run` first when unsure).

## Phase 5 — Features & Close-Out

1. Collect every entry's `features[]` (the interpreter recorded kind + `kb_ref`). Work them interactively one at a time — read the named KB (`kb/calendar-feed`, `kb/quick-galleries`, `kb/popup`, `kb/elfsight`, `kb/staff-grid`, …) and build per its guide. These are NOT automated.
2. Spot-check a few live pages (`joomla_get_frontend_page_info` / `joomla_verify_frontend_content`): content present, headings/links/tables per `kb/content-standards`, no old-site debris.
3. Skim the `draft: true` pages with the user (or list them for later review).
4. `append_site_note` changelog — pages applied (with article IDs), drafts pending review, features built.
5. Hand over the punch list: remaining `needs_input`/`blocked` entries (client-facing questions), unmigrated `assets` images, and any skipped-needs-force articles.

---

## Guardrails

- **Structure is never edited here.** Menu/category changes go through the menu-build agent, then `derive_content_schematic` re-syncs. If the spec changes mid-build, re-derive before anything else.
- **The apply stage never overwrites real content without `force`** — and `force` only after the user has explicitly confirmed the specific pages.
- **Images:** the writer never embeds `<img>` tags; old-site image URLs are recorded in `assets`. Migrate the ones worth keeping via `joomla_media` (folder rules in `kb/content-standards`) and add them to articles manually.
- **Idempotency:** every stage skips what's already done (`source_file` present, status `written`/`done`). Re-running a tool is always safe.

## Checklist (end of build)

- [ ] All writable entries `done`; punch list issued for the rest
- [ ] Drafts (`draft: true`) reviewed or handed to the client
- [ ] Features from `features[]` built per their KBs
- [ ] Spot-checks passed on live pages
- [ ] `append_site_note` written
