---
name: project-structure
description: "joomla-mcp-suite monorepo layout — 4 downstream MCP servers behind a single orchestrator, agent scoping, where docs and site notes live"
metadata:
  node_type: memory
  type: project
  originSessionId: eeb05621-374b-4eda-b3b9-84b638f8fbc9
---

Monorepo (`joomla-mcp-suite`) — a fleet-management platform for Solutio Software's Joomla/Gantry 5 parish and school sites. As of 2026-06-12 (Phase 3 of the restructure plan complete):

**Apps:**
- `apps/orchestrator` — the single MCP entry point (port 9302 HTTP; renamed from `apps/joomla-orchestrator` 2026-06-12). Auth (bearer tokens via `config/users.json`), per-session active site, agent-scope enforcement, KB accessor (`kb.js`), config-driven downstream registry, and the composite `gantry_css_asset_smoke_test` tool.
- `apps/joomla-mcp` — TypeScript, Joomla admin automation (27 tools), site-keyed session cache. Port 9300.
- `apps/gantry-mcp` — Node.js, Gantry 5 layout automation (9 consolidated action-dispatch tools; consolidated from 65 on 2026-07-28). Port 9301.
- `apps/freshdesk-mcp` — Freshdesk REST tools (7), no site context (`inject: null`). Port 9303.
- `apps/ftp-mcp` — FTP tools (7), owns `ftp-sites.json`. Port 9304.
- `apps/agent-runtime` — dashboard backend (JWT logins, chat sessions, jobs/knowledge proxies). Port 18310. Replaced the retired `apps/dashboard`.

**MCP client connects only to the orchestrator.** Tools appear as `mcp__orchestrator__*` (prefix changed from `mcp__joomla-orchestrator__*` with the rename). Routing: first downstream whose tool map has the name wins; the active site is injected as `site_url` (joomla/ftp) or `site` (gantry).

**Agent scoping:** `config/agents/<name>.json` (support, menu-content, admin) defines allowed tools + docs; instruction files sit beside them. Workflow docs live in `docs/agents/<scope>/` (global, support, menu-content, design, launch) and are read via the `read_agent_doc` tool — legacy flat names like `kb/staff-grid` still resolve through kb.js aliasing.

**Site notes:** per-hostname markdown at `docs/sites/<hostname>.md` via `get_site_notes` / `append_site_note` / `write_site_notes`; entries are auto-stamped with the session user.

**Start scripts:** `scripts/start-all.ps1` (windows) or per-service `start-*.ps1`; Docker via root Dockerfile + docker-compose.
