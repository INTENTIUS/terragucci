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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { planTerragruntWave, TerragruntMockRefusal, type TerragruntExec, type TerragruntWavePlan } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { stackOfUnit, terragruntDependents, type TerragruntUnit } from "@intentius/chant-lexicon-terraform/terragrunt/units";
import { parseTerragruntReport, terragruntEnv } from "@intentius/chant-lexicon-terraform/terragrunt/wave";
import { terragruntRenderArgs } from "@intentius/chant-lexicon-terraform/terragrunt/mocks";
import { describeTerragruntAffectedReason, findTerragruntAffected } from "@intentius/chant-lexicon-terraform/terragrunt/affected";
// Path rules only: no HCL parser, no compiler.
import { changedRoots } from "@intentius/chant-lexicon-terraform/changed-roots";
// A named import, so the bundle carries the version and not the whole package.json.
import { version as VERSION } from "../../package.json";
import { applyWaves, lockTimeoutArgs, readLedger } from "../apply";
import { approvalRule, declaredGates } from "../approval";
import { decideOverride, OVERRIDE_LEDGER } from "../override";
import { ConfigError, findConfig, loadConfig, resolveProject, resolveRepo, responseTo, type ForgeName, type PolicySettings } from "../config";
import { applyLayers, detectBinary, findRoots, globMatch, remoteStateReads, rootDependencies } from "../detect";
import { linkRoot, type Link, type Linked } from "../linked";
import { plannedOutputs, plannedReadLine, unknownUpstreams, wavesOf } from "../planned-outputs";
import { describeBinary, RootBinaries, type Installer } from "../pins";
import { detectTerragrunt, discoverUnits, refineWaves, unitWaves, walkUnits } from "../terragrunt";
import { backendStrings, DIRS_FILE, missingOutput, PHASE_ENV, previewReads, readRecord, readServed, SERVED_FILE, servedOutputs, servingWrapper, unitTexts, type PreviewBlock, type RunUpstream, type ServedUnit } from "../tg-preview";
import { findIssue, ForgeError, type Fetch } from "../forge";
import { buildReport, planFiles, type RootInput, type WaveInput } from "./build";
import { loadHclParser } from "../rollout/parser";
import { pinChecker } from "../publish/require";
import { describeTips, repoTips } from "../tips";
import type { DecideOptions } from "../decide";
import { ATTRIBUTIONS_FILE, attribute, awsAuditLog, type Attributed, type AuditLog } from "../respond/attribute";
import { driftOf } from "../respond/drift";
import { checkDriftSchedule, DRIFT_SCHEDULE_FILE, pipelineAdded } from "./drift-schedule";
import { DRIFT_MARKER, drifted, driftCount, driftNames, driftPlan, renderDriftIssue, targetFromEnv, trackDrift, type DriftIssueResult } from "./drift";
import { redactPlan } from "./redact";
import { scrubPlanText } from "./plan-text";
import { checkPlans, governingPolicy, type PolicyCost, type PolicyOptions, type PolicyRunContext, type TrustedOptions } from "./policy";
import { storeFromEnv } from "./bucket";
import type { S3Fetch } from "./s3";
import { modulePins, StageObserver } from "./observe";
import { telemetryFromEnv, type OtlpFetch } from "../telemetry";
import type { Report, ReportCost, ReportDeferred, ReportMockRead, ReportPolicy, ReportRead, ReportRun } from "./schema";
import { bucketReportUrl, presignedLinks, uploadReport, writeReportDir, type Uploaded } from "./store";
import { costCommand, costReason, costRule, estimateCosts, policyCost, waveCost, writeCostFiles, type CostRule, type CostRunner } from "./cost";
import { isArtifactPage, noteLimit, type NoteOptions } from "./views";
import { binaryEnv, terragruntExec } from "../binary-env";
import { synthAffected } from "../synth";
import { readSteps, runSteps, stepsUsed, STEPS_NOT_TERRAGRUNT, type StepWhen } from "../steps";
import type { ReportStep } from "./schema";

export const STAGES = ["tf-plan", "tf-drift"] as const;

export interface StageOptions {
  /** Runs the cost estimator; tests pass one. */
  costRunner?: CostRunner;
  /** Leave the cost estimate out, with `cost` set: the confirm job's plan posts no note. */
  noCost?: boolean;
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
  /** How a version a root pins is installed. Default: the release, checked against its SHA256SUMS. */
  installer?: Installer;
  /** Where to copy the report, when the pipeline names a bucket. Default: the config's `reports`. */
  reports?: { bucket: string; endpoint?: string; prefix?: string; url?: string };
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
  /** tf-drift with `respond.drift: attribute`: the audit log to read. Default CloudTrail through the aws CLI. */
  audit?: AuditLog;
  /** tf-drift with `respond.drift: attribute`: how the decision client reaches its service. */
  decideOptions?: DecideOptions;
  /** tf-plan with `policy:` set: how the engine runs and is fetched. Default: the real thing. */
  policy?: PolicyOptions;
  /** tf-plan with `drift:` set: the time the drift schedule is checked against. Default: now. */
  now?: Date;
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

type RunFacts = Pick<ReportRun, "project" | "commit" | "base" | "job_url" | "commit_url" | "pull_request" | "pull_request_url">;

/**
 * The run's facts, from the CI environment when there is one and from git
 * when not: the project, the commit and its page, the pull request the
 * pipeline names in `TG_PR` (or GitLab's merge request) and its page, and the
 * job. `forge` tells Forgejo's pull request pages (`/pulls/<n>`) from
 * GitHub's (`/pull/<n>`), which share the environment.
 */
export function runFacts(repo: string, env: NodeJS.ProcessEnv, forge?: ForgeName): RunFacts {
  let project: string | undefined;
  let job_url: string | undefined;
  let web: string | undefined;
  let gitlab = false;
  if (env.GITHUB_REPOSITORY) {
    const server = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
    project = `${new URL(server).host}/${env.GITHUB_REPOSITORY}`;
    web = `${server}/${env.GITHUB_REPOSITORY}`;
    if (env.GITHUB_RUN_ID) job_url = `${web}/actions/runs/${env.GITHUB_RUN_ID}`;
  } else if (env.CI_PROJECT_PATH) {
    project = `${env.CI_SERVER_HOST ?? "gitlab.com"}/${env.CI_PROJECT_PATH}`;
    job_url = env.CI_JOB_URL;
    web = env.CI_PROJECT_URL ?? (env.CI_SERVER_URL ? `${env.CI_SERVER_URL.replace(/\/+$/, "")}/${env.CI_PROJECT_PATH}` : undefined);
    gitlab = true;
  }
  project ??= (() => {
    const remote = git(repo, "remote", "get-url", "origin");
    return remote ? projectFromRemote(remote) : undefined;
  })() ?? basename(resolve(repo));
  const commit = env.TG_SHA || env.GITHUB_SHA || env.CI_COMMIT_SHA || git(repo, "rev-parse", "HEAD") || "unknown";
  const base = env.GITHUB_BASE_REF || env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || undefined;
  const pr = (env.TG_PR || env.CI_MERGE_REQUEST_IID || "").trim();
  const number = /^\d+$/.test(pr) ? pr : undefined;
  const forgejo = forge === "forgejo" || env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true";
  const prPath = gitlab ? "-/merge_requests" : forgejo ? "pulls" : "pull";
  return {
    project,
    commit,
    ...(base ? { base } : {}),
    ...(job_url ? { job_url } : {}),
    ...(web && commit !== "unknown" ? { commit_url: `${web}/${gitlab ? "-/" : ""}commit/${commit}` } : {}),
    ...(number ? { pull_request: number } : {}),
    ...(web && number ? { pull_request_url: `${web}/${prPath}/${number}` } : {}),
  };
}

/**
 * Where a job's `terragucci-report` artifact is, from the CI environment, as
 * the pipeline passes it to the plan job: report.html itself on GitLab, the
 * run's page (where the artifact is a download) on GitHub and Forgejo.
 */
export function artifactReportUrl(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CI_JOB_URL) return `${env.CI_JOB_URL}/artifacts/file/terragucci-report/report.html`;
  if (env.GITHUB_REPOSITORY && forgeArtifact(env)) return `${(env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "")}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  return undefined;
}

/**
 * Whether the job runs where the pipeline's upload step keeps a forge
 * artifact: a GitLab job, or a GitHub or Forgejo Actions run, which number
 * their runs. A runner that runs the workflow on its own (its run ids are not
 * numbers) keeps no artifact on the forge, so the note does not point at one.
 */
export function forgeArtifact(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CI_JOB_URL) || /^\d+$/.test(env.GITHUB_RUN_ID ?? "");
}

/** What the report says about where it can be read and traced, and how the note links it. */
export interface ReportLinks {
  /** report.run fields: the bucket copy's address, the trace id and its link. */
  run: Pick<ReportRun, "report_url" | "trace_id" | "trace_url">;
  note: NoteOptions;
}

/**
 * Where the note links the report. The bucket's copy when `reports.url` says
 * where the bucket is served (never guessed from the bucket's name); else the
 * URL the pipeline passed, which on GitHub and Forgejo is the run's page that
 * holds the report as an artifact; else the relative `report.html`. A
 * tf-apply wave is passed no URL; it gives `artifactReportUrl`, since its job
 * keeps the report as an artifact too. The trace is linked when
 * `telemetry.trace_url` is set.
 */
export function reportLinks(
  report: Report,
  o: { reports?: { bucket?: string; prefix?: string; url?: string }; given?: string; traceId?: string; traceUrl?: string; env?: NodeJS.ProcessEnv },
): ReportLinks {
  const bucket = o.reports?.bucket ? bucketReportUrl(report, o.reports) : undefined;
  const url = bucket ?? o.given;
  // A run's page that holds no artifact: the note names the run and links no report.
  const noArtifact = !bucket && url !== undefined && isArtifactPage(url) && o.env !== undefined && !forgeArtifact(o.env);
  const note: NoteOptions = noArtifact ? { runUrl: url } : url ? { reportUrl: url, ...(isArtifactPage(url) ? { artifacts: true } : {}) } : {};
  const traceUrl = o.traceId && o.traceUrl ? o.traceUrl.replaceAll("{trace_id}", o.traceId) : undefined;
  return {
    run: { ...(bucket ? { report_url: bucket } : {}), ...(o.traceId ? { trace_id: o.traceId } : {}), ...(traceUrl ? { trace_url: traceUrl } : {}) },
    note,
  };
}

/** The forge the CI environment is: GitLab's variables, Forgejo's flag, else GitHub. */
export function forgeOfEnv(env: NodeJS.ProcessEnv): ForgeName {
  if (env.CI_PROJECT_PATH) return "gitlab";
  return env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true" ? "forgejo" : "github";
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
  const opts = { encoding: "utf-8" as const, maxBuffer: 512 * 1024 * 1024, env: binaryEnv(env) };
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

/** Run the binary with the job's environment less its forge tokens (binaryEnv). */
export function spawnAsync(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<Spawned> {
  return new Promise((done) => {
    const child = spawn(file, args, { env: binaryEnv(env), stdio: ["ignore", "pipe", "pipe"] });
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
export type Turn = <T>(fn: () => Promise<T>) => Promise<T>;

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
  attributed?: Attributed;
  redacted?: number;
  deferred?: ReportDeferred;
  /** The names of its `on_failure: approve` steps that failed: its wave waits for an approval. */
  holds?: string[];
  /** The upstreams it planned on whose outputs it reads are known only once they apply. */
  unknownFrom?: string[];
}

const GITLAB_STATE = /\/api\/v4\/projects\/[^"\s]*\/terraform\/state\//;

/**
 * How many roots of a layer plan at once: the config's `parallelism`, else
 * from the roots' state backend, as Terragrunt mode sets it. GitLab-managed
 * state rate-limits concurrent inits, so it gets 3; every other backend 4.
 * Each root running starts its own providers, and the AWS provider alone
 * takes about 800 MB, so 4 roots fit a hosted runner's 7 GB.
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
  return { value: 4, reason: named.length === 1 ? `the ${named[0]} backend` : named.length > 1 ? `the ${named.join(", ")} backends` : "the default" };
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

/** Why a unit is in the plan when there is no base to select against. With a base, affected selection (Terragrunt's git range and chant's supplements) gives each unit its own reason. */
const SELECTED_ALL = "every unit: no base branch to compare against";

/** One layer of a Terragrunt run: its wave as the apply jobs number it, the units it plans, and the dependents it previews. */
interface UnitLayer {
  number: number;
  roots: string[];
  preview: string[];
}

/** A unit not previewed, and the wave it would have planned in. */
type Unpreviewed = PreviewBlock & { wave: number };

/**
 * Plan a Terragrunt repo's units, one `terragrunt run --all` per layer, and
 * read each unit's plan JSON and run-report row.
 *
 * A unit that reads, through a `dependency` block, a unit planned in an
 * earlier layer of the run plans on that plan's outputs (../tg-preview.ts),
 * when every value it reads is known. One that reads a value known only once
 * its upstream applies is not planned: it is named with the value and the
 * wave that settles it. With `dependents: plan`, the dependents of the
 * changed units are previewed the same way, in their own layers, marked
 * provisional, so no digest or group of real plans takes them.
 *
 * A layer whose plans would read `mock_outputs` is refused by chant before
 * anything is planned. The refused units come out and the rest of the layer
 * plans. A unit whose upstream has no outputs yet waits: it plans in a later
 * wave, after the upstream applied, and is never previewed on its mocks. A
 * unit whose block always reads its mocks (`skip_outputs`, `enabled = false`)
 * fails.
 */
async function planUnits(
  repo: string,
  layers: UnitLayer[],
  binary: string,
  work: string,
  options: StageOptions & { selection: (unit: string) => string; drift?: boolean; observer?: StageObserver; graph: TerragruntUnit[]; waveOf: ReadonlyMap<string, number> },
  log: (line: string) => void,
): Promise<{
  inputs: RootInput[];
  plans: Map<string, { text?: string; json?: string }>;
  redacted: number;
  mockReads: ReportMockRead[];
  waiting: string[];
  names: Map<string, Map<string, string>>;
  unpreviewed: Map<string, Unpreviewed>;
  /** Per wave, the waves whose planned outputs its units read. */
  waveReads: Map<number, number[]>;
}> {
  const drift = options.drift === true;
  const env = options.env ?? process.env;
  const names = new Map<string, Map<string, string>>();
  const planner = plannerForBinary(binary);
  let inputs: RootInput[] = [];
  const plans = new Map<string, { text?: string; json?: string }>();
  const mockReads: ReportMockRead[] = [];
  let redacted = 0;
  const terragrunt = options.terragruntPath ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  // A drift plan takes no lock. A plan waits for one as long as a plain root's apply-time plan does.
  const exec = drift ? refreshOnlyExec(options.terragruntExec) : lockTimeoutExec(options.terragruntExec, env);
  const edges = new Map(options.graph.map((u) => [u.path, u.dependencies]));
  const includes = new Map(options.graph.map((u) => [u.path, [...Object.values(u.include ?? {}), ...(u.reading ?? [])]]));
  /** Every unit this run planned or meant to: its plan, when it has one, and its wave. */
  const run = new Map<string, RunUpstream>();
  /** Where each unit's plan ran, as the wrapper recorded it. */
  const dirs = new Map<string, string>();
  /** The upstreams whose planned outputs a later layer reads. */
  const served = new Map<string, ServedUnit>();
  const unpreviewed = new Map<string, Unpreviewed>();
  const waveReads = new Map<number, number[]>();
  const rec = join(work, "preview");
  mkdirSync(join(rec, "out"), { recursive: true });

  /** The runner with `TG_TF_PATH` pointed at a wrapper that hands over the served upstreams' planned outputs (drift: the runner as it is). */
  const servingExec = (workDir: string): TerragruntExec => {
    if (drift) return exec;
    mkdirSync(workDir, { recursive: true });
    const plansDir = join(resolve(workDir), "plans");
    let real = plansDir;
    try {
      real = join(realpathSync(workDir), "plans");
    } catch {
      // The path as given is matched alone.
    }
    const dir = `${resolve(workDir)}.serve`;
    mkdirSync(dir, { recursive: true });
    const wrapper = join(dir, basename(binary) || "tofu");
    writeFileSync(wrapper, servingWrapper(binary, [plansDir, real], rec, [...served.values()]));
    chmodSync(wrapper, 0o755);
    return (file, args, opts) => {
      // The plan itself, apart from the mock check's render and output calls before it.
      const phase = args.includes("--all") && args[args.indexOf("--") + 1] === "plan" ? "plan" : "check";
      return exec(file, args, { ...opts, env: { ...opts.env, TG_TF_PATH: wrapper, TERRAGUCCI_TG_NEXT: opts.env.TG_TF_PATH ?? binary, [PHASE_ENV]: phase } });
    };
  };
  /** One layer's run: Terragrunt calls the binary through the wrappers, the spans one sending each unit's plan spans to the stage. */
  const runFor = (units: string[], workDir: string) => {
    const inner = servingExec(workDir);
    const wrapped = options.observer ? (unitSpansExec(inner, binary, units, workDir, options.observer, env) ?? inner) : inner;
    return { dir: repo, binary, terragrunt, exec: wrapped };
  };

  /** Hand an upstream's planned outputs to the layers after it: its working directory, and the strings of its backend. */
  const serve = async (up: string): Promise<ServedUnit> => {
    const outputs = join(rec, "out", `${served.size + 1}.json`);
    writeFileSync(outputs, JSON.stringify(servedOutputs(plannedOutputs(run.get(up)!.plan)!.outputs)) + "\n");
    let backend: string[] = [];
    const r = await servingExec(join(work, `render-${served.size + 1}`))(terragrunt, terragruntRenderArgs(up), { cwd: repo, env: terragruntEnv(binary) });
    try {
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() ?? `exit ${r.code}`);
      backend = backendStrings(JSON.parse(r.stdout));
    } catch (e) {
      log(`${up}: terragrunt render --json did not say where its state is (${(e as Error).message}), so only its own working directory answers with its planned outputs`);
    }
    const dir = dirs.get(up);
    return { unit: up, ...(dir ? { dir } : {}), outputs, backend };
  };

  /** Take a unit out of the run's plans: it is not previewed, for `why`. */
  const unpreview = (unit: string, wave: number, block: PreviewBlock): void => {
    inputs = inputs.filter((i) => i.path !== unit);
    plans.delete(unit);
    run.set(unit, { wave });
    unpreviewed.set(unit, { ...block, wave });
    log(`${unit}: not previewed: ${block.why}`);
  };

  const read = (workDir: string, wave: TerragruntWavePlan, number: number, provisional: ReadonlySet<string>, reads: ReadonlyMap<string, ReportRead[]>): void => {
    if (wave.code !== 0 && wave.code !== 2) log(tail(wave.log));
    if (options.observer) for (const [unit, t] of unitTimes(join(workDir, "plan-report.json"))) options.observer.unitTimed(unit, (t.end - t.start) / 1000, t);
    const results = new Map(wave.results.map((r) => [r.unit, r]));
    for (const part of wave.parts) {
      const path = part.member.member;
      const result = results.get(path);
      const preview = provisional.has(path);
      const unit = { stack: stackOfUnit(path), selection: options.selection(path), provisional: preview, run_result: result?.result ?? "not run" };
      const file = join(workDir, "json", path, "tfplan.json");
      const read = reads.get(path) ?? [];
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
        // An output the planned outputs left out: the unit read a value known only once its upstream applies.
        const missing = read.length > 0 ? missingOutput(error) : undefined;
        if (missing) {
          const ups = read.map((r) => r.upstream);
          const settles = wavesOf(options.waveOf, ups, number);
          unpreview(path, number, { after: ups, why: `reads ${"`"}${missing}${"`"} of ${ups.join(", ")}, unknown until wave ${settles.join(", ") || number - 1} applies` });
          continue;
        }
        run.set(path, { wave: number });
        inputs.push({ path, planner, error, preventDestroy: new Set(), terragrunt: unit });
        log(`${path}: ${error.split("\n")[0]}`);
        continue;
      }
      if (!drift) run.set(path, { plan, wave: number });
      const safe = redactPlan(plan);
      redacted += safe.values;
      plans.set(path, { json: JSON.stringify(safe.plan, null, 2) + "\n" });
      if (drift) names.set(path, driftNames(plan));
      inputs.push({ path, plan: drift ? driftPlan(plan) : plan, planner, files: { json: planFiles(path).json }, preventDestroy: new Set(), terragrunt: unit, ...(read.length ? { reads: read } : {}) });
      for (const r of read) log(plannedReadLine(path, r));
      log(drift ? `${path}: ${driftCount(plan) === 0 ? "no drift" : `${driftCount(plan)} resource${driftCount(plan) === 1 ? "" : "s"} drifted`}` : `${path}: ${preview ? "previewed (provisional)" : "planned"}`);
    }
  };

  const allWaiting: string[] = [];
  for (const layer of layers) {
    const provisional = new Set(layer.preview);
    const reads = new Map<string, ReportRead[]>();
    /** The upstreams each unit plans on the planned outputs of. */
    const needs = new Map<string, string[]>();
    let units: string[] = [];
    for (const u of [...layer.roots, ...layer.preview]) {
      if (drift) {
        units.push(u);
        continue;
      }
      const p = previewReads(u, edges.get(u) ?? [], unitTexts(repo, u, includes.get(u)), run);
      if ("why" in p) {
        unpreview(u, layer.number, p);
        continue;
      }
      units.push(u);
      if (p.reads.length > 0) {
        reads.set(u, p.reads);
        needs.set(u, p.served);
      }
    }
    for (const up of new Set([...needs.values()].flat())) if (!served.has(up)) served.set(up, await serve(up));
    const ups = [...new Set([...reads.values()].flat().map((r) => r.upstream))];
    if (ups.length > 0) waveReads.set(layer.number, wavesOf(options.waveOf, ups, layer.number));
    writeFileSync(join(rec, SERVED_FILE), "");
    const waiting: string[] = [];
    // Each refusal names every read of the units it checked, so one pass takes them all out.
    for (let attempt = 0; units.length > 0 && attempt < 2; attempt++) {
      const workDir = join(work, `wave-${layer.number}${attempt ? `-${attempt}` : ""}`);
      try {
        read(workDir, await planTerragruntWave({ ...runFor(units, workDir), units, workDir }), layer.number, provisional, reads);
        units = [];
      } catch (e) {
        if (!(e instanceof TerragruntMockRefusal)) {
          const error = (e as Error).message;
          for (const path of units) {
            run.set(path, { wave: layer.number });
            inputs.push({ path, planner, error, preventDestroy: new Set(), terragrunt: { stack: stackOfUnit(path), selection: options.selection(path), provisional: provisional.has(path), run_result: "not run" } });
          }
          log(`wave ${layer.number}: ${error}`);
          units = [];
          break;
        }
        log(`wave ${layer.number}: ${e.message}`);
        mockReads.push(...e.reads.map((r) => ({ unit: r.unit, dependency: r.dependency, upstream: r.upstream, reason: r.reason, ...(r.keys ? { keys: r.keys } : {}) })));
        // Each refused unit waits; mock_reads says why, and which upstream it waits for.
        const refused = new Set(e.reads.map((r) => r.unit));
        for (const u of refused) run.set(u, { wave: layer.number });
        waiting.push(...refused);
        units = units.filter((u) => !refused.has(u));
      }
    }
    allWaiting.push(...waiting);
    if (drift) continue;
    for (const [u, d] of readRecord(readText(join(rec, DIRS_FILE)))) dirs.set(u, d[0]!);
    // A plan that read an upstream some other way than through the wrapper (straight from its state) is not on its planned outputs.
    const answered = readServed(readText(join(rec, SERVED_FILE)));
    for (const [u, ups] of needs) {
      const missed = ups.filter((up) => !answered.get(up)?.has("plan"));
      if (missed.length > 0 && run.get(u)?.plan !== undefined) {
        unpreview(u, layer.number, { after: missed, why: `Terragrunt did not ask the binary for the outputs of ${missed.join(", ")}, so its plan is not on their planned outputs` });
      }
    }
  }
  return { inputs, plans, redacted, mockReads, waiting: allWaiting, names, unpreviewed, waveReads };
}

/** A file's text, or nothing when there is none. */
function readText(file: string): string {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

/** `2026-10-05T10:00:01.123456789Z` as epoch milliseconds; the fraction past milliseconds is dropped. */
export function isoMillis(text: string): number {
  return Date.parse(text.replace(/(\.\d{3})\d+/, "$1"));
}

/**
 * Each unit's start and end in a wave, from Terragrunt's run report
 * (`Started` and `Ended`), in epoch milliseconds. Empty when the report is
 * missing or unreadable, and a row without both times is left out.
 */
export function unitTimes(reportFile: string): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  let rows: ReturnType<typeof parseTerragruntReport>;
  try {
    rows = parseTerragruntReport(readFileSync(reportFile, "utf-8"));
  } catch {
    return out;
  }
  for (const [unit, row] of rows) {
    if (!row.started || !row.ended) continue;
    const start = isoMillis(row.started);
    const end = isoMillis(row.ended);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) out.set(unit, { start, end });
  }
  return out;
}

/** Each unit's time in a wave, from Terragrunt's run report, in seconds. */
export function unitSeconds(reportFile: string): Map<string, number> {
  return new Map([...unitTimes(reportFile)].map(([unit, t]) => [unit, (t.end - t.start) / 1000]));
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The `TG_TF_PATH` wrapper for one wave: a shell script that runs the binary
 * with the variables of the unit whose plan it runs. Terragrunt hands each
 * unit's plan `-out=<out-dir>/<unit>/tfplan.tfplan`, which names the unit;
 * every other call (init, show, output, version) runs the binary as it is.
 * `outDirs` are the wave's plan directory as given and as its real path.
 */
export function unitWrapper(binary: string, outDirs: string[], units: Map<string, Record<string, string>>): string {
  const lines = [
    "#!/bin/sh",
    "# terragucci: each unit's plan sends its spans to the stage. Written for one wave.",
    'out=""',
    'prev=""',
    'for a in "$@"; do',
    '  case "$a" in -out=*|--out=*) out="${a#*=}" ;; esac',
    '  if [ "$prev" = "-out" ] || [ "$prev" = "--out" ]; then out="$a"; fi',
    '  prev="$a"',
    "done",
    'case "$out" in',
  ];
  for (const [unit, vars] of units) {
    const set = Object.entries(vars);
    if (set.length === 0) continue;
    const patterns = [...new Set(outDirs.map((d) => join(d, unit, "tfplan.tfplan")))].map(shq).join(" | ");
    lines.push(`  ${patterns}) export ${set.map(([k, v]) => `${k}=${shq(v)}`).join(" ")} ;;`);
  }
  lines.push("esac", `exec ${shq(binary)} "$@"`);
  return lines.join("\n") + "\n";
}

/**
 * The runner with `TG_TF_PATH` pointed at a wave's wrapper (`unitWrapper`),
 * so each unit's plan sends its spans to the stage's span receiver, under
 * the unit's span when tracing. The wrapper carries the binary's name, which
 * Terragrunt prefixes its log lines with. When there is nothing to send to,
 * the runner is returned as it is.
 */
function unitSpansExec(
  inner: TerragruntExec | undefined,
  binary: string,
  units: string[],
  workDir: string,
  observer: StageObserver,
  env: NodeJS.ProcessEnv,
): TerragruntExec | undefined {
  const vars = new Map(units.map((u) => [u, observer.unitEnv(u, "plan", env)]));
  if ([...vars.values()].every((v) => Object.keys(v).length === 0)) return inner;
  mkdirSync(workDir, { recursive: true });
  const plans = join(resolve(workDir), "plans");
  let real = plans;
  try {
    real = join(realpathSync(workDir), "plans");
  } catch {
    // The path as given is matched alone.
  }
  const dir = `${resolve(workDir)}.bin`;
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, basename(binary) || "tofu");
  writeFileSync(wrapper, unitWrapper(binary, [plans, real], vars));
  chmodSync(wrapper, 0o755);
  const run = inner ?? terragruntExec;
  return (file, args, opts) => run(file, args, { ...opts, env: { ...opts.env, TG_TF_PATH: wrapper } });
}

/**
 * The runner with the default `-lock-timeout` added to the binary's plan
 * command (`lockTimeoutArgs`), unless the job's `TF_CLI_ARGS` names one, so a
 * unit's plan waits for a lock an apply holds instead of failing at once.
 */
function lockTimeoutExec(inner: TerragruntExec = terragruntExec, env: NodeJS.ProcessEnv): TerragruntExec {
  return (file, args, opts) => {
    const at = args.indexOf("--");
    if (at < 0 || args[at + 1] !== "plan") return inner(file, args, opts);
    return inner(file, [...args.slice(0, at + 2), ...lockTimeoutArgs("plan", env), ...args.slice(at + 2)], opts);
  };
}

/**
 * The runner with `-refresh-only` added to the engine's plan command, so a
 * wave's `run --all` plans what the real world changed and not what the code
 * would change. Terragrunt's other calls (render, output) pass through.
 */
function refreshOnlyExec(inner: TerragruntExec = terragruntExec): TerragruntExec {
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
    if (settings.steps?.length) throw new ConfigError(STEPS_NOT_TERRAGRUNT);
    return runTerragruntStage(repo, settings, options, env, log, drift);
  }
  const all = options.layers ? options.layers.flat() : findRoots(repo, settings.roots);
  const full = options.layers ?? applyLayers(repo, all);
  const layers = full
    .map((l) => (options.root ? l.filter((r) => globMatch(options.root!, r)) : l))
    .filter((l) => l.length > 0);
  if (layers.length === 0) throw new ConfigError(options.root ? `no root matches ${options.root}` : "found no roots");
  // The pipeline names the roots init found. When none is on disk they are written by a command that has not run here.
  if (!options.root && layers.flat().every((r) => !existsSync(join(repo, r)))) {
    throw new ConfigError(`found no roots: none of the ${layers.flat().length} the pipeline names is on disk${settings.synth ? `; the synth command (${settings.synth}) writes them, so run it first` : "; roots a command writes, such as CDK Terrain's stacks, need synth in terragucci.yml"}`);
  }
  // A pull request plans only the roots its change reaches, and their dependents. Drift reads every root.
  const base = drift ? undefined : (options.base ?? baseRef(env));
  // Roots a synth command writes are not in git, so no diff names them: the command runs on the base too, and the roots whose output differs plan.
  const notices: string[] = [];
  let selected: Set<string> | undefined;
  if (base && settings.synth) {
    const synthed = await synthAffected(repo, base, settings.synth, layers.flat(), rootDependencies(repo, all), env, log);
    selected = synthed.selected;
    notices.push(synthed.notice);
  } else if (base) {
    selected = affectedRoots(repo, base, all, layers.flat(), log);
  }
  // steps: read at base, so the change under review cannot add, edit or remove one. Drift has no base: the default branch's own.
  const stepsRead = await readSteps(repo, base, settings.steps, { ...(configPath ? { config: configPath } : {}), ...(options.project ? { project: options.project } : {}) });
  if (stepsRead.note) log(stepsRead.note);
  const steps = stepsUsed(stepsRead.steps, stage);
  if (steps.length > 0) log(`steps: ${steps.length} read from terragucci.yml at ${stepsRead.from}`);
  const planLayers = selected ? layers.map((l) => l.filter((r) => selected.has(r))).filter((l) => l.length > 0) : layers;
  const roots = planLayers.flat();
  if (roots.length === 0) log("this change reaches no root, so nothing is planned");
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, all).value;
  const planner = plannerForBinary(binary);
  // Each root's binary: the job's, or the version the root pins, installed once per version.
  const binaries = new RootBinaries(repo, binary, settings.version, env, options.installer);
  const started = new Date().toISOString();
  const observer = new StageObserver(telemetryFromEnv(env), stage, env);
  if (roots.length > 0) await observer.collectSpans(log);
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));
  const limit = options.parallelism !== undefined ? { value: options.parallelism, reason: "--parallelism" } : rootsParallelism(repo, roots, settings, env);
  if (roots.length > 1) log(`planning ${limit.value === 1 ? "one root at a time" : `up to ${limit.value} roots at once`} (${limit.reason})`);
  // The roots share one provider cache, the job's or one of the stage's own, so a provider downloads once per job rather
  // than once per root (some 700 MB for the AWS provider). The cache is not safe for inits that run together, so they
  // take turns. Plans still run at once.
  const binEnv = { ...env, TF_PLUGIN_CACHE_DIR: env.TF_PLUGIN_CACHE_DIR || mkdtempSync(join(work, "plugins-")) };
  const initTurn = oneAtATime();

  // modules.require: attested, checked for every root before any plans, one at a time, since each check fetches into the checkout.
  const pinRefusals = new Map<string, string[]>();
  if (!drift && roots.length > 0) {
    const pins = await pinChecker(repo, settings.modules, base, policyTrust(repo, options), { env });
    for (const root of pins ? roots : []) {
      const r = await pins!(root);
      if (r.refused.length) pinRefusals.set(root, r.refused);
      else if (r.verified.length) log(`${root}: attested ${r.verified.join("; ")}`);
    }
  }

  const inputs: RootInput[] = [];
  const plans = new Map<string, { text?: string; json?: string }>();
  const names = new Map<string, Map<string, string>>();
  const attributions = new Map<string, Attributed>();
  // Drift names who changed what when the project asks for it; the same table, audit log and decision as `respond drift`.
  const attributing = drift && responseTo(settings, "drift") === "attribute";
  const audit = attributing ? (options.audit ?? awsAuditLog({ region: settings.audit_region })) : undefined;
  const deferred: ReportDeferred[] = [];
  const held = new Set<string>();
  const upstreamState = new Map<string, boolean | undefined>();
  const heldBySteps = new Set<string>();
  const unknownFrom = new Map<string, string[]>();
  const readsOf = drift ? new Map<string, Set<string>>() : rootDependencies(repo, all);
  // Linked states: the terraform_remote_state blocks of each root, and the plans of the roots this run planned, whose outputs a later layer plans on.
  const blocksOf = drift ? new Map<string, { name: string; upstream: string; repeated: boolean }[]>() : remoteStateReads(repo, all);
  const upstreamPlans = new Map<string, unknown>();
  let redacted = 0;

  /** How a root reads each upstream: the links a plan on their planned outputs takes, and the reads the report names. */
  const linksFor = (root: string): { links: Link[]; reads: ReportRead[] } => {
    const links: Link[] = [];
    const reads: ReportRead[] = [];
    for (const b of blocksOf.get(root) ?? []) {
      const applied = (why: string): void => void reads.push({ upstream: b.upstream, data: b.name, outputs: "applied", why });
      if (!roots.includes(b.upstream)) {
        applied("this change does not reach it, so its state stands");
        continue;
      }
      const plan = upstreamPlans.get(b.upstream);
      if (plan === undefined) {
        applied("it did not plan in this run");
        continue;
      }
      if (b.repeated) {
        applied("the block has count or for_each, which a linked plan does not follow");
        continue;
      }
      const planned = plannedOutputs(plan);
      if (!planned) applied("its plan names no output changes");
      else if (!planned.changed) applied("its plan changes no output, so its state stands");
      else links.push({ name: b.name, upstream: b.upstream, outputs: planned.outputs });
    }
    return { links, reads };
  };

  /** One root planned, its outcome kept apart so the report and the log take roots in order, not in the order they finish. */
  const planRoot = async (root: string, index: number): Promise<RootOutcome> => {
    const lines: string[] = [];
    const dir = join(repo, root);
    const { links, reads } = linksFor(root);
    // A root that reads the state of a root nothing has applied cannot plan: its terraform_remote_state block reads that
    // state even when its references point at the upstream's plan. Hold it back. An upstream that has applied and has a
    // change pending is the linked path: the root plans on that upstream's planned outputs.
    const waitsFor = [...(readsOf.get(root) ?? [])].filter((up) => upstreamState.get(up) === true).sort();
    if (waitsFor.length > 0) {
      lines.push(`${root}: held back, ${waitsFor.join(", ")} has no state yet`);
      return { root, lines, deferred: { unit: root, after: waitsFor, why: `reads the state of ${waitsFor.join(", ")}, which nothing has applied yet, so it cannot plan until then`, previewed: false } };
    }
    const planFile = join(work, `${index}.tfplan`);
    const timing = observer.root(root);
    let bin = binaries.expected(root);
    let path = binary;
    const run = (...args: string[]) =>
      observer.commandAsync(timing, path, args, binEnv, (e) => spawnAsync(path, [`-chdir=${dir}`, ...args], e));
    const ran: ReportStep[] = [];
    const holds: string[] = [];
    /** Run one moment's steps; the error when one failed the root. */
    const step = async (when: StepWhen, file?: string): Promise<string | undefined> => {
      if (steps.length === 0) return undefined;
      const o = await runSteps(steps, when, { repo, root, stage: drift ? "tf-drift" : "tf-plan", env: binEnv, ...(file ? { planFile: file } : {}), log: (l) => lines.push(l) });
      ran.push(...o.runs);
      holds.push(...o.holds);
      return o.error;
    };
    const failed = (error: string, line: string): RootOutcome => {
      lines.push(line);
      return { root, lines, ...(holds.length ? { holds } : {}), input: { path: root, planner, binary: bin, error, preventDestroy: new Set(), ...(ran.length ? { steps: ran } : {}), ...(reads.length ? { reads } : {}) } };
    };
    const refused = pinRefusals.get(root);
    if (refused) {
      observer.endRoot(timing);
      return failed(refused.join("\n"), `${root}: refused by modules.require: attested`);
    }
    const planStep = drift ? "drift" : "plan";
    try {
      try {
        const resolved = await binaries.resolve(root);
        ({ path } = resolved);
        bin = { name: resolved.name, ...(resolved.version ? { version: resolved.version } : {}), ...(resolved.pin ? { pin: resolved.pin } : {}) };
      } catch (e) {
        return failed((e as Error).message, `${root}: ${(e as Error).message}`);
      }
      if (bin.pin) lines.push(`${root}: ${describeBinary(bin)}`);
      let stepError = await step("before-init");
      if (stepError) return failed(stepError, `${root}: a step before init failed`);
      const init = await initTurn(() => run("init", "-input=false", "-no-color"));
      if (init.status !== 0) return failed(`init failed:\n${tail(init.stderr || init.stdout)}`, `${root}: init failed`);
      stepError = (await step("after-init")) ?? (await step(`before-${planStep}`));
      if (stepError) return failed(stepError, `${root}: a step before ${planStep} failed`);
      // A plan never writes state, so it takes no lock and never blocks an apply.
      // A refresh-only plan compares the state with the real objects and ignores the code.
      const planOnce = () => run("plan", ...(drift ? ["-refresh-only"] : []), "-input=false", "-no-color", "-lock=false", `-out=${planFile}`);
      // Linked: the root plans on the planned outputs of the upstreams this run planned, its files put back once the plan is made.
      let linked: Linked | undefined;
      const unlink = (why: string): void => {
        for (const l of links) reads.push({ upstream: l.upstream, data: l.name, outputs: "applied", why });
      };
      if (links.length > 0) {
        try {
          linked = linkRoot(dir, links);
        } catch (e) {
          unlink(`no linked plan: ${(e as Error).message}`);
        }
      }
      let p: Awaited<ReturnType<typeof planOnce>>;
      try {
        p = await planOnce();
      } finally {
        linked?.restore();
      }
      if (linked && (p.status !== 0 || !existsSync(planFile))) {
        // A plan the planned outputs fail (a count or for_each on an unknown value) plans again on the applied state, and says so.
        const why = (p.stderr || p.stdout).match(/Error: (.*)/)?.[1]?.trim() ?? "the plan failed";
        lines.push(`${root}: the plan on the planned outputs of ${links.map((l) => l.upstream).join(", ")} failed (${why}), so it plans on their applied state`);
        unlink(`the plan on its planned outputs failed: ${why}`);
        linked = undefined;
        p = await planOnce();
      }
      if (linked) {
        reads.push(...linked.reads);
        for (const r of linked.reads) lines.push(plannedReadLine(root, r));
      }
      reads.sort((a, b) => (a.upstream < b.upstream ? -1 : a.upstream > b.upstream ? 1 : a.data < b.data ? -1 : 1));
      if (p.status !== 0 || !existsSync(planFile)) return failed(`plan failed:\n${tail(p.stderr || p.stdout)}`, `${root}: plan failed`);
      stepError = await step(`after-${planStep}`, planFile);
      if (stepError) return failed(stepError, `${root}: a step after ${planStep} failed`);
      const json = await run("show", "-json", planFile);
      const text = await run("show", "-no-color", planFile);
      let plan: unknown;
      try {
        plan = JSON.parse(json.stdout);
      } catch {
        return failed(`show -json printed no plan:\n${tail(json.stderr || json.stdout)}`, `${root}: show -json failed`);
      }
      if (!drift) upstreamPlans.set(root, plan);
      const unknownFrom = unknownUpstreams(reads);
      const safe = redactPlan(plan);
      let attributed: Attributed | undefined;
      if (audit && driftCount(plan) > 0) {
        try {
          attributed = await attribute(root, driftOf(plan), { audit, decide: settings.decide, options: options.decideOptions });
        } catch (e) {
          lines.push(`${root}: attribution skipped, ${(e as Error).message}`);
        }
      }
      lines.push(drift ? `${root}: ${driftCount(plan) === 0 ? "no drift" : `${driftCount(plan)} resource${driftCount(plan) === 1 ? "" : "s"} drifted`}` : `${root}: ${p.stdout.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned"}`);
      return {
        root, lines, redacted: safe.values, ...(holds.length ? { holds } : {}), ...(unknownFrom.length ? { unknownFrom } : {}),
        // The binary masks what the plan marks sensitive; a value copied into an unmarked attribute is masked here too.
        plan: { text: scrubPlanText(text.stdout, plan).text, json: JSON.stringify(safe.plan, null, 2) + "\n" },
        ...(drift ? { names: driftNames(plan) } : {}),
        ...(attributed ? { attributed } : {}),
        input: { path: root, plan: drift ? driftPlan(plan) : plan, planner, binary: bin, files: planFiles(root), preventDestroy: preventDestroyIn(dir), ...(ran.length ? { steps: ran } : {}), ...(reads.length ? { reads } : {}) },
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
    if (o.holds?.length) heldBySteps.add(o.root);
    if (o.unknownFrom?.length) unknownFrom.set(o.root, o.unknownFrom);
    if (o.plan) plans.set(o.root, o.plan);
    if (o.names) names.set(o.root, o.names);
    if (o.attributed) attributions.set(o.root, o.attributed);
    redacted += o.redacted ?? 0;
  };

  try {
    let index = 0;
    // Roots in one layer read none of each other's state, so they plan at once. A later layer waits for the layers it reads.
    for (const layer of planLayers) {
      // The upstreams this layer reads, each read once, before any root of the layer plans.
      const ups = [...new Set(layer.flatMap((r) => [...(readsOf.get(r) ?? [])]))].filter((up) => !upstreamState.has(up)).sort();
      await eachLimited(ups, limit.value, async (up) => {
        // The upstream's own binary reads its state; the job's when its pin cannot be installed, and its own plan says why.
        const upBinary = await binaries.resolve(up).then((b) => b.path, () => binary);
        upstreamState.set(up, await stateIsEmptyAsync(upBinary, join(repo, up), binEnv, initTurn));
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
  const applyOrder = drift ? [] : applyWaves(full, options.canary ?? settings.waves?.canary);
  const waveOf = new Map(applyOrder.flatMap((w, i) => w.map((r) => [r, i + 1] as const)));
  const waves: WaveInput[] = applyOrder
    .map((w, i) => ({ number: i + 1, roots: w.filter((r) => roots.includes(r) && !held.has(r)) }))
    .filter((w) => w.roots.length > 0)
    .map((w) => {
      const holding = w.roots.filter((r) => heldBySteps.has(r));
      const reads = wavesOf(waveOf, w.roots.flatMap((r) => [...(readsOf.get(r) ?? [])]), w.number);
      const replansAfter = wavesOf(waveOf, w.roots.flatMap((r) => unknownFrom.get(r) ?? []), w.number);
      return {
        ...w,
        state: "planned" as const,
        ...(holding.length ? { heldBySteps: holding } : {}),
        ...(reads.length ? { reads } : {}),
        ...(replansAfter.length ? { replansAfter } : {}),
      };
    });

  return finish(repo, settings, options, env, log, { binary, started, inputs, waves, plans, redacted, all, roots, observer, stage, names, ...(attributing ? { attributions } : {}), ...(deferred.length ? { deferred } : {}), ...(notices.length ? { notices } : {}) });
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
  /** tf-drift with `respond.drift: attribute`: who changed what, per root. */
  attributions?: Map<string, Attributed>;
  /** Lines for the note about how the roots were selected (`synth`: how many were unchanged). */
  notices?: string[];
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
  let discovered = false;
  if (!options.layers || base) {
    const found = await discoverUnits(repo, { exclude: settings.terragrunt?.exclude, binary, ...tool });
    found.notes.forEach((n) => log(`note: ${n}`));
    units = found.units;
    discovered = found.source === "terragrunt find";
  }
  let waves = options.layers ?? unitWaves(units!, canary);
  // The pipeline's waves split by the edges terragrunt find gives now, as the apply jobs split them.
  if (options.layers && discovered) waves = refineWaves(waves, units!);
  // The waves as the apply jobs number them, whatever this run selects of them.
  const full = waves;
  const waveOf = new Map(full.flatMap((w, i) => w.map((u) => [u, i + 1] as const)));
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
        deferred.push({ unit: d, after, why: "depends on a changed unit", previewed: false });
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
  // modules.require: attested, checked for every unit before any wave plans, as for plain roots: a refused unit fails and does not plan.
  const refusedUnits: RootInput[] = [];
  if (!drift) {
    const pins = await pinChecker(repo, settings.modules, base, policyTrust(repo, options), { env });
    for (const unit of pins ? waves.flat() : []) {
      const r = await pins!(unit);
      if (r.refused.length) {
        log(`${unit}: refused by modules.require: attested`);
        refusedUnits.push({ path: unit, planner: plannerForBinary(binary), error: r.refused.join("\n"), preventDestroy: new Set(), terragrunt: { stack: stackOfUnit(unit), selection: reasons.get(unit) ?? everyUnit, provisional: false, run_result: "not run" } });
      } else if (r.verified.length) log(`${unit}: attested ${r.verified.join("; ")}`);
    }
    const refused = new Set(refusedUnits.map((u) => u.path));
    waves = waves.map((w) => w.filter((u) => !refused.has(u))).filter((w) => w.length > 0);
  }
  const started = new Date().toISOString();
  const observer = new StageObserver(telemetryFromEnv(env), drift ? "tf-drift" : "tf-plan", env);
  // Each unit's plan sends its spans here through the TG_TF_PATH wrapper, for its per-resource timings.
  await observer.collectSpans(log);
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));
  // Each layer: the units it plans, and with dependents: plan the dependents it previews.
  const selected = new Set(waves.flat());
  const previewing = new Set(!drift && settings.terragrunt?.dependents === "plan" ? preview : []);
  const layers = full
    .map((w, i) => ({ number: i + 1, roots: w.filter((u) => selected.has(u)), preview: w.filter((u) => previewing.has(u)) }))
    .filter((l) => l.roots.length > 0 || l.preview.length > 0);
  try {
    const planned = await planUnits(repo, layers, binary, work, {
      ...options, env, drift, observer, waveOf,
      // The edges a preview follows: discovery's, else the plain paths the units' files name.
      graph: units ?? walkUnits(repo, settings.terragrunt?.exclude),
      selection: (u) => reasons.get(u) ?? everyUnit,
    }, log);
    const { inputs, plans, redacted, mockReads } = planned;
    inputs.push(...refusedUnits);
    /** Say why a unit waits; a dependent already listed gets the reason added. */
    const defer = (unit: string, after: string[], why: string): void => {
      const known = deferred.find((d) => d.unit === unit);
      if (!known) deferred.push({ unit, after, why, previewed: false });
      else {
        known.after = [...new Set([...known.after, ...after])].sort();
        known.why = `${known.why}; ${why}`;
      }
    };
    for (const u of planned.waiting) {
      if (drift) {
        // A refresh needs the upstream's real outputs; with none, the unit cannot be checked.
        const error = "its upstream has no outputs yet, so Terragrunt would plan it on mock_outputs";
        inputs.push({ path: u, planner: plannerForBinary(binary), error, preventDestroy: new Set(), terragrunt: { stack: stackOfUnit(u), selection: everyUnit, provisional: false, run_result: "not run" } });
        continue;
      }
      defer(u, [...new Set(mockReads.filter((r) => r.unit === u).map((r) => r.upstream))].sort(), "would read mock_outputs");
    }
    for (const [u, b] of planned.unpreviewed) defer(u, [...b.after].sort(), b.why);
    const previewed = new Set(inputs.filter((r) => r.terragrunt?.provisional && r.plan !== undefined).map((r) => r.path));
    for (const d of deferred) d.previewed = previewed.has(d.unit);
    const all = (units ?? []).map((u) => u.path);
    const plannedPaths = inputs.map((r) => r.path);
    // A wave covers what it planned for real: no unit that waits for its upstream, and no preview.
    const real = new Set(inputs.filter((r) => !r.terragrunt?.provisional).map((r) => r.path));
    return await finish(repo, settings, options, env, log, {
      binary, started, inputs, plans, redacted, all: all.length ? all : plannedPaths, roots: plannedPaths, observer, mockReads,
      ...(drift ? { stage: "tf-drift" as const, names: planned.names } : {}),
      deferred: deferred.sort((a, b) => (a.unit < b.unit ? -1 : 1)),
      ...(existsSync(join(repo, "root.hcl")) ? { configDirs: ["."] } : {}),
      // Drift is not applied, so there are no waves to gate. Each wave keeps the number its apply job has.
      waves: drift ? [] : layers
        .map((l) => {
          // A unit of the wave not previewed plans once the waves it reads apply: so does the wave, and no review binds it now.
          const replansAfter = wavesOf(waveOf, l.roots.flatMap((u) => planned.unpreviewed.get(u)?.after ?? []), l.number);
          const reads = planned.waveReads.get(l.number) ?? [];
          return { number: l.number, roots: l.roots.filter((u) => real.has(u)), ...(reads.length ? { reads } : {}), ...(replansAfter.length ? { replansAfter } : {}) };
        })
        .filter((w) => w.roots.length > 0),
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
 * Check each plan against the project's policy and return the error of every
 * path that fails: a denial lists the messages, and a policy that cannot be
 * read or run fails the path too. For a pull request (`base` set) the policy
 * comes from the base branch, so the change under review cannot edit it away.
 * Nothing reads a response or agent setting, so no path waives it.
 * `checkPlans` (policy.ts) also returns each root's verdict and its warnings.
 */
export async function checkPolicy(repo: string, policy: PolicySettings, items: { path: string; plan: unknown }[], base: string | undefined, trust: TrustedOptions, options: PolicyOptions, log: (line: string) => void): Promise<Map<string, string>> {
  return (await checkPlans(repo, policy, items, base, trust, options, log)).failed;
}

/**
 * Run the policy over the planned roots. A root the policy denies, or could
 * not check, fails with the reason as its error, and keeps its plan so the
 * report still shows what it would change; every checked root carries its
 * verdict and warnings.
 */
async function applyPolicy(repo: string, policy: PolicySettings, inputs: RootInput[], base: string | undefined, trust: TrustedOptions, options: PolicyOptions = {}, log: (line: string) => void, run: Omit<PolicyRunContext, "root" | "cost"> = {}, costOf: (root: string) => PolicyCost | undefined = () => undefined): Promise<{ inputs: RootInput[]; policy: ReportPolicy }> {
  const checked = inputs.filter((i) => i.plan !== undefined && i.error === undefined && !i.terragrunt?.provisional);
  const found = await checkPlans(repo, policy, checked.map((i) => {
    const cost = costOf(i.path);
    return { path: i.path, plan: i.plan, ...(cost ? { cost } : {}) };
  }), base, trust, options, log, run);
  return {
    policy: found.policy,
    inputs: inputs.map((i) => {
      const verdict = found.roots.get(i.path);
      if (verdict === undefined) return i;
      const error = found.failed.get(i.path);
      return { ...i, policy: verdict, ...(error !== undefined ? { error } : {}) };
    }),
  };
}

/**
 * The overrides that stand for the roots the policy denied, when
 * `policy.override` in the config at base names who may write one (the
 * governing policy key names some, and approvalRule reads the list). The root
 * still fails the plan: the override lets `tf-apply` apply it, and the note
 * and the report say so. Nothing is recorded here; the wave records the
 * denial an override answers. Anything that cannot be read leaves the roots
 * as they are.
 */
export async function planOverrides(repo: string, options: StageOptions, env: NodeJS.ProcessEnv, inputs: RootInput[], policy: ReportPolicy, log: (line: string) => void): Promise<RootInput[]> {
  const denied = inputs.filter((i) => i.plan !== undefined && i.policy?.result === "denied");
  if (denied.length === 0 || options.project) return inputs;
  const base = options.base ?? baseRef(env);
  const configPath = options.config ?? findConfig(repo);
  try {
    const rule = await approvalRule(repo, { ...(base ? { at: base } : {}), ...(configPath ? { config: configPath } : {}) });
    if (rule.overriders.length === 0) return inputs;
    policy.overriders = rule.overriders;
    const ledger = readLedger(repo, OVERRIDE_LEDGER);
    const now = new Date().toISOString();
    const overridden: string[] = [];
    const out = inputs.map((i) => {
      if (!denied.includes(i)) return i;
      const planDigest = terraformChangeSetPart({ member: i.path, plan: i.plan, planner: i.planner ?? "terraform" }).member.planDigest;
      if (!planDigest) return i;
      const decision = decideOverride(ledger, rule, i.path, planDigest, i.policy!.rules ?? [], now);
      if (decision.status !== "overridden") return i;
      overridden.push(i.path);
      log(`${i.path}: the policy denial is overridden by ${decision.override.by} at ${decision.override.at}, so tf-apply applies this plan; the plan still fails here`);
      return { ...i, policy: { ...i.policy!, override: decision.override } };
    });
    if (overridden.length > 0) policy.overridden = overridden.sort();
    return out;
  } catch (e) {
    log(`policy override: ${(e as Error).message}, so no override is shown`);
    return inputs;
  }
}

/** Where the policy key is read: the config file and the project the run reads. */
function policyTrust(repo: string, options: StageOptions): TrustedOptions {
  const configPath = options.config ?? findConfig(repo);
  return { ...(configPath ? { config: configPath } : {}), ...(options.project ? { project: options.project } : {}) };
}

async function finish(
  repo: string,
  settings: ReturnType<typeof resolveRepo>,
  options: StageOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  { binary, started, inputs: planned, waves, plans, redacted, all, roots, observer, mockReads, deferred, configDirs, stage = "tf-plan", names, attributions, notices: selection = [] }: Planned,
): Promise<StageResult> {
  let inputs = planned;
  let policy: ReportPolicy | undefined;
  const drift = stage === "tf-drift";
  // cost: the estimator over each root's stored plan, before the policy, which reads the figures; a failed estimate is named and fails nothing.
  // cost.approve_above is read at base, so the note says which waves the amount will hold as the base's config has it.
  let costOutputs: Map<string, string> | undefined;
  let cost: ReportCost | undefined;
  let rule: CostRule = {};
  if (!drift && !options.noCost) {
    rule = await costRule(repo, settings.cost, options.base ?? baseRef(env), policyTrust(repo, options));
    if (rule.note) log(rule.note);
    if (rule.error) log(`cost: ${rule.error}`);
    const stored = rule.setting
      ? inputs.flatMap((i) => {
        const json = plans.get(i.path)?.json;
        return json !== undefined ? [{ root: i.path, json }] : [];
      })
      : [];
    if (rule.setting && stored.length > 0) {
      const costWork = mkdtempSync(join(tmpdir(), "terragucci-cost-"));
      try {
        const estimate = await estimateCosts(stored, costCommand(rule.setting), env, costWork, repo, log, options.costRunner);
        cost = estimate.cost;
        costOutputs = estimate.outputs;
      } finally {
        rmSync(costWork, { recursive: true, force: true });
      }
    }
  }
  const costWaves = cost ? waves.map((w) => ({ ...w, cost: waveCost(cost!, w.roots, rule.approveAbove) })) : waves;
  for (const w of costWaves) {
    if ("cost" in w && w.cost?.over) log(`cost: wave ${w.number}: ${costReason(w.cost, rule.source)}, so it waits for an approval when it applies`);
  }
  const costOf = (root: string): PolicyCost | undefined => {
    if (!cost) return undefined;
    const w = costWaves.find((x) => x.roots.includes(root));
    return policyCost(cost, root, w && "cost" in w && w.cost ? { number: w.number, cost: w.cost } : undefined, rule.approveAbove);
  };
  // The base's policy key decides whether policy runs, so a pull request that deletes it is still checked.
  const governing = drift ? undefined : await governingPolicy(repo, settings.policy, options.base ?? baseRef(env), policyTrust(repo, options));
  if (governing?.note) log(governing.note);
  if (governing?.policy) {
    const facts = runFacts(repo, env, options.forge ?? settings.forge);
    const run = { stage: "tf-plan" as const, project: facts.project, commit: facts.commit, ...(facts.pull_request ? { pullRequest: facts.pull_request } : {}) };
    ({ inputs, policy } = await applyPolicy(repo, governing.policy, inputs, options.base ?? baseRef(env), governing.trust, options.policy, log, run, costOf));
    if (governing.policy.override?.length) inputs = await planOverrides(repo, options, env, inputs, policy, log);
  }
  const report = buildReport({
    run: { ...runFacts(repo, env, options.forge ?? settings.forge), stage, binary, runtime: settings.runtime, started, finished: new Date().toISOString(), terragucci: VERSION },
    roots: inputs,
    waves: costWaves,
    redacted,
    // The waves of a plan say which the gate will hold, and carry the digest approval: pr-review binds a review to.
    ...(drift ? {} : { gate: settings.gate }),
    ...(mockReads?.length ? { mockReads } : {}),
    ...(deferred?.length ? { deferred } : {}),
    ...(policy ? { policy } : {}),
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
  if (cost) report.cost = cost;
  observer.addTimings(report);
  const dir = resolve(repo, options.out ?? "terragucci-report");
  // The bucket's address comes from the config when the pipeline names the same bucket without it.
  const named = options.reports;
  const same = named && settings.reports?.bucket === named.bucket ? settings.reports : undefined;
  const configured = named && !named.url ? same?.url : undefined;
  const reports = named ? { ...named, ...(configured ? { url: configured } : {}), ...(same?.role ? { role: same.role } : {}) } : settings.reports;
  const links = reportLinks(report, { reports, given: options.reportUrl, traceId: observer.trace?.traceId, traceUrl: settings.telemetry?.trace_url, env });
  Object.assign(report.run, links.run);
  observer.reportUrl = links.run.report_url;
  // A bucket with no address that serves it: the note links its report.html and plan.txt files presigned, as `terragucci estate` links its page.
  let noteLinks = links.note;
  if (reports?.bucket && !links.run.report_url) {
    try {
      const store = storeFromEnv(reports, env, options.fetch);
      noteLinks = await presignedLinks(store, report, reports.prefix, [...plans].filter(([, p]) => p.text !== undefined).map(([root]) => root));
    } catch (e) {
      log(`the note links no copy in the bucket: ${(e as Error).message}`);
    }
  }
  const limit = noteLimit(options.forge ?? settings.forge ?? forgeOfEnv(env), report);
  // A drift schedule that stopped cannot say so itself; the plan job, which runs on every pull request, does.
  const notices: string[] = [...selection];
  // Without a token the stage asks as a reader, which only a public repo answers; the note job asks again with its token.
  let leftSchedule: { cron: string; added?: string } | undefined;
  if (!drift && typeof settings.drift === "string") {
    const token = options.token ?? env.TG_TOKEN;
    const forge = options.forge ?? settings.forge;
    const reader = targetFromEnv(forge, env, token, true);
    const late = reader ? await checkDriftSchedule(repo, settings.drift, reader, options.forgeFetch ?? (globalThis.fetch as unknown as Fetch), options.now ?? new Date(), log) : undefined;
    if (late) notices.push(late.message);
    if (!token && reader && reader.forge !== "gitlab") {
      const added = pipelineAdded(repo, reader.forge);
      leftSchedule = { cron: settings.drift, ...(added ? { added } : {}) };
    }
  }
  // A waiting wave's command in the note asks for --sign when the repo seals its approvals.
  const sealed = (settings.approval ?? (declaredGates(existsSync(join(repo, "chant.workspace.json")) ? readFileSync(join(repo, "chant.workspace.json"), "utf-8") : undefined) > 0 ? "sealed" : "ledger")) === "sealed";
  writeReportDir(dir, report, plans, { ...noteLinks, limit, ...(notices.length ? { notices } : {}), ...(sealed ? { sealed } : {}) });
  if (leftSchedule) writeFileSync(join(dir, DRIFT_SCHEDULE_FILE), JSON.stringify(leftSchedule) + "\n");
  else rmSync(join(dir, DRIFT_SCHEDULE_FILE), { force: true });
  if (costOutputs) writeCostFiles(dir, costOutputs);
  let uploaded: Uploaded | undefined;
  if (reports?.bucket) {
    uploaded = await uploadReport(storeFromEnv(reports, env, options.fetch), dir, report, reports.prefix);
  }
  let issue: StageResult["issue"];
  if (drift) {
    const issueOptions = { ...(names ? { names } : {}), ...(attributions ? { attributions } : {}), ...links.note };
    writeFileSync(join(dir, "issue.md"), renderDriftIssue(report, issueOptions));
    // `respond drift` in the same job reads who changed what from here, so the audit log is read once.
    // A reused report directory can hold the file from an earlier run, so a run that made none removes it.
    if (attributions) writeFileSync(join(dir, ATTRIBUTIONS_FILE), JSON.stringify(Object.fromEntries(attributions), null, 2) + "\n");
    else rmSync(join(dir, ATTRIBUTIONS_FILE), { force: true });
    const token = options.token ?? env.TG_TOKEN;
    const target = targetFromEnv(options.forge, env, token);
    if (!target) {
      log("no forge token or no forge in the environment, so the drift issue is left alone");
      // Its age can still be read: a public repo answers an issue search without a token.
      const reader = token ? undefined : targetFromEnv(options.forge, env, undefined, true);
      if (reader && drifted(report).roots > 0) {
        try {
          const open = await findIssue(options.forgeFetch ?? (globalThis.fetch as unknown as Fetch), reader, DRIFT_MARKER);
          if (open?.created) observer.drift = { since: open.created };
        } catch (e) {
          if (!(e instanceof ForgeError) && !(e instanceof TypeError)) throw e;
        }
      }
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
  observer.pins = modulePins(inputs);
  if (drift && issue && "issue" in issue && issue.action !== "closed") {
    // A newly opened issue was opened by this run, so its drift starts now.
    observer.drift = { since: issue.action === "opened" ? report.run.finished : (issue.issue.created ?? report.run.finished) };
  }
  await observer.finish(report, env, log, options.otlpFetch);
  return { report, dir, ...(uploaded ? { uploaded } : {}), ...(issue ? { issue } : {}), failed: report.roots.some((r) => r.status === "failed" && !r.terragrunt?.provisional) || issue?.error !== undefined };
}

