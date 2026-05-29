/**
 * browser.js — Chrome connection manager
 *
 * Strategy:
 *   1. Try to attach to an existing Chrome via puppeteer.connect() on CHROME_PORT.
 *   2. If that fails, launch a new Chrome/Chromium instance via puppeteer-core.
 *
 * After connecting, exposes:
 *   - page    : Puppeteer Page (high-level API)
 *   - cdp     : CDPSession attached to the page (raw Protocol access)
 */

import puppeteer from 'puppeteer-core';
import { existsSync } from 'fs';

// Common Chrome executable paths per platform
const CHROME_PATHS = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ],
};

function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH set but not found: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }

  const candidates = CHROME_PATHS[process.platform] ?? CHROME_PATHS.linux;
  const found = candidates.find(p => p && existsSync(p));
  if (!found) {
    throw new Error(
      'Chrome/Chromium not found. Install Chrome or set CHROME_PATH in .env.\n' +
      `Searched:\n${candidates.join('\n')}`
    );
  }
  return found;
}

class BrowserManager {
  constructor() {
    /** @type {import('puppeteer-core').Browser|null} */
    this.browser = null;
    /** @type {import('puppeteer-core').Page|null} */
    this.page = null;
    /** @type {import('puppeteer-core').CDPSession|null} */
    this.cdp = null;
    /** @type {'attached'|'launched'|null} */
    this.mode = null;
  }

  /**
   * Connect to Chrome. Tries to attach first; falls back to launching.
   * @param {{ port?: number, headless?: boolean }} opts
   */
  async connect({ port = Number(process.env.CHROME_PORT ?? 9222), headless = true } = {}) {
    // ── Attempt 1: attach to running Chrome ────────────────────────────────
    try {
      this.browser = await puppeteer.connect({
        browserURL: `http://localhost:${port}`,
        defaultViewport: null,
      });
      this.mode = 'attached';
    } catch {
      // ── Attempt 2: launch headless Chrome ──────────────────────────────
      const executablePath = findChrome();
      this.browser = await puppeteer.launch({
        executablePath,
        headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
        ],
        defaultViewport: null,
      });
      this.mode = 'launched';
    }

    // Get first open tab (or open a blank one)
    const pages = await this.browser.pages();
    this.page = pages[0] ?? await this.browser.newPage();

    // Create a CDP session for raw Protocol access
    this.cdp = await this.page.createCDPSession();
    await this.cdp.send('DOM.enable');
    await this.cdp.send('CSS.enable');

    return {
      mode: this.mode,
      url: this.page.url(),
      title: await this.page.title(),
    };
  }

  /** Navigate to a URL. Re-enables CDP domains after load. */
  async navigate(url) {
    this._requirePage();
    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });

    // CDP session survives navigation but domains need re-enabling
    await this.cdp.send('DOM.enable');
    await this.cdp.send('CSS.enable');

    return { url: this.page.url(), title: await this.page.title() };
  }

  /** Take a full viewport screenshot. Returns base64 PNG. */
  async screenshot() {
    this._requirePage();
    const buf = await this.page.screenshot({ type: 'png', fullPage: false });
    return buf.toString('base64');
  }

  /** Evaluate a JS expression in the page. Returns JSON-serializable result. */
  async evaluate(expression) {
    this._requirePage();
    // Wrap as arrow fn so both expressions and statement blocks work
    return this.page.evaluate(new Function(`return (${expression})`));
  }

  /** Raw CDPSession — for DOM/CSS protocol calls */
  getCDP() {
    this._requirePage();
    return this.cdp;
  }

  /** Puppeteer Page — for high-level operations */
  getPage() {
    this._requirePage();
    return this.page;
  }

  /** Disconnect or close Chrome depending on how we connected. */
  async disconnect() {
    if (this.mode === 'launched') {
      await this.browser?.close();
    } else {
      await this.browser?.disconnect();
    }
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.mode = null;
  }

  _requirePage() {
    if (!this.page) {
      throw new Error('Not connected. Call browser_connect first.');
    }
  }
}

// Singleton — shared across all tool handlers
export const browserManager = new BrowserManager();
