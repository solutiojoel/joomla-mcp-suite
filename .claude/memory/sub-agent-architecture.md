---
name: sub-agent-architecture
description: "Planned LLM-backed sub-agent capability — agents-mcp downstream, design decisions not yet in code"
metadata: 
  node_type: memory
  type: project
  originSessionId: 10dc667f-052e-490e-8773-0dcf379e3b0b
---

Planned (not yet built as of 2026-06-18) capability: MCP tools that are themselves LLM-backed agents. An MCP tool handler runs its own Anthropic agentic loop (claude-opus-4-8) with its own system prompt + tool subset, then returns structured JSON to the main agent.

**Decided architecture:**
- New downstream server `apps/agents-mcp/` hosts the sub-agent tools (e.g. `run_menu_interpretation`, `run_menu_build`). Added to orchestrator `DEFAULT_DOWNSTREAMS`.
- Sub-agents connect **directly** to leaf servers (joomla-mcp :9300, gantry-mcp :9301) as MCP clients — NOT back through the orchestrator (avoids loop risk, lost session state, extra hops). No second orchestrator needed.
- Tool schemas stay defined once in the leaf servers; sub-agents `listTools()` and filter to an allow list at runtime — no duplicated tool definitions.
- Shared `bridge.ts` helper (~50 lines) in agents-mcp: connect downstreams by label, cache listTools, filter to allow list, re-inject `site_url`/`site` on every proxied call, route by tool name. Not an orchestrator.
- **Unified agent config** — same `config/agents/<name>.json` format for main agents and sub-agents (no `type` field). Orchestrator reads it for session scope; agents-mcp reads it for sub-agent tool filtering.
- Sub-agents hidden from `switch_agent` menu via `"hidden": true` field, filtered in `listAvailableAgents` ([orchestrator.js](../../../../code-projects/joomla-mcp-suite/apps/orchestrator/orchestrator.js)).

**Key implementation risks (address in this order):**
1. **Request timeout** — `callDownstream` uses MCP SDK default 60s; a nested Opus loop exceeds it. Must raise timeout + use progress notifications (`resetTimeoutOnProgress`) for agent-tool calls. This is the #1 blocker — prove transport first (Phase 0 spike) before any agent logic.
2. **Site context** — orchestrator's site injection does NOT apply to agents-mcp's own outbound clients; the bridge must re-inject site on every call. Silent failure if forgotten.
3. **Runaway loops** — hard `maxIterations` guard returning structured error.
4. Sub-agent internal tool use is governed only by its own allow list, NOT the session scope or global tool-policy — document as a known security boundary.
5. `ANTHROPIC_API_KEY` must live in agents-mcp's server env (it makes the Anthropic calls, not Claude Code).

Dev plan phases: 0=transport spike, 1=runtime harness + bridge, 2=menu-interpreter (first real sub-agent), 3=orchestrator integration + hide from menu, 4=hardening, 5=menu-builder (multi-downstream validation).

Related: [[orchestrator-stdio-vs-http]], [[project-structure]], [[feedback-reload-after-build]].
