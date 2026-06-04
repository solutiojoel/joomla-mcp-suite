# KB — Business Directory & Web Sponsorship

How to set up and update the Business Directory and Sponsorship features on a Solutio site.

---

## Required URLs

The URLs for these pages **must** be exactly:
- `/sponsors-list/sponsors-list`
- `/sponsors-list/sponsor-this-site`

If they differ, fix them in **Menu Manager**. These URLs must be preserved exactly during redesigns — do not let them change.

---

## Updating the Site Code (Passcode)

1. Log into the client's SBS project. Copy the **Directory Passcode** from the top of the project page.
2. In Joomla, go to **Article Manager** (from the Control Panel dashboard) and search for the article titled **"Business Directory"**.
3. Open the article in **Editor-CodeMirror** (not the standard TinyMCE editor — TinyMCE will corrupt the script).
4. Find this code in the article:
   ```html
   <div id="bizdirectory"><h2>Directory is loading.</h2></div>
   <script>getBizDirectoryDos('SITEPASSCODEGOESHERE');</script>
   ```
5. Replace `SITEPASSCODEGOESHERE` with the actual passcode (keep the single quotes).
6. Save and close.

**Warning:** If edited in TinyMCE, the script will be wrapped in CDATA comments and break. Correct format:
```html
<script>getBizDirectoryDos('9ngrssad7J');</script>
```
Broken format (do not use):
```html
<script>// <![CDATA[ getBizDirectoryDos('9ngrssad7J'); // ]]></script>
```

## Additional Notes

- The Business Directory page must have **no Side Menu** module assigned to it.
- The Directory Passcode update is also part of the Google Analytics GA4 setup checklist — update it when setting up analytics for a new site.
