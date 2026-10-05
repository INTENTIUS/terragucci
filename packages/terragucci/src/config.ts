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
export const DEPENDENTS = ["follow", "plan"] as const;
export const POLICY_ENGINES = ["conftest", "opa"] as const;

export type Binary = (typeof BINARIES)[number];
export type ForgeName = (typeof FORGES)[number];
export type Gate = (typeof GATES)[number];
export type Runtime = (typeof RUNTIMES)[number];
export type Dependents = (typeof DEPENDENTS)[number];
export type PolicyEngine = (typeof POLICY_ENGINES)[number];

/**
 * Policy as code, off unless set. `tf-plan` runs the engine over each planned
 * root's plan JSON and fails the root on a denial. No response, agent or
 * comment can waive it.
 */
export interface PolicySettings {
  /** The engine. Default `conftest`, which terragucci installs on demand when it is not on the path. */
  engine?: PolicyEngine;
  /** The directory of Rego policy, relative to the repo root. Default `policy`. */
  path?: string;
  /** The Rego package whose `deny` rules count. conftest default: every namespace. opa default: `main`. */
  namespace?: string;
}

/** A plan role and an apply role, for the units under one path. */
export interface RolePair {
  plan: string;
  apply: string;
}

/**
 * Terragrunt settings. Terragrunt mode is detected (`root.hcl`,
 * `terragrunt.hcl` or `terragrunt.stack.hcl`); this block only tunes it.
 */
export interface TerragruntSettings {
  /** The Terragrunt release the pipeline installs. Default: the one terragucci's image carries. */
  version?: string;
  /** Unit globs discovery leaves out, beside `catalog/**` and the module cache. */
  exclude?: string[];
  /** How many units one `run --all` runs at once. Default: from the state backend. */
  parallelism?: number;
  /** Units that depend on a changed unit: `follow` plans them in later waves, `plan` also previews them at pull-request time. */
  dependents?: Dependents;
  /**
   * Plan and apply roles by unit path glob, assumed over OIDC through a
   * generated auth-provider-cmd. A unit that sets its own `iam_role` keeps it.
   */
  credentials?: Record<string, RolePair>;
}

/**
 * Pipeline events and the responses each takes. The first mode is the
 * default and needs no model; `agent` adds an agent's comment or proposal on
 * top of the deterministic response, and is never the default.
 */
export const RESPONSES = {
  plan: ["summary", "agent"],
  "wave-refused": ["diff", "off"],
  "apply-failed": ["triage", "agent", "off"],
  drift: ["pull-request", "agent", "off"],
  tips: ["pull-request", "off"],
  fmt: ["commit", "off"],
  publish: ["notes", "agent", "off"],
  rollout: ["next-wave", "off"],
  question: ["off", "agent"],
} as const;
export type RespondEvent = keyof typeof RESPONSES;
export const AGENT_VIA = ["forge", "fountain"] as const;

/** The services `decide:` can name; each speaks the Jev request and response shape. */
export const DECIDE_BACKENDS = ["laya", "von", "decider", "jev"] as const;
export type DecideBackend = (typeof DECIDE_BACKENDS)[number];
export const QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * `decide:`: the typed-decision service the opt-in uses ask (terragucci#28).
 * With no `decide:`, every use runs its deterministic response.
 */
export interface DecideSettings {
  /** Which service answers: laya (the terragucci-decide image), von, decider or jev. */
  backend: DecideBackend;
  /** The service's base URL; `/v1/systemone` is appended. Required except for jev, which defaults to TypeSafe's. */
  url?: string;
  /** The pinned model version. Required except for laya, which defaults to the version terragucci-decide serves. */
  model?: string;
  /** The environment variable holding the service's bearer token. Required for jev. */
  token_env?: string;
  /** The probability an answer needs before a use acts on it, per question type, between 0 and 1. */
  thresholds?: Partial<Record<QuestionType, number>>;
}

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
  /** The secret holding `OTEL_EXPORTER_OTLP_HEADERS`, such as a collector's API key. */
  telemetry?: { headers_secret: string };
  tips?: boolean;
  modules?: { path?: string; publish?: string | string[] };
  /**
   * Cloud roles the pipeline assumes over OIDC, so no long-lived keys sit in CI.
   * Plan runs pull-request code and gets the read-only role; apply gets the
   * write role. The two must differ.
   */
  oidc?: { plan_role: string; apply_role: string; audience?: string };
  /** Whether removing the project from a control repo removes its generated files. */
  owned?: boolean;
  /** How many roots of one dependency layer plan at once. Default: from the state backend. */
  parallelism?: number;
  /** Terragrunt settings, for a repo terragucci finds Terragrunt in. */
  terragrunt?: TerragruntSettings;
  /** Opt-in policy checks over each plan; see PolicySettings. */
  policy?: PolicySettings;
  /** The response to each pipeline event; see RESPONSES. */
  respond?: Partial<Record<RespondEvent, string>>;
  /**
   * Where an agent response runs, for any event set to `agent`. Its token can
   * comment and open pull requests; its role, when named, is read-only.
   */
  agent?: { via: (typeof AGENT_VIA)[number]; token_env: string; role?: string };
  /** The typed-decision service; see DecideSettings. Off when absent. A project's `decide` replaces the defaults' whole. */
  decide?: DecideSettings;
}

/** The whole file: one repo's settings, or `defaults` and `projects` for many repos. */
export interface TerragucciConfig extends ProjectSettings {
  defaults?: ProjectSettings;
  projects?: Record<string, ProjectSettings>;
}

/** The response a project takes to an event: its setting, or the event's default. */
export function responseTo(settings: ProjectSettings, event: RespondEvent): string {
  return settings.respond?.[event] ?? RESPONSES[event][0];
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
  /** Every problem found, when the error is a validation failure. */
  readonly problems?: string[];
  constructor(message: string, problems?: string[]) {
    super(message);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** A `--mode` value: dry-run or apply. */
export function checkMode(mode: string): "dry-run" | "apply" {
  if (mode !== "dry-run" && mode !== "apply") throw new ConfigError("--mode must be dry-run or apply");
  return mode;
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
  "reports", "token_env", "env", "telemetry", "tips", "modules", "owned", "oidc", "parallelism", "terragrunt", "policy", "respond", "agent", "decide",
]);

const TERRAGRUNT_KEYS = ["version", "exclude", "parallelism", "dependents", "credentials"];

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
  if (s.telemetry !== undefined) {
    const t = s.telemetry;
    if (!isObject(t)) problems.push(`${where}.telemetry must be a map with headers_secret`);
    else {
      for (const k of Object.keys(t)) if (k !== "headers_secret") problems.push(`${where}.telemetry.${k} is not a setting (settings: headers_secret)`);
      if (typeof t.headers_secret !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.headers_secret)) {
        problems.push(`${where}.telemetry.headers_secret must name the secret holding the OTLP headers, such as OTLP_HEADERS`);
      }
    }
  }
  if (s.reports !== undefined && !(isObject(s.reports) && typeof s.reports.bucket === "string")) {
    problems.push(`${where}.reports must name a bucket`);
  }
  if (s.oidc !== undefined) {
    const o = s.oidc;
    if (!isObject(o)) problems.push(`${where}.oidc must be a map with plan_role and apply_role`);
    else {
      for (const k of Object.keys(o)) {
        if (!["plan_role", "apply_role", "audience"].includes(k)) problems.push(`${where}.oidc.${k} is not a setting (settings: plan_role, apply_role, audience)`);
      }
      for (const k of ["plan_role", "apply_role"] as const) {
        if (typeof o[k] !== "string" || o[k] === "") problems.push(`${where}.oidc.${k} must name a role, one for plan and one for apply`);
      }
      if (o.audience !== undefined && typeof o.audience !== "string") problems.push(`${where}.oidc.audience must be a string`);
      if (typeof o.plan_role === "string" && o.plan_role === o.apply_role) {
        problems.push(`${where}.oidc.plan_role and apply_role are the same role; plan runs pull-request code, so give it a read-only role of its own`);
      }
    }
  }
  if (s.parallelism !== undefined && !(Number.isInteger(s.parallelism) && (s.parallelism as number) >= 1)) {
    problems.push(`${where}.parallelism must be a whole number of 1 or more`);
  }
  if (s.terragrunt !== undefined) checkTerragrunt(s.terragrunt, `${where}.terragrunt`, problems);
  if (s.policy !== undefined) checkPolicy(s.policy, `${where}.policy`, problems);
  if (s.respond !== undefined) {
    if (!isObject(s.respond)) problems.push(`${where}.respond must map events to responses`);
    else {
      for (const [event, mode] of Object.entries(s.respond)) {
        const modes = (RESPONSES as Record<string, readonly string[]>)[event];
        if (!modes) problems.push(`${where}.respond.${event} is not an event (events: ${Object.keys(RESPONSES).join(", ")})`);
        else oneOf(mode, modes, `${where}.respond.${event}`, problems);
      }
    }
  }
  if (s.agent !== undefined) {
    const a = s.agent;
    if (!isObject(a)) problems.push(`${where}.agent must be a map with via and token_env`);
    else {
      for (const k of Object.keys(a)) if (!["via", "token_env", "role"].includes(k)) problems.push(`${where}.agent.${k} is not a setting (settings: via, token_env, role)`);
      if (a.via === undefined) problems.push(`${where}.agent.via is missing; use forge or fountain`);
      else oneOf(a.via, AGENT_VIA, `${where}.agent.via`, problems);
      if (typeof a.token_env !== "string" || a.token_env === "") problems.push(`${where}.agent.token_env must name the variable holding the agent's forge token`);
      if (a.role !== undefined && typeof a.role !== "string") problems.push(`${where}.agent.role must name a read-only role`);
    }
  }
  if (s.decide !== undefined) checkDecide(s.decide, `${where}.decide`, problems);
  if (s.modules !== undefined) {
    if (!isObject(s.modules)) problems.push(`${where}.modules must be a map`);
    else {
      if (s.modules.path !== undefined && typeof s.modules.path !== "string") problems.push(`${where}.modules.path must be a glob`);
      const targets = Array.isArray(s.modules.publish) ? s.modules.publish : s.modules.publish === undefined ? [] : [s.modules.publish];
      for (const t of targets) {
        if (typeof t !== "string" || !(t === "git-tags" || /^oci:\/\/[^/]+\/.+/.test(t))) {
          problems.push(`${where}.modules.publish is ${JSON.stringify(t)}; use an oci:// registry address or git-tags`);
        }
      }
    }
  }
}

function checkPolicy(p: unknown, where: string, problems: string[]): void {
  if (!isObject(p)) {
    problems.push(`${where} must be a map (settings: engine, path, namespace)`);
    return;
  }
  for (const k of Object.keys(p)) if (!["engine", "path", "namespace"].includes(k)) problems.push(`${where}.${k} is not a setting (settings: engine, path, namespace)`);
  oneOf(p.engine, POLICY_ENGINES, `${where}.engine`, problems);
  if (p.path !== undefined && (typeof p.path !== "string" || p.path === "" || p.path.startsWith("/") || p.path.split("/").includes(".."))) {
    problems.push(`${where}.path must be a directory inside the repo, such as policy`);
  }
  if (p.namespace !== undefined && !(typeof p.namespace === "string" && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(p.namespace))) {
    problems.push(`${where}.namespace must be a Rego package name, such as terraform.plan`);
  }
}

const DECIDE_KEYS = ["backend", "url", "model", "token_env", "thresholds"];

function checkDecide(d: unknown, where: string, problems: string[]): void {
  if (!isObject(d)) {
    problems.push(`${where} must be a map (settings: ${DECIDE_KEYS.join(", ")})`);
    return;
  }
  for (const k of Object.keys(d)) {
    if (!DECIDE_KEYS.includes(k)) problems.push(`${where}.${k} is not a setting (settings: ${DECIDE_KEYS.join(", ")})`);
  }
  if (d.backend === undefined) problems.push(`${where}.backend is missing; use one of ${DECIDE_BACKENDS.join(", ")}`);
  else oneOf(d.backend, DECIDE_BACKENDS, `${where}.backend`, problems);
  for (const k of ["url", "model", "token_env"] as const) {
    if (d[k] !== undefined && (typeof d[k] !== "string" || d[k] === "")) problems.push(`${where}.${k} must be a string`);
  }
  if (typeof d.url === "string" && !/^https?:\/\/[^/\s]+/.test(d.url)) problems.push(`${where}.url must be an http or https URL, such as http://localhost:8790`);
  if (d.url === undefined && d.backend !== "jev" && d.backend !== undefined) problems.push(`${where}.url is missing; name the service's base URL`);
  if (d.model === undefined && d.backend !== "laya" && d.backend !== undefined) {
    problems.push(`${where}.model is missing; pin the model version the ${String(d.backend)} service answers as`);
  }
  if (typeof d.model === "string" && /(^|[-_.])(latest|preview)$/.test(d.model)) {
    problems.push(`${where}.model is ${d.model}, an alias that moves when a new version ships; pin a versioned id, such as jev-1.13.0`);
  }
  if (d.backend === "jev" && d.token_env === undefined) problems.push(`${where}.token_env is missing; name the variable holding the Jev API key`);
  if (typeof d.token_env === "string" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.token_env)) problems.push(`${where}.token_env must name an environment variable`);
  if (d.thresholds !== undefined) {
    if (!isObject(d.thresholds)) problems.push(`${where}.thresholds must map question types (${QUESTION_TYPES.join(", ")}) to a probability`);
    else {
      for (const [k, v] of Object.entries(d.thresholds)) {
        if (!(QUESTION_TYPES as readonly string[]).includes(k)) problems.push(`${where}.thresholds.${k} is not a question type (types: ${QUESTION_TYPES.join(", ")})`);
        else if (typeof v !== "number" || !(v > 0 && v <= 1)) problems.push(`${where}.thresholds.${k} must be a probability above 0 and at most 1`);
      }
    }
  }
}

function checkTerragrunt(t: unknown, where: string, problems: string[]): void {
  if (!isObject(t)) {
    problems.push(`${where} must be a map (settings: ${TERRAGRUNT_KEYS.join(", ")})`);
    return;
  }
  for (const k of Object.keys(t)) {
    if (!TERRAGRUNT_KEYS.includes(k)) problems.push(`${where}.${k} is not a setting (settings: ${TERRAGRUNT_KEYS.join(", ")})`);
  }
  if (t.version !== undefined) {
    const m = typeof t.version === "string" ? /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?$/.exec(t.version) : null;
    if (!m) problems.push(`${where}.version must be a release version such as 1.1.6`);
    else if (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 1)) {
      problems.push(`${where}.version is ${t.version}; terragucci needs Terragrunt 1.1 or later`);
    }
  }
  stringList(t.exclude, `${where}.exclude`, problems);
  if (t.parallelism !== undefined && !(Number.isInteger(t.parallelism) && (t.parallelism as number) >= 1)) {
    problems.push(`${where}.parallelism must be a whole number of 1 or more`);
  }
  oneOf(t.dependents, DEPENDENTS, `${where}.dependents`, problems);
  if (t.credentials !== undefined) {
    if (!isObject(t.credentials)) {
      problems.push(`${where}.credentials must map unit path globs to a plan role and an apply role`);
      return;
    }
    for (const [glob, pair] of Object.entries(t.credentials)) {
      const at = `${where}.credentials["${glob}"]`;
      if (!isObject(pair)) {
        problems.push(`${at} must be a map with plan and apply`);
        continue;
      }
      for (const k of Object.keys(pair)) {
        if (k !== "plan" && k !== "apply") problems.push(`${at}.${k} is not a setting (settings: plan, apply)`);
      }
      for (const k of ["plan", "apply"] as const) {
        if (typeof pair[k] !== "string" || pair[k] === "") problems.push(`${at}.${k} must name a role`);
      }
      if (typeof pair.plan === "string" && pair.plan === pair.apply) {
        problems.push(`${at} uses one role for plan and apply; plan runs pull-request code, so give it a read-only role of its own`);
      }
    }
  }
}

/**
 * An `agent` response needs somewhere to run, and the agent never holds the
 * apply role: at most a forge token and read-only cloud credentials.
 */
function checkAgent(s: Record<string, unknown>, where: string, problems: string[]): void {
  const respond = isObject(s.respond) ? s.respond : {};
  const agent = isObject(s.agent) ? s.agent : undefined;
  for (const [event, mode] of Object.entries(respond)) {
    if (mode === "agent" && !agent) {
      problems.push(`${where}.respond.${event} is agent, but no agent integration is configured; add agent with via (forge or fountain) and token_env (the variable holding the agent's forge token)`);
    }
  }
  const oidc = isObject(s.oidc) ? s.oidc : {};
  if (agent?.role !== undefined && agent.role === oidc.apply_role) {
    problems.push(`${where}.agent.role is the apply role; an agent gets read-only credentials at most, so name the plan role or a read-only role of its own`);
  }
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
  const d = isObject(defaults) ? defaults : {};
  if (isObject(projects)) {
    for (const [key, s] of Object.entries(projects)) checkAgent({ ...d, ...(isObject(s) ? s : {}) }, `projects["${key}"]`, problems);
  } else checkAgent(rest, "config", problems);
  if (problems.length) throw new ConfigError(`${where} has ${problems.length} problem(s):\n  ${problems.join("\n  ")}`, problems);
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

/** The TypeScript folder ships separately; only a `.ts` config needs it. */
export const TSAD_INSTALL = "npm i -D @intentius/tsad-reference";

async function foldConfig(path: string): Promise<unknown> {
  let tsad: typeof import("@intentius/tsad-reference");
  try {
    tsad = await import("@intentius/tsad-reference");
  } catch {
    throw new ConfigError(`${path} is TypeScript, which needs the TypeScript folder: ${TSAD_INSTALL}`);
  }
  const { foldProject, EMPTY_HOST } = tsad;
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
  if (settings.oidc) out.oidc = { ...base.oidc, ...settings.oidc };
  if (base.terragrunt || settings.terragrunt) out.terragrunt = { ...base.terragrunt, ...settings.terragrunt };
  if (base.respond || settings.respond) out.respond = { ...base.respond, ...settings.respond };
  if (base.policy || settings.policy) out.policy = { ...base.policy, ...settings.policy };
  if (base.waves || settings.waves) out.waves = { ...base.waves, ...settings.waves };
  return out;
}
