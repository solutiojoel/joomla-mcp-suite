# Joomla MCP Suite — Universal Editing Rules

All agents must follow these rules regardless of the task being performed.

## Session Start (Required — in this order)

**Step 1** — Call `get_active_site` and `get_current_agent` in parallel, then announce both:
> "Agent: super_shannon | Active site: https://example.com"

- If the user's request includes a site URL, call `set_active_site` with that URL and confirm the switch.
- If no site is specified, ask which site to work on before making any changes.

**Step 2** — Call `get_agent_instructions` immediately after the active site is confirmed.

**Step 3** — Call `get_site_notes` and review the active site's history before making any changes.


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

## Tool Scope & Policy

The orchestrator enforces two layers of access control before any tool runs:

**Global deny** (`config/tool-policy.json` → `globalDeny`) — blocks a tool for every agent. Error: `"Tool 'X' is currently disabled."` Do not attempt workarounds; tell the user the tool is disabled and that `config/tool-policy.json` controls it.

**Per-agent scope** (`config/agents/<name>.json` → `tools.allow` / `tools.deny`) — tools outside your agent's allow list never appear in your tool list and cannot be called. If you need a tool not available in your current scope, tell the user and suggest switching agents with `switch_agent`.

**Argument rules** (global `toolRules` and per-agent `rules`) — block specific argument values even when the tool itself is allowed (e.g., creating certain menu item types). Error: the custom message defined in the rule. Do not try different argument values to bypass the rule; report the restriction to the user.

**Doc scope** (`docs.allow` in the agent config) — `read_agent_doc` only serves files permitted for your agent. If a doc call returns a not-permitted error, do not guess the content; tell the user the doc is out of scope for the current agent.

All policies hot-reload — no orchestrator restart is needed after editing config files.

## Update vs. Delete + Recreate

Always use `action: "update"` to modify existing items. Never delete an item and recreate it — this causes alias conflicts and can break menu links, module assignments, and URL routing.

- Use `joomla_article(action: "update", ...)` not delete + create
- Use `joomla_module(action: "update", ...)` not delete + create
- Use `joomla_menu_item(action: "update", ...)` not delete + create

## Primary Site Outline Page Settings — Do Not Break Inheritance

**Never check all Page Settings override boxes on a primary site outline (#Outline, #Home, #Grid, #Sponsors).** That is the subsite setup pattern and will break inheritance from Base Outline for the entire outline.

Primary site outlines inherit Page Settings from Base Outline via Gantry's native mechanism (section override checkboxes unchecked). The ONLY local overrides allowed are:

| Outline | Local override | Value |
|---------|---------------|-------|
| `#Outline` | none — full inherit | — |
| `#Home` | Body Classes only | `gantry site-home withmaxwidth` |
| `#Grid` | Body Id only | `site-grid` |
| `#Sponsors` | none — full inherit | — |

Do NOT use `gantry_page_copy_from` or `gantry_subsite_child_outline_setup` on any primary site outline. Those tools are for subsite families only and will force all Page Settings local.

If inheritance has been accidentally broken, use `gantry_primary_page_settings_restore` to reset the outline. It stores only the specified `localFields` and clears everything else.

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

## Changelog — Write Immediately After Every Change

**Do not batch to session end.** Call `append_site_note` right after completing any change. Conversations can end abruptly — the note must be written while the work is still being done.

```
append_site_note(
  note: "### YYYY-MM-DD — [Ticket #XXXXX | ][Brief title]
**Requested by:** [Name / email / 'internal'] | **Ticket:** [#XXXXX or 'none']
**Changes:**
- [specific change with IDs]
**Notes:** [anything non-obvious, or 'No follow-up needed']"
)
```

Rules:
- Always include specific IDs (article ID, module ID, menu item ID) — not just names
- Always include who requested the change
- Investigation-only session: still log what was checked, what was found, what was ruled out before responding to the user
- Vague entries ("updated some articles") are worse than no entry — be specific

For the full format specification and examples, see `read_agent_doc(doc: "kb/site-history")`.

## Session End (Also Required)

At session end, handle any persistent-fact updates that weren't done inline:

**Step 1 — Update persistent facts** (if anything changed or was newly discovered):
- New IDs found → update the Key IDs table
- New quirk discovered → add to Quirks & Warnings
- New integration added → add to Active Integrations
- Use `write_site_notes` with the full updated file content

**Step 2 — Review for process improvements** (if applicable — not required every session):

Briefly replay the session's steps. If any of the following apply, read `read_agent_doc(doc: "improvements")` and append an entry:
- A task took more attempts than it should have
- A KB article was missing, wrong, or didn't cover the actual case
- A better approach was discovered mid-task
- A tool behaved in an unexpected or undocumented way
- A workflow step was in the wrong order or had a missing prerequisite

This is a shared queue reviewed by the team — not a per-session requirement. Only add an entry if something genuinely useful was found. See `read_agent_doc(doc: "improvements")` for the format.

---

## Available Workflow Guides

The full index of workflow guides and KB articles is in `get_agent_instructions` (AGENTS.md). Only read a guide when explicitly performing that workflow — do not load them proactively.
