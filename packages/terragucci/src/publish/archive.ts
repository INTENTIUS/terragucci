import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const sha256 = (data: Uint8Array | string): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;

const SKIP = new Set([".git", ".terraform", "node_modules"]);

/** Files in a module, as sorted relative paths. The `version` file is metadata and stays out of the archive. */
export function moduleFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (SKIP.has(name)) continue;
      const path = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else if (path !== "version" && name !== ".terraform.lock.hcl") out.push(path);
    }
  };
  walk("");
  return out.sort();
}

function field(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value.slice(0, length), offset, "utf-8");
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header(path: string, size: number, mode: number): Buffer {
  const buf = Buffer.alloc(512);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const at = path.slice(0, 156).lastIndexOf("/");
    if (at < 0 || Buffer.byteLength(path.slice(at + 1)) > 100) throw new Error(`${path} is too long for the module archive`);
    prefix = path.slice(0, at);
    name = path.slice(at + 1);
  }
  field(buf, 0, 100, name);
  field(buf, 100, 8, octal(mode, 8));
  field(buf, 108, 8, octal(0, 8));
  field(buf, 116, 8, octal(0, 8));
  field(buf, 124, 12, octal(size, 12));
  field(buf, 136, 12, octal(0, 12));
  buf.fill(0x20, 148, 156);
  buf[156] = 0x30;
  field(buf, 257, 6, "ustar\0");
  field(buf, 263, 2, "00");
  field(buf, 345, 155, prefix);
  let sum = 0;
  for (const b of buf) sum += b;
  field(buf, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return buf;
}

/**
 * The module as a tar, the same bytes for the same files: sorted paths, no
 * owner, no timestamps. Its digest says whether the module's content changed.
 */
export function moduleTar(dir: string): Buffer {
  const parts: Buffer[] = [];
  for (const path of moduleFiles(dir)) {
    const data = readFileSync(join(dir, path));
    const mode = statSync(join(dir, path)).mode & 0o111 ? 0o755 : 0o644;
    parts.push(header(path, data.length, mode), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export const gzip = (tar: Buffer): Buffer => gzipSync(tar, { level: 9 });
