# Joomla MCP Suite — Replit

A multi-server MCP orchestration suite that gives AI agents programmatic control over a Joomla + Gantry 5 site. Originally Docker-based; adapted to run directly on Replit.

## Architecture

```
scripts/start-all.sh  (single entrypoint)
  ├── apps/joomla-mcp          port 9300  — Joomla admin automation (100+ tools)
  ├── apps/gantry-mcp          port 9301  — Gantry 5 layout/style tools (42 tools)
  ├── apps/freshdesk-mcp       port 9303  — Freshdesk ticket tools
  ├── apps/ftp-mcp             port 9304  — FTP asset management
  ├── apps/mockup-analyzer     port 9305  — Python/FastMCP image analysis
  ├── apps/knowledge-gateway-mcp port 9306 — AI knowledge base gateway
  ├── apps/orchestrator        port 9302  — Single /mcp endpoint (aggregates all)
  └── apps/gantry-mcp          port 18303 — Site-builder web UI
```

Agents connect to the **orchestrator** at `http://<host>:9302/mcp` with a bearer token matching `ORCHESTRATOR_TOKEN`.

## How to Run

The "Start application" workflow runs `bash scripts/start-all.sh` automatically. It:
1. Starts all downstream MCP servers in parallel
2. Waits for each to be ready
3. Starts the orchestrator (which proxies to all downstreams)
4. Starts the site-builder UI

## Required Environment Secrets

Set these in Replit Secrets (the lock icon) before starting:

| Secret | Description |
|--------|-------------|
| `JOOMLA_BASE_URL` | Full URL to your Joomla administrator, e.g. `https://example.com/administrator` |
| `JOOMLA_USERNAME` | Joomla admin username |
| `JOOMLA_PASSWORD` | Joomla admin password |
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
