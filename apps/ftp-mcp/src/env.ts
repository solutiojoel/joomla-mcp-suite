// Must be the first import in index.ts so module-level env reads elsewhere see
// the loaded values. Layers <app>/.env over the shared repo-root .env; the real
// environment (deployment secrets) beats both. See @solutio/env.
//
// No `required` list: ftp-mcp resolves per-site credential sets from
// ftp-sites.json (FTP_<SET>_READONLY_* / FTP_<SET>_WRITE_*), so there is no
// single pair whose absence is always a misconfiguration.
import { loadEnv } from "@solutio/env";

loadEnv({ from: __dirname, label: "ftp-mcp" });
