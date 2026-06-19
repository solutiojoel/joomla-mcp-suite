# Phase 4 — Shared Packages, Internal Refactor & Sub-Agent Hardening

> Rescoped 2026-06-19 after the agent architecture moved to a **two-boundary**
> model (main agent → orchestrator; sub-agent → downstreams via the agents-mcp
> bridge). Supersedes the original "Phase 4 — Shared packages & internal
> refactor" list. Gantry-mcp internals are explicitly **out of scope** for now.

## Background: the two enforcement boundaries

**Boundary A — main agent → orchestrator.** The orchestrator enforces per-agent
scope via `kb.isToolAllowed(agentDef, name)` in ListTools
([orchestrator.js:753](apps/orchestrator/orchestrator.js#L753)) and CallTool
([orchestrator.js:1000](apps/orchestrator/orchestrator.js#L1000)). Agent defs
live in `config/agents/<name>/<name>.json`.

**Boundary B — sub-agent → downstreams.** `run_menu_interpretation` runs a
Sonnet loop ([runtime.ts](apps/agents-mcp/src/runtime.ts)) that reaches
downstreams through [bridge.ts](apps/agents-mcp/src/bridge.ts) — a **second,
independent** MCP-client layer connecting directly to joomla/gantry/freshdesk/ftp,
bypassing the orchestrator.

**The gap that drives this phase:** at Boundary B the `tools.allow` list only
filters the tool array *advertised* to the model
([menu-interpreter.ts:204](apps/agents-mcp/src/agents/menu-interpreter.ts#L204)).
The bridge `executor` ([bridge.ts:71](apps/agents-mcp/src/bridge.ts#L71)) has
**no allow check** — it executes any tool on a connected downstream. The
allow-list is advisory, not enforced.

## Findings that shaped the ordering

1. **Inject map exists in 3 divergent places.** Orchestrator
   `DEFAULT_DOWNSTREAMS` ([orchestrator.js:55-62](apps/orchestrator/orchestrator.js#L55-L62))
   lists 6 servers on `host.docker.internal` (9300/9301/9303/9304/9305/3506) with
   per-label `inject`. Bridge `DEFAULTS`
   ([bridge.ts:12-17](apps/agents-mcp/src/bridge.ts#L12-L17)) lists 4 on
   `127.0.0.1` and omits mockup-analyzer + agents-mcp. They have **already
   drifted**.
2. **Existing orchestrator tests are stale.** `test-kb-scoping.cjs` loads
   `admin`, `support`, `menu-content` from flat `config/agents/<name>.json`. The
   real agents are `super_shannon`, `support`, `menu-build`, `menu-interpreter`
   in subfolders — `admin` and `menu-content` no longer exist, so the test
   crashes on `fs.readFileSync`. Any "tests per server" work must repair this
   first.
3. **HTTP bootstrap is duplicated near-verbatim in 8 files** (joomla, freshdesk,
   ftp, agents ×index, gantry ×2, orchestrator). joomla-mcp
   ([index.ts:1717-1764](apps/joomla-mcp/src/index.ts#L1717-L1764)) and agents-mcp
   ([index.ts:127-179](apps/agents-mcp/src/index.ts#L127-L179)) are byte-for-byte
   the same shape.
4. **Module split:** joomla/freshdesk/ftp/agents are TS/ESM; orchestrator + gantry
   are CJS. 4 of 6 favor "converge on TS."

---

## Execution order

| # | Item | Type | Risk | Est. |
|---|------|------|------|------|
| 1 | Boundary-A scope test + precedence extraction | test + small refactor | low | 0.5 day |
| 2 | Boundary-B bridge executor enforcement | **security fix** + test | low | 0.5 day |
| 3 | `packages/mcp-downstream-client` | refactor (de-dupe inject map) | med | 1 day |
| 4 | `packages/mcp-transport` + npm workspaces | refactor | med | 1–1.5 day |
| 5 | `packages/logging` | refactor | low | 0.5 day |
| 6 | Split `joomla-client.ts` | refactor | high | 1.5–2 day |

Items 1–2 ship value immediately and unblock nothing else, so they go first.
Item 3 precedes 4 because the inject-map divergence is the live correctness risk.
Item 6 is last (largest regression surface, pure structure).

---

## Item 1 — Boundary-A scope enforcement test + precedence extraction

**Objective.** Lock in "a `support` session cannot call admin/gantry tools" as an
automated, end-to-end-faithful test, and remove the duplicated allow/deny
precedence currently inlined in both ListTools and CallTool.

**Problem today.** The precedence logic — *mandatory bypass → global deny →
agent allow/deny* — is written twice with subtle differences: ListTools
([orchestrator.js:740-757](apps/orchestrator/orchestrator.js#L740-L757)) vs the
CallTool guards (HIDDEN check + globalDeny block + `isToolAllowed` at line 1000).
The only existing scope test (`test-kb-scoping.cjs`) tests `kb.isToolAllowed` in
isolation and is itself stale.

**Steps.**
1. Add `resolveToolAccess(agentDef, toolName, { globalDeny, mandatory, hidden })`
   to `apps/orchestrator/kb.js`, returning `{ allowed: boolean, reason: string }`.
   It encodes the single canonical precedence: `hidden` → denied;
   `mandatory` → allowed; `globalDeny` match → denied; else `isToolAllowed`.
2. Replace the inlined checks in orchestrator ListTools and CallTool with calls
   to `resolveToolAccess`. `MANDATORY_OWN_TOOLS` and `HIDDEN_JOOMLA_TOOLS` are
   passed in. Behavior must be identical — verify with a manual ListTools diff
   before/after for each agent.
3. **Repair** `test-kb-scoping.cjs`: switch `loadAgent` to the subfolder path
   (`config/agents/<name>/<name>.json`, fall back to flat), and replace
   `admin`/`menu-content` with `super_shannon`/`menu-build`. Update the doc-name
   list to current docs.
4. Add `apps/orchestrator/test-scope-enforcement.cjs` (same plain-node
   `check/assert` harness as the other `test-*.cjs`). For every real agent JSON,
   assert via `resolveToolAccess`:
   - `support` is **denied** a representative admin/gantry tool
     (`gantry_layout_edit`, `joomla_user`) and a globally-denied tool.
   - `support` is **allowed** its own tools (`freshdesk_get_ticket`) and every
     `MANDATORY_OWN_TOOLS` entry regardless of agent allow-list.
   - `menu-build` is denied freshdesk/gantry-design tools, allowed
     `joomla_article`.
   - `super_shannon` (`allow: ["*"]`) is allowed everything except hidden/global-deny.
5. Add an `npm test` script at `apps/orchestrator/package.json` that runs all
   three `test-*.cjs` files in sequence.

**Acceptance.** `node apps/orchestrator/test-scope-enforcement.cjs` and the
repaired `test-kb-scoping.cjs` both exit 0; the precedence helper is the only
place encoding allow/deny order.

**Files.** `apps/orchestrator/kb.js`, `apps/orchestrator/orchestrator.js`,
`apps/orchestrator/test-kb-scoping.cjs` (repair),
`apps/orchestrator/test-scope-enforcement.cjs` (new),
`apps/orchestrator/package.json`.

---

## Item 2 — Boundary-B bridge executor enforcement (security)

**Objective.** Make the sub-agent `tools.allow` list **enforced at execution**,
not just at advertisement, so a tool call outside the allow-list is rejected even
if the model emits it (hallucination or prompt injection from the source PDF).

**Steps.**
1. Change `connectDownstreams(labels, siteUrl)` →
   `connectDownstreams(labels, siteUrl, allow)` in
   [bridge.ts](apps/agents-mcp/src/bridge.ts). Store the compiled `allow`
   patterns in the closure.
2. In the `executor`, before `downstream.client.callTool`, check the tool name
   against `allow` using the same trailing-`*` semantics as
   `kb.matchesPattern`. On miss, throw
   `Tool '<name>' is not in this sub-agent's allow-list` with `is_error: true`
   surfaced back through the runtime loop. (The loop already maps thrown executor
   errors to `is_error` tool results — [runtime.ts:69-79](apps/agents-mcp/src/runtime.ts#L69-L79).)
3. Move the advertised-tool filter out of
   [menu-interpreter.ts:204-210](apps/agents-mcp/src/agents/menu-interpreter.ts#L204-L210)
   and into `connectDownstreams` so advertise-filter and execute-filter share one
   list (no second place to drift). `menu-interpreter.ts` then just passes
   `config.allow` through.
4. Factor the pattern matcher into a tiny shared helper. Cheapest correct option:
   a 6-line `matchPattern(name, pattern)` in `apps/agents-mcp/src/match.ts`
   (mirrors `kb.matchesPattern`). A fully shared package is overkill here; note it
   as a candidate to absorb into `packages/mcp-downstream-client` (Item 3).
5. Add `apps/agents-mcp/test-bridge-scope.ts` (or `.cjs` against compiled
   `dist/`): build an executor with a **mock** downstream client (no network),
   register tools `a`, `b`, allow only `a`, assert `executor("b", {})` rejects and
   `executor("a", {})` passes. Wire into an `npm test` script in
   `apps/agents-mcp/package.json`.

**Acceptance.** With `allow: ["joomla_workspace_write"]`, a forced
`executor("joomla_article", …)` call throws and never reaches the downstream;
`joomla_workspace_write` still works end-to-end via `run_menu_interpretation`.

**Files.** `apps/agents-mcp/src/bridge.ts`,
`apps/agents-mcp/src/agents/menu-interpreter.ts`,
`apps/agents-mcp/src/match.ts` (new),
`apps/agents-mcp/test-bridge-scope.*` (new),
`apps/agents-mcp/package.json`. **Rebuild agents-mcp + `reload_tools` after.**

---

## Item 3 — `packages/mcp-downstream-client`

**Objective.** One source of truth for downstream connection + the **inject map**,
consumed by both the orchestrator and the agents-mcp bridge. Kills the 3-way
divergence (Finding 1).

**Package surface (`packages/mcp-downstream-client`).**
- `DOWNSTREAM_DEFAULTS`: `{ label, port, inject }[]` — the canonical registry
  (joomla=site_url, gantry=site, freshdesk=null, ftp=site_url, mockup-analyzer=null,
  agents-mcp=site_url). Host/port/token resolved from env (`<LABEL>_URL`,
  `<LABEL>_TOKEN`) with a base-URL override so orchestrator (`host.docker.internal`)
  and bridge (`127.0.0.1`) keep their environment differences via config, not
  forked code.
- `createDownstreamClient(label, url, token)` → connected MCP `Client`.
- `injectSite(label, args, siteUrl)` → applies the per-label inject arg.
- `buildToolRegistry(clients)` → `Map<toolName, label>` with first-wins ordering.

**Steps.**
1. Scaffold the package (see Item 4 for the module-system decision — this package
   ships the same way). Author in TS.
2. Refactor orchestrator `loadDownstreams` / `createClient` / `callDownstream` /
   `findToolDownstream` to consume the package. Keep orchestrator's fresh-per-call
   strategy and the 10-min agents-mcp timeout
   ([orchestrator.js:243-262](apps/orchestrator/orchestrator.js#L243-L262)) —
   those are orchestrator policy, not connection mechanics.
3. Refactor bridge.ts to consume `DOWNSTREAM_DEFAULTS` + `injectSite` +
   `buildToolRegistry`; delete its private `DEFAULTS`.
4. Single regression risk: orchestrator currently injects on a per-`ds.inject`
   basis at call time; bridge injects in the executor. Keep both call sites, have
   both call `injectSite`. Verify `set_active_site` → joomla call still carries
   `site_url`, and a gantry call carries `site`.

**Acceptance.** Grep shows exactly one literal inject map in the repo (the
package). Orchestrator routing tests (`test-downstream-routing.cjs`) still pass;
`run_menu_interpretation` still injects `site_url` into `joomla_workspace_write`.

**Files.** `packages/mcp-downstream-client/*` (new),
`apps/orchestrator/orchestrator.js`, `apps/agents-mcp/src/bridge.ts`.

---

## Item 4 — `packages/mcp-transport` + npm workspaces

**Objective.** Collapse the 8 copies of the StreamableHTTP/stdio bootstrap into
one package; adopt npm workspaces at the repo root.

**Decision required first — module system.** Recommendation: **author packages in
TS, compile to dual output (ESM + CJS) via a small `tsup`/`tsc` two-config build.**
Rationale: the 4 TS/ESM servers `import` the ESM build; orchestrator + gantry
(CJS) `require` the CJS build; neither has to be rewritten. If dual-build is judged
not worth it, the fallback is **CJS-only with `.d.ts`** — ESM consumers import a
CJS module fine under `esModuleInterop`; the only cost is no named ESM exports.
Pick dual-build unless time-boxed.

**Package surface (`packages/mcp-transport`).**
- `startHttpServer({ port, buildServer, path = "/mcp", onSession? })` — the
  `http.createServer` + session `Map` + POST-body parse + `DELETE` cleanup loop
  shared by all servers.
- `startStdioServer(buildServer)`.
- `runServer({ buildServer })` — reads `HTTP_PORT || PORT`, picks HTTP vs stdio
  (the `main()` shared by every server).

**Steps.**
1. Create root `package.json` with `"workspaces": ["apps/*", "packages/*"]`.
   Confirm each app still builds/installs (some apps have their own
   `node_modules` + `package-lock.json` today; converge to root-hoisted installs).
2. Build `packages/mcp-transport` per the module decision.
3. Replace `startHttp` + `main` in joomla-mcp, freshdesk-mcp, ftp-mcp, agents-mcp
   (ESM consumers). Each `buildServer()` stays in its own file; only the transport
   wiring moves.
4. Replace the equivalent block in orchestrator
   ([orchestrator.js:1159+](apps/orchestrator/orchestrator.js#L1159)) (CJS
   consumer). Gantry mcp-server / site-builder-server can be migrated in the same
   pass or deferred — they're out of the primary scope but are free wins if the
   CJS build exists.
5. Per-server smoke: start each on its port, `initialize` + `tools/list` over
   HTTP, confirm a session id is issued and `DELETE` tears it down.

**Acceptance.** Each migrated server starts on HTTP and stdio with no behavior
change; the transport block appears once. `npm install` at root links all
workspaces.

**Files.** root `package.json` (new), `packages/mcp-transport/*` (new),
`apps/{joomla,freshdesk,ftp,agents}-mcp/src/index.ts`,
`apps/orchestrator/orchestrator.js`.

---

## Item 5 — `packages/logging`

**Objective.** One structured logger; retire the per-server ad-hoc
`console.error`/`log()`. Anchor the design on the concrete consumer that already
wants structure: the agents-mcp per-run JSONL log
([runtime.ts:24-31](apps/agents-mcp/src/runtime.ts#L24-L31)).

**Package surface (`packages/logging`).**
- `createLogger({ name, level })` → `{ debug, info, warn, error }`, line-prefixed
  with server name + ISO timestamp, written to stderr (keeps stdout clean for
  stdio-MCP framing — important, do not log to stdout).
- `createRunLog(dir, runId)` → `append(entry)` JSONL sink; this is exactly the
  runtime.ts logger, lifted and shared.

**Steps.**
1. Build the package (same module decision as Item 4).
2. Swap orchestrator's `log()` ([orchestrator.js:1185](apps/orchestrator/orchestrator.js#L1185))
   and the `console.error` call sites in the TS servers to `createLogger`.
3. Replace runtime.ts's inline `appendLog` with `createRunLog`.

**Acceptance.** Log lines share one format across servers; agents-mcp run logs
still land in `apps/agents-mcp/logs/<runId>.jsonl`; no logging to stdout.

**Files.** `packages/logging/*` (new), `apps/orchestrator/orchestrator.js`,
`apps/{joomla,freshdesk,ftp,agents}-mcp/src/*`.

---

## Item 6 — Split `joomla-client.ts` (6.3k lines, 221 methods)

**Objective.** Break the monolith into domain modules **without changing the
public `JoomlaClient` surface** (orchestrator and the bridge both depend on the
emitted tool behavior, not the class internals — so this is purely internal).

**Approach — prototype augmentation (lowest call-site churn).** Keep the
`JoomlaClient` class shell (constructor, session/auth state, the shared
`request()` helper). Move method *groups* into per-domain files that augment the
prototype, so no caller or tool handler changes.

Proposed modules under `apps/joomla-mcp/src/client/`:
`session`, `articles`, `categories`, `menus`, `modules`, `users`, `media`,
`admin-forms`, `site-build`. Each exports an object of methods merged via
`Object.assign(JoomlaClient.prototype, articlesMethods)` with a matching
`declare module` / interface-merge block so TypeScript keeps the unified type.

**Steps.**
1. Inventory the 221 methods into the 9 buckets (grep the `async`/`public`
   signatures; assign each to a domain). Land the bucketing as a comment map
   first, reviewable before any code moves.
2. Extract one domain at a time (start with the smallest, e.g. `media`), moving
   methods verbatim; run `scripts/tests/smoke.ts` after each extraction.
3. Keep `joomla-client.ts` as the assembly point that imports each domain file
   and performs the prototype merge, re-exporting `JoomlaClient` and
   `JoomlaResponse` unchanged so [index.ts:14](apps/joomla-mcp/src/index.ts#L14)
   is untouched.
4. After all 9: run `mcp-all-tools-test.ts` (full tool surface) as the regression
   gate.

**Acceptance.** `import { JoomlaClient, JoomlaResponse } from "./joomla-client.js"`
still resolves; `smoke.ts` and `mcp-all-tools-test.ts` pass; no single file over
~1k lines.

**Risk note.** Highest regression surface of the phase and pure structure with no
user-visible payoff — schedule last, behind a green `mcp-all-tools-test.ts`, and
do it as 9 small reviewable commits rather than one.

**Files.** `apps/joomla-mcp/src/joomla-client.ts` (becomes assembler),
`apps/joomla-mcp/src/client/*.ts` (new ×9).

---

## Cross-cutting: build / reload discipline

- After any change to a TS server (`joomla-mcp`, `agents-mcp`, `freshdesk-mcp`,
  `ftp-mcp`), **rebuild then call `reload_tools`** — Claude Code runs its own
  stdio orchestrator from `.mcp.json`; restarting port 9302 alone does not refresh
  in-session tools.
- Items 1, 3, 4, 5 touch the orchestrator's own process; in-session tool lists may
  need a fresh session, not just `reload_tools`.

## Out of scope (this phase)

- Gantry-mcp internal split (`mcp-server.js` 3.2k lines) and its second
  transport copy — migrate opportunistically only if the CJS transport build
  from Item 4 lands.
- Any change to downstream **tool behavior** or the agent **doc** layout.
