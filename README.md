# 🧩 Joomla MCP Suite

A self-contained Docker image that gives an AI agent complete programmatic control over a Joomla site — content, menus, modules, media, permissions, FTP assets, Freshdesk tickets, and the full Gantry 5 theming and layout system. Point an MCP client at a single HTTP endpoint and the model can build, edit, audit, and restructure an entire Joomla site without touching the admin UI.

---

## 🏗️ What's in the Suite

Six downstream servers behind a single orchestrator endpoint:

| Server | Path | Tools | What it does |
|--------|------|-------|-------------|
| **Joomla MCP** | `apps/joomla-mcp` | 29 | Every major Joomla admin workflow via form-level HTTP automation |
| **Gantry MCP** | `apps/gantry-mcp` | 9 | Gantry 5 layouts, particles, styles, outlines — via JSON API |
| **Freshdesk MCP** | `apps/freshdesk-mcp` | 7 | Ticket, contact, and conversation access |
| **FTP MCP** | `apps/ftp-mcp` | 8 | Direct server file operations for CSS/JS assets |
| **Knowledge Gateway MCP** | `apps/knowledge-gateway-mcp` | 5 | Workflow docs, KB articles, site notes, audit log |
| **Agents MCP** | `apps/agents-mcp` | 9 | LLM-backed sub-agent stages that run in their own context windows |
| **Orchestrator** | `apps/orchestrator` | 15 | Single `/mcp` endpoint that aggregates every downstream and scopes tools per agent |

Tool counts are the surface an agent actually sees. Both entity servers use
action dispatch (`joomla_article { action: "list" }`) rather than one tool per
verb — Gantry's nine tools route to sixty-plus internal handlers.

No direct database writes. Every Joomla operation goes through the same code paths the admin UI uses — CSRF tokens, session state, extension hooks all work correctly.

---

## ✨ What You Can Do

**🔨 Build a site from scratch.** Three staged pipelines, each driven by a dedicated agent scope and a human-reviewable spec: **menu-build** turns a client menu PDF into a Joomla skeleton, **content-build** writes the pages onto that skeleton, and **site-build** turns a mockup into a live Gantry outline. Every stage stops at an approval gate before it writes.

**📝 Manage all content.** Create, update, and organize articles and categories. Assign categories, set publish states, manage metadata, and bulk check-in locked items.

**🗂️ Control navigation.** Create menus and menu items of any type. `joomla_menu_item_type { action: "list" | "inspect" }` lets the agent discover every available link type and its parameter schema before creating one.

**📦 Place and configure modules.** List every available type and position with `joomla_module_type`, inspect a type's full parameter schema, then create or update modules with precise placement.

**🎨 Design layouts with Gantry 5.** Read the live layout tree of any outline, add particles into sections, move them, resize blocks, edit particle settings, apply inheritance — all via JSON, not the drag-and-drop UI.

**🔒 Manage users and permissions.** Create user accounts and groups, set category- and article-level access controls, and configure teacher/staff user group structures.

**📁 Work with files over FTP.** List, read, upload, delete, rename, and organize files directly on the server — useful for custom CSS/JS assets, service key files, and hero images.

**🎫 Handle support tickets.** Pull Freshdesk tickets, contacts, and conversation history; add internal notes; update ticket status — all from the same agent workflow.

**🛡️ Operate safely.** Every Gantry write tool auto-backs up before saving and supports `dryRun: true`. `gantry_layout { action: "backups" | "undo" }` lists those backups and reverts the last write.

**🌐 Work across multiple sites.** Switch the active site at any time. Gantry tools accept a `site` parameter and maintain per-site login sessions.

---

## 📁 Repository Layout

```
apps/
  orchestrator/            Router — aggregates every downstream under one /mcp endpoint
  joomla-mcp/              TypeScript MCP server — Joomla admin automation
  gantry-mcp/              Node.js MCP server — Gantry 5 layout automation
  freshdesk-mcp/           Freshdesk ticket tools
  ftp-mcp/                 FTP asset upload tools
  knowledge-gateway-mcp/   AI Knowledge Gateway access
  agents-mcp/              LLM-backed sub-agent tool handlers
  agent-runtime/           Dashboard backend (auth, chat sessions, jobs)
packages/                  Shared workspace libraries (env, logging, transport)
reference/design-corpus/   Scraped fleet design data (read-only, no code)
config/                    Agent scopes, user registry (gitignored), examples
docs/                      Architecture and API notes
scripts/                   See the table below
CLAUDE.md                  Agent instructions for Claude Code
AGENTS.md                  Agent instructions for OpenAI Codex and compatible agents
Dockerfile
docker-compose.yml
```

> Workflow guides and KB articles are **not** files. They live in the AI Knowledge
> Gateway and load through the `read_agent_doc` tool.

### Scripts

| Script | Purpose |
|--------|---------|
| `start-single.sh` | Replit entry point — the orchestrator hosts every downstream in-process on one port |
| `start-all.sh` | Legacy multi-process supervisor (Docker and the older Replit workflow) |
| `start-all.ps1` | Local Windows stack — calls the per-service `start-*.ps1` scripts |
| `start-<service>.ps1` | Start one service in its own terminal window |
| `mcp-target.ps1` | Point the `joomla-suite` MCP registration at the local stack or Replit |
| `sync-agent-docs.ps1` | Keep CLAUDE.md and AGENTS.md in sync |
| `hash-tokens.js` | Hash or rotate the orchestrator bearer tokens in `config/users.json` |
| `runtime-user-tool.js` | Hash a password or encrypt a token for `config/runtime-users.json` |
| `on-joomla-edit.ps1` | PostToolUse hook — rebuild joomla-mcp when its source changes |
| `post-merge.sh` | Install dependencies and build after a task merge |
| `check-crash-loop.sh` | Verify the `start-all.sh` supervisor gives up on a crash loop |
| `archive/` | One-time migrations that already ran — reference only |

---

## 🚀 Quick Start (Docker)

1. Copy `.env.example` to `.env` and fill in your Joomla credentials.
2. Build and run:

```bash
docker compose up --build -d
```

3. Connect your MCP client to:

```
http://localhost:18302/mcp
```

### Ports

| Port | Visibility | Service |
|------|-----------|---------|
| `18302` | External | Orchestrator — the only port you need |
| `18300` | Internal | Joomla MCP server |
| `18301` | Internal | Gantry MCP server |
| `18310` | Cloudflare Tunnel | Agent-runtime + Solutio AI Dashboard *(planned — see below)* |

### Build Without Compose

```bash
docker build -t joomla-mcp-suite .
docker run --env-file .env -p 18302:9302 joomla-mcp-suite
```

---

## 💻 Quick Start (No Docker)

Run all three MCP servers directly on your machine.

**Prerequisites:** Node.js 22+, npm 10+

### Install dependencies

```bash
cd apps/joomla-mcp && npm ci && npm run build
cd ../gantry-mcp && npm ci
cd ../orchestrator && npm ci
```

### Create local env files

```dotenv
# apps/joomla-mcp/.env
JOOMLA_BASE_URL=https://example.com/administrator
JOOMLA_USERNAME=your_username
JOOMLA_PASSWORD=your_password
```

```dotenv
# apps/orchestrator/.env
JOOMLA_MCP_URL=http://127.0.0.1:9300/mcp
GANTRY_MCP_URL=http://127.0.0.1:9301/mcp
```

### Start all three servers (3 terminals)

```bash
# Terminal 1
cd apps/joomla-mcp && HTTP_PORT=9300 node dist/index.js

# Terminal 2
cd apps/gantry-mcp && HTTP_PORT=9301 node mcp-server.js

# Terminal 3
cd apps/orchestrator && HTTP_PORT=9302 node orchestrator.js
```

Connect your MCP client to `http://localhost:9302/mcp`.

---

## 🌍 Tailscale / Remote Access

```dotenv
HTTP_HOST=0.0.0.0
CORS_ORIGIN=*
```

Connect using your Tailscale IP: `http://100.x.x.x:18302/mcp`

If reachable via `curl` but not from a browser-based MCP client, allow Tailscale traffic through Docker's iptables:

```bash
sudo iptables -I DOCKER-USER -i tailscale0 -j ACCEPT
```

---

## 🖥️ Solutio AI Dashboard (planned)

The next phase adds a web frontend for the team, backed by a new `apps/agent-runtime` service (port `18310`) that runs AI chat sessions and sub-agent jobs against the orchestrator and exposes a plain REST + SSE API. The frontend is developed externally and served by the runtime as static files; the whole stack self-hosts on a Windows box, published to the team via a Cloudflare Tunnel + Cloudflare Access login at a company domain (Tailscale stays for admin access only). Design docs:

| Doc | Contents |
|---|---|
| [`docs/agent-runtime-architecture.md`](docs/agent-runtime-architecture.md) | System schematic — components, identity chain, session/job models, KB bridge, deployment |
| [`docs/agent-runtime-api.md`](docs/agent-runtime-api.md) | The REST/SSE contract the frontend is built against |

---

## 🛠️ Joomla MCP — Tool Reference

Form-level HTTP automation against the Joomla admin backend. Logs in with your credentials, captures CSRF tokens, and submits the same forms the admin UI uses. No direct database writes — extension hooks and workflow state stay correct.

**29 tools.** Every entity tool is action-dispatched (`joomla_article { action: "list" | "get" | "create" | … }`) rather than one tool per verb. Destructive actions are dry-run by default and take `confirm: true` to execute.

---

### 🔑 Session

**`joomla_login`** — Logs in to Joomla admin. Pass `site_url` to switch sites; omitted, it uses `JOOMLA_BASE_URL`. Normally implicit — `set_active_site` on the orchestrator primes the session for you.

---

### 📄 Content

**`joomla_article`** — `list | get | create | update | delete | checkin`. Body content is raw HTML: write literal `<` and `>`, never entity-encoded tags. `list` reports a warning in its message whenever Joomla applied a different filter than the one requested — read it, and treat the rows as incomplete when it appears.

**`joomla_category`** — `list | get | create | update | delete | checkin`.

**`joomla_bulk_checkin`** — Lists every checked-out item site-wide. Pass `confirm: true` to release them all.

---

### 📦 Modules

**`joomla_module`** — `list | get | create | update | delete | toggle | checkin`.

**`joomla_module_type`** — `list | inspect | list_positions`. Call this to discover types and positions before creating a module.

> **Known bug:** `joomla_module { action: "update" }` silently no-ops the `content` field on `mod_custom`. `create` respects it. To change content, delete and recreate, then verify with `get` — not with the `verification.verified` flag.

---

### 🗺️ Menus

**`joomla_menu`** — `list | create` (menu containers).

**`joomla_menu_item`** — `list | get | create | update | delete | destroy | toggle | checkin`. `delete` trashes the item — the row survives and keeps reserving its alias. `destroy` removes the row for real.

**`joomla_menu_item_type`** — `list | inspect`. Call before creating a menu item.

> `list` shows the top-level ancestor as `parentId`/`parentTitle` for display grouping, not the true immediate parent. Use `get` to verify actual nesting.

---

### 👥 Users & Access

**`joomla_user`** — `list | get | create | update`. Set `requireReset: 1` on every new account. Usernames are the full email address.

**`joomla_group`** — `list | create | delete`.

**`joomla_permissions`** — `get | set` ACL rules. `resource: category | article`.

---

### 🔍 Admin Introspection & Generic Automation

The escape hatch for any admin screen without a dedicated tool.

**`joomla_backend_inventory`** — Discovers the admin surface: components, module types, menu item types, Gantry outlines.

**`joomla_inspect_admin_form`** — Inspects any admin edit form by path. Returns fields, options, hidden fields, token. `rawHtml: true` returns the raw page HTML.

**`joomla_inspect_admin_list`** — Inspects an admin list page. Returns filters, headers, row IDs, toolbar tasks.

**`joomla_submit_admin_form`** — Submits an admin form. Preserves existing fields and injects CSRF. Dry-run by default; set `confirm: true` to submit.

**`joomla_component_inspect`** — Explores any admin component path in form or list mode.

**`joomla_site_config_inspect`** — Reads global site configuration fields.

**`joomla_redirects_list`** — Lists URL redirects.

---

### 📸 Frontend Verification

**`joomla_get_frontend_page`** — Fetches a frontend page. Returns title, headings, body text, links, images, OG meta, template, and module positions.

**`joomla_get_frontend_screenshot`** — Captures a browser screenshot. Injects admin session cookies so unpublished preview content renders.

**`joomla_inspect_frontend`** — Inspects one region of a rendered page in a real browser: DOM structure, box-model geometry, and the CSS rules that actually match. Use it when a screenshot shows something off and you need to know which rule is responsible. `ruleCount: 0` on a block class means the class has no CSS on this site.

**`joomla_verify_frontend_content`** — Asserts that specific strings and CSS classes are present or absent in a rendered page.

---

### 🗄️ Media & Documents

**`joomla_media`** — `list | create_folder | upload | delete | rename | move`. **Images only.** Never browse it for PDFs, forms, or documents — those live in DOCman or FILEman.

**`joomla_docman_document`** — `list | get | create | update | delete`.

**`joomla_docman_category`** — `list | get | create | update | delete`.

**`joomla_fileman_list_files`** — Lists FILEman files and subfolders. Paths are relative to the FILEman container root, typically `images/stories`.

---

### 📁 Workspace

**`joomla_workspace_write`** — Writes a file into the server sandbox at `/app/workspace/`. Use it to hand generated JSON/YAML/HTML to another tool without re-emitting the content through the model.

**`joomla_workspace_read`** — Reads a file back out of `/app/workspace/`.

---

### 📡 FTP File Operations — `ftp-mcp` (8 tools)

`ftp_site_config` · `ftp_list_files` · `ftp_read_file` · `ftp_mkdir` · `ftp_upload_file` · `ftp_upload_local_file` · `ftp_append_file` · `ftp_delete_file`

> `upload_path` and `pub_path` are one aliased directory, not two. See `workflows/ftp-css-smoke-test`.

---

### 🎫 Freshdesk Integration — `freshdesk-mcp` (7 tools)

`freshdesk_list_tickets` · `freshdesk_get_ticket` · `freshdesk_get_conversations` · `freshdesk_add_note` · `freshdesk_update_ticket` · `freshdesk_get_contact` · `freshdesk_get_company`

---

### 🧠 Knowledge Gateway — `knowledge-gateway-mcp` (5 tools)

`knowledge_universal` · `knowledge_client` · `knowledge_self_improving` · `knowledge_audit` · `agent_audit`

Workflow guides and KB articles are rows in `knowledge_universal`, read by name through `read_agent_doc`. See `kb/knowledge-gateway`.

---

### 🤖 Sub-Agent Handlers — `agents-mcp` (9 tools)

LLM-backed and deterministic stages that run in their own context windows.

| Tool | Stage | Engine |
|---|---|---|
| `run_menu_interpretation` | Menu PDF → Menu Spec | Sonnet 5 |
| `run_menu_build` | Menu Spec → Joomla skeleton | Sonnet 5 |
| `derive_content_schematic` | Menu Spec → Content Schematic | deterministic |
| `run_content_interpretation` | PDF → schematic content fields | Sonnet 5 |
| `discover_source_urls` | Find old-site source pages | deterministic |
| `fetch_source_content` | Fetch source pages to markdown | deterministic |
| `run_content_build` | Source → house-style article HTML | Sonnet 5 |
| `apply_content` | Written HTML → live articles | deterministic |
| `agent_ping` | Health check | — |

---

## 🎨 Gantry MCP — Tool Reference

Controls Gantry 5 through Puppeteer automation, reading and writing Gantry's internal layout JSON directly — faster and more reliable than driving the drag-and-drop UI. Every write tool auto-backs up before saving and accepts `dryRun: true`.

---

### 📋 Outlines

**`gantry_outline{action:"list"}`** — All Gantry 5 outlines with IDs, titles, default status, and menu item assignments.

**`gantry_outline{action:"duplicate"}`** — Copies an outline. Pass `noInherit: true` for a full independent clone.

**`gantry_outline{action:"delete"}`** — Permanently deletes one or more outlines by ID.

---

### 🔭 Layout — Reading

**`gantry_layout{action:"list"}`** — Particles in an outline as a flat list. Pass `editable: true` to filter to configurable particles only.

**`gantry_layout{action:"tree"}`** — Full hierarchical layout as a tree (sections → grids → blocks → particles). Use when you need exact structure before a surgical edit.

**`gantry_layout{action:"sections"}`** — Lists top-level sections only (`navigation`, `header`, `expanded`, `footer`, etc.). These IDs are stable and the correct targets for `--to` parameters.

**`gantry_layout{action:"presets"}`** — Built-in layout presets available in the Gantry framework.

---

### ➕ Layout — Adding Particles

**`gantry_particle{action:"add"}`** — Adds a particle, position, spacer, or system element to a section.
- `to` — drops into a section as a new full-width grid row
- `nextTo` — places as a sibling block in the same grid as an existing particle

Always call `gantry_layout{action:"sections"}` or `gantry_layout{action:"tree"}` first to get valid IDs.

---

### ✂️ Layout — Moving & Removing

**`gantry_particle{action:"move"}`** — Moves an existing particle to a new location using the same `to`/`nextTo` placement modes.

**`gantry_particle{action:"remove"}`** — Removes one or more particles by ID. Accepts a single ID, array, or CSV string. Empty grids are cleaned up automatically.

---

### ✏️ Layout — Editing Particles

**`gantry_particle{action:"edit"}`** — Edits an existing particle's settings. Two approaches:

- **JSON-patch path** (default) — fast, dry-run aware. Use Gantry's bracket notation: `particles[contentarray][title]="Newsroom"`, `block[size]=50`
- **Dialog path** (`viaDialog: true`) — opens the actual settings modal. Slower but necessary for fields not in the JSON structure.

---

### 🏛️ Layout — Section Operations

**`gantry_section{action:"edit"}`** — Edits a section's boxed state, CSS class, and variations (`dark`, `flush`, etc.).

**`gantry_section{action:"inherit"}`** — Configures a section to inherit from another outline. Specify what to inherit: `children`, `attributes`, or both.

**`gantry_section{action:"unlink"}`** — Breaks a section's inheritance link, turning it into an independent copy.

---

### 📤 Layout — Export, Import, Copy, Presets

**`gantry_layout{action:"export"}`** — Exports an outline's complete layout as structured JSON.

**`gantry_layout{action:"import"}`** — Applies a previously exported layout JSON to an outline. Auto-backs up before importing.

**`gantry_layout{action:"copy_from"}`** — Copies the layout from one outline directly into another.

**`gantry_layout{action:"load_preset"}`** — Applies a built-in layout preset to an outline.

**`gantry_layout{action:"clear"}`** — Removes all particles. `full` clears everything; `keep-inheritance` leaves inheritance links intact.

---

### ↩️ Layout — Backups & Undo

**`gantry_layout{action:"backups"}`** — All automatic backup files for an outline, sorted by timestamp.

**`gantry_layout{action:"undo"}`** — Restores the most recent backup — one-step undo of the last write.

> A specific backup is restored by passing its filename to `gantry_layout { action: "undo" }`; omit the filename to revert the most recent write.

---

### 🖌️ Styles

**`gantry_styles{action:"list"}`** — All style variables for an outline: fonts, colors, spacing, theme settings.

**`gantry_styles{action:"edit"}`** — Updates style variables using bracket notation: `styles[base][background]="#1a1a2e"`. Changes take effect on next page render.

---

### 📄 Page Settings

**`gantry_page{action:"list"}`** — Page settings for an outline: body classes, head tags, favicon, meta tags.

**`gantry_page{action:"edit"}`** — Updates page settings: `page[body][attribs][class]="gantry site-sub withmaxwidth"`. Useful for adding body classes that control layout behavior.

**`gantry_page{action:"breakdown"}`** — Returns Page Settings grouped like the Gantry UI: Head Properties, Assets, Body Attributes, and Font Awesome, with meta tags, CSS rows, JavaScript rows, and tag attributes parsed from their JSON fields.

**`gantry_page{action:"head"}`** — Updates Head Properties without touching the rest of the page: custom head content plus add/edit/remove meta tags by key.

By default, head edits preserve the managed Solutio site-default block on the Base Outline. Pass `siteDefaults` to update artwork-driven RGB values, color labels, font imports, and font families while keeping required variable names available.

**`gantry_page{action:"head_defaults"}`** — Adds or normalizes the Base Outline startup image, manifest, and `html body` CSS variable block in Head Properties while preserving existing custom content.

**`gantry_page{action:"icons"}`** — Updates just the favicon and touch icon paths.

**`gantry_page{action:"assets"}`** — Adds, edits, or removes individual CSS and JavaScript asset rows. Use this for linked CSS/JS files instead of putting `<link>` or `<script>` tags in custom head content.

**`gantry_page{action:"body"}`** — Updates Body Id, Body Classes, tag attributes, Sections Layout, After `<body>`, and Before `</body>`.

---

## 🤖 Agent Instructions

This repo ships instructions for two agent conventions:

| File | Used by |
|------|---------|
| `CLAUDE.md` | Claude Code |
| `AGENTS.md` | OpenAI Codex CLI and compatible agents |

Both files are kept identical. After editing either one, run:

```powershell
.\scripts\sync-agent-docs.ps1
```

Workflow guides and knowledge base articles live under `docs/agents/`. Agents read these on demand — see `CLAUDE.md` / `AGENTS.md` for the full index.

---

## 🧠 Design Philosophy

**Form-level, not database-level.** The Joomla MCP submits the same forms the admin UI uses. CSRF tokens are respected, Joomla's own validation runs, events fire, and extension hooks work correctly.

**JSON-API, not UI automation.** The Gantry MCP reads `window.G5.lm.builder.serialize()` and POSTs to the layout save endpoint directly. Faster and more reliable than driving the drag-and-drop interface — inherited particles, disabled nodes, and complex nesting all handled through plain JSON mutation.

**Snapshot before mutating.** Any operation that could cause data loss is guarded by a snapshot or auto-backup. Restore tools are first-class, not an afterthought.

**Discover before acting.** Introspection tools (`joomla_module_type{action:"inspect"}`, `joomla_menu_item_type{action:"inspect"}`, `joomla_inspect_admin_form`, `gantry_layout{action:"sections"}`, `gantry_layout{action:"tree"}`) are designed to be called before write operations so the agent can read a form's schema, understand what parameters exist, and construct a correct payload — rather than guessing.
