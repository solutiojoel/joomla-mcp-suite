---
name: Joomla host throttling of cloud IPs
description: The Joomla site's host rate-limits requests from cloud-provider (Replit/GCP) egress IPs; clients must pace requests and back off on 429.
---

The rule: all outbound HTTP to the Joomla site must go through the shared clients, which do bounded 429 retries honoring `Retry-After` (seconds or HTTP-date form). Request pacing exists but defaults to 0ms — the user chose retry-only because pacing was too slow for larger builds; they plan to get the Replit egress IP allowlisted. Re-enable pacing via `JOOMLA_MIN_REQUEST_INTERVAL_MS` if 429 storms return.

**Why:** Confirmed 2026-07-28: from Replit, the 3rd back-to-back request to the site returned HTTP 429 (worked fine from residential ISP IPs). The host's admin said cloud IPs (AWS/GCP) are throttled as bot traffic; slowing the request rate is their recommended fix — it is throttling, not a firewall block.

**How to apply:** Any new client or script that talks to the Joomla site (admin or public pages) must reuse the existing pacing/backoff wrappers in the joomla and gantry MCP HTTP layers rather than raw `fetch`. If 429s persist, raise the interval before asking the host for whitelisting.

**Update 2026-07-28 — pacing alone is not the fix.** Host access logs supplied by Alex show the *second* request of a login triplet already returning 429 while our pacer was set to 750ms. The limit fires on a burst of ~1 on `/administrator/`, so no interval setting can make a multi-request login succeed. Two changes followed:

- **Login is one request shorter.** `postPage()` used to re-GET the page the caller had just fetched; `login()` now passes it via `prefetchedHtml`. Login went from 4 requests to 3 (fetch form → POST → follow 303). The removed GET was the one the log showed being 429'd, which then poisoned the POST behind it. Joomla's CSRF token is session-scoped, not per-page-load, so reusing the prefetched page is safe.
- **We now identify ourselves.** All outbound UAs come from `apps/joomla-mcp/src/user-agent.ts` (and its CJS twin `apps/gantry-mcp/lib/user-agent.js`) — never hardcode a UA again. Default appends `Solutio-MCP/<v> (+https://solutiosoftware.com)` to a valid browser UA and sends `X-Solutio-Agent`, so the host can allowlist us by pattern. Previously joomla-mcp sent a *truncated* (invalid) Chrome UA and gantry-mcp sent `gantry-cli/1.0`, which is the shape of UA the origin 403s.

Still open: pacing state is per-`JoomlaClient` (one per site URL) and per-process. Alex's log shows three distinct GCP egress IPs, so multiple Replit instances pace independently and can still burst. Allowlisting makes this moot; if it stalls, that coordination is the next thing to build.
