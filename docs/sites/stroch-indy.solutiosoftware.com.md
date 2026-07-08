# Site Notes: stroch-indy.solutiosoftware.com

Notes logged by AI agents.

### 2026-06-26 — Ticket #35429 | Parent/Student Handbook — Switched DocMan menu item to article
**Requested by:** Amanda Fisher (afisher@strochindy.org) | **Ticket:** #35429
**Changes:**
- Menu item #211 "Parent/Student Handbook" (school-menu, under "For Parents" parent #134): changed from DOCman Single Document to com_content Single Article
- Created article #476 "Parent/Student Handbook" in category "School Content Articles" (ID: 24) — includes intro paragraph and a styled `readon` download button linking to `/doclink/parent-student-handbook`
- Menu item browserNav changed from 1 (new window) to 0 (same window) since it now loads a page, not a direct download
**Notes:** Button href `/doclink/parent-student-handbook` points to the permanent DocMan download URL. Client to verify the document link resolves correctly; the DocMan document with slug `parent-student-handbook` must remain published.
_Logged by: local_

### 2026-07-08 — Ticket #35602 | Lunch Menu page — investigation only, no edit made
**Requested by:** Amanda Fisher (afisher@strochindy.org) | **Ticket:** #35602
**Changes:** None — investigation only.
**Notes:** School-menu item #212 "Lunch Menu" (alias lunch-menu) is a DOCman Hierarchical List component page, not a Joomla article. Its intro text/description comes from the DOCman category description field (category slug "lunch-menu"), rendered above the document list (show_description=1, show_categories_header=1 in menu item params). The `joomla_docman_category` tool is not in the support agent's scope — this class of edit needs `super_shannon` scope. Drafted the requested pricing block + Free/Reduced Lunch Application link as HTML in an internal Freshdesk note (#35602) for a human/super_shannon session to paste in. Outstanding: [Human] paste DOCman category description.
_Logged by: local_

### 2026-07-08 — Ticket #35602 | Lunch Menu pricing content — created as standalone article
**Requested by:** Amanda Fisher (afisher@strochindy.org) | **Ticket:** #35602
**Changes:**
- Created article #478 "Lunch Menu Pricing" in category "School Content Articles" (ID: 24), published — contains the 2026-2027 pricing block + Free/Reduced Lunch Application link drafted earlier for this ticket.
**Notes:** This is a standalone article, NOT the DOCman category description for the "lunch-menu" category. Menu item #212 "Lunch Menu" (alias lunch-menu) still renders as a DOCman Hierarchical List page — article #478 will not appear there automatically. Outstanding [Human]/[super_shannon] decision: either (a) paste the same content into the DOCman "Lunch Menu" category description field, or (b) repoint article #478 into the page some other way (e.g. link to it, or switch the menu item type). Article #478 exists now as a ready source of the approved copy either way.
_Logged by: local_

### 2026-07-08 — Ticket #35602 | Lunch Menu pricing — draft with styled button link
**Requested by:** Amanda Fisher (afisher@strochindy.org) | **Ticket:** #35602
**Changes:**
- Client added a Position (module) to the top of the Lunch Menu page (menu item #212).
- Created article #479 "Lunch Menu Pricing (Draft)" (unpublished) in "School Content Articles" (ID: 24) — same content as article #478, but the "Free and Reduced Lunch Application" link now uses `class="readon"` for a styled button per kb/css-table-classes.
**Notes:** Article #478 (published, plain link) still exists as the earlier version. #479 is the draft for review before deciding how it's surfaced on the page (module content vs. swapping #478's content).
_Logged by: local_

### 2026-07-08 — Ticket #35602 | Button styling + draft reply
**Requested by:** Amanda Fisher (afisher@strochindy.org) | **Ticket:** #35602
**Changes:**
- Trashed article #479 (was mistakenly created as a duplicate draft article — not what was requested).
- Updated live article #478: "Free and Reduced Lunch Application" link now uses `class="readon"` for button styling.
- Added a draft client reply as a private note on ticket #35602 (not yet sent).
**Notes:** Client had already added a Position/module to the top of the Lunch Menu page themselves. Draft reply is queued in Freshdesk pending review/send.
_Logged by: local_
