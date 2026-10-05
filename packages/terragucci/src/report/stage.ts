/**
 * `terragucci stage tf-plan`: plan the roots a change reaches (every root
 * when there is no base to diff against), keep each root's full plan, and
 * write the run's report. Each root is planned to a plan file, shown as
 * JSON and as text; the JSON is redacted before it is stored, after its
 * plan digest is taken.
 *
 * `terragucci stage tf-drift` does the same with `-refresh-only`, so the
 * report holds only what changed in the real world, never the code waiting
 * on main. It then opens, updates or closes the project's one drift issue.
 * It applies nothing.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { plannerForBinary } from "@intentius/chant-lexicon-terraform/change-set";
import { defaultTerragruntExec, planTerragruntWave, TerragruntMockRefusal, type TerragruntExec, type TerragruntWavePlan } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { stackOfUnit, terragruntDependents, type TerragruntUnit } from "@intentius/chant-lexicon-terraform/terragrunt/units";
import { parseTerragruntReport } from "@intentius/chant-lexicon-terraform/terragrunt/wave";
import { describeTerragruntAffectedReason, findTerragruntAffected } from "@intentius/chant-lexicon-terraform/terragrunt/affected";
// Path rules only: no HCL parser, no compiler.
import { changedRoots } from "@intentius/chant-lexicon-terraform/changed-roots";
// A named import, so the bundle carries the version and not the whole package.json.
import { version as VERSION } from "../../package.json";
import { applyWaves } from "../apply";
import { ConfigError, findConfig, loadConfig, resolveProject, resolveRepo, type ForgeName, type PolicySettings } from "../config";
import { applyLayers, detectBinary, findRoots, globMatch, rootDependencies } from "../detect";
import { detectTerragrunt, discoverUnits, unitWaves } from "../terragrunt";
import { ForgeError, type Fetch } from "../forge";
import { buildReport, planFiles, type RootInput, type WaveInput } from "./build";
import { loadHclParser } from "../rollout/parser";
import { describeTips, repoTips } from "../tips";
import { driftCount, driftNames, driftPlan, renderDriftIssue, targetFromEnv, trackDrift, type DriftIssueResult } from "./drift";
import { redactPlan } from "./redact";
import { checkPlan, describeVerdict, engineBinary, policyPathExists, type PolicyOptions } from "./policy";
import { S3Client, s3FromEnv, type S3Fetch } from "./s3";
import { StageObserver } from "./observe";
import { telemetryFromEnv, type OtlpFetch } from "../telemetry";
import type { Report, ReportDeferred, ReportMockRead, ReportRun } from "./schema";
import { uploadReport, writeReportDir, type Uploaded } from "./store";

export const STAGES = ["tf-plan", "tf-drift"] as const;

export interface StageOptions {
  root?: string;
  project?: string;
  config?: string;
  /** The report directory. Default `terragucci-report` in the repo. */
  out?: string;
  /** Where the note links report.html. Default the relative `report.html`. */
  reportUrl?: string;
  /**
   * The roots in apply order, as the pipeline that runs the stage was written
   * with them, so the stage plans exactly what the pipeline names. Default:
   * the roots found in the repo.
   */
  layers?: string[][];
  /** The binary, when the pipeline names it. Default: the config's, then detection. */
  binary?: string;
  /** Where to copy the report, when the pipeline names a bucket. Default: the config's `reports`. */
  reports?: { bucket: string; endpoint?: string; prefix?: string };
  /** Globs for wave 1. Default: the config's `waves.canary`. */
  canary?: string[];
  /** tf-drift: the forge the drift issue lives on, when the environment alone does not say. */
  forge?: ForgeName;
  /** tf-drift: the token that opens the issue. Default `TG_TOKEN` in the environment. */
  token?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: S3Fetch;
  /** Where traces and metrics go. Default: Node's fetch. */
  otlpFetch?: OtlpFetch;
  /** Plan Terragrunt units, one `run --all` per wave. Default: when the repo is a Terragrunt repo. */
  terragrunt?: boolean;
  /** The `terragrunt` executable. Default: `TERRAGUCCI_TERRAGRUNT`, then `terragrunt` on the path. */
  terragruntPath?: string;
  terragruntExec?: TerragruntExec;
  /** The base of the range affected selection reads (`origin/main`). Default: the pull request's target branch. */
  base?: string;
  /** tf-drift: the forge's API. Default the global fetch. */
  forgeFetch?: Fetch;
  /** How many roots of a layer plan at once. Default: the config's `parallelism`, then from the state backend. */
  parallelism?: number;
  /** tf-plan with `policy:` set: how the engine runs and is fetched. Default: the real thing. */
  policy?: PolicyOptions;
}

/** `a,b;c` as layers: commas inside a layer, semicolons between. */
export function parseLayers(text: string): string[][] {
  return text.split(";").map((l) => l.split(",").map((r) => r.trim()).filter(Boolean)).filter((l) => l.length > 0);
}

/** Layers as `--layers` takes them. */
export const formatLayers = (layers: string[][]): string => layers.map((l) => l.join(",")).join(";");

export interface StageResult {
  report: Report;
  dir: string;
  uploaded?: Uploaded;
  failed: boolean;
  /** tf-drift: what happened to the drift issue. */
  issue?: DriftIssueResult & { error?: string };
}

function git(repo: string, ...args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || undefined : undefined;
}

/** `host/path` from a git remote URL, https or ssh. */
export function projectFromRemote(url: string): string | undefined {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The run's facts, from the CI environment when there is one and from git when not. */
export function runFacts(repo: string, env: NodeJS.ProcessEnv): Pick<ReportRun, "project" | "commit" | "base" | "job_url"> {
  let project: string | undefined;
  let job_url: string | undefined;
  if (env.GITHUB_REPOSITORY) {
    const server = env.GITHUB_SERVER_URL ?? "https://github.com";
    project = `${new URL(server).host}/${env.GITHUB_REPOSITORY}`;
    if (env.GITHUB_RUN_ID) job_url = `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  } else if (env.CI_PROJECT_PATH) {
    project = `${env.CI_SERVER_HOST ?? "gitlab.com"}/${env.CI_PROJECT_PATH}`;
    job_url = env.CI_JOB_URL;
  }
  project ??= (() => {
    const remote = git(repo, "remote", "get-url", "origin");
    return remote ? projectFromRemote(remote) : undefined;
  })() ?? basename(resolve(repo));
  const commit = env.TG_SHA || env.GITHUB_SHA || env.CI_COMMIT_SHA || git(repo, "rev-parse", "HEAD") || "unknown";
  const base = env.GITHUB_BASE_REF || env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || undefined;
  return { project, commit, ...(base ? { base } : {}), ...(job_url ? { job_url } : {}) };
}

function tfFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".tf") && statSync(join(dir, n)).isFile()).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/**
 * `type.name` of every resource declared with `prevent_destroy = true`, in
 * the root and the local modules it calls. The plan JSON does not carry the
 * lifecycle block, so the source is read.
 */
export function preventDestroyIn(rootDir: string): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const visit = (dir: string) => {
    const d = resolve(dir);
    if (seen.has(d)) return;
    seen.add(d);
    for (const f of tfFiles(d)) {
      const src = readFileSync(f, "utf-8");
      const blocks = src.split(/^(?=(?:resource|data|module|variable|output|locals|provider|terraform)\b)/m);
      for (const b of blocks) {
        const r = /^resource\s+"([^"]+)"\s+"([^"]+)"/.exec(b);
        if (r && /prevent_destroy\s*=\s*true/.test(b)) out.add(`${r[1]}.${r[2]}`);
        const m = /^module\s+"[^"]+"[\s\S]*?\bsource\s*=\s*"(\.\.?\/[^"]+)"/.exec(b);
        if (m) visit(join(d, m[1]));
      }
    }
  };
  visit(rootDir);
  return out;
}

/**
 * Whether a root's state holds nothing: no resources and no outputs. Read
 * with `init` and `state pull` in the root. Undefined when it cannot be
 * read (no credentials, no backend), so a root is held back only on a state
 * that was read and found empty.
 */
export function stateIsEmpty(binary: string, dir: string, env: NodeJS.ProcessEnv): boolean | undefined {
  const opts = { encoding: "utf-8" as const, maxBuffer: 512 * 1024 * 1024, env };
  const init = spawnSync(binary, [`-chdir=${dir}`, "init", "-input=false", "-no-color"], opts);
  if (init.status !== 0) return undefined;
  const pull = spawnSync(binary, [`-chdir=${dir}`, "state", "pull"], opts);
  if (pull.status !== 0) return undefined;
  return emptyStateText(pull.stdout);
}

/** `stateIsEmpty` without blocking, its init taking its turn with the roots' inits. */
export async function stateIsEmptyAsync(binary: string, dir: string, env: NodeJS.ProcessEnv, initTurn: Turn = (fn) => fn()): Promise<boolean | undefined> {
  const init = await initTurn(() => spawnAsync(binary, [`-chdir=${dir}`, "init", "-input=false", "-no-color"], env));
  if (init.status !== 0) return undefined;
  const pull = await spawnAsync(binary, [`-chdir=${dir}`, "state", "pull"], env);
  if (pull.status !== 0) return undefined;
  return emptyStateText(pull.stdout);
}

/** What one run of the binary printed and how it exited, read without blocking the other roots. */
export interface Spawned {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export function spawnAsync(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Spawned> {
  return new Promise((done) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let error: Error | undefined;
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => (error = e));
    child.on("close", (code) => done({ status: error ? null : code, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8"), ...(error ? { error } : {}) }));
  });
}

/** Runs a piece of work after the one before it finished. */
type Turn = <T>(fn: () => Promise<T>) => Promise<T>;

export function oneAtATime(): Turn {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const r = last.then(fn);
    last = r.catch(() => undefined);
    return r;
  };
}

/**
 * Run `fn` over `items`, at most `limit` at once, taking them in order. A
 * throw stops new items from starting, waits for the running ones, and is
 * rethrown, so nothing is left running when the caller cleans up.
 */
export async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { e: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (e) {
        failure ??= { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw failure.e;
}

/** One root's plan, or why it was held back, before it joins the report. */
interface RootOutcome {
  root: string;
  lines: string[];
  input?: RootInput;
  plan?: { text?: string; json?: string };
  names?: Map<string, string>;
  redacted?: number;
  deferred?: ReportDeferred;
}

const GITLAB_STATE = /\/api\/v4\/projects\/[^"\s]*\/terraform\/state\//;

/**
 * How many roots of a layer plan at once: the config's `parallelism`, else
 * from the roots' state backend, as Terragrunt mode sets it. GitLab-managed
 * state rate-limits concurrent inits, so it gets 3; every other backend 16.
 * GitLab state is an `http` backend whose address, in the root or in
 * `TF_HTTP_ADDRESS`, is a GitLab project's state API.
 */
export function rootsParallelism(repo: string, roots: readonly string[], settings: { parallelism?: number }, env: NodeJS.ProcessEnv = {}): { value: number; reason: string } {
  if (settings.parallelism !== undefined) return { value: settings.parallelism, reason: "terragucci.yml" };
  const backends = new Set<string>();
  let gitlab = false;
  for (const root of roots) {
    for (const f of tfFiles(join(repo, root))) {
      const text = readFileSync(f, "utf-8").replace(/(^|[^:"])(#|\/\/).*$/gm, "$1");
      for (const m of text.matchAll(/\bbackend\s+"([^"]+)"\s*\{([^}]*)\}/g)) {
        backends.add(m[1]);
        if (m[1] === "http" && (GITLAB_STATE.test(m[2]) || GITLAB_STATE.test(env.TF_HTTP_ADDRESS ?? ""))) gitlab = true;
      }
    }
  }
  if (gitlab) return { value: 3, reason: "GitLab-managed state rate-limits concurrent inits" };
  const named = [...backends].sort();
  return { value: 16, reason: named.length === 1 ? `the ${named[0]} backend` : named.length > 1 ? `the ${named.join(", ")} backends` : "the default" };
}

/** `state pull` output with no resources and no outputs, or no output at all. */
export function emptyStateText(text: string): boolean | undefined {
  if (text.trim() === "") return true;
  try {
    const st = JSON.parse(text) as { resources?: unknown[]; outputs?: Record<string, unknown> };
    return (st.resources?.length ?? 0) === 0 && Object.keys(st.outputs ?? {}).length === 0;
  } catch {
    return undefined;
  }
}

const tail = (s: string, n = 40): string => s.trim().split("\n").slice(-n).join("\n");

/** Why a unit is in the plan. Affected selection (Terragrunt's git range and chant's supplements) replaces this. */
const SELECTED_ALL = "every unit: affected selection is not built yet";

/**
 * Plan a Terragrunt repo's units, one `terragrunt run --all` per wave, and
 * read each unit's plan JSON and run-report row.
 *
 * A wave whose plans would read `mock_outputs` is refused by chant before
 * anything is planned. The refused units come out and the rest of the wave
 * plans. A unit whose upstream has no outputs yet waits: it plans in a later
 * wave, after the upstream applied. With `dependents: plan` it is also
 * previewed here, marked provisional, so no digest or group of real plans
 * takes it. A unit whose block always reads its mocks (`skip_outputs`,
 * `enabled = false`) fails.
 */
async function planUnits(
  repo: string,
  waves: string[][],
  binary: string,
  work: string,
  options: StageOptions & { dependents?: "follow" | "plan"; selection: (unit: string) => string; preview: string[]; drift?: boolean; observer?: StageObserver },
  log: (line: string) => void,
): Promise<{ inputs: RootInput[]; plans: Map<string, { text?: string; json?: string }>; redacted: number; mockReads: ReportMockRead[]; waiting: string[]; names: Map<string, Map<string, string>> }> {
  const drift = options.drift === true;
  const names = new Map<string, Map<string, string>>();
  const planner = plannerForBinary(binary);
  const inputs: RootInput[] = [];
  const plans = new Map<string, { text?: string; json?: string }>();
  const mockReads: ReportMockRead[] = [];
  let redacted = 0;
  const terragrunt = options.terragruntPath ?? (options.env ?? process.env).TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  const exec = drift ? refreshOnlyExec(options.terragruntExec) : options.terragruntExec;
  const run = { dir: repo, binary, terragrunt, ...(exec ? { exec } : {}) };

  const read = (workDir: string, wave: TerragruntWavePlan, provisional: boolean): void => {
    if (wave.code !== 0 && wave.code !== 2) log(tail(wave.log));
    if (options.observer) for (const [unit, secs] of unitSeconds(join(workDir, "plan-report.json"))) options.observer.unitTimed(unit, secs);
    const results = new Map(wave.results.map((r) => [r.unit, r]));
    for (const part of wave.parts) {
      const path = part.member.member;
      const result = results.get(path);
      const unit = { stack: stackOfUnit(path), selection: options.selection(path), provisional, run_result: result?.result ?? "not run" };
      const file = join(workDir, "json", path, "tfplan.json");
      let plan: unknown;
      if (part.member.status !== "failed" && existsSync(file)) {
        try {
          plan = JSON.parse(readFileSync(file, "utf-8"));
        } catch {
          plan = undefined;
        }
      }
      if (plan === undefined) {
        const error = part.member.error ?? "Terragrunt reported the unit planned but wrote no plan JSON for it";
        inputs.push({ path, planner, error, preventDestroy: new Set(), terragrunt: unit });
        log(`${path}: ${error.split("\n")[0]}`);
        continue;
      }
      const safe = redactPlan(plan);
      redacted += safe.values;
      plans.set(path, { json: JSON.stringify(safe.plan, null, 2) + "\n" });
      if (drift) names.set(path, driftNames(plan));
      inputs.push({ path, plan: drift ? driftPlan(plan) : plan, planner, files: { json: planFiles(path).json }, preventDestroy: new Set(), terragrunt: unit });
      log(drift ? `${path}: ${driftCount(plan) === 0 ? "no drift" : `${driftCount(plan)} resource${driftCount(plan) === 1 ? "" : "s"} drifted`}` : `${path}: ${provisional ? "previewed (provisional)" : "planned"}`);
    }
  };

  const allWaiting: string[] = [];
  for (const [i, wave] of waves.entries()) {
    let units = [...wave];
    const waiting: string[] = [];
    // Each refusal names every read of the units it checked, so one pass takes them all out.
    for (let attempt = 0; units.length > 0 && attempt < 2; attempt++) {
      const workDir = join(work, `wave-${i + 1}${attempt ? `-${attempt}` : ""}`);
      try {
        read(workDir, await planTerragruntWave({ ...run, units, workDir }), false);
        units = [];
      } catch (e) {
        if (!(e instanceof TerragruntMockRefusal)) {
          const error = (e as Error).message;
          for (const path of units) {
            inputs.push({ path, planner, error, preventDestroy: new Set(), terragrunt: { stack: stackOfUnit(path), selection: options.selection(path), provisional: false, run_result: "not run" } });
          }
          log(`wave ${i + 1}: ${error}`);
          units = [];
          break;
        }
        log(`wave ${i + 1}: ${e.message}`);
        mockReads.push(...e.reads.map((r) => ({ unit: r.unit, dependency: r.dependency, upstream: r.upstream, reason: r.reason, ...(r.keys ? { keys: r.keys } : {}) })));
        // Each refused unit waits; mock_reads says why, and which upstream it waits for.
        const refused = new Set(e.reads.map((r) => r.unit));
        waiting.push(...refused);
        units = units.filter((u) => !refused.has(u));
      }
    }
    allWaiting.push(...waiting);
  }
  // Dependents of changed units, and units waiting for an upstream, previewed when the project asks.
  const preview = options.dependents === "plan" ? [...new Set([...options.preview, ...allWaiting])].sort() : [];
  if (preview.length > 0) {
    const workDir = join(work, "provisional");
    try {
      read(workDir, await planTerragruntWave({ ...run, units: preview, workDir, provisional: true }), true);
    } catch (e) {
      log(`no provisional preview: ${(e as Error).message}`);
    }
  }
  return { inputs, plans, redacted, mockReads, waiting: allWaiting, names };
}

/** `2026-10-05T10:00:01.123456789Z` as epoch milliseconds; the fraction past milliseconds is dropped. */
export function isoMillis(text: string): number {
  return Date.parse(text.replace(/(\.\d{3})\d+/, "$1"));
}

/**
 * Each unit's time in a wave, from Terragrunt's run report (`Started` and
 * `Ended`), in seconds. Empty when the report is missing or unreadable, and a
 * row without both times is left out.
 */
export function unitSeconds(reportFile: string): Map<string, number> {
  const out = new Map<string, number>();
  let rows: ReturnType<typeof parseTerragruntReport>;
  try {
    rows = parseTerragruntReport(readFileSync(reportFile, "utf-8"));
  } catch {
    return out;
  }
  for (const [unit, row] of rows) {
    if (!row.started || !row.ended) continue;
    const ms = isoMillis(row.ended) - isoMillis(row.started);
    if (Number.isFinite(ms) && ms >= 0) out.set(unit, ms / 1000);
  }
  return out;
}

/**
 * The runner with `-refresh-only` added to the engine's plan command, so a
 * wave's `run --all` plans what the real world changed and not what the code
 * would change. Terragrunt's other calls (render, output) pass through.
 */
function refreshOnlyExec(inner: TerragruntExec = defaultTerragruntExec): TerragruntExec {
  return (file, args, opts) => {
    const at = args.indexOf("--");
    if (at < 0 || args[at + 1] !== "plan") return inner(file, args, opts);
    const next = [...args.slice(0, at + 2), "-refresh-only", "-lock=false", ...args.slice(at + 2)];
    return inner(file, next, opts);
  };
}

export async function runStage(stage: string, repo: string, options: StageOptions = {}, log: (line: string) => void = console.error): Promise<StageResult> {
  if (stage !== "tf-plan" && stage !== "tf-drift") throw new ConfigError(`terragucci stage ${stage || "<name>"}: the stages built so far are ${STAGES.join(", ")}`);
  const drift = stage === "tf-drift";
  const env = options.env ?? process.env;
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const settings = options.project ? resolveProject(config, options.project) : resolveRepo(config);
  if (options.terragrunt ?? detectTerragrunt(repo) !== undefined) {
    return runTerragruntStage(repo, settings, options, env, log, drift);
  }
  const all = options.layers ? options.layers.flat() : findRoots(repo, settings.roots);
  const full = options.layers ?? applyLayers(repo, all);
  const layers = full
    .map((l) => (options.root ? l.filter((r) => globMatch(options.root!, r)) : l))
    .filter((l) => l.length > 0);
  if (layers.length === 0) throw new ConfigError(options.root ? `no root matches ${options.root}` : "found no roots");
  // A pull request plans only the roots its change reaches, and their dependents. Drift reads every root.
  const base = drift ? undefined : (options.base ?? baseRef(env));
  const selected = base ? affectedRoots(repo, base, all, layers.flat(), log) : undefined;
  const planLayers = selected ? layers.map((l) => l.filter((r) => selected.has(r))).filter((l) => l.length > 0) : layers;
  const roots = planLayers.flat();
  if (roots.length === 0) log("this change reaches no root, so nothing is planned");
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, all).value;
  const planner = plannerForBinary(binary);
  const started = new Date().toISOString();
  const observer = new StageObserver(telemetryFromEnv(env), stage, env);
  if (roots.length > 0) await observer.collectSpans(log);
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));
  const limit = options.parallelism !== undefined ? { value: options.parallelism, reason: "--parallelism" } : rootsParallelism(repo, roots, settings, env);
  if (roots.length > 1) log(`planning ${limit.value === 1 ? "one root at a time" : `up to ${limit.value} roots at once`} (${limit.reason})`);
  // Terraform's plugin cache is not safe for inits that run together, so with a shared one they take turns. Plans still run at once.
  const initTurn = env.TF_PLUGIN_CACHE_DIR ? oneAtATime() : <T>(fn: () => Promise<T>) => fn();

  const inputs: RootInput[] = [];
  const plans = new Map<string, { text?: string; json?: string }>();
  const names = new Map<string, Map<string, string>>();
  const deferred: ReportDeferred[] = [];
  const held = new Set<string>();
  const upstreamState = new Map<string, boolean | undefined>();
  const readsOf = drift ? new Map<string, Set<string>>() : rootDependencies(repo, all);
  let redacted = 0;

  /** One root planned, its outcome kept apart so the report and the log take roots in order, not in the order they finish. */
  const planRoot = async (root: string, index: number): Promise<RootOutcome> => {
    const lines: string[] = [];
    const dir = join(repo, root);
    // A root that reads the state of a root nothing has applied cannot plan: hold it back.
    const waitsFor = [...(readsOf.get(root) ?? [])].filter((up) => upstreamState.get(up) === true).sort();
    if (waitsFor.length > 0) {
      lines.push(`${root}: held back, ${waitsFor.join(", ")} has no state yet`);
      return { root, lines, deferred: { unit: root, after: waitsFor, why: `reads the state of ${waitsFor.join(", ")}, which nothing has applied yet, so it cannot plan until then`, previewed: false } };
    }
    const planFile = join(work, `${index}.tfplan`);
    const timing = observer.root(root);
    const run = (...args: string[]) =>
      observer.commandAsync(timing, binary, args, env, (e) => spawnAsync(binary, [`-chdir=${dir}`, ...args], e));
    const failed = (error: string, line: string): RootOutcome => {
      lines.push(line);
      return { root, lines, input: { path: root, planner, error, preventDestroy: new Set() } };
    };
    try {
      const init = await initTurn(() => run("init", "-input=false", "-no-color"));
      if (init.status !== 0) return failed(`init failed:\n${tail(init.stderr || init.stdout)}`, `${root}: init failed`);
      // A plan never writes state, so it takes no lock and never blocks an apply.
      // A refresh-only plan compares the state with the real objects and ignores the code.
      const p = await run("plan", ...(drift ? ["-refresh-only"] : []), "-input=false", "-no-color", "-lock=false", `-out=${planFile}`);
      if (p.status !== 0 || !existsSync(planFile)) return failed(`plan failed:\n${tail(p.stderr || p.stdout)}`, `${root}: plan failed`);
      const json = await run("show", "-json", planFile);
      const text = await run("show", "-no-color", planFile);
      let plan: unknown;
      try {
        plan = JSON.parse(json.stdout);
      } catch {
        return failed(`show -json printed no plan:\n${tail(json.stderr || json.stdout)}`, `${root}: show -json failed`);
      }
      const safe = redactPlan(plan);
      lines.push(drift ? `${root}: ${driftCount(plan) === 0 ? "no drift" : `${driftCount(plan)} resource${driftCount(plan) === 1 ? "" : "s"} drifted`}` : `${root}: ${p.stdout.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned"}`);
      return {
        root, lines, redacted: safe.values,
        plan: { text: text.stdout, json: JSON.stringify(safe.plan, null, 2) + "\n" },
        ...(drift ? { names: driftNames(plan) } : {}),
        input: { path: root, plan: drift ? driftPlan(plan) : plan, planner, files: planFiles(root), preventDestroy: preventDestroyIn(dir) },
      };
    } finally {
      observer.endRoot(timing);
    }
  };

  /** Take an outcome into the run, in root order. */
  const take = (o: RootOutcome): void => {
    o.lines.forEach((l) => log(l));
    if (o.deferred) {
      deferred.push(o.deferred);
      held.add(o.root);
    }
    if (o.input) inputs.push(o.input);
    if (o.plan) plans.set(o.root, o.plan);
    if (o.names) names.set(o.root, o.names);
    redacted += o.redacted ?? 0;
  };

  try {
    let index = 0;
    // Roots in one layer read none of each other's state, so they plan at once. A later layer waits for the layers it reads.
    for (const layer of planLayers) {
      // The upstreams this layer reads, each read once, before any root of the layer plans.
      const ups = [...new Set(layer.flatMap((r) => [...(readsOf.get(r) ?? [])]))].filter((up) => !upstreamState.has(up)).sort();
      await eachLimited(ups, limit.value, async (up) => {
        upstreamState.set(up, await stateIsEmptyAsync(binary, join(repo, up), env, initTurn));
      });
      const first = index;
      index += layer.length;
      const done: (RootOutcome | undefined)[] = new Array(layer.length);
      let next = 0;
      await eachLimited(layer, limit.value, async (root, j) => {
        done[j] = await planRoot(root, first + j);
        // Flush every finished root at the front, so the log reads in root order while the rest still plan.
        for (; next < layer.length && done[next]; next++) take(done[next]!);
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // The apply's waves (canary layers first, one dependency layer each), cut from every root so the numbers match its wave-<k> gates.
  // Drift is not applied, so there are no waves to gate.
  const waves: WaveInput[] = drift
    ? []
    : applyWaves(full, options.canary ?? settings.waves?.canary)
        .map((w, i) => ({ number: i + 1, roots: w.filter((r) => roots.includes(r) && !held.has(r)) }))
        .filter((w) => w.roots.length > 0);

  return finish(repo, settings, options, env, log, { binary, started, inputs, waves, plans, redacted, all, roots, observer, stage, names, ...(deferred.length ? { deferred } : {}) });
}

interface Planned {
  binary: string;
  started: string;
  inputs: RootInput[];
  waves: WaveInput[];
  plans: Map<string, { text?: string; json?: string }>;
  redacted: number;
  mockReads?: ReportMockRead[];
  deferred?: ReportDeferred[];
  /** Directories read for code tips only (a Terragrunt repo's root.hcl). */
  configDirs?: string[];
  /** Every root or unit in the repo, and the ones this run planned. */
  all: string[];
  roots: string[];
  observer: StageObserver;
  /** Default tf-plan. */
  stage?: "tf-plan" | "tf-drift";
  /** tf-drift: the real names of drifted objects, per root. */
  names?: Map<string, Map<string, string>>;
}

/**
 * A Terragrunt repo's tf-plan or tf-drift: its units by wave, as the pipeline
 * names them or as discovery finds them. tf-drift refresh-plans every unit,
 * with no affected selection, and keeps the drift issue.
 */
async function runTerragruntStage(
  repo: string,
  settings: ReturnType<typeof resolveRepo>,
  options: StageOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  drift = false,
): Promise<StageResult> {
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, []).value;
  const canary = drift ? [] : (options.canary ?? settings.waves?.canary ?? []);
  const tool = {
    ...(options.terragruntPath ? { terragrunt: options.terragruntPath } : env.TERRAGUCCI_TERRAGRUNT ? { terragrunt: env.TERRAGUCCI_TERRAGRUNT } : {}),
    ...(options.terragruntExec ? { exec: options.terragruntExec } : {}),
  };
  const base = drift ? undefined : (options.base ?? baseRef(env));
  // Discovery gives the edges that dependents and the canary wave need.
  let units: TerragruntUnit[] | undefined;
  if (!options.layers || base) {
    const found = await discoverUnits(repo, { exclude: settings.terragrunt?.exclude, binary, ...tool });
    found.notes.forEach((n) => log(`note: ${n}`));
    units = found.units;
  }
  let waves = options.layers ?? unitWaves(units!, canary);
  waves = waves.map((w) => (options.root ? w.filter((u) => globMatch(options.root!, u)) : w)).filter((w) => w.length > 0);
  if (waves.length === 0) throw new ConfigError(options.root ? `no unit matches ${options.root}` : "found no Terragrunt units");

  // Affected selection: Terragrunt's git range plus what it misses. Without a base, every unit.
  const reasons = new Map<string, string>();
  let everyUnit = drift ? "every unit: drift checks the whole repo" : SELECTED_ALL;
  const deferred: ReportDeferred[] = [];
  let preview: string[] = [];
  if (base && units) {
    try {
      const affected = await findTerragruntAffected({ dir: repo, base, binary, units, exclude: settings.terragrunt?.exclude, ...tool });
      affected.notes.forEach((n) => log(`note: ${n}`));
      for (const u of affected.units) reasons.set(u.path, u.reasons.map(describeTerragruntAffectedReason).join("; "));
      const changed = [...reasons.keys()];
      const dependents = terragruntDependents(units, changed);
      for (const d of dependents) {
        const after = changed.filter((c) => terragruntDependents(units!, [c]).includes(d));
        reasons.set(d, `depends on ${after.join(", ")}, which changed`);
        deferred.push({ unit: d, after, why: "depends on a changed unit", previewed: settings.terragrunt?.dependents === "plan" });
      }
      preview = dependents;
      const selected = new Set(changed);
      waves = waves.map((w) => w.filter((u) => selected.has(u))).filter((w) => w.length > 0);
      log(`affected: ${changed.length} of ${units.length} units against ${base}, ${dependents.length} dependents after them`);
    } catch (e) {
      everyUnit = `every unit: affected selection failed (${(e as Error).message.split("\n")[0]})`;
      log(everyUnit);
    }
  }
  const started = new Date().toISOString();
  const observer = new StageObserver(telemetryFromEnv(env), drift ? "tf-drift" : "tf-plan", env);
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));
  try {
    const planned = await planUnits(repo, waves, binary, work, {
      ...options, env, drift, dependents: drift ? "follow" : settings.terragrunt?.dependents, preview, observer,
      selection: (u) => reasons.get(u) ?? everyUnit,
    }, log);
    const { inputs, plans, redacted, mockReads } = planned;
    for (const u of planned.waiting) {
      if (drift) {
        // A refresh needs the upstream's real outputs; with none, the unit cannot be checked.
        const error = "its upstream has no outputs yet, so Terragrunt would plan it on mock_outputs";
        inputs.push({ path: u, planner: plannerForBinary(binary), error, preventDestroy: new Set(), terragrunt: { stack: stackOfUnit(u), selection: everyUnit, provisional: false, run_result: "not run" } });
        continue;
      }
      const after = [...new Set(mockReads.filter((r) => r.unit === u).map((r) => r.upstream))].sort();
      deferred.push({ unit: u, after, why: "would read mock_outputs", previewed: settings.terragrunt?.dependents === "plan" });
    }
    const all = (units ?? []).map((u) => u.path);
    const plannedPaths = inputs.map((r) => r.path);
    // A wave covers what it planned for real: no unit that waits for its upstream, and no preview.
    const real = new Set(inputs.filter((r) => !r.terragrunt?.provisional).map((r) => r.path));
    return await finish(repo, settings, options, env, log, {
      binary, started, inputs, plans, redacted, all: all.length ? all : plannedPaths, roots: plannedPaths, observer, mockReads,
      ...(drift ? { stage: "tf-drift" as const, names: planned.names } : {}),
      deferred: deferred.sort((a, b) => (a.unit < b.unit ? -1 : 1)),
      ...(existsSync(join(repo, "root.hcl")) ? { configDirs: ["."] } : {}),
      // Drift is not applied, so there are no waves to gate.
      waves: drift ? [] : waves.map((w) => w.filter((u) => real.has(u))).filter((w) => w.length > 0).map((roots, i) => ({ number: i + 1, roots })),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The roots a change from `base` to HEAD reaches: chant's path rules (a file
 * in the root, in a local module it calls, or one of its var files), plus
 * every root that reads a reached root's state, followed through. Undefined,
 * so every root plans, when git cannot diff the range.
 */
export function affectedRoots(repo: string, base: string, all: string[], roots: string[], log: (line: string) => void): Set<string> | undefined {
  const diff = spawnSync("git", ["-C", repo, "diff", "--name-only", "--no-renames", "--relative", `${base}...HEAD`], { encoding: "utf-8" });
  if (diff.status !== 0) {
    log(`every root: affected selection failed (git diff ${base}...HEAD: ${(diff.stderr || "").trim().split("\n")[0]})`);
    return undefined;
  }
  const files = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const changed = changedRoots(repo, Object.fromEntries(roots.map((r) => [r, { dir: r }])), files);
  const deps = rootDependencies(repo, all);
  const selected = new Set(changed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [root, reads] of deps) {
      if (!selected.has(root) && [...reads].some((d) => selected.has(d))) {
        selected.add(root);
        grew = true;
      }
    }
  }
  for (const r of changed) log(`affected: ${r} changed`);
  for (const r of [...selected].filter((r) => !changed.includes(r)).sort()) {
    log(`affected: ${r} reads the state of ${[...deps.get(r)!].filter((d) => selected.has(d)).sort().join(", ")}`);
  }
  log(`affected: ${changed.length} of ${roots.length} roots against ${base}, ${selected.size - changed.length} dependents after them`);
  return new Set([...selected].filter((r) => roots.includes(r)));
}

/** The base of a pull request's range, from the forge's environment: `origin/<target branch>`. */
export function baseRef(env: NodeJS.ProcessEnv): string | undefined {
  if (env.TG_BASE) return env.TG_BASE;
  const branch = env.GITHUB_BASE_REF || env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  return branch ? `origin/${branch}` : undefined;
}

/**
 * Run the project's policy over each planned root. A root the policy denies
 * becomes a failed root whose error lists the denials; so does one the engine
 * could not check. Nothing reads a response or agent setting, so no path waives it.
 */
async function applyPolicy(repo: string, policy: PolicySettings, inputs: RootInput[], options: PolicyOptions = {}, log: (line: string) => void): Promise<RootInput[]> {
  const engine = policy.engine ?? "conftest";
  const checked = inputs.filter((i) => i.plan !== undefined && i.error === undefined && !i.terragrunt?.provisional);
  if (checked.length === 0) return inputs;
  let binary: string | undefined;
  let setup: string | undefined;
  if (!policyPathExists(policy, repo)) setup = `the policy directory ${policy.path ?? "policy"} does not exist`;
  else {
    try {
      binary = await engineBinary(policy, repo, options);
    } catch (e) {
      setup = (e as Error).message;
    }
  }
  const failed = new Map<string, string>();
  let denied = 0;
  for (const input of checked) {
    const verdict = setup !== undefined || binary === undefined
      ? { violations: [], error: setup ?? "no engine" }
      : await checkPlan(binary, policy, repo, JSON.stringify(input.plan), options);
    if (verdict.error === undefined && verdict.violations.length === 0) {
      log(`${input.path}: policy passed`);
      continue;
    }
    denied += verdict.violations.length;
    failed.set(input.path, describeVerdict(engine, verdict));
    log(`${input.path}: ${verdict.error ? "policy could not be checked" : `policy denied ${verdict.violations.length}`}`);
    for (const m of verdict.violations) log(`  ${m}`);
  }
  if (failed.size > 0) log(`policy: ${failed.size} root${failed.size === 1 ? "" : "s"} failed${denied ? `, ${denied} violation${denied === 1 ? "" : "s"}` : ""}`);
  return inputs.map((i) => {
    const error = failed.get(i.path);
    if (error === undefined) return i;
    const { plan: _plan, ...rest } = i;
    return { ...rest, error };
  });
}

async function finish(
  repo: string,
  settings: ReturnType<typeof resolveRepo>,
  options: StageOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  { binary, started, inputs: planned, waves, plans, redacted, all, roots, observer, mockReads, deferred, configDirs, stage = "tf-plan", names }: Planned,
): Promise<StageResult> {
  let inputs = planned;
  const drift = stage === "tf-drift";
  if (!drift && settings.policy) inputs = await applyPolicy(repo, settings.policy, inputs, options.policy, log);
  const report = buildReport({
    run: { ...runFacts(repo, env), stage, binary, runtime: settings.runtime, started, finished: new Date().toISOString(), terragucci: VERSION },
    roots: inputs,
    waves,
    redacted,
    ...(mockReads?.length ? { mockReads } : {}),
    ...(deferred?.length ? { deferred } : {}),
  });
  // Tips are advice: they read the repo and the finished report, and change neither.
  if (settings.tips) {
    const parser = await loadHclParser().catch(() => undefined);
    if (!parser) log("tips: the HCL parser is not installed, so the lint tips are left out (npm i -D @cdktn/hcl2json)");
    const destroying = [...new Set(report.named.filter((n) => n.action === "delete" || n.action === "replace").map((n) => n.root))];
    try {
      report.tips = await repoTips(repo, all, { settings, ...(parser ? { parser } : {}), destroying, planned: roots.length, ...(configDirs ? { configDirs } : {}) });
    } catch (e) {
      log(`tips: skipped, ${(e as Error).message}`);
      report.tips = [];
    }
    for (const line of describeTips(report.tips)) log(line);
  }
  observer.addTimings(report);
  const dir = resolve(repo, options.out ?? "terragucci-report");
  writeReportDir(dir, report, plans, { ...(options.reportUrl ? { reportUrl: options.reportUrl } : {}) });
  let uploaded: Uploaded | undefined;
  const reports = options.reports ?? settings.reports;
  if (reports?.bucket) {
    const s3 = new S3Client(s3FromEnv(reports, env), options.fetch);
    uploaded = await uploadReport(s3, dir, report, reports.prefix);
  }
  let issue: StageResult["issue"];
  if (drift) {
    const url = options.reportUrl;
    const issueOptions = { ...(names ? { names } : {}), ...(url ? { reportUrl: url } : {}) };
    writeFileSync(join(dir, "issue.md"), renderDriftIssue(report, issueOptions));
    const token = options.token ?? env.TG_TOKEN;
    const target = targetFromEnv(options.forge, env, token);
    if (!target) {
      log("no forge token or no forge in the environment, so the drift issue is left alone");
    } else {
      try {
        issue = await trackDrift(options.forgeFetch ?? (globalThis.fetch as unknown as Fetch), target, report, issueOptions);
        if (issue.action !== "none") log(`drift issue ${issue.action}: ${issue.issue.url}`);
      } catch (e) {
        if (!(e instanceof ForgeError) && !(e instanceof TypeError)) throw e;
        issue = { action: "none", error: e.message };
        log(`the drift issue could not be kept: ${e.message}`);
      }
    }
  }
  await observer.finish(report, env, log, options.otlpFetch);
  return { report, dir, ...(uploaded ? { uploaded } : {}), ...(issue ? { issue } : {}), failed: report.roots.some((r) => r.status === "failed" && !r.terragrunt?.provisional) || issue?.error !== undefined };
}

