# Site: magdalen.solutiosoftware.com

**Live domain:** magdalenwichita.com
**Site code:** magdalen
**Type:** School (St. Mary Magdalen, Wichita)

> Session history lives in `agent_audit { action: "list", site_code: "magdalen" }`.
> This file holds persistent facts only. The pre-2026-07-28 narrative version (three
> 2026-06-09 Ticket #35153 sessions) is archived verbatim at `agent_audit { action: "get", id: 46 }`.

---

## ⚠️ Quirks & Warnings

- **A teacher change touches seven places.** Replacing a faculty member here is never a single edit — see the checklist below. Missing any one of them leaves the old teacher's name visible somewhere on the site.
- **`school-menu-cl` item 636 ("Terry Bolinger") has parentId 616**, which is now titled "Macy Bartel". This is a pre-existing structural oddity, not a mistake introduced by a rename — leave it unless the client asks.
- **Classroom page articles have empty bodies** (e.g. Kindergarten 36609, 4th Grade 36631, MS Science 36644). There is no teacher-specific text in them; category renames cascade to these pages automatically, so they need no edit on a teacher change.
- **Old teacher user groups are left in place** when an account is disabled (e.g. 118, 113, 22, 121). They stay tied to the now-blocked account rather than being deleted.

## ✅ Teacher Replacement Checklist

For each departing → arriving teacher:

1. **Contact** (`com_contact`, School Staff category) — name, role, email, alias.
2. **Side contact info article** — title + name/email in body (e.g. "Bartnick Side Contact Info" → "Kuchinskas Side Contact Info").
3. **Teacher category** — e.g. "Kellie Bartnick - Kindergarten" → "Lisa Kuchinskas - Kindergarten".
4. **Side menu items category** — e.g. "Bartnick Side Menu Items" → "Kuchinskas Side Menu Items".
5. **Menu items — two menus:** `school-menu-cl` (the teacher's nav entry) *and* `school-sub-cl` (the "Grade - Teacher Name" entry).
6. **User account** — block the departing account; create the arriving one with `requireReset=true`.
7. **User group** — create a group named for the new teacher, grant all 5 permissions on their teacher category, and add them to it alongside Manager plus their grade-level group.

Departing staff are **unpublished, not deleted** (contact, side info article, categories, menu items, and any personal articles such as "Hocker Happenings").

## 🔗 Key IDs

| Item | ID |
|------|-----|
| Menus | `school-menu-cl` (teacher nav), `school-sub-cl` (grade-teacher entries) |
| Manager group | 12 |
| Kindergarten group | 93 |
| Specials group | 100 |

Per-teacher categories, groups, contacts, and articles are numerous and change with staffing — look them up live rather than trusting a stale table here.

## 🔌 Active Integrations

- **MailChimp** — staff changes require a corresponding spreadsheet update (handled outside Joomla).
