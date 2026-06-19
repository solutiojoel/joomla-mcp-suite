FROM node:22-slim

# Install Chromium, Python 3, and common runtime deps once for all apps.
RUN apt-get update && apt-get install -y \
  chromium \
  ca-certificates \
  fonts-liberation \
  bash \
  python3 \
  python3-pip \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_CACHE_DIR=/workspace/.puppeteer-cache
ENV XDG_CONFIG_HOME=/workspace/.config

WORKDIR /workspace

# The repo is an npm-workspaces monorepo: one root lockfile installs every app
# and the shared packages/ in a single pass.
COPY package.json package-lock.json ./
COPY packages ./packages
COPY apps ./apps
COPY docs ./docs
COPY config ./config
COPY scripts ./scripts
COPY .env.example ./
COPY README.md ./

# Normalize potential CRLF from Windows checkouts before running with bash.
RUN sed -i 's/\r$//' ./scripts/start-all.sh && chmod +x ./scripts/start-all.sh

# Install all workspaces from the root lockfile (includes devDeps needed to
# build), then build the shared packages and the TypeScript servers. The plain
# JS servers (orchestrator, gantry-mcp) need no build step.
RUN npm ci
RUN npm run build

# Python deps for mockup-analyzer
RUN pip3 install "mcp[cli]" pyyaml --break-system-packages

# Orchestrator (MCP/HTTP), site-builder webapp, and mockup-analyzer
EXPOSE 9302
EXPOSE 9305
EXPOSE 18303

CMD ["bash", "scripts/start-all.sh"]
