# KB — Site History & Change Log System

Every site has a dedicated notes file at `docs/sites/[sitecode].solutiosoftware.com.md` (or the live domain if the site has launched). This file is the authoritative record of the site's state and history. Agents read it at session start and write to it at session end — always, not just when something unusual is found.

---

## Two-Layer Structure

Each site file has two clearly separated sections:

### Layer 1 — Persistent Site Intelligence (top of file)
Facts that remain true over time. Updated in-place using `write_site_notes` when they change. This section answers: *"What do I need to know before touching this site?"*

### Layer 2 — Change Log (bottom of file)
Dated entries appended newest-first using `append_site_note`. This section answers: *"What has happened to this site and when?"*

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
|------|----|
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

---

## 📅 Change Log

*(No entries yet — first entry will appear below after the first session)*
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
- Elfsight, Flocknote, LPI Bulletin Widget, etc.

---

## Change Log — What Triggers an Entry

**Always write an entry when:**
- A Freshdesk support ticket is resolved (required — see `freshdesk-agent.md`)
- Any content change was made (articles created/updated/deleted)
- Any structural change was made (new menu items, modules, categories, outlines)
- Any configuration change was made (reCAPTCHA, GA4, Business Directory passcode, site title/meta)
- Any FTP file was uploaded (custom CSS, JS, images, service keys)
- A site was launched or redesign went live

**Write a shorter entry when:**
- The session involved only investigation with no changes made
- Something important was discovered that future agents need to know (add to Quirks too)

**Skip the changelog only when:**
- Nothing was changed and nothing new was learned about the site

---

## Change Log Entry Format

Append entries using `append_site_note`. Each entry must follow this format:

```
### YYYY-MM-DD — [Ticket #XXXXX | ] [Brief title of what was done]
**Requested by:** [Name / email / "internal"] | **Ticket:** [#XXXXX or "none"]
**Changes:**
- [Specific thing changed — include IDs where relevant]
- [Another specific thing changed]
**Notes:** [Anything non-obvious, quirks found, client preferences noted, follow-up needed]
```

### Good Entry Examples

```
### 2026-06-04 — Ticket #35412 | Staff page — added 3 members, removed 1
**Requested by:** Janet Kowalski (jkowalski@stexample.com) | **Ticket:** #35412
**Changes:**
- Article 47 (/about/staff) — added Fr. Marcus Reyes, Deacon Tom Hill, Mary Johnson to alternaterowsm table
- Article 44 (Fr. Bob Smithson) — unpublished per client request (retired); menu item 203 hidden
- New staff linked via mailto: tags (email addresses provided in ticket)
**Notes:** Client asked about adding photos — referred to training docs. No photos added this session.
```

```
### 2026-05-15 — Grid layout built for Faith Formation section
**Requested by:** Internal (site build) | **Ticket:** none
**Changes:**
- Category "Faith Formation Items" (ID 35) created with 8 articles (IDs 175–182)
- Gantry 5 Particle module created (ID 88) — Joomla Articles particle, position CONTENT-BOTTOM-A
- Module assigned to menu item 167 (Faith Formation landing page)
- Module class suffix: grid-tiles grid-square grid-tiles-mobile
**Notes:** Grid outline (ID 34) confirmed existing and correctly configured before build.
```

```
### 2026-04-02 — reCAPTCHA enabled
**Requested by:** Internal (pre-training audit) | **Ticket:** none
**Changes:**
- reCAPTCHA v2 checkbox enabled via plugin — site key and secret key loaded from Google Cloud project
- From Email set to office@stexample.com in Site Config (required for password reset emails)
**Notes:** Domains registered: stexample.com and sitecode.solutiosoftware.com
```

### Entry Anti-Patterns to Avoid

❌ Too vague — agents can't act on this:
> "Updated some staff articles per client request."

❌ No IDs — next agent has to search for everything:
> "Fixed the menu item that was broken."

❌ Missing the requester — no accountability trail:
> "Added a new module to the homepage."

✅ Specific, with IDs, with requester — complete record:
> "Article 47 (/about/staff) — updated alternaterowsm table: added Fr. Marcus Reyes; menu item 203 (Fr. Bob Smithson) hidden at client request (retired). Ticket #35412, Janet Kowalski."

---

## Updating the Persistent Section

When a persistent fact changes (e.g. a new integration is added, a quirk is resolved, IDs are discovered):

1. Call `get_site_notes` to load the current file.
2. Edit the relevant section in context.
3. Call `write_site_notes` with the full updated content.
4. Then append a changelog entry noting what changed.

Do **not** update persistent facts by appending — the persistent section must remain clean and current, not accumulate outdated entries.

---

## At Session End — Required Steps

Before closing any session on a site, in this order:

1. **Update persistent facts** if anything was discovered (new IDs, new quirk, new integration). Use `write_site_notes`.
2. **Append a changelog entry** using `append_site_note`. Even if the session was investigative-only, note what was looked at and what was found.
3. Announce to the user that the site log has been updated.

This is not optional. The site file is the memory of the site between sessions. If it isn't written, the next agent starts blind.
