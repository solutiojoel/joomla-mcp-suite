/**
 * Regression check for tools that share the code the menu item work touched
 * (postPage, parseAdminForms). Article, category, and module round trips.
 *
 *   npx tsx scripts/tests/adjacent-tools-check.ts
 */
import "../../src/env.js";
import { JoomlaClient } from "../../src/joomla-client.js";

const cfg = {
  baseUrl: process.env.JOOMLA_BASE_URL || "",
  username: process.env.JOOMLA_USERNAME || "",
  password: process.env.JOOMLA_PASSWORD || "",
};

const STAMP = Date.now().toString().slice(-6);
let pass = 0;
const failures: string[] = [];

function checkTrue(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const out = await fn();
  console.log(`  [${String(Date.now() - t).padStart(5)}ms] ${label}`);
  return out;
}

async function main() {
  const joomla = new JoomlaClient(cfg);
  await joomla.login();

  console.log("\n[articles]");
  const art = await timed("create article", () =>
    joomla.createArticle({ title: `ZZ Adj Article ${STAMP}`, articletext: "<p>qa</p>" })
  );
  const artId = String((art.data as Record<string, string>)?.id || "");
  checkTrue("article create", art.success === true, art.message);
  const artGet = await timed("get article", () => joomla.getArticle(artId));
  checkTrue("article get returns title", String((artGet.data as Record<string, string>)?.title || "").includes(`ZZ Adj Article ${STAMP}`));
  const artUpd = await timed("update article", () => joomla.updateArticle(artId, { title: `ZZ Adj Article ${STAMP} v2` }));
  checkTrue("article update", artUpd.success === true, artUpd.message);
  const artDel = await timed("delete article", () => joomla.deleteArticle(artId));
  checkTrue("article delete", artDel.success === true, artDel.message);

  console.log("\n[categories]");
  const cat = await timed("create category", () => joomla.createCategory({ title: `ZZ Adj Cat ${STAMP}` }));
  const catId = String((cat.data as Record<string, string>)?.id || "");
  checkTrue("category create", cat.success === true, cat.message);
  const catUpd = await timed("update category", () => joomla.updateCategory(catId, { title: `ZZ Adj Cat ${STAMP} v2` }));
  checkTrue("category update", catUpd.success === true, catUpd.message);
  const catDel = await timed("delete category", () => joomla.deleteCategory(catId));
  checkTrue("category delete", catDel.success === true, catDel.message);

  console.log("\n[modules]");
  const mod = await timed("create module", () =>
    joomla.createModule({ title: `ZZ Adj Mod ${STAMP}`, moduleType: "mod_custom", position: "sidebar-a", content: "<p>qa</p>" })
  );
  const modId = String((mod.data as Record<string, string>)?.id || "");
  checkTrue("module create", mod.success === true, mod.message);
  const modUpd = await timed("update module", () => joomla.updateModule(modId, { title: `ZZ Adj Mod ${STAMP} v2` }));
  checkTrue("module update", modUpd.success === true, modUpd.message);
  const modDel = await timed("delete module", () => joomla.deleteModule(modId));
  checkTrue("module delete", modDel.success === true, modDel.message);

  console.log(`\n===== ${pass} passed, ${failures.length} failed =====`);
  for (const f of failures) console.log(`  FAILED: ${f}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
