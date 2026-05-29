# Joomla MCP — Claude Code Instructions

## Site Verification (Required)

At the start of every conversation, call `joomla_get_site` and announce the active site before doing anything else:

> "Active site: https://example.com (user: shannon)"

**Then:**
- If the user's request includes a site URL, call `joomla_login` with that URL and confirm the switch before proceeding.
- If the request implies a specific site (e.g., a Freshdesk ticket — the site is derived from the company record), switch to that site before proceeding.
- If no site is specified, **ask which site to work on before making any changes.** Do not assume the currently active site is correct.

## Switching Sites

1. Call `joomla_login` with the new `site_url`
2. Immediately call `joomla_get_site` to confirm the switch
3. Announce the new active site — never assume a switch succeeded

## Universal Editing Rules

Read the `editing-rules` MCP resource at the start of every session. It contains conventions all agents must follow. To read it, use `resources/read` with URI `joomla-docs://agents/editing-rules.md`.

## Support Ticket Workflow

If the user sends a standalone 5-digit number (e.g. `35030`), treat it as a Freshdesk ticket ID.

When the user provides a Freshdesk ticket number or ticket ID, fetch this guide before doing anything else:

- `joomla-docs://agents/freshdesk-agent.md` — full support ticket resolution workflow (fetch/investigate/plan/execute/document)

## Specialized Workflow Guides

Additional workflow docs are available as MCP resources. Only read these when explicitly performing that workflow — do not load them by default:

- `joomla-docs://agents/audit-agent.md` — site audit checklist and approach
- `joomla-docs://agents/menu-agent.md` — building menus, categories, and menu item structures
- `joomla-docs://agents/content-agent.md` — standard article text, SEO, and publish state edits
- `joomla-docs://agents/custom-page-agent.md` — pages with custom CSS/JS, FTP asset uploads, and Raw Tags modules

Knowledge base articles for specific issue types live under `joomla-docs://agents/kb/`. When investigating a support ticket, call `resources/list` to see what KB docs are available and fetch any that match the issue type before starting your investigation.

To list all available guides: `resources/list`

## Credentials

Credentials come from the server's environment variables. Do not ask the user for them.

## Adding New Workflow Guides

Create a new `.md` file in `docs/agents/` — the MCP server discovers all `.md` files in that folder automatically. No server code changes needed.
