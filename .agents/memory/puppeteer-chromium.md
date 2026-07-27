---
name: Puppeteer needs system Chromium
description: Puppeteer's downloaded Chrome is absent in this environment; use Nix Chromium via env vars resolved at startup.
---

Puppeteer's managed Chrome download does not exist in this Replit environment ("Could not find Chrome (ver. ...)" at launch).

**Why:** Nix store paths change on environment rebuilds, so hard-coding a Chromium path breaks; the puppeteer download cache is also not persisted.

**How to apply:** System Chromium is installed via Nix. `scripts/start-single.sh` resolves `command -v chromium` at startup and exports `PUPPETEER_EXECUTABLE_PATH` (puppeteer) and `CHROME_PATH` (cdp-inspector) when unset. Any new script that launches a browser should do the same, never pin a /nix/store path. Note gantry browser sessions default to headful — pass headless in server contexts.
