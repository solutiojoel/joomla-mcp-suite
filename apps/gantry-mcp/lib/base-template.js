'use strict';
/**
 * lib/base-template.js
 *
 * Loads the base home template (agent7 #Home outline) and provides
 * mergeWithBaseTemplate() — used by gantry_layout_import to ensure:
 *
 *  1. All containers (container-top, container-main, container-footer)
 *     are always present.
 *  2. Fixed sections (navigation, bottom, footer, copyright, offcanvas)
 *     always carry their inherit settings from the base template.
 *  3. Top section always keeps its fixed particles.
 *  4. Customizable sections accept whatever the incoming layout provides;
 *     empty customizable sections are kept as empty nodes.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const TEMPLATE_PATH = path.join(__dirname, '..', 'exports', 'base-home-template.yaml');

let _loaded = null;
function loadTemplate() {
  if (_loaded) return _loaded;
  if (!fs.existsSync(TEMPLATE_PATH)) return (_loaded = null);
  try {
    const bt = yaml.load(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
    _loaded = {
      layout:       bt.layout || [],
      fixedSections: bt.fixedSections || {},
    };
    return _loaded;
  } catch (e) {
    console.warn('[base-template] Could not load:', e.message);
    return (_loaded = null);
  }
}

const ALWAYS_INHERIT = new Set(['navigation', 'bottom', 'footer', 'copyright', 'offcanvas']);
const ALWAYS_FIXED   = new Set(['top']);

/**
 * Recursively find a node by id in a layout tree.
 */
function findById(nodes, id) {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findById(n.children, id);
    if (f) return f;
  }
  return null;
}

/**
 * Build a flat map of sectionId -> section node from an incoming layout array.
 */
function flattenSections(nodes, out = {}) {
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes) {
    if (n.type === 'section' || n.type === 'offcanvas') {
      out[n.id] = n;
    }
    flattenSections(n.children, out);
  }
  return out;
}

/**
 * Patch a cloned base-template node using the incoming sections map.
 * - Fixed/inherit sections: use base template's inherit settings, ignoring incoming
 * - Top: keep base template's particles, ignoring incoming
 * - Customizable: use incoming children/attributes if present
 */
function patchNode(node, incoming) {
  if (!node || typeof node !== 'object') return;
  const sid       = node.id;
  const isSection = node.type === 'section' || node.type === 'offcanvas';

  if (isSection && sid) {
    if (ALWAYS_INHERIT.has(sid) || ALWAYS_FIXED.has(sid)) {
      return; // keep base template node exactly
    }
    const src = incoming[sid];
    if (src) {
      node.children  = src.children || [];
      if (src.attributes) {
        node.attributes = Object.assign({}, node.attributes || {}, {
          class:      src.attributes.class      || (node.attributes && node.attributes.class)      || '',
          variations: src.attributes.variations || (node.attributes && node.attributes.variations) || '',
          boxed: (node.attributes && node.attributes.boxed != null)
                   ? node.attributes.boxed
                   : (src.attributes.boxed || '2'),
        });
      }
    } else {
      node.children = node.children || [];
    }
    return;
  }

  if (Array.isArray(node.children)) {
    node.children.forEach(n => patchNode(n, incoming));
  }
}

/**
 * Merge an incoming layout with the base template rules.
 * Returns the merged layout array (ready to pass to saveLayoutDirect).
 *
 * If no base template is found, returns the incoming layout unchanged
 * (graceful fallback).
 */
function mergeWithBaseTemplate(incomingLayout) {
  const tmpl = loadTemplate();
  if (!tmpl || !tmpl.layout.length) {
    return incomingLayout; // no template — pass through
  }

  // Build a map of incoming sections
  const incoming = flattenSections(incomingLayout);

  // Deep-clone the base template and patch
  const merged = JSON.parse(JSON.stringify(tmpl.layout));
  merged.forEach(n => patchNode(n, incoming));
  return merged;
}

module.exports = { mergeWithBaseTemplate, ALWAYS_INHERIT, ALWAYS_FIXED, loadTemplate };
