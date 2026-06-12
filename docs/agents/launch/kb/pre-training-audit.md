# KB — Pre-Training Audit Checklist

Run this audit before every client training session. Covers the most common issues that should be caught before handing off to the client.

---

## Audit Steps

**Browse the site on a phone (3–4 minutes)**
Look at the site from a mobile device. Note anything that appears off before starting the checklist.

**Homepage & Subpage Links**
- External links open in a new tab (social media, RSS feeds, documents, email addresses, footer phone numbers).

**Canva Links on Control Panel**
- No more than 4 Canva links on the Control Panel (rare exceptions exist).
- Each link displays the correct rotator size and text.
- The Canva link itself goes to the correct destination.

**Error Page**
- 404 page looks acceptable — header and footer appear. No template logo missing.

**Menu Dropdown Width**
- Dropdown text does not wrap to a second line. Stay under 350px width in Gantry 5.

**Pictures on Subpages**
- If not using heroes or grids, pictures should appear within article content on subpages.

**Side Menus**
- Active on most pages. Side menus should NOT display on Calendar, Home, or grid pages.

**Rotator & Headlines**
- Try uploading an image with different dimensions to verify it doesn't break the rotator or headlines.

**DOCman Modules**
- PDFs open in a new tab (set in the module settings).

**Headlines Module**
- Add a test headline to confirm the default image functions.

**Parish Registration Form**
- Google form description/subtext shows the correct parish name.

**Site Config**
- Timezone is correct for the client's physical location.
- A functional generic email address is in the From Email field.

**ADA Compliance**
- Alt tags added to images where applicable.

**Default Images**
- Upload the default news image.
- Upload the default grid image.

**Google Calendar**
- Calendar is in the correct timezone.

**Alert Module**
- Alert is published and visible (not hidden behind the menu on mobile).
- Alert "Read More" link is hidden.
- Update alert from the preview site placeholder to the Amazing Feature Message:

```
Amazing Alert Feature!
Stay informed with real-time website alerts! Our alert system notifies you of important updates, upcoming events, and new resources as soon as they're posted. Look for pop-up banners or notification icons to stay up to date.
```

**Editor CSS**
- Font types in `editor.css` match the site fonts.

**Headlines / Latest News Module**
- Category name matches the module title.

**Mobile Alert Check**
- Check site with the alert enabled on a mobile device.

**Social Media Icons**
- Icons change color on hover to a color that matches the site palette.

**Category Order**
Trash unnecessary categories. Correct order should be:
> News → Rotator → Alert → Grid Categories (alphabetical) → Page Content → Homepage Articles → Other DO NOT DELETE → Preview

**Styles Article**
- Colors and fonts in the styles article match the live site.

**reCAPTCHA**
- reCAPTCHA is enabled and the "I'm not a robot" checkbox appears on `/login`.

**Default News Image**
- Check and update if needed.

**Default Grid Image**
- Check and update if needed.
