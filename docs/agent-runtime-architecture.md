# Solutio AI Dashboard — System Architecture

> **Audience:** the whole team — Jeremy (backend), the frontend developer, and anyone operating the box.
> **Companions:** [`agent-runtime-api.md`](agent-runtime-api.md) (the REST contract the frontend is built against) and [`agent-runtime-implementation-plan.md`](agent-runtime-implementation-plan.md) (build phases).
> **Status:** approved design, pre-implementation. Anything marked **NEW** does not exist yet.

---

## 1. The one-paragraph version

The MCP suite already has the *hands* (Joomla/Gantry/Freshdesk/FTP tool servers), the *front desk* (the orchestrator — one endpoint, per-user tokens, per-agent tool scoping), and *specialist workers* (agents-mcp sub-agents that do menu/content builds). What it lacks is a *face* (a website coworkers can open) and a *brain-for-hire* (the AI loop that Claude Code currently provides only on Jeremy's machine). This project adds both: a **NEW `apps/agent-runtime`** service that runs AI chat sessions and background jobs and exposes a plain REST + SSE API, and a frontend (developed in Replit, served as static files by the runtime) that talks only to that API. Everything runs on a spare Windows box, published to the team through a **Cloudflare Tunnel** at a company-controlled domain with **Cloudflare Access** (email login) in front — coworkers just open a URL in any browser, nothing to install. Tailscale remains on the box for Jeremy's admin access only.

---

## 2. Component map — current state

```
                            Claude Code / Claude Desktop (today's only client)
                                          │  MCP Streamable HTTP
                                          │  Authorization: Bearer <token>
                                          ▼
                        ┌─────────────────────────────────────┐
                        │  ORCHESTRATOR   :9302 /mcp          │  apps/orchestrator
                        │  • bearer auth (config/users.json)  │
                        │  • agent scope filtering            │
                        │  • per-session state:               │
                        │      activeSiteUrl, currentAgent    │
                        │  • injects active site into every   │
                        │    downstream call                  │
                        └───┬───┬───┬───┬───┬───┬───┬─────────┘
        ┌───────────────────┘   │   │   │   │   │   └───────────────────┐
        ▼                       ▼   ▼   ▼   ▼   ▼                       ▼
  joomla-mcp :9300      gantry-mcp :9301  ...  freshdesk :9303    agents-mcp :3506
  Joomla admin          Gantry layouts        ftp :9304           LLM sub-agents:
  + site workspace      + outlines/styles     mockup :9305        • menu-interpreter
  (specs, schematics,                                             • menu-builder
   source md, html)     knowledge-gateway-mcp :9306               • content-interpreter
                        thin proxy ──────────────────────┐        • content-writer
                                                         ▼        (Claude Agent SDK,
                                     shannon-data.replit.app/api   JSONL run logs,
                                     (the actual knowledge DB,     .stop cancellation,
                                      hosted on Replit)            run monitor :3507)
```

### 2.1 The orchestrator (the only door)

- **Endpoint:** single MCP Streamable-HTTP path `/mcp` (port `9302` native, `18302` in the Docker mapping). Every other path 404s. There are **no REST endpoints** today — no health check, no admin API.
- **Auth:** `Authorization: Bearer <token>` on every request. `config/users.json` maps token → `{ user, agent }`. The token therefore selects both **identity** (used for site-note/audit attribution) and the **starting agent scope**.
- **Session state:** each MCP session (keyed by `Mcp-Session-Id`) gets its own in-memory `activeSiteUrl` + `currentAgent`. Two users on separate sessions never collide. State dies on restart.
- **Scoping:** agent configs in `config/agents/<name>/<name>.json` define `tools.allow/deny` and `docs.allow`. Deny beats allow; configs are re-read every request (live edits, no restart). `switch_agent` is currently only callable by `super_shannon`-scoped sessions.
- **Aggregation:** downstream registry in `packages/mcp-downstream-client/src/index.ts`; per-server env overrides `<PREFIX>_URL` / `<PREFIX>_TOKEN`. A **fresh downstream client per call** (no stale connections). agents-mcp calls get special treatment: 10-min idle timeout reset by progress notifications, 30-min hard cap, **never retried** (a retry would spawn a duplicate concurrent build).

### 2.2 Endpoint inventory (what a session can call)

**Orchestrator-native tools** (defined in `apps/orchestrator/orchestrator.js`):

| Tool | Purpose |
|---|---|
| `set_active_site` / `get_active_site` | Select/confirm the session's working site (auto-fires Joomla login) |
| `get_site_notes` / `append_site_note` / `write_site_notes` | Per-site persistent facts + changelog (`docs/sites/<host>.md`) |
| `get_current_agent` / `switch_agent` | Read/change the session's agent scope |
| `get_agent_instructions` / `read_agent_doc` | Agent operating instructions and workflow/KB docs |
| `solutio_style_guide` / `solutio_particles` / `solutio_design_workflow` | Static house-convention references |
| `gantry_css_asset_smoke_test` | Composite FTP→Gantry→live-page validation |
| `reload_tools` / `gantry_reconnect` | Operational: refresh downstream tool maps / force Gantry re-auth |

**Proxied tool families** (name prefix → downstream): `joomla_*` → joomla-mcp, `gantry_*` → gantry-mcp, `freshdesk_*` → freshdesk-mcp, `ftp_*` → ftp-mcp, `knowledge_*` → knowledge-gateway-mcp, and the sub-agent tools below → agents-mcp.

**MCP prompts:** `work_on_site`, `build_solutio_site` — conversation starters a client may surface.

### 2.3 Agent scopes

| Agent | Selectable | Model | Purpose |
|---|---|---|---|
| `super_shannon` | ✔ | (session's) | Everything — all tools, all docs |
| `support` | ✔ | (session's) | Freshdesk ticket work; curated Joomla set, admin tools denied |
| `menu-build` | ✔ | (session's) | Menu build Phases 1–4 |
| `content-build` | ✔ | (session's) | Content build Phase 5 |
| `menu-interpreter` | hidden | Sonnet | PDF → Menu Spec (runs inside agents-mcp) |
| `menu-builder` | hidden | Haiku | Spec → Joomla skeleton (runs inside agents-mcp) |
| `content-interpreter` | hidden | Sonnet | PDF → schematic content fields (runs inside agents-mcp) |
| `content-writer` | hidden | Sonnet | Schematic → article HTML, batched (runs inside agents-mcp) |

The hidden four are **not** conversational agents — they are single-purpose workers launched by the `run_*` tools.

### 2.4 The sub-agent job layer (agents-mcp)

Nine tools; four run an LLM, five are deterministic:

| Tool | LLM | What it does |
|---|---|---|
| `run_menu_interpretation` | Sonnet | Menu PDF/text → validated Menu Spec JSON |
| `run_menu_build` | Haiku | Approved spec → Joomla categories/articles/menu items |
| `run_content_interpretation` | Sonnet | Same PDF → fills schematic content fields (structure locked) |
| `run_content_build` | Sonnet | Writes final article HTML per ~8-entry batch, auto-applies |
| `derive_content_schematic` | — | Spec → schematic scaffold; THE sync mechanism after spec edits |
| `discover_source_urls` | — | Old-site sitemap fuzzy-match → source URL proposals |
| `fetch_source_content` | — | Fetch old pages → Readability → markdown in workspace |
| `apply_content` | — | Push written HTML into Joomla articles (guarded overwrite) |
| `agent_ping` | — | 90-second transport/timeout validation spike |

**Execution model — important:** each call is one **long synchronous MCP call** (minutes to ~30 min) that emits progress notifications. There is no job queue or polling API at this layer. Around it already exist: JSONL run logs (`apps/agents-mcp/logs/<runId>.jsonl`), file-based cancellation (`<runId>.stop`), and a run-monitor HTTP API on **:3507** (`GET /api/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/stop`). The **NEW** agent-runtime wraps this into a proper async job model for the frontend (§4.4).

**Inputs:** `pdf_path` must be an absolute path readable by the server process — which is why uploaded files must land on the same machine (§4.5). **Outputs:** persisted to the joomla-mcp site workspace: `{slug}-menu-spec.json`, `{slug}-content-schematic.json`, `{slug}-source/*.md`, `{slug}-html/*.html` — plus live Joomla articles. Nothing flows to the Knowledge Gateway yet (§5 fixes that).

### 2.5 The Knowledge Gateway

`apps/knowledge-gateway-mcp` stores nothing — it proxies a REST API hosted on Replit at `KNOWLEDGE_GATEWAY_BASE_URL` (currently `https://shannon-data.replit.app/api`, `X-Api-Key` auth):

| Collection | REST | Contents |
|---|---|---|
| `/knowledge` | full CRUD | Universal (cross-client) knowledge: editing rules, triage/workflow docs |
| `/client-knowledge` | full CRUD | Per-site records keyed by `siteCode`: audit notes, site facts |
| `/self-improving` | full CRUD | Per-tool AI instructions, auto-versioned |
| `/audit` | read-only | Change log across the three tables |

This is the system's long-term data home: the goal is that specs, schematics, and job artifacts become gateway records manageable from the Replit side without touching this repo.

---

## 3. Target architecture

```
   Employee browser (office or home — any device, nothing installed)
        │
        │  https://dashboard.<company-domain>
        ▼
   Cloudflare edge — Tunnel + Access (email login wall, free tier)
        │
        │  outbound-only tunnel via cloudflared (Windows service on the box;
        │  no port forwarding, no inbound firewall holes)
        ▼  → localhost:18310
        │  • static frontend (same origin — no CORS)
        │  • REST + SSE, runtime JWT auth
        ▼
┌────────────────────────────────────────────────────────────────────┐
│  AGENT-RUNTIME  :18310                              NEW            │
│  apps/agent-runtime — TypeScript + Express                         │
│                                                                    │
│  ┌ auth ─────────┐  login → JWT; config/runtime-users.json maps    │
│  │               │  user → { bcrypt hash, orchestratorToken,       │
│  │               │           claudeOauthToken?, allowedAgents }    │
│  ├ catalog ──────┤  agents + jobs + tools + prompts, live-derived  │
│  ├ chat sessions ┤  Claude Agent SDK query() per session           │
│  │               │    LLM auth: user's own token, shared fallback  │
│  │               │    tools: orchestrator /mcp w/ user's bearer    │
│  ├ jobs ─────────┤  async wrapper over long-sync agents-mcp calls  │
│  ├ files ────────┤  uploads → workspace/uploads/<fileId>/          │
│  ├ knowledge ────┤  proxy → shannon-data.replit.app (key held here)│
│  ├ runs ─────────┤  proxy → agents-mcp monitor :3507               │
│  └ storage ──────┘  SQLite (users/sessions/jobs) + JSONL transcripts│
└──────────────┬─────────────────────────────────────────────────────┘
               │  MCP Streamable HTTP + per-user bearer token
               ▼
        ORCHESTRATOR :9302 /mcp  ──►  all downstreams (unchanged, §2)
```

Everything inside the box runs as **plain Node processes on one spare Windows machine** — no Docker, no cloud (§6).

### 3.1 Why the middle layer exists

1. **Someone must run the AI loop.** The frontend is static files; the browser can't hold Claude credentials or a 30-minute agentic session. The runtime is a rentable copy of what Claude Code does on Jeremy's machine today.
2. **Secrets stay server-side.** Orchestrator bearer tokens, Claude tokens, and the gateway API key never reach a browser.
3. **Decoupling (API-first).** The frontend is built against a stable REST contract; Jeremy can add agents, tools, and jobs behind it and they appear in `GET /api/catalog` without a frontend change.

---

## 4. How the runtime works

### 4.1 Identity chain

```
login (email+password, bcrypt)  →  runtime JWT (12h, browser-held)
        │
        └─ server-side user record (config/runtime-users.json):
              orchestratorToken   → sent as Bearer on every MCP call
                                    ⇒ orchestrator scoping + audit attribution
                                      work exactly as they do today
              claudeOauthToken?   → env for that user's SDK subprocesses
                                    ⇒ their sessions bill their subscription
              allowedAgents       → which chat agents they may start
```

- The JWT is the **only** credential the browser ever holds.
- LLM auth: the user's own `CLAUDE_CODE_OAUTH_TOKEN` (registered once via `claude setup-token`) if present; otherwise the shared credential (`CLAUDE_CODE_OAUTH_TOKEN` today, `ANTHROPIC_API_KEY` when adopted). A revoked/expired personal token degrades gracefully to the fallback.
- Per-user LLM tokens are stored encrypted at rest and injected only into that user's session subprocess environment.

### 4.2 Chat sessions

A chat session = one Claude Agent SDK `query()` loop (the same engine as Claude Code, pattern adapted from `apps/agents-mcp/src/runtime.ts`) with:

- `mcpServers: { orchestrator: { type: "http", url: ORCHESTRATOR_URL, headers: { Authorization: Bearer <user's token> } } }` — the model sees exactly the tools that user's current agent scope allows, enforced by the orchestrator, not the runtime.
- `settingSources: []`, built-in tools disabled — the agent's whole brain is its instruction file plus orchestrator tools.
- **Bootstrap:** orchestrator session state is per-MCP-connection, so agent + active site must be set *inside the SDK's own MCP session*. The runtime prepends a synthetic setup turn ("call `switch_agent(X)` then `set_active_site(Y)`"), then validates via `get_current_agent`/`get_active_site` before opening the session to the user. (Fallback if flaky: orchestrator honors `X-Agent`/`X-Active-Site` headers at session init — small enhancement, see implementation plan.)
- **Persistence & resume:** every event appends to `apps/agent-runtime/data/transcripts/<sessionId>.jsonl` (same `@solutio/logging` idiom as agents-mcp run logs); session metadata in SQLite. The SDK's `resume` lets a closed/expired/post-restart session continue transparently — the user just sends the next message.
- **Streaming:** SSE (§4.3). **Interrupt:** abort the in-flight turn, session stays open.
- **Limits:** 2 active chat sessions + 1 running job per user; 5 concurrent SDK loops globally (each spawns a subprocess — this is the box's real capacity constraint).

### 4.3 Streaming: why SSE, not WebSockets

Traffic is strictly server→client (user turns arrive as normal POSTs). SSE survives proxies untouched, needs no client library (`EventSource` is built into browsers), and auto-reconnects with `Last-Event-ID` — which maps 1:1 onto the per-session monotonic `seq` we already persist, so reconnect replay comes free from the transcript. One caveat is designed in: `EventSource` cannot send headers, so the two stream endpoints accept the JWT as `?token=`. Because the streams traverse the Cloudflare proxy (which drops connections idle ~100 s between bytes), the runtime emits an SSE comment keepalive (`: ping`) every 25 s on quiet streams; a dropped stream is harmless anyway — reconnect replay covers it.

### 4.4 Jobs: bridging sync to async

The frontend can't hold a 30-minute HTTP request open, so the runtime converts:

```
POST /api/jobs → 202 { jobId }        (validated against the job's JSON Schema)
   runtime worker opens a FRESH MCP client (matching orchestrator policy),
   calls the agents-mcp tool with progress-token,
   each heartbeat → job event → SSE stream + lastProgressAt
   completion → parsed result stored on the job row
POST /api/jobs/:id/stop → proxies to :3507 /api/runs/<runId>/stop (.stop file)
```

Job types live in `jobs/catalog.json` — data, not code. Each entry: title, description, JSON-Schema input, mapping to the MCP tool args (with `$file(...)` resolution for uploads). **Adding a new sub-agent = adding a catalog entry;** it appears in the frontend automatically.

### 4.5 Files

`POST /api/files` (multipart, 25 MB cap, pdf/png/jpg) → `workspace/uploads/<fileId>/<originalName>`. Because runtime and agents-mcp share one machine, the runtime resolves a `fileId` to the absolute path agents-mcp requires for `pdf_path` — no agents-mcp changes needed. Uploads are never served back with executable/permissive content types.

### 4.6 Knowledge proxy

`/api/knowledge/*` forwards to the gateway REST API with the server-held `X-Api-Key`, adding `X-On-Behalf-Of: <user email>` for attribution. Proxy rather than direct-from-frontend so the key stays server-side and the frontend has exactly one base URL and one auth scheme.

---

## 5. Knowledge-base bridge (workspace files → gateway)

Goal: job inputs/outputs become gateway records manageable from the Replit side. Phased so nothing breaks:

| Phase | What changes | Risk |
|---|---|---|
| **A — references** | On job success the runtime POSTs a *reference record* per artifact (path, hash, site, runId) to `/client-knowledge` with tags like `["site:{slug}","artifact:menu-spec","run:{runId}"]`. Files stay the source of truth. | none — additive |
| **B — dual-write** | `kb-sync.ts` in agents-mcp (flag `KB_SYNC=1`) writes spec/schematic/source-md *content* inline into gateway records at run end, alongside the file writes. | low — reads unchanged |
| **C — gateway-first** | Consuming tools resolve spec/schematic from the gateway first, workspace file as fallback. Workspace becomes cache/scratch. | the real migration |

Permanently file-based (reference records only): article HTML (large, consumed locally by `apply_content`) and uploaded PDFs.

---

## 6. Deployment — the spare Windows box

**Principle:** the box is a clone of the setup that already runs on Jeremy's dev machine — plain Node processes — plus auto-start and backups. No Docker (adds a WSL2 VM, update breakage, and path-translation bugs for zero benefit on a single dedicated Windows host; the Dockerfile remains for a future cloud move).

| Concern | MVP answer |
|---|---|
| OS / runtime | Windows + Node.js 22, `git clone`, `npm ci`, `npm run build` |
| Reachability | **Cloudflare Tunnel** — `cloudflared` runs as a Windows service on the box and holds an *outbound-only* connection to Cloudflare; `https://dashboard.<company-domain>` routes through it to `localhost:18310`. No port forwarding, no inbound firewall holes, no public IP exposure; HTTPS terminates at Cloudflare for free. Prereq: a domain whose DNS lives in **Jeremy's own free Cloudflare account** — the company domain is in the software developers' account and can't be partially delegated on the free plan, so a dedicated ~$10/yr domain registered via Cloudflare Registrar is the plan (the stack's only recurring cost) |
| User access control | **Cloudflare Access** (Zero Trust free tier, ≤50 users) in front of the hostname — allow-list of employee emails, verified by one-time PIN or Google sign-in, *before* a request ever reaches the box. The runtime's own JWT login is the second, application-level layer |
| Admin access | **Tailscale stays on the box** for Jeremy only — RDP/SSH in, `git pull`, restarts. Coworkers never need it |
| Process supervision | **Windows Task Scheduler**: at-boot + on-failure restart tasks wrapping the existing start scripts + `start-agent-runtime.ps1`; `cloudflared` supervises itself as a service |
| Frontend hosting | Static build served by the runtime at `/` (same origin) |
| Backups | Nightly scheduled task copies `workspace/`, `apps/agent-runtime/data/`, `config/`, `apps/agents-mcp/logs/` to a second drive |
| Network hygiene | All service ports (9300–9306, 3506, 3507, 18305) bound/firewalled to localhost (+ the Tailscale interface for admin); :18310 itself also stays localhost-only — the *only* way in is through the tunnel, which enforces Access |
| Updates | Remote in over Tailscale: `git pull`, `npm run build`, restart tasks |
| Replit bonus | Because the API is now at a public (Access-gated) URL, the frontend dev can hit it live *from Replit itself* during development — a Cloudflare Access **service token** can authenticate the Replit dev app. Final build is still deployed onto the box for same-origin serving |

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Per-user OAuth tokens** aren't Anthropic's supported path for services (each employee using their own subscription for their own work is the defensible shape; a single shared token across the team is not) | Shared-credential fallback wired in from day one; plan the switch to a metered `ANTHROPIC_API_KEY` if policy or rate limits (Pro plans have tight 5-hour windows) bite. Tokens encrypted at rest, server-side only |
| **7 plaintext orchestrator tokens** in `config/users.json` | Phase 0: store sha256 hashes, rotate all tokens, add `scripts/hash-tokens.js` |
| **Public exposure via the tunnel** — the dashboard is reachable from the internet (unlike a tailnet-only setup) | Cloudflare Access email allow-list gates every request *before* it reaches the box; runtime JWT is a second layer; only :18310 is tunneled — nothing else on the box is routable; Access logs give an audit trail |
| **Single box** — power/disk/ISP failure kills mid-run jobs | Task Scheduler restarts, nightly backups, UPS recommended; architecture is host-agnostic (lift the same processes to a cloud VM later) |
| **In-memory session state** (orchestrator MCP sessions, runtime chat sessions) lost on restart | SDK `resume` + persisted transcripts re-bootstrap agent/site; drain running jobs before planned restarts |
| **30-min sync agents-mcp calls** | Stay on one machine — never route them through any proxy with a short request timeout; job queue is the back-pressure |
| **Unauthenticated internal ports** (3507 monitor, 18305 legacy dashboard, all MCP ports) | Firewall to localhost (+ Tailscale for admin); never routed through the tunnel; human access only via the runtime's authenticated proxy |
| **Uploads fed to an LLM** | Size/type caps, stored outside any static-served dir, path resolution only through the fileId indirection |

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **Orchestrator** | The single MCP endpoint (`:9302/mcp`) that authenticates users, scopes tools per agent, and proxies to downstream servers |
| **Agent scope** | A named tool/doc allow-list (`config/agents/`) a session operates under |
| **Sub-agent** | A hidden single-purpose LLM worker (menu-interpreter etc.) run by agents-mcp via the Claude Agent SDK |
| **agent-runtime** | **NEW** service that runs chat sessions + jobs and exposes the frontend REST/SSE API |
| **Job** | The runtime's async wrapper around one long-running agents-mcp tool call |
| **Workspace** | The joomla-mcp file area holding specs/schematics/source/html per site slug |
| **Knowledge Gateway** | The Replit-hosted REST API (`shannon-data.replit.app`) that stores universal/client/self-improving knowledge — the system's long-term data home |
| **Cloudflare Tunnel** | Outbound-only connector (`cloudflared` service on the box) that publishes `localhost:18310` at `https://dashboard.<company-domain>` — no open inbound ports |
| **Cloudflare Access** | Free Zero Trust login wall (email allow-list, OTP/Google) in front of the tunnel hostname — how coworkers are admitted |
| **Tailnet** | The company's private Tailscale network — retained on the box for admin (RDP, updates) only; not required by dashboard users |
