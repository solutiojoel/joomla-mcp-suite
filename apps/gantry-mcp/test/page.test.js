/**
 * Unit tests for applyListActions (lib/page.js), the row-merge behind the
 * gantry_page "assets" action (cssActions/javascriptActions).
 *
 * Bug: `name`/`location` sit on the action object as the edit/remove selector,
 * so real row content is meant to go under `item`. Nothing in the schema stops
 * a caller from putting content fields directly on the action instead — and
 * the orchestrator-level tool description doesn't mention `item` at all. That
 * silently produced an all-defaults blank row on `add` and a no-op on `edit`.
 * Confirmed live via dryRun on shannon.forge before the fix (2026-08-06):
 * `{action:"add", name:"repro-test.css", location:"...", priority:"10"}`
 * saved `{"location":"","inline":"","extra":[],"priority":"0","name":""}`.
 *
 * Run: npm test --prefix apps/gantry-mcp
 */
const test = require('node:test');
const assert = require('node:assert');
const { applyListActions } = require('../lib/page');

const CSS_DEFAULTS = { location: '', inline: '', extra: [], priority: '0', name: '' };

test('add with fields directly on the action (the common real-world call shape)', () => {
  const rows = applyListActions([], [
    { action: 'add', name: 'repro-test.css', location: 'gantry-media://theme/css/repro-test.css', priority: '10' },
  ], CSS_DEFAULTS);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], {
    location: 'gantry-media://theme/css/repro-test.css',
    inline: '',
    extra: [],
    priority: '10',
    name: 'repro-test.css',
  });
});

test('add with fields nested under item (the documented shape) still works', () => {
  const rows = applyListActions([], [
    { action: 'add', item: { name: 'nested.css', location: 'content/nested.css', priority: '5' } },
  ], CSS_DEFAULTS);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'nested.css');
  assert.strictEqual(rows[0].location, 'content/nested.css');
  assert.strictEqual(rows[0].priority, '5');
});

test('add with both flat and item fields: item wins on conflict', () => {
  const rows = applyListActions([], [
    { action: 'add', name: 'flat-name.css', item: { name: 'item-name.css', location: 'content/item.css' } },
  ], CSS_DEFAULTS);
  assert.strictEqual(rows[0].name, 'item-name.css');
  assert.strictEqual(rows[0].location, 'content/item.css');
});

test('add with no content at all fails loudly instead of pushing a blank row', () => {
  assert.throws(
    () => applyListActions([], [{ action: 'add' }], CSS_DEFAULTS),
    /requires at least one row field/,
  );
});

test('edit by name, with the new value on the action itself, applies it', () => {
  const existing = [{ location: 'old/path.css', inline: '', extra: [], priority: '0', name: 'Override' }];
  const rows = applyListActions(existing, [
    { action: 'edit', name: 'Override', location: 'new/path.css', priority: '9' },
  ], CSS_DEFAULTS);
  assert.strictEqual(rows[0].location, 'new/path.css');
  assert.strictEqual(rows[0].priority, '9');
  assert.strictEqual(rows[0].name, 'Override');
});

test('edit leaves fields not mentioned in the action or item untouched', () => {
  const existing = [{ location: 'a.css', inline: 'body{}', extra: [{ x: 1 }], priority: '3', name: 'Keep Me' }];
  const rows = applyListActions(existing, [
    { action: 'edit', index: 0, item: { priority: '7' } },
  ], CSS_DEFAULTS);
  assert.strictEqual(rows[0].priority, '7');
  assert.strictEqual(rows[0].inline, 'body{}');
  assert.deepStrictEqual(rows[0].extra, [{ x: 1 }]);
  assert.strictEqual(rows[0].name, 'Keep Me');
});

test('remove is unaffected by the content-extraction change', () => {
  const existing = [
    { location: 'a.css', inline: '', extra: [], priority: '0', name: 'A' },
    { location: 'b.css', inline: '', extra: [], priority: '0', name: 'B' },
  ];
  const rows = applyListActions(existing, [{ action: 'remove', name: 'A' }], CSS_DEFAULTS);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'B');
});
