---
name: feedback-fresh-menus
description: Menu builds must always create fresh client-named menus — never use or alter existing forge menus
metadata: 
  node_type: memory
  type: feedback
  originSessionId: fe262b60-2e8a-4da9-818b-5e9286eb8186
---

Phase 4 menu builds must always create fresh menus — never use or alter any existing menus on the forge site (mainmenu, tempsite-menu, hidden-menu, or any other pre-existing menu).

**Why:** Forge sites share template menus across multiple client builds. Altering an existing menu could break other sites or templates that depend on it.

**How to apply:** At the start of Phase 4, create client-named menus before building any items. Use names like "School Menu" / "School Hidden Menu" for a school site, "Church Menu" / "Church Hidden Menu" for a church site. Map the spec's `mainmenu`/`hiddenmenu` keys to the new slugs and record created IDs in the spec's `joomla_ids` block. See [[feedback-menu-build-workflow]] for the full rule.
