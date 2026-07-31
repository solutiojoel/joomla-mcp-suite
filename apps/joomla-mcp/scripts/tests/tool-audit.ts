/**
 * Cross-tool audit — request count, payload, and wall time per operation.
 * Same instrumentation as menu-audit.ts, widened to articles, categories,
 * modules and users.
 *
 *   npx tsx scripts/tests/tool-audit.ts
 */
import "../../src/env.js";
import { JoomlaClient } from "../../src/joomla-client.js";

const BASE = process.env.JOOMLA_BASE_URL || "";

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
    url: String(url).replace(BASE, "").slice(0, 120),
    ms: Date.now() - t,
    status: res.status,
    bytes: body.length,
  });
  return res;
}) as typeof fetch;

const results: Array<Record<string, unknown>> = [];
const VERBOSE = process.env.AUDIT_VERBOSE === "1";

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
  const net = reqLog.reduce((a, r) => a + r.ms, 0);
  const bytes = reqLog.reduce((a, r) => a + r.bytes, 0);
  results.push({
    op: name,
    ms,
    net,
    parse: ms - net,
    reqs: reqLog.length,
    kb: Math.round(bytes / 1024),
    ok: err ? "ERR" : String(out?.success),
  });
  console.log(`  ${String(ms).padStart(5)}ms (net ${String(net).padStart(5)}ms / parse ${String(ms - net).padStart(5)}ms)  ${String(reqLog.length).padStart(2)} reqs  ${String(Math.round(bytes / 1024)).padStart(4)}KB  ${err ? "ERR" : out?.success}  ${name}`);
  if (VERBOSE) for (const r of reqLog) console.log(`        ${r.method.padEnd(4)} ${r.status} ${String(r.ms).padStart(5)}ms ${String(Math.round(r.bytes / 1024)).padStart(4)}KB ${r.url}`);
  return out;
}

async function main() {
  const j = new JoomlaClient({
    baseUrl: BASE,
    username: process.env.JOOMLA_USERNAME || "",
    password: process.env.JOOMLA_PASSWORD || "",
  });
  const S = Date.now().toString().slice(-6);
  await bench("login", () => j.login());

  console.log("\n--- articles ---");
  const arts = await bench("article list", () => j.listArticles(undefined, undefined, 20, 1));
  const artSample = ((arts?.data || []) as Array<Record<string, string>>)[0];
  if (artSample) await bench(`article get (id=${artSample.id})`, () => j.getArticle(artSample.id));
  // createArticle requires categoryId — verification compares it, so omitting it makes
  // every create report unverified.
  const catForArticle = artSample?.categoryId || "2";
  const a = await bench("article create", () =>
    j.createArticle({ title: `ZZ Audit Art ${S}`, categoryId: catForArticle, articletext: "<p>x</p>" })
  );
  const aId = String((a?.data as Record<string, string>)?.id || "");
  if (aId) {
    await bench("article update", () => j.updateArticle(aId, { title: `ZZ Audit Art ${S} v2` }));
    await bench("article checkin", () => j.checkInArticle(aId));
    await bench("article delete", () => j.deleteArticle(aId));
  }

  console.log("\n--- categories ---");
  const cats = await bench("category list", () => j.listCategories("com_content", 20, 1));
  const catSample = ((cats?.data || []) as Array<Record<string, string>>)[0];
  if (catSample) await bench(`category get (id=${catSample.id})`, () => j.getCategory(catSample.id));
  const c = await bench("category create", () => j.createCategory({ title: `ZZ Audit Cat ${S}` }));
  const cId = String((c?.data as Record<string, string>)?.id || "");
  if (cId) {
    await bench("category update", () => j.updateCategory(cId, { title: `ZZ Audit Cat ${S} v2` }));
    await bench("category checkin", () => j.checkInCategory(cId));
    await bench("category delete", () => j.deleteCategory(cId));
  }

  console.log("\n--- modules ---");
  const mods = await bench("module list", () => j.listModules("0", undefined, 20, 1));
  const modSample = ((mods?.data || []) as Array<Record<string, string>>)[0];
  if (modSample) await bench(`module get (id=${modSample.id})`, () => j.getModule(modSample.id));
  await bench("module types list", () => j.listModuleTypes("0"));
  const m = await bench("module create", () =>
    j.createModule({ title: `ZZ Audit Mod ${S}`, moduleType: "mod_custom", position: "sidebar-a", content: "<p>x</p>" })
  );
  const mId = String((m?.data as Record<string, string>)?.id || "");
  if (mId) {
    await bench("module update", () => j.updateModule(mId, { title: `ZZ Audit Mod ${S} v2` }));
    await bench("module toggle off", () => j.toggleModule(mId, "0"));
    await bench("module toggle on", () => j.toggleModule(mId, "1"));
    await bench("module checkin", () => j.checkInModule(mId));
    await bench("module delete", () => j.deleteModule(mId));
  }

  console.log("\n--- users ---");
  const users = await bench("user list", () => j.listUsers(undefined, undefined, undefined, 20, 1));
  const userSample = ((users?.data || []) as Array<Record<string, string>>)[0];
  if (userSample) await bench(`user get (id=${userSample.id})`, () => j.getUser(String(userSample.id)));
  await bench("group list", () => j.listGroups());

  console.log("\n===== SUMMARY =====");
  console.table(results);
  const total = results.reduce((a, r) => a + (r.ms as number), 0);
  const net = results.reduce((a, r) => a + (r.net as number), 0);
  const reqs = results.reduce((a, r) => a + (r.reqs as number), 0);
  console.log(`TOTAL ${total}ms  (net ${net}ms, parse ${total - net}ms)  ${reqs} requests across ${results.length} ops`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
