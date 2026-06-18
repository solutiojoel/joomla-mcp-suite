# KB — Ministry Platform Widget Setup

How to integrate Ministry Platform widgets (events, opportunities, checkout) into a Joomla site.

---

## Background

In spring 2025, Ministry Platform conflicted with Joomla by appending `id=123` to URLs, which pulled up Joomla menu items by ID instead. This has since been resolved — the parameter is now `mpevent=7333` or `mpopportunity=2`.

**Try Option 1 first** — it is cleaner. Only use Option 2 if Option 1 doesn't work.

---

## Option 1: Update the ID Parameter in Ministry Platform (Preferred)

The client logs into Ministry Platform → Configuration Settings and updates 5 settings. They search by "key name" and set each value to `mpid`. See the Ministry Platform help docs for specifics:
https://help.acst.com/en/ministryplatform/help-topics/widgets/widgets-release-notes/may-2025#widget-urls-0

Once configured, widgets can be placed on any page as long as the head script is already added.

Head script (replace with client's MP domain):
```html
<script id="MPWidgets" src="https://CLIENTSITE.ministryplatform.com/widgets/dist/MPWidgets.js"></script>
```

---

## Option 2: /eventapp URL Structure

All pages hosting MP widgets (except the homepage) must be nested under the `/eventapp` URL.

### Widget Code Snippets

```html
<!-- Opportunity Finder -->
<mpp-opportunity-finder targeturl="/opportunity-details"></mpp-opportunity-finder>

<!-- Event Finder -->
<mpp-event-finder targeturl="/details"></mpp-event-finder>

<!-- Event Details -->
<mpp-event-details returnurl="/events" opportunityfinderwidgettargeturl="/opportunities" checkouturl="invoices"></mpp-event-details>

<!-- Invoice and Payment (replace with Vanco URL) -->
<mpp-checkout paymentprocessortargeturl="https://sample.com/paymentform" backtoeventtargeturl="/events"></mpp-checkout>

<!-- User Login -->
<mpp-user-login></mpp-user-login>
```

### Setup Steps

1. **Head script** — add via a Raw Tags module in the `ganalytics` position, assigned only to needed pages.
2. **Menu structure** — nest widget pages (single article menu items) under a Text Separator with alias `/eventapp`.
3. **Widget code** — embed in a **Raw Tags module** assigned to the appropriate page (use `content-top-a` or `content-bottom-a`). Do **not** paste into an article — TinyMCE strips custom HTML tags.
   - Alternatively, use `{loadmoduleid 123}` syntax in an article (remove the space after `:`).
4. **Menu item aliases** — if client wants these in the main menu, create a **Menu Item Alias** type item that redirects to the hidden `/eventapp` page to preserve the URL structure.
5. **Share URLs with client** — give them a landing page with all the widget URLs rather than individual links:
   - Example: `https://www.stjosephmiddletown.com/resources`
6. **Client generates widget code** — request this from the client, then embed it.
7. **Verify** — ask the client to confirm everything works.

---

## Notes

- Reference ticket: https://catholicwebsiteexperts.freshdesk.com/a/tickets/29196
- Example of well-implemented MP integration: https://stmmanhattan.com/my-parish-profile
