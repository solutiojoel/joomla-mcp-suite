/**
 * Regression check for the shared admin-form parser (parseAdminFields / buildLabelIndex).
 * Confirms labels are still resolved, and reports parse time per form.
 *
 *   npx tsx scripts/tests/form-parse-check.ts
 */
import "../../src/env.js";
import { JoomlaClient } from "../../src/joomla-client.js";

const cfg = {
  baseUrl: process.env.JOOMLA_BASE_URL || "",
  username: process.env.JOOMLA_USERNAME || "",
  password: process.env.JOOMLA_PASSWORD || "",
};

type Field = { name: string; id: string; label: string };

async function main() {
  const joomla = new JoomlaClient(cfg);
  await joomla.login();

  const targets: Array<{ name: string; path: string; formId?: string }> = [
    { name: "menu item edit", path: "index.php?option=com_menus&task=item.add" },
    { name: "article edit", path: "index.php?option=com_content&task=article.add" },
    { name: "category edit", path: "index.php?option=com_categories&task=category.add&extension=com_content" },
    { name: "menu add", path: "index.php?option=com_menus&task=menu.add" },
    { name: "user add", path: "index.php?option=com_users&task=user.add" },
  ];

  let failures = 0;
  for (const t of targets) {
    const started = Date.now();
    const res = await joomla.inspectAdminForm(t.path, t.formId);
    const ms = Date.now() - started;
    const forms = (res.data as Record<string, unknown>)?.["forms"] as Array<Record<string, unknown>> | undefined;
    const form = forms?.[0];
    const fields = (form?.["fields"] || []) as Field[];
    const withId = fields.filter((f) => f.id);
    const labelled = withId.filter((f) => f.label && f.label.length > 0);
    const ok = fields.length > 0 && (withId.length === 0 || labelled.length > 0);
    if (!ok) failures++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${t.name.padEnd(16)} ${String(ms).padStart(5)}ms  fields=${String(fields.length).padStart(4)}  withId=${String(withId.length).padStart(4)}  labelled=${String(labelled.length).padStart(4)}`
    );
    const sample = labelled.slice(0, 3).map((f) => `${f.id}="${f.label}"`).join("  ");
    if (sample) console.log(`      e.g. ${sample}`);
  }

  console.log(failures ? `\n${failures} target(s) failed` : "\nAll form parses returned labelled fields");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
