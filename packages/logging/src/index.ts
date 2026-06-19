/**
 * Shared logging for the Joomla MCP suite.
 *
 * Two facilities:
 *   - createLogger(name): a small leveled logger that writes to STDERR. Stderr
 *     (never stdout) matters: stdio-transport MCP servers frame JSON-RPC on
 *     stdout, so any stray stdout write corrupts the protocol.
 *   - createRunLog(dir, runId): an append-only JSONL sink, lifted from the
 *     agents-mcp sub-agent runner — the structured per-run log this package was
 *     designed around.
 *
 * Dependency-free, so it ships as a dual ESM/CJS build consumable by both the
 * CommonJS orchestrator and the ESM/TS servers.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Minimum level to emit. Defaults to "debug" (everything). */
  level?: LogLevel;
  /** Prefix each line with an ISO-8601 timestamp. Defaults to false. */
  timestamps?: boolean;
}

/**
 * A logger is callable — `log("msg")` logs at info — so it drops directly into
 * APIs that expect a `(msg: string) => void` sink (e.g. mcp-transport's logger).
 * It also exposes per-level methods.
 */
export interface Logger {
  (msg: string): void;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(name: string, options: LoggerOptions = {}): Logger {
  const threshold = LEVEL_ORDER[options.level ?? "debug"];
  const withTime = options.timestamps ?? false;

  const emit = (level: LogLevel, msg: string) => {
    if (LEVEL_ORDER[level] < threshold) return;
    const ts = withTime ? `${new Date().toISOString()} ` : "";
    // info stays as the bare "[name] msg" the suite already used; other levels
    // carry an uppercase tag so warnings/errors stand out in the stream.
    const tag = level === "info" ? "" : `${level.toUpperCase()}: `;
    process.stderr.write(`${ts}[${name}] ${tag}${msg}\n`);
  };

  const logger = ((msg: string) => emit("info", msg)) as Logger;
  logger.debug = (msg: string) => emit("debug", msg);
  logger.info = (msg: string) => emit("info", msg);
  logger.warn = (msg: string) => emit("warn", msg);
  logger.error = (msg: string) => emit("error", msg);
  return logger;
}

export interface RunLog {
  /** Append one JSON object as a line. A `timestamp` is added automatically. */
  append(entry: Record<string, unknown>): Promise<void>;
  /** Absolute path of the JSONL file. */
  readonly file: string;
}

/**
 * Create an append-only JSONL run log at `<dir>/<runId>.jsonl`. The directory is
 * created on first append.
 */
export function createRunLog(dir: string, runId: string): RunLog {
  const file = join(dir, `${runId}.jsonl`);
  let dirReady: Promise<unknown> | null = null;
  return {
    file,
    async append(entry: Record<string, unknown>): Promise<void> {
      if (!dirReady) dirReady = mkdir(dir, { recursive: true });
      await dirReady;
      await appendFile(file, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
    },
  };
}
