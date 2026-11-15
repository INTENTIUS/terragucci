/**
 * `terragucci modules adopt <dir>`: move a module kept in the repository, and
 * called by relative path, to the source it is published at, caller by caller.
 *
 * A local module cannot be staged: every root that calls it gets a change to
 * it in the same commit. Once each call names a pinned source, a change to the
 * module is a release, and `terragucci rollout` moves the roots in waves.
 * Adopting is the step that gets each call there, and it uses the same path:
 * a rollout whose `from` is the local path and whose `to` is the published
 * version (./rollout/adopt.ts). The waves, the gate, the pull request per wave
 * and `terragucci respond rollout` are the rollout's.
 *
 * The module has to be published already; this command does not publish it.
 * The source is the one the config publishes to (`modules.publish`
 * `git-tags` or an `oci://` address, or `modules.registry`), or `source` when
 * it is given: `git::<url>//<dir>`, `oci://<host>/<repository>` or a registry
 * address, with no pin. The version is the one given or the newest published.
 *
 * Before any wave, a git source is cloned at the tag and its files are
 * compared with the directory's, because the plan of each wave can show no
 * changes only when they match. A directory that differs from its release
 * is refused, with the files that differ.
 *
 * Calls inside other modules are left as written: a rollout reads roots only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, relative } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { checkMode, ConfigError, findConfig, loadConfig, resolveRepo, type ResolvedSettings } from "./config";
import { findRoots } from "./detect";
import { sourceUrl } from "./publish/index";
import { ociRepoFor, newestPublished } from "./rollout/discover";
import { adoptCalls, LOCAL_FROM, pinnedSource, type AdoptKind, type AdoptTarget } from "./rollout/adopt";
import { rollout, rolloutExit, describeRollout, type RolloutOptions, type RolloutResult } from "./rollout";
import type { RolloutForge } from "./rollout/forge";
import { loadHclParser } from "./rollout/parser";
import { isLocalSource, localTarget } from "./rollout/range";
import { parseRegistrySource, registryAddress } from "./publish/registry";
import { compareSemver, formatSemver, parseSemver, type Semver } from "./publish/semver";
import { detectShape } from "./shape";

export interface AdoptOptions {
  /** `dry-run` (the default) opens nothing; `apply` opens the next wave's pull requests. */
  mode?: "dry-run" | "apply";
  /** List the callers and plan the waves without asking the forge for anything. */
  tableOnly?: boolean;
  config?: string;
  /** Limit to the roots under this directory or equal to it. */
  root?: string;
  /** The published source without its pin. Default: where `modules.publish` or `modules.registry` publishes the directory. */
  source?: string;
  /** The published version. Default: the newest published. */
  version?: string;
  parser?: Hcl2Json;
  /**
   * The directory holding the module's files as published at `version`, to
   * compare with the local directory. Default: for a git source, a clone at
   * the tag; for an OCI or registry source nothing is fetched.
   */
  published?: (target: AdoptTarget, version: string) => string | undefined | Promise<string | undefined>;
  /** Passed to the rollout: the forge, fetch, env and the rest. */
  rollout?: Pick<RolloutOptions, "fetch" | "env" | "forge" | "registryFetch">;
}

export interface AdoptCaller {
  /** A root, or a module that is not one. */
  dir: string;
  file: string;
  call: string;
  state: "local" | "adopted" | "left";
  /** Why a call is left as written. */
  reason?: string;
}

export interface AdoptResult {
  mode: "dry-run" | "apply";
  dir: string;
  target: AdoptTarget;
  version: string;
  /** What each call of the module reads at that version. */
  source: string;
  /** Whether the published files were compared with the directory, and the files that differ. */
  compared: boolean;
  callers: AdoptCaller[];
  /** Absent when no root has a call to move. */
  rollout?: RolloutResult;
}

const SKIP = new Set(["node_modules", ".terraform", ".terragrunt-cache", ".git"]);

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (SKIP.has(name)) continue;
      const child = rel ? posix.join(rel, name) : name;
      if (statSync(join(root, child)).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk("");
  return out;
}

/** The files that differ between two directories: present in one, or with other bytes. */
export function differingFiles(a: string, b: string): string[] {
  const left = listFiles(a);
  const right = listFiles(b);
  const names = [...new Set([...left, ...right])].sort();
  return names.filter((n) => !left.includes(n) || !right.includes(n) || !readFileSync(join(a, n)).equals(readFileSync(join(b, n))));
}

/** `git::<url>//<subdir>` as the clone URL and the directory in it. */
export function gitParts(module: string): { url: string; subdir: string } {
  const m = /^(?:git::)?(.*?[^:/])\/\/(.+)$/.exec(module);
  if (!m) throw new ConfigError(`${module} is not a git source with a directory: write it as git::<url>//<directory>`);
  return { url: m[1]!, subdir: m[2]! };
}

function sourceKind(source: string): AdoptKind {
  if (source.startsWith("oci://")) return "oci";
  if (/^git::|\.git(\/|$)/.test(source) || /^(ssh|git|file):\/\//.test(source)) return "git";
  if (parseRegistrySource(source)) return "registry";
  throw new ConfigError(`--source ${source} is none of git::<url>//<directory>, oci://<host>/<repository> or a registry address <host>/<namespace>/<name>/<system>`);
}

/** Where `dir` is published, from `source` or from the config. */
export function adoptTarget(repo: string, dir: string, settings: ResolvedSettings, source?: string): AdoptTarget {
  if (source) {
    if (/[?]/.test(source)) throw new ConfigError(`--source ${source} carries a pin; give the address without the ?ref= or ?tag=, and the version with --version`);
    const kind = sourceKind(source);
    if (kind === "git") {
      const url = source.startsWith("git::") ? source : `git::${source}`;
      return { dir, kind, module: gitParts(url).subdir === dir ? url : `${url.replace(/\/+$/, "")}//${dir}` };
    }
    return { dir, kind, module: source.replace(/\/+$/, "") };
  }
  const publish = settings.modules?.publish;
  const targets = Array.isArray(publish) ? publish : publish ? [publish] : [];
  if (targets.includes("git-tags")) {
    let origin: string;
    try {
      origin = execFileSync("git", ["-C", repo, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      throw new ConfigError("modules.publish is git-tags and this checkout has no origin remote, so there is no address to name; pass --source git::<url>//" + dir);
    }
    return { dir, kind: "git", module: `git::${sourceUrl(origin)}//${dir}` };
  }
  const oci = targets.find((t) => t.startsWith("oci://"));
  if (oci) return { dir, kind: "oci", module: ociRepoFor(oci, dir) };
  const reg = settings.modules?.registry;
  if (reg) return { dir, kind: "registry", module: registryAddress(reg, dir).source };
  throw new ConfigError(`nothing says where ${dir} is published: set modules.publish (git-tags or an oci:// address) or modules.registry, or pass --source`);
}

function remoteTags(url: string, dir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-remote", "--tags", "--refs", url, `refs/tags/${dir}/v*`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return out.split("\n").filter(Boolean).map((l) => l.split("\t").pop()!.replace(/^refs\/tags\//, ""));
  } catch (e) {
    throw new ConfigError(`cannot list the tags at ${url}: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").pop()}`);
  }
}

/** The version to adopt: the one given, or the newest the source's releases list. */
async function versionOf(repo: string, target: AdoptTarget, given: string | undefined, options: AdoptOptions): Promise<string> {
  if (given) {
    if (!parseSemver(given)) throw new ConfigError(`--version ${given} is not a version such as 1.4.0`);
    return given.replace(/^v/, "");
  }
  let best: Semver | undefined;
  let found: string | undefined;
  if (target.kind === "git") {
    const url = gitParts(target.module).url;
    for (const tag of remoteTags(url, target.dir)) {
      const v = parseSemver(tag.slice(target.dir.length + 1));
      if (v && (!best || compareSemver(v, best) > 0)) best = v;
    }
    found = best ? formatSemver(best) : undefined;
  } else {
    found = (await newestPublished({ module: target.dir, repos: [], oci: target.kind === "oci" ? [target.module] : [], registries: target.kind === "registry" ? [target.module] : [], env: options.rollout?.env, fetch: options.rollout?.registryFetch }))?.version;
  }
  if (!found) throw new ConfigError(`found no published version of ${target.dir} at ${target.module}; publish it first (terragucci publish) or name the version with --version`);
  return found;
}

/** The module's files as published, for a git source cloned at the tag. Undefined when nothing is fetched. */
async function publishedFiles(target: AdoptTarget, version: string, options: AdoptOptions): Promise<{ dir: string; cleanup: () => void } | undefined> {
  if (options.published) {
    const dir = await options.published(target, version);
    return dir ? { dir, cleanup: () => {} } : undefined;
  }
  if (target.kind !== "git") return undefined;
  const { url, subdir } = gitParts(target.module);
  const ref = `${target.dir}/v${version}`;
  const work = mkdtempSync(join(tmpdir(), "terragucci-adopt-"));
  const cleanup = () => rmSync(work, { recursive: true, force: true });
  try {
    execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", ref, url, work], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    cleanup();
    throw new ConfigError(`${target.module} has no tag ${ref}: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim().split("\n").pop()}. Publish the version first: ${PUBLISH_STEPS}`);
  }
  return { dir: join(work, subdir), cleanup };
}

const PUBLISH_STEPS = "run terragucci publish (modules.publish: git-tags) from the repository that holds the module, or the release job, so that the tag <dir>/v<version> exists at the source";

/** Every directory with `.tf` files that is not a root or inside `dir`, for the calls of the module a rollout does not move. */
function otherModules(repo: string, roots: Set<string>, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(repo, rel);
    const names = readdirSync(abs).sort();
    if (rel && names.some((n) => n.endsWith(".tf")) && !roots.has(rel) && rel !== dir && !rel.startsWith(`${dir}/`)) out.push(rel);
    for (const n of names) {
      if (n.startsWith(".") || SKIP.has(n)) continue;
      if (statSync(join(abs, n)).isDirectory()) walk(rel ? posix.join(rel, n) : n);
    }
  };
  walk("");
  return out;
}

/** The local calls in a directory's `.tf` files, with where each points. */
async function localCallsIn(repo: string, dir: string, parser: Hcl2Json): Promise<Array<{ file: string; call: string; target: string }>> {
  const out: Array<{ file: string; call: string; target: string }> = [];
  for (const f of readdirSync(join(repo, dir)).filter((n) => n.endsWith(".tf")).sort()) {
    const file = dir === "." ? f : posix.join(dir, f);
    const tree = (await parser.parse(file, readFileSync(join(repo, file), "utf-8"))) as Record<string, unknown>;
    for (const [name, bodies] of Object.entries((tree.module as Record<string, Record<string, unknown>[]> | undefined) ?? {})) {
      for (const body of bodies) if (typeof body.source === "string" && isLocalSource(body.source)) out.push({ file, call: `module.${name}`, target: localTarget(file, body.source) });
    }
  }
  return out;
}

export async function adoptModule(cwd: string, dirArg: string, options: AdoptOptions = {}): Promise<AdoptResult> {
  const mode = options.mode ?? "dry-run";
  let repo: string;
  try {
    repo = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new ConfigError("terragucci modules adopt runs in a git repository");
  }
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  if (config.projects) throw new ConfigError("terragucci modules adopt edits the roots of one repository, so it runs in a repository with its roots, not a control repository");
  const settings = resolveRepo(config);
  const refused = detectShape(repo, settings).refuses("rollouts");
  if (refused) throw new ConfigError(`terragucci modules adopt: ${refused}`);

  const dir = (isAbsolute(dirArg) ? relative(repo, dirArg) : posix.normalize(dirArg.replace(/\\/g, "/"))).replace(/^\.\//, "").replace(/\/+$/, "");
  if (!dir || dir === "." || dir.startsWith("..") || !existsSync(join(repo, dir)) || !statSync(join(repo, dir)).isDirectory()) throw new ConfigError(`${dirArg} is not a directory in this repository`);
  if (!readdirSync(join(repo, dir)).some((n) => n.endsWith(".tf"))) throw new ConfigError(`${dir} holds no .tf files, so it is not a module`);

  const parser = options.parser ?? (await loadHclParser("terragucci modules adopt reads module calls"));
  const target = adoptTarget(repo, dir, settings, options.source);
  const version = await versionOf(repo, target, options.version, options);

  // A published archive holds the directory alone: a call out of it would not resolve.
  if (target.kind !== "git") {
    const outward = (await localCallsIn(repo, dir, parser)).filter((c) => c.target !== dir && !c.target.startsWith(`${dir}/`));
    if (outward.length > 0) throw new ConfigError(`${dir} calls local modules outside itself (${outward.map((c) => `${c.file} ${c.call} -> ${c.target}`).join(", ")}), which a ${target.kind} release of the directory does not hold; adopt those first or use a git source`);
  }

  let compared = false;
  const files = await publishedFiles(target, version, options);
  if (files) {
    try {
      const differ = differingFiles(join(repo, dir), files.dir);
      if (differ.length > 0) throw new ConfigError(`${dir} differs from its release ${version} in ${differ.join(", ")}, so the plans of the waves would show changes. Publish the directory as it is now, or name the version that matches`);
      compared = true;
    } finally {
      files.cleanup();
    }
  }

  let roots = findRoots(repo, settings.roots);
  if (options.root) {
    const under = options.root.replace(/^\.\//, "").replace(/\/+$/, "");
    roots = roots.filter((r) => r === under || r.startsWith(`${under}/`) || under === ".");
  }
  const callers: AdoptCaller[] = [];
  const moving: string[] = [];
  for (const root of roots) {
    const found = await adoptCalls(repo, root, target, parser);
    for (const c of found) callers.push({ dir: root, file: c.file, call: c.call, state: c.local ? "local" : "adopted" });
    if (found.some((c) => c.local)) moving.push(root);
  }
  const rootSet = new Set(findRoots(repo, settings.roots));
  for (const m of otherModules(repo, rootSet, dir)) {
    for (const c of (await localCallsIn(repo, m, parser)).filter((x) => x.target === dir)) {
      callers.push({ dir: m, file: c.file, call: c.call, state: "left", reason: "a module's call; a rollout reads roots, so it stays a local path" });
    }
  }
  callers.sort((a, b) => a.dir.localeCompare(b.dir) || a.call.localeCompare(b.call));

  const result: AdoptResult = { mode, dir, target, version, source: pinnedSource(target, version), compared, callers };
  if (moving.length === 0) return result;
  const forge = options.tableOnly ? { forge: () => offlineForge(repo) } : {};
  result.rollout = await rollout(repo, { ...options.rollout, ...forge, kind: "module", name: dir, from: LOCAL_FROM, to: version, adopt: target, only: moving, mode, ...(options.config ? { config: options.config } : {}), parser });
  return result;
}

/** A forge that has no pull requests, for a plan that asks none. The default branch is origin's. */
function offlineForge(repo: string): RolloutForge {
  return {
    async defaultBranch() {
      try {
        return execFileSync("git", ["-C", repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/^origin\//, "");
      } catch {
        return "main";
      }
    },
    async findPullRequest() {
      return null;
    },
    async createPullRequest() {
      throw new Error("a plan that asks no forge opens no pull request");
    },
    async commitChecks() {
      return [];
    },
    async listPullRequests() {
      return [];
    },
  };
}

/** 0 when the rollout ran or finished, or there was nothing to move; 1 when it stopped; 3 when it waits. */
export function adoptExit(result: AdoptResult): number {
  return result.rollout ? rolloutExit(result.rollout) : 0;
}

export function describeAdopt(result: AdoptResult): string {
  const lines = [`${result.dir} at ${result.version}: each local call becomes ${result.source}`, `published files ${result.compared ? "match the directory" : "were not compared with the directory (only a git source is fetched here)"}`, ""];
  const header = ["dir", "call", "file", "state"];
  const cells = result.callers.map((c) => [c.dir, c.call, c.file, c.state === "local" ? "to adopt" : c.state === "adopted" ? "adopted" : `left: ${c.reason}`]);
  if (cells.length === 0) lines.push(`no module call names ${result.dir} by a relative path`);
  else {
    const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
    const line = (c: string[]) => c.map((x, i) => (i < c.length - 1 ? x.padEnd(widths[i]!) : x)).join("  ").trimEnd();
    lines.push(line(header), ...cells.map(line));
  }
  if (result.rollout) lines.push("", describeRollout(result.rollout));
  else if (cells.length > 0) lines.push("", "no root has a local call to move");
  return lines.join("\n");
}

const ADOPT_USAGE = "usage: terragucci modules adopt <dir> [--source <address>] [--version <v>] [--root <dir>] [--dry-run] [--mode dry-run|apply] [--config <file>]";

/** `terragucci modules adopt` arguments (after `modules adopt`) as the directory and options. */
export function adoptArgs(args: string[], flags: Record<string, string | true>): { dir: string; options: AdoptOptions } {
  const value = (k: string): string | undefined => {
    const v = flags[k];
    if (v === true) throw new ConfigError(`--${k} needs a value`);
    return v;
  };
  if (args.length !== 1) throw new ConfigError(ADOPT_USAGE);
  return {
    dir: args[0]!,
    options: {
      mode: checkMode(value("mode") ?? "dry-run"),
      tableOnly: flags["dry-run"] === true,
      ...(value("config") ? { config: value("config") } : {}),
      ...(value("root") ? { root: value("root") } : {}),
      ...(value("source") ? { source: value("source") } : {}),
      ...(value("version") ? { version: value("version") } : {}),
    },
  };
}
