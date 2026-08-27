import {
  DesignSpec,
  SpecBlock,
  SECTION_ORDER,
  ALL_PARTICLES,
  isContentParticle,
  isChromeParticle,
  blockcontentMode,
  collectBindings,
  parseFingerprint,
  customHoldsClientContent,
  CUSTOM_PARTICLE,
} from "./design-spec.js";

/**
 * Design Spec validation — structure + the semantic invariants from
 * workflows/site-build §3.
 *
 * This file is the point of the overhaul. The old process kept these rules in
 * a prose checklist an agent was asked to remember; every one of them is a rule
 * a build failed on at least once. Here they are code, so a spec that breaks
 * one cannot reach the compiler.
 *
 * No LLM anywhere in this file.
 */

export interface ValidationIssue {
  rule: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** Set once every binding carries a real id — the Phase 2 exit condition. */
  substrate_resolved: boolean;
  counts: {
    sections: number;
    blocks: number;
    bindings: number;
    unresolved_bindings: number;
    open_questions: number;
  };
}

const ROLE_RE = /^[a-z][a-z0-9_]*$/;

/** Fields that must be present and non-empty at the top level. */
const REQUIRED_TOP = ["site", "site_type", "source", "source_kind", "target_outline"] as const;

export function validateDesignSpec(input: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (rule: string, path: string, message: string) =>
    errors.push({ rule, path, message });
  const warn = (rule: string, path: string, message: string) =>
    warnings.push({ rule, path, message });

  const empty: ValidationResult = {
    valid: false,
    errors,
    warnings,
    substrate_resolved: false,
    counts: { sections: 0, blocks: 0, bindings: 0, unresolved_bindings: 0, open_questions: 0 },
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    err("structure", "$", "spec must be a JSON object");
    return empty;
  }
  const spec = input as DesignSpec;

  // ── structure ──────────────────────────────────────────────────────────────
  for (const field of REQUIRED_TOP) {
    const v = (spec as unknown as Record<string, unknown>)[field];
    if (typeof v !== "string" || !v.trim()) {
      err("structure", `$.${field}`, `missing or empty required field '${field}'`);
    }
  }
  // ── build type: decides the substrate stage's safety rules ────────────────
  if (spec.build_type !== "new" && spec.build_type !== "redesign") {
    err(
      "build-type",
      "$.build_type",
      `build_type must be 'new' or 'redesign' (got ${JSON.stringify(spec.build_type)}). Run survey_site first — a redesign shares its Joomla install with a live site and the substrate rules differ.`
    );
  }
  if (spec.build_type === "redesign") {
    const root = spec.content_scope?.redesign_root;
    if (typeof root !== "string" || !root.trim()) {
      err(
        "build-type",
        "$.content_scope.redesign_root",
        "a redesign must name the parent category everything nests under, or the build can bind to live content"
      );
    }
  }

  if (!Array.isArray(spec.sections) || spec.sections.length === 0) {
    err("structure", "$.sections", "spec needs at least one section");
    return { ...empty, errors, warnings };
  }

  // ── 7. section ids come from the fleet list, in stack order ────────────────
  let lastOrder = -1;
  const seenSections = new Set<string>();
  spec.sections.forEach((section, si) => {
    const at = `sections[${si}]`;
    if (!section || typeof section !== "object") {
      err("structure", at, "section must be an object");
      return;
    }
    if (typeof section.id !== "string" || !section.id.trim()) {
      err("structure", `${at}.id`, "section needs an id");
      return;
    }
    const order = (SECTION_ORDER as readonly string[]).indexOf(section.id);
    if (order === -1) {
      err(
        "section-id",
        `${at}.id`,
        `'${section.id}' is not a Gantry section id. Valid: ${SECTION_ORDER.join(", ")}`
      );
    } else {
      if (order < lastOrder) {
        err(
          "section-order",
          `${at}.id`,
          `'${section.id}' appears after a section that renders below it. Sections must be listed in stack order.`
        );
      }
      lastOrder = Math.max(lastOrder, order);
    }
    if (seenSections.has(section.id)) {
      err("section-id", `${at}.id`, `section '${section.id}' is declared twice`);
    }
    seenSections.add(section.id);

    if (!Array.isArray(section.blocks) || section.blocks.length === 0) {
      err("structure", `${at}.blocks`, `section '${section.id}' has no blocks`);
      return;
    }

    // fingerprint must agree with the block sizes it claims to describe
    const fp = parseFingerprint(section.fingerprint);
    if (section.fingerprint && !fp) {
      err(
        "fingerprint",
        `${at}.fingerprint`,
        `'${section.fingerprint}' is not a valid column split (expected e.g. "100", "70|30", "33|33|33")`
      );
    } else if (fp) {
      if (fp.length !== section.blocks.length) {
        err(
          "fingerprint",
          `${at}.fingerprint`,
          `fingerprint '${section.fingerprint}' describes ${fp.length} column(s) but the section has ${section.blocks.length} block(s)`
        );
      }
      const total = fp.reduce((a, b) => a + b, 0);
      if (total < 95 || total > 105) {
        warn(
          "fingerprint",
          `${at}.fingerprint`,
          `columns total ${total}, not ~100 — check the split measured off the reference`
        );
      }
    }

    section.blocks.forEach((block, bi) => validateBlock(block, `${at}.blocks[${bi}]`, err, warn));
  });

  // ── 6. every role is unique ────────────────────────────────────────────────
  const bindings = collectBindings(spec);
  const byRole = new Map<string, string[]>();
  for (const { binding, path } of bindings) {
    if (typeof binding.role !== "string" || !ROLE_RE.test(binding.role)) {
      err(
        "binding-role",
        `${path}.content_binding.role`,
        `role '${binding.role}' must be a lower_snake_case slug (e.g. mass_times)`
      );
      continue;
    }
    const list = byRole.get(binding.role) ?? [];
    list.push(path);
    byRole.set(binding.role, list);
  }
  for (const [role, paths] of byRole) {
    if (paths.length > 1) {
      err(
        "binding-role",
        paths[1],
        `role '${role}' is used by ${paths.length} blocks (${paths.join(", ")}). Roles identify one content source and must be unique.`
      );
    }
  }

  // ── 8. after the substrate stage, every binding resolves ───────────────────
  const unresolved = bindings.filter(
    (b) => b.binding.existing_id === null || b.binding.existing_id === undefined
  );
  for (const { binding, path } of unresolved) {
    if (!binding.create || !binding.create.title) {
      err(
        "binding-unresolvable",
        `${path}.content_binding`,
        `role '${binding.role}' has no existing_id and no create.title — nothing can resolve it`
      );
    }
  }

  const openQuestions = Array.isArray(spec.open_questions) ? spec.open_questions : [];
  const unanswered = openQuestions.filter((q) => !q.answer);
  if (unanswered.length) {
    warn(
      "open-questions",
      "$.open_questions",
      `${unanswered.length} open question(s) unanswered — resolve these before Gate 1 approval`
    );
  }

  const blockCount = spec.sections.reduce(
    (n, s) => n + (Array.isArray(s.blocks) ? s.blocks.length : 0),
    0
  );

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    substrate_resolved: bindings.length > 0 && unresolved.length === 0,
    counts: {
      sections: spec.sections.length,
      blocks: blockCount,
      bindings: bindings.length,
      unresolved_bindings: unresolved.length,
      open_questions: openQuestions.length,
    },
  };
}

function validateBlock(
  block: SpecBlock,
  at: string,
  err: (r: string, p: string, m: string) => void,
  warn: (r: string, p: string, m: string) => void
): void {
  if (!block || typeof block !== "object") {
    err("structure", at, "block must be an object");
    return;
  }
  if (typeof block.particle !== "string" || !block.particle.trim()) {
    err("structure", `${at}.particle`, "block needs a particle type");
    return;
  }
  if (!(ALL_PARTICLES as readonly string[]).includes(block.particle)) {
    warn(
      "particle-type",
      `${at}.particle`,
      `'${block.particle}' is not a known fleet particle — confirm it exists with gantry_reference{topic:"particles"}`
    );
  }
  if (typeof block.size !== "number" || block.size <= 0 || block.size > 100) {
    err("structure", `${at}.size`, `size must be a number in 1..100 (got ${block.size})`);
  }

  const binding = block.content_binding;

  // ── 1. every content-bearing block has a binding ─────────────────────────
  if (isContentParticle(block.particle)) {
    if (!binding) {
      err(
        "binding-required",
        `${at}.content_binding`,
        `a '${block.particle}' renders client-editable content and must declare a content_binding. This is the contract the build exists to satisfy.`
      );
    } else {
      if (binding.kind !== "article" && binding.kind !== "category") {
        err(
          "binding-kind",
          `${at}.content_binding.kind`,
          `kind must be 'article' or 'category' (got '${binding.kind}')`
        );
      }
      // ── 4. contentarray binds one or the other, never both ───────────────
      const ov = (block.overrides ?? {}) as Record<string, any>;
      const filter = ov?.article?.filter ?? ov?.filter;
      if (filter && typeof filter === "object") {
        const hasCats = !!String(filter.categories ?? "").trim();
        const hasArts = !!String(filter.articles ?? "").trim();
        if (hasCats && hasArts) {
          err(
            "contentarray-filter",
            `${at}.overrides`,
            "sets both filter.categories and filter.articles — a contentarray binds one or the other, never both"
          );
        }
      }
    }
  }

  // ── 2/3. chrome must not carry a binding; custom must not carry content ──
  if (isChromeParticle(block.particle) && binding) {
    warn(
      "binding-on-chrome",
      `${at}.content_binding`,
      `'${block.particle}' is chrome and carries no client content — a binding here is probably a mistake`
    );
  }

  if (block.particle === CUSTOM_PARTICLE) {
    const check = customHoldsClientContent(block.html);
    if (check.violation) {
      err(
        "binding-violation",
        `${at}.html`,
        `custom particle ${check.reason}. A layout the client cannot edit in the article manager is a failed build.`
      );
    }
  }

  // ── 5. blockcontent: one source, and every item has a buttonlink ─────────
  if (block.particle === "blockcontent") {
    const mode = blockcontentMode(block);
    if (mode === "ambiguous") {
      err(
        "blockcontent-source",
        `${at}`,
        "blockcontent has both subcontents and a content_binding — it renders one source and silently drops the other. Use manual items OR a category binding, not both."
      );
    } else if (mode === "empty") {
      err(
        "blockcontent-source",
        `${at}`,
        "blockcontent has neither subcontents nor a content_binding — the block will render nothing. Add manual items, or bind it to a category."
      );
    }

    const items = block.subcontents;
    if (Array.isArray(items) && items.length > 0) {
      items.forEach((item, ii) => {
        if (!item || typeof item !== "object") {
          err("structure", `${at}.subcontents[${ii}]`, "item must be an object");
          return;
        }
        if (!String(item.name ?? "").trim()) {
          err("blockcontent-items", `${at}.subcontents[${ii}].name`, "item needs a name");
        }
        if (!String(item.buttonlink ?? "").trim()) {
          err(
            "blockcontent-buttonlink",
            `${at}.subcontents[${ii}].buttonlink`,
            `item '${item.name ?? ii}' has an empty buttonlink — every item needs a URL, use "#" if the destination is still open and raise it as an open question`
          );
        }
      });
    }
  }

  // swiper: clickable slides are opt-in, never a default
  if (block.particle === "swiper") {
    const linkable = (block.overrides as Record<string, unknown> | undefined)?.slides_linkable;
    if (linkable === "enabled") {
      warn(
        "swiper-linkable",
        `${at}.overrides.slides_linkable`,
        "slides_linkable is enabled — confirm the client asked for clickable hero slides; it is disabled by default"
      );
    }
  }
}
