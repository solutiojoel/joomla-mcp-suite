import http from "node:http";
import fs from "node:fs";
import path from "node:path";

/**
 * Local monitoring dashboard for sub-agent runs.
 *
 * Reads the JSONL run logs written by runSubAgent() (runtime.ts) — the same
 * log format every sub-agent produces, so this works for menu-interpreter
 * today and any future sub-agent without changes.
 *
 * Usage: npm run dashboard -w apps/agents-mcp
 * Then open http://localhost:3507 (override with DASHBOARD_PORT).
 */

const LOG_DIR = path.join(__dirname, "..", "logs");
const PORT = Number(process.env.DASHBOARD_PORT) || 3507;
const STALL_THRESHOLD_MS = 30_000;

interface RunSummary {
  runId: string;
  agentName: string;
  model?: string;
  maxTurns?: number;
  status: "running" | "success" | "failed" | "crashed" | "stalled" | "stopping" | "stopped";
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  turns?: number;
  userMessagePreview: string;
  toolCalls: number;
  toolErrors: number;
  lastActivityAt: string;
  error?: string;
}

interface TimelineEvent {
  ts: string;
  kind: "meta" | "text" | "tool_use" | "tool_result" | "system" | "result" | "error";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  isError?: boolean;
}

function stopFilePath(runId: string): string {
  return path.join(LOG_DIR, `${runId}.stop`);
}

function readLines(file: string): Record<string, unknown>[] {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* tolerate a torn last line from a killed process */
    }
  }
  return out;
}

function preview(text: string | undefined, max = 180): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max) + "…" : collapsed;
}

function summarizeRun(file: string): RunSummary | null {
  const lines = readLines(file);
  const start = lines.find((l) => l.type === "start");
  if (!start) return null;

  const end = lines.find((l) => l.type === "end");
  const errorLine = lines.find((l) => l.type === "error");

  let toolCalls = 0;
  let toolErrors = 0;
  for (const l of lines) {
    if (l.type !== "sdk_message") continue;
    const msg = l.message as { type?: string; message?: { content?: unknown[] } } | undefined;
    if (msg?.type === "assistant" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message!.content as Array<Record<string, unknown>>) {
        if (b.type === "tool_use") toolCalls++;
      }
    }
    if (msg?.type === "user" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message!.content as Array<Record<string, unknown>>) {
        if (b.type === "tool_result" && b.is_error) toolErrors++;
      }
    }
  }

  const lastActivityAt = (lines[lines.length - 1]?.timestamp as string) ?? (start.timestamp as string);
  const startedAt = start.timestamp as string;
  const endedAt = end?.timestamp as string | undefined;

  let status: RunSummary["status"];
  if (end) {
    if (end.stopped) {
      status = "stopped";
    } else {
      status = (end.success as boolean) ? "success" : "failed";
    }
  } else if (errorLine) {
    status = "crashed";
  } else if (fs.existsSync(stopFilePath(start.runId as string))) {
    status = "stopping";
  } else {
    const age = Date.now() - new Date(lastActivityAt).getTime();
    status = age < STALL_THRESHOLD_MS ? "running" : "stalled";
  }

  const referenceEnd = endedAt ?? lastActivityAt;
  const durationMs = Math.max(0, new Date(referenceEnd).getTime() - new Date(startedAt).getTime());

  return {
    runId: start.runId as string,
    agentName: (start.agentName as string) ?? "unknown",
    model: start.model as string | undefined,
    maxTurns: start.maxTurns as number | undefined,
    status,
    startedAt,
    endedAt,
    durationMs,
    turns: end?.turns as number | undefined,
    userMessagePreview: preview(start.userMessage as string),
    toolCalls,
    toolErrors,
    lastActivityAt,
    error: errorLine?.error as string | undefined,
  };
}

function runDetail(file: string): { summary: RunSummary | null; timeline: TimelineEvent[] } {
  const lines = readLines(file);
  const timeline: TimelineEvent[] = [];

  for (const l of lines) {
    const ts = l.timestamp as string;
    if (l.type === "start") {
      timeline.push({
        ts,
        kind: "meta",
        text: `Started — agent=${l.agentName ?? "unknown"} model=${l.model ?? "?"} maxTurns=${l.maxTurns ?? "?"}\n\n${l.userMessage ?? ""}`,
      });
    } else if (l.type === "end") {
      timeline.push({
        ts,
        kind: "meta",
        text: l.stopped
          ? `Stopped by operator — turns=${l.turns}`
          : `Ended — success=${l.success} turns=${l.turns}`,
      });
    } else if (l.type === "error") {
      timeline.push({ ts, kind: "error", text: String(l.error) });
    } else if (l.type === "sdk_message") {
      const msg = l.message as {
        type?: string;
        subtype?: string;
        message?: { content?: unknown[] };
        result?: string;
        is_error?: boolean;
      };
      if (msg?.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const b of msg.message!.content as Array<Record<string, unknown>>) {
          if (b.type === "text" && b.text) {
            timeline.push({ ts, kind: "text", text: String(b.text) });
          } else if (b.type === "tool_use") {
            timeline.push({
              ts,
              kind: "tool_use",
              toolName: String(b.name ?? ""),
              toolInput: b.input,
            });
          }
        }
      } else if (msg?.type === "user" && Array.isArray(msg.message?.content)) {
        for (const b of msg.message!.content as Array<Record<string, unknown>>) {
          if (b.type === "tool_result") {
            timeline.push({
              ts,
              kind: "tool_result",
              isError: Boolean(b.is_error),
              text: preview(typeof b.content === "string" ? b.content : JSON.stringify(b.content), 500),
            });
          }
        }
      } else if (msg?.type === "system") {
        timeline.push({ ts, kind: "system", text: msg.subtype ?? "system" });
      } else if (msg?.type === "result") {
        timeline.push({
          ts,
          kind: "result",
          text: preview(msg.result, 800),
          isError: Boolean(msg.is_error),
        });
      }
    }
  }

  return { summary: summarizeRun(file), timeline };
}

function listRuns(): RunSummary[] {
  if (!fs.existsSync(LOG_DIR)) return [];
  return fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      try {
        return summarizeRun(path.join(LOG_DIR, f));
      } catch {
        return null;
      }
    })
    .filter((r): r is RunSummary => r !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Sub-Agent Run Dashboard</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 0; background: #0d1117; color: #e6edf3; }
  @media (prefers-color-scheme: light) { body { background: #f6f8fa; color: #1f2328; } }
  header { padding: 14px 20px; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .sub { font-size: 12px; opacity: 0.6; }
  #layout { display: flex; height: calc(100vh - 53px); }
  #list { width: 420px; overflow-y: auto; border-right: 1px solid #30363d; flex-shrink: 0; }
  #detail { flex: 1; overflow-y: auto; padding: 16px 20px; }
  .row { padding: 10px 16px; border-bottom: 1px solid #21262d; cursor: pointer; }
  .row:hover { background: #161b22; }
  @media (prefers-color-scheme: light) { .row:hover { background: #eef1f4; } }
  .row.active { background: #1c2a3a; }
  .row-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .agent { font-weight: 600; font-size: 13px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
  .badge.running { background: #1f6feb33; color: #58a6ff; }
  .badge.success { background: #23863633; color: #3fb950; }
  .badge.failed { background: #f8514933; color: #f85149; }
  .badge.crashed { background: #f8514933; color: #f85149; }
  .badge.stalled { background: #9e6a0333; color: #d29922; }
  .badge.stopping { background: #9e6a0333; color: #d29922; }
  .badge.stopped { background: #6e768133; color: #8b949e; }
  .stopbtn { background: #f8514922; border: 1px solid #f85149; color: #f85149; border-radius: 6px; padding: 2px 10px; font-size: 11px; cursor: pointer; }
  .stopbtn:hover { background: #f8514944; }
  .stopbtn:disabled { opacity: 0.5; cursor: default; }
  .meta-line { font-size: 12px; opacity: 0.65; margin-top: 4px; }
  .preview { font-size: 12px; opacity: 0.8; margin-top: 4px; }
  .runid { font-family: monospace; font-size: 11px; opacity: 0.5; }
  .empty { padding: 40px; text-align: center; opacity: 0.6; }
  #detail h2 { font-size: 15px; margin: 0 0 4px; }
  .ev { border-left: 3px solid #30363d; padding: 6px 0 6px 12px; margin-bottom: 6px; }
  .ev.text { border-color: #58a6ff; }
  .ev.tool_use { border-color: #d29922; }
  .ev.tool_result { border-color: #3fb950; }
  .ev.tool_result.err { border-color: #f85149; }
  .ev.system { border-color: #6e7681; opacity: 0.55; font-size: 11px; }
  .ev.meta { border-color: #8957e5; font-weight: 600; }
  .ev.result { border-color: #3fb950; font-weight: 600; }
  .ev.error { border-color: #f85149; color: #f85149; }
  .ev-ts { font-size: 10px; opacity: 0.5; font-family: monospace; }
  .ev-body { white-space: pre-wrap; font-size: 12.5px; font-family: monospace; margin-top: 2px; }
  .toolbar { padding: 8px 0; display: flex; gap: 6px; flex-wrap: wrap; }
  .toolbar button { background: #21262d; border: 1px solid #30363d; color: inherit; border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer; }
  .toolbar button.active { background: #1f6feb; border-color: #1f6feb; color: white; }
</style>
</head>
<body>
<header>
  <h1>Sub-Agent Run Dashboard</h1>
  <span class="sub" id="statusline">loading…</span>
</header>
<div id="layout">
  <div id="list"></div>
  <div id="detail"><div class="empty">Select a run to view its timeline.</div></div>
</div>
<script>
let selected = null;
let runs = [];
let filter = "all";

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m + "m " + (s % 60) + "s";
}
function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString();
}
function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function stopButtonHtml(summary) {
  if (summary.status === "running" || summary.status === "stalled") {
    return '<button class="stopbtn" data-stop="' + esc(summary.runId) + '">Stop</button>';
  }
  if (summary.status === "stopping") {
    return '<button class="stopbtn" disabled>Stopping…</button>';
  }
  return "";
}

async function stopRun(runId) {
  if (!confirm("Stop this run? The sub-agent will be aborted mid-task.")) return;
  const res = await fetch("/api/runs/" + runId + "/stop", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    alert("Could not stop run: " + (body.error || res.status));
  }
  loadList();
}

async function loadList() {
  const res = await fetch("/api/runs");
  runs = await res.json();
  render();
  if (selected) loadDetail(selected, true);
}

function render() {
  const list = document.getElementById("list");
  const running = runs.filter((r) => r.status === "running").length;
  document.getElementById("statusline").textContent =
    runs.length + " run(s) · " + running + " active";

  const agents = [...new Set(runs.map((r) => r.agentName))];
  const toolbar =
    '<div class="toolbar">' +
    ['all', ...agents]
      .map((a) => '<button data-f="' + esc(a) + '" class="' + (filter === a ? "active" : "") + '">' + esc(a) + "</button>")
      .join("") +
    "</div>";

  const filtered = filter === "all" ? runs : runs.filter((r) => r.agentName === filter);

  if (filtered.length === 0) {
    list.innerHTML = toolbar + '<div class="empty">No runs yet.</div>';
  } else {
    list.innerHTML =
      toolbar +
      filtered
        .map(
          (r) => \`
      <div class="row \${r.runId === selected ? "active" : ""}" data-id="\${r.runId}">
        <div class="row-top">
          <span class="agent">\${esc(r.agentName)}</span>
          <span style="display:flex;align-items:center;gap:6px;">
            \${stopButtonHtml(r)}
            <span class="badge \${r.status}">\${r.status}</span>
          </span>
        </div>
        <div class="meta-line">\${fmtTime(r.startedAt)} · \${fmtDuration(r.durationMs)} · \${r.toolCalls} tool call(s)\${r.toolErrors ? " · " + r.toolErrors + " tool error(s)" : ""}\${r.turns ? " · " + r.turns + " turn(s)" : ""}</div>
        <div class="preview">\${esc(r.userMessagePreview)}</div>
        <div class="runid">\${r.runId}</div>
      </div>\`
        )
        .join("");
  }

  for (const btn of list.querySelectorAll("[data-f]")) {
    btn.onclick = () => {
      filter = btn.dataset.f;
      render();
    };
  }
  for (const row of list.querySelectorAll(".row")) {
    row.onclick = () => {
      selected = row.dataset.id;
      render();
      loadDetail(selected);
    };
  }
  for (const btn of list.querySelectorAll("[data-stop]")) {
    btn.onclick = (e) => {
      e.stopPropagation();
      stopRun(btn.dataset.stop);
    };
  }
}

async function loadDetail(runId, silent) {
  const res = await fetch("/api/runs/" + runId);
  if (!res.ok) return;
  const { summary, timeline } = await res.json();
  const detail = document.getElementById("detail");
  const kindClass = (ev) => ev.kind + (ev.kind === "tool_result" && ev.isError ? " err" : "");
  detail.innerHTML =
    '<h2>' + esc(summary.agentName) + ' <span class="badge ' + summary.status + '">' + summary.status + '</span> ' + stopButtonHtml(summary) + '</h2>' +
    '<div class="meta-line">' + summary.runId + ' · model=' + esc(summary.model) + ' · ' + fmtDuration(summary.durationMs) + '</div><br/>' +
    timeline
      .map(
        (ev) => \`
      <div class="ev \${kindClass(ev)}">
        <div class="ev-ts">\${fmtTime(ev.ts)} · \${ev.kind}\${ev.toolName ? " · " + esc(ev.toolName) : ""}</div>
        <div class="ev-body">\${esc(ev.text || (ev.toolInput ? JSON.stringify(ev.toolInput) : ""))}</div>
      </div>\`
      )
      .join("");
  const detailStop = detail.querySelector("[data-stop]");
  if (detailStop) {
    detailStop.onclick = () => stopRun(detailStop.dataset.stop);
  }
}

loadList();
setInterval(loadList, 3000);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/" ) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  if (url.pathname === "/api/runs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listRuns()));
    return;
  }

  const stopMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)\/stop$/);
  if (stopMatch && req.method === "POST") {
    const runId = stopMatch[1];
    const file = path.join(LOG_DIR, `${runId}.jsonl`);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const summary = summarizeRun(file);
    if (summary && !["running", "stalled", "stopping"].includes(summary.status)) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `run already ${summary.status}` }));
      return;
    }
    fs.writeFileSync(
      stopFilePath(runId),
      JSON.stringify({ requestedAt: new Date().toISOString(), via: "dashboard" })
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const detailMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9-]+)$/);
  if (detailMatch) {
    const file = path.join(LOG_DIR, `${detailMatch[1]}.jsonl`);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(runDetail(file)));
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.error(`[dashboard] watching ${LOG_DIR}`);
  console.error(`[dashboard] http://localhost:${PORT}`);
});
