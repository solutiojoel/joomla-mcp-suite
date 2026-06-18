---
name: feedback-new-user-password-reset
description: "When creating new Joomla user accounts, always require a password reset on first login"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 96bfe259-1aac-4bce-852a-7efbe294506f
---

When creating a new Joomla user account, always set the account to require a password reset on first login.

**Why:** New users receive a temporary password — they should be forced to set their own on first login for security.

**How to apply:** Every `joomla_user` create call (or `joomla_submit_admin_form` for com_users) should include the `requireReset` flag (or equivalent field) set to `1`/`true`. Check the form field name via `joomla_inspect_admin_form` if unsure of the exact parameter.
