/**
 * Unit tests for lib/design-compiler.js.
 *
 * Two classes of bug live here, both of which shipped silently once:
 *   1. Particle settings values Gantry accepts but that do not behave the way
 *      its admin select implies (display.title.enabled: "hide").
 *   2. main_container shortcut output — block sizes and section ids. Generated
 *      ids made the section-preservation check read sidebar / mainbar / aside
 *      as deleted on every real save, and `size` was read by nothing.
 *
 * Run: npm test --prefix apps/gantry-mcp
 */
const test = require('node:test');
const assert = require('node:assert');
const compiler = require('../lib/design-compiler');

/* ── Particle settings traps ─────────────────────────────────────────────── */

test('contentarray display.title.enabled "hide" is rejected', () => {
  const errors = compiler.checkParticleSettings('contentarray', { display: { title: { enabled: 'hide' } } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /does not hide the title/);
});

test('blockcontent display.title.enabled "hide" is rejected', () => {
  const errors = compiler.checkParticleSettings('blockcontent', { display: { title: { enabled: 'hide' } } });
  assert.equal(errors.length, 1);
});

test('"" and "show" are both accepted', () => {
  assert.deepEqual(compiler.checkParticleSettings('contentarray', { display: { title: { enabled: '' } } }), []);
  assert.deepEqual(compiler.checkParticleSettings('contentarray', { display: { title: { enabled: 'show' } } }), []);
});

test('the trap does not fire on unrelated subtypes', () => {
  assert.deepEqual(compiler.checkParticleSettings('custom', { display: { title: { enabled: 'hide' } } }), []);
});

test('missing subtype or attributes is not an error', () => {
  assert.deepEqual(compiler.checkParticleSettings('', { display: { title: { enabled: 'hide' } } }), []);
  assert.deepEqual(compiler.checkParticleSettings('contentarray', null), []);
});

test('validateParticleTree walks nested grids and blocks and names the node', () => {
  const errors = compiler.validateParticleTree([
    { type: 'grid', children: [
      { type: 'block', children: [
        { type: 'particle', subtype: 'contentarray', id: 'p1', attributes: { display: { title: { enabled: 'hide' } } } },
      ] },
    ] },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\(id: p1\)/);
});

/* ── main_container shortcut ─────────────────────────────────────────────── */

function compileMain(yamlBody) {
  compiler.resetIds();
  return compiler.compileYaml('schema: 1\nmain_container:\n  layout: sidebar-main-aside\n' + (yamlBody || ''), {});
}

/** The three blocks under container-main, in order. */
function mainBlocks(result) {
  const container = result.layout.find((n) => n.id === 'container-main');
  assert.ok(container, 'container-main must exist');
  return container.children[0].children;
}

test('main_container keeps the conventional container id', () => {
  const r = compileMain();
  assert.ok(r.valid, JSON.stringify(r.errors));
  assert.ok(r.layout.some((n) => n.id === 'container-main'));
});

test('sidebar/mainbar/aside get their conventional ids and section type', () => {
  const blocks = mainBlocks(compileMain());
  assert.deepEqual(blocks.map((b) => b.children[0].id), ['sidebar', 'mainbar', 'aside']);
  assert.deepEqual(blocks.map((b) => b.children[0].type), ['section', 'section', 'section']);
});

test('block sizes default to the 55/30/15 split', () => {
  assert.deepEqual(mainBlocks(compileMain()).map((b) => b.attributes.size), [55, 30, 15]);
});

test('size under each group overrides the default', () => {
  const r = compileMain('  sidebar:\n    size: 2\n  mainbar:\n    size: 83\n  aside:\n    size: 15\n');
  assert.deepEqual(mainBlocks(r).map((b) => b.attributes.size), [2, 83, 15]);
});

test('an omitted group still compiles to its named empty section', () => {
  const r = compileMain('  mainbar:\n    size: 100\n');
  assert.deepEqual(mainBlocks(r).map((b) => b.children[0].id), ['sidebar', 'mainbar', 'aside']);
});

test('an explicit section_id still wins over the default', () => {
  const r = compileMain('  mainbar:\n    section_id: custom-main\n');
  assert.equal(mainBlocks(r)[1].children[0].id, 'custom-main');
});

test('compile rejects a design carrying the title.enabled trap', () => {
  compiler.resetIds();
  const r = compiler.compileYaml(
    'schema: 1\nsections:\n  - id: top\n    grids:\n      - blocks:\n' +
    '          - size: 100\n            particle: contentarray\n            title: News\n' +
    '            attributes:\n              display:\n                title:\n                  enabled: hide\n',
    {}
  );
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /does not hide the title/.test(e)), JSON.stringify(r.errors));
});

/* ── the shape a live particle actually uses ──────────────────────────────
 *
 * The first version of PARTICLE_VALUE_TRAPS matched `display.title.enabled`.
 * Every test above used that shape too, so the suite passed while the check
 * never fired on a real particle: Gantry nests these settings under `article`,
 * and a live dryRun on shannon.forge accepted `hide` without complaint. These
 * cases pin the real shape so the check cannot silently miss it again.
 */

test('contentarray article.display.title.enabled "hide" is rejected', () => {
  const errors = compiler.checkParticleSettings('contentarray', {
    article: { display: { title: { enabled: 'hide' } } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /article\.display\.title\.enabled/);
  assert.match(errors[0], /does not hide the title/);
});

test('blockcontent article.display.title.enabled "hide" is rejected', () => {
  const errors = compiler.checkParticleSettings('blockcontent', {
    article: { display: { title: { enabled: 'hide' } } },
  });
  assert.equal(errors.length, 1);
});

test('the full live attribute tree from a real contentarray is checked', () => {
  // Copied from gantry_particle inspect on shannon.forge outline 75.
  const errors = compiler.checkParticleSettings('contentarray', {
    article: {
      filter: { categories: '', articles: '36', featured: 'include' },
      limit: { total: '1', columns: '1', start: '0' },
      display: { pagination_buttons: '', title: { enabled: 'hide' } },
      sort: { orderby: 'ordering', ordering: 'ASC' },
    },
    enabled: 1,
  });
  assert.equal(errors.length, 1);
});

test('"" and "show" are accepted under the article wrapper too', () => {
  assert.deepEqual(
    compiler.checkParticleSettings('contentarray', { article: { display: { title: { enabled: '' } } } }),
    []
  );
  assert.deepEqual(
    compiler.checkParticleSettings('contentarray', { article: { display: { title: { enabled: 'show' } } } }),
    []
  );
});

test('validateParticleTree catches the article-wrapped shape', () => {
  const errors = compiler.validateParticleTree([
    { type: 'grid', children: [
      { type: 'block', children: [
        {
          type: 'particle',
          subtype: 'contentarray',
          id: 'p9',
          attributes: { article: { display: { title: { enabled: 'hide' } } } },
        },
      ] },
    ] },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\(id: p9\)/);
});
