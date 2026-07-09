import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { ContentSchematic, SchematicEntry } from "./schematic.js";

/**
 * Deterministic content fetching — no LLM anywhere in this file.
 *
 * `fetchSourceContent` pulls each entry's old-site page, extracts the main
 * content with Readability (nav/footer/chrome stripped), converts it to
 * markdown with Turndown, and persists it as a workspace file. The markdown is
 * what the content-writer sub-agent later Reads — raw HTML never enters an LLM
 * context window.
 *
 * `discoverSourceUrls` proposes candidate source URLs for entries that need
 * one, by fuzzy-matching entry titles against the old site's sitemap (or
 * homepage nav links). Proposals are presented to the human in Phase 2 of the
 * content-build workflow — never auto-accepted.
 */

export type WorkspaceWriter = (path: string, content: string) => Promise<void>;

export interface FetchReportItem {
  node_key: string;
  title: string;
  source_url?: string;
  source_file?: string;
  outcome: "fetched" | "failed" | "skipped";
  detail?: string;
}

export interface FetchReport {
  fetched: FetchReportItem[];
  failed: FetchReportItem[];
  skipped: FetchReportItem[];
}

export interface FetchOptions {
  /** Site slug used for workspace paths ({slug}-source/...). */
  slug: string;
  /** Persists a file to the site workspace (bridge joomla_workspace_write). */
  writeWorkspaceFile: WorkspaceWriter;
  /** Re-fetch entries that already have a source_file. Default false (skip). */
  refetch?: boolean;
  /** Override the HTTP fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Default 20000. */
  timeoutMs?: number;
  /** Politeness delay between page fetches in ms. Default 1500 — old parish
   *  hosts (eCatholic etc.) 403-block burst traffic. 0 disables. */
  delayMs?: number;
}

// Plain browser UA — WAFs on old parish hosts (eCatholic etc.) flag custom
// UA suffixes and burst traffic; see also the inter-request delay below.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function fetchHtml(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const type = res.headers.get("content-type") ?? "";
    if (type && !/html|xml|text/i.test(type)) {
      throw new Error(`Not an HTML page (content-type: ${type})`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export interface ExtractedPage {
  title?: string;
  markdown: string;
  imageUrls: string[];
}

/** Chrome that must never count as page content. Stripped BEFORE Readability
 *  runs — on nav-heavy small-content sites (most old parish sites) the menu
 *  otherwise outscores the actual page text. */
const CHROME_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
].join(",");

/** Containers to try, best-first, when Readability's pick is still mostly
 *  links (its scoring lost to a menu/sitemap block). */
const CONTENT_SELECTORS = ["main", '[role="main"]', "article", "#content", ".content", "#main"];

/** Share of an element's text that sits inside links. */
function linkDensity(el: { textContent: string | null; querySelectorAll: (s: string) => any }): number {
  const total = (el.textContent ?? "").replace(/\s+/g, " ").trim().length;
  if (total === 0) return 1;
  let linked = 0;
  for (const a of el.querySelectorAll("a")) {
    linked += ((a.textContent as string) ?? "").replace(/\s+/g, " ").trim().length;
  }
  return Math.min(linked / total, 1);
}

/** Main-content extraction → Turndown markdown. Chrome-strip + Readability,
 *  with a link-density fallback to known content containers. Pure function of
 *  the HTML — exported for unit testing with fixtures. */
export function extractPageContent(html: string, pageUrl: string): ExtractedPage {
  // jsdom logs CSS-parse noise from real-world stylesheets; silence it.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole });
  const doc = dom.window.document;
  for (const el of doc.querySelectorAll(CHROME_SELECTORS)) el.remove();

  // Readability mutates the document — give it a clone so the fallback below
  // still sees the full (chrome-stripped) page.
  const readerDoc = doc.cloneNode(true) as Document;
  const article = new Readability(readerDoc, { charThreshold: 100 }).parse();

  let contentHtml = article?.content ?? "";
  let title = article?.title ?? undefined;

  const pickedDom = contentHtml ? new JSDOM(contentHtml, { url: pageUrl, virtualConsole }) : null;
  const picked = pickedDom?.window.document.body;
  if (!picked || linkDensity(picked) > 0.7) {
    // Readability's pick is a menu (or nothing) — take the least link-dense
    // known content container instead, falling back to the stripped body.
    let best: { html: string; density: number } | null = null;
    for (const sel of CONTENT_SELECTORS) {
      const el = doc.querySelector(sel);
      if (!el || !(el.textContent ?? "").trim()) continue;
      const density = linkDensity(el as any);
      if (!best || density < best.density) best = { html: el.innerHTML, density };
    }
    if (best && best.density < 0.7) {
      contentHtml = best.html;
    } else if (!contentHtml) {
      contentHtml = doc.body?.innerHTML ?? "";
    }
    title = title ?? doc.title ?? undefined;
  }

  const contentDom = new JSDOM(contentHtml, { url: pageUrl, virtualConsole });

  const imageUrls: string[] = [];
  for (const img of contentDom.window.document.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) continue;
    try {
      const abs = new URL(src, pageUrl).href;
      if (!imageUrls.includes(abs)) imageUrls.push(abs);
    } catch {
      /* unparseable src — skip */
    }
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  const markdown = turndown.turndown(contentHtml).trim();

  return { title, markdown, imageUrls };
}

function isHttpUrl(value: string | undefined): value is string {
  return !!value && /^https?:\/\//i.test(value);
}

/** Entries the fetch stage operates on: pull/existing source with a real URL. */
function isFetchable(entry: SchematicEntry): boolean {
  return (
    (entry.content_source === "pull" || entry.content_source === "existing") &&
    entry.status === "filled" &&
    isHttpUrl(entry.source_url)
  );
}

/**
 * Fetch source content for every eligible entry. Mutates the schematic
 * (source_file, assets, status, open_questions) and persists the markdown
 * files; the caller persists the schematic itself.
 */
export async function fetchSourceContent(
  schematic: ContentSchematic,
  opts: FetchOptions
): Promise<FetchReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const delayMs = opts.delayMs ?? (opts.fetchImpl ? 0 : 1500);
  const report: FetchReport = { fetched: [], failed: [], skipped: [] };
  let fetchesMade = 0;

  for (let i = 0; i < schematic.entries.length; i++) {
    const entry = schematic.entries[i];
    const base: FetchReportItem = {
      node_key: entry.node_key,
      title: entry.title,
      source_url: entry.source_url,
      outcome: "skipped",
    };

    if (!isFetchable(entry)) {
      // Only report skips that look like they *wanted* fetching — keeps the
      // manifest focused (todo/generate/done entries aren't noise-listed).
      if (
        (entry.content_source === "pull" || entry.content_source === "existing") &&
        entry.status === "filled"
      ) {
        report.skipped.push({ ...base, detail: `no http(s) source_url (${entry.source_url ?? "unset"})` });
      }
      continue;
    }
    if (entry.source_file && !opts.refetch) {
      report.skipped.push({ ...base, source_file: entry.source_file, detail: "already fetched (pass refetch to redo)" });
      continue;
    }

    const nn = String(i + 1).padStart(2, "0");
    const filePath = `${opts.slug}-source/${nn}-${slugify(entry.title)}.md`;

    try {
      if (fetchesMade > 0 && delayMs > 0) {
        await new Promise((res) => setTimeout(res, delayMs));
      }
      fetchesMade++;
      const html = await fetchHtml(entry.source_url!, fetchImpl, timeoutMs);
      const page = extractPageContent(html, entry.source_url!);
      if (!page.markdown) throw new Error("extraction produced no content");

      const header = [
        `<!-- source: ${entry.source_url} -->`,
        `<!-- node_key: ${entry.node_key} -->`,
        page.title ? `<!-- page title: ${page.title} -->` : null,
        "",
      ]
        .filter((l): l is string => l !== null)
        .join("\n");
      await opts.writeWorkspaceFile(filePath, header + page.markdown + "\n");

      entry.source_file = filePath;
      if (page.imageUrls.length > 0) {
        const assets = entry.assets ?? [];
        for (const url of page.imageUrls) {
          if (!assets.includes(url)) assets.push(url);
        }
        entry.assets = assets;
      }
      report.fetched.push({ ...base, source_file: filePath, outcome: "fetched" });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      entry.status = "needs_input";
      const question = `Could not fetch source content for "${entry.title}" from ${entry.source_url} (${detail}) — provide the correct URL or the content itself.`;
      schematic.open_questions = schematic.open_questions ?? [];
      if (!schematic.open_questions.some((q) => q.includes(entry.title))) {
        schematic.open_questions.push(question);
      }
      report.failed.push({ ...base, outcome: "failed", detail });
    }
  }

  return report;
}

// ─── Source URL discovery ────────────────────────────────────────────────────

export interface UrlCandidate {
  url: string;
  score: number;
  matched: string;
}

export interface UrlProposal {
  node_key: string;
  title: string;
  candidates: UrlCandidate[];
}

export interface DiscoverOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Max candidates per entry. Default 3. */
  maxCandidates?: number;
}

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !["the", "of", "and", "our", "us"].includes(t));
}

/** Token-overlap score between an entry title and a URL slug / link text.
 *  1.0 = every title token present. Exported for unit testing. */
export function matchScore(title: string, candidateText: string): number {
  const titleTokens = normalizeTokens(title);
  if (titleTokens.length === 0) return 0;
  const candTokens = new Set(normalizeTokens(candidateText));
  let hits = 0;
  for (const t of titleTokens) {
    if (candTokens.has(t)) hits++;
  }
  return hits / titleTokens.length;
}

async function fetchSitemapUrls(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<Array<{ url: string; text: string }>> {
  const sitemapUrl = new URL("/sitemap.xml", baseUrl).href;
  const xml = await fetchHtml(sitemapUrl, fetchImpl, timeoutMs);
  const urls: Array<{ url: string; text: string }> = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const url = match[1];
    const lastSeg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    urls.push({ url, text: lastSeg });
  }
  return urls;
}

async function fetchNavLinks(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<Array<{ url: string; text: string }>> {
  const html = await fetchHtml(baseUrl, fetchImpl, timeoutMs);
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, { url: baseUrl, virtualConsole });
  const origin = new URL(baseUrl).origin;
  const links: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  for (const a of dom.window.document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      const abs = new URL(href, baseUrl);
      if (abs.origin !== origin || seen.has(abs.href)) continue;
      seen.add(abs.href);
      const lastSeg = abs.pathname.split("/").filter(Boolean).pop() ?? "";
      const text = `${a.textContent?.trim() ?? ""} ${lastSeg}`.trim();
      links.push({ url: abs.href, text });
    } catch {
      /* unparseable href — skip */
    }
  }
  return links;
}

/**
 * Propose source URLs for entries that need one (pull/existing without a real
 * URL), by matching titles against the old site's sitemap.xml, falling back to
 * homepage links. Read-only — never writes into the schematic.
 */
export async function discoverSourceUrls(
  schematic: ContentSchematic,
  baseUrl: string,
  opts: DiscoverOptions = {}
): Promise<{ proposals: UrlProposal[]; source: "sitemap" | "homepage"; pages_scanned: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxCandidates = opts.maxCandidates ?? 3;

  let pages: Array<{ url: string; text: string }>;
  let source: "sitemap" | "homepage";
  try {
    pages = await fetchSitemapUrls(baseUrl, fetchImpl, timeoutMs);
    source = "sitemap";
    if (pages.length === 0) throw new Error("empty sitemap");
  } catch {
    pages = await fetchNavLinks(baseUrl, fetchImpl, timeoutMs);
    source = "homepage";
  }

  const needsUrl = schematic.entries.filter(
    (e) =>
      (e.content_source === "pull" || e.content_source === "existing") &&
      !isHttpUrl(e.source_url) &&
      e.status !== "orphaned" &&
      e.status !== "done" &&
      e.kind !== "docman"
  );

  const proposals: UrlProposal[] = [];
  for (const entry of needsUrl) {
    const scored = pages
      .map((p) => ({ url: p.url, matched: p.text, score: matchScore(entry.title, p.text) }))
      .filter((c) => c.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCandidates);
    proposals.push({ node_key: entry.node_key, title: entry.title, candidates: scored });
  }

  return { proposals, source, pages_scanned: pages.length };
}
