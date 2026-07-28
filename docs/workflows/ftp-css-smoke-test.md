# FTP → Gantry CSS Smoke Test Workflow

**Scope:** Validating that a CSS file can be written via FTP and linked into a Gantry outline's Page Settings so it is emitted on a target page. Use this any time you need to confirm the FTP-to-Gantry CSS pipeline end-to-end — before a full custom page build, after a server migration, or when debugging a missing stylesheet.

---

## ⚠️ Read This First — The Most Common Trap

**Do not assume "Base Outline" affects the live page.** Most production pages are served by a child outline (e.g., outline `33`, `Home`, `Interior`, etc.) that may have its own local Page Settings. A CSS file added to Base Outline will NOT appear on pages served by a child outline that has its own Assets rows.

**Always detect the active outline for the target page before editing any Page Settings asset.** This is step 2 below.

---

## Standard Sequence

### Step 1 — Get the FTP config

```
ftp_site_config()
```

Returns:
- `upload_path` — write path; use with `ftp_upload_file` only
- `pub_path` — read path for the same files; use with `ftp_read_file` / `ftp_list_files`
- Public URL for any uploaded file: `https://<site-domain>/images/pub/<filename>`

The two paths are different due to a server-side FTP alias. Never use `upload_path` for reading.

---

### Step 2 — Detect the outline serving the target page

```
gantry_outline(action: "for_page", site: "...", path: "/")
```

Note the outline ID returned. **Edit this outline — not Base Outline — in steps 4 and 5.**

If the path parameter isn't supported, check the menu item's assigned outline via `joomla_get_menu_item` and look at the `template_style_id` field.

---

### Step 3 — Upload the CSS file

```
ftp_upload_file(
  path: "<upload_path>/smoke-test.css",
  content: "/* smoke test */ body::after { content: 'CSS OK'; display:none; }"
)
```

Use a minimal sentinel rule — something that is inert visually but verifiable in the page source.

Confirm the public URL resolves: `https://<site-domain>/images/pub/smoke-test.css`

---

### Step 4 — Link the file into the correct outline's Page Settings

Use the outline ID from step 2.

```
gantry_page(
  action: "assets",
  site: "...",
  outline: "<outline-id-from-step-2>",
  cssActions: [
    { action: "add", item: { location: "https://<site-domain>/images/pub/smoke-test.css" } }
  ]
)
```

CSS and JS rows are edited through the `cssActions` / `javascriptActions` arrays.
Each entry carries its own `action` (`add` | `edit` | `remove`); select an existing
row with `index`, `name`, or `location`.

This replaces the old `gantry_page_asset_files_edit` tool and its
`gantry_add_css_asset` / `gantry_link_css_file` / `gantry_page_assets_edit`
aliases — there is now one way to do it.

As a fallback, `gantry_page(action: "edit")` can write the
`page[assets][css][_json]` field directly (read first, append the row, write the
full array back).

---

### Step 5 — Verify the stylesheet is emitted on the target page

```
joomla_get_frontend_page(path: "/")
```

Search the returned HTML for `smoke-test.css`. If the `<link>` tag is present, the pipeline works end-to-end.

Optionally verify the file is publicly reachable:
```
ftp_read_file(path: "<pub_path>/smoke-test.css")
```

---

### Step 6 — Cleanup (optional)

If this was a validation run only:

```
gantry_page(action: "assets",
  site: "...",
  outline: "<outline-id>",
  action: "remove",
  file: "https://<site-domain>/images/pub/smoke-test.css"
)
```

The FTP file can remain in place — it is inert.

---

## Quick Reference: Full Sequence

```
ftp_site_config()
  → gantry_outline(action: "for_page", path: "/target-page")   ← detect active outline first
  → ftp_upload_file(path: "<upload_path>/file.css")
  → gantry_page(action: "assets", outline: "<detected-id>",
                cssActions: [{ action: "add", item: { location: "..." } }])
  → joomla_get_frontend_page(path: "/target-page")       ← search for <link> tag
```

---

## Failure Modes and Fixes

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| FTP upload succeeds but file isn't at public URL | Wrong path — used `pub_path` instead of `upload_path` | Re-read `ftp_site_config` and use the correct path for each operation |
| CSS file at public URL but not in page source | Added to wrong outline | Re-run `gantry_outline{action:"for_page"}`, edit the correct outline |
| Asset row added but stylesheet still missing | Child outline has `inherit: false` for Assets | Edit the child outline's Assets directly, not Base Outline |
| `gantry_page{action:"assets"}` not found | Tool name varies by server version | Use `gantry_page{action:"edit"}` with `page[assets][css][_json]` |

---

## Tooling Request (pending)

A combined tool `gantry_css_asset_smoke_test(site, target_page, remote_filename, outline="auto_detect", cleanup=false)` would collapse steps 1–5 into one call with a structured result: FTP write success, public URL, active outline ID, asset row added, stylesheet emitted. Tracked in `improvements.md`.
