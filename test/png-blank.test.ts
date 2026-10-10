// stack/png.mjs: the blank measure stack/shot.mjs refuses a screenshot by.
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain ES module without types
import { blankShare, decode } from "../stack/png.mjs";

/** An RGB PNG whose rows are drawn by `ink(x, y)`: true is a dark pixel on white. */
function png(width: number, height: number, ink: (x: number, y: number) => boolean): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const v = ink(x, y) ? 30 : 250;
      raw.fill(v, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3);
    }
  }
  const chunk = (name: string, body: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, Buffer.from(name, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Lines of "text": 28px of glyphs in every 42px, across most of the width.
const text = (x: number, y: number) => y % 42 < 28 && x % 7 < 4 && x < 560;

describe("blankShare", () => {
  it("counts lines of text with their gaps as content", () => {
    expect(blankShare(decode(png(600, 840, text)))).toBeLessThan(0.05);
  });

  it("counts the white below a short page as blank", () => {
    const share = blankShare(decode(png(600, 1600, (x, y) => y < 400 && text(x, y))));
    expect(share).toBeGreaterThan(0.7);
  });

  it("does not count a box's border as content", () => {
    const share = blankShare(decode(png(600, 1000, (x, y) => x < 2 || x > 597 || (y < 200 && text(x, y)))));
    expect(share).toBeGreaterThan(0.7);
  });

  it("leaves out the margin at the top and bottom when asked", () => {
    const img = decode(png(600, 300, (x, y) => y >= 60 && y < 240 && text(x, y)));
    expect(blankShare(img, 40, 0)).toBeGreaterThan(0.3);
    expect(blankShare(img, 40, 60)).toBeLessThan(0.05);
  });
});
