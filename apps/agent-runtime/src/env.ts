// Must be the first import in index.ts so module-level env reads elsewhere see
// the loaded values. Loads the app-local .env (cwd when launched via the start
// script), then the repo-root .env as a non-overriding fallback.
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
dotenv.config({
  path: path.resolve(__dirname, "..", "..", "..", ".env"),
  quiet: true,
});
