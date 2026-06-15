# Support Agent Workflow

## Overview

Support ticket work follows two distinct phases. Do not skip ahead — Phase 1 is always cheap and fast; Phase 2 is thorough and requires user direction before each step.

---

## Phase 1 — Triage Summary

**When:** User asks to browse, review, or summarize open tickets.

Call only:
```
freshdesk_list_tickets()
```

**Do not call `freshdesk_get_conversations` during triage.** Conversations are expensive and are not needed for a summary pass.

Present results as a table:

| Ticket ID | Site Code | Summary | Can Resolve? |
|-----------|-----------|---------|--------------|
| 35258 | stpeter-lincoln | Youth Formation page needs card grid layout | Yes |
| 35291 | lo-bros | Form not submitting — may need plugin config | Needs investigation |
| 35218 | unknown | No site URL provided, client unresponsive | No — close or ignore |

**Can Resolve?** — use your judgment:
- **Yes** — you have enough context to plan a resolution with available tools
- **Needs investigation** — likely resolvable but needs more research
- **No** — missing info, client-side issue, or outside scope

Wait for the user to tell you which tickets to investigate further before proceeding.

---

## Phase 2 — Individual Ticket Research and Resolution

The user tells you which ticket(s) to work on. For each, follow these steps in order.

---

### Step 2.1 — Load Full Ticket Context

Call all three in parallel:
```
freshdesk_get_ticket(ticket_id)
freshdesk_get_contact(requester_id)
freshdesk_get_conversations(ticket_id)
```

Then load the company:
```
freshdesk_get_company(company_id)   ← from ticket or contact
```

**Never skip `freshdesk_get_conversations`.** Prior replies and notes often contain completed work or client responses that change what the right action is.

Announce a brief summary:
> **Ticket #XXXX — [Subject]**
> Status: [status_label] | Priority: [priority_label]
> Requester: [name] <[email]>
> Company: [company name] → site: `[site_code]` (`[site_url]`)

---

### Step 2.2 — Switch to the Client Site

```
set_active_site(url: "[site_url from company]")
get_active_site()   ← always confirm
```

If `set_active_site` fails or returns the wrong URL, stop and report before going further.

---

### Step 2.3 — Read Site Notes

```
get_site_notes()
```

Review any known quirks before starting investigation.

---

### Step 2.4 — Draft a Research Plan and Send to User

Read the full ticket description and conversation. Based on that, draft a **research plan** — what you intend to look up in Joomla and why — and send it to the user before touching any tools.

Format:
> **Research plan — Ticket #XXXX**
> - Check menu item X — suspect it links to the wrong article
> - Inspect module Y — need to confirm the category it's pulling from
> - Read KB doc `kb/staff-grid` — issue matches staff grid pattern

Wait for the user to approve the research plan or redirect you.

---

### Step 2.5 — Investigate

**Before investigating:** Check whether any KB doc matches the issue type. Call `read_agent_doc` for any that apply:

| Issue type | KB doc |
|-----------|--------|
| Staff/team grid | `kb/staff-grid` |
| Grid layout pages | `kb/grid-layout` |
| Menu/category structure | `menu-agent` |
| Galleries | `kb/quick-galleries` |
| Calendar / events | `kb/calendar-feed` |
| CSS tables or buttons | `kb/css-table-classes` |
| User accounts / permissions | `kb/user-accounts` |
| Popups | `kb/popup` |
| Elfsight widgets | `kb/elfsight` |

Common Joomla investigation starting points:

- **Article / content wrong**: `joomla_article(action: "list", search: "...")`, then `get`
- **Menu broken or missing**: `joomla_menu_item(action: "list", menuId: "mainmenu")`
- **Module not showing**: `joomla_module(action: "list")`, then `get`
- **Gantry layout**: `gantry_get_outline_for_page`, `gantry_particle_inspect`
- **General site state**: `joomla_backend_inventory()`

Surface any blockers, unexpected findings, or questions to the user as they arise. Do not make changes during this step.

---

### Step 2.6 — Present Resolution Plan and Add as Ticket Note

Once you have a confident diagnosis, present a clear resolution plan to the user:

1. **Root cause** — what you found and why it's causing the issue
2. **Proposed changes** — specific items with IDs (article ID, module ID, menu item ID, field, new value)
3. **Risks or caveats** — any side effects or things that could break

Then add the plan as an internal Freshdesk note:
```
freshdesk_add_note(ticket_id: ..., body: "<p><strong>Resolution Plan</strong></p>...")
```

End with: *"Ready to proceed, or would you like to adjust anything?"*

Wait for user approval before making any changes.

---

### Step 2.7 — Execute

Once approved, make changes using Joomla tools. Follow these rules:

- Update existing items — never delete + recreate (breaks aliases and menu links)
- If any step fails or produces unexpected results, stop and report before continuing
- Ask before taking any action that could affect live content in a non-obvious way

---

### Step 2.8 — Log the Change

**Call `append_site_note` immediately after executing** — before writing Freshdesk notes, before updating ticket status.

```
append_site_note(note: "### YYYY-MM-DD — Ticket #XXXXX | [Brief title]
**Requested by:** [Name] ([email]) | **Ticket:** #XXXXX
**Changes:**
- [Specific change — include IDs, old value → new value]
- [Another change]
**Notes:** [Anything non-obvious, follow-up needed, or 'No follow-up needed']")
```

Always include specific IDs. Vague entries ("updated some content per client request") are not acceptable.

If new persistent facts were discovered (IDs, quirks, integrations):
```
get_site_notes()
→ update the relevant section
→ write_site_notes(content: "[full updated content]")
```

---

### Step 2.9 — Add Summary Note and Draft Client Reply

Add two Freshdesk notes:

**1. Internal summary** (what was done, for the human agent):
```
freshdesk_add_note(
  ticket_id: ...,
  body: "<p><strong>Issue:</strong> [root cause]</p>
         <p><strong>Resolution:</strong> [what was changed, with IDs]</p>
         <p><strong>Follow-up:</strong> [recommended next steps or 'None']</p>"
)
```

**2. Draft client reply** (for the human agent to review and send):
```
freshdesk_add_note(
  ticket_id: ...,
  body: "<p><strong>Draft reply for [Client Name]:</strong></p><p>...</p>"
)
```

- Write as the human agent would send it — warm, concise, client-friendly
- Use numbered steps for multi-step instructions
- Bold key UI element names
- No salutation or signature needed — Freshdesk adds those when the agent sends it
- If waiting on the client, draft a follow-up nudge instead

---

### Step 2.10 — Resolve Ticket

Only with explicit user confirmation:
```
freshdesk_update_ticket(ticket_id: ..., status: 4)   ← 4 = Resolved
```

---

## Error Cases

| Situation | Action |
|-----------|--------|
| `set_active_site` fails for the derived URL | Report to user, ask if the site URL needs adjustment |
| Ticket has no `company_id` | Check contact's `company_id`; if still missing, ask user for the site code |
| Ticket is already resolved per conversation | Flag it to the user — don't redo completed work |
| Issue is not Joomla-related | Summarize findings, note what was checked, ask user how to proceed |
| Missing info / client unresponsive | Present to user — may need to close or pend ticket |

---

## Conventions

- All Freshdesk notes are private (internal only) — there is no public reply option from the MCP
- Never guess at IDs — always look them up with list/search tools first
- Never change ticket status without user confirmation
- The draft client reply is always added as a note — the human agent sends the actual reply

---

## Joomla Backend Navigation (for client reply instructions)

When giving clients instructions for navigating the Joomla backend:

| Say this | Not this |
|---|---|
| **Article Manager** (button on the Control Panel dashboard) | "Content → Articles" |
| **Extensions → Modules** | "the module manager" |
| **Menus → [Menu Name]** | "the menu manager" |

Clients access the Article Manager via the shortcut button on the Joomla Control Panel homepage. Always say:
> "Go to the **Article Manager** from your dashboard, then search for..."
