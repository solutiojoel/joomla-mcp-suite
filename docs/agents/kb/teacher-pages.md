# KB — Teacher Pages & Side Menu Subcategory

How to build individual teacher/classroom pages with sidebar navigation and user access controls. Used primarily on school sites.

---

## Overview

Each teacher requires two categories, two articles, specific menu items, multiple modules, and a user group/account. Follow this order.

---

## Step 1: Create Categories

Create two categories per teacher:
- **Grade & Teacher Name** — e.g., `3A - Smith` (contains the teacher profile article)
- **Side Menu Items** — e.g., `3A Side Menu Items` (contains subcategory pages like assignments, newsletters)

The Side Menu category's child articles will appear in the sidebar navigation of the teacher's page.

---

## Step 2: Create the Teacher Profile Article

- Saved under the **Grade & Teacher Name** category.
- Set to **Featured** — this makes it appear in the sidebar contact section.
- Contains: photo, name, title, email, phone, bio.
- Set permissions so the teacher cannot delete or unpublish this article.

---

## Step 3: Create the Grade Page Article

- Title = grade/class name.
- Set to **Featured**.
- Saved under the **Side Menu Items** category.
- Set permissions so the teacher cannot delete or unpublish this article.

---

## Step 4: Create Menu Items

Match the existing teacher menu structure on the site.

1. **Single Article** menu item → points to the Grade Page article. Set page class: `school-staff-layout`.
2. **Blog or Category List** submenu item (hidden in Gantry settings) — required so that side menu articles have a menu item to anchor from.

---

## Step 5: Create Required Modules

Each teacher page needs:

| Module | Purpose |
|--------|---------|
| **Page grid** (blog layout) | Main page content |
| **Featured article** (sidebar) | Displays teacher profile/contact info |
| **Side Menu** (sidebar) | Shows the subcategory list of teacher pages |
| **Documents** (sidebar) | Only required if the site uses document modules |

There is typically also a staff grid module on the class page (especially on larger schools).

---

## Step 6: Create User Group & Account

- Create a user group named by grade and teacher last name (e.g., `3A-Smith`) — use this naming convention so it's easy to update when teachers change.
- Grant the user group permission access to the **parent category** only — child categories inherit permissions.
- Create a user account with access to **Basic Editor** and assigned to the user group.

---

## Final Checklist Before Completion

- [ ] Both categories created correctly
- [ ] Profile article is Featured
- [ ] Grade page article is Featured
- [ ] Menu item uses `school-staff-layout` page class
- [ ] Hidden category menu item exists
- [ ] All modules assigned to correct pages and positions
- [ ] User group created with correct category permissions
- [ ] User account created with Basic Editor access
