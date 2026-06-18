---
name: sub-agent-implementation-plan
description: Step-by-step implementation plan for the agents-mcp sub-agent capability — pick this up in the next session
metadata: 
  node_type: memory
  type: project
  originSessionId: 10dc667f-052e-490e-8773-0dcf379e3b0b
---

## Goal

Add a new downstream server `apps/agents-mcp/` that exposes MCP tools whose handlers run their own Anthropic agentic loop (sub-agents). The first sub-agent is `menu-interpreter` (reads a menu PDF, probes Joomla, returns a structured JSON spec). See [[sub-agent-architecture]] for all design decisions.

---

## Phase 0 — Transport spike (✅ DONE)

**Goal:** Prove a long-running tool call survives the orchestrator hop without timing out.

**Why first:** The orchestrator's `callDownstream` uses the MCP SDK default 60s timeout. A nested Opus loop exceeds that. If transport doesn't work nothing else matters.

Steps:
1. Scaffold `apps/agents-mcp/` as an HTTP MCP server — mirror the pattern in `apps/joomla-mcp/src/index.ts` (`buildServer()` + `StreamableHTTPServerTransport`).
2. Add one dummy tool `agent_ping` that sleeps 90 seconds, emitting an MCP progress notification every 10s, then returns `{ ok: true }`.
3. Add agents-mcp to `DEFAULT_DOWNSTREAMS` in `apps/orchestrator/orchestrator.js` (line ~55):
   ```js
   { label: 'agents-mcp', url: 'http://host.docker.internal:9302/mcp', inject: 'site_url' }
   ```
4. Add a timeout override in `callDownstream` (orchestrator.js line ~236) for agent tools — pass `{ timeout: 600000, resetTimeoutOnProgress: true, maxTotalTimeout: 900000 }` to `client.callTool()`.
5. **Exit criteria:** `agent_ping` returns success through the full chain (main Claude → orchestrator → agents-mcp) without a timeout. Stop and fix before continuing if it fails.

---

## Phase 1 — Runtime harness and bridge helper

**Goal:** Reusable internals every sub-agent shares. No menu logic yet.

Files to create in `apps/agents-mcp/src/`:

**`bridge.ts`** (~50 lines)
- `connectDownstreams(labels: string[], siteUrl: string)` — opens an MCP client to each listed downstream (by label, resolving port from env/config), calls `listTools()`, caches the results.
- Returns `{ tools: Anthropic.Tool[], executor }` where `executor(name, args)` re-injects `site_url`/`site` on every call and routes to the right client by tool name.
- Labels: `"joomla-mcp"` → port 9300, `"gantry-mcp"` → port 9301.

**`runtime.ts`**
- `runSubAgent({ systemPrompt, tools, toolExecutor, userMessage, maxIterations?, onIteration? }): Promise<string>`
- Manual Anthropic agentic loop: `while(true)` → `anthropic.messages.create(...)` → handle `tool_use` blocks → push `tool_result` → check `end_turn`.
- Hard `maxIterations` guard (default 25) — returns structured error `{ success: false, error: "max iterations reached" }` if hit.
- Calls `onIteration` each loop turn (used for MCP progress notifications to keep the orchestrator timeout reset).
- Logs each iteration (messages, stop_reason, tool calls) to a run-keyed file under `logs/`.

**`config.ts`**
- `loadSubAgentConfig(name: string)` — reads `config/agents/<name>/<name>.json`, returns `{ allow: string[], instructions: string, downstreams: string[] }`.
- Instructions file resolved relative to the config dir, read and returned as system prompt text.

---

## Phase 2 — First real sub-agent: menu-interpreter

**Goal:** Wire the harness to real Joomla tools and a real system prompt.

Files:
- `config/agents/menu-interpreter/menu-interpreter.json`:
  ```json
  {
    "name": "menu-interpreter",
    "hidden": true,
    "description": "Reads menu PDF text and produces a structured Joomla menu spec",
    "instructions": "menu-interpreter-system.md",
    "tools": {
      "allow": ["joomla_menu", "joomla_menu_item", "joomla_category", "joomla_article"],
      "downstreams": ["joomla-mcp"]
    },
    "docs": { "allow": ["menu-build/*"] }
  }
  ```
- `config/agents/menu-interpreter/menu-interpreter-system.md` — system prompt for the sub-agent.
- `apps/agents-mcp/src/agents/menu-interpreter.ts` — the tool handler:
  1. Loads config via `loadSubAgentConfig("menu-interpreter")`
  2. Connects via `connectDownstreams(config.downstreams, site_url)`
  3. Filters tool list to `config.allow`
  4. Calls `runSubAgent(...)`, passing a progress-notification callback as `onIteration`
  5. Validates returned JSON against the menu spec Zod schema before returning
  6. Returns `{ content: [{ type: "text", text: JSON.stringify(result) }] }`

- Add `run_menu_interpretation` to `config/agents/menu-build/menu-build.json` allow list.

**Return contract** (validate with Zod before returning to main Claude):
```typescript
{ success: boolean, spec?: MenuSpec, error?: string }
```

---

## Phase 3 — Orchestrator integration and menu cleanup

- Filter `"hidden": true` agents from `listAvailableAgents()` in orchestrator.js (line ~151):
  ```js
  function addJson(jsonPath) {
    const def = JSON.parse(...)
    if (def.hidden) return;  // add this line
    ...
  }
  ```
- Confirm global `tool-policy.json` still applies to the call to `run_menu_interpretation` from main Claude (it does — the orchestrator enforces it on inbound calls). The sub-agent's internal tool use is governed only by its own allow list — this is intentional and documented.
- Add `agents-mcp` to docker-compose / whatever starts the servers. `ANTHROPIC_API_KEY` must be in agents-mcp's environment (it makes the Anthropic API calls, not Claude Code).

---

## Phase 4 — Hardening

- Timeout/error tests: runaway loop hits `maxIterations` → clean error response (not a hang).
- joomla-mcp down → structured failure returned to main Claude, not an unhandled exception.
- Log cost/latency per run (iterations, wall time) alongside the session changelog.
- Update `CLAUDE.md` / `AGENTS.md`: add `agents-mcp` to the downstream table; note that sub-agent internal tool use bypasses session scope.

---

## Phase 5 — menu-builder (validates multi-downstream story)

Only after Phase 2 ships and is stable.

- `config/agents/menu-builder/menu-builder.json` — allow list spans both `joomla-mcp` AND `gantry-mcp`.
- `apps/agents-mcp/src/agents/menu-builder.ts` — calls `connectDownstreams(["joomla-mcp", "gantry-mcp"], site_url)`.
- This validates that the bridge helper handles multiple clients and routes correctly — if Phase 1 was built right, this is mostly config + a system prompt.

---

## Key decisions already made (do not re-litigate)

- No second orchestrator — sub-agents connect directly to leaf servers.
- Same config format for main agents and sub-agents — `"hidden": true` keeps sub-agents out of the switch menu.
- Unified bridge helper, not per-sub-agent client code.
- Transport spike (Phase 0) is prerequisite to everything else.
- `ANTHROPIC_API_KEY` lives in agents-mcp server env.
