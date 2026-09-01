import {
  DesignSpec,
  collectBindings,
  isContentParticle,
  customHoldsClientContent,
} from "./design-spec.js";

/**
 * Phase 5a — structural build verification.
 *
 * NO LLM. The draft handed the whole QA pass to a vision sub-agent; working
 * through the defect taxonomy showed that the defects that actually block a
 * ship are all decidable from data:
 *
 *   binding_violation  — read the spec and the live layout
 *   content_missing    — read the bound article/category
 *   unstyled_block     — joomla_inspect_frontend reports ruleCount
 *   broken_asset       — the rendered page lists its links and images
 *
 * Even layout drift turned out to be arithmetic: the spec states the column
 * split it measured off the reference, and the rendered blocks report their own
 * widths. So there is no vision stage at all — this is cheaper, repeatable, and
 * cannot hallucinate a defect or miss one out of inattention. A screenshot is
 * still worth a human glance for polish; nothing here depends on one.
 */

export type Executor = (name: string, args: Record<string, any>) => Promise<any>;

/**
 * There is deliberately no `content_wrong` kind. "The wrong article rendered"
 * is not decidable here: the spec's binding IS the definition of right, so if
 * the binding names article 44 and article 44 renders, that is correct by
 * construction. A wrong binding is caught by a human at Gate 1, not by this
 * stage — declaring a kind nothing can emit would promise a check that does
 * not exist.
 */
export type DefectKind =
  | "binding_violation"
  | "content_missing"
  | "unstyled_block"
  | "layout_drift"
  | "broken_asset"
  | "residual_outline";

export type Severity = "blocker" | "major" | "minor";

export interface Defect {
  id: string;
  severity: Severity;
  kind: DefectKind;
  section: string;
  selector?: string;
  observed: string;
  expected: string;
  evidence?: Record<string, unknown>;
  suggested_owner: "spec" | "substrate" | "css-author" | "human";
}

export interface VerifyReport {
  verdict: "clean" | "defects_found";
  checked: {
    bindings: number;
    block_classes: number;
    page_fetched: boolean;
  };
  defects: Defect[];
  /** Blocker count, surfaced separately because it gates the ship decision. */
  blockers: number;
}

interface JoomlaResult {
  success?: boolean;
  message?: string;
  data?: any;
}

async function callSafe(
  executor: Executor,
  name: string,
  args: Record<string, any>
): Promise<JoomlaResult> {
  try {
    const res = await executor(name, args);
    if (typeof res === "object" && res !== null) return res as JoomlaResult;
    return { success: true, message: typeof res === "string" ? res : undefined };
  } catch (err: unknown) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Visible text length, markup and entities removed. Mirrors the same helper in
 *  content-apply.ts — a shell article that never got real content reads as a
 *  handful of placeholder characters. */
export function visibleLength(html: string | undefined): number {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, "")
    .length;
}

const PLACEHOLDER_RE = /content to be added|lorem ipsum|placeholder|coming soon|tbd/i;

export function isStillPlaceholder(html: string | undefined): boolean {
  const s = String(html ?? "");
  if (visibleLength(s) < 25) return true;
  return PLACEHOLDER_RE.test(s) && visibleLength(s) < 200;
}

export interface VerifyOptions {
  executor: Executor;
  spec: DesignSpec;
  page_path?: string;
  /** Skip the frontend fetch (useful in tests and when the site is unreachable). */
  skip_frontend?: boolean;
}

export async function verifyBuild(opts: VerifyOptions): Promise<VerifyReport> {
  const { executor, spec, page_path = "/", skip_frontend = false } = opts;
  const defects: Defect[] = [];
  let n = 0;
  const add = (d: Omit<Defect, "id">) => defects.push({ id: `d${++n}`, ...d });

  const bindings = collectBindings(spec);

  // ── 1. binding_violation — the contract, checked against the spec ─────────
  for (const section of spec.sections ?? []) {
    for (const block of section.blocks ?? []) {
      if (isContentParticle(block.particle) && !block.content_binding) {
        add({
          severity: "blocker",
          kind: "binding_violation",
          section: String(section.id),
          selector: block.block_class,
          observed: `a '${block.particle}' renders with no content_binding`,
          expected: "every content-bearing particle points at an article or category by id",
          suggested_owner: "spec",
        });
      }
      if (block.particle === "custom") {
        // Same predicate the validator uses. Two definitions of "is this client
        // content" would let a spec pass one gate and fail the other.
        const check = customHoldsClientContent(block.html);
        if (check.violation) {
          add({
            severity: "blocker",
            kind: "binding_violation",
            section: String(section.id),
            selector: block.block_class,
            observed: `custom particle ${check.reason}`,
            expected: "client-editable copy lives in an article, rendered through contentarray",
            suggested_owner: "spec",
          });
        }
      }
    }
  }

  // ── 2. content_missing — read what each binding actually resolves to ──────
  for (const { binding, section } of bindings) {
    if (!binding.existing_id) {
      add({
        severity: "blocker",
        kind: "content_missing",
        section: String(section.id),
        observed: `binding '${binding.role}' has no Joomla id`,
        expected: "build_content_substrate resolves every binding before layout",
        suggested_owner: "substrate",
      });
      continue;
    }

    if (binding.kind === "article") {
      const res = await callSafe(executor, "joomla_article", {
        action: "get",
        id: String(binding.existing_id),
      });
      const article = res?.data;
      if (!res.success || !article) {
        add({
          severity: "blocker",
          kind: "content_missing",
          section: String(section.id),
          observed: `article ${binding.existing_id} ('${binding.role}') could not be read: ${res.message ?? "not found"}`,
          expected: "the bound article exists and is readable",
          suggested_owner: "substrate",
          evidence: { article_id: binding.existing_id },
        });
        continue;
      }
      if (String(article.state) === "0" || String(article.state) === "-2") {
        add({
          severity: "blocker",
          kind: "content_missing",
          section: String(section.id),
          observed: `article ${binding.existing_id} ('${binding.role}') is not published (state ${article.state})`,
          expected: "bound articles are published, or the section renders empty",
          suggested_owner: "substrate",
          evidence: { article_id: binding.existing_id, state: article.state },
        });
      } else if (isStillPlaceholder(article.content ?? article.introtext)) {
        add({
          severity: "major",
          kind: "content_missing",
          section: String(section.id),
          observed: `article ${binding.existing_id} ('${binding.role}') still holds placeholder copy`,
          expected: "real client content before launch — fine mid-build, not at handoff",
          suggested_owner: "human",
          evidence: { article_id: binding.existing_id },
        });
      }
    } else {
      const res = await callSafe(executor, "joomla_article", {
        action: "list",
        category_id: String(binding.existing_id),
      });
      const items = Array.isArray(res?.data)
        ? res.data
        : Array.isArray(res?.data?.items)
          ? res.data.items
          : [];
      if (!items.length) {
        add({
          severity: "blocker",
          kind: "content_missing",
          section: String(section.id),
          observed: `category ${binding.existing_id} ('${binding.role}') contains no articles`,
          expected: "a category feed needs at least one article, or the section renders empty",
          suggested_owner: "substrate",
          evidence: { category_id: binding.existing_id },
        });
      }
    }
  }

  // ── 3. unstyled_block — a block class with no CSS on this theme ───────────
  const blockClasses = new Set<string>();
  for (const section of spec.sections ?? []) {
    for (const block of section.blocks ?? []) {
      for (const cls of String(block.block_class ?? "").split(/\s+/).filter(Boolean)) {
        blockClasses.add(cls);
      }
    }
  }

  let pageFetched = false;
  if (!skip_frontend) {
    for (const cls of blockClasses) {
      const res = await callSafe(executor, "joomla_inspect_frontend", {
        path: page_path,
        selector: `.${cls}`,
        include: ["css"],
        cssFor: `.${cls}`,
      });
      const ruleCount = Number(
        res?.data?.ruleCount ?? res?.data?.css?.ruleCount ?? res?.data?.matches?.length ?? NaN
      );
      if (Number.isFinite(ruleCount) && ruleCount === 0) {
        add({
          severity: "major",
          kind: "unstyled_block",
          section: "(page)",
          selector: `.${cls}`,
          observed: `block class '${cls}' matches no CSS rule on this site's theme`,
          expected:
            "the class carries the intended card/banner styling; ruleCount 0 means raw Joomla chrome renders instead",
          evidence: { ruleCount: 0 },
          suggested_owner: "css-author",
        });
      }
    }

    // ── 4. layout_drift — rendered column widths vs. the spec fingerprint ───
    // This was the last defect class the draft assigned to a vision model. It
    // is arithmetic: the spec states the split it measured off the reference,
    // and the rendered blocks report their own widths.
    for (const section of spec.sections ?? []) {
      const fp = parseFingerprintLocal(section.fingerprint);
      if (!fp || fp.length < 2) continue;

      const res = await callSafe(executor, "joomla_inspect_frontend", {
        path: page_path,
        selector: `#g-${section.id} > .g-container > .g-grid > .g-block`,
        include: ["box"],
        depth: 1,
      });
      const widths = extractWidths(res?.data);
      if (widths.length !== fp.length) continue; // structure differs; other checks cover it

      const total = widths.reduce((a, b) => a + b, 0);
      if (total <= 0) continue;
      const actual = widths.map((w) => (w / total) * 100);

      for (let i = 0; i < fp.length; i++) {
        const drift = Math.abs(actual[i] - fp[i]);
        // 6 points of slack absorbs gaps, padding, and sub-pixel rounding.
        if (drift > 6) {
          add({
            severity: "major",
            kind: "layout_drift",
            section: String(section.id),
            selector: `#g-${section.id} .g-block:nth-child(${i + 1})`,
            observed: `column ${i + 1} renders at ${actual[i].toFixed(1)}% of the row`,
            expected: `${fp[i]}% per the spec fingerprint '${section.fingerprint}'`,
            evidence: { rendered: actual.map((n) => Number(n.toFixed(1))), fingerprint: fp },
            suggested_owner: "css-author",
          });
          break; // one drift report per section is enough to act on
        }
      }
    }

    // ── 5. broken_asset — empty links and missing images on the live page ───
    const page = await callSafe(executor, "joomla_get_frontend_page", { path: page_path });
    if (page.success && page.data) {
      pageFetched = true;
      const links: any[] = Array.isArray(page.data.links) ? page.data.links : [];
      const emptyLinks = links.filter((l) => {
        const href = String(l?.href ?? l?.url ?? "").trim();
        return href === "" || href === "#";
      });
      if (emptyLinks.length) {
        add({
          severity: "major",
          kind: "broken_asset",
          section: "(page)",
          observed: `${emptyLinks.length} anchor(s) render with an empty or placeholder href`,
          expected: "every link has a real destination before handoff",
          evidence: {
            count: emptyLinks.length,
            samples: emptyLinks.slice(0, 5).map((l) => l?.text ?? l?.title ?? "(no text)"),
          },
          suggested_owner: "spec",
        });
      }

      const images: any[] = Array.isArray(page.data.images) ? page.data.images : [];
      const brokenImages = images.filter((i) => !String(i?.src ?? "").trim());
      if (brokenImages.length) {
        add({
          severity: "major",
          kind: "broken_asset",
          section: "(page)",
          observed: `${brokenImages.length} image(s) render with no src`,
          expected: "every image resolves",
          evidence: { count: brokenImages.length },
          suggested_owner: "css-author",
        });
      }

      // ── 6. residual_outline — a duplicated content-page outline leaking ──
      const bodyText = String(page.data.bodyText ?? page.data.text ?? "");
      const buildsMain = (spec.sections ?? []).some((s) =>
        ["mainbar", "aside", "container-main"].includes(String(s.id))
      );
      if (!buildsMain && /Written by|Hits:\s*\d+/i.test(bodyText)) {
        add({
          severity: "major",
          kind: "residual_outline",
          section: "mainbar",
          observed: "the page renders article byline or hit-count chrome",
          expected:
            "a homepage outline clears mainbar/aside rather than inheriting the content-page layout",
          suggested_owner: "spec",
        });
      }
    }
  }

  const blockers = defects.filter((d) => d.severity === "blocker").length;
  return {
    verdict: defects.length ? "defects_found" : "clean",
    checked: {
      bindings: bindings.length,
      block_classes: blockClasses.size,
      page_fetched: pageFetched,
    },
    defects: defects.sort((a, b) => rank(a.severity) - rank(b.severity)),
    blockers,
  };
}

function rank(s: Severity): number {
  return s === "blocker" ? 0 : s === "major" ? 1 : 2;
}

/** Local copy so verify-build has no import cycle with the spec module's
 *  parseFingerprint. Same semantics: "70|30" → [70, 30], null when malformed. */
function parseFingerprintLocal(fp: string | undefined): number[] | null {
  if (!fp) return null;
  const parts = fp.split("|").map((p) => Number(p.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return parts;
}

/**
 * Pull rendered block widths out of a joomla_inspect_frontend box response.
 * The tool's shape varies a little by version, so accept the documented nesting
 * and the flat array, and ignore anything without a positive width.
 * Exported for tests.
 */
export function extractWidths(data: any): number[] {
  const nodes: any[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.nodes)
      ? data.nodes
      : Array.isArray(data?.matches)
        ? data.matches
        : Array.isArray(data?.box)
          ? data.box
          : [];
  return nodes
    .map((n) => Number(n?.rect?.width ?? n?.box?.width ?? n?.width ?? NaN))
    .filter((w) => Number.isFinite(w) && w > 0);
}
