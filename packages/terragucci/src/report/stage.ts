/**
 * `terragucci stage tf-plan`: plan every root, keep each root's full plan,
 * and write the run's report. Each root is planned to a plan file, shown as
 * JSON and as text; the JSON is redacted before it is stored, after its
 * plan digest is taken.
 *
 * `terragucci stage tf-drift` does the same with `-refresh-only`, so the
 * report holds only what changed in the real world, never the code waiting
 * on main. It then opens, updates or closes the project's one drift issue.
 * It applies nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { plannerForBinary } from "@intentius/chant-lexicon-terraform/change-set";
import { planTerragruntWave, TerragruntMockRefusal, type TerragruntExec, type TerragruntWavePlan } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { stackOfUnit, terragruntDependents, type TerragruntUnit } from "@intentius/chant-lexicon-terraform/terragrunt/units";
import { describeTerragruntAffectedReason, findTerragruntAffected } from "@intentius/chant-lexicon-terraform/terragrunt/affected";
import pkg from "../../package.json" with { type: "json" };
import { ConfigError, findConfig, loadConfig, resolveProject, resolveRepo, type ForgeName } from "../config";
import { applyLayers, detectBinary, findRoots, globMatch } from "../detect";
import { detectTerragrunt, discoverUnits, unitWaves } from "../terragrunt";
import { ForgeError, type Fetch } from "../forge";
import { buildReport, planFiles, type RootInput, type WaveInput } from "./build";
import { loadHclParser } from "../rollout/parser";
import { describeTips, repoTips } from "../tips";
import { driftCount, driftNames, driftPlan, renderDriftIssue, targetFromEnv, trackDrift, type DriftIssueResult } from "./drift";
import { redactPlan } from "./redact";
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
  options: StageOptions & { dependents?: "follow" | "plan"; selection: (unit: string) => string; preview: string[] },
  log: (line: string) => void,
): Promise<{ inputs: RootInput[]; plans: Map<string, { text?: string; json?: string }>; redacted: number; mockReads: ReportMockRead[]; waiting: string[] }> {
  const planner = plannerForBinary(binary);
  const inputs: RootInput[] = [];
  const plans = new Map<string, { text?: string; json?: string }>();
  const mockReads: ReportMockRead[] = [];
  let redacted = 0;
  const terragrunt = options.terragruntPath ?? (options.env ?? process.env).TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  const run = { dir: repo, binary, terragrunt, ...(options.terragruntExec ? { exec: options.terragruntExec } : {}) };

  const read = (workDir: string, wave: TerragruntWavePlan, provisional: boolean): void => {
    if (wave.code !== 0 && wave.code !== 2) log(tail(wave.log));
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
      inputs.push({ path, plan, planner, files: { json: planFiles(path).json }, preventDestroy: new Set(), terragrunt: unit });
      log(`${path}: ${provisional ? "previewed (provisional)" : "planned"}`);
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
  return { inputs, plans, redacted, mockReads, waiting: allWaiting };
}

export async function runStage(stage: string, repo: string, options: StageOptions = {}, log: (line: string) => void = console.error): Promise<StageResult> {
  if (stage !== "tf-plan" && stage !== "tf-drift") throw new ConfigError(`terragucci stage ${stage || "<name>"}: the stages built so far are ${STAGES.join(", ")}`);
  const drift = stage === "tf-drift";
  const env = options.env ?? process.env;
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const settings = options.project ? resolveProject(config, options.project) : resolveRepo(config);
  if (options.terragrunt ?? detectTerragrunt(repo) !== undefined) {
    if (drift) throw new ConfigError("tf-drift does not plan Terragrunt units yet; it plans Terraform and OpenTofu roots");
    return runTerragruntStage(repo, settings, options, env, log);
  }
  const all = options.layers ? options.layers.flat() : findRoots(repo, settings.roots);
  const layers = (options.layers ?? applyLayers(repo, all))
    .map((l) => (options.root ? l.filter((r) => globMatch(options.root!, r)) : l))
    .filter((l) => l.length > 0);
  const roots = layers.flat();
  if (roots.length === 0) throw new ConfigError(options.root ? `no root matches ${options.root}` : "found no roots");
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, all).value;
  const planner = plannerForBinary(binary);
  const started = new Date().toISOString();
  const observer = new StageObserver(telemetryFromEnv(env), stage, env);
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));

  const inputs: RootInput[] = [];
  const plans = new Map<string, { text?: string; json?: string }>();
  const names = new Map<string, Map<string, string>>();
  let redacted = 0;
  try {
    for (const root of roots) {
      const dir = join(repo, root);
      const planFile = join(work, `${inputs.length}.tfplan`);
      const timing = observer.root(root);
      const run = (...args: string[]) =>
        observer.command(timing, binary, args, env, (e) => spawnSync(binary, [`-chdir=${dir}`, ...args], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024, env: e }));
      try {
        const init = run("init", "-input=false", "-no-color");
        if (init.status !== 0) {
          inputs.push({ path: root, planner, error: `init failed:\n${tail(init.stderr || init.stdout)}`, preventDestroy: new Set() });
          log(`${root}: init failed`);
          continue;
        }
        // A plan never writes state, so it takes no lock and never blocks an apply.
        // A refresh-only plan compares the state with the real objects and ignores the code.
        const p = run("plan", ...(drift ? ["-refresh-only"] : []), "-input=false", "-no-color", "-lock=false", `-out=${planFile}`);
        if (p.status !== 0 || !existsSync(planFile)) {
          inputs.push({ path: root, planner, error: `plan failed:\n${tail(p.stderr || p.stdout)}`, preventDestroy: new Set() });
          log(`${root}: plan failed`);
          continue;
        }
        const json = run("show", "-json", planFile);
        const text = run("show", "-no-color", planFile);
        let plan: unknown;
        try {
          plan = JSON.parse(json.stdout);
        } catch {
          inputs.push({ path: root, planner, error: `show -json printed no plan:\n${tail(json.stderr || json.stdout)}`, preventDestroy: new Set() });
          log(`${root}: show -json failed`);
          continue;
        }
        const safe = redactPlan(plan);
        redacted += safe.values;
        plans.set(root, { text: text.stdout, json: JSON.stringify(safe.plan, null, 2) + "\n" });
        if (drift) names.set(root, driftNames(plan));
        inputs.push({ path: root, plan: drift ? driftPlan(plan) : plan, planner, files: planFiles(root), preventDestroy: preventDestroyIn(dir) });
        log(drift ? `${root}: ${driftCount(plan) === 0 ? "no drift" : `${driftCount(plan)} resource${driftCount(plan) === 1 ? "" : "s"} drifted`}` : `${root}: ${p.stdout.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned"}`);
      } finally {
        observer.endRoot(timing);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Wave 1 is the canary list, when there is one; later waves follow apply order.
  const canary = drift ? [] : (options.canary ?? settings.waves?.canary ?? []);
  const isCanary = (r: string) => canary.some((g) => globMatch(g, r));
  const waves: WaveInput[] = [];
  if (drift) {
    // Drift is not applied, so there are no waves to gate.
  } else if (roots.some(isCanary)) waves.push({ number: 1, roots: roots.filter(isCanary) });
  for (const l of drift ? [] : layers) {
    const rest = l.filter((r) => !isCanary(r));
    if (rest.length) waves.push({ number: waves.length + 1, roots: rest });
  }

  return finish(repo, settings, options, env, log, { binary, started, inputs, waves, plans, redacted, all, roots, observer });
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
}

/** A Terragrunt repo's tf-plan: its units by wave, as the pipeline names them or as discovery finds them. */
async function runTerragruntStage(
  repo: string,
  settings: ReturnType<typeof resolveRepo>,
  options: StageOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<StageResult> {
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, []).value;
  const canary = options.canary ?? settings.waves?.canary ?? [];
  const tool = {
    ...(options.terragruntPath ? { terragrunt: options.terragruntPath } : env.TERRAGUCCI_TERRAGRUNT ? { terragrunt: env.TERRAGUCCI_TERRAGRUNT } : {}),
    ...(options.terragruntExec ? { exec: options.terragruntExec } : {}),
  };
  const base = options.base ?? baseRef(env);
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
  let everyUnit = SELECTED_ALL;
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
  const observer = new StageObserver(telemetryFromEnv(env), "tf-plan", env);
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));
  try {
    const planned = await planUnits(repo, waves, binary, work, {
      ...options, env, dependents: settings.terragrunt?.dependents, preview,
      selection: (u) => reasons.get(u) ?? everyUnit,
    }, log);
    const { inputs, plans, redacted, mockReads } = planned;
    for (const u of planned.waiting) {
      const after = [...new Set(mockReads.filter((r) => r.unit === u).map((r) => r.upstream))].sort();
      deferred.push({ unit: u, after, why: "would read mock_outputs", previewed: settings.terragrunt?.dependents === "plan" });
    }
    const all = (units ?? []).map((u) => u.path);
    const plannedPaths = inputs.map((r) => r.path);
    // A wave covers what it planned for real: no unit that waits for its upstream, and no preview.
    const real = new Set(inputs.filter((r) => !r.terragrunt?.provisional).map((r) => r.path));
    return await finish(repo, settings, options, env, log, {
      binary, started, inputs, plans, redacted, all: all.length ? all : plannedPaths, roots: plannedPaths, observer, mockReads,
      deferred: deferred.sort((a, b) => (a.unit < b.unit ? -1 : 1)),
      ...(existsSync(join(repo, "root.hcl")) ? { configDirs: ["."] } : {}),
      waves: waves.map((w) => w.filter((u) => real.has(u))).filter((w) => w.length > 0).map((roots, i) => ({ number: i + 1, roots })),
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The base of a pull request's range, from the forge's environment: `origin/<target branch>`. */
export function baseRef(env: NodeJS.ProcessEnv): string | undefined {
  if (env.TG_BASE) return env.TG_BASE;
  const branch = env.GITHUB_BASE_REF || env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  return branch ? `origin/${branch}` : undefined;
}

async function finish(
  repo: string,
  settings: ReturnType<typeof resolveRepo>,
  options: StageOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  { binary, started, inputs, waves, plans, redacted, all, roots, observer, mockReads, deferred, configDirs }: Planned,
): Promise<StageResult> {
  const report = buildReport({
    run: { ...runFacts(repo, env), stage, binary, runtime: settings.runtime, started, finished: new Date().toISOString(), terragucci: pkg.version },
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
    const issueOptions = { names, ...(url ? { reportUrl: url } : {}) };
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

