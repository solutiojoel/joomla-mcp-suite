---
name: Single-process (in-process downstream) mode
description: How and why the suite runs as one process for Autoscale; guards required in downstream entry points.
---

The orchestrator hosts all Node downstream MCP servers in-process (SDK
InMemoryTransport, fresh linked pair per call) and runs the Python
mockup-analyzer as a persistent stdio child, when `INPROCESS_DOWNSTREAMS=1`
(set by `scripts/start-single.sh`, used by both the dev workflow and the
deployment).

**Why:** Replit Autoscale runs one stateless web process per container; the
old 8-process stack failed its startup probe and would have background
processes killed. Single process + single port (5000) publishes cleanly and
scales to zero.

**How to apply / rules:**
- Every downstream entry point must export `buildServer()` and guard its
  auto-start with `if (require.main === module)` — requiring the module for
  in-process hosting must have no side effects. Apps compile to CJS; the
  orchestrator `require()`s their dist directly (Node 20.19+ can require the
  ESM transport package).
- Downstream module-level session caches (Joomla/Gantry logins) survive
  across calls because the module is required once; per-call Server
  instances are cheap.
- Stdio children must NOT see HTTP_PORT/PORT/MOCKUP_MCP_PORT in env or they
  start in HTTP mode; a failed stdio call invalidates the cached client so
  the next call respawns the child (this is also how mockup-analyzer
  self-heals — it works in this mode, unlike the old HTTP mode).
- The 9303 forwarder is dev-only; it must not run in deployments (gate on
  `REPLIT_DEPLOYMENT`) or a second open port breaks port detection.
- Behavior change accepted by design: idle scale-to-zero loses in-memory MCP
  sessions and active-site state; clients re-init and re-run
  set_active_site.
