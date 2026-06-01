# KB — Staff Grid Page

How to build a staff/team page using a Gantry 5 `contentarray` particle module.

---

## Staff Article Format

Each staff member is a Joomla article in the Staff Items category. The body must follow this exact format for the grid particle to render correctly:

```html
<p style="text-align: center;"><strong>Full Name<br /></strong><em>Job Title</em><br /><a href="tel:000-000-0000">000-000-0000</a><br /><a href="mailto:email@example.com">email@example.com</a></p>
```

- Name is bold and repeats the article title — the grid hides article titles so the name must appear in the body
- Role is italic
- Phone and email are linked — no plain-text labels
- The whole paragraph is center-aligned

---

## Staff Grid Module

One module per staff page, assigned only to that menu item.

**Call `joomla_create_module` with:**

| Field | Value |
|---|---|
| `title` | e.g. "EEC Staff Grid" |
| `moduleType` | `Gantry 5 Particle` |
| `position` | `content-bottom-a` |
| `showtitle` | `0` |
| `published` | `1` |
| `assignment` | `1` (only selected pages) |
| `assigned` | `["<menu item ID>"]` |

**`params` — particle config as JSON string under key `"particle"`:**
```json
{
  "particle": "{\"type\":\"particle\",\"particle\":\"contentarray\",\"title\":\"Joomla Articles\",\"options\":{\"particle\":{\"enabled\":\"1\",\"title\":\"\",\"article\":{\"filter\":{\"categories\":\"<CATEGORY_ID>\",\"articles\":\"\",\"featured\":\"include\"},\"limit\":{\"total\":\"50\",\"columns\":\"1\",\"start\":\"0\"},\"display\":{\"pagination_buttons\":\"\",\"image\":{\"enabled\":\"full\"},\"text\":{\"type\":\"full\",\"limit\":\"\",\"formatting\":\"html\",\"prepare\":\"0\"},\"edit\":\"0\",\"title\":{\"enabled\":\"\",\"limit\":\"\"},\"date\":{\"enabled\":\"\",\"format\":\"l, F d, Y\"},\"read_more\":{\"enabled\":\"\",\"label\":\"\",\"css\":\"\"},\"author\":{\"enabled\":\"\"},\"category\":{\"enabled\":\"\"},\"hits\":{\"enabled\":\"\"}},\"sort\":{\"orderby\":\"ordering\",\"ordering\":\"ASC\"}},\"css\":{\"class\":\"\"},\"extra\":[]}}}"
}
```
Replace `<CATEGORY_ID>` with the Staff Items category ID.

**`advanced` — CSS classes for the grid layout:**
```json
{
  "moduleclass_sfx": "grid grid-articles grid-mobile-stacked grid-portrait grid-columns-4 grid-bg-img-flush-white grid-g-grid-box-shadow grid-title-align-center grid-text-align-center grid-g-grid-border-radius-1-point-5 grid-no-default-links grid-mobile-columns-1"
}
```

---

## After Creating the Module

- Set article ordering within the category using `joomla_article(action: "update", ordering: -1)` for first, then `ordering: <prev_article_id>` for each subsequent article
- Staff photos: articles have no images until headshots are uploaded to `images/stories/` — flag this to the user
