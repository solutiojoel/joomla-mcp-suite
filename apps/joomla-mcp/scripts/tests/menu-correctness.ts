/**
 * Menu item correctness suite.
 *
 *   npx tsx scripts/tests/menu-correctness.ts
 *
 * Every assertion is checked with a SECOND client instance, so nothing a write path
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

const MENU = process.env.AUDIT_MENU || "mainmenu";
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
  // Independent reader — separate session, separate cookies, separate caches.
  const auditor = new JoomlaClient(cfg);
  await client.login();
  await auditor.login();

  const readBack = async (id: string) => {
    const r = await auditor.getMenuItem(id);
    return (r.data || {}) as Record<string, string>;
  };
  const created: string[] = [];

  // ---------- 1. flat create ----------
  console.log("\n[1] create separator at root");
  const sep = await client.createMenuItem({
    title: `ZZ QA Sep ${STAMP}`,
    menuType: MENU,
    itemType: "separator",
  });
  const sepId = String((sep.data as Record<string, string>)?.id || "");
  created.push(sepId);
  checkTrue("create reports success", sep.success === true);
  checkTrue("create returned an id", /^\d+$/.test(sepId));
  {
    const item = await readBack(sepId);
    check("title persisted", item.title, `ZZ QA Sep ${STAMP}`);
    check("menuType persisted", item.menuType, MENU);
    check("parent is root", item.parentId, "1");
    check("published persisted", item.published, "1");
  }

  // ---------- 2. nested create (exercises the parent self-heal path) ----------
  console.log("\n[2] create child under the separator");
  const child = await client.createMenuItem({
    title: `ZZ QA Child ${STAMP}`,
    menuType: MENU,
    itemType: "url",
    link: "https://example.com/qa",
    parentId: sepId,
  });
  const childId = String((child.data as Record<string, string>)?.id || "");
  created.push(childId);
  checkTrue("nested create reports success", child.success === true);
  {
    const item = await readBack(childId);
    check("child parent is the separator", item.parentId, sepId);
    check("child link persisted", item.link, "https://example.com/qa");
    check("child title persisted", item.title, `ZZ QA Child ${STAMP}`);
  }

  // ---------- 3. create unpublished (exercises the published repair path) ----------
  console.log("\n[3] create an unpublished item");
  const unpub = await client.createMenuItem({
    title: `ZZ QA Unpub ${STAMP}`,
    menuType: MENU,
    itemType: "url",
    link: "https://example.com/unpub",
    published: "0",
  });
  const unpubId = String((unpub.data as Record<string, string>)?.id || "");
  created.push(unpubId);
  checkTrue("unpublished create reports success", unpub.success === true);
  {
    const listed = await auditor.listMenuItems(MENU, `ZZ QA Unpub ${STAMP}`);
    const row = ((listed.data || []) as Array<Record<string, string>>).find((r) => r.id === unpubId);
    check("list shows it unpublished", row?.state, "Unpublished");
  }

  // ---------- 4. create a component-type item ----------
  console.log("\n[4] create a single-article item");
  const articles = await auditor.listArticles(undefined, undefined, 1, 1);
  const articleId = ((articles.data || []) as Array<Record<string, string>>)[0]?.id;
  const art = await client.createMenuItem({
    title: `ZZ QA Article ${STAMP}`,
    menuType: MENU,
    itemType: "com_content.article",
    request: { id: String(articleId) },
  });
  const artId = String((art.data as Record<string, string>)?.id || "");
  created.push(artId);
  checkTrue("article-type create reports success", art.success === true);
  {
    const item = await readBack(artId);
    checkTrue("link points at the article view", String(item.link).includes("view=article"));
    check("request id persisted", (item.request as unknown as Record<string, string>)?.id, String(articleId));
  }

  // ---------- 5. update several fields at once ----------
  console.log("\n[5] update title, alias, note, browserNav");
  const upd = await client.updateMenuItem(childId, {
    title: `ZZ QA Child ${STAMP} renamed`,
    alias: `zz-qa-child-${STAMP}`,
    note: "qa note",
    browserNav: "1",
    menuType: MENU,
  });
  checkTrue("update reports success", upd.success === true);
  {
    const item = await readBack(childId);
    check("title updated", item.title, `ZZ QA Child ${STAMP} renamed`);
    check("alias updated", item.alias, `zz-qa-child-${STAMP}`);
    check("note updated", item.note, "qa note");
    check("browserNav updated", item.browserNav, "1");
    check("parent unchanged by update", item.parentId, sepId);
  }

  // ---------- 6. reparent via update ----------
  console.log("\n[6] move the child back to root");
  const moved = await client.updateMenuItem(childId, { parentId: "1", menuType: MENU });
  checkTrue("reparent reports success", moved.success === true);
  check("parent is now root", (await readBack(childId)).parentId, "1");

  // ---------- 7. toggle ----------
  console.log("\n[7] unpublish then publish");
  const off = await client.toggleMenuItem(childId, "0", MENU);
  checkTrue("unpublish reports success", off.success === true);
  {
    const listed = await auditor.listMenuItems(MENU, `ZZ QA Child ${STAMP}`);
    const row = ((listed.data || []) as Array<Record<string, string>>).find((r) => r.id === childId);
    check("list shows unpublished", row?.state, "Unpublished");
  }
  const on = await client.toggleMenuItem(childId, "1", MENU);
  checkTrue("publish reports success", on.success === true);
  {
    const listed = await auditor.listMenuItems(MENU, `ZZ QA Child ${STAMP}`);
    const row = ((listed.data || []) as Array<Record<string, string>>).find((r) => r.id === childId);
    check("list shows published", row?.state, "Published");
  }

  // ---------- 8. guard rails still refuse a mismatched target ----------
  console.log("\n[8] safety guards");
  const badTitle = await client.deleteMenuItem(childId, { expectedTitle: "Definitely Not This" });
  checkTrue("delete refuses a wrong expectedTitle", badTitle.success === false);
  const badMenu = await client.toggleMenuItem(childId, "0", MENU, { expectedMenuType: "no-such-menu" });
  checkTrue("toggle refuses a wrong expectedMenuType", badMenu.success === false);
  check("item survived the refused delete", (await readBack(childId)).title, `ZZ QA Child ${STAMP} renamed`);

  // ---------- 9. nothing left checked out ----------
  console.log("\n[9] no stale checkouts");
  {
    const listed = await auditor.listMenuItems(MENU);
    const rows = (listed.data || []) as Array<Record<string, string>>;
    const stuck = rows.filter((r) => created.includes(r.id) && r.checkedOut === "1");
    checkTrue(`no QA item is left checked out (${stuck.map((s) => s.title).join(", ") || "none"})`, stuck.length === 0);
  }

  // ---------- 10. delete ----------
  console.log("\n[10] trash every QA item");
  for (const id of created) {
    if (!id) continue;
    const del = await client.deleteMenuItem(id, { menuType: MENU });
    checkTrue(`delete ${id} reports success`, del.success === true);
  }
  {
    const listed = await auditor.listMenuItems(MENU);
    const rows = (listed.data || []) as Array<Record<string, string>>;
    const survivors = rows.filter((r) => created.includes(r.id));
    checkTrue(`no QA item remains listed (${survivors.map((s) => s.title).join(", ") || "none"})`, survivors.length === 0);
  }

  console.log(`\n===== ${pass} passed, ${failures.length} failed =====`);
  for (const f of failures) console.log(`  FAILED: ${f}`);
  if (failures.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
