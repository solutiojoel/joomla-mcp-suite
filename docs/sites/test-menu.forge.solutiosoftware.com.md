# Site Notes: test-menu.forge.solutiosoftware.com

Notes logged by AI agents.

### 2026-06-16 — Phase 4 Menu Skeleton Build — Sacred Heart Emporia
**Requested by:** internal | **Ticket:** none
**Changes:**
- Created menus: School Menu (ID 7, `school-menu`), School Hidden Menu (ID 8, `school-hidden-menu`)
- Created categories: Page Content (ID 54, alias `page-content-she`), Faculty & Staff (ID 50), Parent Grid Items (ID 51), Sponsors (ID 52), School News & Events (ID 53)
- Created 36 placeholder articles in Page Content (IDs 154–189); landing pages: Faculty & Staff (186), News & Events (187), Parents (188), Sponsors (189)
- Created 40 menu items in school-menu (IDs 179–218) and school-hidden-menu (ID 186)
- Top-level school-menu: About Sacred Heart School (179, heading), News & Events (180, single article), Admissions & Academics (181, heading), Parents (182, single article), Support Us (183, heading), Capital Campaign (184), Sponsors (185)
- All children created with correct parentIds; alias collisions handled with -she suffix
**Notes:** News & Events reclassified from heading to category_grid (category: School News & Events, member_menu_items: listed) per user correction mid-session. "Parents" and "News & Events" are edge-case grid landing pages with children retained as sub-menu items. Spec saved at workspace/she-menu-spec.json. Deferred: TopLinks targets, Under Rotator targets (3 of 5), Faculty & Staff content/photos from client.
_Logged by: local_

### 2026-06-18 — Phase 4 Menu Skeleton Build — Sacred Heart Emporia (redo)
**Requested by:** internal | **Ticket:** none
**Changes:**
- Created menus: School Menu (ID 9, `school-menu`), School Hidden Menu (ID 10, `school-hidden-menu`)
- Created categories: Faculty & Staff (ID 55, alias `faculty-staff-she`), Sponsors (ID 56, alias `sponsors-she`); reused existing Page Content (ID 54, alias `page-content-she`)
- Created 31 placeholder articles in Page Content (IDs 190–220): Welcome from the Principal (190), Why Choose Sacred Heart? (191), Our History (192), Contact Us & Directions (193), Sacred Heart School Commission (194), Alumni (195), Calendar (196), Weekly Information & Newsletter (197), Lunch Menu (198), Request Information (199), Registration (200), Financial Aid & Tuition (201), Curriculum (202), Specials (203), Preschool & Child Care Center (204), Accreditations (205), KSDE Accountability Reports (206), Parent Login (207), Parent/Student Handbook (208), Lunch Menus & Information (209), Virtus (210), PTO (211), Extended Care (212), Dress Code (213), Pick Up/Drop Off (214), Supply Lists (215), Donate (216), Mexican Supper (217), Feast for Our Future (218), Faculty & Staff landing (219), Sponsors landing (220)
- Created 44 menu items in school-menu (IDs 219–262, 226–230 in hidden menu):
  - Top-level school-menu: About Sacred Heart School (219, heading), News & Events (220, heading), Admissions & Academics (221, heading), Parents (222, heading), Support Us (223, heading), Capital Campaign (224, url/#), Sponsors (225, article 220)
  - About children (parentId 219): Welcome from the Principal (231), Why Choose Sacred Heart? (232), Faculty & Staff (233), Our History (234), Contact Us & Directions (235), Sacred Heart School Commission (236), Alumni (237)
  - News & Events children (parentId 220): Calendar (238), Weekly Information & Newsletter (239), Lunch Menu (240), Parish News (241, url/#)
  - Admissions children (parentId 221): Request Information (242), Registration (243), Financial Aid & Tuition (244), Curriculum (245), Specials (246), Preschool & Child Care Center (247), Accreditations (248), KSDE Accountability Reports (249)
  - Parents children (parentId 222): Parent Login (250), Parent/Student Handbook (251), Calendar alias→238 (262), Lunch Menus & Information (252), Virtus (253), PTO (254), Extended Care (255), Dress Code (256), Pick Up/Drop Off (257), Supply Lists (258)
  - Support Us children (parentId 223): Donate (259), Mexican Supper (260), Feast for Our Future (261)
  - school-hidden-menu: Giving (226), Apply (227), Church (228), Parent Resources (229), Parents Login (230)
- Spec saved at workspace/she-menu-spec.json
**Notes:** All TBD redirect targets set to '#' placeholder. Deferred: Parish News URL, Capital Campaign URL, TopLink targets (Giving/Apply), Under Rotator targets (Schedule a Tour Google Form, Parent Resources, Parents Login, Church), Parent Login clarification (internal page vs external redirect). Faculty & Staff photos/info from client (Phase 5). Calendar under Parents built as alias to menu item 238.
_Logged by: local_
