import "./env.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  InitializeRequestSchema,
  JSONRPCResponse,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import { JoomlaClient, JoomlaResponse } from "./joomla-client.js";
import { runServer } from "@solutio/mcp-transport";
import { createLogger } from "@solutio/logging";

// Load config from environment
const config = {
  baseUrl: process.env.JOOMLA_BASE_URL || "https://example.com/administrator",
  username: process.env.JOOMLA_USERNAME || "",
  password: process.env.JOOMLA_PASSWORD || "",
  moduleTypeBlacklist: new Set(
    (process.env.MODULE_TYPE_BLACKLIST || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
  menuItemTypeBlacklist: new Set(
    (process.env.MENU_ITEM_TYPE_BLACKLIST || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
  disabledTools: new Set(
    (process.env.DISABLED_TOOLS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  ),
};

// ─── Site-keyed session cache ─────────────────────────────────────────────────
// Mirrors gantry-mcp's ctxCache pattern. Each site URL gets its own
// JoomlaClient with independent cookies and login state. TTL is set slightly
// under Joomla's 15-minute admin session so we re-login before it expires.

interface SiteSession {
  client: JoomlaClient;
  isLoggedIn: boolean;
  lastUsed: number;
}

const siteCache = new Map<string, SiteSession>();
const SESSION_TTL_MS = 12 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [url, sess] of siteCache) {
    if (now - sess.lastUsed > SESSION_TTL_MS) siteCache.delete(url);
  }
}, 60_000).unref();

function getOrCreateSiteSession(normalizedUrl: string): SiteSession {
  let sess = siteCache.get(normalizedUrl);
  if (!sess || Date.now() - sess.lastUsed > SESSION_TTL_MS) {
    sess = {
      client: new JoomlaClient({ ...config, baseUrl: normalizedUrl }),
      isLoggedIn: false,
      lastUsed: Date.now(),
    };
    siteCache.set(normalizedUrl, sess);
  } else {
    sess.lastUsed = Date.now();
  }
  return sess;
}

// Format response for LLM consumption
function formatResult(response: JoomlaResponse): string {
  const result: Record<string, unknown> = {
    success: response.success,
    message: response.message,
  };

  if (response.data !== undefined) {
    result.data = response.data;
    result.dataType = Array.isArray(response.data) ? "array" : typeof response.data;
    if (Array.isArray(response.data)) {
      result.itemCount = response.data.length;
    }
  }

  return JSON.stringify(result, null, 2);
}

function normalizeUrl(url: string): string {
  const u = url.trim().replace(/\/administrator\/?$/i, "").replace(/\/+$/, "");
  return u.startsWith("http") ? u : `https://${u}`;
}


export function buildServer(): Server {
  // Create MCP server
  const server = new Server(
  {
    name: "joomla-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Tool definitions
const tools = [
  {
    name: "joomla_login",
    description: "Log in to Joomla admin. Pass site_url to switch sites; omits uses JOOMLA_BASE_URL.",
    inputSchema: {
      type: "object",
      properties: {
        site_url: {
          type: "string",
          description: "Target site URL. Switches session to this site. Defaults to JOOMLA_BASE_URL.",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_article",
    description: "Manage articles. action: list|get|create|update|delete|checkin.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "get", "create", "update", "delete", "checkin"],
          description: "list: search/filter; get: fetch by id or title; create: new article; update: edit fields; delete: trash; checkin: release lock",
        },
        id: { type: "string", description: "Article ID (get/update/delete/checkin)" },
        title: { type: "string", description: "Title (create: required; get: searches by title)" },
        alias: { type: "string", description: "URL alias (auto-generated if omitted)" },
        categoryId: { type: "string", description: "Category ID (create: required)" },
        content: { type: "string", description: "Article body as HTML" },
        state: { type: "string", description: "1=published, 0=unpublished, -2=trashed, 2=archived" },
        access: { type: "string", description: "1=Public, 2=Special, 3=Registered" },
        ordering: { type: "string", description: "Place after article ID; -1 for first (update only)" },
        introImage: { type: "string" },
        introImageAlt: { type: "string" },
        featuredImage: { type: "string", description: "Used in listing/blog views" },
        featuredImageAlt: { type: "string" },
        search: { type: "string", description: "Server-side title filter (list only)" },
        category_id: { type: "string", description: "Filter by category ID (list only)" },
        limit: { type: "number", description: "Per page, default 200 (list only)" },
        page: { type: "number", description: "Page number, 1-based (list only)" },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches (delete/checkin)" },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_category",
    description: "Manage Joomla categories. action: list|get|create|update|delete|checkin.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "checkin"], description: "Operation to perform." },
        id: { type: "string", description: "Category ID (required for get/update/delete/checkin)." },
        title: { type: "string", description: "Required for create. Used for search in get." },
        alias: { type: "string" },
        parentId: { type: "string", description: "Parent category ID (default: 1=root)" },
        description: { type: "string", description: "HTML description" },
        published: { type: "string", description: "1=published, 0=unpublished" },
        extension: { type: "string", description: "Component extension (default: com_content)" },
        ordering: { type: "string", description: "Place after category with this ID. Use -1 for first." },
        search: { type: "string", description: "Server-side title filter (list only)." },
        limit: { type: "number", description: "Per page (default: 200, max: 500)" },
        page: { type: "number", description: "Page number, 1-based" },
        expectedTitle: { type: "string", description: "Safety check for delete/checkin: refuse unless title matches." },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_module",
    description: "Manage Joomla modules. action: list|get|create|update|delete|toggle|checkin. Use joomla_module_type to discover types and positions before creating.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "toggle", "checkin"], description: "Operation to perform." },
        id: { type: "string", description: "Module ID (required for get/update/delete/toggle/checkin)." },
        title: { type: "string", description: "Required for create. Used for search in get." },
        moduleType: { type: "string", description: "Required for create. Extension ID or visible title (e.g. Custom, Menu, Search)." },
        client_id: { type: "string", description: "0=site, 1=admin (default: 0)" },
        position: { type: "string" },
        published: { type: "string", description: "1=yes, 0=no" },
        state: { type: "string", enum: ["0", "1"], description: "toggle: 1=enable, 0=disable" },
        access: { type: "string", description: "Access level ID. 1=Public, 2=Special, 3=Registered" },
        showtitle: { type: "string", description: "1=yes, 0=no" },
        ordering: { type: "string" },
        style: { type: "string" },
        language: { type: "string", description: "Defaults to *" },
        note: { type: "string" },
        assignment: { type: "string", description: "0=all pages, -=none, 1=only selected, -1=all except selected" },
        assigned: { type: "array", items: { type: "string" }, description: "Menu item IDs for assignment" },
        content: { type: "string", description: "HTML content for Custom modules" },
        params: { type: "object", additionalProperties: { type: "string" }, description: "Type-specific params from joomla_module_type inspect" },
        advanced: { type: "object", additionalProperties: { type: "string" } },
        fieldOverrides: { type: "object", additionalProperties: { type: "string" }, description: "Raw field overrides e.g. {\"jform[params][count]\":\"5\"}" },
        search: { type: "string", description: "Server-side title filter (list only)." },
        limit: { type: "number", description: "Per page (default: 200, max: 500)" },
        page: { type: "number", description: "Page number, 1-based" },
        expectedTitle: { type: "string", description: "Safety check for delete/toggle/checkin: refuse unless title matches." },
        expectedModuleType: { type: "string", description: "Safety check for delete/toggle/checkin: refuse unless type matches." },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_module_type",
    description: "Discover module types and positions. action: list|inspect|list_positions.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "inspect", "list_positions"], description: "list=available module types, inspect=type details and params, list_positions=template positions." },
        moduleType: { type: "string", description: "Required for inspect. Extension ID or visible title (e.g. Custom, Menu)." },
        client_id: { type: "string", description: "0=site, 1=admin (default: 0)" },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_menu",
    description: "Manage menu containers. action: list|create.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create"], description: "list=all menus, create=new menu container" },
        title: { type: "string", description: "create: visible menu title" },
        menuType: { type: "string", description: "create: system type slug, max 24 chars (defaults from title)" },
        description: { type: "string", description: "create: menu description" },
        cssClasses: { type: "string", description: "create: CSS classes" },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_menu_item",
    description: "Manage menu items. action: list|get|create|update|delete|toggle|checkin.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete", "toggle", "checkin"], description: "Operation to perform" },
        id: { type: "string", description: "get|update|delete|toggle|checkin: menu item ID" },
        menuId: { type: "string", description: "list: menu type identifier to scope to one menu (e.g. mainmenu). Omit to search/list across all menus. get: optional scope for title search." },
        search: { type: "string", description: "list: server-side title filter. Combine with an omitted menuId to find an item by title when you don't know which menu it's in." },
        limit: { type: "number", description: "list: per page (default: 0=all, max 500)" },
        page: { type: "number", description: "list: page number, 1-based" },
        title: { type: "string", description: "get: search by title. create|update: item title." },
        menuType: { type: "string", description: "create: menu type (e.g. mainmenu). update: move to another menu. delete|toggle|checkin: for verification." },
        itemType: { type: "string", description: "create|update: encoded type or request key (e.g. com_content.article)" },
        alias: { type: "string" },
        link: { type: "string", description: "create|update: explicit link (e.g. index.php?option=com_content&view=article&id=123)" },
        parentId: { type: "string", description: "create|update: parent menu item ID (default: 1=root)" },
        published: { type: "string", description: "create|update: 1=published, 0=unpublished, -2=trashed" },
        access: { type: "string", description: "create|update: access level ID (usually 1=Public)" },
        language: { type: "string", description: "create|update: defaults to *" },
        browserNav: { type: "string", description: "create|update: 0=same window, 1=new window, 2=popup" },
        home: { type: "string", description: "create|update: 1=set as home page" },
        note: { type: "string" },
        templateStyleId: { type: "string", description: "create|update: Gantry outline ID (0=site default)" },
        ordering: { type: "string", description: "update: place after sibling with this ID. Use -1 for first." },
        request: { type: "object", additionalProperties: { type: "string" }, description: "create|update: type-specific request values e.g. {\"id\":\"123\"}" },
        params: { type: "object", additionalProperties: { type: "string" } },
        fieldOverrides: { type: "object", additionalProperties: { type: "string" } },
        state: { type: "string", description: "toggle: 1=publish, 0=unpublish", enum: ["0", "1"] },
        expectedTitle: { type: "string", description: "delete|toggle|checkin: safety check — refuse unless title matches" },
        expectedMenuType: { type: "string", description: "delete|toggle|checkin: safety check — refuse unless menu type matches" },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_menu_item_type",
    description: "Discover available menu item types. action: list|inspect. Call before creating a menu item.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "inspect"], description: "list=all types, inspect=fields for a specific type" },
        itemType: { type: "string", description: "inspect: encoded value, label, or request key (e.g. com_content.article)" },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_bulk_checkin",
    description: "List all checked-out items site-wide. Pass confirm=true to release them all.",
    inputSchema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "List without checking in (default)" },
        confirm: { type: "boolean", description: "Set true to check in all items" },
      },
      required: [],
    },
  },
  {
    name: "joomla_backend_inventory",
    description: "Discover the admin surface: components, module types, menu item types, Gantry outlines.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_inspect_admin_form",
    description: "Inspect any admin edit form by path. Returns fields, options, hidden fields, token. Pass rawHtml:true to get the raw page HTML instead (useful for debugging CSS selectors).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Admin path (e.g. index.php?option=com_content&task=article.add)" },
        formId: { type: "string", description: "Form ID to prefer (e.g. item-form)" },
        rawHtml: { type: "boolean", description: "Return raw page HTML instead of parsed structure." },
        head: { type: "number", description: "Limit output to first N lines of HTML (default: all)." },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_inspect_admin_list",
    description: "Inspect an admin list page. Returns filters, headers, row IDs, toolbar tasks. Pass rawHtml:true to get the raw page HTML instead (useful for debugging CSS selectors).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Admin path (e.g. index.php?option=com_content&view=articles)" },
        formId: { type: "string", description: "List form ID (default: adminForm)" },
        rawHtml: { type: "boolean", description: "Return raw page HTML instead of parsed structure." },
        head: { type: "number", description: "Limit output to first N lines of HTML (default: all)." },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_submit_admin_form",
    description: "Submit an admin form. Preserves existing fields, injects CSRF. Dry-run by default — set confirm=true to submit.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Admin path containing the form." },
        formId: { type: "string" },
        overrides: { type: "object", additionalProperties: true, description: "Raw field overrides by exact field name." },
        task: { type: "string", description: "Joomla task to set." },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean", description: "Required true for live submit." },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_component_inspect",
    description: "Explore any admin component path in form or list mode. Pass rawHtml:true to get the raw page HTML instead (useful for debugging CSS selectors).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        mode: { type: "string", enum: ["form", "list"] },
        formId: { type: "string" },
        rawHtml: { type: "boolean", description: "Return raw page HTML instead of parsed structure." },
        head: { type: "number", description: "Limit output to first N lines of HTML (default: all)." },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_media",
    description: "Manage Joomla Media Manager files and folders. action: list|create_folder|upload|delete|rename|move. Destructive actions are dry-run by default — pass confirm:true to execute.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create_folder", "upload", "delete", "rename", "move"], description: "Operation to perform." },
        path: { type: "string", description: "File/folder path relative to media root. Required for delete/rename/move." },
        folder: { type: "string", description: "Subfolder for list or upload (e.g. 'stories')." },
        folderName: { type: "string", description: "Required for create_folder." },
        folderBase: { type: "string", description: "Base path for create_folder." },
        fileUrl: { type: "string", description: "URL to download and upload (upload action)." },
        base64Content: { type: "string", description: "Base64 file content (upload action). Requires fileName." },
        fileName: { type: "string", description: "Target filename (upload action). Required with base64Content; inferred from fileUrl if omitted." },
        newName: { type: "string", description: "New filename including extension (rename action)." },
        targetFolder: { type: "string", description: "Destination folder relative to media root (move action). Empty string = root." },
        type: { type: "string", enum: ["file", "folder"], description: "delete: file or folder (default: file)." },
        dryRun: { type: "boolean", description: "Preview without executing (default: true for destructive actions)." },
        confirm: { type: "boolean", description: "Set true to execute destructive actions." },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_docman_document",
    description: "Manage DOCman documents. action: list|get|create|update|delete.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete"], description: "Operation to perform." },
        id: { type: "string", description: "Document ID (required for get/update/delete)." },
        title: { type: "string", description: "Required for create." },
        categoryId: { type: "string", description: "Required for create." },
        storagePath: { type: "string", description: "Relative path within DOCman files (e.g. 'bulletin/MyFile.pdf')" },
        storageType: { type: "string", description: "Defaults to 'file'" },
        description: { type: "string" },
        access: { type: "string", description: "1=Public, 2=Registered" },
        enabled: { type: "string", enum: ["0", "1"], description: "1=published (default)" },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_docman_category",
    description: "Manage DOCman categories. action: list|get|create|update|delete.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "delete"], description: "Operation to perform." },
        id: { type: "string", description: "Category ID (required for get/update/delete)." },
        title: { type: "string", description: "Required for create." },
        parentId: { type: "string", description: "Parent category ID. Omit for root-level." },
        description: { type: "string" },
        access: { type: "string", description: "1=Public, 2=Registered" },
        enabled: { type: "string", enum: ["0", "1"], description: "1=published (default)" },
      },
      required: ["action"],
    },
  },
  {
    name: "joomla_fileman_list_files",
    description: "List FILEman files and subfolders via the FILEman JSON API. Paths are relative to the FILEman container root (typically images/stories).",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Container-relative folder to list (e.g. 'staff'). Omit for the root folder." },
      },
    },
  },
  {
    name: "joomla_redirects_list",
    description: "List redirects.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_site_config_inspect",
    description: "Inspect global site configuration fields.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_get_frontend_page",
    description: "Fetch a frontend page. Returns title, headings, body text, links, images, OG meta, template, and module positions.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Frontend path (e.g. '/about-us') or full URL",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_get_frontend_screenshot",
    description: "Capture a browser screenshot of a frontend page. Injects admin session cookies for preview content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Frontend path or full URL. Defaults to '/'.",
        },
        viewport: {
          type: "string",
          enum: ["desktop", "tablet", "mobile"],
          description: "desktop (1280×800), tablet (768×1024), mobile (390×844). Defaults to desktop.",
        },
      },
      required: [],
    },
  },
  {
    name: "joomla_inspect_frontend",
    description:
      "Inspect one region of a rendered frontend page in a real browser: DOM structure, " +
      "box-model geometry, and the CSS rules that actually match. Use this when a screenshot " +
      "shows something is off but not why — unexpected spacing, a rule that will not apply, " +
      "a specificity fight. Returns a depth-capped tree plus, for CSS, only the rules matching " +
      "the target element under the current media query, and a 'winners' map naming the selector " +
      "and stylesheet that won each property. Scoped and truncated by design; prefer it over " +
      "fetching whole pages or stylesheets.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Frontend path (e.g. '/gala') or full URL." },
        selector: {
          type: "string",
          description: "CSS selector for the region to inspect (e.g. '#g-expanded', '.gala-prayer').",
        },
        viewport: {
          type: "string",
          enum: ["desktop", "tablet", "mobile"],
          description: "desktop (1280×800), tablet (768×1024), mobile (390×844). Defaults to desktop.",
        },
        include: {
          type: "array",
          items: { type: "string", enum: ["box", "text", "css"] },
          description:
            "Extra payloads. 'box' = geometry and margin/padding per node (default), " +
            "'text' = truncated text content, 'css' = matched rules and cascade winners. " +
            "The structure tree is always returned.",
        },
        cssFor: {
          type: "string",
          description:
            "Collect CSS for this descendant of the matched element instead of the element " +
            "itself (e.g. selector '#g-expanded', cssFor '.gala-prayer-title').",
        },
        properties: {
          type: "array",
          items: { type: "string" },
          description:
            "Restrict CSS output to these properties (e.g. ['margin-top','padding-top','color']). " +
            "Strongly recommended when debugging one specific thing — it cuts the output sharply.",
        },
        depth: { type: "number", description: "How many levels of children to walk. Default 3." },
        maxNodes: { type: "number", description: "Node cap per match. Default 60." },
        maxMatches: { type: "number", description: "How many matching elements to report. Default 3." },
        textLimit: { type: "number", description: "Characters of text per node. Default 80." },
        settleMs: {
          type: "number",
          description:
            "Wait after scrolling the target into view, for scroll-triggered animations to " +
            "finish before measuring. Default 1200.",
        },
        includeInactiveMedia: {
          type: "boolean",
          description:
            "Also report rules whose media query does not currently match. Default false — " +
            "useful for checking why a mobile rule is not firing at desktop width.",
        },
      },
      required: ["path", "selector"],
    },
  },
  {
    name: "joomla_workspace_write",
    description:
      "Write a file into the /app/workspace/ directory inside the container. " +
      "Use this to ferry AI-generated content (JSON, YAML, HTML, etc.) into the " +
      "server sandbox so that other tools (like filePath-based importers) can read it. " +
      "The bind-mount makes /app/workspace/ the same as the C:\\joomla-mcp-update\\ " +
      "folder on the host, so written files are also visible on disk. " +
      "Path must be relative and must not contain '..'.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path under /app/workspace/ (e.g. 'blueprints/home.json'). Must not contain '..'.",
        },
        content: {
          type: "string",
          description: "File content to write (text, JSON, YAML, etc.).",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "joomla_workspace_read",
    description:
      "Read back a file previously written with joomla_workspace_write from the " +
      "/app/workspace/ directory. Use this to fetch a persisted artifact instead of " +
      "having a model re-emit its full content. Path must be relative and must not contain '..'.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path under /app/workspace/ (e.g. 'blueprints/home.json'). Must not contain '..'.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_verify_frontend_content",
    description:
      "Verify that specific text strings are present or absent in a frontend page's " +
      "rendered content, and that specific CSS classes are present or absent anywhere " +
      "in the page HTML. Useful for confirming that a change has taken effect on the " +
      "live site. Returns per-check pass/fail results and an overall success flag.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Frontend path (e.g. '/about-us') or full URL",
        },
        text_present: {
          type: "array",
          items: { type: "string" },
          description: "Strings that MUST appear in the page text content",
        },
        text_absent: {
          type: "array",
          items: { type: "string" },
          description: "Strings that must NOT appear in the page text content",
        },
        css_present: {
          type: "array",
          items: { type: "string" },
          description: "CSS class names that MUST appear somewhere in the page HTML",
        },
        css_absent: {
          type: "array",
          items: { type: "string" },
          description: "CSS class names that must NOT appear anywhere in the page HTML",
        },
      },
      required: ["path"],
    },
  },
  // ==================== USER MANAGEMENT ====================
  {
    name: "joomla_user",
    description: "Manage Joomla users. action: list|get|create|update.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "create", "update", "send_reset_email"], description: "Operation to perform. send_reset_email: sends Joomla password reset email to the user (requires id)." },
        id: { type: "string", description: "User ID (required for get/update/send_reset_email)." },
        name: { type: "string", description: "Full display name. Required for create." },
        username: { type: "string", description: "Login username (typically email). Required for create." },
        email: { type: "string", description: "Required for create." },
        password: { type: "string", description: "Required for create. Omit on update to keep existing." },
        groups: {
          type: "array",
          items: { type: "string" },
          description: "Group IDs. Required for create; replaces all groups on update. Grade groups: 15=1st, 16=2nd, 17=3rd, 18=4th, 19=5th, 20=6th, 33=7th, 23=8th, 14=Kinder, 26=Pre-K, 12=Basic Editor.",
        },
        block: { type: "boolean", description: "true=block/create-blocked, false=enable." },
        requireReset: { type: "boolean", description: "Require password reset on next login. Defaults to true on create. Pass false to disable." },
        search: { type: "string", description: "Filter by name or email (list only)." },
        group_id: { type: "string", description: "Filter by group ID (list only)." },
        state: { type: "string", enum: ["0", "1"], description: "list: 0=enabled, 1=blocked." },
        limit: { type: "number", description: "Per page (default: 200, max: 500)" },
        page: { type: "number", description: "Page number, 1-based" },
      },
      required: ["action"],
    },
  },
  // ==================== GROUPS ====================
  {
    name: "joomla_group",
    description: "Manage Joomla user groups. action: list|create|delete.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "delete"], description: "Operation to perform." },
        id: { type: "string", description: "Group ID (required for delete)." },
        title: { type: "string", description: "Group name (required for create)." },
        parent_id: { type: "string", description: "Parent group ID for create. Omit for root level." },
      },
      required: ["action"],
    },
  },
  // ==================== PERMISSIONS ====================
  {
    name: "joomla_permissions",
    description: "Read or update ACL rules for articles and categories. action: get|set. resource: category|article.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set"], description: "get=read rules, set=update rules." },
        resource: { type: "string", enum: ["category", "article"], description: "Resource type to read/write permissions for." },
        id: { type: "string", description: "Category or article ID." },
        rules: {
          type: "object",
          description: "Required for set. { \"<groupId>\": { \"core.edit\": \"1\" } }. ''=Inherit, '1'=Allow, '0'=Deny.",
          additionalProperties: {
            type: "object",
            additionalProperties: { type: "string", enum: ["", "0", "1"] },
          },
        },
        extension: { type: "string", description: "Component extension for category permissions (default: com_content)." },
      },
      required: ["action", "resource", "id"],
    },
  },
];

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.filter((t) => !config.disabledTools.has(t.name.toLowerCase())),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
  const { name, arguments: args } = request.params;

  if (config.disabledTools.has(name.toLowerCase())) {
    return { content: [{ type: "text", text: JSON.stringify({ success: false, message: `Tool "${name}" is currently disabled.` }) }] };
  }

  // Resolve site-keyed Joomla session from cache.
  // The orchestrator injects site_url on every call; fall back to JOOMLA_BASE_URL
  // for direct (non-orchestrated) calls.
  const siteUrl = (args?.site_url as string | undefined) ?? config.baseUrl;
  const sess = getOrCreateSiteSession(normalizeUrl(siteUrl));
  const joomla = sess.client;

  async function ensureLoggedIn(): Promise<JoomlaResponse> {
    if (sess.isLoggedIn) {
      const stillLoggedIn = await joomla.isLoggedIn();
      if (stillLoggedIn) return { success: true, message: "Already logged in" };
      sess.isLoggedIn = false;
    }
    if (!config.username || !config.password) {
      return {
        success: false,
        message: "Joomla credentials not configured. Set JOOMLA_USERNAME and JOOMLA_PASSWORD in .env file.",
      };
    }
    const result = await joomla.login();
    if (result.success) sess.isLoggedIn = true;
    return result;
  }

  try {
    switch (name) {
      case "joomla_login": {
        // Site already resolved from site_url arg at top of handler.
        // Force re-auth so an explicit joomla_login always re-authenticates.
        sess.isLoggedIn = false;
        const result = await ensureLoggedIn();
        const cfg = joomla.getConfig();
        if (result.success) {
          result.data = { ...((result.data as object) ?? {}), activeSite: cfg.baseUrl, username: cfg.username };
        }
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_article": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;

        switch (action) {
          case "list":
            result = await joomla.listArticles(
              (args?.category_id as string) || undefined,
              (args?.state as string) || undefined,
              (args?.limit as number) || undefined,
              (args?.page as number) || undefined,
              (args?.search as string) || undefined,
            );
            break;
          case "get":
            result = await joomla.getArticle(
              (args?.id as string) || undefined,
              (args?.title as string) || undefined,
            );
            break;
          case "create": {
            const title = args?.title as string;
            const categoryId = args?.categoryId as string;
            if (!title || !categoryId)
              return { content: [{ type: "text", text: "Error: title and categoryId are required for create" }], isError: true };
            result = await joomla.createArticle({
              title,
              alias: args?.alias as string,
              categoryId,
              content: args?.content as string,
              state: args?.state as string,
              access: args?.access as string,
              introImage: args?.introImage as string,
              introImageAlt: args?.introImageAlt as string,
              featuredImage: args?.featuredImage as string,
              featuredImageAlt: args?.featuredImageAlt as string,
            });
            break;
          }
          case "update": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
            result = await joomla.updateArticle(id, {
              title: args?.title as string,
              alias: args?.alias as string,
              categoryId: args?.categoryId as string,
              content: args?.content as string,
              state: args?.state as string,
              access: args?.access as string,
              ordering: args?.ordering as string,
              introImage: args?.introImage as string,
              introImageAlt: args?.introImageAlt as string,
              featuredImage: args?.featuredImage as string,
              featuredImageAlt: args?.featuredImageAlt as string,
            });
            break;
          }
          case "delete": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
            result = await joomla.deleteArticle(id, { expectedTitle: args?.expectedTitle as string });
            break;
          }
          case "checkin": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for checkin" }], isError: true };
            result = await joomla.checkInArticle(id, { expectedTitle: args?.expectedTitle as string });
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|get|create|update|delete|checkin` }], isError: true };
        }

        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;
        switch (action) {
          case "list": {
            result = await joomla.listCategories(
              args?.extension as string,
              (args?.limit as number) || undefined,
              (args?.page as number) || undefined,
              (args?.search as string) || undefined,
            );
            break;
          }
          case "get": {
            result = await joomla.getCategory(
              (args?.id as string) || undefined,
              (args?.title as string) || undefined,
            );
            break;
          }
          case "create": {
            const title = args?.title as string;
            if (!title) return { content: [{ type: "text", text: "Error: title is required for create" }], isError: true };
            result = await joomla.createCategory({
              title,
              alias: args?.alias as string,
              parentId: args?.parentId as string,
              description: args?.description as string,
              published: args?.published as string,
              extension: args?.extension as string,
            });
            break;
          }
          case "update": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
            result = await joomla.updateCategory(id, {
              title: args?.title as string,
              alias: args?.alias as string,
              parentId: args?.parentId as string,
              description: args?.description as string,
              published: args?.published as string,
              ordering: args?.ordering as string,
            });
            break;
          }
          case "delete": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
            result = await joomla.deleteCategory(id, {
              expectedTitle: args?.expectedTitle as string,
            });
            break;
          }
          case "checkin": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for checkin" }], isError: true };
            result = await joomla.checkInCategory(id, {
              expectedTitle: args?.expectedTitle as string,
            });
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|get|create|update|delete|checkin` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;
        switch (action) {
          case "list": {
            result = await joomla.listModules(
              args?.client_id as string,
              (args?.search as string) || undefined,
              (args?.limit as number) || undefined,
              (args?.page as number) || undefined,
            );
            break;
          }
          case "get": {
            result = await joomla.getModule(
              (args?.id as string) || undefined,
              (args?.title as string) || undefined,
              (args?.client_id as string) || "0",
            );
            break;
          }
          case "create": {
            const title = args?.title as string;
            const moduleType = args?.moduleType as string;
            if (!title || !moduleType)
              return { content: [{ type: "text", text: "Error: title and moduleType are required for create" }], isError: true };
            result = await joomla.createModule({
              title,
              moduleType,
              clientId: args?.client_id as string,
              position: args?.position as string,
              published: args?.published as string,
              access: args?.access as string,
              showtitle: args?.showtitle as string,
              ordering: args?.ordering as string,
              style: args?.style as string,
              language: args?.language as string,
              note: args?.note as string,
              assignment: args?.assignment as string,
              assigned: args?.assigned as string[],
              content: args?.content as string,
              params: args?.params as Record<string, string>,
              advanced: args?.advanced as Record<string, string>,
              fieldOverrides: args?.fieldOverrides as Record<string, string>,
            });
            break;
          }
          case "update": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
            result = await joomla.updateModule(id, {
              title: args?.title as string,
              position: args?.position as string,
              published: args?.published as string,
              access: args?.access as string,
              showtitle: args?.showtitle as string,
              ordering: args?.ordering as string,
              style: args?.style as string,
              language: args?.language as string,
              note: args?.note as string,
              assignment: args?.assignment as string,
              assigned: args?.assigned as string[],
              content: args?.content as string,
              params: args?.params as Record<string, string>,
              advanced: args?.advanced as Record<string, string>,
              fieldOverrides: args?.fieldOverrides as Record<string, string>,
            });
            break;
          }
          case "delete": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
            result = await joomla.deleteModule(id, {
              clientId: args?.client_id as string,
              expectedTitle: args?.expectedTitle as string,
              expectedModuleType: args?.expectedModuleType as string,
            });
            break;
          }
          case "toggle": {
            const id = args?.id as string;
            const state = args?.state as string;
            if (!id || !state)
              return { content: [{ type: "text", text: "Error: id and state are required for toggle" }], isError: true };
            result = await joomla.toggleModule(id, state, {
              expectedTitle: args?.expectedTitle as string,
              expectedModuleType: args?.expectedModuleType as string,
            });
            break;
          }
          case "checkin": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for checkin" }], isError: true };
            result = await joomla.checkInModule(id, {
              expectedTitle: args?.expectedTitle as string,
              expectedModuleType: args?.expectedModuleType as string,
            });
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|get|create|update|delete|toggle|checkin` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_module_type": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;
        switch (action) {
          case "list": {
            result = await joomla.listModuleTypes(args?.client_id as string);
            break;
          }
          case "list_positions": {
            result = await joomla.listModulePositions(args?.client_id as string);
            break;
          }
          case "inspect": {
            const moduleType = args?.moduleType as string;
            if (!moduleType) return { content: [{ type: "text", text: "Error: moduleType is required for inspect" }], isError: true };
            result = await joomla.inspectModuleType(moduleType, args?.client_id as string);
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|inspect|list_positions` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_menu": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;

        switch (action) {
          case "list":
            result = await joomla.listMenus();
            break;
          case "create": {
            const title = args?.title as string;
            if (!title) return { content: [{ type: "text", text: "Error: title is required for create" }], isError: true };
            result = await joomla.createMenu({
              title,
              menuType: args?.menuType as string,
              description: args?.description as string,
              cssClasses: args?.cssClasses as string,
            });
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|create` }], isError: true };
        }

        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;

        switch (action) {
          case "list": {
            result = await joomla.listMenuItems(
              (args?.menuId as string) || undefined,
              (args?.search as string) || undefined,
              (args?.limit as number) || undefined,
              (args?.page as number) || undefined,
            );
            break;
          }
          case "get":
            result = await joomla.getMenuItem(
              (args?.id as string) || undefined,
              (args?.title as string) || undefined,
              (args?.menuId as string) || undefined,
            );
            break;
          case "create": {
            const title = args?.title as string;
            const menuType = args?.menuType as string;
            const itemType = args?.itemType as string;
            if (!title || !menuType || !itemType)
              return { content: [{ type: "text", text: "Error: title, menuType, and itemType are required for create" }], isError: true };
            result = await joomla.createMenuItem({
              title,
              menuType,
              itemType,
              alias: args?.alias as string,
              link: args?.link as string,
              parentId: args?.parentId as string,
              published: args?.published as string,
              access: args?.access as string,
              language: args?.language as string,
              browserNav: args?.browserNav as string,
              home: args?.home as string,
              note: args?.note as string,
              templateStyleId: args?.templateStyleId as string,
              request: args?.request as Record<string, string>,
              params: args?.params as Record<string, string>,
              fieldOverrides: args?.fieldOverrides as Record<string, string>,
            });
            break;
          }
          case "update": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
            result = await joomla.updateMenuItem(id, {
              title: args?.title as string,
              itemType: args?.itemType as string,
              alias: args?.alias as string,
              menuType: args?.menuType as string,
              link: args?.link as string,
              parentId: args?.parentId as string,
              published: args?.published as string,
              access: args?.access as string,
              language: args?.language as string,
              browserNav: args?.browserNav as string,
              home: args?.home as string,
              note: args?.note as string,
              templateStyleId: args?.templateStyleId as string,
              ordering: args?.ordering as string,
              request: args?.request as Record<string, string>,
              params: args?.params as Record<string, string>,
              fieldOverrides: args?.fieldOverrides as Record<string, string>,
            });
            break;
          }
          case "delete": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
            result = await joomla.deleteMenuItem(id, {
              menuType: args?.menuType as string,
              expectedTitle: args?.expectedTitle as string,
              expectedMenuType: args?.expectedMenuType as string,
            });
            break;
          }
          case "toggle": {
            const id = args?.id as string;
            const state = args?.state as string;
            if (!id || !state) return { content: [{ type: "text", text: "Error: id and state are required for toggle" }], isError: true };
            result = await joomla.toggleMenuItem(id, state, args?.menuType as string, {
              expectedTitle: args?.expectedTitle as string,
              expectedMenuType: args?.expectedMenuType as string,
            });
            break;
          }
          case "checkin": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for checkin" }], isError: true };
            result = await joomla.checkInMenuItem(id, args?.menuType as string, {
              expectedTitle: args?.expectedTitle as string,
              expectedMenuType: args?.expectedMenuType as string,
            });
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|get|create|update|delete|toggle|checkin` }], isError: true };
        }

        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_menu_item_type": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;

        switch (action) {
          case "list":
            result = await joomla.listMenuItemTypes();
            break;
          case "inspect": {
            const itemType = args?.itemType as string;
            if (!itemType) return { content: [{ type: "text", text: "Error: itemType is required for inspect" }], isError: true };
            result = await joomla.inspectMenuItemType(itemType);
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|inspect` }], isError: true };
        }

        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_bulk_checkin": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.bulkCheckin({
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_backend_inventory": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.backendInventory();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_inspect_admin_form": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.inspectAdminForm(path, args?.formId as string);
        if (args?.rawHtml) {
          const lines = (result.html || "").split("\n");
          const limited = args?.head ? lines.slice(0, args.head as number) : lines;
          return { content: [{ type: "text", text: limited.join("\n") }], isError: !result.success };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_inspect_admin_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.inspectAdminList(path, (args?.formId as string) || "adminForm");
        if (args?.rawHtml) {
          const lines = (result.html || "").split("\n");
          const limited = args?.head ? lines.slice(0, args.head as number) : lines;
          return { content: [{ type: "text", text: limited.join("\n") }], isError: !result.success };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_submit_admin_form": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.submitAdminForm(path, {
          formId: args?.formId as string,
          overrides: args?.overrides as Record<string, string>,
          task: args?.task as string,
          dryRun: (args?.dryRun as boolean | undefined) ?? !(args?.confirm as boolean),
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_component_inspect": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.componentInspect({ path, mode: args?.mode as "form" | "list", formId: args?.formId as string });
        if (args?.rawHtml) {
          const lines = (result.html || "").split("\n");
          const limited = args?.head ? lines.slice(0, args.head as number) : lines;
          return { content: [{ type: "text", text: limited.join("\n") }], isError: !result.success };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;
        switch (action) {
          case "list": {
            result = await joomla.mediaList((args?.path as string) || (args?.folder as string) || "index.php?option=com_media");
            break;
          }
          case "create_folder": {
            const folderName = args?.folderName as string;
            if (!folderName) return { content: [{ type: "text", text: "Error: folderName is required for create_folder" }], isError: true };
            result = await joomla.createMediaFolder({
              folderName,
              folderBase: args?.folderBase as string,
              path: args?.path as string,
              dryRun: args?.dryRun as boolean,
              confirm: args?.confirm as boolean,
            });
            break;
          }
          case "upload": {
            result = await joomla.uploadMediaFile({
              fileUrl: args?.fileUrl as string,
              base64Content: args?.base64Content as string,
              fileName: args?.fileName as string,
              folder: args?.folder as string,
              dryRun: args?.dryRun as boolean,
              confirm: args?.confirm as boolean,
            });
            break;
          }
          case "delete": {
            const path = args?.path as string;
            if (!path) return { content: [{ type: "text", text: "Error: path is required for delete" }], isError: true };
            result = await joomla.deleteMedia({
              path,
              type: args?.type as "file" | "folder",
              dryRun: args?.dryRun as boolean,
              confirm: args?.confirm as boolean,
            });
            break;
          }
          case "rename": {
            const path = args?.path as string;
            const newName = args?.newName as string;
            if (!path) return { content: [{ type: "text", text: "Error: path is required for rename" }], isError: true };
            if (!newName) return { content: [{ type: "text", text: "Error: newName is required for rename" }], isError: true };
            result = await joomla.renameMediaFile({
              path,
              newName,
              dryRun: args?.dryRun as boolean,
              confirm: args?.confirm as boolean,
            });
            break;
          }
          case "move": {
            const path = args?.path as string;
            const targetFolder = args?.targetFolder as string;
            if (!path) return { content: [{ type: "text", text: "Error: path is required for move" }], isError: true };
            if (targetFolder === undefined) return { content: [{ type: "text", text: "Error: targetFolder is required for move" }], isError: true };
            result = await joomla.moveMediaFile({
              path,
              targetFolder,
              dryRun: args?.dryRun as boolean,
              confirm: args?.confirm as boolean,
            });
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|create_folder|upload|delete|rename|move` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_document": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;
        switch (action) {
          case "list": {
            result = await joomla.listDocmanDocuments();
            break;
          }
          case "get": {
            if (!args?.id) return { content: [{ type: "text", text: "Error: id is required for get" }], isError: true };
            result = await joomla.getDocmanDocument(String(args.id));
            break;
          }
          case "create": {
            if (!args?.title || !args?.categoryId) return { content: [{ type: "text", text: "Error: title and categoryId are required for create" }], isError: true };
            result = await joomla.createDocmanDocument({
              title: String(args.title),
              categoryId: String(args.categoryId),
              storagePath: args?.storagePath !== undefined ? String(args.storagePath) : undefined,
              storageType: args?.storageType !== undefined ? String(args.storageType) : undefined,
              description: args?.description !== undefined ? String(args.description) : undefined,
              access: args?.access !== undefined ? String(args.access) : undefined,
              enabled: args?.enabled !== undefined ? String(args.enabled) : undefined,
            });
            break;
          }
          case "update": {
            if (!args?.id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
            result = await joomla.updateDocmanDocument(String(args.id), {
              title: args?.title !== undefined ? String(args.title) : undefined,
              categoryId: args?.categoryId !== undefined ? String(args.categoryId) : undefined,
              storagePath: args?.storagePath !== undefined ? String(args.storagePath) : undefined,
              description: args?.description !== undefined ? String(args.description) : undefined,
              access: args?.access !== undefined ? String(args.access) : undefined,
              enabled: args?.enabled !== undefined ? String(args.enabled) : undefined,
            });
            break;
          }
          case "delete": {
            if (!args?.id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
            result = await joomla.deleteDocmanDocument(String(args.id));
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|get|create|update|delete` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;
        switch (action) {
          case "list": {
            result = await joomla.listDocmanCategories();
            break;
          }
          case "get": {
            if (!args?.id) return { content: [{ type: "text", text: "Error: id is required for get" }], isError: true };
            result = await joomla.getDocmanCategory(String(args.id));
            break;
          }
          case "create": {
            if (!args?.title) return { content: [{ type: "text", text: "Error: title is required for create" }], isError: true };
            result = await joomla.createDocmanCategory({
              title: String(args.title),
              parentId: args?.parentId !== undefined ? String(args.parentId) : undefined,
              description: args?.description !== undefined ? String(args.description) : undefined,
              access: args?.access !== undefined ? String(args.access) : undefined,
              enabled: args?.enabled !== undefined ? String(args.enabled) : undefined,
            });
            break;
          }
          case "update": {
            if (!args?.id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
            result = await joomla.updateDocmanCategory(String(args.id), {
              title: args?.title !== undefined ? String(args.title) : undefined,
              parentId: args?.parentId !== undefined ? String(args.parentId) : undefined,
              description: args?.description !== undefined ? String(args.description) : undefined,
              access: args?.access !== undefined ? String(args.access) : undefined,
              enabled: args?.enabled !== undefined ? String(args.enabled) : undefined,
            });
            break;
          }
          case "delete": {
            if (!args?.id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
            result = await joomla.deleteDocmanCategory(String(args.id));
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|get|create|update|delete` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_fileman_list_files": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listFilemanFiles(args?.folder as string | undefined);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_redirects_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listRedirects();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_site_config_inspect": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.inspectSiteConfig();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_get_frontend_page": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };

        const result = await joomla.getFrontendPageInfo(path);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_get_frontend_screenshot": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const screenshotPath = (args?.path as string | undefined) ?? "/";
        const viewport = (args?.viewport as "desktop" | "tablet" | "mobile" | undefined) ?? "desktop";

        const result = await joomla.getFrontendScreenshot(screenshotPath, viewport);

        if (!result.success) {
          return { content: [{ type: "text", text: formatResult(result) }], isError: true };
        }

        const { url, pageTitle, width, height, base64 } =
          result.data as { url: string; pageTitle: string; viewport: string; width: number; height: number; base64: string };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, url, pageTitle, viewport, width, height }, null, 2),
            },
            {
              type: "image",
              data: base64,
              mimeType: "image/png",
            },
          ],
          isError: false,
        };
      }

      case "joomla_workspace_read": {
        const relPath = args?.path as string;
        if (!relPath) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        if (relPath.includes("..") || path.isAbsolute(relPath))
          return { content: [{ type: "text", text: "Error: path must be relative and must not contain '..'" }], isError: true };
        const workspaceDir = path.join(process.cwd(), "workspace");
        const srcPath = path.join(workspaceDir, relPath);
        if (!srcPath.startsWith(workspaceDir + path.sep) && srcPath !== workspaceDir)
          return { content: [{ type: "text", text: "Error: resolved path escapes workspace directory" }], isError: true };
        if (!fs.existsSync(srcPath))
          return { content: [{ type: "text", text: `Error: no file at workspace path '${relPath}'` }], isError: true };
        const fileContent = fs.readFileSync(srcPath, "utf8");
        return {
          content: [{ type: "text", text: fileContent }],
          isError: false,
        };
      }

      case "joomla_inspect_frontend": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const inspectPath = args?.path as string;
        const inspectSelector = args?.selector as string;
        if (!inspectPath || !inspectSelector) {
          return { content: [{ type: "text", text: "Error: path and selector are required" }], isError: true };
        }

        const result = await joomla.inspectFrontend({
          path: inspectPath,
          selector: inspectSelector,
          viewport: (args?.viewport as 'desktop' | 'tablet' | 'mobile' | undefined) ?? 'desktop',
          include: args?.include as Array<'box' | 'text' | 'css'> | undefined,
          cssFor: args?.cssFor as string | undefined,
          properties: args?.properties as string[] | undefined,
          depth: args?.depth as number | undefined,
          maxNodes: args?.maxNodes as number | undefined,
          maxMatches: args?.maxMatches as number | undefined,
          textLimit: args?.textLimit as number | undefined,
          settleMs: args?.settleMs as number | undefined,
          includeInactiveMedia: args?.includeInactiveMedia as boolean | undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_verify_frontend_content": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const verifyPath = args?.path as string;
        if (!verifyPath) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };

        const textPresent = (args?.text_present as string[] | undefined) ?? [];
        const textAbsent = (args?.text_absent as string[] | undefined) ?? [];
        const cssPresent = (args?.css_present as string[] | undefined) ?? [];
        const cssAbsent = (args?.css_absent as string[] | undefined) ?? [];

        const pageResult = await joomla.getFrontendPageInfo(verifyPath);
        if (!pageResult.success) {
          return { content: [{ type: "text", text: formatResult(pageResult) }], isError: true };
        }

        const pageData = pageResult.data as { rawHtml?: string; bodyText?: string; [k: string]: unknown };
        const rawHtml = (pageData.rawHtml ?? "") as string;
        const bodyText = (pageData.bodyText ?? "") as string;

        const checks: { check: string; kind: string; target: string; pass: boolean }[] = [];

        for (const t of textPresent) {
          checks.push({ check: "text_present", kind: "text", target: t, pass: bodyText.toLowerCase().includes(t.toLowerCase()) });
        }
        for (const t of textAbsent) {
          checks.push({ check: "text_absent", kind: "text", target: t, pass: !bodyText.toLowerCase().includes(t.toLowerCase()) });
        }
        for (const c of cssPresent) {
          checks.push({ check: "css_present", kind: "css", target: c, pass: rawHtml.includes(c) });
        }
        for (const c of cssAbsent) {
          checks.push({ check: "css_absent", kind: "css", target: c, pass: !rawHtml.includes(c) });
        }

        const allPass = checks.every((ch) => ch.pass);
        const failed = checks.filter((ch) => !ch.pass);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: allPass, url: verifyPath, checks, failed }, null, 2),
          }],
          isError: !allPass,
        };
      }

      case "joomla_workspace_write": {
        const relPath = args?.path as string;
        const fileContent = args?.content as string;
        if (!relPath) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        if (fileContent === undefined || fileContent === null)
          return { content: [{ type: "text", text: "Error: content is required" }], isError: true };
        if (relPath.includes("..") || path.isAbsolute(relPath))
          return { content: [{ type: "text", text: "Error: path must be relative and must not contain '..'" }], isError: true };
        const workspaceDir = path.join(process.cwd(), "workspace");
        const destPath = path.join(workspaceDir, relPath);
        if (!destPath.startsWith(workspaceDir + path.sep) && destPath !== workspaceDir)
          return { content: [{ type: "text", text: "Error: resolved path escapes workspace directory" }], isError: true };
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, fileContent, "utf8");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Written ${fileContent.length} bytes`,
              containerPath: destPath,
              workspacePath: relPath,
            }, null, 2),
          }],
          isError: false,
        };
      }

      // ==================== USER MANAGEMENT ====================

      case "joomla_user": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;
        switch (action) {
          case "list": {
            result = await joomla.listUsers(
              args?.search as string | undefined,
              args?.group_id as string | undefined,
              args?.state as string | undefined,
              args?.limit as number | undefined,
              args?.page as number | undefined,
            );
            break;
          }
          case "get": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for get" }], isError: true };
            result = await joomla.getUser(id);
            break;
          }
          case "create": {
            const name = args?.name as string;
            const username = args?.username as string;
            const email = args?.email as string;
            const password = args?.password as string;
            const groups = args?.groups as string[];
            if (!name || !username || !email || !password || !groups?.length)
              return { content: [{ type: "text", text: "Error: name, username, email, password, and groups are required for create" }], isError: true };
            result = await joomla.createUser({ name, username, email, password, groups, block: args?.block as boolean | undefined, requireReset: args?.requireReset as boolean | undefined });
            break;
          }
          case "update": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for update" }], isError: true };
            result = await joomla.updateUser(id, {
              name: args?.name as string | undefined,
              username: args?.username as string | undefined,
              email: args?.email as string | undefined,
              password: args?.password as string | undefined,
              block: args?.block as boolean | undefined,
              groups: args?.groups as string[] | undefined,
              requireReset: args?.requireReset as boolean | undefined,
            });
            break;
          }
          case "send_reset_email": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for send_reset_email" }], isError: true };
            result = await joomla.sendUserResetEmail(id);
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|get|create|update|send_reset_email` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      // ==================== GROUPS ====================

      case "joomla_group": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        let result: JoomlaResponse;
        switch (action) {
          case "list": {
            result = await joomla.listGroups();
            break;
          }
          case "create": {
            const title = args?.title as string;
            if (!title) return { content: [{ type: "text", text: "Error: title is required for create" }], isError: true };
            result = await joomla.createGroup({ title, parentId: args?.parent_id as string | undefined });
            break;
          }
          case "delete": {
            const id = args?.id as string;
            if (!id) return { content: [{ type: "text", text: "Error: id is required for delete" }], isError: true };
            result = await joomla.deleteGroup(id);
            break;
          }
          default:
            return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: list|create|delete` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      // ==================== PERMISSIONS ====================

      case "joomla_permissions": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const action = args?.action as string;
        const resource = args?.resource as string;
        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        let result: JoomlaResponse;
        if (action === "get") {
          if (resource === "category") {
            result = await joomla.getCategoryPermissions(id, args?.extension as string | undefined);
          } else if (resource === "article") {
            result = await joomla.getArticlePermissions(id);
          } else {
            return { content: [{ type: "text", text: `Error: unknown resource "${resource}". Valid: category|article` }], isError: true };
          }
        } else if (action === "set") {
          const rules = args?.rules as Record<string, Record<string, string>>;
          if (!rules) return { content: [{ type: "text", text: "Error: rules are required for set" }], isError: true };
          if (resource === "category") {
            result = await joomla.setCategoryPermissions(id, rules, args?.extension as string | undefined);
          } else if (resource === "article") {
            result = await joomla.setArticlePermissions(id, rules);
          } else {
            return { content: [{ type: "text", text: `Error: unknown resource "${resource}". Valid: category|article` }], isError: true };
          }
        } else {
          return { content: [{ type: "text", text: `Error: unknown action "${action}". Valid: get|set` }], isError: true };
        }
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

  const DOCS_DIR = path.join(__dirname, "..", "..", "..", "docs", "agents");

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] };
  });

  function collectMdFiles(dir: string, base: string = ""): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(...collectMdFiles(path.join(dir, entry.name), rel));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(rel);
      }
    }
    return results;
  }

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const files = collectMdFiles(DOCS_DIR);
    return {
      resources: files.map((f) => ({
        uri: `joomla-docs://agents/${f}`,
        name: f.replace(".md", ""),
        mimeType: "text/markdown",
        description: `Joomla MCP workflow guide: ${f.replace(".md", "")}`,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri as string;
    const match = uri.match(/^joomla-docs:\/\/agents\/(.+\.md)$/);
    if (!match) throw new Error(`Unknown resource: ${uri}`);
    const filePath = path.join(DOCS_DIR, match[1]);
    if (!fs.existsSync(filePath)) throw new Error(`Resource not found: ${match[1]}`);
    return {
      contents: [{ uri, mimeType: "text/markdown", text: fs.readFileSync(filePath, "utf8") }],
    };
  });

  return server;
}

// Only auto-start a transport when executed directly (node dist/index.js).
// The orchestrator requires this module for in-process hosting and calls
// buildServer() itself.
if (require.main === module) runServer({
  buildServer,
  serverInfo: { name: "joomla-mcp", version: "1.0.0" },
  logger: createLogger("joomla-mcp"),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
