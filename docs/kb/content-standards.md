# KB — Content Entry Standards

Universal rules for entering and migrating content on all Solutio sites. Apply whenever creating or editing articles, images, or links.

---

## Formatting When Copying Content

Always strip formatting when pulling content from a client's old site or Trello:
- Select all text (Ctrl+A) and click **Clear Formatting** in the article toolbar.
- After clearing, toggle to the code editor and spot-check for leftover `<div>`, `<span>`, `<section>`, `<figure>`, `<wp>`, or extra `class` attributes — these cause layout issues on ministry-style pages.
- Do not copy-paste images or clipart from the old site unless the client explicitly requests them.
- Do not bring over content older than 5 years unless requested.

## Consistency Checklist

Check these every time before marking a page complete:
- Phone numbers formatted identically across all pages (pick one format and stick to it).
- All phone numbers and email addresses are linked (`tel:` and `mailto:`).
- External links, documents (PDF/DOC), forms, and email links all open in a **new window/tab**.
- No leftover classes on modules.
- Headings are consistent — Heading 6 is preferred for section labels in most parish sites.
- Tables use CSS classes, not manual width/height adjustments (see `css-table-classes.md`).
- Ministry/staff images are resized before upload.

## Image Manager Rules

When creating folders in Image Manager, avoid:
- Capital letters
- Special characters
- Spaces (use hyphens instead)
- Names longer than 40 characters

Violation of any of these can break the image button in the article toolbar and corrupt file paths. If a bad folder already exists, create a new one with a clean name and move images there.

## Hero Images

- Use hero images only on sites with a simple header, or if the client requests them.
- Standard hero image size: **1600×444px**.
- Save to the site's `hero` folder.
- Prefer client-provided photos over stock images.
- Do not duplicate hero images across pages (one per main menu section is acceptable on small sites).
- Avoid using rotator images as heroes — they vary in width and opacity.
- Ensure people's heads are not cropped awkwardly.

## Hyperlinks

| Link type | Open in new window? |
|-----------|-------------------|
| External URLs | Yes |
| Documents (PDF, DOC, etc.) | Yes |
| Forms | Yes |
| Email addresses | Yes |
| Internal page links | No |

## Tables

Use the **Insert Template** button in the article toolbar to insert pre-styled tables. Available CSS classes:

| Class | Use |
|-------|-----|
| `fancytable` | Contact-style key/value layout |
| `equaltable` | Equal-width columns |
| `flextable` | Flexible-width columns |
| `alternaterows` | Alternating row colors (general) |
| `alternaterowsm` | Alternating rows, responsive (staff/contact lists) |

Do not manually set column widths — it breaks mobile layout. Always check mobile view before marking complete.

## Pictures in Articles

- Upload to the parish folder, template folder, or a clean new folder in Image Manager.
- Keep folders organized so clients can find and update images after launch.
- Pictures should be sprinkled tastefully in articles or used as hero images.
