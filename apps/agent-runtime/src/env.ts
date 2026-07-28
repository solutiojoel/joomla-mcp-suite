// Must be the first import in index.ts so module-level env reads elsewhere see
// the loaded values. Layers <app>/.env over the shared repo-root .env; the real
// environment (deployment secrets) beats both. See @solutio/env.
//
// This app pioneered the layered pattern with a hand-rolled pair of dotenv
// calls; it now uses the shared loader so every server resolves env identically
// and app-root detection no longer depends on the launch directory.
import { loadEnv } from "@solutio/env";

loadEnv({
  from: __dirname,
  label: "agent-runtime",
  required: ["RUNTIME_JWT_SECRET", "RUNTIME_ENC_KEY"],
});
