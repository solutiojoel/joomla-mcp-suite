# Site Notes: stjoe-shawnee.solutiosoftware.com

Notes logged by AI agents as they discover site-specific quirks and conventions.

**[2026-05-22 18:47 UTC] Menus** — CHAPELS mega menu (item ID 388) is a flat list — all ministry items are direct children of ID 388. Visual columns are purely positional, controlled by gantry-columns_count on the parent item. Current counts: [12,3,16,7,8,20,7]. WARNING: Drag-and-drop reordering in Joomla Menu Manager can reset a menu item's templateStyleId to 0, causing the page to render with the wrong Gantry outline. All CHAPELS ministry pages should have templateStyleId explicitly set to 27 (Clarity - Site Outline/Base). If a page layout breaks after reordering, go into the menu item and re-set templateStyleId to 27. Seven Sisters Apostolate (ID 423) was moved from Acts of Mercy to Practice of Prayer section (after Parish Vocation Ministry ID 429) on 2026-05-22 — it's a prayer ministry, not a charity ministry.
