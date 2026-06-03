#!/usr/bin/env bash
set -euo pipefail

export JOOMLA_MCP_PORT="${JOOMLA_MCP_PORT:-9300}"
export GANTRY_MCP_PORT="${GANTRY_MCP_PORT:-9301}"
export ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-9302}"
export SITE_BUILDER_PORT="${SITE_BUILDER_PORT:-18303}"
export MOCKUP_BUILDER_PORT="${MOCKUP_BUILDER_PORT:-18304}"

# Force orchestrator to talk to services running in the same container.
export JOOMLA_MCP_URL="${JOOMLA_MCP_URL:-http://127.0.0.1:${JOOMLA_MCP_PORT}/mcp}"
export GANTRY_MCP_URL="${GANTRY_MCP_URL:-http://127.0.0.1:${GANTRY_MCP_PORT}/mcp}"

cleanup() {
  echo "Stopping child processes..."
  jobs -p | xargs -r kill || true
}

trap cleanup SIGTERM SIGINT

wait_for_port() {
  local host="$1"
  local port="$2"
  local retries="${3:-60}"
  local i

  for ((i = 1; i <= retries; i++)); do
    if bash -c "</dev/tcp/${host}/${port}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for ${host}:${port}" >&2
  return 1
}

(
  cd /workspace/apps/joomla-mcp
  HTTP_PORT="${JOOMLA_MCP_PORT}" node dist/index.js
) &

(
  cd /workspace/apps/gantry-mcp
  HTTP_PORT="${GANTRY_MCP_PORT}" node mcp-server.js
) &

wait_for_port 127.0.0.1 "${JOOMLA_MCP_PORT}"
wait_for_port 127.0.0.1 "${GANTRY_MCP_PORT}"

(
  cd /workspace/apps/joomla-orchestrator
  HTTP_PORT="${ORCHESTRATOR_PORT}" node orchestrator.js
) &

(
  cd /workspace/apps/gantry-mcp
  SITE_BUILDER_PORT="${SITE_BUILDER_PORT}" \
  GANTRY_MCP_URL="http://127.0.0.1:${GANTRY_MCP_PORT}/mcp" \
  JOOMLA_MCP_URL="http://127.0.0.1:${JOOMLA_MCP_PORT}/mcp" \
  node site-builder-server.js
) &

(
  cd /workspace/apps/gantry-mcp
  MOCKUP_BUILDER_PORT="${MOCKUP_BUILDER_PORT}" \
  node mockup-brief-server.js
) &

# Exit container if any one process exits unexpectedly.
wait -n
cleanup
exit 1
