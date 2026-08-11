import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { encryptSecret, decryptSecret } from "@solutio/env";

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

export { encryptSecret, decryptSecret } from "@solutio/env";

/** Decrypted personal Claude token, or null if the user has none. */
export function claudeTokenFor(user: RuntimeUser): string | null {
  if (!user.claudeOauthToken) return null;
  return decryptSecret(user.claudeOauthToken);
}
