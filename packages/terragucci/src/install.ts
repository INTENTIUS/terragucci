/**
 * `terragucci install <binary> <version>`: fetch a release, check it against
 * the release's SHA256SUMS, unpack it, and print the directory it is in. It
 * needs only Node, so it runs in terragucci's images, which carry no curl or
 * unzip. A pipeline uses it when a repo pins a version its image does not carry.
 * It fetches Linux builds only (see assertLinux). With `--verify`, a choudoufu
 * release must also carry a signature, SLSA provenance and an SBOM
 * attestation that verify against choudoufu's pinned release key
 * (verifyChoudoufu).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ConfigError } from "./config";
import { CHOUDOUFU_RELEASE_KEY } from "./images";
import { AttestationError, PROVENANCE_TYPE, publicKey, SPDX_TYPE, verifyAttestation, verifySignature } from "./publish/verify";

export type Tool = "tofu" | "terraform" | "terragrunt" | "choudoufu" | "infracost" | "cosign" | "atmos" | "terramate";

/** The Infracost release a plan job installs for `cost:`. */
export const INFRACOST_VERSION = "0.10.45";

/**
 * The cosign release the publish job installs for `modules.attest`: the 2.x
 * line, whose key-based signing takes `--tlog-upload=false`. Not in the
 * images, since attest is opt-in and cosign is a 137 MB binary.
 */
export const COSIGN_VERSION = "2.6.5";

/** A tool a job installs; `verify` (choudoufu, under `install.verify`) adds `--verify`. */
export interface ToolInstall {
  tool: Tool;
  version: string;
  verify?: boolean;
}

export interface Release {
  url: string;
  sums: string;
  /** The file name SHA256SUMS lists. */
  file: string;
  kind: "tar.gz" | "zip" | "binary";
  /** The binary's name inside a tar.gz, when it is not the tool's. */
  member?: string;
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
  if (tool === "infracost") {
    // Each file has its own checksum file, in SHA256SUMS form.
    const base = `https://github.com/infracost/infracost/releases/download/v${version}`;
    const file = `infracost-linux-${a}.tar.gz`;
    return { url: `${base}/${file}`, sums: `${base}/${file}.sha256`, file, kind: "tar.gz", member: `infracost-linux-${a}` };
  }
  if (tool === "cosign") {
    const base = `https://github.com/sigstore/cosign/releases/download/v${version}`;
    const file = `cosign-linux-${a}`;
    return { url: `${base}/${file}`, sums: `${base}/cosign_checksums.txt`, file, kind: "binary" };
  }
  if (tool === "atmos") {
    // A bare binary per platform, listed in the release's SHA256SUMS.
    const base = `https://github.com/cloudposse/atmos/releases/download/v${version}`;
    const file = `atmos_${version}_linux_${a}`;
    return { url: `${base}/${file}`, sums: `${base}/atmos_${version}_SHA256SUMS`, file, kind: "binary" };
  }
  if (tool === "terramate") {
    // A tar.gz per platform, named x86_64 for amd64, listed in the release's checksums.txt.
    const base = `https://github.com/terramate-io/terramate/releases/download/v${version}`;
    const file = `terramate_${version}_linux_${a === "amd64" ? "x86_64" : a}.tar.gz`;
    return { url: `${base}/${file}`, sums: `${base}/checksums.txt`, file, kind: "tar.gz" };
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

/** The bundles a signed choudoufu release publishes beside each archive, by what they hold. */
export const CHOUDOUFU_BUNDLES = { signature: "sig.bundle", provenance: "provenance.bundle", sbom: "sbom.bundle" } as const;

/** The workflow, at the release's own tag, that the provenance of choudoufu `v<version>` must name as its builder. */
export function choudoufuBuilder(version: string): string {
  return `https://github.com/INTENTIUS/choudoufu/.github/workflows/release.yml@refs/tags/v${version}`;
}

interface Provenance {
  buildDefinition?: {
    externalParameters?: { tag?: unknown; sourceRef?: unknown };
    resolvedDependencies?: { uri?: unknown; digest?: { gitCommit?: unknown } }[];
  };
  runDetails?: { builder?: { id?: unknown } };
}

/**
 * Check a choudoufu release archive against its three bundles and the
 * release key: the signature over its bytes, then a SLSA provenance
 * statement about these bytes whose builder is choudoufu's release workflow
 * at `v<version>` and whose source is the commit that tag was built from,
 * then an SPDX SBOM attestation about these bytes. A failure throws a
 * ConfigError naming the release, the bundle and the reason.
 */
export function verifyChoudoufu(version: string, file: string, archive: Buffer, bundles: Partial<Record<keyof typeof CHOUDOUFU_BUNDLES, string>>, keyPem: string): void {
  const tag = `v${version}`;
  const refuse = (part: keyof typeof CHOUDOUFU_BUNDLES, reason: string): never => {
    throw new ConfigError(`choudoufu ${tag}: ${file}.${CHOUDOUFU_BUNDLES[part]}: ${reason}; the binary was not installed`);
  };
  if (!keyPem.trim()) throw new ConfigError(`choudoufu ${tag}: no choudoufu release key is pinned in this terragucci release, so there is nothing to verify ${file} against`);
  const key = publicKey(keyPem, "choudoufu's pinned release key");
  const digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  const checked = <T>(part: keyof typeof CHOUDOUFU_BUNDLES, check: () => T): T => {
    if (bundles[part] === undefined) refuse(part, "the release publishes no such file, so it is not a signed release");
    try {
      return check();
    } catch (e) {
      if (e instanceof AttestationError || e instanceof SyntaxError) return refuse(part, e.message);
      throw e;
    }
  };
  checked("signature", () => verifySignature(bundles.signature, archive, key));
  const statement = checked("provenance", () => verifyAttestation(bundles.provenance, digest, PROVENANCE_TYPE, key, "provenance"));
  const p = (statement.predicate ?? {}) as Provenance;
  const builder = p.runDetails?.builder?.id;
  if (builder !== choudoufuBuilder(version)) refuse("provenance", `the provenance names its builder ${typeof builder === "string" ? builder : "as nothing"}, not ${choudoufuBuilder(version)}`);
  const ext = p.buildDefinition?.externalParameters;
  if (ext?.tag !== tag) refuse("provenance", `the provenance says it built ${typeof ext?.tag === "string" ? ext.tag : "no tag"}, not ${tag}`);
  const commit = ext?.sourceRef;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) refuse("provenance", "the provenance names no source commit");
  const source = `git+https://github.com/INTENTIUS/choudoufu@refs/tags/${tag}`;
  if (!(p.buildDefinition?.resolvedDependencies ?? []).some((d) => d.uri === source && d.digest?.gitCommit === commit)) {
    refuse("provenance", `the provenance does not name ${source} at ${commit as string} as its source`);
  }
  checked("sbom", () => verifyAttestation(bundles.sbom, digest, SPDX_TYPE, key, "SBOM attestation"));
}

/** The bundle beside a release file, or undefined when the release publishes none. */
async function bundle(url: string): Promise<string | undefined> {
  const res = await fetch(url);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new ConfigError(`${url} answered ${res.status}`);
  return res.text();
}

export interface InstallOptions {
  /** choudoufu only: verify the release's signature, provenance and SBOM attestation before the binary is installed. */
  verify?: boolean;
  /** The release key to verify against, as PEM. Default: CHOUDOUFU_RELEASE_KEY. */
  key?: string;
}

/** Install `tool` at `version` and return the directory holding it. An existing install is reused, with `verify` only one that was verified. */
export async function install(tool: Tool, version: string, dir = installDir(tool, version), options: InstallOptions = {}): Promise<string> {
  if (options.verify && tool !== "choudoufu") throw new ConfigError(`--verify checks choudoufu releases, and ${tool} is not choudoufu`);
  const keyPem = options.key ?? CHOUDOUFU_RELEASE_KEY;
  if (options.verify && !keyPem.trim()) throw new ConfigError("--verify: no choudoufu release key is pinned in this terragucci release, so there is nothing to verify a release against");
  const target = join(dir, tool);
  const verified = join(dir, ".verified");
  if (existsSync(target) && (!options.verify || existsSync(verified))) return dir;
  const r = release(tool, version);
  const [archive, sums] = await Promise.all([get(r.url), get(r.sums)]);
  const actual = createHash("sha256").update(archive).digest("hex");
  const expected = expectedSum(sums.toString("utf-8"), r.file);
  if (actual !== expected) throw new ConfigError(`${r.file} has sha256 ${actual}, but the release lists ${expected}`);
  if (options.verify) {
    const [signature, provenance, sbom] = await Promise.all(Object.values(CHOUDOUFU_BUNDLES).map((ext) => bundle(`${r.url}.${ext}`)));
    verifyChoudoufu(version, r.file, archive, { signature, provenance, sbom }, keyPem);
  }

  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${tool}.${process.pid}`);
  if (r.kind === "zip") writeFileSync(tmp, unzipEntry(archive, tool));
  else if (r.kind === "binary") writeFileSync(tmp, archive);
  else {
    const staging = `${tmp}.d`;
    mkdirSync(staging, { recursive: true });
    execFileSync("tar", ["-xz", "-C", staging, r.member ?? tool], { input: archive });
    renameSync(join(staging, r.member ?? tool), tmp);
    rmSync(staging, { recursive: true, force: true });
  }
  chmodSync(tmp, 0o755);
  renameSync(tmp, target);
  if (options.verify) writeFileSync(verified, `${r.file}\n`);
  return dir;
}
