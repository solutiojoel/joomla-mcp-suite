# AI Knowledge Gateway

The Knowledge Gateway is a shared REST-backed knowledge store (separate from the local
`docs/` tree and per-site notes). It is reached through four orchestrator tools served by
`knowledge-gateway-mcp`. No active site is required at the transport level — client-scoped
entries are addressed by an explicit `site_code` argument.

| Tool | Resource | Actions |
|------|----------|---------|
| `knowledge_universal` | Shared knowledge across all clients | list, get, create, update, delete |
| `knowledge_client` | Knowledge scoped to one site (`site_code`) | list, get, create, update, delete |
| `knowledge_self_improving` | Per-tool AI instructions (auto-versioned) | list, get, create, update, delete |
| `knowledge_audit` | Read-only change log | list |

## When to use which

- **Universal vs. client:** Use `knowledge_universal` for facts true everywhere (billing
  policy, house conventions, generic how-tos). Use `knowledge_client` for facts specific to
  one site (its office hours, a quirk, a client-specific integration). Always pass `site_code`
  on client `create`/`list`.
- **Gateway vs. local docs:** The `docs/workflows/*` and `docs/kb/*` guides (read via
  `read_agent_doc`) remain the canonical procedural reference and are unaffected. Per-site
  history is now split two ways (see `kb/site-history`): persistent facts live in site notes
  (`get_site_notes` / `write_site_notes`), and per-session changelog records are written as
  audit notes via `knowledge_client { tags: ["audit"] }` — the gateway *is* where site history
  lives for that half, not merely an additional store. `append_site_note` is deprecated for
  changelog entries.
- **Self-improving vs. `workflows/improvements`:** `docs/workflows/improvements.md` stays the
  human-readable team queue for process fixes. Use `knowledge_self_improving` for concise,
  machine-applied per-tool instruction text. `version` increments automatically on update;
  pass `change_reason` to record why.

## Common calls

```
knowledge_universal { action: "list", search: "billing" }
knowledge_universal { action: "create", topic: "billing", content: "...", tags: ["billing","faq"] }
knowledge_client    { action: "list", site_code: "SITE001" }
knowledge_client    { action: "create", site_code: "SITE001", topic: "office hours", content: "Mon–Fri 9–5" }
knowledge_self_improving { action: "update", id: 1, instruction: "...", change_reason: "Clarified phrasing" }
knowledge_audit     { action: "list", table_name: "client_knowledge", change_action: "update" }
```

Notes:
- `knowledge_audit` is read-only (only `action: "list"`). Filter change type with
  `change_action` (create|update|delete) and the source table with `table_name`.
- All tools return the standard `{ success, message, data?, itemCount? }` envelope.
- Configuration: `KNOWLEDGE_GATEWAY_API_KEY` (required) and `KNOWLEDGE_GATEWAY_BASE_URL`
  (defaults to `https://shannon-data.replit.app/api`). Tool calls are tagged in the gateway's
  audit log via the `X-Tool-Name: joomla-mcp-suite` header.
