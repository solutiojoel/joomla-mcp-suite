# KB — Calendar Feed Setup

How to configure the Solutio Calendar Feed builder and embed Google Calendars with colored parish labels.

---

## Calendar Feed Builder

Login at: https://calendarfeed.solutiocloud.us/login
(Get credentials from Al.)

This is where new calendar configurations are created. The builder adjusts display settings as information is entered.

---

## Color Label HTML

Used when a site hosts multiple parishes sharing one calendar display. Update the hex color codes and parish names:

```html
<p>
  <span style="color: #0b8043;">St Joseph <i class="fa fa-square"></i></span> |
  <span style="color: #8e24aa;">St Joachim <i class="fa fa-square"></i></span> |
  <span style="color: #e4c441;">OLGC <i class="fa fa-square"></i></span>
</p>
```

---

## Saints Public Calendar URL

Shared calendar for all Solutio sites (saints' feast days):
```
https://calendar.google.com/calendar/embed?src=solutiosoftware.net_8msm9288ui8epu6ugdn14f27ts%40group.calendar.google.com&ctz=America%2FChicago
```

---

## Badge Calendar (RokMini Events) — Google API Setup

Used for the badge-style calendar particle. The current process generates a **JSON key file** instead of the older .p12 format.

1. Go to **Google Developers Console**: https://console.cloud.google.com/apis/dashboard
2. Create a new project.
3. Enable the **Google Calendar API** in the Library.
4. Configure **Credentials**:
   - Configure consent screen
   - Create **OAuth Client ID**
   - Create a **Service Account** — click through the service account email to get to the keys screen
   - Generate a **JSON key file** (not p12) for upload to Admin Tools → Calendars
5. In Gantry 5 particle settings, update the **Unique Calendar Name** field with the alias you create (suggested format: `sitecode-calendar`).
6. On the Admin Tools Calendars screen, **refresh** to load the calendar after saving.

### RokMini Events Timezone Reference

RokMini Events requires a non-US timezone name to display US local time correctly:

| US Timezone | Use This Timezone |
|-------------|------------------|
| Eastern | Porto Novo (adjust for DST) |
| Central | Reykjavik or Dakar |
| Mountain | Cape Verde |
| Pacific | South Georgia or Sao Paulo (Brazil) |
| Hawaii | La Paz |

Reference: https://www.timeanddate.com/worldclock/difference.html?p1=204

### Legacy .p12 Key Process (Older Sites)

If a site still uses the .p12 format:
- Download from Google Developers Console.
- Double-click to install; password is always: `notasecret`
- Rename file to reflect the client.
- Upload to `/images/service-keys/` via FTP (Cyberduck/FileZilla). This directory is protected from public web access.
- In RokMiniEvents3 module, enter: OAuth Email, P12 file location, Calendar ID.
- Make sure the Google Calendar is set to **public**.
