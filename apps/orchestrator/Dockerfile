FROM node:22-slim

# No Puppeteer/Chrome needed — the orchestrator only routes MCP calls

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 9302

ENV HTTP_PORT=9302

CMD ["node", "orchestrator.js"]
