# MCP → Server Traffic Schematic (for firewall / throttling rules)

Prepared 2026-08-11 · Audience: infrastructure engineer configuring edge firewall & rate limiting

## 1. Traffic overview

```
┌──────────────────────────── Replit (dynamic Google Cloud egress IPs) ───────────────────────────┐
│                                                                                                 │
│   MCP clients ──HTTPS──▶ Orchestrator (:5000, Bearer auth)                                      │
│                              │                                                                  │
│               ┌──────────────┼──────────────────┬───────────────────┐                           │
│               ▼              ▼                  ▼                   ▼                           │
│          joomla-mcp     gantry-mcp         ftp-mcp        freshdesk / knowledge-gateway         │
│               │              │                  │                   │                           │
└───────────────┼──────────────┼──────────────────┼───────────────────┼───────────────────────────┘
                │ HTTPS        │ HTTPS            │ FTP (21/passive)  │ HTTPS → third-party APIs
                ▼              ▼                  ▼                   ▼      (not your infra)
        ┌──────────────────────────────┐   ┌──────────────┐
        │   YOUR JOOMLA WEB SERVER     │   │ YOUR FTP SRV │
        │   (edge firewall goes here)  │   └──────────────┘
        └──────────────────────────────┘
```

Only **joomla-mcp** and **gantry-mcp** send HTTP(S) to your web server. ftp-mcp
speaks FTP only (no HTTP headers; identify by FTP account `FTP_READONLY_USER` /
`FTP_WRITE_USER`). Freshdesk/knowledge-gateway traffic never touches your infra.

## 2. HTTP request fingerprint

Every HTTP request from joomla-mcp and gantry-mcp carries **both** of these
markers (default "identified" mode):

| Marker | Value |
|---|---|
| `User-Agent` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Solutio-MCP/1.0 (+https://solutiosoftware.com)` |
| `X-Solutio-Agent` | `joomla-mcp/1.0` **or** `gantry-mcp/1.0` (identifies the sending service) |

Notes:
- The UA is a real Chrome string with a `Solutio-MCP/<version>` product token
  appended (bare tool UAs were being 403'd by the edge).
- Header names are case-insensitive on the wire (gantry sends it lowercase).
- Version segment comes from `SOLUTIO_MCP_VERSION` (default `1.0`).
- Requests are authenticated Joomla admin sessions: expect a `Cookie` header
  with a Joomla session ID on most requests, targeting `/administrator/...`
  paths, plus occasional front-end GETs.

## 3. Source IPs — do not filter by IP

Replit does **not** offer static egress IPs. Both the development workspace and
the published (Autoscale) deployment egress from rotating Google Cloud IPs.
Any IP-based allowlist will silently break. Filter on the request markers above
instead.

## 4. Recommended rules

1. **Throttling exemption (primary goal):** exempt requests bearing the
   `X-Solutio-Agent` header (any value) from rate limiting / 429s. Optionally
   match value prefix `joomla-mcp/` or `gantry-mcp/` per-service.
2. **Fallback / broader match:** UA substring `Solutio-MCP/` — covers the same
   traffic if a proxy strips custom headers.
3. **Logging:** the `X-Solutio-Agent` value tells you which service produced a
   request; the UA token makes traffic greppable in access logs.

## 5. Spoofing caveat

Both markers are plain headers and can be forged by anyone who reads this doc.
The exemption removes rate limiting only — Joomla auth still gates all actions.
If you need a tamper-resistant exemption, we can add a shared-secret header
(e.g. `X-Solutio-Key: <secret>`) validated at the edge; the MCP side is a small
change.

## 6. Behavior under throttling

The clients deliberately **fail fast on HTTP 429** — no client-side retry or
backoff. Any 429 from the edge surfaces immediately as a tool error, which is
why the exemption matters.
