# KB — DNS Setup & Site Launching

DNS change instructions and launch process for new sites. For redesign launches, see `redesign-launch.md`.

---

## DNS Records for Solutio-Hosted Sites

Make these changes on the client's registrar for each domain hosting a Solutio site (primary domain + any school subdomains):

1. **Remove** the existing `www` A record.
2. **Create** a CNAME on the `www` subdomain:
   - Value: `SITE-CODE.w.solutiosoftware.net.`
3. **Update** the A record on the apex/base domain:
   - New value: `54.83.55.79`

For apex/hostname fields: use `@` to represent the apex domain, `www` for the www subdomain.

**If a domain just needs to forward all traffic** to a different domain (no site hosted):
- Set both the www A record and the apex A record to `54.83.55.79`.

**If a client has multiple A records:** forward each to the new IP or delete unneeded ones — evaluate case by case.

---

## NameCheap NS Records (When Transferring Domain to Solutio Registrar)

Before transferring, confirm existing DNS records and recreate them on our nameservers. Then send instructions to switch nameservers:

```
ns10.dnsmadeeasy.com
ns11.dnsmadeeasy.com
```

Note: Do not complete the domain transfer before launch — some registrars shut down DNS during a transfer, which breaks the live site.

---

## New Site Launch Checklist

1. **Domain** — if Solutio has the domain, launch from Domain Manager. If the client has the domain, DNS instructions should have already been sent.
2. **Enable HTTPS** after DNS records propagate (use Putty to verify propagation). May also need to enable HTTPS on the redirect.
3. **Announce launch:**
   - Tweet (Lori)
   - Slack message to All Solutio with domain name, site code, and screenshot
4. **Google Calendar** — add a "Transition to Support Fees" reminder to B/S Team calendar with a notification 2 weeks prior. Usually 3 months of unlimited support for a paid site.
5. **Billing** — add contact in Launch Billing Hopper so Alex/Andy have the correct person to invoice.
6. **Sitemap:**
   - Generate at: https://www.xml-sitemaps.com/
   - Remove URLs of pages that won't remain (e.g., specific bulletins or headlines)
   - Upload to `/content/sitemap.xml` via Cyberduck
   - Submit to Google Search Console (logged in as `media@solutiosoftware.net`)
7. **Notify client** — email the same contacts who received training follow-up.
8. **Email list** — add users from training to the MailChimp email list (reference Master Contact List spreadsheet).

---

## Launch Email Templates

**Website Launched:**
> Subject: DOMAINNAME is Launched
> Hi everyone! The domain transfer has completed and we have full control of the domain. I have launched your new site! Enjoy today! Pax Christi.

**DNS Launch Instructions (sent to client when they hold the domain):**
> Subject: DNS Launch Instructions for DOMAINNAME.COM
>
> With the website scheduled to launch on [DATE], these are the DNS changes needed:
> - Update the CNAME record on the `www` subdomain: new value: `SITECODE.w.solutiosoftware.net.`
> - Update the A record on the base domain: new value: `54.83.55.79`
>
> The site is configured to accept this domain. Once DNS changes are made, the site will go live after propagation. Please notify Joel and I when the records have been updated so we can enable SSL.

**Paid Support Transition (sent ~2 weeks before unlimited support ends):**
> Subject: Paid Support to Begin — [Site]
>
> Per the terms of our agreement, your period of unlimited support will end on [DATE]. After that date, support incidents are charged at our normal rate: $25 base fee; $1.83/minute over 10 minutes. 90% of requests resolve in under 10 minutes. Password/account questions, server issues, and billing questions are not charged.
