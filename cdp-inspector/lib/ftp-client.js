/**
 * ftp-client.js — Upload CSS to an FTP/FTPS server via basic-ftp
 *
 * Config is read from environment variables (set in .env):
 *   FTP_HOST, FTP_USER, FTP_PASSWORD, FTP_SECURE
 */

import { Client } from 'basic-ftp';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';

function requireConfig() {
  const { FTP_HOST, FTP_USER, FTP_PASSWORD, FTP_SECURE } = process.env;
  if (!FTP_HOST || !FTP_USER || !FTP_PASSWORD) {
    throw new Error(
      'FTP credentials missing. Set FTP_HOST, FTP_USER, and FTP_PASSWORD in .env'
    );
  }
  return {
    host: FTP_HOST,
    user: FTP_USER,
    password: FTP_PASSWORD,
    secure: FTP_SECURE === 'true',
  };
}

export const ftpClient = {
  /**
   * Upload CSS content to a remote path on the FTP server.
   *
   * @param {string} cssContent   CSS to upload
   * @param {string} remotePath   Remote file path (e.g. /templates/g5_hydrogen/custom/css/custom.css)
   * @param {'replace'|'append'}  mode  Replace the file or append to existing content
   */
  async upload(cssContent, remotePath, mode = 'replace') {
    const config = requireConfig();
    // Fall back to env default if caller didn't provide a path
    const target = remotePath || process.env.FTP_DEFAULT_CSS_PATH;
    if (!target) {
      throw new Error('remotePath is required (or set FTP_DEFAULT_CSS_PATH in .env)');
    }

    const client = new Client();
    // client.ftp.verbose = true; // uncomment to debug FTP commands

    try {
      await client.access(config);

      let finalContent = cssContent;

      if (mode === 'append') {
        // Download existing file so we can append
        const dlTmp = join(tmpdir(), `cdp-inspector-dl-${randomBytes(4).toString('hex')}.css`);
        try {
          await client.downloadTo(dlTmp, target);
          const existing = readFileSync(dlTmp, 'utf8');
          const timestamp = new Date().toISOString();
          finalContent =
            existing.trimEnd() +
            `\n\n/* ── Claude CDP Inspector — ${timestamp} ── */\n` +
            cssContent;
        } catch {
          // File doesn't exist yet — first upload, treat as replace
        }
      }

      // Write to a temp file then stream it up
      const ulTmp = join(tmpdir(), `cdp-inspector-ul-${randomBytes(4).toString('hex')}.css`);
      writeFileSync(ulTmp, finalContent, 'utf8');
      await client.uploadFrom(ulTmp, target);

      return `✅ Uploaded ${finalContent.length} bytes → ${target} (mode: ${mode})`;
    } finally {
      client.close();
    }
  },

  /** Quick connectivity test — lists the root directory. */
  async testConnection() {
    const config = requireConfig();
    const client = new Client();
    try {
      await client.access(config);
      const list = await client.list('/');
      return {
        ok: true,
        host: config.host,
        rootEntries: list.slice(0, 10).map(e => e.name),
      };
    } finally {
      client.close();
    }
  },
};
