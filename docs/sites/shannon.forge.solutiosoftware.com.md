# Site Notes: shannon.forge.solutiosoftware.com

Notes logged by AI agents.

### 2026-06-15 — Phase 4: Menu skeleton build (sh-emporia-menu-spec.json)

**Requested by:** internal | **Ticket:** none

**Changes:**
- Created 3 article categories: News & Events (ID 53), Faculty & Staff (ID 54), Parents (ID 55)
- Created 31 placeholder articles across categories
- Deleted errant "Page Articles" category (ID 52)
- Created Shannon menu (menuType: shannon, ID 7) for mainmenu structure
- Created 39 menu items in shannon mainmenu:
  - Top-level headings/items: About Sacred Heart School (185), Admissions & Academics (186), Support Us (187), Capital Campaign (188), Sponsors (184)
  - Grid landing pages: Parents (183)
  - Children under About SH: 7 items (Welcome, Why Choose, Faculty & Staff grid, History, Contact Us, Commission, Alumni) — IDs 190–196
  - Children under Admissions: 8 items (Request Info, Registration, Financial Aid, Curriculum, Specials, Preschool, Accreditations, KSDE Reports) — IDs 197–204
  - Children under Support Us: 3 items (Donate, Mexican Supper, Feast) — IDs 205–207
  - Children under Parents: 10 items (Parent Login, Handbook, Calendar alias, Lunch Menus, Virtus, PTO, Extended Care, Dress Code, Pickup/Dropoff, Supply Lists) — IDs 208–217
- Created 1 menu item in hidden-menu: Church (189, external URL to shemporia.org)
- Orphaned News & Events children at top level (IDs 218–221): Calendar, Weekly Newsletter, Lunch Menu, Parish News — **needs parent assignment**

**Notes:** News & Events menu item creation failed repeatedly despite multiple attempts (article and heading types both failed); children were created orphaned. Grid modules (News & Events, Faculty & Staff, Parents) not yet configured. Phase 4 gate passed: all menus exist, categories created, 31/31 articles created, 39/40 menu items created (News & Events parent pending).
_Logged by: local_

### 2026-06-15 — Phase 4 skeleton build complete (sh-emporia-menu-spec.json)
**Requested by:** internal | **Ticket:** none
**Changes:**
- 3 categories created: News & Events (ID 53), Faculty & Staff (ID 54), Parents (ID 55)
- 31 placeholder articles created across Page Content, News & Events, Parents, Faculty & Staff categories
- 40 of 40 menu items created in `shannon` menu (mainmenu spec key maps to `shannon` menuType on this forge site)
- News & Events heading (ID 223, alias: news-events-sh) — required 6 attempts due to alias collisions from trashed items holding alias slots
- Children Calendar (218), Weekly Information & Newsletter (219), Lunch Menu (220), Parish News (221) were initially orphaned at root; re-parented to ID 223 after parent confirmed
- Calendar (218) was trashed during re-parent pass; republished separately
- News & Events ordering fixed to position 2 (after About Sacred Heart School ID 185)
**Notes:** Forge `mainmenu` is a shared template menu — all items must go in the site-specific `shannon` menu. Trashed items hold their aliases in Joomla — a deleted item blocks the same alias until permanently purged; use a fresh suffix on retry. Phase 5 (content) and grid module configuration are pending.
_Logged by: local_
