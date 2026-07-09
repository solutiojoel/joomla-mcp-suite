import "dotenv/config";
import { connectDownstreams } from "./bridge.js";
import { applyContent } from "./content-apply.js";
import { ContentSchematic } from "./schematic.js";

async function main() {
  const site = "https://stkat-philly.solutiosoftware.com";
  const filename = "stkat-philly-content-schematic.json";
  const dryRun = process.argv.includes("--dry-run");

  const { executor } = await connectDownstreams(["joomla-mcp"], site, [
    "joomla_workspace_read",
    "joomla_workspace_write",
    "joomla_article",
  ]);
  const schematic = (await executor("joomla_workspace_read", { path: filename })) as ContentSchematic;

  const report = await applyContent(schematic, {
    executor,
    schematic_filename: filename,
    node_keys: ["mainmenu:Academics/STREAM"],
    dry_run: dryRun,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
