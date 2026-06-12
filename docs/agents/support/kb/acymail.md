# KB — AcyMail Email Feature Setup

How to configure AcyMail (Acy Email) for parish email newsletters on Solutio sites.

---

## Default CSS

Paste this into the AcyMail template CSS when setting up a new email template:

```css
#acym__wysid__template img { margin: auto; }
#dynamicContent0 .acymailing_content { border-top: 10px solid #ddd; padding-top: 5px; }
.acym__wysid__column__element__td div { margin: auto; display: block; text-align: center; }
.acym__wysid__column__element__td div a { display: inline-block; }
```

To normalize article text in email stories (removes inline formatting inconsistencies and hides extra body images):

```css
.acydescription img { display: none; opacity: 0; height: 1px; width: 1px; }
#acym__wysid__template .acydescription p,
#acym__wysid__template .acydescription h1,
#acym__wysid__template .acydescription h2,
#acym__wysid__template .acydescription h3,
#acym__wysid__template .acydescription h4,
#acym__wysid__template .acydescription h5,
#acym__wysid__template .acydescription h6 {
  color: #000000 !important;
  font-family: Lato, sans-serif !important;
  font-size: 16px !important;
  text-align: left !important;
  font-weight: 400 !important;
  font-style: normal !important;
}
```

---

## Sponsorship Notice

Add this text to existing AcyMail setups:

> "Want to advertise in these emails? Click here to learn more." (link to the sponsorship options page)

If someone inquires about advertising before the feature is fully rolled out, respond with:

> "We are so glad you are interested. We have closed our first round of launching emails and will add you to our list to be considered / included in our next round of integrations."

---

## Default Images

Maintain default images for the three standard email types:
- Weekly Send
- Prayer Line
- Announcements
