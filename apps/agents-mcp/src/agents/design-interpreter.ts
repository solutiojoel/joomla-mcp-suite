import path from "node:path";
import { z } from "zod";
import { loadSubAgentConfig } from "../config.js";
import { connectDownstreams } from "../bridge.js";
import { runSubAgent, SubAgentEvent } from "../runtime.js";
import { validateDesignSpec, ValidationIssue } from "../design-spec-validator.js";

export interface DesignInterpreterArgs {
  site_url: string;
  site_type?: string;
  /** new | redesign — from survey_site. The spec must carry it. */
  build_type?: "new" | "redesign";
  /** redesign only: the parent category everything nests under. */
  redesign_root?: string;
  target_outline?: string;
  theme?: string;
  /** Absolute path to a mockup image, PDF, Figma export, or Claude Design
   *  export (.dc.html) on this host. The sub-agent reads it itself. */
  reference_path?: string;
  /** A reference URL to reproduce, when there is no local file. */
  reference_url?: string;
  /** A written brief, when there is no visual reference at all. */
  brief?: string;
  spec_filename?: string;
}

export interface DesignInterpreterResult {
  success: boolean;
  spec?: Record<string, unknown>;
  spec_filename?: string;
  error?: string;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
  partial_spec?: unknown;
  run_log?: string;
}

/** Markup inputs are read structurally; images need vision. */
function referenceKind(p: string | undefined, url?: string, brief?: string): string {
  if (url) return "reference_url";
  if (brief && !p) return "brief";
  if (!p) return "brief";
  const ext = path.extname(p).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "claude_design_export";
  if (ext === ".pdf") return "mockup_image";
  return "mockup_image";
}

/**
 * Run the design-interpreter sub-agent — Phase 1 of the site build.
 *
 * This is one of only two stages in the pipeline that genuinely needs a model:
 * reading a visual reference and deciding what each band is, which pattern
 * fits, and what content should feed it. Everything downstream of the approved
 * spec is deterministic.
 *
 * The reference (image, PDF, or markup) is read inside the sub-agent's own
 * context window and never reaches the caller.
 */
export async function runDesignInterpreter(
  args: DesignInterpreterArgs,
  sendProgress: (progress: number, total: number) => Promise<void>,
  onEvent?: (event: SubAgentEvent) => void
): Promise<DesignInterpreterResult> {
  const { site_url, reference_path, reference_url, brief } = args;

  if (!reference_path && !reference_url && !brief) {
    return {
      success: false,
      error: "Provide one of reference_path, reference_url, or brief",
    };
  }

  const config = await loadSubAgentConfig("design-interpreter");
  const { executor } = await connectDownstreams(config.downstreams, site_url, config.allow);

  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");

  const workspaceWrite = tool(
    "joomla_workspace_write",
    "Persist a file to the active site's workspace. Use it to save the finished Design Spec JSON.",
    {
      path: z.string().describe("Workspace filename, e.g. {site-slug}-design-spec.json"),
      content: z.string().describe("Full file content (the Design Spec JSON)"),
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

  // The pattern/particle/template catalogue, so section choices come from what
  // the fleet actually has rather than from the model's memory of it.
  const gantryReference = tool(
    "gantry_reference",
    "Gantry design knowledge base. topic: patterns | particles | section_templates | homepage_examples | conventions.",
    {
      topic: z
        .enum(["patterns", "particles", "section_templates", "homepage_examples", "conventions"])
        .describe("Which reference to return"),
      name: z.string().optional().describe("patterns/section_templates: fetch one by name"),
      subtype: z.string().optional().describe("particles: one subtype, e.g. contentarray"),
      site_type: z.string().optional().describe("patterns/homepage_examples: filter the listing"),
    },
    async (input: Record<string, unknown>) => {
      const result = await executor("gantry_reference", input);
      return {
        content: [
          { type: "text" as const, text: typeof result === "string" ? result : JSON.stringify(result) },
        ],
      };
    }
  );

  const server = createSdkMcpServer({
    name: "sitebuild",
    tools: [workspaceWrite, gantryReference],
  });

  const slug = new URL(site_url).hostname.replace(/^www\./, "").split(".")[0];
  const specFilename = args.spec_filename || `${slug}-design-spec.json`;
  const today = new Date().toISOString().slice(0, 10);
  const kind = referenceKind(reference_path, reference_url, brief);
  const needsFileRead = !!reference_path;

  const lines = [
    `Interpret the visual reference for site: ${site_url}`,
    `Site type: ${args.site_type ?? "parish"}`,
    `Build type: ${args.build_type ?? "new"}${args.build_type === "redesign" ? ` (redesign root: ${args.redesign_root ?? "Redesign"})` : ""}`,
    `Target outline: ${args.target_outline ?? "#Home"}`,
    `Theme: ${args.theme ?? "rt_studius"}`,
    `Source kind: ${kind}`,
    `Today's date: ${today}`,
    "",
  ];

  if (reference_path) {
    lines.push(
      `The reference is a file at: ${reference_path}`,
      kind === "claude_design_export"
        ? "It is markup. Read it with the Read tool and derive the band structure from the DOM directly — use judgement only where the markup is ambiguous."
        : "Read it with the Read tool. If it is a multi-page PDF, read it in chunks with the pages parameter.",
      ""
    );
  } else if (reference_url) {
    lines.push(`The reference is a live page: ${reference_url}`, "");
  } else {
    lines.push("--- BRIEF START ---", String(brief).trim(), "--- BRIEF END ---", "");
  }

  lines.push(
    "Produce the Design Spec JSON following the rules in your system prompt.",
    `Set "build_type": "${args.build_type ?? "new"}" in the spec.`,
    "Every content-bearing block MUST carry a content_binding — that rule is enforced",
    "by a validator after you return, so a spec that breaks it will be rejected.",
    "",
    `1. Persist the spec with joomla_workspace_write to: ${specFilename}`,
    "2. Then return ONLY this JSON as your final response, no prose and no code fences:",
    `   {"success": true, "spec_path": "${specFilename}", "section_count": N, "open_question_count": N}`,
    "",
    "The caller reads the spec from the workspace, so never paste the spec body into your reply."
  );

  const result = await runSubAgent({
    agentName: "design-interpreter",
    systemPrompt: config.instructions,
    userMessage: lines.join("\n"),
    mcpServers: { sitebuild: server },
    allowedTools: [
      "mcp__sitebuild__joomla_workspace_write",
      "mcp__sitebuild__gantry_reference",
      ...(needsFileRead ? ["Read"] : []),
    ],
    builtinTools: needsFileRead ? ["Read"] : [],
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

  // The sub-agent returns a receipt; the spec itself is read back from the
  // workspace so the body never travels through the model's final message.
  let spec: Record<string, unknown> | null = null;
  try {
    const loaded = await executor("joomla_workspace_read", { path: specFilename });
    spec = typeof loaded === "string" ? JSON.parse(loaded) : (loaded as Record<string, unknown>);
  } catch (err: unknown) {
    return {
      success: false,
      error: `Sub-agent finished but the spec could not be read back from '${specFilename}': ${
        err instanceof Error ? err.message : err
      }`,
      partial_spec: result.result,
      run_log: result.runLogPath,
    };
  }

  if (!spec || typeof spec !== "object") {
    return {
      success: false,
      error: `Workspace file '${specFilename}' is not valid Design Spec JSON`,
      run_log: result.runLogPath,
    };
  }

  const validation = validateDesignSpec(spec);
  if (!validation.valid) {
    return {
      success: false,
      error: `Design Spec failed validation: ${validation.errors.length} error(s). The spec is saved at ${specFilename} — fix it there and re-validate rather than re-running interpretation.`,
      errors: validation.errors,
      warnings: validation.warnings,
      partial_spec: spec,
      spec_filename: specFilename,
      run_log: result.runLogPath,
    };
  }

  return {
    success: true,
    spec,
    spec_filename: specFilename,
    warnings: validation.warnings,
    run_log: result.runLogPath,
  };
}
