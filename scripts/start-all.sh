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

# Self-check: the workflow's waitForPort 5000 only resolves when .replit maps
# localPort 5000 (explicit [[ports]] entries disable Replit's auto-detection).
# The platform has previously reverted this mapping; warn loudly if it's gone.
if ! grep -qE '^\s*localPort\s*=\s*5000\b' "$ROOT/.replit" 2>/dev/null; then
  echo "WARNING: .replit is missing the 'localPort = 5000' port mapping." >&2
  echo "WARNING: Workflow port detection will time out ('didn't open port 5000')." >&2
  echo "WARNING: Re-add a [[ports]] entry with localPort = 5000 to .replit." >&2
fi

cleanup() {
  echo "Stopping child processes..."
  jobs -p | xargs -r kill || true
}

trap cleanup SIGTERM SIGINT

# Supervised restart policy for downstream services: a crashed service is
# restarted up to SERVICE_MAX_RESTARTS times within SERVICE_RESTART_WINDOW
# seconds. A steady crash loop exhausts the budget and fails the whole
# stack visibly (the supervisor exits non-zero, tripping `wait -n` below).
SERVICE_MAX_RESTARTS="${SERVICE_MAX_RESTARTS:-3}"
SERVICE_RESTART_WINDOW="${SERVICE_RESTART_WINDOW:-60}"

supervise() {
  local name="$1"
  shift
  local restarts=0
  local window_start=$SECONDS
  local child=""

  # Forward shutdown signals to the currently running child.
  trap '[[ -n "$child" ]] && kill "$child" 2>/dev/null; exit 0' TERM INT

  while true; do
    "$@" &
    child=$!
    local status=0
    wait "$child" || status=$?
    child=""

    # Reset the restart budget once the service has stayed up long enough.
    if (( SECONDS - window_start > SERVICE_RESTART_WINDOW )); then
      restarts=0
      window_start=$SECONDS
    fi

    restarts=$((restarts + 1))
    if (( restarts > SERVICE_MAX_RESTARTS )); then
      echo "[supervisor] ${name} crashed ${restarts} times within ${SERVICE_RESTART_WINDOW}s; giving up." >&2
      return 1
    fi

    echo "[supervisor] ${name} exited (status ${status}); restart ${restarts}/${SERVICE_MAX_RESTARTS} in 1s..." >&2
    sleep 1
  done
}

run_joomla() {
  cd "$ROOT/apps/joomla-mcp"
  HTTP_PORT="${JOOMLA_MCP_PORT}" exec node dist/index.js
}

run_gantry() {
  cd "$ROOT/apps/gantry-mcp"
  HTTP_PORT="${GANTRY_MCP_PORT}" exec node mcp-server.js
}

run_freshdesk() {
  cd "$ROOT/apps/freshdesk-mcp"
  HTTP_PORT="${FRESHDESK_MCP_PORT}" exec node dist/index.js
}

run_ftp() {
  cd "$ROOT/apps/ftp-mcp"
  HTTP_PORT="${FTP_MCP_PORT}" exec node dist/index.js
}

run_mockup() {
  cd "$ROOT/apps/mockup-analyzer"
  HTTP_PORT="${MOCKUP_MCP_PORT}" exec python3 server.py
}

run_knowledge_gateway() {
  cd "$ROOT/apps/knowledge-gateway-mcp"
  HTTP_PORT="${KNOWLEDGE_GATEWAY_MCP_PORT}" exec node dist/index.js
}

run_site_builder() {
  cd "$ROOT/apps/gantry-mcp"
  SITE_BUILDER_PORT="${SITE_BUILDER_PORT}" \
  GANTRY_MCP_URL="http://127.0.0.1:${GANTRY_MCP_PORT}/mcp" \
  JOOMLA_MCP_URL="http://127.0.0.1:${JOOMLA_MCP_PORT}/mcp" \
  exec node site-builder-server.js
}

# Fast polling (0.2s) with an overall timeout (default 60s).
wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout="${3:-60}"
  local deadline=$((SECONDS + timeout))

  while ((SECONDS < deadline)); do
    if bash -c "</dev/tcp/${host}/${port}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  echo "Timed out waiting for ${host}:${port}" >&2
  return 1
}

# Downstream services run under the supervisor: transient crashes are
# retried with a bounded budget instead of taking the whole stack down.
supervise joomla-mcp run_joomla &
supervise gantry-mcp run_gantry &
supervise freshdesk-mcp run_freshdesk &
supervise ftp-mcp run_ftp &
supervise mockup-analyzer run_mockup &
supervise knowledge-gateway-mcp run_knowledge_gateway &
supervise site-builder run_site_builder &

# The orchestrator opens fresh per-call connections to downstream MCP
# servers, so it does not need them to be up before it starts. It is NOT
# supervised: if the public-facing entry point dies, fail the stack
# immediately and visibly.
(
  cd "$ROOT/apps/orchestrator"
  HTTP_HOST=0.0.0.0 HTTP_PORT="${ORCHESTRATOR_PORT}" node orchestrator.js
) &

# Wait for all service ports in parallel; fail fast if any never comes up.
wait_pids=()
for port in \
  "${JOOMLA_MCP_PORT}" \
  "${GANTRY_MCP_PORT}" \
  "${FRESHDESK_MCP_PORT}" \
  "${FTP_MCP_PORT}" \
  "${MOCKUP_MCP_PORT}" \
  "${KNOWLEDGE_GATEWAY_MCP_PORT}" \
  "${ORCHESTRATOR_PORT}"; do
  wait_for_port 127.0.0.1 "${port}" &
  wait_pids+=($!)
done

for pid in "${wait_pids[@]}"; do
  if ! wait "${pid}"; then
    echo "A service failed to become ready; shutting down." >&2
    cleanup
    exit 1
  fi
done

echo "All services ready."

# Replit's domain proxy routes external traffic to local port 9303 (legacy
# platform port mapping). Forward it to the orchestrator so the public URL
# always reaches the /mcp endpoint, unless something else already owns 9303.
# A short guard delay (replacing the old fixed 15s sleep) gives Replit's
# port detector a head start to latch onto 5000 before a second public port
# appears. This does not slow startup: 5000 is already serving by now.
if [ "${DISABLE_9303_FORWARDER:-0}" != "1" ] && [ "${FRESHDESK_MCP_PORT}" != "9303" ] && [ "${ORCHESTRATOR_PORT}" != "9303" ]; then
  sleep "${FORWARDER_GUARD_DELAY:-5}"
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
