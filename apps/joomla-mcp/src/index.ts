import "dotenv/config";
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
import { FtpClient } from "./ftp-client.js";
import { FreshdeskClient } from "./freshdesk-client.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// Freshdesk client (optional — tools fail gracefully if not configured)
const freshdeskConfig = {
  domain: process.env.FRESHDESK_DOMAIN ?? "",
  apiKey: process.env.FRESHDESK_API_KEY ?? "",
};
const freshdesk =
  freshdeskConfig.domain && freshdeskConfig.apiKey
    ? new FreshdeskClient(freshdeskConfig)
    : null;

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


function buildServer(joomla: JoomlaClient): Server {
  let isLoggedIn = false;
  const ftpClient = new FtpClient();

  async function ensureLoggedIn(): Promise<JoomlaResponse> {
    if (isLoggedIn) {
      const stillLoggedIn = await joomla.isLoggedIn();
      if (stillLoggedIn) return { success: true, message: "Already logged in" };
      isLoggedIn = false;
    }

    if (!config.username || !config.password) {
      return {
        success: false,
        message: "Joomla credentials not configured. Set JOOMLA_USERNAME and JOOMLA_PASSWORD in .env file.",
      };
    }

    const result = await joomla.login();
    if (result.success) {
      isLoggedIn = true;
    }
    return result;
  }

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
    name: "joomla_list_categories",
    description: "List categories. Use 'search' to filter by title server-side. Optional extension (default: com_content). Paginated — default 200/page.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Server-side title filter." },
        extension: { type: "string", description: "Component extension (default: com_content)" },
        limit: { type: "number", description: "Per page (default: 200, max: 500)" },
        page: { type: "number", description: "Page number, 1-based" },
      },
      required: [],
    },
  },
  {
    name: "joomla_get_category",
    description: "Get a category by id or title. Ambiguous title returns a list to disambiguate.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID for a direct lookup." },
        title: { type: "string", description: "Search by title. Returns category directly if unique, or a list of matches." },
      },
      required: [],
    },
  },
  {
    name: "joomla_create_category",
    description: "Create a category. Requires title.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        alias: { type: "string" },
        parentId: { type: "string", description: "Parent category ID (default: 1=root)" },
        description: { type: "string", description: "HTML description" },
        published: { type: "string", description: "1=published, 0=unpublished" },
        extension: { type: "string", description: "Default: com_content" },
      },
      required: ["title"],
    },
  },
  {
    name: "joomla_update_category",
    description: "Update a category by ID. Only provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID" },
        title: { type: "string" },
        alias: { type: "string" },
        parentId: { type: "string" },
        description: { type: "string", description: "HTML description" },
        published: { type: "string", description: "1=published, 0=unpublished" },
        ordering: { type: "string", description: "Place after category with this ID. Use -1 for first." },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_delete_category",
    description: "Delete a category by ID. Cannot delete categories that contain articles.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID" },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_checkin_category",
    description: "Check in a checked-out category.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID" },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_list_modules",
    description: "List modules. Use 'search' to filter by title server-side. client_id: 0=site, 1=admin.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Server-side title filter." },
        client_id: { type: "string", description: "0=site, 1=admin (default: 0)" },
        limit: { type: "number", description: "Per page (default: 200, max: 500)" },
        page: { type: "number", description: "Page number, 1-based" },
      },
      required: [],
    },
  },
  {
    name: "joomla_list_module_types",
    description: "List available module types that can be created.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string", description: "0=site, 1=admin (default: 0)" },
      },
      required: [],
    },
  },
  {
    name: "joomla_list_module_positions",
    description: "List module positions available in the template.",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string", description: "0=site, 1=admin (default: 0)" },
      },
      required: [],
    },
  },
  {
    name: "joomla_inspect_module_type",
    description: "Inspect a module type before creating. Returns type-specific params, positions, assignment options.",
    inputSchema: {
      type: "object",
      properties: {
        moduleType: { type: "string", description: "Extension ID or visible title (e.g. Custom, Menu)" },
        client_id: { type: "string", description: "0=site, 1=admin (default: 0)" },
      },
      required: ["moduleType"],
    },
  },
  {
    name: "joomla_get_module",
    description: "Get a module by id or title. Ambiguous title returns a list to disambiguate.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Module ID for a direct lookup." },
        title: { type: "string", description: "Search by title. Returns module directly if unique, or a list of matches." },
        client_id: { type: "string", description: "0=site, 1=admin (default: 0)" },
      },
      required: [],
    },
  },
  {
    name: "joomla_update_module",
    description: "Update a module by ID. Supports params, advanced, page assignments, and fieldOverrides.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Module ID" },
        title: { type: "string" },
        position: { type: "string" },
        published: { type: "string", description: "1=yes, 0=no" },
        access: { type: "string", description: "1=Public, 2=Special, 3=Registered" },
        showtitle: { type: "string", description: "1=yes, 0=no" },
        ordering: { type: "string" },
        style: { type: "string" },
        language: { type: "string", description: "Defaults to *" },
        note: { type: "string" },
        assignment: { type: "string", description: "0=all pages, -=none, 1=only selected, -1=all except selected" },
        assigned: { type: "array", items: { type: "string" }, description: "Menu item IDs for assignment" },
        params: { type: "object", additionalProperties: { type: "string" }, description: "Type-specific params from joomla_inspect_module_type" },
        advanced: { type: "object", additionalProperties: { type: "string" } },
        fieldOverrides: { type: "object", additionalProperties: { type: "string" }, description: "Raw field overrides e.g. {\"jform[params][count]\":\"5\"}" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_create_module",
    description: "Create a module. Use joomla_list_module_types and joomla_inspect_module_type first.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        moduleType: { type: "string", description: "Extension ID or visible title (e.g. Custom, Menu, Search)" },
        client_id: { type: "string", description: "0=site, 1=admin (default: 0)" },
        position: { type: "string" },
        published: { type: "string", description: "1=yes, 0=no" },
        access: { type: "string", description: "Access level ID" },
        showtitle: { type: "string", description: "1=yes, 0=no" },
        ordering: { type: "string" },
        style: { type: "string" },
        language: { type: "string" },
        note: { type: "string" },
        assignment: { type: "string", description: "0=all pages, -=none, 1=only selected, -1=all except selected" },
        assigned: { type: "array", items: { type: "string" }, description: "Menu item IDs for assignment" },
        content: { type: "string", description: "HTML content for Custom modules" },
        params: { type: "object", additionalProperties: { type: "string" } },
        advanced: { type: "object", additionalProperties: { type: "string" } },
        fieldOverrides: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["title", "moduleType"],
    },
  },
  {
    name: "joomla_delete_module",
    description: "Delete a module by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Module ID" },
        client_id: { type: "string", description: "0=site, 1=admin (for verification)" },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches" },
        expectedModuleType: { type: "string", description: "Safety check: refuse unless type matches" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_checkin_module",
    description: "Check in a checked-out module.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Module ID" },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches" },
        expectedModuleType: { type: "string", description: "Safety check: refuse unless type matches" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_toggle_module",
    description: "Enable (state=1) or disable (state=0) a module.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Module ID" },
        state: { type: "string", description: "1=enable, 0=disable", enum: ["0", "1"] },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches" },
        expectedModuleType: { type: "string", description: "Safety check: refuse unless type matches" },
      },
      required: ["id", "state"],
    },
  },
  {
    name: "joomla_list_menus",
    description: "List all menus. Returns id and title for each.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "joomla_create_menu",
    description: "Create a menu container. Use the returned menuType when creating menu items.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Visible menu title" },
        menuType: { type: "string", description: "System type slug, max 24 chars (defaults from title)" },
        description: { type: "string" },
        cssClasses: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "joomla_list_menu_items",
    description: "List menu items for a menu (menuId = menuType, e.g. 'mainmenu'). Use 'search' to filter by title.",
    inputSchema: {
      type: "object",
      properties: {
        menuId: { type: "string", description: "Menu type identifier (e.g. mainmenu)" },
        search: { type: "string", description: "Server-side title filter." },
        limit: { type: "number", description: "Per page (default: 0=all, max 500)" },
        page: { type: "number", description: "Page number, 1-based" },
      },
      required: ["menuId"],
    },
  },
  {
    name: "joomla_list_menu_item_types",
    description: "List all available menu item types.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "joomla_inspect_menu_item_type",
    description: "Inspect a menu item type before creating. Returns type-specific fields.",
    inputSchema: {
      type: "object",
      properties: {
        itemType: { type: "string", description: "Encoded value, label, or request key (e.g. com_content.article)" },
      },
      required: ["itemType"],
    },
  },
  {
    name: "joomla_get_menu_item",
    description: "Get a menu item by id or title. Returns request and params fields. Ambiguous title returns a list.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Menu item ID for a direct lookup." },
        title: { type: "string", description: "Search by title. Returns item directly if unique, or a list of matches." },
        menuId: { type: "string", description: "Scope title search to a specific menu (e.g. mainmenu)." },
      },
      required: [],
    },
  },
  {
    name: "joomla_create_menu_item",
    description: "Create a menu item. Use joomla_list_menu_item_types first.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        menuType: { type: "string", description: "Menu type (e.g. mainmenu)" },
        itemType: { type: "string", description: "Encoded type or request key (e.g. com_content.article)" },
        alias: { type: "string" },
        link: { type: "string", description: "Explicit link (e.g. index.php?option=com_content&view=article&id=123)" },
        parentId: { type: "string", description: "Parent menu item ID (default: 1=root)" },
        published: { type: "string", description: "1=published, 0=unpublished, -2=trashed" },
        access: { type: "string", description: "Access level ID (usually 1=Public)" },
        language: { type: "string", description: "Defaults to *" },
        browserNav: { type: "string", description: "0=same window, 1=new window, 2=popup" },
        home: { type: "string", description: "1=set as home page" },
        note: { type: "string" },
        request: { type: "object", additionalProperties: { type: "string" }, description: "Type-specific request values e.g. {\"id\":\"123\"}" },
        params: { type: "object", additionalProperties: { type: "string" } },
        templateStyleId: { type: "string", description: "Gantry outline ID (0=site default). See templateStyleOptions in joomla_get_menu_item." },
        fieldOverrides: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["title", "menuType", "itemType"],
    },
  },
  {
    name: "joomla_update_menu_item",
    description: "Update a menu item by ID. Use instead of delete+recreate to avoid alias conflicts.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Menu item ID" },
        title: { type: "string" },
        itemType: { type: "string", description: "New type (e.g. com_content.category.blog)" },
        alias: { type: "string" },
        menuType: { type: "string", description: "Move to another menu" },
        link: { type: "string" },
        parentId: { type: "string" },
        published: { type: "string" },
        access: { type: "string" },
        language: { type: "string" },
        browserNav: { type: "string", description: "0=same window, 1=new window, 2=popup" },
        home: { type: "string" },
        note: { type: "string" },
        templateStyleId: { type: "string", description: "Gantry outline ID (0=site default)" },
        ordering: { type: "string", description: "Place after sibling with this ID. Use -1 for first." },
        request: { type: "object", additionalProperties: { type: "string" } },
        params: { type: "object", additionalProperties: { type: "string" } },
        fieldOverrides: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_delete_menu_item",
    description: "Trash a menu item by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Menu item ID" },
        menuType: { type: "string", description: "Menu type for post-delete verification" },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches" },
        expectedMenuType: { type: "string", description: "Safety check: refuse unless menu type matches" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_toggle_menu_item",
    description: "Publish (state=1) or unpublish (state=0) a menu item.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Menu item ID" },
        state: { type: "string", description: "1=publish, 0=unpublish", enum: ["0", "1"] },
        menuType: { type: "string" },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches" },
        expectedMenuType: { type: "string", description: "Safety check: refuse unless menu type matches" },
      },
      required: ["id", "state"],
    },
  },
  {
    name: "joomla_checkin_menu_item",
    description: "Check in a checked-out menu item.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Menu item ID" },
        menuType: { type: "string" },
        expectedTitle: { type: "string", description: "Safety check: refuse unless title matches" },
        expectedMenuType: { type: "string", description: "Safety check: refuse unless menu type matches" },
      },
      required: ["id"],
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
    description: "Inspect any admin edit form by path. Returns fields, options, hidden fields, token.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Admin path (e.g. index.php?option=com_content&task=article.add)" },
        formId: { type: "string", description: "Form ID to prefer (e.g. item-form)" },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_inspect_admin_list",
    description: "Inspect an admin list page. Returns filters, headers, row IDs, toolbar tasks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Admin path (e.g. index.php?option=com_content&view=articles)" },
        formId: { type: "string", description: "List form ID (default: adminForm)" },
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
    description: "Explore any admin component path in form or list mode.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        mode: { type: "string", enum: ["form", "list"] },
        formId: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_media_list",
    description: "List Media Manager folders and files.",
    inputSchema: { type: "object", properties: { folder: { type: "string" }, path: { type: "string" } } },
  },
  {
    name: "joomla_media_create_folder",
    description: "Create a Media Manager folder. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        folderName: { type: "string" },
        folderBase: { type: "string" },
        path: { type: "string" },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["folderName"],
    },
  },
  {
    name: "joomla_media_upload",
    description: "Upload a file to Media Manager via URL or base64. Use folder to target a subfolder (e.g. 'stories'). Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        fileUrl: { type: "string", description: "URL to download and upload." },
        base64Content: { type: "string", description: "Base64 file content. Requires fileName." },
        fileName: { type: "string", description: "Target filename. Required with base64Content; inferred from fileUrl if omitted." },
        folder: { type: "string", description: "Subfolder relative to image root (e.g. 'stories'). Omit for root." },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean", description: "Set true to upload." },
      },
      required: [],
    },
  },
  {
    name: "joomla_media_delete",
    description: "Delete a file or folder from Media Manager. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to media root (e.g. 'template/test/image.png')" },
        type: { type: "string", enum: ["file", "folder"], description: "Defaults to 'file'" },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["path"],
    },
  },
  {
    name: "joomla_media_rename",
    description: "Rename a Media Manager file. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Current path relative to media root" },
        newName: { type: "string", description: "New filename including extension" },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["path", "newName"],
    },
  },
  {
    name: "joomla_media_move",
    description: "Move a Media Manager file to another folder. Dry-run by default.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Current path relative to media root" },
        targetFolder: { type: "string", description: "Destination folder relative to media root. Empty string = root." },
        dryRun: { type: "boolean" },
        confirm: { type: "boolean" },
      },
      required: ["path", "targetFolder"],
    },
  },
  {
    name: "joomla_docman_list_documents",
    description: "List all DOCman documents with id, title, category, state, and storage path.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_docman_list_categories",
    description: "List all DOCman categories with id, title, parent, and state.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_docman_get_document",
    description: "Get a DOCman document by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_docman_get_category",
    description: "Get a DOCman category by ID.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID." },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_docman_create_document",
    description: "Create a DOCman document referencing an existing file in the storage folder.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        categoryId: { type: "string" },
        storagePath: { type: "string", description: "Relative path within DOCman files (e.g. 'bulletin/MyFile.pdf')" },
        storageType: { type: "string", description: "Defaults to 'file'" },
        description: { type: "string" },
        access: { type: "string", description: "1=Public, 2=Registered" },
        enabled: { type: "string", enum: ["0", "1"], description: "1=published (default)" },
      },
      required: ["title", "categoryId"],
    },
  },
  {
    name: "joomla_docman_create_category",
    description: "Create a DOCman category.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        parentId: { type: "string", description: "Omit for root-level" },
        description: { type: "string" },
        access: { type: "string", description: "1=Public, 2=Registered" },
        enabled: { type: "string", enum: ["0", "1"], description: "1=published (default)" },
      },
      required: ["title"],
    },
  },
  {
    name: "joomla_docman_update_document",
    description: "Update a DOCman document — title, category, file path, or state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        categoryId: { type: "string" },
        storagePath: { type: "string" },
        description: { type: "string" },
        access: { type: "string" },
        enabled: { type: "string", enum: ["0", "1"] },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_docman_update_category",
    description: "Update a DOCman category — title, parent, or state.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        parentId: { type: "string" },
        description: { type: "string" },
        access: { type: "string" },
        enabled: { type: "string", enum: ["0", "1"] },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_docman_delete_document",
    description: "Delete a DOCman document. Destructive — confirm with user first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Document ID to delete." },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_docman_delete_category",
    description: "Delete a DOCman category. Destructive — confirm with user first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID to delete." },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_fileman_list_files",
    description: "List FILEman files.",
    inputSchema: { type: "object", properties: {} },
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
  {
    name: "ftp_list_files",
    description: "List files on the FTP server at a path. Start at '/' to explore.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute remote path (e.g. '/' or '/wichita/cathedral')" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["path"],
    },
  },
  {
    name: "ftp_read_file",
    description: "Read a text file via FTP (max 200 KB). Use grep, head, or offset/limit to avoid bloating context.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute remote file path" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
        grep: { type: "string", description: "Regex to search for. Returns matching lines + context instead of full file." },
        context_lines: { type: "number", description: "Lines of context around each grep match (default: 2)" },
        head: { type: "number", description: "Return first N lines only" },
        offset: { type: "number", description: "Zero-based start line for pagination" },
        limit: { type: "number", description: "Lines to return from offset" },
      },
      required: ["path"],
    },
  },
  {
    name: "ftp_upload_file",
    description: "Upload text content to a file on the FTP server. Target path must be within upload_path if configured.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute remote destination path" },
        content: { type: "string", description: "Text content to write" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "ftp_delete_file",
    description: "Delete a file via FTP. Target path must be within upload_path if configured.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute remote file path to delete" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["path"],
    },
  },
  {
    name: "ftp_upload_local_file",
    description: "Upload a local file to the FTP server. Supports any file type including images and PDFs.",
    inputSchema: {
      type: "object",
      properties: {
        local_path: { type: "string", description: "Absolute local file path (e.g. C:/Users/Jeremy/Desktop/photo.png)" },
        path: { type: "string", description: "Absolute remote destination path" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["local_path", "path"],
    },
  },
  {
    name: "ftp_mkdir",
    description: "Create a directory on the FTP server (including intermediate directories).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Remote directory path to create" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["path"],
    },
  },
  {
    name: "ftp_site_config",
    description: "Show FTP config for a site: host, web_root, upload_path, pub_path, pub_url. Call before other FTP tools to verify the site is configured.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: [],
    },
  },

  // --- Freshdesk tools ---
  {
    name: "freshdesk_get_ticket",
    description: "Fetch a Freshdesk ticket. Returns subject, description, status, priority, tags, requester_id, company_id.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "number" },
      },
      required: ["ticket_id"],
    },
  },
  {
    name: "freshdesk_get_contact",
    description: "Fetch a Freshdesk contact by ID. Returns name, email, phone, company_id.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "number", description: "Use requester_id from ticket" },
      },
      required: ["contact_id"],
    },
  },
  {
    name: "freshdesk_get_company",
    description: "Fetch a Freshdesk company by ID. Returns name, domains, and derived site_url for joomla_login.",
    inputSchema: {
      type: "object",
      properties: {
        company_id: { type: "number" },
      },
      required: ["company_id"],
    },
  },
  {
    name: "freshdesk_get_conversations",
    description: "Fetch all replies and notes for a ticket in chronological order.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "number" },
      },
      required: ["ticket_id"],
    },
  },
  {
    name: "freshdesk_add_note",
    description: "Add a private internal note to a ticket. Server prepends '— Shannon (AI Assistant)' automatically.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "number" },
        body: { type: "string", description: "Note body (HTML supported). Describe what was checked and changed." },
      },
      required: ["ticket_id", "body"],
    },
  },
  {
    name: "freshdesk_list_tickets",
    description: "List tickets by status. Default: unresolved (open+pending+waiting). Returns 30/page.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "pending", "waiting", "resolved", "closed", "unresolved", "all"],
          description: "open=2, pending=3, waiting=6+7, resolved=4, closed=5, unresolved=default",
        },
        company_id: { type: "number" },
        page: { type: "number", description: "Default: 1, 30 per page" },
      },
      required: [],
    },
  },
  // ==================== USER MANAGEMENT ====================
  {
    name: "joomla_list_users",
    description: "List users. Use 'search' to filter by name or email, 'group_id' to filter by group.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Filter by name or email" },
        group_id: { type: "string", description: "Filter by user group ID" },
        state: { type: "string", enum: ["0", "1"], description: "0=enabled, 1=blocked" },
        limit: { type: "number", description: "Per page (default: 200, max: 500)" },
        page: { type: "number", description: "Page number, 1-based" },
      },
      required: [],
    },
  },
  {
    name: "joomla_get_user",
    description: "Get full user details by ID including groups.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_create_user",
    description: "Create a user. For teachers: include group 12 (Basic Editor) plus grade group.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Full display name" },
        username: { type: "string", description: "Login username (typically email)" },
        email: { type: "string" },
        password: { type: "string" },
        groups: {
          type: "array",
          items: { type: "string" },
          description: "Group IDs. Grade groups: 15=1st, 16=2nd, 17=3rd, 18=4th, 19=5th, 20=6th, 33=7th, 23=8th, 14=Kinder, 26=Pre-K, 12=Basic Editor.",
        },
        block: { type: "boolean", description: "true=create as blocked (default: false)" },
      },
      required: ["name", "username", "email", "password", "groups"],
    },
  },
  {
    name: "joomla_update_user",
    description: "Update a user. Omit password to keep existing. 'groups' replaces all assigned groups.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        username: { type: "string" },
        email: { type: "string" },
        password: { type: "string", description: "Omit to keep existing" },
        block: { type: "boolean", description: "true=block, false=enable" },
        groups: {
          type: "array",
          items: { type: "string" },
          description: "Full replacement group list. Grade groups: 15=1st, 16=2nd, 17=3rd, 18=4th, 19=5th, 20=6th, 33=7th, 23=8th, 14=Kinder, 26=Pre-K, 12=Basic Editor.",
        },
      },
      required: ["id"],
    },
  },
  // ==================== GROUPS ====================
  {
    name: "joomla_list_groups",
    description: "List all user groups with IDs, names, depth, and user counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "joomla_create_group",
    description: "Create a user group.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        parent_id: { type: "string", description: "Parent group ID. Omit for root level." },
      },
      required: ["title"],
    },
  },
  {
    name: "joomla_delete_group",
    description: "Delete a user group. ACL rules are removed; users are not deleted.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Group ID to delete" },
      },
      required: ["id"],
    },
  },
  // ==================== PERMISSIONS ====================
  {
    name: "joomla_get_category_permissions",
    description: "Read ACL rules for a category. Returns group → action → value map (''=Inherit, '1'=Allow, '0'=Deny).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID" },
        extension: { type: "string", description: "Default: com_content" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_set_category_permissions",
    description: "Update ACL rules on a category. Only provided group/action pairs are changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Category ID" },
        rules: {
          type: "object",
          description: "{ \"<groupId>\": { \"core.edit\": \"1\" } }. ''=Inherit, '1'=Allow, '0'=Deny.",
          additionalProperties: {
            type: "object",
            additionalProperties: { type: "string", enum: ["", "0", "1"] },
          },
        },
        extension: { type: "string", description: "Default: com_content" },
      },
      required: ["id", "rules"],
    },
  },
  {
    name: "joomla_get_article_permissions",
    description: "Read ACL rules for an article. Most articles inherit from category — only returns data when article-level overrides exist.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Article ID" },
      },
      required: ["id"],
    },
  },
  {
    name: "joomla_set_article_permissions",
    description: "Update ACL rules on an article. Only provided group/action pairs are changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        rules: {
          type: "object",
          description: "{ \"<groupId>\": { \"core.edit\": \"1\" } }. ''=Inherit, '1'=Allow, '0'=Deny.",
          additionalProperties: {
            type: "object",
            additionalProperties: { type: "string", enum: ["", "0", "1"] },
          },
        },
      },
      required: ["id", "rules"],
    },
  },
  {
    name: "freshdesk_update_ticket",
    description: "Update ticket status, priority, or tags. Confirm with user before changing status.",
    inputSchema: {
      type: "object",
      properties: {
        ticket_id: { type: "number" },
        status: { type: "number", enum: [2, 3, 4, 5], description: "2=Open, 3=Pending, 4=Resolved, 5=Closed" },
        priority: { type: "number", enum: [1, 2, 3, 4], description: "1=Low, 2=Medium, 3=High, 4=Urgent" },
        tags: { type: "array", items: { type: "string" }, description: "Replaces full tag list" },
      },
      required: ["ticket_id"],
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

  try {
    switch (name) {
      case "joomla_login": {
        const siteUrl = args?.site_url as string | undefined;
        if (siteUrl) {
          joomla.switchSite(siteUrl);
          isLoggedIn = false;
        }
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

      case "joomla_list_categories": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listCategories(
          args?.extension as string,
          (args?.limit as number) || undefined,
          (args?.page as number) || undefined,
          (args?.search as string) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_get_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.getCategory(
          (args?.id as string) || undefined,
          (args?.title as string) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        if (!title) return { content: [{ type: "text", text: "Error: title is required" }], isError: true };

        const result = await joomla.createCategory({
          title,
          alias: args?.alias as string,
          parentId: args?.parentId as string,
          description: args?.description as string,
          published: args?.published as string,
          extension: args?.extension as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_update_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.updateCategory(id, {
          title: args?.title as string,
          alias: args?.alias as string,
          parentId: args?.parentId as string,
          description: args?.description as string,
          published: args?.published as string,
          ordering: args?.ordering as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_delete_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.deleteCategory(id, {
          expectedTitle: args?.expectedTitle as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_checkin_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.checkInCategory(id, {
          expectedTitle: args?.expectedTitle as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_modules": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listModules(
          args?.client_id as string,
          (args?.search as string) || undefined,
          (args?.limit as number) || undefined,
          (args?.page as number) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_module_types": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listModuleTypes(args?.client_id as string);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_module_positions": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listModulePositions(args?.client_id as string);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_inspect_module_type": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const moduleType = args?.moduleType as string;
        if (!moduleType) return { content: [{ type: "text", text: "Error: moduleType is required" }], isError: true };

        const result = await joomla.inspectModuleType(moduleType, args?.client_id as string);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_get_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.getModule(
          (args?.id as string) || undefined,
          (args?.title as string) || undefined,
          (args?.client_id as string) || "0",
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_update_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.updateModule(id, {
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
          params: args?.params as Record<string, string>,
          advanced: args?.advanced as Record<string, string>,
          fieldOverrides: args?.fieldOverrides as Record<string, string>,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        const moduleType = args?.moduleType as string;
        if (!title || !moduleType)
          return { content: [{ type: "text", text: "Error: title and moduleType are required" }], isError: true };

        const result = await joomla.createModule({
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
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_delete_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.deleteModule(id, {
          clientId: args?.client_id as string,
          expectedTitle: args?.expectedTitle as string,
          expectedModuleType: args?.expectedModuleType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_checkin_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.checkInModule(id, {
          expectedTitle: args?.expectedTitle as string,
          expectedModuleType: args?.expectedModuleType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_toggle_module": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        const state = args?.state as string;
        if (!id || !state)
          return { content: [{ type: "text", text: "Error: id and state are required" }], isError: true };

        const result = await joomla.toggleModule(id, state, {
          expectedTitle: args?.expectedTitle as string,
          expectedModuleType: args?.expectedModuleType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_menus": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listMenus();
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_menu": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        if (!title) return { content: [{ type: "text", text: "Error: title is required" }], isError: true };

        const result = await joomla.createMenu({
          title,
          menuType: args?.menuType as string,
          description: args?.description as string,
          cssClasses: args?.cssClasses as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_menu_items": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const menuId = args?.menuId as string;
        if (!menuId) return { content: [{ type: "text", text: "Error: menuId is required" }], isError: true };

        const result = await joomla.listMenuItems(
          menuId,
          (args?.search as string) || undefined,
          (args?.limit as number) || undefined,
          (args?.page as number) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_list_menu_item_types": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.listMenuItemTypes();
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_inspect_menu_item_type": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const itemType = args?.itemType as string;
        if (!itemType) return { content: [{ type: "text", text: "Error: itemType is required" }], isError: true };

        const result = await joomla.inspectMenuItemType(itemType);
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_get_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const result = await joomla.getMenuItem(
          (args?.id as string) || undefined,
          (args?.title as string) || undefined,
          (args?.menuId as string) || undefined,
        );
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_create_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const title = args?.title as string;
        const menuType = args?.menuType as string;
        const itemType = args?.itemType as string;
        if (!title || !menuType || !itemType)
          return { content: [{ type: "text", text: "Error: title, menuType, and itemType are required" }], isError: true };

        const result = await joomla.createMenuItem({
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
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_update_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.updateMenuItem(id, {
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
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_delete_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.deleteMenuItem(id, {
          menuType: args?.menuType as string,
          expectedTitle: args?.expectedTitle as string,
          expectedMenuType: args?.expectedMenuType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_toggle_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        const state = args?.state as string;
        if (!id || !state) return { content: [{ type: "text", text: "Error: id and state are required" }], isError: true };

        const result = await joomla.toggleMenuItem(id, state, args?.menuType as string, {
          expectedTitle: args?.expectedTitle as string,
          expectedMenuType: args?.expectedMenuType as string,
        });
        return {
          content: [{ type: "text", text: formatResult(result) }],
          isError: !result.success,
        };
      }

      case "joomla_checkin_menu_item": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };

        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };

        const result = await joomla.checkInMenuItem(id, args?.menuType as string, {
          expectedTitle: args?.expectedTitle as string,
          expectedMenuType: args?.expectedMenuType as string,
        });
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
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_inspect_admin_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.inspectAdminList(path, (args?.formId as string) || "adminForm");
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
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media_list": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.mediaList((args?.path as string) || (args?.folder as string) || "index.php?option=com_media");
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media_create_folder": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const folderName = args?.folderName as string;
        if (!folderName) return { content: [{ type: "text", text: "Error: folderName is required" }], isError: true };
        const result = await joomla.createMediaFolder({
          folderName,
          folderBase: args?.folderBase as string,
          path: args?.path as string,
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media_upload": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.uploadMediaFile({
          fileUrl: args?.fileUrl as string,
          base64Content: args?.base64Content as string,
          fileName: args?.fileName as string,
          folder: args?.folder as string,
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media_delete": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        const result = await joomla.deleteMedia({
          path,
          type: args?.type as "file" | "folder",
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media_rename": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        const newName = args?.newName as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        if (!newName) return { content: [{ type: "text", text: "Error: newName is required" }], isError: true };
        const result = await joomla.renameMediaFile({
          path,
          newName,
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_media_move": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const path = args?.path as string;
        const targetFolder = args?.targetFolder as string;
        if (!path) return { content: [{ type: "text", text: "Error: path is required" }], isError: true };
        if (targetFolder === undefined) return { content: [{ type: "text", text: "Error: targetFolder is required" }], isError: true };
        const result = await joomla.moveMediaFile({
          path,
          targetFolder,
          dryRun: args?.dryRun as boolean,
          confirm: args?.confirm as boolean,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_list_documents": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listDocmanDocuments();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_list_categories": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listDocmanCategories();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_get_document": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.getDocmanDocument(String(args?.id));
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_get_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.getDocmanCategory(String(args?.id));
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_create_document": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.createDocmanDocument({
          title: String(args?.title),
          categoryId: String(args?.categoryId),
          storagePath: args?.storagePath !== undefined ? String(args.storagePath) : undefined,
          storageType: args?.storageType !== undefined ? String(args.storageType) : undefined,
          description: args?.description !== undefined ? String(args.description) : undefined,
          access: args?.access !== undefined ? String(args.access) : undefined,
          enabled: args?.enabled !== undefined ? String(args.enabled) : undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_create_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.createDocmanCategory({
          title: String(args?.title),
          parentId: args?.parentId !== undefined ? String(args.parentId) : undefined,
          description: args?.description !== undefined ? String(args.description) : undefined,
          access: args?.access !== undefined ? String(args.access) : undefined,
          enabled: args?.enabled !== undefined ? String(args.enabled) : undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_update_document": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.updateDocmanDocument(String(args?.id), {
          title: args?.title !== undefined ? String(args.title) : undefined,
          categoryId: args?.categoryId !== undefined ? String(args.categoryId) : undefined,
          storagePath: args?.storagePath !== undefined ? String(args.storagePath) : undefined,
          description: args?.description !== undefined ? String(args.description) : undefined,
          access: args?.access !== undefined ? String(args.access) : undefined,
          enabled: args?.enabled !== undefined ? String(args.enabled) : undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_update_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.updateDocmanCategory(String(args?.id), {
          title: args?.title !== undefined ? String(args.title) : undefined,
          parentId: args?.parentId !== undefined ? String(args.parentId) : undefined,
          description: args?.description !== undefined ? String(args.description) : undefined,
          access: args?.access !== undefined ? String(args.access) : undefined,
          enabled: args?.enabled !== undefined ? String(args.enabled) : undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_delete_document": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.deleteDocmanDocument(String(args?.id));
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_docman_delete_category": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.deleteDocmanCategory(String(args?.id));
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_fileman_list_files": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listFilemanFiles();
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

      case "ftp_list_files": {
        const ftpPath = (args?.path as string) || "/";
        const domain = (args?.domain as string) || FtpClient.domainFromUrl(joomla.getConfig().baseUrl);
        const result = await ftpClient.listFiles(ftpPath, domain);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "ftp_read_file": {
        const ftpPath = args?.path as string;
        const domain = (args?.domain as string) || FtpClient.domainFromUrl(joomla.getConfig().baseUrl);
        const result = await ftpClient.readTextFile(ftpPath, domain, {
          grep: args?.grep as string | undefined,
          contextLines: args?.context_lines as number | undefined,
          head: args?.head as number | undefined,
          offset: args?.offset as number | undefined,
          limit: args?.limit as number | undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "ftp_upload_file": {
        const ftpPath = args?.path as string;
        const content = (args?.content as string) || "";
        const domain = (args?.domain as string) || FtpClient.domainFromUrl(joomla.getConfig().baseUrl);
        const result = await ftpClient.uploadFile(ftpPath, content, domain);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "ftp_delete_file": {
        const ftpPath = args?.path as string;
        const domain = (args?.domain as string) || FtpClient.domainFromUrl(joomla.getConfig().baseUrl);
        const result = await ftpClient.deleteFile(ftpPath, domain);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "ftp_upload_local_file": {
        const localPath = args?.local_path as string;
        const ftpPath = args?.path as string;
        const domain = (args?.domain as string) || FtpClient.domainFromUrl(joomla.getConfig().baseUrl);
        const result = await ftpClient.uploadLocalFile(localPath, ftpPath, domain);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "ftp_mkdir": {
        const ftpPath = args?.path as string;
        const domain = (args?.domain as string) || FtpClient.domainFromUrl(joomla.getConfig().baseUrl);
        const result = await ftpClient.makeDirectory(ftpPath, domain);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "ftp_site_config": {
        const domain = (args?.domain as string) || FtpClient.domainFromUrl(joomla.getConfig().baseUrl);
        const result = ftpClient.getSiteInfo(domain);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      // --- Freshdesk cases ---
      case "freshdesk_get_ticket": {
        if (!freshdesk) return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "Freshdesk not configured: set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env" }) }], isError: true };
        const ticketId = args?.ticket_id as number | undefined;
        if (!ticketId) return { content: [{ type: "text", text: "Error: ticket_id is required" }], isError: true };
        const result = await freshdesk.getTicket(ticketId);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "freshdesk_get_contact": {
        if (!freshdesk) return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "Freshdesk not configured: set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env" }) }], isError: true };
        const contactId = args?.contact_id as number | undefined;
        if (!contactId) return { content: [{ type: "text", text: "Error: contact_id is required" }], isError: true };
        const result = await freshdesk.getContact(contactId);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "freshdesk_get_company": {
        if (!freshdesk) return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "Freshdesk not configured: set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env" }) }], isError: true };
        const companyId = args?.company_id as number | undefined;
        if (!companyId) return { content: [{ type: "text", text: "Error: company_id is required" }], isError: true };
        const result = await freshdesk.getCompany(companyId);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "freshdesk_get_conversations": {
        if (!freshdesk) return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "Freshdesk not configured: set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env" }) }], isError: true };
        const ticketId = args?.ticket_id as number | undefined;
        if (!ticketId) return { content: [{ type: "text", text: "Error: ticket_id is required" }], isError: true };
        const result = await freshdesk.getConversations(ticketId);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "freshdesk_add_note": {
        if (!freshdesk) return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "Freshdesk not configured: set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env" }) }], isError: true };
        const ticketId = args?.ticket_id as number | undefined;
        const body = args?.body as string | undefined;
        if (!ticketId || !body) return { content: [{ type: "text", text: "Error: ticket_id and body are required" }], isError: true };
        const taggedBody = `<p>— Shannon (AI Assistant)</p>${body}`;
        const result = await freshdesk.addNote(ticketId, taggedBody, true);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "freshdesk_list_tickets": {
        if (!freshdesk) return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "Freshdesk not configured: set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env" }) }], isError: true };
        const result = await freshdesk.listTickets({
          status: args?.status as "open" | "pending" | "waiting" | "resolved" | "closed" | "unresolved" | "all" | undefined,
          company_id: args?.company_id as number | undefined,
          page: args?.page as number | undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "freshdesk_update_ticket": {
        if (!freshdesk) return { content: [{ type: "text", text: JSON.stringify({ success: false, message: "Freshdesk not configured: set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env" }) }], isError: true };
        const ticketId = args?.ticket_id as number | undefined;
        if (!ticketId) return { content: [{ type: "text", text: "Error: ticket_id is required" }], isError: true };
        const result = await freshdesk.updateTicket(ticketId, {
          status: args?.status as number | undefined,
          priority: args?.priority as number | undefined,
          tags: args?.tags as string[] | undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      // ==================== USER MANAGEMENT ====================

      case "joomla_list_users": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listUsers(
          args?.search as string | undefined,
          args?.group_id as string | undefined,
          args?.state as string | undefined,
          args?.limit as number | undefined,
          args?.page as number | undefined,
        );
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_get_user": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };
        const result = await joomla.getUser(id);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_create_user": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const name = args?.name as string;
        const username = args?.username as string;
        const email = args?.email as string;
        const password = args?.password as string;
        const groups = args?.groups as string[];
        if (!name || !username || !email || !password || !groups?.length) {
          return { content: [{ type: "text", text: "Error: name, username, email, password, and groups are required" }], isError: true };
        }
        const result = await joomla.createUser({ name, username, email, password, groups, block: args?.block as boolean | undefined });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_update_user": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };
        const result = await joomla.updateUser(id, {
          name: args?.name as string | undefined,
          username: args?.username as string | undefined,
          email: args?.email as string | undefined,
          password: args?.password as string | undefined,
          block: args?.block as boolean | undefined,
          groups: args?.groups as string[] | undefined,
        });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      // ==================== GROUPS ====================

      case "joomla_list_groups": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const result = await joomla.listGroups();
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_create_group": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const title = args?.title as string;
        if (!title) return { content: [{ type: "text", text: "Error: title is required" }], isError: true };
        const result = await joomla.createGroup({ title, parentId: args?.parent_id as string | undefined });
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_delete_group": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };
        const result = await joomla.deleteGroup(id);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      // ==================== PERMISSIONS ====================

      case "joomla_get_category_permissions": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };
        const result = await joomla.getCategoryPermissions(id, args?.extension as string | undefined);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_set_category_permissions": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const id = args?.id as string;
        const rules = args?.rules as Record<string, Record<string, string>>;
        if (!id || !rules) return { content: [{ type: "text", text: "Error: id and rules are required" }], isError: true };
        const result = await joomla.setCategoryPermissions(id, rules, args?.extension as string | undefined);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_get_article_permissions": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const id = args?.id as string;
        if (!id) return { content: [{ type: "text", text: "Error: id is required" }], isError: true };
        const result = await joomla.getArticlePermissions(id);
        return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
      }

      case "joomla_set_article_permissions": {
        const login = await ensureLoggedIn();
        if (!login.success) return { content: [{ type: "text", text: formatResult(login) }], isError: true };
        const id = args?.id as string;
        const rules = args?.rules as Record<string, Record<string, string>>;
        if (!id || !rules) return { content: [{ type: "text", text: "Error: id and rules are required" }], isError: true };
        const result = await joomla.setArticlePermissions(id, rules);
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

async function startHttp(port: number): Promise<void> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);

    const urlPath = reqUrl.pathname;
    if (urlPath !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      const joomlaClient = new JoomlaClient(config);
      const mcpServer = buildServer(joomlaClient);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, transport!);
        },
      });
      await mcpServer.connect(transport);
    }

    let body: unknown;
    if (req.method === "POST") {
      body = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk: Buffer) => (data += chunk.toString()));
        req.on("end", () => {
          try { resolve(JSON.parse(data)); } catch { resolve(undefined); }
        });
        req.on("error", reject);
      });
    }

    await transport.handleRequest(req, res, body);
    if (req.method === "DELETE" && sessionId) {
      sessions.delete(sessionId);
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.error(`Joomla MCP Server running on HTTP port ${port}`);
}

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  const rawPort = process.env.HTTP_PORT || process.env.PORT;
  const httpPort = rawPort ? parseInt(rawPort, 10) : null;

  if (httpPort) {
    await startHttp(httpPort);
  } else {
    const joomlaClient = new JoomlaClient(config);
    const mcpServer = buildServer(joomlaClient);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("Joomla MCP Server running on stdio");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
