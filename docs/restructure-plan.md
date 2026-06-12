# Joomla MCP Suite — Restructure & Multi-User Implementation Plan

> Drafted 2026-06-11. Companion to the boss's "Solutio Tool Architecture" document.
> Goal: adopt that document's principles (strict permissions, independent servers,
> testability, approval for risky writes) while making the suite safe for ~6
> concurrent users — without rebuilding the Joomla/Gantry session machinery
> per-capability.

---

## Current codebase — read these before implementing

| File | Size | What to know |
|------|------|--------------|
| `apps/orchestrator/orchestrator.js` | 837 lines | The only file changed in Phases 0–2. Single `activeSiteUrl` global at line 50 (Phase 1.2 target). HTTP handler at line 764 (Phase 0.1 target). `buildServer()` at line 163 — a fresh Server is created per HTTP session; session state goes inside here. `HIDDEN_JOOMLA_TOOLS` set at line 435 is checked in ListTools only — also needs enforcing in CallTool (Phase 0.2). Silent URL auto-detect at lines 669–683 (Phase 0.3 delete). |
| `apps/joomla-mcp/src/index.ts` | 2,044 lines | Tool registration + CallTool handler. One `JoomlaClient` + `isLoggedIn` flag per process (Phase 1.3 target: replace with `Map<siteUrl, {client, lastUsed}>`). |
| `apps/joomla-mcp/src/joomla-client.ts` | 6,331 lines | All Joomla HTTP/form automation. Not changed until Phase 4. |
| `apps/joomla-mcp/src/freshdesk-client.ts` | 415 lines | Moves verbatim to `apps/freshdesk-mcp/` in Phase 3. |
| `apps/joomla-mcp/src/ftp-client.ts` | 393 lines | Moves verbatim to `apps/ftp-mcp/` in Phase 3. `ftp-sites.json` moves with it. |
| `apps/gantry-mcp/mcp-server.js` | 3,354 lines | Already site-keyed (`ctxCache` Map at line ~59) — model for Phase 1.3. Has one cross-server call at lines 40–55 (`joomlaMcpClient`) — eliminated in Phase 3.4. |
| `apps/orchestrator/solutio-conventions.js` | 1,391 lines | Style guide + particle reference data. Not changed. |
| `docs/agents/` | flat dir | All workflow guides currently live at one level. Phase 2.5 reorganizes into `global/`, `support/`, `menu-content/`, `design/`, `launch/` subdirs. Doc names must keep resolving (KB accessor handles the mapping). |

---

## Target end state

```
joomla-mcp-suite/
  apps/
    orchestrator/   auth, per-session state, agent definitions, KB accessor, routing
    joomla-mcp/            Joomla admin automation (site-keyed sessions)
    gantry-mcp/            Gantry 5 layout/theming (already site-keyed)
    freshdesk-mcp/         NEW — Freshdesk API tools
    ftp-mcp/               NEW — FTP tools + ftp-sites.json ownership
    dashboard/             unchanged
  packages/
    mcp-transport/         shared StreamableHTTP server bootstrap + CORS
    logging/               shared structured logging
  docs/
    agents/
      global/              docs every agent can read
      support/             support-agent docs
      menu-content/        menu-content agent docs  ← NEW (matches agent name)
      design/              admin-only Gantry/FTP design docs
      launch/              admin-only launch/closeout docs
    sites/                 per-site history (unchanged, all agents)
  config/
    agents/                agent definitions (JSON) — gitignored, example checked in
    users.json             token → user + agent mapping — gitignored, example checked in
```

**Key architectural decisions (already agreed):**

1. Four downstream servers split by **backend protocol/credential domain**
   (Joomla forms, Gantry JSON API, Freshdesk REST, FTP) — not by capability.
2. The orchestrator stays a **router with enforcement**, not an LLM planner.
   Claude (the MCP client) is the planner; the orchestrator enforces what each
   agent may do.
3. **Agent definitions** bundle: allowed tools + allowed docs + an instruction
   file. An "agent" here is a named job role (support, design) that a session
   runs as — the LLM client is the brain, the agent definition is its scope.
   The "super agent" is just the `admin` agent with wildcards — same
   enforcement code path, different data.
4. KB access goes through a single **accessor module** so the later move to a
   database/API is a one-module swap.

---

## Phase 0 — Security quick wins (½–1 day, no restructuring)

Do these first; each is small, isolated, and closes a real hole.

| # | Task | Where | Notes |
|---|------|-------|-------|
| 0.1 | Inbound bearer-token check on `/mcp` | `orchestrator.js` HTTP handler (~line 764) | Check `Authorization: Bearer <token>` before any routing. Interim: a single `ORCHESTRATOR_TOKEN` env var; reject if header missing or mismatch. Phase 1 replaces this with the per-user registry. Also change `CORS_ORIGIN` default from `*` to `process.env.CORS_ORIGIN \|\| 'http://localhost'` (require explicit opt-in for broad access). |
| 0.2 | Enforce `HIDDEN_JOOMLA_TOOLS` in CallTool | `orchestrator.js` CallTool handler | Currently filtered from ListTools only; `joomla_login` is still routable by name. |
| 0.3 | Remove silent site auto-detection | `orchestrator.js` (~lines 669–683) | Return the existing "call set_active_site first" error instead of adopting any URL-shaped argument as the active site. |
| 0.4 | Repo hygiene | `.gitignore`, README | Ignore `apps/gantry-mcp/{discovery,exports,backups}` and any committed `node_modules`. Fix README tool reference (consolidated action-based tools) and add dashboard to the layout section. |

**Acceptance:** unauthenticated requests to `/mcp` are rejected; `joomla_login`
called by name returns an error; a tool call with a URL argument and no active
site errors instead of switching sites.

---

## Phase 1 — Multi-user safety (2–4 days)

This is what makes 6 simultaneous users possible. Everything else can trail it.

### 1.1 Per-user tokens

`config/users.json` (gitignored; example file checked in):

```json
{
  "tok_jeremy_xxxx":  { "user": "jeremy@solutiosoftware.com",  "agent": "admin" },
  "tok_coworker_xx":  { "user": "coworker@solutiosoftware.com", "agent": "admin" },
  "tok_support_01":   { "user": "support1@solutiosoftware.com", "agent": "support" }
}
```

Orchestrator resolves token → `{ user, agent }` at session creation and
attaches it to the session. Until Phase 2 lands, the `agent` field is stored
but only `admin` exists.

### 1.2 Per-session active site

Move `activeSiteUrl` (currently a module-level global, `orchestrator.js:50`)
into per-session scope. The plumbing exists: the HTTP layer already builds a
fresh `Server` per MCP session (`startHttp`, lines 786–796). Move the variable
inside `buildServer()` and thread it through the handlers. Session object
shape: `{ activeSiteUrl, user, agent }`.

### 1.3 Site-keyed session cache in joomla-mcp

**The most important concurrency fix.** joomla-mcp currently holds one
`JoomlaClient` + one `isLoggedIn` flag and mutates it when `site_url` changes —
two users on different sites cause session thrash and an in-flight race.

Mirror gantry-mcp's proven pattern (`ctxCache` in `mcp-server.js`, keyed by
site, with TTL):

- `Map<siteUrl, { client: JoomlaClient, lastUsed }>` with a TTL slightly under
  Joomla's 15-minute admin session (gantry uses 12 min).
- Every tool call resolves its client from the map via the injected `site_url`;
  no shared mutable "current site."
- Evict + re-login on auth failure.

### 1.4 Changelog attribution

`append_site_note` / `write_site_notes` automatically stamp the session's
`user` on entries (e.g. in the `**Requested by:**` line or a trailing
`_logged by jeremy@…_`). With one shared Joomla admin login, this is the only
record of *who* made a change.

**Acceptance:** two concurrent MCP sessions pointed at different sites can
interleave write calls without cross-contamination (test: parallel
`joomla_article list` + `gantry_outlines_list` against two sites from two
clients); site-note entries carry the author.

**Out of scope (deliberately):** locking two users out of editing the *same*
site simultaneously. Joomla check-in/check-out plus Gantry auto-backups are the
safety net; revisit only if it bites in practice.

---

## Phase 2 — Agent definitions & knowledge-base scoping (3–5 days)

### 2.1 Agent definition schema

> **Design rationale:** the primary goal of scoping agents is **consistency and
> testability**, not just security. A narrower tool surface means the LLM has
> fewer paths to wander down, behavior is more predictable, and job workflows
> can be tested in isolation. "The menu-content agent always does menu and content things" is
> a verifiable property. Restriction is a side-effect, not the point.

`config/agents/<name>.json`:

```json
{
  "name": "support",
  "description": "Freshdesk ticket resolution — diagnose, fix, close",
  "instructions": "agents/support.md",
  "tools": {
    "allow": [
      "set_active_site", "get_active_site", "get_agent_instructions",
      "get_site_notes", "append_site_note", "write_site_notes",
      "read_agent_doc", "reload_tools",
      "joomla_article", "joomla_category", "joomla_menu*", "joomla_module*",
      "joomla_media", "joomla_bulk_checkin",
      "joomla_get_frontend_*", "joomla_verify_frontend_content",
      "freshdesk_*"
    ],
    "deny": ["joomla_submit_admin_form", "joomla_permissions", "joomla_user*", "joomla_group*"]
  },
  "docs": {
    "allow": ["global/*", "support/*"]
  }
}
```

```json
{
  "name": "menu-content",
  "description": "Content and menu building — articles, categories, menus, modules",
  "instructions": "agents/menu-content.md",
  "tools": {
    "allow": [
      "set_active_site", "get_active_site", "get_agent_instructions",
      "get_site_notes", "append_site_note", "write_site_notes",
      "read_agent_doc", "reload_tools",
      "joomla_article", "joomla_category", "joomla_menu*", "joomla_module*",
      "joomla_media", "joomla_bulk_checkin",
      "joomla_get_frontend_*", "joomla_verify_frontend_content",
      "joomla_plan_site_build", "joomla_apply_site_build",
      "joomla_docman_*", "joomla_redirects_list"
    ],
    "deny": ["joomla_submit_admin_form", "joomla_permissions", "joomla_user*", "joomla_group*"]
  },
  "docs": {
    "allow": ["global/*", "menu-content/*"]
  }
}
```

```json
{
  "name": "admin",
  "description": "Super agent — all tools, all docs, no restrictions",
  "instructions": "agents/admin.md",
  "tools": { "allow": ["*"] },
  "docs":  { "allow": ["*"] }
}
```

**What separates support from menu-content:**
- `support` is anchored to the Freshdesk workflow — fix the thing the ticket
  describes, close it, move on. Its tool list overlaps heavily with
  `menu-content` so it doesn't stall on routine fixes, but its instruction
  file and doc scope orient it toward diagnosis and minimal intervention.
- `menu-content` is for deliberate build work — new pages, menus, article
  structures, full site-build pipeline. Menu and content tools are bundled
  together because they're inseparable in practice (a menu item needs an
  article to point to, a category to organize it).

- Glob-style matching (`*` suffix), `deny` beats `allow`.
- Site-notes tools and the session-protocol tools are hard-wired into every
  agent (not configurable) — the changelog discipline is the backbone of the
  multi-agent setup.

**Starting agent set — three, deliberately:** `support`, `menu-content`, `admin`.
Add more only when a real job needs one; over-fragmenting agents is the main
failure mode of this design. Joel's Gantry design work runs as `admin`.

**Files to create as part of Phase 2:**
- `config/agents/support.json`, `config/agents/menu-content.json`, `config/agents/admin.json` (definitions above)
- `config/users.json` (gitignored) — real token registry
- `config/users.example.json` — checked-in example
- `config/agents/support.md` — support agent instruction file (adapted from AGENTS.md, freshdesk-workflow focus)
- `config/agents/menu-content.md` — menu-content agent instruction file (adapted from AGENTS.md, build-workflow focus)
- admin instructions: falls back to the project-root AGENTS.md (no separate file)
- Add `config/users.json` to `.gitignore`. **Decided 2026-06-12:** `config/agents/*.json` stay checked in — they contain scope rules, not secrets, and reviewing scope changes in git history is a feature.

> **Terminology note:** an *agent definition* is the JSON scope bundle; the
> LLM session "runs as" that agent. Distinct from `docs/agents/` (workflow
> guides), which keeps its existing name.

### 2.2 Enforcement (permissions, not prompts)

In the orchestrator, both directions:

- **ListTools** → only the agent's allowed tools (and `read_agent_doc`'s
  `enum` lists only the agent's allowed docs).
- **CallTool** → re-check the agent's scope before routing. An out-of-scope
  tool or doc name called directly returns a permission error.

### 2.3 KB accessor module

New `apps/orchestrator/kb.js` (or `packages/kb` later), the **only**
place that touches the docs filesystem:

```
listDocs(agent)          → [{ name, title, scope }]
readDoc(agent, name)     → string | PermissionError | NotFoundError
readInstructions(agent)  → string
```

- Maintains the doc-name → file-path mapping, so **existing doc names keep
  working** (`kb/staff-grid` still resolves even though the file moves to
  `docs/agents/support/kb/staff-grid.md`). No CLAUDE.md reference breaks.
- When the KB moves to a database/API, only this module changes. Handlers
  never call `fs` for docs. Treat site notes the same way (`sites.js`
  accessor) — they're equally likely to move to the DB.

### 2.4 Per-agent instructions

`get_agent_instructions` returns the session agent's instruction file
instead of the monolithic AGENTS.md. Each agent's file contains: the session
protocol (active site → instructions → site notes → editing-rules), its doc
index (only what it can read), and its job-specific workflow. The current
AGENTS.md becomes the `admin` agent's instructions, mostly unchanged.
Update `scripts/sync-agent-docs.ps1` accordingly (CLAUDE.md ↔ admin agent).

### 2.5 Doc reorganization (initial mapping)

| Scope | Who can read | Docs |
|-------|-------------|------|
| `global/` | all agents | editing-rules, improvements, kb/site-history, kb/content-standards, kb/css-table-classes, kb/site-config |
| `support/` | support + admin | freshdesk-agent, kb/user-accounts, kb/quick-galleries, kb/ministry-platform-widget, kb/popup, kb/podcasting, kb/calendar-feed, kb/elfsight, kb/acymail, kb/business-directory, kb/error-pages |
| `menu-content/` | menu-content + admin | content-agent, menu-agent, custom-page-agent, kb/staff-grid, kb/staff-pages, kb/teacher-pages, kb/grid-layout, kb/animate-on-scroll, kb/subpage-backgrounds |
| `design/` | admin only | gantry-section-css, gantry-particle-map, gantry-visual-qa, ftp-css-smoke-test, gantry-design-agent |
| `launch/` | admin only | kb/dns-launching, kb/redesign-launch, kb/pre-training-audit, kb/project-closeout |

**Notes on this mapping:**
- `content-agent.md` and `menu-agent.md` are `menu-content/` scope — support
  agents follow the `freshdesk-agent.md` workflow which calls those docs on
  demand via `read_agent_doc` if needed. If that proves limiting, move them to
  `global/`.
- `custom-page-agent` (FTP + CSS workflows) is `menu-content/` not `design/` —
  menu-content agents need it for custom page builds even without Gantry access.
- When in doubt, put a doc in `global/`: an agent missing a house convention is
  worse than an agent seeing an extra doc.

**Acceptance:** a `support`-token session lists only support tools/docs and gets
a permission error calling `gantry_layout_edit` or reading `gantry-design-agent`
by name; a `menu-content` session can call `joomla_plan_site_build` and read
`menu-agent` but not `gantry_layout_add`; an `admin` session sees everything;
all doc names referenced in CLAUDE.md still resolve.

---

## Phase 3 — Server split: freshdesk-mcp and ftp-mcp (2–3 days)

Mechanical once Phases 1–2 are stable.

### 3.1 Extract freshdesk-mcp

- New `apps/freshdesk-mcp/` (TypeScript, reuse `freshdesk-client.ts` verbatim).
- Owns `FRESHDESK_DOMAIN` / `FRESHDESK_API_KEY`. No Joomla session, no site
  context needed.
- Port 9303 internal.

### 3.2 Extract ftp-mcp

- New `apps/ftp-mcp/` (reuse `ftp-client.ts` + **moves `ftp-sites.json` with
  it** — ftp-mcp owns per-site FTP credentials).
- Orchestrator keeps injecting the active site so ftp-mcp resolves credentials.
- Port 9304 internal.

### 3.3 Orchestrator: downstream registry

Replace the hardcoded joomla/gantry pair with a config-driven registry:

```json
[
  { "label": "joomla-mcp",    "url": "…:9300/mcp", "inject": "site_url" },
  { "label": "gantry-mcp",    "url": "…:9301/mcp", "inject": "site" },
  { "label": "freshdesk-mcp", "url": "…:9303/mcp", "inject": null },
  { "label": "ftp-mcp",       "url": "…:9304/mcp", "inject": "site_url" }
]
```

Routing = lookup tool name across per-server tool maps (current behavior,
generalized). Freshdesk's "no active site required" special case becomes
`inject: null` instead of a name-prefix check.

### 3.4 Fix the cross-server call

`gantry_css_asset_smoke_test` currently opens its own MCP client to joomla-mcp
for `ftp_*` calls (`mcp-server.js:40–55`). Move the smoke test up into the
orchestrator as a composite tool that calls gantry-mcp and ftp-mcp itself —
removing the suite's one tool-to-tool dependency, per the architecture doc.

### 3.5 Deployment updates

`scripts/start-all.sh` (two new processes + wait_for_port), `Dockerfile`,
`docker-compose.yml`, `.env.example`. Remove Freshdesk/FTP code and env vars
from joomla-mcp once the new servers are confirmed working.

**Acceptance:** full smoke test through the orchestrator touching all four
servers; freshdesk + ftp tools work from a fresh container; joomla-mcp no
longer contains freshdesk/ftp code.

---

## Phase 4 — Shared packages & internal refactor (ongoing, 4–6 days)

Lower urgency; pure structure, no behavior change.

1. **`packages/mcp-transport`** — the StreamableHTTP server bootstrap + CORS
   block currently pasted into orchestrator, joomla-mcp, and gantry-mcp (and
   soon two more servers). Decide the module-system question once here: ship
   the package CJS-compatible, or take the opportunity to converge on TS.
   Adopt npm workspaces at the repo root.
2. **`packages/logging`** — shared structured logger (currently each server
   has its own `log()`).
3. **Split `joomla-client.ts` (6.3k lines)** into domain modules within
   joomla-mcp: `session`, `articles`, `categories`, `menus`, `modules`,
   `users`, `media`, `admin-forms`, `site-build`. Same for gantry
   `mcp-server.js` (3.3k): move tool definitions/handlers into per-domain
   files under `tools/`.
4. **Tests per server** — gantry-mcp has none today. Minimum bar: a smoke
   script per server (joomla-mcp's `scripts/tests/` pattern) + orchestrator
   tests for agent-scope enforcement (the highest-value tests in the suite: assert
   that a support session *cannot* call admin tools).

---

## Phase 5 — Risk gating for destructive writes (1–2 days, optional but boss-aligned)

Tag the genuinely dangerous tools and enforce a confirmation step in the
orchestrator (not in prompts):

- **Tier "destructive":** `gantry_outlines_delete`, `joomla_submit_admin_form`,
  `ftp_delete_file`, `joomla_permissions` writes, user/group deletes,
  `gantry_layout_clear`.
- Enforcement: the orchestrator rejects these unless the call includes
  `confirm: true` (added to the schema at list time) — making the agent state
  intent explicitly — and, where a snapshot tool exists for the target, a
  snapshot was taken this session. dryRun/snapshot primitives already exist;
  this makes them mandatory instead of conventional.

---

## Sequencing & effort summary

| Phase | What | Effort | Unblocks |
|-------|------|--------|----------|
| 0 | Security quick wins | ½–1 day | Safe to expose the port at all |
| 1 | Tokens, per-session state, site-keyed joomla sessions | 2–4 days | **6 concurrent users** |
| 2 | Agent definitions + KB scoping + accessor | 3–5 days | `support`/`menu-content`/`admin` agents, super agent, future DB move |
| 3 | freshdesk-mcp + ftp-mcp split, registry routing | 2–3 days | Boss's independent-server requirement |
| 4 | packages/, file splits, tests | 4–6 days | Maintainability, evals |
| 5 | Destructive-write gating | 1–2 days | Boss's approval-for-risky-actions requirement |

Phases 0–1 are strictly ordered. Phase 2 depends on 1 (agent definitions hang
off session identity). Phase 3 depends on 2 only for the registry's agent
interaction — it can run in parallel with late Phase 2 if two people work it.
Phases 4–5 are independent of each other.

**Migration for the team:** you and your coworker keep running independent
instances until Phase 1 acceptance passes, then converge on the shared
deployment with `admin` tokens. New users get scoped tokens as Phase 2
agent definitions land.

## Risks & open questions

- **One shared Joomla admin login** for all 6 users: changelog attribution
  (1.4) papers over it, but Joomla's own audit trail will show one user.
  Per-user Joomla accounts are a future option, not in this plan.
- **Same-site concurrent edits** are not locked (see Phase 1 out-of-scope).
- **Module system split** (CJS gantry/orchestrator vs TS ESM joomla-mcp) makes
  `packages/` slightly awkward — resolve in Phase 4, don't let it block 0–3.
- **Agent granularity**: start with 3 agent definitions; resist adding more until a
  real job needs one.
- **KB → database timing**: nothing in Phases 0–3 needs to know; the accessor
  module (2.3) is the contract.
