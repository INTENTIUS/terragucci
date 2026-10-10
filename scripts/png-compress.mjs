#!/usr/bin/env node
// Shrink screenshots in place before a capture records their hashes: a
// palette PNG of at most 256 colours, which a page of text and boxes keeps
// to the eye, at about a third of Chrome's size. Uses the docs site's sharp
// (`npm ci` in docs-site/).
//
//   node scripts/png-compress.mjs FILE.png...
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(new URL("../docs-site/package.json", import.meta.url));
let sharp;
try {
  sharp = require("sharp");
} catch {
  console.error("png-compress: no sharp; run npm ci in docs-site/");
  process.exit(1);
}
for (const file of process.argv.slice(2)) {
  const before = readFileSync(file);
  const after = await sharp(before).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9, dither: 0.5 }).toBuffer();
  if (after.length < before.length) writeFileSync(file, after);
  console.log(`${file}: ${before.length} -> ${Math.min(after.length, before.length)} bytes`);
}
