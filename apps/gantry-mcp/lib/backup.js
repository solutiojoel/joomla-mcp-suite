'use strict';

/**
 * Layout backups — automatic snapshots before any mutating layout op.
 *
 * Configurable directory: GANTRY_BACKUP_DIR env var, otherwise ./backups
 */

const fs = require('fs');
const path = require('path');

function backupRoot() {
  const raw = process.env.GANTRY_BACKUP_DIR || 'backups';
  // Resolve relative paths from the project root so this works regardless of
  // process.cwd() (e.g. when spawned as stdio by Cowork, CWD = system32).
  return path.isAbsolute(raw) ? raw : path.resolve(__dirname, '..', raw);
}

function safeHost(ctx) {
  try {
    return new URL(ctx.base).host.replace(/[^a-zA-Z0-9._-]/g, '_');
  } catch {
    return 'site';
  }
}

function backupDir(ctx, outline) {
  const dir = path.join(backupRoot(), safeHost(ctx), String(outline || 'default'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

function takeBackup(ctx, outline, op, structure) {
  const dir = backupDir(ctx, outline);
  const file = path.join(dir, `${timestamp()}-${op}.json`);
  fs.writeFileSync(file, JSON.stringify(structure, null, 2));
  return file;
}

function listBackups(ctx, outline) {
  const dir = backupDir(ctx, outline);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .map((f) => ({
      name: f,
      path: path.join(dir, f),
      size: fs.statSync(path.join(dir, f)).size,
      mtime: fs.statSync(path.join(dir, f)).mtime,
    }));
}

function resolveBackup(ctx, outline, ref) {
  if (!ref) throw new Error('No backup ref given (path | name | "latest")');
  if (ref === 'latest' || ref === 'last') {
    const list = listBackups(ctx, outline);
    if (!list.length) throw new Error('No backups found for outline ' + outline);
    return list[0].path;
  }
  if (path.isAbsolute(ref) && fs.existsSync(ref)) return ref;
  const candidate = path.join(backupDir(ctx, outline), ref);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error('Backup not found: ' + ref);
}

function readBackup(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  backupRoot,
  backupDir,
  takeBackup,
  listBackups,
  resolveBackup,
  readBackup,
};
