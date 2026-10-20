import { spawnSync } from "node:child_process";
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
