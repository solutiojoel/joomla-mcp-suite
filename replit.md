# Joomla MCP Suite — Replit

A multi-server MCP orchestration suite that gives AI agents programmatic control over a Joomla + Gantry 5 site. Originally Docker-based; adapted to run directly on Replit.

## Architecture

**Single-process mode (default — dev workflow and production deployment):**

```
scripts/start-single.sh → node apps/orchestrator/orchestrator.js  (port 5000)
  ├── joomla-mcp             hosted in-process (in-memory MCP transport)
  ├── gantry-mcp             hosted in-process
  ├── freshdesk-mcp          hosted in-process
  ├── ftp-mcp                hosted in-process
  └── knowledge-gateway-mcp  hosted in-process
```

One web process, one port — this is what lets the suite publish as a Replit
Autoscale deployment (scales to zero when idle, wakes on request).
`INPROCESS_DOWNSTREAMS=1` activates this mode; each Node downstream exports
`buildServer()` with no side effects on require.

**Legacy multi-process mode** (`scripts/start-all.sh`) still works: each server
gets its own loopback HTTP port (9300–9307).

Agents connect to the **orchestrator** `/mcp` endpoint with a bearer token.
Unauthenticated status dashboard at `/`, `/status`, `/status.json`.

### Authentication — two modes

The orchestrator prefers a **user registry**: a map of `sha256:<hex>` token
digests → `{ user, agent, allowedAgents? }`. It gives each person their own
revocable token, their own default agent scope, and their own name in the audit
log. Generate and rotate tokens with `scripts/hash-tokens.js`.

Locally the registry is the gitignored file `config/users.json`. That file never
reaches a deployment, so set the secret **`ORCHESTRATOR_USERS_JSON`** to the same
JSON instead — paste the file contents verbatim, newlines and all. The digests
are one-way, so the secret holds no usable token.

Without a registry the orchestrator falls back to **single-token mode**: one
shared `ORCHESTRATOR_TOKEN`, every caller recorded as `local` with the
`super_shannon` scope. A loaded registry replaces this outright, so
`ORCHESTRATOR_TOKEN` stops authenticating once `ORCHESTRATOR_USERS_JSON` parses.
Keep it set anyway — it is what takes over if the secret is ever malformed.

Call `reload_tools` to confirm which mode is live. It reports the token count and
the source it loaded from.

### Autoscale behavior change (by design)

In production the app scales to zero when idle. In-memory session state —
the MCP session, active site selection, and cached Joomla/Gantry logins —
is lost when an idle instance is recycled. Clients must re-initialize their
MCP session and call `set_active_site` again after a reconnect (most MCP
clients handle the reconnect automatically). The first request after idle
takes a few seconds (cold start).

## How to Run

The "Start application" workflow runs `bash scripts/start-single.sh`
automatically. The deployment uses the same entry point (build:
`npm run build && pip install 'mcp[cli]' pyyaml`).

## Required Environment Secrets

Set these in Replit Secrets (the lock icon) before starting.

Every server resolves configuration through `@solutio/env`, which layers
`apps/<name>/.env` over the repo-root `.env` and lets the real environment beat
both. In a deployment neither file exists, so Secrets are the only source — and
each secret is set **once**, no matter how many servers read it. Each server
logs `[env:<name>] loaded …` at boot and warns about unset required variables,
so a missing secret shows up immediately instead of failing inside a tool call.

| Secret | Description |
|--------|-------------|
| `JOOMLA_BASE_URL` | Full URL to your Joomla administrator, e.g. `https://example.com/administrator` |
| `JOOMLA_USERNAME` | Joomla admin username — shared by joomla-mcp, gantry-mcp and ftp-mcp |
| `JOOMLA_PASSWORD` | Joomla admin password — shared by joomla-mcp, gantry-mcp and ftp-mcp |
| `ORCHESTRATOR_TOKEN` | Shared bearer token for single-token mode, and the fallback when no registry loads |

### Optional secrets

| Secret | Purpose |
|--------|---------|
| `ORCHESTRATOR_USERS_JSON` | The per-user token registry as JSON — the deployment's stand-in for `config/users.json`. See "Authentication" above. |
| `FRESHDESK_DOMAIN` | Freshdesk subdomain (e.g. `yourcompany`) |
| `FRESHDESK_API_KEY` | Freshdesk API key |
| `FTP_READONLY_USER` / `FTP_READONLY_PASS` | FTP read-only credentials |
| `FTP_WRITE_USER` / `FTP_WRITE_PASS` | FTP write credentials |
| `KNOWLEDGE_GATEWAY_API_KEY` | Key for the AI knowledge gateway |
| `RUNTIME_JWT_SECRET` | JWT signing secret for agent-runtime dashboard logins |
| `RUNTIME_ENC_KEY` | Encryption key for per-user Claude OAuth tokens |

## Connecting an MCP Client

Point any MCP-compatible client (Claude Desktop, Cursor, etc.) at:

```
URL:    http://<replit-dev-domain>:9302/mcp
Token:  your own registry token, or ORCHESTRATOR_TOKEN in single-token mode
```

The `.mcp.json` in the repo root has a template entry.

## Build

The TypeScript apps must be compiled before running:

```bash
npm ci
npm run build
```

## User Preferences

- Keep Docker-specific `/workspace` paths out of the codebase — use `$ROOT` (resolved at startup in `start-all.sh`) instead.
