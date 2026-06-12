# KB — Subpage Background Effects

How to add a full-page background image to specific subpages using Gantry 5 CSS and a page class.

---

## Background Image CSS

Add to the site's custom CSS. Replace `site-1-sub` with the page class assigned to the subpage menu item, and update the image path as needed:

```css
/************ BACKGROUND ************/
.site-1-sub #g-page-surround {
  background: white url(../images/template/background.jpg) 0% 50% no-repeat;
  background-size: cover;
  background-attachment: fixed;
}

.site-1-sub #g-container-main {
  margin: 0;
  padding: 0 10%;
  background: none;
}
```

## Steps

1. Upload the background image to the site via FTP (Cyberduck) at the path referenced in the CSS (e.g., `images/template/background.jpg`).
2. Add the page class to the relevant menu item in Joomla (Menu Item → Page Display → Page Class).
3. Add the CSS block above to the site's Gantry 5 custom CSS.

## Common Image Paths

- `../images/template/background.jpg` — template images directory (most common)

Adjust the path based on where the image was uploaded via FTP.
