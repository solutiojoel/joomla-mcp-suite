// Round-trip drift test for the duplicated enc:v1 token crypto:
// encrypt with apps/agent-runtime/src/users.ts (the format owner), then
// resolve through THIS package's resolveClaudeEnv against a temp registry.
// If the format or key derivation ever drifts between the two copies, the
// personal-token assertion here fails before it can lock users out at runtime.
// Run: npx tsx src/credentials.test.ts   (or: npm test)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err: any) {
    failures++;
    console.error(`FAIL  ${label} — ${err.message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  // Environment must be in place BEFORE the modules under test are imported:
  // credentials.ts resolves RUNTIME_USERS_PATH at module load.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-test-"));
  const registryPath = path.join(tmpDir, "runtime-users.json");
  process.env.RUNTIME_ENC_KEY = "test-enc-key-for-round-trip";
  process.env.RUNTIME_USERS_PATH = registryPath;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "shared-token-sentinel";
  process.env.ANTHROPIC_API_KEY = "api-key-sentinel";

  // encryptSecret from the format owner (agent-runtime)…
  const { encryptSecret } = await import("../../agent-runtime/src/users.js");
  // …resolved by this package's duplicated decryption path.
  const { resolveClaudeEnv } = await import("./credentials.js");

  const PERSONAL = "sk-ant-oat-PERSONAL-TOKEN-ROUND-TRIP";
  const encrypted = encryptSecret(PERSONAL);

  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      "Alice@Example.com": {
        passwordHash: "x",
        orchestratorToken: "tok",
        claudeOauthToken: encrypted,
      },
      "bob@example.com": {
        passwordHash: "x",
        orchestratorToken: "tok",
        // no claudeOauthToken
      },
    })
  );

  console.log("— round trip: agent-runtime encrypt → agents-mcp resolve —");

  check("encrypted value is enc:v1 format", () => {
    assert(encrypted.startsWith("enc:v1:"), `format: ${encrypted.slice(0, 12)}…`);
    assert(encrypted.split(":").length === 5, "expected 5 colon-separated parts");
  });

  check("personal token resolves as the personal credential", () => {
    const { env, credentialSource } = resolveClaudeEnv("alice@example.com");
    assert(credentialSource === "personal", `source ${credentialSource}`);
    assert(env.CLAUDE_CODE_OAUTH_TOKEN === PERSONAL, "decrypted token mismatch — crypto drift!");
    assert(!("ANTHROPIC_API_KEY" in env) || env.ANTHROPIC_API_KEY === undefined, "ANTHROPIC_API_KEY not dropped");
  });

  check("identity lookup is case-insensitive (registry key has mixed case)", () => {
    const { credentialSource } = resolveClaudeEnv("ALICE@example.COM");
    assert(credentialSource === "personal", `source ${credentialSource}`);
  });

  console.log("— fallbacks to the shared credential —");

  check("unknown user falls back to shared", () => {
    const { env, credentialSource } = resolveClaudeEnv("nobody@example.com");
    assert(credentialSource === "shared", `source ${credentialSource}`);
    assert(env.CLAUDE_CODE_OAUTH_TOKEN === "shared-token-sentinel", "shared token not preserved");
    assert(env.ANTHROPIC_API_KEY === "api-key-sentinel", "API key not preserved");
  });

  check("known user without a personal token falls back to shared", () => {
    const { credentialSource } = resolveClaudeEnv("bob@example.com");
    assert(credentialSource === "shared", `source ${credentialSource}`);
  });

  check("no identity (MCP client) falls back to shared", () => {
    const { env, credentialSource } = resolveClaudeEnv(undefined);
    assert(credentialSource === "shared", `source ${credentialSource}`);
    assert(env.CLAUDE_CODE_OAUTH_TOKEN === "shared-token-sentinel", "shared token not preserved");
  });

  check("undecryptable token fails open to shared (wrong-key ciphertext)", () => {
    const parts = encrypted.split(":");
    // Corrupt the auth tag so decryption throws.
    parts[4] = Buffer.from("0".repeat(16)).toString("base64url");
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        "alice@example.com": { passwordHash: "x", orchestratorToken: "tok", claudeOauthToken: parts.join(":") },
      })
    );
    const { credentialSource } = resolveClaudeEnv("alice@example.com");
    assert(credentialSource === "shared", `source ${credentialSource}`);
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
