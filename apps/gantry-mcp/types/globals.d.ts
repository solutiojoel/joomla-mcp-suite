/**
 * Types for the browser-side globals this server drives through Puppeteer.
 *
 * Everything inside a `page.evaluate()` callback runs in the Gantry admin page,
 * not in Node. TypeScript checks those callback bodies against the DOM lib, so
 * without a declaration for Gantry's own global every `window.G5` read is an
 * error — which would drown the real findings.
 */

/** Gantry's layout-manager builder, as exposed on the admin page. */
interface G5LayoutBuilder {
  serialize(): unknown[];
  setStructure(structure: unknown): void;
  [key: string]: unknown;
}

interface G5LayoutManager {
  builder: G5LayoutBuilder;
  [key: string]: unknown;
}

interface G5Global {
  lm: G5LayoutManager;
  [key: string]: unknown;
}

interface Window {
  G5: G5Global;
}
