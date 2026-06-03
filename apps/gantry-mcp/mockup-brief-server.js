#!/usr/bin/env node
'use strict';

/**
 * Mockup Brief Builder
 *
 * A small web app for turning a homepage mockup, supporting assets, and design
 * notes into a Gantry/Solutio implementation brief. It intentionally produces
 * a plan and prompt rather than importing a layout directly: the purpose is to
 * teach the LLM how to reason from a new design using established construction
 * methods, not to copy an existing section library.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = __dirname;
const EXPORTS_DIR = path.join(ROOT, 'exports');
const HTML_FILE = path.join(EXPORTS_DIR, 'mockup-brief-builder.html');
const MOCKUP_ASSETS_DIR = path.join(EXPORTS_DIR, 'mockup-assets');
const PARTICLES_DIR = path.join(ROOT, 'particles');
const SECTION_TEMPLATES_DIR = path.join(ROOT, 'templates', 'sections');
const HOMEPAGES_DIR = path.join(ROOT, 'templates', 'homepages');

const PORT = Number(process.env.MOCKUP_BUILDER_PORT || 18304);

const app = express();
app.use(express.json({ limit: '150mb' }));
app.use(express.static(EXPORTS_DIR));

function readYamlFile(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const safeKey = key === '' ? '_none' : key;
    out[safeKey] = sanitizeJson(child);
  }
  return out;
}

function listParticleCatalog() {
  const particles = {};
  if (!fs.existsSync(PARTICLES_DIR)) return particles;
  for (const file of fs.readdirSync(PARTICLES_DIR).filter((f) => f.endsWith('.yaml')).sort()) {
    try {
      const item = readYamlFile(path.join(PARTICLES_DIR, file));
      if (item && item.name) {
        particles[item.name] = {
          name: item.name,
          title: item.title || item.name,
          category: item.category || '',
          description: item.description || '',
          when_to_use: item.when_to_use || [],
          when_not_to_use: item.when_not_to_use || [],
          common_block_classes: sanitizeJson(item.common_block_classes || {}),
          examples: sanitizeJson(item.examples || {}),
        };
      }
    } catch (err) {
      particles[file.replace(/\.yaml$/, '')] = { error: err.message };
    }
  }
  return particles;
}

function listSectionTemplates() {
  const templates = [];
  if (!fs.existsSync(SECTION_TEMPLATES_DIR)) return templates;
  for (const file of fs.readdirSync(SECTION_TEMPLATES_DIR).filter((f) => f.endsWith('.yaml')).sort()) {
    const fullPath = path.join(SECTION_TEMPLATES_DIR, file);
    const raw = fs.readFileSync(fullPath, 'utf8');
    const titleMatch = raw.match(/^#\s*Section Template:\s*(.+)$/m);
    const usageMatch = raw.match(/^#\s*Usage:\s*(.+)$/m);
    templates.push({
      name: file.replace(/\.yaml$/, ''),
      title: titleMatch ? titleMatch[1].trim() : file.replace(/\.yaml$/, ''),
      usage: usageMatch ? usageMatch[1].trim() : '',
    });
  }
  return templates;
}

function listHomepageExamples() {
  const examples = [];
  if (!fs.existsSync(HOMEPAGES_DIR)) return examples;
  for (const file of fs.readdirSync(HOMEPAGES_DIR).filter((f) => f.endsWith('-meta.yaml')).sort()) {
    try {
      const meta = readYamlFile(path.join(HOMEPAGES_DIR, file));
      const slug = file.replace(/-(school-)?home-meta\.yaml$/, '');
      examples.push({
        slug,
        site_type: meta.site_type || '',
        outline_name: meta.outline_name || '',
        theme: meta.theme || 'rt_studius',
        sections: (meta.sections || []).map((s) => ({
          id: s.id,
          particles: s.particles || [],
          notes: s.notes || '',
        })),
        block_classes: meta.block_classes || [],
        design_notes: meta.design_notes || '',
      });
    } catch {}
  }
  return examples;
}

function getKnowledgeBase() {
  return {
    particles: listParticleCatalog(),
    section_templates: listSectionTemplates(),
    homepage_examples: listHomepageExamples(),
    construction_principles: [
      'Use contentarray when content should be Joomla article/category managed.',
      'Use blockcontent when the section is a repeated static set of cards, quicklinks, sponsors, or resource links.',
      'Use custom for small structural HTML: headings, standalone buttons, jdoc module wrappers, and one-off markup.',
      'Use swiper for a hero/carousel, usually sourced from Joomla slider articles.',
      'Treat existing site examples as evidence for construction methods, not as pieces that must be copied.',
      'Separate visual intent, content source, link behavior, layout structure, and CSS behavior before producing YAML.',
      'Navigation, footer, bottom, copyright, and offcanvas are base-outline concerns inherited by sub-outlines.',
      'Home-specific sections such as slideshow, utility, main content, expanded, and extension are changed in the #Home outline.',
      'The footer shell article is selected/rendered from the base outline so every sub-outline shares the same site footer.',
    ],
  };
}

function hasAny(text, words) {
  const haystack = String(text || '').toLowerCase();
  return words.some((word) => haystack.includes(word));
}

function slugify(value, fallback) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || fallback;
}

function safeFilename(value, fallback) {
  const raw = String(value || fallback || 'asset');
  const ext = path.extname(raw).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const rawBase = ext ? raw.slice(0, -path.extname(raw).length) : raw;
  const base = path.basename(rawBase)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'asset';
  return base + (ext || '.png');
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mime: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let index = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${index}${ext}`;
    index++;
  }
  return candidate;
}

function stageUploadedImages(input) {
  const staged = [];
  const siteSlug = slugify(input.buildSlug || input.siteSlug || input.siteName || input.targetOutline || input.siteType, 'site-build');
  const buildId = slugify(input.buildId || new Date().toISOString().slice(0, 10), 'build');
  const folderName = `${siteSlug}-${buildId}`;
  const folder = path.join(MOCKUP_ASSETS_DIR, folderName);
  fs.mkdirSync(folder, { recursive: true });

  const files = [];
  if (input.mockupImage && input.mockupImage.dataUrl) {
    files.push({ role: 'mockup', uploadToJoomla: false, ...input.mockupImage });
  }
  for (const asset of (input.assetImages || [])) {
    if (asset && asset.dataUrl) files.push({ role: 'implementation_asset', uploadToJoomla: true, ...asset });
  }

  for (const file of files) {
    const decoded = decodeDataUrl(file.dataUrl);
    if (!decoded) continue;
    const filename = uniquePath(folder, safeFilename(file.name, file.role === 'mockup' ? 'mockup.png' : 'asset.png'));
    const localPath = path.join(folder, filename);
    fs.writeFileSync(localPath, decoded.buffer);
    const appPath = `/mockup-assets/${folderName}/${filename}`;
    const joomlaPath = `/images/template/mockups/${folderName}/${filename}`;
    const workspaceRelativePath = path.join('apps', 'gantry-mcp', 'exports', 'mockup-assets', folderName, filename).replace(/\\/g, '/');
    staged.push({
      role: file.role,
      name: file.name || filename,
      filename,
      mime: decoded.mime,
      size: decoded.buffer.length,
      width: file.width || null,
      height: file.height || null,
      localPath,
      workspaceRelativePath,
      appPath,
      uploadToJoomla: !!file.uploadToJoomla,
      joomlaPath: file.uploadToJoomla ? joomlaPath : null,
      ftpTargetHint: file.uploadToJoomla ? joomlaPath.replace(/^\/images\//, 'images/') : null,
    });
  }

  return {
    folderName,
    folder,
    publicFolder: `/mockup-assets/${folderName}`,
    joomlaFolder: `/images/template/mockups/${folderName}`,
    assets: staged,
  };
}

function inferSections(input) {
  const notes = input.designNotes || '';
  const selected = new Set(input.selectedSections || []);
  const sections = [];

  function scopeForSection(id) {
    if (['navigation', 'footer', 'bottom', 'copyright', 'offcanvas'].includes(id)) return 'base_outline';
    return 'home_outline';
  }

  function add(id, reason, particle, contentSource, linkBehavior, classes) {
    if (sections.some((s) => s.id === id)) return;
    sections.push({ id, scope: scopeForSection(id), reason, particle, contentSource, linkBehavior, classes });
  }

  if (selected.has('navigation') || hasAny(notes, ['nav', 'menu', 'header', 'logo', 'contact us', 'search'])) {
    add('navigation', 'Brand header, logo, main menu, social/search/contact controls. This is inherited by sub-outlines and should be edited in the Base Outline.', 'logo + menu + blockcontent', 'Base Outline inherited section plus static toplinks', 'Toplinks are individual blockcontent links.', ['ole-faithful', 'ql-toplinks-studius']);
  }
  if (selected.has('slideshow') || hasAny(notes, ['hero', 'slider', 'swiper', 'slideshow', 'carousel', 'mass'])) {
    add('slideshow', 'Hero media area with an optional schedule or featured content companion.', 'swiper + contentarray', 'Swiper category and/or shell article', 'Slides normally not linkable unless requested; shell article links only inside article body.', ['fullwidth-swiper', 'rotate-wide', 'mass-times-block']);
  }
  if (selected.has('utility') || hasAny(notes, ['quicklink', 'quick link', 'welcome', 'online giving', 'bulletin', 'join us'])) {
    add('utility', 'Welcome heading and repeated image/text action links.', 'custom + blockcontent', 'Static particle repeater', 'Each quicklink item is individually clickable via buttonlink.', ['welcome-title', 'ql-united']);
  }
  if (selected.has('main') || hasAny(notes, ['news', 'events', 'facebook', 'ad', 'sponsor'])) {
    add('container-main', 'Editorial feed/social/widget/ad working area.', 'contentarray + position + custom', 'Category feed, shell articles, and module positions', 'Feed items/read-more can link; widget buttons link; ad modules managed separately.', ['news-to-me', 'headlines-spacing', 'ph-sideway-stack', 'facebook-widget-container', 'side-ads']);
  }
  if (selected.has('expanded') || hasAny(notes, ['card', 'resource', 'link box', 'ministry', 'daily readings', 'cfn'])) {
    add('expanded', 'Resource or ministry card/link grid.', 'blockcontent', 'Static particle repeater', 'Usually item/card clickable; static display cards must omit empty links.', ['link-boxes']);
  }
  if (selected.has('extension') || hasAny(notes, ['calendar', 'instagram', 'embed', 'quote'])) {
    add('extension', 'Secondary widgets, calendar/social embeds, quote blocks.', 'contentarray', 'Shell Homepage Articles', 'Buttons inside shell articles link; entire widget block is not globally linked.', ['calendar-container', 'instagram-container']);
  }
  if (selected.has('footer') || hasAny(notes, ['footer', 'office', 'hours', 'address', 'phone', 'links'])) {
    add('footer', 'Contact information, office hours, footer links, logo/emblem. The footer section and selected footer shell article are inherited from the Base Outline.', 'contentarray', 'Single footer shell article selected in Base Outline', 'Links live inside the footer article HTML.', ['footer-wrapper']);
  }

  if (!sections.length) {
    add('navigation', 'Standard brand/header area for the site. Edit in Base Outline because sub-outlines inherit it.', 'logo + menu + blockcontent', 'Base Outline inherited section plus static toplinks', 'Toplinks are individual blockcontent links.', ['ole-faithful', 'ql-toplinks-studius']);
    add('slideshow', 'Primary first-viewport hero area.', 'swiper + contentarray', 'Swiper category and optional shell article', 'Slides not linkable unless requested.', ['fullwidth-swiper']);
    add('utility', 'Action strip below the hero.', 'custom + blockcontent', 'Static particle repeater', 'Each quicklink item links individually.', ['ql-united']);
  }

  return sections;
}

function inferArticles(input, sections) {
  const articles = [];
  const notes = input.designNotes || '';
  const category = input.homepageCategory || 'Homepage Articles';
  const siteType = input.siteType || 'church';

  function articleScope(sourceSection) {
    return sourceSection === 'footer' ? 'base_outline' : 'home_outline';
  }

  function add(title, alias, purpose, sourceSection, htmlNotes) {
    if (articles.some((a) => a.alias === alias)) return;
    articles.push({ title, alias, category, scope: articleScope(sourceSection), sourceSection, purpose, htmlNotes });
  }

  if (sections.some((s) => s.id === 'slideshow') && hasAny(notes, ['mass', 'schedule', 'confession'])) {
    add('Mass Schedule', 'mass-times', 'Editor-managed schedule shell pulled through contentarray.', 'slideshow', 'Use headings for Sunday Mass, Daily Mass, Confession; links only where needed, such as phone links.');
  }
  if (sections.some((s) => s.id === 'container-main') && hasAny(notes, ['facebook'])) {
    add('Facebook', 'facebook', 'Social embed shell article pulled through contentarray.', 'mainbar', 'Include widget wrapper, embed code, and Follow Us button.');
  }
  if (sections.some((s) => s.id === 'extension') && hasAny(notes, ['instagram'])) {
    add('Instagram', 'instagram', 'Instagram embed and optional quote shell article.', 'extension', 'Include widget wrapper, embed code, quote text, and attribution.');
  }
  if (sections.some((s) => s.id === 'extension') && hasAny(notes, ['calendar', 'bulletin'])) {
    add(hasAny(notes, ['bulletin']) ? 'Bulletins' : 'Calendar', hasAny(notes, ['bulletin']) ? 'bulletins' : 'calendar', 'Calendar/bulletin module wrapper shell article.', 'extension', 'Use a module placeholder or embed wrapper plus archive/full calendar button.');
  }
  if (sections.some((s) => s.id === 'footer')) {
    add('Footer', 'footer', `Footer shell article for ${siteType} contact information and links. This article is selected in the Base Outline footer and inherited by Home/sub-outlines.`, 'footer', 'Use structured footer columns, office info, office hours, links, and logo/emblem.');
  }

  return articles;
}

function inferLinkLabels(input) {
  const text = `${input.designNotes || ''}\n${(input.assetImages || []).map((a) => a.name).join('\n')}`;
  const labels = [
    'Home', 'About Us', "What's Happening", 'Parish Life', 'Sacraments',
    'Religious Education', 'Sponsors', 'Contact Us', 'Search', 'Online Giving',
    'Bulletin', 'Faith Formation', 'Join Us', 'Pre-K', 'Calendar',
    'Daily Readings', 'Parish Registration', 'Funeral Information',
  ];
  return labels.filter((label) => hasAny(text, [label.toLowerCase()]));
}

function buildDesignYamlScaffold(input, sections) {
  const homeSections = sections.filter((s) => s.scope !== 'base_outline');
  const baseSections = sections.filter((s) => s.scope === 'base_outline');
  const lines = [
    'schema: 2',
    `outline: "${input.targetOutline || '#Home'}"`,
    '',
    'context:',
    `  site_type: "${input.siteType || 'church'}"`,
    `  homepage_category: "${input.homepageCategory || 'Homepage Articles'}"`,
    '  # Fill these after Joomla content/menu resolution:',
    '  slider_category_id: ""',
    '  alert_category_id: ""',
    '  news_category_id: ""',
    '  mass_times_article_id: ""',
    '  facebook_article_id: ""',
    '  instagram_article_id: ""',
    '  calendar_article_id: ""',
    '  footer_article_id: ""',
    '',
    '# This scaffold is intentionally a design brief, not a direct copy.',
    '# Use gantry_layout_design after replacing placeholders and validating contracts.',
    '# Base Outline inheritance rule:',
    '# - Do not place navigation/footer changes in this Home outline scaffold.',
    '# - Edit navigation/footer/footer article selection in the Base Outline, then let #Home inherit them.',
  ];

  if (baseSections.length) {
    lines.push('', '# Base Outline changes to make separately:');
    if (baseSections.some((s) => s.id === 'navigation')) {
      lines.push('# - navigation: edit logo/menu/toplinks/header styling in the Base Outline.');
    }
    if (baseSections.some((s) => s.id === 'footer')) {
      lines.push('# - footer: create/resolve Footer article, then set the footer contentarray in the Base Outline.');
    }
  }

  if (homeSections.some((s) => s.id === 'slideshow')) {
    lines.push('', 'top_container:', '  sections:');
    lines.push('    - template: hero-swiper');
  }
  if (homeSections.some((s) => s.id === 'utility')) {
    lines.push('', 'sections:', '  - template: utility-quicklinks');
  }
  if (homeSections.some((s) => s.id === 'container-main')) {
    lines.push('', 'main_container:', '  layout: sidebar-main-aside');
    lines.push('  # Use contentarray for news/social shell articles and position for ads/modules.');
  }
  const extra = homeSections.filter((s) => ['expanded', 'extension'].includes(s.id));
  if (extra.length) {
    lines.push('', 'extra_sections:');
    for (const section of extra) {
      if (section.id === 'expanded') lines.push('  - template: link-boxes');
      if (section.id === 'extension') {
        lines.push('  - id: extension');
        lines.push('    type: section');
        lines.push('    grids: [] # Add calendar/social shell article contentarrays here.');
      }
    }
  }
  return lines.join('\n');
}

function buildWorkPlan(sections, articles) {
  const baseSections = sections.filter((s) => s.scope === 'base_outline');
  const homeSections = sections.filter((s) => s.scope !== 'base_outline');
  const baseArticles = articles.filter((a) => a.scope === 'base_outline');
  const homeArticles = articles.filter((a) => a.scope !== 'base_outline');

  return {
    base_outline: {
      purpose: 'Site-wide inherited structure shared by #Home and sub-outlines.',
      sections: baseSections,
      articles: baseArticles,
      instructions: [
        'Edit navigation in the Base Outline, not in the #Home outline.',
        'Create or update the Footer shell article in Homepage Articles, then point the Base Outline footer contentarray at that article.',
        'Confirm child outlines inherit navigation/footer/bottom/copyright/offcanvas from Base Outline before making per-outline changes.',
      ],
    },
    home_outline: {
      purpose: 'Homepage-specific layout and content sections.',
      sections: homeSections,
      articles: homeArticles,
      instructions: [
        'Apply hero, utility, main content, expanded, and extension changes in the #Home outline.',
        'Do not duplicate inherited navigation or footer sections in the #Home layout.',
        'Use dry-run validation before applying Home outline design YAML.',
      ],
    },
  };
}

function buildPrompt(input, sections, articles, links, stagedAssets) {
  const implementationAssets = (stagedAssets && stagedAssets.assets || []).filter((asset) => asset.uploadToJoomla);
  const mockupAssets = (stagedAssets && stagedAssets.assets || []).filter((asset) => asset.role === 'mockup');
  const assetList = implementationAssets
    .map((asset) => `- ${asset.name}${asset.width ? ` (${asset.width}x${asset.height})` : ''}: staged at ${asset.localPath} (${asset.workspaceRelativePath}); after FTP upload use ${asset.joomlaPath}`)
    .join('\n') || '- No supporting assets listed';
  const mockupList = mockupAssets
    .map((asset) => `- ${asset.name}: staged at ${asset.localPath} (${asset.workspaceRelativePath}); browser preview ${asset.appPath}`)
    .join('\n') || '- No mockup image staged';

  const sectionText = sections.map((s) =>
    `- ${s.id} (${s.scope}): use ${s.particle}; ${s.reason} Content: ${s.contentSource}. Links: ${s.linkBehavior}. CSS/classes: ${s.classes.join(', ')}.`
  ).join('\n');

  const articleText = articles.map((a) =>
    `- ${a.scope}: create/resolve "${a.title}" (${a.alias}) in ${a.category}: ${a.purpose}`
  ).join('\n') || '- No shell Homepage Articles inferred yet.';

  const linkText = links.map((label) => `- Resolve or create menu/page link for: ${label}`).join('\n') || '- Resolve links from visible labels and notes.';

  return [
    'Analyze the attached mockup and produce a Gantry/Solutio implementation plan.',
    '',
    `Target site type: ${input.siteType || 'church'}`,
    `Target outline: ${input.targetOutline || '#Home'}`,
    `Homepage article category: ${input.homepageCategory || 'Homepage Articles'}`,
    '',
    'Design notes from user:',
    input.designNotes || '(none provided)',
    '',
    'Mockup/reference image:',
    mockupList,
    '',
    'Supporting image/assets supplied:',
    assetList,
    '',
    'Asset upload rule:',
    '- Use staged localPath values as the source files when uploading assets by FTP.',
    '- Upload implementation assets into the matching Joomla /images/template/mockups/... path.',
    '- In articles, particles, and CSS, reference uploaded assets with root-relative paths only, starting with /images/. Do not include the base domain.',
    '',
    'Use these established construction methods as the foundation, but do not simply copy an existing layout:',
    sectionText,
    '',
    'Outline scope rules:',
    '- Base Outline: navigation, footer, bottom, copyright, and offcanvas are site-wide inherited areas.',
    '- Base Outline: the Footer shell article contentarray selection belongs here so sub-outlines inherit the same footer.',
    '- Home Outline: slideshow, utility, main content, expanded, extension, and other homepage-only sections belong here.',
    '- Never duplicate inherited navigation or footer in #Home unless inheritance has intentionally been broken.',
    '',
    'Homepage Articles to create or resolve:',
    articleText,
    '',
    'Menu/page links to resolve:',
    linkText,
    '',
    'Guardrails:',
    '- Decide content source before particle choice: category feed, shell article, static repeater, module position, or custom HTML.',
    '- Use contentarray for editor-managed Joomla article/category content.',
    '- Use blockcontent for repeated static link cards or display cards.',
    '- Use custom only for small structural HTML and standalone buttons/headings.',
    '- Do not create empty anchors for static display cards.',
    '- Do not make whole sections clickable unless explicitly requested.',
    '- Preserve base outline inheritance for navigation/footer/bottom/copyright/offcanvas unless a deliberate override is approved.',
    '- Make inherited section edits in the Base Outline first, then make homepage-specific edits in #Home.',
    '- Validate links, article IDs, category IDs, module positions, and responsive CSS before applying.',
  ].join('\n');
}

function analyzeMockup(input) {
  const stagedAssets = stageUploadedImages(input);
  const sections = inferSections(input);
  const articles = inferArticles(input, sections);
  const links = inferLinkLabels(input);
  const cssPlan = sections.map((section) => ({
    section: section.id,
    classes: section.classes,
    behavior: section.linkBehavior,
    write_new_css_from_mockup: true,
    reuse_conventions_not_exact_rules: true,
  }));

  return {
    summary: `Generated mockup implementation brief for ${input.siteType || 'church'} ${input.targetOutline || '#Home'}.`,
    outlineWorkPlan: buildWorkPlan(sections, articles),
    stagedAssets,
    sections,
    homepageArticles: articles,
    linksToResolve: links,
    cssPlan,
    designYamlScaffold: buildDesignYamlScaffold(input, sections),
    visionPrompt: buildPrompt(input, sections, articles, links, stagedAssets),
  };
}

app.get('/', (_req, res) => {
  if (!fs.existsSync(HTML_FILE)) {
    return res.status(503).send('<h2>Mockup Brief Builder is not generated.</h2>');
  }
  res.sendFile(HTML_FILE);
});

app.get('/api/knowledge', (_req, res) => {
  res.json(getKnowledgeBase());
});

app.post('/api/analyze', (req, res) => {
  try {
    res.json(analyzeMockup(req.body || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mockup Brief Builder running at http://localhost:${PORT}`);
});
