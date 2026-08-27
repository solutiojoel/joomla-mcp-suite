import { z } from "zod";
import { loadSubAgentConfig } from "../config.js";
import { connectDownstreams } from "../bridge.js";
import { runSubAgent, SubAgentEvent } from "../runtime.js";
import type { Defect } from "../verify-build.js";

export interface CssAuthorArgs {
  site_url: string;
  page_path?: string;
  /** Defects to address. Only those owned by css-author are sent through. */
  defects: Defect[];
  /** Existing override.css, so the model appends rather than rewrites. */
  existing_css?: string;
  css_filename?: string;
}

export interface CssAuthorResult {
  success: boolean;
  css_filename?: string;
  css?: string;
  rules_added?: number;
  addressed?: string[];
  skipped?: Array<{ id: string; reason: string }>;
  error?: string;
  run_log?: string;
}

/**
 * Run the css-author sub-agent — the CSS half of Phase 5.
 *
 * The second of the two stages that genuinely needs a model. Writing a rule
 * that fixes a visual defect without breaking three other pages is judgement
 * against a live DOM, not a lookup.
 *
 * It runs in its own context window because joomla_inspect_frontend output is
 * large; only a compact receipt comes back. The CSS itself lands in the
 * workspace for the caller to upload.
 */
export async function runCssAuthor(
  args: CssAuthorArgs,
  sendProgress: (progress: number, total: number) => Promise<void>,
  onEvent?: (event: SubAgentEvent) => void
): Promise<CssAuthorResult> {
  const { site_url, page_path = "/", existing_css = "" } = args;

  const mine = (args.defects ?? []).filter((d) => d.suggested_owner === "css-author");
  if (!mine.length) {
    return {
      success: true,
      rules_added: 0,
      addressed: [],
      skipped: [],
      css_filename: args.css_filename,
    };
  }

  const config = await loadSubAgentConfig("css-author");
  const { executor } = await connectDownstreams(config.downstreams, site_url, config.allow);

  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");

  const inspect = tool(
    "joomla_inspect_frontend",
    "Inspect one region of a rendered page: DOM structure, box-model geometry, and the CSS rules that actually match. Use it before writing any selector.",
    {
      path: z.string().describe("Frontend path, e.g. /"),
      selector: z.string().describe("CSS selector for the region"),
      include: z.array(z.string()).optional().describe('["box"] | ["css"] | ["box","css"]'),
      cssFor: z.string().optional().describe("Selector to report matching rules for"),
      properties: z.array(z.string()).optional().describe("Restrict CSS output to these properties"),
      depth: z.number().optional(),
    },
    async (input: Record<string, unknown>) => {
      const result = await executor("joomla_inspect_frontend", input);
      return {
        content: [
          { type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) },
        ],
      };
    }
  );

  const workspaceWrite = tool(
    "joomla_workspace_write",
    "Persist the full updated CSS to the site workspace.",
    {
      path: z.string().describe("Workspace filename, e.g. {site-slug}-override.css"),
      content: z.string().describe("The complete CSS file content"),
    },
    async (input: { path: string; content: string }) => {
      const result = await executor("joomla_workspace_write", input);
      return {
        content: [
          { type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) },
        ],
      };
    }
  );

  // read_agent_doc lives on the orchestrator, which is not a downstream of
  // agents-mcp. The docs are knowledge_universal rows, so fetch them by their
  // `doc:` tag through the gateway rather than duplicating 13KB of CSS rules
  // into this prompt, where they would drift from the doc.
  const readDoc = tool(
    "read_agent_doc",
    "Read a workflow guide by name. Use workflows/gantry-section-css for the CSS authority.",
    { doc: z.string().describe('Doc name, e.g. "workflows/gantry-section-css"') },
    async (input: { doc: string }) => {
      const result = await executor("knowledge_universal", {
        action: "list",
        tag: `doc:${input.doc}`,
      });
      return {
        content: [
          { type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) },
        ],
      };
    }
  );

  const server = createSdkMcpServer({
    name: "sitebuild",
    tools: [inspect, workspaceWrite, readDoc],
  });

  const slug = new URL(site_url).hostname.replace(/^www\./, "").split(".")[0];
  const cssFilename = args.css_filename || `${slug}-override.css`;

  const lines = [
    `Write CSS for: ${site_url}`,
    `Page: ${page_path}`,
    `Output file: ${cssFilename}`,
    "",
    "Defects to address:",
    JSON.stringify(mine, null, 2),
    "",
    existing_css.trim()
      ? [
          "--- EXISTING CSS START ---",
          existing_css.trim(),
          "--- EXISTING CSS END ---",
          "",
          "Append to this. Do not rewrite or reorder what is already there — other",
          "pages depend on rules you cannot see from here.",
        ].join("\n")
      : "There is no existing override.css. You are writing the first rules for this file.",
    "",
    "Inspect every selector with joomla_inspect_frontend before writing against it.",
    `1. Write the COMPLETE updated CSS to ${cssFilename} with joomla_workspace_write.`,
    "2. Then return ONLY this JSON, no prose and no code fences:",
    `   {"success": true, "css_path": "${cssFilename}", "rules_added": N, "addressed": ["d1"], "skipped": [{"id":"d2","reason":"..."}]}`,
    "",
    "Never paste the CSS body into your reply — the caller reads it from the workspace.",
  ];

  const result = await runSubAgent({
    agentName: "css-author",
    systemPrompt: config.instructions,
    userMessage: lines.join("\n"),
    mcpServers: { sitebuild: server },
    allowedTools: [
      "mcp__sitebuild__joomla_inspect_frontend",
      "mcp__sitebuild__joomla_workspace_write",
      "mcp__sitebuild__read_agent_doc",
    ],
    // css-author reads joomla_workspace_read through the executor directly
    // (below), not as a model-facing tool — the CSS never enters its context
    // twice.
    model: config.model,
    maxTurns: 40,
    onIteration: async (current, max) => {
      await sendProgress(current, max);
    },
    onEvent,
  });

  if (!result.success) {
    return { success: false, error: result.error, run_log: result.runLogPath };
  }

  const receipt = (typeof result.result === "object" && result.result !== null
    ? (result.result as Record<string, unknown>)
    : {}) as Record<string, any>;

  // Read the CSS back so the caller can upload it without trusting the receipt.
  let css: string | undefined;
  try {
    const loaded = await executor("joomla_workspace_read", { path: cssFilename });
    css = typeof loaded === "string" ? loaded : JSON.stringify(loaded);
  } catch {
    return {
      success: false,
      error: `Sub-agent reported success but '${cssFilename}' could not be read back from the workspace`,
      run_log: result.runLogPath,
    };
  }

  return {
    success: true,
    css_filename: cssFilename,
    css,
    rules_added: Number(receipt.rules_added ?? 0),
    addressed: Array.isArray(receipt.addressed) ? receipt.addressed : [],
    skipped: Array.isArray(receipt.skipped) ? receipt.skipped : [],
    run_log: result.runLogPath,
  };
}
