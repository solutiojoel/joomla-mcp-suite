import path from "node:path";
import { z } from "zod";
import { loadSubAgentConfig } from "../config.js";
import { connectDownstreams } from "../bridge.js";
import { runSubAgent, SubAgentEvent } from "../runtime.js";
import {
  deriveContentSchematic,
  collectExcludedNodes,
  ContentSchematic,
  DeriveChanges,
} from "../schematic.js";
import { validateSchematic, diffNodeKeys } from "../schematic-validator.js";

export interface ContentInterpreterArgs {
  site_url: string;
  /** Absolute path to the client menu/content PDF on this host — the same
   *  document the menu structure was interpreted from. The sub-agent reads it
   *  directly, keeping it out of the caller's context window. */
  pdf_path: string;
  /** The approved Menu Spec JSON — the scaffold is derived from it here, so
   *  the schematic always reflects the spec as passed. */
  spec: Record<string, unknown>;
  /** Existing schematic to merge into (preserves filled content on re-runs). */
  schematic?: ContentSchematic | null;
  /** Workspace filename to persist to. Defaults to {site-slug}-content-schematic.json. */
  schematic_filename?: string;
  source_filename?: string;
}

export interface ContentInterpreterResult {
  success: boolean;
  schematic?: ContentSchematic;
  changes?: DeriveChanges;
  error?: string;
  schema_errors?: string[];
  lint_errors?: string[];
  structure_errors?: string[];
  partial_schematic?: unknown;
  run_log?: string;
}

/**
 * Run the content-interpreter sub-agent.
 *
 * Phase 3.5 of the menu build: derives the Content Schematic scaffold from the
 * approved Menu Spec (deterministic — the sync guarantee), then has the
 * sub-agent read the client PDF in a separate context window and fill each
 * entry's content fields. The returned schematic is schema/lint validated AND
 * checked for node-key-set equality against the scaffold — the interpreter can
 * never change structure, only enrich it.
 */
export async function runContentInterpreter(
  args: ContentInterpreterArgs,
  sendProgress: (progress: number, total: number) => Promise<void>,
  onEvent?: (event: SubAgentEvent) => void
): Promise<ContentInterpreterResult> {
  const { site_url, pdf_path, spec } = args;

  if (!site_url) return { success: false, error: "site_url is required" };
  if (!pdf_path) return { success: false, error: "pdf_path is required" };
  if (!spec || typeof spec !== "object") {
    return { success: false, error: "spec is required (the approved Menu Spec JSON)" };
  }

  const slug = new URL(site_url).hostname.replace(/^www\./, "").split(".")[0];
  const schematicFilename = args.schematic_filename || `${slug}-content-schematic.json`;
  const sourceName = args.source_filename || path.basename(pdf_path);

  // Deterministic scaffold — structure comes from the spec, never the PDF.
  const { schematic: scaffold, changes } = deriveContentSchematic(spec, args.schematic ?? null, {
    source: sourceName,
    menu_spec_file: `${slug}-menu-spec.json`,
  });

  if (scaffold.entries.length === 0) {
    return {
      success: false,
      error: "Derived scaffold has no entries — is the spec missing its menus?",
    };
  }

  const config = await loadSubAgentConfig("content-interpreter");
  const { executor } = await connectDownstreams(config.downstreams, site_url, config.allow);

  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
  const workspaceWrite = tool(
    "joomla_workspace_write",
    "Persist a file to the active site's workspace. Use it to save the finished Content Schematic JSON.",
    {
      path: z.string().describe("Workspace filename (no directories), e.g. {site-slug}-content-schematic.json"),
      content: z.string().describe("Full file content (the Content Schematic JSON)"),
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

  const promptLines = [
    `Fill the Content Schematic for site: ${site_url}`,
    `Source document: ${sourceName}`,
    `Workspace schematic filename: ${schematicFilename}`,
    "",
    `The client PDF is at: ${pdf_path}`,
    "Read it with the Read tool before filling anything. If the PDF has more than",
    "10 pages, read it in chunks using the pages parameter (e.g. \"1-10\").",
    "",
    "--- SCAFFOLD START ---",
    JSON.stringify(scaffold),
    "--- SCAFFOLD END ---",
    "",
    "These menu pages intentionally have NO schematic entry (external redirects, aliases, separators).",
    "If the PDF gives content direction for one of them, do NOT flag it as missing/removed — any",
    "URL asks for these are already tracked in the Menu Spec's open questions:",
    ...collectExcludedNodes(spec).map((n) => `- ${n.title} (${n.type})`),
    "",
    "The scaffold's entry set is final — derived from the human-approved Menu Spec.",
    "Fill the content fields per your system prompt. Never add, remove, or rekey entries.",
    `1. Persist the filled schematic with joomla_workspace_write (path: "${schematicFilename}").`,
    "2. Then reply with a short confirmation only (e.g. \"done\") — do NOT repeat the schematic JSON in your final response.",
    "If you cannot produce a valid schematic, skip the write and reply with { \"success\": false, \"error\": \"reason\" } instead.",
  ];

  const result = await runSubAgent({
    agentName: "content-interpreter",
    systemPrompt: config.instructions,
    userMessage: promptLines.join("\n"),
    mcpServers: { joomla: joomlaServer },
    allowedTools: ["mcp__joomla__joomla_workspace_write", "Read"],
    builtinTools: ["Read"],
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

  // The model may still self-report failure in its final text instead of writing
  // the file (e.g. "I couldn't produce a valid schematic") — check that first.
  const rawResult = result.result;
  const asFailure = (val: unknown): { error: string } | null => {
    if (typeof val === "object" && val !== null && (val as Record<string, unknown>).success === false) {
      const err = (val as Record<string, unknown>).error;
      return { error: typeof err === "string" ? err : "Sub-agent reported failure" };
    }
    if (typeof val === "string") {
      try {
        return asFailure(JSON.parse(val));
      } catch {
        return null;
      }
    }
    return null;
  };
  const reportedFailure = asFailure(rawResult);
  if (reportedFailure) {
    return {
      success: false,
      error: reportedFailure.error,
      partial_schematic: rawResult,
      run_log: result.runLogPath,
    };
  }

  // Read the persisted schematic back from the workspace rather than trusting the
  // model to repeat the full (potentially large) JSON a second time in its final
  // response — halves output-token generation for the run's largest artifact.
  let filled: Record<string, unknown> | null = null;
  try {
    const read = await executor("joomla_workspace_read", { path: schematicFilename });
    filled = typeof read === "string" ? JSON.parse(read) : (read as Record<string, unknown>);
  } catch (err) {
    return {
      success: false,
      error: `Could not read persisted schematic from workspace: ${err instanceof Error ? err.message : String(err)}`,
      run_log: result.runLogPath,
    };
  }

  if (!filled) {
    return { success: false, error: "Workspace schematic file was empty", run_log: result.runLogPath };
  }

  // Structure lock: the returned entry set must equal the scaffold's exactly.
  const structureDiff = diffNodeKeys(filled, scaffold);
  if (structureDiff.length > 0) {
    return {
      success: false,
      error: `Sub-agent changed the schematic's structure (${structureDiff.length} node-key mismatch(es)) — structure is owned by the derivation`,
      structure_errors: structureDiff,
      partial_schematic: filled,
      run_log: result.runLogPath,
    };
  }

  // Schema + lint + cross-lint against the spec the scaffold came from.
  const validation = validateSchematic(filled, spec);
  if (!validation.valid) {
    return {
      success: false,
      error: `Schematic failed validation: ${validation.schema_errors.length} schema error(s), ${validation.lint_errors.length} lint error(s)`,
      schema_errors: validation.schema_errors,
      lint_errors: validation.lint_errors,
      partial_schematic: filled,
      run_log: result.runLogPath,
    };
  }

  return {
    success: true,
    schematic: filled as unknown as ContentSchematic,
    changes,
    run_log: result.runLogPath,
  };
}
