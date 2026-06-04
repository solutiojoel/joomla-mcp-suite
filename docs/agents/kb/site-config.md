# KB — Site Configuration & Setup Defaults

Standard settings to configure on every new or redesigned site. Access most of these from the **Site Configure** button on the Joomla Control Panel (under the Solutio Admin section).

---

## Site Title, Meta Description & Tags

1. Set **Site Name** to the full name of the church/school including city and state.
2. **Meta Description** — fill in a complete sentence describing the site:
   > "St. John the Beloved Catholic School, Wilmington, DE. Features include school news, event schedule, lunch menus, forms, school calendar, descriptions of all school programs, and much more!"
3. **Meta Keywords** — comma-separated (can use ChatGPT to generate):
   > `'st john the beloved catholic school', 'st john school wilmington de', 'wilmington delaware catholic school', 'catholic school'`
4. **Timezone** — set to match the client's physical location.
5. **From Email** — add a functional generic email address (e.g., `office@`, `info@`). Do not invent an address if none is available.

---

## reCAPTCHA Setup

Required for client password resets and contact forms.

1. Open https://www.google.com/recaptcha/admin/create in an **incognito window** logged into `media@solutiosoftware.net`.
2. Select **v2 Checkbox**.
3. Add all apex domains (e.g., `example.com`) and the site code domain (e.g., `sitecode.solutiosoftware.com`). Do not add subdomains except the site code.
4. Store both keys in the **ReCAPTCHA Keys Google Cloud project**.
5. In Joomla: Control Panel → **ReCAPTCHA plugin** → paste Site Key and Secret Key → enable → set to version 2.0.
6. Verify by visiting `/login` — the "I'm not a robot" checkbox should appear on the password reset screen.
7. Note: The From Email field in Site Config must have a value for password reset emails to send.

---

## Webmaster Verification (Google Search Console)

1. Go to https://search.google.com/search-console/ logged in as `media@solutiosoftware.net`.
2. Add property → **URL Prefix** → enter the full domain with `https://`.
   - Include `www` if the domain stays with the client's registrar.
   - Omit `www` if the domain is at Solutio's registrar.
3. Copy the **HTML Tag** meta value (just the content within the quotation marks).
4. Paste into the **Google Tools module** on the site.
5. If the site is not yet launched, click **Done** — verification must wait until after launch.

---

## Google Analytics GA4

1. Create a new GA4 Property in Google Analytics.
2. Copy the **Measurement ID** (e.g., `G-LK87PRH95E`) → paste into the **Google Tools module** → switch toggle to **GTag Format**.
3. In GA4 Admin → Property Settings → Data Display → **Key Events** → create:
   - `click` (mark as key event)
   - `impress` (mark as key event)
4. In GA4 Admin → **Custom Definitions** → add two dimensions:
   - `Event Category` / Scope: Event / Parameter: `event_category`
   - `Event Label` / Scope: Event / Parameter: `event_label`
5. Refresh the site homepage to activate data collection. Confirm "data collection is active" in the GA4 Home tab.
6. Paste the Property ID into the **Site Facts** field in SBS.
7. Update the **Website Traffic** icon in the Icon Panel Config with the analytics embed URL.

---

## SVG Control Panel Icons

Standard going forward: **remove the "Need Help" icon and the Google Analytics icon** from the control panel SVG set.

File path for panel icons: `Dropbox\Web\FORGE Directories\images\panel-icons`
