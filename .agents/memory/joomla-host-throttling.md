---
name: Joomla host throttling of cloud IPs
description: The Joomla host 429s cloud-provider egress IPs; all client-side pacing and backoff was removed on 2026-07-30 — we fail fast and fix it by allowlisting, not by slowing down.
---

**Decision 2026-07-30: no client-side throttling. It is removed, not disabled.** Pacing, the `paceRequest`/`pacerChain` serializers, the bounded 429 retry loops, `parseRetryAfterMs`, and `JOOMLA_MIN_REQUEST_INTERVAL_MS` are all deleted from `apps/joomla-mcp/src/joomla-client.ts` and `apps/gantry-mcp/lib/http.js`. Requests go out at full speed. A 429 throws `RATE_LIMITED: <host> returned HTTP 429` immediately — no wait, no retry.

**Why:** the cure was worse than the disease. Each request could spend up to ~29s in backoff (2+4+8+15), and a write makes many requests. A `joomla_menu_item` create therefore blew past the orchestrator's 60s call deadline, which the orchestrator then treated as a retryable failure and replayed — producing a duplicate menu item and a 120s wall time. Throughput before the throttling was added was better in practice. The real fix is getting our egress IP allowlisted; slowing ourselves down only masked the problem while making every operation slow.

**How to apply:** write new Joomla/Gantry HTTP paths as plain `fetch` through the existing shared clients. Do not reintroduce a pacer or a retry-on-429 loop. If 429s appear, treat it as an infrastructure ticket — get the IP allowlisted — and surface the error to the user rather than absorbing it in the client.

**Keep the identification.** `apps/joomla-mcp/src/user-agent.ts` and its CJS twin `apps/gantry-mcp/lib/user-agent.js` remain the single source of outbound UA. They append `Solutio-MCP/<v> (+https://solutiosoftware.com)` to a valid browser UA and send `X-Solutio-Agent`, which is what makes allowlisting-by-pattern possible. Never hardcode a UA. A *truncated* or non-browser UA gets 403'd by the origin, which is a different failure from a 429.

**Background:** confirmed 2026-07-28 that from Replit the 3rd back-to-back request returned 429, while residential ISP IPs were fine. Host access logs from Alex later showed the *second* request of a login triplet already 429ing at a 750ms pace, so no interval setting could have made a multi-request login succeed. That is what settled it: the limit fires on a burst of ~1 on `/administrator/`, so pacing was never going to work.

**Related, still true:** `login()` passes `prefetchedHtml` to `postPage()` so it does not re-GET a page the caller already holds. That took login from 4 requests to 3. Joomla's CSRF token is session-scoped, not per-page-load, so reusing the prefetched page is safe. Fewer requests is the durable win — keep looking for those.

**Replit note:** `.replit` sets `deploymentTarget = "autoscale"`, so several containers run with separate cookie jars and separate egress IPs. Allowlisting has to cover every egress IP, or a Reserved VM has to pin it to one.
