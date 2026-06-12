# Joomla MCP Suite — Claude Code Instructions

> **Sync note:** This file is kept in sync with `AGENTS.md`. If you update one, run `scripts/sync-agent-docs.ps1` to update the other, or edit both manually.

---

## Platform Overview

All tools in this project are exposed through a single orchestrator MCP endpoint. You will see them as `mcp__joomla-orchestrator__*`. There is no separate joomla-mcp or gantry-mcp connection — the orchestrator aggregates everything.

Workflow guides and KB articles are accessible via the `read_agent_doc` orchestrator tool — use it instead of the local Read tool so that agents without this repository mounted can access them.

---

## Session Start (Required)

At the start of every conversation:

**Step 1 — `get_active_site`** → announce the result: "Active site: https://example.com"
- If the user's request includes a site URL, call `set_active_site` with that URL and confirm the switch.
- If the request implies a specific site (e.g., a Freshdesk ticket), derive it and switch before proceeding.
- If no site is specified, ask which site to work on before making any changes.

**Step 2 — `get_agent_instructions`** ← call this immediately after the active site is confirmed.
This tool returns the full contents of this file (AGENTS.md) via the orchestrator. Any agent or LLM that does not have this repository mounted locally **must** call this tool to obtain the complete operating instructions before doing any work. Do not skip it.

**Step 3 — `get_site_notes`** → read the active site's history before making any changes.

After completing these three steps, call `read_agent_doc(doc: "editing-rules")` — it contains universal conventions that apply to every task.

---

## Changelog — Write Immediately After Every Change

**Do not wait until the end of the session.** Call `append_site_note` immediately after completing any change — the conversation may end before a "session close" step happens.

After every meaningful action (article updated, module created, menu item changed, CSS deployed, config updated, ticket resolved), call:

```
append_site_note(note: "### YYYY-MM-DD — [Ticket #XXXXX | ][Brief title]
**Requested by:** [Name / email / 'internal'] | **Ticket:** [#XXXXX or 'none']
**Changes:**
- [specific change with IDs]
**Notes:** [anything non-obvious, or 'No follow-up needed']")
```

If the session was investigation-only (no changes), still log what was looked at and what was found before responding to the user.

See `read_agent_doc(doc: "kb/site-history")` for the full format spec and examples.

## Session End (Also Required)

At the end of any session where persistent facts changed (new key IDs discovered, new quirk found, new integration added):

**1. Update persistent facts** — call `get_site_notes`, update the relevant section, call `write_site_notes` with the full updated content.

**2. Review for process improvements** (when applicable — not required every session) — replay the session's steps and check: did a task take more attempts than it should? Was a KB article missing or wrong? Was a better approach discovered mid-task? Did a tool behave unexpectedly? If yes, call `read_agent_doc(doc: "improvements")` and append an entry. This is a shared team queue — only log when something genuinely useful was found.

---

## Switching Sites

1. Call `set_active_site` with the new URL — this also auto-primes the Joomla session
2. Immediately call `get_active_site` to confirm the switch succeeded
3. Announce the new active site — never assume a switch succeeded
4. Call `get_site_notes` and review any known quirks before starting work

---

## Support Ticket Workflow

If the user sends a standalone 5-digit number (e.g. `35118`), treat it as a Freshdesk ticket ID.

Call this before doing anything else:

```
read_agent_doc(doc: "freshdesk-agent")
```

---

## Specialized Workflow Guides

Only read these when explicitly performing that workflow — do not load them by default.

Call `read_agent_doc(doc: "<name>")` with the name from the first column:

| Doc name | When to use |
|----------|-------------|
| `editing-rules` | Every session — universal editing conventions |
| `freshdesk-agent` | Support ticket resolution |
| `menu-agent` | Building menus, categories, and menu item structures |
| `content-agent` | Standard article text, SEO, and publish state edits |
| `custom-page-agent` | Pages with custom CSS/JS, FTP asset uploads, Raw Tags modules |
| `gantry-section-css` | Gantry rendered section HTML, max-width containers, section backgrounds, and CSS selector conventions |
| `gantry-particle-map` | Gantry particle settings, rendered HTML anchors, and particle selection/CSS targeting map |
| `gantry-visual-qa` | Visual QA loop after any layout or CSS work — screenshots, checklist, CSS iteration |
| `ftp-css-smoke-test` | End-to-end validation that FTP upload → Gantry Page Settings → live page emission works; use before custom page builds or after server migrations |
| `gantry-design-agent` | Solutio Gantry design workflow — step-by-step process for building or rebuilding a homepage layout |
| `improvements` | Shared team queue for process improvement notes |

Knowledge base articles for specific issue types — call `read_agent_doc(doc: "kb/<name>")`. When investigating a support ticket, check the KB index below and read any files that match the issue type before starting your investigation.

**KB file index:**

| Doc name | Topic |
|----------|-------|
| `kb/staff-grid` | Staff/team grid using contentarray particle |
| `kb/staff-pages` | All staff page layouts (grid, teacherbox, table, contact form) |
| `kb/teacher-pages` | Teacher/classroom pages with sidebar nav and user groups |
| `kb/grid-layout` | Grid layout pages using Joomla Articles particle module |
| `kb/content-standards` | Formatting rules, images, links, tables — applies to all content work |
| `kb/css-table-classes` | CSS table classes, button classes, site fonts/colors |
| `kb/site-config` | Site title, meta, timezone, reCAPTCHA, GA4, Webmaster Verification |
| `kb/business-directory` | Business Directory & Sponsorship passcode setup |
| `kb/user-accounts` | User account creation, groups, and category permissions |
| `kb/quick-galleries` | QuickGallery setup and broken gallery link fix |
| `kb/ministry-platform-widget` | Ministry Platform event/opportunity widget integration |
| `kb/popup` | Homepage popup via category + Gantry JS |
| `kb/podcasting` | Podcast/homily feature setup |
| `kb/calendar-feed` | Calendar feed builder and RokMini Events API setup |
| `kb/elfsight` | Elfsight Instagram/Facebook widget connection |
| `kb/acymail` | AcyMail email newsletter template CSS and setup |
| `kb/dns-launching` | DNS records, new site launch checklist, email templates |
| `kb/redesign-launch` | Redesign launch checklist — menu migration, modules, subsites |
| `kb/pre-training-audit` | Pre-training audit checklist before client handoff |
| `kb/project-closeout` | SBS, Dropbox, and calendar steps to close a project |
| `kb/error-pages` | 404 error page content and Gantry outline setup |
| `kb/animate-on-scroll` | Scroll-triggered animations on article/grid sections |
| `kb/subpage-backgrounds` | Full-page background image on specific subpages via CSS |
| `kb/site-history` | Site history system — two-layer format spec, changelog entry format, examples |

---

## Key Orchestrator Tools

| Tool | Purpose |
|------|---------|
| `set_active_site` | Set the working site URL and auto-login |
| `get_active_site` | Confirm the current active site |
| `get_agent_instructions` | Return this full AGENTS.md file — required second step at session start |
| `read_agent_doc` | Read any workflow guide or KB article by doc name (see index above) |
| `get_site_notes` | Read the active site's history and persistent facts |
| `append_site_note` | Append a changelog entry to the active site's history |
| `write_site_notes` | Overwrite the active site's notes file (read first) |
| `solutio_style_guide` | Load Solutio house conventions for Gantry 5 builds |
| `solutio_particles` | Load Solutio particle reference before adding/editing particles |
| `gantry_outline_conventions` | Load Base/#Outline/#Home/#Grid/#Sponsors and subsite outline inheritance rules before creating or rewiring outlines |
| `reload_tools` | Reload tool lists if a downstream server was restarted |
| `gantry_reconnect` | Force Gantry re-auth if layout tools are failing |

---

## Credentials

All credentials come from the server's environment variables. Do not ask the user for them.

---

## Adding New Workflow Guides

Create a new `.md` file under the matching scope directory in `docs/agents/` — `global/` (all agents), `support/`, `menu-content/`, `design/` (admin only), or `launch/` (admin only) — and add a row to the doc name index in both AGENTS.md and CLAUDE.md. KB articles go in the scope's `kb/` subfolder. The scope directory controls which agents can read the doc; the doc is still referenced by its short name (e.g. `kb/staff-grid`, not `menu-content/kb/staff-grid`). When in doubt, use `global/` — an agent missing a house convention is worse than an agent seeing an extra doc. No server code changes or container rebuild needed — `read_agent_doc` scans the directory on every call and the new file appears in the enum immediately.
