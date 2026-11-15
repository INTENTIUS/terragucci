/**
 * What one root's init and plan take that another root's do not, and one
 * directory run as several roots.
 *
 *   backend_config  root glob to the `-backend-config` files init takes
 *   var_files       root glob to the `-var-file` files plan takes
 *   instances       directory to the names it runs under
 *   sources         root glob to the module and provider lists its roots are checked against
 *
 * The paths are relative to the root's directory, where the binary runs. A
 * directory in `instances` is not a root itself: each name makes a root
 * called `<directory>@<name>`, which runs in that directory with the
 * settings its own globs give it. A glob that matches the directory alone
 * reaches each of its instances, so the settings the instances share go
 * there and each instance adds its own.
 *
 * Every reader of a root's state, order and inputs goes through here, so the
 * address a root keeps its state at, the plan, the apply, drift and the
 * locks all take the same values.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYAMLDocument } from "@intentius/chant/yaml";
import { findConfig, type SourceLists, type SourcesByRoot } from "./config";
import { globMatch } from "./detect";

/** What separates a directory from the instance's name in a root's name. */
export const INSTANCE_SEP = "@";

/** The keys of terragucci.yml this module reads, as a repo's own file holds them. */
export interface RootConfig {
  backend_config?: Record<string, string | string[]>;
  var_files?: Record<string, string | string[]>;
  instances?: Record<string, string[]>;
}

/** One root's inputs: the `-backend-config` files and the `-var-file` files, in the order the config lists them. */
export interface RootInputs {
  backendConfig: string[];
  varFiles: string[];
}

/** An instance's name: what a state key, a file name and a root glob can all carry. */
export const INSTANCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The three keys out of a config, left as they are when they are not the shape they should be (config check refuses those). */
function pick(raw: unknown): RootConfig {
  if (!isObject(raw)) return {};
  const out: RootConfig = {};
  if (isObject(raw.backend_config)) out.backend_config = raw.backend_config as RootConfig["backend_config"];
  if (isObject(raw.var_files)) out.var_files = raw.var_files as RootConfig["var_files"];
  if (isObject(raw.instances)) out.instances = raw.instances as RootConfig["instances"];
  return out;
}

/** Configs a command loaded, by directory: a `.ts` config is folded once there, and read from here after. */
const noted = new Map<string, RootConfig>();
const read = new Map<string, { stamp: string; config: RootConfig }>();

/** Remember the root settings of the config loaded for the repo at `dir`, so a reader that finds a root's state without the async loader sees them. */
export function noteRootConfig(dir: string, config: unknown): void {
  noted.set(resolve(dir), pick(config));
}

/** The repo's root settings: the config a command loaded, else the repo's terragucci.yml or .json. Empty when there is none or it cannot be read. */
export function rootConfigOf(repo: string): RootConfig {
  const key = resolve(repo);
  const loaded = noted.get(key);
  if (loaded) return loaded;
  try {
    const path = findConfig(repo);
    if (!path || path.endsWith(".ts")) return {};
    const stat = statSync(path);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = read.get(path);
    if (cached?.stamp === stamp) return cached.config;
    const text = readFileSync(path, "utf-8");
    const raw = path.endsWith(".json") ? JSON.parse(text) : text.trim() === "" ? {} : parseYAMLDocument(text);
    const config = pick(raw);
    read.set(path, { stamp, config });
    return config;
  } catch {
    return {};
  }
}

/** The root `<dir>@<name>`. */
export const instanceRoot = (dir: string, name: string): string => `${dir}${INSTANCE_SEP}${name}`;

/** The names a directory runs under in `config`; none for a directory that is one root. */
function namesIn(config: RootConfig, dir: string): string[] {
  const names = config.instances?.[dir];
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [];
}

/** The names a directory runs under; none for a directory that is one root. */
export function instancesOf(repo: string, dir: string): string[] {
  return namesIn(rootConfigOf(repo), dir);
}

/** The directory a root runs in, and the instance it is, when `config` declares it one. */
export function splitIn(config: RootConfig, root: string): { dir: string; instance?: string } {
  const at = root.lastIndexOf(INSTANCE_SEP);
  if (at <= 0) return { dir: root };
  const dir = root.slice(0, at);
  const name = root.slice(at + 1);
  return namesIn(config, dir).includes(name) ? { dir, instance: name } : { dir: root };
}

/** The directory a root runs in, and the instance it is, when it is one. */
export function splitRoot(repo: string, root: string): { dir: string; instance?: string } {
  return splitIn(rootConfigOf(repo), root);
}

/** The directory a root runs in, relative to the repo: the root itself, or an instance's directory. */
export function rootDir(repo: string, root: string): string {
  return splitRoot(repo, root).dir;
}

/** `root`'s path in `repo`, the directory its binary runs in. */
export function rootPath(repo: string, root: string): string {
  return join(repo, rootDir(repo, root));
}

const list = (v: string | string[] | undefined): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Every file of the entries whose glob matches the root, or its directory when it is an instance, in the order the config lists them. */
function matching(map: Record<string, string | string[]> | undefined, config: RootConfig, root: string): string[] {
  if (!map) return [];
  const { dir, instance } = splitIn(config, root);
  return Object.entries(map)
    .filter(([glob]) => globMatch(glob, root) || (instance !== undefined && globMatch(glob, dir)))
    .flatMap(([, files]) => list(files));
}

/** The files `root`'s settings in `config` name, for a reader that holds a config of its own (the base's and the head's, compared). */
export function inputsIn(config: RootConfig, root: string): RootInputs {
  return { backendConfig: matching(config.backend_config, config, root), varFiles: matching(config.var_files, config, root) };
}

/** The `-backend-config` files init and the `-var-file` files plan take for `root`. */
export function rootInputs(repo: string, root: string): RootInputs {
  return inputsIn(rootConfigOf(repo), root);
}

/** The `-backend-config` values init takes for `root`, to read where its state is. */
export function rootBackendConfigs(repo: string, root: string): string[] {
  return rootInputs(repo, root).backendConfig;
}

/** The var files plan takes for `root`, relative to its directory. */
export function rootVarFiles(repo: string, root: string): string[] {
  return rootInputs(repo, root).varFiles;
}

/** A path as one word of a TF_CLI_ARGS value, which splits on spaces and reads quotes. */
function word(flag: string, path: string): string {
  return /[\s"'\\]/.test(path) ? `${flag}="${path.replace(/(["\\])/g, "\\$1")}"` : `${flag}=${path}`;
}

/** `value` with `words` after it, as one TF_CLI_ARGS value. */
const appended = (value: string | undefined, words: string[]): string => [value?.trim(), ...words].filter(Boolean).join(" ");

/**
 * `env` for the binary run on `root`. An instance keeps its own data
 * directory (`TF_DATA_DIR`, relative to the directory), so two instances of one directory never share
 * the backend and modules `init` recorded. With `inputs`, the root's
 * `-backend-config` files go to `init` (with `-reconfigure`, since the
 * directory's data may hold another backend) and its `-var-file` files to
 * `plan`, through `TF_CLI_ARGS_init` and `TF_CLI_ARGS_plan`, after whatever
 * the job's environment already sets. A run that hands the binary its roots
 * as chant does passes the files itself: it asks for the data directory
 * alone.
 */
export function rootInputsEnv(repo: string, root: string, env: NodeJS.ProcessEnv, inputs = true): NodeJS.ProcessEnv {
  const { instance } = splitRoot(repo, root);
  const files = inputs ? rootInputs(repo, root) : { backendConfig: [], varFiles: [] };
  if (!instance && files.backendConfig.length === 0 && files.varFiles.length === 0) return env;
  const out: NodeJS.ProcessEnv = { ...env };
  if (instance) out.TF_DATA_DIR = join(".terraform", "instances", instance);
  if (files.backendConfig.length) out.TF_CLI_ARGS_init = appended(env.TF_CLI_ARGS_init, ["-reconfigure", ...files.backendConfig.map((f) => word("-backend-config", f))]);
  if (files.varFiles.length) out.TF_CLI_ARGS_plan = appended(env.TF_CLI_ARGS_plan, files.varFiles.map((f) => word("-var-file", f)));
  return out;
}

/** Problems with the files a root's settings name: each must be a file in the repo, relative to the root's directory. */
export function rootFileProblems(repo: string, roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const dir = rootPath(repo, root);
    const { backendConfig, varFiles } = rootInputs(repo, root);
    for (const [key, files] of [["backend_config", backendConfig], ["var_files", varFiles]] as const) {
      for (const f of files) {
        if (f.startsWith("/") || /^[A-Za-z]:[\\/]/.test(f)) continue;
        if (!existsSync(join(dir, f))) out.push(`${key}: ${root} names ${f}, which is not a file relative to ${rootDir(repo, root)}`);
      }
    }
  }
  return out;
}

/**
 * Problems read from the roots found: a key of `backend_config` or
 * `var_files` that matches no root, an `instances` directory that is no
 * root, and a file a root names that is not in its directory. A root's files
 * are not checked when the roots are written by a command that has not run.
 */
export function rootsInputProblems(repo: string, config: RootConfig, roots: readonly string[], written = false): string[] {
  const out: string[] = [];
  const dirs = new Set(roots.map((r) => splitIn(config, r).dir));
  for (const dir of Object.keys(config.instances ?? {})) {
    if (!dirs.has(dir)) out.push(`instances: ${dir} is not a root directory${written ? "" : ", or no roots glob matches it"}`);
  }
  for (const key of ["backend_config", "var_files"] as const) {
    for (const glob of Object.keys(config[key] ?? {})) {
      if (!roots.some((r) => globMatch(glob, r) || globMatch(glob, splitIn(config, r).dir))) out.push(`${key}: ${JSON.stringify(glob)} matches no root`);
    }
  }
  if (!written) out.push(...rootFileProblems(repo, roots));
  return out;
}

/** The keys of a by-root `sources` that are not a root glob. */
const SOURCES_RESERVED = new Set(["default", "proxies"]);

/**
 * The lists `root` is checked against under a by-root `sources`: the first
 * entry, in the order the file lists them, whose glob matches the root (or
 * its directory, for an instance); else `default`. A root the pull request
 * adds (`added`) matches no entry whatever its path, so it gets `default`
 * and never a list a glob of the base gives a root that was already there.
 * Undefined when the root has no list to be checked against.
 */
export function sourceListsIn(sources: SourcesByRoot, config: RootConfig, root: string, added = false): SourceLists | undefined {
  const entry = (v: unknown): SourceLists | undefined => (isObject(v) ? (v as SourceLists) : undefined);
  if (!added) {
    const { dir, instance } = splitIn(config, root);
    for (const [glob, lists] of Object.entries(sources)) {
      if (SOURCES_RESERVED.has(glob)) continue;
      if (globMatch(glob, root) || (instance !== undefined && globMatch(glob, dir))) return entry(lists);
    }
  }
  return entry(sources.default);
}
