# stpat-ic.solutiosoftware.com — Site Notes

## Key IDs
- Admin user group: id **10** ("Admin") — used for full backend access on this site. `joomla_group list` does not surface it (list only returned custom groups + Registered); confirmed via existing users' `groups` field instead.

## Quirks & Warnings
- Several legacy Admin accounts predate the email-username convention (e.g. `cheryl`, `angela`, `test`) — do not assume all existing usernames follow the `full-email` standard; only enforce it going forward on new/updated accounts.
- `joomla_user update`: omitting `block` from the call can silently flip `blocked` to `true`, and `requireReset` may not persist even when explicitly passed. Always pass `block` explicitly and verify with `get()` after any update. See knowledge_universal (tag: improvements) entry "joomla_user update: partial update silently blocks account + drops requireReset" (2026-07-22).

## Active Integrations
(none recorded yet)
