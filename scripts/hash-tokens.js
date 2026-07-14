#!/usr/bin/env node
'use strict';

// Hash (and optionally rotate) the orchestrator bearer tokens in config/users.json.
//
//   node scripts/hash-tokens.js            Hash any plaintext keys in place.
//                                          Existing tokens keep working — the
//                                          orchestrator compares sha256(token)
//                                          against the "sha256:<hex>" keys.
//   node scripts/hash-tokens.js --rotate   Replace EVERY entry with a fresh
//                                          random token and print the plaintext
//                                          tokens once. Distribute them and
//                                          update each user's client config —
//                                          the old tokens stop working as soon
//                                          as the orchestrator reloads the
//                                          registry (restart or reload_tools).
//
// Either mode rewrites config/users.json; a one-time backup is written next to
// it as config/users.json.bak.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_JSON_PATH = path.join(__dirname, '..', 'config', 'users.json');

function sha256Key(token) {
  return 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

if (!fs.existsSync(USERS_JSON_PATH)) {
  console.error(`Not found: ${USERS_JSON_PATH}`);
  process.exit(1);
}

const rotate = process.argv.includes('--rotate');
const users = JSON.parse(fs.readFileSync(USERS_JSON_PATH, 'utf8'));

const out = {};
const printed = [];
let hashed = 0;
let already = 0;

for (const [key, entry] of Object.entries(users)) {
  if (rotate) {
    const token = newToken();
    out[sha256Key(token)] = entry;
    printed.push({ user: entry.user, token });
  } else if (key.startsWith('sha256:')) {
    out[key] = entry;
    already++;
  } else {
    out[sha256Key(key)] = entry;
    hashed++;
  }
}

const bakPath = USERS_JSON_PATH + '.bak';
if (!fs.existsSync(bakPath)) fs.copyFileSync(USERS_JSON_PATH, bakPath);
fs.writeFileSync(USERS_JSON_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');

if (rotate) {
  console.log(`Rotated ${printed.length} token(s). New plaintext tokens (shown ONCE — distribute now):\n`);
  for (const { user, token } of printed) {
    console.log(`  ${user}\n    ${token}\n`);
  }
  console.log('config/users.json now holds only sha256 digests.');
  console.log('Old tokens remain valid until the orchestrator restarts or reload_tools is called.');
} else {
  console.log(`Hashed ${hashed} plaintext key(s) in place (${already} already hashed).`);
  console.log('Existing tokens keep working. Run with --rotate to issue new tokens.');
}
console.log(`Backup of the previous file: ${bakPath} — delete it once you have verified logins.`);
