import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

/**
 * config/runtime-users.json — dashboard user registry, keyed by email.
 * Distinct from config/users.json (orchestrator bearer tokens): each runtime
 * user *references* their orchestrator token so MCP scoping and audit
 * attribution keep working unchanged.
 *
 * The file is read fresh on every access (live edits, no restart — same
 * convention as the orchestrator's registries).
 */

export interface RuntimeUserRecord {
  displayName?: string;
  role?: "admin" | "member";
  /** bcrypt hash — generate with: node scripts/runtime-user-tool.js hash-password '<pw>' */
  passwordHash: string;
  /** The user's orchestrator bearer token (sent on every MCP call as this user). */
  orchestratorToken: string;
  /**
   * Optional personal CLAUDE_CODE_OAUTH_TOKEN, encrypted at rest as
   * enc:v1:<iv>:<ciphertext>:<tag> (AES-256-GCM, key from RUNTIME_ENC_KEY).
   * Generate with: node scripts/runtime-user-tool.js encrypt-token '<token>'
   */
  claudeOauthToken?: string;
  defaultAgent?: string;
  allowedAgents?: string[];
}

export interface RuntimeUser extends RuntimeUserRecord {
  email: string;
}

export interface PublicUser {
  email: string;
  displayName: string;
  role: "admin" | "member";
  defaultAgent: string;
  allowedAgents: string[];
  hasPersonalClaudeToken: boolean;
}

const USERS_PATH =
  process.env.RUNTIME_USERS_PATH ||
  path.resolve(__dirname, "..", "..", "..", "config", "runtime-users.json");

export function loadUsers(): Record<string, RuntimeUserRecord> {
  if (!fs.existsSync(USERS_PATH)) return {};
  return JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
}

export function findUser(email: string): RuntimeUser | null {
  if (!email) return null;
  const users = loadUsers();
  const key = Object.keys(users).find(
    (k) => k.toLowerCase() === email.toLowerCase()
  );
  if (!key) return null;
  return { email: key, ...users[key] };
}

export async function verifyPassword(
  user: RuntimeUser,
  password: string
): Promise<boolean> {
  if (!user.passwordHash) return false;
  return bcrypt.compare(password, user.passwordHash);
}

/** Agents this user may start a chat session as (default agent always included). */
export function agentSetFor(user: RuntimeUser): string[] {
  return [
    ...new Set(
      [user.defaultAgent || "super_shannon", ...(user.allowedAgents || [])]
    ),
  ];
}

/** The user object shape returned by login and /api/me (never includes secrets). */
export function publicUser(user: RuntimeUser): PublicUser {
  return {
    email: user.email,
    displayName: user.displayName || user.email.split("@")[0],
    role: user.role === "admin" ? "admin" : "member",
    defaultAgent: user.defaultAgent || "super_shannon",
    allowedAgents: agentSetFor(user),
    hasPersonalClaudeToken: !!user.claudeOauthToken,
  };
}

// ── Secret encryption (AES-256-GCM, format enc:v1:<iv>:<ct>:<tag>, base64url) ──
// Keep in sync with scripts/runtime-user-tool.js.

function encKey(): Buffer {
  const raw = process.env.RUNTIME_ENC_KEY;
  if (!raw) {
    throw new Error("RUNTIME_ENC_KEY is not set (required for encrypted claudeOauthToken values)");
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

/** Decrypted personal Claude token, or null if the user has none. */
export function claudeTokenFor(user: RuntimeUser): string | null {
  if (!user.claudeOauthToken) return null;
  return decryptSecret(user.claudeOauthToken);
}
