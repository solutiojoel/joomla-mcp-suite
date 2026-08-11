#!/usr/bin/env node
'use strict';

// Helper for populating config/runtime-users.json (agent-runtime dashboard users).
//
//   node scripts/runtime-user-tool.js hash-password '<password>'
//       → bcrypt hash for the "passwordHash" field
//
//   node scripts/runtime-user-tool.js encrypt-token '<CLAUDE_CODE_OAUTH_TOKEN>'
//       → enc:v1:… value for the "claudeOauthToken" field
//         (requires RUNTIME_ENC_KEY in the environment or a .env file)
//
// Encryption is handled by @solutio/env (packages/env) — the single source of
// truth for the AES-256-GCM enc:v1 format.

const path = require('path');

function loadDotenv() {
  try {
    const dotenv = require('dotenv');
    dotenv.config({ path: path.join(__dirname, '..', 'apps', 'agent-runtime', '.env'), quiet: true });
    dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  } catch { /* dotenv not installed yet — env vars still work */ }
}

const [, , command, value] = process.argv;

if (!command || !value) {
  console.error("Usage: node scripts/runtime-user-tool.js <hash-password|encrypt-token> '<value>'");
  process.exit(1);
}

if (command === 'hash-password') {
  const bcrypt = require('bcryptjs');
  console.log(bcrypt.hashSync(value, 12));
} else if (command === 'encrypt-token') {
  loadDotenv();
  if (!process.env.RUNTIME_ENC_KEY) {
    console.error('RUNTIME_ENC_KEY is not set (add it to .env or the environment first).');
    process.exit(1);
  }
  const { encryptSecret } = require('@solutio/env');
  console.log(encryptSecret(value));
} else {
  console.error(`Unknown command: ${command} (expected hash-password or encrypt-token)`);
  process.exit(1);
}
