#!/usr/bin/env node
'use strict';

/**
 * MCP server exposing the gantry CLI as Model Context Protocol tools.
 *
 * Run as a stdio server; an MCP client (Claude Desktop, Claude Code, etc.)
 * spawns this process and talks to it over JSON-RPC on stdin/stdout.
 *
 * Tools accept a `site` argument (URL of the Joomla install). Sessions are
 * cached per-site so an LLM can run dozens of operations without paying the
 * login cost each time.
 */

// Load .env from the same directory as this script — MCP clients spawn this
// process from arbitrary cwds, so relying on the default `./.env` lookup fails.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const http = require('http');
const { randomUUID } = require('crypto');

const session = require('./lib/session');
const baseTemplate = require('./lib/base-template');
const layout = require('./lib/layout');
const layoutApi = require('./lib/layout-api');
const outlines = require('./lib/outlines');
const styles = require('./lib/styles');
const pageMod = require('./lib/page');
const backup = require('./lib/backup');
const compiler = require('./lib/design-compiler');

/* ---------------------------- session cache --------------------------- */

const ctxCache = new Map(); // siteUrl -> { ctx, lastUsed }
const CTX_TTL_MS = 12 * 60 * 1000; // 12 minutes — shorter than Joomla's 15-min admin session

async function getCtx(args) {
  const site = args.site;
  if (!site) throw new Error('Missing required argument: site');
  // Normalize theme so "", "studius", and "rt_studius" all share the same cache entry.
  const rawTheme = (args.theme || '').toLowerCase().replace(/^rt_/, '');
  const key = site + '|' + rawTheme;
  const cached = ctxCache.get(key);
  if (cached && Date.now() - cached.lastUsed < CTX_TTL_MS) {
    cached.lastUsed = Date.now();
    return cached.ctx;
  }
  // Need a fresh ctx
  if (cached) {
    try { await cached.ctx.close?.(); } catch {}
    ctxCache.delete(key);
  }
  const ctx = await session.start({
    mode: 'http',
    site,
    user: args.user,
    pass: args.pass,
    themeName: args.theme,
  });
  ctxCache.set(key, { ctx, lastUsed: Date.now() });
  return ctx;
}

/** Drop the cached ctx for a site (e.g. on auth failure). */
function invalidateCtx(site, theme = '') {
  const rawTheme = theme.toLowerCase().replace(/^rt_/, '');
  const key = site + '|' + rawTheme;
  const cached = ctxCache.get(key);
  if (cached) {
    cached.ctx.close?.().catch(() => {});
    ctxCache.delete(key);
  }
}

/* --------------------------- tool definitions ------------------------- */

// Common pieces of input schema we reuse
const SITE_FIELD = {
  site: {
    type: 'string',
    description: 'Joomla site URL (e.g. https://example.com). Credentials come from .env.',
  },
};
const SITE_THEME_FIELDS = {
  ...SITE_FIELD,
  theme: { type: 'string', description: 'Theme directory (default: studius/rt_studius)' },
};
const OUTLINE_FIELD = {
  outline: { type: 'string', description: 'Outline id (e.g. "default", "33", "75")', default: 'default' },
};

/* ─── outline normalisation helper ──────────────────────────────────────────
 * Accepts a numeric id ("33"), a named title ("#Home", "home"), or omitted.
 * Returns the canonical string id ("33", "default", …).
 */
async function resolveOutlineArg(ctx, args) {
  const raw = args.outline;
  if (!raw || /^\d+$/.test(String(raw)) || raw === 'default') return raw || 'default';
  return (await outlines.resolveOutline(ctx, raw)).id;
}

const TOOLS = [
  /* Outlines */
  {
    name: 'gantry_outlines_list',
    description:
      'List every outline (configuration) defined for the theme. Returns id, title, and isDefault flag for each. Outline id is what you pass as `outline` to all the layout commands.',
    schema: { type: 'object', properties: SITE_THEME_FIELDS, required: ['site'] },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await outlines.openOutlines(ctx);
      return outlines.listOutlines(ctx);
    },
  },
  {
    name: 'gantry_outlines_duplicate',
    description:
      'Duplicate an existing outline. Pass --no-inherit-equivalent (inherit:false) to deep-clone children rather than reference them. Returns the server response (which includes the new outline id when available).',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        sourceId: { type: 'string', description: 'Outline to duplicate' },
        title: { type: 'string', description: 'Optional new outline title (auto-generated if blank)' },
        inherit: { type: 'boolean', description: 'When false, clones children instead of inheriting (default: true)' },
      },
      required: ['site', 'sourceId'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      return outlines.duplicateOutline(ctx, args.sourceId, {
        title: args.title,
        inherit: args.inherit,
      });
    },
  },
  {
    name: 'gantry_outlines_delete',
    description: 'Delete an outline. Cannot be undone (outlines have no backup). Pass `ids` (array) to delete several.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        id: { type: 'string', description: 'Outline id to delete' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Multiple outline ids' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const ids = [...(args.ids || []), ...(args.id ? [args.id] : [])];
      const results = [];
      for (const id of ids) {
        try {
          await outlines.deleteOutline(ctx, id);
          results.push({ id, deleted: true });
        } catch (err) {
          results.push({ id, deleted: false, error: err.message });
        }
      }
      return results;
    },
  },

  /* Layout — read */
  {
    name: 'gantry_layout_list',
    description:
      'List every editable particle/system/spacer/position in an outline\'s layout. Returns id, type, subtype, title, sectionId, inherited flag, disabled flag.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        editable: { type: 'boolean', description: 'Skip inherited and disabled particles (default: false)' },
        includeBlocks: { type: 'boolean', description: 'Include wrapper block nodes (rarely useful)' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const structure = await layoutApi.getLayoutStructure(ctx, args.outline || 'default');
      return layoutApi.listParticlesIn(structure, {
        onlyEditable: !!args.editable,
        includeBlocks: !!args.includeBlocks,
      });
    },
  },
  {
    name: 'gantry_layout_tree',
    description:
      'Return the full nested tree of containers / sections / grids / blocks / particles for an outline. Useful for understanding structure before editing.',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const structure = await layoutApi.getLayoutStructure(ctx, args.outline || 'default');
      return layoutApi.dumpTreeIn(structure);
    },
  },
  {
    name: 'gantry_layout_sections',
    description:
      'List the stable section ids for an outline (top, navigation, header, expanded, footer, etc.). These are the valid `to` targets for layout_add and layout_move.',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const structure = await layoutApi.getLayoutStructure(ctx, args.outline || 'default');
      return layoutApi.listSectionsIn(structure);
    },
  },
  {
    name: 'gantry_layout_presets',
    description: 'List Gantry\'s built-in layout presets (default, fullwidth, left_sidebar, …) that can be applied via layout_load_preset.',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const { presets } = await layoutApi.listAvailablePresets(ctx, args.outline || 'default');
      return presets;
    },
  },

  /* Layout — write */
  {
    name: 'gantry_layout_add',
    description:
      'Add a particle / position / spacer / system node to a section. Either drop into a section as a new full-width row (`to`) or place beside an existing particle (`nextTo`). The standard Studius particle subtypes include: blockcontent, custom, gridstatistic, image, contentarray, logo, menu, mobile-menu, pricingtable, search, simplecontent, slider, social, swiper, timeline, totop, video. Positions: module, position. Spacer: spacer. System: content, messages.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        type: { type: 'string', enum: ['particle', 'position', 'spacer', 'system'], default: 'particle' },
        subtype: { type: 'string', description: 'Subtype name from layout_available' },
        to: { type: 'string', description: 'Target section id (e.g. expanded, navigation)' },
        nextTo: { type: 'string', description: 'Place next to this existing particle id' },
        size: { type: 'number', description: 'Width % when using nextTo (default: equal split)' },
        title: { type: 'string', description: 'Display title for the new particle' },
        mode: { type: 'string', enum: ['newGrid', 'firstGrid'], default: 'newGrid' },
        dryRun: { type: 'boolean', description: 'Show the diff and skip the save POST' },
      },
      required: ['site', 'subtype'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      let added;
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => {
          if (args.nextTo) {
            added = layoutApi.addParticleNextTo(structure, args.nextTo, args.type || 'particle', args.subtype, {
              title: args.title,
              size: args.size,
            });
          } else if (args.to) {
            added = layoutApi.addParticleToSection(structure, args.to, args.type || 'particle', args.subtype, {
              title: args.title,
              mode: args.mode || 'newGrid',
            });
          } else {
            throw new Error('Pass `to` (section) or `nextTo` (sibling particle id)');
          }
        },
        { op: 'add', dryRun: !!args.dryRun }
      );
      return { added, dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_move',
    description: 'Move a particle to another section, or place it next to another particle.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Particle id to move' },
        to: { type: 'string', description: 'Target section id' },
        nextTo: { type: 'string', description: 'Sibling particle id' },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => {
          if (args.nextTo) layoutApi.moveParticleNextTo(structure, args.id, args.nextTo);
          else if (args.to) layoutApi.moveParticleToSection(structure, args.id, args.to);
          else throw new Error('Pass `to` or `nextTo`');
        },
        { op: 'move', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_remove',
    description: 'Remove one or more particles from a layout.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Particle id to remove' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Multiple particle ids' },
        dryRun: { type: 'boolean' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const ids = [...(args.ids || []), ...(args.id ? [args.id] : [])];
      const removed = [];
      const missing = [];
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => {
          for (const id of ids) {
            const got = layoutApi.removeNode(structure, id);
            (got ? removed : missing).push(id);
          }
        },
        { op: 'remove', dryRun: !!args.dryRun }
      );
      return { removed, missing, dryRun: !!r.dryRun, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_edit',
    description:
      'Edit a particle\'s settings via JSON-patch. Pass `edits` as a flat map of form-field names → values, e.g.:\n  {"particles[contentarray][title]": "News", "block[size]": 50, "inherit[mode]": "clone"}',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Particle id' },
        edits: {
          type: 'object',
          additionalProperties: true,
          description: 'Map of "particles[type][...]" / "block[...]" / "inherit[...]" form names to values',
        },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id', 'edits'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      const r = await layoutApi.mutateLayout(
        ctx, outline,
        (structure) => layoutApi.editParticleFromForm(structure, args.id, args.edits),
        { op: 'edit', dryRun: !!args.dryRun }
      );
      // Detect silent no-ops: if the diff is empty, nothing matched — warn loudly.
      const diff = r.diff || null;
      const noop = diff && diff.changed.length === 0 && diff.added.length === 0 && diff.removed.length === 0;
      if (noop && !r.dryRun) {
        // Surface the particle's actual attribute keys to help fix field names
        const structure = await layoutApi.getLayoutStructure(ctx, outline);
        const info = layoutApi.inspectParticleDeep(structure, args.id);
        const attrKeys = info ? Object.keys(info.attributes) : [];
        throw new Error(
          `gantry_layout_edit: no fields matched — the edit was a no-op. ` +
          `Particle "${args.id}" attribute keys: [${attrKeys.join(', ')}]. ` +
          `Use gantry_particle_direct_edit to patch attributes directly by key name.`
        );
      }
      return { dryRun: !!r.dryRun, diff, verified: r.verified ?? null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_section_edit',
    description: 'Patch a section\'s attributes (boxed, class, variations, etc.). Pass attrs as a flat object.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Section id (e.g. expanded, navigation)' },
        attrs: { type: 'object', additionalProperties: true },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id', 'attrs'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.editSectionAttrs(structure, args.id, args.attrs),
        { op: 'section-edit', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_section_inherit',
    description: 'Make a section inherit from another outline (from), with optional include parts (children, attributes, block).',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string' },
        from: { type: 'string', description: 'Source outline (e.g. "default")' },
        include: { type: 'array', items: { type: 'string' }, default: ['children', 'attributes'] },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id', 'from'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const inherit = { outline: args.from, include: args.include || ['children', 'attributes'] };
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.setNodeInherit(structure, args.id, inherit),
        { op: 'section-inherit', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null };
    },
  },
  {
    name: 'gantry_layout_section_clone',
    description: 'Break inheritance on a section (clears the inherit field).',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD, id: { type: 'string' }, dryRun: { type: 'boolean' } },
      required: ['site', 'id'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.clearNodeInherit(structure, args.id),
        { op: 'section-clone', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null };
    },
  },
  {
    name: 'gantry_layout_clear',
    description: 'Wipe an outline\'s layout. mode "full" empties everything; "keep-inheritance" preserves nodes that have an inherit set.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        mode: { type: 'string', enum: ['full', 'keep-inheritance'], default: 'full' },
        dryRun: { type: 'boolean' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const r = await layoutApi.mutateLayout(
        ctx,
        args.outline || 'default',
        (structure) => layoutApi.clearLayout(structure, args.mode || 'full'),
        { op: 'clear-' + (args.mode || 'full'), dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_layout_copy_from',
    description: 'Copy the entire layout from one outline into another. Auto-backs up the target before overwriting.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        from: { type: 'string', description: 'Source outline id' },
        to: { type: 'string', description: 'Target outline id' },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'from', 'to'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const source = await layoutApi.fetchSavedLayout(ctx, args.from);
      if (!source.length) throw new Error(`Source outline ${args.from} has no layout`);
      const before = await layoutApi.fetchSavedLayout(ctx, args.to);
      const diff = layoutApi.diffStructures(before, source);
      if (args.dryRun) return { dryRun: true, diff };
      const backupPath = backup.takeBackup(ctx, args.to, `copy-from-${args.from}`, before);
      await layoutApi.saveLayoutDirect(ctx, ctx, args.to, source);
      return { copied: true, backupPath };
    },
  },
  {
    name: 'gantry_layout_load_preset',
    description: 'Apply a built-in Gantry preset (see layout_presets) to an outline. Auto-backed-up.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        preset: { type: 'string', description: 'Preset name (e.g. fullwidth, default, left_sidebar)' },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'preset'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = args.outline || 'default';
      // Fetch preset payload
      const url =
        `${ctx.base}/administrator/index.php` +
        `?option=com_gantry5` +
        `&view=${encodeURIComponent('configurations/' + outline + '/layout/preset/' + args.preset)}` +
        `&theme=${encodeURIComponent(ctx.theme)}` +
        (ctx.token ? `&${ctx.token}=1` : '') +
        '&format=json';
      const fetched = await ctx.fetch(url, { method: 'GET' });
      if (fetched.status >= 400) throw new Error(`Preset fetch ${fetched.status}`);
      const parsed = JSON.parse(fetched.body);
      if (parsed.success === false) throw new Error('Preset failed: ' + (parsed.message || ''));
      const newLayout = JSON.parse(parsed.data);
      const before = await layoutApi.fetchSavedLayout(ctx, outline);
      const diff = layoutApi.diffStructures(before, newLayout);
      if (args.dryRun) return { dryRun: true, diff, title: parsed.title };
      const backupPath = backup.takeBackup(ctx, outline, `pre-load-preset-${args.preset}`, before);
      // Use the same form-encoded body shape Gantry expects
      const saveUrl =
        `${ctx.base}/administrator/index.php?option=com_gantry5` +
        `&view=${encodeURIComponent('configurations/' + outline + '/layout')}` +
        `&theme=${encodeURIComponent(ctx.theme)}` +
        (ctx.token ? `&${ctx.token}=1` : '') +
        '&format=json';
      const body =
        'preset=' + encodeURIComponent(parsed.preset || '') +
        '&layout=' + encodeURIComponent(parsed.data);
      const saveRes = await ctx.fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
      });
      if (saveRes.status >= 400) throw new Error(`Save ${saveRes.status}`);
      return { applied: true, preset: args.preset, title: parsed.title, backupPath };
    },
  },

  /* Backups & undo */
  {
    name: 'gantry_layout_backups_list',
    description: 'List automatic layout backups for an outline (newest first).',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      return backup.listBackups(ctx, args.outline || 'default').map((b) => ({
        name: b.name,
        size: b.size,
        mtime: b.mtime.toISOString(),
        path: b.path,
      }));
    },
  },
  {
    name: 'gantry_layout_undo',
    description: 'Restore the most recent layout backup for an outline. Takes a fresh backup before reverting (so you can re-undo).',
    schema: {
      type: 'object',
      properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const file = backup.resolveBackup(ctx, args.outline || 'default', 'latest');
      const structure = backup.readBackup(file);
      const before = await layoutApi.fetchSavedLayout(ctx, args.outline || 'default');
      const preBackup = backup.takeBackup(ctx, args.outline || 'default', 'pre-restore', before);
      await layoutApi.saveLayoutDirect(ctx, ctx, args.outline || 'default', structure);
      return { restoredFrom: file, preRestoreBackup: preBackup };
    },
  },

  /* Styles & Page settings */
  {
    name: 'gantry_styles_list',
    description: 'List every style field of an outline (colors, fonts, breakpoints, etc.) with its current value.',
    schema: { type: 'object', properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD }, required: ['site'] },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await styles.openStyles(ctx, args.outline || 'default');
      return styles.listStyles(ctx);
    },
  },
  {
    name: 'gantry_styles_edit',
    description:
      'Edit theme style fields. Pass edits as a flat map, e.g. { "styles[base][background]": "#fafafa", "styles[font][family-title]": "Roboto" }.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        edits: { type: 'object', additionalProperties: true },
      },
      required: ['site', 'edits'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await styles.openStyles(ctx, args.outline || 'default');
      await styles.editStyles(ctx, args.edits);
      await styles.saveStyles(ctx);
      return { saved: Object.keys(args.edits) };
    },
  },
  {
    name: 'gantry_page_list',
    description: 'List every per-outline Page Settings field with its current value (favicon, body class/id, head_bottom, body_top/body_bottom, fontawesome).',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        all: { type: 'boolean', description: 'Include hidden _json aggregator fields' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await pageMod.openPage(ctx, args.outline || 'default');
      return pageMod.listPage(ctx, { all: !!args.all });
    },
  },
  {
    name: 'gantry_page_edit',
    description:
      'Edit Page Settings. Pass edits as a flat map, e.g. { "page[body][attribs][class]": "site-sub", "page[assets][favicon]": "gantry-media://template/favicon.png" }.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        edits: { type: 'object', additionalProperties: true },
      },
      required: ['site', 'edits'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      await pageMod.openPage(ctx, args.outline || 'default');
      await pageMod.editPage(ctx, args.edits);
      await pageMod.savePage(ctx);
      return { saved: Object.keys(args.edits) };
    },
  },

  /* Export / Import */
  {
    name: 'gantry_layout_export',
    description: 'Return the full layout structure (JSON) for an outline. The LLM can save this, modify it, or pass it to layout_import.',
    schema: { type: 'object', properties: { ...SITE_THEME_FIELDS, ...OUTLINE_FIELD }, required: ['site'] },
    handler: async (args) => {
      const ctx = await getCtx(args);
      return await layoutApi.fetchSavedLayout(ctx, args.outline || 'default');
    },
  },
  {
    name: 'gantry_layout_import',
    description: 'Apply a previously-exported layout structure to a target outline. Auto-backed-up.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        layout: {
          type: 'array',
          items: { type: 'object' },
          description: 'Layout structure (array of node objects) from gantry_layout_export',
        },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'layout'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      // Merge incoming layout with the base home template:
      // enforces fixed sections (navigation/bottom/footer/copyright/offcanvas inherit),
      // keeps top particles, and ensures all containers are always present.
      const mergedLayout = baseTemplate.mergeWithBaseTemplate(args.layout);
      const before = await layoutApi.fetchSavedLayout(ctx, args.outline || 'default');
      const diff = layoutApi.diffStructures(before, mergedLayout);
      if (args.dryRun) return { dryRun: true, diff };
      // Section preservation: reject if any existing section would be deleted or moved
      if (!args.force_section_delete) {
        layoutApi.assertSectionsPreserved(layoutApi.snapshotSections(before), mergedLayout);
      }
      const backupPath = backup.takeBackup(ctx, args.outline || 'default', 'pre-import', before);
      await layoutApi.saveLayoutDirect(ctx, ctx, args.outline || 'default', mergedLayout);
      return { imported: true, backupPath, baseTemplateApplied: true };
    },
  },
  /* ── New tools: particle inspection & mutation ─────────────────────────── */
  {
    name: 'gantry_particle_inspect',
    description:
      'Deep-inspect a single particle by id. Returns the particle node, its wrapper ' +
      'block node (with CSS class), and all attributes. Essential before editing a ' +
      'repeater or block class — shows the exact JSON structure to patch.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: { type: 'string', description: 'Particle id to inspect' },
      },
      required: ['site', 'id'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      const structure = await layoutApi.getLayoutStructure(ctx, outline);
      const result = layoutApi.inspectParticleDeep(structure, args.id);
      if (!result) throw new Error(`Particle "${args.id}" not found in outline "${outline}"`);
      return result;
    },
  },
  {
    name: 'gantry_particle_find',
    description:
      'Find particles in an outline that match filter criteria. Useful for locating ' +
      'the exact id of a particle before editing it. Filters: section id, title ' +
      '(case-insensitive substring), subtype (e.g. "logo", "menu", "contentarray").',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        section:  { type: 'string', description: 'Section id to restrict search to' },
        title:    { type: 'string', description: 'Case-insensitive substring of particle title' },
        subtype:  { type: 'string', description: 'Exact subtype match (e.g. "logo", "contentarray")' },
        type:     { type: 'string', description: 'Node type: particle | system | position | spacer' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      const structure = await layoutApi.getLayoutStructure(ctx, outline);
      const matches = layoutApi.findParticles(structure, {
        section: args.section,
        title:   args.title,
        subtype: args.subtype,
        type:    args.type,
      });
      return matches.map(({ particle, block, attributes }) => ({
        id:         particle.id,
        type:       particle.type,
        subtype:    particle.subtype,
        title:      particle.title,
        blockId:    block ? block.id : null,
        blockClass: block?.attributes?.class || '',
        attributes,
      }));
    },
  },
  {
    name: 'gantry_particle_update_repeater_item',
    description:
      'Update a single item inside a repeater (array) attribute on a particle — ' +
      'e.g. change one slide in a slider, one row in a contentarray, one link in a menu. ' +
      'Pass repeaterPath as the attribute key (e.g. "items"), index (0-based), and ' +
      'patch (fields to merge into that item). Preserves all other items untouched.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id:           { type: 'string', description: 'Particle id' },
        repeaterPath: { type: 'string', description: 'Attribute key of the array (e.g. "items", "subcontents")' },
        index:        { type: 'number', description: '0-based index of the item to update' },
        patch:        { type: 'object', additionalProperties: true, description: 'Fields to merge into the item' },
        dryRun:       { type: 'boolean' },
      },
      required: ['site', 'id', 'repeaterPath', 'index', 'patch'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      const r = await layoutApi.mutateLayout(
        ctx, outline,
        (structure) => layoutApi.editRepeaterItem(structure, args.id, args.repeaterPath, args.index, args.patch),
        { op: 'repeater-item-edit', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_particle_replace_repeater',
    description:
      'Replace an entire repeater (array) attribute on a particle with a new array. ' +
      'Use this when you need to reorder, add, or delete items in a repeater. ' +
      'Always inspect the particle first to get the current array structure.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id:           { type: 'string', description: 'Particle id' },
        repeaterPath: { type: 'string', description: 'Attribute key of the array (e.g. "items")' },
        newArray:     { type: 'array',  items: { type: 'object' }, description: 'Replacement array (each element is a plain object)' },
        dryRun:       { type: 'boolean' },
      },
      required: ['site', 'id', 'repeaterPath', 'newArray'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      const r = await layoutApi.mutateLayout(
        ctx, outline,
        (structure) => layoutApi.replaceRepeater(structure, args.id, args.repeaterPath, args.newArray),
        { op: 'repeater-replace', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_block_edit',
    description:
      'Edit a block node\'s attributes — most commonly to set or change the CSS class ' +
      '(e.g. `{"class": "g-offset-20"}`) or size. The block is the wrapper around a ' +
      'particle; get its id from gantry_particle_inspect (result.block.id).',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id:     { type: 'string', description: 'Block node id' },
        attrs:  { type: 'object', additionalProperties: true, description: 'Attributes to merge into the block (e.g. {"class": "g-offset-20"})' },
        dryRun: { type: 'boolean' },
      },
      required: ['site', 'id', 'attrs'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      const r = await layoutApi.mutateLayout(
        ctx, outline,
        (structure) => layoutApi.editBlockAttrs(structure, args.id, args.attrs),
        { op: 'block-edit', dryRun: !!args.dryRun }
      );
      return { dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_find_and_edit',
    description:
      'Find particles matching filter criteria and apply the same edits to all of them ' +
      'in a single atomic save. Useful for bulk-updating all particles of a given subtype ' +
      'across a layout (e.g. hide all "social" particles, re-title all "logo" particles). ' +
      'Pass the same `edits` format as gantry_layout_edit.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        section:  { type: 'string', description: 'Restrict to particles in this section id' },
        title:    { type: 'string', description: 'Case-insensitive title substring filter' },
        subtype:  { type: 'string', description: 'Exact subtype to target (e.g. "logo")' },
        type:     { type: 'string', description: 'Node type filter (particle | system | position | spacer)' },
        edits:    {
          type: 'object',
          additionalProperties: true,
          description: 'Edits to apply to each matched particle (form-field name → value)',
        },
        dryRun:   { type: 'boolean' },
      },
      required: ['site', 'edits'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      let matched = [];
      const r = await layoutApi.mutateLayout(
        ctx, outline,
        (structure) => {
          const hits = layoutApi.findParticles(structure, {
            section: args.section,
            title:   args.title,
            subtype: args.subtype,
            type:    args.type,
          });
          if (hits.length === 0) throw new Error('No particles matched the given filters');
          matched = hits.map(h => ({ id: h.particle.id, title: h.particle.title, subtype: h.particle.subtype }));
          for (const { particle } of hits) {
            layoutApi.editParticleFromForm(structure, particle.id, args.edits);
          }
        },
        { op: 'find-and-edit', dryRun: !!args.dryRun }
      );
      return { matched, dryRun: !!r.dryRun, diff: r.diff || null, backupPath: r.backupPath || null };
    },
  },
  {
    name: 'gantry_outline_resolve',
    description:
      'Resolve an outline name or title to its numeric id. Accepts a numeric id ' +
      '("33"), a title ("#Home", "Home"), or "default". Returns { id, title }. ' +
      'Use this when you have a human-readable name but need the id for other tools.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ref: { type: 'string', description: 'Outline id, title, or "#Title" format' },
      },
      required: ['site', 'ref'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      return outlines.resolveOutline(ctx, args.ref);
    },
  },
  {
    name: 'gantry_outline_assignments',
    description:
      'Read the assignments for an outline — which menu items are assigned to it. ' +
      'Returns the raw assignment form fields so you can see the current state. ' +
      'Pass `edits` (field-name → value map) to update assignments and save.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        edits:  { type: 'object', additionalProperties: true, description: 'Optional: assignment field edits to save' },
        dryRun: { type: 'boolean' },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      const url =
        `${ctx.base}/administrator/index.php` +
        `?option=com_gantry5&view=${encodeURIComponent('configurations/' + outline + '/assignments')}` +
        `&theme=${encodeURIComponent(ctx.theme)}` +
        (ctx.token ? `&${ctx.token}=1` : '');
      const res = await ctx.fetch(url, { method: 'GET' });
      if (res.status >= 400) throw new Error(`Assignments page returned ${res.status}`);
      const html = res.body;
      // Parse checkbox inputs named "assignments[...]"
      const fields = [];
      const inputRe = /<input\b([^>]*)>/gi;
      let m;
      while ((m = inputRe.exec(html))) {
        const tag = m[1];
        const name = (tag.match(/\bname="(assignments\[[^\]]*\][^"]*)"/) || [])[1];
        if (!name) continue;
        const type = ((tag.match(/\btype="([^"]*)"/) || [,'text'])[1]).toLowerCase();
        const checked = type === 'checkbox' ? /\bchecked\b/.test(tag) : null;
        const value = (tag.match(/\bvalue="([^"]*)"/) || [])[1] || '';
        fields.push({ name, type, value, checked });
      }
      if (!args.edits) return { outline, fields };
      if (args.dryRun) return { outline, dryRun: true, fieldCount: fields.length };
      // Merge edits over parsed fields and POST
      const fieldMap = {};
      for (const f of fields) {
        if (f.type === 'checkbox') { if (f.checked) fieldMap[f.name] = f.value; }
        else fieldMap[f.name] = f.value;
      }
      Object.assign(fieldMap, args.edits);
      const saveUrl = url.replace(/(&format=[^&]*)/, '') + '&format=json';
      const body = Object.entries(fieldMap)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
      const saveRes = await ctx.fetch(saveUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body,
      });
      if (saveRes.status >= 400) throw new Error(`Assignments save returned ${saveRes.status}`);
      let parsed = null;
      try { parsed = JSON.parse(saveRes.body); } catch {}
      return { outline, saved: true, response: parsed || saveRes.body.slice(0, 300) };
    },
  },

  /* ── Reliable direct-edit + page outline detection ─────────────────────── */
  {
    name: 'gantry_particle_direct_edit',
    description:
      'The most reliable way to edit a particle. Fetches a fresh layout snapshot, ' +
      'directly deep-merges an `attributes` patch into the particle (no form-field ' +
      'name translation needed), optionally sets the wrapper block CSS class, saves, ' +
      'then re-reads the layout and returns a verified diff. ' +
      'Use this instead of gantry_layout_edit for repeater fields (subcontents, items, ' +
      'slides) or whenever gantry_layout_edit reports a no-op. ' +
      'Pass `attributes` as the exact JSON object to merge — e.g. ' +
      '{"subcontents": [...], "title": "My Title"}. ' +
      'Pass `blockClass` to set/replace the wrapper block CSS class (e.g. "ql-window-title").',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id:         { type: 'string', description: 'Particle node id' },
        attributes: {
          type: 'object',
          additionalProperties: true,
          description: 'Key/value pairs to deep-merge into particle.attributes',
        },
        blockClass: { type: 'string', description: 'CSS class to set on the wrapper block node' },
        dryRun:      { type: 'boolean' },
        page_url:    { type: 'string',  description: 'Frontend page URL where this particle renders. When provided with return_html:true, the saved result is verified against live rendered HTML.' },
        return_html: { type: 'boolean', description: 'After saving, fetch the particle rendered HTML from page_url and include it in the response (requires page_url).' },
      },
      required: ['site', 'id'],
    },
    handler: async (args) => {
      if (!args.attributes && !args.blockClass) {
        throw new Error('Pass at least one of `attributes` or `blockClass`');
      }
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      let editedParticleId = args.id;
      let editedBlockId = null;

      const r = await layoutApi.mutateLayout(
        ctx, outline,
        (structure) => {
          // Attributes patch
          if (args.attributes) {
            const node = layoutApi.findNode(structure, args.id);
            if (!node) throw new Error(`Particle "${args.id}" not found in outline "${outline}"`);
            if (!['particle', 'system', 'position', 'spacer'].includes(node.type)) {
              throw new Error(`Node "${args.id}" is type "${node.type}", not a particle`);
            }
            node.attributes = { ...(node.attributes || {}), ...args.attributes };
          }
          // Block class patch
          if (args.blockClass !== undefined) {
            const info = layoutApi.inspectParticleDeep(structure, args.id);
            if (!info) throw new Error(`Cannot inspect particle "${args.id}"`);
            if (info.block) {
              info.block.attributes = { ...(info.block.attributes || {}), class: args.blockClass };
              editedBlockId = info.block.id;
            }
          }
        },
        { op: 'direct-edit', dryRun: !!args.dryRun }
      );

      const out = {
        particleId: editedParticleId,
        blockId:    editedBlockId,
        dryRun:     !!r.dryRun,
        diff:       r.diff || null,
        verified:   r.verified ?? null,
        backupPath: r.backupPath || null,
      };

      // Optional: fetch live rendered HTML after save
      if (!r.dryRun && args.return_html && args.page_url) {
        try {
          const site = args.site.replace(/\/+$/, '');
          const pageUrl = args.page_url.startsWith('http')
            ? args.page_url
            : `${site}${args.page_url.startsWith('/') ? '' : '/'}${args.page_url}`;
          const htmlResult = await layoutApi.fetchParticleHtml(ctx, outline, args.id, pageUrl);
          out.renderedHtml = htmlResult;
        } catch (htmlErr) {
          out.renderedHtmlError = htmlErr.message;
        }
      }

      return out;
    },
  },
  {
    name: 'gantry_particle_html',
    description:
      'Fetch the rendered frontend HTML for a specific particle. ' +
      'Returns the outerHTML of the block wrapper, the list of classes on the ' +
      'block wrapper (blockClasses), and the list of classes on the inner ' +
      'g-content element (innerClasses). Also returns the current blockClass and ' +
      'particle attributes from the layout JSON side-by-side. ' +
      'Use this to design override.css rules — you see exactly what Gantry renders ' +
      'before deciding what class to apply. ' +
      'Locating strategy: first tries the custom block CSS class already set on the ' +
      'particle; falls back to the particle subtype class (g-{subtype}). ' +
      'If the particle has no unique class yet, set one with gantry_particle_direct_edit ' +
      'and re-run for precise targeting.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        id: {
          type: 'string',
          description: 'Particle node id (from gantry_layout_list or gantry_particle_find)',
        },
        page_url: {
          type: 'string',
          description: 'Frontend page URL or path (e.g. "/" or "https://example.com/about-us") where this particle renders',
        },
      },
      required: ['site', 'id', 'page_url'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);
      const site = args.site.replace(/\/+$/, '');
      const pageUrl = args.page_url.startsWith('http')
        ? args.page_url
        : `${site}${args.page_url.startsWith('/') ? '' : '/'}${args.page_url}`;
      return layoutApi.fetchParticleHtml(ctx, outline, args.id, pageUrl);
    },
  },
  {
    name: 'gantry_get_outline_for_page',
    description:
      'Fetch a frontend page and detect which Gantry outline is serving it. ' +
      'Gantry embeds the outline id in the page body class (e.g. "outline-33"). ' +
      'Returns { outlineId, title, url } so you know exactly which outline to edit ' +
      'before making layout changes. Always call this before editing a page layout.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        path: {
          type: 'string',
          description: 'Frontend path (e.g. "/", "/about-us") or full URL',
        },
      },
      required: ['site', 'path'],
    },
    handler: async (args) => {
      const ctx = await getCtx(args);
      const site = args.site.replace(/\/+$/, '');
      const url = args.path.startsWith('http')
        ? args.path
        : `${site}${args.path.startsWith('/') ? '' : '/'}${args.path}`;

      const res = await ctx.fetch(url, { method: 'GET' });
      if (res.status >= 400) throw new Error(`Page fetch returned ${res.status}: ${url}`);

      const html = res.body;

      // Extract outline id from body class, e.g. class="... outline-33 ..."
      const outlineMatch = html.match(/\boutline-(\d+)\b/);
      const outlineId = outlineMatch ? outlineMatch[1] : null;

      // Also look for theme/template info
      const themeMatch = html.match(/\btemplate-([a-z0-9_-]+)\b/i);
      const detectedTheme = themeMatch ? themeMatch[1] : null;

      // Try to get a title from the <title> tag
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const pageTitle = titleMatch ? titleMatch[1].trim() : '';

      if (!outlineId) {
        return {
          outlineId: null,
          warning: 'No outline-N class found in page body. Is this a Gantry 5 page?',
          url, pageTitle, detectedTheme,
        };
      }

      // Resolve outline title from Gantry
      let outlineTitle = outlineId;
      try {
        const resolved = await outlines.resolveOutline(ctx, outlineId);
        outlineTitle = resolved.title;
      } catch {}

      return { outlineId, outlineTitle, url, pageTitle, detectedTheme };
    },
  },

  /* ── Layout design system ───────────────────────────────────────────────── */
  {
    name: 'gantry_particle_catalog',
    description:
      'Return the full knowledge base for one or all Gantry particle types. ' +
      'Includes attribute schemas, when-to-use guidance, common block classes, ' +
      'and worked examples. Call this at the start of any layout design session ' +
      'to understand what each particle can do before writing a design YAML.',
    schema: {
      type: 'object',
      properties: {
        subtype: {
          type: 'string',
          description:
            'Specific particle subtype to look up (e.g. "blockcontent", "contentarray"). ' +
            'Omit to return the full catalog of all particle types.',
        },
      },
      required: [],
    },
    handler: async (args) => {
      const catalog = compiler.getParticleCatalog(args.subtype || null);
      if (!catalog) throw new Error(`Particle type "${args.subtype}" not found in catalog`);
      return catalog;
    },
  },
  {
    name: 'gantry_section_templates',
    description:
      'Return available section template starters for parish site layouts. ' +
      'Templates are pre-built YAML snippets for standard sections: ' +
      'header-navigation, hero-swiper, utility-quicklinks, news-events-grid, ' +
      'link-boxes, footer-3col, alert-banner. ' +
      'Omit name to get an index of all templates with descriptions. ' +
      'Pass name to get the full YAML content of a specific template.',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Template name (e.g. "hero-swiper", "footer-3col"). ' +
            'Omit to list all available templates.',
        },
      },
      required: [],
    },
    handler: async (args) => {
      return compiler.getSectionTemplates(args.name || null);
    },
  },
  {
    name: 'gantry_layout_design',
    description:
      'Compile and optionally apply a design YAML layout to a Gantry outline. ' +
      'The design YAML is a simplified, AI-writable format — no IDs, flat ' +
      'section structure, context variable substitution. The compiler generates ' +
      'all Gantry IDs, builds container/grid/block nesting, and validates the result. ' +
      'Use dryRun:true first to validate and see the compiled tree before applying. ' +
      'Context variables in the YAML ({{news_category_id}}) are substituted from the ' +
      'context object. ' +
      'Design YAML top-level keys: schema, outline, context, top_container, sections, ' +
      'main_container, extra_sections, footer_container, offcanvas.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        design_yaml: {
          type: 'string',
          description: 'The design YAML string to compile and apply.',
        },
        dryRun: {
          type: 'boolean',
          description: 'If true, compile and validate but do not save to Gantry.',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description:
            'Runtime context variables that override those in the design YAML. ' +
            'E.g. { "news_category_id": "8", "mass_times_article_id": "55" }',
        },
      },
      required: ['site', 'design_yaml'],
    },
    handler: async (args) => {
      const result = compiler.compileYaml(args.design_yaml, args.context || {});

      if (!result.valid) {
        return {
          valid: false,
          errors: result.errors,
          warnings: result.warnings,
          treeSummary: result.treeSummary,
        };
      }

      if (args.dryRun) {
        return {
          valid: true,
          dryRun: true,
          errors: result.errors,
          warnings: result.warnings,
          treeSummary: result.treeSummary,
          nodeCount: result.layout.length,
        };
      }

      // Apply — use the existing import path
      const ctx     = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);

      const before     = await layoutApi.fetchSavedLayout(ctx, outline);
      const diff       = layoutApi.diffStructures(before, result.layout);
      // Section preservation: reject if any existing section would be deleted or moved
      if (!args.force_section_delete) {
        layoutApi.assertSectionsPreserved(layoutApi.snapshotSections(before), result.layout);
      }
      const backupPath = backup.takeBackup(ctx, outline, 'pre-design-import', before);
      await layoutApi.saveLayoutDirect(ctx, ctx, outline, result.layout);

      // Readback verify
      let verified = null;
      try {
        const saved      = await layoutApi.fetchSavedLayout(ctx, outline);
        const verifyDiff = layoutApi.diffStructures(result.layout, saved);
        verified = verifyDiff.changed.length === 0 &&
                   verifyDiff.added.length   === 0 &&
                   verifyDiff.removed.length === 0;
      } catch {}

      return {
        valid:    true,
        applied:  true,
        outline,
        backupPath,
        diff,
        verified,
        warnings: result.warnings,
        treeSummary: result.treeSummary,
      };
    },
  },

  {
    name: 'gantry_homepage_examples',
    description:
      'Query the homepage blueprint library — a collection of captured #Home and ' +
      '#School Home outlines from real parish/school/cemetery sites. ' +
      'Use this to find design patterns, block classes, and proven layout structures ' +
      'before designing a new homepage. ' +
      'Call with no slug to list/filter the library. Call with a slug to get the full ' +
      'meta and optionally the decompiled design YAML or raw blueprint for that site. ' +
      'Workflow: (1) list to find a relevant example, (2) fetch with include_decompiled:true ' +
      'to get a design YAML starting point, (3) adapt context variables, ' +
      '(4) compile and apply with gantry_layout_design.',
    schema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description:
            'Site slug to fetch (e.g. "stlaw-alex", "olmc-fairfield"). ' +
            'Omit to list/filter all examples.',
        },
        outline_type: {
          type: 'string',
          enum: ['home', 'school_home'],
          description: 'Which outline type to retrieve. Defaults to "home".',
        },
        site_type: {
          type: 'string',
          enum: ['parish', 'school', 'cemetery'],
          description: 'Filter listing by site type.',
        },
        has_school: {
          type: 'boolean',
          description: 'Filter listing to sites that have a school home outline.',
        },
        search_block_class: {
          type: 'string',
          description:
            'Filter listing to sites whose home outline contains this block class ' +
            '(e.g. "fullwidth-swiper", "news-to-me"). Case-insensitive substring match.',
        },
        include_decompiled: {
          type: 'boolean',
          description:
            'When fetching a specific slug, also return the blueprint decompiled to ' +
            'design YAML. Use this to get a starting point for a new design. Default false.',
        },
        include_blueprint: {
          type: 'boolean',
          description:
            'When fetching a specific slug, also return the raw blueprint JSON. ' +
            'Large — only request when you need the full layout detail. Default false.',
        },
      },
    },
    handler: async (args) => {
      return compiler.getHomepageExamples(args.slug || null, {
        outline_type:        args.outline_type,
        site_type:           args.site_type,
        has_school:          args.has_school,
        search_block_class:  args.search_block_class,
        include_decompiled:  args.include_decompiled,
        include_blueprint:   args.include_blueprint,
      });
    },
  },

  {
    name: 'gantry_layout_decompile',
    description:
      'Decompile a Gantry outline layout into a human/AI-readable design YAML. ' +
      'The reverse of gantry_layout_design: takes a live outline (by ID) or a ' +
      'provided blueprint JSON and converts it into the simplified design YAML format ' +
      'that the compiler understands. ' +
      'Use this to: (1) understand an existing outline before editing, ' +
      '(2) clone a layout to a new site by exporting → decompiling → adapting → recompiling, ' +
      '(3) audit what particles and block classes are actually in a live outline. ' +
      'The returned YAML can be passed directly to gantry_layout_design after editing.',
    schema: {
      type: 'object',
      properties: {
        outline: {
          type: 'string',
          description:
            'Outline ID or name to decompile (e.g. "33" or "#Home"). ' +
            'The live layout is fetched and decompiled. ' +
            'Either outline or blueprint must be provided.',
        },
        blueprint: {
          type: 'object',
          additionalProperties: true,
          description:
            'A blueprint JSON object to decompile directly (e.g. from gantry_layout_export ' +
            'or the homepage library). Use instead of outline if you already have the JSON.',
        },
        truncate_html: {
          type: 'boolean',
          description: 'Truncate long HTML strings in custom particles. Default true.',
        },
        max_html_len: {
          type: 'number',
          description: 'Max characters for HTML strings before truncation. Default 400.',
        },
        site: { type: 'string', description: 'Site URL override (uses active site if omitted).' },
        theme: { type: 'string', description: 'Theme key override (default: rt_studius).' },
      },
    },
    handler: async (args) => {
      const opts = {
        truncateHtml: args.truncate_html !== false,
        maxHtmlLen:   args.max_html_len  || 400,
      };

      let input = args.blueprint;

      if (!input) {
        if (!args.outline) throw new Error('Either outline or blueprint must be provided');
        const ctx = await getCtx(args.site, args.theme || '');
        const layout = await layoutApi.fetchSavedLayout(ctx, args.outline);
        input = layout;
      }

      const { design, yaml: yamlStr } = compiler.decompile(input, opts);
      return {
        outline: args.outline || '(from blueprint)',
        design_yaml: yamlStr,
        section_count: (design.sections || []).length +
                       (design.top_container ? 1 : 0) +
                       (design.main_container ? 1 : 0) +
                       (design.footer_container ? 1 : 0),
      };
    },
  },

  {
    name: 'gantry_layout_from_brief',
    description:
      'Generate a starter design YAML from a plain-English site brief. ' +
      'Analyzes the brief for keywords (hero, quicklinks, news, footer, etc.) ' +
      'and assembles an appropriate YAML scaffold using section templates. ' +
      'The returned YAML has placeholder context variables that need to be ' +
      'filled in (article IDs, category IDs) before calling gantry_layout_design. ' +
      'Workflow: (1) call this to get a starter YAML, (2) fill in context IDs ' +
      'from joomla_list_categories / joomla_list_articles, (3) call ' +
      'gantry_layout_design with dryRun:true to validate, (4) apply.',
    schema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description:
            'Plain-English description of the site layout needed. Include the parish name, ' +
            'sections required, and any known IDs. Example: ' +
            '"Homepage for St. Mary Parish. Hero slider, mass times sidebar, quicklinks bar ' +
            'with 5 links, news feed, link boxes, 3-column footer. News category ID is 8."',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Any known context values to pre-populate (category IDs, article IDs, etc.)',
        },
      },
      required: ['brief'],
    },
    handler: async (args) => {
      return compiler.briefToDesignYaml(args.brief, args.context || {});
    },
  },

  /* -- Design knowledge layer ------------------------------------------- */
  {
    name: 'gantry_design_patterns',
    description:
      'Return the design pattern knowledge base - a library of named, explained ' +
      'section patterns that teach the LLM WHY each particle+CSS+content combination ' +
      'was chosen. Each pattern covers: intent, particle_choice rationale, content ' +
      'contract (what Joomla IDs are needed), layout contract (section, blockClass, ' +
      'width), CSS contract (required selectors, behavior), link behavior rules, and ' +
      'guardrails. ' +
      'Call with no name to list all patterns. Call with a name to get the full ' +
      'pattern detail. ' +
      'REQUIRED first call before designing any homepage section. Use patterns to ' +
      'choose the right particle, understand what content IDs to look up, and know ' +
      'which guardrails apply before writing design YAML.',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'Pattern name to fetch in full (e.g. "hero-swiper-with-mass-times", ' +
            '"quicklinks-bar", "alert-banner"). Omit to list all patterns.',
        },
        site_type: {
          type: 'string',
          enum: ['parish', 'school', 'cemetery'],
          description: 'Filter listing to patterns applicable to this site type.',
        },
      },
    },
    handler: async (args) => {
      const fs   = require('fs');
      const path = require('path');
      const yaml = require('js-yaml');

      const patternsDir = path.join(__dirname, 'design-patterns');
      if (!fs.existsSync(patternsDir)) {
        return { patterns: [], note: 'No design-patterns/ directory found.' };
      }

      const files = fs.readdirSync(patternsDir).filter(f => f.endsWith('.yaml'));

      if (args.name) {
        const file = files.find(f => f === args.name + '.yaml' || f === args.name);
        if (!file) throw new Error(`Pattern "${args.name}" not found. Available: ${files.map(f => f.replace('.yaml','')).join(', ')}`);
        const raw = fs.readFileSync(path.join(patternsDir, file), 'utf8');
        return yaml.load(raw);
      }

      const index = files.map(f => {
        try {
          const raw = fs.readFileSync(path.join(patternsDir, f), 'utf8');
          const p = yaml.load(raw);
          if (args.site_type && p.site_types && !p.site_types.includes(args.site_type)) return null;
          const intent = (p.intent || '').replace(/\s+/g, ' ').trim();
          return {
            name:       p.name,
            label:      p.label,
            site_types: p.site_types,
            intent:     intent.slice(0, 120) + (intent.length > 120 ? '...' : ''),
            particle:   p.particle_choice && (p.particle_choice.use ||
                          Object.keys(p.particle_choice).map(k => p.particle_choice[k] && p.particle_choice[k].use).filter(Boolean).join(', ')),
            blockClass: (p.layout_contract && p.layout_contract.blockClass) || '',
            section:    (p.layout_contract && p.layout_contract.section) || '',
          };
        } catch (e) { return null; }
      }).filter(Boolean);

      return { count: index.length, patterns: index };
    },
  },

  {
    name: 'gantry_design_plan_from_brief',
    description:
      'Generate a structured DESIGN PLAN from a plain-English brief - BEFORE writing ' +
      'any design YAML. Returns a checklist of: selected patterns, why each was chosen, ' +
      'required Joomla content IDs to look up, CSS classes needed, guardrails that apply, ' +
      'and missing information that must be resolved before proceeding. ' +
      'This is step 1 of the design workflow. After resolving all missing info, call ' +
      'gantry_layout_from_brief or gantry_layout_design to produce the actual YAML.',
    schema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description:
            'Plain-English description of the layout needed. Include site type, sections ' +
            'required, and any known IDs. Example: "Parish homepage. Hero slider, mass ' +
            'times sidebar, quicklinks bar, news feed, Facebook widget, footer."',
        },
        site_type: {
          type: 'string',
          enum: ['parish', 'school', 'cemetery'],
          description: 'Site type - controls which patterns are eligible.',
        },
      },
      required: ['brief'],
    },
    handler: async (args) => {
      const fs   = require('fs');
      const path = require('path');
      const yaml = require('js-yaml');

      const patternsDir = path.join(__dirname, 'design-patterns');
      const files = fs.existsSync(patternsDir)
        ? fs.readdirSync(patternsDir).filter(f => f.endsWith('.yaml'))
        : [];

      const patterns = files.map(f => {
        try { return yaml.load(fs.readFileSync(path.join(patternsDir, f), 'utf8')); }
        catch (e) { return null; }
      }).filter(Boolean);

      const brief = (args.brief || '').toLowerCase();

      const KEYWORDS = {
        'hero-swiper-with-mass-times': ['hero', 'swiper', 'slider', 'slideshow', 'mass times', 'rotator'],
        'alert-banner':  ['alert', 'announcement', 'banner', 'notice'],
        'quicklinks-bar': ['quicklink', 'quick link', 'utility', 'ql', 'link bar', 'nav bar', 'links bar'],
        'news-feed-sidebar': ['news', 'events', 'feed', 'articles', 'parish news'],
        'link-boxes-grid': ['link box', 'ministry', 'card grid', 'card', 'link grid', 'categories', 'programs'],
        'social-widget': ['facebook', 'instagram', 'social', 'widget', 'embed'],
        'footer-shell': ['footer'],
        'parish-mission': ['mission', 'welcome', 'about', 'statement'],
      };

      const selected = [];
      const missing  = [];
      const allGuardrails = [];

      for (const [patternName, keywords] of Object.entries(KEYWORDS)) {
        if (keywords.some(k => brief.includes(k))) {
          const pattern = patterns.find(p => p.name === patternName);
          if (!pattern) continue;
          if (args.site_type && pattern.site_types && !pattern.site_types.includes(args.site_type)) continue;

          const pc = pattern.particle_choice || {};
          const particleUse = pc.use || Object.keys(pc).map(k => pc[k] && pc[k].use).filter(Boolean).join(', ');
          const lc = pattern.layout_contract || {};

          const entry = {
            pattern:    patternName,
            label:      pattern.label,
            why:        'Matched keywords: ' + keywords.filter(k => brief.includes(k)).join(', '),
            particle:   particleUse,
            section:    lc.section || '(see pattern)',
            blockClass: lc.blockClass || '',
            required_ids: [],
            guardrails: pattern.guardrails || [],
          };

          for (const [varName, varDef] of Object.entries(pattern.context_variables || {})) {
            if (varDef.required) {
              entry.required_ids.push({ variable: varName, find_with: varDef.find_with, hint: varDef.hint });
              missing.push({ for_pattern: patternName, variable: varName, find_with: varDef.find_with, hint: varDef.hint });
            }
          }

          allGuardrails.push(...(pattern.guardrails || []).map(g => '[' + patternName + '] ' + g));
          selected.push(entry);
        }
      }

      return {
        brief: args.brief,
        patterns_selected: selected.length,
        plan: selected,
        missing_information: missing,
        all_guardrails: allGuardrails,
        next_steps: [
          missing.length > 0
            ? 'Resolve ' + missing.length + ' missing content IDs using joomla_list_categories and joomla_list_articles'
            : 'All required IDs are known - proceed to gantry_layout_from_brief or write design YAML directly',
          'Run gantry_layout_design with dryRun:true to validate before applying',
          'After applying, fetch frontend page and verify each section renders correctly',
        ],
      };
    },
  },

  {
    name: 'gantry_validate_design_contract',
    description:
      'Validate a design YAML against design pattern contracts - checking content rules, ' +
      'link behavior, and guardrails BEFORE applying. Returns errors and warnings with ' +
      'fix instructions. Call this after writing design YAML and before gantry_layout_design. ' +
      'Catches: empty buttonlinks, wrong particle for content type, missing article/category ' +
      'IDs, conflicting filter settings.',
    schema: {
      type: 'object',
      properties: {
        design_yaml: {
          type: 'string',
          description: 'Design YAML string to validate.',
        },
        pattern_name: {
          type: 'string',
          description: 'Specific pattern to validate against. Omit to run all checks.',
        },
      },
      required: ['design_yaml'],
    },
    handler: async (args) => {
      const yaml = require('js-yaml');

      let design;
      try { design = yaml.load(args.design_yaml); }
      catch (e) { return { valid: false, errors: ['YAML parse error: ' + e.message], warnings: [] }; }

      const errors   = [];
      const warnings = [];

      const sections = [
        ...(design.sections || []),
        ...((design.top_container && design.top_container.sections) || []),
        ...((design.main_container && design.main_container.sections) || []),
        ...((design.footer_container && design.footer_container.sections) || []),
      ];

      for (const section of sections) {
        const sid = section.id || 'unknown-section';
        for (const grid of (section.grids || [])) {
          for (const block of (grid.blocks || [])) {
            const particle = block.particle || block.type || '';
            const bc       = block.blockClass || '';
            const attrs    = block.attributes || {};

            // blockcontent checks
            if (particle === 'blockcontent') {
              const items = attrs.subcontents || [];
              items.forEach((item, i) => {
                if (!item.buttonlink && item.buttonlink !== 0) {
                  errors.push('[' + sid + '] blockcontent item[' + i + '] "' + (item.name || '') + '" has empty buttonlink - produces broken anchor.');
                }
              });
              if (bc.includes('mass-times') || bc.includes('mass_times')) {
                errors.push('[' + sid + '] blockClass "' + bc + '" looks like Mass Times but particle is blockcontent. Mass Times must use contentarray (editor-managed article).');
              }
            }

            // contentarray checks
            if (particle === 'contentarray') {
              const filter = ((attrs.article || {}).filter) || {};
              const hasCategories = filter.categories && filter.categories !== '';
              const hasArticles   = filter.articles   && filter.articles   !== '';
              if (!hasCategories && !hasArticles) {
                errors.push('[' + sid + '] contentarray has neither filter.categories nor filter.articles set - will render nothing.');
              }
              if (hasCategories && hasArticles) {
                warnings.push('[' + sid + '] contentarray has both categories AND articles set - articles filter takes precedence; categories will be ignored.');
              }
              if (hasArticles) {
                const limit = ((attrs.article || {}).limit || {}).total;
                if (limit && parseInt(limit, 10) > 1) {
                  warnings.push('[' + sid + '] contentarray points to specific article IDs but limit.total > 1. For shell articles, set total:"1".');
                }
                const disp = ((attrs.article || {}).display || {});
                if (disp.pagination_buttons) {
                  errors.push('[' + sid + '] contentarray shell article has pagination_buttons enabled - must be blank/off.');
                }
              }
              if (hasCategories) {
                const disp = ((attrs.article || {}).display || {});
                const rm = disp.read_more || {};
                if (rm.enabled === 'hide') {
                  warnings.push('[' + sid + '] contentarray category feed has read_more hidden - visitors cannot reach full articles.');
                }
              }
            }

            // swiper checks
            if (particle === 'swiper') {
              const filter = ((attrs.article || {}).filter) || {};
              const hasCategories = filter.categories && filter.categories !== '';
              const hasArticles   = filter.articles   && filter.articles   !== '';
              if (!hasCategories && !hasArticles) {
                errors.push('[' + sid + '] swiper has no article filter set - will render empty slides.');
              }
            }

            // Placeholder check
            const raw = JSON.stringify(attrs);
            const placeholders = raw.match(/\{\{[^}]+\}\}/g);
            if (placeholders) {
              errors.push('[' + sid + '] Unresolved placeholders in ' + (block.title || particle) + ': ' + [...new Set(placeholders)].join(', '));
            }
          }
        }
      }

      return {
        valid:    errors.length === 0,
        errors,
        warnings,
        summary: errors.length === 0
          ? 'No contract violations found.' + (warnings.length ? ' ' + warnings.length + ' warning(s) to review.' : '')
          : errors.length + ' error(s) must be fixed before applying.',
      };
    },
  },

  {
    name: 'gantry_explain_existing_section',
    description:
      'Explain a live section in plain English: why each particle was chosen, where its ' +
      'content comes from, what the CSS block classes do, what link behavior applies, and ' +
      'what guardrails protect it. Use this before editing a section you did not build. ' +
      'Combines live layout data with design pattern knowledge.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        section: {
          type: 'string',
          description: 'Section id to explain (e.g. "slideshow", "utility", "sidebar", "footer").',
        },
      },
      required: ['site', 'section'],
    },
    handler: async (args) => {
      const fs   = require('fs');
      const path = require('path');
      const yaml = require('js-yaml');

      const ctx       = await getCtx(args);
      const outline   = await resolveOutlineArg(ctx, args);
      const structure = await layoutApi.getLayoutStructure(ctx, outline);

      const particles = layoutApi.findParticles(structure, { section: args.section });
      if (particles.length === 0) {
        return { section: args.section, note: 'No particles found in section "' + args.section + '".' };
      }

      const patternsDir = path.join(__dirname, 'design-patterns');
      const patternFiles = fs.existsSync(patternsDir)
        ? fs.readdirSync(patternsDir).filter(f => f.endsWith('.yaml'))
        : [];
      const patterns = patternFiles.map(f => {
        try { return yaml.load(fs.readFileSync(path.join(patternsDir, f), 'utf8')); }
        catch (e) { return null; }
      }).filter(Boolean);

      const explanations = particles.map(({ particle, block, attributes }) => {
        const subtype    = particle.subtype || particle.type;
        const blockClass = (block && block.attributes && block.attributes.class) || '';

        const match = patterns.find(p => {
          const lc = p.layout_contract || {};
          const pc = p.particle_choice || {};
          const particleUse = pc.use || Object.keys(pc).map(k => pc[k] && pc[k].use).find(Boolean);
          const classMatch  = lc.blockClass && blockClass.includes(lc.blockClass.split(' ')[0]);
          return particleUse === subtype && (classMatch || !lc.blockClass);
        });

        const contentSource = (() => {
          const filter = ((attributes && attributes.article) || {}).filter || {};
          if (filter.articles && filter.articles.length) return 'Article ID(s): ' + (Array.isArray(filter.articles) ? filter.articles.join(', ') : filter.articles);
          if (filter.categories && filter.categories.length) return 'Category ID(s): ' + (Array.isArray(filter.categories) ? filter.categories.join(', ') : filter.categories);
          const sub = ((attributes && attributes.subcontents) || []).length;
          if (sub > 0) return sub + ' static hardcoded items';
          return '(static particle or no filter)';
        })();

        const entry = {
          particle_id:    particle.id,
          title:          particle.title || '',
          subtype,
          blockClass,
          section:        args.section,
          content_source: contentSource,
        };

        if (match) {
          entry.pattern             = match.name;
          entry.intent              = (match.intent || '').replace(/\s+/g, ' ').trim();
          entry.why_this_particle   = (match.particle_choice && (match.particle_choice.why ||
            Object.values(match.particle_choice).map(v => v && v.why).find(Boolean))) || '';
          entry.css_behavior        = ((match.css_contract && match.css_contract.behavior) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          entry.link_behavior       = ((match.link_behavior && match.link_behavior.note) || '').replace(/\s+/g, ' ').trim();
          entry.guardrails          = match.guardrails || [];
        } else {
          entry.pattern = null;
          entry.note    = 'No matching design pattern found - manual inspection recommended.';
        }

        return entry;
      });

      return {
        outline,
        section: args.section,
        particle_count: explanations.length,
        explanations,
      };
    },
  },

  {
    name: 'gantry_section_apply',
    description:
      'Apply a section design YAML to a SINGLE section in a live outline, leaving all ' +
      'other sections completely untouched. The surgical alternative to gantry_layout_design. ' +
      'Modes: ' +
      '"replace" (default) clears the section then adds the new particles; ' +
      '"merge" appends new particles alongside existing ones; ' +
      '"clear" removes all particles from the section without adding new ones. ' +
      'section_yaml accepts the same format as a single section in gantry_layout_design: ' +
      'id, attributes.class, grids array with blocks, or a template: reference. ' +
      'Context variables ({{article_id}}) are substituted from the context argument. ' +
      'Always use dryRun:true first to confirm the compiled particles before applying.',
    schema: {
      type: 'object',
      properties: {
        ...SITE_THEME_FIELDS,
        ...OUTLINE_FIELD,
        section: {
          type: 'string',
          description:
            'Target section id in the live outline (e.g. "slideshow", "utility", "sidebar"). ' +
            'Required if section_yaml does not include an id field.',
        },
        section_yaml: {
          type: 'string',
          description:
            'YAML describing the section to apply. Same format as a single section block ' +
            'in gantry_layout_design. Include id, optional attributes.class, and grids. ' +
            'Example: "id: slideshow\nattributes:\n  class: floatator\ngrids:\n  - blocks: [...]"',
        },
        mode: {
          type: 'string',
          enum: ['replace', 'merge', 'clear'],
          description:
            '"replace" (default): remove existing particles then add new ones. ' +
            '"merge": keep existing particles and append new ones. ' +
            '"clear": remove all particles from the section (section_yaml not required).',
        },
        update_section_class: {
          type: 'boolean',
          description:
            'When true (default), also update the section CSS class from attributes.class in the YAML. ' +
            'Set false to leave the section class attribute unchanged.',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description: 'Runtime context variables to substitute into the section YAML (e.g. { "mass_times_article_id": "55" }).',
        },
        dryRun: {
          type: 'boolean',
          description: 'Compile and validate but do not save. Returns diff and particle summary.',
        },
      },
      required: ['site'],
    },
    handler: async (args) => {
      const yaml = require('js-yaml');

      const mode = args.mode || 'replace';
      const targetSectionId = args.section;

      // Parse section YAML (not needed for clear mode if section arg provided)
      let sectionDef = null;
      if (args.section_yaml) {
        try { sectionDef = yaml.load(args.section_yaml); }
        catch (e) { return { valid: false, error: 'section_yaml parse error: ' + e.message }; }
      }

      // Resolve section id
      const resolvedSectionId = targetSectionId || (sectionDef && sectionDef.id);
      if (!resolvedSectionId) {
        throw new Error('Pass `section` argument or include `id` in section_yaml');
      }

      if (mode !== 'clear' && !sectionDef) {
        throw new Error('section_yaml is required for mode "' + mode + '"');
      }

      // Merge context: YAML context < runtime args context
      const context = Object.assign({}, (sectionDef && sectionDef.context) || {}, args.context || {});

      const ctx     = await getCtx(args);
      const outline = await resolveOutlineArg(ctx, args);

      // Fetch live layout so we can seed the ID generator
      const liveStructure = await layoutApi.getLayoutStructure(ctx, outline);

      // Seed compiler IDs from existing layout to prevent collisions
      compiler.resetIds();
      compiler.seedIds(compiler.collectNodeIds(liveStructure));

      // Compile the new section content
      let newGrids = [];
      if (sectionDef && mode !== 'clear') {
        // Ensure the sectionDef has the right id
        const defWithId = Object.assign({}, sectionDef, { id: resolvedSectionId });
        const compiled = compiler.compileSection(defWithId, context);
        newGrids = compiled.children || [];

        if (newGrids.length === 0) {
          return {
            valid: false,
            error: 'Compiled section has no grids. Check that section_yaml has a non-empty grids array.',
          };
        }
      }

      // Apply the mutation
      const r = await layoutApi.mutateLayout(
        ctx,
        outline,
        (structure) => {
          const found = layoutApi.findNode(structure, resolvedSectionId);
          if (!found) throw new Error('Section "' + resolvedSectionId + '" not found in outline "' + outline + '"');

          const section = found.node;
          if (!['section', 'offcanvas'].includes(section.type)) {
            throw new Error('"' + resolvedSectionId + '" is type "' + section.type + '"; expected section or offcanvas');
          }

          // Replace: strip non-inherited grid children
          if (mode === 'replace' || mode === 'clear') {
            section.children = (section.children || []).filter(child =>
              child.inherit && Object.keys(child.inherit).length > 0
            );
          }

          // Append new grids (not for clear)
          if (mode !== 'clear') {
            section.children = (section.children || []).concat(newGrids);
          }

          // Update section CSS class from YAML if requested
          if (args.update_section_class !== false && sectionDef &&
              sectionDef.attributes && sectionDef.attributes.class !== undefined) {
            if (!section.attributes) section.attributes = {};
            section.attributes.class = sectionDef.attributes.class;
          }
        },
        { op: 'section-apply', dryRun: !!args.dryRun }
      );

      // Build a human-readable summary of what was applied
      const summary = newGrids.map((grid, gi) => {
        const blocks = grid.children || [];
        const parts = blocks.map(b => {
          const p = b.children && b.children[0];
          const bc = (b.attributes && b.attributes.class) || '';
          if (!p) return 'block';
          return (p.subtype || p.type) + (bc ? '.' + bc.split(' ')[0] : '');
        });
        return 'grid[' + gi + ']: ' + parts.join(' | ');
      });

      return {
        section:          resolvedSectionId,
        outline,
        mode,
        grids_applied:    newGrids.length,
        particles_applied: newGrids.reduce((n, g) => n + (g.children || []).length, 0),
        summary,
        dryRun:     !!r.dryRun,
        diff:       r.diff   || null,
        backupPath: r.backupPath || null,
      };
    },
  },


];
