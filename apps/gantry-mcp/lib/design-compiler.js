'use strict';

/**
 * design-compiler.js
 *
 * Compiles a simplified "design YAML" into import-ready Gantry 5 JSON.
 *
 * Design YAML is a human/AI-writable format that omits all the mechanical
 * boilerplate of the export format (no IDs, no deep container nesting).
 * The compiler handles:
 *   - ID generation  (subtype-NNNN, matching Gantry's convention)
 *   - Container/grid/block nesting reconstruction
 *   - Context variable substitution  ({{variable_path}})
 *   - Template file expansion  (template: footer-3col)
 *   - Structure validation
 *   - Human-readable tree summary
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const PARTICLES_DIR  = path.join(__dirname, '..', 'particles');
const TEMPLATES_DIR  = path.join(__dirname, '..', 'templates', 'sections');

/* ─── ID generator ──────────────────────────────────────────────────────── */

const _usedIds = new Set();

function resetIds() { _usedIds.clear(); }

function genId(subtype) {
  let id;
  do {
    const n = String(Math.floor(1000 + Math.random() * 9000));
    id = `${subtype}-${n}`;
  } while (_usedIds.has(id));
  _usedIds.add(id);
  return id;
}

/* ─── Context variable substitution ─────────────────────────────────────── */

function resolveVars(value, context) {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
      const parts = path.trim().split('.');
      let cur = context;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return _;
        cur = cur[p];
      }
      return (cur == null) ? _ : String(cur);
    });
  }
  if (Array.isArray(value)) return value.map(v => resolveVars(v, context));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveVars(v, context);
    return out;
  }
  return value;
}

/* ─── Template loader ────────────────────────────────────────────────────── */

function loadTemplate(name) {
  const file = path.join(TEMPLATES_DIR, `${name}.yaml`);
  if (!fs.existsSync(file)) throw new Error(`Template not found: ${name}`);
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

/* ─── Particle catalog loader ────────────────────────────────────────────── */

let _catalog = null;
function loadCatalog() {
  if (_catalog) return _catalog;
  _catalog = {};
  if (!fs.existsSync(PARTICLES_DIR)) return _catalog;
  for (const f of fs.readdirSync(PARTICLES_DIR)) {
    if (!f.endsWith('.yaml')) continue;
    try {
      const p = yaml.load(fs.readFileSync(path.join(PARTICLES_DIR, f), 'utf8'));
      if (p && p.name) _catalog[p.name] = p;
    } catch {}
  }
  return _catalog;
}

/* ─── Node builders ──────────────────────────────────────────────────────── */

function makeBlock(size, blockClass, child) {
  return {
    id:       genId('block'),
    type:     'block',
    subtype:  'block',
    layout:   true,
    attributes: {
      size: size,
      ...(blockClass ? { class: blockClass } : {}),
    },
    children: child ? [child] : [],
  };
}

function makeGrid(blocks) {
  return {
    id:         genId('grid'),
    type:       'grid',
    subtype:    'grid',
    layout:     true,
    attributes: {},
    children:   blocks,
  };
}

function makeContainer(id, title, sectionClass, children) {
  return {
    id:       id || genId('container'),
    type:     'container',
    subtype:  'container',
    layout:   true,
    title:    title || 'Container',
    attributes: {
      boxed: '',
      class: sectionClass || '',
      extra: [],
    },
    children: [makeGrid([makeBlock(100, '', { type: 'section-wrapper', children })])],
  };
}

/* ─── Particle node builder ──────────────────────────────────────────────── */

const SYSTEM_SUBTYPES = new Set(['messages', 'content', 'head', 'footer']);

/* ─── Base Outline inherited sections ───────────────────────────────────────
 * These sections are inherited by all non-base outlines from the Base Outline.
 * (Navigation, Bottom, Footer, Copyright, Offcanvas)
 * If a design YAML doesn't explicitly define them, the compiler injects
 * inheritance stubs so a full import never wipes out inherited sections.
 * Set  preserve_base_inheritance: false  in design YAML to suppress.
 */
const BASE_SECTIONS = [
  { id: 'navigation', type: 'section', title: 'Navigation' },
  { id: 'bottom',     type: 'section', title: 'Bottom'     },
  { id: 'footer',     type: 'section', title: 'Footer'     },
  { id: 'copyright',  type: 'section', title: 'Copyright'  },
  { id: 'offcanvas',  type: 'offcanvas', title: 'Offcanvas' },
];

const ALWAYS_INHERITED_SECTION_IDS = new Set(BASE_SECTIONS.map(s => s.id));

function makeInheritanceStub(sectionDef) {
  return {
    id:       sectionDef.id,
    type:     sectionDef.type || 'section',
    subtype:  sectionDef.type || 'section',
    layout:   true,
    title:    sectionDef.title,
    attributes: { boxed: '', class: '', variations: '' },
    inherit:  { outline: 'default', include: ['attributes', 'block', 'children'] },
    children: [],
  };
}

function collectNodeIds(layout) {
  const ids = new Set();
  function w(nodes) {
    if (!Array.isArray(nodes)) nodes = [nodes];
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (node.id) ids.add(node.id);
      if (node.children) w(node.children);
    }
  }
  w(layout);
  return ids;
}

function pruneInheritedSections(nodes, warnings, parentId = 'layout') {
  if (!Array.isArray(nodes)) return nodes;
  const kept = [];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (ALWAYS_INHERITED_SECTION_IDS.has(node.id) && !(node.inherit && node.inherit.outline)) {
      warnings.push(
        `${node.id}: removed explicit ${node.type || 'section'} from ${parentId}; ` +
        'Home/sub-outlines inherit navigation, bottom, footer, copyright, and offcanvas from the Base Outline.'
      );
      continue;
    }
    if (Array.isArray(node.children)) {
      node.children = pruneInheritedSections(node.children, warnings, node.id || parentId);
    }
    kept.push(node);
  }
  return kept;
}



function makeParticleNode(blockDef, context) {
  const raw = blockDef.particle || '';
  const [ptype, psubtype] = raw.includes('/')
    ? raw.split('/')
    : ['particle', raw];

  // Special cases
  if (raw === 'spacer') {
    return { id: genId('spacer'), type: 'spacer', subtype: 'spacer', layout: true, title: blockDef.title || 'Spacer', attributes: {} };
  }
  if (raw === 'position' || blockDef.position_type) {
    const posSubtype = blockDef.position_type === 'module' ? 'module' : 'position';
    return { id: genId(`position-${posSubtype}`), type: 'position', subtype: posSubtype, layout: true, title: blockDef.title || 'Position', attributes: {} };
  }

  const resolvedType    = SYSTEM_SUBTYPES.has(psubtype) ? 'system' : ptype;
  const resolvedSubtype = psubtype || ptype;
  const id = genId(resolvedSubtype === 'messages' ? 'system-messages' : resolvedSubtype);
  const attrs = resolveVars(blockDef.attributes || {}, context);
  if (!('enabled' in attrs) && resolvedType === 'particle') attrs.enabled = 1;

  return {
    id,
    type:       resolvedType,
    subtype:    resolvedSubtype,
    layout:     true,
    title:      blockDef.title || resolvedSubtype,
    attributes: attrs,
    inherit:    {},
    children:   [],
  };
}

/* ─── Grid row compiler ──────────────────────────────────────────────────── */

function compileGridRow(blocks, context) {
  const builtBlocks = blocks.map(blockDef => {
    if (blockDef.template) {
      // Template expansion within a block — not typical but handle it
      const tmpl = loadTemplate(blockDef.template);
      return compileSection(tmpl, context);
    }
    const particleNode = makeParticleNode(blockDef, context);
    return makeBlock(blockDef.size || 100, blockDef.blockClass || '', particleNode);
  });
  return makeGrid(builtBlocks);
}

/* ─── Section compiler ───────────────────────────────────────────────────── */

function compileSection(sectionDef, context) {
  if (sectionDef.template) {
    const tmpl = loadTemplate(sectionDef.template);
    return compileSection(resolveVars(tmpl, context), context);
  }

  const grids = (sectionDef.grids || []).map(gridDef =>
    compileGridRow(gridDef.blocks || [], context)
  );

  const sectionNode = {
    id:       sectionDef.id || genId('section'),
    type:     sectionDef.type === 'section' ? 'section' : (sectionDef.type || 'section'),
    subtype:  sectionDef.subtype || sectionDef.type || 'section',
    layout:   true,
    title:    sectionDef.title || capitalize(sectionDef.id || 'Section'),
    attributes: {
      boxed:      sectionDef.boxed !== undefined ? String(sectionDef.boxed) : '',
      class:      (sectionDef.attributes && sectionDef.attributes.class) || '',
      variations: '',
    },
    children: grids,
  };

  if (sectionDef.inherit) {
    sectionNode.inherit = {
      outline: sectionDef.inherit,
      include: ['attributes', 'block', 'children'],
    };
  }

  return sectionNode;
}

/* ─── Main container compiler ────────────────────────────────────────────── */

/**
 * Compiles the main content area.
 * Supports a flat sections array or the sidebar/mainbar/aside shorthand.
 */
function compileMainContainer(mainDef, context) {
  if (!mainDef) return null;

  let sections = [];

  if (mainDef.layout === 'sidebar-main-aside') {
    // 55/30/15 split
    const sidebarSections  = compileSectionGroup(mainDef.sidebar,  context);
    const mainbarSections  = compileSectionGroup(mainDef.mainbar,  context);
    const asideSections    = compileSectionGroup(mainDef.aside,    context);

    const mainGrid = makeGrid([
      makeBlock(55, '', wrapInSection(sidebarSections, mainDef.sidebar, 'aside')),
      makeBlock(30, '', wrapInSection(mainbarSections, mainDef.mainbar, 'main')),
      makeBlock(15, '', wrapInSection(asideSections,   mainDef.aside,   'aside')),
    ]);

    return {
      id:       genId('container'),
      type:     'container',
      subtype:  'container',
      layout:   true,
      title:    'Container-main',
      attributes: { boxed: '2', class: '', extra: [] },
      children: [mainGrid],
    };
  }

  // Flat sections list
  for (const sectionDef of (mainDef.sections || [])) {
    sections.push(compileSection(sectionDef, context));
  }
  return buildContainerFromSections('container-main', 'Container-main', sections);
}

function compileSectionGroup(def, context) {
  if (!def) return [];
  const sectionNode = {
    id:       def.section_id || def.id || genId('section'),
    type:     def.type || 'aside',
    subtype:  def.type || 'aside',
    layout:   true,
    title:    capitalize(def.section_id || def.id || 'Section'),
    attributes: {
      boxed: '',
      class: (def.attributes && def.attributes.class) || '',
      variations: '',
    },
    children: (def.grids || []).map(g => compileGridRow(g.blocks || [], context)),
  };
  return [sectionNode];
}

function wrapInSection(sections, def, fallbackType) {
  if (sections.length === 1) return sections[0];
  // Multiple sections — wrap in a block-level section
  const wrapper = {
    id:       genId('section'),
    type:     fallbackType,
    subtype:  fallbackType,
    layout:   true,
    title:    capitalize(fallbackType),
    attributes: { boxed: '', class: '', variations: '' },
    children: sections,
  };
  return wrapper;
}

function buildContainerFromSections(id, title, sections) {
  return {
    id:         id || genId('container'),
    type:       'container',
    subtype:    'container',
    layout:     true,
    title:      title || 'Container',
    attributes: { boxed: '2', class: '', extra: [] },
    children:   sections.map(s => makeGrid([makeBlock(100, '', s)])),
  };
}

/* ─── Offcanvas compiler ─────────────────────────────────────────────────── */

function compileOffcanvas(def, context) {
  if (!def) {
    // Default offcanvas with mobile-menu
    const mobileMenu = {
      id: genId('mobile-menu'), type: 'particle', subtype: 'mobile-menu',
      layout: true, title: 'Mobile Menu', attributes: { enabled: 1 }, inherit: {}, children: [],
    };
    return {
      id: 'offcanvas', type: 'offcanvas', subtype: 'offcanvas', layout: true, title: 'Offcanvas',
      children: [makeGrid([makeBlock(100, '', mobileMenu)])],
    };
  }
  const grids = (def.grids || []).map(g => compileGridRow(g.blocks || [], context));
  return {
    id: 'offcanvas', type: 'offcanvas', subtype: 'offcanvas', layout: true, title: 'Offcanvas',
    children: grids,
  };
}

/* ─── Top/footer container compilers ────────────────────────────────────── */

function compileTopContainer(topDef, context) {
  if (!topDef) return defaultTopContainer(context);

  const sections = (topDef.sections || []).map(s => {
    if (s.template) return compileSection(resolveVars(loadTemplate(s.template), context), context);
    return compileSection(s, context);
  });

  return buildTopContainer(sections);
}

function buildTopContainer(sections) {
  return {
    id: 'container-top',
    type: 'container',
    subtype: 'container',
    layout: true,
    title: 'Container-top',
    attributes: { boxed: '', class: '', extra: [] },
    children: sections.map(s => makeGrid([makeBlock(100, '', s)])),
  };
}

function defaultTopContainer(context) {
  const systemMessages = {
    id: genId('system-messages'), type: 'system', subtype: 'messages',
    layout: true, title: 'System Messages', attributes: { enabled: 1 }, inherit: {}, children: [],
  };
  const topSection = {
    id: 'top', type: 'section', subtype: 'section', layout: true, title: 'Top',
    attributes: { boxed: '', class: '', variations: '' },
    children: [makeGrid([makeBlock(100, '', systemMessages)])],
  };
  return buildTopContainer([topSection]);
}

function compileFooterContainer(footerDef, context) {
  if (!footerDef) return null;

  if (footerDef.template) {
    const tmpl = loadTemplate(footerDef.template);
    return compileFooterContainer(resolveVars(tmpl, context), context);
  }

  // Support three shapes:
  //  1. { sections: [...] }  — flat array
  //  2. { sections: { footer: {...}, copyright: {...} } }  — named object (from template files)
  //  3. { footer: {...}, copyright: {...} }  — named keys at top level
  let sectionDefs;
  if (Array.isArray(footerDef.sections)) {
    sectionDefs = footerDef.sections;
  } else if (footerDef.sections && typeof footerDef.sections === 'object') {
    sectionDefs = Object.values(footerDef.sections);
  } else {
    // Top-level named keys — filter to objects with an id or type
    sectionDefs = Object.values(footerDef).filter(v => v && typeof v === 'object' && (v.id || v.type));
  }

  const sections = sectionDefs.map(s => compileSection(s, context));

  return {
    id: genId('container'),
    type: 'container',
    subtype: 'container',
    layout: true,
    title: 'Container-footer',
    attributes: { boxed: '', class: '', extra: [] },
    children: sections.map(s => makeGrid([makeBlock(100, '', s)])),
  };
}

/* ─── Top-level compile ──────────────────────────────────────────────────── */

/**
 * Compile a design YAML object into a Gantry-compatible layout structure array.
 * @param {object} design   — parsed design YAML
 * @param {object} context  — runtime context variables (overrides design.context)
 * @returns {{ layout: Array, errors: Array, warnings: Array, treeSummary: string }}
 */
function compile(design, context) {
  resetIds();
  const errors   = [];
  const warnings = [];
  const ctx      = Object.assign({}, design.context || {}, context || {});

  const layout = [];

  // 1. Top container (navigation + hero sections)
  try {
    layout.push(compileTopContainer(design.top_container, ctx));
  } catch (e) { errors.push(`top_container: ${e.message}`); }

  // 2. Free-standing sections (above, feature, showcase, utility, etc.)
  //    Listed outside any container
  for (const sectionDef of (design.sections || [])) {
    try {
      layout.push(compileSection(sectionDef, ctx));
    } catch (e) { errors.push(`section[${sectionDef.id}]: ${e.message}`); }
  }

  // 3. Main container
  if (design.main_container) {
    try {
      const mc = compileMainContainer(design.main_container, ctx);
      if (mc) layout.push(mc);
    } catch (e) { errors.push(`main_container: ${e.message}`); }
  }

  // 4. Additional top-level sections (expanded, extension, bottom, etc.)
  for (const sectionDef of (design.extra_sections || [])) {
    try {
      layout.push(compileSection(sectionDef, ctx));
    } catch (e) { errors.push(`extra_section[${sectionDef.id}]: ${e.message}`); }
  }

  // 5. Footer container
  if (design.footer_container) {
    try {
      const fc = compileFooterContainer(design.footer_container, ctx);
      if (fc) layout.push(fc);
    } catch (e) { errors.push(`footer_container: ${e.message}`); }
  }

  // 6. Offcanvas
  if (design.offcanvas || design.preserve_base_inheritance === false) {
    try {
      layout.push(compileOffcanvas(design.offcanvas, ctx));
    } catch (e) { errors.push(`offcanvas: ${e.message}`); }
  }

  // Inject Base Outline inheritance stubs for any missing standard sections.
  // Ensures a full import never silently drops inherited navigation/footer/etc.
  // Suppress with: preserve_base_inheritance: false in design YAML for Base Outline work.
  if (design.preserve_base_inheritance !== false) {
    const cleaned = pruneInheritedSections(layout, warnings);
    layout.length = 0;
    layout.push(...cleaned);
    const existingIds = collectNodeIds(layout);
    const stubs = BASE_SECTIONS
      .filter(sec => !existingIds.has(sec.id))
      .map(makeInheritanceStub);
    if (stubs.length) layout.push(...stubs);
  }

  // Validate
  validateLayout(layout, errors, warnings);

  return {
    layout,
    errors,
    warnings,
    valid: errors.length === 0,
    treeSummary: buildTreeSummary(layout),
  };
}

/* ─── Validation ─────────────────────────────────────────────────────────── */

function validateLayout(layout, errors, warnings) {
  const catalog = loadCatalog();
  walk(layout, (node) => {
    // Validate particle types against catalog
    if (node.type === 'particle' && node.subtype) {
      if (catalog && Object.keys(catalog).length > 0 && !catalog[node.subtype]) {
        errors.push(
          `Unknown particle subtype: "${node.subtype}" (id: ${node.id}) — ` +
          `Gantry will render "Missing content: particle cannot be found". ` +
          `Valid subtypes: ${Object.keys(catalog).sort().join(', ')}`
        );
      }
    }
    // Validate grid sizes sum to ~100
    if (node.type === 'grid' && node.children && node.children.length > 0) {
      const total = node.children.reduce((sum, b) => sum + (parseFloat(b.attributes && b.attributes.size) || 0), 0);
      if (Math.abs(total - 100) > 1) {
        warnings.push(`Grid ${node.id}: block sizes sum to ${total.toFixed(1)}, expected 100`);
      }
    }
  });
}

function walk(nodes, fn) {
  if (!Array.isArray(nodes)) nodes = [nodes];
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    fn(node);
    if (node.children) walk(node.children, fn);
  }
}

/* ─── Tree summary ───────────────────────────────────────────────────────── */

function buildTreeSummary(layout, indent = 0) {
  const lines = [];
  const pad = '  '.repeat(indent);
  for (const node of (Array.isArray(layout) ? layout : [layout])) {
    if (!node || typeof node !== 'object') continue;
    const t  = node.type || '?';
    const st = node.subtype || '';
    const id = node.id || '';
    const title = node.title ? ` "${node.title}"` : '';
    const cls = (node.attributes && node.attributes.class) ? ` class="${node.attributes.class}"` : '';
    const bc  = (node.attributes && node.attributes.class && t === 'block') ? ` [${node.attributes.class}]` : '';
    const size = (node.attributes && node.attributes.size) ? ` size=${node.attributes.size}` : '';
    lines.push(`${pad}${t}/${st} [${id}]${title}${cls}${bc}${size}`);
    if (node.children && node.children.length) {
      lines.push(buildTreeSummary(node.children, indent + 1));
    }
  }
  return lines.join('\n');
}

/* ─── YAML entry point ───────────────────────────────────────────────────── */

/**
 * Compile a design YAML string.
 */
function compileYaml(yamlString, context) {
  const design = yaml.load(yamlString);
  if (!design || typeof design !== 'object') throw new Error('Design YAML is empty or invalid');
  return compile(design, context);
}

/**
 * Compile a design YAML file.
 */
function compileFile(filePath, context) {
  const content = fs.readFileSync(filePath, 'utf8');
  return compileYaml(content, context);
}

/* ─── Particle catalog API ───────────────────────────────────────────────── */

function getParticleCatalog(subtype) {
  const catalog = loadCatalog();
  if (subtype) return catalog[subtype] || null;
  return catalog;
}

/* ─── Section template API ───────────────────────────────────────────────── */

function getSectionTemplates(name) {
  if (name) return loadTemplate(name);
  // Return index of all templates
  const templates = [];
  if (!fs.existsSync(TEMPLATES_DIR)) return templates;
  for (const f of fs.readdirSync(TEMPLATES_DIR)) {
    if (!f.endsWith('.yaml')) continue;
    try {
      const tmpl = yaml.load(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'));
      const fname = f.replace('.yaml', '');
      // Extract description from leading comment if present
      const raw = fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8');
      const commentMatch = raw.match(/^#\s*Section Template:\s*(.+)/m);
      const usageMatch   = raw.match(/^#\s*Usage:\s*(.+)/m);
      templates.push({
        name:        fname,
        title:       commentMatch ? commentMatch[1].trim() : fname,
        usage:       usageMatch  ? usageMatch[1].trim()   : '',
        yaml_content: raw,
      });
    } catch {}
  }
  return templates;
}

/* ─── Brief → design YAML scaffolding ───────────────────────────────────── */

const BRIEF_PATTERNS = [
  { pattern: /hero|slider|swiper|slideshow/i,  template: 'hero-swiper' },
  { pattern: /quicklink|utility|welcome/i,     template: 'utility-quicklinks' },
  { pattern: /news|event|feed/i,               template: 'news-events-grid' },
  { pattern: /link.?box|ministr|card.?grid|resource.?grid/i, template: 'link-boxes' },
  { pattern: /footer/i,                        template: 'footer-3col' },
  { pattern: /alert|announcement|banner/i,     template: 'alert-banner' },
];

function briefToDesignYaml(brief, context) {
  const notes = [];
  const usedTemplates = [];

  for (const { pattern, template } of BRIEF_PATTERNS) {
    if (pattern.test(brief)) {
      usedTemplates.push(template);
      notes.push(`Detected "${template}" from brief`);
    }
  }

  // Build the design YAML scaffold
  const parishName  = extractParishName(brief) || 'Our Parish';
  const menuId      = extractNumber(brief, /(?:main\s+)?menu\s+(?:id\s+)?(?:is\s+)?(\d+)/i) || 1;

  let yamlLines = [
    `schema: 2`,
    `outline: "#Home"`,
    ``,
    `context:`,
    `  parish_name: "${parishName}"`,
    `  menu_id: ${menuId}`,
    `  # Fill in these IDs from joomla_list_categories and joomla_list_articles:`,
    `  mass_times_article_id: ""`,
    `  news_category_id: ""`,
    `  social_article_id: ""`,
    `  footer_article_id: ""`,
    `  alert_category_id: ""`,
    ``,
    `top_container:`,
    `  sections:`,
    `    # Navigation is inherited from the Base Outline.`,
  ];

  const topSections   = [];
  const mainSections  = [];
  const extraSections = [];

  if (usedTemplates.includes('alert-banner'))      topSections.push('    - template: alert-banner');
  if (usedTemplates.includes('hero-swiper'))       topSections.push('    - template: hero-swiper');
  if (usedTemplates.includes('utility-quicklinks')) topSections.push('    - template: utility-quicklinks');

  if (topSections.length) {
    yamlLines = yamlLines.concat(topSections);
  }

  if (usedTemplates.includes('news-events-grid')) {
    yamlLines.push('');
    yamlLines.push('main_container:');
    yamlLines.push('  layout: sidebar-main-aside');
    yamlLines.push('  # Populated from news-events-grid template — edit context IDs above');
    yamlLines.push('  sidebar:');
    yamlLines.push('    section_id: sidebar');
    yamlLines.push('    attributes: { class: "news-to-me headlines-spacing" }');
    yamlLines.push('    grids:');
    yamlLines.push('      - blocks:');
    yamlLines.push('          - size: 100');
    yamlLines.push('            blockClass: ph-sideway-stack');
    yamlLines.push('            particle: contentarray');
    yamlLines.push('            title: "News & Events"');
    yamlLines.push('            attributes:');
    yamlLines.push('              article:');
    yamlLines.push('                filter: { categories: "{{news_category_id}}", featured: include }');
    yamlLines.push('                limit: { total: "4", columns: "1" }');
    yamlLines.push('                display:');
    yamlLines.push('                  image: { enabled: "full" }');
    yamlLines.push('                  title: { enabled: "show" }');
    yamlLines.push('                  text: { type: "intro", limit: "90", formatting: "text" }');
    yamlLines.push('                  read_more: { enabled: "show" }');
    yamlLines.push('                sort: { orderby: ordering, ordering: ASC }');
    yamlLines.push('  mainbar:');
    yamlLines.push('    section_id: mainbar');
    yamlLines.push('    grids:');
    yamlLines.push('      - blocks:');
    yamlLines.push('          - size: 100');
    yamlLines.push('            blockClass: facebook-widget-container widget-container');
    yamlLines.push('            particle: contentarray');
    yamlLines.push('            title: "Social Feed"');
    yamlLines.push('            attributes:');
    yamlLines.push('              article:');
    yamlLines.push('                filter: { articles: "{{social_article_id}}", featured: include }');
    yamlLines.push('                limit: { total: "1", columns: "1" }');
    yamlLines.push('                display: { pagination_buttons: "" }');
    yamlLines.push('                sort: { orderby: ordering, ordering: ASC }');
    yamlLines.push('  aside:');
    yamlLines.push('    section_id: aside');
    yamlLines.push('    grids:');
    yamlLines.push('      - blocks:');
    yamlLines.push('          - size: 100');
    yamlLines.push('            blockClass: "ads-903 side-ads"');
    yamlLines.push('            particle: position');
    yamlLines.push('            title: "Home Ads"');
    yamlLines.push('            position_type: module');
  }

  if (usedTemplates.includes('link-boxes')) {
    yamlLines.push('');
    yamlLines.push('extra_sections:');
    yamlLines.push('  - template: link-boxes');
  }

  if (usedTemplates.includes('footer-3col')) {
    yamlLines.push('');
    yamlLines.push('footer_container:');
    yamlLines.push('  template: footer-3col');
  }

  return { design_yaml: yamlLines.join('\n'), notes };
}

function extractParishName(brief) {
  const m = brief.match(/(?:for|of)\s+([A-Z][A-Za-z .']+?Parish|[A-Z][A-Za-z .']+?Church)/);
  return m ? m[1].trim() : null;
}

function extractNumber(brief, re) {
  const m = brief.match(re);
  return m ? parseInt(m[1], 10) : null;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}


/* ═══════════════════════════════════════════════════════════════════════════
   BLUEPRINT DECOMPILER  (Gantry export JSON → design YAML)
   ═══════════════════════════════════════════════════════════════════════════ */

const HOMEPAGES_DIR = path.join(__dirname, '..', 'templates', 'homepages');

function extractRootFromBlueprint(input) {
  if (Array.isArray(input)) return input;
  if (input.data && input.data.blueprint && input.data.blueprint.layout)
    return input.data.blueprint.layout.root;
  if (input.layout && input.layout.root) return input.layout.root;
  if (input.blueprint && input.blueprint.layout) return input.blueprint.layout.root;
  throw new Error('Cannot find layout root in provided blueprint');
}

function isInheritedNode(node) {
  return !!(node && node.inherit && node.inherit.outline);
}

function innerNodesOfContainer(containerNode) {
  const found = [];
  for (const grid of (containerNode.children || [])) {
    if (grid.type !== 'grid') continue;
    for (const block of (grid.children || [])) {
      if (block.type !== 'block') continue;
      for (const child of (block.children || [])) found.push(child);
    }
  }
  return found;
}

function decompileSectionNode(node, opts) {
  if (!node || typeof node !== 'object') return null;
  const out = { id: node.id };
  if (node.type && node.type !== 'section') out.type = node.type;
  if (isInheritedNode(node)) { out.inherit = node.inherit.outline; return out; }
  const cls  = node.attributes && node.attributes.class;
  const vari = node.attributes && node.attributes.variations;
  if (cls)  out.class = cls;
  if (vari) out.variations = vari;
  const grids = [];
  for (const grid of (node.children || [])) {
    if (grid.type !== 'grid') continue;
    const blocks = [];
    for (const block of (grid.children || [])) {
      if (block.type !== 'block') continue;
      const b = decompileBlockNode(block, opts);
      if (b) blocks.push(b);
    }
    if (blocks.length) grids.push({ blocks });
  }
  if (grids.length) out.grids = grids;
  return out;
}

function decompileBlockNode(block, opts) {
  if (!block) return null;
  const size       = (block.attributes && block.attributes.size) || 100;
  const blockClass = (block.attributes && block.attributes.class) || '';
  const particle   = (block.children || [])[0];
  if (!particle) return null;
  const def = { size };
  if (blockClass) def.blockClass = blockClass;
  if (isInheritedNode(particle)) {
    def.particle = particle.subtype || particle.type;
    if (particle.title) def.title = particle.title;
    def.inherit = particle.inherit.outline;
    return def;
  }
  if (particle.type === 'spacer')   { def.particle = 'spacer'; return def; }
  if (particle.type === 'position') {
    def.particle = 'position';
    if (particle.title) def.title = particle.title;
    def.position_type = particle.subtype === 'module' ? 'module' : 'position';
    if (particle.attributes && particle.attributes.key) def.position_key = particle.attributes.key;
    return def;
  }
  def.particle = particle.subtype || particle.type;
  if (particle.title) def.title = particle.title;
  const attrs = decompileParticleAttrs(def.particle, particle.attributes || {}, opts);
  if (Object.keys(attrs).length) def.attributes = attrs;
  return def;
}

function decompileParticleAttrs(subtype, attrs, opts) {
  opts = opts || {};
  const maxHtml  = opts.maxHtmlLen || 400;
  const truncate = opts.truncateHtml !== false;
  if (subtype === 'custom') {
    const h = attrs.html || '';
    return { html: (truncate && h.length > maxHtml) ? h.slice(0, maxHtml) + ' ...[truncated]' : h };
  }
  if (subtype === 'contentarray') return attrs.article ? { article: attrs.article } : {};
  if (subtype === 'swiper') {
    const keep = ['source','height','navigation','pagination','autoplay','loop','speed','effect','slides'];
    const out = {};
    for (const k of keep) if (attrs[k] !== undefined) out[k] = attrs[k];
    return out;
  }
  if (subtype === 'blockcontent')  return attrs.subcontents ? { subcontents: attrs.subcontents } : {};
  if (subtype === 'menu') {
    const out = {};
    if (attrs.menu_id)    out.menu_id    = attrs.menu_id;
    if (attrs.startLevel) out.startLevel = attrs.startLevel;
    return out;
  }
  if (subtype === 'logo' || subtype === 'mobile-menu') return {};
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'enabled' && v === 1) continue;
    if (v === null || v === undefined || v === '') continue;
    out[k] = v;
  }
  return out;
}

function decompileColumnBlock(blockNode, opts) {
  const section = (blockNode.children || [])[0];
  if (!section) return {};
  const result = { section_id: section.id };
  if (section.type && section.type !== 'section') result.type = section.type;
  if (section.attributes && section.attributes.class) result.class = section.attributes.class;
  const grids = (section.children || []).filter(g => g.type === 'grid').map(g => ({
    blocks: (g.children || []).filter(b => b.type === 'block')
              .map(b => decompileBlockNode(b, opts)).filter(Boolean)
  })).filter(g => g.blocks.length);
  if (grids.length) result.grids = grids;
  return result;
}

/**
 * Decompile a Gantry blueprint (export JSON) into a design YAML object + string.
 * @param {object|Array} input   Blueprint JSON, raw root array, or export tool response
 * @param {object}       opts    { truncateHtml, maxHtmlLen }
 * @returns {{ design: object, yaml: string }}
 */
function decompile(input, opts) {
  opts = opts || {};
  const root = extractRootFromBlueprint(input);
  const design = { schema: 2, preserve_base_inheritance: false };
  const standalone = [];

  for (const node of root) {
    if (!node || typeof node !== 'object') continue;

    if (node.type === 'container') {
      const inner = innerNodesOfContainer(node);

      if (node.id === 'container-top') {
        design.top_container = { sections: inner.map(s => decompileSectionNode(s, opts)).filter(Boolean) };

      } else if (node.id && node.id.startsWith('container-main')) {
        // Detect sidebar/mainbar/aside: grid with >1 blocks
        let multiCol = false;
        for (const grid of (node.children || [])) {
          if (grid.type === 'grid' && grid.children && grid.children.length > 1) {
            multiCol = true;
            const cols = grid.children;
            design.main_container = { layout: 'sidebar-main-aside' };
            if (cols[0]) design.main_container.sidebar  = decompileColumnBlock(cols[0], opts);
            if (cols[1]) design.main_container.mainbar  = decompileColumnBlock(cols[1], opts);
            if (cols[2]) design.main_container.aside    = decompileColumnBlock(cols[2], opts);
            break;
          }
        }
        if (!multiCol)
          design.main_container = { sections: inner.map(s => decompileSectionNode(s, opts)).filter(Boolean) };

      } else {
        design.footer_container = { sections: inner.map(s => decompileSectionNode(s, opts)).filter(Boolean) };
      }

    } else if (node.type === 'offcanvas') {
      if (!isInheritedNode(node)) {
        const grids = (node.children || []).filter(g => g.type === 'grid').map(g => ({
          blocks: (g.children || []).filter(b => b.type === 'block')
                    .map(b => decompileBlockNode(b, opts)).filter(Boolean)
        })).filter(g => g.blocks.length);
        if (grids.length) design.offcanvas = { grids };
      }
    } else {
      const s = decompileSectionNode(node, opts);
      if (s) standalone.push(s);
    }
  }

  if (standalone.length) design.sections = standalone;
  const yamlStr = yaml.dump(design, { lineWidth: 120, noRefs: true, indent: 2 });
  return { design, yaml: yamlStr };
}

/* ═══════════════════════════════════════════════════════════════════════════
   HOMEPAGE LIBRARY QUERY
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Query the homepage blueprint library.
 * slug=null returns an index; slug=string returns that site's meta (+ optionally blueprint/decompiled YAML).
 * options: { outline_type, site_type, has_school, theme, include_blueprint, include_decompiled, search_block_class }
 */
function getHomepageExamples(slug, options) {
  options = options || {};
  if (!fs.existsSync(HOMEPAGES_DIR))
    return { error: 'Homepage library not found', path: HOMEPAGES_DIR };

  if (slug) {
    const type     = (options.outline_type || 'home').replace(' ', '_');
    const metaPath = path.join(HOMEPAGES_DIR, `${slug}-${type}-meta.yaml`);
    const bpPath   = path.join(HOMEPAGES_DIR, `${slug}-${type}.json`);
    if (!fs.existsSync(metaPath))
      return { error: `No ${type} example for slug: ${slug}` };

    const meta   = yaml.load(fs.readFileSync(metaPath, 'utf8'));
    const result = { slug, outline_type: type, meta };

    if (options.include_blueprint && fs.existsSync(bpPath)) {
      try { result.blueprint = JSON.parse(fs.readFileSync(bpPath, 'utf8')); }
      catch (e) { result.blueprint_error = e.message; }
    }
    if (options.include_decompiled && fs.existsSync(bpPath)) {
      try {
        const bp = JSON.parse(fs.readFileSync(bpPath, 'utf8'));
        result.decompiled_yaml = decompile(bp, { truncateHtml: true, maxHtmlLen: 300 }).yaml;
      } catch (e) { result.decompile_error = e.message; }
    }
    return result;
  }

  // List / filter
  const summaryPath = path.join(HOMEPAGES_DIR, '_capture-summary.yaml');
  let sites = [];
  if (fs.existsSync(summaryPath)) {
    const summary = yaml.load(fs.readFileSync(summaryPath, 'utf8'));
    sites = summary.sites || [];
  } else {
    for (const f of fs.readdirSync(HOMEPAGES_DIR)) {
      const m = f.match(/^(.+)-home-meta\.yaml$/);
      if (m) sites.push({ slug: m[1] });
    }
  }

  if (options.site_type)          sites = sites.filter(s => s.site_type === options.site_type);
  if (options.has_school)         sites = sites.filter(s => s.school_home_outline_id);
  if (options.theme)              sites = sites.filter(s => s.theme     === options.theme);
  if (options.search_block_class) {
    const needle = options.search_block_class.toLowerCase();
    sites = sites.filter(s => {
      const mf = path.join(HOMEPAGES_DIR, `${s.slug}-home-meta.yaml`);
      return fs.existsSync(mf) && fs.readFileSync(mf, 'utf8').toLowerCase().includes(needle);
    });
  }

  return {
    total: sites.length,
    sites: sites.map(s => ({
      slug:            s.slug,
      url:             s.url,
      site_type:       s.site_type,
      has_home:        !!s.home_outline_id,
      has_school_home: !!s.school_home_outline_id,
      status:          s.status,
      notes:           s.notes || undefined,
    })),
  };
}

/* ─── Exports ────────────────────────────────────────────────────────────── */

module.exports = {
  compile,
  compileYaml,
  compileFile,
  decompile,
  getParticleCatalog,
  getSectionTemplates,
  getHomepageExamples,
  briefToDesignYaml,
  buildTreeSummary,
  // Exposed for testing
  resolveVars,
  genId,
  resetIds,
};
