/**
 * Prepared images: a provider mirror the customer builds `FROM` terragucci's
 * image, in their own CI and registry, so `init` takes every provider from the
 * image and never reaches a registry. Downloading in the job stays the
 * default; this is opt-in.
 *
 * `terragucci image recipe` writes the files to build it: a Dockerfile, a CLI
 * config with a `filesystem_mirror`, a build script, and one small module per
 * distinct lock file whose `required_providers` hold each provider at exactly
 * the version the lock file pins. The image runs `providers mirror` on each
 * module for the platform it is built for, so the lock file's hashes check
 * every download. terragucci builds and pushes nothing.
 *
 * `terragucci check-mirror` is tf-check's step when `image.mirror` is set:
 * every provider every lock file pins must be in the image's mirror for the
 * job's platform. A gap warns the first time; when the same gap was already
 * in the lock files at the commit before (the previous run), it fails.
 *
 * The lock walk, the grouping, the mirror modules and the mirror check are
 * chant's terraform lexicon's (`/registry`, chant#4564), shared with the
 * provider network mirror. The CLI hands them in from `mirrorCode()` when
 * the installed chant has them; the copies here are the fallback until
 * terragucci's chant pin carries them. The Dockerfile, CLI config and build
 * script stay here, as words and templates.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { imageFor, imageReference, terragruntImage } from "./images";
import { MIRROR_DIR, type Binary } from "./config";
import { LOCK_FILE, readLock } from "./rollout/lock";
import type { CheckResult } from "./check";
import { chantRegistry } from "./chant-next";

/** Directories a lock file is never looked for in: caches and what init or a package manager writes. */
const SKIP = new Set([".git", ".terraform", ".terragrunt-cache", "node_modules", "cdktf.out", ".terragucci"]);

/** The repo's lock files, as `/`-separated paths relative to the repo, sorted. */
export function lockFiles(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      if (n === LOCK_FILE) {
        out.push(posix.normalize(relative(repo, p).split("\\").join("/")));
        continue;
      }
      if (SKIP.has(n)) continue;
      let dirLike = false;
      try {
        dirLike = statSync(p).isDirectory();
      } catch {
        dirLike = false;
      }
      if (dirLike) walk(p);
    }
  };
  walk(repo);
  return out.sort();
}

/** One provider one lock file pins. */
export interface LockEntry {
  /** The lock file, relative to the repo. */
  lock: string;
  /** The full address, `registry.opentofu.org/hashicorp/aws`. */
  address: string;
  version: string;
}

/** Every provider each of `files` pins. */
export function lockEntries(repo: string, files: string[] = lockFiles(repo)): LockEntry[] {
  return files.flatMap((lock) => [...readLock(readFileSync(join(repo, lock), "utf-8"))].map(([address, version]) => ({ lock, address, version })));
}

/** The job's platform as the binary names it: `linux_amd64`. */
export function hostPlatform(platform: string = process.platform, arch: string = process.arch): string {
  const a = arch === "x64" ? "amd64" : arch === "ia32" ? "386" : arch;
  return `${platform}_${a}`;
}

/**
 * Whether the mirror holds the provider at the version for the platform, in
 * either layout a `filesystem_mirror` reads: packed (what `providers mirror`
 * writes, a zip per platform) or unpacked (a directory per platform).
 */
export function mirrorHas(mirror: string, address: string, version: string, platform: string): boolean {
  const parts = address.toLowerCase().split("/");
  if (parts.length !== 3) return false;
  const dir = join(mirror, ...parts);
  const type = parts[2]!;
  return existsSync(join(dir, `terraform-provider-${type}_${version}_${platform}.zip`)) || existsSync(join(dir, version, platform));
}

/** Reads a lock file at the commit before the one checked; undefined when that commit or the file is not there. */
export type PreviousLock = (lock: string) => string | undefined;

/** The lock files at the previous run's commit: the checked commit's first parent, from git. Undefined when git has no parent to read. */
export function previousFromGit(repo: string): PreviousLock | undefined {
  const parent = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^"], { cwd: repo, encoding: "utf-8" });
  if (parent.status !== 0) return undefined;
  const sha = parent.stdout.trim();
  // git show takes a path from the repo's top, and the repo may be a directory under it.
  const prefix = spawnSync("git", ["rev-parse", "--show-prefix"], { cwd: repo, encoding: "utf-8" }).stdout?.trim() ?? "";
  return (lock) => {
    const r = spawnSync("git", ["show", `${sha}:${prefix}${lock}`], { cwd: repo, encoding: "utf-8" });
    return r.status === 0 ? r.stdout : undefined;
  };
}

export interface MirrorCheckOptions {
  /** The job's platform. Default: the one this process runs on. */
  platform?: string;
  /** The lock files at the previous run's commit. Default: the commit's first parent, from git. Pass null for none. */
  previous?: PreviousLock | null;
  /** The mirror code (`mirrorCode()`). Default: the copies here. */
  code?: MirrorCode;
}

/**
 * tf-check's mirror step. Each lock entry the mirror lacks is a gap. A gap
 * whose lock file already pinned the same provider at the same version at
 * the previous run's commit was warned about there, so it fails now; any
 * other gap warns. Nothing falls back to a download: the job's own init
 * fails on a provider the mirror lacks, and this says why.
 */
export function checkMirror(repo: string, mirror: string, options: MirrorCheckOptions = {}): CheckResult {
  const platform = options.platform ?? hostPlatform();
  const code = options.code ?? OWN_MIRROR_CODE;
  const files = code.lockFiles(repo);
  const log: string[] = [];
  const report: string[] = [];
  if (!existsSync(mirror)) {
    const line = `FAILED image mirror: ${mirror} is not in the job's image; image.mirror names a prepared image's provider mirror. Build the image terragucci image recipe writes and name it in image.name, or remove image.mirror`;
    return { ok: false, log: [line], report: ["### Provider mirror", "", `- ${line.replace(/^FAILED /, "")}`] };
  }
  const entries = code.lockEntries(repo, files);
  const gaps = entries.filter((e) => !code.mirrorHas(mirror, e.address, e.version, platform));
  if (files.length === 0) log.push("image mirror: no lock file in the repo, so there is nothing to check");
  if (gaps.length === 0) {
    if (files.length > 0) log.push(`image mirror: ${mirror} covers every provider in ${plural(files.length, "lock file")} for ${platform}`);
    return { ok: true, log, report: [] };
  }
  const previous = options.previous === null ? undefined : (options.previous ?? previousFromGit(repo));
  const before = new Map<string, Map<string, string>>();
  const priorLock = (lock: string): Map<string, string> => {
    if (!before.has(lock)) {
      const text = previous?.(lock);
      before.set(lock, text === undefined ? new Map() : readLock(text));
    }
    return before.get(lock)!;
  };
  const stale = gaps.filter((g) => priorLock(g.lock).get(g.address) === g.version);
  const fresh = gaps.filter((g) => !stale.includes(g));
  const rebuild = "rebuild the image with the files terragucci image recipe writes, push it and name it in image.name";
  const describe = (g: LockEntry): string => `${g.address} ${g.version} (${g.lock})`;
  report.push("### Provider mirror", "");
  for (const g of stale) {
    log.push(`FAILED image mirror: ${describe(g)} is not in ${mirror} for ${platform}, and was not at the run before either; ${rebuild}`);
    report.push(`- stale since the run before: \`${g.address}\` ${g.version} in \`${g.lock}\`, not in the image's mirror for ${platform}`);
  }
  for (const g of fresh) {
    log.push(`WARNING image mirror: ${describe(g)} is not in ${mirror} for ${platform}; ${rebuild}. The next run fails if the image still lacks it`);
    report.push(`- new in this change: \`${g.address}\` ${g.version} in \`${g.lock}\`, not in the image's mirror for ${platform}; the next run fails if the image still lacks it`);
  }
  report.push("", `To clear it, ${rebuild}.`);
  return { ok: stale.length === 0, log, report };
}

/** Lock files that pin the same providers at the same versions, mirrored once. */
export interface MirrorGroup {
  locks: string[];
  /** The first lock file's text, which `providers mirror` checks downloads against. */
  text: string;
  providers: Map<string, string>;
}

/** The repo's lock files grouped by what they pin; a lock file that pins nothing is left out. */
function ownGroups(repo: string, locks: string[] = lockFiles(repo)): MirrorGroup[] {
  const groups = new Map<string, MirrorGroup>();
  for (const lock of locks) {
    const text = readFileSync(join(repo, lock), "utf-8");
    const providers = readLock(text);
    if (providers.size === 0) continue;
    const key = [...providers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([a, v]) => `${a}=${v}`).join("\n");
    const g = groups.get(key);
    if (g) g.locks.push(lock);
    else groups.set(key, { locks: [lock], text, providers });
  }
  return [...groups.values()];
}

/** One module per group, under `dir`: each provider at exactly its locked version, with the lock file beside it. */
function ownModules(groups: MirrorGroup[], options: { dir?: string } = {}): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  groups.forEach((g, i) => {
    const dir = `${options.dir ?? "mirror"}/${String(i + 1).padStart(2, "0")}`;
    const required = [...g.providers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([address, version], n) => `    p${n} = { source = "${address}", version = "= ${version}" }`);
    files.push({
      path: `${dir}/versions.tf`,
      content: [`# The providers ${g.locks.join(", ")} lock${g.locks.length === 1 ? "s" : ""}, each at exactly its locked version.`, "terraform {", "  required_providers {", ...required, "  }", "}", ""].join("\n"),
    });
    // The lock file itself, so providers mirror checks each download against its hashes.
    files.push({ path: `${dir}/${LOCK_FILE}`, content: g.text });
  });
  return files;
}

/** The mirror code the recipe and the check run: chant's lexicon's (chant#4564), or the copies here. */
export interface MirrorCode {
  lockFiles(repo: string): string[];
  lockEntries(repo: string, files?: string[]): LockEntry[];
  mirrorGroups(repo: string, locks?: string[]): MirrorGroup[];
  mirrorModules(groups: MirrorGroup[], options?: { dir?: string }): { path: string; content: string }[];
  mirrorHas(mirror: string, address: string, version: string, platform: string): boolean;
}

/** The copies here. */
export const OWN_MIRROR_CODE: MirrorCode = { lockFiles, lockEntries, mirrorGroups: ownGroups, mirrorModules: ownModules, mirrorHas };

/** chant's mirror code when the installed chant's `/registry` has it (chant#4564), else the copies here. */
export async function mirrorCode(): Promise<MirrorCode> {
  const lexicon = (await chantRegistry()) as (Partial<MirrorCode> & object) | undefined;
  const names = ["lockFiles", "lockEntries", "mirrorGroups", "mirrorModules", "mirrorHas"] as const;
  if (!lexicon || !names.every((n) => typeof lexicon[n] === "function")) return OWN_MIRROR_CODE;
  const chant = lexicon as MirrorCode;
  return {
    ...chant,
    // terragucci's check compares lower case, as `providers mirror` writes its directories.
    mirrorHas: (mirror, address, version, platform) => address.split("/").length === 3 && chant.mirrorHas(mirror, address.toLowerCase(), version, platform),
  };
}

/** A file the recipe writes, relative to its output directory. */
export interface RecipeFile {
  path: string;
  content: string;
  mode?: number;
}

export interface RecipeOptions {
  /** The image the recipe builds FROM. Default: the terragucci image for the binary, the one init names. */
  from?: string;
  /** The binary in the base image that runs `providers mirror`. Default: tofu, or the repo's binary. */
  binary?: Binary;
  /** A Terragrunt repo: the base is the Terragrunt image. */
  terragrunt?: boolean;
  /** Platforms the build script builds, Docker's form: `linux/amd64`. Default linux/amd64. */
  platforms?: string[];
  /** Where the mirror goes in the image. Default MIRROR_DIR. */
  mirror?: string;
  /** The mirror code (`mirrorCode()`). Default: the copies here. */
  code?: MirrorCode;
}

export interface Recipe {
  from: string;
  /** The lock files the mirror covers. */
  locks: string[];
  /** Distinct providers at their versions, `address version`. */
  providers: string[];
  platforms: string[];
  files: RecipeFile[];
}

/** The terragucci image a repo's pipeline runs in by default, which the recipe builds FROM. */
export function baseImage(binary: Binary, terragrunt: boolean): string {
  return imageReference(terragrunt ? (binary === "choudoufu" ? imageFor("choudoufu") : terragruntImage()) : imageFor(binary));
}

export const RECIPE_MARKER = "# Generated by terragucci image recipe from the repo's lock files. Rebuild the image when a lock file or the terragucci version changes.";

const PLATFORM = /^[a-z0-9]+\/[a-z0-9]+$/;

/**
 * The recipe for a repo: one mirror module per distinct lock file, a CLI
 * config that installs providers only from the mirror, a Dockerfile and a
 * build script. Throws when a platform is not `os/arch`.
 */
export function planRecipe(repo: string, options: RecipeOptions = {}): Recipe {
  const binary = options.binary ?? "tofu";
  // The Terragrunt image carries OpenTofu, which mirrors any address, a Terraform one too.
  const mirrorBinary = options.terragrunt && binary !== "choudoufu" ? "tofu" : binary;
  const from = options.from ?? baseImage(binary, options.terragrunt === true);
  const platforms = options.platforms?.length ? [...new Set(options.platforms)] : ["linux/amd64"];
  const bad = platforms.filter((p) => !PLATFORM.test(p));
  if (bad.length) throw new Error(`--platform ${bad.join(", ")}: name a platform as os/arch, such as linux/amd64`);
  const mirror = options.mirror ?? MIRROR_DIR;
  const code = options.code ?? OWN_MIRROR_CODE;
  const groups = code.mirrorGroups(repo, code.lockFiles(repo));
  const files: RecipeFile[] = code.mirrorModules(groups, { dir: "mirror" });
  const providers = [...new Set(groups.flatMap((g) => [...g.providers].map(([a, v]) => `${a} ${v}`)))].sort();
  files.push({
    path: "terragucci.tfrc",
    content: [
      RECIPE_MARKER,
      "# init installs every provider from the image's mirror and reaches no registry.",
      "provider_installation {",
      "  filesystem_mirror {",
      `    path = "${mirror}"`,
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  files.push({
    path: "Dockerfile",
    content: [
      RECIPE_MARKER,
      "# Build it in your own CI with build.sh, push it to your registry, and name it in terragucci.yml:",
      "#   image:",
      "#     name: <the reference you pushed>",
      `#     mirror: ${mirror === MIRROR_DIR ? "true" : mirror}`,
      `FROM ${from}`,
      "ARG TARGETOS=linux",
      "ARG TARGETARCH=amd64",
      "COPY mirror/ /tmp/terragucci-mirror/",
      groups.length
        ? `RUN set -eu; for d in /tmp/terragucci-mirror/*/; do ${mirrorBinary} -chdir="$d" providers mirror -platform="\${TARGETOS}_\${TARGETARCH}" ${mirror}; done; rm -rf /tmp/terragucci-mirror`
        : `RUN mkdir -p ${mirror}; rm -rf /tmp/terragucci-mirror`,
      `COPY terragucci.tfrc ${posix.dirname(mirror)}/terragucci.tfrc`,
      `ENV TF_CLI_CONFIG_FILE=${posix.dirname(mirror)}/terragucci.tfrc`,
      "",
    ].join("\n"),
  });
  if (groups.length === 0) files.push({ path: "mirror/.keep", content: "" });
  files.push({
    path: "build.sh",
    mode: 0o755,
    content: [
      "#!/bin/sh",
      RECIPE_MARKER,
      "# Builds the prepared image and pushes it to IMAGE, a reference in your registry.",
      "set -eu",
      ': "${IMAGE:?set IMAGE to the reference to push, such as registry.example.com/infra/terragucci-mirror:1}"',
      'cd "$(dirname "$0")"',
      `docker buildx build --platform ${platforms.join(",")} --push -t "$IMAGE" .`,
      "",
    ].join("\n"),
  });
  return { from, locks: groups.flatMap((g) => g.locks).sort(), providers, platforms, files };
}

/** What `image recipe` wrote, for the terminal. */
export function describeRecipe(recipe: Recipe, out: string): string {
  const lines = [
    `wrote ${out}: a Dockerfile FROM ${recipe.from}, its CLI config and build.sh, for ${recipe.platforms.join(", ")}`,
    recipe.locks.length
      ? `the mirror covers ${plural(recipe.providers.length, "provider version")} from ${plural(recipe.locks.length, "lock file")}`
      : "no lock file pins a provider, so the mirror is empty; commit the roots' .terraform.lock.hcl files and run this again",
    `next: run ${out}/build.sh in your CI with IMAGE set, then name the image in terragucci.yml under image.name with image.mirror: true, and run terragucci init`,
  ];
  return lines.join("\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
