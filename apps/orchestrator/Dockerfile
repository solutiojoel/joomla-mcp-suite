# DEPRECATED: this standalone per-app image no longer builds on its own. The repo
# is now an npm-workspaces monorepo and this app depends on the shared @solutio/*
# packages under ../../packages. Build from the repo-root Dockerfile
# (docker compose up) instead, which installs every workspace in one pass.
FROM node:22-slim

# No Puppeteer/Chrome needed — the orchestrator only routes MCP calls

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 9302

ENV HTTP_PORT=9302

CMD ["node", "orchestrator.js"]
