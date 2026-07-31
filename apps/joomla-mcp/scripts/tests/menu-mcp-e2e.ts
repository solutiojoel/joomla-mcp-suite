/**
 * End-to-end menu item test through the real local MCP server over stdio.
 *
 *   npx tsx scripts/tests/menu-mcp-e2e.ts
 *
 * Exercises every joomla_menu_item / joomla_menu_item_type action as a client would,
 * so tool routing in index.ts is covered as well as the client. Times each call.
 */
import "../../src/env.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const MENU = process.env.AUDIT_MENU || "mainmenu";
const STAMP = Date.now().toString().slice(-6);

let pass = 0;
const failures: string[] = [];
const timings: Array<Record<string, unknown>> = [];

function checkTrue(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  const serverPath = path.resolve(__dirname, "..", "..", "src", "index.ts");
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["tsx", serverPath],
    env: process.env as Record<string, string>,
  });
  const client = new Client({ name: "menu-e2e", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  checkTrue("server exposes joomla_menu_item", names.includes("joomla_menu_item"));
  checkTrue("server exposes joomla_menu_item_type", names.includes("joomla_menu_item_type"));

  async function call(label: string, name: string, args: Record<string, unknown>) {
    const t = Date.now();
    const res = await client.callTool({ name, arguments: args });
    const ms = Date.now() - t;
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "")
      .join("\n");
    timings.push({ op: label, ms, isError: !!res.isError });
    console.log(`  [${String(ms).padStart(5)}ms] ${label}${res.isError ? "  <ERROR>" : ""}`);
    return { text, isError: !!res.isError };
  }

  console.log("\n[list / discovery]");
  const list = await call("list all", "joomla_menu_item", { action: "list" });
  checkTrue("list succeeds", !list.isError);
  const listOne = await call("list one menu", "joomla_menu_item", { action: "list", menuId: MENU, limit: 20 });
  checkTrue("scoped list succeeds", !listOne.isError);
  const types = await call("type list", "joomla_menu_item_type", { action: "list" });
  checkTrue("type list succeeds", !types.isError);
  const inspect = await call("type inspect", "joomla_menu_item_type", { action: "inspect", itemType: "com_content.article" });
  checkTrue("type inspect succeeds", !inspect.isError);

  console.log("\n[create]");
  const create = await call("create", "joomla_menu_item", {
    action: "create",
    title: `ZZ E2E ${STAMP}`,
    menuType: MENU,
    itemType: "url",
    link: "https://example.com/e2e",
  });
  checkTrue("create succeeds", !create.isError, create.text.slice(0, 160));
  const id = create.text.match(/"id":\s*"(\d+)"/)?.[1] ?? create.text.match(/\bid[:=]\s*"?(\d+)/)?.[1] ?? "";
  checkTrue("create returned an id", /^\d+$/.test(id), `parsed "${id}"`);

  console.log("\n[read / write]");
  const get = await call("get", "joomla_menu_item", { action: "get", id });
  checkTrue("get succeeds", !get.isError);
  checkTrue("get returns the created title", get.text.includes(`ZZ E2E ${STAMP}`));

  const update = await call("update", "joomla_menu_item", {
    action: "update", id, title: `ZZ E2E ${STAMP} v2`, note: "e2e", menuType: MENU,
  });
  checkTrue("update succeeds", !update.isError, update.text.slice(0, 160));

  const getAfter = await call("get after update", "joomla_menu_item", { action: "get", id });
  checkTrue("update persisted", getAfter.text.includes(`ZZ E2E ${STAMP} v2`));

  const off = await call("toggle off", "joomla_menu_item", { action: "toggle", id, state: "0", menuType: MENU });
  checkTrue("toggle off succeeds", !off.isError, off.text.slice(0, 160));
  const on = await call("toggle on", "joomla_menu_item", { action: "toggle", id, state: "1", menuType: MENU });
  checkTrue("toggle on succeeds", !on.isError, on.text.slice(0, 160));

  const checkin = await call("checkin", "joomla_menu_item", { action: "checkin", id, menuType: MENU });
  checkTrue("checkin succeeds", !checkin.isError, checkin.text.slice(0, 160));

  console.log("\n[guards and errors]");
  const guard = await call("delete w/ wrong title", "joomla_menu_item", {
    action: "delete", id, expectedTitle: "Not The Title",
  });
  checkTrue("delete refuses a mismatched expectedTitle", guard.isError);
  const bad = await call("unknown action", "joomla_menu_item", { action: "nope" });
  checkTrue("unknown action is rejected", bad.isError);
  const noId = await call("update without id", "joomla_menu_item", { action: "update" });
  checkTrue("update without id is rejected", noId.isError);

  console.log("\n[delete]");
  const del = await call("delete", "joomla_menu_item", { action: "delete", id, menuType: MENU });
  checkTrue("delete succeeds", !del.isError, del.text.slice(0, 160));
  // The list message echoes the search term, so assert on the row count, not the text.
  const gone = await call("list after delete", "joomla_menu_item", { action: "list", menuId: MENU, search: `ZZ E2E ${STAMP}` });
  checkTrue("deleted item no longer listed", /Found 0 menu items/.test(gone.text), gone.text.slice(0, 200));

  await client.close();

  console.log("\n===== MCP call timings =====");
  console.table(timings);
  console.log(`\n===== ${pass} passed, ${failures.length} failed =====`);
  for (const f of failures) console.log(`  FAILED: ${f}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
