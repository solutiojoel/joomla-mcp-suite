# Gantry Design Agent

Use this guide whenever you are building or significantly modifying a Gantry 5 homepage layout from a brief. It enforces a workflow that prevents the most common design mistakes: wrong particle for content type, empty buttonlinks, missing content IDs, and applying a layout before understanding what already exists.

---

## When To Use This Guide

- Building a new `#Home` or `#School Home` outline from scratch
- Rebuilding an existing homepage layout from a brief
- Adding a new major section (hero, quicklinks, news feed, footer, etc.)
- Cloning a layout from one site to another

Do **not** use this guide for minor edits (changing a particle title, updating a block class, editing one article filter). Use `content-agent.md` or the universal editing conventions (`knowledge_universal { action: "list", tag: "editing-rules" }`) for those.

---

## Required Tool Call Order

Follow these steps in order. Do not skip ahead.

### Step 0 — Understand rendered section HTML and CSS targeting

Read:

```
read_agent_doc(doc: "gantry-section-css")
read_agent_doc(doc: "gantry-particle-map")
```

Use this DOM model when writing or reviewing `override.css`: `#g-section > .g-container > .g-grid > .g-block`, where the particle's custom block class lives on `.g-block` and the particle-generated HTML lives inside it. Put section backgrounds on `#g-section`, put section padding on `#g-section > .g-container` with `!important`, and scope homepage-only section styles with `.site-home`.

Use the particle map to confirm every setting for the particle subtype before writing design YAML. After applying on a test outline, use `gantry_particle{action:"html"}` to inspect the rendered block and write CSS from the actual DOM.

### Step 1 — Understand the design pattern options

```
gantry_reference{topic:"patterns"}   (no arguments → returns index of all patterns)
```

Read the pattern index. Identify which patterns match the sections requested in the brief. If the brief mentions "hero slider + mass times", that is the `hero-swiper-with-mass-times` pattern. If it mentions "quicklinks bar", that is `quicklinks-bar`. Etc.

Fetch full detail for any pattern you plan to use:
```
gantry_reference(topic: "patterns", name: "hero-swiper-with-mass-times")
gantry_reference(topic: "patterns", name: "quicklinks-bar")
```

**Do not skip this step.** The patterns teach you the particle choice rationale, content contract, and guardrails before you write a single line of YAML.

---

### Step 2 — Write the design plan yourself

There is no tool for this step. The old `gantry_design_plan_from_brief` matched
keywords in the brief against a fixed pattern list; you read the brief far
better than that did. Using the patterns loaded in Step 1, write out:

- Which patterns you selected, and why each fits this brief
- Every content ID you must resolve first (article IDs, category IDs) — look
  them up with `joomla_article(action: "list")` / `joomla_category(action: "list")`
- Which guardrails from those patterns apply to this design
- Anything the brief leaves unanswered

**Do not proceed until every open question is resolved.** Guessing an article ID
or a section's purpose produces a layout that has to be rebuilt.

---

### Step 3 — Look at similar sites for proven examples

```
gantry_reference(topic: "homepage_examples", site_type: "parish")
```

Find a site whose layout resembles what you're building. Fetch it with `include_decompiled: true` to get a working design YAML as a starting point:

```
gantry_reference(topic: "homepage_examples", slug: "stchris-speed", include_decompiled: true)
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
gantry_section(action: "explain", site: "...", outline: "...", section: "slideshow")
gantry_section(action: "explain", site: "...", outline: "...", section: "utility")
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
gantry_design(action: "validate", design_yaml: "...")
```

Fix all `errors` before proceeding. Review all `warnings`. Do not apply a layout with validation errors.

---

### Step 8 — Dry run the compiler

```
gantry_design(action: "compile", site: "...", outline: "...", design_yaml: "...", dryRun: true)
```

Check `treeSummary` to confirm the section structure matches what you intended. Check `warnings` from the compiler. Fix any issues.

---

### Step 9 — Apply

```
gantry_design(action: "compile", site: "...", outline: "...", design_yaml: "...")
```

Confirm `applied: true` and `verified: true` in the response.

---

### Step 10 — Verify the frontend

Fetch the homepage and check each section:

```
joomla_get_frontend_page(site: "...", path: "/")
```

Or use `gantry_particle{action:"html"}` to fetch the rendered HTML of specific particles:

```
gantry_particle(action: "html", site: "...", outline: "...", id: "...", page_url: "/")
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

For full details on any pattern, call `gantry_reference(topic: "patterns", name: "pattern-name")`.
