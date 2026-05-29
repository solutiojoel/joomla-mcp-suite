# Joomla MCP Suite (Single Image)

This repository combines the following tools into one organized project and one Docker image:

- `apps/joomla-mcp` (content/admin MCP tools)
- `apps/gantry-mcp` (Gantry design/layout MCP tools)
- `apps/joomla-orchestrator` (single routed MCP endpoint)

The image starts all three services internally and exposes only the orchestrator endpoint.

## Repository Layout

- `apps/joomla-mcp`: TypeScript MCP server
- `apps/gantry-mcp`: Gantry automation MCP server
- `apps/joomla-orchestrator`: Router MCP server
- `scripts/start-all.sh`: process supervisor for all services
- `Dockerfile`: single image build for entire suite

## Quick Start (Docker)

1. Copy `.env.example` to `.env` and fill in Joomla credentials.
2. Build and run:

```bash
docker compose up --build -d
```

3. Connect your MCP client to:

```text
http://localhost:18302/mcp
```

## Ports

- `18302` exposed externally: orchestrator MCP endpoint
- `18300` internal Joomla MCP server
- `18301` internal Gantry MCP server

## Build Without Compose

```bash
docker build -t joomla-mcp-suite .
docker run --env-file .env -p 18302:9302 joomla-mcp-suite
```

## Notes

- The orchestrator automatically routes to internal services using `127.0.0.1`.
- Chromium is installed once in the image and shared by both Puppeteer-based apps.
- If one internal process exits, the container exits so orchestration can restart it.

## Quick Start (No Docker)

This runs all 3 MCP servers directly on your machine.

### 1. Prerequisites

- Node.js 22+
- npm 10+

### 2. Install dependencies

From repo root:

```bash
cd apps/joomla-mcp && npm ci && npm run build
cd ../gantry-mcp && npm ci
cd ../joomla-orchestrator && npm ci
```

PowerShell equivalent:

```powershell
Set-Location apps/joomla-mcp; npm ci; npm run build
Set-Location ../gantry-mcp; npm ci
Set-Location ../joomla-orchestrator; npm ci
```

### 3. Create local env files

Create these files:

- `apps/joomla-mcp/.env`
- `apps/gantry-mcp/.env`
- `apps/joomla-orchestrator/.env`

Recommended minimum values:

```dotenv
# apps/joomla-mcp/.env
JOOMLA_BASE_URL=https://example.com/administrator
JOOMLA_USERNAME=your_username
JOOMLA_PASSWORD=your_password
```

```dotenv
# apps/joomla-orchestrator/.env
JOOMLA_MCP_URL=http://127.0.0.1:9300/mcp
GANTRY_MCP_URL=http://127.0.0.1:9301/mcp
```

`apps/gantry-mcp/.env` can be empty unless you use optional overrides.

### 4. Start all 3 servers (3 terminals)

Terminal 1:

```bash
cd apps/joomla-mcp
HTTP_PORT=9300 node dist/index.js
```

```powershell
Set-Location apps/joomla-mcp
$env:HTTP_PORT = "9300"
node dist/index.js
```

Terminal 2:

```bash
cd apps/gantry-mcp
HTTP_PORT=9301 node mcp-server.js
```

```powershell
Set-Location apps/gantry-mcp
$env:HTTP_PORT = "9301"
node mcp-server.js
```

Terminal 3:

```bash
cd apps/joomla-orchestrator
HTTP_PORT=9302 node orchestrator.js
```

```powershell
Set-Location apps/joomla-orchestrator
$env:HTTP_PORT = "9302"
node orchestrator.js
```

### 5. Connect your MCP client

Use:

```text
http://localhost:9302/mcp
```
