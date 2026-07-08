import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runServer } from "@solutio/mcp-transport";
import { createLogger } from "@solutio/logging";
import { runMenuInterpreter } from "./agents/menu-interpreter.js";
import { runMenuBuilder } from "./agents/menu-builder.js";
import { runContentInterpreter } from "./agents/content-interpreter.js";
import { deriveContentSchematic, ContentSchematic } from "./schematic.js";
import { validateSchematic } from "./schematic-validator.js";
import { connectDownstreams } from "./bridge.js";

const TOOLS = [
  {
    name: "agent_ping",
    description:
      "Phase-0 transport spike. Sleeps 90 seconds, emitting a progress notification every 10s, then returns { ok: true }. Used to validate that the orchestrator timeout + resetTimeoutOnProgress config works before any real sub-agent logic is built.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_menu_interpretation",
    description:
      "Phase 1–2 of the menu build workflow: interprets a menu document and produces a validated Menu Spec JSON. " +
      "Runs the menu-interpreter sub-agent in a separate context window (Claude Agent SDK on the operator's subscription). " +
      "It applies the Phase 1 classification rules, self-checks the 8 lint invariants, persists the spec to the workspace " +
      "via joomla_workspace_write, and the result is re-validated (JSON schema + lint) before being returned. " +
      "Provide either pdf_path (preferred — the sub-agent reads the PDF itself, keeping it out of your context) or menu_text. " +
      "Returns { success: true, spec, run_log } or { success: false, error, schema_errors?, lint_errors?, partial_spec?, run_log }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: {
          type: "string",
          description: "The active site URL (e.g. https://example.com). Used to persist the spec to the correct workspace.",
        },
        pdf_path: {
          type: "string",
          description: "Absolute path to the menu PDF on this host (e.g. C:\\Users\\...\\Church-Menu.pdf). The sub-agent reads it directly.",
        },
        menu_text: {
          type: "string",
          description: "Raw text of the menu document, if already extracted. Include all headings, page names, and sub-items. Ignored when pdf_path is set.",
        },
        source_filename: {
          type: "string",
          description: "Original filename of the source document (e.g. \"Church-Menu.pdf\"). Used as the spec's source field. Defaults to the pdf_path basename.",
        },
      },
    },
  },
  {
    name: "run_menu_build",
    description:
      "Phase 4 of the menu build workflow: mechanically builds the Joomla skeleton (categories, placeholder articles, menu items) from an already-approved Menu Spec JSON. " +
      "Runs the menu-builder sub-agent in a separate context window (Claude Agent SDK, Haiku — Phase 4 is execution against a spec, not interpretation). " +
      "Requires 'joomla_ids.menu_map' in the spec, mapping each spec.menus key (e.g. mainmenu, hiddenmenu) to the real Joomla menuType slug created during the Pre-Phase-4 confirmation — " +
      "the sub-agent never creates menus itself. " +
      "It is idempotent (searches before creating), skips items it can't safely build (TBD targets, docman), persists the updated spec with joomla_ids populated via joomla_workspace_write, " +
      "and never creates the grid particle module for a category_grid item — those are listed in build_notes for manual follow-up per kb/grid-layout. " +
      "Returns { success: true, joomla_ids, summary, build_notes, run_log } or { success: false, error, joomla_ids?, build_notes?, partial?, run_log }.",
    inputSchema: {
      type: "object",
      required: ["site_url", "spec"],
      properties: {
        site_url: {
          type: "string",
          description: "The active site URL (e.g. https://example.com).",
        },
        spec: {
          type: "object",
          description: "The full, approved Menu Spec JSON — schema/lint validated, open_questions resolved, and joomla_ids.menu_map populated with the real menuType slugs from the Pre-Phase-4 confirmation.",
        },
        spec_filename: {
          type: "string",
          description: "Workspace filename to persist the updated spec to (e.g. \"example-menu-spec.json\"). Defaults to the site hostname slug's spec filename.",
        },
        default_template_style_id: {
          type: "string",
          description: "Gantry outline (template style) ID applied to every created menu item unless a spec item sets its own templateStyleId.",
        },
      },
    },
  },
  {
    name: "derive_content_schematic",
    description:
      "Deterministically derive (or re-derive/merge) the Content Schematic from a Menu Spec — no LLM involved. " +
      "One entry per content-bearing spec node (single articles, grid landings, grid members, category landings, docman); " +
      "merging preserves all interpreter/human-filled content fields, adds 'todo' entries for new spec nodes, and marks removed nodes 'orphaned'. " +
      "THIS IS THE SYNC MECHANISM: run it after ANY edit to the menu spec once a schematic exists, and again after run_menu_build completes " +
      "(stamps joomla_article_ids from the spec's joomla_ids). Persists the schematic to the site workspace via joomla_workspace_write. " +
      "Returns { success, schematic, changes: { added, updated, orphaned }, validation }.",
    inputSchema: {
      type: "object",
      required: ["site_url", "spec"],
      properties: {
        site_url: {
          type: "string",
          description: "The active site URL (e.g. https://example.com).",
        },
        spec: {
          type: "object",
          description: "The approved Menu Spec JSON to derive the schematic from (post-Phase-3; pass the post-Phase-4 spec to stamp article IDs).",
        },
        schematic: {
          type: "object",
          description: "The existing Content Schematic to merge into, when re-deriving. Omit for the first derivation.",
        },
        schematic_filename: {
          type: "string",
          description: "Workspace filename to persist to. Defaults to {site-slug}-content-schematic.json.",
        },
      },
    },
  },
  {
    name: "run_content_interpretation",
    description:
      "Phase 3.5 of the menu build workflow: fills the Content Schematic's content fields from the client menu/content PDF — the same document run_menu_interpretation started from. " +
      "Runs the content-interpreter sub-agent in a separate context window (Claude Agent SDK on the operator's subscription). " +
      "The scaffold is derived deterministically from the approved spec first, so structure always matches the skeleton; the sub-agent only enriches entries " +
      "(instructions, source URLs, verbatim copy, assets, features) and can never add/remove/rekey them — the harness hard-fails on any node-key mismatch. " +
      "Call this after Pre-Phase-4 approval; it can run in parallel with run_menu_build. Re-derive with derive_content_schematic after Phase 4 to stamp article IDs. " +
      "Returns { success: true, schematic, changes, run_log } or { success: false, error, schema_errors?, lint_errors?, structure_errors?, partial_schematic?, run_log }.",
    inputSchema: {
      type: "object",
      required: ["site_url", "pdf_path", "spec"],
      properties: {
        site_url: {
          type: "string",
          description: "The active site URL (e.g. https://example.com).",
        },
        pdf_path: {
          type: "string",
          description: "Absolute path to the client menu/content PDF on this host. The sub-agent reads it directly.",
        },
        spec: {
          type: "object",
          description: "The full, approved Menu Spec JSON (post-Phase-3 — structure frozen).",
        },
        schematic: {
          type: "object",
          description: "Existing Content Schematic to merge into before interpreting (preserves already-filled content on re-runs). Omit for the first run.",
        },
        schematic_filename: {
          type: "string",
          description: "Workspace filename to persist to. Defaults to {site-slug}-content-schematic.json.",
        },
        source_filename: {
          type: "string",
          description: "Original filename of the source PDF, recorded as the schematic's source field. Defaults to the pdf_path basename.",
        },
      },
    },
  },
];

function buildServer(): Server {
  const server = new Server(
    { name: "agents-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  console.error(`[buildServer] registering ${TOOLS.length} tools`);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error(`[ListToolsRequestSchema] handler called`);
    const result = { tools: TOOLS };
    console.error(`[ListToolsRequestSchema] returning`, JSON.stringify(result));
    return result;
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, _meta } = request.params;
    const progressToken = _meta?.progressToken;

    const sendProgress = async (progress: number, total: number) => {
      if (progressToken === undefined) return;
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total },
      });
    };

    switch (name) {
      case "agent_ping": {
        const TOTAL_SECS = 90;
        const INTERVAL_SECS = 10;
        const steps = TOTAL_SECS / INTERVAL_SECS;

        console.error(`[agent_ping] starting 90s sleep (${steps} intervals)`);
        for (let i = 0; i < steps; i++) {
          await new Promise<void>((res) => setTimeout(res, INTERVAL_SECS * 1000));
          console.error(`[agent_ping] step ${i + 1}/${steps}`);
          await sendProgress((i + 1) * INTERVAL_SECS, TOTAL_SECS);
        }
        console.error("[agent_ping] done");

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }],
        };
      }

      case "run_menu_interpretation": {
        console.error(`[run_menu_interpretation] starting`);
        let iterCount = 0;
        const result = await runMenuInterpreter(
          {
            site_url: request.params.arguments?.site_url as string,
            menu_text: request.params.arguments?.menu_text as string | undefined,
            pdf_path: request.params.arguments?.pdf_path as string | undefined,
            source_filename: request.params.arguments?.source_filename as string | undefined,
          },
          async (progress, total) => {
            iterCount = progress;
            console.error(`[run_menu_interpretation] iteration ${progress}/${total}`);
            await sendProgress(progress, total);
          }
        );
        console.error(`[run_menu_interpretation] done after ${iterCount} iterations, success=${result.success}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      }

      case "run_menu_build": {
        console.error(`[run_menu_build] starting`);
        let iterCount = 0;
        const result = await runMenuBuilder(
          {
            site_url: request.params.arguments?.site_url as string,
            spec: request.params.arguments?.spec as Record<string, unknown>,
            spec_filename: request.params.arguments?.spec_filename as string | undefined,
            default_template_style_id: request.params.arguments?.default_template_style_id as string | undefined,
          },
          async (progress, total) => {
            iterCount = progress;
            console.error(`[run_menu_build] iteration ${progress}/${total}`);
            await sendProgress(progress, total);
          }
        );
        console.error(`[run_menu_build] done after ${iterCount} iterations, success=${result.success}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      }

      case "derive_content_schematic": {
        console.error(`[derive_content_schematic] starting`);
        const site_url = request.params.arguments?.site_url as string;
        const spec = request.params.arguments?.spec as Record<string, unknown>;
        const existing = request.params.arguments?.schematic as ContentSchematic | undefined;

        const fail = (error: string) => ({
          content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
          isError: true,
        });
        if (!site_url) return fail("site_url is required");
        if (!spec || typeof spec !== "object") return fail("spec is required (the Menu Spec JSON)");

        const slug = new URL(site_url).hostname.replace(/^www\./, "").split(".")[0];
        const schematicFilename =
          (request.params.arguments?.schematic_filename as string | undefined) ||
          `${slug}-content-schematic.json`;

        const { schematic, changes } = deriveContentSchematic(spec, existing ?? null, {
          menu_spec_file: `${slug}-menu-spec.json`,
        });
        const validation = validateSchematic(
          schematic as unknown as Record<string, unknown>,
          spec
        );

        // Persist to the site workspace through the same bridge the sub-agents use.
        try {
          const { executor } = await connectDownstreams(["joomla-mcp"], site_url, [
            "joomla_workspace_write",
          ]);
          await executor("joomla_workspace_write", {
            path: schematicFilename,
            content: JSON.stringify(schematic, null, 2),
          });
        } catch (err: unknown) {
          return fail(
            `Derived OK but failed to persist to workspace: ${err instanceof Error ? err.message : err}`
          );
        }

        console.error(
          `[derive_content_schematic] done: ${schematic.entries.length} entries (+${changes.added.length} ~${changes.updated.length} -${changes.orphaned.length}), valid=${validation.valid}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: validation.valid,
                schematic,
                changes,
                validation,
                schematic_filename: schematicFilename,
              }),
            },
          ],
          isError: !validation.valid,
        };
      }

      case "run_content_interpretation": {
        console.error(`[run_content_interpretation] starting`);
        let iterCount = 0;
        const result = await runContentInterpreter(
          {
            site_url: request.params.arguments?.site_url as string,
            pdf_path: request.params.arguments?.pdf_path as string,
            spec: request.params.arguments?.spec as Record<string, unknown>,
            schematic: request.params.arguments?.schematic as ContentSchematic | undefined,
            schematic_filename: request.params.arguments?.schematic_filename as string | undefined,
            source_filename: request.params.arguments?.source_filename as string | undefined,
          },
          async (progress, total) => {
            iterCount = progress;
            console.error(`[run_content_interpretation] iteration ${progress}/${total}`);
            await sendProgress(progress, total);
          }
        );
        console.error(`[run_content_interpretation] done after ${iterCount} iterations, success=${result.success}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          isError: !result.success,
        };
      }

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  return server;
}

runServer({
  buildServer,
  logger: createLogger("agents-mcp"),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
