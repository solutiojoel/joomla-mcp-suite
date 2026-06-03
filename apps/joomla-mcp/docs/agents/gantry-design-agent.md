# Gantry Design Agent

Use this guide whenever you are building or significantly modifying a Gantry 5 homepage layout from a brief. It enforces a workflow that prevents the most common design mistakes: wrong particle for content type, empty buttonlinks, missing content IDs, and applying a layout before understanding what already exists.

---

## When To Use This Guide

- Building a new `#Home` or `#School Home` outline from scratch
- Rebuilding an existing homepage layout from a brief
- Adding a new major section (hero, quicklinks, news feed, footer, etc.)
- Cloning a layout from one site to another

Do **not** use this guide for minor edits (changing a particle title, updating a block class, editing one article filter). Use `content-agent.md` or `editing-rules.md` for those.

---

## Required Tool Call Order

Follow these steps in order. Do not skip ahead.

### Step 1 — Understand the design pattern options

```
gantry_design_patterns   (no arguments → returns index of all patterns)
```

Read the pattern index. Identify which patterns match the sections requested in the brief. If the brief mentions "hero slider + mass times", that is the `hero-swiper-with-mass-times` pattern. If it mentions "quicklinks bar", that is `quicklinks-bar`. Etc.

Fetch full detail for any pattern you plan to use:
```
gantry_design_patterns(name: "hero-swiper-with-mass-times")
gantry_design_patterns(name: "quicklinks-bar")
```

**Do not skip this step.** The patterns teach you the particle choice rationale, content contract, and guardrails before you write a single line of YAML.

---

### Step 2 — Generate a design plan from the brief

```
gantry_design_plan_from_brief(brief: "...", site_type: "parish")
```

This returns:
- Which patterns were selected and why
- All required content IDs you must resolve (article IDs, category IDs)
- All guardrails that apply to this design
- Missing information that blocks proceeding

**Do not proceed until all missing_information items are resolved.**

---

### Step 3 — Look at similar sites for proven examples

```
gantry_homepage_examples(site_type: "parish")
```

Find a site whose layout resembles what you're building. Fetch it with `include_decompiled: true` to get a working design YAML as a starting point:

```
gantry_homepage_examples(slug: "stchris-speed", include_decompiled: true)
```

**Use the decompiled YAML as your starting point** — adapt the context variables, not the structure, unless the brief explicitly differs.

---

### Step 4 — Resolve all content IDs

For every `required_ids` item from Step 2, look up the actual Joomla IDs:

```
joomla_list_categories(site: "...")     → find category IDs
joomla_list_articles(site: "...", ...)  → find article IDs
```

**Never proceed with placeholder IDs like `{{mass_times_article_id}}` in the final YAML.** Replace every placeholder before compiling.

---

### Step 5 — Explain the existing layout (if modifying)

If you are modifying an existing outline rather than building from scratch:

```
gantry_explain_existing_section(site: "...", outline: "...", section: "slideshow")
gantry_explain_existing_section(site: "...", outline: "...", section: "utility")
```

Read the explanations before touching anything. Understand what each particle does, where its content comes from, and what guardrails protect it.

---

### Step 6 — Write the design YAML

Write your design YAML using:
- Patterns from Steps 1–2 as the authority on particle choice and layout contracts
- Decompiled example from Step 3 as the structural template
- Real content IDs from Step 4 substituted for all context variables
- `seen_on` references in patterns as sanity checks for block classes

**Checklist before proceeding:**
- [ ] Every `contentarray` has either `filter.categories` or `filter.articles` set (not both, not neither)
- [ ] Every `blockcontent` subcontents item has a non-empty `buttonlink`
- [ ] Every shell article contentarray has `title: { enabled: "hide" }` and `pagination_buttons: ""`
- [ ] Every news/events feed contentarray has `read_more: { enabled: "show" }`
- [ ] No placeholder `{{variable}}` values remain
- [ ] `swiper` slides_linkable is `disabled` unless the client explicitly requested clickable slides

---

### Step 7 — Validate the design contract

```
gantry_validate_design_contract(design_yaml: "...")
```

Fix all `errors` before proceeding. Review all `warnings`. Do not apply a layout with validation errors.

---

### Step 8 — Dry run the compiler

```
gantry_layout_design(site: "...", outline: "...", design_yaml: "...", dryRun: true)
```

Check `treeSummary` to confirm the section structure matches what you intended. Check `warnings` from the compiler. Fix any issues.

---

### Step 9 — Apply

```
gantry_layout_design(site: "...", outline: "...", design_yaml: "...")
```

Confirm `applied: true` and `verified: true` in the response.

---

### Step 10 — Verify the frontend

Fetch the homepage and check each section:

```
joomla_get_frontend_page(site: "...", path: "/")
```

Or use `gantry_particle_html` to fetch the rendered HTML of specific particles:

```
gantry_particle_html(site: "...", outline: "...", id: "...", page_url: "/")
```

For each major section, confirm:
- Content is rendering (not empty)
- Images are loading
- Links are correct (no empty `href=""` anchors)
- Mass Times / footer / mission content is coming from the right article

---

## Brief Format

Use this format when writing or receiving a design brief:

```
Site type: parish | school | cemetery
Overall feel: traditional | modern | bright | bold | quiet
Required sections:
  - Hero: [rotator category ID or name]
  - Alert banner: [alert category ID or "create new"]
  - Quicklinks: [list of labels and URLs]
  - News: [news category ID or name]
  - Mission: [mission article ID or "create new"]
  - Link boxes: [ministry labels + URLs]
  - Social: [Facebook/Instagram article ID or "create new"]
  - Footer: [footer article ID or "create new"]
Known IDs: [any article/category IDs already confirmed]
Do not: [e.g. "no clickable hero slides", "no pagination on news", etc.]
```

**Good brief example:**
> Parish homepage for St. Mary. Hero swiper (rotator category ID 12), mass times sidebar (article ID 44), 5 quicklinks (Bulletin /bulletin, Giving /giving, Calendar /calendar, Registration /registration, Mass Times /mass-times), news feed (category ID 6, 4 articles), link-boxes grid (Ministries, Sacraments, School, Staff, Contact — URLs TBD), Facebook widget (article ID 28), footer (article ID 18). No clickable slides. Traditional feel.

---

## Common Mistakes — Do Not Do These

| Mistake | Correct approach |
|---|---|
| Using `blockcontent` for Mass Times | Use `contentarray` pointing to the mass times article |
| Using `contentarray` for quicklinks | Use `blockcontent` with subcontents items |
| Leaving `buttonlink` blank on any blockcontent item | Every item must have a URL — even if it's `#` temporarily |
| Setting both `filter.categories` and `filter.articles` on a contentarray | Use one or the other, never both |
| Hardcoding embed code in a `custom` particle | Put embed code in a Joomla article, use `contentarray` |
| Applying without a dry run | Always dry run first |
| Using placeholder article IDs (`{{mass_times_article_id}}`) in the final YAML | Resolve all IDs before applying |
| Enabling `slides_linkable` without client confirmation | Disabled by default |
| Showing `read_more` on a shell article contentarray | Shell articles do not need read-more buttons |

---

## Pattern Quick Reference

| Section | Pattern | Particle | blockClass |
|---|---|---|---|
| Alert top | alert-banner | contentarray | modern-alert |
| Hero + Mass Times | hero-swiper-with-mass-times | swiper + contentarray | fullwidth-swiper + mass-times-block |
| Quicklinks | quicklinks-bar | blockcontent | ql-united |
| News feed | news-feed-sidebar | contentarray | ph-sideway-stack |
| Ministry cards | link-boxes-grid | blockcontent | link-boxes |
| Social widget | social-widget | contentarray | facebook-widget-container widget-container |
| Parish mission | parish-mission | contentarray | parish-mission-wrapper |
| Footer | footer-shell | contentarray | (blank) |

For full details on any pattern, call `gantry_design_patterns(name: "pattern-name")`.
