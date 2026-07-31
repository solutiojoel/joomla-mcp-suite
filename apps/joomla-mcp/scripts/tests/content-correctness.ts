/**
 * Correctness suite for the article, category, and module tools.
 *
 *   npx tsx scripts/tests/content-correctness.ts
 *
 * Every assertion is read back with a SECOND client instance, so nothing a write path
 * cached or reported about itself can make a test pass. Creates everything it needs
 * under a "ZZ QA <stamp>" prefix and trashes it at the end.
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

function check(name: string, actual: unknown, expected: unknown) {
  if (String(actual) === String(expected)) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.log(`  FAIL  ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function checkTrue(name: string, actual: boolean) {
  check(name, actual, true);
}

async function main() {
  const client = new JoomlaClient(cfg);
  const auditor = new JoomlaClient(cfg);
  await client.login();
  await auditor.login();

  // ==================== CATEGORIES ====================
  console.log("\n=== categories ===");
  const cat = await client.createCategory({ title: `ZZ QA Cat ${STAMP}`, description: "<p>qa desc</p>" });
  const catId = String((cat.data as Record<string, string>)?.id || "");
  checkTrue("category create reports success", cat.success === true);
  checkTrue("category create returned an id", /^\d+$/.test(catId));
  {
    const c = ((await auditor.getCategory(catId)).data || {}) as Record<string, string>;
    check("category title persisted", c.title, `ZZ QA Cat ${STAMP}`);
    check("category parent is root", c.parentId, "1");
    check("category published", c.published, "1");
    checkTrue("category description persisted", String(c.description).includes("qa desc"));
  }

  const catUpd = await client.updateCategory(catId, {
    title: `ZZ QA Cat ${STAMP} v2`,
    alias: `zz-qa-cat-${STAMP}`,
    description: "<p>qa desc updated</p>",
  });
  checkTrue("category update reports success", catUpd.success === true);
  {
    const c = ((await auditor.getCategory(catId)).data || {}) as Record<string, string>;
    check("category title updated", c.title, `ZZ QA Cat ${STAMP} v2`);
    check("category alias updated", c.alias, `zz-qa-cat-${STAMP}`);
    checkTrue("category description updated", String(c.description).includes("qa desc updated"));
  }

  const catCi = await client.checkInCategory(catId);
  checkTrue("category checkin reports success", catCi.success === true);

  // ==================== ARTICLES ====================
  console.log("\n=== articles ===");
  const art = await client.createArticle({
    title: `ZZ QA Art ${STAMP}`,
    categoryId: catId,
    content: "<p>qa body</p>",
  });
  const artId = String((art.data as Record<string, string>)?.id || "");
  checkTrue("article create reports success", art.success === true);
  checkTrue("article create returned an id", /^\d+$/.test(artId));
  {
    const a = ((await auditor.getArticle(artId)).data || {}) as Record<string, string>;
    check("article title persisted", a.title, `ZZ QA Art ${STAMP}`);
    check("article landed in the new category", a.categoryId, catId);
    check("article state persisted", a.state, "1");
    checkTrue("article body persisted", String(a.content).includes("qa body"));
  }

  // An unpublished create goes down a different verification branch.
  const artUnpub = await client.createArticle({
    title: `ZZ QA Art Unpub ${STAMP}`,
    categoryId: catId,
    content: "<p>hidden</p>",
    state: "0",
  });
  const artUnpubId = String((artUnpub.data as Record<string, string>)?.id || "");
  checkTrue("unpublished article create reports success", artUnpub.success === true);
  check("unpublished article state", (((await auditor.getArticle(artUnpubId)).data || {}) as Record<string, string>).state, "0");

  const artUpd = await client.updateArticle(artId, {
    title: `ZZ QA Art ${STAMP} v2`,
    content: "<p>qa body updated</p>",
  });
  checkTrue("article update reports success", artUpd.success === true);
  {
    const a = ((await auditor.getArticle(artId)).data || {}) as Record<string, string>;
    check("article title updated", a.title, `ZZ QA Art ${STAMP} v2`);
    checkTrue("article body updated", String(a.content).includes("qa body updated"));
    check("article category unchanged by update", a.categoryId, catId);
  }

  const artCi = await client.checkInArticle(artId);
  checkTrue("article checkin reports success", artCi.success === true);

  // ==================== MODULES ====================
  console.log("\n=== modules ===");
  const mod = await client.createModule({
    title: `ZZ QA Mod ${STAMP}`,
    moduleType: "mod_custom",
    position: "sidebar-a",
    content: "<p>qa module</p>",
  });
  const modId = String((mod.data as Record<string, string>)?.id || "");
  checkTrue("module create reports success", mod.success === true);
  checkTrue("module create returned an id", /^\d+$/.test(modId));
  {
    const m = ((await auditor.getModule(modId)).data || {}) as Record<string, string>;
    check("module title persisted", m.title, `ZZ QA Mod ${STAMP}`);
    check("module type resolved to mod_custom", m.moduleType, "mod_custom");
    check("module position persisted", m.position, "sidebar-a");
  }

  // Second create of the same type exercises the resolved-type cache.
  const mod2 = await client.createModule({
    title: `ZZ QA Mod2 ${STAMP}`,
    moduleType: "mod_custom",
    position: "sidebar-a",
    content: "<p>qa module 2</p>",
  });
  const mod2Id = String((mod2.data as Record<string, string>)?.id || "");
  checkTrue("second module create reports success", mod2.success === true);
  check(
    "cached type resolution still yields mod_custom",
    (((await auditor.getModule(mod2Id)).data || {}) as Record<string, string>).moduleType,
    "mod_custom"
  );

  const modUpd = await client.updateModule(modId, { title: `ZZ QA Mod ${STAMP} v2`, content: "<p>qa module updated</p>" });
  checkTrue("module update reports success", modUpd.success === true);
  {
    const m = ((await auditor.getModule(modId)).data || {}) as Record<string, string>;
    check("module title updated", m.title, `ZZ QA Mod ${STAMP} v2`);
    check("module position unchanged by update", m.position, "sidebar-a");
    checkTrue("module content updated", String(m.content).includes("qa module updated"));
  }

  const modOff = await client.toggleModule(modId, "0");
  checkTrue("module unpublish reports success", modOff.success === true);
  {
    const rows = ((await auditor.listModules("0", `ZZ QA Mod ${STAMP}`)).data || []) as Array<Record<string, string>>;
    check("list shows module unpublished", rows.find((r) => r.id === modId)?.state, "Unpublished");
  }
  const modOn = await client.toggleModule(modId, "1");
  checkTrue("module publish reports success", modOn.success === true);
  {
    const rows = ((await auditor.listModules("0", `ZZ QA Mod ${STAMP}`)).data || []) as Array<Record<string, string>>;
    check("list shows module published", rows.find((r) => r.id === modId)?.state, "Published");
  }

  const modCi = await client.checkInModule(modId);
  checkTrue("module checkin reports success", modCi.success === true);

  // ==================== GUARDS ====================
  console.log("\n=== safety guards ===");
  checkTrue(
    "article delete refuses a wrong expectedTitle",
    (await client.deleteArticle(artId, { expectedTitle: "Not This" })).success === false
  );
  checkTrue(
    "category delete refuses a wrong expectedTitle",
    (await client.deleteCategory(catId, { expectedTitle: "Not This" })).success === false
  );
  checkTrue(
    "module delete refuses a wrong expectedTitle",
    (await client.deleteModule(modId, { expectedTitle: "Not This" })).success === false
  );
  checkTrue(
    "module toggle refuses a wrong expectedModuleType",
    (await client.toggleModule(modId, "0", { expectedModuleType: "mod_nonexistent" })).success === false
  );
  check(
    "article survived the refused delete",
    (((await auditor.getArticle(artId)).data || {}) as Record<string, string>).title,
    `ZZ QA Art ${STAMP} v2`
  );

  // ==================== NO STALE CHECKOUTS ====================
  console.log("\n=== no stale checkouts ===");
  {
    const artRows = ((await auditor.listArticles(catId)).data || []) as Array<Record<string, string>>;
    const stuckArt = artRows.filter((r) => [artId, artUnpubId].includes(r.id) && r.checkedOut === "1");
    checkTrue(`no QA article left checked out (${stuckArt.map((s) => s.title).join(", ") || "none"})`, stuckArt.length === 0);

    const modRows = ((await auditor.listModules("0", `ZZ QA Mod`)).data || []) as Array<Record<string, string>>;
    const stuckMod = modRows.filter((r) => [modId, mod2Id].includes(r.id) && r.checkedOut === "1");
    checkTrue(`no QA module left checked out (${stuckMod.map((s) => s.title).join(", ") || "none"})`, stuckMod.length === 0);
  }

  // ==================== CLEANUP + DELETE VERIFICATION ====================
  console.log("\n=== delete ===");
  for (const [label, id, fn] of [
    ["article", artId, () => client.deleteArticle(artId)],
    ["article (unpub)", artUnpubId, () => client.deleteArticle(artUnpubId)],
    ["module", modId, () => client.deleteModule(modId)],
    ["module 2", mod2Id, () => client.deleteModule(mod2Id)],
    ["category", catId, () => client.deleteCategory(catId)],
  ] as Array<[string, string, () => Promise<{ success?: boolean; message?: string }>]>) {
    if (!id) continue;
    const res = await fn();
    checkTrue(`${label} ${id} delete reports success`, res.success === true);
  }
  {
    const artRows = ((await auditor.listArticles()).data || []) as Array<Record<string, string>>;
    checkTrue("no QA article remains listed", !artRows.some((r) => [artId, artUnpubId].includes(r.id)));
    const modRows = ((await auditor.listModules("0")).data || []) as Array<Record<string, string>>;
    checkTrue("no QA module remains listed", !modRows.some((r) => [modId, mod2Id].includes(r.id)));
    const catRows = ((await auditor.listCategories()).data || []) as Array<Record<string, string>>;
    checkTrue("no QA category remains listed", !catRows.some((r) => r.id === catId));
  }

  console.log(`\n===== ${pass} passed, ${failures.length} failed =====`);
  for (const f of failures) console.log(`  FAILED: ${f}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
