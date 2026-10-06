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
// file it cannot read (8-bit, non-interlaced PNGs only, which is what Chrome
// writes).
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

function decode(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const data = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), name = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; type = body[9]; interlace = body[12];
    } else if (name === "IDAT") data.push(body);
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || interlace !== 0 || !channels) throw new Error("unsupported PNG");
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v = src[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, channels, pixels: out };
}

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
