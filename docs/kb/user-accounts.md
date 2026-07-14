# KB — User Accounts & Permissions

How to create user accounts, groups, and set category/article-level permissions on Solutio sites.

---

## User Account Creation

Users can be created manually in Joomla or imported via CSV. For bulk creation (e.g., new site trainings), use the import spreadsheet:
https://docs.google.com/spreadsheets/d/1xoP6LY6g8wRJZHgEGrNaa_CwJ4WGmQP0ybQ2PtvoL5E/edit

The same spreadsheet generates a CSV for email list import.

**Username convention:** Always set the username to the user's full email address (e.g., `lkuchinskas@magdalenwichita.com`). Do not use short usernames like `lkuchinskas`.

**User groups at creation:** Assign users to one of:
- **Basic Editor** (or Manager) + a user group specific to their category(ies)
- **Admin** — for full backend access

Note: `Registered` is the default Joomla group but does **not** grant backend access. Do not assign clients to Registered.

**Require password reset:** `joomla_user create` sets `requireReset` to `1` by default (pass `requireReset: false` to disable). This forces the user to choose their own password on first login. `joomla_user get`/`create`/`update` now read back and verify this flag (fixed and confirmed 2026-07-10) — no manual fallback needed.

**After creating users:** Add them to the Email Lists Spreadsheet so Lori can add them to MailChimp.

---

## Category-Level Permissions

If a user should access an **entire category**:
- Allow all 6 permission settings on the user group for that category.
- Child categories automatically inherit parent permissions.

If a user should access only **specific articles** within a category:
- Set permissions on individual articles (allow or deny per article).
- Other articles in the category will appear grayed out to that user.

---

## Teacher/Staff User Groups

See `teacher-pages.md` for the full teacher user group setup. Key rules:
- Name user groups by grade and teacher last name (e.g., `3A-Smith`) — easy to update when staff turns over.
- Grant permission on the **parent category** only — children inherit.
- Assign **Basic Editor** as the user role.

---

## Podcast Manager User

For podcasting access across all sites:
- Username: `manager`
- Password: `portal3pod`

---

## How to Set Permissions

1. Go to **Category Manager** → select the category → click **Permissions** tab.
2. Select the user group → set each action (Create, Delete, Edit, etc.) to Allow or Deny.
3. Save. Child categories inherit automatically.

For article-level overrides: open the article → **Permissions** tab → set per user group.
