import { Client, FileType } from "basic-ftp";
import { Readable, Writable } from "stream";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// Same shape joomla-mcp's JoomlaResponse had — kept structurally identical so
// the orchestrator and existing callers see no difference after the split.
export interface JoomlaResponse {
  success: boolean;
  message: string;
  data?: unknown;
}

const MAX_TEXT_FILE_BYTES = 200 * 1024;

interface FtpSiteConfig {
  host: string;
  web_root: string;
  upload_path: string | null;
  /**
   * Extra directories this site accepts writes into, beyond `upload_path`.
   *
   * `upload_path` is the images/pub asset bucket, meant for CSS/JS/Gantry Raw
   * Tags assets. A site whose DOCman files live elsewhere (e.g.
   * "/lincoln/stm-lincoln/content/documents") could not take a new document at
   * all — every write outside images/pub was refused and the ticket had to be
   * finished by hand. List those roots here to open them deliberately.
   */
  write_paths?: string[];
  port?: number;
  secure?: "implicit" | "explicit";
  credential_set?: string;
}

export class FtpClient {
  private readonlyUser: string;
  private readonlyPass: string;
  private writeUser: string;
  private writePass: string;

  constructor() {
    this.readonlyUser = process.env.FTP_READONLY_USER || "";
    this.readonlyPass = process.env.FTP_READONLY_PASS || "";
    this.writeUser = process.env.FTP_WRITE_USER || "";
    this.writePass = process.env.FTP_WRITE_PASS || "";
  }

  static domainFromUrl(url: string): string {
    try {
      const normalized = url.includes("://") ? url : `https://${url}`;
      return new URL(normalized).hostname;
    } catch {
      return url;
    }
  }

  private loadSites(): Record<string, FtpSiteConfig> {
    // Default to the app's own ftp-sites.json (compiled file lives in dist/,
    // so one level up is the app root). cwd is unreliable: in single-process
    // mode the orchestrator runs from the repo root.
    const configPath = process.env.FTP_SITES_PATH || path.join(__dirname, "..", "ftp-sites.json");
    if (!fs.existsSync(configPath)) return {};
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, FtpSiteConfig>;
    } catch {
      return {};
    }
  }

  private async connect(
    domain: string,
    mode: "read" | "write"
  ): Promise<{ client: Client; config: FtpSiteConfig } | { error: string }> {
    const sites = this.loadSites();
    const config = sites[domain];
    if (!config) {
      const available = Object.keys(sites);
      return {
        error: `No FTP configuration found for "${domain}". Add it to ftp-sites.json.${available.length ? ` Available domains: ${available.join(", ")}` : ""}`,
      };
    }

    let user: string;
    let password: string;
    let varPrefix: string;

    if (config.credential_set) {
      const prefix = `FTP_${config.credential_set.toUpperCase()}`;
      varPrefix = mode === "read" ? `${prefix}_READONLY` : `${prefix}_WRITE`;
      user = process.env[`${varPrefix}_USER`] || process.env[`${prefix}_USER`] || "";
      password = process.env[`${varPrefix}_PASS`] || process.env[`${prefix}_PASS`] || "";
    } else {
      varPrefix = mode === "read" ? "FTP_READONLY" : "FTP_WRITE";
      user = mode === "read" ? this.readonlyUser : this.writeUser;
      password = mode === "read" ? this.readonlyPass : this.writePass;
    }

    if (!user || !password) {
      return { error: `FTP credentials not configured. Set ${varPrefix}_USER and ${varPrefix}_PASS in .env.` };
    }

    const client = new Client();
    client.ftp.verbose = false;

    const port = config.port ?? 21;
    const secure: true | "implicit" = config.secure === "implicit" ? "implicit" : true;

    try {
      await client.access({
        host: config.host,
        port,
        user,
        password,
        secure,
        secureOptions: { rejectUnauthorized: false },
      });
      return { client, config };
    } catch (err) {
      client.close();
      return { error: `FTP connection to ${config.host} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async listFiles(remotePath: string, domain: string): Promise<JoomlaResponse> {
    const conn = await this.connect(domain, "read");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client } = conn;
    try {
      const items = await client.list(remotePath);
      const data = items.map((item) => ({
        name: item.name,
        type: item.type === FileType.Directory ? "directory" : item.type === FileType.SymbolicLink ? "symlink" : "file",
        size: item.size,
        modified: item.modifiedAt ? item.modifiedAt.toISOString() : (item.rawModifiedAt ?? null),
      }));
      return {
        success: true,
        message: `Listed ${data.length} item(s) at ${remotePath} on ${domain}`,
        data,
      };
    } catch (err) {
      return { success: false, message: `FTP list failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      client.close();
    }
  }

  async readTextFile(
    remotePath: string,
    domain: string,
    options?: { grep?: string; contextLines?: number; head?: number; offset?: number; limit?: number }
  ): Promise<JoomlaResponse> {
    const conn = await this.connect(domain, "read");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client } = conn;
    try {
      const lastSlash = remotePath.lastIndexOf("/");
      const dir = lastSlash > 0 ? remotePath.substring(0, lastSlash) : "/";
      const filename = remotePath.substring(lastSlash + 1);

      const items = await client.list(dir);
      const fileInfo = items.find((f) => f.name === filename);

      if (!fileInfo) {
        return { success: false, message: `File not found: ${remotePath}` };
      }
      if (fileInfo.type === FileType.Directory) {
        return { success: false, message: `${remotePath} is a directory. Use ftp_list_files instead.` };
      }
      if (fileInfo.size > MAX_TEXT_FILE_BYTES) {
        return {
          success: false,
          message: `File is too large to read as text (${fileInfo.size} bytes; limit is ${MAX_TEXT_FILE_BYTES} bytes). Download it manually via Cyberduck.`,
        };
      }

      const chunks: Buffer[] = [];
      const writable = new Writable({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          chunks.push(chunk);
          cb();
        },
      });

      await client.downloadTo(writable, remotePath);
      const fullContent = Buffer.concat(chunks).toString("utf8");
      const lines = fullContent.split("\n");
      const totalLines = lines.length;

      if (options?.grep) {
        let pattern: RegExp;
        try {
          pattern = new RegExp(options.grep, "i");
        } catch {
          return { success: false, message: `Invalid grep pattern: ${options.grep}` };
        }
        const ctx = options.contextLines ?? 2;
        const matchedIndices = new Set<number>();
        lines.forEach((line, i) => {
          if (pattern.test(line)) {
            for (let j = Math.max(0, i - ctx); j <= Math.min(totalLines - 1, i + ctx); j++) {
              matchedIndices.add(j);
            }
          }
        });
        const sorted = Array.from(matchedIndices).sort((a, b) => a - b);
        const content = sorted.map((i) => `${i + 1}: ${lines[i]}`).join("\n");
        return {
          success: true,
          message: `${sorted.length} lines matching /${options.grep}/ in ${remotePath} (${totalLines} total lines)`,
          data: { content, matched_lines: sorted.length, total_lines: totalLines, path: remotePath },
        };
      }

      if (options?.head !== undefined || options?.offset !== undefined || options?.limit !== undefined) {
        const start = options.offset ?? 0;
        const end = options.head !== undefined ? options.head : options.limit !== undefined ? start + options.limit : totalLines;
        const slice = lines.slice(start, end);
        const content = slice.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
        return {
          success: true,
          message: `Lines ${start + 1}–${start + slice.length} of ${remotePath} (${totalLines} total lines)`,
          data: { content, lines_returned: slice.length, total_lines: totalLines, path: remotePath },
        };
      }

      return {
        success: true,
        message: `Read ${fullContent.length} characters from ${remotePath} (${totalLines} lines)`,
        data: { content: fullContent, bytes: fileInfo.size, total_lines: totalLines, path: remotePath },
      };
    } catch (err) {
      return { success: false, message: `FTP read failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      client.close();
    }
  }

  /**
   * The read-side alias of the write directory. Both paths address the same
   * files on the server; `upload_path` accepts writes, `pub_path` serves reads
   * and maps to https://<domain>/images/pub.
   */
  private pubPathFor(config: FtpSiteConfig): string {
    return config.web_root + "/images/pub";
  }

  /**
   * Containment check for the write guard. A bare `startsWith` is not a
   * containment test: it lets "<upload_path>-other" through, and it lets
   * "<upload_path>/../.." escape entirely. Normalise away "." / ".." and
   * require the boundary to land on a path separator.
   */
  private isWithin(base: string, target: string): boolean {
    const norm = (p: string): string => {
      const out: string[] = [];
      for (const seg of p.split("/")) {
        if (!seg || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
      }
      return "/" + out.join("/");
    };
    const b = norm(base);
    const t = norm(target);
    return t === b || t.startsWith(b === "/" ? "/" : b + "/");
  }

  /** Every directory this site accepts writes into. */
  private writeRoots(config: FtpSiteConfig): string[] {
    const roots: string[] = [];
    if (config.upload_path) roots.push(config.upload_path);
    for (const p of config.write_paths || []) if (p) roots.push(p);
    return roots;
  }

  /** True when `remotePath` sits inside any configured write root. */
  private isAllowedWrite(config: FtpSiteConfig, remotePath: string): boolean {
    return this.writeRoots(config).some((root) => this.isWithin(root, remotePath));
  }

  /**
   * Explain a refused write. Callers reach for `pub_path` because that is what
   * they just read the file from, so name the alias and hand back the rewritten
   * path rather than suggesting the config is wrong — it is not.
   */
  private refusalMessage(verb: string, remotePath: string, config: FtpSiteConfig): string {
    const pubPath = this.pubPathFor(config);
    if (this.isWithin(pubPath, remotePath)) {
      const rewritten = config.upload_path + remotePath.slice(pubPath.length);
      return `${verb} refused: "${remotePath}" is the read-only alias of the upload directory. ` +
        `pub_path ("${pubPath}") and upload_path ("${config.upload_path}") are the same directory on the ` +
        `server — read from pub_path, write to upload_path. Retry with "${rewritten}".`;
    }
    const roots = this.writeRoots(config);
    return `${verb} refused: "${remotePath}" is outside every allowed write directory ` +
      `(${roots.map((r) => `"${r}"`).join(", ")}). The same files read back from "${pubPath}". ` +
      `If this path is a legitimate write target for this site — a DOCman files root, for example — ` +
      `add it to "write_paths" for this domain in ftp-sites.json.`;
  }

  /**
   * Write a buffer to `remotePath`. A fresh Readable per attempt: the fallback
   * would otherwise resume a stream the failed attempt had already drained and
   * write a truncated file.
   */
  private async putBuffer(client: Client, remotePath: string, buffer: Buffer): Promise<void> {
    const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
    const filename = remotePath.substring(remotePath.lastIndexOf("/") + 1);
    if (!remoteDir) {
      await client.uploadFrom(Readable.from(buffer), remotePath);
      return;
    }
    try {
      // Try a single CWD command first — handles symlinked directories that
      // ensureDir's step-by-step navigation cannot traverse.
      await client.cd(remoteDir);
      await client.uploadFrom(Readable.from(buffer), filename);
    } catch {
      // Directory may not exist yet — fall back to ensureDir + absolute upload.
      await client.ensureDir(remoteDir);
      await client.uploadFrom(Readable.from(buffer), remotePath);
    }
  }

  /** Download `remotePath` into memory. Caller owns the connection. */
  private async getBuffer(client: Client, remotePath: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk: Buffer, _enc: string, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });
    await client.downloadTo(writable, remotePath);
    return Buffer.concat(chunks);
  }

  async uploadFile(remotePath: string, content: string, domain: string): Promise<JoomlaResponse> {
    const conn = await this.connect(domain, "write");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client, config } = conn;
    const warnings: string[] = [];

    if (this.writeRoots(config).length) {
      if (!this.isAllowedWrite(config, remotePath)) {
        client.close();
        return {
          success: false,
          message: this.refusalMessage("Upload", remotePath, config),
        };
      }
    } else {
      warnings.push(`No upload_path or write_paths configured for ${domain} — write access is unrestricted. Consider adding upload_path to ftp-sites.json.`);
    }

    try {
      const buffer = Buffer.from(content, "utf8");
      await this.putBuffer(client, remotePath, buffer);

      // sha256 of exactly the bytes written. Callers that built `content` by
      // any lossy route (reconstructing a file from context rather than piping
      // it) can compare this against a local `sha256sum` and know the whole
      // file round-tripped — not just the lines they thought to spot-check.
      const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

      return {
        success: true,
        message: `Uploaded ${buffer.length} bytes to ${remotePath} on ${domain} (sha256 ${sha256.slice(0, 12)}…)`,
        data: {
          path: remotePath,
          bytes: buffer.length,
          sha256,
          verify_hint: "Compare against the local file: sha256sum <file> (or Get-FileHash -Algorithm SHA256 <file>). Equal hashes mean the whole file matches; a byte count alone does not.",
          warnings,
        },
      };
    } catch (err) {
      return { success: false, message: `FTP upload failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      client.close();
    }
  }

  /**
   * Add `content` to the end of an existing file without the caller ever holding
   * the current contents.
   *
   * The alternative — read the file, retype it plus the new section, upload the
   * whole thing — puts every existing byte back through the caller once more. A
   * single character altered in that carried-over region ships silently, because
   * the obvious check (does the new section look right?) never looks at it. Here
   * the existing bytes go server → memory → server untouched, so only the new
   * text can be wrong.
   */
  async appendFile(
    remotePath: string,
    content: string,
    domain: string,
    options?: { separator?: string; createIfMissing?: boolean }
  ): Promise<JoomlaResponse> {
    const conn = await this.connect(domain, "write");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client, config } = conn;
    const warnings: string[] = [];

    if (this.writeRoots(config).length) {
      if (!this.isAllowedWrite(config, remotePath)) {
        client.close();
        return {
          success: false,
          message: this.refusalMessage("Append", remotePath, config),
        };
      }
    } else {
      warnings.push(`No upload_path or write_paths configured for ${domain} — write access is unrestricted. Consider adding upload_path to ftp-sites.json.`);
    }

    try {
      const lastSlash = remotePath.lastIndexOf("/");
      const dir = lastSlash > 0 ? remotePath.substring(0, lastSlash) : "/";
      const filename = remotePath.substring(lastSlash + 1);

      let existing: Buffer = Buffer.alloc(0);
      let created = false;

      let listing: Awaited<ReturnType<Client["list"]>> = [];
      try {
        listing = await client.list(dir);
      } catch {
        listing = [];
      }
      const fileInfo = listing.find((f) => f.name === filename);

      if (!fileInfo) {
        if (options?.createIfMissing === false) {
          return {
            success: false,
            message: `Append refused: ${remotePath} does not exist. Pass create_if_missing (default) to create it, or use ftp_upload_file.`,
          };
        }
        created = true;
      } else {
        if (fileInfo.type === FileType.Directory) {
          return { success: false, message: `${remotePath} is a directory, not a file.` };
        }
        // The whole file is rewritten, so the read cap applies here too.
        if (fileInfo.size > MAX_TEXT_FILE_BYTES) {
          return {
            success: false,
            message: `File is too large to append to (${fileInfo.size} bytes; limit is ${MAX_TEXT_FILE_BYTES} bytes). Edit it manually via Cyberduck.`,
          };
        }
        existing = await this.getBuffer(client, remotePath);
      }

      // Default separator keeps appended sections from fusing onto the last line.
      // Skipped when the file is new or already ends in a newline.
      const separator = options?.separator ?? "\n";
      const needsSeparator = existing.length > 0 && separator.length > 0 && !existing.toString("utf8").endsWith("\n");
      const addition = Buffer.from((needsSeparator ? separator : "") + content, "utf8");
      const combined = Buffer.concat([existing, addition]);

      await this.putBuffer(client, remotePath, combined);

      const shaBefore = crypto.createHash("sha256").update(existing).digest("hex");
      const sha256 = crypto.createHash("sha256").update(combined).digest("hex");

      // Read the file back and prove the pre-existing region is byte-identical.
      // This is the check a full-file retype cannot make about itself.
      let preservedPrefix: boolean | null = null;
      try {
        const readback = await this.getBuffer(client, remotePath);
        preservedPrefix = readback.subarray(0, existing.length).equals(existing);
        if (!readback.equals(combined)) {
          warnings.push("Read-back does not match the bytes sent — the server may have altered line endings. Compare sha256 against a local copy before you rely on this file.");
        }
      } catch {
        warnings.push("Append succeeded but the read-back check could not run. Confirm the file with ftp_read_file.");
      }

      return {
        success: true,
        message: created
          ? `Created ${remotePath} on ${domain} with ${combined.length} bytes (sha256 ${sha256.slice(0, 12)}…)`
          : `Appended ${addition.length} bytes to ${remotePath} on ${domain}: ${existing.length} → ${combined.length} bytes (sha256 ${sha256.slice(0, 12)}…)`,
        data: {
          path: remotePath,
          created,
          bytes_before: existing.length,
          bytes_appended: addition.length,
          bytes: combined.length,
          separator_inserted: needsSeparator,
          sha256,
          sha256_before: shaBefore,
          existing_content_preserved: preservedPrefix,
          warnings,
        },
      };
    } catch (err) {
      return { success: false, message: `FTP append failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      client.close();
    }
  }

  async makeDirectory(remotePath: string, domain: string): Promise<JoomlaResponse> {
    const conn = await this.connect(domain, "write");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client, config } = conn;

    if (this.writeRoots(config).length && !this.isAllowedWrite(config, remotePath)) {
      client.close();
      return {
        success: false,
        message: this.refusalMessage("mkdir", remotePath, config),
      };
    }

    try {
      await client.ensureDir(remotePath);
      return { success: true, message: `Directory created: ${remotePath} on ${domain}` };
    } catch (err) {
      return { success: false, message: `FTP mkdir failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      client.close();
    }
  }

  async deleteFile(remotePath: string, domain: string): Promise<JoomlaResponse> {
    const conn = await this.connect(domain, "write");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client, config } = conn;

    if (this.writeRoots(config).length && !this.isAllowedWrite(config, remotePath)) {
      client.close();
      return {
        success: false,
        message: this.refusalMessage("Delete", remotePath, config),
      };
    }

    try {
      await client.remove(remotePath);
      return { success: true, message: `Deleted ${remotePath} on ${domain}` };
    } catch (err) {
      return { success: false, message: `FTP delete failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      client.close();
    }
  }

  async uploadLocalFile(localPath: string, remotePath: string, domain: string): Promise<JoomlaResponse> {
    if (!fs.existsSync(localPath)) {
      // `localPath` resolves on THIS process's filesystem. When ftp-mcp runs
      // co-located with the caller (local dev, self-hosted) that is the same
      // machine and this tool is the right one. When it runs remotely (the
      // Replit deployment) the caller's paths do not exist here, and a bare
      // "file not found" sends the caller hunting for a typo instead of
      // reaching for the transfer route that actually works.
      return {
        success: false,
        message:
          `Local file not found: ${localPath}\n\n` +
          `Note: local_path is resolved on the ftp-mcp server's filesystem (host ${os.hostname()}), ` +
          `not the caller's. If this server is running remotely, the caller's local paths will never resolve here.\n` +
          `Alternatives:\n` +
          `  • Text/CSS/JS — use ftp_upload_file with the content inline, then verify the returned sha256 against the local file.\n` +
          `  • Binaries (images, PDFs) — upload via the Gateway Files UI and use the resulting public URL.`,
      };
    }

    const conn = await this.connect(domain, "write");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client, config } = conn;
    const warnings: string[] = [];

    if (this.writeRoots(config).length) {
      if (!this.isAllowedWrite(config, remotePath)) {
        client.close();
        return {
          success: false,
          message: this.refusalMessage("Upload", remotePath, config),
        };
      }
    } else {
      warnings.push(`No upload_path or write_paths configured for ${domain} — write access is unrestricted. Consider adding upload_path to ftp-sites.json.`);
    }

    try {
      const stats = fs.statSync(localPath);
      const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/"));
      const filename = remotePath.substring(remotePath.lastIndexOf("/") + 1);
      if (remoteDir) {
        try {
          await client.cd(remoteDir);
          await client.uploadFrom(localPath, filename);
        } catch {
          await client.ensureDir(remoteDir);
          await client.uploadFrom(localPath, remotePath);
        }
      } else {
        await client.uploadFrom(localPath, remotePath);
      }
      const sha256 = crypto.createHash("sha256").update(fs.readFileSync(localPath)).digest("hex");
      return {
        success: true,
        message: `Uploaded ${stats.size} bytes from ${localPath} to ${remotePath} on ${domain} (sha256 ${sha256.slice(0, 12)}…)`,
        data: { local_path: localPath, remote_path: remotePath, bytes: stats.size, sha256, warnings },
      };
    } catch (err) {
      return { success: false, message: `FTP upload failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      client.close();
    }
  }

  getSiteInfo(domain: string): JoomlaResponse {
    const sites = this.loadSites();
    const config = sites[domain];
    if (!config) {
      return {
        success: false,
        message: `No FTP configuration for "${domain}". Add it to ftp-sites.json.`,
        data: { available_domains: Object.keys(sites) },
      };
    }
    return {
      success: true,
      message: `FTP config for ${domain}`,
      data: {
        domain,
        host: config.host,
        web_root: config.web_root,
        upload_path: config.upload_path ?? "(not set — write access is unrestricted)",
        // Every directory writes are accepted into, so a caller can see up
        // front whether a target such as a DOCman files root is reachable
        // instead of discovering the refusal mid-task.
        write_paths: config.write_paths ?? [],
        allowed_write_roots: this.writeRoots(config),
        pub_path: this.pubPathFor(config),
        pub_url: `https://${domain}/images/pub`,
        // Stated explicitly because the two paths look like different
        // directories and are not: writing to pub_path is refused, and the
        // natural conclusion — that the config is wrong — is incorrect.
        note:
          "upload_path and pub_path are the SAME directory behind a server-side FTP alias. " +
          "Write with upload_path, read/list with pub_path, and serve from pub_url. " +
          "Do not change upload_path to match pub_path. " +
          "upload_path is the images/pub asset bucket; a write target outside it (a DOCman files " +
          "root, for example) must be listed in write_paths for this domain in ftp-sites.json.",
      },
    };
  }
}
