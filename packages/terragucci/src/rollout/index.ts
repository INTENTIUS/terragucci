/**
 * tf-rollout: roll a module version, or a provider version, out as one pull
 * request per wave, in every project the wave reaches.
 *
 *   terragucci rollout <module> [<version>]            move a module's pin
 *   terragucci rollout --provider <address> <version>  move the lock file
 *
 * Each run reads where the rollout stands and does at most one step. It reads
 * every root on each project's default branch: at the old version, at the new
 * one, refused (a floating range, a pin set from a variable, no pin, no lock
 * file), or at some other version. Only roots at the old or new version are in
 * the rollout, so the waves come out the same on every run. Then it walks the
 * waves, reading each wave's pull requests by their branch:
 *
 * - every pull request merged, and every moved root applied on its merge
 *   commit: the wave is done, go on;
 * - a pull request still open, or a merge whose apply has not reported: wait;
 * - a pull request closed unmerged, or an apply that failed: stop, naming it;
 * - no pull request yet: open one per project (`--mode apply`), or say it
 *   would (the dry run, the default).
 *
 * The gate is a fact read on the next run, never a wait. A pull request's
 * branch is cut from the default branch and changes only its roots' files, so
 * a path-diff selection plans exactly those roots. Nothing here writes a
 * default branch or merges anything.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/parse";
import { terragruntDependencies } from "@intentius/chant-lexicon-terraform/pin";
import { checkMode, ConfigError, findConfig, forgeFromHost, loadConfig, parseProjectKey, resolveProject, resolveRepo, type ForgeName, type ResolvedSettings, type TerragucciConfig } from "../config";
import { detectBinary, detectForge, findRoots, hostOfRemote, rootDependencies } from "../detect";
import { DEFAULT_TOKEN_ENV, type Fetch, type ForgeTarget } from "../forge";
import type { Fetch as RegistryFetch } from "../publish/oci";
import { IDENTITY, where, withToken } from "../reconcile";
import { newestPublished, ociRepoFor } from "./discover";
import { appliedState, fetchForge, type ListedPullRequest, type RolloutForge } from "./forge";
import { binaryLocker, LOCK_FILE, lockedProvider, moveLock, readLock, type Locker } from "./lock";
import { loadHclParser } from "./parser";
import { moduleCalls, movePins, pinVersion, shapePin, type ModuleCall } from "./pins";
import { planWaves, type Wave } from "./waves";

export type RolloutKind = "module" | "provider";

export interface RolloutOptions {
  kind: RolloutKind;
  /** The module (a path such as `modules/network`, or its source without the pin), or the provider's address. */
  name: string;
  /** The new version. A module's newest published version when absent. */
  to?: string;
  /** The version being replaced. Read from the roots when they agree on one. */
  from?: string;
  /** `dry-run` (the default) opens nothing; `apply` opens the next wave's pull requests when they are due. */
  mode?: "dry-run" | "apply";
  /** The config file. Default: the repository's own. */
  config?: string;
  fetch?: Fetch;
  env?: Record<string, string | undefined>;
  /** For tests: the forge each project answers through. */
  forge?: (project: { key: string; target?: ForgeTarget }) => RolloutForge;
  parser?: Hcl2Json;
  /** For tests: writes a root's lock file. Default: the project's binary. */
  locker?: (binary: string) => Locker;
  /** For tests: the registry client for OCI discovery. */
  registryFetch?: RegistryFetch;
}

export type RootState = "from" | "to" | "refused" | "elsewhere" | "absent";

export interface RootStatus {
  project: string;
  root: string;
  state: RootState;
  /** At `from` or elsewhere: the version found. */
  version?: string;
  reason?: string;
}

export type PartState = "applied" | "nothing-to-move" | "opened" | "would-open" | "open" | "waiting-apply" | "failed" | "closed" | "not-reached";

export interface PartStatus {
  project: string;
  roots: string[];
  branch: string;
  state: PartState;
  pullRequest?: string;
  pending?: string[];
  failed?: string[];
  /** Files the pull request changes, when it is opened or would be. */
  files?: string[];
  reason?: string;
}

export interface WaveStatus {
  wave: number;
  canary: boolean;
  parts: PartStatus[];
}

export interface Tip {
  rule: string;
  project: string;
  root: string;
  message: string;
}

export interface RolloutResult {
  kind: RolloutKind;
  name: string;
  from?: string;
  to: string;
  /** Where `to` came from, when the rollout found it. */
  discovered?: string;
  mode: "dry-run" | "apply";
  /**
   * `complete`: every wave applied. `opened`/`would-open`: the next wave's pull
   * requests were opened, or would be. `waiting`: one is open, or an apply has
   * not reported. `stopped`: a pull request closed unmerged, or an apply failed.
   */
  status: "complete" | "opened" | "would-open" | "waiting" | "stopped";
  stop?: string;
  waves: WaveStatus[];
  roots: RootStatus[];
  tips: Tip[];
}

/** 0 complete or a step taken, 1 stopped, 3 waiting on a merge or an apply. */
export function rolloutExit(result: RolloutResult): number {
  return result.status === "stopped" ? 1 : result.status === "waiting" ? 3 : 0;
}

// ── projects ─────────────────────────────────────────────────────────────────

interface Project {
  key: string;
  settings: ResolvedSettings;
  /** A checkout of the default branch, which the rollout may write. */
  dir: string;
  base: string;
  forge: RolloutForge;
  /** Commit what is staged and force-push it to `branch`. */
  push(branch: string, files: string[], message: string): void;
  cleanup(): void;
}

function git(dir: string, args: string[], token?: string): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr || (e as Error).message);
    throw new Error(token ? msg.split(token).join("***") : msg);
  }
}

function pusher(dir: string, token?: string): Project["push"] {
  return (branch, files, message) => {
    git(dir, ["add", "--", ...files]);
    git(dir, [...IDENTITY, "commit", "-q", "--no-verify", "-m", message]);
    git(dir, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`], token);
  };
}

/** The forge API target for a remote URL: its host's origin and its path. */
export function targetOfRemote(remote: string): { origin: string; path: string; host: string } | undefined {
  const host = hostOfRemote(remote);
  if (!host) return undefined;
  const http = /^(https?):\/\/(?:[^@/]+@)?[^/]+\/(.+?)(?:\.git)?\/?$/.exec(remote);
  if (http) return { origin: `${http[1]}://${host}`, path: http[2]!, host };
  const other = /^(?:[a-z+]+:\/\/)?(?:[^@]+@)?[^:/]+[:/](.+?)(?:\.git)?\/?$/.exec(remote);
  return other ? { origin: `https://${host.replace(/:\d+$/, "")}`, path: other[1]!.replace(/^\d+\//, ""), host } : undefined;
}

interface Target {
  key: string;
  forge: RolloutForge;
  forgeName?: ForgeName;
  token: string;
}

/** This repository's forge, from terragucci.yml's forge and url or the origin remote. */
function singleTarget(repo: string, settings: ResolvedSettings, options: Pick<RolloutOptions, "env" | "forge" | "fetch" | "mode">): Target {
  const env = options.env ?? process.env;
  let remote: string;
  try {
    remote = git(repo, ["remote", "get-url", "origin"]).trim();
  } catch {
    throw new ConfigError("this repository has no origin remote, so there is nowhere to open a pull request");
  }
  const forgeName = settings.forge ?? detectForge(repo)?.value;
  const at = settings.url ? targetOfRemote(settings.url) : targetOfRemote(remote);
  const token = forgeName ? (env[settings.token_env ?? DEFAULT_TOKEN_ENV[forgeName]] ?? "") : "";
  const target: ForgeTarget | undefined = forgeName && at ? { forge: forgeName, origin: at.origin, path: at.path, token } : undefined;
  const key = at ? `${at.host}/${at.path}` : ".";
  let forge: RolloutForge;
  if (options.forge) forge = options.forge({ key, target });
  else if (target) forge = fetchForge(options.fetch ?? (globalThis.fetch as unknown as Fetch), target);
  else throw new ConfigError("cannot tell which forge this repository's origin is on; set forge (and url) in terragucci.yml");
  if (options.mode === "apply" && !options.forge && !token) throw new ConfigError(`${settings.token_env ?? DEFAULT_TOKEN_ENV[forgeName!]} is not set; it holds the forge token`);
  return { key, forge, forgeName, token };
}

/** A control repo's project's forge. */
function controlTarget(config: TerragucciConfig, key: string, options: Pick<RolloutOptions, "env" | "forge" | "fetch" | "mode">): Target & { settings: ResolvedSettings; cloneUrl: string } {
  const env = options.env ?? process.env;
  const settings = resolveProject(config, key);
  const pk = parseProjectKey(key);
  const forgeName = settings.forge ?? forgeFromHost(pk.host);
  if (!forgeName) throw new ConfigError(`cannot tell which forge ${pk.host} is; set forge for this project`);
  const tokenEnv = settings.token_env ?? DEFAULT_TOKEN_ENV[forgeName];
  const token = env[tokenEnv] ?? "";
  if (options.mode === "apply" && !options.forge && !token) throw new ConfigError(`${tokenEnv} is not set; it holds the token for ${pk.host}`);
  const { cloneUrl, origin } = where(key, settings.url);
  const target: ForgeTarget = { forge: forgeName, origin, path: pk.path, token };
  const forge = options.forge ? options.forge({ key, target }) : fetchForge(options.fetch ?? (globalThis.fetch as unknown as Fetch), target);
  return { key, forge, forgeName, token, settings, cloneUrl };
}

async function singleProject(repo: string, settings: ResolvedSettings, options: RolloutOptions): Promise<Project> {
  const { key, forge } = singleTarget(repo, settings, options);
  git(repo, ["fetch", "-q", "origin"]);
  const base = await forge.defaultBranch();
  const dir = mkdtempSync(join(tmpdir(), "terragucci-rollout-"));
  git(repo, ["worktree", "add", "-q", "--detach", dir, `refs/remotes/origin/${base}`]);
  return {
    key,
    settings,
    dir,
    base,
    forge,
    push: pusher(dir),
    cleanup: () => {
      try {
        git(repo, ["worktree", "remove", "--force", dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function controlProject(config: TerragucciConfig, key: string, options: RolloutOptions): Promise<Project> {
  const { settings, forge, token, cloneUrl } = controlTarget(config, key, options);
  const base = await forge.defaultBranch();
  const work = mkdtempSync(join(tmpdir(), "terragucci-rollout-"));
  const dir = join(work, "repo");
  git(work, ["clone", "-q", "--depth", "1", "--branch", base, withToken(cloneUrl, token || undefined), dir], token || undefined);
  return { key, settings, dir, base, forge, push: pusher(dir, token || undefined), cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

// ── roots ────────────────────────────────────────────────────────────────────

const SKIP = new Set(["node_modules", ".terraform", ".terragrunt-cache"]);

/** Directories with a `terragrunt.hcl`, which `findRoots` does not count. */
function terragruntUnits(repo: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(repo, rel);
    for (const name of readdirSync(abs)) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const child = rel ? posix.join(rel, name) : name;
      if (statSync(join(abs, name)).isDirectory()) walk(child);
      else if (name === "terragrunt.hcl" && rel) out.push(rel);
    }
  };
  walk("");
  return out;
}

function rootsOf(project: Project): string[] {
  return [...new Set([...findRoots(project.dir, project.settings.roots), ...terragruntUnits(project.dir)])].sort();
}

interface Classified {
  status: RootStatus;
  calls?: ModuleCall[];
}

function classifyModule(project: string, root: string, calls: ModuleCall[], from: string | undefined, to: string): Classified {
  const base = { project, root };
  if (calls.length === 0) return { status: { ...base, state: "absent" } };
  const refused = calls.filter((c) => c.pin.pin === null);
  if (refused.length > 0) return { status: { ...base, state: "refused", reason: refused.map((c) => `${c.file} ${c.call}: ${c.pin.unpinned}`).join("; ") }, calls };
  const at = (c: ModuleCall, v: string) => c.version === v || c.pin.pin === v;
  if (calls.every((c) => at(c, to))) return { status: { ...base, state: "to", version: to }, calls };
  if (from !== undefined && calls.every((c) => at(c, from) || at(c, to))) return { status: { ...base, state: "from", version: from }, calls };
  const others = [...new Set(calls.filter((c) => !(from !== undefined && at(c, from)) && !at(c, to)).map((c) => c.version!))];
  if (from !== undefined && calls.some((c) => at(c, from))) {
    return { status: { ...base, state: "refused", reason: `its calls are pinned at more than one version (${[from, ...others].join(", ")})` }, calls };
  }
  return { status: { ...base, state: "elsewhere", version: others.join(", "), reason: `pinned at ${others.join(", ")}` }, calls };
}

function providerSource(address: string): string {
  return address.split("/").slice(-2).join("/").toLowerCase();
}

function classifyProvider(dir: string, project: string, root: string, name: string, from: string | undefined, to: string): RootStatus {
  const base = { project, root };
  const lockPath = join(dir, root, LOCK_FILE);
  if (!existsSync(lockPath)) {
    const source = providerSource(name);
    const uses = readdirSync(join(dir, root))
      .filter((f) => f.endsWith(".tf"))
      .some((f) => readFileSync(join(dir, root, f), "utf-8").toLowerCase().includes(`"${source}"`));
    return uses
      ? { ...base, state: "refused", reason: `it has no ${LOCK_FILE}, so init picks the ${source} version and the diff cannot show it` }
      : { ...base, state: "absent" };
  }
  const entry = lockedProvider(readLock(readFileSync(lockPath, "utf-8")), name);
  if (!entry) return { ...base, state: "absent" };
  if (entry.version === to) return { ...base, state: "to", version: to };
  if (entry.version === from) return { ...base, state: "from", version: from };
  return { ...base, state: "elsewhere", version: entry.version, reason: `locked at ${entry.version}` };
}

// ── tips ─────────────────────────────────────────────────────────────────────

function tipFor(r: RootStatus, to: string): Tip | undefined {
  if (r.state !== "refused" || !r.reason) return undefined;
  const base = { project: r.project, root: r.root };
  if (/is a constraint/.test(r.reason)) {
    return { ...base, rule: "rollout-floating-pin", message: `${r.root}: ${r.reason}. Pin one version, such as version = "${to}", so a rollout can move it and the diff shows which roots it moves.` };
  }
  if (/is an expression/.test(r.reason)) {
    return { ...base, rule: "rollout-literal-pin", message: `${r.root}: ${r.reason}. Write the pin as a literal: a pin set from a variable or local cannot be read from the diff, so a rollout cannot tell which roots it moves.` };
  }
  if (/no \.terraform\.lock\.hcl/.test(r.reason)) {
    return { ...base, rule: "rollout-lock-file", message: `${r.root}: ${r.reason}. Commit ${LOCK_FILE} so a provider bump is a reviewed change.` };
  }
  if (/more than one version/.test(r.reason)) {
    return { ...base, rule: "rollout-one-pin", message: `${r.root}: ${r.reason}. Pin every call of the module at one version.` };
  }
  return { ...base, rule: "rollout-pin", message: `${r.root}: ${r.reason}. Pin it to one version (a ?ref=, ?tag= or version) so a rollout can move it.` };
}

// ── the run ──────────────────────────────────────────────────────────────────

const MARKER = "terragucci-rollout";

function slug(value: string): string {
  return value.replace(/^[a-z]+:\/\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export function waveBranch(name: string, to: string, wave: number): string {
  return `terragucci/rollout/${slug(name)}-${slug(to)}/wave-${wave}`;
}

/** What a wave's pull request body records about its rollout. `waves` is missing from a body written before it was recorded. */
interface Marker {
  kind?: RolloutKind;
  name?: string;
  from?: string;
  to?: string;
  wave?: number;
  waves?: number;
  roots?: string[];
}

function readMarker(body: string): Marker | undefined {
  const m = new RegExp(`<!-- ${MARKER} (\\{.*?\\}) -->`).exec(body);
  try {
    return m ? (JSON.parse(m[1]!) as Marker) : undefined;
  } catch {
    return undefined;
  }
}

function markerRoots(body: string): string[] | undefined {
  return readMarker(body)?.roots;
}

export async function rollout(cwd: string, options: RolloutOptions): Promise<RolloutResult> {
  const mode = options.mode ?? "dry-run";
  let repo: string;
  try {
    repo = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new ConfigError("terragucci rollout runs in a git repository");
  }
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  if (options.kind === "provider" && !options.to) throw new ConfigError("a provider rollout needs the version to move to");

  // Load the parser before any forge is asked, so a missing one fails first.
  const parser = options.parser ?? (options.kind === "module" ? await loadHclParser() : undefined);
  const projects: Project[] = [];
  try {
    if (config.projects) {
      for (const key of Object.keys(config.projects)) projects.push(await controlProject(config, key, { ...options, mode }));
    } else {
      projects.push(await singleProject(repo, resolveRepo(config), { ...options, mode }));
    }
    return await walk(repo, config, projects, { ...options, mode, parser });
  } finally {
    for (const p of projects) p.cleanup();
  }
}

// ── continuing every rollout in flight ───────────────────────────────────────

const BRANCH_PREFIX = "terragucci/rollout/";

export interface InFlight {
  kind: RolloutKind;
  name: string;
  from?: string;
  to: string;
  /** The newest wave with a pull request. */
  wave: number;
  /** How many waves the rollout had when that wave opened, when its pull request says. */
  waves?: number;
  /**
   * `ran`: the newest wave merged, so the rollout ran, and `result` says what it
   * did. `waiting`: a pull request of the newest wave is open. `stopped`: one
   * closed without merging. `done`: the last wave merged. `failed`: the run
   * threw, and `reason` says why.
   */
  action: "ran" | "waiting" | "stopped" | "done" | "failed";
  reason?: string;
  pullRequests: string[];
  result?: RolloutResult;
}

export interface ContinueResult {
  mode: "dry-run" | "apply";
  rollouts: InFlight[];
}

/** 1 when a rollout's run failed, else 0: a rollout waiting or stopped is nothing to do. */
export function continueExit(result: ContinueResult): number {
  return result.rollouts.some((r) => r.action === "failed") ? 1 : 0;
}

/**
 * Every rollout in flight, found from its pull requests' branches and the
 * marker each body carries, taken one step further: a rollout whose newest
 * wave merged runs again, which opens the next wave once that wave applied.
 * A rollout with a wave open or closed, or with its last wave merged, does not
 * run. So a run on a schedule continues each rollout within one interval of
 * its wave applying, and opens nothing a person would not.
 */
export async function continueRollouts(cwd: string, options: Omit<RolloutOptions, "kind" | "name" | "to" | "from"> = {}): Promise<ContinueResult> {
  const mode = options.mode ?? "dry-run";
  let repo: string;
  try {
    repo = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new ConfigError("terragucci respond rollout runs in a git repository");
  }
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const targets = config.projects ? Object.keys(config.projects).map((key) => controlTarget(config, key, { ...options, mode })) : [singleTarget(repo, resolveRepo(config), { ...options, mode })];

  type Seen = { marker: Required<Pick<Marker, "kind" | "name" | "to" | "wave">> & Marker; state: ListedPullRequest["state"]; url: string };
  const groups = new Map<string, Seen[]>();
  for (const t of targets) {
    const branches = new Set<string>();
    for (const pr of await t.forge.listPullRequests(BRANCH_PREFIX)) {
      // The list is newest update first: the first pull request from a branch is the one a rollout reads.
      if (branches.has(pr.branch)) continue;
      branches.add(pr.branch);
      const m = readMarker(pr.body);
      if (!m || (m.kind !== "module" && m.kind !== "provider") || !m.name || !m.to || !Number.isInteger(m.wave)) continue;
      const of = /, wave \d+ of (\d+)$/.exec(pr.title);
      const marker = { ...m, ...(m.waves === undefined && of ? { waves: Number(of[1]) } : {}) } as Seen["marker"];
      const id = JSON.stringify([m.kind, m.name, m.to]);
      groups.set(id, [...(groups.get(id) ?? []), { marker, state: pr.state, url: pr.url }]);
    }
  }

  const rollouts: InFlight[] = [];
  for (const seen of groups.values()) {
    const wave = Math.max(...seen.map((s) => s.marker.wave));
    const newest = seen.filter((s) => s.marker.wave === wave);
    const m = newest[0]!.marker;
    const waves = newest.map((s) => s.marker.waves).find((n) => n !== undefined);
    const base: InFlight = { kind: m.kind, name: m.name, ...(m.from !== undefined ? { from: m.from } : {}), to: m.to, wave, ...(waves !== undefined ? { waves } : {}), action: "ran", pullRequests: newest.map((s) => s.url) };
    const open = newest.filter((s) => s.state === "open");
    const closed = newest.filter((s) => s.state === "closed");
    if (open.length > 0) rollouts.push({ ...base, action: "waiting", reason: `wave ${wave} is open: ${open.map((s) => s.url).join(", ")}` });
    else if (closed.length > 0) rollouts.push({ ...base, action: "stopped", reason: `wave ${wave} was closed without merging: ${closed.map((s) => s.url).join(", ")}` });
    else if (waves !== undefined && wave >= waves) rollouts.push({ ...base, action: "done", reason: `wave ${wave} of ${waves}, the last, merged` });
    else {
      try {
        const result = await rollout(repo, { ...options, mode, kind: m.kind, name: m.name, to: m.to, ...(m.from !== undefined ? { from: m.from } : {}) });
        rollouts.push({ ...base, result });
      } catch (e) {
        rollouts.push({ ...base, action: "failed", reason: (e as Error).message });
      }
    }
  }
  return { mode, rollouts };
}

export function describeContinue(result: ContinueResult): string {
  if (result.rollouts.length === 0) return "no rollout in flight";
  return result.rollouts
    .map((r) => {
      if (r.result) return describeRollout(r.result);
      const what = r.kind === "module" ? r.name : `provider ${r.name}`;
      return `${what} ${r.from ?? "?"} -> ${r.to}: ${r.action} (${r.reason})`;
    })
    .join("\n");
}

async function walk(repo: string, config: TerragucciConfig, projects: Project[], options: RolloutOptions & { mode: "dry-run" | "apply" }): Promise<RolloutResult> {
  const needsParser = options.kind === "module" || projects.some((p) => terragruntUnits(p.dir).length > 0);
  const parser = options.parser ?? (needsParser ? await loadHclParser() : undefined);

  // 1. Every root's calls, and the versions they pin.
  const roots = new Map<string, string[]>();
  const calls = new Map<string, ModuleCall[]>();
  for (const p of projects) {
    roots.set(p.key, rootsOf(p));
    if (options.kind === "module") for (const r of roots.get(p.key)!) calls.set(`${p.key}\0${r}`, await moduleCalls(p.dir, r, options.name, parser!));
  }

  let to = options.to;
  let discovered: string | undefined;
  if (!to) {
    const oci = new Set<string>();
    for (const p of [...projects.map((p) => p.settings), config.defaults ?? {}]) {
      const publish = p.modules?.publish;
      for (const t of Array.isArray(publish) ? publish : publish ? [publish] : []) if (t.startsWith("oci://")) oci.add(ociRepoFor(t, options.name));
    }
    for (const list of calls.values()) for (const c of list) if (c.pin.module.startsWith("oci://")) oci.add(c.pin.module.split("?")[0]!);
    const found = await newestPublished({ module: options.name, repos: [repo, ...projects.map((p) => p.dir)], oci: [...oci], env: options.env, fetch: options.registryFetch });
    if (!found) throw new ConfigError(`found no published version of ${options.name}; name the version to roll out`);
    to = found.version;
    discovered = found.from;
  }
  const toVersion = options.kind === "module" ? pinVersion(to) : to;

  let from = options.from !== undefined ? pinVersion(options.from) : undefined;
  if (from === undefined) {
    const seen = new Set<string>();
    if (options.kind === "module") {
      for (const list of calls.values()) for (const c of list) if (c.version !== null && c.version !== toVersion) seen.add(c.version);
    } else {
      for (const p of projects) {
        for (const r of roots.get(p.key)!) {
          const lock = join(p.dir, r, LOCK_FILE);
          const e = existsSync(lock) ? lockedProvider(readLock(readFileSync(lock, "utf-8")), options.name) : undefined;
          if (e && e.version !== toVersion) seen.add(e.version);
        }
      }
    }
    if (seen.size > 1) throw new ConfigError(`${options.name} is at ${[...seen].sort().join(", ")} across the roots; pass --from to say which version moves`);
    from = [...seen][0];
  }

  // 2. Where each root stands.
  const statuses: RootStatus[] = [];
  const byKey = new Map(projects.map((p) => [p.key, p]));
  const inRollout = new Map<string, string[]>();
  for (const p of projects) {
    const list: string[] = [];
    for (const r of roots.get(p.key)!) {
      const s = options.kind === "module" ? classifyModule(p.key, r, calls.get(`${p.key}\0${r}`)!, from, toVersion).status : classifyProvider(p.dir, p.key, r, options.name, from, toVersion);
      if (s.state !== "absent") statuses.push(s);
      if (s.state === "from" || s.state === "to") list.push(r);
    }
    inRollout.set(p.key, list);
  }
  const stateOf = (project: string, root: string) => statuses.find((s) => s.project === project && s.root === root)?.state;

  // 3. The waves.
  const plan: Wave[] = [];
  const planned: Parameters<typeof planWaves>[0] = [];
  for (const p of projects) {
    const list = inRollout.get(p.key)!;
    if (list.length === 0) continue;
    const deps = rootDependencies(p.dir, roots.get(p.key)!);
    for (const r of list) {
      const tg = join(p.dir, r, "terragrunt.hcl");
      if (existsSync(tg)) for (const d of await terragruntDependencies(r, readFileSync(tg, "utf-8"), parser!)) deps.get(r)?.add(d) ?? deps.set(r, new Set([d]));
    }
    planned.push({ key: p.key, roots: list, dependsOn: deps, canary: p.settings.waves?.canary ?? [] });
  }
  try {
    plan.push(...planWaves(planned));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  // 4. Walk them.
  const result: RolloutResult = {
    kind: options.kind,
    name: options.name,
    ...(from !== undefined ? { from } : {}),
    to: toVersion,
    ...(discovered ? { discovered } : {}),
    mode: options.mode,
    status: "complete",
    waves: plan.map((w) => ({ wave: w.wave, canary: w.canary, parts: w.parts.map((p) => ({ ...p, branch: waveBranch(options.name, toVersion, w.wave), state: "not-reached" as PartState })) })),
    roots: statuses,
    tips: [],
  };
  const lockerFor = (p: Project) => (options.locker ?? binaryLocker)(p.settings.binary ?? detectBinary(p.dir, roots.get(p.key)!).value);

  for (const wave of result.waves) {
    const due: PartStatus[] = [];
    let waiting = false;
    for (const part of wave.parts) {
      const project = byKey.get(part.project)!;
      const pr = await project.forge.findPullRequest(part.branch);
      if (pr) part.pullRequest = pr.url;
      if (pr?.state === "open") {
        part.state = "open";
        waiting = true;
      } else if (pr?.state === "closed") {
        part.state = "closed";
        result.stop ??= `wave ${wave.wave}: ${pr.url} was closed without merging`;
      } else if (pr?.state === "merged") {
        const moved = markerRoots(pr.body) ?? part.roots;
        const checks = pr.mergeCommit ? await project.forge.commitChecks(pr.mergeCommit) : [];
        part.failed = moved.filter((r) => appliedState(checks, r) === "failure");
        part.pending = moved.filter((r) => appliedState(checks, r) === "pending");
        if (part.failed.length > 0) {
          part.state = "failed";
          result.stop ??= `wave ${wave.wave}: ${part.failed.join(", ")} in ${part.project} failed to apply after ${pr.url} merged`;
        } else if (part.pending.length > 0) {
          part.state = "waiting-apply";
          waiting = true;
        } else part.state = "applied";
      } else if (part.roots.some((r) => stateOf(part.project, r) === "from")) {
        due.push(part);
      } else part.state = "nothing-to-move";
    }
    if (result.stop) {
      result.status = "stopped";
      break;
    }
    if (due.length > 0) {
      for (const part of due) await openPart(byKey.get(part.project)!, part, wave, result, options, lockerFor, parser);
      if (result.stop) result.status = "stopped";
      else result.status = options.mode === "apply" ? "opened" : "would-open";
      break;
    }
    if (waiting) {
      result.status = "waiting";
      break;
    }
  }

  const tipsOn = (project: string) => byKey.get(project)?.settings.tips !== false;
  result.tips = statuses.filter((s) => tipsOn(s.project)).map((s) => tipFor(s, toVersion)).filter((t): t is Tip => t !== undefined);
  return result;
}

async function openPart(
  project: Project,
  part: PartStatus,
  wave: WaveStatus,
  result: RolloutResult,
  options: RolloutOptions & { mode: "dry-run" | "apply" },
  lockerFor: (p: Project) => Locker,
  parser: Hcl2Json | undefined,
): Promise<void> {
  const moving = part.roots.filter((r) => result.roots.find((s) => s.project === part.project && s.root === r)?.state === "from");
  if (options.mode === "dry-run" && options.kind === "provider") {
    // The binary writes the lock file; a dry run names the files without running it.
    part.files = moving.map((r) => (r === "." ? LOCK_FILE : posix.join(r, LOCK_FILE))).sort();
    part.state = "would-open";
    return;
  }
  const edits = new Map<string, string>();
  for (const root of moving) {
    const moved =
      options.kind === "module"
        ? await movePins(project.dir, await moduleCalls(project.dir, root, options.name, parser!), result.from!, result.to, parser!)
        : moveLock(project.dir, root, options.name, result.from!, result.to, lockerFor(project));
    if ("refused" in moved) {
      part.state = "failed";
      part.reason = moved.refused;
      result.stop ??= `wave ${wave.wave}: ${root} in ${part.project} cannot move: ${moved.refused}`;
      return;
    }
    for (const [file, content] of moved.edits) edits.set(file, content);
  }
  part.files = [...edits.keys()].sort();
  if (options.mode === "dry-run") {
    part.state = "would-open";
    return;
  }
  for (const [file, content] of edits) writeFileSync(join(project.dir, file), content);
  const total = result.waves.length;
  const what = options.kind === "module" ? `${options.name} ${result.from} -> ${result.to}` : `provider ${options.name} ${result.from} -> ${result.to}`;
  const title = `terragucci rollout: ${what}, wave ${wave.wave} of ${total}`;
  const others = result.roots.filter((r) => r.project === part.project && (r.state === "refused" || r.state === "elsewhere"));
  const body = [
    `<!-- ${MARKER} ${JSON.stringify({ kind: options.kind, name: options.name, from: result.from, to: result.to, wave: wave.wave, waves: total, roots: moving })} -->`,
    `Wave ${wave.wave} of ${total}${wave.canary ? " (canaries)" : ""}: ${what}.`,
    "",
    `This pull request moves ${options.kind === "module" ? "the pin" : `\`${LOCK_FILE}\``} for these roots and changes no other file:`,
    "",
    ...moving.map((r) => `- \`${r}\``),
    ...(others.length > 0 ? ["", "Not moved by this rollout:", "", ...others.map((r) => `- \`${r.root}\`: ${r.reason}`)] : []),
    "",
    wave.wave < total
      ? `Wave ${wave.wave + 1} opens on a later run, once every pull request of this wave has merged and its roots have applied.`
      : "This is the last wave.",
  ].join("\n");
  project.push(part.branch, part.files, `${title}\n\nRoots: ${moving.join(", ")}\n`);
  part.pullRequest = await project.forge.createPullRequest({ base: project.base, head: part.branch, title, body });
  part.state = "opened";
}

// ── output ───────────────────────────────────────────────────────────────────

const PART_TEXT: Record<PartState, string> = {
  applied: "merged and applied",
  "nothing-to-move": "nothing to move",
  opened: "pull request opened",
  "would-open": "next; would open its pull request",
  open: "pull request open, waiting for merge",
  "waiting-apply": "merged, waiting for apply",
  failed: "failed",
  closed: "pull request closed without merging",
  "not-reached": "not opened",
};

export function describeRollout(result: RolloutResult): string {
  const what = result.kind === "module" ? result.name : `provider ${result.name}`;
  const lines = [`${what} ${result.from ?? "?"} -> ${result.to}${result.discovered ? ` (newest published: ${result.discovered})` : ""}: ${result.status}${result.stop ? ` (${result.stop})` : ""}`];
  const multi = new Set(result.waves.flatMap((w) => w.parts.map((p) => p.project))).size > 1;
  for (const w of result.waves) {
    lines.push(`  wave ${w.wave}${w.canary ? " (canaries)" : ""}`);
    for (const p of w.parts) {
      lines.push(`    ${multi ? `${p.project}: ` : ""}${PART_TEXT[p.state]}${p.pullRequest ? ` ${p.pullRequest}` : ""}${p.reason ? ` (${p.reason})` : ""}`);
      lines.push(`      roots: ${p.roots.join(", ")}`);
      if (p.pending?.length) lines.push(`      apply pending: ${p.pending.join(", ")}`);
      if (p.failed?.length) lines.push(`      apply failed: ${p.failed.join(", ")}`);
      if (p.files?.length) lines.push(`      files: ${p.files.join(", ")}`);
    }
  }
  for (const r of result.roots.filter((r) => r.state === "refused" || r.state === "elsewhere")) {
    lines.push(`  not in the rollout: ${multi ? `${r.project} ` : ""}${r.root}: ${r.reason}`);
  }
  for (const t of result.tips) lines.push(`  tip (${t.rule}): ${t.message}`);
  if (result.mode === "dry-run" && (result.status === "would-open" || result.status === "complete")) lines.push("dry run: nothing was opened");
  return lines.join("\n");
}

// ── the command line ─────────────────────────────────────────────────────────

/** `terragucci rollout` arguments as options. */
export function rolloutArgs(args: string[], flags: Record<string, string | true>): RolloutOptions {
  const value = (k: string): string | undefined => {
    const v = flags[k];
    if (v === true) throw new ConfigError(`--${k} needs a value`);
    return v;
  };
  const mode = checkMode(value("mode") ?? "dry-run");
  const provider = value("provider");
  const usage = "usage: terragucci rollout <module> [<version>] | terragucci rollout --provider <address> <version>";
  if (provider) {
    if (args.length !== 1) throw new ConfigError(usage);
    return { kind: "provider", name: provider, to: args[0], from: value("from"), mode, config: value("config") };
  }
  if (args.length < 1 || args.length > 2) throw new ConfigError(usage);
  return { kind: "module", name: args[0]!, to: args[1], from: value("from"), mode, config: value("config") };
}
