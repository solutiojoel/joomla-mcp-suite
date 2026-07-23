# St. Anne Wichita (stanne.solutiosoftware.com) — Site Notes

## Key IDs
- Giving page: article 9836 ("Giving"), category "Involvement/Stewardship Items"
- Giving Items category: ID 2092 — feeds the "Giving Grid" module (Gantry 5 Particle, Joomla Articles particle, category filter 2092, limit 10)

## Quirks & Conventions
- **Giving/grid tile pattern:** Each tile on the Giving page is an article in category 2092 with an intro image and empty body content. The tile's click-through target is NOT set in the article — it's a **Redirect** (Content → Redirects) mapping the article's own front-end path (e.g. `/giving-items/10109-school-giving`) to the external giving link (mostly Pushpay URLs, but can be any external URL). Redirect type is 307.
- To add a new giving/grid button: create the article in category 2092 (published, intro image, no body needed), then add a redirect from the article's front-end path to the target URL.
- **Joomla Redirect component's admin `option` param is `com_redir`, not `com_redirect`** — `com_redirect` returns "No forms found" / 0 rows. Use `index.php?option=com_redir&task=link.add` (fields: `jform[old_url]`, `jform[new_url]`, `jform[published]`, `jform[redirect_type]`) via `joomla_inspect_admin_form` / `joomla_submit_admin_form`.
- FTP uploads are restricted to the `pub` directory only (`/wichita/stanne/pub`, public at `images/pub/...`) — not `images/stories`. Use this path for any FTP-uploaded image needing to become a Joomla intro/featured image.
- `support` agent scope does not have FTP or admin-form-inspection tools; switch to `super_shannon` for FTP uploads or com_redir work, then switch back.
- Two Giving Items articles exist unpublished: "School Lunch Payments" (9840) and "St. Anne Catholic School" (9841) — each already has a working redirect to Pushpay but is intentionally hidden from the grid.
