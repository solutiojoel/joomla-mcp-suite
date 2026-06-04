# KB — Podcasting Setup

How to enable and configure the podcasting/homily feature on a Solutio site.

---

## Prerequisites

Check the **Feature Notes** section in SBS for the client's project. If it mentions podcasting, proceed. If blank, assume no podcasting is needed.

Email **Andy** to add podcasting to the website — he creates the category linked to the Podcast Manager.

---

## Setup Steps

1. **Create a folder** in Image Manager: `podcast-upload` (in the root folder).
2. **Publish icons** in the Icon Panel Manager: `podcast-upload` and `podcast-manager`.
3. **Add this HTML to the category description** (update the placeholder text with the actual parish name and domain):

```html
<table style="width: 100%;" border="0">
  <tbody>
    <tr>
      <td>
        <p>Podcasts are an easy way to listen to audio from Our Lady of Perpetual Help Catholic Church.
        <br />Click on a link below to listen to the various podcasts.
        <br /><br />RSS Feed<br />
        <a href="/podcasts/homilies.xml" target="_blank" rel="noopener noreferrer">http://SITEDOMAIN.ORG/podcasts/homilies.xml</a></p>
      </td>
      <td align="center">
        <p><a class="readon" href="https://SITECODE.solutiosoftware.com/">Subscribe with iTunes</a></p>
        <p>Coming soon</p>
      </td>
    </tr>
  </tbody>
</table>
```

4. **Create the podcast/homily menu item:**
   - Type: **Category Blog**
   - Two columns
   - Category description: **Show**
   - Article titles: **Hide**

5. **Verify** by uploading a test MP3 to the site. Test file: `HailMary-MP3.mp3`

---

## Podcast Manager Credentials

These credentials work across all Solutio sites:
- Username: `manager`
- Password: `portal3pod`
