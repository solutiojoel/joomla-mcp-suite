import fs from "node:fs";
import path from "node:path";
import { orchestratorUrl } from "../mcp";
import { dataDir } from "../store";
import { claudeTokenFor, type RuntimeUser } from "../users";

/**
 * One chat session = one Claude Agent SDK query() loop (the same engine as
 * Claude Code; pattern adapted from apps/agents-mcp/src/runtime.ts) with a
 * streaming async-iterable prompt so the conversation is multi-turn.
 *
 * The loop's only capabilities are the orchestrator MCP tools (called with
 * THIS user's bearer token, so scoping/audit attribution are unchanged) plus
 * the built-in Read tool for user-attached files. LLM credentials: the user's
 * personal Claude OAuth token if registered, else the shared credential
 * already in the runtime's environment.
 */

export interface DriverCallbacks {
  /** Assign a seq, persist to the transcript, broadcast on SSE. Returns the seq. */
  emit(event: string, data: Record<string, unknown>): number;
  onSdkSessionId(sdkSessionId: string): void;
  onTurnDone(): void;
  /** The SDK loop ended — the driver is no longer usable. */
  onExit(error?: string): void;
}

export interface DriverParams {
  sessionId: string;
  user: RuntimeUser;
  agent: string;
  siteUrl?: string | null;
  resumeSdkSessionId?: string | null;
  callbacks: DriverCallbacks;
}

interface QueuedUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

/** Push-based async iterable feeding the SDK's streaming prompt input. */
class MessageQueue implements AsyncIterable<QueuedUserMessage> {
  private buffer: QueuedUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<QueuedUserMessage>) => void> = [];
  private closed = false;

  push(text: string): void {
    const msg: QueuedUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.buffer.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<QueuedUserMessage> {
    return {
      next: (): Promise<IteratorResult<QueuedUserMessage>> => {
        const msg = this.buffer.shift();
        if (msg) return Promise.resolve({ value: msg, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Compact a tool_result content payload into a one-line summary for the UI. */
function summarizeToolResult(content: unknown, maxLen = 500): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        const b = block as Record<string, unknown>;
        return b?.type === "text" ? String(b.text ?? "") : `[${String(b?.type ?? "block")}]`;
      })
      .join(" ");
  } else if (content != null) {
    text = JSON.stringify(content);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

// SDK subprocesses share a stable cwd so `resume` finds its session files.
const SDK_CWD = path.join(dataDir(), "sdk-cwd");

export class ChatDriver {
  /** True until the bootstrap turn completes — used for resume-failure fallback. */
  bootstrapping = true;

  // True from the moment any input (bootstrap or user message) is queued until
  // the engine reports a completed turn. NOTE: the engine merges all queued
  // input into one turn (a user message sent to a just-resumed session rides
  // along with the bootstrap turn and produces a single `result`), so this is
  // a flag cleared on every result — never a per-message counter.
  private busyFlag = false;
  // On a cold spawn the engine can run the first turn before the orchestrator
  // MCP connection is registered; if bootstrap finishes without a successful
  // orchestrator tool call, it is retried once.
  private sawOrchestratorTool = false;
  private bootstrapAttempts = 1;
  private queue = new MessageQueue();
  private abort = new AbortController();
  private q: { interrupt(): Promise<void> } | null = null;
  private pendingTools = new Map<string, string>(); // tool_use_id → toolName
  private stopped = false;
  private exited = false;

  constructor(private p: DriverParams) {}

  /** Spawn the SDK loop and queue the bootstrap turn. Resolves once the loop is running. */
  async start(): Promise<void> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    fs.mkdirSync(SDK_CWD, { recursive: true });

    // Credential resolution: personal token wins; otherwise the shared
    // CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY already in our env applies.
    const env: Record<string, string | undefined> = { ...process.env };
    let personal: string | null = null;
    try {
      personal = claudeTokenFor(this.p.user);
    } catch (err) {
      console.warn(
        `[chat] cannot decrypt personal token for ${this.p.user.email} — using shared credential: ${(err as Error).message}`
      );
    }
    if (personal) {
      env.CLAUDE_CODE_OAUTH_TOKEN = personal;
      delete env.ANTHROPIC_API_KEY;
    }

    this.q = query({
      prompt: this.queue,
      options: {
        systemPrompt: this.systemPrompt(),
        model: process.env.AGENT_RUNTIME_CHAT_MODEL || undefined,
        maxTurns: Number(process.env.AGENT_RUNTIME_MAX_TURNS || 60),
        cwd: SDK_CWD,
        // Isolation: no user/project settings or CLAUDE.md — instructions come
        // from the orchestrator's get_agent_instructions, same as every agent.
        settingSources: [],
        // Read only, for user-attached files; no Bash/Write/filesystem beyond that.
        tools: ["Read"],
        mcpServers: {
          orchestrator: {
            type: "http",
            url: orchestratorUrl(),
            headers: { Authorization: `Bearer ${this.p.user.orchestratorToken}` },
          },
        },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController: this.abort,
        resume: this.p.resumeSdkSessionId || undefined,
        env,
      },
    }) as unknown as { interrupt(): Promise<void> };

    this.busyFlag = true;
    this.p.callbacks.emit("status", { state: "thinking" });
    this.queue.push(this.bootstrapText());
    void this.runLoop();
  }

  /** True while any turn (including bootstrap) is queued or in flight. */
  get busy(): boolean {
    return this.busyFlag;
  }

  /** Queue the next user turn. Caller must have checked `busy` first. */
  pushUserTurn(promptText: string): void {
    if (this.exited) throw new Error("driver has exited");
    this.busyFlag = true;
    this.queue.push(promptText);
  }

  /** Abort the in-flight turn; the session stays open. */
  async interrupt(): Promise<boolean> {
    if (!this.q || !this.busy) return false;
    try {
      await this.q.interrupt();
    } catch (err) {
      console.warn(`[chat] interrupt failed for ${this.p.sessionId}: ${(err as Error).message}`);
      return false;
    }
    // The SDK usually emits a result message after an interrupt; if it doesn't
    // arrive promptly, re-enable input ourselves so the session can't wedge.
    setTimeout(() => {
      if (this.busyFlag && !this.exited) {
        this.busyFlag = false;
        this.endTurn();
      }
    }, 3000);
    return true;
  }

  /** Shut the loop down (session closed / runtime shutdown). */
  stop(): void {
    this.stopped = true;
    this.queue.close();
    this.abort.abort();
  }

  private endTurn(): void {
    this.p.callbacks.emit("status", { state: "idle" });
    this.p.callbacks.emit("done", {}); // manager stamps turnSeq
    this.p.callbacks.onTurnDone();
  }

  private async runLoop(): Promise<void> {
    const cb = this.p.callbacks;
    let error: string | undefined;
    try {
      for await (const raw of this.q as unknown as AsyncIterable<Record<string, unknown>>) {
        const message = raw as {
          type: string;
          subtype?: string;
          session_id?: string;
          parent_tool_use_id?: string | null;
          event?: { type?: string; delta?: { type?: string; text?: string } };
          message?: { content?: unknown };
          is_error?: boolean;
          result?: string;
        };
        switch (message.type) {
          case "system": {
            if (message.subtype === "init" && message.session_id) {
              cb.onSdkSessionId(message.session_id);
            }
            break;
          }
          case "stream_event": {
            if (message.parent_tool_use_id) break;
            const ev = message.event;
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
              cb.emit("text.delta", { text: ev.delta.text });
            }
            break;
          }
          case "assistant": {
            if (message.parent_tool_use_id) break;
            const content = message.message?.content;
            if (!Array.isArray(content)) break;
            for (const rawBlock of content) {
              const block = rawBlock as Record<string, unknown>;
              if (block.type === "text" && block.text) {
                cb.emit("message", { role: "assistant", type: "text", text: String(block.text) });
              } else if (block.type === "tool_use") {
                this.pendingTools.set(String(block.id), String(block.name ?? ""));
                cb.emit("tool_use", { toolName: String(block.name ?? ""), toolInput: block.input });
                cb.emit("status", { state: "running_tool" });
              }
            }
            break;
          }
          case "user": {
            // Tool results echo back as user-role messages in the SDK stream.
            if (message.parent_tool_use_id) break;
            const content = message.message?.content;
            if (!Array.isArray(content)) break;
            for (const rawBlock of content) {
              const block = rawBlock as Record<string, unknown>;
              if (block.type !== "tool_result") continue;
              const toolName = this.pendingTools.get(String(block.tool_use_id)) || "";
              this.pendingTools.delete(String(block.tool_use_id));
              if (toolName.startsWith("mcp__orchestrator__") && !block.is_error) {
                this.sawOrchestratorTool = true;
              }
              cb.emit("tool_result", {
                toolName,
                summary: summarizeToolResult(block.content),
                isError: !!block.is_error,
              });
              cb.emit("status", { state: "thinking" });
            }
            break;
          }
          case "result": {
            // A result means the engine has gone idle (all queued input consumed).
            if (this.bootstrapping) {
              if (!this.sawOrchestratorTool && !this.stopped && this.bootstrapAttempts < 2) {
                this.bootstrapAttempts++;
                console.warn(`[chat] ${this.p.sessionId}: bootstrap saw no orchestrator tools — retrying once`);
                this.queue.push(
                  `[Automated retry — the orchestrator tools may not have been connected a moment ago.]\n` +
                    `Run the session setup again now:\n${this.bootstrapText()}`
                );
                break; // stay busy through the retry
              }
              this.bootstrapping = false;
            }
            if (this.busyFlag) {
              this.busyFlag = false;
              this.endTurn();
            }
            break;
          }
        }
      }
    } catch (err) {
      if (!this.stopped) error = err instanceof Error ? err.message : String(err);
    }
    this.exited = true;
    this.queue.close();
    if (this.busyFlag && !this.stopped) {
      // The loop died mid-turn (crash, maxTurns). Unwedge the UI; the next
      // user message starts a fresh loop with `resume`.
      this.busyFlag = false;
      cb.emit("status", { state: "error", message: error || "Session loop ended unexpectedly" });
      cb.emit("done", {});
    }
    cb.onExit(error);
  }

  private systemPrompt(): string {
    const { user, agent, siteUrl } = this.p;
    return [
      `You are the "${agent}" agent in the Solutio AI Dashboard, in a chat session with ${user.displayName || user.email} (${user.email}).`,
      `All of your capabilities come from the connected orchestrator MCP tools (mcp__orchestrator__*).`,
      `Your full operating instructions come from the get_agent_instructions tool during session setup — follow them for the rest of the conversation.`,
      siteUrl
        ? `This session works on ${siteUrl}. Do not switch sites unless the user asks.`
        : `No site is selected yet — ask which site to work on before making changes, and call set_active_site once known.`,
      `The user sees your text plus a live feed of your tool calls; keep replies concise and readable.`,
      `When the user attaches a file, its absolute path appears in their message — open it with the Read tool.`,
    ].join("\n");
  }

  private bootstrapText(): string {
    const { agent, siteUrl } = this.p;
    const steps = [
      `1. Call get_current_agent. If the current agent is not "${agent}", call switch_agent with {"agent": "${agent}"}.`,
    ];
    if (siteUrl) {
      steps.push(`2. Call set_active_site with {"url": "${siteUrl}"} and confirm it with get_active_site.`);
      steps.push(`3. Call get_agent_instructions and keep its conventions in mind for this conversation.`);
      steps.push(`4. Call get_site_notes and note any quirks relevant to upcoming work.`);
    } else {
      steps.push(`2. Call get_agent_instructions and keep its conventions in mind for this conversation.`);
    }
    return [
      `[Automated session bootstrap — this message was not written by the user.]`,
      `Set up this dashboard chat session:`,
      ...steps,
      `Then reply with ONE short line confirming the agent${siteUrl ? " and active site" : ""} (or describing any setup problem). Do not begin any other work yet.`,
    ].join("\n");
  }
}
