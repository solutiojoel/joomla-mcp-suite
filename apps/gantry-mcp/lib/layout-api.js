'use strict';

/**
 * JSON-based Layout API.
 *
 * Bypasses Gantry's drag/drop UI entirely — modifies the in-memory layout
 * structure via `window.G5.lm.builder.serialize()` / `setStructure(json)`,
 * then triggers Save Layout. Way more reliable than synthesized mouse drags
 * through CDP.
 *
 * The serialized structure is an array of nodes:
 *   { id, type, subtype, title, attributes, inherit, children: [...] }
 *
 * Types observed: container | section | offcanvas | grid | block | particle | system | spacer | position
 */

const { sleep, snap } = require('./util');
const backup = require('./backup');

/**
 * One node of a serialized Gantry layout.
 *
 * @typedef {object} LayoutNode
 * @property {string} id Structural id. Gantry reassigns these on save — see resolveSavedNodeId.
 * @property {string} type container | section | offcanvas | grid | block | particle | system | spacer | position
 * @property {string|boolean} [subtype] Particle name; `false` on a structural node as posted, and the node's own type on read-back.
 * @property {string} [title] Display title. Gantry drops the "Untitled" placeholder on grids and blocks.
 * @property {Record<string, any>} [attributes]
 * @property {Record<string, any>} [inherit] Non-empty when the node is inherited from a parent outline.
 * @property {LayoutNode[]} [children]
 */

/**
 * What findNode returns. This is NOT a node — it is a node plus where it sits.
 *
 * Reading it as a node is the bug that shipped here once already: four call
 * sites used the result directly and every one failed at runtime with
 * `Node "X" is type "undefined"`. Destructure `.node`.
 *
 * @typedef {object} FoundNode
 * @property {LayoutNode} node
 * @property {LayoutNode|null} parent Null when the node is at the root of the structure.
 * @property {number} index Position within its parent's children (or the root array).
 */

/**
 * Random id like "branding-7421". Keeps Gantry's existing id convention.
 */
function freshId(prefix) {
  return `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
}

/* ============================================================
 *  Pure helpers — operate on a structure JSON, no Page needed
 * ============================================================ */

/**
 * Walk the tree and call cb(node, parent, index, depth) for each node.
 * Stops if cb returns true.
 */
function walk(structure, cb, parent = null, depth = 0) {
  if (!Array.isArray(structure)) return false;
  for (let i = 0; i < structure.length; i++) {
    const node = structure[i];
    if (cb(node, parent, i, depth)) return true;
    if (Array.isArray(node.children)) {
      if (walk(node.children, cb, node, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Find a node by id (or matching predicate).
 *
 * Returns a {@link FoundNode} wrapper, not the node — callers must destructure
 * `.node`. See the FoundNode typedef for why that is spelled out.
 *
 * @param {LayoutNode[]} structure
 * @param {string|((node: LayoutNode) => boolean)} idOrFn
 * @returns {FoundNode|null}
 */
function findNode(structure, idOrFn) {
  let result = null;
  const matcher =
    typeof idOrFn === 'function' ? idOrFn : (n) => n.id === idOrFn;
  walk(structure, (node, parent, index) => {
    if (matcher(node)) {
      result = { node, parent, index };
      return true;
    }
    return false;
  });
  return result;
}

/**
 * Remove a node by id; returns the removed node (or null).
 */
function removeNode(structure, id) {
  const found = findNode(structure, id);
  if (!found) return null;
  const siblings = found.parent ? found.parent.children : structure;
  siblings.splice(found.index, 1);
  return found.node;
}

/**
 * Build a fresh layout node ready to drop into a block.
 *
 * Gantry layout nodes come in four block-types (the `type` field):
 *   - "particle"  → an actual Gantry particle. id is `<subtype>-NNNN`
 *                   Examples: blockcontent, customhtml, logo, menu, video, search, ...
 *   - "position"  → a Joomla module placeholder.  id is `position-<subtype>-NNNN`
 *                   subtype="module" (Module Instance) or "position" (Module Position)
 *   - "spacer"    → blank visual spacer. id is `spacer-NNNN`. subtype="spacer".
 *   - "system"    → Joomla content (Page Content, System Messages).
 *                   id is `system-<subtype>-NNNN`.
 *                   subtype="content" (Page Content) or "messages" (System Messages)
 *
 *   `title`: display title (optional)
 *   `attrs`: attribute object — fields in the settings dialog
 */
function makeParticleNode(blocktype, subtype, title = '', attrs = {}) {
  // Pick the id prefix matching what Gantry's picker would produce
  let idPrefix;
  if (blocktype === 'particle') idPrefix = subtype;
  else if (blocktype === 'spacer') idPrefix = 'spacer';
  else idPrefix = `${blocktype}-${subtype}`; // position-module, system-content, ...

  return {
    id: freshId(idPrefix),
    type: blocktype,
    subtype,
    title: title || subtype.charAt(0).toUpperCase() + subtype.slice(1),
    attributes: blocktype === 'particle' ? { enabled: 1, ...attrs } : { ...attrs },
    inherit: {},
    children: [],
  };
}

function makeBlockNode(particle, sizePct = 100, blockClass = '') {
  return {
    id: freshId('block'),
    type: 'block',
    subtype: false,
    title: 'Untitled',
    attributes: blockClass ? { size: sizePct, class: blockClass } : { size: sizePct },
    inherit: {},
    children: [particle],
  };
}

function makeGridNode(blocks) {
  return {
    id: freshId('grid'),
    type: 'grid',
    subtype: false,
    title: 'Untitled',
    attributes: {},
    inherit: {},
    children: Array.isArray(blocks) ? blocks : [blocks],
  };
}

/**
 * Add a new node (particle / position / spacer / system) to a section.
 *
 *   addParticleToSection(structure, "expanded", "particle", "blockcontent", { title: "My Block" })
 *   addParticleToSection(structure, "expanded", "spacer",   "spacer")
 *   addParticleToSection(structure, "expanded", "system",   "content")        // Page Content
 *   addParticleToSection(structure, "expanded", "system",   "messages")       // System Messages
 *   addParticleToSection(structure, "navigation","position","module")         // Module Instance
 *
 * mode = "newGrid" (default): drops a new full-width grid below existing.
 * mode = "firstGrid": appends as a sibling block in the first grid (auto-resize).
 *
 * Returns the new node (so the caller can read its id).
 */
function addParticleToSection(structure, sectionId, blocktype, subtype, opts = {}) {
  const { title, attrs, mode = 'newGrid' } = opts;
  const target = findNode(structure, sectionId);
  if (!target) throw new Error(`Section "${sectionId}" not found in layout`);
  if (!['section', 'container', 'offcanvas'].includes(target.node.type)) {
    throw new Error(
      `Target "${sectionId}" is a ${target.node.type}; can only append into section/container/offcanvas.`
    );
  }
  const node = makeParticleNode(blocktype, subtype, title, attrs);
  // Empty sections have no `children` key at all in the exported JSON.
  // Initialize it so both modes can safely push into it.
  if (!Array.isArray(target.node.children)) target.node.children = [];
  if (mode === 'newGrid') {
    const block = makeBlockNode(node, 100);
    const grid = makeGridNode(block);
    target.node.children.push(grid);
  } else if (mode === 'firstGrid') {
    // Append as a new sibling block in the first grid (auto-resize-on-render)
    const grid = target.node.children.find((c) => c.type === 'grid');
    if (!grid) {
      const block = makeBlockNode(node, 100);
      target.node.children.push(makeGridNode(block));
    } else {
      const blocks = grid.children || (grid.children = []);
      const newSize = Number((100 / (blocks.length + 1)).toFixed(2));
      blocks.forEach((b) => {
        if (b.attributes) b.attributes.size = newSize;
      });
      blocks.push(makeBlockNode(node, newSize));
    }
  }
  return node;
}

/**
 * Parse a Gantry form-field name into a path array.
 *   "particles[contentarray][article][limit][total]"
 *     -> ["particles", "contentarray", "article", "limit", "total"]
 */
function parseFieldName(name) {
  return name.replace(/\]/g, '').split(/\[/);
}

/**
 * Recursively merge `patch` into `target` and return a new object.
 * Plain objects merge key by key; arrays and scalars replace outright, because a
 * particle repeater (slides, links) is always supplied whole, never patched
 * element by element — use editRepeaterItem for that.
 */
function deepMerge(target, patch) {
  const isPlain = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlain(target) || !isPlain(patch)) return patch;
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Set a deep path (array of keys) on `obj` to `value`, creating intermediate objects. */
function setDeep(obj, pathKeys, value) {
  let cur = obj;
  for (let i = 0; i < pathKeys.length - 1; i++) {
    const k = pathKeys[i];
    if (cur[k] == null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[pathKeys[pathKeys.length - 1]] = value;
}

/**
 * Apply a flat map of Gantry-style form-field edits to a particle node, by
 * routing each key into the right JSON location:
 *
 *   particles[<subtype>][a][b]  → particle.attributes.a.b
 *   block[a][b]                 → wrapping-block.attributes.a.b
 *   inherit[a][b]               → particle.inherit.a.b
 *
 *   editParticleFromForm(structure, "contentarray-6583", {
 *     "particles[contentarray][title]": "New",
 *     "block[size]": 50,
 *     "inherit[mode]": "clone",
 *   })
 */
function editParticleFromForm(structure, particleId, edits) {
  const found = findNode(structure, particleId);
  if (!found) {
    // Two known reasons a particle ID is not found:
    //
    // 1. INHERITED PARTICLES — Particles inherited from a parent outline (e.g. Base)
    //    are present in the layout tree but their IDs are generated at runtime and are
    //    NOT saved in this outline's YAML. They cannot be edited here; edit them on
    //    the source outline (usually "default"/Base Outline) instead.
    //
    // 2. STALE ID — If a layout-modifying operation (add, import) was called, all
    //    structural IDs (grids, blocks) and some particle IDs are regenerated on the
    //    next save. Always call gantry_layout_list(editable:true) after any mutation
    //    and use the IDs it returns — never rely on IDs from a prior tree/list call.
    throw new Error(`Particle "${particleId}" not found`);
  }
  const blockEntry = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(found.node)
  );
  for (const [name, value] of Object.entries(edits)) {
    const tokens = parseFieldName(name);
    const top = tokens[0];
    if (top === 'particles') {
      // tokens[1] is the subtype name; the rest is the path inside attributes.
      if (!found.node.attributes) found.node.attributes = {};
      setDeep(found.node.attributes, tokens.slice(2), value);
    } else if (top === 'block') {
      if (!blockEntry) throw new Error(`No wrapping block found for ${particleId}`);
      if (!blockEntry.node.attributes) blockEntry.node.attributes = {};
      setDeep(blockEntry.node.attributes, tokens.slice(1), value);
    } else if (top === 'inherit') {
      if (!found.node.inherit) found.node.inherit = {};
      setDeep(found.node.inherit, tokens.slice(1), value);
    } else {
      // unrecognised top-level: store as direct property on the node
      setDeep(found.node, tokens, value);
    }
  }
  return found.node;
}

/**
 * Add a new node as a sibling block in the same grid as an existing particle.
 * Auto-resizes existing siblings to share the row equally, unless --size is
 * passed (in which case the new block takes that width and existing blocks
 * share the remainder proportionally).
 *
 *   addParticleNextTo(structure, "contentarray-6583", "particle", "custom",
 *                     { title: "Side", size: 25 })
 *
 * Returns the new node.
 */
function addParticleNextTo(structure, siblingId, blocktype, subtype, opts = {}) {
  const { title, attrs, size } = opts;
  const found = findNode(structure, siblingId);
  if (!found) throw new Error(`Sibling "${siblingId}" not found in layout`);

  // Walk up to the wrapping block, then to its grid
  const block = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(found.node)
  );
  if (!block || block.node.type !== 'block') {
    throw new Error(`Could not find block wrapping "${siblingId}"`);
  }
  const grid = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(block.node)
  );
  if (!grid || grid.node.type !== 'grid') {
    throw new Error(`Could not find grid wrapping "${siblingId}"`);
  }

  const node = makeParticleNode(blocktype, subtype, title, attrs);
  const blocks = grid.node.children;

  if (typeof size === 'number') {
    // Caller specified a width for the new block; rescale others to fit.
    const remaining = 100 - size;
    const oldTotal = blocks.reduce((sum, b) => sum + (Number(b.attributes?.size) || 0), 0) || 100;
    blocks.forEach((b) => {
      if (b.attributes) {
        const cur = Number(b.attributes.size) || 0;
        b.attributes.size = Number(((cur / oldTotal) * remaining).toFixed(2));
      }
    });
    blocks.push(makeBlockNode(node, Number(size.toFixed(2))));
  } else {
    // Equal split among existing siblings + new block
    const newSize = Number((100 / (blocks.length + 1)).toFixed(2));
    blocks.forEach((b) => {
      if (b.attributes) b.attributes.size = newSize;
    });
    blocks.push(makeBlockNode(node, newSize));
  }
  return node;
}

/**
 * Move a particle (by id) into a target section. The particle keeps its block
 * wrapper. The target section receives a new full-width grid containing the
 * particle's block.
 */
function moveParticleToSection(structure, particleId, targetSectionId) {
  const found = findNode(structure, particleId);
  if (!found) throw new Error(`Particle "${particleId}" not found`);
  if (found.node.type !== 'particle' && found.node.type !== 'system' && found.node.type !== 'position' && found.node.type !== 'spacer') {
    throw new Error(`"${particleId}" is type ${found.node.type}; only particles/system/position/spacer can be moved`);
  }
  const target = findNode(structure, targetSectionId);
  if (!target) throw new Error(`Target section "${targetSectionId}" not found`);

  // Find the block wrapping this particle
  const blockEntry = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(found.node)
  );
  if (!blockEntry) throw new Error('Could not locate block wrapping the particle');
  const block = blockEntry.node;

  // Find the grid wrapping that block, and remove the block from it
  const gridEntry = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(block)
  );
  if (!gridEntry) throw new Error('Could not locate grid wrapping the block');
  const idx = gridEntry.node.children.indexOf(block);
  gridEntry.node.children.splice(idx, 1);
  // If the grid is now empty, remove it from its parent
  if (gridEntry.node.children.length === 0) {
    const sec = gridEntry.parent;
    if (sec) sec.children.splice(sec.children.indexOf(gridEntry.node), 1);
  } else {
    // Re-balance sibling block sizes
    const remaining = gridEntry.node.children;
    const newSize = Number((100 / remaining.length).toFixed(2));
    remaining.forEach((b) => {
      if (b.attributes) b.attributes.size = newSize;
    });
  }
  // Drop into a new full-width grid in the target
  block.attributes.size = 100;
  target.node.children.push(makeGridNode(block));
  return found.node;
}

/**
 * Move a particle (by id) so it sits next to another particle (in the same
 * grid). Equal-splits sizes by default.
 */
function moveParticleNextTo(structure, particleId, siblingId) {
  const movingFound = findNode(structure, particleId);
  if (!movingFound) throw new Error(`Particle "${particleId}" not found`);
  const sibFound = findNode(structure, siblingId);
  if (!sibFound) throw new Error(`Sibling "${siblingId}" not found`);

  // Identify wrappers
  const movingBlock = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(movingFound.node)
  );
  const movingGrid = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(movingBlock.node)
  );
  const sibBlock = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(sibFound.node)
  );
  const targetGrid = findNode(structure, (n) =>
    Array.isArray(n.children) && n.children.includes(sibBlock.node)
  );

  if (movingGrid.node === targetGrid.node) {
    // Already in same grid — no-op (but rebalance just in case)
    const blocks = targetGrid.node.children;
    const newSize = Number((100 / blocks.length).toFixed(2));
    blocks.forEach((b) => {
      if (b.attributes) b.attributes.size = newSize;
    });
    return movingFound.node;
  }

  // Remove the block from its current grid
  const idx = movingGrid.node.children.indexOf(movingBlock.node);
  movingGrid.node.children.splice(idx, 1);
  if (movingGrid.node.children.length === 0) {
    const sec = movingGrid.parent;
    if (sec) sec.children.splice(sec.children.indexOf(movingGrid.node), 1);
  } else {
    const remaining = movingGrid.node.children;
    const newSize = Number((100 / remaining.length).toFixed(2));
    remaining.forEach((b) => {
      if (b.attributes) b.attributes.size = newSize;
    });
  }

  // Insert into the target grid right after the sibling
  const sibIdx = targetGrid.node.children.indexOf(sibBlock.node);
  targetGrid.node.children.splice(sibIdx + 1, 0, movingBlock.node);
  const after = targetGrid.node.children;
  const newSize = Number((100 / after.length).toFixed(2));
  after.forEach((b) => {
    if (b.attributes) b.attributes.size = newSize;
  });
  return movingFound.node;
}

/* ============================================================
 *  Section-level ops (inherit / clone / attribute edits)
 * ============================================================ */

/**
 * Patch a section's `attributes` object (class, boxed, variations, extras…).
 *   editSectionAttrs(structure, "expanded", { class: "my-cls", boxed: "1" })
 */
function editSectionAttrs(structure, sectionId, attrs) {
  const found = findNode(structure, sectionId);
  if (!found) throw new Error(`Section "${sectionId}" not found`);
  if (!found.node.attributes) found.node.attributes = {};
  Object.assign(found.node.attributes, attrs);
  return found.node;
}

/**
 * Add/remove CSS classes on a section's `attributes.class` string.
 *   addSectionClasses(structure, "expanded", ["sticky", "narrow"])
 *   addSectionClasses(structure, "expanded", [], ["narrow"])  // remove
 */
function addSectionClasses(structure, sectionId, add = [], remove = []) {
  const found = findNode(structure, sectionId);
  if (!found) throw new Error(`Section "${sectionId}" not found`);
  if (!found.node.attributes) found.node.attributes = {};
  const current = String(found.node.attributes.class || '').split(/\s+/).filter(Boolean);
  const set = new Set(current);
  add.forEach((c) => set.add(c));
  remove.forEach((c) => set.delete(c));
  found.node.attributes.class = [...set].join(' ');
  return found.node;
}

/**
 * Mark a node as inheriting from a parent outline.
 *   setNodeInherit(structure, "expanded", { outline: "default", include: ["children","attributes","block"] })
 *
 * `include` controls what to inherit (Gantry uses values like
 * "children", "attributes", "block").
 */
function setNodeInherit(structure, nodeId, inherit) {
  const found = findNode(structure, nodeId);
  if (!found) throw new Error(`Node "${nodeId}" not found`);
  found.node.inherit = { ...(inherit || {}) };
  return found.node;
}

function cloneDeep(value) {
  return JSON.parse(JSON.stringify(value));
}

function clearInheritDeep(node) {
  if (!node || typeof node !== 'object') return node;
  node.inherit = {};
  if (Array.isArray(node.children)) {
    node.children.forEach(clearInheritDeep);
  }
  return node;
}

/**
 * Break inheritance on a node AND every particle underneath it. Gantry tracks
 * inheritance at two independent levels: the node's own `inherit` pointer
 * (which children/particles exist) and each descendant particle's own
 * `inherit` block (whether that particle's `attributes`/`block` still
 * resolve live from a parent-outline counterpart). Clearing only the node's
 * own field leaves every child particle silently re-resolving its attributes
 * from the parent outline on every read — edits to those particles appear to
 * save but have no visible effect. Recursing with `clearInheritDeep` clears
 * both layers in one call, so the section is truly local afterward.
 */
function clearNodeInherit(structure, nodeId) {
  const found = findNode(structure, nodeId);
  if (!found) throw new Error(`Node "${nodeId}" not found`);
  return clearInheritDeep(found.node);
}

/**
 * Build the full ancestor chain (root-first, target-last) for a node id.
 * `findNode`/`walk` only ever hand back the *immediate* parent, which is not
 * enough to know whether a grandparent section is still inherited.
 */
function findNodePath(structure, nodeId) {
  let result = null;
  const search = (nodes, path) => {
    if (result || !Array.isArray(nodes)) return;
    for (const node of nodes) {
      const nextPath = [...path, node];
      if (node.id === nodeId) {
        result = nextPath;
        return;
      }
      if (Array.isArray(node.children)) search(node.children, nextPath);
      if (result) return;
    }
  };
  search(structure, []);
  return result;
}

/**
 * Locate a node by its POSITION in the tree — an array of child indices from
 * the root down — instead of by id.
 *
 * Gantry regenerates structural ids (grids, blocks, and frequently the particle
 * itself) when it saves a section, so the id a mutator assigned is often dead
 * by the time the save returns. The saved tree is otherwise the tree we posted,
 * so the index path survives the save when the id does not.
 */
function indexPathOf(structure, nodeId) {
  let result = null;
  const search = (nodes, path) => {
    if (result || !Array.isArray(nodes)) return;
    for (let i = 0; i < nodes.length; i++) {
      const nextPath = [...path, i];
      if (nodes[i].id === nodeId) {
        result = nextPath;
        return;
      }
      search(nodes[i].children, nextPath);
      if (result) return;
    }
  };
  search(structure, []);
  return result;
}

/** Follow an index path from indexPathOf back to a node. Null if it runs off the tree. */
function nodeAtIndexPath(structure, path) {
  let nodes = structure;
  let node = null;
  for (const i of path) {
    if (!Array.isArray(nodes) || !nodes[i]) return null;
    node = nodes[i];
    nodes = node.children;
  }
  return node;
}

/**
 * Translate a node id from the structure we POSTed into the id that same node
 * carries in the structure Gantry actually saved.
 *
 * Returns { id, changed, resolved }. `resolved: false` means the position walk
 * failed or landed on a different kind of node, so the pre-save id comes back
 * unchanged — a caller must report that rather than hand out an id it cannot
 * stand behind.
 */
function resolveSavedNodeId(after, saved, nodeId) {
  const path = indexPathOf(after, nodeId);
  if (!path) return { id: nodeId, changed: false, resolved: false };
  const source = nodeAtIndexPath(after, path);
  const target = nodeAtIndexPath(saved, path);
  // Type/subtype must agree, otherwise the trees diverged and the same position
  // is a different node — Gantry reordered or dropped something.
  if (!source || !target || target.type !== source.type || target.subtype !== source.subtype) {
    return { id: nodeId, changed: false, resolved: false };
  }
  return { id: target.id, changed: target.id !== nodeId, resolved: true };
}

/**
 * Break inheritance on every ANCESTOR of a node (section, grid, block —
 * everything from the root down to but not including the node itself).
 *
 * `clearNodeInherit` only clears a node and its descendants. That is not
 * enough for editing/removing a single particle: if the containing section
 * still carries `inherit.include: [..., "children"]`, Gantry recomputes that
 * section's child list from the parent outline on every read/render, which
 * silently resupplies the very particle that was just edited or removed —
 * the edit/removal appears to save but has no visible effect. Call this
 * before mutating a particle (or its own clearNodeInherit) so the whole path
 * from root to the particle is local and nothing upstream can resupply it.
 */
function clearAncestorInherit(structure, nodeId) {
  const path = findNodePath(structure, nodeId);
  if (!path) throw new Error(`Node "${nodeId}" not found`);
  let broke = false;
  const previous = [];
  for (const node of path.slice(0, -1)) {
    if (node.inherit && Object.keys(node.inherit).length) {
      previous.push({ id: node.id, inherit: { ...node.inherit } });
      node.inherit = {};
      broke = true;
    }
  }
  return { broke, previous };
}

/**
 * Replace a target node with a local clone of the matching source node.
 * Equivalent to Gantry's section Inheritance -> Clone flow with:
 *   - Section Attributes checked
 *   - Block Attributes checked
 *   - Particles within Section checked
 *
 * The copied subtree has inheritance cleared so the target is independent.
 */
function cloneNodeFromStructure(targetStructure, sourceStructure, nodeId) {
  const source = findNode(sourceStructure, nodeId);
  if (!source) throw new Error(`Source node "${nodeId}" not found`);
  const target = findNode(targetStructure, nodeId);
  if (!target) throw new Error(`Target node "${nodeId}" not found`);

  const cloned = clearInheritDeep(cloneDeep(source.node));
  const siblings = target.parent ? target.parent.children : targetStructure;
  siblings[target.index] = cloned;
  return cloned;
}

/**
 * Return a full local clone of a layout structure with inheritance cleared on
 * every node. Use for the subsite #Outline "clone the whole Base Outline"
 * operation where the target must stop inheriting from Base Outline entirely.
 */
function cloneStructureLocal(sourceStructure) {
  const cloned = cloneDeep(sourceStructure);
  cloned.forEach(clearInheritDeep);
  return cloned;
}

/**
 * Wipe the entire layout structure.
 *   mode = "full"              → empty array (will fall back to base outline)
 *   mode = "keep-inheritance"  → keep top-level sections that are inheriting,
 *                                 strip their non-inherited children
 */
function clearLayout(structure, mode = 'full') {
  if (mode === 'full') {
    structure.length = 0;
    return structure;
  }
  if (mode === 'keep-inheritance') {
    // Walk top-level: keep nodes that have a non-empty inherit; recursively strip
    // children from the rest.
    const stripChildren = (n) => {
      if (!Array.isArray(n.children)) return;
      n.children = n.children.filter((child) => {
        if (child.inherit && Object.keys(child.inherit).length) {
          stripChildren(child);
          return true;
        }
        return false;
      });
    };
    structure.forEach(stripChildren);
    return structure;
  }
  throw new Error(`Unknown clear mode: ${mode}`);
}

/* ============================================================
 *  Page-bound helpers — call into Gantry's lm.builder API
 * ============================================================ */

/**
 * Serialize the current layout. Two paths:
 *   - browser ctx: read from window.G5.lm.builder (in-memory state, may include
 *     unsaved client-side edits)
 *   - http ctx: GET the layout page HTML and parse `data-lm-root`
 *
 * Either way returns the same JSON-array-of-nodes shape.
 */
async function serializeLayout(ctxOrPage) {
  // Back-compat: callers pass the Page directly when running in browser mode
  if (ctxOrPage && typeof ctxOrPage.evaluate === 'function') {
    return ctxOrPage.evaluate(() => window.G5.lm.builder.serialize());
  }
  const ctx = ctxOrPage;
  if (ctx && ctx.mode === 'browser' && ctx.page) {
    return ctx.page.evaluate(() => window.G5.lm.builder.serialize());
  }
  // HTTP path — needs ctx + outline; signature reroutes through fetchSavedLayout
  throw new Error('serializeLayout(ctx) without a page requires HTTP ctx — use fetchSavedLayout(ctx, outline) instead.');
}

/**
 * Mode-aware: read the current layout structure for an outline. In browser
 * mode this returns the live in-memory state (which may include unsaved
 * client-side edits); in HTTP mode it returns the saved-on-disk layout.
 */
async function getLayoutStructure(ctx, outline) {
  if (ctx?.mode === 'browser' && ctx.page) {
    return ctx.page.evaluate(() => window.G5.lm.builder.serialize());
  }
  return fetchSavedLayout(ctx, outline);
}

/**
 * Pure walker: list every particle/system/spacer/position node in a structure.
 * Returns the same shape as the legacy DOM-based listParticles.
 */
function listParticlesIn(structure, opts = {}) {
  const { onlyEditable = false, includeBlocks = false } = opts;
  const out = [];
  function visit(nodes, parentSection) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const type = node.type || '';
      const isSection = ['section', 'container', 'offcanvas'].includes(type);
      const newParent = isSection ? node.id : parentSection;
      const skipType = ['section', 'container', 'offcanvas', 'grid'].includes(type);
      if (!skipType && (type !== 'block' || includeBlocks)) {
        const inherited = !!(node.inherit && Object.keys(node.inherit).length);
        const disabled = node.attributes?.enabled === 0 || node.attributes?.enabled === '0';
        if (!onlyEditable || (!inherited && !disabled)) {
          out.push({
            id: node.id,
            type,
            subtype: node.subtype || '',
            title: node.title || '',
            sectionId: parentSection,
            inherited,
            disabled,
          });
        }
      }
      visit(node.children, newParent);
    }
  }
  visit(structure, '');
  return out;
}

/** Pure walker: list every section/container/offcanvas (stable drop targets). */
function listSectionsIn(structure) {
  const out = [];
  walk(structure, (n) => {
    const t = n.type || '';
    if (['section', 'container', 'offcanvas'].includes(t)) {
      out.push({ id: n.id, type: t, title: n.title || n.id });
    }
    return false;
  });
  return out;
}

/** Pure walker: full nested tree as flat parent/children list (same as dumpLayoutTree). */
function dumpTreeIn(structure) {
  const out = [];
  function visit(nodes, parent) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      out.push({
        id: node.id,
        type: node.type || '',
        parent,
        children: (node.children || []).map((c) => c.id),
      });
      visit(node.children, node.id);
    }
  }
  visit(structure, null);
  return out;
}

/**
 * HTTP-mode equivalent of serializeLayout: fetch the saved layout JSON for an
 * outline by parsing the lm-blocks `data-lm-root` attribute from the page HTML.
 */
async function fetchSavedLayout(ctx, outline) {
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '');
  const res = await ctx.fetch(url, { method: 'GET' });
  if (res.status >= 400) throw new Error(`Layout fetch ${res.status}: ${res.body.slice(0, 200)}`);
  // The data-lm-root attribute holds the layout JSON (HTML-escaped)
  const m = res.body.match(/data-lm-root="((?:[^"\\]|\\.)*)"/);
  if (!m) {
    throw new Error('data-lm-root not found in layout page HTML');
  }
  // Decode HTML entities (named + hex + decimal) and JSON parse
  const decoded = decodeHtmlEntities(m[1]);
  try {
    return JSON.parse(decoded);
  } catch (e) {
    throw new Error(`Could not parse data-lm-root JSON: ${e.message}`);
  }
}

/** Decode the entity escapes Joomla emits in attributes (named, hex, decimal). */
function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Save a new layout structure by POSTing directly to Gantry's save endpoint.
 *
 * Captured request shape (via DevTools network):
 *   POST  /administrator/index.php?option=com_gantry5&view=configurations/<outline>/layout&theme=<theme>&<token>=1&format=json
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: preset=<urlencoded preset JSON>&layout=<urlencoded layout array>
 *
 * Returns the JSON response Gantry sent back.
 */
/**
 * `pageOrCtx` accepts either a browser ctx (with .fetch) or a legacy Page —
 * we keep the older signature working for the dialog-flow callers.
 */
async function saveLayoutDirect(pageOrCtx, ctx, outline, structure) {
  // Determine which mode we're in
  const usingPage = pageOrCtx && typeof pageOrCtx.evaluate === 'function';
  const fetchFn = usingPage
    ? null // page mode — we'll inline the fetch via evaluate
    : pageOrCtx.fetch;

  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '') +
    `&format=json`;

  // Read the current preset metadata. Browser mode reads it from the live
  // page; HTTP mode fetches the layout page and parses data-lm-preset.
  let preset = '';
  if (usingPage) {
    preset = await pageOrCtx.evaluate(() => {
      const el = document.querySelector('.lm-blocks, [data-lm-preset]');
      return el?.getAttribute('data-lm-preset') || '';
    });
  } else {
    const layoutUrl =
      `${ctx.base}/administrator/index.php?option=com_gantry5` +
      `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
      `&theme=${encodeURIComponent(ctx.theme)}` +
      (ctx.token ? `&${ctx.token}=1` : '');
    const r = await fetchFn(layoutUrl, { method: 'GET' });
    const m = r.body.match(/data-lm-preset="((?:[^"\\]|\\.)*)"/);
    if (m) preset = decodeHtmlEntities(m[1]);
  }

  const body =
    'preset=' + encodeURIComponent(preset) +
    '&layout=' + encodeURIComponent(JSON.stringify(structure));

  let result;
  if (usingPage) {
    result = await pageOrCtx.evaluate(
      async (url, body) => {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body,
        });
        return { status: res.status, text: await res.text() };
      },
      url,
      body
    );
  } else {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    result = { status: r.status, text: r.body };
  }

  if (result.status >= 400) {
    throw new Error(`Save layout POST returned ${result.status}: ${result.text.slice(0, 400)}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.text);
  } catch {}
  if (parsed && parsed.success === false) {
    throw new Error(`Save reported failure: ${parsed.error || result.text.slice(0, 400)}`);
  }
  return parsed || result;
}

/**
 * High-level helper: fetch current structure, mutate it, POST it to Gantry.
 *
 *   const ctx = await session.start({...});
 *   await openLayout(page, ctx, '75');
 *   await mutateLayout(page, ctx, '75', (structure) => {
 *     addParticleToSection(structure, 'expanded', 'blockcontent');
 *   }, { op: 'add' });
 *
 * Production-hardened defaults:
 *   - Auto-takes a backup before mutating.       Disable with { backup: false }
 *   - --dry-run mode prints diff and skips POST. Enable with { dryRun: true }
 *
 * Bypasses the Save Layout button entirely — POSTs directly to the layout
 * endpoint with the form-encoded body Gantry expects.
 */
/**
 * Three accepted calling conventions:
 *   1. (page, ctx, outline, mutator, opts)        — legacy browser
 *   2. (null|undefined, ctx, outline, mutator, opts) — legacy HTTP (page omitted)
 *   3. (ctx, outline, mutator, opts)              — new clean signature
 */
/* ---------------------------------------------------------------
 *  Section preservation guard
 *  Sections/containers/offcanvas define the layout skeleton.
 *  They must NEVER be deleted or moved between containers.
 * --------------------------------------------------------------- */

function snapshotSections(structure) {
  const snap = [];
  function visit(nodes, parentId) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const t = node.type || '';
      if (['section', 'container', 'offcanvas'].includes(t)) {
        snap.push({ id: node.id, type: t, parentId: parentId || null });
      }
      if (Array.isArray(node.children)) visit(node.children, node.id || parentId);
    }
  }
  visit(structure, null);
  return snap;
}

/**
 * @param {Array} snapshot  - result of snapshotSections(before)
 * @param {Array} afterStructure
 * @param {object} [opts]
 * @param {boolean} [opts.checkParent=true] - also verify sections haven't moved
 *   between containers.  Set false for full-layout replacements where new
 *   container IDs are generated (gantry_layout_import / gantry_layout_design).
 */
function assertSectionsPreserved(snapshot, afterStructure, opts) {
  const checkParent = !opts || opts.checkParent !== false;
  const afterMap = new Map();
  function visit(nodes, parentId) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const t = node.type || '';
      if (['section', 'container', 'offcanvas'].includes(t)) {
        afterMap.set(node.id, parentId || null);
      }
      if (Array.isArray(node.children)) visit(node.children, node.id || parentId);
    }
  }
  visit(afterStructure, null);
  const errors = [];
  for (const { id, type, parentId } of snapshot) {
    if (!afterMap.has(id)) {
      errors.push('Section "' + id + '" (' + type + ') was deleted. '
        + 'Sections must never be removed from an outline. '
        + 'To clear a section remove its particles but keep the section node.');
    } else if (checkParent && afterMap.get(id) !== parentId) {
      errors.push('Section "' + id + '" (' + type + ') was moved '
        + 'from container "' + parentId + '" to "' + afterMap.get(id)
        + '". Sections must never be moved between containers.');
    }
  }
  if (errors.length > 0) {
    throw new Error('SECTION_PRESERVATION_VIOLATION:\n' + errors.join('\n'));
  }
}

async function mutateLayout(arg1, arg2, arg3, arg4, arg5) {
  let ctx, outline, mutator, opts, page;
  if (arg1 && typeof arg1.evaluate === 'function') {
    // form 1
    page = arg1;
    ctx = arg2;
    outline = arg3;
    mutator = arg4;
    opts = arg5 || {};
  } else if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    // form 3
    ctx = arg1;
    outline = arg2;
    mutator = arg3;
    opts = arg4 || {};
    page = ctx?.page;
  } else {
    // form 2: page is null/undefined, args shift back by one
    page = arg1;
    ctx = arg2;
    outline = arg3;
    mutator = arg4;
    opts = arg5 || {};
    if (!page) page = ctx?.page;
  }
  const { op = 'mutate', backup: doBackup = true, dryRun = false } = opts;

  // Read current state — browser mode reads in-memory; HTTP fetches from disk
  let before;
  if (ctx?.mode === 'browser' && page) {
    before = await page.evaluate(() => window.G5.lm.builder.serialize());
  } else {
    before = await fetchSavedLayout(ctx, outline);
  }

  let backupPath = null;
  if (doBackup && !dryRun) {
    backupPath = backup.takeBackup(ctx, outline, op, before);
  }

  const _sectionSnapshot = snapshotSections(before);

  const after = JSON.parse(JSON.stringify(before));
  const result = mutator(after);
  // Enforce section preservation before saving
  const { preserveSections = true } = opts;
  if (preserveSections) assertSectionsPreserved(_sectionSnapshot, after);


  // Always diff — even for real saves. Callers can detect no-ops via diff.
  const diff = diffStructures(before, after);

  if (dryRun) {
    return { structure: after, result, diff, dryRun: true };
  }

  // saveLayoutDirect is dual-mode: pass page in browser, ctx in http
  const saveTarget = ctx?.mode === 'browser' && page ? page : ctx;
  const resp = await saveLayoutDirect(saveTarget, ctx, outline, after);

  // Readback verification: re-fetch from disk and confirm the save landed.
  // Only possible in HTTP mode (browser mode reads in-memory state).
  // `saved` is returned as well as diffed: it is the only place the post-save
  // ids exist, and a caller that just created a node needs them (see
  // resolveSavedNodeId).
  let verified = null;
  let verifyDiff = null;
  let verifyMismatch = null;
  let saved = null;
  if (ctx?.mode !== 'browser') {
    try {
      saved = await fetchSavedLayout(ctx, outline);
      // Compare by position and content, not by id — Gantry rewrites grid and
      // block ids on save, which made the old id-keyed verdict false every time.
      verifyMismatch = firstStructuralMismatch(after, saved);
      verified = verifyMismatch === null;
      verifyDiff = diffStructures(after, saved);
    } catch {
      // non-fatal — best-effort
    }
  }

  return { structure: after, result, resp, backupPath, diff, verified, verifyDiff, verifyMismatch, saved };
}

/** Key-order-independent serialization, so an attribute map that survived a
 *  YAML round trip still compares equal to the one we posted. */
function stableString(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(stableString).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + stableString(value[k]))
    .join(',') + '}';
}

/**
 * Structural nodes carry no meaningful subtype, but Gantry writes the node's own
 * type into the field when it saves — a grid built with `subtype: false` reads
 * back as `subtype: "grid"`. Collapse both spellings to null so that server
 * normalization does not read as a content change. Particles are unaffected:
 * their subtype ("custom", "image") is never equal to their type.
 */
function normalizedSubtype(node) {
  const subtype = node.subtype;
  if (!subtype) return null;
  return subtype === node.type ? null : subtype;
}

/**
 * Grids and blocks are stamped with the placeholder title "Untitled" when we
 * build them; Gantry drops the field entirely when it saves. Collapse both to
 * null. Only grids and blocks are normalized — a particle really can be titled
 * "Untitled", and losing that would hide a real change.
 */
function normalizedTitle(node) {
  const title = node.title;
  if (node.type === 'grid' || node.type === 'block') {
    return title && title !== 'Untitled' ? title : null;
  }
  return title ?? null;
}

/**
 * Compare two layout trees by POSITION and CONTENT, ignoring node ids. Returns
 * a description of the first mismatch, or null when the trees are equivalent.
 *
 * Readback verification cannot use an id-keyed diff. Gantry assigns its own ids
 * to grids and blocks as it saves, so comparing what we posted against what came
 * back always reports spurious added/removed nodes — a perfectly applied save
 * reported `verified: false` every time, which made the flag worthless. Ids are
 * the server's to choose; what has to survive the save is the shape and the
 * content, so that is what this checks.
 */
function firstStructuralMismatch(after, saved, path = 'root') {
  const a = Array.isArray(after) ? after : [];
  const b = Array.isArray(saved) ? saved : [];
  if (a.length !== b.length) {
    return `${path}: expected ${a.length} child node(s), saved layout has ${b.length}`;
  }
  for (let i = 0; i < a.length; i++) {
    const expected = a[i];
    const actual = b[i];
    const here = `${path}[${i}]`;
    if ((expected.type ?? null) !== (actual.type ?? null)) {
      return `${here}: type is ${JSON.stringify(actual.type)}, expected ${JSON.stringify(expected.type)}`;
    }
    if (normalizedSubtype(expected) !== normalizedSubtype(actual)) {
      return `${here}: subtype is ${JSON.stringify(actual.subtype)}, expected ${JSON.stringify(expected.subtype)}`;
    }
    if (normalizedTitle(expected) !== normalizedTitle(actual)) {
      return `${here}: title is ${JSON.stringify(actual.title)}, expected ${JSON.stringify(expected.title)}`;
    }
    for (const field of ['attributes', 'inherit']) {
      if (stableString(expected[field] ?? {}) !== stableString(actual[field] ?? {})) {
        return `${here} (${actual.type}): ${field} did not survive the save`;
      }
    }
    const deeper = firstStructuralMismatch(expected.children, actual.children, here);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Cheap-and-cheerful structural diff — flat lists of added / removed / changed.
 * Walks both trees, indexing nodes by id, and reports differences in a way
 * that's useful for a --dry-run summary.
 */
function diffStructures(before, after) {
  const flat = (root) => {
    const map = new Map();
    walk(root, (node) => {
      map.set(node.id, {
        id: node.id,
        type: node.type,
        subtype: node.subtype,
        title: node.title,
        attributes: node.attributes,
        inherit: node.inherit,
        size: node.attributes?.size,
      });
      return false;
    });
    return map;
  };
  const a = flat(before);
  const b = flat(after);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, node] of b) {
    if (!a.has(id)) {
      added.push(node);
      continue;
    }
    const old = a.get(id);
    const oldStr = JSON.stringify(old);
    const newStr = JSON.stringify(node);
    if (oldStr !== newStr) {
      changed.push({ id, type: node.type, before: old, after: node });
    }
  }
  for (const [id, node] of a) {
    if (!b.has(id)) removed.push(node);
  }
  return { added, removed, changed };
}

/**
 * Restore an outline to a saved backup structure (POSTs the JSON to the save
 * endpoint, just like a normal mutate).
 */
async function restoreLayout(page, ctx, outline, structure, opts = {}) {
  const { backup: doBackup = true } = opts;
  if (doBackup) {
    const before = await serializeLayout(page);
    backup.takeBackup(ctx, outline, 'pre-restore', before);
  }
  return saveLayoutDirect(page, ctx, outline, structure);
}

/**
 * Fetch the catalog of available presets (and other-outline copy targets) by
 * calling /configurations/<outline>/layout/switch&format=json and parsing the
 * dialog HTML. Returns:
 *   { presets: [{ name, title }], outlines: [{ id, title }] }
 *
 * The /switch endpoint is global within a theme — calling it on any outline
 * gives the same preset catalog.
 */
async function listAvailablePresets(arg1, arg2, arg3) {
  let ctx, outline;
  if (arg1 && typeof arg1.evaluate === 'function') {
    // (page, ctx, outline)
    ctx = arg2;
    outline = arg3;
  } else if (arg1 && (arg1.mode || typeof arg1.fetch === 'function')) {
    // (ctx, outline)
    ctx = arg1;
    outline = arg2;
  } else {
    // (undefined-page, ctx, outline) — HTTP mode legacy callers
    ctx = arg2;
    outline = arg3;
  }
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout/switch')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '') +
    `&format=json`;
  const res = await ctx.fetch(url, { method: 'GET' });
  if (res.status >= 400) throw new Error(`switch endpoint returned ${res.status}`);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`switch response was not JSON: ${e.message}`);
  }
  const html = parsed.html || '';
  // Pull every <li> that carries a data-switch attribute (preset or outline copy)
  const items = html.match(/<li[\s\S]*?data-switch[\s\S]*?<\/li>/g) || [];
  const presets = [];
  const outlines = [];
  for (const item of items) {
    const url = (item.match(/data-switch="([^"]+)"/) || [])[1];
    if (!url) continue;
    const ariaLabel = (item.match(/aria-label="([^"]+)"/) || [])[1] || '';
    const innerText = (item
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim());
    const title = (ariaLabel || innerText).replace(/&amp;/g, '&').trim();
    const presetMatch = url.match(/\/preset\/([^&?"]+)/);
    if (presetMatch) {
      presets.push({ name: presetMatch[1], title });
      continue;
    }
    // Outline-copy items have URLs like /configurations/<id>/layout (no /preset/)
    const outlineMatch = url.match(/configurations\/([^/]+)\/layout/);
    if (outlineMatch) {
      outlines.push({ id: outlineMatch[1], title });
    }
  }
  return { presets, outlines };
}

/**
 * Load a built-in preset onto an outline:
 *   1. GET /configurations/<outline>/layout/preset/<presetName>&format=json
 *      → returns { preset: <json string>, data: <json string>, title }
 *   2. POST those fields back to /configurations/<outline>/layout&format=json
 *      so the layout is persisted.
 */
async function loadPresetByName(page, ctx, outline, presetName) {
  const url =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout/preset/' + presetName)}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '') +
    `&format=json`;

  // 1. Fetch the preset
  const res = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: 'same-origin' });
    return { status: r.status, body: await r.text() };
  }, url);
  if (res.status >= 400) throw new Error(`preset fetch returned ${res.status}: ${res.body.slice(0, 200)}`);
  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`preset response was not JSON: ${e.message}`);
  }
  if (parsed.success === false) {
    throw new Error(`preset fetch reported failure: ${parsed.message || res.body.slice(0, 200)}`);
  }
  if (!parsed.data) throw new Error(`preset response missing "data" field`);

  // 2. POST it as the new layout. preset and data are already JSON strings.
  const saveUrl =
    `${ctx.base}/administrator/index.php` +
    `?option=com_gantry5` +
    `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
    `&theme=${encodeURIComponent(ctx.theme)}` +
    (ctx.token ? `&${ctx.token}=1` : '') +
    `&format=json`;

  const saveRes = await page.evaluate(
    async (u, preset, data) => {
      const body = 'preset=' + encodeURIComponent(preset) + '&layout=' + encodeURIComponent(data);
      const r = await fetch(u, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
      });
      return { status: r.status, body: await r.text() };
    },
    saveUrl,
    parsed.preset || '',
    parsed.data
  );
  if (saveRes.status >= 400) {
    throw new Error(`save returned ${saveRes.status}: ${saveRes.body.slice(0, 200)}`);
  }
  let saveParsed = null;
  try { saveParsed = JSON.parse(saveRes.body); } catch {}
  if (saveParsed && saveParsed.success === false) {
    throw new Error(`save reported failure: ${saveParsed.message || saveRes.body.slice(0, 200)}`);
  }
  return {
    preset: presetName,
    title: parsed.title || presetName,
    data: JSON.parse(parsed.data),
  };
}

/**
 * Copy the layout from `fromOutline` into `toOutline` in one browser session.
 * Single login, two navigations, one POST.
 *
 * Reuses openLayout from lib/layout to land on each page; the page's
 * window.G5.lm.builder is what we serialize from.
 */
async function copyLayoutFrom(page, ctx, fromOutline, toOutline, openLayoutFn) {
  // Source: navigate, serialize
  await openLayoutFn(page, ctx, fromOutline);
  const source = await serializeLayout(page);
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error(`Source outline "${fromOutline}" has no layout to copy.`);
  }
  // Target: navigate, POST
  await openLayoutFn(page, ctx, toOutline);
  const resp = await saveLayoutDirect(page, ctx, toOutline, source);
  return { source, resp };
}

/* ============================================================
 *  New helpers — added for improved MCP tooling
 * ============================================================ */

/**
 * Resolve a dot-separated path like "subcontents" or "items.0.text" against obj.
 * Returns { parent, key, value } so callers can mutate.
 */
function resolvePath(obj, pathStr) {
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') {
      throw new Error(`Path "${pathStr}" not found at segment "${parts[i]}"`);
    }
    cur = cur[parts[i]];
  }
  const key = parts[parts.length - 1];
  return { parent: cur, key, value: cur == null ? undefined : cur[key] };
}

/**
 * Deep-inspect a particle by id: returns the particle node, its wrapper block,
 * and all attributes. Useful for understanding the full structure before editing.
 *
 * Returns: { particle, block, attributes, inherited, inheritedFrom }
 *   particle      — the raw particle node from the layout tree
 *   block         — the block node that wraps this particle (may be null for top-level)
 *   attributes    — particle.attributes (convenience)
 *   inherited     — true if this particle still has a live `inherit` block, meaning
 *                   `attributes` (and/or `block`) may be silently re-resolved from a
 *                   parent outline on every read regardless of what this response shows.
 *   inheritedFrom — { outline, particle, include } describing the source, or null.
 */
function inspectParticleDeep(structure, particleId) {
  /** @type {LayoutNode|null} */
  let particle = null;
  /** @type {LayoutNode|null} */
  let block = null;

  walk(structure, (node, parent) => {
    if (node.id === particleId && ['particle', 'system', 'position', 'spacer'].includes(node.type)) {
      particle = node;
      // The direct parent in a normal layout is a block
      if (parent && parent.type === 'block') {
        block = parent;
      }
    }
  });

  if (!particle) return null;
  const inherited = !!(particle.inherit && Object.keys(particle.inherit).length);
  return {
    particle,
    block,
    attributes: particle.attributes || {},
    inherited,
    inheritedFrom: inherited ? particle.inherit : null,
  };
}

/**
 * Edit a single item inside a repeater (array) attribute on a particle.
 *
 * @param {Array}  structure     Layout structure array
 * @param {string} particleId   ID of the target particle node
 * @param {string} repeaterPath Dot-path to the repeater array within attributes
 *                              e.g. "items" or "subcontents"
 * @param {number} index        Zero-based index of the item to update
 * @param {object} patch        Key/value pairs to merge into that item
 *
 * Returns the mutated structure.
 */
function editRepeaterItem(structure, particleId, repeaterPath, index, patch) {
  // findNode returns { node, parent, index } — the node itself is .node.
  const found = findNode(structure, particleId);
  if (!found) throw new Error(`Particle "${particleId}" not found`);
  const node = found.node;
  if (!['particle', 'system', 'position', 'spacer'].includes(node.type)) {
    throw new Error(`Node "${particleId}" is not a particle (type: ${node.type})`);
  }

  node.attributes = node.attributes || {};
  const { parent, key, value } = resolvePath(node.attributes, repeaterPath);

  if (!Array.isArray(value)) {
    throw new Error(
      `Expected an array at attributes.${repeaterPath} on particle "${particleId}", ` +
      `got ${value === null ? 'null' : typeof value}`
    );
  }
  if (index < 0 || index >= value.length) {
    throw new Error(
      `Index ${index} is out of range for repeater "${repeaterPath}" ` +
      `(length: ${value.length})`
    );
  }

  value[index] = { ...value[index], ...patch };
  parent[key] = value;
  return structure;
}

/**
 * Replace an entire repeater (array) attribute on a particle.
 * The replacement must be an array; each element is validated to be an object.
 *
 * Returns the mutated structure.
 */
function replaceRepeater(structure, particleId, repeaterPath, newArray) {
  if (!Array.isArray(newArray)) {
    throw new Error('replaceRepeater: newArray must be an array');
  }
  for (let i = 0; i < newArray.length; i++) {
    if (typeof newArray[i] !== 'object' || newArray[i] === null || Array.isArray(newArray[i])) {
      throw new Error(`replaceRepeater: item at index ${i} must be a plain object`);
    }
  }

  // findNode returns { node, parent, index } — the node itself is .node.
  const found = findNode(structure, particleId);
  if (!found) throw new Error(`Particle "${particleId}" not found`);
  const node = found.node;

  node.attributes = node.attributes || {};
  const { parent, key } = resolvePath(node.attributes, repeaterPath);
  parent[key] = newArray;
  return structure;
}

/**
 * Edit the attributes of a block node (the wrapper around a particle).
 * Commonly used to set CSS classes on the block.
 *
 * @param {Array}  structure  Layout structure array
 * @param {string} blockId    ID of the block node
 * @param {object} patch      Key/value pairs to merge into block.attributes
 *
 * Returns the mutated structure.
 */
function editBlockAttrs(structure, blockId, patch) {
  // findNode returns { node, parent, index } — the node itself is .node.
  const found = findNode(structure, blockId);
  if (!found) {
    throw new Error(
      `Block "${blockId}" not found. Pass the block's own id, or the id of the node it wraps ` +
      `(a section id such as "mainbar" works, and is the supported way to resize the ` +
      `sidebar/mainbar/aside blocks).`
    );
  }
  let node = found.node;
  // Accept the id of the node the block WRAPS, not only the block's own id.
  // The blocks around main-container sections carry generated ids a caller has
  // no handy way to read, so resizing sidebar / mainbar / aside failed with
  // "Block not found" and had no supported path at all.
  if (node.type !== 'block') {
    if (found.parent && found.parent.type === 'block') {
      node = found.parent;
    } else {
      throw new Error(
        `Node "${blockId}" is type "${node.type}", not a block, and is not wrapped by one.`
      );
    }
  }
  node.attributes = { ...(node.attributes || {}), ...patch };
  return structure;
}

/**
 * Find particles matching filter criteria.
 * Returns an array of inspected particle results.
 *
 * @param {Array}  structure  Layout structure array
 * @param {object} filters
 *   filters.section   — match particles in this section id or title
 *   filters.title     — match by particle title (case-insensitive substring)
 *   filters.subtype   — match by particle subtype (e.g. "logo", "menu")
 *   filters.type      — match by node type (default: any particle-like type)
 *
 * Returns: Array of { particle, block, attributes }
 */
function findParticles(structure, filters = {}) {
  const { section, title, subtype, type: nodeType } = filters;
  const results = [];

  // Build a map of particle-id → section-id for section filtering
  const particleSection = {};
  if (section) {
    walk(structure, (node, parent, depth) => {
      if (node.type === 'section') {
        walk(node.children || [], (child) => {
          if (['particle', 'system', 'position', 'spacer'].includes(child.type)) {
            particleSection[child.id] = node.id;
          }
        });
      }
    });
  }

  walk(structure, (node, parent) => {
    const isParticleType = ['particle', 'system', 'position', 'spacer'].includes(node.type);
    if (!isParticleType) return;
    if (nodeType && node.type !== nodeType) return;
    if (subtype && node.subtype !== subtype) return;
    if (title && !(node.title || '').toLowerCase().includes(title.toLowerCase())) return;
    if (section && particleSection[node.id] !== section) return;

    const block = (parent && parent.type === 'block') ? parent : null;
    results.push({ particle: node, block, attributes: node.attributes || {} });
  });

  return results;
}


/* ─── HTML class inspection helpers ──────────────────────────────────────────
 * Extract a particle's rendered HTML from a live frontend page so you can
 * see exactly what classes Gantry emits and map them to override.css rules.
 */

/**
 * Given an HTML string and a CSS class name, find the first block-level element
 * that carries that class and return its full outerHTML (balanced tags).
 */
function extractElementByClass(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openRe = new RegExp(
    `<(div|section|article|aside|header|footer|main)\\b[^>]*\\bclass="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`,
    'i'
  );
  const m = openRe.exec(html);
  if (!m) return null;

  const tag = m[1].toLowerCase();
  const startIdx = m.index;
  let i = startIdx + m[0].length;
  let depth = 1;
  const closeStr = `</${tag}>`;

  while (depth > 0 && i < html.length) {
    const nextOpen  = html.indexOf(`<${tag}`, i);
    const nextClose = html.indexOf(closeStr, i);
    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Make sure it's an opening tag (followed by space or >)
      const after = html[nextOpen + 1 + tag.length];
      if (after === ' ' || after === '>' || after === '\n' || after === '\r' || after === '\t') {
        depth++;
        i = nextOpen + 1;
      } else {
        i = nextOpen + 1;
      }
    } else {
      depth--;
      i = nextClose + closeStr.length;
    }
  }

  return html.slice(startIdx, i);
}

/**
 * Parse the class lists out of a raw HTML snippet.
 * Returns { blockClasses, innerClasses } where:
 *   blockClasses — classes on the outermost element (the g-block wrapper)
 *   innerClasses — classes on the first g-content div (the inner wrapper)
 */
function analyzeHtmlClasses(snippet) {
  if (!snippet) return { blockClasses: [], innerClasses: [] };
  const outerMatch = snippet.match(/^<\w+[^>]*\bclass="([^"]*)"/);
  const blockClasses = outerMatch
    ? outerMatch[1].trim().split(/\s+/).filter(Boolean)
    : [];
  const innerMatch = snippet.match(/<div[^>]*\bclass="([^"]*\bg-content\b[^"]*)"/);
  const innerClasses = innerMatch
    ? innerMatch[1].trim().split(/\s+/).filter(Boolean)
    : [];
  return { blockClasses, innerClasses };
}

/**
 * Fetch rendered HTML for a specific particle from a live frontend page.
 *
 * Locating strategy (in order):
 *   1. Custom block CSS class already set on the particle's block wrapper
 *   2. Gantry particle subtype class (g-{subtype}) on the inner element
 *
 * Returns:
 *   { particleId, blockClass, particleAttributes, particleSubtype, pageUrl,
 *     locatedBy, outerHTML, blockClasses, innerClasses, warning? }
 */
async function fetchParticleHtml(ctx, outline, particleId, pageUrl) {
  const structure = await getLayoutStructure(ctx, outline);
  const info = inspectParticleDeep(structure, particleId);
  if (!info) throw new Error(`Particle "${particleId}" not found in outline "${outline}"`);

  const currentBlockClass = (info.block && info.block.attributes && info.block.attributes.class) || '';
  const subtype = (info.node && info.node.subtype) || '';

  // Fetch the frontend page using the existing authenticated session
  const res = await ctx.fetch(pageUrl, { method: 'GET' });
  if (res.status >= 400) throw new Error(`Page fetch returned ${res.status}: ${pageUrl}`);
  const html = res.body;

  let snippet = null;
  let locatedBy = null;
  let warning = null;

  // Strategy 1 — locate by custom block class (skip generic Gantry utility classes)
  if (currentBlockClass) {
    const customClasses = currentBlockClass.trim().split(/\s+/).filter(
      c => c && !/^(g-block|g-content|size-\d+|g-grid|g-section|g-container)$/.test(c)
    );
    for (const cls of customClasses) {
      snippet = extractElementByClass(html, cls);
      if (snippet) { locatedBy = `blockClass:${cls}`; break; }
    }
  }

  // Strategy 2 — locate by particle subtype inner class (g-{subtype})
  if (!snippet && subtype) {
    const innerSnippet = extractElementByClass(html, `g-${subtype}`);
    if (innerSnippet) {
      // Walk up one level to get the block wrapper
      const escaped = (`g-${subtype}`).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const innerRe = new RegExp(
        `<(div|section)[^>]*\\bclass="[^"]*\\b${escaped}\\b[^"]*"`,
        'i'
      );
      const innerIdx = innerRe.exec(html)?.index ?? -1;
      // Try to find the enclosing g-block wrapper
      const wrapperRe = /<(div|section)\b[^>]*\bclass="[^"]*\bg-block\b[^"]*"[^>]*>/gi;
      let lastWrap = null;
      let wm;
      while ((wm = wrapperRe.exec(html)) !== null) {
        if (wm.index < innerIdx) lastWrap = wm;
        else break;
      }
      if (lastWrap) {
        snippet = extractElementByClass(html, 'g-block');
        // extractElementByClass returns the FIRST g-block; use offset approach instead
        snippet = extractElementByClassAt(html, 'g-block', lastWrap.index);
      }
      if (!snippet) snippet = innerSnippet; // fallback: return just the inner element
      locatedBy = `particleSubtype:g-${subtype}`;
      warning = `Located by particle subtype — may match multiple particles of the same type. ` +
        `Set a unique blockClass on this particle via gantry_particle_direct_edit for precise targeting.`;
    }
  }

  if (!snippet) {
    warning = `Could not locate particle "${particleId}" in rendered HTML. ` +
      `blockClass="${currentBlockClass}", subtype="${subtype}". ` +
      `Set a unique blockClass on this particle and retry.`;
  }

  const { blockClasses, innerClasses } = analyzeHtmlClasses(snippet);

  return {
    particleId,
    blockClass:          currentBlockClass,
    particleAttributes:  (info.node && info.node.attributes) || {},
    particleSubtype:     subtype,
    pageUrl,
    locatedBy,
    outerHTML:           snippet || null,
    blockClasses,
    innerClasses,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Like extractElementByClass but starts scanning from a given offset in html.
 */
function extractElementByClassAt(html, className, fromIndex) {
  const sub = html.slice(fromIndex);
  const result = extractElementByClass(sub, className);
  return result;
}

module.exports = {
  walk,
  snapshotSections,
  assertSectionsPreserved,
  findNode,
  deepMerge,
  removeNode,
  makeParticleNode,
  makeBlockNode,
  makeGridNode,
  addParticleToSection,
  editParticleFromForm,
  addParticleNextTo,
  moveParticleToSection,
  moveParticleNextTo,
  editSectionAttrs,
  addSectionClasses,
  setNodeInherit,
  clearNodeInherit,
  findNodePath,
  indexPathOf,
  nodeAtIndexPath,
  resolveSavedNodeId,
  clearAncestorInherit,
  cloneNodeFromStructure,
  cloneStructureLocal,
  clearLayout,
  serializeLayout,
  getLayoutStructure,
  listParticlesIn,
  listSectionsIn,
  dumpTreeIn,
  fetchSavedLayout,
  saveLayoutDirect,
  mutateLayout,
  diffStructures,
  firstStructuralMismatch,
  restoreLayout,
  listAvailablePresets,
  loadPresetByName,
  copyLayoutFrom,
  // Particle inspection helpers
  resolvePath,
  inspectParticleDeep,
  editRepeaterItem,
  replaceRepeater,
  editBlockAttrs,
  findParticles,
  // HTML class inspection helpers
  fetchParticleHtml,
  extractElementByClass,
  analyzeHtmlClasses,
};
