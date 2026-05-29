/**
 * content/inspector.js
 *
 * Runs in every page. Tracks the last right-clicked element and responds to
 * capture requests from the background service worker.
 */

'use strict';

// ── Track the right-clicked target ───────────────────────────────────────────

let lastTarget = null;

document.addEventListener('contextmenu', (e) => {
  lastTarget = e.target;
}, true /* capture phase so we always see it */);

// ── Utilities ─────────────────────────────────────────────────────────────────

function buildUniqueSelector(el) {
  if (!el || el === document.documentElement) return 'html';
  if (el.id) return `#${CSS.escape(el.id)}`;

  const parts = [];
  let current = el;

  while (current && current !== document.documentElement) {
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }

    let part = current.tagName.toLowerCase();

    // Up to 3 meaningful class names (skip transient state classes)
    const classes = [...current.classList]
      .filter(c => !/^(active|open|hover|focus|selected|is-|has-|js-)/.test(c))
      .slice(0, 3);

    if (classes.length) {
      part += '.' + classes.map(c => CSS.escape(c)).join('.');
    }

    // Disambiguate with :nth-of-type when needed
    if (current.parentNode) {
      const siblings = [...current.parentNode.children].filter(
        s => s.tagName === current.tagName
      );
      if (siblings.length > 1 && !classes.length) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }

    parts.unshift(part);
    current = current.parentElement;

    // Stop early once the path is already unique
    const candidate = parts.join(' > ');
    try {
      if (document.querySelectorAll(candidate).length === 1) break;
    } catch { /* invalid selector mid-build — keep going */ }
  }

  return parts.join(' > ');
}

function captureKeyStyles(el) {
  const cs = window.getComputedStyle(el);
  const props = [
    'display', 'position', 'width', 'height',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border', 'border-radius', 'box-shadow',
    'background-color', 'color', 'font-family', 'font-size', 'font-weight',
    'line-height', 'text-align', 'opacity', 'z-index', 'overflow',
    'flex', 'flex-direction', 'justify-content', 'align-items',
    'max-width', 'min-width', 'top', 'left', 'right', 'bottom',
    'transform', 'transition',
  ];
  return Object.fromEntries(props.map(p => [p, cs.getPropertyValue(p)]));
}

function captureElement(el) {
  const rect = el.getBoundingClientRect();
  return {
    tagName:    el.tagName.toLowerCase(),
    id:         el.id || null,
    classes:    [...el.classList],
    attributes: Object.fromEntries([...el.attributes].map(a => [a.name, a.value])),
    selector:   buildUniqueSelector(el),
    text:       el.textContent?.trim().slice(0, 300) || null,
    innerHTML:  el.innerHTML?.trim().slice(0, 800) || null,
    computedStyles: captureKeyStyles(el),
    dimensions: {
      width:  Math.round(rect.width),
      height: Math.round(rect.height),
    },
    position: {
      top:  Math.round(rect.top  + window.scrollY),
      left: Math.round(rect.left + window.scrollX),
    },
    pageUrl:     window.location.href,
    pageTitle:   document.title,
  };
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'CAPTURE_ELEMENT') return;

  if (!lastTarget) {
    sendResponse({ error: 'No right-click target recorded yet.' });
    return true;
  }

  try {
    const data = captureElement(lastTarget);
    sendResponse({ data });
  } catch (err) {
    sendResponse({ error: err.message });
  }

  return true; // keep channel open for async
});
