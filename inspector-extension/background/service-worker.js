/**
 * background/service-worker.js
 *
 * Handles the context menu click:
 *   1. Asks the content script for element data
 *   2. POSTs it to the MCP bridge server (localhost:9224)
 *   3. Briefly highlights the captured element on success
 */

'use strict';

const BRIDGE_URL = 'http://127.0.0.1:9224/element';

// ── Register context menu on install ─────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'inspect-with-claude',
    title:    'Inspect with Claude',
    contexts: ['all'],
  });
});

// ── Handle menu click ─────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'inspect-with-claude') return;
  if (!tab?.id) return;

  try {
    // Ask content script to capture the right-clicked element
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_ELEMENT' });

    if (response?.error) {
      console.error('[cdp-inspector] Capture error:', response.error);
      return;
    }

    const { data } = response;

    // POST to MCP bridge server
    let res;
    try {
      res = await fetch(BRIDGE_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data),
      });
    } catch (fetchErr) {
      console.error(
        '[cdp-inspector] Bridge unreachable. Is the MCP server running?\n',
        fetchErr.message
      );
      return;
    }

    if (!res.ok) {
      console.error('[cdp-inspector] Bridge returned', res.status);
      return;
    }

    console.log('[cdp-inspector] Captured →', data.selector);

    // Visual feedback: briefly outline the element in indigo
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func(selector) {
        const el = document.querySelector(selector);
        if (!el) return;
        const prev = el.style.outline;
        el.style.outline = '3px solid #6366f1';
        el.style.outlineOffset = '2px';
        setTimeout(() => {
          el.style.outline = prev;
          el.style.outlineOffset = '';
        }, 1800);
      },
      args: [data.selector],
    });

  } catch (err) {
    console.error('[cdp-inspector] Unexpected error:', err);
  }
});
