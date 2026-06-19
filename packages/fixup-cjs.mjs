// Drop a { "type": "commonjs" } marker into dist/cjs so Node treats the CJS
// build as CommonJS even though the package root is "type": "module".
// Run from a package directory: `node ../fixup-cjs.mjs`.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const cjsDir = join(process.cwd(), "dist", "cjs");
mkdirSync(cjsDir, { recursive: true });
writeFileSync(join(cjsDir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
console.log(`[fixup-cjs] wrote ${join(cjsDir, "package.json")}`);
