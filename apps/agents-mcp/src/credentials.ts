import fs from "node:fs";
import path from "node:path";
import { decryptSecret } from "@solutio/env";

/**
 * Per-job Claude credential resolution.
 *
 * Sub-agent jobs carry the triggering user's identity (`triggered_by`, an
 * email — injected by the orchestrator from its session context). This module
 * resolves that identity to the user's personal CLAUDE_CODE_OAUTH_TOKEN from
 * config/runtime-users.json so each teammate's runs bill to their own
 * subscription. Resolution order matches apps/agent-runtime/src/sessions/driver.ts:
 *   personal token → shared CLAUDE_CODE_OAUTH_TOKEN → ANTHROPIC_API_KEY.
 *
 * The registry file and the enc:v1 AES-256-GCM format are owned by
 * apps/agent-runtime/src/users.ts (key from RUNTIME_ENC_KEY) — keep the
 * decryption here in sync with it and scripts/runtime-user-tool.js. Everything
 * is fail-open: any lookup/decrypt problem logs a warning and falls back to
 * the shared credential already in this process's environment, so jobs from
 * MCP clients or users without a personal token behave exactly as before.
 */

const USERS_PATH =
  process.env.RUNTIME_USERS_PATH ||
  path.resolve(__dirname, "..", "..", "..", "config", "runtime-users.json");

interface RuntimeUserRecord {
  claudeOauthToken?: string;
}

/** The decrypted personal Claude token for an identity, or null (fail-open). */
function personalClaudeTokenFor(triggeredBy: string): string | null {
  let users: Record<string, RuntimeUserRecord>;
  try {
    if (!fs.existsSync(USERS_PATH)) return null;
    users = JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
  } catch (err) {
    console.error(`[credentials] cannot read runtime user registry: ${(err as Error).message}`);
    return null;
  }
  const key = Object.keys(users).find((k) => k.toLowerCase() === triggeredBy.toLowerCase());
  const record = key ? users[key] : undefined;
  if (!record?.claudeOauthToken) return null;
  try {
    return decryptSecret(record.claudeOauthToken);
  } catch (err) {
    console.error(
      `[credentials] cannot decrypt personal token for ${triggeredBy} — using shared credential: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Environment for a sub-agent run. With a personal token the env pins
 * CLAUDE_CODE_OAUTH_TOKEN and drops ANTHROPIC_API_KEY (personal token wins);
 * otherwise the inherited environment applies unchanged (shared
 * CLAUDE_CODE_OAUTH_TOKEN, then ANTHROPIC_API_KEY).
 * Returns the env and which credential source was chosen (for run logs).
 */
export function resolveClaudeEnv(triggeredBy?: string): {
  env: Record<string, string | undefined>;
  credentialSource: "personal" | "shared";
} {
  const env: Record<string, string | undefined> = { ...process.env };
  if (triggeredBy) {
    const personal = personalClaudeTokenFor(triggeredBy);
    if (personal) {
      env.CLAUDE_CODE_OAUTH_TOKEN = personal;
      delete env.ANTHROPIC_API_KEY;
      return { env, credentialSource: "personal" };
    }
  }
  return { env, credentialSource: "shared" };
}
