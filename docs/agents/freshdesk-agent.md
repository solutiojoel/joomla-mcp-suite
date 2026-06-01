# Support Agent Workflow

## Overview

This guide describes the full support ticket resolution workflow using the `freshdesk` and `joomla` MCP servers together. Follow these steps in order every time a user provides a ticket ID.

---

## Step 1 — Load Ticket Context

When the user provides a ticket ID — even for a simple request like "draft a response" or "add a note" — always call these three in parallel before doing anything else:

```
freshdesk_get_ticket(ticket_id)
freshdesk_get_contact(requester_id)   ← use requester_id from the ticket
freshdesk_get_conversations(ticket_id)
```

**Never skip `freshdesk_get_conversations`.** Prior notes and replies often contain completed work, client responses, or context that changes what the appropriate action is.

Then load the company using `company_id` from the ticket (fall back to contact's `company_id` if the ticket has none):

```
freshdesk_get_company(company_id)
```

Announce a brief summary before doing anything else:

> **Ticket #XXXX — [Subject]**
> Status: [status_label] | Priority: [priority_label]
> Requester: [name] <[email]>
> Company: [company name] → site: `[site_code]` (`[site_url]`)

---

## Step 2 — Switch to the Client Site

Use the `site_url` returned by `freshdesk_get_company` to switch the active site:

```
set_active_site(url: "[site_url from company]")
get_active_site()   ← always confirm the switch
```

Announce the confirmed active site. If `set_active_site` fails or returns the wrong site, stop and report the error to the user — do not proceed with Joomla work.

---

## Step 3 — Read Site Notes

```
get_site_notes()
```

Review any known quirks for this site before starting investigation.

---

## Step 4 — Research the Issue

**Before investigating:** Call `resources/list` and check whether any KB doc under `kb/` matches the issue type (e.g. `kb/docman.md` for DOCman issues, `kb/akeeba.md` for backup issues). If a match exists, fetch it — it contains known solutions and pitfalls for that area.

Read the full ticket description and conversation thread, then investigate using Joomla tools. Common starting points by issue type:

- **Article / content missing or wrong**: `joomla_article(action: "list", search: "...")`, `joomla_article(action: "get", id: ...)`
- **Page not found / menu broken**: `joomla_list_menus()`, `joomla_list_menu_items(menuId: ...)`
- **Module not showing / wrong position**: `joomla_list_modules()`, `joomla_get_module(id: ...)`
- **Visual / layout issue**: `joomla_get_frontend_page(path: "...")`, screenshot tools
- **General site overview**: `joomla_backend_inventory()`

Dig until you have identified a root cause or have a confident hypothesis. If the issue is ambiguous, summarize what you found and what remains unclear.

---

## Step 5 — Present a Plan

**Do not make any changes until the user explicitly approves.**

Present a clear plan including:

1. **Root cause** — what you found and why it is causing the issue
2. **Proposed changes** — specific items (article ID, module ID, menu item ID, field name, new value)
3. **Risks or caveats** — anything that could have side effects

End with: *"Would you like me to proceed with this plan?"*

---

## Step 6 — Execute

Once the user approves:

- Make changes using appropriate Joomla tools
- After each significant change, verify with `joomla_get_frontend_page` or a screenshot
- Use `joomla_update_*` (never delete + recreate — this breaks aliases and can break menu links)
- If any step fails or produces unexpected results, stop and report before continuing

---

## Step 7 — Document and Close

After all work is complete:

**1. Site note** (if you discovered something non-obvious):
```
append_site_note(note: "...", category: "...")
```

**2. Freshdesk note** (always — document what was done):
```
freshdesk_add_note(
  ticket_id: ...,
  body: "<p><strong>Issue:</strong> ...</p><p><strong>Resolution:</strong> ...</p>"
)
```

The note should include:
- What the issue was
- What was changed (with specific IDs, titles, or paths)
- Any follow-up recommended for the client

**3. Recommended reply note** (always — draft the reply for the human agent to send):
```
freshdesk_add_note(
  ticket_id: ...,
  body: "<p><strong>Recommended Reply to [Client Name]:</strong></p><p>...</p>"
)
```

- Write the reply as the human agent would send it — no salutation, no signature (Freshdesk adds those automatically)
- Keep it concise and client-friendly
- If the ticket is waiting on the client (e.g. pending info), draft a follow-up nudge instead

**4. Update ticket status** (only with user confirmation):
```
freshdesk_update_ticket(ticket_id: ..., status: 4)   ← 4 = Resolved
```

---

## Error Cases

| Situation | Action |
|-----------|--------|
| `set_active_site` fails for the derived `site_url` | Report to user, ask if the site URL needs adjustment |
| Ticket has no `company_id` | Check contact's `company_id`; if still missing, ask user for the site code |
| Freshdesk API 401 | Check `FRESHDESK_DOMAIN` and `FRESHDESK_API_KEY` in server env |
| Issue is not Joomla-related | Summarize findings, note what was checked, ask user how to proceed |

---

## Conventions

- All Freshdesk notes are always private (internal only) — there is no public reply option
- Do not change ticket status without asking the user
- Never guess at IDs — always look them up with list/search tools first
- Prefer `description_text` (plain text) for reading; `description` (HTML) is available if formatting matters
