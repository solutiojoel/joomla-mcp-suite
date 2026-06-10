FROM node:22-slim

# Install Chromium and common runtime deps once for all apps.
RUN apt-get update && apt-get install -y \
  chromium \
  ca-certificates \
  fonts-liberation \
  bash \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_CACHE_DIR=/workspace/.puppeteer-cache
ENV XDG_CONFIG_HOME=/workspace/.config

WORKDIR /workspace

COPY apps ./apps
COPY docs ./docs
COPY scripts ./scripts
COPY .env.example ./
COPY README.md ./

# Normalize potential CRLF from Windows checkouts before running with bash.
RUN sed -i 's/\r$//' ./scripts/start-all.sh && chmod +x ./scripts/start-all.sh

# Install dependencies for each app.
RUN cd apps/gantry-mcp && npm ci
RUN cd apps/joomla-mcp && npm ci && npm run build
RUN cd apps/joomla-orchestrator && npm ci
RUN cd apps/dashboard && npm ci

# Orchestrator (MCP/HTTP), site-builder webapp, mockup brief webapp, dashboard
EXPOSE 9302
EXPOSE 18303
EXPOSE 18304
EXPOSE 18305

CMD ["bash", "scripts/start-all.sh"]
