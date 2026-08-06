/**
 * Unit tests for the pure helpers in lib/layout-api.js.
 *
 * These cover the post-save id resolution added for gantry_layout_add. Gantry
 * rewrites structural ids as it saves, so the only way to hand a caller a
 * usable id is to locate the node by tree position in the saved layout. That
 * translation is easy to get subtly wrong and impossible to notice from a
 * successful-looking add, so it is tested directly.
 *
 * Run: npm test --prefix apps/gantry-mcp
 */
const test = require('node:test');
const assert = require('node:assert');
const api = require('../lib/layout-api');

/** A two-section layout: one section with a particle, one empty. */
function baseStructure() {
  return [
    {
      id: 'header',
      type: 'section',
      subtype: false,
      title: 'Header',
      attributes: {},
      inherit: {},
      children: [
        {
          id: 'grid-1000',
          type: 'grid',
          subtype: false,
          title: 'Untitled',
          attributes: {},
          inherit: {},
          children: [
            {
              id: 'block-1001',
              type: 'block',
              subtype: false,
              title: 'Untitled',
              attributes: { size: 100 },
              inherit: {},
              children: [
                {
                  id: 'logo-1002',
                  type: 'particle',
                  subtype: 'logo',
                  title: 'Logo',
                  attributes: { enabled: 1 },
                  inherit: {},
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'expanded',
      type: 'section',
      subtype: false,
      title: 'Expanded',
      attributes: {},
      inherit: {},
      children: [],
    },
  ];
}

/**
 * Stand in for what Gantry does on save: rewrite every structural id, keeping
 * the tree shape and every other field identical.
 */
function regenerateIds(structure) {
  const clone = JSON.parse(JSON.stringify(structure));
  let n = 5000;
  const rewrite = (nodes) => {
    for (const node of nodes) {
      // Sections keep their ids in Gantry; everything below them is rewritten.
      if (node.type !== 'section') {
        const prefix = node.id.replace(/-\d+$/, '');
        node.id = `${prefix}-${n++}`;
      }
      if (Array.isArray(node.children)) rewrite(node.children);
    }
  };
  rewrite(clone);
  return clone;
}

test('indexPathOf finds a nested node by position', () => {
  const s = baseStructure();
  assert.deepStrictEqual(api.indexPathOf(s, 'logo-1002'), [0, 0, 0, 0]);
  assert.deepStrictEqual(api.indexPathOf(s, 'expanded'), [1]);
  assert.strictEqual(api.indexPathOf(s, 'nope-9999'), null);
});

test('nodeAtIndexPath round-trips with indexPathOf', () => {
  const s = baseStructure();
  const path = api.indexPathOf(s, 'logo-1002');
  assert.strictEqual(api.nodeAtIndexPath(s, path).id, 'logo-1002');
});

test('nodeAtIndexPath returns null when the path runs off the tree', () => {
  const s = baseStructure();
  assert.strictEqual(api.nodeAtIndexPath(s, [0, 0, 0, 7]), null);
  assert.strictEqual(api.nodeAtIndexPath(s, [9]), null);
});

test('resolveSavedNodeId returns the post-save id of an added particle', () => {
  const before = baseStructure();
  const after = JSON.parse(JSON.stringify(before));
  const added = api.addParticleToSection(after, 'expanded', 'particle', 'custom', {
    title: 'My Block',
  });
  const saved = regenerateIds(after);

  const result = api.resolveSavedNodeId(after, saved, added.id);
  assert.strictEqual(result.resolved, true);
  assert.strictEqual(result.changed, true);
  assert.notStrictEqual(result.id, added.id);

  // The id it hands back must actually address the particle in the saved tree.
  const node = api.findNode(saved, result.id);
  assert.ok(node, 'resolved id must exist in the saved layout');
  assert.strictEqual(node.node.type, 'particle');
  assert.strictEqual(node.node.subtype, 'custom');
  assert.strictEqual(node.node.title, 'My Block');
});

test('resolveSavedNodeId reports changed:false when Gantry kept the id', () => {
  const after = baseStructure();
  const saved = JSON.parse(JSON.stringify(after));
  const result = api.resolveSavedNodeId(after, saved, 'logo-1002');
  assert.deepStrictEqual(result, { id: 'logo-1002', changed: false, resolved: true });
});

test('resolveSavedNodeId resolves a particle added next to a sibling', () => {
  const after = baseStructure();
  const added = api.addParticleNextTo(after, 'logo-1002', 'particle', 'menu', {
    title: 'Main Menu',
  });
  const saved = regenerateIds(after);

  const result = api.resolveSavedNodeId(after, saved, added.id);
  assert.strictEqual(result.resolved, true);
  const node = api.findNode(saved, result.id);
  assert.strictEqual(node.node.subtype, 'menu');
  assert.strictEqual(node.node.title, 'Main Menu');
});

test('resolveSavedNodeId refuses to resolve when the trees diverge', () => {
  const after = baseStructure();
  const added = api.addParticleToSection(after, 'expanded', 'particle', 'custom');
  // Gantry dropped the new grid instead of saving it — the same position now
  // holds nothing, so no id may be handed back.
  const saved = regenerateIds(after);
  saved[1].children = [];

  const result = api.resolveSavedNodeId(after, saved, added.id);
  assert.strictEqual(result.resolved, false);
  assert.strictEqual(result.id, added.id, 'must return the pre-save id unchanged');
});

test('resolveSavedNodeId refuses when the position holds a different node type', () => {
  const after = baseStructure();
  const added = api.addParticleToSection(after, 'expanded', 'particle', 'custom');
  const saved = regenerateIds(after);
  // Same position, different particle — a reorder would look like this.
  const path = api.indexPathOf(after, added.id);
  api.nodeAtIndexPath(saved, path).subtype = 'image';

  const result = api.resolveSavedNodeId(after, saved, added.id);
  assert.strictEqual(result.resolved, false);
  assert.strictEqual(result.id, added.id);
});

test('resolveSavedNodeId refuses an id that is not in the posted tree', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  const result = api.resolveSavedNodeId(after, saved, 'ghost-9999');
  assert.strictEqual(result.resolved, false);
  assert.strictEqual(result.id, 'ghost-9999');
});

/* --- ancestor inheritance (clearAncestorInherit) --- */

test('clearAncestorInherit clears the whole path to a freshly added particle', () => {
  const s = baseStructure();
  // An outline duplicated with inherit:true looks like this: the section
  // recomputes its child list from the parent, so anything added under it is
  // discarded on the next read.
  s[1].inherit = { outline: '33', include: ['attributes', 'children'] };
  const added = api.addParticleToSection(s, 'expanded', 'particle', 'custom');

  const result = api.clearAncestorInherit(s, added.id);
  assert.strictEqual(result.broke, true);
  assert.deepStrictEqual(s[1].inherit, {}, 'the section must be local afterwards');
  assert.deepStrictEqual(
    result.previous.map((p) => p.id),
    ['expanded'],
    'must report which node it cleared, so the caller can say what changed',
  );
});

test('clearAncestorInherit reports no change when nothing on the path inherits', () => {
  const s = baseStructure();
  const added = api.addParticleToSection(s, 'expanded', 'particle', 'custom');
  const result = api.clearAncestorInherit(s, added.id);
  assert.strictEqual(result.broke, false);
  assert.deepStrictEqual(result.previous, []);
});

test('clearAncestorInherit leaves the added particle itself untouched', () => {
  const s = baseStructure();
  s[1].inherit = { outline: '33', include: ['children'] };
  const added = api.addParticleToSection(s, 'expanded', 'particle', 'custom', { title: 'Kept' });
  api.clearAncestorInherit(s, added.id);
  const node = api.findNode(s, added.id);
  assert.strictEqual(node.node.title, 'Kept');
  assert.strictEqual(node.node.subtype, 'custom');
});

/* --- readback verification (firstStructuralMismatch) --- */

test('regenerated ids alone do not count as a failed save', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  assert.strictEqual(api.firstStructuralMismatch(after, saved), null);
});

test('attribute key order does not count as a failed save', () => {
  const after = baseStructure();
  const saved = JSON.parse(JSON.stringify(after));
  // A YAML round trip can reorder keys; the content is the same.
  saved[0].children[0].children[0].children[0].attributes = { enabled: 1, extra: 'x' };
  after[0].children[0].children[0].children[0].attributes = { extra: 'x', enabled: 1 };
  assert.strictEqual(api.firstStructuralMismatch(after, saved), null);
});

test('Gantry writing a structural node\'s type into subtype is not a failed save', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  // Observed live: a grid posted with `subtype: false` reads back as "grid",
  // and a block as "block". Server normalization, not a content change.
  saved[0].children[0].subtype = 'grid';
  saved[0].children[0].children[0].subtype = 'block';
  assert.strictEqual(api.firstStructuralMismatch(after, saved), null);
});

test('a particle whose subtype changed is still reported', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  // "particle" is never a valid particle subtype, so normalization must not
  // swallow this the way it swallows grid/block.
  saved[0].children[0].children[0].children[0].subtype = 'particle';
  assert.match(api.firstStructuralMismatch(after, saved), /subtype is "particle"/);
});

test('Gantry dropping the "Untitled" placeholder is not a failed save', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  // Observed live: Gantry omits the title field on grids and blocks entirely.
  delete saved[0].children[0].title;
  delete saved[0].children[0].children[0].title;
  assert.strictEqual(api.firstStructuralMismatch(after, saved), null);
});

test('a particle losing its title is still reported', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  delete saved[0].children[0].children[0].children[0].title;
  assert.match(api.firstStructuralMismatch(after, saved), /title is undefined, expected "Logo"/);
});

test('a dropped node is reported as a mismatch', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  saved[0].children = [];
  const mismatch = api.firstStructuralMismatch(after, saved);
  assert.ok(mismatch, 'must report a mismatch');
  assert.match(mismatch, /expected 1 child node\(s\), saved layout has 0/);
});

test('an attribute Gantry refused to save is reported', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  after[0].children[0].children[0].children[0].attributes.html = '<p>new</p>';
  const mismatch = api.firstStructuralMismatch(after, saved);
  assert.ok(mismatch, 'must report a mismatch');
  assert.match(mismatch, /attributes did not survive the save/);
});

test('a changed node type is reported', () => {
  const after = baseStructure();
  const saved = regenerateIds(after);
  saved[0].children[0].children[0].children[0].subtype = 'image';
  const mismatch = api.firstStructuralMismatch(after, saved);
  assert.match(mismatch, /subtype is "image", expected "logo"/);
});
