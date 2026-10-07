/**
 * `terragucci install <binary> <version>`: fetch a release, check it against
 * the release's SHA256SUMS, unpack it, and print the directory it is in. It
 * needs only Node, so it runs in terragucci's images, which carry no curl or
 * unzip. A pipeline uses it when a repo pins a version its image does not carry.
 * It fetches Linux builds only (see assertLinux).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ConfigError } from "./config";

export type Tool = "tofu" | "terraform" | "terragrunt" | "choudoufu";

export interface Release {
  url: string;
  sums: string;
  /** The file name SHA256SUMS lists. */
  file: string;
  kind: "tar.gz" | "zip" | "binary";
}

function arch(): string {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

/** The releases `install` fetches are Linux builds, for a CI job; anywhere else it says so rather than hand over a binary that will not run. */
export function assertLinux(platform: string = process.platform): void {
  if (platform !== "linux") {
    throw new ConfigError(`terragucci install fetches Linux builds for a CI job, and this machine is ${platform}; install the tool with your package manager`);
  }
}

export function release(tool: Tool, version: string, a = arch()): Release {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) throw new ConfigError(`"${version}" is not a release version`);
  if (tool === "tofu") {
    const base = `https://github.com/opentofu/opentofu/releases/download/v${version}`;
    const file = `tofu_${version}_linux_${a}.tar.gz`;
    return { url: `${base}/${file}`, sums: `${base}/tofu_${version}_SHA256SUMS`, file, kind: "tar.gz" };
  }
  if (tool === "terraform") {
    const base = `https://releases.hashicorp.com/terraform/${version}`;
    const file = `terraform_${version}_linux_${a}.zip`;
    return { url: `${base}/${file}`, sums: `${base}/terraform_${version}_SHA256SUMS`, file, kind: "zip" };
  }
  if (tool === "choudoufu") {
    const base = `https://github.com/INTENTIUS/choudoufu/releases/download/v${version}`;
    const file = `choudoufu_v${version}_linux_${a}.tar.gz`;
    return { url: `${base}/${file}`, sums: `${base}/SHA256SUMS`, file, kind: "tar.gz" };
  }
  const base = `https://github.com/gruntwork-io/terragrunt/releases/download/v${version}`;
  const file = `terragrunt_linux_${a}`;
  return { url: `${base}/${file}`, sums: `${base}/SHA256SUMS`, file, kind: "binary" };
}

/** The expected digest for `file` in a SHA256SUMS text. */
export function expectedSum(sums: string, file: string): string {
  for (const line of sums.split("\n")) {
    const [sum, name] = line.trim().split(/\s+\*?/);
    // choudoufu's SHA256SUMS names each file as ./<file>.
    if (name?.replace(/^\.\//, "") === file) return sum.toLowerCase();
  }
  throw new ConfigError(`the release's checksums do not list ${file}`);
}

/** One file out of a zip archive, by name. Stored and deflated entries only, which is what releases use. */
export function unzipEntry(zip: Buffer, name: string): Buffer {
  // The end-of-central-directory record is in the last 64 KiB plus 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entry = zip.toString("utf-8", p + 46, p + 46 + nameLen);
    if (entry === name) {
      const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(dataStart, dataStart + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`zip entry ${name} uses compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`the archive has no ${name}`);
}

async function get(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new ConfigError(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export function installDir(tool: Tool, version: string, env = process.env): string {
  const root = env.TOFU_INSTALL_DIR ?? join(env.RUNNER_TEMP ?? tmpdir(), "terragucci-bin");
  return join(root, `${tool}-${version}`);
}

/** Install `tool` at `version` and return the directory holding it. An existing install is reused. */
export async function install(tool: Tool, version: string, dir = installDir(tool, version)): Promise<string> {
  const target = join(dir, tool);
  if (existsSync(target)) return dir;
  const r = release(tool, version);
  const [archive, sums] = await Promise.all([get(r.url), get(r.sums)]);
  const actual = createHash("sha256").update(archive).digest("hex");
  const expected = expectedSum(sums.toString("utf-8"), r.file);
  if (actual !== expected) throw new ConfigError(`${r.file} has sha256 ${actual}, but the release lists ${expected}`);

  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${tool}.${process.pid}`);
  if (r.kind === "zip") writeFileSync(tmp, unzipEntry(archive, tool));
  else if (r.kind === "binary") writeFileSync(tmp, archive);
  else {
    const staging = `${tmp}.d`;
    mkdirSync(staging, { recursive: true });
    execFileSync("tar", ["-xz", "-C", staging, tool], { input: archive });
    renameSync(join(staging, tool), tmp);
    rmSync(staging, { recursive: true, force: true });
  }
  chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  return dir;
}
