---
name: feedback-reload-after-build
description: "After joomla-mcp or gantry-mcp source changes are built, Claude must call reload_tools so the orchestrator picks up the new tool list"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0195a915-9519-4e51-b927-75a94760cbc1
---

After any joomla-mcp TypeScript build or gantry-mcp change, call `reload_tools` to refresh the orchestrator's tool map.

**Why:** The orchestrator caches tool lists from downstream servers at startup. Without reload_tools, it continues exposing the old tool set even after a server restart.

**How to apply:** When the PostToolUse hook reports "Build succeeded. Restart the joomla-mcp server window..." — remind the user to restart the server, then immediately call `reload_tools` once they confirm it's restarted. Also call `reload_tools` any time the user manually restarts joomla-mcp or gantry-mcp.
