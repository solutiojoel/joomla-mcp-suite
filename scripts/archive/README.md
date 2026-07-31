# Archived scripts

One-time migrations that already ran. They stay here for reference only. Do not
run them as part of normal work.

| Script | Ran on | What it did |
|--------|--------|-------------|
| `migrate-docs-to-gateway.js` | 2026-07-29 | Moved `docs/workflows/` and `docs/kb/` into the Knowledge Gateway as `knowledge_universal` rows. |
| `migrate-site-notes-to-gateway.js` | 2026-07-29 | Moved `docs/sites/` into the Knowledge Gateway. |

Both are idempotent and both support `--dry-run` and `--verify-only`, so you can
re-verify the migration without a write.

`apps/orchestrator/gateway-store.js` mirrors the `siteCodeFromHost()` logic from
`migrate-site-notes-to-gateway.js`. Keep the two in agreement if you change either.
