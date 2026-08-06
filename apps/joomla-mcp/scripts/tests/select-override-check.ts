/**
 * Regression check for submitAdminForm's select-field override validation.
 *
 *   npx tsx scripts/tests/select-override-check.ts
 *
 * Joomla <select> fields use short codes as values ("", "0", "1"), not the
 * option's label text or an intended-meaning word like "hide". Before this
 * check existed, an override that matched no real option was accepted
 * silently — the submit reported success (fieldsMatched could even read
 * true), and the write had no effect. Found on ticket #36012 (stant-northport,
 * 2026-08-06) trying to hide an article byline via
 * jform[attribs][show_author] = "hide".
 *
 * Covers two directions: a bad value must be refused before any POST, and a
 * real option value must still pass through untouched.
 */
import "../../src/env.js";
import { JoomlaClient } from "../../src/joomla-client.js";

const cfg = {
  baseUrl: process.env.JOOMLA_BASE_URL || "",
  username: process.env.JOOMLA_USERNAME || "",
  password: process.env.JOOMLA_PASSWORD || "",
};

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(38)} ${detail}`);
}

async function main() {
  const joomla = new JoomlaClient(cfg);
  await joomla.login();

  const articles = await joomla.listArticles();
  const target = ((articles.data || []) as Array<Record<string, string>>).find((a) => a.checkedOut !== "1");
  if (!target) {
    console.log("No unlocked article available to test against; skipping.");
    return;
  }
  const path = `index.php?option=com_content&task=article.edit&id=${target.id}`;

  // A word value that matches no real <select> option must be refused before any POST.
  const bad = await joomla.submitAdminForm(path, {
    overrides: { "jform[attribs][show_author]": "hide" },
    confirm: true,
  });
  check(
    "invalid value refused pre-POST",
    bad.success === false && /not a valid option/i.test(bad.message || ""),
    `success=${bad.success} message="${bad.message}"`,
  );
  const validOptions = (bad.data as Record<string, unknown> | undefined)?.validOptions as Array<{ value: string }> | undefined;
  check(
    "refusal names the real option values",
    Array.isArray(validOptions) && validOptions.some((o) => o.value === "0") && validOptions.some((o) => o.value === "1"),
    `validOptions=${JSON.stringify(validOptions)}`,
  );

  // A real option value must still pass validation and reach the payload (dry run — no save).
  const good = await joomla.submitAdminForm(path, {
    overrides: { "jform[attribs][show_author]": "0" },
    dryRun: true,
  });
  const payload = (good.data as Record<string, unknown> | undefined)?.payload as Record<string, string> | undefined;
  check(
    "valid value is not falsely refused",
    good.success === true && payload?.["jform[attribs][show_author]"] === "0",
    `success=${good.success} payloadValue=${payload?.["jform[attribs][show_author]"]}`,
  );

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
