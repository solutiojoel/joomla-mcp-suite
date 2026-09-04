import "./env.js";
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
import { runContentWriter } from "./agents/content-writer.js";
import { deriveContentSchematic, ContentSchematic } from "./schematic.js";
import { validateSchematic } from "./schematic-validator.js";
import { fetchSourceContent, discoverSourceUrls } from "./content-fetch.js";
import { applyContent, ApplyReport } from "./content-apply.js";
import { connectDownstreams } from "./bridge.js";
import { runDesignInterpreter } from "./agents/design-interpreter.js";
import { runCssAuthor } from "./agents/css-author.js";
import { validateDesignSpec } from "./design-spec-validator.js";
import { buildSubstrate } from "./substrate.js";
import { deriveDesignYaml, DeriveError } from "./derive-design-yaml.js";
import { verifyBuild, Defect } from "./verify-build.js";
import { surveySite } from "./site-survey.js";
import { DesignSpec } from "./design-spec.js";

function siteSlug(siteUrl: string): string {
  return new URL(siteUrl).hostname.replace(/^www\./, "").split(".")[0];
}

function statusSummary(schematic: ContentSchematic): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of schematic.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return counts;
}

/** Bridge + schematic loader shared by the content-build tools. The schematic
 *  can stay server-side: when the caller doesn't pass one, it is read from the
 *  site workspace — the main session only ever sees manifests. */
async function contentBuildContext(siteUrl: string, schematicFilename?: string, passed?: unknown) {
  const slug = siteSlug(siteUrl);
  const filename = schematicFilename || `${slug}-content-schematic.json`;
  const { executor } = await connectDownstreams(["joomla-mcp"], siteUrl, [
    "joomla_workspace_read",
    "joomla_workspace_write",
    "joomla_article",
  ]);

  let schematic: ContentSchematic;
  if (passed && typeof passed === "object") {
    schematic = passed as ContentSchematic;
  } else {
    const loaded = await executor("joomla_workspace_read", { path: filename });
    if (typeof loaded === "string") {
      throw new Error(`workspace file '${filename}' is not valid schematic JSON`);
    }
    schematic = loaded as ContentSchematic;
  }
  if (!Array.isArray(schematic.entries)) {
    throw new Error(`schematic '${filename}' has no entries array`);
  }

  const persist = () =>
    executor("joomla_workspace_write", {
      path: filename,
      content: JSON.stringify(schematic, null, 2),
    });

  return { slug, filename, executor, schematic, persist };
}

/** Bridge + Design Spec loader shared by the site-build tools. Mirrors
 *  contentBuildContext: the spec stays server-side, so the calling session sees
 *  reports rather than the whole document. */
async function siteBuildContext(siteUrl: string, specFilename?: string, passed?: unknown) {
  const slug = siteSlug(siteUrl);
  const filename = specFilename || `${slug}-design-spec.json`;
  const { executor } = await connectDownstreams(["joomla-mcp"], siteUrl, [
    "joomla_workspace_read",
    "joomla_workspace_write",
    "joomla_article",
    "joomla_category",
    "joomla_inspect_frontend",
    "joomla_get_frontend_page",
  ]);

  let spec: DesignSpec;
  if (passed && typeof passed === "object") {
    spec = passed as DesignSpec;
  } else {
    const loaded = await executor("joomla_workspace_read", { path: filename });
    if (typeof loaded === "string") {
      try {
        spec = JSON.parse(loaded) as DesignSpec;
      } catch {
        throw new Error(`workspace file '${filename}' is not valid Design Spec JSON`);
      }
    } else {
      spec = loaded as DesignSpec;
    }
  }
  if (!Array.isArray(spec?.sections)) {
    throw new Error(`Design Spec '${filename}' has no sections array`);
  }

  const persist = () =>
    executor("joomla_workspace_write", {
      path: filename,
      content: JSON.stringify(spec, null, 2),
    });

  return { slug, filename, executor, spec, persist };
}

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
      "Runs the menu-builder sub-agent in a separate context window (Claude Agent SDK, Sonnet — Phase 4 is execution against a spec; Sonnet holds idempotent search-then-create discipline and recovers from mid-build errors). " +
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
  {
    name: "discover_source_urls",
    description:
      "Content-build Phase 2 helper: deterministically proposes source URLs for schematic entries that need one (content_source pull/existing without a real URL) — no LLM involved. " +
      "Fetches the OLD site's sitemap.xml (falling back to homepage links) and fuzzy-matches entry titles against URL slugs and link text. " +
      "Proposals are candidates for the human to confirm — NEVER write them into the schematic without confirmation. " +
      "Reads the schematic from the site workspace unless one is passed. " +
      "Returns { success, proposals: [{ node_key, title, candidates: [{ url, score, matched }] }], source, pages_scanned }.",
    inputSchema: {
      type: "object",
      required: ["site_url", "base_url"],
      properties: {
        site_url: { type: "string", description: "The active (new) site URL — locates the workspace schematic." },
        base_url: { type: "string", description: "The OLD site's base URL to scan for existing content (e.g. https://www.oldparishsite.org)." },
        schematic: { type: "object", description: "Content Schematic to match against. Omit to load {slug}-content-schematic.json from the workspace." },
        schematic_filename: { type: "string", description: "Workspace schematic filename override." },
        max_candidates: { type: "number", description: "Max candidate URLs per entry. Default 3." },
      },
    },
  },
  {
    name: "fetch_source_content",
    description:
      "Content-build Phase 3: deterministically fetches every eligible entry's old-site page (content_source pull/existing, status filled, http source_url), " +
      "extracts the main content with Readability, converts it to markdown with Turndown, and saves it to the workspace as {slug}-source/{nn}-{title}.md — no LLM involved, raw HTML never enters a context window. " +
      "Stamps source_file on each entry, records page image URLs in assets, flips failed fetches to needs_input with an open question, and persists the schematic. " +
      "Reads the schematic from the site workspace unless one is passed; returns only the manifest (not the schematic). " +
      "Returns { success, report: { fetched, failed, skipped }, status_summary, schematic_filename }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL (e.g. https://example.com)." },
        schematic: { type: "object", description: "Content Schematic to operate on. Omit to load {slug}-content-schematic.json from the workspace." },
        schematic_filename: { type: "string", description: "Workspace schematic filename override." },
        refetch: { type: "boolean", description: "Re-fetch entries that already have a source_file. Default false." },
      },
    },
  },
  {
    name: "run_content_build",
    description:
      "Content-build Phase 4: writes final Joomla article HTML for every writable entry and (by default) auto-applies it to the skeleton after each batch. " +
      "Writable = status 'filled' with a fetched source_file or client copy, or content_source 'generate' with instructions (drafted and flagged draft: true for review). " +
      "Runs the content-writer sub-agent (Sonnet) per batch of ~8 entries in a fresh context window — page content flows through workspace files, never through your context. " +
      "The harness validates every claimed file and stamps content_file/draft/status 'written'; the deterministic apply stage then updates each Joomla article (status 'done'), " +
      "REFUSING to overwrite an article that already has real content unless force is set. Idempotent: re-runs pick up where the statuses left off. " +
      "Reads the schematic from the site workspace unless one is passed; returns manifests only. " +
      "Returns { success, write: { batches, written, failed, not_writable, drafts }, apply: { applied, skipped, failed }, status_summary }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL (e.g. https://example.com)." },
        schematic: { type: "object", description: "Content Schematic to operate on. Omit to load {slug}-content-schematic.json from the workspace." },
        schematic_filename: { type: "string", description: "Workspace schematic filename override." },
        batch_size: { type: "number", description: "Entries per content-writer run. Default 8." },
        node_keys: { type: "array", items: { type: "string" }, description: "Explicit subset of node_keys to write (also unlocks re-writing 'written' entries)." },
        apply: { type: "boolean", description: "Auto-apply each batch to Joomla after writing. Default true." },
        force: { type: "boolean", description: "Apply even over articles that already have real content. Default false." },
        dry_run: { type: "boolean", description: "Report the batch plan (and apply plan) without running the writer or touching Joomla." },
      },
    },
  },
  {
    name: "apply_content",
    description:
      "Standalone deterministic apply stage (also runs automatically inside run_content_build): pushes each 'written' entry's HTML file into its Joomla article — no LLM involved. " +
      "Resolves the article by stamped joomla_article_id (title-lookup fallback, '{title} (landing)' for grid landings), verifies the article title matches, " +
      "and refuses to overwrite real (non-placeholder) content unless force is set. Success → status 'done' + applied_at; failures stay 'written' for a re-run. " +
      "Use dry_run first to see the full plan; use node_keys+force to re-apply specific pages. " +
      "Reads the schematic from the site workspace unless one is passed. " +
      "Returns { success, report: { applied, would_apply, skipped, failed }, status_summary }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL (e.g. https://example.com)." },
        schematic: { type: "object", description: "Content Schematic to operate on. Omit to load {slug}-content-schematic.json from the workspace." },
        schematic_filename: { type: "string", description: "Workspace schematic filename override." },
        node_keys: { type: "array", items: { type: "string" }, description: "Explicit subset to apply (also unlocks re-applying 'done' entries)." },
        force: { type: "boolean", description: "Overwrite articles that already have real content. Default false." },
        dry_run: { type: "boolean", description: "Report the plan without updating Joomla." },
      },
    },
  },

  // ─── site build ────────────────────────────────────────────────────────────
  // Seven tools, two of which use a model. Reading a visual reference and
  // writing CSS need judgement; everything else is deterministic on purpose, so
  // a build repeats exactly and a rule cannot be forgotten.
  {
    name: "survey_site",
    description:
      "Phase 0 of the site build: survey the Joomla install BEFORE anything is designed. Deterministic — no LLM. " +
      "Answers the three questions a build cannot start safely without: (1) is this a NEW build or a REDESIGN — a redesign shares its install with a live site, so the substrate rules change completely; (2) what content is already prepared, since menu-build and content-build usually run first and most bindings should resolve to rows that already exist; (3) what is genuinely missing and must be created. " +
      "Infers the build type from category/article counts, category nesting, presence of the fleet skeleton, and the theme (a legacy template is a strong redesign signal), and reports the evidence so you can overrule it. On a redesign it also locates the redesign parent category and flags which roles match LIVE content that will be copied rather than bound to. " +
      "Run this before run_design_interpretation, and put its findings in front of the Gate 1 review. " +
      "Returns { success, report: { build_type, confidence, signals, counts, redesign_root, prepared, missing, will_copy, warnings } }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL." },
        build_type: { type: "string", enum: ["new", "redesign"], description: "Overrule the inference. The operator usually knows; the survey reports a warning if this disagrees with what the install looks like." },
        redesign_root: { type: "string", description: "Redesign only: the parent category title, when you know it. Omitted, the survey infers it from the category tree — the name varies per build (Redesign, New Site, STM 2026...) and is never defaulted." },
        redesign_root_id: { type: "number", description: "Redesign only: the parent category id, when a previous survey already resolved it. Beats every other signal." },
        site_notes: { type: "string", description: "Site notes text from get_site_notes. Pass it and the resolver can use a parent category name recorded there." },
        theme: { type: "string", description: "Theme in use, if known. A template outside the current fleet set is a strong redesign signal and means fleet block classes have no CSS." },
      },
    },
  },
  {
    name: "validate_design_spec",
    description:
      "Deterministic Design Spec validation — no LLM. Checks structure plus the semantic invariants from workflows/site-build: every content-bearing block declares a content_binding, no client-editable copy sits in a particle attribute, no embed hides in a custom particle, a contentarray binds a category OR an article (never both), every blockcontent item has a non-empty buttonlink, roles are unique, section ids are real and in stack order, and (after Phase 2) every binding carries a Joomla id. " +
      "Call it after any hand edit to the spec and before deriving YAML. " +
      "Returns { success, validation: { valid, errors, warnings, substrate_resolved, counts } }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL." },
        spec: { type: "object", description: "The Design Spec. Omit to load {slug}-design-spec.json from the workspace." },
        spec_filename: { type: "string", description: "Workspace spec filename override." },
      },
    },
  },
  {
    name: "run_design_interpretation",
    description:
      "Phase 1 of the site build: reads a visual reference and produces a validated Design Spec JSON. Runs the design-interpreter sub-agent in a separate context window (Claude Agent SDK on the operator's subscription), so the mockup and the pattern catalogue never enter the caller's context. " +
      "Run survey_site first and pass its build_type through — a redesign spec that omits it is rejected by the validator. " +
      "Accepts a local file (mockup image, PDF, Figma export, or Claude Design .dc.html export), a reference_url, or a written brief — markup inputs give the highest fidelity because structure is read from the DOM rather than inferred. " +
      "The spec is persisted to the workspace and validated before it is returned; a spec that breaks the content-binding contract is rejected. " +
      "Returns { success, spec, spec_filename, warnings } or { success: false, error, errors, partial_spec }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL." },
        reference_path: { type: "string", description: "Absolute path on this host to a mockup image, PDF, or design export. The sub-agent reads it directly." },
        reference_url: { type: "string", description: "A live page to reproduce, when there is no local file." },
        brief: { type: "string", description: "A written brief, when there is no visual reference at all." },
        site_type: { type: "string", description: "parish | school | cemetery. Selects the pattern set. Default parish." },
        build_type: { type: "string", enum: ["new", "redesign"], description: "From survey_site. The spec must carry it, and the substrate stage behaves differently for each. Default new." },
        redesign_root: { type: "string", description: "Redesign only: the parent category everything nests under. Default Redesign." },
        target_outline: { type: "string", description: 'Outline to build, e.g. "#Home". Default "#Home".' },
        theme: { type: "string", description: "Site theme. Default rt_studius; a different theme means fleet block classes have no CSS behind them." },
        spec_filename: { type: "string", description: "Workspace spec filename override." },
      },
    },
  },
  {
    name: "build_content_substrate",
    description:
      "Phase 2 of the site build: creates the Joomla categories and shell articles the approved spec's content bindings require, then stamps the real ids back into the spec. Deterministic — no LLM. " +
      "This is the stage that makes the finished homepage maintainable: after it runs, every content-bearing section points at a row the client can open in the article manager. Run it BEFORE any layout work. " +
      "Idempotent: searches by exact title before creating, so a re-run creates nothing. It never updates an existing article's body, never deletes or unpublishes, and reports an ambiguous title match as an error rather than guessing. " +
      "Returns { success, report: { created, would_create, reused, errors, substrate_resolved }, spec_filename }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL." },
        spec: { type: "object", description: "The approved Design Spec. Omit to load {slug}-design-spec.json from the workspace." },
        spec_filename: { type: "string", description: "Workspace spec filename override." },
        dry_run: { type: "boolean", description: "Report what would be created without writing to Joomla." },
      },
    },
  },
  {
    name: "derive_design_yaml",
    description:
      "Phase 3 of the site build: turns an approved, id-stamped Design Spec into design YAML for gantry_design{action:\"compile\"}. Deterministic — no LLM, and byte-stable across re-runs. " +
      "Refuses to derive while any binding lacks a Joomla id, which is what keeps the substrate-before-layout order honest. Maps sections into the compiler's containers (top_container / sections / main_container / extra_sections / footer_container) and preserves Base Outline inheritance for navigation, bottom, footer, copyright and offcanvas. " +
      "Pass the result to gantry_design validate, then compile with dryRun, then compile. " +
      "Returns { success, design_yaml, warnings, bound }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL." },
        spec: { type: "object", description: "The approved Design Spec. Omit to load it from the workspace." },
        spec_filename: { type: "string", description: "Workspace spec filename override." },
        yaml_filename: { type: "string", description: "Also persist the YAML to this workspace file." },
      },
    },
  },
  {
    name: "verify_build",
    description:
      "Phase 5 of the site build: structural verification of an applied outline. Deterministic — no LLM and no screenshots. " +
      "Catches every defect class that blocks a ship: binding violations (editable copy baked into a particle), content_missing (a binding resolving to nothing, an unpublished shell, or copy still on placeholder), unstyled_block (a block class whose ruleCount is 0 on this theme, which is what makes raw Joomla bylines leak through), layout_drift (rendered column widths against the spec fingerprint), broken_asset (empty hrefs, missing image src), and residual_outline (mainbar/aside left inherited). " +
      "Defects come back ranked by severity with a suggested_owner naming who fixes each one. Feed the css-author-owned subset to run_css_authoring. " +
      "Returns { success, report: { verdict, checked, defects, blockers } }.",
    inputSchema: {
      type: "object",
      required: ["site_url"],
      properties: {
        site_url: { type: "string", description: "The active site URL." },
        spec: { type: "object", description: "The Design Spec the build came from. Omit to load it from the workspace." },
        spec_filename: { type: "string", description: "Workspace spec filename override." },
        page_path: { type: "string", description: "Frontend path to verify. Default '/'." },
        skip_frontend: { type: "boolean", description: "Check the spec and bound content only; skip live page inspection." },
      },
    },
  },
  {
    name: "run_css_authoring",
    description:
      "Phase 5 of the site build: turns verify_build's css-author-owned defects into override.css rules, written against the real rendered DOM. Runs the css-author sub-agent in a separate context window, so joomla_inspect_frontend output never reaches the caller. " +
      "It appends to the existing CSS rather than rewriting it, and skips defects that CSS is the wrong tool for, naming what would fix them instead. The CSS lands in the workspace; the caller uploads it with ftp_upload_file. " +
      "Returns { success, css_filename, css, rules_added, addressed, skipped }.",
    inputSchema: {
      type: "object",
      required: ["site_url", "defects"],
      properties: {
        site_url: { type: "string", description: "The active site URL." },
        defects: { type: "array", items: { type: "object" }, description: "Defect array from verify_build. Only suggested_owner 'css-author' entries are acted on." },
        page_path: { type: "string", description: "Frontend path. Default '/'." },
        existing_css: { type: "string", description: "Current override.css contents, so the sub-agent appends rather than rewrites." },
        css_filename: { type: "string", description: "Workspace CSS filename override." },
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
            triggered_by: request.params.arguments?.triggered_by as string | undefined,
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
            triggered_by: request.params.arguments?.triggered_by as string | undefined,
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
            triggered_by: request.params.arguments?.triggered_by as string | undefined,
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

      case "discover_source_urls": {
        console.error(`[discover_source_urls] starting`);
        const site_url = request.params.arguments?.site_url as string;
        const base_url = request.params.arguments?.base_url as string;
        try {
          if (!site_url) throw new Error("site_url is required");
          if (!base_url) throw new Error("base_url is required (the OLD site to scan)");
          const ctx = await contentBuildContext(
            site_url,
            request.params.arguments?.schematic_filename as string | undefined,
            request.params.arguments?.schematic
          );
          const result = await discoverSourceUrls(ctx.schematic, base_url, {
            maxCandidates: request.params.arguments?.max_candidates as number | undefined,
          });
          console.error(
            `[discover_source_urls] done: ${result.proposals.length} proposals from ${result.pages_scanned} ${result.source} pages`
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: true, ...result }) }],
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      case "fetch_source_content": {
        console.error(`[fetch_source_content] starting`);
        const site_url = request.params.arguments?.site_url as string;
        try {
          if (!site_url) throw new Error("site_url is required");
          const ctx = await contentBuildContext(
            site_url,
            request.params.arguments?.schematic_filename as string | undefined,
            request.params.arguments?.schematic
          );
          let count = 0;
          const report = await fetchSourceContent(ctx.schematic, {
            slug: ctx.slug,
            refetch: request.params.arguments?.refetch === true,
            writeWorkspaceFile: async (path, content) => {
              await ctx.executor("joomla_workspace_write", { path, content });
              count++;
              await sendProgress(count, count + 1);
            },
          });
          await ctx.persist();
          console.error(
            `[fetch_source_content] done: ${report.fetched.length} fetched, ${report.failed.length} failed, ${report.skipped.length} skipped`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: report.failed.length === 0,
                  report,
                  status_summary: statusSummary(ctx.schematic),
                  schematic_filename: ctx.filename,
                }),
              },
            ],
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      case "run_content_build": {
        console.error(`[run_content_build] starting`);
        const site_url = request.params.arguments?.site_url as string;
        const doApply = request.params.arguments?.apply !== false;
        const force = request.params.arguments?.force === true;
        const dry_run = request.params.arguments?.dry_run === true;
        try {
          if (!site_url) throw new Error("site_url is required");
          const ctx = await contentBuildContext(
            site_url,
            request.params.arguments?.schematic_filename as string | undefined,
            request.params.arguments?.schematic
          );

          const applyReports: ApplyReport[] = [];
          const writeResult = await runContentWriter(
            {
              site_url,
              schematic: ctx.schematic,
              schematic_filename: ctx.filename,
              batch_size: request.params.arguments?.batch_size as number | undefined,
              node_keys: request.params.arguments?.node_keys as string[] | undefined,
              dry_run,
              triggered_by: request.params.arguments?.triggered_by as string | undefined,
            },
            sendProgress,
            (event) => {
              if (event.type === "tool_use") {
                console.error(`[run_content_build] writer tool: ${event.toolName}`);
              }
            },
            doApply && !dry_run
              ? async (writtenKeys, batch, total) => {
                  if (writtenKeys.length === 0) return;
                  console.error(`[run_content_build] applying batch ${batch}/${total} (${writtenKeys.length} entries)`);
                  applyReports.push(
                    await applyContent(ctx.schematic, {
                      executor: ctx.executor,
                      schematic_filename: ctx.filename,
                      node_keys: writtenKeys,
                      force,
                    })
                  );
                }
              : undefined
          );

          const apply: ApplyReport = { applied: [], would_apply: [], skipped: [], failed: [] };
          for (const r of applyReports) {
            apply.applied.push(...r.applied);
            apply.would_apply.push(...r.would_apply);
            apply.skipped.push(...r.skipped);
            apply.failed.push(...r.failed);
          }

          const success = writeResult.success && apply.failed.length === 0;
          console.error(
            `[run_content_build] done: ${writeResult.written.length} written, ${apply.applied.length} applied, ${writeResult.failed.length + apply.failed.length} failed, ${writeResult.drafts.length} drafts`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success,
                  error: writeResult.error,
                  write: {
                    batches: writeResult.batches,
                    written: writeResult.written,
                    failed: writeResult.failed,
                    not_attempted: writeResult.not_attempted,
                    not_writable: writeResult.not_writable,
                    drafts: writeResult.drafts,
                  },
                  apply: doApply ? apply : "skipped (apply: false)",
                  status_summary: statusSummary(ctx.schematic),
                  schematic_filename: ctx.filename,
                }),
              },
            ],
            isError: !success,
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      case "apply_content": {
        console.error(`[apply_content] starting`);
        const site_url = request.params.arguments?.site_url as string;
        try {
          if (!site_url) throw new Error("site_url is required");
          const ctx = await contentBuildContext(
            site_url,
            request.params.arguments?.schematic_filename as string | undefined,
            request.params.arguments?.schematic
          );
          const report = await applyContent(ctx.schematic, {
            executor: ctx.executor,
            schematic_filename: ctx.filename,
            node_keys: request.params.arguments?.node_keys as string[] | undefined,
            force: request.params.arguments?.force === true,
            dry_run: request.params.arguments?.dry_run === true,
          });
          console.error(
            `[apply_content] done: ${report.applied.length} applied, ${report.would_apply.length} planned, ${report.skipped.length} skipped, ${report.failed.length} failed`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: report.failed.length === 0,
                  report,
                  status_summary: statusSummary(ctx.schematic),
                  schematic_filename: ctx.filename,
                }),
              },
            ],
            isError: report.failed.length > 0,
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      // ─── site build ──────────────────────────────────────────────────────
      case "survey_site": {
        console.error(`[survey_site] starting`);
        const site_url = request.params.arguments?.site_url as string;
        try {
          if (!site_url) throw new Error("site_url is required");
          const { executor } = await connectDownstreams(["joomla-mcp"], site_url, [
            "joomla_category",
            "joomla_article",
          ]);
          const report = await surveySite({
            executor,
            build_type: request.params.arguments?.build_type as "new" | "redesign" | undefined,
            redesign_root: request.params.arguments?.redesign_root as string | undefined,
            redesign_root_id: request.params.arguments?.redesign_root_id as number | undefined,
            site_notes: request.params.arguments?.site_notes as string | undefined,
            theme: request.params.arguments?.theme as string | undefined,
          });
          console.error(
            `[survey_site] done: ${report.build_type} (${report.confidence}), ${report.prepared.length} prepared, ${report.missing.length} missing, ${report.will_copy.length} to copy`
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: true, report }) }],
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      case "validate_design_spec": {
        console.error(`[validate_design_spec] starting`);
        const site_url = request.params.arguments?.site_url as string;
        try {
          if (!site_url) throw new Error("site_url is required");
          const ctx = await siteBuildContext(
            site_url,
            request.params.arguments?.spec_filename as string | undefined,
            request.params.arguments?.spec
          );
          const validation = validateDesignSpec(ctx.spec);
          console.error(
            `[validate_design_spec] done: valid=${validation.valid}, ${validation.errors.length} error(s), ${validation.warnings.length} warning(s)`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: validation.valid,
                  validation,
                  spec_filename: ctx.filename,
                }),
              },
            ],
            isError: !validation.valid,
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      case "run_design_interpretation": {
        console.error(`[run_design_interpretation] starting`);
        try {
          const site_url = request.params.arguments?.site_url as string;
          if (!site_url) throw new Error("site_url is required");
          const result = await runDesignInterpreter(
            request.params.arguments as any,
            sendProgress,
            undefined
          );
          console.error(`[run_design_interpretation] done: success=${result.success}`);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            isError: !result.success,
          };
        } catch (err: unknown) {
          // A downstream being unreachable, or a bad site_url, throws out of the
          // runner. Return the same envelope shape as every other tool rather
          // than an opaque transport error.
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[run_design_interpretation] failed: ${error}`);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      case "build_content_substrate": {
        console.error(`[build_content_substrate] starting`);
        const site_url = request.params.arguments?.site_url as string;
        try {
          if (!site_url) throw new Error("site_url is required");
          const ctx = await siteBuildContext(
            site_url,
            request.params.arguments?.spec_filename as string | undefined,
            request.params.arguments?.spec
          );
          const dry_run = request.params.arguments?.dry_run === true;
          const report = await buildSubstrate({
            executor: ctx.executor,
            spec: ctx.spec,
            dry_run,
          });
          // The spec now carries real ids — persist it, or Phase 3 cannot run.
          if (!dry_run) await ctx.persist();
          console.error(
            `[build_content_substrate] done: ${report.created.length} created, ${report.reused.length} reused, ${report.errors.length} error(s), resolved=${report.substrate_resolved}`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: report.errors.length === 0,
                  report,
                  spec_filename: ctx.filename,
                }),
              },
            ],
            isError: report.errors.length > 0,
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      case "derive_design_yaml": {
        console.error(`[derive_design_yaml] starting`);
        const site_url = request.params.arguments?.site_url as string;
        try {
          if (!site_url) throw new Error("site_url is required");
          const ctx = await siteBuildContext(
            site_url,
            request.params.arguments?.spec_filename as string | undefined,
            request.params.arguments?.spec
          );

          // Never derive from a spec that would not pass the gate.
          const validation = validateDesignSpec(ctx.spec);
          if (!validation.valid) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    success: false,
                    error: `Design Spec is invalid — fix it before deriving (${validation.errors.length} error(s))`,
                    validation,
                    spec_filename: ctx.filename,
                  }),
                },
              ],
              isError: true,
            };
          }

          const derived = deriveDesignYaml(ctx.spec);
          const yamlFilename = request.params.arguments?.yaml_filename as string | undefined;
          if (yamlFilename) {
            await ctx.executor("joomla_workspace_write", {
              path: yamlFilename,
              content: derived.design_yaml,
            });
          }
          console.error(
            `[derive_design_yaml] done: ${derived.bound.length} binding(s), ${derived.warnings.length} warning(s)`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: true,
                  design_yaml: derived.design_yaml,
                  warnings: derived.warnings,
                  bound: derived.bound,
                  spec_filename: ctx.filename,
                  yaml_filename: yamlFilename,
                }),
              },
            ],
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: false,
                  error,
                  hint:
                    err instanceof DeriveError
                      ? "Run build_content_substrate before deriving — layout must never precede substrate."
                      : undefined,
                }),
              },
            ],
            isError: true,
          };
        }
      }

      case "verify_build": {
        console.error(`[verify_build] starting`);
        const site_url = request.params.arguments?.site_url as string;
        try {
          if (!site_url) throw new Error("site_url is required");
          const ctx = await siteBuildContext(
            site_url,
            request.params.arguments?.spec_filename as string | undefined,
            request.params.arguments?.spec
          );
          const report = await verifyBuild({
            executor: ctx.executor,
            spec: ctx.spec,
            page_path: (request.params.arguments?.page_path as string) || "/",
            skip_frontend: request.params.arguments?.skip_frontend === true,
          });
          console.error(
            `[verify_build] done: ${report.verdict}, ${report.defects.length} defect(s), ${report.blockers} blocker(s)`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  success: report.blockers === 0,
                  report,
                  spec_filename: ctx.filename,
                }),
              },
            ],
            // Only blockers fail the call — a major defect is a to-do, not an error.
            isError: report.blockers > 0,
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
      }

      case "run_css_authoring": {
        console.error(`[run_css_authoring] starting`);
        try {
          const site_url = request.params.arguments?.site_url as string;
          if (!site_url) throw new Error("site_url is required");
          const defects = request.params.arguments?.defects;
          if (!Array.isArray(defects)) {
            throw new Error("defects must be an array — pass verify_build's report.defects");
          }
          const result = await runCssAuthor(
            {
              site_url,
              page_path: request.params.arguments?.page_path as string | undefined,
              defects: defects as Defect[],
              existing_css: request.params.arguments?.existing_css as string | undefined,
              css_filename: request.params.arguments?.css_filename as string | undefined,
            },
            sendProgress,
            undefined
          );
          console.error(
            `[run_css_authoring] done: success=${result.success}, ${result.rules_added ?? 0} rule(s)`
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            isError: !result.success,
          };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[run_css_authoring] failed: ${error}`);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }) }],
            isError: true,
          };
        }
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
  serverInfo: { name: "agents-mcp", version: "0.1.0" },
  logger: createLogger("agents-mcp"),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
