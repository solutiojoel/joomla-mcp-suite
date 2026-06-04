# Gantry Section HTML and CSS Conventions

Use this guide before writing custom CSS for Gantry 5 sections or before explaining rendered particle HTML. It defines the shared DOM model Solutio sites rely on.

---

## Rendered Section Structure

Gantry renders each layout section as a stable section ID in the frontend HTML:

```html
<section id="g-above" class="g-flushed">
    <div class="g-container">
        <div class="g-grid">
            <div class="g-block size-100 ql-title-overlay">
                <!-- particle-generated HTML -->
            </div>
        </div>
    </div>
</section>
```

The standard selector path is:

```css
#g-above > .g-container > .g-grid > .g-block
```

- `#g-{section}` is the section wrapper. Section background colors and section-level background images go here.
- `.g-container` is the max-width content wrapper. On Solutio sites it is capped by `--site-container-max-width`, normally `1440px`.
- `.g-grid` is one row in the Gantry section. A section can have multiple `.g-grid` children, one for each line in the layout manager.
- `.g-block` wraps an individual particle within a row. The particle's custom block class is found on this element, alongside `size-*`.
- Inside the `.g-block`, the particle outputs its own generated HTML such as `.g-content`, `.g-particle`, `.g-blockcontent`, `.g-array-item`, or particle-specific classes.

When writing particle CSS, start from the most stable meaningful selector:

```css
html body.site-home #g-above .ql-title-overlay .g-blockcontent {
    /* blockcontent particle styles */
}
```

Use the section ID plus the block class when the same particle type may appear elsewhere. Use only the block class when the style is intentionally reusable across sections.

---

## Max-Width Section Model

Solutio sites use the `withmaxwidth` body class to keep section contents predictable on wide screens. The section itself can span the viewport, while its immediate `.g-container` stays constrained.

```css
.withmaxwidth :is(#g-top, #g-navigation, #g-slideshow, #g-header, #g-above, #g-feature, #g-showcase, #g-utility, #g-container-main, #g-expanded, #g-extension, #g-bottom, #g-footer) > .g-container {
    position: relative;
}

@media only screen and (min-width: 90rem) {
    .withmaxwidth:not(.sponsorshippage) :is(#g-top, #g-navigation, #g-slideshow, #g-header, #g-above, #g-feature, #g-showcase, #g-utility, #g-container-main, #g-expanded, #g-extension, #g-bottom, #g-footer) {
        display: flex;
        justify-content: center;
    }

    .withmaxwidth:not(.sponsorshippage) :is(#g-top, #g-navigation, #g-slideshow, #g-header, #g-above, #g-feature, #g-showcase, #g-utility, #g-container-main, #g-expanded, #g-extension, #g-bottom, #g-footer) > .g-container {
        max-width: var(--site-container-max-width);
    }

    .withmaxwidth.sponsorshippage :is(#g-top, #g-navigation, #g-bottom, #g-footer) {
        display: flex;
        justify-content: center;
    }

    .withmaxwidth.sponsorshippage :is(#g-top, #g-navigation, #g-bottom, #g-footer) > .g-container {
        max-width: var(--site-container-max-width);
    }
}
```

Because sections normally use `g-flushed`, section padding must be applied to the immediate `.g-container` with `!important`:

```css
html body.site-home #g-above > .g-container {
    padding: min(4vw, 4rem) min(2vw, 2rem)!important;
}
```

Use `min(Nvw, Nrem)` sizing for paddings, gaps, headings, and scalable measurements so values grow with the viewport until the 1440px container cap, then stop expanding.

---

## Section Background Variables

The baseline section background contract is variable-driven:

```css
body {
    --section-page-surround-bg: var(--default-white);
    --section-container-top-bg: var(--default-white);
    --section-top-bg: var(--primary-color);
    --section-navigation-bg: var(--primary-color);
    --section-slideshow-bg: var(--default-white);
    --section-header-bg: var(--default-white);
    --section-above-bg: var(--default-white);
    --section-feature-bg: var(--default-white);
    --section-showcase-bg: var(--default-white);
    --section-utility-bg: var(--default-white);
    --section-container-main-bg: var(--default-white);
    --section-sidebar-bg: transparent;
    --section-mainbar-bg: transparent;
    --section-aside-bg: transparent;
    --section-expanded-bg: var(--default-white);
    --section-extension-bg: var(--default-white);
    --section-bottom-bg: var(--default-white);
    --section-container-footer-bg: var(--default-white);
    --section-footer-bg: var(--primary-color);
    --section-copyright-bg: var(--primary-color);
    --section-offcanvas-bg: var(--primary-color);
    --section-offcanvas-bg-overlay: rgba(0,0,0,.25);
}
```

These variables map directly to the rendered section IDs:

```css
#g-page-surround { background: var(--section-page-surround-bg); }
#g-container-top { background: var(--section-container-top-bg); }
#g-top { background: var(--section-top-bg); }
#g-navigation { background: var(--section-navigation-bg); }
#g-slideshow { background: var(--section-slideshow-bg); }
#g-header { background: var(--section-header-bg); }
#g-above { background: var(--section-above-bg); }
#g-feature { background: var(--section-feature-bg); }
#g-showcase { background: var(--section-showcase-bg); }
#g-utility { background: var(--section-utility-bg); }
#g-container-main { background: var(--section-container-main-bg); }
#g-sidebar { background: var(--section-sidebar-bg); }
#g-mainbar { background: var(--section-mainbar-bg); }
#g-aside { background: var(--section-aside-bg); }
#g-expanded { background: var(--section-expanded-bg); }
#g-extension { background: var(--section-extension-bg); }
#g-bottom { background: var(--section-bottom-bg); }
#g-container-footer { background: var(--section-container-footer-bg); }
#g-footer { background: var(--section-footer-bg); }
#g-copyright { background: var(--section-copyright-bg); }
#g-offcanvas { background: var(--section-offcanvas-bg); }
```

Scope variable overrides by page context:

- Use `html body.site-home {}` for homepage-only sections such as slideshow, header, above, feature, showcase, utility, container-main, expanded, and extension.
- Use `html body.site-sub {}` for subpage-only section treatments.
- Use `html body {}` or direct all-page section selectors for navigation, bottom, footer, copyright, offcanvas, and global defaults.
- Navigation, bottom, and footer should normally look the same across the site, so do not hide their core styling inside `.site-home`.

---

## Background Images and Overlays

Put section-wide background images on the section wrapper, not on `.g-container`. This lets the image span the viewport while the content remains constrained.

```css
@media only screen and (min-width: 50.99rem) {
    html body.site-home #g-expanded {
        background: url('/images/template/bg-welcome.jpg') 50% 50% no-repeat;
        background-size: cover;
        background-attachment: fixed;
        position: relative;
    }

    html body.site-home #g-expanded:before {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(var(--primary-color-rgb), .45);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        z-index: 1;
    }

    html body.site-home #g-expanded > .g-container {
        position: relative;
        z-index: 2;
        padding: min(4vw, 4rem) min(10vw, 10rem)!important;
    }
}

@media only screen and (max-width: 50.99rem) {
    html body.site-home #g-expanded {
        background: url('/images/template/bg-welcome.jpg') 50% 50% no-repeat;
        background-size: cover;
        position: relative;
    }

    html body.site-home #g-expanded:before {
        content: '';
        position: absolute;
        inset: 0;
        background: rgba(var(--primary-color-rgb), .45);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        z-index: 1;
    }

    html body.site-home.withmaxwidth #g-expanded > .g-container {
        position: relative;
        z-index: 2;
        padding: 2rem 1rem!important;
    }
}
```

Keep overlay pseudo-elements behind the `.g-container` by setting the section `position: relative`, the overlay `z-index: 1`, and the `.g-container` `position: relative; z-index: 2`.

---

## Where to Put Custom CSS

**Always write custom CSS to a file on the FTP server, then link it in the Base Outline.** Do not paste CSS into the Gantry admin Styles textarea — that field is for Gantry variable overrides only, not site CSS. Anything put there is harder to version-control, invisible to the next agent, and easy to accidentally overwrite.

### File location

The standard path for site-specific custom CSS on Solutio sites is:

```
/templates/g5_clarity/custom/css/custom.css
```

If the file doesn't exist yet, create it via FTP. If a site uses a different template folder name, check with `ftp_list_files` at `/templates/` to confirm the folder name.

### Linking the file in the Base Outline

After writing the file to FTP, register it so it loads on every page:

1. Gantry admin → **Base Outline** → **Styles** tab → scroll to **CSS Files** section
2. Add the path: `/templates/g5_clarity/custom/css/custom.css`
3. Save the outline

Because all other outlines (Home, Grid, Subpage, Sponsors, Error, etc.) inherit from Base, the file is automatically included everywhere — do not register it on individual outlines.

### Check before registering

Before adding the link, verify it isn't already there:

```
gantry_page_list(outlineId: "[base outline ID]")
```

Look for the CSS Files section in the returned page settings.

### Full workflow

```
1. ftp_read_file("/templates/g5_clarity/custom/css/custom.css")
   → read current CSS, or note if file doesn't exist yet

2. Append new rules to the content

3. ftp_upload_file("/templates/g5_clarity/custom/css/custom.css", content: "...")
   → write updated file back to server

4. Confirm the file path is registered in Base Outline → CSS Files
   → add it if missing
```

---

## CSS Authoring Rules

- Preserve the rendered hierarchy when choosing selectors: section ID, container/grid only when needed, block class, then particle-generated class.
- Put layout spacing on `#g-section > .g-container`, not on the particle internals, unless the spacing is truly part of the particle component.
- Use `!important` for section `.g-container` padding because `g-flushed` otherwise wins.
- Use desktop/mobile breakpoints at `50.99rem`. Use the wide max-width breakpoint at `90rem`.
- Use `min(Nvw, Nrem)` for scalable measurements and keep the numbers matched.
- Prefer CSS variables for colors and backgrounds instead of hardcoded hex values.
- Add `.site-home` or `.site-sub` scope unless the section must be consistent site-wide.
- Navigation, bottom, footer, copyright, and offcanvas are shared sections; treat them as all-page styles unless a site-specific exception is documented.
