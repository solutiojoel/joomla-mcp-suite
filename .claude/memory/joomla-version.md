---
name: joomla-version
description: Joomla version context — all client sites and forge environments run Joomla 3; no Joomla 4 or 5 in use anywhere
metadata: 
  node_type: memory
  type: project
  originSessionId: ce590e10-bab8-4901-b539-eb954df1cba8
---

All Joomla sites managed by this project (client sites and forge build/test environments) run **Joomla 3**. Joomla 4 and 5 are not used.

**Why:** Solutio Software's entire client base is on Joomla 3. No migration to J4/J5 is in progress.

**How to apply:**
- Do not write code that assumes Joomla 4/5-only features: `<joomla-field-status>` web components, Atum admin template, new `MenusController::rebuild`, Joomla 4 CSRF header changes, J4 `com_ajax` patterns, etc.
- Joomla 3 admin template is **Isis** (Bootstrap 2-based); look for `.accordion-heading`, `.nav-stacked`, `.alert.alert-success` etc.
- Joomla 3 success flash messages appear in redirect target HTML as Bootstrap alert divs — the exact text may differ from J4/J5 (e.g. "1 item(s) saved" vs "Menu item saved").
- `jform[published]` is a standard `<select>` in Joomla 3 (not the `<joomla-field-status>` web component used in J4/J5).
- `rebuildMenuTree` posts `task=menus.rebuild` — this DOES exist in Joomla 3's `MenusController` (unlike J4 where it was removed).
- System link menu item types (url, separator, alias) need `jform[type]` set to the plain type title string, not a base64-encoded JSON payload.
