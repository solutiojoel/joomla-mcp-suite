#!/usr/bin/env bash
set -euo pipefail

# Single-process entry point: the orchestrator hosts every Node downstream
# server in-process (in-memory MCP transport) and runs the Python
# mockup-analyzer as a stdio child. One web process, one port — exactly what
# Replit Autoscale expects. Used both by the dev workflow and the deployment.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export INPROCESS_DOWNSTREAMS=1
export HTTP_HOST="${HTTP_HOST_OVERRIDE:-0.0.0.0}"

# Puppeteer: use the system (Nix) Chromium instead of a downloaded Chrome —
# the puppeteer-managed download isn't present in this environment. Resolve
# the path dynamically so Nix store path changes don't break it.
CHROMIUM_BIN="$(command -v chromium || true)"
if [ -n "$CHROMIUM_BIN" ]; then
  export PUPPETEER_EXECUTABLE_PATH="${PUPPETEER_EXECUTABLE_PATH:-$CHROMIUM_BIN}"
  export CHROME_PATH="${CHROME_PATH:-$CHROMIUM_BIN}"   # cdp-inspector uses CHROME_PATH
fi

if [ -n "${REPLIT_DEPLOYMENT:-}" ]; then
  # Production (Autoscale): listen where the platform routes external :80
  # traffic. Replit sets PORT in deployments; fall back to the .replit
  # [[ports]] entry mapped to externalPort 80 (localPort 9303). Do NOT
  # hardcode 5000 here — in .replit it maps to externalPort 8008, so a
  # server on 5000 never receives the health check and promote fails
  # silently at "Creating Autoscale service".
  export HTTP_PORT="${PORT:-9303}"
else
  # Dev workspace: workflow/webview expects port 5000.
  export HTTP_PORT="${ORCHESTRATOR_PORT:-5000}"
fi

# Dev-only: Replit's domain proxy maps external 80 → local 9303 in the
# workspace, so keep the tiny TCP forwarder there. Deployments route straight
# to the app's single open port, so the forwarder must NOT run in production
# (a second open port would confuse port detection).
if [ -z "${REPLIT_DEPLOYMENT:-}" ] && [ "${DISABLE_9303_FORWARDER:-0}" != "1" ]; then
  (
    sleep "${FORWARDER_GUARD_DELAY:-5}"
    node -e '
      const net = require("net");
      const target = Number(process.env.HTTP_PORT || 5000);
      net.createServer((c) => {
        const u = net.connect(target, "127.0.0.1");
        c.pipe(u).pipe(c);
        c.on("error", () => u.destroy());
        u.on("error", () => c.destroy());
      }).listen(9303, "0.0.0.0", () => console.log("[forwarder] 0.0.0.0:9303 -> 127.0.0.1:" + target));
    '
  ) &
fi

cd "$ROOT/apps/orchestrator"
exec node orchestrator.js
