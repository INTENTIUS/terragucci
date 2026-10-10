// PNG reading for the capture scripts: stack/png-same.mjs compares two
// screenshots with it, and stack/shot.mjs and scripts/tutorial-check.mjs
// measure how much of one is blank. 8-bit, non-interlaced PNGs only: what
// Chrome writes, and what scripts/png-compress.mjs writes (a palette).
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** A PNG's pixels, unfiltered, as RGB(A) bytes: { width, height, channels, pixels }. */
export function decode(file) {
  const buf = typeof file === "string" ? readFileSync(file) : file;
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette, alpha;
  const data = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), name = buf.toString("latin1", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; type = body[9]; interlace = body[12];
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") alpha = body;
    else if (name === "IDAT") data.push(body);
    pos += 12 + len;
  }
  const stored = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (depth !== 8 || interlace !== 0 || !stored || (type === 3 && !palette)) throw new Error("unsupported PNG");
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * stored;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= stored ? out[y * stride + x - stored] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= stored && y > 0 ? out[(y - 1) * stride + x - stored] : 0;
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
  if (type !== 3) return { width, height, channels: stored, pixels: out };
  // A palette image, as RGBA.
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const k = out[i];
    rgba[i * 4] = palette[k * 3]; rgba[i * 4 + 1] = palette[k * 3 + 1]; rgba[i * 4 + 2] = palette[k * 3 + 2];
    rgba[i * 4 + 3] = alpha && k < alpha.length ? alpha[k] : 255;
  }
  return { width, height, channels: 4, pixels: rgba };
}

/**
 * The share of a picture that is blank: its rows that lie in a run of at
 * least `run` blank rows (40 by default: 20 CSS pixels at deviceScaleFactor
 * 2, more than the space between paragraphs). A row is blank when nearly every pixel in it (all but 2%) is within a
 * few levels of that row's commonest colour, so a box's borders do not count.
 * The gaps between lines of text are shorter than a run; the white below a
 * short page, or a band above an anchor, is not. The `edge` rows at the top
 * and bottom (the margin shot.mjs leaves around an element) are not counted.
 */
export function blankShare(img, run = 40, edge = 0) {
  const { width, height, channels, pixels } = img;
  const near = 12;
  let blank = 0, streak = 0;
  const counts = new Map();
  const from = Math.min(edge, height >> 2), to = height - from;
  for (let y = from; y < to; y++) {
    counts.clear();
    const row = y * width * channels;
    // The row's commonest colour, sampled every 4th pixel, at 5 bits a channel.
    let top = 0, bg = 0;
    for (let x = 0; x < width; x += 4) {
      const i = row + x * channels;
      const k = channels >= 3 ? ((pixels[i] >> 3) << 10) | ((pixels[i + 1] >> 3) << 5) | (pixels[i + 2] >> 3) : pixels[i] >> 3;
      const n = (counts.get(k) ?? 0) + 1;
      counts.set(k, n);
      if (n > top) { top = n; bg = i; }
    }
    let off = 0;
    const limit = width * 0.02;
    for (let x = 0; x < width && off <= limit; x++) {
      const i = row + x * channels;
      for (let c = 0; c < Math.min(channels, 3); c++) {
        if (Math.abs(pixels[i + c] - pixels[bg + c]) > near) { off++; break; }
      }
    }
    if (off <= limit) streak++;
    else { if (streak >= run) blank += streak; streak = 0; }
  }
  if (streak >= run) blank += streak;
  return to > from ? blank / (to - from) : 1;
}
