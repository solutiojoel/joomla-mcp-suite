---
name: orchestrator-stdio-vs-http
description: Claude Code spawns its own stdio orchestrator from .mcp.json — restarting the HTTP stack (9302) does not update the in-session MCP tools
metadata: 
  node_type: memory
  type: project
  originSessionId: 0f8307c2-2f99-434e-9ab8-675eb05d0deb
---

The project `.mcp.json` runs the orchestrator via **stdio** (`node orchestrator.js`), so each Claude Code session spawns its own orchestrator process at session start. The HTTP orchestrator on port 9302 (started by `scripts/start-all.ps1`) is a separate instance used by Claude Desktop / other clients.

**Why:** After editing `orchestrator.js`, restarting the 9302 window does NOT update the `mcp__joomla-orchestrator__*` tools in a running Claude Code session — the stdio child still runs the code loaded at session start. `reload_tools` only refreshes its downstream tool maps, not its own code.

**How to apply:** To verify orchestrator code changes, test against the HTTP instance directly (e.g. `node apps/orchestrator/test-downstream-routing.cjs http://127.0.0.1:9302/mcp`). The in-session stdio instance picks up new code only after the user reconnects the MCP server (`/mcp`) or starts a new session. Related: [[feedback-reload-after-build]].
