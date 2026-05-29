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

## Quick Start

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
