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
**Observation:** A prior agent applied subsite-pattern Page Settings (all section override checkboxes checked, all values copied locally) to all four primary site outlines. This is wrong — primary site outlines must inherit from Base Outline with only Body Classes (#Home) and Body Id (#Grid) as local overrides. Body Classes were also set to `gantry site-home withmaxwidth` on all outlines instead of the correct values. The Gantry HTTP form API cannot uncheck section-level override boxes because they have no `name` attribute and Vue's state isn't updated by DOM events.
**Suggested fix:** New tool `gantry_primary_page_settings_restore` added to `apps/gantry-mcp/mcp-server.js` — posts a minimal form that stores only the specified `localFields` and clears all other overrides. Restart gantry-mcp server, then call this tool on outlines 32, 33, 34, 35 with correct localFields per outline. Body Classes/Id values were already corrected via `gantry_page_edit` as an interim fix.
**Status:** pending — awaiting gantry-mcp server restart to activate the new tool

### 2026-06-05 — Tooling Request | FTP-to-Gantry CSS smoke test should be one workflow
**Context:** agent7.forge.solutiosoftware.com, quick validation that a CSS file could be written via FTP and linked in Base Outline Page Settings
**Observation:** The task required too much hunting across tools: first confirm FTP config, then find the right FTP upload tool, then find the right Gantry Page Settings Assets tool, then separately discover that the live homepage was served by outline `33` with local Assets so the Base Outline change would not appear there. The current workflow proves pieces independently, but not the end-to-end question the user actually asked.
**Suggested fix:** Add either a KB/workflow note or a new tool such as `gantry_css_asset_smoke_test` that does four things in one pass: uploads a small CSS file to the allowed FTP path, links it into the chosen outline's Assets, detects which outline serves a target page, and verifies whether the stylesheet is emitted on that page. At minimum, document a short standard sequence: `ftp_site_config` -> `ftp_upload_file` -> `gantry_get_outline_for_page` -> `gantry_page_asset_files_edit` -> frontend verification.
**Status:** implemented — workflow doc at `docs/agents/ftp-css-smoke-test.md`; outline-detect warning in `gantry-visual-qa.md`; `gantry_css_asset_smoke_test` tool + aliases (`gantry_add_css_asset`, `gantry_link_css_file`, `gantry_page_assets_edit`) added to `apps/gantry-mcp/mcp-server.js`; stale-write guard added to `write_site_notes` in `apps/joomla-orchestrator/orchestrator.js`

---

## ✅ Implemented

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
