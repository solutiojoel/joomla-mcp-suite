/**
 * inspector.js — Element inspection via CDP + Puppeteer
 *
 * All functions accept a Puppeteer Page and/or CDPSession.
 * They return plain JSON-serializable objects.
 */

// CSS properties surfaced by getComputedStyles when no filter is provided
const DEFAULT_COMPUTED_PROPS = [
  'display', 'visibility', 'position', 'top', 'right', 'bottom', 'left',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-width', 'border-style', 'border-color', 'border-radius',
  'background', 'background-color', 'background-image',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'line-height', 'letter-spacing', 'text-align', 'text-decoration',
  'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items',
  'grid', 'grid-template-columns', 'grid-template-rows',
  'z-index', 'overflow', 'overflow-x', 'overflow-y',
  'opacity', 'transform', 'transition', 'box-shadow',
  'cursor', 'pointer-events', 'user-select',
];

/**
 * Resolve a CSS selector to a CDP nodeId.
 * Throws if the element isn't found.
 */
async function resolveNodeId(cdp, selector) {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) {
    throw new Error(`No element found for selector: "${selector}"`);
  }
  return nodeId;
}

export const inspector = {
  /**
   * Full snapshot of an element: tag, id, classes, attributes, dimensions,
   * position, child count, text content, and key computed props.
   */
  async inspect(page, selector) {
    const data = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;

      const rect = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);

      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: [...el.classList],
        attributes: Object.fromEntries([...el.attributes].map(a => [a.name, a.value])),
        text: el.textContent?.trim().slice(0, 300) || null,
        innerHTML: el.innerHTML?.trim().slice(0, 800) || null,
        childCount: el.children.length,
        dimensions: {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        position: {
          top: Math.round(rect.top + window.scrollY),
          left: Math.round(rect.left + window.scrollX),
          bottom: Math.round(rect.bottom + window.scrollY),
          right: Math.round(rect.right + window.scrollX),
        },
        computed: {
          display: cs.display,
          position: cs.position,
          boxSizing: cs.boxSizing,
        },
      };
    }, selector);

    if (!data) throw new Error(`Element not found: "${selector}"`);
    return data;
  },

  /**
   * Computed CSS styles for an element via CDP.
   * Returns all 300+ properties or a filtered subset if `properties` is provided.
   */
  async getComputedStyles(cdp, page, selector, properties) {
    const nodeId = await resolveNodeId(cdp, selector);
    const { computedStyle } = await cdp.send('CSS.getComputedStyleForNode', { nodeId });

    const all = Object.fromEntries(computedStyle.map(p => [p.name, p.value]));

    const keys = properties?.length ? properties : DEFAULT_COMPUTED_PROPS;
    return Object.fromEntries(keys.map(k => [k, all[k] ?? null]));
  },

  /**
   * All CSS rules that match an element, sourced from:
   *   - inline styles
   *   - stylesheets (author rules)
   *   - inherited rules from parent chain
   *
   * Each rule lists its selectors, origin, and CSS properties.
   */
  async getCSSRules(cdp, page, selector) {
    const nodeId = await resolveNodeId(cdp, selector);

    const { matchedCSSRules, inlineStyle, inherited } = await cdp.send(
      'CSS.getMatchedStylesForNode',
      { nodeId }
    );

    function simplifyProps(cssProperties = []) {
      return cssProperties
        .filter(p => !p.implicit && p.value)
        .map(p => ({
          name: p.name,
          value: p.value,
          ...(p.important ? { important: true } : {}),
        }));
    }

    function simplifyRule(rule) {
      return {
        selectors: rule.selectorList?.selectors?.map(s => s.text) ?? [],
        origin: rule.origin,   // 'user-agent' | 'user' | 'regular' | 'inspector'
        properties: simplifyProps(rule.style?.cssProperties),
      };
    }

    return {
      // Styles applied directly via the style attribute
      inline: simplifyProps(inlineStyle?.cssProperties),

      // Stylesheet rules that match this element (most specific last)
      matched: (matchedCSSRules ?? [])
        .map(({ rule }) => simplifyRule(rule))
        .filter(r => r.properties.length > 0),

      // Rules inherited from ancestor elements
      inherited: (inherited ?? [])
        .flatMap(({ matchedCSSRules: rules }) =>
          (rules ?? []).map(({ rule }) => ({ ...simplifyRule(rule), inherited: true }))
        )
        .filter(r => r.properties.length > 0),
    };
  },

  /**
   * Generate a unique, minimal CSS selector path for a given element.
   * Climbs the DOM until it finds a selector that uniquely identifies the element.
   */
  async getUniqueSelector(page, selector) {
    return page.evaluate((sel) => {
      const target = document.querySelector(sel);
      if (!target) return null;

      function buildPath(el) {
        // ID shortcut — always unique
        if (el.id) return `#${CSS.escape(el.id)}`;

        const parts = [];
        let current = el;

        while (current && current !== document.documentElement) {
          if (current.id) {
            parts.unshift(`#${CSS.escape(current.id)}`);
            break;
          }

          let part = current.tagName.toLowerCase();

          // Add up to 3 class names, skipping state classes
          const classes = [...current.classList]
            .filter(c => !/^(active|open|hover|focus|is-|has-|js-)/.test(c))
            .slice(0, 3);

          if (classes.length) {
            part += '.' + classes.map(c => CSS.escape(c)).join('.');
          }

          // Disambiguate with :nth-of-type when siblings share the same tag
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

          // Early exit once selector is already unique
          const candidate = parts.join(' > ');
          if (document.querySelectorAll(candidate).length === 1) return candidate;
        }

        return parts.join(' > ');
      }

      return buildPath(target);
    }, selector);
  },

  /**
   * Query the page DOM.
   * Returns a summary of the matched element(s): tag, id, classes, text.
   */
  async query(page, selector, all = false) {
    return page.evaluate((sel, returnAll) => {
      function summarize(el) {
        const rect = el.getBoundingClientRect();
        return {
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          classes: [...el.classList],
          text: el.textContent?.trim().slice(0, 100) || null,
          visible: rect.width > 0 && rect.height > 0,
        };
      }

      if (returnAll) {
        return [...document.querySelectorAll(sel)].map(summarize);
      }
      const el = document.querySelector(sel);
      return el ? summarize(el) : null;
    }, selector, all);
  },
};
