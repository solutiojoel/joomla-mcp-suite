# Agent-Runtime — Implementation Plan

> **Audience:** whoever executes the build (Jeremy + Claude Code sessions). One phase per work session is the intended pace; each phase ends in a shippable state.
> **Companions:** [`agent-runtime-architecture.md`](agent-runtime-architecture.md) (the design being built) and [`agent-runtime-api.md`](agent-runtime-api.md) (the binding contract — `[P1]`/`[P2]`/`[P3]` tags there map to Phases 1–3 here).
> **Reuse first:** the Agent SDK harness (`apps/agents-mcp/src/runtime.ts`), the StreamableHTTP MCP client (`apps/dashboard/server/mcp-client.js`), JSONL logging (`@solutio/logging`), and the shared HTTP layer (`packages/mcp-transport`) all exist — adapt, don't rewrite.

---

## Phase 0 — Hardening & enablers (small, do first)

Prereqs for anything multi-user; each is independently landable.

1. **`/healthz` on every MCP server** — add to `startHttpServer` in `packages/mcp-transport/src/index.ts` (unauthenticated `GET /healthz` → `{ ok: true, name, version }`; today any non-`/mcp` path 404s). Every app using `runServer` gets it for free; the runtime's own `/healthz` aggregates them.
2. **Hash + rotate orchestrator tokens** — `resolveSessionContext()` in `apps/orchestrator/orchestrator.js` compares `sha256(presentedToken)` against hashed keys in `config/users.json` (accept plaintext keys for one release as migration fallback). Add `scripts/hash-tokens.js` (hash-in-place + print new random tokens). Rotate all 7 live tokens; update `config/users.example.json` and each user's client config.
3. **`allowedAgents` per user** — extend `users.json` entries with `"allowedAgents": ["support", "menu-build", …]`; in the `switch_agent` handler (and its ListTools filtering), permit switching to any agent in the session's `allowedAgents` (hidden agents always excluded; `super_shannon` scope keeps switch-to-anything). Today only super_shannon can switch at all, which would block non-admin users from starting a menu-build chat.

**Verify:** `curl :9302/healthz`; MCP init with an old token fails, new hashed token works; a `support`-default token can `switch_agent` to an allowed agent and is refused others.

---

## Phase 1 — Scaffold `apps/agent-runtime` (the frontend dev can integrate from here)

New workspace app: TypeScript + Express, port **18310** (`AGENT_RUNTIME_PORT`). Same build toolchain as agents-mcp (tsc → CJS, dynamic `import()` for the ESM-only Agent SDK later).

```
apps/agent-runtime/src/
  index.ts        # express bootstrap, static frontend hosting (SPA fallback), /healthz
  auth.ts         # POST /api/auth/login, JWT middleware (RUNTIME_JWT_SECRET, 12h), GET /api/me
  users.ts        # config/runtime-users.json loader (bcrypt hash, orchestratorToken,
                  #   claudeOauthToken? encrypted-at-rest, allowedAgents, role)
  mcp.ts          # per-user orchestrator MCP client — adapt apps/dashboard/server/mcp-client.js,
                  #   add Authorization header + onprogress support
  catalog.ts      # GET /api/catalog (agents from config/agents non-hidden ∩ allowedAgents;
                  #   tools/prompts via live MCP listTools/listPrompts under caller's token;
                  #   jobs from jobs/catalog.json), GET /api/sites (from ftp-sites.json/docs/sites)
  store.ts        # better-sqlite3 at data/runtime.db (sessions, jobs, seq counters)
```

Also: `config/runtime-users.example.json`, `scripts/start-agent-runtime.ps1`, register in root `package.json` workspaces + start scripts, `.env.example` additions (`AGENT_RUNTIME_PORT`, `RUNTIME_JWT_SECRET`, `ORCHESTRATOR_URL`).

**Verify:** login → JWT → `/api/me`; `/api/catalog` for a menu-build-only user shows only that agent and its scoped tools; static hosting serves a placeholder index.html.

---

## Phase 2 — Chat sessions (the core)

1. **`sessions/chat-driver.ts`** — adapt `runSubAgent` from `apps/agents-mcp/src/runtime.ts`: dynamic-import `@anthropic-ai/claude-agent-sdk`, `query()` with a **streaming async-iterable prompt** (multi-turn), `mcpServers: { orchestrator: { type: "http", url, headers: { Authorization } } }`, `settingSources: []`, built-in tools off, `maxTurns` ~60, abort controller, `resume` support. **LLM credential resolution:** user's `claudeOauthToken` → else shared `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY`, injected into the subprocess env only.
2. **Bootstrap** — synthetic setup turn instructing `switch_agent` + `set_active_site`, validated via `get_current_agent`/`get_active_site` before the session opens. If flaky in practice, add the orchestrator enhancement instead: honor `X-Agent`/`X-Active-Site` headers at MCP session init to pre-seed session state.
3. **`sessions/manager.ts` + `sse.ts` + transcripts** — session registry with lifecycle (`active` → `idle` 15 min → `closed` 60 min/restart; resume on next message), per-session monotonic `seq`, JSONL transcript via `@solutio/logging`, SSE hub with `Last-Event-ID` replay from the transcript, `?token=` JWT auth on the stream route. Limits: 2 active sessions/user, 5 SDK loops global.
4. Endpoints per API doc §4 (create/list/get/messages/stream/interrupt/delete).

**Verify (end-to-end):** two users chat concurrently on different sites without cross-talk; kill the runtime mid-conversation, restart, send a message → session resumes; kill the SSE connection → reconnect replays missed events; interrupt stops a turn without killing the session; a user with no personal token transparently uses the shared credential.

---

## Phase 3 — Jobs, files, knowledge proxy, run monitor

1. **`files.ts`** — multipart upload (25 MB, pdf/png/jpg) → `workspace/uploads/<fileId>/<name>`; download route.
2. **`jobs/catalog.json` + `jobs/manager.ts`** — one catalog entry per agents-mcp tool (input schemas transcribed from `apps/agents-mcp/src/index.ts` `TOOLS`, with `pdf_path` fields exposed as `format: runtime-file-id` and resolved server-side). Worker: fresh MCP client per job (mirrors orchestrator policy: 10-min idle reset on progress, 30-min cap, **no retry**), progress-token heartbeats → job events, queue with per-user (1) and global limits, result parsing into `{ summary, artifacts, raw }`.
3. **Stop** — resolve the agents-mcp `runId` (from progress/log events), proxy `POST /api/jobs/:id/stop` → `http://127.0.0.1:3507/api/runs/<runId>/stop`.
4. **`knowledge.ts`** — proxy to `KNOWLEDGE_GATEWAY_BASE_URL` with server-held `X-Api-Key` + `X-On-Behalf-Of`; **`runs-proxy.ts`** — read-only proxy of the 3507 monitor.
5. **KB bridge Phase A** — on job success, POST a reference record per artifact to `/client-knowledge` (tags `site:<slug>`, `artifact:<kind>`, `run:<runId>`); stamp `kbRecordId` into the job result.

**Verify:** Tori's worked example A from the API doc runs end-to-end on a staging site — upload PDF → interpret job → live progress → stop works → re-run → spec artifact visible under `/api/knowledge/client-knowledge?tag=artifact:menu-spec`.

---

## Phase 4 — KB bridge B (dual-write in agents-mcp)

- `apps/agents-mcp/src/kb-sync.ts`: at run end, write spec/schematic/source-md **content** inline to gateway records alongside the existing workspace writes. Feature flag `KB_SYNC=1`. No read-path changes.
- Bridge C (gateway-first reads with workspace fallback in `contentBuildContext` and the run tools) is deliberately deferred until B has soaked.

**Verify:** run a build with the flag on → records appear in the gateway with correct tags; flag off → behavior identical to today.

---

## Phase 5 — The spare box

1. **Cloudflare setup** (one-time, in Jeremy's own free Cloudflare account; the company domain lives in the software developers' account and is not usable here):
   - Onboard the dashboard domain (Jeremy's existing Namecheap domain): add it to the Cloudflare account (Free plan), confirm the imported DNS records match Namecheap's (MX/email forwarding especially, if the domain is in use), then switch the domain's nameservers at Namecheap to the two Cloudflare assigns. Wait for Cloudflare to mark the zone active.
   - Zero Trust → create a tunnel; install `cloudflared` on the box as a Windows service with the tunnel token; add a public hostname `dashboard.<company-domain>` → `http://localhost:18310`.
   - Zero Trust → Access → application for that hostname; policy = allow-list of employee emails (One-Time PIN and/or Google login). Add a **service token** for the Replit dev environment while the frontend is being built.
2. **`docs/deploy-selfhosted.md` runbook:** install Node 22 + Git + Tailscale (admin access only) + `cloudflared` → clone repo → copy `.env` files + `config/*.json` → `npm ci` + build → tunnel + Access per step 1 → smoke test.
3. **`scripts/setup-scheduled-tasks.ps1`:** registers Task Scheduler entries — at-boot start for the full suite + agent-runtime, on-failure restart, nightly backup task (`workspace/`, `apps/agent-runtime/data/`, `config/`, `apps/agents-mcp/logs/` → second drive). `cloudflared` runs as its own Windows service.
4. **Network hygiene:** bind or firewall **all** ports — internal (9300–9306, 3506, 3507, 18305) *and* 18310 — to localhost (+ the Tailscale interface for admin). Nothing listens on LAN/WAN; the only user path is browser → Cloudflare Access → tunnel → localhost:18310.
5. Migrate operation from Jeremy's dev machine; deploy the frontend's static build into the runtime's public dir.

**Verify:** reboot the box → everything (including the tunnel) comes back with no human touch; `https://dashboard.<company-domain>` prompts for the Access email login from any network, then loads the dashboard; a non-allow-listed email is refused at the Cloudflare edge; all ports (incl. 18310) unreachable from the LAN directly; a long chat turn and a job stream survive >2 min through the tunnel (keepalives working); backup task produces a restorable copy; run one real menu-build job start-to-finish on the box.

---

## Dependency notes

- Order is 0 → 1 → 2 → 3 → 5; Phase 4 can run any time after 3.
- The frontend developer is unblocked by the API doc immediately, and by a live Phase-1 deployment for real integration.
- Risks and their owners are catalogued in the architecture doc §7 — re-read it before Phases 2 (LLM credentials) and 5 (network exposure).
