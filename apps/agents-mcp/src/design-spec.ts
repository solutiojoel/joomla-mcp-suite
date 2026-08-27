/**
 * Design Spec — the durable artifact of a site build.
 *
 * Sits between the visual reference and the live Gantry outline the way the
 * Menu Spec sits between the client PDF and the Joomla skeleton: reviewable,
 * hand-editable, re-runnable.
 *
 * This module holds the types plus the fleet vocabulary the validator and the
 * YAML deriver both key off. No LLM anywhere in this file.
 */

/** Gantry section ids in render order. A spec's sections must appear in this
 *  relative order — the frontend stacks them top to bottom regardless, so a
 *  spec listing them out of order is describing something it cannot build. */
export const SECTION_ORDER = [
  "top",
  "navigation",
  "slideshow",
  "header",
  "above",
  "feature",
  "showcase",
  "utility",
  "container-main",
  "sidebar",
  "mainbar",
  "aside",
  "expanded",
  "extension",
  "bottom",
  "footer",
  "copyright",
  "offcanvas",
] as const;

export type SectionId = (typeof SECTION_ORDER)[number];

/**
 * Particles that render client-editable content. Every block using one of these
 * MUST carry a content_binding — that is the contract the whole pipeline exists
 * to enforce.
 */
export const CONTENT_PARTICLES = ["contentarray", "blockcontent", "swiper"] as const;

/**
 * Chrome. These render navigation, branding, or system output — nothing a
 * client edits in the article manager, so they are exempt from binding.
 */
export const CHROME_PARTICLES = [
  "logo",
  "menu",
  "mobile-menu",
  "system-messages",
  "copyright",
  "spacer",
  "position",
  "module",
  "search",
  "social",
  "horizmenu",
] as const;

/**
 * `custom` is neither. It is legitimate for structural HTML (a section heading,
 * a standalone button, popup scaffolding) and illegitimate for anything a
 * client would want to change. The validator draws that line by inspecting the
 * html, not by trusting the spec.
 */
export const CUSTOM_PARTICLE = "custom";

export const ALL_PARTICLES = [
  ...CONTENT_PARTICLES,
  ...CHROME_PARTICLES,
  CUSTOM_PARTICLE,
  "timeline",
  "video",
] as const;

export type ParticleType = (typeof ALL_PARTICLES)[number];

export function isContentParticle(p: string): boolean {
  return (CONTENT_PARTICLES as readonly string[]).includes(p);
}

export function isChromeParticle(p: string): boolean {
  return (CHROME_PARTICLES as readonly string[]).includes(p);
}

// ─── Spec shape ──────────────────────────────────────────────────────────────

export interface ContentBindingCreate {
  title: string;
  /** Category only: parent category title. Articles use `category`. */
  parent?: string;
  /** Article only: the category this article is created in. */
  category?: string;
  /** Article only: copy read off the reference, as article HTML. */
  seed_content?: string;
}

export interface ContentBinding {
  kind: "article" | "category";
  /** Stable slug naming what this feeds: mass_times, hero_slides, news_feed… */
  role: string;
  /** Null until the substrate stage stamps it. */
  existing_id: number | null;
  /** True when the substrate stage created the row rather than reusing one. */
  created_by_build?: boolean;
  create?: ContentBindingCreate;
}

export interface SubcontentItem {
  name: string;
  buttonlink: string;
  icon?: string;
  img?: string;
  description?: string;
  buttontarget?: string;
  buttonclass?: string;
}

export interface SpecBlock {
  /** Column width within the row, 1-100. Sizes in a row should total ~100. */
  size: number;
  block_class?: string;
  particle: ParticleType | string;
  title?: string;
  content_binding?: ContentBinding;
  /** blockcontent only: the repeater items. */
  subcontents?: SubcontentItem[];
  /** Raw particle attribute overrides merged last by the deriver. */
  overrides?: Record<string, unknown>;
  /** custom only. */
  html?: string;
  notes?: string;
}

export interface SpecSection {
  id: SectionId | string;
  /** Column split, e.g. "100", "70|30", "33|33|33". Must match block sizes. */
  fingerprint?: string;
  /** Name from gantry_reference{topic:"patterns"}, or null when structural. */
  pattern?: string | null;
  reason?: string;
  attributes?: Record<string, unknown>;
  blocks: SpecBlock[];
}

export interface OpenQuestion {
  id: string;
  section?: string;
  question: string;
  why_it_matters?: string;
  /** Filled by the driver once the user answers. */
  answer?: string;
}

export interface DesignSpec {
  site: string;
  site_type: "parish" | "school" | "cemetery" | string;
  source: string;
  source_kind:
    | "mockup_image"
    | "figma_export"
    | "claude_design_export"
    | "reference_url"
    | "brief"
    | string;
  target_outline: string;
  outline_id?: number | null;
  theme?: string;
  generated?: string;
  sections: SpecSection[];
  open_questions?: OpenQuestion[];
  assumptions?: string[];
}

// ─── Helpers shared by the validator and the deriver ─────────────────────────

/** Every binding in the spec, with the path that located it (for error text). */
export function collectBindings(
  spec: DesignSpec
): Array<{ binding: ContentBinding; path: string; block: SpecBlock; section: SpecSection }> {
  const out: Array<{
    binding: ContentBinding;
    path: string;
    block: SpecBlock;
    section: SpecSection;
  }> = [];
  spec.sections?.forEach((section, si) => {
    section.blocks?.forEach((block, bi) => {
      if (block.content_binding) {
        out.push({
          binding: block.content_binding,
          path: `sections[${si}](${section.id}).blocks[${bi}]`,
          block,
          section,
        });
      }
    });
  });
  return out;
}

/** Parse "70|30" → [70, 30]. Returns null for a malformed fingerprint. */
export function parseFingerprint(fp: string | undefined): number[] | null {
  if (!fp) return null;
  const parts = fp.split("|").map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return parts;
}

/**
 * Does this `custom` particle hold something a client would need to edit?
 *
 * Embeds and long prose belong in an article. Short structural markup — a
 * heading, a button, a wrapper div — is what `custom` is legitimately for.
 * Deliberately conservative: it flags what is clearly content, so a false
 * positive is rare and a reviewer can override by moving the copy anyway.
 */
export function customHoldsClientContent(html: string | undefined): {
  violation: boolean;
  reason?: string;
} {
  if (!html) return { violation: false };

  if (/<iframe|<script|data-elfsight|fb-page|instagram-media/i.test(html)) {
    return {
      violation: true,
      reason: "contains an embed (iframe/script/widget) — put it in an article and render it with contentarray",
    };
  }

  // Visible text, markup and entities removed.
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > 200) {
    return {
      violation: true,
      reason: `holds ${text.length} characters of visible prose — copy this long is client content and belongs in an article`,
    };
  }

  // Several paragraphs is prose even when each one is short.
  const paragraphs = (html.match(/<p[\s>]/gi) || []).length;
  if (paragraphs >= 3) {
    return {
      violation: true,
      reason: `holds ${paragraphs} paragraphs — multi-paragraph copy belongs in an article`,
    };
  }

  return { violation: false };
}
