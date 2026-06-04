# 🧩 Joomla MCP Suite

A self-contained Docker image that gives an AI agent complete programmatic control over a Joomla site — content, menus, modules, media, permissions, FTP assets, Freshdesk tickets, and the full Gantry 5 theming and layout system. Point an MCP client at a single HTTP endpoint and the model can build, edit, audit, and restructure an entire Joomla site without touching the admin UI.

---

## 🏗️ What's in the Suite

Three cooperating servers behind a single orchestrator endpoint:

| Server | Path | Tools | What it does |
|--------|------|-------|-------------|
| **Joomla MCP** | `apps/joomla-mcp` | 100+ | Every major Joomla admin workflow via form-level HTTP automation |
| **Gantry MCP** | `apps/gantry-mcp` | 42 | Gantry 5 layouts, particles, styles, outlines — via JSON API |
| **Orchestrator** | `apps/joomla-orchestrator` | — | Single `/mcp` endpoint that aggregates both servers |

No direct database writes. Every Joomla operation goes through the same code paths the admin UI uses — CSRF tokens, session state, extension hooks all work correctly.

---

## ✨ What You Can Do

**🔨 Build a site from scratch.** Use `joomla_plan_site_build` to generate a structured build plan from a natural-language brief, then `joomla_apply_site_build` to execute it — categories, articles, menus, modules, and Gantry layout regions created in the right order. `joomla_validate_site_build` audits the result and `joomla_launch_checklist` runs a pre-launch check.

**📝 Manage all content.** Create, update, and organize articles and categories. Assign categories, set publish states, manage metadata, and bulk check-in locked items.

**🗂️ Control navigation.** Create menus and menu items of any type. The `joomla_list_menu_item_types` and `joomla_inspect_menu_item_type` tools let the agent discover every available link type before creating one.

**📦 Place and configure modules.** List every available type and position, inspect a type's full parameter schema, then create or update modules with precise placement. Export and import module blueprints to reproduce configurations across sites.

**🎨 Design layouts with Gantry 5.** Read the live layout tree of any outline, add particles into sections, move them, resize blocks, edit particle settings, apply inheritance — all via JSON, not the drag-and-drop UI.

**🔒 Manage users and permissions.** Create user accounts and groups, set category- and article-level access controls, and configure teacher/staff user group structures.

**📁 Work with files over FTP.** List, read, upload, delete, rename, and organize files directly on the server — useful for custom CSS/JS assets, service key files, and hero images.

**🎫 Handle support tickets.** Pull Freshdesk tickets, contacts, and conversation history; add internal notes; update ticket status — all from the same agent workflow.

**🛡️ Operate safely.** Snapshot any target before a risky operation and restore it if something goes wrong. Every Gantry write tool auto-backs up and supports `dryRun: true`.

**🌐 Work across multiple sites.** Switch the active site at any time. Gantry tools accept a `site` parameter and maintain per-site login sessions.

---

## 📁 Repository Layout

```
apps/
  joomla-mcp/          TypeScript MCP server — Joomla admin automation
  gantry-mcp/          Node.js MCP server — Gantry 5 layout automation
  joomla-orchestrator/ Router — aggregates both servers under one /mcp endpoint
docs/
  agents/              Workflow guides loaded by AI agents
    kb/                Knowledge base articles (staff pages, grids, DNS, etc.)
scripts/
  start-all.sh         Process supervisor (used inside Docker)
  sync-agent-docs.ps1  Keeps CLAUDE.md and AGENTS.md in sync
CLAUDE.md              Agent instructions for Claude Code
AGENTS.md              Agent instructions for OpenAI Codex and compatible agents
Dockerfile
docker-compose.yml
```

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
| `18303` | External | Gantry Site Builder web app |
| `18304` | External | Gantry Mockup Brief Builder web app |
| `18300` | Internal | Joomla MCP server |
| `18301` | Internal | Gantry MCP server |

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
cd ../joomla-orchestrator && npm ci
```

### Create local env files

```dotenv
# apps/joomla-mcp/.env
JOOMLA_BASE_URL=https://example.com/administrator
JOOMLA_USERNAME=your_username
JOOMLA_PASSWORD=your_password
```

```dotenv
# apps/joomla-orchestrator/.env
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
cd apps/joomla-orchestrator && HTTP_PORT=9302 node orchestrator.js
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

## 🛠️ Joomla MCP — Tool Reference

Form-level HTTP automation against the Joomla admin backend. Logs in with your credentials, captures CSRF tokens, and submits the same forms the admin UI uses. All operations reversible via snapshot/restore.

---

### 🔑 Session

**`joomla_login`** — Authenticates and initializes session cookies. Most tools call this automatically, but you can call it explicitly to verify credentials or refresh an expired session.

---

### 📄 Articles

**`joomla_list_articles`** — Paginated article list with IDs, titles, categories, publish states, authors, and creation dates. Filters: category, state, search text.

**`joomla_get_article`** — Full content and metadata for a single article — HTML body, introtext, fulltext, meta fields, access level, language, custom fields.

**`joomla_create_article`** — Creates a new article with full control over title, content, category, alias, publish state, featured flag, access level, metadata, and publishing dates.

**`joomla_update_article`** — Updates any field on an existing article by ID. Partial updates are safe — only provided fields change.

**`joomla_delete_article`** — Moves an article to trash (Joomla's two-step delete).

**`joomla_checkin_article`** — Releases a checked-out article locked by a previous session.

---

### 🗂️ Categories

**`joomla_list_categories`** — Lists all content categories with IDs, titles, aliases, parent IDs, publish states, and nesting levels.

**`joomla_get_category`** — Full details for a single category including description, parent, access level, and metadata.

**`joomla_create_category`** — Creates a new content category with title, alias, description, parent, publish state, and access.

**`joomla_update_category`** — Updates an existing category. Safe for partial updates.

**`joomla_delete_category`** — Moves a category to trash. Child categories and articles are not automatically moved.

**`joomla_checkin_category`** — Releases a checked-out category lock.

---

### 📦 Modules

**`joomla_list_modules`** — Lists all modules with IDs, titles, types, positions, publish states, and menu assignments.

**`joomla_list_module_types`** — Every available module type installed on the site.

**`joomla_list_module_positions`** — All template positions defined by the active template.

**`joomla_inspect_module_type`** — Full parameter schema for a given module type. Call before creating.

**`joomla_get_module`** — Full configuration of an existing module including all custom parameters.

**`joomla_create_module`** — Creates a module of any type with position, ordering, menu assignment, and all type-specific parameters.

**`joomla_update_module`** — Updates an existing module. Partial updates preserve existing settings.

**`joomla_delete_module`** — Moves a module to trash.

**`joomla_toggle_module`** — Publishes or unpublishes a module in a single call.

**`joomla_checkin_module`** — Releases a checked-out module lock.

**`joomla_export_module_blueprint`** — Exports a module's full configuration as a portable YAML file.

**`joomla_import_module_blueprint`** — Creates a module from a previously exported YAML blueprint.

---

### 🗺️ Menus & Menu Items

**`joomla_list_menus`** — All menus on the site with IDs, titles, types, and item counts.

**`joomla_create_menu`** — Creates a new menu container.

**`joomla_list_menu_items`** — All items in a given menu including full hierarchy and ordering.

**`joomla_list_menu_item_types`** — Every available menu item type grouped by component.

**`joomla_inspect_menu_item_type`** — Full parameter schema for a specific menu item type. Always call before creating a non-trivial item.

**`joomla_get_menu_item`** — Full configuration of an existing menu item.

**`joomla_create_menu_item`** — Creates a new menu item of any type. Supports all advanced options: CSS class, browser target, access level, language, ordering.

**`joomla_update_menu_item`** — Updates an existing menu item. Safe for partial updates.

**`joomla_delete_menu_item`** — Moves a menu item to trash. Child items are not automatically affected.

**`joomla_toggle_menu_item`** — Publishes or unpublishes a menu item without a full form cycle.

**`joomla_checkin_menu_item`** — Releases a checked-out menu item lock.

---

### 👥 Users & Groups

**`joomla_list_users`** — Lists all user accounts with IDs, usernames, emails, groups, and states.

**`joomla_get_user`** — Full details for a single user account.

**`joomla_create_user`** — Creates a new user account with username, email, password, and group assignments.

**`joomla_update_user`** — Updates an existing user account.

**`joomla_list_groups`** — Lists all user groups defined on the site.

**`joomla_create_group`** — Creates a new user group.

**`joomla_delete_group`** — Deletes a user group.

---

### 🔐 Permissions

**`joomla_get_category_permissions`** — Returns the current permission settings for a category across all user groups.

**`joomla_set_category_permissions`** — Sets category-level permissions (create, edit, delete, etc.) for one or more user groups.

**`joomla_get_article_permissions`** — Returns article-level permission overrides for a specific article.

**`joomla_set_article_permissions`** — Sets article-level permission overrides, useful for restricting access to individual articles within a shared category.

---

### 🔍 Admin Introspection & Generic Automation

**`joomla_backend_inventory`** — Map of every accessible admin section with menu paths and URLs. Starting point for components without a dedicated tool.

**`joomla_inspect_admin_form`** — Loads any admin form and returns its full field structure — every input with its current value, type, name, and options. Read the form, build a payload, submit with `joomla_submit_admin_form`.

**`joomla_inspect_admin_list`** — Loads any admin list view and returns rows with IDs, titles, states, and other visible columns.

**`joomla_submit_admin_form`** — Posts a form to any admin URL with a provided field payload. Handles CSRF injection automatically.

**`joomla_page_content`** — Returns raw HTML/text of any admin page. Useful for reading status messages, errors, or info not exposed by structured APIs.

**`joomla_bulk_checkin`** — Releases all checked-out items of a given type in a single call.

---

### 📸 Frontend Verification

**`joomla_get_frontend_page`** — Fetches a rendered frontend page by URL and returns HTML. Verifies published content appears correctly after backend changes.

**`joomla_get_frontend_screenshot`** — Captures a screenshot of a frontend page for visual verification.

**`joomla_verify_frontend_content`** — Checks a frontend page for specific text or element presence, returning pass/fail with context.

---

### 🗄️ Media Library

**`joomla_media_list`** — Lists files and folders in the Joomla media library at a given path.

**`joomla_media_create_folder`** — Creates a new folder in the media library.

**`joomla_media_upload`** — Uploads a file to the media library at a specified path.

**`joomla_media_delete`** — Deletes a file or folder from the media library.

**`joomla_media_rename`** — Renames a media file or folder.

**`joomla_media_move`** — Moves a media file to a different folder.

---

### 📡 FTP File Operations

Direct file access to the site's server — useful for custom CSS/JS, service key files, hero images, and any asset not manageable through Joomla's media library.

**`ftp_list_files`** — Lists files and directories at a given FTP path.

**`ftp_read_file`** — Reads the contents of a file on the server.

**`ftp_upload_file`** — Uploads content as a new file at the specified path.

**`ftp_upload_local_file`** — Uploads a local file from the workspace to the server.

**`ftp_delete_file`** — Deletes a file from the server.

**`ftp_mkdir`** — Creates a directory on the server.

**`ftp_site_config`** — Returns FTP connection details for the active site.

---

### 🎫 Freshdesk Integration

Read and update support tickets without leaving the agent workflow. Used during the support ticket resolution flow (see `docs/agents/freshdesk-agent.md`).

**`freshdesk_list_tickets`** — Lists open tickets with filters for status, priority, and assignee.

**`freshdesk_get_ticket`** — Full details for a single ticket including description, status, priority, and requester.

**`freshdesk_get_contact`** — Returns contact details for a ticket requester.

**`freshdesk_get_company`** — Returns company details associated with a ticket, including the site URL used to switch the active Joomla site.

**`freshdesk_get_conversations`** — Returns the full conversation thread for a ticket — all replies, notes, and timestamps. Always call this before working a ticket.

**`freshdesk_add_note`** — Adds a private internal note to a ticket. Used to document what was investigated and what was changed.

**`freshdesk_update_ticket`** — Updates ticket fields — status, priority, assignee. Requires user confirmation before resolving.

---

### 📊 DOCman Document Management

For sites running the DOCman document management extension.

**`joomla_docman_list_documents`** — Lists documents with IDs, titles, categories, and download URLs.

**`joomla_docman_list_categories`** — Lists DOCman categories.

**`joomla_docman_get_document`** — Full details for a single document.

**`joomla_docman_get_category`** — Full details for a DOCman category.

**`joomla_docman_create_document`** — Creates a new document entry.

**`joomla_docman_create_category`** — Creates a new DOCman category.

**`joomla_docman_update_document`** — Updates an existing document.

**`joomla_docman_update_category`** — Updates a DOCman category.

**`joomla_docman_delete_document`** — Deletes a document.

**`joomla_docman_delete_category`** — Deletes a DOCman category.

**`joomla_fileman_list_files`** — Lists files in a file manager extension (eXtplorer / Phoca Download).

---

### 🔄 Snapshot & Restore

**`joomla_snapshot_target`** — Captures the current state of any supported entity (article, module, menu item, outline) as a named snapshot. Use before any risky change.

**`joomla_restore_snapshot`** — Restores a previously captured snapshot, reverting the entity to its saved state.

---

### 🏗️ Site Build Pipeline

**`joomla_plan_site_build`** — Takes a natural-language brief and produces a structured, ordered build plan: categories, articles, menus, modules, and layout regions.

**`joomla_apply_site_build`** — Executes a build plan in dependency order. Returns a report of every action with success/failure status and created IDs.

**`joomla_validate_site_build`** — Audits the site against a build plan. Checks every planned item was created correctly, relationships are intact, and no orphaned items exist.

**`joomla_launch_checklist`** — Runs a comprehensive pre-launch audit independent of any build plan. Returns a prioritized list of issues to address before going live.

---

### 🎨 Gantry 5 Blueprints (via Joomla MCP)

**`joomla_gantry5_export_outline_blueprint`** — Exports a complete Gantry 5 outline (layout, styles, page settings) as a portable YAML file.

**`joomla_gantry5_import_outline_blueprint`** — Imports a blueprint, recreating the layout and settings in a target outline.

---

### ⚙️ Site & Component Tools

**`joomla_site_config_inspect`** — Returns full Joomla Global Configuration: database, SEO, cache, mail, metadata defaults.

**`joomla_component_inspect`** — Configuration and current state of any installed component by option name.

**`joomla_redirects_list`** — All URL redirects with source, destination, status code, and enabled state.

**`joomla_subsites_list`** — Lists subsites in multi-site installations.

**`joomla_sponsors_list`** / **`joomla_sponsor_inspect`** — Sponsor records from the sponsors component.

**`joomla_workspace_write`** — Writes content to the agent's local workspace (useful for staging files before FTP upload).

---

## 🎨 Gantry MCP — Tool Reference

Controls Gantry 5 through Puppeteer automation, reading and writing Gantry's internal layout JSON directly — faster and more reliable than driving the drag-and-drop UI. Every write tool auto-backs up before saving and accepts `dryRun: true`.

---

### 📋 Outlines

**`gantry_outlines_list`** — All Gantry 5 outlines with IDs, titles, default status, and menu item assignments.

**`gantry_outlines_duplicate`** — Copies an outline. Pass `noInherit: true` for a full independent clone.

**`gantry_outlines_delete`** — Permanently deletes one or more outlines by ID.

---

### 🔭 Layout — Reading

**`gantry_layout_list`** — Particles in an outline as a flat list. Pass `editable: true` to filter to configurable particles only.

**`gantry_layout_tree`** — Full hierarchical layout as a tree (sections → grids → blocks → particles). Use when you need exact structure before a surgical edit.

**`gantry_layout_sections`** — Lists top-level sections only (`navigation`, `header`, `expanded`, `footer`, etc.). These IDs are stable and the correct targets for `--to` parameters.

**`gantry_layout_presets`** — Built-in layout presets available in the Gantry framework.

---

### ➕ Layout — Adding Particles

**`gantry_layout_add`** — Adds a particle, position, spacer, or system element to a section.
- `to` — drops into a section as a new full-width grid row
- `nextTo` — places as a sibling block in the same grid as an existing particle

Always call `gantry_layout_sections` or `gantry_layout_tree` first to get valid IDs.

---

### ✂️ Layout — Moving & Removing

**`gantry_layout_move`** — Moves an existing particle to a new location using the same `to`/`nextTo` placement modes.

**`gantry_layout_remove`** — Removes one or more particles by ID. Accepts a single ID, array, or CSV string. Empty grids are cleaned up automatically.

---

### ✏️ Layout — Editing Particles

**`gantry_layout_edit`** — Edits an existing particle's settings. Two approaches:

- **JSON-patch path** (default) — fast, dry-run aware. Use Gantry's bracket notation: `particles[contentarray][title]="Newsroom"`, `block[size]=50`
- **Dialog path** (`viaDialog: true`) — opens the actual settings modal. Slower but necessary for fields not in the JSON structure.

---

### 🏛️ Layout — Section Operations

**`gantry_layout_section_edit`** — Edits a section's boxed state, CSS class, and variations (`dark`, `flush`, etc.).

**`gantry_layout_section_inherit`** — Configures a section to inherit from another outline. Specify what to inherit: `children`, `attributes`, or both.

**`gantry_layout_section_clone`** — Breaks a section's inheritance link, turning it into an independent copy.

---

### 📤 Layout — Export, Import, Copy, Presets

**`gantry_layout_export`** — Exports an outline's complete layout as structured JSON.

**`gantry_layout_import`** — Applies a previously exported layout JSON to an outline. Auto-backs up before importing.

**`gantry_layout_copy_from`** — Copies the layout from one outline directly into another.

**`gantry_layout_load_preset`** — Applies a built-in layout preset to an outline.

**`gantry_layout_clear`** — Removes all particles. `full` clears everything; `keep-inheritance` leaves inheritance links intact.

---

### ↩️ Layout — Backups & Undo

**`gantry_layout_backups_list`** — All automatic backup files for an outline, sorted by timestamp.

**`gantry_layout_undo`** — Restores the most recent backup — one-step undo of the last write.

**`gantry_layout_restore`** — Restores a specific backup by filename or the keyword `latest`.

---

### 🖌️ Styles

**`gantry_styles_list`** — All style variables for an outline: fonts, colors, spacing, theme settings.

**`gantry_styles_edit`** — Updates style variables using bracket notation: `styles[base][background]="#1a1a2e"`. Changes take effect on next page render.

---

### 📄 Page Settings

**`gantry_page_list`** — Page settings for an outline: body classes, head tags, favicon, meta tags.

**`gantry_page_edit`** — Updates page settings: `page[body][attribs][class]="gantry site-sub withmaxwidth"`. Useful for adding body classes that control layout behavior.

**`gantry_page_settings_breakdown`** — Returns Page Settings grouped like the Gantry UI: Head Properties, Assets, Body Attributes, and Font Awesome, with meta tags, CSS rows, JavaScript rows, and tag attributes parsed from their JSON fields.

**`gantry_page_head_edit`** — Updates Head Properties without touching the rest of the page: custom head content plus add/edit/remove meta tags by key.

**`gantry_page_asset_icons_edit`** — Updates just the favicon and touch icon paths.

**`gantry_page_asset_files_edit`** — Adds, edits, or removes individual CSS and JavaScript asset rows. Use this for linked CSS/JS files instead of putting `<link>` or `<script>` tags in custom head content.

**`gantry_page_body_edit`** — Updates Body Id, Body Classes, tag attributes, Sections Layout, After `<body>`, and Before `</body>`.

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

**Discover before acting.** Introspection tools (`joomla_inspect_module_type`, `joomla_inspect_menu_item_type`, `joomla_inspect_admin_form`, `gantry_layout_sections`, `gantry_layout_tree`) are designed to be called before write operations so the agent can read a form's schema, understand what parameters exist, and construct a correct payload — rather than guessing.
