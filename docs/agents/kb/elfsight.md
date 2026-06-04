# KB — Elfsight Social Media Widgets

How to connect Elfsight widgets (Instagram, Facebook, etc.) to client social media accounts.

---

## How It Works

Elfsight widgets require OAuth authorization from the client's social media account. We cannot connect them without the account owner clicking an approval link. Due to Instagram/Facebook permission policies, the old method of connecting by handle alone no longer works.

---

## Instagram / Facebook Connection Process

1. In Elfsight, open the widget settings → choose **Personal Account** → click **"How to connect to an account I don't own"** → copy the authorization URL.
2. **Save the widget before sending** the link to the client.
3. Email the client with this message template:

> Hello [Name],
>
> It used to be that we could make an Instagram display on the homepage by the handle of the account. However, due to permission policies, we now need permission for it to appear on the website. Please share the following link with whoever manages the @[instagramhandle] Instagram account.
>
> [PASTE AUTHORIZATION URL HERE — note: it may paste as white text; remove formatting before sending]
>
> That person will need to click the link. It will open a window asking for permission. Please click Allow. Please let us know when this has been completed. Thank you!

4. Once the client clicks Allow, the widget will connect and display on the site.

---

## Facebook Widget — Scheduled Connection Call

For Facebook specifically, a screen-sharing call is required:

1. Schedule a call with Dakota or Jeremy.
2. Connect to the client's computer via Chrome Remote Desktop: https://remotedesktop.google.com/support/
3. Have the client open a browser logged into Facebook.
4. Open a second tab — Solutio logs into the Elfsight account.
5. Click through settings to connect the widget to the client's Facebook page.
6. Log out of Elfsight, disconnect Remote Desktop, end call.
