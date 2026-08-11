import path from "node:path";
import { z } from "zod";
import { loadSubAgentConfig } from "../config.js";
import { connectDownstreams } from "../bridge.js";
import { runSubAgent, SubAgentEvent } from "../runtime.js";
import { validateSpec } from "../spec-validator.js";

export interface MenuInterpreterArgs {
  site_url: string;
  /** Raw text of the menu document. Provide this OR pdf_path. */
  menu_text?: string;
  /** Absolute path to the menu PDF on this host. The sub-agent reads it
   *  directly, keeping the document out of the caller's context window. */
  pdf_path?: string;
  source_filename?: string;
  /** Identity (email) of the triggering user — resolved to their personal Claude token. */
  triggered_by?: string;
}

export interface MenuInterpreterResult {
  success: boolean;
  spec?: Record<string, unknown>;
  error?: string;
  schema_errors?: string[];
  lint_errors?: string[];
  partial_spec?: unknown;
  run_log?: string;
}

/**
 * Run the menu-interpreter sub-agent.
 *
 * Phase 1–2 of the menu build: reads a menu document (raw text or a PDF on
 * disk), classifies it into a Menu Spec in a separate context window via the
 * Claude Agent SDK (operator subscription auth — no API key), persists the
 * spec with joomla_workspace_write, and returns it after schema + lint
 * validation.
 */
export async function runMenuInterpreter(
  args: MenuInterpreterArgs,
  sendProgress: (progress: number, total: number) => Promise<void>,
  onEvent?: (event: SubAgentEvent) => void
): Promise<MenuInterpreterResult> {
  const { site_url, menu_text, pdf_path, source_filename, triggered_by } = args;

  if (!menu_text && !pdf_path) {
    return { success: false, error: "Provide either menu_text or pdf_path" };
  }

  // Load config (system prompt + model + tool allow list + downstreams)
  const config = await loadSubAgentConfig("menu-interpreter");

  // Connect to the declared downstreams (joomla-mcp for joomla_workspace_write).
  // The bridge enforces the allow-list at execution time and injects site_url,
  // so the sub-agent never has to (and never can) address other tools or sites.
  const { executor } = await connectDownstreams(config.downstreams, site_url, config.allow);

  // Wrap the bridge executor as an in-process MCP server for the Agent SDK.
  // The model sees one tool: mcp__joomla__joomla_workspace_write.
  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const workspaceWrite = tool(
    "joomla_workspace_write",
    "Persist a file to the active site's workspace. Use it to save the finished Menu Spec JSON.",
    {
      path: z.string().describe("Workspace filename (no directories), e.g. {site-slug}-menu-spec.json"),
      content: z.string().describe("Full file content (the Menu Spec JSON)"),
    },
    async (input: { path: string; content: string }) => {
      const result = await executor("joomla_workspace_write", input);
      return {
        content: [
          {
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result),
          },
        ],
      };
    }
  );
  const joomlaServer = createSdkMcpServer({ name: "joomla", tools: [workspaceWrite] });

  const today = new Date().toISOString().slice(0, 10);
  const sourceName = source_filename || (pdf_path ? path.basename(pdf_path) : "menu document");

  const promptLines = [
    `Interpret the following menu document for site: ${site_url}`,
    `Source document: ${sourceName}`,
    `Today's date: ${today}`,
    "",
  ];

  if (pdf_path) {
    promptLines.push(
      `The menu document is a PDF at: ${pdf_path}`,
      "Read it with the Read tool before interpreting. If the PDF has more than",
      "10 pages, read it in chunks using the pages parameter (e.g. \"1-10\").",
      ""
    );
  } else {
    promptLines.push(
      "--- MENU DOCUMENT START ---",
      (menu_text ?? "").trim(),
      "--- MENU DOCUMENT END ---",
      ""
    );
  }

  promptLines.push(
    "Produce the Menu Spec JSON following the rules in your system prompt.",
    "1. Persist the spec with the joomla_workspace_write tool.",
    "2. Then return the complete spec JSON as your final text response (no prose, no code fences)."
  );

  const result = await runSubAgent({
    agentName: "menu-interpreter",
    triggeredBy: triggered_by,
    systemPrompt: config.instructions,
    userMessage: promptLines.join("\n"),
    mcpServers: { joomla: joomlaServer },
    allowedTools: [
      "mcp__joomla__joomla_workspace_write",
      ...(pdf_path ? ["Read"] : []),
    ],
    builtinTools: pdf_path ? ["Read"] : [],
    model: config.model,
    maxTurns: 30,
    onIteration: async (current, max) => {
      await sendProgress(current, max);
    },
    onEvent,
  });

  if (!result.success) {
    return { success: false, error: result.error, run_log: result.runLogPath };
  }

  // Parse the result — runtime already tries JSON.parse on the final text
  const rawResult = result.result;
  let spec: Record<string, unknown> | null = null;

  if (typeof rawResult === "object" && rawResult !== null) {
    spec = rawResult as Record<string, unknown>;
  } else if (typeof rawResult === "string") {
    try {
      spec = JSON.parse(rawResult);
    } catch {
      return {
        success: false,
        error: "Sub-agent returned non-JSON final response",
        partial_spec: rawResult,
        run_log: result.runLogPath,
      };
    }
  }

  if (!spec) {
    return { success: false, error: "Sub-agent returned an empty result", run_log: result.runLogPath };
  }

  // Error envelope from the sub-agent itself
  if (spec.success === false && typeof spec.error === "string") {
    return { success: false, error: spec.error, partial_spec: spec, run_log: result.runLogPath };
  }

  // Structural schema validation + the 8 lint invariants
  const validation = validateSpec(spec);
  if (!validation.valid) {
    return {
      success: false,
      error: `Spec failed validation: ${validation.schema_errors.length} schema error(s), ${validation.lint_errors.length} lint error(s)`,
      schema_errors: validation.schema_errors,
      lint_errors: validation.lint_errors,
      partial_spec: spec,
      run_log: result.runLogPath,
    };
  }

  return { success: true, spec, run_log: result.runLogPath };
}
