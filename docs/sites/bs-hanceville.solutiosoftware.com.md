# Site Notes: bs-hanceville.solutiosoftware.com

Notes logged by AI agents.

### 2026-06-26 — Ticket #35392 | Server crawler rate-limiting (Lighthouse / Moz)
**Requested by:** Liz Swope (SEO Specialist, Shrine of the Most Blessed Sacrament) | **Ticket:** #35392
**Changes:**
- No Joomla/site changes. Investigation + drafted client reply (Freshdesk note #14294448770).
**Notes:** Server-side issue handled by engineering (Alex). Lighthouse was being throttled by the older-Chrome-user-agent filter (treated as bad traffic); an exemption was added so Lighthouse audits now pass. Moz 4xx errors are not throttling — Moz's crawler is requesting non-existent recursive URLs (e.g. /about/priest-retreat-house/visit/visit/.../employment), which correctly return 4xx; client asked to review Moz crawler config. Site also serves at olamshrine.com. No follow-up needed unless client reports continued issues after fixing Moz settings.
_Logged by: local_
