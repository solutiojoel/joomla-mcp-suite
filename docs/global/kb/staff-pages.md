# KB — Staff Pages

How to build staff/contact pages on Solutio sites. Multiple layout options depending on client preference.

---

## Layout Option 1: Staff Grid (contentarray particle)

See existing `staff-grid.md` for the contentarray particle approach. Each staff member is a Joomla article with a specific body format:

```html
<p style="text-align: center;">
  <strong>Full Name<br /></strong>
  <em>Job Title</em><br />
  <a href="tel:000-000-0000">000-000-0000</a><br />
  <a href="mailto:email@example.com">email@example.com</a>
</p>
```

Name is bold, role is italic, phone and email are linked. The grid hides article titles so the name must appear in the body.

---

## Layout Option 2: Teacherbox (div class)

Used when each staff member has a photo, bio link, and contact info in a card format:

```html
<div class="teacherbox">
  <div style="text-align: center;">
    <a href="/XXXXXX">
      <img style="display: block; margin-left: auto; margin-right: auto;"
           src="https://dfpjao5r6vmsd.cloudfront.net/images/stories/staff/image-coming-soon.png" alt="" />
    </a>
  </div>
  <div style="text-align: center;">
    <p style="text-align: center;">
      <strong><a href="/XXXXX">Name of Person</a><br /></strong>
      <em>Grade or Title<br /></em>
      <em>EXT. <br /></em>
      <a href="mailto:EMAILADDRESS" target="_blank" rel="noopener noreferrer">EMAIL ADDRESS<br /></a>
      <a class="button" href="/faculty-staff/ID">Teacher's Bio</a>
    </p>
  </div>
</div>
<hr id="system-readmore" />
```

If the client prefers not to show the email address publicly, hyperlink the word "Email" instead:
```html
<a href="mailto:xxxxxx@gmail.com" target="_blank" rel="noopener noreferrer">Email</a>
```

---

## Layout Option 3: Staff Table

Use the `alternaterowsm` table class for a responsive contact table:

```html
<table class="alternaterowsm">
  <tbody>
    <tr>
      <td><strong>Fr. John Smith</strong></td>
      <td><em>Pastor</em></td>
      <td><a href="tel:xxxxxxxxxx">xxx.xxx.xxxx</a></td>
      <td><a href="mailto:test@gmail.com" target="_blank" rel="noopener noreferrer">test@gmail.com</a></td>
    </tr>
  </tbody>
</table>
```

---

## Layout Option 4: Email Links to Contact Form

When clients want staff email addresses to route through a contact form rather than exposing actual addresses (example: stb-stl.solutiosoftware.com/about/staff):

1. Create a **Staff category** in the Contacts manager (not the Article manager).
2. Create a **Contact** for each staff member who has an email address.
3. For each contact, create a **Single Contact** menu item — ensure the form setting is set to display.
4. In each staff article, hyperlink the word "email" to that staff member's contact form page.

---

## Grade/Group-Specific Staff Pages (Schools Only)

Used when staff must be filtered by grade or group:

1. Create staff articles using the teacherbox layout above.
2. Go to Module Manager → New → **Strips RokSprocket** (Content provider: Joomla). Click Continue.
3. Set Joomla Content Filter Rules to **Articles** and add the desired staff members.
4. Set module position and menu assignment to the appropriate page.
