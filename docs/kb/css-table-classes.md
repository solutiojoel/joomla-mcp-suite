# KB — CSS Table Classes & Standard Styles

Reference for Solutio standard CSS table classes, button styles, and site-wide typography.

---

## Table Classes

Add the class to the `<table>` tag, e.g. `<table class="fancytable">`.

| Class | Purpose |
|-------|---------|
| `fancytable` | Key/value contact layout with `<th>` header cells |
| `equaltable` | All columns equal width |
| `flextable` | Flexible-width columns |
| `alternaterows` | Alternating row background colors |
| `alternaterowsm` | Alternating rows, responsive — use for staff/contact lists |

**Do not manually set column widths.** It looks fine on desktop but breaks on mobile. Use these classes instead. Always check mobile view before marking a table complete.

### HTML Refresher

```html
<table class="alternaterowsm">
  <tbody>
    <tr>                        <!-- Table Row -->
      <th>Header Cell</th>      <!-- Table Header (colored) -->
      <td>Data Cell</td>        <!-- Table Data -->
    </tr>
  </tbody>
</table>
```

### fancytable Example (Contact Info)

```html
<table class="fancytable">
  <tbody>
    <tr>
      <th>Contact</th>
      <td>Fr. Bob<br />555-555-5555<br />fatherbob@strobert.org</td>
    </tr>
  </tbody>
</table>
```

---

## Button Classes

```html
<a class="readon" href="/page">Read On Button</a>
<a class="button" href="/page">Button</a>
<a class="button transparentbutton" href="/page">Transparent Button</a>
<a class="button whitebutton" href="/page">White Button</a>
```

---

## Standard Site Fonts & Colors

| Property | Value |
|----------|-------|
| Title font | `'EB Garamond', serif` |
| Body font | `'Lato', sans-serif` |
| Primary color | var(--primary-color) | `#3595be` / `rgba(53, 149, 190, 1)` | ex: var(--primary-color-rgb) == 53,149,190 / var(--primary-color) == rgba(var(--primary-color-rgb),1)
| Secondary color | var(--secondary-color) | `#c9b8a0` / `rgba(201, 184, 160, 1)` | ex: var(--secondary-color-rgb) == 201,184,160 / var(--secondary-color) == rgba(var(--secondary-color-rgb),1)
| Tertiary color | var(--tertiary-color) | `#f7d000` / `rgba(247, 208, 0, 1)` | ex: var(--tertiary-color-rgb) == 247,208,0 / var(--tertiary-color) == rgba(var(--tertiary-color-rgb),1)

---

## Styles Article Bootstrap HTML

Add this to the Styles article to auto-render the site's color/font reference:

```html
<div id="stylesBox"></div>
<p><script>// <![CDATA[ addSiteStyles(); // ]]></script></p>
```

---

## Colored Background Sections

```html
<div class="primary-back">
  <div class="whiteborder">
    <!-- content here -->
  </div>
</div>

<div class="secondary-back">
  <div class="whiteborder">
    <!-- content here -->
  </div>
</div>
```
