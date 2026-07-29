import "./env.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runServer } from "@solutio/mcp-transport";
import { createLogger } from "@solutio/logging";
import { FtpClient, JoomlaResponse } from "./ftp-client.js";

function formatResult(response: JoomlaResponse): string {
  const result: Record<string, unknown> = {
    success: response.success,
    message: response.message,
  };
  if (response.data !== undefined) {
    result.data = response.data;
    result.dataType = Array.isArray(response.data) ? "array" : typeof response.data;
    if (Array.isArray(response.data)) {
      result.itemCount = response.data.length;
    }
  }
  return JSON.stringify(result, null, 2);
}

const tools = [
  {
    name: "ftp_list_files",
    description: "List files on the FTP server at a path. Start at '/' to explore.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute remote path (e.g. '/' or '/wichita/cathedral')" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["path"],
    },
  },
  {
    name: "ftp_read_file",
    description: "Read a text file via FTP (max 200 KB). Use grep, head, or offset/limit to avoid bloating context.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute remote file path" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
        grep: { type: "string", description: "Regex to search for. Returns matching lines + context instead of full file." },
        context_lines: { type: "number", description: "Lines of context around each grep match (default: 2)" },
        head: { type: "number", description: "Return first N lines only" },
        offset: { type: "number", description: "Zero-based start line for pagination" },
        limit: { type: "number", description: "Lines to return from offset" },
      },
      required: ["path"],
    },
  },
  {
    name: "ftp_upload_file",
    description:
      "Upload text content to a file on the FTP server. Target path must be within upload_path if configured. " +
      "Returns the sha256 of the bytes written: when you assembled `content` from anything other than a direct copy, " +
      "compare that hash against the local file (sha256sum / Get-FileHash) to confirm the WHOLE file round-tripped. " +
      "Spot-checking a few lines of a whole-file write does not verify it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute remote destination path" },
        content: { type: "string", description: "Text content to write" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "ftp_delete_file",
    description: "Delete a file via FTP. Target path must be within upload_path if configured.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute remote file path to delete" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["path"],
    },
  },
  {
    name: "ftp_upload_local_file",
    description:
      "Upload a file from the FTP SERVER's OWN filesystem to the FTP server. Supports any file type including images and PDFs. " +
      "Only usable when this server runs on the same machine as the caller — on a remote deployment the caller's paths do not exist here. " +
      "For text use ftp_upload_file with inline content; for binaries use the Gateway Files bridge.",
    inputSchema: {
      type: "object",
      properties: {
        local_path: { type: "string", description: "Absolute path on the ftp-mcp server's filesystem (NOT the caller's machine, unless they are the same host)" },
        path: { type: "string", description: "Absolute remote destination path" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["local_path", "path"],
    },
  },
  {
    name: "ftp_mkdir",
    description: "Create a directory on the FTP server (including intermediate directories).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Remote directory path to create" },
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: ["path"],
    },
  },
  {
    name: "ftp_site_config",
    description: "Show FTP config for a site: host, web_root, upload_path, pub_path, pub_url. Call before other FTP tools to verify the site is configured.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Site domain. Defaults to active site's domain." },
      },
      required: [],
    },
  },
];

export function buildServer(): Server {
  const ftpClient = new FtpClient();

  const server = new Server(
    { name: "ftp-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // ftp_upload_local_file reads from THIS process's filesystem, so it only works
  // when ftp-mcp is co-located with the caller. Remote deployments should set
  // FTP_LOCAL_UPLOAD=0 to stop advertising a tool that can never succeed there —
  // an advertised-but-uncallable tool costs a round trip and misdirects the
  // caller into hand-reconstructing file contents. Opt-out rather than opt-in so
  // existing local/self-hosted setups keep working untouched.
  const localUploadEnabled = !/^(0|false|no)$/i.test(process.env.FTP_LOCAL_UPLOAD ?? "");
  const visibleTools = localUploadEnabled
    ? tools
    : tools.filter(t => t.name !== "ftp_upload_local_file");

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
    const { name, arguments: args } = request.params;

    // Domain resolution: explicit domain arg wins; otherwise derive from the
    // site_url the orchestrator injects on every call.
    const siteUrl = args?.site_url as string | undefined;
    const domain = (args?.domain as string) || (siteUrl ? FtpClient.domainFromUrl(siteUrl) : "");
    if (!domain) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, message: "No site domain available. Pass a domain argument or set an active site first." }) }],
        isError: true,
      };
    }

    try {
      switch (name) {
        case "ftp_list_files": {
          const ftpPath = (args?.path as string) || "/";
          const result = await ftpClient.listFiles(ftpPath, domain);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "ftp_read_file": {
          const ftpPath = args?.path as string;
          const result = await ftpClient.readTextFile(ftpPath, domain, {
            grep: args?.grep as string | undefined,
            contextLines: args?.context_lines as number | undefined,
            head: args?.head as number | undefined,
            offset: args?.offset as number | undefined,
            limit: args?.limit as number | undefined,
          });
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "ftp_upload_file": {
          const ftpPath = args?.path as string;
          const content = (args?.content as string) || "";
          const result = await ftpClient.uploadFile(ftpPath, content, domain);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "ftp_delete_file": {
          const ftpPath = args?.path as string;
          const result = await ftpClient.deleteFile(ftpPath, domain);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "ftp_upload_local_file": {
          if (!localUploadEnabled) {
            return {
              content: [{ type: "text", text: formatResult({
                success: false,
                message:
                  "ftp_upload_local_file is disabled on this deployment (FTP_LOCAL_UPLOAD=0) because this server does not " +
                  "share a filesystem with the caller. Use ftp_upload_file with inline content for text, or the Gateway " +
                  "Files bridge for binaries.",
              }) }],
              isError: true,
            };
          }
          const localPath = args?.local_path as string;
          const ftpPath = args?.path as string;
          const result = await ftpClient.uploadLocalFile(localPath, ftpPath, domain);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "ftp_mkdir": {
          const ftpPath = args?.path as string;
          const result = await ftpClient.makeDirectory(ftpPath, domain);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        case "ftp_site_config": {
          const result = ftpClient.getSiteInfo(domain);
          return { content: [{ type: "text", text: formatResult(result) }], isError: !result.success };
        }

        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, message: error instanceof Error ? error.message : String(error) }) }],
        isError: true,
      };
    }
  });

  return server;
}

// Only auto-start a transport when executed directly (node dist/index.js).
// The orchestrator requires this module for in-process hosting and calls
// buildServer() itself.
if (require.main === module) runServer({
  buildServer,
  serverInfo: { name: "ftp-mcp", version: "1.0.0" },
  logger: createLogger("ftp-mcp"),
}).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
