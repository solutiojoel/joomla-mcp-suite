# Site: trinity-lenexa.solutiosoftware.com

**Live domain:** htlenexa.org (parish) / school subsite
**Site code:** trinity-lenexa
**Type:** Parish + School (Holy Trinity, Lenexa KS)

> Session history lives in `agent_audit { action: "list", site_code: "trinity-lenexa" }`.
> This file holds persistent facts only. The pre-2026-07-28 narrative version is archived
> verbatim at `agent_audit { action: "get", id: 45 }`.

---

## ⚠️ Quirks & Warnings

- **Article hero banner ignores the Intro Image field.** Both the Parish News grid tile and the article-detail hero render from `Featured Image` only; `Intro Image` is populated on some articles but is not read anywhere in the current particle config. A client-supplied 1600×444 Intro Image will not appear — the 1600×900 Featured Image gets stretched into that slot instead. Real fix is a Gantry/template particle change (needs a `super_shannon` session). **Until fixed, never tell a client Intro Image "works" for the banner.**
- **Cloned staff articles keep the original person's `mailto:` href.** Staff articles on this site are routinely created by cloning another staff member's article; the visible email text gets corrected but the underlying `mailto:` link often does not. 14 such instances were found and fixed across Faculty & Staff sections. **When cloning a staff article, always verify the `mailto:` href separately from the visible text.**
- **Never create menu items concurrently** — parallel creates corrupt Joomla's nested set. Create sequentially, then fix parents in a second pass.
- **Joomla aliases collide globally, across all menus.** Already taken here: `faith-formation` (→ used `faith-formation-nav`), `sponsors` (→ `sponsors-htl`), `home` (→ `home-htl`).
- **`joomla_module update` does not persist the `content` field** on an existing module — it reports success and verifies, but a follow-up `get` returns the original create-time content. Delete and recreate the module instead. (Global tool bug; bit this site during the Parent Portal hero build.)
- **Frontend screenshots cannot verify access-gated pages.** `joomla_get_frontend_screenshot` injects the admin *backend* session only, not a real Parents-group frontend login, so any `access=6` page (Parent Resources and its cards) redirects to the login form when captured. Structural readback is the only automated verification available; real visual QA needs a manual login as the shared Parents account.
- **Site Login is granted on a screen no tool can reach.** A "can't access the private section of this site" error for a custom group is usually Global Configuration → Permissions → *Site Login* for that group — entirely separate from Access Levels and category ACL. Human-only; no orchestrator tool touches it.
- **Watch for literal `<![CDATA[…]]>` wrappers in article content.** Article 675 rendered blank because its `content` field was wrapped in CDATA markers (its sibling cards were clean). Root cause unknown. If a Parent Resources card ever fails to render, check for this first.

## 🔗 Key IDs

**Menus & outlines**

| Item | ID |
|------|-----|
| Trinity Lenexa Menu (`trinity-lenexa`) | 8 |
| Other menus | `school-menu-cl`, `school-sub-cl`, `parent-menu` |
| templateStyleId — Studius #Outline | 32 |
| templateStyleId — #School Outline | 69 |
| templateStyleId — #School Grid | 70 |

**Parent Portal / Parent Resources (access-gated)**

| Item | ID |
|------|-----|
| Access Level "Parents" | 6 |
| User group "Parents" | 14 |
| Shared user account (username `Parents`) | 951 |
| Parent Portal menu item — **Login Form type** (`com_users&view=login`) | 308 |
| Parent Resources menu item (access=6) | 367 → article 664 |
| Parent Resources Items category (access=6) | 124 |
| Parent Resources Grid module | 222 |
| Hidden Menu "Parent Resources Items" (Category Blog → cat 124) | 368 |
| `mod_login` module (assigned to 367) | 167 |
| "Hero - Parent Portal" custom module (content-top-a, item 308) | 224 |

- Menu item 368 is **required**: Joomla's router needs a menu item associated with category 124, or grid-card article links resolve under the wrong template. Do not delete it.
- Login redirect → 367, logout redirect → 291. Module 158 ("Parent's Login") is an unused, harmless duplicate.
- Login Form menu items ignore `show_page_heading`/`page_heading` (core Joomla) — the page title and hero must come from a module, which is what 224 does. Mirrors the "Hero - Bulletin" (132) pattern used elsewhere on this site.

**School Faculty & Staff** — menu item **322**, one `mod_gantry5_particle` per section, all position `content-bottom-a`, sorted `ordering ASC` within each category:

| Section | Module / Category |
|---|---|
| Administration | 161 / 101 |
| Office Staff | 207 / 103 |
| Counseling · Nurses | 206 · 208 |
| K–5 | 209/105, 210, 211, 212/108, 213, 214 |
| 6th · 7th&8th | 215/111 · 216/112 |
| Specials · Resources | 217/113 · 218/114 |
| Support Staff (unpublished per client) | 220 / 115 IT + 116 Facilities |
| Teacher Aides | 221 / 122 |

Reorder people by editing each article's `ordering` field (place-after-ID semantics) — do not touch the module. Module 219 is an unpublished duplicate of Resources; leave it.

**Parish staff grid:** category 62, module 151 (content-bottom-a, menu item 207), articles 218–248.

**Other**

| Item | ID |
|------|-----|
| Uniform & Grooming Codes article (menu item 365) | 311 |
| Lunch Schedule menu item — System Link, external | 369 |
| Raw Tags "Solutio Components — CSS/JS" (all pages) | 147 |

- Site CSS: `/kck/trinity-lenexa/content/override-school.css`.
- Lunch Schedule points directly at `https://menus.healthepro.com/organizations/1805`. If that URL changes, update **two** places: menu item 369's link field and article 666's content. Article 677 is an orphaned unpublished intermediate — ignore.

## 🧩 Reusable Components

- **`sc-accordion`** — in the site-wide `solutio-components.css`/`.js` pair loaded by Raw Tags module 147 on every page (no per-page module needed). TinyMCE-safe. Markup: `div.sc-accordion.sc-accordion-3up` (or `-2up`) wrapping `details.sc-accordion-item > summary.sc-accordion-summary > span` + `i.fa-solid.fa-chevron-down.sc-accordion-chevron`, then `div.sc-accordion-body`. JS adds a WAAPI height animation (native `<details>` has no transition). Use this for any FAQ/policy expandable grid instead of hand-rolling `<details>` blocks.

## 🔌 Active Integrations

Smore (newsletter) · Google Calendar (embed + subscribe) · healthepro.com (lunch menus) · Renaissance Parents · ClassDojo · RaiseRight (code `6AA1FD3D57177`) · HT Parish Venmo (`@HTParish`, code `#4406`) · Flocknote

## 📋 Outstanding Client Items

- **Free & Reduced Lunch** (article 667) and **Handbook** (article 671) are still "Coming soon" placeholders — the client has been asked twice and has never provided either.
- **Safe Environment** (menu item 366 / article 663) is a placeholder; the client referenced a form on their old site but never sent it. Nothing matching exists in DOCman or articles here.
