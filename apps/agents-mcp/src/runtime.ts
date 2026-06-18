import { Anthropic } from "@anthropic-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface RunSubAgentParams {
  systemPrompt: string;
  tools: any[];
  toolExecutor: (name: string, args: Record<string, any>) => Promise<any>;
  userMessage: string;
  model?: string;
  maxIterations?: number;
  onIteration?: (current: number, max: number) => Promise<void>;
}

export async function runSubAgent(params: RunSubAgentParams): Promise<{ success: boolean; result?: any; error?: string }> {
  const anthropic = new Anthropic();
  const maxIterations = params.maxIterations || 25;
  
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: params.userMessage }
  ];

  const runId = randomUUID();
  const logDir = path.join(__dirname, "..", "logs");
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${runId}.jsonl`);

  const appendLog = async (entry: any) => {
    await fs.appendFile(logFile, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
  };

  await appendLog({ type: "start", systemPrompt: params.systemPrompt, userMessage: params.userMessage });

  for (let i = 1; i <= maxIterations; i++) {
    if (params.onIteration) {
      await params.onIteration(i, maxIterations);
    }

    await appendLog({ type: "iteration", iteration: i });

    let response;
    try {
      response = await anthropic.messages.create({
        model: params.model || "claude-3-5-sonnet-latest",
        system: params.systemPrompt,
        messages,
        tools: params.tools.length > 0 ? params.tools as any : undefined,
        max_tokens: 4096,
      });
    } catch (err: any) {
      await appendLog({ type: "error", error: err.message });
      return { success: false, error: `Anthropic API error: ${err.message}` };
    }

    messages.push({ role: "assistant", content: response.content });
    await appendLog({ type: "response", response });

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          let output;
          let isError = false;
          try {
            const rawOutput = await params.toolExecutor(block.name, block.input as Record<string, any>);
            output = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
          } catch (err: any) {
            output = err.message;
            isError = true;
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output,
            is_error: isError,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      await appendLog({ type: "tool_results", toolResults });
    } else {
      const finalText = response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      await appendLog({ type: "end", finalText });
      
      try {
        return { success: true, result: JSON.parse(finalText) };
      } catch {
        return { success: true, result: finalText };
      }
    }
  }

  const errorMsg = "Max iterations reached";
  await appendLog({ type: "error", error: errorMsg });
  return { success: false, error: errorMsg };
}
