# Site Notes: hs-fairfield.solutiosoftware.com

Notes logged by AI agents.

### 2026-06-09 — Sanctuary V1 redesign — Mass Times article HTML
**Requested by:** internal | **Ticket:** none
**Changes:**
- Updated article ID 55 ("Mass Times") with `v1-mass-card` HTML structure matching Variation 1 Sanctuary design
- Replaced old `schedule-container` markup with semantic `v1-mass-group` / `v1-mass-row` layout
- Schedule data preserved: Sat 5pm/7pm, Sun 7:30/9/10:30am/12pm/6am/2pm; Mon–Fri 7&9am, Tue&Fri 7pm, Sat 9am
**Notes:** Article is rendered via contentarray-2192 in the Slideshow section of outline #Home (ID 75). CSS for `.v1-mass-card` and related classes still needs to be uploaded via FTP and linked in Gantry Page Settings.

### 2026-06-10 — Sanctuary V1 — Swiper overlay implementation
**Requested by:** internal | **Ticket:** none
**Changes:**
- Updated article ID 55 ("Mass Times") — added `.v1-hero-overlay` (left-side rotator text: tagline, church title, location) alongside the existing `.v1-mass-card`, both wrapped in `.v1-swiper-overlays` container
- Rewrote override.css swiper/overlay sections: replaced "MASS TIMES CARD" block and cleaned up `.studius-swiper` (removed inline comments, fixed indentation); added unified "SWIPER OVERLAYS" section with `.j-mass-times` absolute positioning and all hero/card CSS
- Scoped `.v1-mass-sub` to `.v1-mass-card .v1-mass-sub` to prevent global leakage; converted all hardcoded hex colors to CSS variables; replaced `'Cormorant Garamond'` references with `var(--title-font-family)`
- Key fix: `.j-slideshow .g-grid:has(.j-mass-times)` uses `height: 0 !important` to collapse the grid row — base CSS assigns it a computed fixed height (~447px) that must be beaten; `.g-container` is already `position: relative` so no additional anchor needed
**Notes:** `contentarray-2192` was manually enabled by user in Gantry layout editor before this session. Overlays hidden on mobile via `@media (max-width: 50.99rem)`.
