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

## Site Notes (During Session)

Every site has a dedicated history file at `docs/sites/[sitecode].md`. Call `get_site_notes` at session start and review it before making any changes — it contains known quirks, key IDs, active integrations, and change history.

When you discover something non-obvious mid-session, update the persistent facts section immediately:
- Call `get_site_notes`, update the relevant section in context, then call `write_site_notes` with the full updated text
- Examples worth adding to persistent facts: unexpected module behavior, non-standard alias patterns, quirks that would trip up a future agent, active integrations, key IDs discovered

## FTP Access Limitations

FTP credentials only provide access to user-content directories (`images/` and site-specific content folders). **Gantry 5 template files are not accessible via FTP.** This includes:

- Outline YAML files (`config/default/*.yaml`)
- Menu configuration YAML files (`config/default/menu/*.yaml`)
- Template PHP/TWIG files

Do not attempt to read or edit Gantry 5 configuration via FTP — those paths will return empty or not exist. Use the Joomla admin interface or MCP tools instead (e.g. `gantry-subtitle` is a menu item param, not a template file edit).

## Session End (Required — every session)

Before closing any session on a site, complete both steps in order:

**Step 1 — Update persistent facts** (if anything changed or was newly discovered):
- New IDs found → update the Key IDs table
- New quirk discovered → add to Quirks & Warnings
- New integration added → add to Active Integrations
- Use `write_site_notes` with the full updated file content

**Step 2 — Append a changelog entry** (always, no exceptions):

```
append_site_note(
  note: "### YYYY-MM-DD — [Ticket #XXXXX | ][Brief title]\n**Requested by:** [Name / email / 'internal'] | **Ticket:** [#XXXXX or 'none']\n**Changes:**\n- [specific change with IDs]\n- [specific change with IDs]\n**Notes:** [anything non-obvious, quirks, follow-up needed]"
)
```

Rules for changelog entries:
- Always include specific IDs (article ID, module ID, menu item ID) — not just names
- Always include who requested the change
- If the session was investigation-only with no changes, still log: what was investigated, what was found, what was ruled out
- Vague entries ("updated some articles") are worse than no entry — be specific

After writing the entry, tell the user the site log has been updated.

For the full format specification and examples, see `docs/agents/kb/site-history.md`.

**Step 3 — Review for process improvements** (if applicable — not required every session):

Briefly replay the session's steps. If any of the following apply, append an entry to `docs/agents/improvements.md`:
- A task took more attempts than it should have
- A KB article was missing, wrong, or didn't cover the actual case
- A better approach was discovered mid-task
- A tool behaved in an unexpected or undocumented way
- A workflow step was in the wrong order or had a missing prerequisite
- A pattern appeared that warrants documentation

This is a shared queue reviewed by the team — not a per-session requirement. Only add an entry if something genuinely useful was found. See `docs/agents/improvements.md` for the format.

---

## Available Workflow Guides

Additional agent-specific guides are available as MCP resources. Only fetch them when performing that specific workflow:

- `audit-agent` — site audit checklist
- `content-agent` — article and content editing workflow
