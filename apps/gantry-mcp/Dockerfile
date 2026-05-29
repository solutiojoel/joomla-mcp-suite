FROM node:22-slim

# Install Chromium — let apt resolve all transitive deps automatically.
# Avoids hardcoding lib names that change between Debian releases (e.g. libasound2→libasound2t64).
RUN apt-get update && apt-get install -y \
  chromium \
  ca-certificates \
  fonts-liberation \
  --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip downloading its own Chrome and use the system Chromium.
# Also redirect its cache/config so it never needs to stat $HOME/.config at startup.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_CACHE_DIR=/app/.puppeteer-cache
ENV XDG_CONFIG_HOME=/app/.config

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 9305

ENV HTTP_PORT=9305

CMD ["node", "mcp-server.js"]
