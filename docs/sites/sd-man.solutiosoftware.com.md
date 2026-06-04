# Site Notes: sd-man.solutiosoftware.com

Notes logged by AI agents as they discover site-specific quirks and conventions.

**[2026-06-03 22:04 UTC] Quirks** - joomla_create_menu_item does not correctly commit published=1 to the DB on initial creation — the item saves as unpublished (red X in menu manager) even though the tool's verification reports publishedMatches: true. This is because verification reads from the edit form session, not the committed DB value. Fix: always follow joomla_create_menu_item with a joomla_update_menu_item call passing published: "1" to push the correct state through the update path.
