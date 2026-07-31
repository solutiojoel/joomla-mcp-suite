/**
 * Menu item tool audit — counts HTTP requests, payload size, and wall time per operation.
 *
 *   npx tsx scripts/tests/menu-audit.ts
 *
 * Set AUDIT_MENU to target a menu other than mainmenu.
 */
import "../../src/env.js";
import { JoomlaClient } from "../../src/joomla-client.js";

const BASE = process.env.JOOMLA_BASE_URL || "";

// ---- instrument fetch so every outbound admin request is counted ----
let reqLog: Array<{ method: string; url: string; ms: number; status: number; bytes: number }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const t = Date.now();
  const res = await realFetch(input as never, init as never);
  const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
  const clone = res.clone();
  const body = await clone.text();
  reqLog.push({
    method: (init?.method as string) || "GET",
    url: String(url).replace(BASE, "").slice(0, 110),
    ms: Date.now() - t,
    status: res.status,
    bytes: body.length,
  });
  return res;
}) as typeof fetch;

const results: Array<Record<string, unknown>> = [];

async function bench(name: string, fn: () => Promise<{ success?: boolean; message?: string; data?: unknown }>) {
  reqLog = [];
  const t = Date.now();
  let out: { success?: boolean; message?: string; data?: unknown } | undefined;
  let err: string | null = null;
  try {
    out = await fn();
  } catch (e) {
    err = (e as Error).message;
  }
  const ms = Date.now() - t;
  const bytes = reqLog.reduce((a, r) => a + r.bytes, 0);
  results.push({
    op: name,
    ms,
    reqs: reqLog.length,
    kb: Math.round(bytes / 1024),
    ok: err ? "ERR" : String(out?.success),
  });
  console.log(
    `\n### ${name}\n  time=${ms}ms  requests=${reqLog.length}  payload=${Math.round(bytes / 1024)}KB  ok=${err ? "ERR" : out?.success}`
  );
  console.log(`  msg: ${err ?? String(out?.message ?? "").slice(0, 120)}`);
  for (const r of reqLog) {
    console.log(
      `    ${r.method.padEnd(4)} ${String(r.status).padEnd(3)} ${String(r.ms).padStart(5)}ms ${String(
        Math.round(r.bytes / 1024)
      ).padStart(4)}KB  ${r.url}`
    );
  }
  return out;
}

async function main() {
  const client = new JoomlaClient({
    baseUrl: BASE,
    username: process.env.JOOMLA_USERNAME || "",
    password: process.env.JOOMLA_PASSWORD || "",
  });

  const MENU = process.env.AUDIT_MENU || "mainmenu";
  const STAMP = Date.now().toString().slice(-6);

  await bench("login", () => client.login());

  const listed = await bench("list (all menus)", () => client.listMenuItems());
  await bench("list (one menu, limit 20)", () => client.listMenuItems(MENU, undefined, 20, 1));
  await bench("list (search)", () => client.listMenuItems(MENU, "Home"));
  await bench("type list (cold)", () => client.listMenuItemTypes());
  await bench("type list (warm)", () => client.listMenuItemTypes());
  await bench("type inspect (single article)", () => client.inspectMenuItemType("com_content.article"));

  const items = (listed?.data || []) as Array<Record<string, string>>;
  const sample = items[0];
  if (sample) {
    await bench(`get id=${sample.id}`, () => client.getMenuItem(sample.id));
    await bench(`get id=${sample.id} (repeat)`, () => client.getMenuItem(sample.id));
    await bench(`get by title "${sample.title}"`, () => client.getMenuItem(undefined, sample.title, MENU));
  }

  const created = await bench("create (separator)", () =>
    client.createMenuItem({ title: `ZZ Audit Sep ${STAMP}`, menuType: MENU, itemType: "separator" })
  );
  const newId = String((created?.data as Record<string, unknown>)?.id ?? "");

  const createdUrl = await bench("create (external url)", () =>
    client.createMenuItem({
      title: `ZZ Audit Url ${STAMP}`,
      menuType: MENU,
      itemType: "url",
      link: "https://example.com",
    })
  );
  const urlId = String((createdUrl?.data as Record<string, unknown>)?.id ?? "");

  if (newId) {
    await bench(`update title id=${newId}`, () =>
      client.updateMenuItem(newId, { title: `ZZ Audit Sep ${STAMP} v2`, menuType: MENU })
    );
    await bench(`toggle unpublish id=${newId}`, () => client.toggleMenuItem(newId, "0", MENU));
    await bench(`toggle publish id=${newId}`, () => client.toggleMenuItem(newId, "1", MENU));
    await bench(`checkin id=${newId}`, () => client.checkInMenuItem(newId, MENU));
    await bench(`delete id=${newId}`, () => client.deleteMenuItem(newId, { menuType: MENU }));
  }
  if (urlId) {
    await bench(`delete id=${urlId}`, () => client.deleteMenuItem(urlId, { menuType: MENU }));
  }

  console.log("\n\n===== SUMMARY =====");
  console.table(results);
  const total = results.reduce((a, r) => a + (r.ms as number), 0);
  console.log(`TOTAL: ${total}ms across ${results.length} ops`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
