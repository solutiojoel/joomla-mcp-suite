'use strict';

// Menu Spec acceptance test — structural schema validation + semantic lint rules.
// Run: node apps/orchestrator/test-menu-spec.cjs
//
// The structural validator is a small JSON-Schema (draft-07 subset) walker so the
// schema file in config/ is actually enforced — no ajv / external deps, matching
// the rest of this repo's tests. The lint rules cover the cross-field invariants
// JSON Schema can't express (e.g. "a TBD target requires an open_question").

const fs   = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config', 'menu-spec.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// Minimal JSON Schema (draft-07 subset) validator: type, required, properties,
// additionalProperties, items, enum, minProperties, minItems, and local $ref.
// ---------------------------------------------------------------------------
function resolveRef(ref, root) {
  // only supports local refs like "#/$defs/menuItem"
  const parts = ref.replace(/^#\//, '').split('/');
  return parts.reduce((node, key) => node[key], root);
}

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v; // object, string, number, boolean
}

function validate(node, sch, root, pathStr, errors) {
  if (sch.$ref) return validate(node, resolveRef(sch.$ref, root), root, pathStr, errors);

  if (sch.type) {
    const t = typeOf(node);
    const want = sch.type === 'integer' ? 'number' : sch.type;
    if (t !== want) {
      errors.push(`${pathStr}: expected ${sch.type}, got ${t}`);
      return; // further checks meaningless on wrong type
    }
  }

  if (sch.enum && !sch.enum.includes(node)) {
    errors.push(`${pathStr}: '${node}' not in [${sch.enum.join(', ')}]`);
  }

  if (typeOf(node) === 'object') {
    if (sch.required) {
      for (const r of sch.required) {
        if (!(r in node)) errors.push(`${pathStr}: missing required '${r}'`);
      }
    }
    if (typeof sch.minProperties === 'number' && Object.keys(node).length < sch.minProperties) {
      errors.push(`${pathStr}: needs >= ${sch.minProperties} properties`);
    }
    for (const [key, val] of Object.entries(node)) {
      const childPath = `${pathStr}.${key}`;
      if (sch.properties && key in sch.properties) {
        validate(val, sch.properties[key], root, childPath, errors);
      } else if (sch.additionalProperties && typeof sch.additionalProperties === 'object') {
        validate(val, sch.additionalProperties, root, childPath, errors);
      } else if (sch.additionalProperties === false && (!sch.properties || !(key in sch.properties))) {
        errors.push(`${childPath}: unexpected property`);
      }
    }
  }

  if (typeOf(node) === 'array') {
    if (typeof sch.minItems === 'number' && node.length < sch.minItems) {
      errors.push(`${pathStr}: needs >= ${sch.minItems} items`);
    }
    if (sch.items) {
      node.forEach((el, i) => validate(el, sch.items, root, `${pathStr}[${i}]`, errors));
    }
  }
}

function schemaErrors(spec) {
  const errors = [];
  validate(spec, schema, schema, 'spec', errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Semantic lint — cross-field invariants. Returns array of error strings.
// ---------------------------------------------------------------------------
const NEEDS_TARGET = 'external_url';

function lint(spec) {
  const errors = [];
  const oq = (spec.open_questions || []).join(' | ').toLowerCase();
  const hasTbdQuestion = oq.length > 0;

  function isTbd(v) { return !v || String(v).trim().toUpperCase() === 'TBD'; }

  function walk(item, menuName, siblingTitles) {
    // duplicate titles at the same level
    const key = item.title.toLowerCase();
    if (siblingTitles.has(key)) errors.push(`${menuName}: duplicate title '${item.title}' at same level`);
    siblingTitles.add(key);

    if (item.type === NEEDS_TARGET) {
      if (!('target' in item)) errors.push(`${menuName} > '${item.title}': external_url missing target (use 'TBD' + open_question)`);
      else if (isTbd(item.target) && !hasTbdQuestion) errors.push(`${menuName} > '${item.title}': target is TBD but no open_questions entry`);
    }

    if (item.type === 'category_grid') {
      if (!item.category) errors.push(`${menuName} > '${item.title}': category_grid requires a category`);
      const articleChildren = (item.children || []).filter(c => c.type === 'single_article');
      if (articleChildren.length) {
        errors.push(`${menuName} > '${item.title}': category_grid has single_article children (${articleChildren.map(c => c.title).join(', ')}) — grid members self-route, do not create menu items for them`);
      }
    }

    if (item.type === 'heading' && (!item.children || item.children.length === 0)) {
      errors.push(`${menuName} > '${item.title}': heading has no children (a parent-only item with nothing under it is usually a mistake)`);
    }

    if (item.children) {
      const childTitles = new Set();
      for (const c of item.children) walk(c, `${menuName} > ${item.title}`, childTitles);
    }
  }

  for (const [menuName, items] of Object.entries(spec.menus || {})) {
    const top = new Set();
    for (const item of items) walk(item, menuName, top);
  }

  // module quicklinks that are raw external links need a target or a menu_item ref
  for (const [modKey, mod] of Object.entries(spec.modules || {})) {
    for (const it of mod.items || []) {
      const t = it.type || NEEDS_TARGET;
      if (t === NEEDS_TARGET && !it.menu_item) {
        if (!('target' in it)) errors.push(`module '${modKey}' > '${it.label}': needs a target or menu_item`);
        else if (isTbd(it.target) && !hasTbdQuestion) errors.push(`module '${modKey}' > '${it.label}': target is TBD but no open_questions entry`);
      }
    }
  }

  // grids must name a category (schema enforces presence; this checks non-TBD or flagged)
  for (const g of spec.grids || []) {
    if (isTbd(g.category) && !hasTbdQuestion) errors.push(`grid '${g.page}': category is TBD but no open_questions entry`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const VALID = {
  site: 'https://sacred-heart-emporia.example.com',
  source: 'SH-Emporia School Menu & Content.pdf',
  generated: '2026-06-15',
  menus: {
    mainmenu: [
      {
        title: 'About Sacred Heart School', type: 'heading', children: [
          { title: 'Welcome from the Principal', type: 'single_article', category: 'Page Articles', content_source: 'generate', notes: 'principal retiring' },
          { title: 'Faculty & Staff', type: 'single_article', category: 'Page Articles', content_source: 'pull', notes: 'no teacher pages' }
        ]
      },
      {
        title: 'News & Events', type: 'heading', children: [
          { title: 'Calendar', type: 'single_article', content_source: 'pull' },
          { title: 'Parish News', type: 'external_url', target: 'TBD', content_source: 'redirect' }
        ]
      }
    ],
    hiddenmenu: [
      { title: 'Church', type: 'external_url', target: 'TBD', content_source: 'redirect' }
    ]
  },
  modules: {
    toplinks: { items: [
      { label: 'Contact Us', type: 'external_url', target: 'TBD' },
      { label: 'Apply', type: 'external_url', target: 'TBD' }
    ] },
    under_rotator: { items: [
      { label: 'Schedule a Tour', type: 'external_url', target: 'https://www.shsemporia.org/request-information', notes: 'make into google form' },
      { label: 'Church', type: 'external_url', menu_item: 'Church' }
    ] }
  },
  grids: [
    { page: 'All News', menu_ref: 'News & Events', type: 'category_grid', category: 'News', particle: 'joomla_articles', member_menu_items: 'none' }
  ],
  open_questions: [
    'Parish News redirect target URL?',
    'Capital Campaign — which church URL?',
    'TopLinks targets for Contact Us / Giving / Apply?'
  ],
  assumptions: [
    '"Pull from website" leaves default to single_article in the Page Articles category',
    'All News is a category_grid with no per-article menu items'
  ]
};

// Each invalid fixture pairs a broken spec with the validator expected to flag it.
const INVALID = [
  {
    label: 'unknown item type rejected by schema',
    check: 'schema',
    spec: { site: 's', menus: { mainmenu: [{ title: 'X', type: 'wormhole' }] } }
  },
  {
    label: 'missing required title rejected by schema',
    check: 'schema',
    spec: { site: 's', menus: { mainmenu: [{ type: 'single_article' }] } }
  },
  {
    label: 'unexpected property rejected by schema',
    check: 'schema',
    spec: { site: 's', menus: { mainmenu: [{ title: 'X', type: 'heading', children: [{ title: 'Y', type: 'single_article' }], colour: 'red' }] } }
  },
  {
    label: 'TBD target without open_question flagged by lint',
    check: 'lint',
    spec: { site: 's', menus: { mainmenu: [{ title: 'Giving', type: 'external_url', target: 'TBD' }] } }
  },
  {
    label: 'grid member given its own menu item flagged by lint',
    check: 'lint',
    spec: { site: 's', menus: { mainmenu: [
      { title: 'News', type: 'category_grid', category: 'News', children: [{ title: 'Story 1', type: 'single_article' }] }
    ] } }
  },
  {
    label: 'category_grid without category flagged by lint',
    check: 'lint',
    spec: { site: 's', menus: { mainmenu: [{ title: 'News', type: 'category_grid' }] } }
  },
  {
    label: 'duplicate sibling titles flagged by lint',
    check: 'lint',
    spec: { site: 's', menus: { mainmenu: [
      { title: 'Calendar', type: 'single_article' },
      { title: 'Calendar', type: 'single_article' }
    ] } }
  }
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
let failures = 0;
function check(label, fn) {
  try { fn(); console.log(`  ok  ${label}`); }
  catch (err) { failures++; console.error(`FAIL  ${label} — ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('— valid fixture —');
check('valid spec passes schema', () => {
  const e = schemaErrors(VALID);
  assert(e.length === 0, `schema errors: ${e.join('; ')}`);
});
check('valid spec passes lint', () => {
  const e = lint(VALID);
  assert(e.length === 0, `lint errors: ${e.join('; ')}`);
});

console.log('— invalid fixtures are caught —');
for (const fx of INVALID) {
  check(fx.label, () => {
    const e = fx.check === 'schema' ? schemaErrors(fx.spec) : lint(fx.spec);
    assert(e.length > 0, 'expected at least one error, got none');
  });
}

console.log('— schema file is well-formed —');
check('schema declares menuItem recursion via $ref', () => {
  assert(schema.$defs && schema.$defs.menuItem, 'no $defs.menuItem');
  assert(schema.$defs.menuItem.properties.children.items.$ref === '#/$defs/menuItem', 'children not recursive');
});

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
