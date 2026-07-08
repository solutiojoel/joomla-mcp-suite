# Site Notes: ourlady-ankeny.solutiosoftware.com

Notes logged by AI agents.

### 2026-07-08 — Ticket #33822 | McKenna Smith login — password reset email sent
**Requested by:** Abby Henderson (abby@olih.org) | **Ticket:** #33822
**Changes:**
- User #960 (mckenna@olih.org, groups: Admin/Basic Editor) was getting a login error on her original credentials. Sent a Joomla password reset email via joomla_user send_reset_email.
**Notes:** No follow-up needed unless she doesn't receive/complete the reset email — ask her to check spam if so.
_Logged by: local_

### 2026-07-08 — Ticket #33822 | McKenna Smith login — correction, account was disabled
**Requested by:** Abby Henderson (abby@olih.org) | **Ticket:** #33822
**Changes:**
- User #960 (mckenna@olih.org): explicitly set blocked=false (re-enabled). Previously sent a password-reset email, but that alone would not have fixed login since Joomla blocks disabled accounts before password checks.
**Notes:** Corrects earlier note in this file — root cause was account being disabled, not just a stale password. Both fixes now applied.
_Logged by: local_

### 2026-07-08 — Investigation only: MCP screenshot tool test
**Requested by:** internal (Jeremy) | **Ticket:** none
**Changes:**
- None — read-only. Captured one desktop screenshot of the homepage via joomla_get_frontend_screenshot as part of an MCP tool audit; capture succeeded and rendered correctly.
**Notes:** No follow-up needed.
_Logged by: local_
