// Bridge allow-list enforcement test.
// Asserts the sub-agent allow-list is enforced at EXECUTION (not just when tools
// are advertised), so a call outside the list never reaches a downstream.
// Run: npx tsx src/bridge.test.ts   (or: npm test)

import { buildExecutor, type DownstreamHandle, type ToolCaller } from "./bridge.js";
import { isToolAllowed, matchPattern } from "./match.js";

let failures = 0;
function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok  ${label}`))
    .catch((err) => {
      failures++;
      console.error(`FAIL  ${label} — ${err.message}`);
    });
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}
async function expectReject(p: Promise<any>, includes: string) {
  try {
    await p;
  } catch (err: any) {
    assert(err.message.includes(includes), `expected error containing "${includes}", got "${err.message}"`);
    return;
  }
  throw new Error(`expected rejection containing "${includes}", but resolved`);
}

// A mock downstream that records every call it receives.
function mockDownstream(inject: string | null) {
  const calls: Array<{ name: string; arguments: Record<string, any> }> = [];
  const client: ToolCaller = {
    async callTool(req) {
      calls.push(req);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, received: req.arguments }) }] };
    },
  };
  return { handle: { client, inject } as DownstreamHandle, calls };
}

async function main() {
  console.log("— matchPattern / isToolAllowed —");
  await check("exact match", () => assert(matchPattern("joomla_article", "joomla_article"), "exact failed"));
  await check("wildcard match", () => assert(matchPattern("joomla_menu_item", "joomla_menu*"), "wildcard failed"));
  await check("star matches all", () => assert(matchPattern("anything", "*"), "star failed"));
  await check("non-match", () => assert(!matchPattern("joomla_user", "joomla_menu*"), "should not match"));
  await check("empty allow = allow all (back-compat)", () => assert(isToolAllowed("anything"), "empty allow blocked"));
  await check("allow list blocks others", () => assert(!isToolAllowed("joomla_user", ["joomla_article"]), "should be blocked"));

  console.log("— executor enforces allow-list at execution —");
  const { handle, calls } = mockDownstream("site_url");
  const clients = new Map<string, DownstreamHandle>([["joomla-mcp", handle]]);
  const registry = new Map<string, string>([
    ["joomla_workspace_write", "joomla-mcp"],
    ["joomla_article", "joomla-mcp"], // connected but NOT in allow-list
  ]);
  const exec = buildExecutor(clients, registry, "https://example.com", ["joomla_workspace_write"]);

  await check("allowed tool executes and reaches downstream", async () => {
    const out = await exec("joomla_workspace_write", { path: "spec.json" });
    assert(out.ok === true, "did not get downstream result");
    assert(calls.length === 1, `expected 1 downstream call, got ${calls.length}`);
  });

  await check("allowed tool gets site_url injected", async () => {
    assert(calls[0].arguments.site_url === "https://example.com", "site_url not injected");
  });

  await check("disallowed tool is REJECTED before reaching downstream", async () => {
    const before = calls.length;
    await expectReject(exec("joomla_article", { id: 1 }), "allow-list");
    assert(calls.length === before, "downstream was called for a disallowed tool!");
  });

  await check("unconnected tool reports not-found (distinct from allow-list)", async () => {
    // In allow-list but not in the registry → routing error, not an allow error.
    const exec2 = buildExecutor(clients, registry, "https://example.com", ["*"]);
    await expectReject(exec2("nonexistent_tool", {}), "not found in connected downstreams");
  });

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
