// Must be the first import in index.ts so module-level env reads elsewhere see
// the loaded values. Layers <app>/.env over the shared repo-root .env; the real
// environment (deployment secrets) beats both. See @solutio/env.
import { loadEnv } from "@solutio/env";

loadEnv({
  from: __dirname,
  label: "knowledge-gateway-mcp",
  required: ["KNOWLEDGE_GATEWAY_API_KEY"],
});
