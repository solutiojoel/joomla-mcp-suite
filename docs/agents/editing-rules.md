# Joomla MCP Suite — Universal Editing Rules

All agents must follow these rules regardless of the task being performed.

## Session Start (Required — in this order)

1. Call `get_active_site` and announce the active site to the user:
   > "Active site: https://example.com"


## Switching Sites 

When asked to switch to a different site:
1. If the new active site is obvious or the user already sent you a site, go ahead and switch.
2. Call `set_active_site` with the new URL (this also logs in automatically)
3. Immediately call `get_active_site` to confirm the switch succeeded
4. Announce the new active site to the user
5. Never assume a switch succeeded — always verify. Do not perform any edits until the user has acknowledged the active site.
6. Call `get_site_notes` and review any known quirks for this site before starting work.

## Credentials

Username and password come from the server's environment variables (`JOOMLA_USERNAME` / `JOOMLA_PASSWORD`). They are shared across all sites. Do not ask the user for credentials.

## Update vs. Delete + Recreate

Always use `joomla_update_*` tools to modify existing items. Never delete an item and recreate it — this causes alias conflicts and can break menu links, module assignments, and URL routing.

- Use `joomla_article(action: "update", ...)` not delete + create
- Use `joomla_update_module` not delete + create
- Use `joomla_update_menu_item` not delete + create

## Destructive Actions

Always confirm with the user before executing any destructive action:
- Unpublishing or trashing articles, modules, or menu items
- Deleting any content
- Changing site-wide configuration

State clearly what will be changed and wait for explicit user approval.

## Search Strategy

When searching for content:
1. Search by specific name first using the `search` parameter (server-side filter, faster)
2. If a module search returns nothing, search articles next before exploring Gantry outlines
3. Use `joomla_backend_inventory` for a broad overview when starting on an unfamiliar site

## Site Notes

When you discover something non-obvious about the current site, save it immediately:
- Call `append_site_note` with what you found and an optional `category` (e.g. Modules, Menus, Template, Content, Quirks)
- Examples worth noting: unexpected module assignments, non-standard alias patterns, broken features, extension quirks, client preferences

When existing notes become stale or incorrect:
- Call `get_site_notes`, revise the content in context, then call `write_site_notes` with the full updated text

## FTP Access Limitations

FTP credentials only provide access to user-content directories (`images/` and site-specific content folders). **Gantry 5 template files are not accessible via FTP.** This includes:

- Outline YAML files (`config/default/*.yaml`)
- Menu configuration YAML files (`config/default/menu/*.yaml`)
- Template PHP/TWIG files

Do not attempt to read or edit Gantry 5 configuration via FTP — those paths will return empty or not exist. Use the Joomla admin interface or MCP tools instead (e.g. `gantry-subtitle` is a menu item param, not a template file edit).

## Available Workflow Guides

Additional agent-specific guides are available as MCP resources. Only fetch them when performing that specific workflow:

- `audit-agent` — site audit checklist
- `content-agent` — article and content editing workflow
