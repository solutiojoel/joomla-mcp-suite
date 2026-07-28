# Joomla MCP Suite — Claude Code Instructions

> **Sync note:** This file is kept in sync with `AGENTS.md`. If you update one, run `scripts/sync-agent-docs.ps1` to update the other, or edit both manually.

---
## Platform Overview

All tools in this project are exposed through a single orchestrator MCP endpoint. You will see them as `mcp__orchestrator__*`. There is no separate joomla-mcp or gantry-mcp connection — the orchestrator aggregates everything.

Workflow guides and KB articles are accessible via the `read_agent_doc` orchestrator tool — use it instead of the local Read tool so that agents without this repository mounted can access them.

---

## Session Start (Required)

At the start of every conversation:

**Step 0 — Infer the correct agent scope and call `switch_agent` immediately.**
Do this before any other tool call — the active scope controls which tools are visible in the session.

| Task type | Agent scope |
|-----------|-------------|
| Support tickets, Freshdesk triage | `support` |
| Menu build (PDF → spec → Joomla skeleton) | `menu-build` |
| Content build (schematic → written pages on the skeleton) | `content-build` |
| Everything else (design, content, config, investigation) | `super_shannon` |

**Recognizing a support ticket (do not miss this):** if the user's message is **just a number** (e.g. `35478`), a `#`-prefixed number (`#35478`), a Freshdesk ticket URL, or mentions a "ticket" / "Freshdesk" / "support" — it is a **support ticket**. Switch to `support` and begin the Support Ticket Workflow immediately. A bare 4–6 digit number on its own is **always** a Freshdesk ticket ID — treat it as one; never respond with "what would you like to work on?" or fall through to `super_shannon`.

Call `switch_agent` with the appropriate name. If the task isn't clear yet, default to `super_shannon`.

**Step 1 — call `get_active_site` and `get_current_agent` in parallel** → announce both results:
> "Agent: super_shannon | Active site: https://example.com"

- If the user's request includes a site URL, call `set_active_site` with that URL and confirm the switch.
- If the request implies a specific site (e.g., a Freshdesk ticket), derive it and switch before proceeding.
- If no site is specified, ask which site to work on before making any changes.

**Step 2 — `get_agent_instructions`** ← call this immediately after the active site is confirmed.
This tool returns the full contents of this file (AGENTS.md) via the orchestrator. Any agent or LLM that does not have this repository mounted locally **must** call this tool to obtain the complete operating instructions before doing any work. Do not skip it.

**Step 3 — `get_site_notes`** → read the active site's history before making any changes.

After completing these three steps, load the universal editing conventions from the Knowledge Gateway: `knowledge_universal { action: "list", tag: "editing-rules" }` — they apply to every task. Do NOT call `read_agent_doc(doc: "workflows/editing-rules")` — that file is a deprecated stub.

---

## Session End (Required)

At the end of every session that touched a site, in this order:

**1. Update site notes** — if any persistent fact changed (new IDs discovered, new quirk found, new integration added), call `get_site_notes`, edit the relevant section, and call `write_site_notes`. Site notes contain **only** persistent facts: quirks & warnings, key IDs, active integrations. Do not append changelog entries to site notes.

**2. Write one audit note** — always, for every session that touched the site. Use `agent_audit`, **not** `knowledge_client`:

```
agent_audit {
  action: "create",
  site_code: "SITECODE",
  agent_id: "super_shannon",              ← the agent scope that did the work
  task: "YYYY-MM-DD — [Ticket #XXXXX | ][Brief title]",
  user_id: "[Name / email / 'internal']",
  original_request: "[the user's request, verbatim where practical]",
  task_notes: "**Summary of changes:**\n- [specific change with IDs]\n\n**Session detail:**\n[Step-by-step: what was investigated, every action taken, errors and how resolved, decisions made]"
}
```

Audit notes live in their own container and are **never loaded at session start** — they exist for accountability and debugging only. Retrieve with `agent_audit { action: "list", site_code: "SITECODE" }`, which returns **summaries only** (id, site, agent, task, date); follow up with `agent_audit { action: "get", id: N }` for the one record you actually need.

> **Never write audit or changelog content into `knowledge_client`.** That container is read during normal work, so session narratives there get pulled into every context window. `knowledge_client` is for durable client facts only.

See `read_agent_doc(doc: "kb/site-history")` for the full format spec and examples.

**3. Review for process improvements** (when applicable — not required every session) — did a task take more attempts than it should? Was a KB article missing or wrong? Was a better approach discovered? If yes, call `read_agent_doc(doc: "workflows/improvements")` and append an entry.

---

## Switching Sites

1. Call `set_active_site` with the new URL — this also auto-primes the Joomla session
2. Immediately call `get_active_site` to confirm the switch succeeded
3. Announce the new active site — never assume a switch succeeded
4. Call `get_site_notes` and review any known quirks before starting work

---

## Support Ticket Workflow

The support workflow lives in the Knowledge Gateway — not in local docs. Load it via:

```
knowledge_universal { action: "list", tag: "triage" }    ← browsing/summarizing tickets
knowledge_universal { action: "list", tag: "workflow" }  ← working a specific ticket
```

Working a specific ticket returns **two** docs under `tag: "workflow"` — follow both:
- **Support Agent Workflow** — Steps 1–10 (load context, switch site, investigate, plan, execute, log, draft notes, resolve). Includes how to **read ticket attachments** (the `attachment_url` is a ~5-min signed S3 link — re-fetch the ticket for a fresh URL, download with curl, open with `Read`; never use `WebFetch`).
- **Support Agent — Human Handoff** — the `human_agent` model. Every fix is presented as **one ordered resolution roadmap** whose steps are tagged by owner — **[AI]**, **[Human]**, or **[Client]** — with dependencies inline and a separate **Blockers** section for anything (usually a client decision or missing info) that must be resolved before a step can run. Route to **[Human]** (don't attempt) anything needing contracts, Google Workspace / calendar, mailbox access, Jotform / PDF Filler fillable PDFs & forms, Gantry troubleshooting, or cost estimates. Do not resolve a ticket while [Human]/[Client] steps or blockers are outstanding.

Do NOT call `read_agent_doc(doc: "workflows/freshdesk-agent")` — that file is deprecated and archived. The support agent's `get_agent_instructions` handles this correctly; this note is for any other agent or human referencing CLAUDE.md.

---

## Specialized Workflow Guides

Only read these when explicitly performing that workflow — do not load them by default.

Call `read_agent_doc(doc: "<name>")` with the name from the first column:

| Doc name | When to use |
|----------|-------------|
| `workflows/editing-rules` | **Moved to Knowledge Gateway.** Use `knowledge_universal { action: "list", tag: "editing-rules" }` instead. |
| `workflows/freshdesk-agent` | **Deprecated — archived only.** Use `knowledge_universal { tag: "triage" \| "workflow" }` instead. |
| `workflows/menu-build-workflow` | Menu build — PDF → Menu Spec → Joomla skeleton (Phases 1–4). Category conventions, pitfalls, and checklist included. |
| `workflows/content-build-workflow` | Content build — Content Schematic → written pages on the skeleton (Phase 5). Open-question resolution, deterministic fetch, batched writer, auto-apply. |
| `workflows/content-agent` | Standard article text, SEO, and publish state edits |
| `workflows/custom-page-agent` | Pages with custom CSS/JS, FTP asset uploads, Raw Tags modules |
| `workflows/gantry-section-css` | Gantry rendered section HTML, max-width containers, section backgrounds, and CSS selector conventions |
| `workflows/gantry-particle-map` | Gantry particle settings, rendered HTML anchors, and particle selection/CSS targeting map |
| `workflows/gantry-visual-qa` | Visual QA loop after any layout or CSS work — screenshots, checklist, CSS iteration |
| `workflows/ftp-css-smoke-test` | End-to-end validation that FTP upload → Gantry Page Settings → live page emission works; use before custom page builds or after server migrations |
| `workflows/gantry-design-agent` | Solutio Gantry design workflow — step-by-step process for building or rebuilding a homepage layout |
| `workflows/improvements` | Shared team queue for process improvement notes |

Knowledge base articles for specific issue types — call `read_agent_doc(doc: "kb/<name>")`. When investigating a support ticket, check the KB index below and read any files that match the issue type before starting your investigation.

**KB file index:**

| Doc name | Topic |
|----------|-------|
| `kb/staff-grid` | Staff/team grid using contentarray particle |
| `kb/staff-pages` | All staff page layouts (grid, teacherbox, table, contact form) |
| `kb/teacher-pages` | Teacher/classroom pages with sidebar nav and user groups |
| `kb/grid-layout` | Grid layout pages using Joomla Articles particle module |
| `kb/menu-spec-schema` | Menu Spec JSON schema, classification ruleset, and worked example for menu builds |
| `kb/content-schematic-schema` | Content Schematic schema, node-key rules, status lifecycle, and re-derive sync rule (menu build Phase 3.5 / content build input) |
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
| `kb/knowledge-gateway` | AI Knowledge Gateway tools — universal/client knowledge, self-improving instructions, audit log |

---

## Key Orchestrator Tools

| Tool | Purpose |
|------|---------|
| `set_active_site` | Set the working site URL and auto-login |
| `get_active_site` | Confirm the current active site |
| `get_current_agent` | Return the active agent scope name and available agents — called at session start |
| `switch_agent` | Switch to a different agent scope mid-session |
| `get_agent_instructions` | Return this full AGENTS.md file — required second step at session start |
| `read_agent_doc` | Read any workflow guide or KB article by doc name (see index above) |
| `get_site_notes` | Read the active site's history and persistent facts |
| `append_site_note` | Append a changelog entry to the active site's history |
| `write_site_notes` | Overwrite the active site's notes file (read first) |
| `solutio_style_guide` | Load Solutio house conventions for Gantry 5 builds |
| `solutio_particles` | Load Solutio particle reference before adding/editing particles |
| `gantry_reference{topic:"conventions"}` | Load Base/#Outline/#Home/#Grid/#Sponsors and subsite outline inheritance rules before creating or rewiring outlines |
| `knowledge_universal` / `knowledge_client` / `knowledge_self_improving` / `knowledge_audit` | AI Knowledge Gateway access — see `kb/knowledge-gateway` |
| `agent_audit` | Agent session audit log — where end-of-session audit notes go (`list` returns summaries; `get` for full detail) |
| `reload_tools` | Reload tool lists if a downstream server was restarted |
| `gantry_reconnect` | Force Gantry re-auth if layout tools are failing |

---

## Credentials

All credentials come from the server's environment variables. Do not ask the user for them.

---

## Adding New Workflow Guides

Create a new `.md` file in `docs/workflows/` (for procedural how-to guides) or `docs/kb/` (for reference articles) and add a row to the doc name index in both AGENTS.md and CLAUDE.md. The doc name agents use is its path relative to `docs/` without the `.md` extension — e.g. `workflows/my-guide` or `kb/my-article`.

Agent access is controlled by `docs.allow` in each agent's JSON config (`config/agents/<name>/<name>.json`):
- Folder-level access: `"workflows/*"` or `"kb/*"` grants the whole folder
- Explicit access: `"workflows/my-guide"` grants a single doc

No server code changes or container rebuild needed — `read_agent_doc` scans the directory on every call and the new file appears immediately.

## graphify

**Only applies when the `graphify` CLI is installed and `graphify-out/graph.json` exists.** Not every team machine has graphify set up — if either is missing, skip this section entirely and never attempt to run `graphify`.

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"`. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
