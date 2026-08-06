import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { load as cheerioLoad } from "cheerio";
import puppeteer, { type Browser } from 'puppeteer';
import { outboundHeaders, userAgentFor } from "./user-agent.js";

export interface JoomlaConfig {
  baseUrl: string;
  username: string;
  password: string;
  moduleTypeBlacklist?: Set<string>;
  menuItemTypeBlacklist?: Set<string>;
}

export interface JoomlaResponse {
  success: boolean;
  message: string;
  data?: unknown;
  html?: string;
}

interface MenuItemType {
  group: string;
  label: string;
  description: string;
  encoded: string;
  title: string;
  request: Record<string, string>;
}

interface ModuleType {
  id: string;
  title: string;
  href: string;
  module?: string;
}

type FormValue = string | string[];
type FormDataMap = Record<string, FormValue>;
interface GantryLayoutNode {
  id?: string;
  title?: string;
  type?: string;
  subtype?: string;
  attributes?: Record<string, unknown>;
  children?: GantryLayoutNode[];
  layout?: boolean;
}

interface GantryCategoryReference {
  id: string;
  title: string;
}

interface GantryArticleReference {
  id: string;
  title: string;
  alias: string;
  categoryId: string;
  categoryTitle: string;
  introtext: string;
  fulltext: string;
  state: string;
  access: string;
}

interface GantryParticleReference {
  particleId: string;
  particleTitle: string;
  particleType: string;
  filterPath: string;
  categories: GantryCategoryReference[];
  articles: GantryArticleReference[];
}

interface AdminFieldDetails {
  name: string;
  id: string;
  kind: string;
  inputType: string;
  value: string;
  checked?: boolean;
  disabled?: boolean;
  label?: string;
  options?: Array<{ value: string; label: string; selected: boolean }>;
}

type JoomlaEntity = "article" | "category" | "module" | "menuItem";

interface ModuleBlueprint {
  kind: "joomla-module-blueprint";
  version: 1;
  exportedAt: string;
  source: {
    id: string;
    title: string;
    moduleType: string;
  };
  module: {
    title: string;
    moduleType: string;
    clientId: string;
    position: string;
    published: string;
    access: string;
    showtitle: string;
    ordering: string;
    style: string;
    language: string;
    note: string;
    assignment: string;
    assigned: string[];
    content?: string;
    params: Record<string, string>;
    advanced: Record<string, string>;
    fieldOverrides: Record<string, string>;
  };
}

export class JoomlaClient {
  private config: JoomlaConfig;
  private cookies: Map<string, string> = new Map();
  private tokenName: string | null = null;
  private _browser: Browser | null = null;
  /**
   * Cached Gantry 5 configuration entry URL (including CSRF token).
   * Populated on first successful navigation to the Gantry theme configure page
   * and reused for all subsequent calls within the same process lifetime.
   * This avoids the "stale snapshot" error caused by re-navigating to the
   * themes page (which can refresh the token) between snapshot and save.
   */
  private gantryEntryUrl: string | null = null;
  /** Per-outline layout URL cache: outline id → absolute URL. Once discovered, reused directly. */
  private gantryOutlineLayoutUrls: Map<string, string> = new Map();
  /** Per-outline layout root+preset cache. Populated on fetch; used to skip re-fetch in liveBefore check. Cleared on login and after successful save. */
  private gantryLayoutRootCache: Map<string, { root: GantryLayoutNode[]; preset: unknown }> = new Map();
  // Joomla's nested set (lft/rgt) corrupts under concurrent INSERTs — serialize all creates within a session
  private _menuCreateQueue: Promise<void> = Promise.resolve();
  /** Installed menu item types — immutable for the life of the session. */
  private _menuItemTypesCache: MenuItemType[] | null = null;

  /** mod_* name -> resolved type, keyed by "<clientId>:<mod_name>". See resolveModuleType. */
  private _moduleTypeCache: Map<string, ModuleType> = new Map();
  /** Set JOOMLA_MCP_TIMING=1 to log per-phase timings for slow admin operations. */
  static readonly TIMING = process.env.JOOMLA_MCP_TIMING === "1";

  constructor(config: JoomlaConfig) {
    this.config = config;
  }

  getConfig(): JoomlaConfig {
    return { ...this.config };
  }

  switchSite(url: string): void {
    this.config.baseUrl = url;
    this.cookies.clear();
    this.tokenName = null;
    this.gantryEntryUrl = null;
    this.gantryOutlineLayoutUrls.clear();
    this.gantryLayoutRootCache.clear();
    // Installed menu item types are per-site — carrying them across a switch would
    // resolve an itemType against the previous site's component list.
    this._menuItemTypesCache = null;
  }

  private getAdminUrl(path = ""): string {
    const siteBase = this.config.baseUrl.replace(/\/+$/, "");
    const base = /\/administrator$/i.test(siteBase) ? siteBase : `${siteBase}/administrator`;
    return `${base}/${path.replace(/^\/+/, "")}`;
  }

  private getBaseUrl(): string {
    return this.config.baseUrl.replace(/\/administrator\/?$/i, "").replace(/\/+$/, "");
  }

  private resolveUrl(path: string): string {
    if (path.startsWith("http")) return path;
    if (path.startsWith("/")) return this.getBaseUrl() + path;
    return this.getAdminUrl(path);
  }

  private buildEntityUrls(entity: JoomlaEntity, id: string): { editUrl: string; viewUrl: string } {
    switch (entity) {
      case "article":
        return {
          editUrl: this.getAdminUrl(`index.php?option=com_content&task=article.edit&id=${id}`),
          viewUrl: `${this.getBaseUrl()}/index.php?option=com_content&view=article&id=${id}`,
        };
      case "category":
        return {
          editUrl: this.getAdminUrl(`index.php?option=com_categories&task=category.edit&id=${id}&extension=com_content`),
          viewUrl: `${this.getBaseUrl()}/index.php?option=com_content&view=category&id=${id}`,
        };
      case "module":
        return {
          editUrl: this.getAdminUrl(`index.php?option=com_modules&task=module.edit&id=${id}`),
          viewUrl: "",
        };
      case "menuItem":
        return {
          editUrl: this.getAdminUrl(`index.php?option=com_menus&task=item.edit&id=${id}`),
          viewUrl: `${this.getBaseUrl()}/index.php?Itemid=${id}`,
        };
      default:
        return { editUrl: "", viewUrl: "" };
    }
  }

  private buildOperationData(
    entity: JoomlaEntity,
    id: string,
    data: {
      title?: string;
      state?: string;
      warnings?: string[];
      verification?: Record<string, unknown>;
      [key: string]: unknown;
    }
  ): Record<string, unknown> {
    const { editUrl, viewUrl } = this.buildEntityUrls(entity, id);
    return {
      id,
      title: data.title || "",
      state: data.state || "",
      editUrl,
      viewUrl,
      warnings: data.warnings || [],
      verification: data.verification || { attempted: false },
      ...data,
    };
  }

  private findLatestByTitle(items: Array<Record<string, string>>, title: string): Record<string, string> | null {
    const decodedTitle = this.decodeHtmlEntities(title);
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (this.decodeHtmlEntities(items[i].title) === decodedTitle) return items[i];
    }
    return null;
  }

  private getCookieHeader(): string | null {
    if (this.cookies.size === 0) return null;
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  private parseSetCookie(header: string): void {
    if (!header) return;
    // Handle multiple set-cookie headers (semicolon-separated in some cases)
    const cookies = header.split(", ").length > 1 ? header.split(", ") : [header];
    for (const cookie of cookies) {
      const parts = cookie.split(";")[0];
      const eqIdx = parts.indexOf("=");
      if (eqIdx > 0) {
        const name = parts.substring(0, eqIdx).trim();
        const value = parts.substring(eqIdx + 1).trim();
        this.cookies.set(name, value);
      }
    }
  }

  private extractCsrfToken(html: string): { name: string; value: string } | null {
    // Method 1: Extract from JS options JSON
    const jsMatch = html.match(/"csrf\.token"\s*:\s*"([a-f0-9]+)"/);
    if (jsMatch) {
      return { name: jsMatch[1], value: "1" };
    }

    // Method 2: Extract from hidden input with CSRF_TOKEN markers
    const markerMatch = html.match(/CSRF_TOKEN_START[^>]*<input[^>]*name="([a-f0-9]+)"[^>]*value="([^"]*)"/);
    if (markerMatch) {
      return { name: markerMatch[1], value: markerMatch[2] };
    }

    // Method 3: Extract from any hidden input with hex name
    const $ = this.$c(html);
    const tokenInput = $("input[type='hidden']").filter((_, el) =>
      /^[a-f0-9]{32}$/.test($(el).attr("name") || "")
    ).first();
    if (tokenInput.length) {
      return { name: tokenInput.attr("name")!, value: tokenInput.attr("value") ?? "" };
    }

    return null;
  }

  private getFormUrlEncoded(data: FormDataMap): string {
    return Object.entries(data)
      .flatMap(([key, value]) => {
        const values = Array.isArray(value) ? value : [value];
        return values.map((item) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      })
      .join("&");
  }

  private $c(html: string) {
    return cheerioLoad(html);
  }

  private getSelectedValue(selectHtml: string): string {
    const $ = this.$c(selectHtml);
    const selected = $("option[selected]").first();
    return selected.length
      ? (selected.attr("value") ?? "")
      : ($("option").first().attr("value") ?? "");
  }

  /**
   * Scrape a form's current values so that a save POST can round-trip the
   * fields the caller did not explicitly set.
   *
   * Names ending in "[]" carry multiple values — `jform[assigned][]` (module
   * page assignments), `jform[groups][]` (user groups), `cid[]`. Collapsing
   * those to a single value silently drops every selection but one: a module
   * assigned to four menu items comes back assigned to one, and the save looks
   * like it succeeded. So those accumulate into an array; every other name
   * keeps last-write-wins, matching how a browser and PHP resolve duplicates.
   */
  private extractFormFields(html: string, formId = "adminForm"): FormDataMap {
    const $ = this.$c(html);
    const form = $(`form[id="${formId}"]`);
    const find = (sel: string) => form.length ? form.find(sel) : $(sel);
    const fields: FormDataMap = {};

    const add = (name: string, value: string) => {
      if (!name.endsWith("[]")) {
        fields[name] = value;
        return;
      }
      const existing = fields[name];
      if (Array.isArray(existing)) existing.push(value);
      else fields[name] = [value];
    };

    find("input").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const type = ($el.attr("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") return;
      if ((type === "checkbox" || type === "radio") && !$el.is("[checked]")) return;
      add(name, $el.attr("value") ?? "");
    });

    find("textarea").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (name) add(name, $el.text());
    });

    find("select").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const selected = $el.find("option[selected]");
      if ($el.is("[multiple]")) {
        // A multi-select submits every selected option, and nothing at all when
        // none are selected — it does not fall back to the first option.
        selected.each((__, opt) => add(name, $(opt).attr("value") ?? ""));
        return;
      }
      add(name, selected.length
        ? (selected.first().attr("value") ?? "")
        : ($el.find("option").first().attr("value") ?? ""));
    });

    return fields;
  }

  private getJFormField(fields: FormDataMap, key: string, fallback = ""): string {
    return this.firstValue(fields[`jform[${key}]`] ?? fields[`jform_${key}`], fallback);
  }

  /** Narrow a scraped form value to a single string, for fields known to be scalar. */
  private firstValue(value: FormValue | undefined, fallback = ""): string {
    if (value === undefined) return fallback;
    return Array.isArray(value) ? (value[0] ?? fallback) : value;
  }

  private extractCheckedValues(html: string, name: string): string[] {
    const $ = this.$c(html);
    return $(`input[name="${name}"][checked]`).map((_, el) => $(el).attr("value") ?? "").get();
  }

  private extractSelectOptions(html: string, selectId: string): Array<{ value: string; label: string; selected: boolean }> {
    const $ = this.$c(html);
    const select = $(`select[id="${selectId}"]`);
    if (!select.length) return [];
    return select.find("option").map((_, el) => {
      const $el = $(el);
      return {
        value: $el.attr("value") ?? "",
        label: $el.text().trim(),
        selected: $el.is("[selected]"),
      };
    }).get();
  }

  private stripHtml(value: string): string {
    return this.$c(value).text().replace(/\s+/g, " ").trim();
  }

  private extractPublishedState(row: string): string {
    if (/listItemTask\('[^']+','[^']+\.unpublish'\)/.test(row)) return "Published";
    if (/listItemTask\('[^']+','[^']+\.publish'\)/.test(row)) return "Unpublished";
    if (/icon-unpublish/.test(row)) return "Published";
    if (/icon-publish/.test(row)) return "Unpublished";
    if (/listItemTask\('[^']+','[^']+\.trash'\)/.test(row) || /icon-trash/.test(row)) return "Trashed";
    return "Unknown";
  }

  private parseMenuItemTypePayload(encoded: string): { title: string; request: Record<string, string> } | null {
    try {
      const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
        title?: unknown;
        request?: Record<string, unknown>;
      };
      const request: Record<string, string> = {};
      for (const [key, value] of Object.entries(decoded.request || {})) {
        request[key] = String(value);
      }
      return {
        title: String(decoded.title || ""),
        request,
      };
    } catch {
      return null;
    }
  }

  private buildLinkFromRequest(request: Record<string, string>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request)) {
      if (value !== "") params.set(key, value);
    }
    return `index.php?${params.toString()}`;
  }

  private buildArticleText(introtext = "", fulltext = ""): string {
    if (!fulltext) return introtext;
    return `${introtext}<hr id="system-readmore" />${fulltext}`;
  }

  private normalizeRichText(value: string): string {
    return this.decodeHtmlEntities(String(value || ""))
      .replace(/\r\n?/g, "\n")
      .replace(/<hr\b[^>]*\bid=["']system-readmore["'][^>]*\/?>/gi, '<hr id="system-readmore" />')
      .replace(/>\s+</g, "><")
      .replace(/\s+/g, " ")
      .trim();
  }

  private isEquivalentRichText(actual: string, expected: string): boolean {
    return this.normalizeRichText(actual) === this.normalizeRichText(expected);
  }

  private verifyAlias(actual: string, requested?: string): boolean {
    if (requested && requested.trim()) {
      return actual === requested;
    }
    return actual.trim().length > 0;
  }

  private collapseVerification(detail: Record<string, boolean>, verified: boolean): Record<string, unknown> {
    if (verified) return { verified: true };
    const failures = Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== true));
    return { verified: false, failures };
  }

  private shouldVerifyAssignedMembers(assignment: string): boolean {
    return assignment === "1" || assignment === "-1";
  }

  private isDeletionVerified(stillListed: boolean, verify: JoomlaResponse, stateFieldNames: string[]): boolean {
    if (stillListed) return false;
    if (!verify.success) return true;
    const record = (verify.data || {}) as Record<string, unknown>;
    return stateFieldNames.some((fieldName) => String(record[fieldName] || "") === "-2");
  }

  private isCheckInVerified(successMsg: boolean, verify: JoomlaResponse, checkedOutCleared: boolean): boolean {
    return verify.success && (checkedOutCleared || successMsg);
  }

  private splitArticleText(articletext: string): { introtext: string; fulltext: string } {
    const readmore = /<hr\b[^>]*\bid=["']system-readmore["'][^>]*>/i;
    const parts = articletext.split(readmore);
    return {
      introtext: parts[0] || "",
      fulltext: parts.slice(1).join("") || "",
    };
  }

  private getMenuItemsListUrl(menuType?: string, search?: string): string {
    const params = new URLSearchParams({
      option: "com_menus",
      view: "items",
      limit: "0",
      // Every com_menus list filter is sticky: Joomla stores it in the session and
      // reapplies it to later requests that omit it. So a scoped read would silently
      // narrow every read after it — an "all menus" list returning only the last menu
      // scoped, or a verification read missing a trashed row. Send all three on every
      // request, empty when we mean unfiltered, so the URL fully determines the result.
      menutype: menuType ?? "",
      // com_menus honours an "id:<n>" search prefix, which is how the write paths
      // address exactly one row. A plain title search is a LIKE match, so it can pull
      // in siblings and is not a safe basis for verifying one item.
      "filter[search]": search ?? "",
      "filter[published]": "",
    });
    return this.getAdminUrl(`index.php?${params.toString()}`);
  }

  /**
   * Check a record back in using a token we already hold, in one request.
   *
   * Opening any Joomla edit form (task=<x>.edit) checks the record out, so every read
   * has to release it again. The full checkIn* tools cost several requests because they
   * re-verify the target first; internal callers already know the target is right, so
   * they use this instead. Joomla routes POSTs by the task field, and its CSRF tokens
   * are per-session, so a list URL plus an edit-page token is a valid check-in with no
   * page fetch of its own.
   */
  private async quickCheckInRecord(
    id: string,
    listPath: string,
    task: string,
    token: { name: string; value: string } | null
  ): Promise<boolean> {
    if (!token) return false;
    const result = await this.postPage(
      this.getAdminUrl(listPath),
      { task, "cid[]": id, boxchecked: "1" },
      { token, noFollow: true }
    );
    return result.redirected;
  }

  private quickCheckIn(id: string, token: { name: string; value: string } | null): Promise<boolean> {
    return this.quickCheckInRecord(id, "index.php?option=com_menus&view=items", "items.checkin", token);
  }

  /**
   * List URLs for the other three components, on the same terms as getMenuItemsListUrl:
   * every sticky filter is sent on every request (empty when we mean unfiltered) so the
   * URL fully determines the result, and "id:<n>" addresses exactly one row rather than
   * relying on a title LIKE match.
   */
  private getArticlesListUrl(search?: string, categoryId?: string): string {
    const params = new URLSearchParams({
      option: "com_content",
      view: "articles",
      limit: "0",
      "filter[search]": search ?? "",
      "filter[published]": "",
      "filter[category_id]": categoryId ?? "",
    });
    return this.getAdminUrl(`index.php?${params.toString()}`);
  }

  private getCategoriesListUrl(search?: string, extension = "com_content"): string {
    const params = new URLSearchParams({
      option: "com_categories",
      view: "categories",
      extension,
      limit: "0",
      "filter[search]": search ?? "",
      "filter[published]": "",
    });
    return this.getAdminUrl(`index.php?${params.toString()}`);
  }

  private getModulesListUrl(search?: string, clientId = "0"): string {
    const params = new URLSearchParams({
      option: "com_modules",
      view: "modules",
      client_id: clientId,
      limit: "0",
      "filter[search]": search ?? "",
      "filter[state]": "",
      "filter[position]": "",
    });
    return this.getAdminUrl(`index.php?${params.toString()}`);
  }

  private quickCheckInArticle(id: string, token: { name: string; value: string } | null): Promise<boolean> {
    return this.quickCheckInRecord(id, "index.php?option=com_content&view=articles", "articles.checkin", token);
  }

  private quickCheckInCategory(id: string, token: { name: string; value: string } | null): Promise<boolean> {
    return this.quickCheckInRecord(
      id,
      "index.php?option=com_categories&view=categories&extension=com_content",
      "categories.checkin",
      token
    );
  }

  private quickCheckInModule(id: string, token: { name: string; value: string } | null): Promise<boolean> {
    return this.quickCheckInRecord(id, "index.php?option=com_modules&view=modules", "modules.checkin", token);
  }

  /**
   * Read one menu item's row from the items list, plus a token for the task that follows.
   *
   * The list-driven writes (toggle, check-in, trash) need four things about their target
   * before they act: that it exists, its title, its state, and a CSRF token. Reading the
   * edit form gets all four but costs three requests — Joomla 303s task=item.edit to the
   * form, the form is ~71KB, and opening it checks the item out, so it has to be checked
   * back in before a list task will touch it. The list row carries the same four things
   * in one request and takes no checkout at all.
   *
   * Requires the menuType so the list can be scoped server-side; callers that do not know
   * it fall back to the edit form. Returns null when the row is not in the list.
   */
  private async findMenuItemRow(
    id: string,
    menuType: string,
  ): Promise<{ row: Record<string, string>; token: { name: string; value: string } | null } | null> {
    const { html, token } = await this.getPage(this.getMenuItemsListUrl(menuType, `id:${id}`));
    const row = this.parseMenuItemList(html).find((entry) => entry.id === id);
    return row ? { row, token } : null;
  }

  /**
   * Shared safety check for the list-driven menu item writes (toggle, check-in, trash).
   *
   * Establishes that the target exists and matches what the caller expected, and returns
   * a token for the task. Prefers the one-request list row; falls back to the edit form
   * when the menu is unknown or the row is not listed, which also recovers the menuType.
   */
  private async menuItemPreflight(
    id: string,
    menuType: string | undefined,
    verb: string,
    options: { expectedTitle?: string; expectedMenuType?: string },
  ): Promise<
    | { ok: true; title: string; menuType: string; token: { name: string; value: string }; row: Record<string, string> | null }
    | { ok: false; message: string }
  > {
    let title = "";
    let actualMenuType = menuType || "";
    let token: { name: string; value: string } | null = null;
    let row: Record<string, string> | null = null;

    if (actualMenuType) {
      const found = await this.findMenuItemRow(id, actualMenuType);
      if (found) {
        row = found.row;
        title = found.row.title;
        token = found.token;
      }
    }

    if (!row) {
      // No menuType to scope by, or the id is not in that menu. The edit form answers
      // both questions, at the cost of a checkout we have to release again.
      const before = await this.fetchMenuItemForm(id);
      if (!before.success) {
        return { ok: false, message: `Refusing to ${verb} menu item ${id} because the current target could not be verified` };
      }
      const item = (before.data || {}) as Record<string, unknown>;
      title = String(item.title || "");
      actualMenuType = menuType || String(item.menuType || "");
      token = before.token ?? null;
      await this.quickCheckIn(id, token);
    }

    if (options.expectedTitle && this.decodeHtmlEntities(title) !== this.decodeHtmlEntities(options.expectedTitle)) {
      return { ok: false, message: `Refusing to ${verb} menu item ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedMenuType && actualMenuType !== options.expectedMenuType) {
      return { ok: false, message: `Refusing to ${verb} menu item ${id}: expected menuType ${options.expectedMenuType}, found ${actualMenuType}` };
    }
    if (!token) {
      return { ok: false, message: "Failed to extract CSRF token" };
    }
    return { ok: true, title, menuType: actualMenuType, token, row };
  }

  private parseMenuItemTypes(html: string): MenuItemType[] {
    const $ = this.$c(html);
    const types: MenuItemType[] = [];
    $(".accordion-heading").each((_, headingEl) => {
      const group = $(headingEl).text().trim();
      const container = $(headingEl).closest(".accordion-group, .accordion-inner, .accordion");
      const links = container.length
        ? container.find("ul.nav-stacked a")
        : $(headingEl).nextAll("ul.nav-stacked").first().find("a");
      links.each((_, linkEl) => {
        const $link = $(linkEl);
        const onclick = $link.attr("onclick") || "";
        const encodedMatch = onclick.match(/setmenutype\('([^']+)'\)/);
        if (!encodedMatch) return;
        const encoded = encodedMatch[1];
        const payload = this.parseMenuItemTypePayload(encoded);
        if (!payload) return;
        types.push({
          group,
          label: $link.text().trim(),
          description: $link.attr("title") || "",
          encoded,
          title: payload.title,
          request: payload.request,
        });
      });
    });
    return types;
  }

  private findMenuItemType(types: MenuItemType[], itemType: string): MenuItemType | null {
    const lowered = itemType.toLowerCase();
    const decoded = this.parseMenuItemTypePayload(itemType);
    if (decoded) {
      return {
        group: "",
        label: decoded.title,
        description: "",
        encoded: itemType,
        title: decoded.title,
        request: decoded.request,
      };
    }

    return types.find((type) => {
      const requestKey = [type.request.option, type.request.view, type.request.layout].filter(Boolean).join(".");
      return (
        type.label.toLowerCase() === lowered ||
        type.title.toLowerCase() === lowered ||
        requestKey.toLowerCase() === lowered
      );
    }) || null;
  }

  private parseMenuItemForm(html: string): Record<string, unknown> {
    const adminForms = this.parseAdminForms(html, "item-form");
    const form = adminForms[0] as Record<string, unknown> | undefined;
    const fields = (form?.values || {}) as Record<string, string>;
    const fieldDetails = (form?.fields || []) as AdminFieldDetails[];

    const item: Record<string, unknown> = {};
    const request: Record<string, string> = {};
    const params: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
      const requestMatch = key.match(/^jform\[request\]\[([^\]]+)\]$/);
      const paramsMatch = key.match(/^jform\[params\]\[([^\]]+)\]$/);
      if (requestMatch) request[requestMatch[1]] = value;
      if (paramsMatch) params[paramsMatch[1]] = value;
    }

    item.id = this.getJFormField(fields, "id");
    item.title = this.getJFormField(fields, "title");
    item.alias = this.getJFormField(fields, "alias");
    item.menuType = this.getJFormField(fields, "menutype");
    item.type = this.getJFormField(fields, "type");
    item.link = this.getJFormField(fields, "link");
    item.parentId = this.getJFormField(fields, "parent_id", "1");
    item.published = this.getJFormField(fields, "published", "1");
    item.access = this.getJFormField(fields, "access", "1");
    item.language = this.getJFormField(fields, "language", "*");
    item.browserNav = this.getJFormField(fields, "browserNav", "0");
    item.home = this.getJFormField(fields, "home", "0");
    item.note = this.getJFormField(fields, "note");
    item.templateStyleId = fields["jform[template_style_id]"] ?? "0";
    item.templateStyleOptions = fieldDetails.find((f) => f.name === "jform[template_style_id]")?.options ?? [];
    item.request = request;
    item.params = params;
    return item;
  }

  private looksLoggedIn(html: string): boolean {
    return !html.includes("mod-login-username") && (
      html.includes("option=com_login&amp;task=logout") ||
      html.includes("option=com_login&task=logout") ||
      html.includes("task=logout") ||
      html.includes("com_cpanel") ||
      html.includes("com_dashboard") ||
      html.includes("submenu") ||
      html.includes("navbar")
    );
  }

  // Outbound requests go out at full speed. Pacing and 429 backoff used to live
  // here; they cost far more than they bought — a single write spent up to ~29s
  // per request in backoff and blew past the caller's deadline. We identify
  // ourselves via user-agent.ts instead, so the host can allowlist our egress.
  // A 429 now surfaces immediately as an error (see the check below).
  private async request(
    url: string,
    options?: { method?: string; body?: string | FormData; contentType?: string; additionalHeaders?: Record<string, string> }
  ): Promise<{ status: number; headers: Map<string, string>; body: string }> {
    const headers: Record<string, string> = {
      ...outboundHeaders(url),
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    const cookieHeader = this.getCookieHeader();
    if (cookieHeader) {
      headers["Cookie"] = cookieHeader;
    }

    // Don't set Content-Type for FormData — fetch sets it with the multipart boundary
    if (options?.contentType && !(options.body instanceof FormData)) {
      headers["Content-Type"] = options.contentType;
    }

    if (options?.additionalHeaders) {
      Object.assign(headers, options.additionalHeaders);
    }

    const fetchOptions: RequestInit = {
      method: options?.method || "GET",
      headers,
      body: options?.body as string | FormData | undefined,
      redirect: "manual",
    };

    const response = await fetch(url, fetchOptions);

    // Parse response headers
    const responseHeaders = new Map<string, string>();
    response.headers.forEach((value, key) => {
      responseHeaders.set(key.toLowerCase(), value);
    });

    // Update cookies
    const setCookie = responseHeaders.get("set-cookie");
    if (setCookie) {
      this.parseSetCookie(setCookie);
    }

    const body = await response.text();

    // Fail fast and legibly. Without this the throttled HTML body flows on and
    // fails later as an unrelated parse error, which is what made the original
    // 429s so hard to recognise. We do not wait and we do not retry — get the
    // egress IP allowlisted instead.
    if (response.status === 429) {
      throw new Error(
        `RATE_LIMITED: ${new URL(url).host} returned HTTP 429. The host is throttling this egress IP — ` +
        `it needs allowlisting. Retrying will not help.`
      );
    }

    return { status: response.status, headers: responseHeaders, body };
  }

  private async getPage(url: string, options?: { skipAuthCheck?: boolean }): Promise<{ html: string; token: { name: string; value: string } | null }> {
    const result = await this.request(url);

    // Follow redirects
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      const location = result.headers.get("location") || url;
      const redirectUrl = this.resolveUrl(location);
      return this.getPage(redirectUrl, options);
    }

    const html = result.body;

    // Detect session expiry: an admin component URL returned the login form
    if (!options?.skipAuthCheck && url.includes("/administrator/") && url.includes("option=") && html.includes("mod-login-username")) {
      throw new Error("SESSION_EXPIRED: Joomla session has expired. Call joomla_login to re-authenticate, then retry.");
    }

    const token = this.extractCsrfToken(html);
    if (token) {
      this.tokenName = token.name;
    }

    return { html, token };
  }

  private async postPage(
    url: string,
    formData: FormDataMap,
    options?: { prefetchedHtml?: string; token?: { name: string; value: string }; noFollow?: boolean }
  ): Promise<{ status: number; html: string; redirected: boolean; redirectUrl?: string }> {
    // Get the page to ensure we have a fresh token — unless the caller already
    // holds that exact page (prefetchedHtml) or already holds a valid session
    // token (token), in which case re-fetching is a wasted round trip. On a
    // rate-limited host it is worse than wasted: it is the request that trips
    // the limit, so the POST behind it fails too.
    // Joomla CSRF tokens are per-session, not per-form, so a token lifted from
    // any admin page in this session authenticates a POST to any other.
    let token = options?.token ?? null;
    if (!token) {
      const html = options?.prefetchedHtml ?? (await this.getPage(url)).html;
      token = this.extractCsrfToken(html);
    }
    if (token) {
      formData[token.name] = token.value;
      this.tokenName = token.name;
    } else if (this.tokenName) {
      formData[this.tokenName] = "1";
    }

    const formBody = this.getFormUrlEncoded(formData);
    const result = await this.request(url, {
      method: "POST",
      body: formBody,
      contentType: "application/x-www-form-urlencoded",
    });

    // Follow redirect — capture the redirect URL so callers can extract IDs from it.
    // noFollow skips fetching the redirect target, which on com_menus list tasks is a
    // full items page the caller does not read. The 303 alone proves Joomla accepted
    // the task, so the body is dead weight.
    if (result.status === 302 || result.status === 303) {
      const location = result.headers.get("location") || url;
      const redirectUrl = this.resolveUrl(location);
      if (options?.noFollow) {
        return { status: result.status, html: "", redirected: true, redirectUrl };
      }
      const redirectResult = await this.request(redirectUrl);
      return {
        status: redirectResult.status,
        html: redirectResult.body,
        redirected: true,
        redirectUrl,
      };
    }

    return { status: result.status, html: result.body, redirected: false };
  }

  private getSnapshotDir(): string {
    return path.resolve(__dirname, "..", "snapshots");
  }

  private getBlueprintDir(kind = ""): string {
    return path.resolve(__dirname, "..", "blueprints", kind);
  }

  private getSnapshotPath(snapshotId: string): string {
    const safeId = snapshotId.replace(/[^a-zA-Z0-9_.-]/g, "");
    return path.join(this.getSnapshotDir(), `${safeId}.json`);
  }

  private writeSnapshot(data: Record<string, unknown>): Record<string, unknown> {
    mkdirSync(this.getSnapshotDir(), { recursive: true });
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(data.kind || "snapshot")}-${randomUUID().slice(0, 8)}`;
    const snapshot = {
      ...data,
      id,
      snapshotId: id,
      createdAt: new Date().toISOString(),
    };
    const filePath = this.getSnapshotPath(id);
    writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
    return { ...snapshot, filePath };
  }

  private readSnapshot(snapshotId: string): Record<string, unknown> | null {
    const filePath = this.getSnapshotPath(snapshotId);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  }

  private normalizeAdminPath(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl) || pathOrUrl.startsWith("/")) return pathOrUrl;
    return pathOrUrl || "index.php";
  }

  private adminPathToUrl(pathOrUrl: string): string {
    const normalized = this.normalizeAdminPath(pathOrUrl);
    return this.resolveUrl(normalized);
  }

  private formActionToUrl(action: string, fallbackUrl: string): string {
    if (!action) return fallbackUrl;
    return this.resolveUrl(action);
  }

  /**
   * Index every label by its `for` target in one pass.
   *
   * This replaces a per-field `$c(formHtml)` lookup. A Joomla menu item or module edit
   * form carries several hundred fields, so that lookup re-parsed the whole ~100KB form
   * once per field and made local parsing cost several times more than the HTTP request
   * that fetched it.
   */
  private buildLabelIndex($: ReturnType<typeof cheerioLoad>): Map<string, string> {
    const labels = new Map<string, string>();
    $("label[for]").each((_, el) => {
      const target = $(el).attr("for");
      if (target && !labels.has(target)) labels.set(target, $(el).text().trim());
    });
    return labels;
  }

  private parseAdminFields(formHtml: string): AdminFieldDetails[] {
    const $ = this.$c(formHtml);
    const labels = this.buildLabelIndex($);
    const getLabelFor = (id: string) => (id ? labels.get(id) ?? "" : "");
    const fields: AdminFieldDetails[] = [];

    $("input").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const inputType = ($el.attr("type") || "text").toLowerCase();
      if (["button", "submit", "reset"].includes(inputType)) return;
      const id = $el.attr("id") || "";
      fields.push({
        name,
        id,
        kind: "input",
        inputType,
        value: $el.attr("value") || "",
        checked: $el.is("[checked]"),
        disabled: $el.is("[disabled]"),
        label: getLabelFor(id),
      });
    });

    $("textarea").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const id = $el.attr("id") || "";
      fields.push({
        name,
        id,
        kind: "textarea",
        inputType: "textarea",
        value: $el.text(),
        disabled: $el.is("[disabled]"),
        label: getLabelFor(id),
      });
    });

    $("select").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const id = $el.attr("id") || "";
      const options = $el.find("option").map((_, opt) => {
        const $opt = $(opt);
        return {
          value: $opt.attr("value") || "",
          label: $opt.text().trim(),
          selected: $opt.is("[selected]"),
        };
      }).get();
      const selected = $el.find("option[selected]").first();
      fields.push({
        name,
        id,
        kind: "select",
        inputType: $el.is("[multiple]") ? "select-multiple" : "select",
        value: selected.length ? (selected.attr("value") ?? "") : ($el.find("option").first().attr("value") ?? ""),
        disabled: $el.is("[disabled]"),
        label: getLabelFor(id),
        options,
      });
    });

    return fields;
  }

  private formValuesFromDetails(fields: AdminFieldDetails[]): Record<string, string> {
    const values: Record<string, string> = {};
    for (const field of fields) {
      if (field.disabled) continue;
      if ((field.inputType === "checkbox" || field.inputType === "radio") && !field.checked) continue;
      values[field.name] = field.value;
    }
    return values;
  }

  private parseAdminForms(html: string, preferredFormId?: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const forms: Array<Record<string, unknown>> = [];
    $("form").each((_, el) => {
      const $form = $(el);
      const id = $form.attr("id") || "";
      if (preferredFormId && id !== preferredFormId) return;
      const formHtml = $.html($form) || "";
      const fields = this.parseAdminFields(formHtml);
      forms.push({
        id,
        name: $form.attr("name") || "",
        action: $form.attr("action") || "",
        method: ($form.attr("method") || "get").toLowerCase(),
        fieldCount: fields.length,
        fields,
        values: this.formValuesFromDetails(fields),
      });
    });
    return forms;
  }

  private extractAlertMessage(html: string): string | null {
    const $ = this.$c(html);
    const messages: string[] = [];

    // Joomla 4/5 renders [class*="alert-message"]; Joomla 3 (Isis) renders
    // #system-message > .alert.alert-error. Collect both, plus inline field
    // validation errors, so a rejected save reports why instead of going silent.
    $('[class*="alert-message"], #system-message .alert, .alert-error, .alert-danger').each((_, el) => {
      const $el = $(el).clone();
      // Drop the dismiss button ("×" / "Close") so it doesn't pollute the message.
      $el.find("button, .close").remove();
      const text = $el.text().replace(/\s+/g, " ").trim();
      if (text) messages.push(text);
    });

    // Joomla marks failed fields with .invalid and renders the reason in the label.
    $("label.invalid, .invalid > label, span.form-message").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text) messages.push(text);
    });

    const unique = Array.from(new Set(messages)).filter(Boolean);
    return unique.length ? unique.join(" | ") : null;
  }

  private parseAdminLinks(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const links: Array<Record<string, string>> = [];
    $("a[href]").each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      if (!href.includes("index.php")) return;
      const label = $el.text().trim();
      if (label) links.push({ label, href });
    });
    return links;
  }

  private parseToolbarTasks(html: string): string[] {
    const tasks = new Set<string>();
    for (const match of html.matchAll(/Joomla\.submitbutton\(['"]([^'"]+)['"]\)/gi)) tasks.add(match[1]);
    for (const match of html.matchAll(/submitbutton\(['"]([^'"]+)['"]\)/gi)) tasks.add(match[1]);
    for (const match of html.matchAll(/task=([a-z0-9_.-]+)/gi)) tasks.add(this.decodeHtml(match[1]));
    return Array.from(tasks).sort();
  }

  private parseAdminTableRows(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const rows: Array<Record<string, unknown>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const rowHtml = $.html($row) || "";
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const editLink = $row.find("a[href*='layout=edit'], a[href*='.edit']").first();
      const title = editLink.length
        ? editLink.text().trim()
        : $row.find("a").first().text().trim();
      rows.push({
        id: cid,
        title,
        state: this.extractPublishedState(rowHtml),
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml),
        rawText: $row.text().replace(/\s+/g, " ").trim().slice(0, 500),
      });
    });
    return rows;
  }

  private inferRestoreTask(kind: string, pathOrUrl?: string): string {
    const path = pathOrUrl || "";
    if (kind === "article" || /option=com_content/.test(path)) return "article.save";
    if (kind === "category" || /option=com_categories/.test(path)) return "category.save";
    if (kind === "menuItem" || /option=com_menus.*view=item|task=item/.test(path)) return "item.save";
    if (kind === "module" || /option=com_modules/.test(path)) return "module.save";
    if (kind === "menu" || /option=com_menus.*view=menu/.test(path)) return "menu.save";
    return "";
  }

  private getStableFormIdentity(values: Record<string, string>): Record<string, string> {
    const identityKeys = [
      "id",
      "jform[id]",
      "jform[module]",
      "jform[client_id]",
      "jform[menutype]",
      "jform[type]",
      "jform[extension]",
      "jform[catid]",
      "jform[parent_id]",
      "option",
      "view",
      "layout",
    ];
    const identity: Record<string, string> = {};
    for (const key of identityKeys) {
      if (typeof values[key] === "string" && values[key] !== "") {
        identity[key] = values[key];
      }
    }
    return identity;
  }

  private getRestorableVerificationFields(values: Record<string, string>): Record<string, string> {
    const allowedExactKeys = new Set([
      "jform[title]",
      "jform[alias]",
      "jform[note]",
      "jform[articletext]",
      "jform[description]",
      "jform[content]",
      "jform[catid]",
      "jform[parent_id]",
      "jform[state]",
      "jform[published]",
      "jform[access]",
      "jform[language]",
      "jform[module]",
      "jform[client_id]",
      "jform[position]",
      "jform[showtitle]",
      "jform[ordering]",
      "jform[style]",
      "jform[assignment]",
      "jform[menutype]",
      "jform[type]",
      "jform[link]",
      "jform[browserNav]",
      "jform[home]",
      "jform[publish_up]",
      "jform[publish_down]",
    ]);
    const allowedPrefixes = ["jform[request][", "jform[params][", "jform[advanced]["];
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(values || {})) {
      if (!allowedExactKeys.has(key) && !allowedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
      result[key] = value;
    }
    return result;
  }

  private matchesVerificationField(key: string, actualValue: string, expectedValue: string): boolean {
    if (key === "jform[articletext]" || key === "jform[description]" || key === "jform[content]") {
      return this.isEquivalentRichText(actualValue, expectedValue);
    }
    return String(actualValue || "") === String(expectedValue || "");
  }

  // ==================== BACKEND DISCOVERY / SAFETY ====================

  async backendInventory(): Promise<JoomlaResponse> {
    const { html } = await this.getPage(this.getAdminUrl("index.php"));
    const adminLinks = this.parseAdminLinks(html)
      .filter((link) => !/logout|task=logout|https?:\/\//i.test(link.href))
      .filter((link, index, links) => links.findIndex((item) => item.href === link.href) === index);

    const components = Array.from(new Set(adminLinks.flatMap((link) =>
      Array.from(link.href.matchAll(/option=(com_[a-z0-9_]+)/gi)).map((match) => match[1])
    ))).sort();

    const moduleTypes = await this.listModuleTypes("0");
    const menuItemTypes = await this.listMenuItemTypes();
    const gantryOutlines = await this.listGantry5Outlines();
    const keyForms = [
      ["Article Add", "index.php?option=com_content&task=article.add", "item-form"],
      ["Category Add", "index.php?option=com_categories&task=category.add&extension=com_content", "item-form"],
      ["Menu Item Add", "index.php?option=com_menus&view=item&layout=edit&menutype=mainmenu", "item-form"],
      ["Module List", "index.php?option=com_modules&view=modules", "adminForm"],
      ["Media", "index.php?option=com_media", ""],
      ["Sponsors", "index.php?option=com_sponsors&view=sponsors", "adminForm"],
      ["DOCman Documents", "index.php?option=com_docman", ""],
      ["Redirects", "index.php?option=com_redir", "adminForm"],
      ["Site Config", "index.php?option=com_siteconfig", "application-form"],
    ].map(([label, path, formId]) => ({ label, path, formId }));

    return {
      success: true,
      message: `Found ${components.length} components, ${adminLinks.length} admin links`,
      data: {
        components,
        adminLinks,
        moduleTypes: moduleTypes.data,
        menuItemTypes: menuItemTypes.data,
        gantryOutlines: (gantryOutlines.data as Record<string, unknown> | undefined)?.outlines || [],
        keyForms,
      },
    };
  }

  async inspectAdminForm(pathOrUrl: string, formId?: string): Promise<JoomlaResponse> {
    const url = this.adminPathToUrl(pathOrUrl);
    const { html, token } = await this.getPage(url);
    const forms = this.parseAdminForms(html, formId);
    return {
      success: forms.length > 0,
      message: forms.length > 0 ? `Found ${forms.length} form(s)` : "No forms found",
      data: {
        path: pathOrUrl,
        url,
        csrfTokenName: token?.name || this.tokenName,
        toolbarTasks: this.parseToolbarTasks(html),
        forms,
      },
      html: html.substring(0, 50000),
    };
  }

  async inspectAdminList(pathOrUrl: string, formId = "adminForm"): Promise<JoomlaResponse> {
    const url = this.adminPathToUrl(pathOrUrl);
    const { html, token } = await this.getPage(url);
    const forms = this.parseAdminForms(html, formId);
    const $page = this.$c(html);
    const headers = $page("th").map((_, el) => $page(el).text().trim()).get().filter(Boolean);
    const rows = this.parseAdminTableRows(html);
    return {
      success: true,
      message: `Found ${rows.length} row(s)`,
      data: {
        path: pathOrUrl,
        url,
        csrfTokenName: token?.name || this.tokenName,
        toolbarTasks: this.parseToolbarTasks(html),
        headers: Array.from(new Set(headers)),
        filters: forms[0] || null,
        rows,
      },
      html: html.substring(0, 50000),
    };
  }

  async submitAdminForm(pathOrUrl: string, data: {
    formId?: string;
    overrides?: Record<string, string>;
    task?: string;
    dryRun?: boolean;
    confirm?: boolean;
    expectedAction?: string;
    expectedIdentity?: Record<string, string>;
    verifyFields?: Record<string, string>;
  }): Promise<JoomlaResponse> {
    const url = this.adminPathToUrl(pathOrUrl);
    const { html, token } = await this.getPage(url);
    const forms = this.parseAdminForms(html, data.formId);
    const form = forms[0] as Record<string, unknown> | undefined;
    if (!form) return { success: false, message: "No matching form found" };

    const fields = (form.values || {}) as Record<string, string>;
    const action = this.formActionToUrl(String(form.action || ""), url);
    const currentIdentity = this.getStableFormIdentity(fields);
    if (data.expectedAction && action !== this.resolveUrl(data.expectedAction)) {
      return {
        success: false,
        message: `Refusing to submit form because the current action no longer matches the snapshot target`,
        data: {
          path: pathOrUrl,
          expectedAction: this.resolveUrl(data.expectedAction),
          actualAction: action,
        },
      };
    }
    if (data.expectedIdentity) {
      for (const [key, expectedValue] of Object.entries(data.expectedIdentity)) {
        if (String(currentIdentity[key] || "") !== String(expectedValue || "")) {
          return {
            success: false,
            message: `Refusing to submit form because the current target no longer matches the snapshot identity`,
            data: {
              path: pathOrUrl,
              key,
              expectedValue,
              actualValue: String(currentIdentity[key] || ""),
            },
          };
        }
      }
    }

    const payload: Record<string, string> = {
      ...fields,
      ...(data.overrides || {}),
    };
    if (data.task) payload.task = data.task;
    if (token) payload[token.name] = token.value;
    else if (this.tokenName) payload[this.tokenName] = "1";
    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: data.dryRun ? "Dry run: form payload prepared" : "Form payload prepared; set confirm=true to submit",
        data: { path: pathOrUrl, action, method: form.method, payload, expectedIdentity: data.expectedIdentity || null },
      };
    }

    const result = await this.request(action, {
      method: "POST",
      body: this.getFormUrlEncoded(payload),
      contentType: "application/x-www-form-urlencoded",
    });
    const successMsg = /saved|success|updated|created|published|unpublished/i.test(result.body) && !/alert-error|alert-danger/i.test(result.body);
    const verify = await this.inspectAdminForm(pathOrUrl, data.formId);
    const verifyData = (verify.data || {}) as Record<string, unknown>;
    const verifyForms = (verifyData.forms || []) as Array<Record<string, unknown>>;
    const verifyForm = verifyForms[0];
    const verifyValues = ((verifyForm?.values || {}) as Record<string, string>);
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success && !!verifyForm,
      fieldsMatched: !!verifyForm && Object.entries(data.verifyFields || {}).every(([key, expectedValue]) => this.matchesVerificationField(key, String(verifyValues[key] || ""), String(expectedValue || ""))),
      successMsg,
    };
    const success = verification.readbackSucceeded && verification.fieldsMatched;
    return {
      success,
      message: success ? "Form submitted" : successMsg ? "Form submitted, but readback verification failed" : "Form submitted; verify result",
      data: {
        status: result.status,
        action,
        task: payload.task || "",
        verification,
      },
      html: result.body.substring(0, 50000),
    };
  }

  async snapshotTarget(data: {
    kind: string;
    id?: string;
    path?: string;
    formId?: string;
    outline?: string;
    theme?: string;
  }): Promise<JoomlaResponse> {
    const kind = data.kind;
    let snapshotData: Record<string, unknown>;
    if (kind === "gantryLayout") {
      const layout = await this.getGantry5Layout(data.outline || "default", { theme: data.theme, includeRaw: true });
      snapshotData = {
        kind,
        outline: data.outline || "default",
        theme: this.getGantryThemeKey(data.theme),
        payload: layout.data,
      };
    } else {
      const targetPath = data.path || (
        kind === "article" ? `index.php?option=com_content&task=article.edit&id=${data.id}` :
        kind === "category" ? `index.php?option=com_categories&task=category.edit&id=${data.id}` :
        kind === "menuItem" ? `index.php?option=com_menus&task=item.edit&id=${data.id}` :
        kind === "module" ? `index.php?option=com_modules&task=module.edit&id=${data.id}` :
        ""
      );
      if (!targetPath) return { success: false, message: "Snapshot requires path or supported kind/id" };
      const inspected = await this.inspectAdminForm(targetPath, data.formId);
      snapshotData = {
        kind,
        targetId: data.id || "",
        path: targetPath,
        formId: data.formId || "",
        restoreTask: this.inferRestoreTask(kind, targetPath),
        payload: inspected.data,
      };
    }

    const snapshot = this.writeSnapshot(snapshotData);
    return {
      success: true,
      message: "Snapshot saved",
      data: {
        ...snapshot,
        snapshotId: String(snapshot.id || ""),
      },
    };
  }

  async restoreSnapshot(snapshotId: string, options: { confirm?: boolean; task?: string } = {}): Promise<JoomlaResponse> {
    const snapshot = this.readSnapshot(snapshotId);
    if (!snapshot) return { success: false, message: `Snapshot not found: ${snapshotId}` };
    if (!options.confirm) {
      return {
        success: true,
        message: "Dry run: snapshot found; set confirm=true to restore",
        data: snapshot,
      };
    }

    if (snapshot.kind === "gantryLayout") {
      const payload = snapshot.payload as Record<string, unknown>;
      return this.saveGantry5LayoutRaw(String(snapshot.outline || "default"), {
        root: payload.root || (payload.layout as Record<string, unknown> | undefined)?.root,
        preset: payload.preset,
        snapshotId,
        theme: String(snapshot.theme || "rt_studius"),
      });
    }

    const payload = snapshot.payload as Record<string, unknown>;
    const forms = ((payload as Record<string, unknown>).forms || []) as Array<Record<string, unknown>>;
    const form = forms[0];
    if (!form) return { success: false, message: "Snapshot does not contain a restorable form" };
    const snapshotValues = (form.values || {}) as Record<string, string>;
    return this.submitAdminForm(String(snapshot.path || ""), {
      formId: String(snapshot.formId || form.id || ""),
      overrides: snapshotValues,
      task: options.task || String(snapshot.restoreTask || ""),
      confirm: true,
      expectedAction: String(form.action || ""),
      expectedIdentity: this.getStableFormIdentity(snapshotValues),
      verifyFields: this.getRestorableVerificationFields(snapshotValues),
    });
  }

  private slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private parseMenuTreeText(text: string): Array<Record<string, unknown>> {
    const roots: Array<Record<string, unknown>> = [];
    const stack: Array<{ indent: number; node: Record<string, unknown> }> = [];
    for (const rawLine of text.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const indent = rawLine.match(/^\s*/)?.[0].replace(/\t/g, "    ").length || 0;
      const clean = rawLine.trim().replace(/^[-*]\s+/, "");
      const grid = /\[grid\]/i.test(clean);
      const unpublished = /\b(unpublish|unpublished|coming soon)\b/i.test(clean);
      const title = clean.replace(/\s*\[grid\]\s*/i, "").replace(/\s*\([^)]*\)\s*$/, "").trim();
      const note = clean.match(/\(([^)]*)\)/)?.[1] || "";
      const node: Record<string, unknown> = { title, note, grid, unpublished, children: [] };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length) {
        ((stack[stack.length - 1].node.children as Array<Record<string, unknown>>) || []).push(node);
      } else {
        roots.push(node);
      }
      stack.push({ indent, node });
    }
    return roots;
  }

  private normalizeMenuTree(menuTree: unknown): Array<Record<string, unknown>> {
    if (typeof menuTree === "string") return this.parseMenuTreeText(menuTree);
    if (Array.isArray(menuTree)) return menuTree as Array<Record<string, unknown>>;
    return [];
  }

  private buildSiteBuildPlan(data: {
    siteCode?: string;
    suffix?: string;
    menuTitle?: string;
    menuType?: string;
    menuTree: unknown;
    pageContentCategory?: string;
    homeCategory?: string;
  }): Record<string, unknown> {
    const suffix = this.slugify(data.suffix || data.siteCode || "site");
    const menuTitle = data.menuTitle || `Main Menu ${suffix.toUpperCase()}`;
    const menuType = data.menuType || `main-menu-${suffix}`.slice(0, 24);
    const pageContentCategory = data.pageContentCategory || "Page Content (Menu Item Needed)";
    const homeCategory = data.homeCategory || "__ Catholic";
    const tree = this.normalizeMenuTree(data.menuTree);
    const operations: Array<Record<string, unknown>> = [
      { type: "ensureCategory", key: "pageContent", title: pageContentCategory, published: "1" },
      { type: "ensureCategory", key: "homeCategory", title: homeCategory, published: "1" },
      { type: "ensureMenu", title: menuTitle, menuType },
    ];

    const walk = (nodes: Array<Record<string, unknown>>, parentKey = "root", gridAncestorCategory = "", depth = 0) => {
      for (const node of nodes) {
        const title = String(node.title || "").trim();
        if (!title) continue;
        const alias = `${this.slugify(title)}-${suffix}`;
        const key = `${parentKey}/${alias}`;
        const isHome = depth === 0 && title.toLowerCase() === "home";
        const gridCategory = node.grid ? `${title} Items` : gridAncestorCategory;
        if (node.grid) operations.push({ type: "ensureCategory", key: `grid:${title}`, title: gridCategory, published: "1" });

        if (isHome) {
          operations.push({
            type: "ensureMenuItem",
            key,
            title,
            alias,
            menuType,
            parentKey,
            itemType: "COM_CONTENT_CATEGORY_VIEW_BLOG_TITLE",
            request: { id: "{homeCategoryId}" },
            published: "1",
            home: "1",
          });
        } else {
          const articleCategory = gridAncestorCategory || pageContentCategory;
          operations.push({
            type: "ensureArticle",
            key: `article:${key}`,
            title,
            alias,
            categoryTitle: articleCategory,
            state: node.unpublished ? "0" : "1",
            content: `<h1>${title}</h1>`,
          });
          operations.push({
            type: "ensureMenuItem",
            key,
            title,
            alias,
            menuType,
            parentKey,
            itemType: "COM_CONTENT_ARTICLE_VIEW_DEFAULT_TITLE",
            request: { id: `{article:${key}}` },
            published: node.unpublished ? "0" : "1",
          });
        }
        walk((node.children || []) as Array<Record<string, unknown>>, key, gridCategory, depth + 1);
      }
    };
    walk(tree);

    return {
      generatedAt: new Date().toISOString(),
      suffix,
      menuTitle,
      menuType,
      pageContentCategory,
      homeCategory,
      tree,
      operations,
    };
  }

  async planSiteBuild(data: {
    siteCode?: string;
    suffix?: string;
    menuTitle?: string;
    menuType?: string;
    menuTree: unknown;
    pageContentCategory?: string;
    homeCategory?: string;
  }): Promise<JoomlaResponse> {
    const plan = this.buildSiteBuildPlan(data);
    return {
      success: true,
      message: `Planned ${(plan.operations as unknown[]).length} site-build operation(s)`,
      data: plan,
    };
  }

  private async searchArticlesByTitle(title: string): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      "option": "com_content",
      "view": "articles",
      "filter[search]": title,
      "limit": "50",
    });
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    return this.parseArticleList(html);
  }

  private async searchCategoriesByTitle(title: string, extension = "com_content"): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      "option": "com_categories",
      "view": "categories",
      "extension": extension,
      "filter[search]": title,
      "limit": "50",
    });
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    return this.parseCategoryList(html);
  }

  private async searchModulesByTitle(title: string, clientId = "0"): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      "option": "com_modules",
      "view": "modules",
      "client_id": clientId,
      "filter[search]": title,
      "limit": "50",
    });
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    return this.parseModuleList(html);
  }

  private async searchMenuItemsByTitle(title: string, menuId?: string): Promise<Array<Record<string, string>>> {
    const params = new URLSearchParams({
      "option": "com_menus",
      "view": "items",
      "filter[search]": title,
      "limit": "50",
    });
    if (menuId) params.set("menutype", menuId);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    return this.parseMenuItemList(html);
  }

  private async findCategoryByTitle(title: string): Promise<Record<string, string> | null> {
    const categories = await this.searchCategoriesByTitle(title);
    return categories.find((category) => category.title === title) || null;
  }

  private async ensureCategoryByTitle(title: string): Promise<Record<string, string> | null> {
    if (!title) return null;
    const existing = await this.findCategoryByTitle(title);
    if (existing) return existing;
    const created = await this.createCategory({ title, published: "1" });
    if (!created.success) return null;
    return this.findCategoryByTitle(title);
  }

  private async findArticleByTitle(title: string, categoryTitle?: string): Promise<Record<string, string> | null> {
    const items = await this.searchArticlesByTitle(title);
    return items.find((article) => article.title === title && (!categoryTitle || article.category === categoryTitle)) || null;
  }

  private parseIdList(value: unknown): string[] {
    if (typeof value !== "string") return [];
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  private stringifyIdList(values: string[]): string {
    return values.filter(Boolean).join(",");
  }

  private async collectGantryParticleReferences(root: GantryLayoutNode[]): Promise<GantryParticleReference[]> {
    const references: GantryParticleReference[] = [];
    const categoryCache = new Map<string, GantryCategoryReference | null>();
    const articleCache = new Map<string, GantryArticleReference | null>();

    const getCategoryRef = async (id: string): Promise<GantryCategoryReference | null> => {
      if (categoryCache.has(id)) return categoryCache.get(id) || null;
      const category = await this.getCategory(id);
      const data = (category.data || {}) as Record<string, string>;
      const ref = category.success ? { id, title: String(data.title || "") } : null;
      categoryCache.set(id, ref);
      return ref;
    };

    const getArticleRef = async (id: string): Promise<GantryArticleReference | null> => {
      if (articleCache.has(id)) return articleCache.get(id) || null;
      const article = await this.getArticle(id);
      const data = (article.data || {}) as Record<string, string>;
      const splitContent = this.splitArticleText(String(data.content || ""));
      const ref = article.success ? {
        id,
        title: String(data.title || ""),
        alias: String(data.alias || ""),
        categoryId: String(data.categoryId || ""),
        categoryTitle: String(data.categoryName || ""),
        introtext: splitContent.introtext,
        fulltext: splitContent.fulltext,
        state: String(data.state || "1"),
        access: String(data.access || "1"),
      } : null;
      articleCache.set(id, ref);
      return ref;
    };

    const visit = async (node: GantryLayoutNode, path: string[]): Promise<void> => {
      const nodePath = [...path, node.id || node.type || "node"];
      if (node.type === "particle") {
        const articleConfig = (node.attributes || {}).article as Record<string, unknown> | undefined;
        const filter = articleConfig?.filter as Record<string, unknown> | undefined;
        const categoryIds = this.parseIdList(filter?.categories);
        const articleIds = this.parseIdList(filter?.articles);
        if (categoryIds.length || articleIds.length) {
          const categories = (await Promise.all(categoryIds.map((id) => getCategoryRef(id)))).filter((item): item is GantryCategoryReference => !!item);
          const articles = (await Promise.all(articleIds.map((id) => getArticleRef(id)))).filter((item): item is GantryArticleReference => !!item);
          references.push({
            particleId: String(node.id || ""),
            particleTitle: String(node.title || ""),
            particleType: String(node.subtype || ""),
            filterPath: `${nodePath.join(" > ")}.attributes.article.filter`,
            categories,
            articles,
          });
        }
      }
      for (const child of node.children || []) await visit(child, nodePath);
    };

    for (const node of root) await visit(node, []);
    return references;
  }

  private async remapGantryParticleReferences(
    root: GantryLayoutNode[],
    references: GantryParticleReference[],
    options: { dryRun?: boolean } = {}
  ): Promise<{ root: GantryLayoutNode[]; actions: Array<Record<string, unknown>> }> {
    const actions: Array<Record<string, unknown>> = [];
    const categoryMap = new Map<string, string>();
    const articleMap = new Map<string, string>();

    for (const reference of references) {
      for (const category of reference.categories) {
        if (categoryMap.has(category.id)) continue;
        const existing = await this.findCategoryByTitle(category.title);
        const target = existing || (options.dryRun ? null : await this.ensureCategoryByTitle(category.title));
        if (target?.id) {
          categoryMap.set(category.id, target.id);
          actions.push({ type: "mapCategory", sourceId: category.id, sourceTitle: category.title, targetId: target.id });
        } else if (options.dryRun) {
          actions.push({ type: "mapCategory", sourceId: category.id, sourceTitle: category.title, wouldCreateCategory: true });
        }
      }
      for (const article of reference.articles) {
        if (articleMap.has(article.id)) continue;
        const existing = await this.findArticleByTitle(article.title, article.categoryTitle || "Homepage Articles");
        if (existing?.id) {
          articleMap.set(article.id, existing.id);
          actions.push({ type: "mapArticle", sourceId: article.id, sourceTitle: article.title, targetId: existing.id, created: false });
          continue;
        }

        if (options.dryRun) {
          actions.push({
            type: "mapArticle",
            sourceId: article.id,
            sourceTitle: article.title,
            wouldCreateArticle: true,
            category: "Homepage Articles",
          });
          continue;
        }

        const homepageCategory = await this.ensureCategoryByTitle("Homepage Articles");
        if (!homepageCategory?.id) continue;
        const created = await this.createArticle({
          title: article.title,
          alias: article.alias,
          categoryId: homepageCategory.id,
          content: this.buildArticleText(article.introtext, article.fulltext),
          state: article.state || "1",
          access: article.access || "1",
        });
        const createdId = String(((created.data || {}) as Record<string, unknown>).id || "");
        if (created.success && createdId) {
          articleMap.set(article.id, createdId);
          actions.push({ type: "mapArticle", sourceId: article.id, sourceTitle: article.title, targetId: createdId, created: true, category: "Homepage Articles" });
        }
      }
    }

    const visit = (node: GantryLayoutNode): void => {
      if (node.type === "particle") {
        const articleConfig = (node.attributes || {}).article as Record<string, unknown> | undefined;
        const filter = articleConfig?.filter as Record<string, unknown> | undefined;
        if (filter) {
          const categoryIds = this.parseIdList(filter.categories).map((id) => categoryMap.get(id) || id);
          const articleIds = this.parseIdList(filter.articles).map((id) => articleMap.get(id) || id);
          filter.categories = this.stringifyIdList(categoryIds);
          filter.articles = this.stringifyIdList(articleIds);
        }
      }
      for (const child of node.children || []) visit(child);
    };

    for (const node of root) visit(node);
    return { root, actions };
  }

  async applySiteBuild(data: {
    plan?: Record<string, unknown>;
    siteCode?: string;
    suffix?: string;
    menuTitle?: string;
    menuType?: string;
    menuTree?: unknown;
    pageContentCategory?: string;
    homeCategory?: string;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    const plan = data.plan || this.buildSiteBuildPlan({
      siteCode: data.siteCode,
      suffix: data.suffix,
      menuTitle: data.menuTitle,
      menuType: data.menuType,
      menuTree: data.menuTree || [],
      pageContentCategory: data.pageContentCategory,
      homeCategory: data.homeCategory,
    });
    if (!data.confirm) {
      return { success: true, message: "Dry run: site build plan prepared; set confirm=true to apply", data: plan };
    }

    const results: Array<Record<string, unknown>> = [];
    const categoryIds = new Map<string, string>();
    const articleIds = new Map<string, string>();
    const menuItemIds = new Map<string, string>([["root", "1"]]);
    let menuType = String(plan.menuType || "");

    for (const op of (plan.operations || []) as Array<Record<string, unknown>>) {
      if (op.type === "ensureCategory") {
        const existing = await this.findCategoryByTitle(String(op.title));
        if (existing) {
          categoryIds.set(String(op.key || op.title), existing.id);
          results.push({ op, success: true, skipped: true, id: existing.id });
        } else {
          const created = await this.createCategory({ title: String(op.title), published: String(op.published || "1") });
          const idMatch = String(created.html || "").match(/task=category\.edit&amp;id=(\d+)/);
          const found = await this.findCategoryByTitle(String(op.title));
          const id = found?.id || idMatch?.[1] || "";
          categoryIds.set(String(op.key || op.title), id);
          results.push({ op, success: created.success, id, message: created.message });
        }
      } else if (op.type === "ensureMenu") {
        const menus = await this.listMenus();
        const existing = ((menus.data || []) as Array<Record<string, string>>).find((menu) => menu.menuType === op.menuType || menu.title === op.title);
        if (existing) {
          menuType = existing.menuType || String(op.menuType);
          results.push({ op, success: true, skipped: true, menuType });
        } else {
          const created = await this.createMenu({ title: String(op.title), menuType: String(op.menuType) });
          menuType = String(op.menuType);
          results.push({ op, success: created.success, menuType, message: created.message });
        }
      } else if (op.type === "ensureArticle") {
        const category = await this.findCategoryByTitle(String(op.categoryTitle));
        const categoryId = category?.id || categoryIds.get(String(op.categoryTitle)) || "";
        if (!categoryId) {
          results.push({ op, success: false, message: `Missing category: ${op.categoryTitle}` });
          continue;
        }
        const created = await this.createArticle({
          title: String(op.title),
          alias: String(op.alias),
          categoryId,
          content: String(op.introtext || op.content || ""),
          state: String(op.state || "1"),
        });
        const list = await this.listArticles(categoryId);
        const article = ((list.data || []) as Array<Record<string, string>>).find((item) => item.title === op.title);
        if (article?.id) articleIds.set(String(op.key), article.id);
        results.push({ op, success: created.success, id: article?.id || "", message: created.message });
      } else if (op.type === "ensureMenuItem") {
        const parentId = menuItemIds.get(String(op.parentKey || "root")) || "1";
        const request: Record<string, string> = {};
        for (const [key, value] of Object.entries((op.request || {}) as Record<string, string>)) {
          if (value === "{homeCategoryId}") request[key] = categoryIds.get("homeCategory") || "";
          else if (/^\{article:/.test(value)) request[key] = articleIds.get(value.slice(1, -1)) || "";
          else request[key] = value;
        }
        const created = await this.createMenuItem({
          title: String(op.title),
          menuType,
          itemType: String(op.itemType),
          alias: String(op.alias),
          parentId,
          published: String(op.published || "1"),
          home: String(op.home || "0"),
          request,
        });
        const id = String((created.data as Record<string, unknown> | undefined)?.id || "");
        if (id) menuItemIds.set(String(op.key), id);
        results.push({ op, success: created.success, id, message: created.message });
      }
    }

    return {
      success: results.every((result) => result.success),
      message: `Applied ${results.length} site-build operation(s)`,
      data: { plan, results },
    };
  }

  async validateSiteBuild(data: { menuType?: string; plan?: Record<string, unknown> }): Promise<JoomlaResponse> {
    const warnings: Array<Record<string, unknown>> = [];
    const planOps = ((data.plan || {}).operations || []) as Array<Record<string, unknown>>;
    const aliases = new Map<string, number>();
    for (const op of planOps) {
      const alias = String(op.alias || "");
      if (!alias) continue;
      aliases.set(alias, (aliases.get(alias) || 0) + 1);
    }
    for (const [alias, count] of aliases) {
      if (count > 1) warnings.push({ type: "duplicatePlannedAlias", alias, count });
    }

    if (data.menuType) {
      const items = await this.listMenuItems(data.menuType);
      const seenTitles = new Map<string, number>();
      for (const item of (items.data || []) as Array<Record<string, string>>) {
        seenTitles.set(item.title, (seenTitles.get(item.title) || 0) + 1);
        if (item.state === "Unpublished" && !/coming soon|safety committee/i.test(item.title)) {
          warnings.push({ type: "unpublishedMenuItem", id: item.id, title: item.title });
        }
      }
      for (const [title, count] of seenTitles) {
        if (count > 1) warnings.push({ type: "duplicateMenuTitle", title, count });
      }
    }

    return {
      success: warnings.length === 0,
      message: warnings.length ? `Found ${warnings.length} validation warning(s)` : "Validation passed",
      data: { warnings },
    };
  }

  async launchChecklist(data: { menuType?: string; gantryOutline?: string; theme?: string } = {}): Promise<JoomlaResponse> {
    const checks: Array<Record<string, unknown>> = [];
    const categories = await this.listCategories("com_content");
    checks.push({ name: "contentCategories", success: categories.success, count: Array.isArray(categories.data) ? categories.data.length : 0 });
    const menus = await this.listMenus();
    checks.push({ name: "menus", success: menus.success, count: Array.isArray(menus.data) ? menus.data.length : 0 });
    if (data.menuType) {
      const items = await this.listMenuItems(data.menuType);
      checks.push({ name: "menuItems", success: items.success, menuType: data.menuType, count: Array.isArray(items.data) ? items.data.length : 0 });
    }
    const siteConfig = await this.inspectAdminForm("index.php?option=com_siteconfig", "application-form");
    checks.push({ name: "siteConfig", success: siteConfig.success });
    const gantry = await this.getGantry5Layout(data.gantryOutline || "default", { theme: data.theme });
    checks.push({ name: "gantryLayout", success: gantry.success, outline: data.gantryOutline || "default" });
    const redirects = await this.inspectAdminList("index.php?option=com_redir");
    checks.push({ name: "redirects", success: redirects.success, count: (((redirects.data as Record<string, unknown>).rows || []) as unknown[]).length });
    return {
      success: checks.every((check) => check.success),
      message: checks.every((check) => check.success) ? "Launch checklist passed" : "Launch checklist has warnings",
      data: { checks },
    };
  }

  async componentInspect(data: { path: string; mode?: "form" | "list"; formId?: string }): Promise<JoomlaResponse> {
    if (!data.path) return { success: false, message: "path is required" };
    if (data.mode === "form") return this.inspectAdminForm(data.path, data.formId);
    if (data.mode === "list") return this.inspectAdminList(data.path, data.formId || "adminForm");
    const list = await this.inspectAdminList(data.path, data.formId || "adminForm");
    if (list.success && (((list.data as Record<string, unknown>).rows || []) as unknown[]).length > 0) return list;
    return this.inspectAdminForm(data.path, data.formId);
  }

  async mediaList(pathOrFolder = "index.php?option=com_media"): Promise<JoomlaResponse> {
    const pathValue = pathOrFolder.includes("index.php")
      ? pathOrFolder
      : `index.php?option=com_media&folder=${encodeURIComponent(pathOrFolder)}`;

    // Extract the folder parameter so we can build the imagesList URL
    const folderMatch = pathValue.match(/[?&]folder=([^&]*)/);
    const folderParam = folderMatch ? folderMatch[1] : "";

    // Fetch main page (navigation + forms) and imagesList view (actual files in static HTML) in parallel
    const [{ html }, imagesListResult] = await Promise.all([
      this.getPage(this.adminPathToUrl(pathValue)),
      this.getPage(this.getAdminUrl(
        `index.php?option=com_media&view=imagesList&tmpl=component&folder=${folderParam}`
      )),
    ]);

    // Parse folder/nav links from the main page
    const links = this.parseAdminLinks(html)
      .filter((link) => /com_media|task=file|task=folder|download|images\//i.test(link.href + " " + link.text))
      .slice(0, 200);

    // Parse actual files from the imagesList component view (rendered as static img tags)
    const $list = this.$c(imagesListResult.html);
    const files = $list("img[src]").map((_, el) => {
      const $el = $list(el);
      const src = $el.attr("src") || "";
      const name = $el.attr("alt") || src.split("/").pop() || src;
      const $container = $el.closest("li, .imgOutline, div[class*='img']");
      const label = $container.find("a, .imgInfoBar, span").first().text().trim() || name;
      return { name, src, label };
    }).get()
      .filter((f) => f.src && !/media\/system|jui\/img|alpha\.png|administrator\/templates/i.test(f.src))
      .slice(0, 200);

    // Parse subfolders from imagesList: <a href="...&folder=child"> links that are direct children
    const currentFolderDecoded = decodeURIComponent(folderParam);
    const seenPaths = new Set<string>();
    const subfolders: Array<{ label: string; href: string; path: string }> = [];
    $list("a[href*='folder=']").each((_, el) => {
      const href = $list(el).attr("href") || "";
      const fm = href.match(/[?&]folder=([^&]+)/);
      if (!fm) return;
      const linkedPath = decodeURIComponent(fm[1]);
      const expectedPrefix = currentFolderDecoded ? currentFolderDecoded + "/" : "";
      if (expectedPrefix) {
        if (!linkedPath.startsWith(expectedPrefix)) return;
        if (linkedPath.slice(expectedPrefix.length).includes("/")) return;
      } else {
        if (linkedPath.includes("/")) return;
      }
      if (seenPaths.has(linkedPath)) return;
      seenPaths.add(linkedPath);
      const name = linkedPath.split("/").pop() || linkedPath;
      subfolders.push({ label: name, href, path: linkedPath });
    });

    return {
      success: true,
      message: files.length > 0 || subfolders.length > 0
        ? `Found ${files.length} file(s) and ${subfolders.length} subfolder(s) in "${currentFolderDecoded || "root"}"`
        : `No files or subfolders found in "${currentFolderDecoded || "root"}"`,
      data: {
        path: pathValue,
        folder: currentFolderDecoded || "root",
        files,
        subfolders,
        forms: this.parseAdminForms(html).map((form) => ({
          id: form.id,
          action: form.action,
          method: form.method,
          fieldCount: Array.isArray(form.fields) ? form.fields.length : 0,
        })),
        toolbarTasks: this.parseToolbarTasks(html),
      },
      html: html.substring(0, 50000),
    };
  }

  async createMediaFolder(data: { folderName: string; folderBase?: string; path?: string; dryRun?: boolean; confirm?: boolean }): Promise<JoomlaResponse> {
    if (!data.folderName) return { success: false, message: "folderName is required" };
    const path = data.path || "index.php?option=com_media";
    if (data.dryRun || !data.confirm) {
      return this.submitAdminForm(path, {
        overrides: {
          foldername: data.folderName,
          folder: data.folderBase || "",
        },
        task: "folder.create",
        dryRun: data.dryRun ?? !data.confirm,
        confirm: data.confirm,
      });
    }

    const submitted = await this.submitAdminForm(path, {
      overrides: {
        foldername: data.folderName,
        folder: data.folderBase || "",
      },
      task: "folder.create",
      confirm: true,
    });
    if (!submitted.success) return submitted;

    const parentFolder = data.folderBase || "";
    const listing = await this.mediaList(parentFolder || "index.php?option=com_media");
    const listingData = (listing.data || {}) as Record<string, unknown>;
    const subfolders = ((listingData.subfolders || []) as Array<Record<string, string>>);
    const folderMatch = subfolders.some((sf) =>
      String(sf.label || "") === data.folderName
      || decodeURIComponent(String(sf.path || "")).endsWith(`/${data.folderName}`)
      || decodeURIComponent(String(sf.path || "")) === data.folderName
    );

    return {
      success: folderMatch,
      message: folderMatch ? "Media folder created" : "Media folder create submitted, but the new folder was not verified in the media listing",
      data: {
        ...(submitted.data || {}),
        folderName: data.folderName,
        folderBase: data.folderBase || "",
        verification: {
          attempted: true,
          listedAfterCreate: folderMatch,
        },
      },
      html: submitted.html,
    };
  }

  async deleteMedia(data: {
    path: string;
    type?: "file" | "folder";
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    if (!data.path) return { success: false, message: "path is required" };

    const parts = data.path.replace(/\/+$/, "").split("/");
    const name = parts.pop() || "";
    const parentFolder = parts.join("/");
    const isFolder = data.type === "folder";

    if (!name) return { success: false, message: "Invalid path: could not determine file/folder name" };

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: `[DRY RUN] Would delete ${isFolder ? "folder" : "file"} "${data.path}". Pass confirm=true to proceed.`,
        data: { path: data.path, type: isFolder ? "folder" : "file", parentFolder, name, dryRun: true },
      };
    }

    // POST to the task-specific URL so Joomla routes correctly regardless of POST body parsing
    const mediaFolderUrl = this.getAdminUrl(`index.php?option=com_media&folder=${encodeURIComponent(parentFolder)}`);
    const { token } = await this.getPage(mediaFolderUrl);
    // Both J3 controllers (file.delete and folder.delete) read rm[] entries
    // relative to the parent folder passed in `folder`.
    const task = isFolder ? "folder.delete" : "file.delete";
    const payload: FormDataMap = { task, folder: parentFolder, "rm[]": [name] };
    if (token) payload[token.name] = token.value;
    else if (this.tokenName) payload[this.tokenName] = "1";

    const taskUrl = this.getAdminUrl("index.php?option=com_media");
    const result = await this.request(taskUrl, {
      method: "POST",
      body: this.getFormUrlEncoded(payload),
      contentType: "application/x-www-form-urlencoded",
    });
    // Follow redirect
    const status = result.status;
    const redirectLocation = result.headers.get("location") || "";
    if (result.status === 302 || result.status === 303) {
      if (redirectLocation) await this.request(this.resolveUrl(redirectLocation));
    }

    const listing = await this.mediaList(parentFolder || "index.php?option=com_media");
    const listingData = (listing.data || {}) as Record<string, unknown>;
    const listingFiles = (listingData.files || []) as Array<Record<string, string>>;
    const subfolders = (listingData.subfolders || []) as Array<Record<string, string>>;
    const stillExists = isFolder
      ? subfolders.some((f) => f.label === name || decodeURIComponent(f.href || "").includes(`/${name}`))
      : listingFiles.some((f) => f.src?.includes(`/${name}`) || f.name?.startsWith(name));
    const deleted = !stillExists;

    return {
      success: deleted,
      message: deleted
        ? `${isFolder ? "Folder" : "File"} deleted: ${data.path}`
        : `Delete submitted but "${name}" may still exist — check manually`,
      data: {
        path: data.path,
        type: isFolder ? "folder" : "file",
        parentFolder,
        name,
        httpStatus: status,
        payloadSent: payload,
        redirectLocation,
        verification: { attempted: true, deleted },
      },
    };
  }

  async renameMediaFile(data: {
    path: string;
    newName: string;
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    if (!data.path) return { success: false, message: "path is required" };
    if (!data.newName) return { success: false, message: "newName is required" };

    const parts = data.path.split("/");
    const oldName = parts.pop() || "";
    const folder = parts.join("/");
    const fileUrl = `${this.getBaseUrl()}/images/stories/${data.path}`;

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: `[DRY RUN] Would rename "${oldName}" → "${data.newName}" in folder "${folder || "root"}". Pass confirm=true to proceed.`,
        data: { path: data.path, oldName, newName: data.newName, folder, fileUrl, dryRun: true },
      };
    }

    const upload = await this.uploadMediaFile({ fileUrl, fileName: data.newName, folder, confirm: true });
    if (!upload.success) {
      return { success: false, message: `Rename failed: could not upload as "${data.newName}": ${upload.message}`, data: upload.data };
    }

    const del = await this.deleteMedia({ path: data.path, type: "file", confirm: true });

    return {
      success: del.success,
      message: del.success
        ? `Renamed "${oldName}" → "${data.newName}" in "${folder || "root"}"`
        : `Uploaded "${data.newName}" but failed to delete original "${oldName}": ${del.message}`,
      data: {
        path: data.path,
        newPath: folder ? `${folder}/${data.newName}` : data.newName,
        oldName,
        newName: data.newName,
        folder,
        uploadResult: upload.data,
        deleteResult: del.data,
      },
    };
  }

  async moveMediaFile(data: {
    path: string;
    targetFolder: string;
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    if (!data.path) return { success: false, message: "path is required" };
    if (data.targetFolder === undefined) return { success: false, message: "targetFolder is required" };

    const parts = data.path.split("/");
    const fileName = parts.pop() || "";
    const sourceFolder = parts.join("/");
    const fileUrl = `${this.getBaseUrl()}/images/stories/${data.path}`;

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: `[DRY RUN] Would move "${fileName}" from "${sourceFolder || "root"}" to "${data.targetFolder || "root"}". Pass confirm=true to proceed.`,
        data: { path: data.path, fileName, sourceFolder, targetFolder: data.targetFolder, fileUrl, dryRun: true },
      };
    }

    const upload = await this.uploadMediaFile({ fileUrl, fileName, folder: data.targetFolder, confirm: true });
    if (!upload.success) {
      return { success: false, message: `Move failed: could not upload to "${data.targetFolder}": ${upload.message}`, data: upload.data };
    }

    const del = await this.deleteMedia({ path: data.path, type: "file", confirm: true });

    return {
      success: del.success,
      message: del.success
        ? `Moved "${fileName}" from "${sourceFolder || "root"}" → "${data.targetFolder || "root"}"`
        : `Uploaded to "${data.targetFolder}" but failed to delete source "${data.path}": ${del.message}`,
      data: {
        path: data.path,
        newPath: data.targetFolder ? `${data.targetFolder}/${fileName}` : fileName,
        fileName,
        sourceFolder,
        targetFolder: data.targetFolder,
        uploadResult: upload.data,
        deleteResult: del.data,
      },
    };
  }

  async listSponsors(): Promise<JoomlaResponse> {
    return this.inspectAdminList("index.php?option=com_sponsors&view=sponsors");
  }

  async inspectSponsor(pathOrUrl = "index.php?option=com_sponsors&view=sponsor&layout=edit"): Promise<JoomlaResponse> {
    return this.inspectAdminForm(pathOrUrl);
  }

  // ==================== DOCMAN JSON API ====================

  private async docmanApiCall(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    data?: Record<string, string>
  ): Promise<{ success: boolean; entity: Record<string, unknown> | null; entities: Array<Record<string, unknown>>; meta: Record<string, unknown>; error?: string }> {
    if (!this.tokenName) {
      await this.getPage(this.getAdminUrl("index.php?option=com_docman&view=documents"));
    }
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const additionalHeaders: Record<string, string> = {
      "Origin": baseUrl,
      "Referer": this.getAdminUrl("index.php?option=com_docman&view=documents"),
      "Accept": "application/json",
    };
    let body: string | undefined;
    let url = this.getAdminUrl(path);
    if ((method === "POST" || method === "PATCH") && data !== undefined) {
      const payload: Record<string, string> = { ...(data || {}) };
      if (this.tokenName) payload[this.tokenName] = "1";
      body = this.getFormUrlEncoded(payload);
    } else if (method === "DELETE" && this.tokenName) {
      url = url + (url.includes("?") ? "&" : "?") + `${this.tokenName}=1`;
    }
    const result = await this.request(url, {
      method,
      body,
      contentType: body ? "application/x-www-form-urlencoded" : undefined,
      additionalHeaders,
    });
    if (!result.body || result.body.trim() === "") {
      return { success: true, entity: null, entities: [], meta: {} };
    }
    try {
      const json = JSON.parse(result.body) as Record<string, unknown>;
      if (json.errors) {
        const errors = json.errors as Array<{ message?: string }>;
        return { success: false, entity: null, entities: [], meta: {}, error: errors[0]?.message || "Unknown error" };
      }
      const entities = (json.entities || []) as Array<Record<string, unknown>>;
      const meta = (json.meta || {}) as Record<string, unknown>;
      return { success: true, entity: entities[0] || null, entities, meta };
    } catch {
      return { success: false, entity: null, entities: [], meta: {}, error: "Failed to parse JSON response" };
    }
  }

  private mapDocmanDocument(e: Record<string, unknown>): Record<string, unknown> {
    return {
      id: e.id,
      title: e.title,
      slug: e.slug,
      categoryId: e.docman_category_id,
      categoryTitle: e.category_title,
      categoryPath: e.category_path,
      enabled: e.enabled,
      status: e.status,
      access: e.access,
      description: e.description,
      storagePath: e.storage_path,
      storageType: e.storage_type,
      extension: e.extension,
      size: e.size,
      createdOn: e.created_on,
      modifiedOn: e.modified_on,
      editUrl: this.getAdminUrl(`index.php?option=com_docman&view=document&id=${e.id}&format=json`),
    };
  }

  private mapDocmanCategory(e: Record<string, unknown>): Record<string, unknown> {
    return {
      id: e.id,
      title: e.title,
      slug: e.slug,
      parentId: e.parent_id,
      hierarchyTitle: e.hierarchy_title,
      enabled: e.enabled,
      access: e.access,
      description: e.description,
      folder: e.folder,
      createdOn: e.created_on,
      modifiedOn: e.modified_on,
      editUrl: this.getAdminUrl(`index.php?option=com_docman&view=category&id=${e.id}&format=json`),
    };
  }

  async listDocmanDocuments(): Promise<JoomlaResponse> {
    const result = await this.docmanApiCall("index.php?option=com_docman&view=documents&format=json");
    if (!result.success) return { success: false, message: result.error || "Failed to list documents" };
    const total = (result.meta as Record<string, unknown>)?.total ?? result.entities.length;
    return {
      success: true,
      message: `Found ${total} document(s)`,
      data: result.entities.map(e => this.mapDocmanDocument(e)),
    };
  }

  async listDocmanCategories(): Promise<JoomlaResponse> {
    const result = await this.docmanApiCall("index.php?option=com_docman&view=categories&format=json");
    if (!result.success) return { success: false, message: result.error || "Failed to list categories" };
    const total = (result.meta as Record<string, unknown>)?.total ?? result.entities.length;
    return {
      success: true,
      message: `Found ${total} category(ies)`,
      data: result.entities.map(e => this.mapDocmanCategory(e)),
    };
  }

  async getDocmanDocument(id: string): Promise<JoomlaResponse> {
    const result = await this.docmanApiCall(`index.php?option=com_docman&view=document&id=${id}&format=json`);
    if (!result.success) return { success: false, message: result.error || "Failed to get document" };
    if (!result.entity) return { success: false, message: "Document not found" };
    return { success: true, message: "OK", data: this.mapDocmanDocument(result.entity) };
  }

  async getDocmanCategory(id: string): Promise<JoomlaResponse> {
    const result = await this.docmanApiCall(`index.php?option=com_docman&view=category&id=${id}&format=json`);
    if (!result.success) return { success: false, message: result.error || "Failed to get category" };
    if (!result.entity) return { success: false, message: "Category not found" };
    return { success: true, message: "OK", data: this.mapDocmanCategory(result.entity) };
  }

  async createDocmanDocument(data: {
    title: string;
    categoryId: string;
    storageType?: string;
    storagePath?: string;
    description?: string;
    access?: string;
    enabled?: string;
  }): Promise<JoomlaResponse> {
    const payload: Record<string, string> = {
      title: data.title,
      docman_category_id: data.categoryId,
      storage_type: data.storageType ?? "file",
      // DOCman leaves access "0" when omitted, which hides the document on the
      // frontend — default new documents to Public like the admin UI does.
      access: data.access ?? "1",
    };
    if (data.storagePath !== undefined) payload.storage_path = data.storagePath;
    if (data.description !== undefined) payload.description = data.description;
    if (data.enabled !== undefined) payload.enabled = data.enabled;
    const result = await this.docmanApiCall("index.php?option=com_docman&view=document&format=json", "POST", payload);
    if (!result.success) return { success: false, message: result.error || "Failed to create document" };
    if (!result.entity) return { success: false, message: "Document created but no entity returned" };
    return { success: true, message: "Document created", data: this.mapDocmanDocument(result.entity) };
  }

  async createDocmanCategory(data: {
    title: string;
    parentId?: string;
    description?: string;
    access?: string;
    enabled?: string;
  }): Promise<JoomlaResponse> {
    const payload: Record<string, string> = { title: data.title };
    if (data.parentId !== undefined) payload.parent_id = data.parentId;
    if (data.description !== undefined) payload.description = data.description;
    if (data.access !== undefined) payload.access = data.access;
    if (data.enabled !== undefined) payload.enabled = data.enabled;
    const result = await this.docmanApiCall("index.php?option=com_docman&view=category&format=json", "POST", payload);
    if (!result.success) return { success: false, message: result.error || "Failed to create category" };
    if (!result.entity) return { success: false, message: "Category created but no entity returned" };
    return { success: true, message: "Category created", data: this.mapDocmanCategory(result.entity) };
  }

  async updateDocmanDocument(id: string, data: {
    title?: string;
    categoryId?: string;
    storagePath?: string;
    description?: string;
    access?: string;
    enabled?: string;
  }): Promise<JoomlaResponse> {
    const payload: Record<string, string> = {};
    if (data.title !== undefined) payload.title = data.title;
    if (data.categoryId !== undefined) payload.docman_category_id = data.categoryId;
    if (data.storagePath !== undefined) payload.storage_path = data.storagePath;
    if (data.description !== undefined) payload.description = data.description;
    if (data.access !== undefined) payload.access = data.access;
    if (data.enabled !== undefined) payload.enabled = data.enabled;
    const result = await this.docmanApiCall(`index.php?option=com_docman&view=document&id=${id}&format=json`, "PATCH", payload);
    if (!result.success) return { success: false, message: result.error || "Failed to update document" };
    if (!result.entity) return { success: false, message: "Document updated but no entity returned" };
    return { success: true, message: "Document updated", data: this.mapDocmanDocument(result.entity) };
  }

  async updateDocmanCategory(id: string, data: {
    title?: string;
    parentId?: string;
    description?: string;
    access?: string;
    enabled?: string;
  }): Promise<JoomlaResponse> {
    const payload: Record<string, string> = {};
    if (data.title !== undefined) payload.title = data.title;
    if (data.parentId !== undefined) payload.parent_id = data.parentId;
    if (data.description !== undefined) payload.description = data.description;
    if (data.access !== undefined) payload.access = data.access;
    if (data.enabled !== undefined) payload.enabled = data.enabled;
    const result = await this.docmanApiCall(`index.php?option=com_docman&view=category&id=${id}&format=json`, "PATCH", payload);
    if (!result.success) return { success: false, message: result.error || "Failed to update category" };
    if (!result.entity) return { success: false, message: "Category updated but no entity returned" };
    return { success: true, message: "Category updated", data: this.mapDocmanCategory(result.entity) };
  }

  async deleteDocmanDocument(id: string): Promise<JoomlaResponse> {
    const result = await this.docmanApiCall(`index.php?option=com_docman&view=document&id=${id}&format=json`, "DELETE");
    if (!result.success) return { success: false, message: result.error || "Failed to delete document" };
    return { success: true, message: "Document deleted", data: { id } };
  }

  async deleteDocmanCategory(id: string): Promise<JoomlaResponse> {
    const result = await this.docmanApiCall(`index.php?option=com_docman&view=category&id=${id}&format=json`, "DELETE");
    if (!result.success) return { success: false, message: result.error || "Failed to delete category" };
    return { success: true, message: "Category deleted", data: { id } };
  }

  async listFilemanFiles(folder?: string): Promise<JoomlaResponse> {
    // FILEman's admin page is a Koowa JS app with no static table — scraping it
    // always yields 0 rows. Use its JSON API instead (same pattern as DOCman).
    if (!this.tokenName) {
      await this.getPage(this.getAdminUrl("index.php?option=com_fileman"));
    }
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const additionalHeaders: Record<string, string> = {
      "Origin": baseUrl,
      "Referer": this.getAdminUrl("index.php?option=com_fileman"),
      "Accept": "application/json",
    };
    const fetchJson = async (path: string) => {
      const result = await this.request(this.getAdminUrl(path), { additionalHeaders });
      let entities: Array<Record<string, unknown>> = [];
      try {
        const json = JSON.parse(result.body) as Record<string, unknown>;
        entities = (json.entities || []) as Array<Record<string, unknown>>;
      } catch {
        // non-JSON body falls through with empty entities; status carries the error
      }
      return { status: result.status, entities };
    };

    const cleanFolder = (folder || "").replace(/^\/+|\/+$/g, "");
    const [files, folders] = await Promise.all([
      fetchJson(`index.php?option=com_fileman&view=files&folder=${encodeURIComponent(cleanFolder)}&format=json&limit=500`),
      fetchJson("index.php?option=com_fileman&view=folders&format=json&limit=500"),
    ]);

    // FILEman answers 410 for a folder that doesn't exist in the container
    if (files.status === 410) {
      return { success: false, message: `FILEman folder not found: "${cleanFolder}"` };
    }
    if (files.status >= 400) {
      return { success: false, message: `FILEman API error (HTTP ${files.status}) listing "${cleanFolder || "root"}"` };
    }

    // The folders view returns every folder in the container — keep direct children only
    const prefix = cleanFolder ? `${cleanFolder}/` : "";
    const subfolders = folders.entities
      .map((e) => ({
        name: String(e.name ?? ""),
        path: String(e.path ?? ""),
        fileCount: e.file_count ?? null,
      }))
      .filter((f) => {
        if (!f.path.startsWith(prefix)) return false;
        const rest = f.path.slice(prefix.length);
        return rest.length > 0 && !rest.includes("/");
      });

    const fileList = files.entities.map((e) => {
      const meta = (e.metadata || {}) as Record<string, unknown>;
      const modifiedTs = typeof meta.modified_date === "number" ? meta.modified_date : null;
      return {
        name: String(e.name ?? ""),
        path: e.path ?? (cleanFolder ? `${cleanFolder}/${e.name}` : e.name),
        folder: e.folder ?? cleanFolder,
        type: e.type ?? null,
        size: meta.size ?? null,
        extension: meta.extension ?? null,
        mimetype: meta.mimetype ?? null,
        modified: modifiedTs ? new Date(modifiedTs * 1000).toISOString() : null,
      };
    });

    return {
      success: true,
      message: `Found ${fileList.length} file(s) and ${subfolders.length} subfolder(s) in "${cleanFolder || "root"}"`,
      data: { folder: cleanFolder || "root", files: fileList, subfolders },
    };
  }

  async listRedirects(): Promise<JoomlaResponse> {
    return this.inspectAdminList("index.php?option=com_redir");
  }

  async inspectSiteConfig(): Promise<JoomlaResponse> {
    return this.inspectAdminForm("index.php?option=com_siteconfig", "application-form");
  }

  async listSubsites(): Promise<JoomlaResponse> {
    return this.inspectAdminList("index.php?option=com_subsites");
  }

  // ==================== AUTH ====================

  async login(): Promise<JoomlaResponse> {
    // Clear any cached Gantry URLs so a fresh login always starts fresh
    this.gantryEntryUrl = null;
    this.gantryOutlineLayoutUrls.clear();
    this.gantryLayoutRootCache.clear();
    const loginUrl = this.getAdminUrl();
    const result = await this.getPage(loginUrl, { skipAuthCheck: true });
    const token = this.extractCsrfToken(result.html);

    if (!token) {
      if (this.looksLoggedIn(result.html)) {
        return {
          success: true,
          message: "Already logged in",
          html: result.html,
        };
      }

      return {
        success: false,
        message: "Failed to extract CSRF token from login page",
        html: result.html,
      };
    }

    const formData: Record<string, string> = {
      username: this.config.username,
      passwd: this.config.password,
      option: "com_login",
      task: "login",
      return: "aW5kZXgucGhw",
      [token.name]: token.value,
    };

    // Reuse the login page we just fetched — postPage would otherwise GET it a
    // second time, and that duplicate is what the host's rate limiter blocks.
    const postResult = await this.postPage(loginUrl, formData, { prefetchedHtml: result.html });

    // Check success
    if (postResult.html.includes("mod-login-username") || postResult.html.includes("Empty password")) {
      // Login failed - still on login page
      const errorMsg = this.extractAlertMessage(postResult.html);
      return {
        success: false,
        message: errorMsg ?? "Login failed",
        html: postResult.html,
      };
    }

    // Login successful
    this.tokenName = this.extractCsrfToken(postResult.html)?.name || this.tokenName;
    return {
      success: true,
      message: "Login successful",
      html: postResult.html,
    };
  }

  async logout(): Promise<JoomlaResponse> {
    return this.postPage(this.getAdminUrl(), {
      option: "com_login",
      task: "logout",
      [this.tokenName || ""] : "1",
    }).then((r) => ({
      success: r.status === 200,
      message: "Logged out",
      html: r.html,
    }));
  }

  async isLoggedIn(): Promise<boolean> {
    const { html } = await this.getPage(this.getAdminUrl("index.php"));
    return this.looksLoggedIn(html);
  }

  // ==================== ARTICLES ====================

  async listArticles(categoryId?: string, state?: string, limit?: number, page?: number, search?: string): Promise<JoomlaResponse> {
    const effectiveLimit = Math.min(limit ?? 200, 500);
    const effectivePage = Math.max(page ?? 1, 1);
    const limitStart = (effectivePage - 1) * effectiveLimit;
    const params = new URLSearchParams({
      "option": "com_content",
      "view": "articles",
      "limit": String(effectiveLimit),
      "limitstart": String(limitStart),
    });
    if (categoryId) params.set("filter[category_id]", categoryId);
    if (state !== undefined && state !== "") params.set("filter[published]", state);
    if (search) params.set("filter[search]", search);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const articles = this.parseArticleList(html);
    return {
      success: true,
      message: `Found ${articles.length} articles (page ${effectivePage}, limit ${effectiveLimit}${search ? `, search="${search}"` : ""})`,
      data: articles,
      html,
    };
  }

  private parseArticleList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const articles: Array<Record<string, string>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const $titleLink = $row.find("a[href*='task=article.edit']").first();
      const title = $titleLink.text().trim();
      if (!title) return;
      const rowHtml = $.html($row) || "";
      const $titleTd = $titleLink.closest("td");
      const $smallDiv = $titleTd.find("div.small").first();
      const $catLink = $smallDiv.find("a").first();
      let category = $catLink.text().trim();
      if (!category) {
        const smallText = $smallDiv.text().trim();
        const colonIdx = smallText.indexOf(": ");
        category = colonIdx >= 0 ? smallText.slice(colonIdx + 2).trim() : smallText;
      }
      const catHref = $catLink.attr("href") || "";
      const catIdMatch = catHref.match(/filter\[category_id\]=(\d+)/);
      const categoryId = catIdMatch ? catIdMatch[1] : "";
      articles.push({
        id: cid,
        title,
        state: this.extractPublishedState(rowHtml),
        category: category || "Unknown",
        categoryId,
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml) ? "1" : "0",
      });
    });
    return articles;
  }

  /** The token is returned so callers can post follow-up tasks without re-fetching a page. */
  private async fetchArticleForm(id: string): Promise<JoomlaResponse & { token?: { name: string; value: string } | null }> {
    const url = this.getAdminUrl(`index.php?option=com_content&task=article.edit&id=${id}`);
    const { html, token } = await this.getPage(url);
    const article = this.parseArticleForm(html);
    return {
      success: !!article.title,
      message: article.title ? "Article retrieved" : "Failed to parse article form",
      data: article,
      html,
      token,
    };
  }

  async getArticle(id?: string, title?: string): Promise<JoomlaResponse> {
    if (!id && !title) return { success: false, message: "Either id or title is required" };
    if (!id && title) {
      const matches = await this.searchArticlesByTitle(title);
      if (matches.length === 0) return { success: false, message: `No article found matching title '${title}'` };
      if (matches.length === 1) return this.getArticle(matches[0].id);
      return { success: true, message: `Multiple articles found for '${title}' — provide id to get full details`, data: matches };
    }
    const result = await this.fetchArticleForm(id!);
    if (result.success) {
      // Release the checkout the edit form just took. This used to call the full
      // checkInArticle tool, which re-fetched the form and listed every article to
      // verify a target this method had already read.
      const released = await this.quickCheckInArticle(id!, result.token ?? null);
      if (!released) {
        result.message = (result.message ?? "") + " (warning: auto-checkin failed)";
      }
    }
    const { token: _token, ...response } = result;
    return response;
  }

  private parseArticleForm(html: string): Record<string, string> {
    const fields = this.extractFormFields(html);
    const article: Record<string, string> = {};

    article.title = this.getJFormField(fields, "title");
    article.alias = this.getJFormField(fields, "alias");
    article.categoryId = this.getJFormField(fields, "catid");

    article.categoryName = this.$c(html)("select[id='jform_catid'] option[selected]").first().text().trim();

    article.state = this.getJFormField(fields, "state");
    article.content = this.getJFormField(fields, "articletext");
    article.access = this.getJFormField(fields, "access", "1");
    article.note = this.getJFormField(fields, "note");

    article.introImage = this.firstValue(fields["jform[images][image_intro]"]);
    article.introImageAlt = this.firstValue(fields["jform[images][image_intro_alt]"]);
    article.featuredImage = this.firstValue(fields["jform[images][image_fulltext]"])
      || this.firstValue(fields["hidden-image"]);
    article.featuredImageAlt = this.firstValue(fields["jform[images][image_fulltext_alt]"]);

    return article;
  }

  async createArticle(data: {
    title: string;
    alias?: string;
    categoryId: string;
    content?: string;
    state?: string;
    access?: string;
    introImage?: string;
    introImageAlt?: string;
    featuredImage?: string;
    featuredImageAlt?: string;
  }): Promise<JoomlaResponse> {
    const newArticleUrl = this.getAdminUrl("index.php?option=com_content&view=article&layout=edit");
    const { html } = await this.getPage(newArticleUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: FormDataMap = {
      ...this.extractFormFields(html),
      // "apply" (not "save") redirects back to the edit form with &id=<new> in the URL —
      // "save" redirects to the list view with no id, forcing every create through the
      // flaky title-scan fallback below. Apply gives a reliable id on the fast path.
      task: "article.apply",
      "jform[title]": data.title,
      "jform[alias]": data.alias || "",
      "jform[catid]": data.categoryId,
      "jform[articletext]": data.content || "",
      "jform[state]": data.state ?? "1",
      "jform[access]": data.access ?? "1",
      [token.name]: token.value,
    };

    if (data.introImage !== undefined) formData["jform[images][image_intro]"] = data.introImage;
    if (data.introImageAlt !== undefined) formData["jform[images][image_intro_alt]"] = data.introImageAlt;
    if (data.featuredImage !== undefined) {
      formData["jform[images][image_fulltext]"] = data.featuredImage;
      formData["hidden-image"] = data.featuredImage;
    }
    if (data.featuredImageAlt !== undefined) formData["jform[images][image_fulltext_alt]"] = data.featuredImageAlt;

    // Reuse the add form we just fetched — postPage would otherwise re-GET it, and the
    // article edit form is the heaviest page in the admin (~1.4MB with the editor).
    const result = await this.postPage(newArticleUrl, formData, { prefetchedHtml: html });

    // Accept a redirect (302/303) as a success signal — Joomla 3 always redirects on save,
    // and the destination page (article list) may not contain "Article saved" text.
    const successMsg = result.redirected || result.html.includes("Article saved") || result.html.includes("The article has been saved");
    const errorMsg = this.extractAlertMessage(result.html);

    let createdId = "";
    if (successMsg) {
      // Fastest path: Joomla sometimes redirects to the edit form with ?id=<newId> — grab it directly.
      const idFromRedirect = result.redirectUrl?.match(/[?&]id=(\d+)/)?.[1] ?? "";
      createdId = idFromRedirect;

      if (!createdId) {
        // Fallback: scan the category list. Narrow to the target category so we don't
        // pick up an unrelated article with the same title.
        const listed = await this.listArticles(data.categoryId);
        const found = this.findLatestByTitle((listed.data || []) as Array<Record<string, string>>, data.title);
        createdId = found?.id || "";
      }

      if (!createdId) {
        // One retry after a short delay — handles the DB commit timing window where
        // the article exists on the server but hasn't propagated to the list view yet.
        await new Promise((r) => setTimeout(r, 600));
        const listedRetry = await this.listArticles(data.categoryId);
        const foundRetry = this.findLatestByTitle((listedRetry.data || []) as Array<Record<string, string>>, data.title);
        createdId = foundRetry?.id || "";
      }
    }
    const expectedArticleText = data.content || "";
    const buildVerification = (verify: JoomlaResponse | null) => {
      const article = ((verify?.data || {}) as Record<string, string>);
      return {
        attempted: true,
        foundInList: !!createdId,
        readbackSucceeded: !!verify?.success,
        titleMatches: !!verify?.success && this.decodeHtmlEntities(article.title) === this.decodeHtmlEntities(data.title),
        aliasMatches: !!verify?.success && this.verifyAlias(String(article.alias || ""), data.alias),
        categoryMatches: !!verify?.success && article.categoryId === data.categoryId,
        stateMatches: !!verify?.success && article.state === String(data.state ?? "1"),
        accessMatches: !!verify?.success && article.access === String(data.access ?? "1"),
        articleTextMatches: !!verify?.success && this.isEquivalentRichText(String(article.content || ""), expectedArticleText),
      };
    };

    // task=article.apply redirects to the new article's own edit form, so result.html is
    // already the readback — no need to fetch that ~1.4MB page again. apply leaves the
    // article checked out either way, so release it once we have the values.
    const applyHtmlIsForm = /view=article\b/.test(result.redirectUrl ?? "") && /layout=edit/.test(result.redirectUrl ?? "");
    let verify: JoomlaResponse | null = null;
    let verifyToken: { name: string; value: string } | null = null;
    if (createdId && applyHtmlIsForm) {
      const parsed = this.parseArticleForm(result.html);
      if (parsed.title) {
        verify = { success: true, message: "Article retrieved", data: parsed };
        verifyToken = this.extractCsrfToken(result.html);
      }
    }
    if (createdId && !verify) {
      const fetched = await this.fetchArticleForm(createdId);
      verify = fetched;
      verifyToken = fetched.token ?? null;
    }
    let verification = buildVerification(verify);
    let verified = Object.values(verification).every((value) => value === true);
    // Read-after-write lag: the row can exist server-side before a readback reflects
    // it, especially under concurrent/parallel creates. Retry the readback (not just
    // the list-scan above) before reporting an unverified create.
    if (createdId && !verified) {
      await new Promise((r) => setTimeout(r, 800));
      const retry = await this.fetchArticleForm(createdId);
      verify = retry;
      verifyToken = retry.token ?? null;
      verification = buildVerification(verify);
      verified = Object.values(verification).every((value) => value === true);
    }
    if (createdId) await this.quickCheckInArticle(createdId, verifyToken);
    const article = ((verify?.data || {}) as Record<string, string>);

    return {
      success: verified,
      message: verified ? "Article saved" : (errorMsg ?? (successMsg ? "Article save submitted, but creation was not verified" : "Article save was rejected by Joomla and no alert message was returned")),
      data: this.buildOperationData("article", createdId || "", {
        title: article.title || data.title,
        state: article.state || String(data.state ?? "1"),
        verification: this.collapseVerification(verification, verified),
      }),
      html: result.html,
    };
    }

  async updateArticle(
    id: string,
    data: {
      title?: string;
      alias?: string;
      categoryId?: string;
      content?: string;
      state?: string;
      access?: string;
      ordering?: string;
      introImage?: string;
      introImageAlt?: string;
      featuredImage?: string;
      featuredImageAlt?: string;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_content&task=article.edit&id=${id}`);
    let { html } = await this.getPage(editUrl);
    let existingArticle = this.parseArticleForm(html);

    if (!existingArticle.title) {
      await this.checkInArticle(id);
      const retry = await this.getPage(editUrl);
      html = retry.html;
      existingArticle = this.parseArticleForm(html);
      if (!existingArticle.title) {
        return { success: false, message: `Article ${id} form could not be loaded after auto check-in — article may not exist or may require elevated permissions` };
      }
    }

    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const content = data.content ?? existingArticle.content;
    const formData: FormDataMap = {
      ...this.extractFormFields(html),
      // "apply" rather than "save": both persist identically, but apply redirects back to
      // this article's edit form, so the response IS the readback — and that form is
      // ~1.4MB, so not fetching it twice is the single biggest saving here.
      task: "article.apply",
      "jform[title]": data.title ?? existingArticle.title,
      "jform[alias]": data.alias ?? existingArticle.alias,
      "jform[catid]": data.categoryId ?? existingArticle.categoryId,
      "jform[articletext]": content,
      "jform[state]": data.state ?? existingArticle.state,
      "jform[access]": data.access ?? existingArticle.access,
      "jform[images][image_intro]": data.introImage ?? existingArticle.introImage ?? "",
      "jform[images][image_intro_alt]": data.introImageAlt ?? existingArticle.introImageAlt ?? "",
      "jform[images][image_fulltext]": data.featuredImage ?? existingArticle.featuredImage ?? "",
      "hidden-image": data.featuredImage ?? existingArticle.featuredImage ?? "",
      "jform[images][image_fulltext_alt]": data.featuredImageAlt ?? existingArticle.featuredImageAlt ?? "",
      [token.name]: token.value,
    };

    if (data.ordering !== undefined) {
      formData["jform[ordering]"] = data.ordering;
    }

    const result = await this.postPage(editUrl, formData, { prefetchedHtml: html });
    const successMsg = result.html.includes("Article saved") || result.html.includes("The article has been saved");
    const errorMsg = this.extractAlertMessage(result.html);
    let verify: JoomlaResponse | null = null;
    let verifyToken: { name: string; value: string } | null = null;
    if (/view=article\b/.test(result.redirectUrl ?? "") && /layout=edit/.test(result.redirectUrl ?? "")) {
      const parsed = this.parseArticleForm(result.html);
      if (parsed.title) {
        verify = { success: true, message: "Article retrieved", data: parsed };
        verifyToken = this.extractCsrfToken(result.html);
      }
    }
    if (!verify) {
      const fetched = await this.fetchArticleForm(id);
      verify = fetched;
      verifyToken = fetched.token ?? null;
    }
    await this.quickCheckInArticle(id, verifyToken);
    const article = (verify.data || {}) as Record<string, string>;
    const expectedTitle = String(formData["jform[title]"] || "");
    const expectedAlias = String(formData["jform[alias]"] || "");
    const expectedCategoryId = String(formData["jform[catid]"] || "");
    const expectedArticleText = String(formData["jform[articletext]"] || "");
    const expectedState = String(formData["jform[state]"] || "");
    const expectedAccess = String(formData["jform[access]"] || "");
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success,
      titleMatches: verify.success && this.decodeHtmlEntities(article.title) === this.decodeHtmlEntities(expectedTitle),
      aliasMatches: verify.success && article.alias === expectedAlias,
      categoryMatches: verify.success && article.categoryId === expectedCategoryId,
      articleTextMatches: verify.success && this.isEquivalentRichText(String(article.content || ""), expectedArticleText),
      stateMatches: verify.success && article.state === expectedState,
      accessMatches: verify.success && article.access === expectedAccess,
    };
    const verified = Object.values(verification).every((value) => value === true);

    return {
      success: verified,
      message: verified ? "Article saved" : (errorMsg ?? (successMsg ? "Article save submitted, but updated values were not verified" : "Unknown result")),
      data: this.buildOperationData("article", id, {
        title: article.title || expectedTitle,
        state: article.state || expectedState,
        verification: this.collapseVerification(verification, verified),
      }),
      html: result.html,
    };
    }

  async deleteArticle(id: string, options: { expectedTitle?: string } = {}): Promise<JoomlaResponse> {
    // Read the edit form directly rather than through getArticle: the token it yields
    // authenticates the trash task below, and articles.trash fails on a checked-out
    // article, so the checkout this read takes must be released first anyway.
    const before = await this.fetchArticleForm(id);
    const articleBefore = (before.data || {}) as Record<string, string>;
    const title = articleBefore.title || "";
    const token = before.token ?? null;
    if (!before.success) {
      return { success: false, message: `Refusing to delete article ${id} because the current target could not be verified` };
    }
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }
    // Release before the guard below, not after: the read above checked the article out,
    // and a guard that refuses the delete still has to leave the record unlocked.
    await this.quickCheckInArticle(id, token);
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to delete article ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }

    // Post the task at the single-row list URL so its redirect target doubles as the
    // "is it still listed?" check, without listing every article on the site.
    const listUrl = this.getArticlesListUrl(`id:${id}`);
    const result = await this.postPage(listUrl, { task: "articles.trash", "cid[]": id }, { token });
    const successMsg = /article[s]?\s+(trashed|deleted)|has been (trashed|deleted)/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const stillListed = this.parseArticleList(result.html).some((entry) => entry.id === id);
    const verify = await this.fetchArticleForm(id);
    if (verify.success) await this.quickCheckInArticle(id, verify.token ?? null);
    const verified = !stillListed && (successMsg || this.isDeletionVerified(stillListed, verify, ["published", "state"]));

    return {
      success: verified,
      message: verified ? "Article trashed" : (errorMsg ?? (successMsg ? "Article trash submitted, but deletion was not verified" : "Unknown result")),
      data: this.buildOperationData("article", id, {
        title,
        state: "-2",
        verification: {
          attempted: true,
          preflightVerified: true,
          stillListed,
          readbackSucceeded: verify.success,
          verified,
        },
      }),
      html: result.html,
    };
    }

  async checkInArticle(id: string, options: { expectedTitle?: string } = {}): Promise<JoomlaResponse> {
    // Address exactly this row, so the preflight, the task, and the verification all
    // read a single-row page instead of every article on the site.
    const listUrl = this.getArticlesListUrl(`id:${id}`);
    const { html: listHtml } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(listHtml);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    if (options.expectedTitle) {
      const articles = this.parseArticleList(listHtml);
      const match = articles.find((a) => a.id === id);
      if (match && match.title !== options.expectedTitle) {
        return { success: false, message: `Refusing to check in article ${id}: expected title '${options.expectedTitle}', found '${match.title}'` };
      }
    }

    // The page above supplies the token, and the task's redirect target is the same
    // filtered list, so it doubles as the verification read.
    const result = await this.postPage(listUrl, {
      task: "articles.checkin",
      "cid[]": id,
      boxchecked: "1",
    }, { token });
    const errorMsg = this.extractAlertMessage(result.html);

    let listedArticle = this.parseArticleList(result.html).find((entry) => entry.id === id);
    if (!listedArticle) {
      const verifyPage = await this.getPage(listUrl);
      listedArticle = this.parseArticleList(verifyPage.html).find((entry) => entry.id === id);
    }
    const checkedOutCleared = !!listedArticle && listedArticle.checkedOut !== "1";

    return {
      success: checkedOutCleared,
      message: checkedOutCleared ? "Article checked in" : (errorMsg ?? "Article check-in submitted, but checkout state was not verified as cleared"),
      data: this.buildOperationData("article", id, {
        title: listedArticle?.title ?? "",
        state: String(listedArticle?.state || ""),
        verification: {
          attempted: true,
          listedAfterCheckIn: !!listedArticle,
          checkedOutCleared,
        },
      }),
      html: result.html,
    };
  }

  // ==================== CATEGORIES ====================

  async listCategories(extension = "com_content", limit = 200, page = 1, search?: string): Promise<JoomlaResponse> {
    const effectiveLimit = Math.min(limit, 500);
    const effectivePage = Math.max(page, 1);
    const limitStart = (effectivePage - 1) * effectiveLimit;
    const params = new URLSearchParams({
      "option": "com_categories",
      "view": "categories",
      "extension": extension,
      "limit": String(effectiveLimit),
      "limitstart": String(limitStart),
    });
    if (search) params.set("filter[search]", search);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const categories = this.parseCategoryList(html);
    return {
      success: true,
      message: `Found ${categories.length} categories (page ${effectivePage}, limit ${effectiveLimit}${search ? `, search="${search}"` : ""})`,
      data: categories,
      html,
    };
  }

  private parseCategoryList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const categories: Array<Record<string, string>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const title = $row.find("a[href*='task=category.edit']").first().text().trim();
      if (!title) return;
      const rowHtml = $.html($row) || "";
      categories.push({
        id: cid,
        title,
        state: this.extractPublishedState(rowHtml),
        parent: "Root",
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml) ? "1" : "0",
      });
    });
    return categories;
  }

  /** The token is returned so callers can post follow-up tasks without re-fetching a page. */
  private async fetchCategoryForm(id: string): Promise<JoomlaResponse & { token?: { name: string; value: string } | null }> {
    const url = this.getAdminUrl(`index.php?option=com_categories&task=category.edit&id=${id}&extension=com_content`);
    const { html, token } = await this.getPage(url);
    const category = this.parseCategoryForm(html);

    return {
      success: !!category.title,
      message: category.title ? "Category retrieved" : "Failed to parse category form",
      data: category,
      html,
      token,
    };
  }

  async getCategory(id?: string, title?: string): Promise<JoomlaResponse> {
    if (!id && !title) return { success: false, message: "Either id or title is required" };
    if (!id && title) {
      const matches = await this.searchCategoriesByTitle(title);
      if (matches.length === 0) return { success: false, message: `No category found matching title '${title}'` };
      if (matches.length === 1) return this.getCategory(matches[0].id);
      return { success: true, message: `Multiple categories found for '${title}' — provide id to get full details`, data: matches };
    }
    const result = await this.fetchCategoryForm(id!);
    if (result.success) {
      // Release the checkout the edit form just took. This used to call the full
      // checkInCategory tool, which re-fetched the form and listed every category to
      // verify a target this method had already read.
      const released = await this.quickCheckInCategory(id!, result.token ?? null);
      if (!released) {
        result.message = (result.message ?? "") + " (warning: auto-checkin failed)";
      }
    }
    const { token: _token, ...response } = result;
    return response;
  }

  async createCategory(data: {
    title: string;
    alias?: string;
    parentId?: string;
    description?: string;
    published?: string;
    extension?: string;
  }): Promise<JoomlaResponse> {
    const ext = data.extension || "com_content";
    const newCatUrl = this.getAdminUrl(
      `index.php?option=com_categories&view=category&layout=edit&extension=${ext}`
    );
    const { html } = await this.getPage(newCatUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: FormDataMap = {
      ...this.extractFormFields(html),
      // See createArticle: "apply" gives a reliable &id= on redirect, "save" doesn't.
      task: "category.apply",
      "jform[title]": data.title,
      "jform[alias]": data.alias || "",
      "jform[parent_id]": data.parentId || "1",
      "jform[description]": data.description || "",
      "jform[published]": data.published ?? "1",
      "jform[access]": "1",
      [token.name]: token.value,
    };

    // Reuse the add form we just fetched — postPage would otherwise re-GET it.
    const result = await this.postPage(newCatUrl, formData, { prefetchedHtml: html });
    // Accept a redirect (302/303) as a success signal — same pattern as createArticle.
    const successMsg = result.redirected || result.html.includes("Category saved") || result.html.includes("has been saved");
    const errorMsg = this.extractAlertMessage(result.html);

    let createdId = "";
    if (successMsg) {
      // Fastest path: extract the category ID from the redirect URL if present.
      const idFromRedirect = result.redirectUrl?.match(/[?&]id=(\d+)/)?.[1] ?? "";
      createdId = idFromRedirect;

      if (!createdId) {
        const listed = await this.listCategories(ext);
        const found = this.findLatestByTitle((listed.data || []) as Array<Record<string, string>>, data.title);
        createdId = found?.id || "";
      }

      if (!createdId) {
        // One retry after a short delay — handles DB commit timing window.
        await new Promise((r) => setTimeout(r, 600));
        const listedRetry = await this.listCategories(ext);
        const foundRetry = this.findLatestByTitle((listedRetry.data || []) as Array<Record<string, string>>, data.title);
        createdId = foundRetry?.id || "";
      }
    }
    // task=category.apply redirects to the new category's own edit form, so result.html
    // is already the readback. apply leaves it checked out, so release it afterwards.
    let verify: JoomlaResponse | null = null;
    let verifyToken: { name: string; value: string } | null = null;
    if (createdId && /view=category\b/.test(result.redirectUrl ?? "") && /layout=edit/.test(result.redirectUrl ?? "")) {
      const parsed = this.parseCategoryForm(result.html);
      if (parsed.title) {
        verify = { success: true, message: "Category retrieved", data: parsed };
        verifyToken = this.extractCsrfToken(result.html);
      }
    }
    if (createdId && !verify) {
      const fetched = await this.fetchCategoryForm(createdId);
      verify = fetched;
      verifyToken = fetched.token ?? null;
    }
    const buildVerification = (verify: JoomlaResponse | null) => {
      const category = ((verify?.data || {}) as Record<string, string>);
      return {
        attempted: true,
        foundInList: !!createdId,
        readbackSucceeded: !!verify?.success,
        titleMatches: !!verify?.success && this.decodeHtmlEntities(category.title) === this.decodeHtmlEntities(data.title),
        aliasMatches: !!verify?.success && this.verifyAlias(String(category.alias || ""), data.alias),
        parentMatches: !!verify?.success && category.parentId === String(data.parentId || "1"),
        descriptionMatches: !!verify?.success && this.isEquivalentRichText(String(category.description || ""), String(data.description || "")),
        publishedMatches: !!verify?.success && category.published === String(data.published ?? "1"),
      };
    };
    let verification = buildVerification(verify);
    let verified = Object.values(verification).every((value) => value === true);
    // Read-after-write lag: the row can exist server-side before a readback reflects
    // it, especially under concurrent/parallel creates. Retry the readback (not just
    // the list-scan above) before reporting an unverified create. Same fix as
    // createArticle — see [[joomla_article]] self-improving history.
    if (createdId && !verified) {
      await new Promise((r) => setTimeout(r, 800));
      const retry = await this.fetchCategoryForm(createdId);
      verify = retry;
      verifyToken = retry.token ?? null;
      verification = buildVerification(verify);
      verified = Object.values(verification).every((value) => value === true);
    }
    if (createdId) await this.quickCheckInCategory(createdId, verifyToken);
    const category = ((verify?.data || {}) as Record<string, string>);

    return {
      success: verified,
      message: verified ? "Category saved" : (errorMsg ?? (successMsg ? "Category save submitted, but creation was not verified" : "Category save was rejected by Joomla and no alert message was returned")),
      data: this.buildOperationData("category", createdId || "", {
        title: category.title || data.title,
        state: category.published || String(data.published ?? "1"),
        verification: this.collapseVerification(verification, verified),
      }),
      html: result.html,
    };
    }

  async updateCategory(
    id: string,
    data: {
      title?: string;
      alias?: string;
      parentId?: string;
      description?: string;
      published?: string;
      ordering?: string;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_categories&task=category.edit&id=${id}&extension=com_content`);
    const { html } = await this.getPage(editUrl);
    const existingCategory = this.parseCategoryForm(html);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: FormDataMap = {
      ...this.extractFormFields(html),
      // "apply" rather than "save": both persist identically, but apply redirects back
      // to this category's edit form, so the response IS the verification readback.
      task: "category.apply",
      "jform[title]": data.title ?? existingCategory.title,
      "jform[alias]": data.alias ?? existingCategory.alias,
      "jform[parent_id]": data.parentId ?? existingCategory.parentId,
      "jform[description]": data.description ?? existingCategory.description,
      "jform[published]": data.published ?? existingCategory.published,
      "jform[access]": existingCategory.access || "1",
      [token.name]: token.value,
    };

    const result = await this.postPage(editUrl, formData, { prefetchedHtml: html });
    const successMsg = result.html.includes("Category saved") || result.html.includes("has been saved");
    const errorMsg = this.extractAlertMessage(result.html);
    // The apply redirect lands on this category's edit form, so parse the response we
    // already have. Fall back to an explicit read if Joomla redirected elsewhere.
    let verify: JoomlaResponse | null = null;
    let verifyToken: { name: string; value: string } | null = null;
    if (/view=category\b/.test(result.redirectUrl ?? "") && /layout=edit/.test(result.redirectUrl ?? "")) {
      const parsed = this.parseCategoryForm(result.html);
      if (parsed.title) {
        verify = { success: true, message: "Category retrieved", data: parsed };
        verifyToken = this.extractCsrfToken(result.html);
      }
    }
    if (!verify) {
      const fetched = await this.fetchCategoryForm(id);
      verify = fetched;
      verifyToken = fetched.token ?? null;
    }
    await this.quickCheckInCategory(id, verifyToken);
    const category = (verify.data || {}) as Record<string, string>;
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success,
      titleMatches: verify.success && this.decodeHtmlEntities(category.title) === this.decodeHtmlEntities(String(formData["jform[title]"] || "")),
      aliasMatches: verify.success && category.alias === String(formData["jform[alias]"] || ""),
      parentMatches: verify.success && category.parentId === String(formData["jform[parent_id]"] || ""),
      descriptionMatches: verify.success && this.isEquivalentRichText(String(category.description || ""), String(formData["jform[description]"] || "")),
      publishedMatches: verify.success && category.published === String(formData["jform[published]"] || ""),
    };
    const verified = Object.values(verification).every((value) => value === true);

    let reorderResult: { success: boolean; message: string } | undefined;
    if (data.ordering !== undefined) {
      reorderResult = await this.reorderCategory(id, data.ordering);
    }

    const overallSuccess = verified && (reorderResult === undefined || reorderResult.success);

    return {
      success: overallSuccess,
      message: overallSuccess
        ? "Category saved"
        : reorderResult && !reorderResult.success
          ? `Category saved but reorder failed: ${reorderResult.message}`
          : (errorMsg ?? (successMsg ? "Category save submitted, but updated values were not verified" : "Unknown result")),
      data: this.buildOperationData("category", id, {
        title: category.title || String(formData["jform[title]"] || ""),
        state: category.published || String(formData["jform[published]"] || ""),
        verification: {
          ...this.collapseVerification(verification, verified),
          ...(reorderResult !== undefined ? { reorderSuccess: reorderResult.success } : {}),
        },
      }),
      html: result.html,
    };
  }

  private async reorderCategory(id: string, afterId: string): Promise<{ success: boolean; message: string }> {
    const listUrl = this.getAdminUrl(
      "index.php?option=com_categories&view=categories&extension=com_content&limit=500&filter_order=a.lft&filter_order_Dir=asc"
    );
    const { html } = await this.getPage(listUrl);

    const $ = this.$c(html);
    const ids: string[] = [];
    $("tr").each((_, el) => {
      const cid = $(el).find("input[name='cid[]']").attr("value");
      if (cid) ids.push(cid);
    });

    if (!ids.includes(id)) {
      return { success: false, message: `Category ${id} not found in list` };
    }

    const withoutTarget = ids.filter((cid) => cid !== id);

    let insertIndex: number;
    if (afterId === "-1") {
      insertIndex = 0;
    } else {
      const afterIndex = withoutTarget.indexOf(afterId);
      if (afterIndex === -1) {
        return { success: false, message: `Sibling category ${afterId} not found` };
      }
      insertIndex = afterIndex + 1;
    }

    const reordered = [...withoutTarget];
    reordered.splice(insertIndex, 0, id);

    const token = this.extractCsrfToken(html);
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const saveUrl = this.getAdminUrl("index.php?option=com_categories&extension=com_content");
    const formBody = this.getFormUrlEncoded({
      task: "categories.saveorder",
      [token.name]: token.value,
      "cid[]": reordered,
      "order[]": reordered.map((_, i) => String(i + 1)),
    });

    const result = await this.request(saveUrl, {
      method: "POST",
      body: formBody,
      contentType: "application/x-www-form-urlencoded",
    });

    if (result.status === 302 || result.status === 303) {
      return { success: true, message: "Category reordered" };
    }

    try {
      const json = JSON.parse(result.body) as Record<string, unknown>;
      return {
        success: json["success"] !== false,
        message: String(json["message"] || (json["success"] !== false ? "Category reordered" : "Saveorder failed")),
      };
    } catch {
      const errorMsg = this.extractAlertMessage(result.body);
      return {
        success: !errorMsg,
        message: errorMsg || "Category reordered",
      };
    }
  }

  private parseCategoryForm(html: string): Record<string, string> {
    const fields = this.extractFormFields(html);
    const category: Record<string, string> = {};

    category.title = this.getJFormField(fields, "title");
    category.alias = this.getJFormField(fields, "alias");
    category.parentId = this.getJFormField(fields, "parent_id", "1");
    category.description = this.getJFormField(fields, "description");
    category.published = this.getJFormField(fields, "published", "1");
    category.access = this.getJFormField(fields, "access", "1");

    return category;
  }

  async deleteCategory(id: string, options: { expectedTitle?: string } = {}): Promise<JoomlaResponse> {
    // Read the edit form directly rather than through getCategory: the token it yields
    // authenticates the trash task below, and categories.trash fails on a checked-out
    // category, so the checkout this read takes must be released first anyway.
    const before = await this.fetchCategoryForm(id);
    const categoryBefore = (before.data || {}) as Record<string, string>;
    const title = categoryBefore.title || "";
    const token = before.token ?? null;
    if (!before.success) {
      return { success: false, message: `Refusing to delete category ${id} because the current target could not be verified` };
    }
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }
    // Release before the guard below, not after: the read above checked the category out,
    // and a guard that refuses the delete still has to leave the record unlocked.
    await this.quickCheckInCategory(id, token);
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to delete category ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }

    // Post the task at the single-row list URL so its redirect target doubles as the
    // "is it still listed?" check, without listing every category on the site.
    const listUrl = this.getCategoriesListUrl(`id:${id}`);
    const result = await this.postPage(listUrl, { task: "categories.trash", "cid[]": id }, { token });
    const successMsg = /categor(y|ies)\s+(trashed|deleted)|has been (trashed|deleted)/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const stillListed = this.parseCategoryList(result.html).some((entry) => entry.id === id);
    const verify = await this.fetchCategoryForm(id);
    if (verify.success) await this.quickCheckInCategory(id, verify.token ?? null);
    const verified = this.isDeletionVerified(stillListed, verify, ["published", "state"]);

    return {
      success: verified,
      message: verified ? "Category trashed" : (errorMsg ?? (successMsg ? "Category trash submitted, but deletion was not verified" : "Unknown result")),
      data: this.buildOperationData("category", id, {
        title,
        state: "-2",
        verification: {
          attempted: true,
          preflightVerified: true,
          stillListed,
          readbackSucceeded: verify.success,
          verified,
        },
      }),
      html: result.html,
    };
    }

  async checkInCategory(id: string, options: { expectedTitle?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.fetchCategoryForm(id);
    const categoryBefore = (before.data || {}) as Record<string, string>;
    const title = categoryBefore.title || "";
    if (!before.success) {
      return { success: false, message: `Refusing to check in category ${id} because the current target could not be verified` };
    }

    const token = before.token ?? null;
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }
    // Release before the guard below, not after: the read above checked the category out,
    // and a check-in tool that refuses must not itself leave the record locked.
    await this.quickCheckInCategory(id, token);
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to check in category ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }

    // The preflight above holds a valid session token, so the task needs no page fetch
    // of its own, and its redirect target — the single-row list — is the verification read.
    const listUrl = this.getCategoriesListUrl(`id:${id}`);
    const result = await this.postPage(listUrl, {
      task: "categories.checkin",
      "cid[]": id,
      boxchecked: "1",
    }, { token });
    const errorMsg = this.extractAlertMessage(result.html);

    let listedCategory = this.parseCategoryList(result.html).find((entry) => entry.id === id);
    if (!listedCategory) {
      const verifyPage = await this.getPage(listUrl);
      listedCategory = this.parseCategoryList(verifyPage.html).find((entry) => entry.id === id);
    }
    const checkedOutCleared = !!listedCategory && listedCategory.checkedOut !== "1";

    return {
      success: checkedOutCleared,
      message: checkedOutCleared ? "Category checked in" : (errorMsg ?? "Category check-in submitted, but checkout state was not verified as cleared"),
      data: this.buildOperationData("category", id, {
        title,
        state: String(listedCategory?.state || ""),
        verification: {
          attempted: true,
          preflightVerified: true,
          listedAfterCheckIn: !!listedCategory,
          checkedOutCleared,
        },
      }),
      html: result.html,
    };
  }

  // ==================== MODULES ====================

  async listModules(clientId = "0", search?: string, limit?: number, page?: number): Promise<JoomlaResponse> {
    const effectiveLimit = Math.min(limit ?? 200, 500);
    const effectivePage = Math.max(page ?? 1, 1);
    const limitStart = (effectivePage - 1) * effectiveLimit;
    const params = new URLSearchParams({
      "option": "com_modules",
      "view": "modules",
      "client_id": clientId,
      "limit": String(effectiveLimit),
      "limitstart": String(limitStart),
    });
    if (search) params.set("filter[search]", search);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const modules = this.parseModuleList(html);
    return {
      success: true,
      message: `Found ${modules.length} modules (page ${effectivePage}, limit ${effectiveLimit}${search ? `, search="${search}"` : ""})`,
      data: modules,
      html,
    };
  }

  private parseModuleList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const modules: Array<Record<string, string>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const title = $row.find("a[href*='task=module.edit']").first().text().trim();
      if (!title) return;
      const rowHtml = $.html($row) || "";
      const cells = $row.find("td").map((_, td) => $(td).text().trim()).get();
      const state = this.extractPublishedState(rowHtml);
      modules.push({
        id: cid,
        title,
        state,
        enabled: state,
        position: cells[4] || "",
        moduleType: cells[5] || "",
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml) ? "1" : "0",
      });
    });
    return modules;
  }

  private parseModuleTypes(html: string): ModuleType[] {
    const $ = this.$c(html);
    const types: ModuleType[] = [];
    $("a[href*='option=com_modules'][href*='task=module.add']").each((_, el) => {
      const $el = $(el);
      const href = $el.attr("href") || "";
      const idMatch = href.match(/eid=(\d+)/);
      if (idMatch) {
        types.push({
          id: idMatch[1],
          title: $el.text().trim(),
          href,
        });
      }
    });
    return types;
  }

  private findModuleType(types: ModuleType[], moduleType: string): ModuleType | null {
    const lowered = moduleType.toLowerCase();
    return types.find((type) =>
      type.id === moduleType ||
      type.title.toLowerCase() === lowered ||
      (type.module || "").toLowerCase() === lowered
    ) || null;
  }

  /**
   * Rank candidate types so the likely match is probed first.
   *
   * The module select page lists display titles ("Custom", "Articles - Archived") and
   * never the mod_* name, so a request for "mod_custom" cannot be matched from the list
   * alone — each candidate's add form has to be opened to read its real name. Probing in
   * page order meant ~9 types (18 requests) before reaching Custom. Comparing the
   * stripped name against the normalised title puts the right one first.
   */
  private scoreModuleTypeCandidate(type: ModuleType, strippedName: string): number {
    const normalisedTitle = type.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalisedTitle === strippedName) return 0;
    if (normalisedTitle.startsWith(strippedName) || strippedName.startsWith(normalisedTitle)) return 1;
    if (normalisedTitle.includes(strippedName)) return 2;
    return 3;
  }

  private async resolveModuleType(types: ModuleType[], moduleType: string, clientId = "0"): Promise<ModuleType | null> {
    const direct = this.findModuleType(types, moduleType);
    if (direct) return direct;

    const lowered = moduleType.toLowerCase();
    // The eid for a given mod_* name is fixed for the life of the install, so one probe
    // per name per session is enough — a batch build creating many modules of the same
    // type used to repeat the whole search for every single one.
    const cacheKey = `${clientId}:${lowered}`;
    const cached = this._moduleTypeCache.get(cacheKey);
    if (cached) return cached;

    const strippedName = lowered.replace(/^mod_/, "").replace(/[^a-z0-9]/g, "");
    const ordered = [...types].sort(
      (a, b) => this.scoreModuleTypeCandidate(a, strippedName) - this.scoreModuleTypeCandidate(b, strippedName)
    );

    for (const type of ordered) {
      const addUrl = this.getAdminUrl(`index.php?option=com_modules&task=module.add&eid=${type.id}&client_id=${clientId}`);
      const { html } = await this.getPage(addUrl);
      const parsed = this.parseModuleForm(html);
      const actualModule = String(parsed.moduleType || "").toLowerCase();
      if (actualModule === lowered) {
        const resolved = { ...type, module: String(parsed.moduleType || "") };
        this._moduleTypeCache.set(cacheKey, resolved);
        return resolved;
      }
    }

    return null;
  }

  private parseModuleForm(html: string): Record<string, unknown> {
    const fields = this.extractFormFields(html, "module-form");
    const module: Record<string, unknown> = {};
    const params: Record<string, string> = {};
    const advanced: Record<string, string> = {};
    // FormDataMap, not Record<string,string>: multi-valued names such as
    // jform[assigned][] must be reported as the array they are. Flattening them
    // here made `get` under-report a module's page assignments.
    const fieldOverrides: FormDataMap = {};

    for (const [key, value] of Object.entries(fields)) {
      const paramsMatch = key.match(/^jform\[params\]\[([^\]]+)\]$/);
      const advancedMatch = key.match(/^jform\[advanced\]\[([^\]]+)\]$/);
      if (paramsMatch) params[paramsMatch[1]] = this.firstValue(value);
      if (advancedMatch) advanced[advancedMatch[1]] = this.firstValue(value);
      if (!paramsMatch && !advancedMatch) fieldOverrides[key] = value;
    }

    module.id = this.getJFormField(fields, "id");
    module.title = this.getJFormField(fields, "title");
    module.clientId = this.getJFormField(fields, "client_id", "0");
    module.position = this.getJFormField(fields, "position");
    module.published = this.getJFormField(fields, "published", "1");
    module.access = this.getJFormField(fields, "access", "1");
    module.moduleType = this.getJFormField(fields, "module");
    module.showtitle = this.getJFormField(fields, "showtitle", "1");
    module.ordering = this.getJFormField(fields, "ordering", "0");
    module.style = this.getJFormField(fields, "style", "0");
    module.language = this.getJFormField(fields, "language", "*");
    module.note = this.getJFormField(fields, "note");
    module.assignment = this.getJFormField(fields, "assignment", "0");
    module.assigned = this.extractCheckedValues(html, "jform[assigned][]");
    module.content = this.getJFormField(fields, "content");
    module.params = params;
    module.advanced = advanced;
    module.fieldOverrides = fieldOverrides;
    module.positions = this.extractSelectOptions(html, "jform_position");
    module.assignmentOptions = this.extractSelectOptions(html, "jform_assignment");
    return module;
  }

  private sanitizeBlueprintFileName(fileName: string, fallback: string): string {
    return (fileName || fallback).replace(/[^a-zA-Z0-9_.-]/g, "_");
  }

  private omitModuleBlueprintFields(fields: Record<string, string>): Record<string, string> {
    const omitted = new Set([
      "task",
      "boxchecked",
      "return",
      "id",
      "jform[id]",
      "jform[title]",
      "jform[module]",
      "jform[client_id]",
      "jform[position]",
      "jform[published]",
      "jform[access]",
      "jform[showtitle]",
      "jform[ordering]",
      "jform[style]",
      "jform[language]",
      "jform[note]",
      "jform[assignment]",
      "jform[content]",
      "jform[assigned][]",
    ]);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields || {})) {
      if (/^[a-f0-9]{32}$/i.test(key)) continue;
      if (omitted.has(key)) continue;
      result[key] = value;
    }
    return result;
  }

  private parseModuleFieldCatalog(html: string): Record<string, unknown> {
    const fields = this.extractFormFields(html, "module-form");
    const fieldNames = Object.keys(fields);
    const paramFields = fieldNames
      .map((name) => name.match(/^jform\[params\]\[([^\]]+)\]$/)?.[1])
      .filter((name): name is string => !!name);
    const advancedFields = fieldNames
      .map((name) => name.match(/^jform\[advanced\]\[([^\]]+)\]$/)?.[1])
      .filter((name): name is string => !!name);

    return {
      fieldNames,
      paramFields,
      advancedFields,
      positions: this.extractSelectOptions(html, "jform_position"),
      assignmentOptions: this.extractSelectOptions(html, "jform_assignment"),
      assignmentMenuItemIds: Array.from(new Set(Array.from(html.matchAll(/name=["']jform\[assigned\]\[\]["'][^>]*value=["']([^"']+)["']/g)).map((match) => match[1]))),
    };
  }

  async listModuleTypes(clientId = "0"): Promise<JoomlaResponse> {
    const url = this.getAdminUrl(`index.php?option=com_modules&view=select&client_id=${clientId}`);
    const { html } = await this.getPage(url);
    const blacklist = this.config.moduleTypeBlacklist;
    const types = this.parseModuleTypes(html).filter(
      (t) => !blacklist || !blacklist.has(t.title.toLowerCase())
    );

    return {
      success: true,
      message: `Found ${types.length} module types`,
      data: types,
      html,
    };
  }

  async listModulePositions(clientId = "0"): Promise<JoomlaResponse> {
    const typesResult = await this.listModuleTypes(clientId);
    const custom = ((typesResult.data || []) as ModuleType[]).find((type) => type.title.toLowerCase() === "custom") ||
      ((typesResult.data || []) as ModuleType[])[0];

    if (!custom) {
      return { success: false, message: "No module types found to inspect positions" };
    }

    const { html } = await this.getPage(this.getAdminUrl(`index.php?option=com_modules&task=module.add&eid=${custom.id}`));
    const positions = this.extractSelectOptions(html, "jform_position").filter((position) => position.value);

    return {
      success: true,
      message: `Found ${positions.length} module positions`,
      data: positions,
      html,
    };
  }

  async inspectModuleType(moduleType: string, clientId = "0"): Promise<JoomlaResponse> {
    const typesResult = await this.listModuleTypes(clientId);
    const types = (typesResult.data || []) as ModuleType[];
    const type = this.findModuleType(types, moduleType);

    if (!type) {
      return {
        success: false,
        message: `Module type not found: ${moduleType}`,
        data: types,
      };
    }

    const { html } = await this.getPage(this.getAdminUrl(`index.php?option=com_modules&task=module.add&eid=${type.id}`));
    return {
      success: true,
      message: "Module type retrieved",
      data: {
        ...type,
        ...this.parseModuleFieldCatalog(html),
        commonFields: [
          "title",
          "position",
          "published",
          "access",
          "showtitle",
          "ordering",
          "style",
          "language",
          "note",
          "assignment",
          "assigned",
        ],
      },
      html,
    };
  }

  /** The token is returned so callers can post follow-up tasks without re-fetching a page. */
  private async fetchModuleForm(id: string): Promise<JoomlaResponse & { token?: { name: string; value: string } | null }> {
    const url = this.getAdminUrl(`index.php?option=com_modules&task=module.edit&id=${id}`);
    const { html, token } = await this.getPage(url);
    const module = this.parseModuleForm(html);

    return {
      success: !!module.title,
      message: module.title ? "Module retrieved" : "Failed to parse module form",
      data: module,
      html,
      token,
    };
  }

  async getModule(id?: string, title?: string, clientId = "0"): Promise<JoomlaResponse> {
    if (!id && !title) return { success: false, message: "Either id or title is required" };
    if (!id && title) {
      const matches = await this.searchModulesByTitle(title, clientId);
      if (matches.length === 0) return { success: false, message: `No module found matching title '${title}'` };
      if (matches.length === 1) return this.getModule(matches[0].id);
      return { success: true, message: `Multiple modules found for '${title}' — provide id to get full details`, data: matches };
    }
    const result = await this.fetchModuleForm(id!);
    if (result.success) {
      // Release the checkout the edit form just took. This used to call the full
      // checkInModule tool, which re-fetched the form and listed every module to verify
      // a target this method had already read.
      const released = await this.quickCheckInModule(id!, result.token ?? null);
      if (!released) {
        result.message = (result.message ?? "") + " (warning: auto-checkin failed)";
      }
    }
    const { token: _token, ...response } = result;
    return response;
  }

  async exportModuleBlueprint(
    id: string,
    options: {
      format?: "json" | "yaml";
      saveToFile?: boolean;
      fileName?: string;
    } = {}
  ): Promise<JoomlaResponse> {
    const result = await this.getModule(id);
    if (!result.success) return result;

    const module = (result.data || {}) as Record<string, unknown>;
    const format = (options.format || "yaml").toLowerCase() === "json" ? "json" : "yaml";
    const blueprint: ModuleBlueprint = {
      kind: "joomla-module-blueprint",
      version: 1,
      exportedAt: new Date().toISOString(),
      source: {
        id,
        title: String(module.title || ""),
        moduleType: String(module.moduleType || ""),
      },
      module: {
        title: String(module.title || ""),
        moduleType: String(module.moduleType || ""),
        clientId: String(module.clientId || "0"),
        position: String(module.position || ""),
        published: String(module.published || "1"),
        access: String(module.access || "1"),
        showtitle: String(module.showtitle || "1"),
        ordering: String(module.ordering || "0"),
        style: String(module.style || "0"),
        language: String(module.language || "*"),
        note: String(module.note || ""),
        assignment: String(module.assignment || "0"),
        assigned: Array.isArray(module.assigned) ? (module.assigned as string[]) : [],
        content: typeof module.content === "string" ? module.content : undefined,
        params: (module.params || {}) as Record<string, string>,
        advanced: (module.advanced || {}) as Record<string, string>,
        fieldOverrides: this.omitModuleBlueprintFields((module.fieldOverrides || {}) as Record<string, string>),
      },
    };

    const serialized = format === "yaml"
      ? yaml.dump(blueprint, { noRefs: true, lineWidth: 120 })
      : JSON.stringify(blueprint, null, 2);

    let filePath = "";
    if (options.saveToFile) {
      mkdirSync(this.getBlueprintDir("modules"), { recursive: true });
      const safeTitle = String(module.title || `module-${id}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
      const ext = format === "yaml" ? "yaml" : "json";
      const fileName = this.sanitizeBlueprintFileName(options.fileName || `${safeTitle}.${ext}`, `${safeTitle}.${ext}`);
      filePath = path.join(this.getBlueprintDir("modules"), fileName);
      writeFileSync(filePath, serialized, "utf8");
    }

    return {
      success: true,
      message: "Module blueprint exported",
      data: {
        id,
        format,
        filePath,
        blueprint,
        serialized,
      },
    };
  }

  async importModuleBlueprint(data: {
    blueprint?: Record<string, unknown>;
    blueprintText?: string;
    format?: "json" | "yaml";
    filePath?: string;
    title?: string;
    clientId?: string;
    position?: string;
    published?: string;
    access?: string;
    showtitle?: string;
    ordering?: string;
    style?: string;
    language?: string;
    note?: string;
    assignment?: string;
    assigned?: string[];
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    let blueprint = data.blueprint;

    if (!blueprint && data.filePath) {
      const fileText = readFileSync(path.resolve(process.cwd(), data.filePath), "utf8");
      const fileFormat = (data.format || (data.filePath.toLowerCase().endsWith(".yaml") || data.filePath.toLowerCase().endsWith(".yml") ? "yaml" : "json")).toLowerCase();
      blueprint = (fileFormat === "yaml" ? yaml.load(fileText) : JSON.parse(fileText)) as Record<string, unknown>;
    }

    if (!blueprint && data.blueprintText) {
      const format = (data.format || "json").toLowerCase();
      blueprint = (format === "yaml" ? yaml.load(data.blueprintText) : JSON.parse(data.blueprintText)) as Record<string, unknown>;
    }

    if (!blueprint || typeof blueprint !== "object") {
      return { success: false, message: "blueprint, blueprintText, or filePath is required" };
    }

    const module = (blueprint.module || {}) as Record<string, unknown>;
    const payload = {
      title: data.title ?? String(module.title || ""),
      moduleType: String(module.moduleType || ""),
      clientId: data.clientId ?? String(module.clientId || "0"),
      position: data.position ?? String(module.position || ""),
      published: data.published ?? String(module.published || "1"),
      access: data.access ?? String(module.access || "1"),
      showtitle: data.showtitle ?? String(module.showtitle || "1"),
      ordering: data.ordering ?? String(module.ordering || "0"),
      style: data.style ?? String(module.style || "0"),
      language: data.language ?? String(module.language || "*"),
      note: data.note ?? String(module.note || ""),
      assignment: data.assignment ?? String(module.assignment || "0"),
      assigned: data.assigned ?? (Array.isArray(module.assigned) ? (module.assigned as string[]) : []),
      content: typeof module.content === "string" ? module.content : undefined,
      params: ((module.params || {}) as Record<string, string>),
      advanced: ((module.advanced || {}) as Record<string, string>),
      fieldOverrides: ((module.fieldOverrides || {}) as Record<string, string>),
    };

    if (!payload.title || !payload.moduleType) {
      return { success: false, message: "Blueprint module.title and module.moduleType are required" };
    }

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: data.dryRun ? "Dry run: module blueprint parsed and ready" : "Blueprint parsed; set confirm=true to create the module",
        data: payload,
      };
    }

    const created = await this.createModule(payload);
    if (!created.success) return created;

    const modules = await this.listModules(payload.clientId || "0");
    const items = (modules.data || []) as Array<Record<string, string>>;
    const latest = this.findLatestByTitle(items, payload.title);

    return {
      success: true,
      message: "Module blueprint imported",
      data: {
        createdId: latest?.id || "",
        title: payload.title,
        moduleType: payload.moduleType,
        clientId: payload.clientId,
        source: (blueprint.source || {}) as Record<string, unknown>,
      },
    };
  }

  async updateModule(
    id: string,
    data: {
      title?: string;
      position?: string;
      published?: string;
      access?: string;
      showtitle?: string;
      ordering?: string;
      style?: string;
      language?: string;
      note?: string;
      assignment?: string;
      assigned?: string[];
      content?: string;
      params?: Record<string, string>;
      advanced?: Record<string, string>;
      fieldOverrides?: Record<string, string>;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_modules&task=module.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const existingModule = this.parseModuleForm(html);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: FormDataMap = {
      ...this.extractFormFields(html),
      // "apply" rather than "save": both persist identically, but apply redirects back
      // to this module's edit form, so the response IS the verification readback.
      task: "module.apply",
      "jform[title]": data.title ?? String(existingModule.title || ""),
      "jform[position]": data.position ?? String(existingModule.position || ""),
      "jform[published]": data.published ?? String(existingModule.published || "1"),
      "jform[access]": data.access ?? String(existingModule.access || "1"),
      "jform[showtitle]": data.showtitle ?? String(existingModule.showtitle || "1"),
      "jform[ordering]": data.ordering ?? String(existingModule.ordering || "0"),
      "jform[style]": data.style ?? String(existingModule.style || "0"),
      "jform[module]": String(existingModule.moduleType || "mod_custom"),
      "jform[language]": data.language ?? String(existingModule.language || "*"),
      "jform[note]": data.note ?? String(existingModule.note || ""),
      "jform[assignment]": data.assignment ?? String(existingModule.assignment || "0"),
      [token.name]: token.value,
    };

    if (data.content !== undefined) {
      formData["jform[content]"] = data.content;
    }

    if (data.assigned) {
      formData["jform[assigned][]"] = data.assigned;
    }

    for (const [key, value] of Object.entries(data.params || {})) {
      formData[`jform[params][${key}]`] = value;
    }

    for (const [key, value] of Object.entries(data.advanced || {})) {
      formData[`jform[advanced][${key}]`] = value;
    }

    Object.assign(formData, data.fieldOverrides || {});

    const result = await this.postPage(editUrl, formData, { prefetchedHtml: html });
    const successMsg = result.html.includes("Module saved") || result.html.includes("has been saved");
    const errorMsg = this.extractAlertMessage(result.html);
    // The apply redirect lands on this module's edit form, so parse the response we
    // already have. Fall back to an explicit read if Joomla redirected elsewhere.
    let verify: JoomlaResponse | null = null;
    let verifyToken: { name: string; value: string } | null = null;
    if (/view=module\b/.test(result.redirectUrl ?? "") && /layout=edit/.test(result.redirectUrl ?? "")) {
      const parsed = this.parseModuleForm(result.html);
      if (parsed.title) {
        verify = { success: true, message: "Module retrieved", data: parsed };
        verifyToken = this.extractCsrfToken(result.html);
      }
    }
    if (!verify) {
      const fetched = await this.fetchModuleForm(id);
      verify = fetched;
      verifyToken = fetched.token ?? null;
    }
    await this.quickCheckInModule(id, verifyToken);
    const module = (verify.data || {}) as Record<string, unknown>;
    const expectedAssigned = data.assigned ?? (Array.isArray(existingModule.assigned) ? existingModule.assigned as string[] : []);
    const actualAssigned = Array.isArray(module.assigned) ? module.assigned as string[] : [];
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success,
      titleMatches: !!verify.success && this.decodeHtmlEntities(String(module.title || "")) === this.decodeHtmlEntities(String(formData["jform[title]"] || "")),
      positionMatches: !!verify.success && String(module.position || "") === String(formData["jform[position]"] || ""),
      publishedMatches: !!verify.success && String(module.published || "") === String(formData["jform[published]"] || ""),
      accessMatches: !!verify.success && String(module.access || "") === String(formData["jform[access]"] || ""),
      showtitleMatches: !!verify.success && String(module.showtitle || "") === String(formData["jform[showtitle]"] || ""),
      orderingMatches: !!verify.success && String(module.ordering || "") === String(formData["jform[ordering]"] || ""),
      styleMatches: !!verify.success && String(module.style || "") === String(formData["jform[style]"] || ""),
      languageMatches: !!verify.success && String(module.language || "") === String(formData["jform[language]"] || ""),
      noteMatches: !!verify.success && String(module.note || "") === String(formData["jform[note]"] || ""),
      assignmentMatches: !!verify.success && String(module.assignment || "") === String(formData["jform[assignment]"] || ""),
      assignedMatches: !this.shouldVerifyAssignedMembers(String(formData["jform[assignment]"] || "")) || (!!verify.success && JSON.stringify(actualAssigned) === JSON.stringify(expectedAssigned)),
      contentMatches: data.content === undefined || (!!verify.success && this.decodeHtmlEntities(String(module.content || "")) === this.decodeHtmlEntities(String(data.content))),
    };
    const verified = Object.values(verification).every((value, index) => index < 2 || value === true) && verification.readbackSucceeded;

    return {
      success: verified,
      message: verified ? "Module saved" : (errorMsg ?? (successMsg ? "Module save submitted, but updated values were not verified" : "Unknown result")),
      data: this.buildOperationData("module", id, {
        title: String(module.title || formData["jform[title]"] || ""),
        state: String(module.published || formData["jform[published]"] || ""),
        position: String(module.position || formData["jform[position]"] || ""),
        moduleType: String(module.moduleType || existingModule.moduleType || ""),
        verification: this.collapseVerification(verification, verified),
      }),
      html: result.html,
    };
  }

  async createModule(data: {
    title: string;
    moduleType: string;
    clientId?: string;
    position?: string;
    published?: string;
    access?: string;
    showtitle?: string;
    ordering?: string;
    style?: string;
    language?: string;
    note?: string;
    assignment?: string;
    assigned?: string[];
    params?: Record<string, string>;
    advanced?: Record<string, string>;
    content?: string;
    fieldOverrides?: Record<string, string>;
  }): Promise<JoomlaResponse> {
    const typesResult = await this.listModuleTypes(data.clientId || "0");
    const type = await this.resolveModuleType((typesResult.data || []) as ModuleType[], data.moduleType, data.clientId || "0");
    if (!type) {
      return { success: false, message: `Module type not found: ${data.moduleType}` };
    }

    const addUrl = this.getAdminUrl(`index.php?option=com_modules&task=module.add&eid=${type.id}`);
    const { html } = await this.getPage(addUrl);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const existingModule = this.parseModuleForm(html);
    const formData: FormDataMap = {
      ...this.extractFormFields(html, "module-form"),
      // See createArticle: "apply" gives a reliable &id= on redirect, "save" doesn't.
      task: "module.apply",
      "jform[title]": data.title,
      "jform[position]": data.position ?? String(existingModule.position || ""),
      "jform[published]": data.published ?? "1",
      "jform[access]": data.access ?? "1",
      "jform[showtitle]": data.showtitle ?? "1",
      "jform[ordering]": data.ordering ?? String(existingModule.ordering || "0"),
      "jform[style]": data.style ?? String(existingModule.style || "0"),
      "jform[module]": String(existingModule.moduleType || ""),
      "jform[language]": data.language ?? "*",
      "jform[note]": data.note ?? "",
      "jform[assignment]": data.assignment ?? "0",
      [token.name]: token.value,
    };

    if (data.content !== undefined) {
      formData["jform[content]"] = data.content;
    }

    if (data.assigned) {
      formData["jform[assigned][]"] = data.assigned;
    }

    for (const [key, value] of Object.entries(data.params || {})) {
      formData[`jform[params][${key}]`] = value;
    }

    for (const [key, value] of Object.entries(data.advanced || {})) {
      formData[`jform[advanced][${key}]`] = value;
    }

    Object.assign(formData, data.fieldOverrides || {});

    // Reuse the add form we just fetched — postPage would otherwise re-GET it.
    const result = await this.postPage(addUrl, formData, { prefetchedHtml: html });
    const successMsg = result.redirected || /module saved|has been saved/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const idFromRedirect = result.redirectUrl?.match(/[?&]id=(\d+)/)?.[1] ?? "";
    let savedEntry: Record<string, string> | null = null;
    let savedId = idFromRedirect;
    if (!savedId) {
      const listResult = await this.listModules(data.clientId || "0");
      const modules = Array.isArray(listResult.data) ? listResult.data as Array<Record<string, string>> : [];
      savedEntry = this.findLatestByTitle(modules, data.title);
      savedId = String(savedEntry?.id || "");
    }
    if (!savedId) {
      // One retry after a short delay — handles the DB commit timing window where
      // the module exists on the server but hasn't propagated to the list view yet.
      // Same read-after-write lag class as createArticle/createCategory.
      await new Promise((r) => setTimeout(r, 600));
      const listRetry = await this.listModules(data.clientId || "0");
      const modulesRetry = Array.isArray(listRetry.data) ? listRetry.data as Array<Record<string, string>> : [];
      savedEntry = this.findLatestByTitle(modulesRetry, data.title);
      savedId = String(savedEntry?.id || "");
    }
    // task=module.apply redirects to the new module's own edit form, so result.html is
    // already the readback. apply leaves it checked out, so release it afterwards.
    const buildVerification = (verify: JoomlaResponse | null) => {
      const module = ((verify?.data || {}) as Record<string, unknown>);
      const expectedModuleType = String(existingModule.moduleType || "").toLowerCase();
      const actualModuleType = String(module.moduleType || "").toLowerCase();
      const titleMatches = !!verify?.success && this.decodeHtmlEntities(String(module.title || "")) === this.decodeHtmlEntities(data.title);
      const moduleTypeMatches = !!verify?.success && (!expectedModuleType || actualModuleType === expectedModuleType);
      return { titleMatches, moduleTypeMatches };
    };
    let verify: JoomlaResponse | null = null;
    let verifyToken: { name: string; value: string } | null = null;
    if (savedId && /view=module\b/.test(result.redirectUrl ?? "") && /layout=edit/.test(result.redirectUrl ?? "")) {
      const parsed = this.parseModuleForm(result.html);
      if (parsed.title) {
        verify = { success: true, message: "Module retrieved", data: parsed };
        verifyToken = this.extractCsrfToken(result.html);
      }
    }
    if (savedId && !verify) {
      const fetched = await this.fetchModuleForm(savedId);
      verify = fetched;
      verifyToken = fetched.token ?? null;
    }
    let { titleMatches, moduleTypeMatches } = buildVerification(verify);
    let verified = !!savedId && titleMatches && moduleTypeMatches;
    // Read-after-write lag: retry the readback once before reporting an unverified
    // create. Same fix as createArticle — see [[joomla_article]] self-improving history.
    if (savedId && !verified) {
      await new Promise((r) => setTimeout(r, 800));
      const retry = await this.fetchModuleForm(savedId);
      verify = retry;
      verifyToken = retry.token ?? null;
      ({ titleMatches, moduleTypeMatches } = buildVerification(verify));
      verified = !!savedId && titleMatches && moduleTypeMatches;
    }
    if (savedId) await this.quickCheckInModule(savedId, verifyToken);
    const module = ((verify?.data || {}) as Record<string, unknown>);

    return {
      success: verified,
      message: verified
        ? "Module saved"
        : (errorMsg ?? (successMsg ? "Module save submitted, but creation was not verified" : "Module save was rejected by Joomla and no alert message was returned")),
      data: this.buildOperationData("module", savedId, {
        title: String(module.title || data.title),
        state: String(module.published || data.published || "1"),
        position: String(module.position || data.position || ""),
        moduleType: String(module.moduleType || existingModule.moduleType || ""),
        verification: {
          attempted: true,
          foundInList: !!savedId,
          readbackSucceeded: !!verify?.success,
          titleMatches,
          moduleTypeMatches,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async deleteModule(id: string, options: { clientId?: string; expectedTitle?: string; expectedModuleType?: string } = {}): Promise<JoomlaResponse> {
    // Read the edit form directly rather than through getModule: the token it yields
    // authenticates the trash task below, and modules.trash fails on a checked-out
    // module, so the checkout this read takes must be released first anyway.
    const before = await this.fetchModuleForm(id);
    const module = (before.data || {}) as Record<string, unknown>;
    const title = String(module.title || "");
    const moduleType = String(module.moduleType || "");
    const clientId = options.clientId || String(module.clientId || "0");
    const token = before.token ?? null;
    if (!before.success) {
      return { success: false, message: `Refusing to delete module ${id} because the current target could not be verified` };
    }
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }
    // Release before the guards below, not after: the read above checked the module out,
    // and a guard that refuses the operation still has to leave the record unlocked.
    await this.quickCheckInModule(id, token);
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to delete module ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedModuleType && moduleType !== options.expectedModuleType) {
      return { success: false, message: `Refusing to delete module ${id}: expected moduleType ${options.expectedModuleType}, found ${moduleType}` };
    }

    // Post the task at the single-row list URL so its redirect target doubles as the
    // "is it still listed?" check, without listing every module on the site.
    const listUrl = this.getModulesListUrl(`id:${id}`, clientId);
    const result = await this.postPage(listUrl, { task: "modules.trash", "cid[]": id }, { token });
    const successMsg = /module[s]?\s+(trashed|deleted)|has been (trashed|deleted)/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const stillListed = this.parseModuleList(result.html).some((entry) => entry.id === id);
    const verify = await this.fetchModuleForm(id);
    if (verify.success) await this.quickCheckInModule(id, verify.token ?? null);
    const verified = !stillListed && (successMsg || this.isDeletionVerified(stillListed, verify, ["published", "state"]));

    return {
      success: verified,
      message: verified
        ? "Module trashed"
        : (errorMsg ?? (successMsg ? "Module trash submitted, but deletion was not verified" : "Unknown result")),
      data: this.buildOperationData("module", id, {
        title,
        state: "-2",
        moduleType,
        verification: {
          attempted: true,
          preflightVerified: true,
          stillListed,
          readbackSucceeded: verify.success,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async checkInModule(id: string, options: { expectedTitle?: string; expectedModuleType?: string } = {}): Promise<JoomlaResponse> {
    const before = await this.fetchModuleForm(id);
    const moduleBefore = (before.data || {}) as Record<string, unknown>;
    const title = String(moduleBefore.title || "");
    const moduleType = String(moduleBefore.moduleType || "");
    if (!before.success) {
      return { success: false, message: `Refusing to check in module ${id} because the current target could not be verified` };
    }

    const token = before.token ?? null;
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }
    // Release before the guards below, not after: the read above checked the module out,
    // and a check-in tool that refuses must not itself leave the record locked.
    await this.quickCheckInModule(id, token);
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to check in module ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedModuleType && moduleType !== options.expectedModuleType) {
      return { success: false, message: `Refusing to check in module ${id}: expected moduleType ${options.expectedModuleType}, found ${moduleType}` };
    }

    // Address exactly this row. The old code verified against listModules(), which caps
    // at 200 rows — a module outside that window read as "not listed" and reported a
    // false negative even though the check-in had worked. The preflight above supplies
    // the token, and the task's redirect target is this same single-row list.
    const listUrl = this.getModulesListUrl(`id:${id}`, String(moduleBefore.clientId || "0"));
    const result = await this.postPage(listUrl, {
      task: "modules.checkin",
      "cid[]": id,
      boxchecked: "1",
    }, { token });
    const errorMsg = this.extractAlertMessage(result.html);

    let listedModule = this.parseModuleList(result.html).find((entry) => entry.id === id);
    if (!listedModule) {
      const verifyPage = await this.getPage(listUrl);
      listedModule = this.parseModuleList(verifyPage.html).find((entry) => entry.id === id);
    }
    const checkedOutCleared = !!listedModule && listedModule.checkedOut !== "1";

    return {
      success: checkedOutCleared,
      message: checkedOutCleared ? "Module checked in" : (errorMsg ?? "Module check-in submitted, but checkout state was not verified as cleared"),
      data: this.buildOperationData("module", id, {
        title,
        state: String(listedModule?.state || ""),
        moduleType,
        verification: {
          attempted: true,
          preflightVerified: true,
          listedAfterCheckIn: !!listedModule,
          checkedOutCleared,
        },
      }),
      html: result.html,
    };
  }

  // ==================== GANTRY 5 THEMES / OUTLINES ====================

  private getGantryThemeKey(theme?: string): string {
    const value = (theme || "rt_studius").trim();
    if (!value || value.toLowerCase() === "studius") return "rt_studius";
    return value;
  }

  private getGantryThemesUrl(): string {
    return this.getAdminUrl("index.php?option=com_gantry5&view=themes");
  }

  private getGantryOutlineTabUrl(outline = "default", tab = "layout", theme?: string): string {
    const safeOutline = encodeURIComponent(outline || "default");
    const safeTab = encodeURIComponent(tab || "layout");
    const safeTheme = encodeURIComponent(this.getGantryThemeKey(theme));
    return this.getAdminUrl(`index.php?option=com_gantry5&view=configurations/${safeOutline}/${safeTab}&theme=${safeTheme}`);
  }

  private parseGantryThemeConfigureUrl(html: string, theme?: string): string | null {
    const themeKey = this.getGantryThemeKey(theme);
    const $ = this.$c(html);
    let result: string | null = null;
    $("a[href*='option=com_gantry5'][href*='view=configurations/default/layout']").each((_, el) => {
      const href = $(el).attr("href") || "";
      if (href.includes(`theme=${themeKey}`)) {
        result = this.resolveUrl(href);
        return false;
      }
    });
    return result;
  }

  private async getGantryOutlinePage(
    outline = "default",
    tab = "layout",
    theme?: string
  ): Promise<{ url: string; html: string; tabs: Record<string, string>; ajax: Record<string, string> }> {
    // Strategy: navigate to Gantry admin once (getting the session token), then derive
    // URLs for other outlines by replacing the outline segment in the entry URL.
    // This avoids re-visiting the themes page (which can burn the one-use token) and
    // avoids re-navigating at all for outlines we've already fetched.
    const cacheKey = `${this.getGantryThemeKey(theme)}::${outline}`;

    let layoutUrl = this.gantryOutlineLayoutUrls.get(cacheKey) || "";

    if (!layoutUrl) {
      // Navigate from themes page to get the "default" entry URL with its session token
      if (!this.gantryEntryUrl) {
        const themesPage = await this.getPage(this.getGantryThemesUrl());
        const configureUrl = this.parseGantryThemeConfigureUrl(themesPage.html, theme);
        this.gantryEntryUrl = configureUrl || this.getGantryOutlineTabUrl("default", "layout", theme);
      }

      if (outline === "default") {
        // Use the entry URL directly for the default outline
        layoutUrl = this.gantryEntryUrl;
      } else {
        // Derive the outline URL from the entry URL by replacing the outline name.
        // The Gantry URL format is: ...&view=configurations/default/layout&...
        // Replace the outline segment in that view param.
        const derived = this.gantryEntryUrl.replace(
          /configurations\/[^\/&?#]+\//,
          `configurations/${encodeURIComponent(outline)}/`
        );
        layoutUrl = derived !== this.gantryEntryUrl ? derived : this.gantryEntryUrl;
      }

      // Cache so subsequent calls (e.g. the liveBefore check in saveGantry5LayoutRaw)
      // reuse the same URL without re-deriving or re-navigating.
      this.gantryOutlineLayoutUrls.set(cacheKey, layoutUrl);
    }

    const layoutPage = await this.getPage(layoutUrl);

    if (tab === "layout") {
      return {
        url: layoutUrl,
        html: layoutPage.html,
        tabs: this.parseGantryTabs(layoutPage.html),
        ajax: this.parseGantryAjaxVars(layoutPage.html),
      };
    }

    const tabs = this.parseGantryTabs(layoutPage.html);
    const targetUrl = this.resolveUrl(tabs[tab] || this.getGantryOutlineTabUrl(outline, tab, theme));
    const targetPage = await this.getPage(targetUrl);
    return {
      url: targetUrl,
      html: targetPage.html,
      tabs: this.parseGantryTabs(targetPage.html),
      ajax: this.parseGantryAjaxVars(targetPage.html),
    };
  }

  private parseJsonAttribute(value: string | null): unknown {
    if (!value) return null;
    const decoded = this.decodeHtmlEntities(value);
    try {
      return JSON.parse(decoded);
    } catch {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
  }

  private parseGantryAjaxVars(html: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const key of ["GANTRY_AJAX_SUFFIX", "GANTRY_AJAX_URL", "GANTRY_AJAX_CONF_URL", "GANTRY_PLATFORM"]) {
      const match = html.match(new RegExp(`var\\s+${key}\\s*=\\s*['"]([^'"]*)['"]`, "i"));
      if (match) vars[key] = this.decodeHtml(match[1]);
    }
    return vars;
  }

  private parseGantryOutlines(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const select = $("select[id='configuration-selector']");
    if (!select.length) return [];

    const outlines: Array<Record<string, unknown>> = [];
    const collectOption = ($opt: ReturnType<typeof $>, group: string) => {
      const value = $opt.attr("value") || "";
      if (!value) return;
      const data = this.parseJsonAttribute($opt.attr("data-data") ?? null) as Record<string, unknown> | null;
      outlines.push({
        id: value,
        title: $opt.text().trim(),
        group,
        selected: $opt.is("[selected]"),
        url: typeof data?.url === "string" ? data.url : "",
        params: data?.params || {},
      });
    };

    select.children("optgroup").each((_, group) => {
      const groupLabel = $(group).attr("label") || "Base Outline";
      $(group).children("option").each((_, opt) => collectOption($(opt), groupLabel));
    });

    select.children("option").each((_, opt) => collectOption($(opt), "Base Outline"));

    return outlines;
  }

  private parseGantryTabs(html: string): Record<string, string> {
    const $ = this.$c(html);
    const tabs: Record<string, string> = {};
    $("a[data-g5-nav]").each((_, el) => {
      const $el = $(el);
      const nav = $el.attr("data-g5-nav");
      const href = $el.attr("href");
      if (nav && href) tabs[nav] = href;
    });
    $("a:has(span)").each((_, el) => {
      const $el = $(el);
      if ($el.find("span").text().trim() === "Page Settings") {
        const href = $el.attr("href") || "";
        if (href.includes("view=configurations") && href.includes("/page")) {
          tabs.page = href;
        }
      }
    });
    return tabs;
  }

  private parseGantryParticleCatalog(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const catalog: Array<Record<string, unknown>> = [];
    $("li[data-lm-blocktype]").each((_, el) => {
      const $el = $(el);
      catalog.push({
        blockType: $el.attr("data-lm-blocktype") || "",
        subtype: $el.attr("data-lm-subtype") || "",
        icon: $el.attr("data-lm-icon") || "",
        title: $el.find(".particle-title").first().text().trim(),
        disabled: $el.is("[data-lm-disabled]"),
        noDrag: $el.is("[data-lm-nodrag]"),
        note: $el.attr("title") || "",
      });
    });
    return catalog;
  }

  private parseGantryLayoutRoot(html: string): { preset: unknown; root: GantryLayoutNode[] } {
    const $ = this.$c(html);
    const div = $("[class*='lm-blocks']").first();
    const preset = this.parseJsonAttribute(div.attr("data-lm-preset") ?? null);
    const root = this.parseJsonAttribute(div.attr("data-lm-root") ?? null);
    return {
      preset,
      root: Array.isArray(root) ? root as GantryLayoutNode[] : [],
    };
  }

  private validateGantrySnapshot(snapshotId: string, outline: string, theme?: string): JoomlaResponse | null {
    const snapshot = this.readSnapshot(snapshotId);
    if (!snapshot) return { success: false, message: `Snapshot not found: ${snapshotId}` };
    if (snapshot.kind !== "gantryLayout") {
      return { success: false, message: `Snapshot ${snapshotId} is ${String(snapshot.kind || "unknown")}, not gantryLayout` };
    }

    const snapshotOutline = String(snapshot.outline || "default");
    const snapshotTheme = String(snapshot.theme || "rt_studius");
    const requestedTheme = this.getGantryThemeKey(theme);
    if (snapshotOutline !== outline) {
      return { success: false, message: `Snapshot ${snapshotId} was created for outline ${snapshotOutline}, not ${outline}` };
    }
    if (snapshotTheme !== requestedTheme) {
      return { success: false, message: `Snapshot ${snapshotId} was created for theme ${snapshotTheme}, not ${requestedTheme}` };
    }

    return null;
  }

  private summarizeGantryLayout(root: GantryLayoutNode[]): Record<string, unknown> {
    const sections: Array<Record<string, unknown>> = [];
    const particles: Array<Record<string, unknown>> = [];
    const positions: Array<Record<string, unknown>> = [];
    const modules: Array<Record<string, unknown>> = [];
    const nodes: Array<Record<string, unknown>> = [];

    const visit = (node: GantryLayoutNode, path: string[], parent?: GantryLayoutNode) => {
      const id = node.id || "";
      const nodePath = [...path, id || node.type || "node"].filter(Boolean);
      const record = {
        id,
        title: node.title || "",
        type: node.type || "",
        subtype: node.subtype || "",
        path: nodePath.join(" > "),
        parentId: parent?.id || "",
        attributes: node.attributes || {},
        childCount: Array.isArray(node.children) ? node.children.length : 0,
      };
      nodes.push(record);
      if (node.type === "section" || node.type === "container" || node.type === "offcanvas") sections.push(record);
      if (node.type === "particle") particles.push(record);
      if (node.type === "position") {
        positions.push(record);
        if (node.subtype === "module") modules.push(record);
      }
      for (const child of node.children || []) visit(child, nodePath, node);
    };

    for (const node of root) visit(node, []);

    return {
      counts: {
        nodes: nodes.length,
        sections: sections.length,
        particles: particles.length,
        positions: positions.length,
        moduleInstances: modules.length,
      },
      sections,
      particles,
      positions,
      moduleInstances: modules,
      nodes,
    };
  }

  private findGantryLayoutNode(root: GantryLayoutNode[], id: string): { node: GantryLayoutNode; parent: GantryLayoutNode | null } | null {
    const visit = (node: GantryLayoutNode, parent: GantryLayoutNode | null): { node: GantryLayoutNode; parent: GantryLayoutNode | null } | null => {
      if (node.id === id) return { node, parent };
      for (const child of node.children || []) {
        const found = visit(child, node);
        if (found) return found;
      }
      return null;
    };
    for (const node of root) {
      const found = visit(node, null);
      if (found) return found;
    }
    return null;
  }

  private gantryNodeContains(node: GantryLayoutNode, id: string): boolean {
    if (node.id === id) return true;
    return (node.children || []).some((child) => this.gantryNodeContains(child, id));
  }

  private detachGantryLayoutNode(root: GantryLayoutNode[], id: string): { node: GantryLayoutNode; parentId: string } | null {
    const scan = (children: GantryLayoutNode[], parentId = ""): { node: GantryLayoutNode; parentId: string } | null => {
      const index = children.findIndex((child) => child.id === id);
      if (index >= 0) {
        const [node] = children.splice(index, 1);
        return { node, parentId };
      }
      for (const child of children) {
        const found = scan(child.children || [], child.id || "");
        if (found) return found;
      }
      return null;
    };
    return scan(root);
  }

  private async postGantryJson(url: string, data: FormDataMap): Promise<Record<string, unknown>> {
    const page = await this.getPage(url);
    const token = this.extractCsrfToken(page.html);
    if (token) {
      data[token.name] = token.value;
      this.tokenName = token.name;
    } else if (this.tokenName) {
      data[this.tokenName] = "1";
    }
    const separator = url.includes("?") ? "&" : "?";
    const result = await this.request(`${url}${separator}format=json`, {
      method: "POST",
      body: this.getFormUrlEncoded(data),
      contentType: "application/x-www-form-urlencoded",
    });
    try {
      return JSON.parse(result.body) as Record<string, unknown>;
    } catch {
      return {
        success: false,
        status: result.status,
        message: "Gantry save did not return JSON",
        html: result.body.substring(0, 2000),
      };
    }
  }

  private parseGantrySettingsFields(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const labels = this.buildLabelIndex($);
    const fields: Array<Record<string, unknown>> = [];

    $("input, textarea, select").each((_, el) => {
      const $el = $(el);
      const name = $el.attr("name");
      if (!name) return;
      const id = $el.attr("id") || "";
      const kind = el.tagName.toLowerCase() as "input" | "textarea" | "select";
      let value = "";
      let options: Array<Record<string, unknown>> | undefined;

      if (kind === "textarea") {
        value = $el.text();
      } else if (kind === "select") {
        const selected = $el.find("option[selected]").first();
        value = selected.length ? (selected.attr("value") ?? "") : ($el.find("option").first().attr("value") ?? "");
        options = $el.find("option").map((_, opt) => {
          const $opt = $(opt);
          return {
            value: $opt.attr("value") || "",
            label: $opt.text().trim(),
            selected: $opt.is("[selected]"),
          };
        }).get();
      } else {
        value = $el.attr("value") || "";
      }

      fields.push({
        name,
        id,
        label: id ? labels.get(id) ?? "" : "",
        kind,
        inputType: kind === "input" ? ($el.attr("type") || "text") : kind,
        value,
        options,
      });
    });

    return fields;
  }

  async listGantry5Outlines(theme = "rt_studius"): Promise<JoomlaResponse> {
    const page = await this.getGantryOutlinePage("default", "layout", theme);
    const { html, url } = page;
    const outlines = this.parseGantryOutlines(html);
    return {
      success: outlines.length > 0,
      message: outlines.length > 0 ? `Found ${outlines.length} Gantry 5 Studius outlines` : "No Gantry 5 outlines found",
      data: {
        theme: this.getGantryThemeKey(theme),
        tabs: page.tabs,
        ajax: page.ajax,
        outlines,
      },
    };
  }

  async exportGantry5OutlineBlueprint(
    outline = "default",
    options: {
      theme?: string;
      format?: "json" | "yaml";
      saveToFile?: boolean;
      fileName?: string;
    } = {}
  ): Promise<JoomlaResponse> {
    const layout = await this.getGantry5Layout(outline, { theme: options.theme, includeRaw: true });
    if (!layout.success) return layout;
    const data = (layout.data || {}) as Record<string, unknown>;
    const root = (data.root || []) as GantryLayoutNode[];
    const preset = data.preset;
    const theme = this.getGantryThemeKey(options.theme);
    const references = await this.collectGantryParticleReferences(root);
    const blueprint = {
      kind: "gantry5-outline-blueprint",
      version: 1,
      exportedAt: new Date().toISOString(),
      source: {
        theme,
        outline,
      },
      references: {
        particleFilters: references,
      },
      layout: {
        preset,
        root,
      },
      summary: this.summarizeGantryLayout(root),
    };

    const format = (options.format || "json").toLowerCase() === "yaml" ? "yaml" : "json";
    const serialized = format === "yaml"
      ? yaml.dump(blueprint, { noRefs: true, lineWidth: 120 })
      : JSON.stringify(blueprint, null, 2);

    let filePath = "";
    if (options.saveToFile) {
      mkdirSync(this.getBlueprintDir(), { recursive: true });
      const safeOutline = outline.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const ext = format === "yaml" ? "yaml" : "json";
      const fileName = (options.fileName || `gantry-outline-${safeOutline}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`)
        .replace(/[^a-zA-Z0-9_.-]/g, "_");
      filePath = path.join(this.getBlueprintDir(), fileName);
      writeFileSync(filePath, serialized, "utf8");
    }

    return {
      success: true,
      message: "Gantry outline blueprint exported",
      data: {
        format,
        theme,
        outline,
        filePath,
        blueprint,
        serialized,
      },
    };
  }

  async importGantry5OutlineBlueprint(data: {
    outline?: string;
    theme?: string;
    blueprint?: Record<string, unknown>;
    blueprintText?: string;
    format?: "json" | "yaml";
    filePath?: string;
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    let blueprint = data.blueprint as Record<string, unknown> | undefined;

    if (!blueprint && data.filePath) {
      const fileText = readFileSync(path.resolve(process.cwd(), data.filePath), "utf8");
      const fileFormat = (data.format || (data.filePath.toLowerCase().endsWith(".yaml") || data.filePath.toLowerCase().endsWith(".yml") ? "yaml" : "json")).toLowerCase();
      blueprint = (fileFormat === "yaml" ? yaml.load(fileText) : JSON.parse(fileText)) as Record<string, unknown>;
    }

    if (!blueprint && data.blueprintText) {
      const format = (data.format || "json").toLowerCase();
      blueprint = (format === "yaml" ? yaml.load(data.blueprintText) : JSON.parse(data.blueprintText)) as Record<string, unknown>;
    }

    if (!blueprint || typeof blueprint !== "object") {
      return { success: false, message: "blueprint, blueprintText, or filePath is required" };
    }

    const layout = (blueprint.layout || {}) as Record<string, unknown>;
    const root = layout.root as unknown;
    const preset = layout.preset;
    if (!Array.isArray(root)) {
      return { success: false, message: "Blueprint layout.root must be an array" };
    }

    const source = (blueprint.source || {}) as Record<string, unknown>;
    const outline = data.outline || String(source.outline || "default");
    const theme = data.theme || String(source.theme || "rt_studius");
    const references = ((((blueprint.references || {}) as Record<string, unknown>).particleFilters) || []) as GantryParticleReference[];

    let resolvedRoot = root as GantryLayoutNode[];
    let remapActions: Array<Record<string, unknown>> = [];
    if (references.length > 0) {
      const clonedRoot = JSON.parse(JSON.stringify(root)) as GantryLayoutNode[];
      const remapped = await this.remapGantryParticleReferences(clonedRoot, references, { dryRun: data.dryRun || !data.confirm });
      resolvedRoot = remapped.root;
      remapActions = remapped.actions;
    }

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: data.dryRun ? "Dry run: Gantry outline blueprint parsed and ready" : "Blueprint parsed; set confirm=true to apply",
        data: {
          outline,
          theme: this.getGantryThemeKey(theme),
          summary: this.summarizeGantryLayout(resolvedRoot),
          preset,
          remapActions,
        },
      };
    }

    // Auto-snapshot the current live layout so saveGantry5LayoutRaw has a valid
    // snapshotId (needed for CSRF validation / race-condition guard).
    const snap = await this.snapshotTarget({ kind: "gantryLayout", outline, theme });
    if (!snap.success) return snap;
    const snapshotId = String((snap.data as Record<string, unknown>).snapshotId || "");

    const save = await this.saveGantry5LayoutRaw(outline, {
      root: resolvedRoot,
      preset,
      theme,
      snapshotId,
    });

    return {
      success: save.success,
      message: save.success ? "Gantry outline blueprint applied" : save.message,
      data: {
        outline,
        theme: this.getGantryThemeKey(theme),
        remapActions,
        save: save.data,
      },
    };
  }

  async getGantry5Layout(outline = "default", options: { theme?: string; includeRaw?: boolean } = {}): Promise<JoomlaResponse> {
    const page = await this.getGantryOutlinePage(outline, "layout", options.theme);
    const { html, url } = page;
    const { preset, root } = this.parseGantryLayoutRoot(html);
    // Cache so liveBefore check in saveGantry5LayoutRaw can reuse without re-fetching.
    // Deep-clone to prevent in-place mutations from corrupting the cached pre-modification state.
    const rootCacheKey = `${this.getGantryThemeKey(options.theme)}::${outline}`;
    this.gantryLayoutRootCache.set(rootCacheKey, { root: JSON.parse(JSON.stringify(root)) as GantryLayoutNode[], preset });
    const summary = this.summarizeGantryLayout(root);
    return {
      success: true,
      message: root.length > 0 ? "Gantry 5 layout retrieved" : "Gantry 5 layout retrieved (empty root)",
      data: {
        theme: this.getGantryThemeKey(options.theme),
        outline,
        tab: "layout",
        url,
        tabs: page.tabs,
        preset,
        particleCatalog: this.parseGantryParticleCatalog(html),
        layout: summary,
        root: options.includeRaw ? root : undefined,
      },
      html: options.includeRaw ? html.substring(0, 50000) : undefined,
    };
  }

  async saveGantry5LayoutRaw(outline = "default", data: { root: unknown; preset?: unknown; snapshotId?: string; theme?: string }): Promise<JoomlaResponse> {
    if (!Array.isArray(data.root)) {
      return { success: false, message: "root must be the full Gantry layout array from joomla_gantry5_get_layout includeRaw=true" };
    }
    if (!data.snapshotId) {
      return { success: false, message: "snapshotId is required for live Gantry layout saves" };
    }

    const snapshotError = this.validateGantrySnapshot(data.snapshotId, outline, data.theme);
    if (snapshotError) return snapshotError;

    const snapshot = this.readSnapshot(data.snapshotId) as Record<string, unknown>;
    const snapshotPayload = (snapshot.payload || {}) as Record<string, unknown>;
    const snapshotLayout = (snapshotPayload.layout || {}) as Record<string, unknown>;
    const snapshotRoot = ((snapshotPayload.root || snapshotLayout.root) || []) as GantryLayoutNode[];
    const snapshotPreset = snapshotPayload.preset || "default";

    // Use cached layout root if available (avoids re-fetching which can return different HTML in Gantry)
    const rootCacheKey = `${this.getGantryThemeKey(data.theme)}::${outline}`;
    const cachedLayout = this.gantryLayoutRootCache.get(rootCacheKey);
    let liveBeforeRoot: GantryLayoutNode[];
    let liveBeforePreset: unknown;
    if (cachedLayout) {
      liveBeforeRoot = cachedLayout.root;
      liveBeforePreset = cachedLayout.preset;
    } else {
      const liveBefore = await this.getGantry5Layout(outline, { theme: data.theme, includeRaw: true });
      if (!liveBefore.success) {
        return {
          success: false,
          message: "Unable to verify current Gantry layout before saving",
          data: {
            theme: this.getGantryThemeKey(data.theme),
            outline,
            snapshotId: data.snapshotId,
          },
        };
      }
      const liveBeforeData = liveBefore.data as Record<string, unknown>;
      liveBeforeRoot = (liveBeforeData.root || []) as GantryLayoutNode[];
      liveBeforePreset = liveBeforeData.preset || "default";
    }
    const snapshotMatchesLive = JSON.stringify(snapshotRoot) === JSON.stringify(liveBeforeRoot)
      && JSON.stringify(snapshotPreset) === JSON.stringify(liveBeforePreset);
    if (!snapshotMatchesLive) {
      return {
        success: false,
        message: "Snapshot no longer matches the live Gantry layout; take a fresh snapshot before saving",
        data: {
          theme: this.getGantryThemeKey(data.theme),
          outline,
          snapshotId: data.snapshotId,
          verification: {
            attempted: true,
            snapshotMatchesLive: false,
          },
        },
      };
    }

    // Invalidate layout root cache so subsequent reads see the new layout
    this.gantryLayoutRootCache.delete(rootCacheKey);

    const page = await this.getGantryOutlinePage(outline, "layout", data.theme);
    const url = page.url;
    const response = await this.postGantryJson(url, {
      layout: JSON.stringify(data.root),
      preset: JSON.stringify(data.preset || "default"),
    });
    if (response.success !== true) {
      return {
        success: false,
        message: String(response.message || "Gantry 5 layout save failed"),
        data: {
          theme: this.getGantryThemeKey(data.theme),
          outline,
          snapshotId: data.snapshotId,
          response,
        },
      };
    }

    // Gantry normalizes the layout JSON on save (strips empty arrays, reorders keys, etc.)
    // so exact readback comparison is unreliable. Treat response.success=true as definitive.
    const live = await this.getGantry5Layout(outline, { theme: data.theme, includeRaw: true });
    const readbackSucceeded = live.success;
    let rootMatched: boolean | null = null;
    let presetMatched: boolean | null = null;
    if (readbackSucceeded) {
      const liveData = live.data as Record<string, unknown>;
      const actualRoot = (liveData.root || []) as GantryLayoutNode[];
      const actualPreset = liveData.preset;
      rootMatched = JSON.stringify(data.root) === JSON.stringify(actualRoot);
      presetMatched = JSON.stringify(data.preset || "default") === JSON.stringify(actualPreset || "default");
    }
    return {
      success: true,
      message: "Gantry 5 layout saved",
      data: {
        theme: this.getGantryThemeKey(data.theme),
        outline,
        snapshotId: data.snapshotId,
        response,
        verification: {
          attempted: true,
          readbackSucceeded,
          rootMatched,
          presetMatched,
        },
      },
    };
  }

  async toggleModule(id: string, state: string, options: { expectedTitle?: string; expectedModuleType?: string } = {}): Promise<JoomlaResponse> {
    // Read the edit form directly rather than through getModule: we need the token it
    // yields anyway, and modules.publish fails on a checked-out module, so the checkout
    // this read takes has to be released before the task below either way.
    const before = await this.fetchModuleForm(id);
    const moduleBefore = (before.data || {}) as Record<string, unknown>;
    const title = String(moduleBefore.title || "");
    const moduleType = String(moduleBefore.moduleType || "");
    const clientId = String(moduleBefore.clientId || "0");
    const token = before.token ?? null;
    if (!before.success) {
      return { success: false, message: `Refusing to change module ${id} because the current target could not be verified` };
    }
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }
    // Release before the guards below, not after: the read above checked the module out,
    // and a guard that refuses the operation still has to leave the record unlocked.
    await this.quickCheckInModule(id, token);
    if (options.expectedTitle && title !== options.expectedTitle) {
      return { success: false, message: `Refusing to change module ${id}: expected title ${options.expectedTitle}, found ${title}` };
    }
    if (options.expectedModuleType && moduleType !== options.expectedModuleType) {
      return { success: false, message: `Refusing to change module ${id}: expected moduleType ${options.expectedModuleType}, found ${moduleType}` };
    }

    // Post the task at the single-row list URL so its redirect target is the verification
    // read. Verify from the list rather than the edit form: the form's published field
    // defaults to "1", which reads as a false positive when it is not captured.
    const listUrl = this.getModulesListUrl(`id:${id}`, clientId);
    const task = state === "1" ? "modules.publish" : "modules.unpublish";
    const result = await this.postPage(listUrl, {
      task,
      "cid[]": id,
      boxchecked: "1",
    }, { token });
    const successMsg = /module[s]?\s+(published|unpublished)|has been/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);

    let listedModule = this.parseModuleList(result.html).find((entry) => entry.id === id);
    if (!listedModule) {
      const verifyPage = await this.getPage(listUrl);
      listedModule = this.parseModuleList(verifyPage.html).find((entry) => entry.id === id);
    }
    const expectedLabel = state === "1" ? "Published" : "Unpublished";
    const actualLabel = listedModule?.state ?? "Unknown";
    const actualState = actualLabel === "Published" ? "1" : actualLabel === "Unpublished" ? "0" : "";
    const verified = !!listedModule && actualLabel === expectedLabel;

    return {
      success: verified,
      message: verified
        ? `Module ${state === "1" ? "published" : "unpublished"}`
        : (errorMsg ?? (successMsg ? "Module state was not verified after submit" : "Unknown result")),
      data: this.buildOperationData("module", id, {
        title: String(listedModule?.title || title),
        state: actualState,
        moduleType,
        verification: {
          attempted: true,
          preflightVerified: true,
          requestedState: state,
          actualState: actualLabel,
          foundInList: !!listedModule,
          verified,
        },
      }),
      html: result.html,
    };
  }

  // ==================== MENUS ====================

  private parseMenuList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const menus: Array<Record<string, string>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const titleLink = $row.find("a[href*='view=items']").first();
      const title = titleLink.text().trim();
      if (!title) return;
      const menuTypeLink = $row.find("a[href*='task=menu.edit']").first();
      menus.push({
        id: cid,
        title,
        menuType: menuTypeLink.text().trim(),
      });
    });
    return menus;
  }

  async listMenus(): Promise<JoomlaResponse> {
    const url = this.getAdminUrl("index.php?option=com_menus&view=menus");
    const { html } = await this.getPage(url);
    const menus = this.parseMenuList(html);
    return {
      success: true,
      message: `Found ${menus.length} menus`,
      data: menus,
      html,
    };
  }

  /**
   * Refuse a menuType the site does not have.
   *
   * Joomla's own guard here is client-side only — jform[menutype] is a
   * `required` <select>, so a direct POST carrying an unlisted value is
   * accepted and the row is written with no usable menutype. The item then
   * exists, belongs to no menu, and appears in no menu listing. The save
   * reports "Menu item saved." while verification reports menuTypeMatches:
   * false, which reads like a tool bug and historically sent diagnosis down
   * several wrong paths (see the improvements queue). Fail before the POST
   * instead, and name the menus that do exist.
   *
   * Returns null when the menuType is valid.
   */
  private async rejectUnknownMenuType(menuType: string, verb: string): Promise<JoomlaResponse | null> {
    const menusResult = await this.listMenus();
    const menus = (menusResult.data || []) as { title?: string; menuType?: string }[];
    // A failed lookup must not block a legitimate write — only reject on a
    // list we actually got back.
    if (!menusResult.success || menus.length === 0) return null;
    if (menus.some((m) => m.menuType === menuType)) return null;
    const available = menus.map((m) => `${m.menuType} (${m.title})`).join(", ");
    return {
      success: false,
      message:
        `Cannot ${verb} menu item: this site has no menu with menuType "${menuType}". ` +
        `Joomla would accept the save and write an item that belongs to no menu. ` +
        `Available menus: ${available}. ` +
        `Use one of those, or create the menu first with joomla_menu{action:"create"}.`,
    };
  }

  async createMenu(data: {
    title: string;
    menuType?: string;
    description?: string;
    cssClasses?: string;
  }): Promise<JoomlaResponse> {
    const menuType = data.menuType || data.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 24);
    const url = this.getAdminUrl("index.php?option=com_menus&task=menu.add");
    const { html } = await this.getPage(url);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    const formData: FormDataMap = {
      ...this.extractFormFields(html, "item-form"),
      // See createArticle: "apply" gives a reliable &id= on redirect, "save" doesn't.
      // (com_menus menu records are usually addressed by menutype rather than id, so
      // this may not resolve here — the list-scan below stays as the fallback.)
      task: "menu.apply",
      "jform[title]": data.title,
      "jform[menutype]": menuType,
      "jform[description]": data.description || "",
      "jform[css_classes]": data.cssClasses || "",
      [token.name]: token.value,
    };

    const result = await this.postPage(url, formData);
    const successMsg = result.redirected || /menu saved|has been saved|item saved/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    const idFromRedirect = result.redirectUrl?.match(/[?&]id=(\d+)/)?.[1] ?? "";
    const listResult = await this.listMenus();
    const menus = Array.isArray(listResult.data) ? listResult.data as Array<Record<string, string>> : [];
    const savedMenu = idFromRedirect
      ? menus.find((menu) => menu.id === idFromRedirect)
      : menus.find((menu) => menu.title === data.title && menu.menuType === menuType);
    const verified = !!savedMenu;

    return {
      success: verified,
      message: verified ? "Menu saved" : (errorMsg ?? (successMsg ? "Menu save submitted, but creation was not verified" : "Unknown result")),
      data: {
        id: String(savedMenu?.id || idFromRedirect || ""),
        title: data.title,
        menuType,
        verification: {
          attempted: true,
          foundInList: verified,
          verified,
        },
      },
      html: result.html,
    };
  }

  private parseMenuItemList(html: string): Array<Record<string, string>> {
    const $ = this.$c(html);
    const items: Array<Record<string, string>> = [];
    const ancestorStack: Array<{ id: string; title: string }> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowText = $row.text();
      if (rowText.includes("JSelect") || rowText.includes("JAll")) return;
      const $titleLink = $row.find("a[href*='task=item.edit']").first();
      const title = $titleLink.text().trim();
      if (!title) return;
      const rowHtml = $.html($row) || "";
      // In Joomla 3 (Isis), type is rendered inside the title column td as div[title] > span.small.
      // There is no separate type column — the div[title] sits after the alias span within the title td.
      const $titleTd = $titleLink.closest("td");
      const type = $titleTd.find("div[title] span.small").first().text().trim() || "";
      // Joomla renders one '–' (en dash) before the title link per depth level
      const $td = $titleLink.closest("td");
      const tdHtml = $.html($td) || "";
      const aIdx = tdHtml.indexOf("<a");
      const beforeLink = aIdx >= 0 ? tdHtml.substring(0, aIdx) : "";
      const depth = (beforeLink.match(/–/g) || []).length;
      while (ancestorStack.length > depth) ancestorStack.pop();
      const parent = ancestorStack.length > 0 ? ancestorStack[ancestorStack.length - 1] : null;
      ancestorStack.push({ id: cid, title });
      items.push({
        id: cid,
        title,
        state: this.extractPublishedState(rowHtml),
        type,
        checkedOut: /checked[-_ ]?out|icon-lock|fa-lock/i.test(rowHtml) ? "1" : "0",
        parentId: parent?.id ?? "",
        parentTitle: parent ? parent.title : "Root",
      });
    });
    return items;
  }

  async listMenuItems(menuId?: string, search?: string, limit?: number, page?: number): Promise<JoomlaResponse> {
    const effectiveLimit = limit != null ? Math.min(limit, 500) : 0;
    const effectivePage = Math.max(page ?? 1, 1);
    const limitStart = effectiveLimit > 0 ? (effectivePage - 1) * effectiveLimit : 0;
    const params = new URLSearchParams({
      "option": "com_menus",
      "view": "items",
      "limit": String(effectiveLimit),
      "limitstart": String(limitStart),
      // Sticky session filters — see getMenuItemsListUrl. Sending menutype empty is
      // what makes an unscoped list actually span every menu after a scoped one.
      "menutype": menuId ?? "",
      "filter[search]": search ?? "",
      "filter[published]": "",
    });
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const items = this.parseMenuItemList(html);
    return {
      success: true,
      message: `Found ${items.length} menu items${menuId ? ` in menu "${menuId}"` : " across all menus"}${search ? `, search="${search}"` : ""}`,
      data: items,
      html,
    };
  }

  /**
   * The installed menu item types cannot change within a session, so this is cached
   * here rather than in the create path alone — `inspect` and a repeat `list` were
   * paying a full extra admin page load for an answer we already had.
   */
  async listMenuItemTypes(): Promise<JoomlaResponse> {
    if (this._menuItemTypesCache) {
      return {
        success: true,
        message: `Found ${this._menuItemTypesCache.length} menu item types`,
        data: this._menuItemTypesCache,
      };
    }
    const url = this.getAdminUrl("index.php?option=com_menus&view=menutypes&tmpl=component&client_id=0&recordId=0");
    const { html } = await this.getPage(url);
    const blacklist = this.config.menuItemTypeBlacklist;
    const types = this.parseMenuItemTypes(html).filter((t) => {
      if (!blacklist || blacklist.size === 0) return true;
      const cleanLabel = t.label.split("\t")[0].trim().toLowerCase();
      return !blacklist.has(cleanLabel);
    });
    // Only cache a real answer. An empty parse means the page did not render the
    // accordion we expect, and caching that would break every create in the session.
    if (types.length > 0) this._menuItemTypesCache = types;

    return {
      success: true,
      message: `Found ${types.length} menu item types`,
      data: types,
      html,
    };
  }

  /** The token is returned so callers can post follow-up tasks without re-fetching a page. */
  private async fetchMenuItemForm(id: string): Promise<JoomlaResponse & { token?: { name: string; value: string } | null }> {
    const url = this.getAdminUrl(`index.php?option=com_menus&task=item.edit&id=${id}`);
    const { html, token } = await this.getPage(url);
    const item = this.parseMenuItemForm(html);

    return {
      success: !!item.title,
      message: item.title ? "Menu item retrieved" : "Failed to parse menu item form",
      data: item,
      html,
      token,
    };
  }

  async getMenuItem(id?: string, title?: string, menuId?: string): Promise<JoomlaResponse> {
    if (!id && !title) return { success: false, message: "Either id or title is required" };
    if (!id && title) {
      const matches = await this.searchMenuItemsByTitle(title, menuId);
      if (matches.length === 0) return { success: false, message: `No menu item found matching title '${title}'` };
      if (matches.length === 1) return this.getMenuItem(matches[0].id);
      return { success: true, message: `Multiple menu items found for '${title}' — provide id to get full details`, data: matches };
    }
    const result = await this.fetchMenuItemForm(id!);
    if (result.success) {
      // Release the checkout the edit form just took. This used to call the full
      // checkInMenuItem tool, which re-fetched the edit form and the whole items list
      // to verify a target this method had already read — 7 requests to undo a side
      // effect of the 2 requests above.
      const released = await this.quickCheckIn(id!, result.token ?? null);
      if (!released) {
        result.message = (result.message ?? "") + " (warning: auto-checkin failed)";
      }
    }
    const { token: _token, ...response } = result;
    return response;
  }

  async inspectMenuItemType(itemType: string): Promise<JoomlaResponse> {
    const typesResult = await this.listMenuItemTypes();
    const types = (typesResult.data || []) as MenuItemType[];
    const type = this.findMenuItemType(types, itemType);

    if (!type) {
      return {
        success: false,
        message: `Menu item type not found: ${itemType}`,
        data: types.map(({ group, label, title, request }) => ({ group, label, title, request })),
      };
    }

    return {
      success: true,
      message: "Menu item type retrieved",
      data: {
        ...type,
        link: this.buildLinkFromRequest(type.request),
        requestFields: Object.keys(type.request),
        commonFields: [
          "title",
          "menuType",
          "alias",
          "parentId",
          "published",
          "access",
          "language",
          "browserNav",
          "home",
          "note",
        ],
        overrideExamples: [
          "request.id for Single Article or Category Blog/List",
          "params.menu-anchor_title for link title attributes",
          "params.menu_image for menu images",
          "fieldOverrides can set any raw Joomla field name such as jform[params][show_page_heading]",
        ],
      },
    };
  }

  async createMenuItem(data: {
    title: string;
    menuType: string;
    itemType: string;
    alias?: string;
    link?: string;
    parentId?: string;
    published?: string;
    access?: string;
    language?: string;
    browserNav?: string;
    home?: string;
    note?: string;
    templateStyleId?: string;
    request?: Record<string, string>;
    params?: Record<string, string>;
    fieldOverrides?: Record<string, string>;
  }): Promise<JoomlaResponse> {
    // Serialize via queue: Joomla nested set (lft/rgt) corrupts under concurrent INSERTs
    const prev = this._menuCreateQueue;
    let release!: () => void;
    this._menuCreateQueue = new Promise<void>((r) => { release = r; });
    try {
      const tQueue = Date.now();
      await prev;
      if (JoomlaClient.TIMING) console.error(`[joomla-mcp][timing] createMenuItem queue wait ${Date.now() - tQueue}ms`);
      const result = await this._doCreateMenuItem(data);
      // Self-heal: if nested set placed this item under the wrong parent, fix it now.
      // Compare the saved parent directly. This used to read verification.parentMatches,
      // but collapseVerification drops every per-field key once the save verifies, so the
      // flag was always undefined and the repair update ran on every successful create.
      const rd = result.data as Record<string, unknown> | undefined;
      const expectedParentId = String(data.parentId || "1");
      if (rd && String(rd["parentId"] ?? "") !== expectedParentId) {
        const savedId = String(rd["id"] ?? "");
        if (savedId) {
          await this.updateMenuItem(savedId, { parentId: expectedParentId, menuType: data.menuType });
        }
      }
      return result;
    } finally {
      release();
    }
  }

  private async _doCreateMenuItem(data: {
    title: string;
    menuType: string;
    itemType: string;
    alias?: string;
    link?: string;
    parentId?: string;
    published?: string;
    access?: string;
    language?: string;
    browserNav?: string;
    home?: string;
    note?: string;
    templateStyleId?: string;
    request?: Record<string, string>;
    params?: Record<string, string>;
    fieldOverrides?: Record<string, string>;
  }): Promise<JoomlaResponse> {
    const tTypes = Date.now();
    const typesResult = await this.listMenuItemTypes();
    const types = (typesResult.data || []) as MenuItemType[];
    if (JoomlaClient.TIMING) console.error(`[joomla-mcp][timing] listMenuItemTypes ${Date.now() - tTypes}ms`);
    // Joomla exposes "Heading" as its own system link type, distinct from "Separator" —
    // do not collapse one into the other. findMenuItemType matches itemType against the
    // live type list's title/label/requestKey, so a bare string like "heading" resolves
    // correctly on its own; it previously got silently rewritten to "separator" here,
    // which is why itemType:"heading" saved as a Separator with no error.
    const type = this.findMenuItemType(types, data.itemType);
    if (!type) {
      return { success: false, message: `Menu item type not found: ${data.itemType}` };
    }

    const newItemUrl = this.getAdminUrl("index.php?option=com_menus&task=item.add");
    const tForm = Date.now();
    const { html } = await this.getPage(newItemUrl);
    if (JoomlaClient.TIMING) console.error(`[joomla-mcp][timing] GET item.add ${Date.now() - tForm}ms`);
    const token = this.extractCsrfToken(html);

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    // item.setType round-trips the form so the server returns hidden fields — component_id
    // above all — matching the chosen type. That only tells us something for component
    // types. A system link type (url, separator, alias, heading) has an empty request and
    // no component, so the typed form comes back with the same hidden fields we already
    // hold, and the round trip costs two requests and ~70KB for nothing.
    const isSystemLinkType = Object.keys(type.request).length === 0;
    let typedHtml = html;
    let typedToken = token;
    if (!isSystemLinkType) {
      const setTypeFormData: FormDataMap = {
        ...this.extractFormFields(html),
        task: "item.setType",
        fieldtype: "type",
        "jform[type]": type.encoded,
        "jform[menutype]": data.menuType,
        [token.name]: token.value,
      };
      // Reuse the item.add page we just fetched. It is one of the heaviest pages in
      // Joomla admin (every template style, every menu tree, the full type list), and
      // postPage would otherwise re-GET it before each POST.
      const tType = Date.now();
      const typedPage = await this.postPage(newItemUrl, setTypeFormData, { prefetchedHtml: html });
      if (JoomlaClient.TIMING) console.error(`[joomla-mcp][timing] POST item.setType ${Date.now() - tType}ms`);
      typedHtml = typedPage.html || html;
      typedToken = this.extractCsrfToken(typedHtml) || token;
    }
    const request = { ...type.request, ...(data.request || {}) };
    // System link types (separator, url, alias, heading) have an empty request object;
    // Joomla requires the plain type title string in jform[type] for these.
    // Component types (com_content.article etc.) have a non-empty request and need the
    // base64 encoded JSON payload. Sending the encoded payload for system link types
    // causes Joomla to save the item with "Unknown" type.
    const jformType = Object.keys(type.request).length === 0 ? type.title : type.encoded;
    const formData: FormDataMap = {
      ...this.extractFormFields(html),
      ...this.extractFormFields(typedHtml),
      // See createArticle: "apply" gives a reliable &id= on redirect, "save" doesn't.
      task: "item.apply",
      "jform[title]": data.title,
      "jform[alias]": data.alias || "",
      "jform[menutype]": data.menuType,
      "jform[type]": jformType,
      "jform[link]": data.link || this.buildLinkFromRequest(request),
      "jform[parent_id]": data.parentId || "1",
      "jform[published]": data.published ?? "1",
      "jform[access]": data.access || "1",
      "jform[language]": data.language || "*",
      "jform[browserNav]": data.browserNav || "0",
      "jform[home]": data.home || "0",
      "jform[note]": data.note || "",
      "jform[template_style_id]": data.templateStyleId || "0",
      "jform[menuordering]": "-2",
      [typedToken.name]: typedToken.value,
    };

    for (const [key, value] of Object.entries(request)) {
      formData[`jform[request][${key}]`] = value;
    }

    for (const [key, value] of Object.entries(data.params || {})) {
      formData[`jform[params][${key}]`] = value;
    }

    Object.assign(formData, data.fieldOverrides || {});

    const tApply = Date.now();
    const result = await this.postPage(newItemUrl, formData, { prefetchedHtml: typedHtml });
    if (JoomlaClient.TIMING) console.error(`[joomla-mcp][timing] POST item.apply ${Date.now() - tApply}ms`);
    // Joomla 4/5: success message appears in redirect target HTML.
    // Joomla 3: message format differs and may not match, but a 303 redirect always
    // means Joomla accepted the save — a validation failure stays on the form (200).
    const successMsg = result.redirected || /menu item saved|item saved|has been saved/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    let savedId = "";
    // Published state is read from the list, not the edit form: the edit form's
    // jform[published] defaults to "1" even for unpublished items.
    let publishedFromList = "";
    // Set when a follow-up write ran after item.apply, which makes the apply response
    // HTML stale as a readback source.
    let repaired = false;
    if (successMsg) {
      savedId = result.redirectUrl?.match(/[?&]id=(\d+)/)?.[1] ?? "";
      if (!savedId) {
        // Fallback: search by title so Joomla filters server-side — listing all items
        // hits the default page limit and misses newly created items at the end of a
        // long menu.
        const itemsResult = await this.listMenuItems(data.menuType, data.title);
        const items = Array.isArray(itemsResult.data) ? itemsResult.data as Array<Record<string, string>> : [];
        const exactMatches = items.filter((item) => this.decodeHtmlEntities(item.title) === this.decodeHtmlEntities(data.title));
        const listItem = exactMatches[exactMatches.length - 1];
        savedId = listItem?.id || "";
      }
      // Rebuild the menu nested set (lft/rgt) after each create so the tree stays
      // consistent and subsequent creates don't corrupt the published-state display.
      const tRebuild = Date.now();
      // The apply response is an admin page from this session, so its token is valid
      // for the rebuild task and saves that task its own page fetch.
      await this.rebuildMenuTree(this.extractCsrfToken(result.html) ?? typedToken);
      if (JoomlaClient.TIMING) console.error(`[joomla-mcp][timing] rebuildMenuTree ${Date.now() - tRebuild}ms`);
      // Correct the published state only when Joomla actually got it wrong. This used
      // to run unconditionally, which cost a full extra edit-form round trip (~5
      // requests) on every single create even though the common case — published:"1",
      // which is also Joomla's default — needs no correction at all.
      // items.publish fails when the item is checked out, so the repair still goes
      // through updateMenuItem's edit-form path rather than the list task.
      if (savedId) {
        const expectedPublished = data.published ?? "1";
        publishedFromList = await this.readPublishedFromList(data.menuType, data.title, savedId);
        if (publishedFromList !== expectedPublished) {
          await this.updateMenuItem(savedId, { published: expectedPublished, menuType: data.menuType });
          publishedFromList = await this.readPublishedFromList(data.menuType, data.title, savedId);
          repaired = true;
        }
      }
    }
    const tVerify = Date.now();
    // task=item.apply redirects to the saved item's own edit form, so result.html already
    // is the readback — unless a published-state repair ran since, which invalidates it.
    // Either way item.apply leaves the item checked out, so release it afterwards.
    let verify: (JoomlaResponse & { token?: { name: string; value: string } | null }) | null = null;
    if (savedId) {
      const applyHtmlIsForm = !repaired && /view=item\b/.test(result.redirectUrl ?? "") && /layout=edit/.test(result.redirectUrl ?? "");
      if (applyHtmlIsForm) {
        const parsed = this.parseMenuItemForm(result.html);
        if (parsed.title) {
          verify = { success: true, message: "Menu item retrieved", data: parsed, token: this.extractCsrfToken(result.html) };
        }
      }
      if (!verify) verify = await this.fetchMenuItemForm(savedId);
      if (verify.success) await this.quickCheckIn(savedId, verify.token ?? null);
    }
    if (JoomlaClient.TIMING) console.error(`[joomla-mcp][timing] verify readback ${Date.now() - tVerify}ms`);
    const item = ((verify?.data || {}) as Record<string, unknown>);
    const verification = {
      attempted: true,
      foundInList: !!savedId,
      readbackSucceeded: !!verify?.success,
      titleMatches: !!verify?.success && this.decodeHtmlEntities(String(item.title || "")) === this.decodeHtmlEntities(data.title),
      aliasMatches: !!verify?.success && this.verifyAlias(String(item.alias || ""), data.alias),
      menuTypeMatches: !!verify?.success && String(item.menuType || "") === data.menuType,
      parentMatches: !!verify?.success && String(item.parentId || "") === String(data.parentId || "1"),
      publishedMatches: publishedFromList !== ""
        ? publishedFromList === String(data.published ?? "1")
        : (!!verify?.success && String(item.published || "") === String(data.published ?? "1")),
      accessMatches: !!verify?.success && String(item.access || "") === String(data.access || "1"),
      languageMatches: !!verify?.success && String(item.language || "") === String(data.language || "*"),
      browserNavMatches: !!verify?.success && String(item.browserNav || "") === String(data.browserNav || "0"),
      homeMatches: !!verify?.success && String(item.home || "") === String(data.home || "0"),
      // Joomla silently drops jform[template_style_id] back to "0" when the submitted
      // value isn't among the rendered <select> options (e.g. a just-duplicated outline
      // Joomla hasn't listed yet) — no error, no redirect change, "success" message intact.
      // Only check this when the caller actually asked for a non-default outline; template
      // style 0 (site default) is a legitimate, common choice and shouldn't force a readback.
      templateStyleMatches: !data.templateStyleId || data.templateStyleId === "0" || (!!verify?.success && String(item.templateStyleId || "0") === String(data.templateStyleId)),
    };
    const verified = Object.values(verification).every((value) => value === true);

    return {
      success: verified,
      message: verified ? "Menu item saved" : (errorMsg ?? (successMsg ? "Menu item save submitted, but creation was not verified" : "Menu item save was rejected by Joomla and no alert message was returned")),
      data: this.buildOperationData("menuItem", savedId, {
        title: String(item.title || data.title),
        state: publishedFromList || String(item.published || data.published || "1"),
        alias: String(item.alias || data.alias || ""),
        menuType: String(item.menuType || data.menuType),
        parentId: String(item.parentId || data.parentId || "1"),
        itemType: type.title || data.itemType,
        verification: this.collapseVerification(verification, verified),
      }),
      html: result.html,
    };
  }

  async updateMenuItem(
    id: string,
    data: {
    title?: string;
    itemType?: string;
    alias?: string;
    menuType?: string;
    link?: string;
      parentId?: string;
      published?: string;
      access?: string;
      language?: string;
      browserNav?: string;
      home?: string;
      note?: string;
      templateStyleId?: string;
      ordering?: string;
      request?: Record<string, string>;
      params?: Record<string, string>;
      fieldOverrides?: Record<string, string>;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_menus&task=item.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const existing = this.parseMenuItemForm(html);
    const token = this.extractCsrfToken(html);
    let type = null as MenuItemType | null;

    if (!token) {
      return { success: false, message: "Failed to extract CSRF token" };
    }

    if (data.itemType) {
      const typesResult = await this.listMenuItemTypes();
      const types = (typesResult.data || []) as MenuItemType[];
      // See _doCreateMenuItem: "Heading" is its own Joomla system link type, distinct
      // from "Separator" — do not rewrite one to the other before the lookup.
      type = this.findMenuItemType(types, data.itemType);
      if (!type) {
        return { success: false, message: `Menu item type not found: ${data.itemType}` };
      }
    }

    // When changing type, POST item.setType first so the server returns form HTML with
    // component_id (and other hidden fields) correctly set for the new type — same as
    // what the browser's JS does when a user picks a type from the dropdown.
    let formBaseHtml = html;
    let effectiveToken = token;
    if (type) {
      const setTypeFormData: FormDataMap = {
        ...this.extractFormFields(html),
        task: "item.setType",
        fieldtype: "type",
        "jform[type]": type.encoded,
        "jform[menutype]": data.menuType ?? String(existing.menuType || ""),
        [token.name]: token.value,
      };
      // Reuse the edit page fetched above rather than letting postPage re-GET it.
      const typedPage = await this.postPage(editUrl, setTypeFormData, { prefetchedHtml: html });
      formBaseHtml = typedPage.html || html;
      effectiveToken = this.extractCsrfToken(formBaseHtml) || token;
    }

    const request = { ...((type?.request || existing.request) as Record<string, string>), ...(data.request || {}) };
    const aliasTarget = data.params?.aliasoptions;
    const effectiveType = type?.title ?? String(existing.type || "");
    const aliasLink = aliasTarget && (effectiveType === "alias" || data.itemType === "alias")
      ? `index.php?Itemid=${aliasTarget}`
      : undefined;
    const baseFormFields = this.extractFormFields(formBaseHtml);
    const formData: FormDataMap = {
      ...baseFormFields,
      // "apply" rather than "save": both persist identically, but apply redirects back to
      // this item's edit form, so the response IS the verification readback. "save"
      // redirects to the items list and forces a second round trip to re-read the item.
      task: "item.apply",
      "jform[title]": data.title ?? String(existing.title || ""),
      "jform[alias]": data.alias ?? String(existing.alias || ""),
      "jform[menutype]": data.menuType ?? String(existing.menuType || ""),
      "jform[type]": type ? (this.getJFormField(baseFormFields, "type") || type.title) : String(existing.type || ""),
      "jform[link]": data.link ?? aliasLink ?? (type ? this.buildLinkFromRequest(request) : String(existing.link || this.buildLinkFromRequest(request))),
      "jform[parent_id]": data.parentId ?? String(existing.parentId || "1"),
      "jform[published]": data.published ?? String(existing.published || "1"),
      "jform[access]": data.access ?? String(existing.access || "1"),
      "jform[language]": data.language ?? String(existing.language || "*"),
      "jform[browserNav]": data.browserNav ?? String(existing.browserNav || "0"),
      "jform[home]": data.home ?? String(existing.home || "0"),
      "jform[note]": data.note ?? String(existing.note || ""),
      "jform[template_style_id]": data.templateStyleId ?? String(existing.templateStyleId || "0"),
      [effectiveToken.name]: effectiveToken.value,
    };

    for (const [key, value] of Object.entries(request)) {
      formData[`jform[request][${key}]`] = value;
    }

    for (const [key, value] of Object.entries(data.params || {})) {
      formData[`jform[params][${key}]`] = value;
    }

    if (data.ordering !== undefined) {
      formData["jform[menuordering]"] = data.ordering;
    }

    Object.assign(formData, data.fieldOverrides || {});

    // For alias items: ensure jform[link] reflects the aliasoptions target so Joomla
    // saves it correctly and the form readback returns the right value.
    const overrideAlias = data.fieldOverrides?.["jform[params][aliasoptions]"];
    if (overrideAlias && !data.link && !aliasLink) {
      const effectiveFormType = formData["jform[type]"] || "";
      if (effectiveFormType === "alias" || effectiveFormType.includes("alias")) {
        formData["jform[link]"] = `index.php?Itemid=${overrideAlias}`;
      }
    }

    // formBaseHtml is the exact page this POST targets — no need for postPage to re-GET it.
    const result = await this.postPage(editUrl, formData, { prefetchedHtml: formBaseHtml });
    const successMsg = /menu item saved|item saved|has been saved/i.test(result.html);
    const errorMsg = this.extractAlertMessage(result.html);
    // The apply redirect lands on this item's edit form, so parse the response we already
    // have instead of re-fetching it. Fall back to an explicit read if Joomla redirected
    // elsewhere (a validation bounce, for instance). apply leaves the item checked out.
    let verify: (JoomlaResponse & { token?: { name: string; value: string } | null }) | null = null;
    if (/view=item\b/.test(result.redirectUrl ?? "") && /layout=edit/.test(result.redirectUrl ?? "")) {
      const parsed = this.parseMenuItemForm(result.html);
      if (parsed.title) {
        verify = { success: true, message: "Menu item retrieved", data: parsed, token: this.extractCsrfToken(result.html) };
      }
    }
    if (!verify) verify = await this.fetchMenuItemForm(id);
    if (verify.success) await this.quickCheckIn(id, verify.token ?? null);
    const item = (verify.data || {}) as Record<string, unknown>;
    const verification = {
      attempted: true,
      readbackSucceeded: verify.success,
      titleMatches: !!verify.success && this.decodeHtmlEntities(String(item.title || "")) === this.decodeHtmlEntities(String(formData["jform[title]"] || "")),
      aliasMatches: !!verify.success && String(item.alias || "") === String(formData["jform[alias]"] || ""),
      menuTypeMatches: !!verify.success && String(item.menuType || "") === String(formData["jform[menutype]"] || ""),
      parentMatches: !!verify.success && String(item.parentId || "") === String(formData["jform[parent_id]"] || ""),
      publishedMatches: !!verify.success && String(item.published || "") === String(formData["jform[published]"] || ""),
      accessMatches: !!verify.success && String(item.access || "") === String(formData["jform[access]"] || ""),
      languageMatches: !!verify.success && String(item.language || "") === String(formData["jform[language]"] || ""),
      browserNavMatches: !!verify.success && String(item.browserNav || "") === String(formData["jform[browserNav]"] || ""),
      homeMatches: !!verify.success && String(item.home || "") === String(formData["jform[home]"] || ""),
      noteMatches: !!verify.success && String(item.note || "") === String(formData["jform[note]"] || ""),
      // Joomla silently drops jform[template_style_id] back to "0" when the submitted
      // value isn't among the rendered <select> options (e.g. a just-duplicated outline
      // Joomla hasn't listed yet) — no error, no redirect change, "success" message intact.
      // Only check this when the caller actually changed templateStyleId; leaving it
      // untouched (data.templateStyleId undefined) shouldn't force a readback comparison.
      templateStyleMatches: data.templateStyleId === undefined || (!!verify.success && String(item.templateStyleId || "0") === String(formData["jform[template_style_id]"] || "0")),
    };
    const verified = Object.values(verification).every((value) => value === true);

    return {
      success: verified,
      message: verified ? "Menu item saved" : (errorMsg ?? (successMsg ? "Menu item save submitted, but updated values were not verified" : "Menu item save was rejected by Joomla and no alert message was returned")),
      data: this.buildOperationData("menuItem", id, {
        title: String(item.title || formData["jform[title]"] || ""),
        state: String(item.published || formData["jform[published]"] || ""),
        alias: String(item.alias || formData["jform[alias]"] || ""),
        menuType: String(item.menuType || formData["jform[menutype]"] || ""),
        parentId: String(item.parentId || formData["jform[parent_id]"] || ""),
        verification: this.collapseVerification(verification, verified),
      }),
      html: result.html,
    };
  }

  async deleteMenuItem(id: string, options: { expectedTitle?: string; expectedMenuType?: string; menuType?: string } = {}): Promise<JoomlaResponse> {
    const pre = await this.menuItemPreflight(id, options.menuType, "delete", options);
    if (!pre.ok) return { success: false, message: pre.message };
    const { title, menuType, token } = pre;

    const listUrl = this.getMenuItemsListUrl(menuType || undefined, `id:${id}`);
    const result = await this.postPage(listUrl, { task: "items.trash", "cid[]": id }, { token, noFollow: true });

    // The list URL pins filter[published] to its default, which excludes trashed items,
    // so a trashed item drops out of this read. That is the check. Re-reading the edit
    // form to confirm — as this used to — cost three more requests and left the item
    // checked out again, for a weaker signal than its absence from the list.
    const verifyPage = await this.getPage(listUrl);
    const listedItem = this.parseMenuItemList(verifyPage.html).find((entry) => entry.id === id);
    const errorMsg = this.extractAlertMessage(verifyPage.html);
    const stillListed = !!listedItem && listedItem.state !== "Trashed";
    const verified = !stillListed;

    return {
      success: verified,
      message: verified
        ? "Menu item trashed"
        : (errorMsg ?? "Menu item trash submitted, but deletion was not verified"),
      data: this.buildOperationData("menuItem", id, {
        title,
        state: "-2",
        menuType,
        verification: {
          attempted: true,
          preflightVerified: true,
          listCheckAttempted: !!menuType,
          stillListed,
          verified,
        },
      }),
      html: result.html,
    };
  }

  async toggleMenuItem(id: string, state: string, menuType?: string, options: { expectedTitle?: string; expectedMenuType?: string } = {}): Promise<JoomlaResponse> {
    const pre = await this.menuItemPreflight(id, menuType, "change", options);
    if (!pre.ok) return { success: false, message: pre.message };
    const { title, menuType: actualMenuType, token } = pre;

    // Address exactly this row so the verification read returns a few KB instead of
    // the whole menu, and cannot be confused by a similarly titled sibling.
    const listUrl = this.getMenuItemsListUrl(actualMenuType, `id:${id}`);
    const task = state === "1" ? "items.publish" : "items.unpublish";
    // noFollow: the redirect target is the items list under whatever filters the session
    // happens to hold, so it is not a trustworthy readback — the explicit filtered GET
    // below is. Skipping the redirect body drops a page we would only throw away.
    const result = await this.postPage(listUrl, {
      task,
      "cid[]": id,
      boxchecked: "1",
    }, { token, noFollow: true });

    // Verify from the list rather than the edit form: the edit form's jform[published]
    // falls back to "1", which reads as a false positive whenever the field isn't
    // captured. Joomla queues its system message in the session until something renders
    // it, and nothing has yet, so this page carries any error the task produced.
    const verifyPage = await this.getPage(listUrl);
    const listedItem = this.parseMenuItemList(verifyPage.html).find((entry) => entry.id === id);
    const errorMsg = this.extractAlertMessage(verifyPage.html);
    const expectedLabel = state === "1" ? "Published" : "Unpublished";
    const foundInList = !!listedItem;
    const actualLabel = listedItem?.state ?? "Unknown";
    const verified = foundInList && actualLabel === expectedLabel;

    return {
      success: verified,
      message: verified
        ? `Menu item ${state === "1" ? "published" : "unpublished"}`
        : (errorMsg ?? `Menu item state was not verified after ${task}`),
      data: this.buildOperationData("menuItem", id, {
        title: listedItem?.title ?? title,
        state: actualLabel === "Published" ? "1" : actualLabel === "Unpublished" ? "0" : "",
        verification: {
          attempted: true,
          preflightVerified: true,
          requestedState: state,
          actualState: actualLabel,
          foundInList,
          verified,
        },
        menuType: actualMenuType,
      }),
      html: result.html,
    };
  }

  async checkInMenuItem(id: string, menuType?: string, options: { expectedTitle?: string; expectedMenuType?: string } = {}): Promise<JoomlaResponse> {
    // The preflight reads the list, not the edit form. That matters more here than
    // anywhere else: opening the edit form checks the item out, so the old preflight
    // checked out the very item it was about to check in.
    const pre = await this.menuItemPreflight(id, menuType, "check in", options);
    if (!pre.ok) return { success: false, message: pre.message };
    const { title, menuType: actualMenuType, token } = pre;

    // The preflight holds a valid session token, so the task needs no page fetch of its own.
    const listUrl = this.getMenuItemsListUrl(actualMenuType, `id:${id}`);
    const result = await this.postPage(listUrl, {
      task: "items.checkin",
      "cid[]": id,
      boxchecked: "1",
    }, { token, noFollow: true });

    const verifyPage = await this.getPage(listUrl);
    const listedItem = this.parseMenuItemList(verifyPage.html).find((entry) => entry.id === id);
    const errorMsg = this.extractAlertMessage(verifyPage.html);
    const checkedOutCleared = !!listedItem && listedItem.checkedOut !== "1";

    return {
      success: checkedOutCleared,
      message: checkedOutCleared ? "Menu item checked in" : (errorMsg ?? "Menu item check-in submitted, but checkout state was not verified as cleared"),
      data: this.buildOperationData("menuItem", id, {
        title,
        state: String(listedItem?.state || ""),
        verification: {
          attempted: true,
          preflightVerified: true,
          listedAfterCheckIn: !!listedItem,
          checkedOutCleared,
        },
        menuType: actualMenuType,
      }),
      html: result.html,
    };
  }

  // ==================== UTILITIES ====================

  async getPageContent(path: string): Promise<JoomlaResponse> {
    const url = this.getAdminUrl(path);
    const { html } = await this.getPage(url);
    return {
      success: true,
      message: "Page retrieved",
      html: html.substring(0, 50000),
    };
  }

  private findMainContent($: ReturnType<typeof cheerioLoad>) {
    const selectors = [
      "#g-mainbar", "#g-content", "#g-container-main", // Gantry5 (before generic "main")
      "[role='main']",
      "#sp-main-body", "#sp-component",                // Protostar/Cassiopeia
      ".com-content-article", ".item-page", "article", ".blog",
      "#content", "main",
    ];
    for (const sel of selectors) {
      const el = $(sel);
      // require at least 150 chars of text so we skip empty wrappers
      if (el.length > 0 && el.first().text().trim().length > 150) return el.first();
    }
    return $("body");
  }

  async getFrontendPageInfo(path: string): Promise<JoomlaResponse> {
    const url = path.startsWith("http")
      ? path
      : path.startsWith("/")
        ? `${this.getBaseUrl()}${path}`
        : `${this.getBaseUrl()}/${path}`;

    const response = await fetch(url, {
      headers: outboundHeaders(url),
      redirect: "follow",
    });
    if (!response.ok) {
      return { success: false, message: `HTTP ${response.status} fetching ${url}` };
    }
    const html = await response.text();
    const $ = cheerioLoad(html);

    // --- existing fields ---
    const pageTitle = $("title").first().text().trim();
    const h1 = $("h1").first().text().trim();
    const metaDescription = $("meta[name='description']").attr("content")?.trim() ?? "";
    const canonicalUrl = $("link[rel='canonical']").attr("href")?.trim() ?? url;
    const siteName = $("meta[property='og:site_name']").attr("content")?.trim() ?? "";
    const cleanTitle = siteName && pageTitle.endsWith(` - ${siteName}`)
      ? pageTitle.slice(0, -(` - ${siteName}`).length).trim()
      : pageTitle;

    // --- headings ---
    const headings: { level: number; text: string }[] = [];
    $("h1, h2, h3, h4").slice(0, 50).each((_, el) => {
      const level = parseInt(el.tagName.replace("h", ""), 10);
      const text = $(el).text().trim();
      if (text) headings.push({ level, text });
    });

    // --- main content area ---
    const mainContent = this.findMainContent($);
    const mainClone = mainContent.clone();
    mainClone.find("script, style, noscript, nav, header, footer, .nav, .navbar, .breadcrumb, .pagination, #sp-menu, #sp-top-bar, #sp-header, #sp-footer, #sp-bottom").remove();

    // --- bodyText ---
    const rawText = mainClone.text().replace(/\s+/g, " ").trim();
    const bodyText = rawText.length > 8000
      ? rawText.slice(0, 8000) + ` [truncated — ${rawText.length} chars total]`
      : rawText;

    // --- links ---
    const seenHrefs = new Set<string>();
    const links: { text: string; href: string; rel?: string }[] = [];
    mainContent.find("a[href]").each((_, el) => {
      if (links.length >= 100) return;
      const rawHref = $(el).attr("href") ?? "";
      if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) return;
      const text = $(el).text().trim();
      if (!text) return;
      let href = rawHref;
      try { href = new URL(rawHref, url).href; } catch { return; }
      if (seenHrefs.has(href)) return;
      seenHrefs.add(href);
      const rel = $(el).attr("rel");
      links.push(rel ? { text, href, rel } : { text, href });
    });

    // --- images ---
    const images: { src: string; alt: string }[] = [];
    mainContent.find("img[src]").each((_, el) => {
      if (images.length >= 20) return;
      const rawSrc = $(el).attr("src") ?? "";
      if (!rawSrc || rawSrc.startsWith("data:") || rawSrc.includes("/media/system/")) return;
      let src = rawSrc;
      try { src = new URL(rawSrc, url).href; } catch { return; }
      images.push({ src, alt: $(el).attr("alt") ?? "" });
    });

    // --- forms ---
    const forms: { action: string; method: string; fieldNames: string[] }[] = [];
    $("form").each((_, el) => {
      if (forms.length >= 10) return;
      const fieldNames = [...new Set(
        $(el).find("input[name], select[name], textarea[name]")
          .map((__, f) => $(f).attr("name") ?? "").get().filter(Boolean)
      )];
      if (fieldNames.length === 0) return;
      let action = $(el).attr("action") ?? url;
      try { action = new URL(action, url).href; } catch { /* keep as-is */ }
      const method = ($(el).attr("method") ?? "GET").toUpperCase();
      forms.push({ action, method, fieldNames });
    });

    // --- openGraph ---
    const ogTitle = $("meta[property='og:title']").attr("content")?.trim();
    const ogDescription = $("meta[property='og:description']").attr("content")?.trim();
    const ogImage = $("meta[property='og:image']").attr("content")?.trim();
    const ogType = $("meta[property='og:type']").attr("content")?.trim();
    const openGraph = (ogTitle || ogDescription || ogImage || ogType || siteName)
      ? { title: ogTitle, description: ogDescription, image: ogImage, type: ogType, siteName: siteName || undefined }
      : undefined;

    // --- structuredData ---
    const structuredData: unknown[] = [];
    $("script[type='application/ld+json']").each((_, el) => {
      if (structuredData.length >= 5) return;
      try { structuredData.push(JSON.parse($(el).html() ?? "")); } catch { /* skip invalid */ }
    });

    // --- joomlaTemplate ---
    let joomlaTemplate = "unknown";
    $("link[rel='stylesheet']").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const match = href.match(/\/templates\/([^/]+)\//);
      if (match) { joomlaTemplate = match[1]; return false; }
    });
    const bodyClasses = $("body").attr("class") ?? "";
    const htmlClasses = $("html").attr("class") ?? "";
    const allClasses = bodyClasses + " " + htmlClasses;
    if (allClasses.match(/\bg-[a-z]/i) || $("[id='g-page-surround']").length > 0) {
      const cssHref = $("link[rel='stylesheet'][href*='gantry5']").attr("href") ?? "";
      const themeMatch = cssHref.match(/themes\/([^/]+)\//);
      joomlaTemplate = themeMatch ? `gantry5 (${themeMatch[1]})` : "gantry5";
    } else if (joomlaTemplate.includes("cassiopeia")) {
      joomlaTemplate = "cassiopeia";
    } else if (joomlaTemplate.includes("protostar")) {
      joomlaTemplate = "protostar";
    }

    // --- joomlaContext ---
    const bodyClassList = bodyClasses.split(/\s+/);
    const component = bodyClassList.find(c => c.startsWith("com-"))?.replace("com-", "com_").replace(/-/g, "_") ?? null;
    const view = bodyClassList.find(c => c.startsWith("view-"))?.replace("view-", "") ?? null;
    const layout = bodyClassList.find(c => c.startsWith("layout-"))?.replace("layout-", "") ?? null;
    const itemidRaw = bodyClassList.find(c => c.startsWith("itemid-"));
    const itemid = itemidRaw ? itemidRaw.replace("itemid-", "") : null;
    const language = $("html").attr("lang") ?? null;
    const joomlaContext = { component, view, layout, itemid, language };

    // --- articleTitles ---
    const articleTitleSet = new Set<string>();
    const articleSelectors = [
      "h2.article-title", "h3.article-title",
      "h2[itemprop='name']", "h3[itemprop='name']",
      "h2.contentheading", "h3.contentheading",
      "article header h2", "article header h3",
      "[itemtype*='schema.org/Article'] [itemprop='name']",
    ];
    for (const sel of articleSelectors) {
      $(sel).each((_, el) => {
        const t = $(el).text().trim();
        if (t) articleTitleSet.add(t);
      });
    }
    // Catch-all: h2/h3 directly wrapping a link (standard Joomla blog layout)
    $("h2 > a[href], h3 > a[href]").each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href") ?? "";
      if (text && href && !href.startsWith("javascript:")) articleTitleSet.add(text);
    });
    const articleTitles = [...articleTitleSet].slice(0, 20);

    // --- modulePositions ---
    const positionSet = new Set<string>();
    $("[id^='sp-']").each((_, el) => {
      const pos = ($(el).attr("id") ?? "").replace(/^sp-/, "");
      if (pos) positionSet.add(pos);
    });
    $("[id^='g-']").each((_, el) => {
      const pos = ($(el).attr("id") ?? "").replace(/^g-/, "");
      if (pos) positionSet.add(pos);
    });
    $("div[data-gantry-position]").each((_, el) => {
      const pos = $(el).attr("data-gantry-position");
      if (pos) positionSet.add(pos);
    });
    const modulePositions = [...positionSet];

    return {
      success: true,
      message: `Frontend page retrieved: ${url}`,
      data: {
        url, pageTitle, cleanTitle, h1, metaDescription, canonicalUrl,
        headings, bodyText, links, images, forms, openGraph, structuredData,
        joomlaTemplate, joomlaContext, articleTitles, modulePositions, rawHtml: html,
      },
    };
  }

  /** Viewport presets shared by every frontend browser tool. */
  private static readonly FRONTEND_VIEWPORTS = {
    mobile:  { width: 390,  height: 844 },
    tablet:  { width: 768,  height: 1024 },
    desktop: { width: 1280, height: 800 },
  } as const;

  /** Resolve a caller-supplied path or absolute URL against the active site. */
  private frontendUrl(inputPath: string): string {
    if (inputPath.startsWith('http')) return inputPath;
    return inputPath.startsWith('/')
      ? `${this.getBaseUrl()}${inputPath}`
      : `${this.getBaseUrl()}/${inputPath}`;
  }

  /**
   * Open a frontend page in the pooled browser with the admin session attached.
   *
   * Cookies are only injected when the target host matches the active site —
   * sending a session cookie to a third-party host would leak it. Callers own
   * the returned page and must close it.
   */
  private async openFrontendPage(
    url: string,
    viewport: 'mobile' | 'tablet' | 'desktop'
  ): Promise<{ page: import('puppeteer').Page; width: number; height: number; status: number }> {
    const { width, height } = JoomlaClient.FRONTEND_VIEWPORTS[viewport];

    if (!this._browser || !this._browser.connected) {
      this._browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    }

    const page = await this._browser.newPage();
    try {
      await page.setUserAgent(userAgentFor(url));
      await page.setViewport({ width, height });

      const cookieDomain = new URL(this.getBaseUrl()).hostname;
      const urlDomain = new URL(url).hostname;
      const cookieEntries = Array.from(this.cookies.entries());
      if (cookieEntries.length > 0 && urlDomain === cookieDomain) {
        await page.setCookie(
          ...cookieEntries.map(([name, value]) => ({ name, value, domain: cookieDomain }))
        );
      }

      const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      return { page, width, height, status: response?.status() ?? 0 };
    } catch (err) {
      await page.close();
      throw err;
    }
  }

  async getFrontendScreenshot(
    inputPath: string,
    viewport: 'mobile' | 'tablet' | 'desktop' = 'desktop'
  ): Promise<JoomlaResponse> {
    const url = this.frontendUrl(inputPath);
    const { page, width, height, status } = await this.openFrontendPage(url, viewport);
    try {
      if (status < 200 || status >= 300) {
        return { success: false, message: `HTTP ${status || '?'} fetching ${url}` };
      }
      await new Promise(r => setTimeout(r, 2000));

      // Scroll through the page to trigger lazy-loaded content before capturing
      await page.evaluate(() => new Promise<void>((resolve) => {
        const w = globalThis as any;
        const distance = 200;
        const delay = 80;
        const timer = setInterval(() => {
          w.scrollBy(0, distance);
          if (w.scrollY + w.innerHeight >= w.document.body.scrollHeight) {
            clearInterval(timer);
            w.scrollTo(0, 0);
            resolve();
          }
        }, delay);
      }));
      await new Promise(r => setTimeout(r, 500));

      const pageTitle = await page.title();
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: true });
      const base64 = Buffer.from(screenshotBuffer).toString('base64');

      return {
        success: true,
        message: `Screenshot captured: ${url}`,
        data: { url, pageTitle, viewport, width, height, base64 },
      };
    } finally {
      await page.close();
    }
  }

  /**
   * Inspect one region of a rendered frontend page.
   *
   * A screenshot shows *that* something is wrong; the page source shows what
   * markup exists. Neither shows why an element sits where it does, which is
   * usually a box-model or specificity question that can only be answered
   * against the live CSSOM. This runs in the real browser and reports the
   * structure, the geometry, and the CSS rules that actually match.
   *
   * Everything here is built to stay small enough to read: the tree is
   * depth- and count-capped, text is truncated, and the CSS side reports only
   * rules that match the target element under the *current* media query
   * instead of dumping stylesheets. The `winners` map — which selector won
   * each property — is the part that answers "why is my rule not applying".
   */
  async inspectFrontend(opts: {
    path: string;
    selector: string;
    viewport?: 'mobile' | 'tablet' | 'desktop';
    include?: Array<'box' | 'text' | 'css'>;
    cssFor?: string;
    properties?: string[];
    depth?: number;
    maxNodes?: number;
    maxMatches?: number;
    textLimit?: number;
    settleMs?: number;
    includeInactiveMedia?: boolean;
    fetchCrossOrigin?: boolean;
  }): Promise<JoomlaResponse> {
    const {
      selector,
      viewport = 'desktop',
      include = ['box'],
      cssFor,
      properties,
      depth = 3,
      maxNodes = 60,
      maxMatches = 3,
      textLimit = 80,
      settleMs = 1200,
      includeInactiveMedia = false,
      fetchCrossOrigin = true,
    } = opts;

    if (!selector) return { success: false, message: 'selector is required' };

    const url = this.frontendUrl(opts.path);
    const { page, width, height, status } = await this.openFrontendPage(url, viewport);
    try {
      if (status < 200 || status >= 300) {
        return { success: false, message: `HTTP ${status || '?'} fetching ${url}` };
      }

      // Scroll the target into view before measuring. Scroll-triggered reveals
      // (the .s-animate pattern) start life offset by a transform, so measuring
      // an un-revealed element reports the wrong geometry.
      await page.evaluate((sel: string) => {
        const el = (globalThis as any).document.querySelector(sel);
        if (el) el.scrollIntoView({ block: 'center' });
      }, selector);
      await new Promise(r => setTimeout(r, settleMs));

      // On these sites most CSS is served from a CDN (CloudFront, solutiocdn),
      // which makes it cross-origin to the page. The CSSOM refuses to expose
      // `cssRules` for such sheets, so the browser alone can only read the
      // handful served from the site's own host — on a typical Gantry page that
      // is override.css and nothing else. Node is not subject to CORS, so fetch
      // the unreadable ones here and hand the text back for re-parsing in place.
      let externalSheets: Array<{ index: number; href: string; text: string }> = [];
      const unreadable: Array<{ index: number; href: string }> = [];
      const unfetched: string[] = [];
      if (include.includes('css') && fetchCrossOrigin) {
        const inventory = await page.evaluate(() => {
          const g = globalThis as any;
          if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn;
          return (Array.from(g.document.styleSheets) as any[]).map((sheet, index) => {
            let readable = true;
            try { void sheet.cssRules; } catch { readable = false; }
            return { index, href: sheet.href as string | null, readable };
          });
        });

        for (const s of inventory) {
          if (!s.readable && s.href) unreadable.push({ index: s.index, href: s.href });
        }

        const MAX_SHEET_BYTES = 1_500_000;
        const fetched = await Promise.all(
          unreadable.map(async ({ index, href }) => {
            try {
              const res = await fetch(href, { headers: { 'user-agent': userAgentFor(href) } });
              if (!res.ok) return { index, href, error: `HTTP ${res.status}` };
              const text = await res.text();
              if (text.length > MAX_SHEET_BYTES) {
                return { index, href, error: `${Math.round(text.length / 1024)}KB, over cap` };
              }
              return { index, href, text };
            } catch (e) {
              return { index, href, error: e instanceof Error ? e.message : String(e) };
            }
          })
        );
        for (const f of fetched) {
          if ('text' in f && f.text !== undefined) externalSheets.push({ index: f.index, href: f.href, text: f.text });
          else unfetched.push(`${f.href.split('/').pop()?.split('?')[0]} (${(f as { error: string }).error})`);
        }
      }

      const result = await page.evaluate(
        (args: {
          selector: string; include: string[]; cssFor: string | null;
          properties: string[] | null; depth: number; maxNodes: number;
          maxMatches: number; textLimit: number; includeInactiveMedia: boolean;
          externalSheets: Array<{ index: number; href: string; text: string }>;
        }) => {
          const g = globalThis as any;
          // esbuild — which tsx uses to run the server in dev — rewrites nested
          // function definitions to call a module-scope __name helper. evaluate()
          // ships only this function's own source to the browser, so that helper
          // is undefined there and the first inner definition throws. Install a
          // no-op before anything else runs. tsc emits no such helper, so this is
          // dead weight in the built output and harmless either way.
          if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn;
          const doc = g.document;
          const wantBox = args.include.includes('box');
          const wantText = args.include.includes('text');
          const wantCss = args.include.includes('css');

          const px = (v: string) => (v === '0px' ? '0' : v);
          const label = (el: any) => {
            const id = el.id ? `#${el.id}` : '';
            const cls = (el.getAttribute('class') || '')
              .trim().split(/\s+/).filter(Boolean).map((c: string) => `.${c}`).join('');
            return `${el.tagName.toLowerCase()}${id}${cls}`;
          };

          /** Approximate (id, class, element) specificity. Good enough to rank. */
          const specificity = (sel: string): [number, number, number] => {
            const s = sel.replace(/\s*[>+~]\s*/g, ' ');
            const ids = (s.match(/#[\w-]+/g) || []).length;
            const cls = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)(?!not\b|is\b|where\b)[\w-]+/g) || []).length;
            const els = (s.match(/(?:^|\s)(?![.#:[])[a-zA-Z][\w-]*/g) || []).length
              + (s.match(/::[\w-]+/g) || []).length;
            return [ids, cls, els];
          };
          const cmpSpec = (a: number[], b: number[]) =>
            a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

          const sheetName = (href: string | null) =>
            href ? (href.split('/').pop() || href).split('?')[0] : '<inline>';

          // ---- tree walk -------------------------------------------------
          let nodeBudget = args.maxNodes;
          const walk = (el: any, level: number): any => {
            if (nodeBudget-- <= 0) return null;
            const node: any = { level, el: label(el) };
            if (wantBox) {
              const r = el.getBoundingClientRect();
              const cs = g.getComputedStyle(el);
              node.box = {
                top: Math.round(r.top), bottom: Math.round(r.bottom),
                w: Math.round(r.width), h: Math.round(r.height),
                margin: `${px(cs.marginTop)}/${px(cs.marginBottom)}`,
                padding: `${px(cs.paddingTop)}/${px(cs.paddingBottom)}`,
                display: cs.display,
              };
              if (cs.position !== 'static') node.box.position = cs.position;
            }
            if (wantText) {
              const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
              if (t) node.text = t.length > args.textLimit ? `${t.slice(0, args.textLimit)}…` : t;
            }
            if (level < args.depth) {
              const kids = Array.from(el.children).map((c: any) => walk(c, level + 1)).filter(Boolean);
              if (kids.length) node.children = kids;
            } else if (el.children.length) {
              node.truncated = `${el.children.length} more child element(s)`;
            }
            return node;
          };

          // ---- CSS rules matching one element ----------------------------
          const opaqueSheets: string[] = [];
          const recoveredSheets: string[] = [];
          const externalByIndex = new Map<number, { href: string; text: string }>(
            args.externalSheets.map((s) => [s.index, { href: s.href, text: s.text }])
          );

          /**
           * Stylesheets in document order, with cross-origin ones rebuilt from
           * text fetched server-side. Order is preserved because it decides the
           * cascade between rules of equal specificity.
           */
          let sheetCache: Array<{ name: string; rules: any; recovered?: boolean }> | null = null;
          const orderedSheets = (): Array<{ name: string; rules: any; recovered?: boolean }> => {
            if (sheetCache) return sheetCache;
            const out: Array<{ name: string; rules: any; recovered?: boolean }> = [];
            (Array.from(doc.styleSheets) as any[]).forEach((sheet, index) => {
              let live: any = null;
              try { live = sheet.cssRules; } catch { live = null; }
              if (live) { out.push({ name: sheetName(sheet.href), rules: live }); return; }

              const ext = externalByIndex.get(index);
              if (ext) {
                try {
                  const rebuilt = new g.CSSStyleSheet();
                  rebuilt.replaceSync(ext.text);
                  const name = sheetName(ext.href);
                  recoveredSheets.push(name);
                  out.push({ name, rules: rebuilt.cssRules, recovered: true });
                  return;
                } catch { /* fall through to opaque */ }
              }
              opaqueSheets.push(sheetName(sheet.href));
            });
            sheetCache = out;
            return out;
          };

          const collectRules = (el: any) => {
            const rules: any[] = [];
            let order = 0;
            const visit = (list: any, media: string | null, sheet: string) => {
              for (const rule of Array.from(list) as any[]) {
                if (rule.media && rule.cssRules) {
                  const cond = rule.conditionText || rule.media.mediaText;
                  visit(rule.cssRules, media ? `${media} and ${cond}` : cond, sheet);
                  continue;
                }
                if (rule.cssRules && rule.conditionText) {
                  visit(rule.cssRules, media, sheet);
                  continue;
                }
                if (!rule.selectorText || !rule.style) continue;
                const parts = rule.selectorText.split(',').map((s: string) => s.trim());
                let hit: string | null = null;
                for (const p of parts) {
                  // A rule can carry a pseudo-element; match on the base selector.
                  const base = p.replace(/::[\w-]+(\([^)]*\))?/g, '') || '*';
                  try { if (el.matches(base)) { hit = p; break; } } catch { /* unsupported selector */ }
                }
                if (!hit) continue;
                const applies = media ? g.matchMedia(media).matches : true;
                if (!applies && !args.includeInactiveMedia) continue;
                const decls: Record<string, { value: string; important: boolean }> = {};
                for (const prop of Array.from(rule.style) as string[]) {
                  if (args.properties && !args.properties.includes(prop)) continue;
                  decls[prop] = {
                    value: rule.style.getPropertyValue(prop),
                    important: rule.style.getPropertyPriority(prop) === 'important',
                  };
                }
                if (Object.keys(decls).length === 0) continue;
                rules.push({
                  selector: hit, media, applies, source: sheet,
                  specificity: specificity(hit), order: order++, decls,
                });
              }
            };
            for (const sheet of orderedSheets()) {
              // A single malformed rule must not cost the whole stylesheet, so
              // the walk is wrapped per sheet rather than around the whole loop.
              try { visit(sheet.rules, null, sheet.name); }
              catch { opaqueSheets.push(sheet.name); }
            }
            // inline style attribute beats every stylesheet rule
            if (el.getAttribute && el.getAttribute('style')) {
              const decls: Record<string, { value: string; important: boolean }> = {};
              for (const prop of Array.from(el.style) as string[]) {
                if (args.properties && !args.properties.includes(prop)) continue;
                decls[prop] = {
                  value: el.style.getPropertyValue(prop),
                  important: el.style.getPropertyPriority(prop) === 'important',
                };
              }
              if (Object.keys(decls).length) {
                rules.push({
                  selector: 'style="…"', media: null, applies: true, source: '<inline attr>',
                  specificity: [1, 0, 0, 0] as any, order: order++, decls, inline: true,
                });
              }
            }
            return rules;
          };

          /** Resolve the cascade the way the browser does, per property. */
          const resolveWinners = (rules: any[]) => {
            const best: Record<string, any> = {};
            for (const rule of rules) {
              if (!rule.applies) continue;
              for (const [prop, d] of Object.entries(rule.decls) as [string, any][]) {
                const cur = best[prop];
                const beats =
                  !cur ||
                  (d.important && !cur.important) ||
                  (d.important === cur.important &&
                    (cmpSpec(rule.specificity, cur.specificity) > 0 ||
                      (cmpSpec(rule.specificity, cur.specificity) === 0 && rule.order > cur.order)));
                if (beats) {
                  best[prop] = {
                    value: d.value, important: d.important,
                    selector: rule.selector, source: rule.source,
                    media: rule.media, specificity: rule.specificity, order: rule.order,
                  };
                }
              }
            }
            return best;
          };

          // ---- assemble --------------------------------------------------
          const all = Array.from(doc.querySelectorAll(args.selector)) as any[];
          const matched = all.slice(0, args.maxMatches);
          const out: any = {
            selector: args.selector,
            matchCount: all.length,
            reported: matched.length,
            viewport: { w: g.innerWidth, h: g.innerHeight },
            matches: [],
          };

          for (const el of matched) {
            nodeBudget = args.maxNodes;
            const entry: any = { root: label(el), tree: walk(el, 0) };
            if (wantCss) {
              const target = args.cssFor ? el.querySelector(args.cssFor) : el;
              if (!target) {
                entry.css = { error: `cssFor "${args.cssFor}" matched nothing inside this element` };
              } else {
                const rules = collectRules(target);
                entry.css = {
                  target: label(target),
                  ruleCount: rules.length,
                  rules: rules.map((r: any) => ({
                    selector: r.selector,
                    source: r.source,
                    media: r.media || undefined,
                    applies: r.applies,
                    specificity: (r.specificity as number[]).join(','),
                    declarations: Object.fromEntries(
                      Object.entries(r.decls).map(([k, v]: [string, any]) =>
                        [k, v.important ? `${v.value} !important` : v.value])
                    ),
                  })),
                  winners: Object.fromEntries(
                    Object.entries(resolveWinners(rules)).map(([k, v]: [string, any]) => [
                      k,
                      `${v.important ? `${v.value} !important` : v.value}  ←  ${v.selector} (${v.source}${v.media ? ` @${v.media}` : ''})`,
                    ])
                  ),
                };
              }
            }
            out.matches.push(entry);
          }
          if (opaqueSheets.length) out.opaqueStylesheets = [...new Set(opaqueSheets)];
          if (recoveredSheets.length) out.recoveredStylesheets = [...new Set(recoveredSheets)];
          return out;
        },
        {
          selector, include, cssFor: cssFor ?? null, properties: properties ?? null,
          depth, maxNodes, maxMatches, textLimit, includeInactiveMedia, externalSheets,
        }
      );

      if (result.matchCount === 0) {
        return {
          success: false,
          message: `Selector "${selector}" matched nothing on ${url} at ${viewport} (${width}×${height}).`,
          data: { url, selector, viewport, matchCount: 0 },
        };
      }

      const notes: string[] = [];
      if (result.matchCount > result.reported) {
        notes.push(
          `${result.matchCount} elements matched; reporting the first ${result.reported}. ` +
          `Raise maxMatches or narrow the selector.`
        );
      }
      if (result.recoveredStylesheets?.length) {
        notes.push(
          `${result.recoveredStylesheets.length} cross-origin stylesheet(s) were re-fetched ` +
          `server-side and re-parsed in document order, so their rules ARE included: ` +
          `${result.recoveredStylesheets.join(', ')}.`
        );
      }
      if (result.opaqueStylesheets?.length) {
        notes.push(
          `Could not read these stylesheets, so their rules are NOT in the results: ` +
          `${result.opaqueStylesheets.join(', ')}` +
          (unfetched.length ? ` — fetch failures: ${unfetched.join('; ')}` : '') +
          (fetchCrossOrigin ? '.' : '. Set fetchCrossOrigin=true to recover them.')
        );
      }
      if (include.includes('css')) {
        notes.push('Specificity is approximate (id,class,element) and is used only to rank rules.');
      }

      return {
        success: true,
        message: `Inspected "${selector}" on ${url} at ${viewport} (${width}×${height})`,
        data: { url, viewport, width, height, ...result, notes: notes.length ? notes : undefined },
      };
    } finally {
      await page.close();
    }
  }

  // ==================== MEDIA UPLOAD ====================

  async uploadMediaFile(data: {
    fileUrl?: string;
    base64Content?: string;
    fileName?: string;
    folder?: string;
    dryRun?: boolean;
    confirm?: boolean;
  }): Promise<JoomlaResponse> {
    if (!data.fileUrl && !(data.base64Content && data.fileName)) {
      return { success: false, message: "Either fileUrl or (base64Content + fileName) is required" };
    }

    let fileContent: Buffer;
    let fileName: string;

    if (data.fileUrl) {
      const response = await fetch(data.fileUrl);
      if (!response.ok) {
        return { success: false, message: `Failed to download file from ${data.fileUrl}: HTTP ${response.status}` };
      }
      fileContent = Buffer.from(await response.arrayBuffer());
      fileName = data.fileName || data.fileUrl.split("/").pop()?.split("?")[0] || "upload.bin";
    } else {
      fileContent = Buffer.from(data.base64Content!, "base64");
      fileName = data.fileName!;
    }

    const targetFolder = data.folder ?? "";

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: `[DRY RUN] Would upload "${fileName}" (${fileContent.length} bytes) to folder "${targetFolder}". Pass confirm=true to proceed.`,
        data: { fileName, fileSize: fileContent.length, targetFolder, dryRun: true },
      };
    }

    // Navigate to the media page with the target folder so we get the correct upload form action URL
    const folderParam = targetFolder ? `&folder=${encodeURIComponent(targetFolder)}` : "";
    const mediaPageUrl = this.getAdminUrl(`index.php?option=com_media${folderParam}`);
    const { html } = await this.getPage(mediaPageUrl);

    // Extract the real upload form action URL (contains CSRF token in query string)
    const $ = this.$c(html);
    const uploadFormAction = $("form#uploadForm").attr("action");
    if (!uploadFormAction) {
      return { success: false, message: "Failed to find upload form on media page" };
    }

    // Extract hidden fields from the upload form (folder, CSRF token if in body, etc.)
    const formData = new FormData();
    $("form#uploadForm input[type='hidden']").each((_: number, el: any) => {
      const name = $(el).attr("name");
      const value = $(el).attr("value") ?? "";
      if (name) formData.append(name, value);
    });

    // Ensure folder is set correctly (hidden field may already have it, but override to be sure)
    formData.set("folder", targetFolder);

    const blob = new Blob([new Uint8Array(fileContent)], { type: this.getMimeType(fileName) });
    formData.append("Filedata[]", blob, fileName);

    const uploadUrl = uploadFormAction.startsWith("http")
      ? uploadFormAction
      : this.getAdminUrl(uploadFormAction);

    const result = await this.request(uploadUrl, { method: "POST", body: formData });

    // Joomla redirects (303) after upload — follow the Location header to get the result page
    let resultHtml = result.body;
    if (result.status === 303 || result.status === 302) {
      const location = result.headers.get("location");
      if (location) {
        const redirectUrl = location.startsWith("http") ? location : this.getAdminUrl(location);
        const redirectResult = await this.request(redirectUrl);
        resultHtml = redirectResult.body;
      }
    }

    // Only treat the upload as failed if there is an error/warning alert (not a success alert)
    const $r = this.$c(resultHtml);
    const errorMsg = $r('.alert-error .alert-message, .alert-danger .alert-message, .alert-warning .alert-message').first().text().trim() || null;
    const isSuccess = result.status < 500 && !errorMsg;

    const uploadedPath = targetFolder ? `${targetFolder}/${fileName}` : fileName;

    if (isSuccess) {
      return {
        success: true,
        message: `Uploaded: ${uploadedPath}`,
        data: { fileName, fileSize: fileContent.length, targetFolder, uploadedPath },
      };
    }

    // Some sites (FILEman/Koowa-guarded media roots) reject the plain com_media
    // upload form with a non-core "Cannot upload at this time" message. Retry
    // through FILEman's own JSON API, which uses a different upload route.
    const filemanResult = await this.uploadFilemanFile(fileContent, fileName, targetFolder);
    if (filemanResult.success) return filemanResult;

    return {
      success: false,
      message: `com_media upload failed: ${errorMsg || `HTTP ${result.status}`}; FILEman fallback also failed: ${filemanResult.message}`,
      data: { fileName, fileSize: fileContent.length, targetFolder, uploadedPath, comMediaError: errorMsg, filemanError: filemanResult.message },
    };
  }

  // FILEman (Joomlatools com_files) guards com_media uploads on some sites and
  // rejects them with a non-core error. Its own admin UI uploads through a
  // separate Koowa REST route instead — reverse-engineered from FILEman's
  // files.min.js/uploader.min.js: POST multipart to view=file with
  // container=<container slug>, _action=add, folder=<container-relative path>,
  // and the file itself under field name "file" (plupload's default
  // file_data_name). Origin/Referer headers stand in for the csrf_token field,
  // same as the existing docmanApiCall/listFilemanFiles calls.
  private async uploadFilemanFile(fileContent: Buffer, fileName: string, targetFolder: string): Promise<JoomlaResponse> {
    if (!this.tokenName) {
      await this.getPage(this.getAdminUrl("index.php?option=com_fileman"));
    }
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const additionalHeaders: Record<string, string> = {
      "Origin": baseUrl,
      "Referer": this.getAdminUrl("index.php?option=com_fileman"),
      "Accept": "application/json",
    };

    const cleanFolder = targetFolder.replace(/^\/+|\/+$/g, "");
    const formData = new FormData();
    formData.append("_action", "add");
    formData.append("csrf_token", "");
    formData.append("folder", cleanFolder);
    formData.append("container", "fileman-files");
    const blob = new Blob([new Uint8Array(fileContent)], { type: this.getMimeType(fileName) });
    formData.append("file", blob, fileName);

    const uploadUrl = this.getAdminUrl("index.php?option=com_fileman&routed=1&view=file&container=fileman-files");
    const result = await this.request(uploadUrl, { method: "POST", body: formData, additionalHeaders });

    const uploadedPath = cleanFolder ? `${cleanFolder}/${fileName}` : fileName;

    if (result.status >= 400) {
      return { success: false, message: `FILEman upload failed (HTTP ${result.status})`, data: { fileName, targetFolder: cleanFolder, uploadedPath } };
    }

    // Verify by re-listing rather than trusting the POST response shape —
    // matches the verification pattern used elsewhere in this file (delete,
    // create_folder).
    const listing = await this.listFilemanFiles(cleanFolder);
    const listingData = (listing.data || {}) as Record<string, unknown>;
    const files = (listingData.files || []) as Array<Record<string, unknown>>;
    const uploaded = files.some((f) => String(f.name || "") === fileName);

    return {
      success: uploaded,
      message: uploaded ? `Uploaded via FILEman: ${uploadedPath}` : "FILEman upload submitted, but the file was not verified in the listing",
      data: { fileName, fileSize: fileContent.length, targetFolder: cleanFolder, uploadedPath, route: "fileman" },
    };
  }

  private getMimeType(fileName: string): string {
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    const map: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      zip: "application/zip", mp4: "video/mp4", mp3: "audio/mpeg",
    };
    return map[ext] || "application/octet-stream";
  }

  // ==================== MENU TREE ====================

  /**
   * Read an item's published state from the menu list rather than the edit form.
   * The edit form's jform[published] defaults to "1" even for unpublished items,
   * so it cannot be trusted. Uses a title search so this still works when the menu
   * holds more items than the list page limit.
   * Returns "1", "0", or "" when the item is not found.
   */
  private async readPublishedFromList(menuType: string, title: string, id: string): Promise<string> {
    const listVerify = await this.listMenuItems(menuType, title);
    const listItems = Array.isArray(listVerify.data) ? listVerify.data as Array<Record<string, string>> : [];
    const listItem = listItems.find((i) => i.id === id);
    if (!listItem) return "";
    return listItem.state === "Published" ? "1" : listItem.state === "Unpublished" ? "0" : "";
  }

  /**
   * Joomla's CSRF tokens are per-session, so a caller that already holds one lets this
   * skip its own page fetch entirely — the menus list was a 62KB GET made only to read
   * a token out of it.
   */
  private async rebuildMenuTree(sessionToken?: { name: string; value: string } | null): Promise<void> {
    const listUrl = this.getAdminUrl("index.php?option=com_menus&view=menus");
    let token = sessionToken ?? null;
    if (!token) {
      const { html } = await this.getPage(listUrl);
      token = this.extractCsrfToken(html);
    }
    if (!token) return;
    // Skip the redirect target: it is the same menus page again and is never read.
    await this.postPage(listUrl, { task: "menus.rebuild" }, { token, noFollow: true });
  }

  // ==================== BULK CHECKIN ====================

  async bulkCheckin(data: { dryRun?: boolean; confirm?: boolean } = {}): Promise<JoomlaResponse> {
    const url = this.getAdminUrl("index.php?option=com_checkin");
    const { html } = await this.getPage(url);
    const $ = this.$c(html);

    const items: Array<{ id: string; title: string; type: string; editor: string; time: string }> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const cells = $row.find("td");
      items.push({
        id: cid,
        title: $(cells[1]).text().trim(),
        type: $(cells[2]).text().trim(),
        editor: $(cells[3]).text().trim(),
        time: $(cells[4]).text().trim(),
      });
    });

    if (items.length === 0) {
      return { success: true, message: "No checked-out items found — nothing to check in", data: { items: [] } };
    }

    if (data.dryRun || !data.confirm) {
      return {
        success: true,
        message: `[DRY RUN] Found ${items.length} checked-out item(s). Pass confirm=true to check them all in.`,
        data: { items, dryRun: true },
      };
    }

    const token = this.extractCsrfToken(html);
    if (!token) {
      return { success: false, message: "Failed to extract CSRF token from checkin page" };
    }

    const formData: FormDataMap = {
      task: "checkin.checkin",
      [token.name]: token.value,
      boxchecked: String(items.length),
      "cid[]": items.map((i) => i.id),
    };

    await this.postPage(url, formData);

    // Verify by re-loading the checkin page
    const verify = await this.getPage(url);
    const remaining = this.$c(verify.html)("input[name='cid[]']").length;
    const success = remaining === 0;

    return {
      success,
      message: success
        ? `Checked in ${items.length} item(s)`
        : `Check-in submitted, but ${remaining} item(s) still appear checked out`,
      data: { checkedIn: items, remainingCount: remaining },
    };
  }

  // ==================== USERS ====================

  async listUsers(search?: string, groupId?: string, state?: string, limit?: number, page?: number): Promise<JoomlaResponse> {
    const effectiveLimit = Math.min(limit ?? 200, 500);
    const effectivePage = Math.max(page ?? 1, 1);
    const limitStart = (effectivePage - 1) * effectiveLimit;
    const params = new URLSearchParams({
      option: "com_users",
      view: "users",
      limit: String(effectiveLimit),
      limitstart: String(limitStart),
    });
    if (search) params.set("filter[search]", search);
    if (groupId) params.set("filter[group_id]", groupId);
    if (state !== undefined && state !== "") params.set("filter[state]", state);
    const url = this.getAdminUrl(`index.php?${params.toString()}`);
    const { html } = await this.getPage(url);
    const users = this.parseUserList(html);
    return {
      success: true,
      message: `Found ${users.length} user(s)${search ? `, search="${search}"` : ""}`,
      data: users,
    };
  }

  private parseUserList(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const users: Array<Record<string, unknown>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const rowHtml = $.html($row) || "";
      const $cells = $row.find("td");
      const nameLink = $cells.eq(1).find("a[href*='task=user.edit']").first();
      const name = nameLink.text().trim();
      if (!name) return;
      const username = $cells.eq(2).text().trim();
      // Enabled = the row's toggle link offers "task=users.block" — you can only block
      // an account that isn't already blocked. The icon-class check this used to OR in
      // (icon-unpublish) was backwards: that class marks the row's CURRENT disabled-state
      // icon, not an available action, so it made every blocked user read as enabled.
      // Task-string only, since it can't collide with the unblock task's "users.unblock".
      const enabled = /task=users\.block\b/.test(rowHtml);
      const groupsText = $cells.eq(5).text().trim();
      const email = $cells.eq(6).text().trim();
      const lastVisitDate = $cells.eq(7).text().trim();
      const registrationDate = $cells.eq(8).text().trim();
      users.push({ id: cid, name, username, enabled, groups: groupsText, email, lastVisitDate, registrationDate });
    });
    return users;
  }

  async getUser(id: string): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_users&task=user.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const $ = this.$c(html);
    const nameField = $('input[name="jform[name]"]');
    if (!nameField.length) {
      return { success: false, message: `User ${id} not found or access denied` };
    }
    const name = nameField.attr("value") || "";
    const username = $('input[name="jform[username]"]').attr("value") || "";
    const email = $('input[name="jform[email]"]').attr("value") || "";
    // block=0 means enabled, block=1 means blocked. Find the checked radio.
    const blockedRadioValue = $('input[name="jform[block]"][checked]').attr("value") ?? "0";
    const blocked = blockedRadioValue === "1";
    // requireReset=1 means the user must set a new password on next login. Same
    // radio pattern as block above — read the checked value, not just presence.
    const requireResetRadioValue = $('input[name="jform[requireReset]"][checked]').attr("value") ?? "0";
    const requireReset = requireResetRadioValue === "1";
    const groups: Array<{ id: string; name: string }> = [];
    $('input[name="jform[groups][]"][checked]').each((_, el) => {
      const $el = $(el);
      const groupId = $el.attr("value") || "";
      const label = $(`label[for="${$el.attr("id")}"]`).text().trim().replace(/^[\s–—|\-]+/, "").trim();
      if (groupId) groups.push({ id: groupId, name: label });
    });
    return {
      success: true,
      message: "User retrieved",
      data: { id, name, username, email, blocked, requireReset, groups },
    };
  }

  async createUser(data: {
    name: string;
    username: string;
    email: string;
    password: string;
    groups: string[];
    block?: boolean;
    requireReset?: boolean;
  }): Promise<JoomlaResponse> {
    const newUserUrl = this.getAdminUrl("index.php?option=com_users&view=user&layout=edit");
    const { html } = await this.getPage(newUserUrl);
    const token = this.extractCsrfToken(html);
    if (!token) return { success: false, message: "Failed to extract CSRF token" };

    const baseFields = this.extractFormFields(html);
    delete baseFields["jform[groups][]"];

    const formData: FormDataMap = {
      ...baseFields,
      task: "user.save",
      "jform[name]": data.name,
      "jform[username]": data.username,
      "jform[email]": data.email,
      "jform[password]": data.password,
      "jform[password2]": data.password,
      "jform[block]": data.block ? "1" : "0",
      "jform[requireReset]": data.requireReset === false ? "0" : "1",
      "jform[groups][]": data.groups,
      [token.name]: token.value,
    };

    const result = await this.postPage(newUserUrl, formData);
    const saved = result.html.includes("User saved") || result.html.includes("has been saved");
    const errorMsg = saved ? null : this.extractAlertMessage(result.html);
    if (errorMsg) return { success: false, message: errorMsg };

    const listed = await this.listUsers(data.email);
    const found = (listed.data as Array<Record<string, unknown>>)?.find((u) => u.email === data.email);
    const createdId = found ? String(found.id) : "";

    if (!createdId) {
      return { success: false, message: "User form submitted but could not verify creation — check the admin backend" };
    }

    const verify = await this.getUser(createdId);
    const expectedRequireReset = data.requireReset !== false;
    const requireResetVerified = (verify.data as Record<string, unknown> | undefined)?.requireReset === expectedRequireReset;
    let message = verify.success ? `User created (ID: ${createdId})` : "User may have been created but readback failed";
    if (verify.success && !requireResetVerified) {
      message += ` — WARNING: requireReset did not save as requested (expected ${expectedRequireReset}); set it manually via joomla_submit_admin_form`;
    }
    return {
      success: verify.success,
      message,
      data: verify.data,
    };
  }

  async updateUser(
    id: string,
    data: {
      name?: string;
      username?: string;
      email?: string;
      password?: string;
      block?: boolean;
      groups?: string[];
      requireReset?: boolean;
    }
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_users&task=user.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const token = this.extractCsrfToken(html);
    if (!token) return { success: false, message: "Failed to extract CSRF token" };

    const $ = this.$c(html);
    const existingGroups: string[] = [];
    $('input[name="jform[groups][]"][checked]').each((_, el) => {
      const v = $(el).attr("value");
      if (v) existingGroups.push(v);
    });

    const baseFields = this.extractFormFields(html);
    delete baseFields["jform[groups][]"];

    // block/requireReset are read by explicit [checked] lookup, not trusted from
    // extractFormFields's generic pass-through — if the edit page ever renders
    // without those radios checked (e.g. a checkout collision), the generic
    // scraper silently drops the field, and Joomla's save controller then
    // defaults a missing "block" post field to blocked=1. Always assert both
    // fields explicitly so an omitted arg re-sends the current value instead of
    // leaving it to chance.
    const currentBlocked = this.extractCheckedValues(html, "jform[block]")[0] ?? "0";
    const currentRequireReset = this.extractCheckedValues(html, "jform[requireReset]")[0] ?? "0";

    const formData: FormDataMap = {
      ...baseFields,
      task: "user.save",
      "jform[id]": id,
      "jform[groups][]": data.groups ?? existingGroups,
      "jform[block]": data.block !== undefined ? (data.block ? "1" : "0") : currentBlocked,
      "jform[requireReset]": data.requireReset !== undefined ? (data.requireReset ? "1" : "0") : currentRequireReset,
      [token.name]: token.value,
    };

    if (data.name !== undefined) formData["jform[name]"] = data.name;
    if (data.username !== undefined) formData["jform[username]"] = data.username;
    if (data.email !== undefined) formData["jform[email]"] = data.email;
    if (data.password !== undefined) {
      formData["jform[password]"] = data.password;
      formData["jform[password2]"] = data.password;
    }

    const result = await this.postPage(editUrl, formData);
    const saved = result.html.includes("User saved") || result.html.includes("has been saved");
    const errorMsg = saved ? null : this.extractAlertMessage(result.html);
    if (errorMsg) return { success: false, message: errorMsg };

    const verify = await this.getUser(id);
    let message = verify.success ? "User updated" : "User form submitted but readback failed";
    if (verify.success && data.requireReset !== undefined) {
      const requireResetVerified = (verify.data as Record<string, unknown> | undefined)?.requireReset === data.requireReset;
      if (!requireResetVerified) {
        message += ` — WARNING: requireReset did not save as requested (expected ${data.requireReset}); set it manually via joomla_submit_admin_form`;
      }
    }
    return {
      success: verify.success,
      message,
      data: verify.data,
    };
  }

  async sendUserResetEmail(id: string): Promise<JoomlaResponse> {
    const listUrl = this.getAdminUrl("index.php?option=com_users&view=users");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);
    if (!token) return { success: false, message: "Failed to extract CSRF token" };

    const formData: FormDataMap = {
      task: "users.remind",
      "cid[]": id,
      boxchecked: "1",
      [token.name]: token.value,
    };

    const result = await this.postPage(listUrl, formData);
    const success = result.html.includes("reset link") || result.html.includes("mail") || result.status === 303 || result.html.includes("message");
    return {
      success,
      message: success ? `Password reset email sent to user ID ${id}` : "Reset email may not have sent — check admin backend",
    };
  }

  // ==================== GROUPS ====================

  async listGroups(): Promise<JoomlaResponse> {
    const url = this.getAdminUrl("index.php?option=com_users&view=groups&list[limit]=500");
    const { html } = await this.getPage(url);
    const groups = this.parseGroupList(html);
    return { success: true, message: `Found ${groups.length} group(s)`, data: groups };
  }

  private parseGroupList(html: string): Array<Record<string, unknown>> {
    const $ = this.$c(html);
    const groups: Array<Record<string, unknown>> = [];
    $("tr").each((_, el) => {
      const $row = $(el);
      const cid = $row.find("input[name='cid[]']").attr("value");
      if (!cid) return;
      const $cells = $row.find("td");
      const titleCell = $cells.eq(1);
      const title = titleCell.find("a").first().text().trim();
      if (!title) return;
      const rawText = titleCell.text().trim();
      const depth = (rawText.match(/^[\s–—|\-]+/) || [""])[0].replace(/[^–—|\-]/g, "").length;
      const enabledUsers = $cells.eq(2).text().trim();
      const disabledUsers = $cells.eq(3).text().trim();
      groups.push({ id: cid, title, depth, enabledUsers, disabledUsers });
    });
    return groups;
  }

  async createGroup(data: { title: string; parentId?: string }): Promise<JoomlaResponse> {
    // GET uses task=group.add but the form action posts to layout=edit&id=0
    const getUrl = this.getAdminUrl("index.php?option=com_users&task=group.add");
    const postUrl = this.getAdminUrl("index.php?option=com_users&layout=edit&id=0");
    const { html } = await this.getPage(getUrl);
    const token = this.extractCsrfToken(html);
    if (!token) return { success: false, message: "Failed to extract CSRF token" };

    const formData: FormDataMap = {
      ...this.extractFormFields(html),
      task: "group.save",
      "jform[title]": data.title,
      "jform[parent_id]": data.parentId ?? "1",
      [token.name]: token.value,
    };

    const result = await this.postPage(postUrl, formData);
    const saved = result.html.includes("Group saved") || result.html.includes("has been saved");
    const errorMsg = saved ? null : this.extractAlertMessage(result.html);
    if (errorMsg) return { success: false, message: errorMsg };

    const listed = await this.listGroups();
    const groups = listed.data as Array<Record<string, unknown>>;
    const found = groups?.find((g) => g.title === data.title);
    if (!found) return { success: false, message: "Group submitted but could not verify creation" };
    return { success: true, message: `Group created (ID: ${found.id})`, data: found };
  }

  async deleteGroup(id: string): Promise<JoomlaResponse> {
    const listUrl = this.getAdminUrl("index.php?option=com_users&view=groups");
    const { html } = await this.getPage(listUrl);
    const token = this.extractCsrfToken(html);
    if (!token) return { success: false, message: "Failed to extract CSRF token" };

    const formData: FormDataMap = {
      task: "groups.delete",
      "cid[]": [id],
      boxchecked: "1",
      [token.name]: token.value,
    };

    const result = await this.postPage(listUrl, formData);
    const listed = await this.listGroups();
    const groups = listed.data as Array<Record<string, unknown>>;
    const stillExists = groups?.some((g) => String(g.id) === String(id));
    return {
      success: !stillExists,
      message: stillExists
        ? (this.extractAlertMessage(result.html) ?? "Group deletion submitted but group still exists")
        : "Group deleted",
    };
  }

  // ==================== PERMISSIONS ====================

  private parseRulesFromHtml(html: string): Record<string, Record<string, string>> {
    const $ = this.$c(html);
    const rules: Record<string, Record<string, string>> = {};
    $("select[name]").each((_, el) => {
      const name = $(el).attr("name") || "";
      const match = name.match(/jform\[rules\]\[([^\]]+)\]\[([^\]]+)\]/);
      if (!match) return;
      const [, action, groupId] = match;
      const selected = $(el).find("option[selected]").first();
      const value = selected.length ? (selected.attr("value") ?? "") : "";
      if (!rules[groupId]) rules[groupId] = {};
      rules[groupId][action] = value;
    });
    return rules;
  }

  async getCategoryPermissions(id: string, extension = "com_content"): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(
      `index.php?option=com_categories&task=category.edit&id=${id}&extension=${extension}`
    );
    const { html } = await this.getPage(editUrl);
    const $ = this.$c(html);
    const title = $('input[name="jform[title]"]').attr("value") || `Category ${id}`;
    const rules = this.parseRulesFromHtml(html);

    if (!Object.keys(rules).length) {
      return {
        success: false,
        message: "No permission rules found — category may not exist or permissions tab is not rendered in the HTML",
      };
    }

    const groupList = await this.listGroups();
    const groupNames: Record<string, string> = {};
    for (const g of (groupList.data as Array<Record<string, unknown>>) ?? []) {
      groupNames[String(g.id)] = String(g.title);
    }

    return {
      success: true,
      message: `Permissions for category "${title}" (ID: ${id})`,
      data: { categoryId: id, title, rules, groupNames },
    };
  }

  async setCategoryPermissions(
    id: string,
    rules: Record<string, Record<string, string>>,
    extension = "com_content"
  ): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(
      `index.php?option=com_categories&task=category.edit&id=${id}&extension=${extension}`
    );
    const { html } = await this.getPage(editUrl);
    const token = this.extractCsrfToken(html);
    if (!token) return { success: false, message: "Failed to extract CSRF token" };

    const formData: FormDataMap = {
      ...this.extractFormFields(html, "item-form"),
      task: "category.save",
      [token.name]: token.value,
    };

    for (const [groupId, actions] of Object.entries(rules)) {
      for (const [action, value] of Object.entries(actions)) {
        formData[`jform[rules][${action}][${groupId}]`] = value;
      }
    }

    const result = await this.postPage(editUrl, formData);
    const saved = result.html.includes("Category saved") || result.html.includes("has been saved");
    const errorMsg = saved ? null : this.extractAlertMessage(result.html);
    if (errorMsg) return { success: false, message: errorMsg };

    return await this.getCategoryPermissions(id, extension);
  }

  async getArticlePermissions(id: string): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_content&task=article.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const $ = this.$c(html);
    const title = $('input[name="jform[title]"]').attr("value") || `Article ${id}`;
    const rules = this.parseRulesFromHtml(html);

    if (!Object.keys(rules).length) {
      return {
        success: false,
        message: "No permission rules found — article may not exist or does not have article-level ACL configured",
      };
    }

    const groupList = await this.listGroups();
    const groupNames: Record<string, string> = {};
    for (const g of (groupList.data as Array<Record<string, unknown>>) ?? []) {
      groupNames[String(g.id)] = String(g.title);
    }

    return {
      success: true,
      message: `Permissions for article "${title}" (ID: ${id})`,
      data: { articleId: id, title, rules, groupNames },
    };
  }

  async setArticlePermissions(id: string, rules: Record<string, Record<string, string>>): Promise<JoomlaResponse> {
    const editUrl = this.getAdminUrl(`index.php?option=com_content&task=article.edit&id=${id}`);
    const { html } = await this.getPage(editUrl);
    const token = this.extractCsrfToken(html);
    if (!token) return { success: false, message: "Failed to extract CSRF token" };

    const formData: FormDataMap = {
      ...this.extractFormFields(html, "adminForm"),
      task: "article.save",
      [token.name]: token.value,
    };

    for (const [groupId, actions] of Object.entries(rules)) {
      for (const [action, value] of Object.entries(actions)) {
        formData[`jform[rules][${action}][${groupId}]`] = value;
      }
    }

    const result = await this.postPage(editUrl, formData);
    const saved = result.html.includes("Article saved") || result.html.includes("has been saved");
    const errorMsg = saved ? null : this.extractAlertMessage(result.html);
    if (errorMsg) return { success: false, message: errorMsg };

    return await this.getArticlePermissions(id);
  }

  private decodeHtml(html: string): string {
    return this.decodeHtmlEntities(html)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"');
  }

  private decodeHtmlEntities(html: string): string {
    return html
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&ndash;/g, "-");
  }
}
