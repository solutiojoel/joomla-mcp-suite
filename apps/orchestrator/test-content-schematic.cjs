'use strict';

// Content Schematic acceptance test — structural schema validation + the
// intra-schematic lint rules. Run: node apps/orchestrator/test-content-schematic.cjs
//
// The structural validator is the same small JSON-Schema (draft-07 subset)
// walker used by test-menu-spec.cjs, so the schema file in config/ is actually
// enforced — no ajv / external deps. The lint mirror here covers the
// intra-schematic invariants; the cross-lint (schematic ↔ menu spec) and the
// derive/merge semantics are tested against the real implementation in
// apps/agents-mcp/src/schematic.test.ts, where the TS modules can be imported.

const fs   = require('fs');
const path = require('path');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'config', 'agents', 'content-build', 'content-schematic.schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

// ---------------------------------------------------------------------------
// Minimal JSON Schema (draft-07 subset) validator — mirrors test-menu-spec.cjs.
// ---------------------------------------------------------------------------
function resolveRef(ref, root) {
  const parts = ref.replace(/^#\//, '').split('/');
  return parts.reduce((node, key) => node[key], root);
}

function typeOf(v) {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

function validate(node, sch, root, pathStr, errors) {
  if (sch.$ref) return validate(node, resolveRef(sch.$ref, root), root, pathStr, errors);

  if (sch.type) {
    const t = typeOf(node);
    const want = sch.type === 'integer' ? 'number' : sch.type;
    if (t !== want) {
      errors.push(`${pathStr}: expected ${sch.type}, got ${t}`);
      return;
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

function schemaErrors(schematic) {
  const errors = [];
  validate(schematic, schema, schema, 'schematic', errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Intra-schematic lint mirror — rules #2–#5 of kb/content-schematic-schema
// (the cross-lint #6–#8 needs the derivation walk; see schematic.test.ts).
// ---------------------------------------------------------------------------
function lint(schematic) {
  const errors = [];
  const oq = (schematic.open_questions || []).map((q) => String(q).toLowerCase());
  const hasQuestion = (title) => oq.some((q) => q.includes(String(title).toLowerCase()));

  const keys = new Set();
  for (const e of schematic.entries || []) {
    if (keys.has(e.node_key)) errors.push(`entry '${e.node_key}': duplicate node_key`);
    keys.add(e.node_key);

    if (e.status === 'filled' && e.content_source === 'pull' && !e.source_url) {
      errors.push(`entry '${e.node_key}': filled pull entry without source_url`);
    }
    if (e.source_url === 'TBD' && !hasQuestion(e.title)) {
      errors.push(`entry '${e.node_key}': source_url TBD but no open_questions entry`);
    }
    if (e.status === 'needs_input' && !hasQuestion(e.title)) {
      errors.push(`entry '${e.node_key}': needs_input but no open_questions entry`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const VALID = {
  site: 'https://stmarys.example.org',
  source: 'StMarys-Menu.pdf',
  menu_spec_file: 'stmarys-menu-spec.json',
  generated: '2026-07-08',
  derived_at: '2026-07-08T12:00:00Z',
  entries: [
    {
      node_key: 'mainmenu:About Us/Welcome',
      kind: 'single_article',
      title: 'Welcome',
      menu_path: 'About Us / Welcome',
      category: 'Page Content',
      content_source: 'generate',
      joomla_article_id: '101',
      spec_notes: 'principal retiring',
      instructions: 'Write a fresh welcome letter.',
      status: 'filled'
    },
    {
      node_key: 'mainmenu:About Us/Our Staff',
      kind: 'grid_landing',
      title: 'Our Staff',
      category: 'Page Content',
      content_source: 'pull',
      source_url: 'https://old.stmarys.example.org/staff',
      features: [{ kind: 'staff-grid', kb_ref: 'kb/staff-grid' }],
      status: 'filled'
    },
    {
      node_key: 'grid:Our Staff/Jane Smith',
      kind: 'grid_member',
      title: 'Jane Smith',
      category: 'Staff Items',
      content_source: 'pull',
      source_url: 'TBD',
      status: 'needs_input'
    },
    {
      node_key: 'mainmenu:Bulletins',
      kind: 'docman',
      title: 'Bulletins',
      content_source: 'none',
      status: 'blocked'
    },
    {
      node_key: 'mainmenu:About Us/History',
      kind: 'single_article',
      title: 'History',
      category: 'Page Content',
      content_source: 'pull',
      source_url: 'https://old.stmarys.example.org/history',
      joomla_article_id: '104',
      source_file: 'stmarys-source/05-history.md',
      content_file: 'stmarys-html/05-history.html',
      applied_at: '2026-07-09T12:00:00Z',
      status: 'done'
    },
    {
      node_key: 'mainmenu:Welcome New Parishioners',
      kind: 'single_article',
      title: 'Welcome New Parishioners',
      category: 'Page Content',
      content_source: 'generate',
      instructions: 'Draft a welcome page for new parishioners.',
      content_file: 'stmarys-html/06-welcome-new-parishioners.html',
      draft: true,
      status: 'written'
    }
  ],
  open_questions: ['Jane Smith — no bio on current site; ask client'],
  assumptions: ['Grid members inherit the grid landing content_source']
};

// Each invalid fixture pairs a broken schematic with the check expected to flag it.
const INVALID = [
  {
    label: 'unknown kind rejected by schema',
    check: 'schema',
    schematic: { site: 's', entries: [{ node_key: 'k', kind: 'wormhole', title: 'X', content_source: 'pull', status: 'todo' }] }
  },
  {
    label: 'unknown status rejected by schema',
    check: 'schema',
    schematic: { site: 's', entries: [{ node_key: 'k', kind: 'single_article', title: 'X', content_source: 'pull', status: 'meh' }] }
  },
  {
    label: 'missing required node_key rejected by schema',
    check: 'schema',
    schematic: { site: 's', entries: [{ kind: 'single_article', title: 'X', content_source: 'pull', status: 'todo' }] }
  },
  {
    label: 'unexpected entry field rejected by schema',
    check: 'schema',
    schematic: { site: 's', entries: [{ node_key: 'k', kind: 'single_article', title: 'X', content_source: 'pull', status: 'todo', colour: 'red' }] }
  },
  {
    label: 'feature without kind rejected by schema',
    check: 'schema',
    schematic: { site: 's', entries: [{ node_key: 'k', kind: 'single_article', title: 'X', content_source: 'pull', status: 'todo', features: [{ kb_ref: 'kb/popup' }] }] }
  },
  {
    label: 'duplicate node_key flagged by lint',
    check: 'lint',
    schematic: { site: 's', entries: [
      { node_key: 'k', kind: 'single_article', title: 'X', content_source: 'none', status: 'todo' },
      { node_key: 'k', kind: 'single_article', title: 'Y', content_source: 'none', status: 'todo' }
    ] }
  },
  {
    label: 'filled pull entry without source_url flagged by lint',
    check: 'lint',
    schematic: { site: 's', entries: [{ node_key: 'k', kind: 'single_article', title: 'X', content_source: 'pull', status: 'filled' }] }
  },
  {
    label: 'TBD source_url without open_question flagged by lint',
    check: 'lint',
    schematic: { site: 's', entries: [{ node_key: 'k', kind: 'single_article', title: 'X', content_source: 'pull', source_url: 'TBD', status: 'filled' }] }
  },
  {
    label: 'needs_input without open_question flagged by lint',
    check: 'lint',
    schematic: { site: 's', entries: [{ node_key: 'k', kind: 'single_article', title: 'X', content_source: 'generate', status: 'needs_input' }] }
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
check('valid schematic passes schema', () => {
  const e = schemaErrors(VALID);
  assert(e.length === 0, `schema errors: ${e.join('; ')}`);
});
check('valid schematic passes lint', () => {
  const e = lint(VALID);
  assert(e.length === 0, `lint errors: ${e.join('; ')}`);
});
check('orphaned entry with preserved content passes schema and lint', () => {
  const s = JSON.parse(JSON.stringify(VALID));
  s.entries.push({
    node_key: 'mainmenu:Removed Page', kind: 'single_article', title: 'Removed Page',
    content_source: 'pull', source_url: 'https://old.example.org/removed',
    instructions: 'was filled before the spec edit', status: 'orphaned'
  });
  assert(schemaErrors(s).length === 0, 'schema errors');
  assert(lint(s).length === 0, 'lint errors');
});

console.log('— invalid fixtures are caught —');
for (const fx of INVALID) {
  check(fx.label, () => {
    const e = fx.check === 'schema' ? schemaErrors(fx.schematic) : lint(fx.schematic);
    assert(e.length > 0, 'expected at least one error, got none');
  });
}

console.log('— schema file is well-formed —');
check('schema declares entry/status/kind enums', () => {
  assert(schema.$defs && schema.$defs.entry, 'no $defs.entry');
  assert(schema.$defs.entryKind.enum.includes('grid_member'), 'entryKind enum incomplete');
  assert(schema.$defs.entryStatus.enum.includes('orphaned'), 'entryStatus enum incomplete');
  assert(schema.$defs.entryStatus.enum.includes('written'), 'entryStatus enum missing written');
  assert(schema.properties.entries.items.$ref === '#/$defs/entry', 'entries not $ref entry');
  for (const f of ['source_file', 'content_file', 'draft', 'applied_at']) {
    assert(schema.$defs.entry.properties[f], `entry schema missing content-build field '${f}'`);
  }
});

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
