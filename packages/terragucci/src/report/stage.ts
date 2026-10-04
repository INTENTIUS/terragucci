/**
 * `terragucci stage tf-plan`: plan every root, keep each root's full plan,
 * and write the run's report. Each root is planned to a plan file, shown as
 * JSON and as text; the JSON is redacted before it is stored, after its
 * plan digest is taken.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { plannerForBinary } from "@intentius/chant-lexicon-terraform/change-set";
import pkg from "../../package.json" with { type: "json" };
import { ConfigError, findConfig, loadConfig, resolveProject, resolveRepo } from "../config";
import { applyLayers, detectBinary, findRoots, globMatch } from "../detect";
import { buildReport, planFiles, type RootInput, type WaveInput } from "./build";
import { redactPlan } from "./redact";
import { S3Client, s3FromEnv, type S3Fetch } from "./s3";
import type { Report, ReportRun } from "./schema";
import { uploadReport, writeReportDir, type Uploaded } from "./store";

export const STAGES = ["tf-plan"] as const;

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
  env?: NodeJS.ProcessEnv;
  fetch?: S3Fetch;
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

export async function runStage(stage: string, repo: string, options: StageOptions = {}, log: (line: string) => void = console.error): Promise<StageResult> {
  if (stage !== "tf-plan") throw new ConfigError(`terragucci stage ${stage || "<name>"}: the stages built so far are ${STAGES.join(", ")}`);
  const env = options.env ?? process.env;
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(configPath) : {};
  const settings = options.project ? resolveProject(config, options.project) : resolveRepo(config);
  const all = options.layers ? options.layers.flat() : findRoots(repo, settings.roots);
  const layers = (options.layers ?? applyLayers(repo, all))
    .map((l) => (options.root ? l.filter((r) => globMatch(options.root!, r)) : l))
    .filter((l) => l.length > 0);
  const roots = layers.flat();
  if (roots.length === 0) throw new ConfigError(options.root ? `no root matches ${options.root}` : "found no roots");
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, all).value;
  const planner = plannerForBinary(binary);
  const started = new Date().toISOString();
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));

  const inputs: RootInput[] = [];
  const plans = new Map<string, { text?: string; json?: string }>();
  let redacted = 0;
  try {
    for (const root of roots) {
      const dir = join(repo, root);
      const planFile = join(work, `${inputs.length}.tfplan`);
      const run = (...args: string[]) => spawnSync(binary, [`-chdir=${dir}`, ...args], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024, env });
      const init = run("init", "-input=false", "-no-color");
      if (init.status !== 0) {
        inputs.push({ path: root, planner, error: `init failed:\n${tail(init.stderr || init.stdout)}`, preventDestroy: new Set() });
        log(`${root}: init failed`);
        continue;
      }
      // A plan never writes state, so it takes no lock and never blocks an apply.
      const p = run("plan", "-input=false", "-no-color", "-lock=false", `-out=${planFile}`);
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
      inputs.push({ path: root, plan, planner, files: planFiles(root), preventDestroy: preventDestroyIn(dir) });
      log(`${root}: ${p.stdout.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned"}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Wave 1 is the canary list, when there is one; later waves follow apply order.
  const canary = options.canary ?? settings.waves?.canary ?? [];
  const isCanary = (r: string) => canary.some((g) => globMatch(g, r));
  const waves: WaveInput[] = [];
  if (roots.some(isCanary)) waves.push({ number: 1, roots: roots.filter(isCanary) });
  for (const l of layers) {
    const rest = l.filter((r) => !isCanary(r));
    if (rest.length) waves.push({ number: waves.length + 1, roots: rest });
  }

  const report = buildReport({
    run: { ...runFacts(repo, env), stage: "tf-plan", binary, runtime: settings.runtime, started, finished: new Date().toISOString(), terragucci: pkg.version },
    roots: inputs,
    waves,
    redacted,
  });
  const dir = resolve(repo, options.out ?? "terragucci-report");
  writeReportDir(dir, report, plans, { ...(options.reportUrl ? { reportUrl: options.reportUrl } : {}) });
  let uploaded: Uploaded | undefined;
  const reports = options.reports ?? settings.reports;
  if (reports?.bucket) {
    const s3 = new S3Client(s3FromEnv(reports, env), options.fetch);
    uploaded = await uploadReport(s3, dir, report, reports.prefix);
  }
  return { report, dir, ...(uploaded ? { uploaded } : {}), failed: report.roots.some((r) => r.status === "failed") };
}

