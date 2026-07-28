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
| `knowledge_audit` | Read-only change log of gateway writes | list |
| `agent_audit` | Agent session records — what an agent did on a site | list, get, create, delete |

## When to use which

- **Universal vs. client:** Use `knowledge_universal` for facts true everywhere (billing
  policy, house conventions, generic how-tos). Use `knowledge_client` for facts specific to
  one site (its office hours, a quirk, a client-specific integration). Always pass `site_code`
  on client `create`/`list`.
- **Gateway vs. local docs:** The `docs/workflows/*` and `docs/kb/*` guides (read via
  `read_agent_doc`) remain the canonical procedural reference and are unaffected. Per-site
  history is now split two ways (see `kb/site-history`): persistent facts live in site notes
  (`get_site_notes` / `write_site_notes`), and per-session changelog records are written as
  audit notes via `agent_audit { action: "create" }` — the gateway *is* where site history
  lives for that half, not merely an additional store. `append_site_note` is deprecated for
  changelog entries.
- **`knowledge_audit` vs. `agent_audit`:** different things despite the names.
  `knowledge_audit` is the gateway's own change log, written automatically whenever a record
  is created/updated/deleted — you read it to answer "who changed this record". `agent_audit`
  is written deliberately by an agent at session end to answer "what did we do on this site".
  Session audit notes go in `agent_audit`; nothing writes to `knowledge_audit`.
- **Never put audit narratives in `knowledge_client`.** That container is read during normal
  work, so anything stored there is pulled into context on every lookup. It is for durable
  client facts only. `agent_audit { action: "list" }` deliberately returns **summaries only**
  (id, site, agent, task, date) for the same reason — call `get` for the one record you need.
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
agent_audit         { action: "list", site_code: "assumption-west" }
agent_audit         { action: "get", id: 12 }
agent_audit         { action: "create", site_code: "assumption-west", agent_id: "super_shannon",
                      task: "2026-07-28 — Gala invitation in gala-top",
                      user_id: "jeremy@solutiosoftware.com",
                      original_request: "...", task_notes: "..." }
```

Notes:
- `knowledge_audit` is read-only (only `action: "list"`). Filter change type with
  `change_action` (create|update|delete) and the source table with `table_name`.
- `agent_audit` has no `update` — session records are append-only history. Fix a bad entry by
  `delete` + `create`. `list` accepts `site_code`, `agent_id`, `limit`, `offset`, and returns
  summaries; pass `full: true` only when you genuinely need every body.
- All tools return the standard `{ success, message, data?, itemCount? }` envelope.
- Configuration: `KNOWLEDGE_GATEWAY_API_KEY` (required) and `KNOWLEDGE_GATEWAY_BASE_URL`
  (defaults to `https://shannon-data.replit.app/api`). Tool calls are tagged in the gateway's
  audit log via the `X-Tool-Name: joomla-mcp-suite` header.
