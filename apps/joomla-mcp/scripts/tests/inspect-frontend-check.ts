/**
 * Manual check for joomla_inspect_frontend against a live page.
 *   npx tsx scripts/tests/inspect-frontend-check.ts <baseUrl> <path> <selector>
 */
import "dotenv/config";
import { JoomlaClient } from "../../src/joomla-client.js";

const [baseUrl, path, selector] = process.argv.slice(2);

async function main() {
  const joomla = new JoomlaClient({
    baseUrl: baseUrl || process.env.JOOMLA_BASE_URL || "",
    username: process.env.JOOMLA_USERNAME || "",
    password: process.env.JOOMLA_PASSWORD || "",
  });

  const show = (title: string, r: unknown) => {
    console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
    const json = JSON.stringify(r, null, 2);
    console.log(json);
    console.log(`[${json.length} chars]`);
  };

  // 1. geometry only — the case that took a hand-rolled puppeteer script
  show(
    "box only",
    await joomla.inspectFrontend({ path, selector, include: ["box"], depth: 4 })
  );

  // 2. targeted CSS — why is one property winning
  show(
    "css for .gala-prayer-title, colour only",
    await joomla.inspectFrontend({
      path,
      selector,
      include: ["css"],
      cssFor: ".gala-prayer-title",
      properties: ["color", "margin-top", "margin-bottom"],
      depth: 0,
    })
  );

  // 3. selector that matches nothing
  show(
    "no match",
    await joomla.inspectFrontend({ path, selector: "#does-not-exist" })
  );

  await joomla.close?.();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
