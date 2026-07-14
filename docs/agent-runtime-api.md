# Solutio AI Dashboard — Frontend API Contract (v1)

> **Audience:** the frontend developer. This is the complete surface the dashboard is built against — nothing else on the box should be called directly.
> **Base URL:** `http://<box>.tailXXXX.ts.net:18310/api` (final hostname supplied when the box is set up). During frontend development on Replit, mock these endpoints or test live over Tailscale.
> **Companion docs:** [`agent-runtime-architecture.md`](agent-runtime-architecture.md) (how it works inside), [`agent-runtime-implementation-plan.md`](agent-runtime-implementation-plan.md) (delivery order — §1 below marks which endpoints arrive in which phase).
> **Status:** contract for a service not yet built. Shapes here are binding; additive changes (new fields, new endpoints) may occur, breaking changes will be versioned.

---

## 1. Ground rules

- **Auth:** every endpoint except `POST /api/auth/login` and `GET /healthz` requires `Authorization: Bearer <JWT>` (obtained from login). The two SSE endpoints *also* accept `?token=<JWT>` because `EventSource` cannot set headers.
- **Content type:** JSON in/out (`application/json`), except file upload (`multipart/form-data`) and SSE streams (`text/event-stream`).
- **Errors:** always `{ "error": { "code": "<machine_code>", "message": "<human message>" } }` with an appropriate HTTP status. Codes worth handling specially: `unauthorized` (401 — token missing/expired → redirect to login), `forbidden` (403), `not_found` (404), `validation` (400 — message says which field), `limit_exceeded` (429 — see sessions/jobs), `upstream_unavailable` (502 — orchestrator or gateway down).
- **Timestamps:** ISO-8601 UTC strings. **IDs:** opaque strings (`sess_…`, `job_…`, `file_…`).
- **Frontend delivery:** the runtime serves the built frontend as static files at `/` (SPA fallback included). Because the app and API share an origin, there is **no CORS** to deal with in production. Develop wherever you like; ship a static build.
- **Availability by phase:** `[P1]` auth/catalog/sites/health, `[P2]` sessions, `[P3]` jobs/files/knowledge/runs. Build UI in that order and you'll never be blocked on the backend.

---

## 2. Auth & identity `[P1]`

### POST /api/auth/login
```jsonc
// request
{ "email": "tori@solutiosoftware.com", "password": "•••" }
// 200
{
  "token": "eyJhbGciOi…",
  "expiresAt": "2026-07-15T03:00:00Z",
  "user": {
    "email": "tori@solutiosoftware.com",
    "displayName": "Tori",
    "role": "member",                    // "admin" | "member"
    "defaultAgent": "menu-build",
    "allowedAgents": ["menu-build", "content-build", "support"],
    "hasPersonalClaudeToken": true       // false ⇒ her sessions use the shared credential
  }
}
// 401 { "error": { "code": "unauthorized", "message": "Invalid email or password" } }
```

### GET /api/me
Returns the same `user` object for the current token. Use it on app load to restore state.

---

## 3. Catalog — what can this user do right now? `[P1]`

The dashboard must never hardcode agents, jobs, or tools. Render the home screen from this call.

### GET /api/catalog
```jsonc
// 200
{
  "agents": [    // chat-session starting points (filtered to the caller's allowedAgents)
    { "id": "menu-build",  "title": "Menu Build",
      "description": "Menu building — PDF → Menu Spec → Joomla skeleton (Phases 1–4)" },
    { "id": "support",     "title": "Support",
      "description": "Freshdesk ticket resolution — diagnose, fix, close" }
  ],
  "jobs": [      // one-shot sub-agent runs; render input forms from inputSchema
    {
      "id": "run_menu_interpretation",
      "title": "Interpret a menu document",
      "description": "Menu PDF → validated Menu Spec JSON (menu-interpreter sub-agent)",
      "kind": "llm",                         // "llm" (minutes) | "deterministic" (seconds)
      "inputSchema": {                       // standard JSON Schema
        "type": "object",
        "required": ["site_url"],
        "properties": {
          "site_url":  { "type": "string", "format": "site-url" },
          "pdf_file":  { "type": "string", "format": "runtime-file-id",
                         "description": "Upload via POST /api/files first" },
          "menu_text": { "type": "string" }
        }
      },
      "produces": ["menu-spec"]
    }
    // …run_menu_build, derive_content_schematic, run_content_interpretation,
    //  discover_source_urls, fetch_source_content, run_content_build, apply_content
  ],
  "tools":   [ /* raw MCP tools visible to this user's scope — power-user/tool-explorer UI only */ ],
  "prompts": [ { "name": "work_on_site", "description": "…", "arguments": [ … ] } ]
}
```

Custom `format` hints: `site-url` → render the site picker (§4); `runtime-file-id` → render an upload control and pass the resulting file id.

### GET /api/sites
```jsonc
// 200
[ { "url": "https://stmatthewparish.org", "slug": "stmatthewparish", "name": "St. Matthew Parish" } ]
```

---

## 4. Chat sessions `[P2]`

A session is a persistent conversation with one agent on one site. Reopening later is transparent — just send the next message.

### POST /api/sessions
```jsonc
// request
{ "agent": "menu-build", "siteUrl": "https://stmatthewparish.org", "title": "St. Matthew menu build" }
// 201
{ "id": "sess_8f2c", "agent": "menu-build", "siteUrl": "https://stmatthewparish.org",
  "title": "St. Matthew menu build", "status": "active", "createdAt": "…", "seq": 0 }
// 429 — over the per-user limit (2 active); body includes "activeSessions": [ … ]
//        so the UI can offer to close one
```

### GET /api/sessions?status=active|all
Caller's sessions, newest first: `[ { id, agent, siteUrl, title, status, createdAt, lastActivityAt, seq } ]`
`status`: `active` | `idle` | `closed` (closed sessions still accept a new message — they resume).

### GET /api/sessions/:id
Session detail (same shape as above).

### GET /api/sessions/:id/messages?afterSeq=0&limit=200
History for rendering on open — same objects as the `message` SSE event:
```jsonc
{ "messages": [
    { "seq": 12, "ts": "…", "role": "assistant", "type": "text",
      "text": "I've read the menu spec. Three open questions: …" },
    { "seq": 13, "ts": "…", "role": "assistant", "type": "tool_use",
      "toolName": "joomla_menu_item", "toolInput": { "action": "create", "title": "…" } },
    { "seq": 14, "ts": "…", "role": "tool", "type": "tool_result",
      "toolName": "joomla_menu_item", "summary": "Created menu item id 412" }
  ],
  "nextSeq": 15 }
```

### POST /api/sessions/:id/messages
```jsonc
// request — fileIds lets the user attach an uploaded PDF mid-chat
{ "text": "Here's the menu document — walk me through phase 1.", "fileIds": ["file_abc123"] }
// 202
{ "accepted": true, "seq": 15 }        // the assistant's reply arrives on the stream
// 409 { "error": { "code": "busy", "message": "Session is processing the previous turn" } }
```

### GET /api/sessions/:id/stream  (SSE)
Connect with `EventSource("/api/sessions/sess_8f2c/stream?token=" + jwt)`. Every event carries `id: <seq>`; on reconnect the browser sends `Last-Event-ID` automatically and the server **replays anything missed**, then goes live. Event vocabulary:

| event | data | UI meaning |
|---|---|---|
| `status` | `{ "state": "thinking" \| "running_tool" \| "idle" \| "error" }` | activity indicator |
| `text.delta` | `{ "text": "partial…" }` | append to the streaming assistant bubble |
| `message` | full message object (as §above) | finalize a bubble / add tool entries |
| `tool_use` | `{ "toolName", "toolInput" }` | "🔧 calling joomla_menu_item…" row |
| `tool_result` | `{ "toolName", "summary", "isError" }` | resolve that row |
| `done` | `{ "turnSeq": 22 }` | turn finished; input re-enabled |
| `session.closed` | `{ "reason": "idle_timeout" \| "closed" }` | show "resume" affordance |

### POST /api/sessions/:id/interrupt
Aborts the in-flight turn (like pressing Esc in Claude Code). `200 { "interrupted": true }`. Session stays usable.

### DELETE /api/sessions/:id
Archives the session (`status: "closed"`). History remains readable; a new message resumes it.

---

## 5. Jobs — one-shot sub-agent runs `[P3]`

For the "just send the document to the interpreter" flow. LLM jobs run **minutes to ~30 minutes**; design the UI around that (progress panel, not a spinner).

### POST /api/jobs
```jsonc
// request — "type" is a catalog job id; "input" must satisfy its inputSchema
{ "type": "run_menu_interpretation",
  "input": { "site_url": "https://stmatthewparish.org", "pdf_file": "file_abc123" } }
// 202
{ "id": "job_51d0", "type": "run_menu_interpretation", "status": "queued", "createdAt": "…" }
// 400 validation | 429 limit_exceeded (1 running job per user; job was NOT queued)
```

### GET /api/jobs?status=&type=
Caller's jobs, newest first (admins see everyone's): array of the summary fields below.

### GET /api/jobs/:id
```jsonc
// 200
{
  "id": "job_51d0",
  "type": "run_menu_interpretation",
  "status": "running",            // queued | running | succeeded | failed | stopped
  "input": { "site_url": "…", "pdf_file": "file_abc123" },
  "runId": "menu-interpreter-20260714-…",     // agents-mcp run id, null until started
  "progress": { "lastHeartbeatAt": "…", "message": "turn 12" },
  "result": null,                 // on success:
  // "result": {
  //   "summary": "Spec produced: 42 menu items, 3 open questions",
  //   "artifacts": [ { "kind": "menu-spec",
  //                    "path": "workspace/stmatthewparish-menu-spec.json",
  //                    "kbRecordId": 118 } ],     // knowledge-base reference record
  //   "raw": { …parsed tool result: spec / joomla_ids / report… } }
  "error": null,                  // on failure: { "message": "…", "detail": { schema_errors: … } }
  "createdAt": "…", "startedAt": "…", "finishedAt": null
}
```

### GET /api/jobs/:id/stream  (SSE, `?token=` supported)
Events: `status` (state changes), `progress` (`{ message, lastHeartbeatAt }` per heartbeat), `done` (`{ status, result | error }`). Stream closes after `done`.

### POST /api/jobs/:id/stop
`202 { "stopping": true }` — dequeues a queued job instantly; for a running job, triggers agents-mcp's stop mechanism (takes effect at the next agent step; final status becomes `stopped`).

---

## 6. Files `[P3]`

### POST /api/files
`multipart/form-data`, field **`file`**. Limits: 25 MB; `pdf`, `png`, `jpg` only.
```jsonc
// 201
{ "id": "file_abc123", "name": "Church-Menu.pdf", "size": 1834722,
  "contentType": "application/pdf", "uploadedAt": "…" }
// 400 { "error": { "code": "validation", "message": "Only pdf/png/jpg up to 25 MB" } }
```
Use the returned `id` wherever a schema field has `"format": "runtime-file-id"`, or in a chat message's `fileIds`.

### GET /api/files/:id
Downloads the file (attachment disposition). Useful for "view the document I uploaded".

---

## 7. Knowledge base `[P3]`

Proxied to the Knowledge Gateway; the API key stays server-side and every write is attributed to the logged-in user. `:collection` ∈ `knowledge` (universal), `client-knowledge` (per-site), `self-improving` (per-tool instructions).

```
GET    /api/knowledge/:collection?tag=&search=&site_code=&limit=&offset=
POST   /api/knowledge/:collection            // create
GET    /api/knowledge/:collection/:id
PUT    /api/knowledge/:collection/:id        // update
DELETE /api/knowledge/:collection/:id
GET    /api/knowledge/audit?table_name=&change_action=&limit=&offset=   // read-only
```

Record shape (universal/client): `{ "id": 118, "topic": "…", "content": "<markdown>", "tags": ["audit"], "contentType": "markdown", "siteCode": "STM001"? }`. Self-improving adds `toolName`, `instruction`, `notes`, `version`.

Job artifacts appear here automatically as reference records tagged `artifact:<kind>` + `site:<slug>` + `run:<runId>` — the "outputs live in the knowledge base" browse experience is a filtered list on these tags.

---

## 8. Run monitor `[P3]`

Read-only view of *all* sub-agent runs on the box (including ones started from Claude Code, not just dashboard jobs). Proxied from the internal agents-mcp monitor.

```
GET /api/runs           // [ { id, agent, status: running|success|failed|stalled|stopped, startedAt, … } ]
GET /api/runs/:id       // summary + event timeline (text / tool_use / tool_result / result)
```
(Stopping a *dashboard* job goes through `POST /api/jobs/:id/stop`; admin-stopping an arbitrary run can be added later if needed.)

---

## 9. Health `[P1]`

### GET /healthz  (no auth)
```jsonc
{ "ok": true, "orchestrator": "up", "agentsMcp": "up", "knowledgeGateway": "up", "version": "1.0.0" }
```
`ok: false` (still HTTP 200) when a dependency is down — show a degraded-mode banner.

---

## 10. Worked example — Tori's menu build, both ways

### A. One-shot job (the "just send the document" path)
1. `POST /api/auth/login` → JWT.
2. `GET /api/catalog` → render job cards; Tori picks **Interpret a menu document**.
3. Form from `inputSchema`: site picker (`GET /api/sites`) + file upload → `POST /api/files` → `file_abc123`.
4. `POST /api/jobs { type: "run_menu_interpretation", input: { site_url, pdf_file: "file_abc123" } }` → `job_51d0`.
5. Open `GET /api/jobs/job_51d0/stream` — show heartbeat progress and a Stop button (`POST /api/jobs/job_51d0/stop`).
6. `done` → show `result.summary`, link the spec artifact (knowledge record `kbRecordId` and/or `GET /api/files`-style download later), and offer the follow-up job **Build the menu skeleton** (`run_menu_build`) pre-filled with the same site.

### B. Chat session (the guided path)
1–2 as above; Tori picks the **Menu Build** agent instead.
3. `POST /api/sessions { agent: "menu-build", siteUrl }` → `sess_8f2c`; open the SSE stream.
4. `POST /api/files` for the PDF, then `POST /api/sessions/sess_8f2c/messages { text: "Here's the menu document — start phase 1", fileIds: ["file_abc123"] }`.
5. Render the stream: text deltas, tool-call rows, status changes. The agent may ask Tori open questions; she answers with further messages. Interrupt button → `/interrupt`.
6. Days later she reopens the dashboard: `GET /api/sessions` → picks the session → `GET …/messages` renders history → her next message resumes it.

---

## 11. UI surface the API implies (suggested, not binding)

- **Login** → **Home**: "Start a session" (agent cards) / "Run a job" (job cards) / "Resume" (active sessions list) — all driven by `/api/catalog` + `/api/sessions`.
- **Chat view**: transcript with tool-call rows, streaming bubble, status strip, interrupt, attach-file.
- **Jobs view**: list + detail with live progress, stop, artifact links.
- **Knowledge browser**: filterable list (collection, tag, site) + markdown editor.
- **Runs (admin)**: the monitor list/timeline.
- **Degraded banner** off `/healthz`.
