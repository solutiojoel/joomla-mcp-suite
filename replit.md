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
  ├── knowledge-gateway-mcp  hosted in-process
  └── mockup-analyzer        Python stdio child process
```

One web process, one port — this is what lets the suite publish as a Replit
Autoscale deployment (scales to zero when idle, wakes on request).
`INPROCESS_DOWNSTREAMS=1` activates this mode; each Node downstream exports
`buildServer()` with no side effects on require.

**Legacy multi-process mode** (`scripts/start-all.sh`) still works: each server
gets its own loopback HTTP port (9300–9307) plus the site-builder UI on 18303.

Agents connect to the **orchestrator** `/mcp` endpoint with a bearer token
matching `ORCHESTRATOR_TOKEN`. Unauthenticated status dashboard at `/`,
`/status`, `/status.json`.

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
| `ORCHESTRATOR_TOKEN` | Shared bearer token MCP clients use to authenticate with the orchestrator |

### Optional secrets

| Secret | Purpose |
|--------|---------|
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
Token:  <value of ORCHESTRATOR_TOKEN>
```

The `.mcp.json` in the repo root has a template entry.

## Build

The TypeScript apps must be compiled before running:

```bash
npm ci
npm run build
```

Python dependencies for `mockup-analyzer`:

```bash
python3 -m pip install "mcp[cli]" pyyaml
```

## User Preferences

- Keep Docker-specific `/workspace` paths out of the codebase — use `$ROOT` (resolved at startup in `start-all.sh`) instead.
