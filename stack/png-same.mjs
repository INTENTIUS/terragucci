#!/usr/bin/env node
// Are two screenshots the same picture, give or take Forgejo's relative times
// ("2 minutes ago" becomes "3 minutes ago" between captures)? tutorial-capture.sh
// keeps the committed screenshot when this exits 0.
//
//   node stack/png-same.mjs OLD.png NEW.png [tolerance]
//
// Same size, and the share of pixels that differ by more than a few levels in
// some channel is at most the tolerance (default 0.01, or
// TERRAGUCCI_SHOT_TOLERANCE). Exit 0 for the same, 1 for different, 2 for a
// file it cannot read (8-bit, non-interlaced PNGs only; see stack/png.mjs).
import { decode } from "./png.mjs";

const [oldFile, newFile, tol] = process.argv.slice(2);
const tolerance = Number(tol ?? process.env.TERRAGUCCI_SHOT_TOLERANCE ?? 0.01);
try {
  const a = decode(oldFile), b = decode(newFile);
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) process.exit(1);
  let differ = 0;
  for (let i = 0; i < a.pixels.length; i += a.channels) {
    for (let c = 0; c < a.channels; c++) {
      if (Math.abs(a.pixels[i + c] - b.pixels[i + c]) > 8) { differ++; break; }
    }
  }
  process.exit(differ / (a.width * a.height) <= tolerance ? 0 : 1);
} catch (e) {
  console.error(`png-same: ${e.message}`);
  process.exit(2);
}
