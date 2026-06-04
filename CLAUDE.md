# Joomla MCP Suite — Claude Code Instructions

> **Sync note:** This file is kept in sync with `AGENTS.md`. If you update one, run `scripts/sync-agent-docs.ps1` to update the other, or edit both manually.

---

## Platform Overview

All tools in this project are exposed through a single orchestrator MCP endpoint. You will see them as `mcp__joomla-orchestrator__*`. There is no separate joomla-mcp or gantry-mcp connection — the orchestrator aggregates everything.

Workflow guides live in `apps/joomla-mcp/docs/agents/` and are read with the Read tool when needed.

---

## Session Start (Required)

At the start of every conversation, call `get_active_site` and announce the result:

> "Active site: https://example.com"

**Then:**
- If the user's request includes a site URL, call `set_active_site` with that URL and confirm the switch before proceeding.
- If the request implies a specific site (e.g., a Freshdesk ticket — derive the site from the company record), switch before proceeding.
- If no site is specified, ask which site to work on before making any changes.

After confirming the active site, read `docs/agents/editing-rules.md` — it contains universal conventions that apply to every task.

---

## Switching Sites

1. Call `set_active_site` with the new URL — this also auto-primes the Joomla session
2. Immediately call `get_active_site` to confirm the switch succeeded
3. Announce the new active site — never assume a switch succeeded
4. Call `get_site_notes` and review any known quirks before starting work

---

## Support Ticket Workflow

If the user sends a standalone 5-digit number (e.g. `35118`), treat it as a Freshdesk ticket ID.

Read this guide before doing anything else:

```
docs/agents/freshdesk-agent.md
```

---

## Specialized Workflow Guides

Only read these when explicitly performing that workflow — do not load them by default:

| File | When to use |
|------|-------------|
| `docs/agents/editing-rules.md` | Every session — universal editing conventions |
| `docs/agents/freshdesk-agent.md` | Support ticket resolution |
| `docs/agents/menu-agent.md` | Building menus, categories, and menu item structures |
| `docs/agents/content-agent.md` | Standard article text, SEO, and publish state edits |
| `docs/agents/custom-page-agent.md` | Pages with custom CSS/JS, FTP asset uploads, Raw Tags modules |

Knowledge base articles for specific issue types live under `docs/agents/kb/`. When investigating a support ticket, check what files are in that folder and read any that match the issue type before starting your investigation.

**KB file index:**

| File | Topic |
|------|-------|
| `staff-grid.md` | Staff/team grid using contentarray particle |
| `staff-pages.md` | All staff page layouts (grid, teacherbox, table, contact form) |
| `teacher-pages.md` | Teacher/classroom pages with sidebar nav and user groups |
| `grid-layout.md` | Grid layout pages using Joomla Articles particle module |
| `content-standards.md` | Formatting rules, images, links, tables — applies to all content work |
| `css-table-classes.md` | CSS table classes, button classes, site fonts/colors |
| `site-config.md` | Site title, meta, timezone, reCAPTCHA, GA4, Webmaster Verification |
| `business-directory.md` | Business Directory & Sponsorship passcode setup |
| `user-accounts.md` | User account creation, groups, and category permissions |
| `quick-galleries.md` | QuickGallery setup and broken gallery link fix |
| `ministry-platform-widget.md` | Ministry Platform event/opportunity widget integration |
| `popup.md` | Homepage popup via category + Gantry JS |
| `podcasting.md` | Podcast/homily feature setup |
| `calendar-feed.md` | Calendar feed builder and RokMini Events API setup |
| `elfsight.md` | Elfsight Instagram/Facebook widget connection |
| `acymail.md` | AcyMail email newsletter template CSS and setup |
| `dns-launching.md` | DNS records, new site launch checklist, email templates |
| `redesign-launch.md` | Redesign launch checklist — menu migration, modules, subsites |
| `pre-training-audit.md` | Pre-training audit checklist before client handoff |
| `project-closeout.md` | SBS, Dropbox, and calendar steps to close a project |
| `error-pages.md` | 404 error page content and Gantry outline setup |
| `animate-on-scroll.md` | Scroll-triggered animations on article/grid sections |
| `subpage-backgrounds.md` | Full-page background image on specific subpages via CSS |

---

## Key Orchestrator Tools

| Tool | Purpose |
|------|---------|
| `set_active_site` | Set the working site URL and auto-login |
| `get_active_site` | Confirm the current active site |
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

Create a new `.md` file in `docs/agents/` — the server discovers all `.md` files in that folder automatically. No server code changes needed.
