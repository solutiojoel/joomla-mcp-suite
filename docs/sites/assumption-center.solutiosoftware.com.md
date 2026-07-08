# Site Notes: assumption-center.solutiosoftware.com

Notes logged by AI agents.

### 2026-07-08 — Ticket #35587 | Wrap text beside image — replaced table hack with float
**Requested by:** Doreen Corriera (dcorriera@abvmcentereach.com) | **Ticket:** #35587
**Changes:**
- Article #178 "Called to the Table - OCIA" (category 55, Faith Formation Items): replaced the 1-row/2-column table layout (image cell + text cell) with a floated `<img>` (`style="float:left; margin:0 15px 15px 0; max-width:250px;"`) followed by the paragraphs, plus a `clear:both` div before the closing link. Visually identical result, no table markup.
**Notes:** Client had been using tables site-wide as a workaround for wrapping text next to images. Demonstrated the float approach on her example article; draft reply explains how to do this herself going forward via the editor's image alignment option. Note there's a second, unrelated article with the same title (#268, in "Recent Parish News and Upcoming Events") — not touched, wasn't the one referenced in the ticket.
_Logged by: local_
