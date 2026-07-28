---
name: Joomla host throttling of cloud IPs
description: The Joomla site's host rate-limits requests from cloud-provider (Replit/GCP) egress IPs; clients must pace requests and back off on 429.
---

The rule: all outbound HTTP to the Joomla site must go through a paced client — minimum interval between requests (default 750ms, tunable via `JOOMLA_MIN_REQUEST_INTERVAL_MS`) plus bounded 429 retries honoring `Retry-After` (seconds or HTTP-date form).

**Why:** Confirmed 2026-07-28: from Replit, the 3rd back-to-back request to the site returned HTTP 429 (worked fine from residential ISP IPs). The host's admin said cloud IPs (AWS/GCP) are throttled as bot traffic; slowing the request rate is their recommended fix — it is throttling, not a firewall block.

**How to apply:** Any new client or script that talks to the Joomla site (admin or public pages) must reuse the existing pacing/backoff wrappers in the joomla and gantry MCP HTTP layers rather than raw `fetch`. If 429s persist, raise the interval before asking the host for whitelisting.
