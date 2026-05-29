# Joomla MCP — Custom Page Agent Guide

**Scope:** Building or redesigning Joomla article pages that require custom CSS, JS, or FTP-uploaded assets. This is distinct from `content-agent` (which handles standard text/SEO edits) — use this guide any time a page needs a Raw Tags module, FTP file uploads, or a style guide. Read `editing-rules` first.

## Overview

The "fancy page" pattern adds rich CSS styling to a Joomla article using:
1. **TinyMCE-safe HTML** in the article body using `sc-*` CSS classes
2. **Page-specific CSS/JS** files uploaded to the site's `pub` folder via FTP
3. **Font Awesome 6** icons loaded from CDN
4. A **Raw Tags module** (`mod_rawtags`) at the `ganalytics` position that injects all three into `<head>`

**Critical constraint — TinyMCE compatibility:** The article HTML must survive a real person opening and saving the article in the Joomla TinyMCE editor. TinyMCE strips `<script>`, `<style>`, `<link>`, and non-standard elements. If any appear in the article body, they will be silently deleted the next time someone edits the article. All CSS and JS must live in the external FTP files injected via the Raw Tags module — never inline in the article. Use only standard block and inline HTML elements with class attributes.

---

## Step 0 — Get the FTP config

Call `ftp_site_config` (no arguments) at the start. It returns:
- `upload_path` — write-only path; use this with `ftp_upload_file` only
- `pub_path` — readable path for the same files; use this with `ftp_read_file` and `ftp_list_files`
- The public URL for any uploaded file is always: `https://<site-domain>/images/pub/<filename>`

These two paths are different due to a server-side FTP alias — do not use `upload_path` for reading or listing.

---

## Step 1 — Find or Create the Style Guide

Before writing any CSS, check for a style guide in the pub folder:

```
ftp_list_files(path: "<pub_path>")
```

Look for a file named `style-guide.json`. Some sites have sub-sites in the same Joomla build — in that case there may be multiple style guides named after each sub-site (e.g., `style-guide-eec.json`, `style-guide-school.json`). Pick the one matching the section of the site you are working on.

**If a style guide exists**, read it:
```
ftp_read_file(path: "<upload_path>/style-guide.json")
```
Use the tokens inside for all CSS colors, fonts, and spacing.

**If no style guide exists**, create one by inspecting the site:
1. Fetch the live page with `joomla_get_frontend_page` and note any color/font clues in the rendered output
2. Try to read the site's override CSS via FTP: `ftp_read_file(path: "<web_root>/content/override.css")` or `override-eec.css` — these files contain CSS custom properties and design tokens
3. Take a screenshot with `joomla_get_frontend_screenshot` to visually confirm the site's color palette and typography
4. Build a `style-guide.json` and upload it:

```json
{
  "site": "<site-domain>",
  "primary": "rgb(r, g, b)",
  "secondary": "rgb(r, g, b)",
  "tertiary": "rgb(r, g, b)",
  "fontBody": "Font Name, sans-serif",
  "fontDisplay": "Font Name, serif",
  "notes": "Any site-specific design notes"
}
```

```
ftp_upload_file(path: "<upload_path>/style-guide.json", content: "{ ... }")
```

For a sub-site, name it `style-guide-<subsite>.json`.

---

## Step 2 — Upload the Page CSS and JS

Name the files after the page (e.g., `director-welcome.css`). Write all CSS using the style guide tokens.

```
ftp_upload_file(path: "<upload_path>/my-page.css", content: "/* CSS here */")
ftp_upload_file(path: "<upload_path>/my-page.js",  content: "/* JS here */")
```

To revise after upload, re-upload the full file — it overwrites in place.

The scroll fade-in JS pattern (copy as-is, it's generic):
```javascript
(function(){
  function run(){
    var els=document.querySelectorAll('.sc-animate');
    if(!els.length)return;
    var io=new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if(e.isIntersecting){e.target.classList.add('sc-in');io.unobserve(e.target);}
      });
    },{threshold:0.15});
    els.forEach(function(el){io.observe(el);});
  }
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',run):run();
}());
```

---

## Step 3 — Create a Raw Tags Module for This Page

Find the menu item ID for this page first (from `joomla_list_menu_items` or the URL's `Itemid`).

```
joomla_create_module(
  title: "Page Name — CSS/JS",
  moduleType: "mod_rawtags",
  position: "ganalytics",
  assignment: "1",
  assigned: ["<menu_item_id>"],
  params: {
    raw_tags: '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<link rel="stylesheet" href="/images/pub/my-page.css">
<script src="/images/pub/my-page.js" defer></script>'
  }
)
```

---

## Step 4 — Write the Article HTML and Verify

1. Write HTML using `sc-*` classes (see component snippets below)
2. `joomla_article(action: "update", id, content)`
3. `joomla_get_frontend_screenshot(path, viewport="desktop")`

**Article HTML rules (TinyMCE-safe):**
- Wrap everything in `<div class="s-class-name-here">`
- Only use elements TinyMCE allows: `div`, `p`, `h2`–`h4`, `ul`, `ol`, `li`, `blockquote`, `a`, `strong`, `em`, `span`, `i`, `img`
- `class` attributes are preserved; `style` attributes may be stripped — never use inline styles
- Never put `<script>`, `<style>`, or `<link>` in the article — these will be deleted when a user saves in TinyMCE
- Font Awesome icons: `<i class="fa-solid fa-icon-name"></i>` — `<i>` is safe in TinyMCE
- Add `s-animate` to any block element that should fade in on scroll

---


### Scroll Fade-In
Add `s-animate` to any block element. JS adds `s-in` when it enters the viewport (threshold: 15%).
```css
.s-animate { opacity: 0; transform: translateY(24px); transition: opacity 0.65s ease, transform 0.65s ease; }
.s-animate.s-in { opacity: 1; transform: translateY(0); }
```
