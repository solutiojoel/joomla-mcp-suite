# KB — QuickGalleries & Photo Galleries

How to set up and fix QuickGallery photo gallery pages on Solutio sites.

---

## Setting Up QuickGalleries

1. Import the control panel icon CSV: `Control_Panel_Quick-Gallery.csv`.
2. Add the gallery FA icons via Cyberduck to `/images/panel-icons/fa`.
3. In the clones (and action logs), grant **Admin permission** to the Quick Gallery component.

Example of a working QuickGallery:
- https://sfa-lincoln.solutiosoftware.com/photo-gallery

---

## Fixing Broken QuickGallery Links

**Symptom:** Gallery articles contain `href="null?type=articlequick"` — the gallery fails to load.

**Cause:** The menu item alias was lost or changed.

**Fix:** Replace `null` in the href with the alias of the gallery menu item:
```
href="null?type=articlequick"
→
href="quick-galleries/xavier?type=articlequick"
```
Where `xavier` is the alias of the relevant menu item. This was seen on Norbertine-Canonesses in October 2025.

---

## FileMan Gallery (Legacy — Pre-QuickGalleries)

Older sites use FileMan for galleries. Examples:
- https://stjohn-central.solutiosoftware.com/about-us/galleries
- https://sjnlilburn.com/photo-gallery-full

When working with FileMan galleries:
- Add the gallery **page class** to the menu item.
- Add a **Place Here** module in `content-top-a` so the gallery has a title and description (if creating per-folder menu items).
- Add a **Breadcrumbs** module in `content-top-a`.
