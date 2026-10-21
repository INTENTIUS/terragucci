import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync, gunzipSync, gzipSync } from "node:zlib";

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
  return tarOf(moduleFiles(dir).map((path) => ({ path, data: readFileSync(join(dir, path)), exec: (statSync(join(dir, path)).mode & 0o111) !== 0 })));
}

/** A module's files as entries, in the order moduleFiles gives them. */
export interface TarEntry {
  path: string;
  data: Buffer;
  exec: boolean;
}

function tarOf(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const { path, data, exec } of entries) {
    parts.push(header(path, data.length, exec ? 0o755 : 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/**
 * The module at `rel` as the commit `ref` holds it, archived as moduleTar
 * archives a checkout: the same files, so the same bytes and the same digest.
 * Undefined when the commit has no such directory.
 */
export function moduleTarAt(repo: string, ref: string, rel: string): Buffer | undefined {
  const ls = spawnSync("git", ["-C", repo, "ls-tree", "-r", "-z", `${ref}:${rel}`], { encoding: "utf-8", maxBuffer: 1 << 30 });
  if (ls.status !== 0) return undefined;
  const entries: TarEntry[] = [];
  for (const line of ls.stdout.split("\0").filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line);
    if (!m || m[2] !== "blob") continue;
    const path = m[4];
    const parts = path.split("/");
    if (parts.some((p) => SKIP.has(p)) || path === "version" || parts[parts.length - 1] === ".terraform.lock.hcl") continue;
    const blob = spawnSync("git", ["-C", repo, "cat-file", "blob", m[3]], { maxBuffer: 1 << 30 });
    if (blob.status !== 0) return undefined;
    entries.push({ path, data: blob.stdout, exec: m[1] === "100755" });
  }
  if (entries.length === 0) return undefined;
  return tarOf(entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}

export const gzip = (tar: Buffer): Buffer => gzipSync(tar, { level: 9 });

/** The file entries of a tar moduleTar wrote, in its order. */
export function tarEntries(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  const text = (at: number, length: number): string => {
    const raw = tar.subarray(at, at + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end < 0 ? length : end).toString("utf-8");
  };
  for (let at = 0; at + 512 <= tar.length; ) {
    if (tar.subarray(at, at + 512).every((b) => b === 0)) break;
    const name = text(at, 100);
    const prefix = text(at + 345, 155);
    const mode = parseInt(text(at + 100, 8).trim() || "0", 8);
    const size = parseInt(text(at + 124, 12).trim() || "0", 8);
    const type = tar[at + 156];
    const start = at + 512;
    if (type === 0x30 || type === 0) out.push({ path: prefix ? `${prefix}/${name}` : name, data: Buffer.from(tar.subarray(start, start + size)), exec: (mode & 0o111) !== 0 });
    at = start + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** The tar inside a gzipped module archive. */
export const gunzip = (gz: Uint8Array): Buffer => gunzipSync(gz);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00, the earliest time a zip entry can hold, as a DOS date. */
const DOS_DATE = (1 << 5) | 1;

/**
 * The module as a zip, the layer OpenTofu installs from an OCI artifact,
 * made from the module's tar: the module's root at the zip's root, the tar's
 * sorted entries, each dated 1980-01-01 with mode 644 or 755, and each
 * deflated at level 9, or stored when deflating does not make it smaller.
 * The same tar gives the same bytes.
 */
export function moduleZip(tar: Buffer): Buffer {
  const entries = tarEntries(tar);
  if (entries.length > 0xffff) throw new Error(`the module has ${entries.length} files, more than a zip holds without zip64`);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { path, data, exec } of entries) {
    const name = Buffer.from(path, "utf-8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    if (data.length > 0xfffffffe || offset > 0xfffffffe) throw new Error(`${path} does not fit a zip without zip64`);
    const crc = crc32(data);
    const method = stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE((3 << 8) | 20, 4); // made on Unix, so the mode below is read
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE((((exec ? 0o755 : 0o644) | 0o100000) << 16) >>> 0, 38);
    head.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(head, name);
    offset += local.length + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
