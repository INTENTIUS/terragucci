/**
 * terragucci.yml: one schema for one repo or many.
 *
 * In a repo, the file sits at the root and its keys are that repo's settings.
 * In a control repo, `projects:` maps `<host>/<path>` keys to settings, and
 * `defaults:` applies to every project. A project's own keys override the
 * defaults, which override terragucci's built-in defaults. With no file at
 * all, the built-in defaults apply.
 *
 * The file may be YAML, JSON, or TypeScript. A `.ts` file is folded to its
 * value without running it (the data-host profile of typescript-as-data), so
 * a config that reads the environment is refused with its line.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseYAML } from "@intentius/chant/yaml";

export const BINARIES = ["terraform", "tofu", "choudoufu", "cdktn"] as const;
export const FORGES = ["github", "gitlab", "forgejo"] as const;
export const GATES = ["always", "on-destroy", "never"] as const;
export const RUNTIMES = ["forge", "fountain"] as const;

export type Binary = (typeof BINARIES)[number];
export type ForgeName = (typeof FORGES)[number];
export type Gate = (typeof GATES)[number];
export type Runtime = (typeof RUNTIMES)[number];

/** The settings one project (or one repo) can carry. Every key is optional. */
export interface ProjectSettings {
  /** Globs of root directories. Detected when absent. */
  roots?: string[];
  /** The binary the pipeline runs. Detected when absent. */
  binary?: Binary;
  /** The binary's version. Read from the roots' `required_version` when it pins one. */
  version?: string;
  /** The forge, for a host terragucci cannot name. */
  forge?: ForgeName;
  /** Where the project lives, for a forge not on https or the default port. */
  url?: string;
  /** When a wave waits for an approval. */
  gate?: Gate;
  waves?: { canary?: string[] };
  /** A cron schedule for tf-drift, or false. */
  drift?: string | false;
  runtime?: Runtime;
  reports?: { bucket: string; endpoint?: string; prefix?: string };
  /** The environment variable holding the forge token. */
  token_env?: string;
  /** Environment variables every job gets. Values only, never secrets. */
  env?: Record<string, string>;
  tips?: boolean;
  modules?: { path?: string; publish?: string };
  /** Whether removing the project from a control repo removes its generated files. */
  owned?: boolean;
}

/** The whole file: one repo's settings, or `defaults` and `projects` for many repos. */
export interface TerragucciConfig extends ProjectSettings {
  defaults?: ProjectSettings;
  projects?: Record<string, ProjectSettings>;
}

/** Settings with terragucci's defaults filled in. Detection fills `roots`, `binary` and `forge` later. */
export interface ResolvedSettings extends ProjectSettings {
  gate: Gate;
  drift: string | false;
  runtime: Runtime;
  tips: boolean;
  owned: boolean;
  env: Record<string, string>;
}

export const BUILT_IN: ResolvedSettings = {
  gate: "on-destroy",
  drift: false,
  runtime: "forge",
  tips: true,
  owned: false,
  env: {},
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const CONFIG_NAMES = ["terragucci.yml", "terragucci.yaml", "terragucci.json", "terragucci.ts"];

/** The config file in `dir`, or undefined. Two of them is an error. */
export function findConfig(dir: string): string | undefined {
  const found = CONFIG_NAMES.filter((n) => existsSync(join(dir, n)));
  if (found.length > 1) throw new ConfigError(`${dir} has ${found.join(" and ")}; keep one`);
  return found.length ? join(dir, found[0]) : undefined;
}

// ── validation ───────────────────────────────────────────────────────────────

const SETTING_KEYS = new Set([
  "roots", "binary", "version", "forge", "url", "gate", "waves", "drift", "runtime",
  "reports", "token_env", "env", "tips", "modules", "owned",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function oneOf(v: unknown, allowed: readonly string[], where: string, problems: string[]): void {
  if (v !== undefined && !allowed.includes(v as string)) {
    problems.push(`${where} is ${JSON.stringify(v)}; use one of ${allowed.join(", ")}`);
  }
}

function stringList(v: unknown, where: string, problems: string[]): void {
  if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) {
    problems.push(`${where} must be a list of strings`);
  }
}

function checkSettings(s: unknown, where: string, problems: string[]): void {
  if (!isObject(s)) {
    problems.push(`${where} must be a map of settings`);
    return;
  }
  for (const k of Object.keys(s)) {
    if (!SETTING_KEYS.has(k)) problems.push(`${where}.${k} is not a setting (settings: ${[...SETTING_KEYS].join(", ")})`);
  }
  stringList(s.roots, `${where}.roots`, problems);
  oneOf(s.binary, BINARIES, `${where}.binary`, problems);
  oneOf(s.forge, FORGES, `${where}.forge`, problems);
  oneOf(s.gate, GATES, `${where}.gate`, problems);
  oneOf(s.runtime, RUNTIMES, `${where}.runtime`, problems);
  for (const k of ["version", "url", "token_env"] as const) {
    if (s[k] !== undefined && typeof s[k] !== "string") problems.push(`${where}.${k} must be a string`);
  }
  if (s.drift !== undefined && s.drift !== false && typeof s.drift !== "string") {
    problems.push(`${where}.drift must be a cron schedule or false`);
  }
  for (const k of ["tips", "owned"] as const) {
    if (s[k] !== undefined && typeof s[k] !== "boolean") problems.push(`${where}.${k} must be true or false`);
  }
  if (s.waves !== undefined) {
    if (!isObject(s.waves)) problems.push(`${where}.waves must be a map`);
    else stringList(s.waves.canary, `${where}.waves.canary`, problems);
  }
  if (s.env !== undefined) {
    if (!isObject(s.env) || !Object.values(s.env).every((x) => typeof x === "string")) {
      problems.push(`${where}.env must map names to string values`);
    }
  }
  if (s.reports !== undefined && !(isObject(s.reports) && typeof s.reports.bucket === "string")) {
    problems.push(`${where}.reports must name a bucket`);
  }
  if (s.modules !== undefined && !isObject(s.modules)) problems.push(`${where}.modules must be a map`);
}

/** Check a parsed config and return it typed, or throw with every problem listed. */
export function validateConfig(raw: unknown, where: string): TerragucciConfig {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new ConfigError(`${where}: the config must be a map`);
  const { defaults, projects, ...rest } = raw;
  if (projects !== undefined) {
    if (!isObject(projects)) problems.push(`${where}: projects must map <host>/<path> to settings`);
    else {
      for (const [key, s] of Object.entries(projects)) {
        try {
          parseProjectKey(key);
        } catch (e) {
          problems.push(`${where}: ${(e as Error).message}`);
        }
        checkSettings(s ?? {}, `projects["${key}"]`, problems);
      }
    }
    if (Object.keys(rest).length) {
      problems.push(`${where}: a control repo keeps shared settings under defaults; move ${Object.keys(rest).join(", ")} there`);
    }
  } else {
    checkSettings(rest, "config", problems);
  }
  if (defaults !== undefined) checkSettings(defaults, "defaults", problems);
  if (defaults !== undefined && projects === undefined) problems.push(`${where}: defaults only makes sense with projects`);
  if (problems.length) throw new ConfigError(`${where} has ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  // JSON's view: an undefined property is the same as an absent one.
  return JSON.parse(JSON.stringify(raw)) as TerragucciConfig;
}

// ── loading ──────────────────────────────────────────────────────────────────

export type ConfigMode = "fold" | "run" | "check";

function projectFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) continue;
      if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
        files.set(relative(root, abs).split("\\").join("/"), readFileSync(abs, "utf-8"));
      }
    }
  };
  walk(root);
  return files;
}

async function foldConfig(path: string): Promise<unknown> {
  const { foldProject, EMPTY_HOST } = await import("@intentius/tsad-reference");
  const root = dirname(resolve(path));
  const key = relative(root, resolve(path)).split("\\").join("/");
  const verdict = foldProject(projectFiles(root), { ...EMPTY_HOST, profile: "data-host" }).verdicts.get(key);
  if (!verdict) throw new ConfigError(`${path}: not found`);
  if (verdict.kind === "run") throw new ConfigError(`${path} is not data (${verdict.rule}): ${verdict.reason}`);
  const exports = Object.fromEntries(verdict.exports);
  if (!("default" in exports)) throw new ConfigError(`${path} must export the config as \`export default\``);
  return exports.default;
}

async function runConfig(path: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  if (!("default" in mod)) throw new ConfigError(`${path} must export the config as \`export default\``);
  return mod.default;
}

const canonical = (v: unknown): string => {
  const sort = (x: unknown): unknown =>
    x === null || typeof x !== "object"
      ? x
      : Array.isArray(x)
        ? x.map(sort)
        : Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
  return JSON.stringify(sort(JSON.parse(JSON.stringify(v ?? {}))));
};

/** Load and validate a config file. A `.ts` file is folded unless `mode` says otherwise. */
export async function loadConfig(path: string, mode: ConfigMode = "fold"): Promise<TerragucciConfig> {
  if (!existsSync(path)) throw new ConfigError(`${path} does not exist`);
  if (path.endsWith(".ts")) {
    if (mode === "run") return validateConfig(await runConfig(path), path);
    const folded = await foldConfig(path);
    if (mode === "check") {
      const ran = await runConfig(path);
      if (canonical(folded) !== canonical(ran)) {
        throw new ConfigError(`${path}: folding and running the config disagree, so it is not data`);
      }
    }
    return validateConfig(folded, path);
  }
  const text = readFileSync(path, "utf-8");
  let raw: unknown;
  try {
    raw = path.endsWith(".json") ? JSON.parse(text) : text.trim() === "" ? {} : parseYAML(text);
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
  return validateConfig(raw, path);
}

// ── projects ─────────────────────────────────────────────────────────────────

export interface ProjectKey {
  key: string;
  host: string;
  /** Everything after the host: owner/name, or a GitLab group path and name. */
  path: string;
  owner: string;
  name: string;
}

/** Split `<host>/<path>`. The host is the first segment; the path needs an owner and a name. */
export function parseProjectKey(key: string): ProjectKey {
  const clean = key.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  if (parts.length < 3 || parts.some((p) => p === "")) {
    throw new ConfigError(`project key "${key}" must be <host>/<owner>/<name>, such as github.com/acme/infra`);
  }
  const [host, ...rest] = parts;
  return { key, host, path: rest.join("/"), owner: rest.slice(0, -1).join("/"), name: rest[rest.length - 1] };
}

/** The forge a host belongs to, when the host says so. */
export function forgeFromHost(host: string): ForgeName | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h === "github.com" || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.startsWith("gitlab.") || h.includes(".gitlab.")) return "gitlab";
  if (h === "codeberg.org" || h.startsWith("forgejo.") || h.startsWith("gitea.") || h.includes("forgejo")) return "forgejo";
  return undefined;
}

/** One repo's settings: built-in defaults, then the file's own keys. */
export function resolveRepo(config: TerragucciConfig): ResolvedSettings {
  if (config.projects) {
    throw new ConfigError("this config lists projects, so it belongs to a control repo; run terragucci reconcile instead");
  }
  return merge(BUILT_IN, config);
}

/** A control repo's project: built-in defaults, then `defaults`, then the project's own keys. */
export function resolveProject(config: TerragucciConfig, key: string): ResolvedSettings {
  const project = config.projects?.[key];
  if (project === undefined) throw new ConfigError(`no project "${key}" in the config`);
  return merge(merge(BUILT_IN, config.defaults ?? {}), project ?? {});
}

function merge(base: ResolvedSettings, over: ProjectSettings): ResolvedSettings {
  const { defaults: _d, projects: _p, ...settings } = over as TerragucciConfig;
  const out: ResolvedSettings = { ...base, ...settings, env: { ...base.env, ...(settings.env ?? {}) } };
  if (base.waves || settings.waves) out.waves = { ...base.waves, ...settings.waves };
  return out;
}
