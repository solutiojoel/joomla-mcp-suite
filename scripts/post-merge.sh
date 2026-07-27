#!/bin/bash
# Post-merge setup: runs automatically after a task merge.
# Idempotent, non-interactive, fails fast.
set -e

cd "$(dirname "$0")/.."

# Install workspace dependencies (npm workspaces root covers all apps/packages)
npm install --no-audit --no-fund

# Rebuild TypeScript packages and apps
npm run build
