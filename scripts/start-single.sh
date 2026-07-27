#!/usr/bin/env bash
set -euo pipefail

# Single-process entry point: the orchestrator hosts every Node downstream
# server in-process (in-memory MCP transport) and runs the Python
# mockup-analyzer as a stdio child. One web process, one port — exactly what
# Replit Autoscale expects. Used both by the dev workflow and the deployment.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export INPROCESS_DOWNSTREAMS=1
export HTTP_HOST="${HTTP_HOST_OVERRIDE:-0.0.0.0}"
export HTTP_PORT="${ORCHESTRATOR_PORT:-5000}"

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
