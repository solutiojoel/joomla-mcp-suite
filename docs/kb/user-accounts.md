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

**New-user training:** Point newly-created backend users to the Getting Started guide: https://solutiosupport.com/getting-started. Include this link in the client reply whenever a new admin/editor account is created — it's the standard onboarding resource sent to first-time users.

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

---

## Frontend Login Access — a separate permissions screen (Site Login)

Category/Article Permissions (above) and Access Levels (view levels) only control what a logged-in user can *see*. They do **not** control whether that user's group is allowed to log into the frontend at all.

That is a completely separate screen: **System → Global Configuration → Permissions tab**, which sets root-level actions per group (Site Login, Admin Login, Super Admin, etc.), independent from the Category Manager Permissions tab.

**Symptom if this is missed:** a brand-new custom user group (e.g. a shared "Parents" login group created for a gated portal) can have a correct Access Level, correct category/article access, and a valid enabled user account — and login will still fail or land on an access-denied page, because the group was never granted **Site Login**. It's easy to misdiagnose this as a content/category ACL problem (checking Access Levels, category permissions, article access) when the real blocker is upstream at the login gate itself. Built-in groups (Public, Registered) get Site Login by default; new custom groups do not automatically inherit it just by sitting alongside them in a flat hierarchy.

**When debugging any login/access issue for a custom user group:** check Global Configuration → Permissions for that group's Site Login setting *before* assuming the fix is at the category/article/Access-Level layer.

The orchestrator has no tool for this screen — it must be checked/changed manually by a human in the Joomla admin (confirmed 2026-07-21, ticket #35648 / Holy Trinity School Lenexa Parent Portal).
