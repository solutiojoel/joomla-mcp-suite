'use strict';

/**
 * Small helpers shared across modules.
 */

/**
 * Normalize a site URL into a base origin (no trailing slash).
 *  "example.com"          -> "https://example.com"
 *  "http://example.com/"  -> "http://example.com"
 */
function normalizeSite(site) {
  if (!site) throw new Error('Site URL is required');
  let s = String(site).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  // strip trailing slash and any trailing /administrator path the user pasted
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/administrator(\/.*)?$/i, '');
  return s;
}

/**
 * Look up per-site credentials in env, falling back to the global defaults.
 *   https://example.com -> EXAMPLE_COM_USER / EXAMPLE_COM_PASS
 *                       -> GANTRY_ADMIN_USER / GANTRY_ADMIN_PASS
 *                       -> JOOMLA_USERNAME / JOOMLA_PASSWORD
 *
 * The JOOMLA_* pair is the suite-wide credential every other downstream reads
 * (joomla-mcp, ftp-mcp). gantry-mcp historically only honoured GANTRY_ADMIN_*,
 * which is set in the gitignored apps/gantry-mcp/.env and therefore exists on
 * dev machines but never in a deployed environment — so every site-touching
 * Gantry tool failed in production while passing locally. Falling through to
 * JOOMLA_* keeps the two from drifting again.
 */
function resolveCreds(site, override = {}) {
  const url = new URL(normalizeSite(site));
  const key = url.host.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const user =
    override.user ||
    process.env[`${key}_USER`] ||
    process.env.GANTRY_ADMIN_USER ||
    process.env.JOOMLA_USERNAME;
  const pass =
    override.pass ||
    process.env[`${key}_PASS`] ||
    process.env.GANTRY_ADMIN_PASS ||
    process.env.JOOMLA_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      `No credentials found for ${url.host}. Set ${key}_USER/${key}_PASS, ` +
        `GANTRY_ADMIN_USER/GANTRY_ADMIN_PASS, or JOOMLA_USERNAME/JOOMLA_PASSWORD ` +
        `in the environment, or pass --user/--pass.`
    );
  }
  return { user, pass };
}

/**
 * Wait for the first selector in `selectors` that resolves, return that selector.
 * Useful because Joomla/Gantry markup varies a bit between versions.
 */
async function waitForAny(page, selectors, opts = {}) {
  const timeout = opts.timeout ?? 15000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) return sel;
    }
    await page.waitForTimeout?.(150) ?? new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`waitForAny: none of [${selectors.join(', ')}] appeared in ${timeout}ms`);
}

/**
 * Sleep helper that works with all Puppeteer versions.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Save a screenshot to ./screenshots/<name>.png for debugging.
 */
async function snap(page, name) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.resolve(process.cwd(), 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/**
 * Build a Gantry admin URL with the right theme + CSRF token tail.
 *   gantryUrl(ctx, 'configurations/default/layout')
 *   gantryUrl(ctx, 'menu/mainmenu/home')
 *   gantryUrl(ctx, 'configurations')        // outlines list
 *
 * Pass extra params as the third arg.
 */
function gantryUrl(ctx, view, extra = {}) {
  const u = new URL(`${ctx.base}/administrator/index.php`);
  u.searchParams.set('option', 'com_gantry5');
  u.searchParams.set('view', view);
  if (ctx.theme) u.searchParams.set('theme', ctx.theme);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  // Joomla CSRF token must be appended literally as &<token>=1
  let s = u.toString();
  if (ctx.token) s += `&${ctx.token}=1`;
  return s;
}

module.exports = { normalizeSite, resolveCreds, waitForAny, sleep, snap, gantryUrl };
