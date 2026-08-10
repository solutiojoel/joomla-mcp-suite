/**
 * Regression check for the note body sent to Freshdesk.
 *
 *   npx tsx scripts/tests/note-html-check.ts
 *
 * The fault this guards against never errored — it shipped a note that Freshdesk
 * rendered with literal "**bold**" and "- " bullets. freshdesk_add_note prepended
 * "<p>— Shannon (AI Assistant)</p>" to the body BEFORE addNote called
 * markdownToHtmlIfNeeded. The combined string opened with "<p", so the converter's
 * "is this already HTML?" test passed and the caller's markdown went out verbatim.
 *
 * The order is the whole fix, so these checks assert on the payload addNote actually
 * posts, not on the converter alone. The axios instance is replaced with a stub, so no
 * request leaves the machine and no credentials are needed.
 */
import { FreshdeskClient, NOTE_ATTRIBUTION, markdownToHtmlIfNeeded } from "../../src/freshdesk-client.js";

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${detail}`);
}

/** Post the body through addNote and return the payload the client would send. */
async function postedBody(body: string): Promise<string> {
  const client = new FreshdeskClient({ domain: "example.freshdesk.com", apiKey: "stub" });
  let captured = "";
  (client as unknown as { axios: { post(url: string, payload: Record<string, unknown>): Promise<unknown> } }).axios = {
    async post(_url: string, payload: Record<string, unknown>) {
      captured = String(payload.body ?? "");
      return { data: { id: 1, private: true, created_at: "", body: captured } };
    },
  };
  await client.addNote(1, body, true);
  return captured;
}

async function main() {
  const markdown = "Checked the module.\n\n- Rebuilt the cache\n- **Republished** item 42";
  const sent = await postedBody(markdown);

  check("markdown converts", sent.includes("<ul>") && sent.includes("<strong>Republished</strong>"), sent.slice(0, 90));
  check("no raw markers survive", !sent.includes("**") && !/(^|>)- /.test(sent), sent.includes("**") ? "found ** in payload" : "none");
  check("attribution present once", sent.split(NOTE_ATTRIBUTION).length === 2, `${sent.split(NOTE_ATTRIBUTION).length - 1} occurrence(s)`);
  check("attribution leads the body", sent.startsWith(NOTE_ATTRIBUTION), sent.slice(0, 40));

  // A caller that already writes HTML must come through untouched.
  const html = "<p>Root cause: stale cache.</p><ul><li>Item 42 republished</li></ul>";
  const sentHtml = await postedBody(html);
  check("html passes through", sentHtml === `${NOTE_ATTRIBUTION}${html}`, sentHtml.slice(0, 90));

  // The reason the order matters, asserted directly: attribution first defeats the check.
  const preTagged = markdownToHtmlIfNeeded(`${NOTE_ATTRIBUTION}${markdown}`);
  check("attribution first would break", preTagged.includes("**"), "converter skips a body that opens with <p — hence attribution last");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
