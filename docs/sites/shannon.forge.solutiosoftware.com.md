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

### 2026-07-08 — Joomla MCP tool audit (Docman / media / fileman / screenshot)
**Requested by:** internal (Jeremy) | **Ticket:** none
**Changes:**
- Test artifacts created and fully cleaned up: DOCman category "ZZ-MCP-AUDIT Test Category" (ID 4, deleted), DOCman document "ZZ-MCP-AUDIT Test Document" (ID 6, deleted), media folder images/stories/zz-mcp-audit (deleted via direct POST — the joomla_media folder-delete payload is broken, see notes)
- No content, menu, or config changes
**Notes:** Audit findings: (1) com_media file uploads on this site are rejected server-side with non-core message "Cannot upload at this time" — joomla_media upload/rename/move are all blocked here; FILEman (Joomlatools) is installed and its JSON API (index.php?option=com_fileman&view=files&folder=<path>&format=json) works for listing. (2) FILEman container "fileman-files" = images/stories = com_media root on this site. (3) joomla_media delete with type:folder sends the wrong payload (folder=<target>, cb1:0); correct J3 payload is folder=<parent> + rm[]=[name] — verified working. (4) DOCman JSON tools all pass (list/get/create/update/delete). (5) Frontend screenshot tool passed desktop/tablet/mobile including 404 handling.
_Logged by: local_

### 2026-07-08 — joomla-mcp bug fixes verified (follow-up to tool audit)
**Requested by:** internal (Jeremy) | **Ticket:** none
**Changes:**
- Verified three joomla-mcp code fixes against this site (all test artifacts removed): media folder zz-mcp-audit2 created and deleted via joomla_media (folder-delete payload now folder=<parent> + rm[]=[name] — works); DOCman doc ID 7 created without access param → now defaults to access "1" (Public) — deleted after check; joomla_fileman_list_files now uses the FILEman JSON API (root/subfolder/missing-folder all correct, returns size/mimetype/modified metadata)
- No lasting content changes
**Notes:** com_media file upload (and therefore joomla_media rename/move) remains blocked on this site by the server-side "Cannot upload at this time" rejection — separate issue, likely FILEman/Koowa intercepting com_media uploads. FILEman upload API route still undetermined.
_Logged by: local_

### 2026-07-09 — Staff grid page built out (placeholder content)
**Requested by:** internal (Jeremy) | **Ticket:** none
**Changes:**
- Created 6 placeholder staff articles in "Staff Items" category (ID 30): Fr. John Smith/Pastor (154), Jane Doe/Parish Secretary (155), Mary Johnson/Business Manager (156), Robert Williams/Director of Religious Education (157), Susan Brown/Music Director (158), David Martinez/Facilities Manager (159)
- Each article body follows kb/staff-grid format exactly: bold centered name, italic title, linked tel:/mailto: placeholders (000-000-0000 / placeholder@example.com)
- Set introImage + featuredImage on all 6 articles to the existing `/images/stories/staff/blank_person.jpg` (site's own "No Picture Available" graphic) — no new upload needed
- Set ordering: 154 first, then 155→159 sequentially
- No menu item, module, or category changes needed — "Staff" menu item (ID 145, under About Us/111) and "Staff Grid" module (ID 127, Gantry particle, content-bottom-a, category 30, assigned to 145) already existed pre-configured and correct
- Verified live at https://shannon.forge.solutiosoftware.com/about-us/staff — screenshot confirms 4-col grid, card shadows, rounded corners, centered text all rendering per kb/staff-grid spec
**Notes:** Page is placeholder-only — phone/email are dummy values and photos are the generic silhouette graphic. Real headshots and contact info still need to be swapped in by the client/team. No follow-up needed on the build itself.
_Logged by: local_

**[2026-07-09 17:07 UTC | local]** Routing quirk discovered on shannon.forge: the "Staff" menu item (ID 145) is nested under the "About Us" separator (ID 111), so its SEF URL is `/about-us/staff` — the bare `/staff` path 404s. Same is likely true for its siblings (Links=125, Contact Us=157) and other nested single-article pages under separator/heading parents. When verifying frontend content on this site, always use the full nested path (or the non-SEF `index.php?option=com_content&view=article&id=X&Itemid=Y` form) rather than assuming a top-level alias path.

Also: the site history entries from 2026-06-15 (Phase 4 menu skeleton build referencing "Sacred Heart School" menu items — About Sacred Heart School, Admissions & Academics, Faculty & Staff grid IDs 190-221, categories 53/54/55) do NOT match the current live state of this site. The live `shannon` menu today (46 items) is a generic parish-template structure (Home/About Us/News/Sacraments/Ministries/Faith Formation/Sponsors) with none of those IDs present, and category 54 no longer resolves. Likely this forge site was reset/reprovisioned to a base template after those notes were written, or the notes describe a different environment. Treat those older entries as stale until reconciled — don't assume those IDs/menu items still exist without checking live state first.

### 2026-07-09 — Ministries grid page built from scratch (new category + module)
**Requested by:** internal (Jeremy) | **Ticket:** none
**Changes:**
- Created new category "Ministries Items" (ID 50)
- Created 6 placeholder ministry articles in category 50: Altar Servers (160), Music Ministry (161), Eucharistic Ministers (162), Knights of Columbus (163), Youth Ministry (164), Hospitality Ministry (165) — each a short generic placeholder blurb, ordered sequentially
- Set introImage + featuredImage on all 6 to the existing `/images/stories/template/default-grid.jpg` (site's purpose-built generic grid placeholder photo) — no upload needed
- Created new Gantry particle module "Ministries Directory Grid" (ID 147), contentarray particle pointed at category 50, moduleclass_sfx matching the sitewide "topic tile" grid pattern (grid-no-text, image-border-radius, hover-scale) used by Sacraments Grid (module 125) — assigned only to Ministries menu item (166), position content-bottom-a
- Left the pre-existing "Ministries Grid" module (ID 145, points at dead category 49) unpublished-in-effect (renders 0 articles) and untouched, per explicit instruction — both modules now occupy content-bottom-a but 145 is invisible since its category has no content
- Verified live at https://shannon.forge.solutiosoftware.com/ministries — full-width 3-column tile grid, matches Sacraments Grid styling
**Notes:** Module 145 is dead weight (broken category reference) — should eventually be cleaned up (deleted or repointed) once the client confirms real ministries content, to avoid two grid modules stacked in the same position long-term. Photos are the generic site placeholder image, not real ministry photos — flag for follow-up when real assets exist.
_Logged by: local_

**[2026-07-09 17:27 UTC | local]** Gantry outline quirk on shannon.forge: in the "Studius - #Grid" outline (template style ID 34, used by Sacraments/Ministries-type pages), position `content-bottom-a` renders full content width, but `content-bottom-b` renders in a narrow, right-shifted column (large empty gap on the left) — not a simple stacked full-width secondary slot as you'd expect from the position name. Confirmed by placing a working grid module in content-bottom-b and comparing against content-bottom-a on an equivalent page. When adding a second Gantry particle module to a #Grid-outline page, default to content-bottom-a unless there's a reason it must be visually separate, and screenshot-check before assuming content-bottom-b behaves like a normal second content row.

Also: joomla_article create verification (readback check) failed for all 6 ministry articles when fired as parallel/concurrent tool calls in one batch, even though every article was actually created correctly (confirmed via category list + individual get). Likely a race condition in the readback logic under concurrent writes. Workaround: if bulk-creating articles, either create sequentially or treat "creation was not verified" errors as needing a manual list/get check rather than an actual failure — don't retry-create on this error without checking first (retrying could create duplicates).

### 2026-07-09 — Resources grid page built on Hidden Menu (test/practice build, placeholder content)
**Requested by:** internal (Jeremy) | **Ticket:** none
**Changes:**
- Created landing article "Resources" (ID 166, category 31 "Page Content (Menu Item Needed)", empty body) — same pattern as Staff/Ministries landing articles
- Created new category "Resources Items" (ID 51, parentId 1)
- Created 3 placeholder articles in category 51: Financial Assistance (167), Food Pantry (169), Counseling Services (170) — short blurb + `/images/stories/template/default-grid.jpg` placeholder image on each, ordered sequentially
- Created menu item "Resources" (ID 173) in the `hidden-menu` menu, Single Article type → article 166, templateStyleId 34 (Studius - #Grid), parentId "1" (top-level within hidden-menu, matching existing "Items"/"Subscribe" siblings)
- Created new Gantry particle module "Resources Directory Grid" (ID 148), contentarray particle pointed at category 51, position `content-bottom-a` (applied the content-bottom-a lesson from the Ministries build up front this time), moduleclass_sfx matching the sitewide tile-grid pattern (Sacraments/Ministries style), assigned only to menu item 173
- Verified live at https://shannon.forge.solutiosoftware.com/resources — 3-tile full-width grid, correct styling, correctly absent from the visible top nav (hidden-menu item)
**Notes:** Confirmed via live data that category 50 "Ministries Items" (from the earlier Ministries build) is a genuinely separate, new category from category 49 "Get Involved Items" — no category reuse occurred there. Also corrected an earlier assumption: category 49 is not deleted/dead, it's a real published category that is simply empty (0 articles) — the old "Ministries Grid" module (145) renders nothing because its category has no content, not because the category doesn't exist. Placeholder-only build; real resource content/links still needed from client.
_Logged by: local_
