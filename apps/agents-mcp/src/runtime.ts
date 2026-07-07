import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRunLog } from "@solutio/logging";

/**
 * Sub-agent runtime on the Claude Agent SDK.
 *
 * Runs the Claude Code engine headlessly, so authentication comes from the
 * operator's Claude Code credentials — a Pro/Max subscription via
 * CLAUDE_CODE_OAUTH_TOKEN (mint one with `claude setup-token`) or the local
 * `claude` login. No ANTHROPIC_API_KEY is required.
 *
 * The SDK is ESM-only and this package compiles to CJS, so it is loaded via
 * dynamic import() (preserved by module: NodeNext).
 */

/** A user-visible event from the sub-agent run, for logging/observability. */
export interface SubAgentEvent {
  type: "text" | "tool_use" | "tool_result" | "system" | "result";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface RunSubAgentParams {
  /** Sub-agent identifier for observability, e.g. "menu-interpreter". */
  agentName: string;
  systemPrompt: string;
  userMessage: string;
  /** SDK MCP server configs, keyed by server name (see createSdkMcpServer). */
  mcpServers?: Record<string, unknown>;
  /** Tools auto-allowed without prompting, e.g. ["mcp__joomla__joomla_workspace_write"]. */
  allowedTools?: string[];
  /** Built-in Claude Code tools to expose. Defaults to [] — no filesystem/bash access. */
  builtinTools?: string[];
  model?: string;
  maxTurns?: number;
  cwd?: string;
  onIteration?: (current: number, max: number) => Promise<void>;
  /** Called for each notable event — lets the CLI runner stream the run live. */
  onEvent?: (event: SubAgentEvent) => void;
}

export interface RunSubAgentResult {
  success: boolean;
  result?: unknown;
  error?: string;
  runLogPath?: string;
}

/** Strip markdown code fences if the model wrapped its final JSON anyway. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return match ? match[1] : trimmed;
}

export async function runSubAgent(params: RunSubAgentParams): Promise<RunSubAgentResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const maxTurns = params.maxTurns || 30;
  const runId = randomUUID();
  const logDir = path.join(__dirname, "..", "logs");
  const runLog = createRunLog(logDir, runId);
  const runLogPath = path.join(logDir, `${runId}.jsonl`);
  const emit = (event: SubAgentEvent) => {
    try {
      params.onEvent?.(event);
    } catch {
      /* observer errors must not kill the run */
    }
  };

  await runLog.append({
    type: "start",
    runId,
    agentName: params.agentName,
    model: params.model,
    maxTurns,
    userMessage: params.userMessage,
  });

  const q = query({
    prompt: params.userMessage,
    options: {
      systemPrompt: params.systemPrompt,
      model: params.model,
      maxTurns,
      cwd: params.cwd,
      // Isolation: no user/project settings, no CLAUDE.md — the system prompt
      // in config/agents/<name> is the sub-agent's entire brain.
      settingSources: [],
      // Built-in tools off by default; the caller opts in (e.g. Read for PDFs).
      tools: (params.builtinTools ?? []) as string[],
      mcpServers: (params.mcpServers ?? {}) as never,
      allowedTools: params.allowedTools,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    },
  });

  let turns = 0;
  let finalResult: { success: boolean; result?: unknown; error?: string } | null = null;

  try {
    for await (const message of q) {
      await runLog.append({ type: "sdk_message", message });

      if (message.type === "assistant") {
        turns++;
        if (params.onIteration) await params.onIteration(turns, maxTurns);
        const content = (message as { message?: { content?: unknown[] } }).message?.content;
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === "text" && block.text) {
              emit({ type: "text", text: String(block.text) });
            } else if (block.type === "tool_use") {
              emit({
                type: "tool_use",
                toolName: String(block.name ?? ""),
                toolInput: block.input,
              });
            }
          }
        }
      } else if (message.type === "system") {
        const subtype = (message as { subtype?: string }).subtype;
        emit({ type: "system", text: subtype });
      } else if (message.type === "result") {
        const res = message as {
          subtype: string;
          is_error?: boolean;
          result?: string;
          num_turns?: number;
        };
        if (res.subtype === "success" && !res.is_error) {
          const text = stripFences(res.result ?? "");
          emit({ type: "result", text });
          try {
            finalResult = { success: true, result: JSON.parse(text) };
          } catch {
            finalResult = { success: true, result: text };
          }
        } else {
          const error = `Sub-agent run failed (${res.subtype})${res.result ? `: ${res.result}` : ""}`;
          emit({ type: "result", text: error });
          finalResult = { success: false, error };
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await runLog.append({ type: "error", error: msg });
    return { success: false, error: `Agent SDK error: ${msg}`, runLogPath };
  }

  if (!finalResult) {
    finalResult = { success: false, error: "Sub-agent produced no result message" };
  }

  await runLog.append({ type: "end", success: finalResult.success, turns });
  return { ...finalResult, runLogPath };
}
