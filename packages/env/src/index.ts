/**
 * Layered .env loading for every server in the suite.
 *
 * Before this package each app called `import "dotenv/config"` (which resolves
 * `.env` against process.cwd(), so the file found depended on how the process
 * was launched) or hardcoded its own directory. The result was the same secret
 * copied into several app-level .env files, free to drift apart — and one app
 * (gantry-mcp) reading a credential under a private name that existed only on
 * dev machines, so it worked locally and failed 100% in production.
 *
 * The model here is one shared file plus optional per-app overrides:
 *
 *   real environment (Replit Secrets)  >  <appDir>/.env  >  <repoRoot>/.env
 *
 * dotenv never overwrites an already-set variable, so precedence is just load
 * order: most specific first. Put shared credentials in the root .env (or in
 * Secrets when deployed) and keep app-level .env files for values that genuinely
 * differ per server, like HTTP_PORT.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import dotenv from "dotenv";

export interface LoadEnvOptions {
  /**
   * Where to start resolving from — pass `__dirname` (CJS) or the dir of
   * `import.meta.url` (ESM). Relying on process.cwd() is what made this
   * fragile before, so callers should always pass this.
   *
   * The app root is then the nearest ancestor containing a package.json, which
   * is what makes compiled apps work: `__dirname` is `<app>/dist` at runtime,
   * but the .env sits next to package.json one level up.
   */
  from?: string;
  /** Skip app-root detection and use this directory's .env directly. */
  appDir?: string;
  /** Skip auto-detection and use this as the repo root. */
  rootDir?: string;
  /**
   * Variables the caller needs. Any still unset after loading are returned in
   * `missing` and warned about on stderr — this surfaces a misconfiguration at
   * boot instead of deep inside a tool call.
   */
  required?: readonly string[];
  /** Suppress the stderr summary line. */
  quiet?: boolean;
  /** Label for the stderr summary. Defaults to the appDir basename. */
  label?: string;
}

export interface LoadEnvResult {
  /** Detected repo root, or null if no workspace root was found. */
  rootDir: string | null;
  /** .env files that existed and were loaded, most-specific first. */
  files: string[];
  /** Names from `required` that are still unset. */
  missing: string[];
}

/**
 * Walk up from `startDir` to the first ancestor containing a package.json that
 * satisfies `predicate`. Bounded so a detached path can't spin to the fs root.
 */
function findUp(
  startDir: string,
  predicate: (pkg: unknown) => boolean
): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 20; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        if (predicate(JSON.parse(fs.readFileSync(pkgPath, "utf8")))) return dir;
      } catch {
        // Unreadable/!JSON package.json — keep walking rather than abort.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * The npm-workspaces root — the package.json that declares `workspaces`.
 * Returns null rather than guessing, so a missing root is visible instead of
 * silently resolving somewhere unexpected.
 */
export function findRepoRoot(startDir: string): string | null {
  return findUp(startDir, (pkg) => Boolean(pkg && (pkg as any).workspaces));
}

/**
 * The owning app's directory — the nearest ancestor with any package.json.
 * Lets a compiled app pass `__dirname` (which is `<app>/dist`) and still find
 * the .env that sits next to its package.json.
 */
export function findAppRoot(startDir: string): string | null {
  return findUp(startDir, () => true);
}

/**
 * Load `<appDir>/.env` then `<repoRoot>/.env`. Safe to call more than once and
 * safe when neither file exists — in a deployed environment there are no .env
 * files at all and every value comes from the real environment.
 */
export function loadEnv(options: LoadEnvOptions = {}): LoadEnvResult {
  const start = options.from ? path.resolve(options.from) : process.cwd();
  const appDir = options.appDir
    ? path.resolve(options.appDir)
    : findAppRoot(start) ?? start;
  const rootDir =
    options.rootDir !== undefined ? options.rootDir : findRepoRoot(appDir);

  // Most specific first: dotenv leaves already-set variables alone, so the first
  // file to define a key wins, and the real environment beats every file.
  const candidates = [path.join(appDir, ".env")];
  if (rootDir && path.resolve(rootDir) !== appDir) {
    candidates.push(path.join(rootDir, ".env"));
  }

  const files: string[] = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    // quiet: dotenv v17 otherwise prints a promotional tip banner per call.
    // These servers talk MCP over stdio and log to stderr; keep that clean and
    // emit our own single summary line below instead.
    dotenv.config({ path: file, quiet: true });
    files.push(file);
  }

  const missing = (options.required ?? []).filter((name) => !process.env[name]);

  if (!options.quiet) {
    const label = options.label ?? path.basename(appDir);
    const where = files.length
      ? files.map((f) => (rootDir ? path.relative(rootDir, f) : f)).join(", ")
      : "none (using real environment only)";
    console.error(`[env:${label}] loaded ${where}`);
    if (missing.length) {
      console.error(
        `[env:${label}] WARNING: unset required variable(s): ${missing.join(", ")}. ` +
          `Set them in the root .env or as deployment secrets.`
      );
    }
  }

  return { rootDir, files, missing };
}

export default loadEnv;

// ── Secret encryption (AES-256-GCM, format enc:v1:<iv>:<ct>:<tag>, base64url) ──
// Key derivation: sha256(RUNTIME_ENC_KEY).  Authoritative implementation —
// apps/agent-runtime/src/users.ts and apps/agents-mcp/src/credentials.ts both
// import from here; scripts/runtime-user-tool.js uses the CJS build.

function encKey(): Buffer {
  const raw = process.env.RUNTIME_ENC_KEY;
  if (!raw) {
    throw new Error(
      "RUNTIME_ENC_KEY is not set (required for encrypted claudeOauthToken values)"
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${ct.toString("base64url")}:${tag.toString("base64url")}`;
}

/** Decrypt an enc:v1:<iv>:<ct>:<tag> value (base64url). Plaintext passes through. */
export function decryptSecret(value: string): string {
  if (!value.startsWith("enc:")) return value; // plaintext passthrough (discouraged)
  const parts = value.split(":");
  if (parts.length !== 5 || parts[1] !== "v1") {
    throw new Error("Unrecognized encrypted-secret format");
  }
  const [, , ivB64, ctB64, tagB64] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encKey(),
    Buffer.from(ivB64, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
