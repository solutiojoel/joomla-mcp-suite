import { z } from "zod";
import { loadSubAgentConfig } from "../config.js";
import { connectDownstreams } from "../bridge.js";
import { runSubAgent, SubAgentEvent } from "../runtime.js";

export interface MenuBuilderArgs {
  site_url: string;
  /** The full, approved Menu Spec JSON — open_questions resolved, joomla_ids.menu_map populated. */
  spec: Record<string, unknown>;
  /** Workspace filename to persist the updated spec to. Defaults to the site slug's spec filename. */
  spec_filename?: string;
  /** Gantry outline ID applied to every created menu item unless the spec item sets its own. */
  default_template_style_id?: string;
  /** Identity (email) of the triggering user — resolved to their personal Claude token. */
  triggered_by?: string;
}

export interface MenuBuilderResult {
  success: boolean;
  joomla_ids?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  build_notes?: string[];
  error?: string;
  partial?: unknown;
  run_log?: string;
}

/**
 * Run the menu-builder sub-agent.
 *
 * Phase 4 of the menu build: takes an approved Menu Spec JSON (all
 * interpretation decisions and open_questions already resolved by a human)
 * and mechanically creates the Joomla categories, placeholder articles, and
 * menu items it describes, in a separate context window via the Claude Agent
 * SDK (operator subscription auth — no API key). Model is set in
 * config/agents/menu-builder/menu-builder.json (Sonnet): Phase 4 is
 * execution against a spec, but Sonnet holds idempotent search-then-create
 * discipline and recovers from mid-build errors more reliably than Haiku.
 */
export async function runMenuBuilder(
  args: MenuBuilderArgs,
  sendProgress: (progress: number, total: number) => Promise<void>,
  onEvent?: (event: SubAgentEvent) => void
): Promise<MenuBuilderResult> {
  const { site_url, spec, default_template_style_id } = args;

  if (!site_url) {
    return { success: false, error: "site_url is required" };
  }
  if (!spec || typeof spec !== "object") {
    return { success: false, error: "spec is required (the approved Menu Spec JSON)" };
  }

  // Load config (system prompt + model + tool allow list + downstreams)
  const config = await loadSubAgentConfig("menu-builder");

  // Connect to the declared downstreams (joomla-mcp). The bridge enforces the
  // allow-list at execution time, so the sub-agent can only reach the 5
  // joomla tools wired below, and site_url is injected automatically.
  const { executor } = await connectDownstreams(config.downstreams, site_url, config.allow);

  // Wrap the bridge executor as an in-process MCP server for the Agent SDK.
  const { tool, createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");

  function wrap(name: string, description: string, schema: Record<string, z.ZodTypeAny>) {
    return tool(name, description, schema, async (input: Record<string, unknown>) => {
      const result = await executor(name, input);
      return {
        content: [
          {
            type: "text" as const,
            text: typeof result === "string" ? result : JSON.stringify(result),
          },
        ],
      };
    });
  }

  const optStr = () => z.string().optional();
  const optNum = () => z.number().optional();
  const optRec = () => z.record(z.string(), z.string()).optional();

  const joomlaCategory = wrap(
    "joomla_category",
    "Manage Joomla categories. action: list|get|create|update|delete|checkin.",
    {
      action: z.enum(["list", "get", "create", "update", "delete", "checkin"]),
      id: optStr(),
      title: optStr(),
      alias: optStr(),
      parentId: optStr(),
      description: optStr(),
      published: optStr(),
      extension: optStr(),
      ordering: optStr(),
      search: optStr(),
      limit: optNum(),
      page: optNum(),
      expectedTitle: optStr(),
    }
  );

  const joomlaArticle = wrap(
    "joomla_article",
    "Manage articles. action: list|get|create|update|delete|checkin.",
    {
      action: z.enum(["list", "get", "create", "update", "delete", "checkin"]),
      id: optStr(),
      title: optStr(),
      alias: optStr(),
      categoryId: optStr(),
      content: optStr(),
      state: optStr(),
      access: optStr(),
      ordering: optStr(),
      introImage: optStr(),
      introImageAlt: optStr(),
      featuredImage: optStr(),
      featuredImageAlt: optStr(),
      search: optStr(),
      category_id: optStr(),
      limit: optNum(),
      page: optNum(),
      expectedTitle: optStr(),
    }
  );

  const joomlaMenuItem = wrap(
    "joomla_menu_item",
    "Manage menu items. action: list|get|create|update|delete|toggle|checkin.",
    {
      action: z.enum(["list", "get", "create", "update", "delete", "toggle", "checkin"]),
      id: optStr(),
      menuId: optStr(),
      search: optStr(),
      limit: optNum(),
      page: optNum(),
      title: optStr(),
      menuType: optStr(),
      itemType: optStr(),
      alias: optStr(),
      link: optStr(),
      parentId: optStr(),
      published: optStr(),
      access: optStr(),
      language: optStr(),
      browserNav: optStr(),
      home: optStr(),
      note: optStr(),
      templateStyleId: optStr(),
      ordering: optStr(),
      request: optRec(),
      params: optRec(),
      fieldOverrides: optRec(),
      state: optStr(),
      expectedTitle: optStr(),
      expectedMenuType: optStr(),
    }
  );

  const joomlaMenuItemType = wrap(
    "joomla_menu_item_type",
    "Discover available menu item types. action: list|inspect.",
    {
      action: z.enum(["list", "inspect"]),
      itemType: optStr(),
    }
  );

  const workspaceWrite = wrap(
    "joomla_workspace_write",
    "Persist a file to the active site's workspace. Use it to save the updated Menu Spec JSON with populated joomla_ids.",
    {
      path: z.string().describe("Workspace filename (no directories), e.g. {site-slug}-menu-spec.json"),
      content: z.string().describe("Full file content (the updated Menu Spec JSON)"),
    }
  );

  const joomlaServer = createSdkMcpServer({
    name: "joomla",
    tools: [joomlaCategory, joomlaArticle, joomlaMenuItem, joomlaMenuItemType, workspaceWrite],
  });

  const today = new Date().toISOString().slice(0, 10);
  const slug = new URL(site_url).hostname.replace(/^www\./, "").split(".")[0];
  const specFilename = args.spec_filename || `${slug}-menu-spec.json`;

  const promptLines = [
    `Build the Joomla menu skeleton (Phase 4) for site: ${site_url}`,
    `Today's date: ${today}`,
    `Workspace spec filename: ${specFilename}`,
    default_template_style_id
      ? `Default Gantry template style ID for new menu items: ${default_template_style_id}`
      : "No default template style ID given — leave templateStyleId unset unless a spec item specifies one.",
    "",
    "--- APPROVED MENU SPEC JSON START ---",
    JSON.stringify(spec),
    "--- APPROVED MENU SPEC JSON END ---",
    "",
    "This spec is already schema/lint validated and every open_questions entry has been resolved by a human.",
    "Follow the build procedure in your system prompt exactly.",
    "1. Build categories, articles, and menu items per the procedure.",
    "2. Persist the updated spec (joomla_ids populated) via joomla_workspace_write using the workspace filename above.",
    "3. Return ONLY the final build report JSON as your closing text response (no prose, no code fences).",
  ];

  const result = await runSubAgent({
    agentName: "menu-builder",
    triggeredBy: args.triggered_by,
    systemPrompt: config.instructions,
    userMessage: promptLines.join("\n"),
    mcpServers: { joomla: joomlaServer },
    allowedTools: [
      "mcp__joomla__joomla_category",
      "mcp__joomla__joomla_article",
      "mcp__joomla__joomla_menu_item",
      "mcp__joomla__joomla_menu_item_type",
      "mcp__joomla__joomla_workspace_write",
    ],
    builtinTools: [],
    model: config.model,
    // A full Phase 4 build can be dozens of items × (search + create) calls.
    maxTurns: 200,
    onIteration: async (current, max) => {
      await sendProgress(current, max);
    },
    onEvent,
  });

  if (!result.success) {
    return { success: false, error: result.error, run_log: result.runLogPath };
  }

  const rawResult = result.result;
  let report: Record<string, unknown> | null = null;

  if (typeof rawResult === "object" && rawResult !== null) {
    report = rawResult as Record<string, unknown>;
  } else if (typeof rawResult === "string") {
    try {
      report = JSON.parse(rawResult);
    } catch {
      return {
        success: false,
        error: "Sub-agent returned non-JSON final response",
        partial: rawResult,
        run_log: result.runLogPath,
      };
    }
  }

  if (!report) {
    return { success: false, error: "Sub-agent returned an empty result", run_log: result.runLogPath };
  }

  if (report.success === false) {
    return {
      success: false,
      error: typeof report.error === "string" ? report.error : "Build failed",
      joomla_ids: report.joomla_ids as Record<string, unknown> | undefined,
      build_notes: report.build_notes as string[] | undefined,
      partial: report,
      run_log: result.runLogPath,
    };
  }

  return {
    success: true,
    joomla_ids: report.joomla_ids as Record<string, unknown> | undefined,
    summary: report.summary as Record<string, unknown> | undefined,
    build_notes: report.build_notes as string[] | undefined,
    run_log: result.runLogPath,
  };
}
