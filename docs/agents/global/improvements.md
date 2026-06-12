# Agent Process Improvement Log

A shared queue of workflow improvements, efficiency gains, KB gaps, and tool behaviors discovered by agents during live sessions. Not site-specific — everything goes here regardless of which site triggered it.

Reviewed periodically by the team and implemented into workflow guides, KB articles, tooling, or CLAUDE.md as appropriate.

---

## How to Contribute

At the end of any session, mentally replay the steps taken. If any of the following apply, append an entry below:

- A task required more attempts or steps than it should have
- A workaround was needed because a tool, KB article, or workflow step was missing
- A KB article was incomplete, wrong, or didn't cover the actual case encountered
- A better approach was discovered mid-task that would save time next time
- A tool behaved unexpectedly — in a useful or problematic way
- A pattern repeated across multiple sites that warrants documentation
- A step in a workflow guide turned out to be in the wrong order or missing a prerequisite
- Something caused the agent to go down a wrong path before course-correcting

Keep entries concise. This is a review queue, not a journal. One tight paragraph per entry is enough.

**Only add an entry if something genuinely useful was found.** Not every session needs one — this is not a mandatory per-session log like the site changelog.

---

## Entry Format

```
### YYYY-MM-DD — [Category] | [Short title]
**Context:** [What task triggered this — ticket #, site, type of work]
**Observation:** [What was found or what went wrong]
**Suggested fix:** [New KB article / workflow step change / tool request / wording tweak]
**Status:** pending
```

**Categories:**

| Category | Use when |
|----------|---------|
| `KB Gap` | A KB article was missing, incomplete, or didn't cover the real case |
| `Workflow` | A step in a workflow guide was wrong, missing, or in the wrong order |
| `Efficiency` | A better sequence of steps was found that saves time |
| `Tool Behavior` | A tool behaved unexpectedly — either a limitation or a useful undocumented behavior |
| `Bug/Quirk` | A Joomla or Gantry behavior that trips agents up and should be warned about |
| `Tooling Request` | A missing tool that would meaningfully reduce steps or risk |

---

## ⏳ Pending Review

### 2026-06-05 — Bug/Quirk | Primary site outline Page Settings inheritance broken by prior session
**Context:** agent7.forge.solutiosoftware.com, #Home/#Outline/#Grid/#Sponsors primary outlines
**Observation:** A prior agent applied subsite-pattern Page Settings (all section override checkboxes checked, all values copied locally) to all four primary site outlines. Body Classes were also incorrectly set to `gantry site-home withmaxwidth` on all outlines. The Gantry HTTP form API cannot uncheck section-level override boxes because the toggle checkboxes have no `name` attribute and Vue's state isn't updated by DOM events — a raw minimal POST is required.
**Suggested fix:** Done: Body Classes/Id corrected on all four outlines via `gantry_page_edit`. New tool `gantry_primary_page_settings_restore` and `savePageMinimal` added to `apps/gantry-mcp/mcp-server.js` and `lib/page.js`. Docs updated: primary/subsite inheritance distinction added to `outline-conventions.js` and `editing-rules.md`. **Remaining:** restart gantry-mcp server, then call `gantry_primary_page_settings_restore` on outlines 32 (no localFields), 33 (`page[body][attribs][class]` = `gantry site-home withmaxwidth`), 34 (`page[body][attribs][id]` = `site-grid`), 35 (no localFields) to fully clear the section override checkboxes.
**Status:** partially implemented — body values corrected; `gantry_primary_page_settings_restore` tool is in the server code but requires orchestrator restart (or new session) to appear in the tool list. In a fresh session, run the tool on outlines 32, 33, 34, 35 as described above to complete the fix.

---

## ✅ Implemented

### 2026-06-05 — Tooling Request | FTP-to-Gantry CSS smoke test should be one workflow
**Fixed:** `docs/agents/ftp-css-smoke-test.md` (new workflow doc); outline-detect warning added to `gantry-visual-qa.md`; `gantry_css_asset_smoke_test` tool + aliases (`gantry_add_css_asset`, `gantry_link_css_file`, `gantry_page_assets_edit`) added to `apps/gantry-mcp/mcp-server.js`; stale-write guard added to `write_site_notes` in `apps/joomla-orchestrator/orchestrator.js`.

### 2026-06-05 — Bug 1 | `gantry_layout_add` crashes on empty sections
**Fixed:** `apps/gantry-mcp/lib/layout-api.js` — `addParticleToSection()`

Empty sections export with no `children` key at all, causing `.push()` to throw `Cannot read properties of undefined`. Fixed by adding `if (!Array.isArray(target.node.children)) target.node.children = [];` before both `newGrid` and `firstGrid` push paths. Also simplified `firstGrid` to use `target.node.children.find()` directly since children is now guaranteed to be an array.

---

### 2026-06-05 — Bug 2 | `gantry_layout_edit` returns "not found" for inherited particle IDs
**Resolved (by design — behavior clarified, not changed):** `apps/gantry-mcp/lib/layout-api.js` — `editParticleFromForm()`

Inherited particles have runtime-generated IDs not saved in the outline's YAML — they cannot be edited on this outline by design. Added an explanatory code comment to `editParticleFromForm` listing both failure reasons (inherited particle / stale ID) so future developers don't try to "fix" correct behavior. Mitigation documented in `gantry-particle-map.md`: always verify IDs via `gantry_layout_list(editable: true)` before calling edit, and edit inherited particles on their source outline.

---

### 2026-06-05 — Bug 3 | Backup directory resolves to system32 on Windows
**Already fixed in source — needs redeployment:** `apps/gantry-mcp/lib/backup.js` — `backupRoot()`

The current source already uses `path.resolve(__dirname, '..', raw)` to anchor the backup path to the gantry-mcp app directory regardless of `process.cwd()`. The EPERM error on agent7 was from a prior build that used `path.resolve(raw)` (CWD-relative). Restarting the gantry-mcp server on agent7 with the current code will resolve this.
