# KB — Redesign Launch Checklist

Step-by-step process for launching a site redesign. Different from a new site launch because the old and new sites share the same Joomla install.

---

## Pre-Launch

1. After CSS build is complete, run the **RD Pre-Training Audit checklist** in SBS.
2. Confirm reCAPTCHA is working.
3. Email the client a **live preview link** (the preview path, not the live domain). Express genuine excitement. Note any missing elements (e.g., Flocknote RSS feed specific to that parish). If only the homepage/styles are built, note that subpages will take on the new look at launch. Give a go-live date ~1 week out to keep things moving.

**Live Preview Email Template:**
> Subject: DOMAINNAME Live Preview
>
> Hello [Name], Christ's peace be with you! I have a live preview of the website ready for you to see. [sitedomain.com/newhome]
>
> A couple of comments/questions: Links may lead to the current look — no worries, these will be updated at launch. Please let me know if anything else needs to change. We can make the site live as soon as we get your approval. We'll plan to go live [~1 week from today] unless you tell us otherwise. We're excited about this new look and hope you are too!

---

## Launch Steps

### 1. Update Old Menu URLs
On the **current main menu**, append `-old` to the alias of menu items that will **not** move to the new menu (e.g., `home` → `home-old`, `about` → `about-old`).

**Exceptions — do not rename these; move them instead:**
- Sponsors / Business Directory items — move via Batch Process (carry children with top menu item) to retain their URLs.
- Hidden menu items (keep/move over: sponsors, hidden menu items).

### 2. Clean Up the New Menu
- Remove any `-cl` or `-2` suffixes from top-level menu item aliases.
- Set the **default page** to the new homepage.
- Trash any unnecessary placeholder menu items (e.g., a duplicate Sponsors-CL).

### 3. Move Current Menu Items (If Applicable)
- Set max level view to 1 → Batch Process menu items from the existing main menu to the new menu.
- Repeat for hidden menu items (search, documents, login, alert, rotator, buy now, etc.).
- Update any QuickLinks that used `-cl` in their URL/alias.
- Spot-check subpages for correct modules (ads, menus) and correct outline assignments.

### 4. Add Redirect
Add a redirect: source `/home-cl` → destination `/` so any bookmarked old URLs redirect to the new homepage.

### 5. Verify Outline Assignments
Check outline assignment on all default menu items (search, documents, alert, rotator, styles, login/logout). Set the All Languages default to English only after **all subsites** have the new look.

### 6. Check Homepage Content
Verify links, quicklinks, headlines, calendar, and footer links all point correctly. Do not wait for the audit for this step.

### 7. Assign Modules to New Pages
Pay special attention to:
- **Bottom Ads** — all pages
- **Side Ads** — all pages (set ID in base outline)
- **Calendar Ads** — Site Grid outline only; must be a **different module** from footer ads (5 across, not 7)
- **Footer and top-right links**
- Remove `Box1` from side menu modules (Clarity template) — unassign position, assign to all menu items
- Side menu for hidden menu — apply only to Buy Now page, start at 2nd level items
- Check Document & Contact (school) side module format; clear or update module class suffixes

### 8. Sponsor URLs
Sponsors must retain URL `/sponsors-list/sponsors-list`. Assign the Site Sponsors outline to the respective menu items.

### 9. Content Checks
- Headlines should link to subpages, not the homepage.
- Check that the News and Rotators are current (matches current bulletin and liturgical season).
- If Calendar was an iframe menu item, update to a single article menu item.

### 10. Category Reorganization
If moving from category blogs to single article menu items:
- Rearrange categories so order is: Headlines → Rotator → Alert → Page Content → Items → Homepage Articles → Other.
- Create a final "DO NOT DELETE" category with permissions denied for Admin.
- Delete old Gantry 4 modules and RokGalleries, empty trash.

### 11. Subsites
Complete the main site launch first, then repeat all steps for each subsite. Check links from main site to subsites — if linking across domains, use absolute URLs (ext URL type, not menu item alias).

### 12. Launch Announcement
- Send launched email to client.
- Send Slack message to All Solutio with screenshot, domain, and site code: "[Site code] has a new look!"

---

## Post-Launch Email Template

> Subject: DOMAINNAME Live Preview Or Launched
>
> Hello [Name], The new look is live! I have clicked through all of the links on the homepage to make sure they are functioning/linked correctly. Please let me know if you find anything amiss.
