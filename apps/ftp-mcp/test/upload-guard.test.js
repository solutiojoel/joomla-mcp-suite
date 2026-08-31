"use strict";
// Unit coverage for the ftp_upload_file binary-safety guard and base64 path
// added for improvement record 120. None of these tests open an FTP
// connection: the guard and the base64 decode run before uploadFile() calls
// connect(), so a deliberately-unconfigured domain still exercises them.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FtpClient,
  BINARY_EXTENSIONS,
  extensionOf,
  isUtf8Safe,
  decodeBase64Strict,
} = require("../dist/ftp-client.js");

test("extensionOf returns the lower-cased extension or empty", () => {
  assert.equal(extensionOf("/a/b/file.PDF"), "pdf");
  assert.equal(extensionOf("/a/b/style.css"), "css");
  assert.equal(extensionOf("/a/b/archive.tar.gz"), "gz");
  assert.equal(extensionOf("/a/b/README"), "");
  assert.equal(extensionOf("/a/b/.htaccess"), "");
});

test("BINARY_EXTENSIONS covers the formats a text upload would corrupt", () => {
  for (const ext of ["pdf", "png", "jpg", "woff2", "docx", "xlsx", "zip"]) {
    assert.ok(BINARY_EXTENSIONS.has(ext), `expected ${ext} to be treated as binary`);
  }
  for (const ext of ["css", "js", "html", "svg", "txt", "json"]) {
    assert.ok(!BINARY_EXTENSIONS.has(ext), `expected ${ext} to be treated as text`);
  }
});

test("isUtf8Safe accepts text and rejects non-UTF-8 strings", () => {
  assert.equal(isUtf8Safe("plain ascii"), true);
  assert.equal(isUtf8Safe("café — déjà vu — 日本語"), true);
  assert.equal(isUtf8Safe("\uD800"), false); // lone high surrogate
  assert.equal(isUtf8Safe("ok\uDC00ok"), false); // lone low surrogate
});

test("decodeBase64Strict round-trips a real payload", () => {
  const original = Buffer.from("%PDF-1.7\r\n\x00\x01\x02\xff\xfe binary bytes", "latin1");
  const b64 = original.toString("base64");
  const out = decodeBase64Strict(b64);
  assert.ok("buffer" in out, "expected a decoded buffer");
  assert.ok(out.buffer.equals(original));
});

test("decodeBase64Strict tolerates embedded whitespace", () => {
  const original = Buffer.from("hello world, this is a longer payload");
  const b64 = original.toString("base64");
  const wrapped = b64.replace(/(.{8})/g, "$1\n  "); // newlines + indentation
  const out = decodeBase64Strict(wrapped);
  assert.ok("buffer" in out);
  assert.ok(out.buffer.equals(original));
});

test("decodeBase64Strict rejects empty, malformed, and truncated input", () => {
  assert.ok("error" in decodeBase64Strict(""));
  assert.ok("error" in decodeBase64Strict("   \n  "));
  assert.ok("error" in decodeBase64Strict("not valid base64 %%%%"));
  // 5 chars: a remainder of 1 is structurally impossible for real base64.
  // Node's lenient decoder drops the stray char; the round-trip check catches it.
  assert.ok("error" in decodeBase64Strict("QQQQQ"));
  // A well-formed payload with one interior character deleted — re-encoding the
  // decoded bytes no longer matches the input.
  const good = Buffer.from("hello world, a longer sample").toString("base64");
  assert.ok("error" in decodeBase64Strict(good.slice(0, 10) + good.slice(11)));
});

test("uploadFile refuses a text write to a binary path before connecting", async () => {
  const client = new FtpClient();
  const res = await client.uploadFile(
    "/forge/none/pub/form.pdf",
    "this is not a pdf",
    "domain-that-does-not-exist.example",
    "utf8"
  );
  assert.equal(res.success, false);
  assert.match(res.message, /binary format/i);
  assert.match(res.message, /base64/i);
});

test("uploadFile refuses non-UTF-8 text even to a non-binary path", async () => {
  const client = new FtpClient();
  const res = await client.uploadFile(
    "/forge/none/pub/notes.txt",
    "bad\uD800bytes",
    "domain-that-does-not-exist.example",
    "utf8"
  );
  assert.equal(res.success, false);
  assert.match(res.message, /not valid UTF-8/i);
});

test("uploadFile rejects malformed base64 before connecting", async () => {
  const client = new FtpClient();
  const res = await client.uploadFile(
    "/forge/none/pub/form.pdf",
    "%%% definitely not base64 %%%",
    "domain-that-does-not-exist.example",
    "base64"
  );
  assert.equal(res.success, false);
  assert.match(res.message, /base64/i);
});

test("uploadFile accepts a valid base64 payload past the guard (fails later at connect)", async () => {
  const client = new FtpClient();
  const b64 = Buffer.from("%PDF-1.7 fake but well-formed").toString("base64");
  const res = await client.uploadFile(
    "/forge/none/pub/form.pdf",
    b64,
    "domain-that-does-not-exist.example",
    "base64"
  );
  assert.equal(res.success, false);
  // Past the guard and the decode; the failure is now the missing FTP config,
  // not a content rejection.
  assert.match(res.message, /No FTP configuration/i);
});
