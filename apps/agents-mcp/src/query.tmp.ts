import "dotenv/config";
import { connectDownstreams } from "./bridge.js";

async function main() {
  const { executor } = await connectDownstreams(
    ["joomla-mcp"],
    "https://stkat-philly.solutiosoftware.com",
    ["joomla_article"]
  );
  const res = await executor("joomla_article", { action: "list", limit: 200 });
  const items = (res.data ?? []).map((a: any) => `${a.id}: ${a.title} [${a.categoryName ?? a.category ?? ""}]`);
  console.log(`total: ${items.length}`);
  console.log(items.join("\n"));
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
