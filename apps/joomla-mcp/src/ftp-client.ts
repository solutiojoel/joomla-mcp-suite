import { Client, FileType } from "basic-ftp";
import { Readable, Writable } from "stream";
import fs from "fs";
import path from "path";
import { JoomlaResponse } from "./joomla-client.js";

const MAX_TEXT_FILE_BYTES = 200 * 1024;

interface FtpSiteConfig {
  host: string;
  web_root: string;
  upload_path: string | null;
  port?: number;
  secure?: "implicit" | "explicit";
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
    const configPath = path.join(process.cwd(), "ftp-sites.json");
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

    const user = mode === "read" ? this.readonlyUser : this.writeUser;
    const password = mode === "read" ? this.readonlyPass : this.writePass;
    const varPrefix = mode === "read" ? "FTP_READONLY" : "FTP_WRITE";

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

  async uploadFile(remotePath: string, content: string, domain: string): Promise<JoomlaResponse> {
    const conn = await this.connect(domain, "write");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client, config } = conn;
    const warnings: string[] = [];

    if (config.upload_path) {
      if (!remotePath.startsWith(config.upload_path)) {
        client.close();
        return {
          success: false,
          message: `Upload refused: "${remotePath}" is outside the allowed upload directory "${config.upload_path}". Update upload_path in ftp-sites.json to change this restriction.`,
        };
      }
    } else {
      warnings.push(`No upload_path configured for ${domain} — write access is unrestricted. Consider adding upload_path to ftp-sites.json.`);
    }

    try {
      const buffer = Buffer.from(content, "utf8");
      const readable = Readable.from(buffer);
      await client.uploadFrom(readable, remotePath);

      return {
        success: true,
        message: `Uploaded ${buffer.length} bytes to ${remotePath} on ${domain}`,
        data: { path: remotePath, bytes: buffer.length, warnings },
      };
    } catch (err) {
      return { success: false, message: `FTP upload failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      client.close();
    }
  }

  async makeDirectory(remotePath: string, domain: string): Promise<JoomlaResponse> {
    const conn = await this.connect(domain, "write");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client, config } = conn;

    if (config.upload_path && !remotePath.startsWith(config.upload_path)) {
      client.close();
      return {
        success: false,
        message: `mkdir refused: "${remotePath}" is outside the allowed upload directory "${config.upload_path}".`,
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

    if (config.upload_path && !remotePath.startsWith(config.upload_path)) {
      client.close();
      return {
        success: false,
        message: `Delete refused: "${remotePath}" is outside the allowed upload directory "${config.upload_path}".`,
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
      return { success: false, message: `Local file not found: ${localPath}` };
    }

    const conn = await this.connect(domain, "write");
    if ("error" in conn) return { success: false, message: conn.error };

    const { client, config } = conn;
    const warnings: string[] = [];

    if (config.upload_path) {
      if (!remotePath.startsWith(config.upload_path)) {
        client.close();
        return {
          success: false,
          message: `Upload refused: "${remotePath}" is outside the allowed upload directory "${config.upload_path}". Update upload_path in ftp-sites.json to change this restriction.`,
        };
      }
    } else {
      warnings.push(`No upload_path configured for ${domain} — write access is unrestricted. Consider adding upload_path to ftp-sites.json.`);
    }

    try {
      const stats = fs.statSync(localPath);
      await client.uploadFrom(localPath, remotePath);
      return {
        success: true,
        message: `Uploaded ${stats.size} bytes from ${localPath} to ${remotePath} on ${domain}`,
        data: { local_path: localPath, remote_path: remotePath, bytes: stats.size, warnings },
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
        pub_path: config.web_root + "/images/pub",
        pub_url: `https://${domain}/images/pub`,
      },
    };
  }
}
