# Site: stjoe-shawnee.solutiosoftware.com

**Live domain:** https://school.stjoeshawnee.org/school (school subsite)
**Site code:** stjoe-shawnee
**Launched:** (date unknown — pre-existing site)
**Type:** Parish + School

---

## ⚠️ Quirks & Warnings

- **CHAPELS mega menu drag-and-drop resets outline.** Reordering any item in the CHAPELS mega menu (ID 388) via Joomla Menu Manager's drag-and-drop can silently reset that item's `templateStyleId` to 0, causing it to render with the wrong Gantry outline. After any reordering operation, verify each affected menu item still has `templateStyleId = 27` (Clarity - Site Outline/Base) and manually re-set it if needed.
- **CHAPELS menu is a flat list.** Item ID 388 has all ministry pages as direct children — there is no real hierarchy. Visual columns are purely positional, controlled by `gantry-columns_count` on item 388. Current column counts: `[12, 3, 16, 7, 8, 20, 7]`.

## 🔗 Key IDs

| Item | ID |
|------|----|
| CHAPELS mega menu parent | 388 |
| Seven Sisters Apostolate | 423 (in Practice of Prayer section, after ID 429) |
| Parish Vocation Ministry | 429 |
| Required templateStyleId for all CHAPELS pages | 27 (Clarity - Site Outline/Base) |

## 🔌 Active Integrations

- *(none logged yet)*

---

## 📅 Change Log

### 2026-05-22 — Seven Sisters Apostolate moved within CHAPELS menu
**Requested by:** Internal | **Ticket:** none
**Changes:**
- Menu item 423 (Seven Sisters Apostolate) moved from Acts of Mercy section to Practice of Prayer section, positioned after Parish Vocation Ministry (ID 429)
- Reason: Seven Sisters is a prayer ministry, not a charity ministry — incorrect categorization
**Notes:** CHAPELS menu drag-and-drop quirk confirmed — `templateStyleId` must be verified after any reorder. All affected items confirmed at templateStyleId 27 after this move.
