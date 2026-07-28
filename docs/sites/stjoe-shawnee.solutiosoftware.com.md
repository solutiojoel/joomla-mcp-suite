# Site: stjoe-shawnee.solutiosoftware.com

**Live domain:** https://school.stjoeshawnee.org/school (school subsite)
**Site code:** stjoe-shawnee
**Launched:** (date unknown — pre-existing site)
**Type:** Parish + School

> Session history lives in `agent_audit { action: "list", site_code: "stjoe-shawnee" }` —
> this file holds persistent facts only.

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
| Capital Campaign Home outline | 23 |
| Homepage slider — Swiper particle | `swiper-6123` (in outline 23) |
| Rotator - Capital Campaign category | 84 |

**Homepage slider:** the Capital Campaign slider is the Swiper particle `swiper-6123` on outline 23, pulling articles from category 84 sorted by `ordering ASC`. To add, remove, or reposition a slide, publish/unpublish/reorder articles in category 84 — do not edit the particle.

## 🔌 Active Integrations

- *(none logged yet)*
