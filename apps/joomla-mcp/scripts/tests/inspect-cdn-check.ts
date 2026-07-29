/**
 * Confirms that rules recovered from cross-origin (CDN) stylesheets actually
 * take part in matching and cascade resolution — .g-container is defined by
 * Gantry's nucleus.css, which is served from CloudFront on these sites.
 */
import "dotenv/config";
import { JoomlaClient } from "../../src/joomla-client.js";

async function main() {
  const joomla = new JoomlaClient({
    baseUrl: "https://assumption-west.solutiosoftware.com",
    username: process.env.JOOMLA_USERNAME || "",
    password: process.env.JOOMLA_PASSWORD || "",
  });

  const run = async (title: string, o: any) => {
    const r = await joomla.inspectFrontend(o);
    const json = JSON.stringify(r, null, 2);
    console.log(`\n${"=".repeat(70)}\n${title}  [${json.length} chars]\n${"=".repeat(70)}`);
    console.log(json);
  };

  await run("container max-width — expect nucleus.css + gala.css in the ladder", {
    path: "/gala",
    selector: "#g-expanded",
    include: ["css"],
    cssFor: ".g-container",
    properties: ["max-width", "padding-left"],
    depth: 0,
  });

  await run("with fetchCrossOrigin OFF — same query, CDN rules should vanish", {
    path: "/gala",
    selector: "#g-expanded",
    include: ["css"],
    cssFor: ".g-container",
    properties: ["max-width", "padding-left"],
    depth: 0,
    fetchCrossOrigin: false,
  });

  await joomla.close?.();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
