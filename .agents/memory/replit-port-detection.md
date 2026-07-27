---
name: Replit port detection with explicit [[ports]]
description: Why workflow waitForPort fails in this project and how port mappings behave
---

# Replit port detection with explicit [[ports]]

Rule: when `.replit` contains explicit `[[ports]]` entries, Replit disables automatic port detection. A workflow's `waitForPort` port (5000 here) then only resolves if that local port has its own `[[ports]]` mapping.

**Why:** Confirmed by docs and repeated experiments: with no `localPort = 5000` mapping, every workflow restart timed out with "didn't open port 5000" even though the orchestrator was verifiably listening on 0.0.0.0:5000; with the mapping present at restart time, restarts succeeded every time.

**How to apply:** If the workflow fails port detection, check `.replit` has a `[[ports]]` entry for the waited-on port before debugging the server. Use `verifyAndReplaceDotReplit` to edit `.replit` (direct edits are blocked).

Caveat: the platform periodically reverts `.replit` port edits back to its stored config (working tree shows the old content again after restarts). Re-apply the mapping via `verifyAndReplaceDotReplit` and keep the change committed in git so it survives task merges.

Related: the orchestrator opens fresh per-call connections to downstream MCP servers, so it can start before them — startup is fully parallel in `scripts/start-all.sh`. The 9303→80 forwarder needs a short guard delay (~5s) after 5000 opens so the detector latches onto 5000 first.

**Deployment lesson (July 2026):** Autoscale routes all external traffic to the
localPort mapped to externalPort 80 in `.replit` (here: 9303). A server on a
port mapped elsewhere (5000→8008) never receives the health check and the
publish fails at "Creating Autoscale service" with NO runtime logs. Fix in the
start script, not `.replit` (platform reverts port edits): when
REPLIT_DEPLOYMENT is set, listen on `${PORT:-9303}`; in dev, on 5000. Also:
deploy build commands must not run `pip install` — the deploy image's Python is
externally managed (read-only Nix store); Python deps ship via `.pythonlibs`.
