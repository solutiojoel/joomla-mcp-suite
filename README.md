# Joomla MCP Suite

A self-contained Docker image that gives an LLM complete programmatic control over a Joomla site — content, menus, modules, media, redirects, site configuration, and the full Gantry 5 theming and layout system. You point an MCP client at a single HTTP endpoint and the model can build, edit, audit, and restructure an entire Joomla site without touching the admin UI.

The suite ships three cooperating servers behind a single orchestrator endpoint:

- **Joomla MCP** (`apps/joomla-mcp`) — 87 tools covering every major Joomla admin workflow, implemented as form-level automation against the real admin backend. No direct database writes; every operation goes through the same code paths the admin UI uses, preserving tokens, CSRF protection, and state.
- **Gantry MCP** (`apps/gantry-mcp`) — 42 tools for the Gantry 5 framework: layout trees, particle placement, section editing, style variables, page settings, outline management, and bulk cross-site operations.
- **Orchestrator** (`apps/joomla-orchestrator`) — a single routed `/mcp` endpoint that aggregates both servers. Your MCP client connects here and sees all 129 tools as one unified server.

---

## What You Can Do With This

**Build a site from scratch.** Use `joomla_plan_site_build` to generate a structured site plan from a natural-language brief, then `joomla_apply_site_build` to execute it — creating categories, articles, menus, modules, and Gantry layout regions in the right order. `joomla_validate_site_build` checks the result and `joomla_launch_checklist` produces a pre-launch audit.

**Manage all content.** Create, update, and organize articles and categories. Assign categories, set publish states, manage metadata. Bulk operations work through standard list/filter/act patterns.

**Control navigation.** Create menus and menu items of any type. The `joomla_list_menu_item_types` and `joomla_inspect_menu_item_type` tools let the model discover every available link type before creating one, so it always uses the right parameters.

**Place and configure modules.** List every available module type and position, inspect a type's full parameter schema before creating, then create or update modules with precise position and ordering. Export a module's full configuration as a YAML blueprint and import it to reproduce it elsewhere.

**Design layouts with Gantry 5.** Read the live layout tree of any outline, add particles into sections, move them between sections, resize blocks, edit particle settings, apply inheritance from a base outline, and save — all without touching the drag-and-drop UI. The JSON-API approach (`window.G5.lm.builder.serialize()` → mutate → POST) is deterministic and fast.

**Operate safely.** Snapshot any target before a risky operation and restore it if something goes wrong. Every Gantry write tool auto-backups the layout before making changes and supports `dryRun: true` to preview a diff without committing.

**Work across multiple sites.** Gantry tools accept a `site` parameter and maintain per-site login sessions, so you can apply the same layout change to a fleet of Joomla sites in one conversation.

**Introspect anything you don't already know.** The `joomla_backend_inventory`, `joomla_inspect_admin_form`, `joomla_inspect_admin_list`, and `joomla_page_content` tools let the model read any admin page's structure, form fields, and current values before acting — useful for components not covered by a dedicated tool.

---

## Repository Layout

```
apps/
  joomla-mcp/          TypeScript MCP server — Joomla admin automation
  gantry-mcp/          Node.js MCP server — Gantry 5 layout automation
  joomla-orchestrator/ Router — aggregates both servers under one /mcp endpoint
scripts/
  start-all.sh         Process supervisor (used inside Docker)
Dockerfile             Single-image build
docker-compose.yml
```

---

## Quick Start (Docker)

1. Copy `.env.example` to `.env` and fill in Joomla credentials.
2. Build and run:

```bash
docker compose up --build -d
```

3. Connect your MCP client to:

```
http://localhost:18302/mcp
```

---

## Ports

| Port | Visibility | Service |
|------|-----------|---------|
| `18302` | External | Orchestrator — the only port you need to connect to |
| `18303` | External | Gantry Site Builder web app |
| `18304` | External | Gantry Mockup Brief Builder web app |
| `18300` | Internal | Joomla MCP server |
| `18301` | Internal | Gantry MCP server |

---

## Build Without Compose

```bash
docker build -t joomla-mcp-suite .
docker run --env-file .env -p 18302:9302 joomla-mcp-suite
```

---

## Notes

- The orchestrator automatically routes to internal services using `127.0.0.1`.
- Chromium is installed once in the image and shared by both Puppeteer-based apps.
- If one internal process exits, the container exits so orchestration can restart it.

---

## Quick Start (No Docker)

This runs all 3 MCP servers directly on your machine.

### 1. Prerequisites

- Node.js 22+
- npm 10+

### 2. Install dependencies

From repo root:

```bash
cd apps/joomla-mcp && npm ci && npm run build
cd ../gantry-mcp && npm ci
cd ../joomla-orchestrator && npm ci
```

PowerShell equivalent:

```powershell
Set-Location apps/joomla-mcp; npm ci; npm run build
Set-Location ../gantry-mcp; npm ci
Set-Location ../joomla-orchestrator; npm ci
```

### 3. Create local env files

Create these files:

- `apps/joomla-mcp/.env`
- `apps/gantry-mcp/.env`
- `apps/joomla-orchestrator/.env`

Recommended minimum values:

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

`apps/gantry-mcp/.env` can be empty unless you use optional overrides.

### 4. Start all 3 servers (3 terminals)

Terminal 1:

```bash
cd apps/joomla-mcp
HTTP_PORT=9300 node dist/index.js
```

```powershell
Set-Location apps/joomla-mcp
$env:HTTP_PORT = "9300"
node dist/index.js
```

Terminal 2:

```bash
cd apps/gantry-mcp
HTTP_PORT=9301 node mcp-server.js
```

```powershell
Set-Location apps/gantry-mcp
$env:HTTP_PORT = "9301"
node mcp-server.js
```

Terminal 3:

```bash
cd apps/joomla-orchestrator
HTTP_PORT=9302 node orchestrator.js
```

```powershell
Set-Location apps/joomla-orchestrator
$env:HTTP_PORT = "9302"
node orchestrator.js
```

### 5. Connect your MCP client

```
http://localhost:9302/mcp
```

---

## Tailscale / Remote Access

To expose the server over a Tailscale network (or any remote connection), set these environment variables before starting:

```dotenv
HTTP_HOST=0.0.0.0
CORS_ORIGIN=*
```

Then connect your MCP client using the Tailscale IP:

```
http://100.x.x.x:18302/mcp
```

If the container's port is reachable via `curl` but not from a browser-based MCP client, you need to allow Tailscale traffic through Docker's iptables:

```bash
sudo iptables -I DOCKER-USER -i tailscale0 -j ACCEPT
```

---

## Joomla MCP — Tool Reference

The Joomla MCP server automates the Joomla administrator backend through form-level HTTP. It logs in with your credentials, captures CSRF tokens, and submits the same forms the admin UI would. All operations are reversible via snapshot/restore.

### Session

**`joomla_login`**
Authenticates against the Joomla admin backend and initializes the server's session cookies. Most other tools call this automatically on first use, but you can call it explicitly to verify credentials or refresh an expired session. Returns the logged-in username and site name.

---

### Articles

**`joomla_list_articles`**
Returns a paginated list of articles with their IDs, titles, categories, publish states, authors, and creation dates. Accepts filters for category, state (published/unpublished/trashed/archived), and search text. Use this to survey what content exists before making changes.

**`joomla_get_article`**
Fetches the full content and metadata of a single article by ID — including the full HTML body, introtext, fulltext, metadata title, meta description, access level, language, and custom fields. Use this before editing to ensure you're working with the current version.

**`joomla_create_article`**
Creates a new article with full control over title, content (intro and full text separately), category, alias, publish state, featured flag, access level, language, metadata, and publishing dates. Returns the new article's ID and admin edit URL.

**`joomla_update_article`**
Updates any field on an existing article by ID. Only the fields you provide are changed; everything else is preserved. Handles re-fetching the current form values and merging your changes before submitting, so partial updates are safe.

**`joomla_delete_article`**
Moves an article to the trash (Joomla's two-step delete). The article remains in the database in a trashed state and can be permanently deleted or restored from the Trash view.

**`joomla_checkin_article`**
Releases an article that is checked out (locked for editing) by another user or a previous session. Useful when a crashed session left an article locked and the editor form shows "checked out by...".

---

### Categories

**`joomla_list_categories`**
Lists all content categories with IDs, titles, aliases, parent IDs, publish states, and nesting levels. Supports filtering by extension (e.g., `com_content`) and state. Use this to understand the category tree before creating or moving content.

**`joomla_get_category`**
Returns the full details of a single category including its description, parent, access level, metadata, and custom parameters.

**`joomla_create_category`**
Creates a new content category. Accepts title, alias, description, parent ID, publish state, access level, and metadata fields. Returns the new category ID and edit URL.

**`joomla_update_category`**
Updates an existing category by ID. Safe for partial updates — only the fields you specify are changed.

**`joomla_delete_category`**
Moves a category to the trash. Child categories and articles assigned to it are not automatically moved, so audit dependencies before deleting.

**`joomla_checkin_category`**
Releases a checked-out category lock, same pattern as article check-in.

---

### Modules

**`joomla_list_modules`**
Lists all modules across all positions and pages, with IDs, titles, types, positions, publish states, and assigned menu items. Accepts filters for position, type, and state. Essential for understanding what's already placed before adding more.

**`joomla_list_module_types`**
Returns every available module type installed on the site (e.g., `mod_articles_latest`, `mod_menu`, `mod_custom`, Gantry particle modules, third-party modules). Use this to discover what's available before creating.

**`joomla_list_module_positions`**
Lists all template positions defined by the active template. For Gantry 5 templates this includes every position registered in the theme, which is the correct target for module placement.

**`joomla_inspect_module_type`**
Returns the full parameter schema for a given module type — every available field with its type, default value, and description. Call this before `joomla_create_module` to know exactly what parameters the module accepts.

**`joomla_get_module`**
Returns the full configuration of an existing module including all its custom parameters, position, ordering, menu assignment, and publish state.

**`joomla_export_module_blueprint`**
Exports a module's complete configuration as a YAML blueprint file. This blueprint can be imported to recreate the module exactly on the same or a different site, making modules portable and version-controllable.

**`joomla_import_module_blueprint`**
Creates a new module from a previously exported YAML blueprint. All parameters, position, and assignment settings from the blueprint are applied. The position can be overridden at import time.

**`joomla_create_module`**
Creates a new module of any type. Accepts type, title, position, ordering, publish state, menu assignment, access level, and all type-specific parameters. Use `joomla_inspect_module_type` first to know what parameters are available.

**`joomla_update_module`**
Updates an existing module's configuration by ID. Handles the full form cycle — fetches current values, merges your changes, resubmits — so partial updates preserve existing settings.

**`joomla_delete_module`**
Moves a module to trash.

**`joomla_toggle_module`**
Publishes or unpublishes a module in a single call without needing to open the edit form. Useful for quickly showing/hiding modules without a full update cycle.

**`joomla_checkin_module`**
Releases a checked-out module lock.

---

### Menus and Menu Items

**`joomla_list_menus`**
Lists all menus defined on the site with their IDs, titles, types, and item counts. A Joomla site can have multiple independent menus (main navigation, footer links, sidebar, etc.).

**`joomla_create_menu`**
Creates a new menu container. The menu itself is a named collection — items are added separately with `joomla_create_menu_item`.

**`joomla_list_menu_items`**
Returns all items in a given menu with their IDs, titles, types, parent IDs, ordering, and publish states. Shows the full hierarchy so you can see nesting levels and ordering before making changes.

**`joomla_list_menu_item_types`**
Returns every available menu item type — grouped by component (Articles, Users, Contacts, System, etc.). Each type has a unique identifier that you pass to `joomla_create_menu_item`. Use this to discover what link types are available before creating.

**`joomla_inspect_menu_item_type`**
Returns the full parameter schema for a specific menu item type, including every available option and its default. For example, a Category Blog item type exposes leading articles count, intro articles count, columns, and pagination options. Always call this before creating a non-trivial menu item.

**`joomla_get_menu_item`**
Retrieves the full configuration of an existing menu item including link, type, parent, template style assignment, and all advanced options.

**`joomla_create_menu_item`**
Creates a new menu item in a specified menu. Requires type (from `joomla_list_menu_item_types`), title, and the type-specific link parameters. Supports all advanced options: note, image, CSS class, browser target, access level, language, and ordering.

**`joomla_update_menu_item`**
Updates an existing menu item by ID. Safe for partial updates.

**`joomla_delete_menu_item`**
Moves a menu item to trash. Child items are not automatically affected.

**`joomla_toggle_menu_item`**
Publishes or unpublishes a menu item without a full form cycle.

**`joomla_checkin_menu_item`**
Releases a checked-out menu item lock.

---

### Admin Introspection and Generic Form Automation

These tools give the model visibility into any part of the Joomla admin that doesn't have a dedicated tool, and the ability to act on it.

**`joomla_backend_inventory`**
Returns a map of every accessible admin section — components, modules, plugins, templates — with their menu paths and URLs. Useful as a starting point when you need to find something that doesn't have a dedicated tool.

**`joomla_inspect_admin_form`**
Loads any admin form page by URL and returns its complete structure: every form field with its current value, type, name attribute, and available options for selects. This is how you can work with any component — even obscure third-party ones — without a dedicated tool. Read the form, build your payload, submit with `joomla_submit_admin_form`.

**`joomla_inspect_admin_list`**
Loads any admin list view and returns its rows with IDs, titles, states, and any other columns visible in the table. Use this to enumerate records in any component's list view, not just the ones with dedicated list tools.

**`joomla_submit_admin_form`**
Posts a form to any admin URL with a provided field payload. The tool automatically handles CSRF token injection and session cookies. Use in combination with `joomla_inspect_admin_form` to automate any admin action that doesn't have a dedicated tool.

**`joomla_page_content`**
Returns the raw HTML and text content of any Joomla admin page. Useful for reading status messages, error states, or any information rendered on an admin page that isn't accessible through a structured API.

---

### Snapshot and Restore

**`joomla_snapshot_target`**
Captures the current state of a target (an article, module, menu item, Gantry outline, or any other supported entity) and saves it as a named snapshot. Use this before any risky change so you have a known-good state to roll back to. Snapshots are stored locally and referenced by name.

**`joomla_restore_snapshot`**
Restores a previously captured snapshot, reverting the target entity to its saved state. This is the undo mechanism for any operation that went wrong. Works by re-applying the captured form values through the same submission path the original save used.

---

### Site Build Planning and Validation

These four tools form a complete site-build pipeline — from spec to execution to validation.

**`joomla_plan_site_build`**
Takes a natural-language site brief or structured specification and produces a detailed, ordered build plan: which categories to create, which articles to write and where to assign them, what menus and menu items to set up, which modules to place and where, and what Gantry layout regions to configure. The plan is a JSON document that `joomla_apply_site_build` can execute directly.

**`joomla_apply_site_build`**
Executes a site build plan produced by `joomla_plan_site_build` (or written manually). Processes each item in dependency order — categories before articles, menus before menu items, modules after template positions exist. Returns a report of every action taken with success/failure status and the created item IDs.

**`joomla_validate_site_build`**
Audits the current state of the site against a given build plan or specification. Checks that every planned item was created, that states are correct, that relationships are intact (articles in the right categories, menu items pointing to the right targets), and that no orphaned items exist. Returns a pass/fail report with specific issues listed.

**`joomla_launch_checklist`**
Runs a comprehensive pre-launch audit independent of any build plan. Checks for unpublished items that should be live, broken menu items, modules assigned to non-existent positions, empty categories, missing metadata, and other common pre-launch issues. Returns a prioritized checklist of items to address before going live.

---

### Gantry 5 Layout Operations (via Joomla MCP)

These tools are the Joomla MCP's interface to Gantry 5 — complementary to the Gantry MCP's tools. They work through Joomla's admin forms rather than Puppeteer automation.

**`joomla_gantry5_export_outline_blueprint`**
Exports a complete Gantry 5 outline — its layout JSON, style variables, and page settings — as a portable YAML blueprint file. Use this to back up outlines, version-control designs, or transfer layouts between sites.

**`joomla_gantry5_import_outline_blueprint`**
Imports a previously exported outline blueprint, recreating the layout, styles, and page settings in a target outline. The target outline ID can differ from the source, making this useful for applying a proven layout to a new outline.

---

### Component and Extension Coverage

**`joomla_component_inspect`**
Returns the configuration and current state of any installed Joomla component by its option name (e.g., `com_content`, `com_users`, `com_contact`). Shows the component's global configuration parameters and their current values.

**`joomla_media_list`**
Lists files and folders in the Joomla media library at a given path. Returns file names, sizes, types, and URLs. Use this to discover what media assets exist before referencing them in articles or modules.

**`joomla_media_create_folder`**
Creates a new folder in the Joomla media library at a specified path. Useful for organizing uploads before creating content that references them.

**`joomla_redirects_list`**
Lists all URL redirects configured in Joomla's redirect manager, with source URLs, destination URLs, HTTP status codes, and enabled states. Useful for auditing redirect chains or exporting redirect configs.

**`joomla_site_config_inspect`**
Returns the full Joomla Global Configuration — database settings (read-only), SEO settings, cache configuration, mail settings, metadata defaults, and all other global options. Use this to audit site configuration before deployment or to understand the current environment.

**`joomla_subsites_list`**
Lists any subsites or multi-site configurations present. Relevant for Joomla installations that manage multiple sites from a single admin panel.

**`joomla_sponsors_list`**
Lists sponsors from a sponsors component if installed, with IDs, names, and states.

**`joomla_sponsor_inspect`**
Returns full details for a single sponsor record.

**`joomla_docman_list_documents`**
Lists documents in DOCman (a popular Joomla document management extension) if installed. Returns document IDs, titles, categories, and download URLs.

**`joomla_fileman_list_files`**
Lists files managed by a file manager extension such as eXtplorer or Phoca Download if installed.

**`joomla_get_frontend_page`**
Fetches a rendered frontend page by URL and returns its HTML content. Useful for verifying that published content appears correctly on the live site after making backend changes.

---

## Gantry MCP — Tool Reference

The Gantry MCP controls the Gantry 5 framework through Puppeteer browser automation. Rather than driving the drag-and-drop UI, it reads and writes Gantry's internal layout JSON directly — faster, more reliable, and deterministic.

Every write tool auto-backups the layout before saving and accepts `dryRun: true` to preview a diff without committing.

---

### Outlines

**`gantry_outlines_list`**
Returns all Gantry 5 outlines defined on the site: their IDs, titles, whether they are the default outline, and which menu items are assigned to them. An outline is a complete layout/style configuration — most Joomla pages map to one outline, with the `default` outline as the fallback.

**`gantry_outlines_duplicate`**
Creates a copy of an existing outline. Pass `noInherit: true` to make a full independent clone; without it, the new outline inherits from the source and shares its particle defaults. Duplication is useful for creating page-specific layouts based on a working baseline.

**`gantry_outlines_delete`**
Permanently deletes one or more outlines by ID. Accepts a single ID or an array of IDs for bulk deletion. Cannot delete the default outline.

---

### Layout — Reading

**`gantry_layout_list`**
Returns the particles in a given outline as a flat list. Pass `editable: true` to filter to only configurable particles (skipping structural wrappers). Includes each particle's ID, type, subtype, title, and block size. This is the quick overview of what's placed and where.

**`gantry_layout_tree`**
Returns the full hierarchical layout as a tree — sections containing grids, grids containing blocks, blocks containing particles. Shows the complete nesting including all structural nodes. Use this when you need to understand the exact structure before a surgical edit.

**`gantry_layout_sections`**
Lists only the sections of an outline — the stable top-level containers like `navigation`, `header`, `expanded`, `footer`. Section IDs are the correct targets for `--to` parameters when adding particles. These IDs are stable across page loads (unlike grid/block IDs which are randomized).

**`gantry_layout_presets`**
Lists the built-in layout presets available in the Gantry framework. Presets are complete pre-designed layout configurations (e.g., `default`, `fullwidth`, `sidebar-left`) that can be applied to an outline as a starting point.

---

### Layout — Adding Particles

**`gantry_layout_add`**
Adds a new particle, position, spacer, or system element to a section. Two placement modes: `to` drops it into a section as a new full-width grid row; `nextTo` places it as a sibling block in the same grid as an existing particle (auto-resizes blocks to fit). The `size` parameter sets the block's width percentage. Always call `gantry_layout_sections` or `gantry_layout_tree` first to know valid section IDs and existing particle IDs.

The `subtype` identifies the specific particle type (e.g., `custom`, `logo`, `menu`, `contentarray`, `messages`). Use `gantry_layout_available` to see which subtypes are valid for a given outline.

---

### Layout — Moving and Removing

**`gantry_layout_move`**
Moves an existing particle to a new location. Same placement modes as `add`: `to` a section (creates a new grid for it) or `nextTo` another particle (joins its grid as a sibling block). Moving respects block sizing and rebalances adjacent blocks automatically.

**`gantry_layout_remove`**
Removes one or more particles from the layout by ID. Accepts a single ID, an array of IDs, or a CSV string of IDs for bulk removal. Empty grids left behind are cleaned up automatically.

---

### Layout — Editing Particles

**`gantry_layout_edit`**
Edits the settings of an existing particle. Two approaches:

The **JSON-patch path** (default) — fast, reliable, dry-run aware. Specify key-value pairs using Gantry's nested bracket notation: `particles[contentarray][title]="Newsroom"`, `block[size]=50`. This directly mutates the serialized layout JSON without opening any dialogs.

The **dialog path** (`viaDialog: true`) — opens Gantry's actual settings modal in the browser, fills the fields, and submits. Slower but necessary for a small number of fields that aren't exposed in the JSON structure.

**`gantry_layout_edit`** also handles block attributes (the wrapper block's size, extra classes, and variations) via the `block[...]` prefix.

---

### Layout — Section-Level Operations

**`gantry_layout_section_edit`**
Edits a section's attributes: whether it's boxed, its CSS class, its variations (e.g., `dark`, `flush`), and whether it's enabled. These are the section-level settings accessible in Gantry's section edit drawer.

**`gantry_layout_section_inherit`**
Configures a section to inherit from another outline. You specify the source outline and what to inherit: `children` (particles inside the section), `attributes` (section-level settings), or both. This is how you maintain consistent headers/footers across outlines while only customizing the body sections per page.

**`gantry_layout_section_clone`**
Breaks a section's inheritance link, turning an inherited section into an independent copy. After cloning, changes to the source outline no longer affect this section. Use this when you need to customize a section that was previously shared.

---

### Layout — Export, Import, Copy, Presets

**`gantry_layout_export`**
Exports the complete layout of an outline as structured JSON (the same format the Gantry API uses internally). The export includes all sections, grids, blocks, particles, and their full attribute trees, plus outline metadata. Use this to take a point-in-time snapshot or to produce a blueprint for `gantry_layout_import`.

**`gantry_layout_import`**
Applies a previously exported layout JSON to an outline, replacing its current structure. Auto-backups before importing. Pass `dryRun: true` to see a diff of what would change without committing.

**`gantry_layout_copy_from`**
Copies the layout from one outline directly into another — similar to import but without an intermediate file. Useful for propagating a tested layout to a fresh outline.

**`gantry_layout_load_preset`**
Applies one of Gantry's built-in layout presets to an outline, replacing the current structure with the preset's standard configuration. Supports `dryRun: true` to preview the resulting layout diff.

**`gantry_layout_clear`**
Removes all particles from an outline's layout. Two modes: `full` removes everything including structural wrappers; `keep-inheritance` removes only the non-inherited particles, leaving inheritance links intact.

---

### Layout — Backups and Undo

**`gantry_layout_backups_list`**
Lists all automatic backup files for a given outline, sorted by timestamp. Every write operation (add, move, remove, edit, import) creates a backup before making changes. Each entry shows the timestamp, the operation that triggered it, and the file path.

**`gantry_layout_undo`**
Restores the most recent backup for an outline — a one-step undo of the last write operation.

**`gantry_layout_restore`**
Restores a specific backup by filename or the keyword `latest`. Use `gantry_layout_backups_list` to find the right backup, then call this to roll back to any prior state.

---

### Styles

**`gantry_styles_list`**
Returns all style variables defined in an outline — font choices, color variables, spacing values, and theme-specific settings. These are the variables Gantry uses to generate its CSS, equivalent to the Style tab in the Gantry admin.

**`gantry_styles_edit`**
Updates style variables for an outline using Gantry's bracket notation: `styles[base][background]="#1a1a2e"`, `styles[font][family-title]="Roboto"`. Changes take effect immediately on next page render. Supports dry-run to preview what would change.

---

### Page Settings

**`gantry_page_list`**
Returns the page settings for an outline — body classes, head tags, favicon, meta tags, and any outline-level page attributes.

**`gantry_page_edit`**
Updates page settings using bracket notation: `page[body][attribs][class]="gantry site-sub withmaxwidth"`. Useful for adding body classes that control layout behavior (narrow mode, sidebar visibility, etc.) without editing template files.

---

## Design Philosophy

**Form-level, not database-level.** The Joomla MCP submits the same forms the admin UI uses. This means CSRF tokens are respected, Joomla's own validation runs, events fire, extensions that hook into save events work correctly, and nothing bypasses the application layer.

**JSON-API, not UI automation.** The Gantry MCP reads `window.G5.lm.builder.serialize()` and POSTs directly to the layout save endpoint. This is faster and more reliable than driving Gantry's drag-and-drop interface — inherited particles, disabled nodes, and complex nesting structures are all handled through plain JSON mutation.

**Snapshot before mutating.** Any operation that could cause data loss (delete, overwrite, layout replace) is guarded by a snapshot or auto-backup. The restore tools are a first-class part of the workflow, not an afterthought.

**Discover before acting.** The introspection tools (`joomla_inspect_module_type`, `joomla_inspect_menu_item_type`, `joomla_inspect_admin_form`, `gantry_layout_sections`, `gantry_layout_tree`) are designed to be called before write operations. The model can read a form's schema, understand what parameters exist, and construct a correct payload — rather than guessing at field names.
