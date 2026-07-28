# KB — Site History & Audit Notes System

Every site has two separate records:

1. **Site notes** (`get_site_notes` / `write_site_notes`) — persistent site intelligence. Read at session start. Contains only facts that remain true over time.
2. **Audit notes** (`agent_audit`) — per-session records of what was done. Stored in their own container, never loaded at session start, retrieved on-demand when investigating.

---

## Site Notes — Persistent Facts Only

The site notes file lives at `docs/sites/[sitecode].solutiosoftware.com.md`. It answers one question: *"What do I need to know before touching this site?"*

**What belongs here:**
- Quirks and warnings (things that cause breakage if an agent doesn't know them)
- Key IDs (menus, outlines, categories, modules — looked up constantly)
- Active integrations (third-party services needing credentials or annual maintenance)

**What does NOT belong here:**
- Changelog entries (what was done in past sessions)
- Investigation notes
- Step-by-step records of agent actions

---

## File Template

Use this exact structure when creating a new site file:

```markdown
# Site: [sitecode].solutiosoftware.com

**Live domain:** (none yet — staging only) OR https://www.example.com  
**Site code:** [sitecode]  
**Launched:** (not yet) OR YYYY-MM-DD  
**Type:** Parish | School | Parish + School | Organization

---

## ⚠️ Quirks & Warnings

- *(nothing logged yet)*

## 🔗 Key IDs

| Item | ID |
|------|-----|
| Main Menu | — |
| Hidden Menu | — |
| Base Outline | — |
| Home Outline | — |
| Grid Outline | — |
| Site Outline (subpages) | — |
| Page Content category | — |
| Headlines/News category | — |
| Rotator category | — |
| Alert category | — |

## 🔌 Active Integrations

- *(none logged yet)*
```

---

## Persistent Section — What to Record

### ⚠️ Quirks & Warnings
Things that will cause breakage or confusion if an agent doesn't know them in advance:
- Menu items that reset `templateStyleId` when reordered
- Custom JS that conflicts with standard Joomla behavior
- Non-standard URL structures (e.g. Ministry Platform `/eventapp` requirement)
- Components with unusual configuration
- Outline inheritance that deviates from the standard pattern
- Known broken features the client has accepted

### 🔗 Key IDs
Fill in the IDs for the items every agent will look up constantly. Update this table as IDs are discovered. Examples:
- Menu IDs (main, hidden, secondary, footer)
- Outline IDs (base, home, grid, subpage, error, sponsors)
- Core category IDs (Page Content, Headlines, Rotator, Alert, Grid categories)
- Important module IDs (alerts module, ads modules, calendar)

### 🔌 Active Integrations
Third-party services connected to the site that require credentials, tokens, or annual maintenance:
- Elfsight widgets (widget ID, what social account, date connected — needs annual reconnect)
- Google Calendar / RokMini Events (service key file path, calendar ID)
- Ministry Platform (domain, whether Option 1 or Option 2 URL structure)
- AcyMail (if newsletter is active)
- Google Analytics (GA4 Property ID, measurement ID)
- reCAPTCHA (whether enabled)

---

## Updating Site Notes

When a persistent fact changes (new integration added, quirk resolved, IDs discovered):

1. Call `get_site_notes` to load the current file.
2. Edit the relevant section in context.
3. Call `write_site_notes` with the full updated content.

Do **not** use `append_site_note` for changelog entries — that tool is deprecated for this purpose. All session records go in audit notes.

---

## Audit Notes — Per-Session Records

Every session that touches a site must write one audit note to the Knowledge Gateway at session end. This is the single record combining what changed (changelog summary) and how it was done (detailed steps).

### Writing an Audit Note

```
agent_audit {
  action: "create",
  site_code: "SITECODE",
  agent_id: "super_shannon",                ← the agent scope that did the work
  task: "YYYY-MM-DD — [brief description, e.g. Ticket #35412 | Staff page update]",
  user_id: "[Name / email / 'internal']",
  original_request: "[the user's request, verbatim where practical]",
  task_notes: "..."
}
```

Audit notes go in `agent_audit`, which exists for exactly this purpose. **Do not write them to `knowledge_client`** — that container is read during normal work, so session narratives stored there are pulled into every context window that looks up a client fact.

### `task_notes` Format

```
**Ticket:** [#XXXXX or "none"]
**Summary of changes:**
- [What was changed — include IDs]
- [Another change]

**Session detail:**
[What was investigated before making changes, what tools were called, what was changed and in what order, any errors encountered and how resolved, decisions made and why, what was NOT done and why]
```

`user_id` carries the requester, so it no longer needs to be repeated in the body.

### Good Audit Note Example

`site_code: "stexample"`, `agent_id: "support"`, `task: "2026-03-14 — Ticket #35412 | Staff page update"`, `user_id: "jkowalski@stexample.com"`, and `task_notes`:

```
**Ticket:** #35412
**Summary of changes:**
- Article 47 (/about/staff) — added Fr. Marcus Reyes, Deacon Tom Hill, Mary Johnson to alternaterowsm table
- Article 44 (Fr. Bob Smithson) — unpublished; menu item 203 hidden

**Session detail:**
Ticket requested adding 3 new staff and removing 1. Read article 47 first to understand existing table structure (alternaterowsm, 2-column). Added three new rows for the new staff members with mailto: links from ticket. For Fr. Bob Smithson — client said "retired" so chose unpublish over delete to preserve URL history. Hidden menu item 203 so it no longer appears in nav. Client asked about photos during ticket conversation — not in scope for this session, referred to training docs.
```

### When to Write an Audit Note

Write one at the end of **every session** that touched the site — including investigation-only sessions. Even if nothing changed, record what was looked at and what was found.

### Retrieving Audit Notes

Audit notes are **never loaded at session start**. Retrieve only when investigating a problem or auditing past work:

```
agent_audit { action: "list", site_code: "SITECODE" }   ← summaries only (id, agent, task, date)
agent_audit { action: "get", id: 12 }                   ← full detail for one record
```

`list` deliberately returns summaries rather than full bodies, so scanning a site's history costs a few hundred tokens instead of tens of thousands. Pull the full record only for the session you actually care about.

---

## At Session End — Required Steps

1. **Update site notes** if any persistent fact changed (new IDs, new quirk, new integration). Use `write_site_notes`.
2. **Write one audit note** using `agent_audit { action: "create" }` — always, for every session that touched the site.
3. Announce to the user that the audit note has been written.
