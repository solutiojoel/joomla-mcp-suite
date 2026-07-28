---
name: Status dashboard conventions
description: How the public status page classifies service health and why
---
The orchestrator serves an unauthenticated status page (`/`, `/status`, `/status.json`).

**Rules:**
- It must never echo raw internal error strings — only coarse categories ("unreachable", "tool load failed"). It was reviewed as an info-leak surface.
- Health classification is reachability-based, not 200-based: some suite servers (e.g. gantry-mcp) do not implement `/healthz` and 404 it — any HTTP response counts as proof of life; "degraded" means reachable but zero tools loaded.
- The collector self-heals: startup is parallel, so the orchestrator often boots before downstreams; on each status request it retries tool loading (15s throttle) for reachable servers with empty tool maps.

- Per-server enable/disable toggles live on the status page; state persists in `config/downstreams-disabled.json`. The mutation route requires the orchestrator bearer token (page stays public/read-only otherwise), and the disable gate is centralized in `callDownstream` so composite/internal tool paths are also blocked — never gate only at tools/list.

**Why:** startup ordering is intentionally parallel (fast boot), so empty tool maps at boot are normal, not errors.
