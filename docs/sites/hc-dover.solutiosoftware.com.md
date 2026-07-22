# Site Notes — hc-dover.solutiosoftware.com (Church of the Holy Cross, Dover DE)

## Quirks & Warnings
- Public-facing domain is `holycrossdover.org`, which is NOT the Solutio-managed URL. The actual site/admin lives at `hc-dover.solutiosoftware.com` — `set_active_site` must use the `.solutiosoftware.com` URL, not the custom domain (custom domain has no working Joomla session/CSRF).
- User groups follow a per-person convention: each staff/admin gets a personal group named after them (e.g. "Christine Allen", "Ashlyn Baynocky") PLUS the shared `Manager` group (ID 11). There is no dedicated "Religious Education"/DRE group — new religious-ed staff get this same personal-group + Manager pattern.

## Key IDs
- Manager group: 11
- Ashlyn Baynocky (personal group): 81

## Active Integrations
- (none recorded yet)
