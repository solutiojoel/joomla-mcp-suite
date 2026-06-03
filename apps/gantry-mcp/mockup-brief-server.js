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
const MOCKUP_PROJECTS_DIR = path.join(EXPORTS_DIR, 'mockup-projects');
const PARTICLES_DIR = path.join(ROOT, 'particles');
const SECTION_TEMPLATES_DIR = path.join(ROOT, 'templates', 'sections');
const HOMEPAGES_DIR = path.join(ROOT, 'templates', 'homepages');

const PORT = Number(process.env.MOCKUP_BUILDER_PORT || 18304);
const ALWAYS_INHERITED_HOME_SECTIONS = ['navigation', 'bottom', 'footer', 'copyright', 'offcanvas'];

const app = express();
app.use(express.json({ limit: '150mb' }));
app.use(express.static(EXPORTS_DIR));

function readYamlFile(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

function stripDataUrls(value) {
  if (Array.isArray(value)) return value.map(stripDataUrls);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'dataUrl') continue;
    out[key] = stripDataUrls(child);
  }
  return out;
}

function projectPath(id) {
  return path.join(MOCKUP_PROJECTS_DIR, `${slugify(id, 'project')}.json`);
}

function listProjects() {
  ensureDir(MOCKUP_PROJECTS_DIR);
  return fs.readdirSync(MOCKUP_PROJECTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        const project = JSON.parse(fs.readFileSync(path.join(MOCKUP_PROJECTS_DIR, file), 'utf8'));
        return {
          id: project.id,
          name: project.name,
          buildSlug: project.input && project.input.buildSlug,
          updatedAt: project.updatedAt,
          createdAt: project.createdAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function saveProject(payload) {
  ensureDir(MOCKUP_PROJECTS_DIR);
  const now = new Date().toISOString();
  const cleanInput = stripDataUrls(payload.input || {});
  const id = slugify(payload.id || payload.name || cleanInput.buildSlug || 'mockup-project', 'mockup-project');
  const existingPath = projectPath(id);
  let existing = {};
  if (fs.existsSync(existingPath)) {
    try { existing = JSON.parse(fs.readFileSync(existingPath, 'utf8')); } catch {}
  }
  const project = {
    id,
    name: payload.name || existing.name || cleanInput.buildSlug || id,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    input: cleanInput,
    analysis: payload.analysis || null,
  };
  fs.writeFileSync(existingPath, JSON.stringify(project, null, 2));
  return project;
}

function stageUploadedImages(input) {
  const existing = input.existingStagedAssets && Array.isArray(input.existingStagedAssets.assets)
    ? input.existingStagedAssets
    : null;
  const staged = existing ? [...existing.assets] : [];
  const siteSlug = slugify(input.buildSlug || input.siteSlug || input.siteName || input.targetOutline || input.siteType, 'site-build');
  const buildId = slugify(input.buildId || new Date().toISOString().slice(0, 10), 'build');
  const folderName = existing && existing.folderName ? existing.folderName : `${siteSlug}-${buildId}`;
  const folder = path.join(MOCKUP_ASSETS_DIR, folderName);
  ensureDir(folder);

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
    const joomlaPath = `/images/pub/mockups/${folderName}/${filename}`;
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
    joomlaFolder: `/images/pub/mockups/${folderName}`,
    assets: staged,
  };
}

function inferSections(input) {
  const notes = input.designNotes || '';
  const selected = new Set(input.selectedSections || []);
  const sections = [];

  function scopeForSection(id) {
    if (ALWAYS_INHERITED_HOME_SECTIONS.includes(id)) return 'base_outline';
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

  if (sections.some((s) => s.id === 'slideshow')) {
    add('Mass Schedule', 'mass-times', 'Editor-managed schedule shell pulled through contentarray.', 'slideshow', 'Use headings for Sunday Mass, Daily Mass, Confession; links only where needed, such as phone links.');
  }
  if (sections.some((s) => s.id === 'container-main')) {
    add(hasAny(notes, ['facebook']) ? 'Facebook' : 'Social Feed', hasAny(notes, ['facebook']) ? 'facebook' : 'social-feed', 'Social/widget shell article pulled through contentarray in the main content area.', 'mainbar', 'Include widget wrapper, embed code or placeholder, and a Follow Us/View More button if the mockup shows one.');
  }
  if (sections.some((s) => s.id === 'extension')) {
    add('Instagram', 'instagram', 'Instagram embed and optional quote shell article.', 'extension', 'Include widget wrapper, embed code, quote text, and attribution.');
  }
  if (sections.some((s) => s.id === 'extension')) {
    add(hasAny(notes, ['bulletin']) ? 'Bulletins' : 'Calendar', hasAny(notes, ['bulletin']) ? 'bulletins' : 'calendar', 'Calendar/bulletin module wrapper shell article.', 'extension', 'Use a module placeholder or embed wrapper plus archive/full calendar button.');
  }
  if (sections.some((s) => s.id === 'footer')) {
    add('Footer', 'footer', `Footer shell article for ${siteType} contact information and links. This article is selected in the Base Outline footer and inherited by Home/sub-outlines.`, 'footer', 'Use structured footer columns, office info, office hours, links, and logo/emblem.');
  }

  return articles;
}

function inferCategories(input, sections) {
  const categories = [];
  const notes = input.designNotes || '';

  function add(title, alias, purpose, sourceSection, displayThrough, starterArticles) {
    if (categories.some((c) => c.alias === alias)) return;
    categories.push({
      title,
      alias,
      scope: sourceSection === 'footer' ? 'base_outline' : 'home_outline',
      sourceSection,
      purpose,
      displayThrough,
      starterArticles: starterArticles || [],
    });
  }

  if (sections.some((s) => s.id === 'slideshow')) {
    add(
      'Rotator',
      'rotator',
      'Hero/slider articles used by the swiper particle.',
      'slideshow',
      'swiper.article.filter.categories; each article image becomes a slide. Keep slides_linkable disabled unless requested.',
      [
        { title: 'Welcome Slide', content: 'Short optional slide caption; primary image should be the hero photo from the mockup/assets.' },
        { title: 'Parish Life Slide', content: 'Optional secondary slide if the mockup shows a rotating hero.' },
      ]
    );
  }

  if (sections.some((s) => s.id === 'container-main')) {
    add(
      hasAny(notes, ['event']) ? 'News & Events' : 'Parish News & Events',
      'news-events',
      'Dynamic feed for the homepage News & Events section.',
      'sidebar',
      'contentarray.article.filter.categories with image/title/intro/read-more enabled; usually ph-sideway-stack/news-to-me styling.',
      [
        { title: 'Welcome to Our Parish!', content: 'Intro article matching the first visible news card or a brief welcome/news teaser.' },
        { title: 'Upcoming Parish Event', content: 'Placeholder event/news article with intro image and short excerpt.' },
        { title: 'Annual Announcement', content: 'Placeholder announcement article with intro image and short excerpt.' },
      ]
    );
  }

  if (hasAny(notes, ['alert', 'announcement', 'notice'])) {
    add(
      'Alert',
      'alert',
      'Optional alert/announcement feed at the top of the page.',
      'top',
      'contentarray.article.filter.categories; title shown, one column, no pagination.',
      [{ title: 'Homepage Alert', content: 'Short urgent announcement shown in the alert banner.' }]
    );
  }

  return categories;
}

function buildSectionContentPlan(sections, articles, categories) {
  function article(alias) {
    return articles.find((a) => a.alias === alias);
  }
  function category(alias) {
    return categories.find((c) => c.alias === alias);
  }

  return sections.map((section) => {
    const plan = {
      section: section.id,
      scope: section.scope,
      particle: section.particle,
      contentModel: section.contentSource,
      displayContract: '',
      requiredCategories: [],
      requiredArticles: [],
      staticItems: [],
      notes: [],
    };

    if (section.id === 'slideshow') {
      plan.requiredCategories.push(category('rotator'));
      plan.requiredArticles.push(article('mass-times'));
      plan.displayContract = 'Swiper pulls hero images from Rotator category; Mass Schedule contentarray pulls one shell article and hides title/read-more.';
      plan.notes.push('Create/resolve both the Rotator category and Mass Schedule article before applying the hero section.');
    } else if (section.id === 'utility') {
      plan.displayContract = 'Custom welcome heading plus blockcontent quicklink repeater; no Homepage Articles should be created for each quicklink.';
      plan.staticItems = ['Online Giving', 'Bulletin', 'Faith Formation', 'Join Us', 'Pre-K'].map((label) => ({
        label,
        source: 'blockcontent.subcontents[]',
        needsMenuUrl: true,
      }));
    } else if (section.id === 'container-main') {
      plan.requiredCategories.push(category('news-events'));
      plan.requiredArticles.push(article('facebook') || article('social-feed'));
      plan.displayContract = 'News contentarray pulls a category feed; social/widget area pulls a single shell article; ads use module/position content.';
      plan.notes.push('The news feed is a category, not a Homepage Articles shell article. Create starter news articles in that category.');
    } else if (section.id === 'expanded') {
      plan.displayContract = 'Blockcontent card/resource grid; items are static repeaters with images and button links.';
      plan.staticItems = ['Resource Card 1', 'Resource Card 2', 'Resource Card 3', 'Resource Card 4'].map((label) => ({
        label,
        source: 'blockcontent.subcontents[]',
        needsMenuUrl: true,
      }));
    } else if (section.id === 'extension') {
      plan.requiredArticles.push(article('calendar') || article('bulletins'));
      plan.requiredArticles.push(article('instagram'));
      plan.displayContract = 'Two contentarray shell articles, typically Calendar/Bulletins and Instagram, styled by calendar-container and instagram-container.';
    } else if (section.id === 'footer') {
      plan.requiredArticles.push(article('footer'));
      plan.displayContract = 'Base Outline footer contentarray pulls one Footer shell article; all sub-outlines inherit it.';
    } else if (section.id === 'navigation') {
      plan.displayContract = 'Base Outline inherited logo/menu/toplinks. Toplinks are blockcontent static items, not Homepage Articles.';
      plan.staticItems = ['Contact Us', 'Search'].map((label) => ({
        label,
        source: 'blockcontent.subcontents[]',
        needsMenuUrl: true,
      }));
    }

    plan.requiredCategories = plan.requiredCategories.filter(Boolean);
    plan.requiredArticles = plan.requiredArticles.filter(Boolean);
    return plan;
  });
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

function buildWorkPlan(sections, articles, categories) {
  const baseSections = sections.filter((s) => s.scope === 'base_outline');
  const homeSections = sections.filter((s) => s.scope !== 'base_outline');
  const baseArticles = articles.filter((a) => a.scope === 'base_outline');
  const homeArticles = articles.filter((a) => a.scope !== 'base_outline');
  const baseCategories = categories.filter((c) => c.scope === 'base_outline');
  const homeCategories = categories.filter((c) => c.scope !== 'base_outline');

  return {
    base_outline: {
      purpose: 'Site-wide inherited structure shared by #Home and sub-outlines.',
      alwaysInheritedOnHome: ALWAYS_INHERITED_HOME_SECTIONS,
      sections: baseSections,
      articles: baseArticles,
      categories: baseCategories,
      instructions: [
        'Edit navigation in the Base Outline, not in the #Home outline.',
        'Create or update the Footer shell article in Homepage Articles, then point the Base Outline footer contentarray at that article.',
        'Confirm child outlines inherit navigation/footer/bottom/copyright/offcanvas from Base Outline before making per-outline changes.',
      ],
    },
    home_outline: {
      purpose: 'Homepage-specific layout and content sections.',
      inheritsFromBaseOutline: ALWAYS_INHERITED_HOME_SECTIONS,
      sections: homeSections,
      articles: homeArticles,
      categories: homeCategories,
      instructions: [
        'Apply hero, utility, main content, expanded, and extension changes in the #Home outline.',
        'Do not duplicate inherited navigation or footer sections in the #Home layout.',
        'Use dry-run validation before applying Home outline design YAML.',
      ],
    },
  };
}

function buildPrompt(input, sections, articles, categories, contentPlan, links, stagedAssets) {
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
  const categoryText = categories.map((c) =>
    `- ${c.scope}: create/resolve category "${c.title}" (${c.alias}) for ${c.sourceSection}; display through ${c.displayThrough}`
  ).join('\n') || '- No feed categories inferred yet.';
  const contentPlanText = contentPlan.map((p) =>
    `- ${p.section}: ${p.displayContract} Categories: ${p.requiredCategories.map(c => c.title).join(', ') || 'none'}; Articles: ${p.requiredArticles.map(a => a.title).join(', ') || 'none'}; Static items: ${p.staticItems.map(i => i.label).join(', ') || 'none'}.`
  ).join('\n');

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
    '- Upload implementation assets into the matching writable Joomla /images/pub/mockups/... path.',
    '- The FTP write tool can only write under /images/pub/, so do not target /images/template/ for these assets.',
    '- In articles, particles, and CSS, reference uploaded assets with root-relative paths only, starting with /images/. Do not include the base domain.',
    '',
    'Use these established construction methods as the foundation, but do not simply copy an existing layout:',
    sectionText,
    '',
    'Outline scope rules:',
    '- Base Outline: Navigation, Bottom, Footer, Copyright, and Offcanvas are site-wide inherited areas.',
    '- Base Outline: the Footer shell article contentarray selection belongs here so sub-outlines inherit the same footer.',
    '- Home Outline: slideshow, utility, main content, expanded, extension, and other homepage-only sections belong here.',
    '- Home Outline always inherits Navigation, Bottom, Footer, Copyright, and Offcanvas from the Base Outline.',
    '- Never duplicate inherited Navigation, Bottom, Footer, Copyright, or Offcanvas in #Home unless inheritance has intentionally been broken.',
    '',
    'Homepage Articles to create or resolve:',
    articleText,
    '',
    'Feed categories and starter articles to create or resolve:',
    categoryText,
    '',
    'Section content/display plan:',
    contentPlanText,
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
    '- Preserve base outline inheritance for Navigation/Bottom/Footer/Copyright/Offcanvas unless a deliberate override is approved.',
    '- Make inherited section edits in the Base Outline first, then make homepage-specific edits in #Home.',
    '- Validate links, article IDs, category IDs, module positions, and responsive CSS before applying.',
  ].join('\n');
}

function analyzeMockup(input) {
  const stagedAssets = stageUploadedImages(input);
  const sections = inferSections(input);
  const articles = inferArticles(input, sections);
  const categories = inferCategories(input, sections);
  const contentPlan = buildSectionContentPlan(sections, articles, categories);
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
    outlineWorkPlan: buildWorkPlan(sections, articles, categories),
    stagedAssets,
    sections,
    homepageArticles: articles,
    contentCategories: categories,
    sectionContentPlan: contentPlan,
    linksToResolve: links,
    cssPlan,
    designYamlScaffold: buildDesignYamlScaffold(input, sections),
    visionPrompt: buildPrompt(input, sections, articles, categories, contentPlan, links, stagedAssets),
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

app.get('/api/projects', (_req, res) => {
  try {
    res.json({ projects: listProjects() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const filePath = projectPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Project not found' });
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    res.json(saveProject(req.body || {}));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    const filePath = projectPath(req.params.id);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
