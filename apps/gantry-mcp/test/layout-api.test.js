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

/* ── editBlockAttrs: resolve a block from the node it wraps ──────────────── */
//
// The blocks around the main-container sections carry generated ids a caller
// has no handy way to read, so resizing sidebar / mainbar / aside failed with
// "Block not found" and had no supported path at all.

/** A main container: one grid holding three section-wrapping blocks. */
function mainContainerStructure() {
  return [
    {
      id: 'container-main', type: 'container', children: [
        {
          id: 'grid-1', type: 'grid', children: [
            { id: 'block-1', type: 'block', attributes: { size: 55 }, children: [{ id: 'sidebar', type: 'section', children: [] }] },
            { id: 'block-2', type: 'block', attributes: { size: 30 }, children: [{ id: 'mainbar', type: 'section', children: [] }] },
            { id: 'block-3', type: 'block', attributes: { size: 15 }, children: [{ id: 'aside', type: 'section', children: [] }] },
          ],
        },
      ],
    },
  ];
}

test('editBlockAttrs accepts the id of the section a block wraps', () => {
  const s = mainContainerStructure();
  api.editBlockAttrs(s, 'mainbar', { size: 83 });
  assert.equal(s[0].children[0].children[1].attributes.size, 83);
  // The wrapped section itself must not gain the attribute.
  assert.equal(s[0].children[0].children[1].children[0].attributes, undefined);
});

test('editBlockAttrs still accepts the block id directly', () => {
  const s = mainContainerStructure();
  api.editBlockAttrs(s, 'block-1', { size: 2, class: 'g-offset-20' });
  assert.equal(s[0].children[0].children[0].attributes.size, 2);
  assert.equal(s[0].children[0].children[0].attributes.class, 'g-offset-20');
});

test('editBlockAttrs names the child-id fallback when nothing matches', () => {
  const s = mainContainerStructure();
  assert.throws(() => api.editBlockAttrs(s, 'nope', { size: 1 }), /the id of the node it wraps/);
});

test('editBlockAttrs refuses a node that is not wrapped by a block', () => {
  const s = mainContainerStructure();
  assert.throws(() => api.editBlockAttrs(s, 'grid-1', { size: 1 }), /not a block, and is not wrapped by one/);
});

/* ── block sizing on add ──────────────────────────────────────────────────
 *
 * `gantry_particle add` accepted a `size` and then dropped it on the `to`
 * path: addParticleToSection never read the option, and its firstGrid branch
 * always wrote an equal split. A caller who asked for 70/30 got 50/50 with a
 * successful-looking save, which read as a platform bug for months.
 *
 * The other half is real Gantry behaviour: a block size of 0 means "unset", so
 * Gantry re-splits the row equally on save. A split that zeroes a block is now
 * refused up front rather than saved as a lie.
 */

/** One section holding one grid with a single full-width block. */
function oneBlockGrid() {
  return [
    {
      id: 'expanded',
      type: 'section',
      subtype: false,
      title: 'Expanded',
      attributes: {},
      inherit: {},
      children: [
        {
          id: 'grid-9',
          type: 'grid',
          subtype: false,
          title: 'Untitled',
          attributes: {},
          inherit: {},
          children: [
            {
              id: 'block-9',
              type: 'block',
              subtype: false,
              title: 'Untitled',
              attributes: { size: 100 },
              inherit: {},
              children: [
                {
                  id: 'swiper-1',
                  type: 'particle',
                  subtype: 'swiper',
                  title: 'Hero',
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
  ];
}

const gridBlocks = (s) => s[0].children[0].children;

test('addParticleToSection firstGrid honours an unequal size', () => {
  const s = oneBlockGrid();
  api.addParticleToSection(s, 'expanded', 'particle', 'custom', {
    title: 'Side',
    mode: 'firstGrid',
    size: 30,
  });
  assert.deepEqual(gridBlocks(s).map((b) => b.attributes.size), [70, 30]);
});

test('addParticleToSection firstGrid still equal-splits with no size', () => {
  const s = oneBlockGrid();
  api.addParticleToSection(s, 'expanded', 'particle', 'custom', { mode: 'firstGrid' });
  assert.deepEqual(gridBlocks(s).map((b) => b.attributes.size), [50, 50]);
});

test('addParticleToSection refuses a size that zeroes a sibling', () => {
  const s = oneBlockGrid();
  assert.throws(
    () => api.addParticleToSection(s, 'expanded', 'particle', 'custom', { mode: 'firstGrid', size: 100 }),
    /leaves a block below 1%/
  );
  // The refusal must happen before any mutation.
  assert.equal(gridBlocks(s).length, 1);
  assert.equal(gridBlocks(s)[0].attributes.size, 100);
});

test('addParticleToSection refuses size 0 for the new block', () => {
  const s = oneBlockGrid();
  assert.throws(
    () => api.addParticleToSection(s, 'expanded', 'particle', 'custom', { mode: 'firstGrid', size: 0 }),
    /leaves a block below 1%/
  );
});

test('the zero-size refusal points at the CSS overlay route', () => {
  const s = oneBlockGrid();
  assert.throws(
    () => api.addParticleToSection(s, 'expanded', 'particle', 'custom', { mode: 'firstGrid', size: 100 }),
    /set a `class` on the block and position it in CSS/
  );
});

test('addParticleToSection refuses size with mode newGrid', () => {
  const s = oneBlockGrid();
  assert.throws(
    () => api.addParticleToSection(s, 'expanded', 'particle', 'custom', { size: 70 }),
    /no meaning with mode "newGrid"/
  );
});

test('addParticleNextTo honours an unequal size', () => {
  const s = oneBlockGrid();
  api.addParticleNextTo(s, 'swiper-1', 'particle', 'custom', { title: 'Side', size: 25 });
  assert.deepEqual(gridBlocks(s).map((b) => b.attributes.size), [75, 25]);
});

test('addParticleNextTo refuses a size that zeroes a sibling', () => {
  const s = oneBlockGrid();
  assert.throws(
    () => api.addParticleNextTo(s, 'swiper-1', 'particle', 'custom', { size: 100 }),
    /leaves a block below 1%/
  );
  assert.equal(gridBlocks(s).length, 1);
});

test('splitSiblingSizes rescales two siblings in proportion', () => {
  const blocks = [{ attributes: { size: 75 } }, { attributes: { size: 25 } }];
  const newSize = api.splitSiblingSizes(blocks, 40, 'test row');
  assert.equal(newSize, 40);
  assert.deepEqual(blocks.map((b) => b.attributes.size), [45, 15]);
});

test('splitSiblingSizes treats a missing sibling size as an equal share', () => {
  const blocks = [{ attributes: {} }, { attributes: {} }];
  api.splitSiblingSizes(blocks, 50, 'test row');
  assert.deepEqual(blocks.map((b) => b.attributes.size), [25, 25]);
});

test('splitSiblingSizes rejects a non-numeric size', () => {
  assert.throws(
    // A string arrives here from a hand-written MCP call, which is the point.
    () => api.splitSiblingSizes([{ attributes: { size: 100 } }], /** @type {any} */ ('70'), 'test row'),
    /must be a finite number/
  );
});

/* ── whole-percent rounding ───────────────────────────────────────────────
 *
 * Gantry rewrites block sizes at low precision. A row saved as
 * 26.67/26.67/26.67/20 read back 27/27/27/20 on shannon.forge, so the
 * post-save check reported "attributes did not survive the save" on a save
 * that had worked. Whole percents make the written value the read-back value.
 */

test('equalSizes splits three ways as whole percents totalling 100', () => {
  assert.deepEqual(api.equalSizes(3), [34, 33, 33]);
  assert.equal(api.equalSizes(3).reduce((a, b) => a + b, 0), 100);
});

test('equalSizes is exact when the split divides evenly', () => {
  assert.deepEqual(api.equalSizes(2), [50, 50]);
  assert.deepEqual(api.equalSizes(4), [25, 25, 25, 25]);
});

test('roundSizesTo100 gives the leftover to the largest fractions', () => {
  assert.deepEqual(api.roundSizesTo100([26.67, 26.67, 26.67, 20]), [27, 27, 26, 20]);
  assert.equal(api.roundSizesTo100([26.67, 26.67, 26.67, 20]).reduce((a, b) => a + b, 0), 100);
});

test('a fractional split is rounded to whole percents before it is written', () => {
  const s = oneBlockGrid();
  api.addParticleToSection(s, 'expanded', 'particle', 'custom', { mode: 'firstGrid', size: 33.4 });
  const row = gridBlocks(s).map((b) => b.attributes.size);
  assert.ok(row.every((n) => Number.isInteger(n)), `not whole percents: ${row}`);
  assert.equal(row.reduce((a, b) => a + b, 0), 100);
});

test('a three-way rebalance after a size add still totals 100', () => {
  const s = oneBlockGrid();
  api.addParticleToSection(s, 'expanded', 'particle', 'custom', { mode: 'firstGrid' });
  api.addParticleToSection(s, 'expanded', 'particle', 'custom', { mode: 'firstGrid' });
  const row = gridBlocks(s).map((b) => b.attributes.size);
  assert.equal(row.reduce((a, b) => a + b, 0), 100);
  assert.ok(row.every((n) => Number.isInteger(n)), `not whole percents: ${row}`);
});

test('a split that rounds a sibling below one percent is refused', () => {
  const s = oneBlockGrid();
  assert.throws(
    () => api.addParticleToSection(s, 'expanded', 'particle', 'custom', { mode: 'firstGrid', size: 99.7 }),
    /leaves a block below 1%/
  );
});
