import yaml from "js-yaml";
import {
  DesignSpec,
  SpecBlock,
  SpecSection,
  collectBindings,
  isContentParticle,
} from "./design-spec.js";

/**
 * Phase 3 — turn an approved, id-stamped Design Spec into design YAML for
 * gantry_design{action:"compile"}.
 *
 * NO LLM. Every decision this stage could make was settled at Gate 1; all that
 * remains is a mechanical translation, and a model here would only introduce
 * variance into something that must be byte-stable across re-runs.
 *
 * The compiler (apps/gantry-mcp/lib/design-compiler.js) expects:
 *   top_container.sections[]   — top / navigation / slideshow / header
 *   sections[]                 — free-standing: above, feature, showcase, utility
 *   main_container             — sidebar / mainbar / aside
 *   extra_sections[]           — expanded, extension, bottom
 *   footer_container           — footer / copyright
 *   offcanvas
 * and injects Base Outline inheritance stubs for any of navigation / bottom /
 * footer / copyright / offcanvas the design does not name.
 */

/** Sections the compiler inherits from the Base Outline unless overridden.
 *  House rule: these look the same site-wide, so a homepage build leaves them
 *  alone and lets the stub injection handle them. */
const ALWAYS_INHERITED = new Set(["navigation", "bottom", "footer", "copyright", "offcanvas"]);

const TOP_CONTAINER_SECTIONS = new Set(["top", "navigation", "slideshow", "header"]);
const MAIN_CONTAINER_SECTIONS = new Set(["sidebar", "mainbar", "aside"]);
const FOOTER_CONTAINER_SECTIONS = new Set(["footer", "copyright"]);
const EXTRA_SECTIONS = new Set(["expanded", "extension", "bottom"]);

export interface DeriveResult {
  design_yaml: string;
  design: Record<string, unknown>;
  warnings: string[];
  /** Bindings that resolved to a real id, for the caller's report. */
  bound: Array<{ role: string; kind: string; id: number; section: string }>;
}

export class DeriveError extends Error {}

/**
 * Build the particle attributes for a block, merging in order:
 *   1. the binding (article/category filter) — the contract, written first
 *   2. sensible per-particle defaults
 *   3. the spec's explicit `overrides` — last word, so a spec can always win
 */
function attributesFor(block: SpecBlock, sectionId: string): Record<string, unknown> {
  const binding = block.content_binding;
  let attrs: Record<string, unknown> = {};

  if (block.particle === "contentarray") {
    if (!binding) {
      throw new DeriveError(
        `section '${sectionId}': contentarray has no content_binding — the spec should not have passed validation`
      );
    }
    if (!binding.existing_id) {
      throw new DeriveError(
        `section '${sectionId}': binding '${binding.role}' has no id. Run build_content_substrate before deriving.`
      );
    }
    const isCategory = binding.kind === "category";
    attrs = {
      article: {
        filter: {
          // One or the other, never both — enforced by the validator, honoured here.
          categories: isCategory ? String(binding.existing_id) : "",
          articles: isCategory ? "" : String(binding.existing_id),
          featured: "include",
        },
        limit: {
          total: isCategory ? "4" : "1",
          columns: "1",
          start: "0",
        },
        display: {
          pagination_buttons: "",
          // "" hides the title. "hide" does NOT — the compiler rejects "hide"
          // outright, so never "correct" this.
          title: { enabled: "" },
        },
        sort: { orderby: "ordering", ordering: "ASC" },
      },
    };
    // A category feed is a list of articles people click through to.
    if (isCategory) {
      (attrs.article as any).display.read_more = { enabled: "show" };
    }
  } else if (block.particle === "swiper") {
    if (!binding?.existing_id) {
      throw new DeriveError(
        `section '${sectionId}': swiper binding '${binding?.role ?? "?"}' has no id. Run build_content_substrate before deriving.`
      );
    }
    attrs = {
      source: "joomla",
      image: "img",
      height: "36vw",
      heightMobile: "56vw",
      nav: "enabled",
      pagination: "bullets",
      autoplay: "enabled",
      autoplayTimeout: "8000",
      loop: "enabled",
      speed: "800",
      // Clickable hero slides are opt-in. A spec that wants them says so.
      slides_linkable: "disabled",
      touchmove: "enabled",
      direction: "horizontal",
      effect: "slide",
      items: [],
      article: {
        filter: {
          categories: binding.kind === "category" ? String(binding.existing_id) : "",
          articles: binding.kind === "article" ? String(binding.existing_id) : "",
          featured: "include",
        },
        limit: { total: "10", columns: "1", start: "0" },
        sort: { orderby: "ordering", ordering: "ASC" },
      },
    };
  } else if (block.particle === "blockcontent") {
    attrs = {
      source: "manual",
      subcontents: (block.subcontents ?? []).map((item) => ({
        name: item.name,
        button: item.name,
        buttonlink: item.buttonlink,
        buttontarget: item.buttontarget ?? "",
        buttonclass: item.buttonclass ?? "",
        icon: item.icon ?? "",
        img: item.img ?? "",
        description: item.description ?? "",
      })),
    };
  } else if (block.particle === "custom") {
    attrs = { html: block.html ?? "", enabled: 1 };
  }

  // The spec always gets the last word.
  return deepMerge(attrs, (block.overrides ?? {}) as Record<string, unknown>);
}

/** Merge `b` over `a`, recursing into plain objects. Arrays replace wholesale —
 *  a spec that lists subcontents means those items, not those plus defaults. */
export function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      prev && typeof prev === "object" && !Array.isArray(prev)
    ) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function blockToYaml(block: SpecBlock, sectionId: string): Record<string, unknown> {
  const node: Record<string, unknown> = {
    size: block.size,
    particle: block.particle,
  };
  if (block.block_class) node.blockClass = block.block_class;
  if (block.title) node.title = block.title;
  const attrs = attributesFor(block, sectionId);
  if (Object.keys(attrs).length) node.attributes = attrs;
  return node;
}

function sectionToYaml(section: SpecSection): Record<string, unknown> {
  const node: Record<string, unknown> = {
    id: section.id,
    type: "section",
    grids: [{ blocks: section.blocks.map((b) => blockToYaml(b, section.id)) }],
  };
  const cls = (section.attributes as Record<string, unknown> | undefined)?.class;
  if (cls) node.attributes = { class: String(cls) };
  return node;
}

export function deriveDesignYaml(spec: DesignSpec): DeriveResult {
  const warnings: string[] = [];

  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    throw new DeriveError("spec has no sections");
  }

  // Refuse to derive from an unresolved spec. This is the guard that keeps the
  // substrate-before-layout order honest: without it a build can compile a
  // layout whose particles point at nothing.
  const unresolved = collectBindings(spec).filter((b) => !b.binding.existing_id);
  if (unresolved.length) {
    throw new DeriveError(
      `${unresolved.length} binding(s) have no Joomla id (${unresolved
        .map((b) => b.binding.role)
        .join(", ")}). Run build_content_substrate first — layout must never precede substrate.`
    );
  }

  const topSections: Record<string, unknown>[] = [];
  const freeSections: Record<string, unknown>[] = [];
  const extraSections: Record<string, unknown>[] = [];
  const mainGroups: Record<string, Record<string, unknown>> = {};
  const footerSections: Record<string, unknown>[] = [];

  for (const section of spec.sections) {
    const id = String(section.id);

    if (ALWAYS_INHERITED.has(id) && !FOOTER_CONTAINER_SECTIONS.has(id)) {
      warnings.push(
        `section '${id}' normally inherits from the Base Outline and looks the same site-wide. Building it here overrides that for this outline only.`
      );
    }

    const compiled = sectionToYaml(section);

    if (TOP_CONTAINER_SECTIONS.has(id)) {
      topSections.push(compiled);
    } else if (MAIN_CONTAINER_SECTIONS.has(id)) {
      // compileSectionGroup reads `grids`, not `particles` — emitting the wrong
      // key compiles the group to an EMPTY section with no error anywhere.
      // `size` is the group's width inside container-main (sidebar/mainbar/aside
      // split), which is separate from the block sizes inside it.
      mainGroups[id] = {
        section_id: id,
        type: "section",
        size: section.blocks.reduce((n, b) => n + b.size, 0) || 100,
        grids: [{ blocks: section.blocks.map((b) => blockToYaml(b, id)) }],
      };
    } else if (FOOTER_CONTAINER_SECTIONS.has(id)) {
      footerSections.push(compiled);
    } else if (EXTRA_SECTIONS.has(id)) {
      extraSections.push(compiled);
    } else {
      freeSections.push(compiled);
    }
  }

  const design: Record<string, unknown> = {};
  if (topSections.length) design.top_container = { sections: topSections };
  if (freeSections.length) design.sections = freeSections;
  if (Object.keys(mainGroups).length) {
    design.main_container = { layout: "sidebar-main-aside", ...mainGroups };
  }
  if (extraSections.length) design.extra_sections = extraSections;
  if (footerSections.length) design.footer_container = { sections: footerSections };

  // Keep the Base Outline stubs. A homepage build that dropped them would
  // silently lose inherited navigation and footer.
  design.preserve_base_inheritance = true;

  const bound = collectBindings(spec).map(({ binding, section }) => ({
    role: binding.role,
    kind: binding.kind,
    id: binding.existing_id as number,
    section: String(section.id),
  }));

  return {
    design,
    design_yaml: yaml.dump(design, { lineWidth: 100, noRefs: true }),
    warnings,
    bound,
  };
}
