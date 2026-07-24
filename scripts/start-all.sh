#!/usr/bin/env bash
set -euo pipefail

# Resolve the repo root regardless of where the script is called from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export JOOMLA_MCP_PORT="${JOOMLA_MCP_PORT:-9300}"
export GANTRY_MCP_PORT="${GANTRY_MCP_PORT:-9301}"
export ORCHESTRATOR_PORT="${ORCHESTRATOR_PORT:-5000}"
export FRESHDESK_MCP_PORT="${FRESHDESK_MCP_PORT:-9307}"
export FTP_MCP_PORT="${FTP_MCP_PORT:-9304}"
export MOCKUP_MCP_PORT="${MOCKUP_MCP_PORT:-9305}"
export KNOWLEDGE_GATEWAY_MCP_PORT="${KNOWLEDGE_GATEWAY_MCP_PORT:-9306}"
export SITE_BUILDER_PORT="${SITE_BUILDER_PORT:-18303}"

# Internal servers bind loopback only; the orchestrator alone is exposed
# publicly so Replit's domain proxy always routes to it.
export HTTP_HOST="${HTTP_HOST:-127.0.0.1}"
export FASTMCP_HOST="${FASTMCP_HOST:-127.0.0.1}"

# Force orchestrator to talk to services running in the same container.
export JOOMLA_MCP_URL="${JOOMLA_MCP_URL:-http://127.0.0.1:${JOOMLA_MCP_PORT}/mcp}"
export GANTRY_MCP_URL="${GANTRY_MCP_URL:-http://127.0.0.1:${GANTRY_MCP_PORT}/mcp}"
export FRESHDESK_MCP_URL="${FRESHDESK_MCP_URL:-http://127.0.0.1:${FRESHDESK_MCP_PORT}/mcp}"
export FTP_MCP_URL="${FTP_MCP_URL:-http://127.0.0.1:${FTP_MCP_PORT}/mcp}"
export MOCKUP_MCP_URL="${MOCKUP_MCP_URL:-http://127.0.0.1:${MOCKUP_MCP_PORT}/mcp}"
export KNOWLEDGE_GATEWAY_MCP_URL="${KNOWLEDGE_GATEWAY_MCP_URL:-http://127.0.0.1:${KNOWLEDGE_GATEWAY_MCP_PORT}/mcp}"

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
  cd "$ROOT/apps/joomla-mcp"
  HTTP_PORT="${JOOMLA_MCP_PORT}" node dist/index.js
) &

(
  cd "$ROOT/apps/gantry-mcp"
  HTTP_PORT="${GANTRY_MCP_PORT}" node mcp-server.js
) &

(
  cd "$ROOT/apps/freshdesk-mcp"
  HTTP_PORT="${FRESHDESK_MCP_PORT}" node dist/index.js
) &

(
  cd "$ROOT/apps/ftp-mcp"
  HTTP_PORT="${FTP_MCP_PORT}" node dist/index.js
) &

(
  cd "$ROOT/apps/mockup-analyzer"
  HTTP_PORT="${MOCKUP_MCP_PORT}" python3 server.py
) &

(
  cd "$ROOT/apps/knowledge-gateway-mcp"
  HTTP_PORT="${KNOWLEDGE_GATEWAY_MCP_PORT}" node dist/index.js
) &

wait_for_port 127.0.0.1 "${JOOMLA_MCP_PORT}"
wait_for_port 127.0.0.1 "${GANTRY_MCP_PORT}"
wait_for_port 127.0.0.1 "${FRESHDESK_MCP_PORT}"
wait_for_port 127.0.0.1 "${FTP_MCP_PORT}"
wait_for_port 127.0.0.1 "${MOCKUP_MCP_PORT}"
wait_for_port 127.0.0.1 "${KNOWLEDGE_GATEWAY_MCP_PORT}"

(
  cd "$ROOT/apps/orchestrator"
  HTTP_HOST=0.0.0.0 HTTP_PORT="${ORCHESTRATOR_PORT}" node orchestrator.js
) &

(
  cd "$ROOT/apps/gantry-mcp"
  SITE_BUILDER_PORT="${SITE_BUILDER_PORT}" \
  GANTRY_MCP_URL="http://127.0.0.1:${GANTRY_MCP_PORT}/mcp" \
  JOOMLA_MCP_URL="http://127.0.0.1:${JOOMLA_MCP_PORT}/mcp" \
  node site-builder-server.js
) &

wait_for_port 127.0.0.1 "${ORCHESTRATOR_PORT}"

# Replit's domain proxy routes external traffic to local port 9303 (legacy
# platform port mapping). Forward it to the orchestrator so the public URL
# always reaches the /mcp endpoint, unless something else already owns 9303.
if [ "${FRESHDESK_MCP_PORT}" != "9303" ] && [ "${ORCHESTRATOR_PORT}" != "9303" ]; then
  node -e '
    const net = require("net");
    const target = Number(process.env.ORCHESTRATOR_PORT || 9302);
    net.createServer((c) => {
      const u = net.connect(target, "127.0.0.1");
      c.pipe(u).pipe(c);
      c.on("error", () => u.destroy());
      u.on("error", () => c.destroy());
    }).listen(9303, "0.0.0.0", () => console.log("[forwarder] 0.0.0.0:9303 -> 127.0.0.1:" + target));
  ' &
fi

# Exit container if any one process exits unexpectedly.
wait -n
cleanup
exit 1
