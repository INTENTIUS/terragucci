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
import { basename, join, relative, resolve, sep } from "node:path";
import { rootRoleEnv } from "../cloud-identity";
import { rootSecretEnv } from "../root-secrets";
import { workspaceEnv, workspaceInit } from "../backend";
import { atmosDependencies, fillReads, upstreamOutputs, type UpstreamOutputs } from "../atmos";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { planTerragruntWave, TerragruntMockRefusal, type TerragruntExec, type TerragruntWavePlan } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { terragruntDependents, type TerragruntUnit } from "@intentius/chant-lexicon-terraform/terragrunt/units";
import { parseTerragruntReport, terragruntEnv } from "@intentius/chant-lexicon-terraform/terragrunt/wave";
import { terragruntRenderArgs } from "@intentius/chant-lexicon-terraform/terragrunt/mocks";
import { describeTerragruntAffectedReason, findTerragruntAffected } from "@intentius/chant-lexicon-terraform/terragrunt/affected";
// Path rules only: no HCL parser, no compiler.
import { changedRoots } from "@intentius/chant-lexicon-terraform/changed-roots";
// A named import, so the bundle carries the version and not the whole package.json.
import { version as VERSION } from "../../package.json";
import { eachLimited } from "../each-limited";
import { applyWaves, lockTimeoutArgs, readLedger } from "../apply";
import { approvalRule, declaredGates, ruleReport } from "../approval";
import { quorumRuleProgress, quorumRulesFor, trustRolesAt, type GateQuorumRule } from "@intentius/chant/gate-decision";
import { decideOverride, OVERRIDE_LEDGER, overrideRule, overridersFor } from "../override";
import { agentLoginWarning, approvalModeOf, CONFIG_NAMES, ConfigError, DEFAULT_DEPENDENTS, findConfig, loadConfig, resolveProject, resolveRepo, responseTo, type ForgeName, type PolicySettings, type ProjectSettings } from "../config";
import { anyRootGate, environmentOf, GATE_ORDER, topGate, waveGate as rootsGate } from "../environments";
import { readLiveSetup, resolvedEstate } from "../live-setup";
import { applyLayers, detectBinary, estateOutputReads, explicitOrder, findRoots, globMatch, liveRoots, remoteStateReads, rootDependencies, rootOrder, unaddressedStates, type WavesAfter } from "../detect";
import { checkOwnership, controlClaimsAt, projectKeyFromEnv } from "../estate-ownership";
import { estateLinks, estateRefusals, sensitiveWhy, unknownWhy } from "../estate-planned";
import { linkRoot, type Link, type Linked } from "../linked";
import { pendingEstateMigrations, pendingWhy, type PendingEstateRoot } from "../migrate";
import { coneArgs, coneLogLine, coneRoot, readPlanCone } from "../cone";
import { plannedOutputs, plannedReadLine, unknownUpstreams, wavesOf } from "../planned-outputs";
import { describeBinary, RootBinaries, type Installer } from "../pins";
import { discoverUnits, refineWaves, unitWaves, walkUnits } from "../terragrunt";
import { detectShape, fullDriftPlans, plansOnPlannedEstates, type Shape } from "../shape";
import { generateStacks, unitStack } from "../tg-stacks";
import { dirOf, groupUnits, planWaveGroups, UnitBinaries, type PlanWave, type UnitGroup, type UnitTools } from "../unit-pins";
import { backendStrings, DIRS_FILE, missingOutput, NO_FETCH_FROM_STATE, PHASE_ENV, previewReads, readRecord, readServed, SERVED_FILE, servedOutputs, servingWrapper, unitTexts, type PreviewBlock, type RunUpstream, type ServedUnit } from "../tg-preview";
import { ForgeApiError } from "@intentius/chant/pr-forge";
import { prForgeOf, type Fetch } from "../forge";
import { buildReport, planFiles, withEnvironment, type RootInput, type WaveInput } from "./build";
import { loadHclParser } from "../rollout/parser";
import { pinChecker } from "../publish/require";
import { sourceChecker, type SourceChecker } from "../sources";
import { UNIT_REFUSED, uncheckedUnit, unitSourcesExec } from "../sources-terragrunt";
import { catalogHosts, describeTips, repoTips } from "../tips";
import { renamesIn } from "../tips/moved";
import { liveEstate, rootSecrets } from "../tips/secrets";
import type { DecideOptions } from "../decide";
import { ATTRIBUTIONS_FILE, attribute, awsAuditLog, type Attributed, type AuditLog } from "../respond/attribute";
import { driftOf, type Drifted } from "../respond/drift";
import { checkDriftSchedule, DRIFT_SCHEDULE_FILE, pipelineAdded } from "./overdue";
import { DRIFT_ISSUE_FILE } from "../drift-agent";
import { DRIFT_MARKER, drifted, driftCount, driftNames, driftPlan, liveDrift, renderDriftIssue, targetFromEnv, trackDrift, type DriftIssueResult } from "./drift";
import { redactPlan } from "./redact";
import { scrubPlanText } from "./plan-text";
import { checkPlans, configAtBase, governingPolicy, type PolicyCost, type PolicyOptions, type PolicyRunContext, type TrustedOptions } from "./policy";
import { storeFromEnv } from "./bucket";
import type { S3Fetch } from "./s3";
import { modulePins, StageObserver } from "./observe";
import { telemetryFromEnv, type OtlpFetch } from "../telemetry";
import type { Report, ReportApprovalRule, ReportBlast, ReportCompose, ReportCost, ReportDeferred, ReportMockRead, ReportPolicy, ReportRead, ReportRootBinary, ReportRun } from "./schema";
import { applyGroups } from "../cloud-identity";
import { ComposedRun, compositionFor, composeTarget, reportCompose, type ComposedPlan, type ComposeFallback, type Composition } from "../compose";
import { blastRadius } from "./graph";
import { blastRootsOf, resourceBlast } from "./resource-blast";
import { branchCheckouts } from "../branch-checkouts";
import { changesSomething } from "./changing";
import { bucketReportUrl, changesKey, presignedLinks, uploadReport, writeReportDir, type Uploaded } from "./store";
import { readChanges } from "./history";
import { markPerpetual, PERPETUAL_WAVES } from "./perpetual";
import { costCommand, costReason, costRule, estimateCosts, policyCost, waveCost, writeCostFiles, type CostRule, type CostRunner } from "./cost";
import { isArtifactPage, noteLimit, type NoteOptions } from "./views";
import { binaryEnv, terragruntExec } from "../binary-env";
import { synthAffected } from "../synth";
import { outsideWatch, settingsChanged, type OutsideRoots } from "../affected";
import { detectActor } from "../actor";
import { hookCount, hooksUsed, readHooks, runHooks, runUnitHooks, type HookMoment, type StageHooks } from "../hooks";
import { binaryText, type ReportStep } from "./schema";

export const STAGES = ["tf-plan", "tf-drift"] as const;

export interface StageOptions {
  /** The estates' claims in the control repo's records, read now. Default: the checkout TERRAGUCCI_CONTROL_DIR names, else the control repo cloned with TERRAGUCCI_CONTROL_READ_TOKEN. */
  controlClaims?: () => Map<string, string[]> | undefined;
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
  const wsInit = workspaceInit(env, dir);
  const init = await initTurn(() => spawnAsync(binary, [`-chdir=${dir}`, "init", "-input=false", "-no-color"], wsInit?.init ?? env));
  if (init.status !== 0) return undefined;
  if (wsInit && (await spawnAsync(binary, [`-chdir=${dir}`, ...wsInit.select], wsInit.selectEnv)).status !== 0) return undefined;
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

/**
 * The providers an `init` downloaded, as `<source> v<version>`, from the
 * `- Installed <source> v<version> (...)` lines OpenTofu and Terraform print.
 * A provider taken from the plugin cache prints `- Using ... from the shared
 * cache directory` instead, so it is not counted.
 */
export function providerDownloads(initOutput: string): string[] {
  return [...initOutput.matchAll(/^- Installed (\S+) v(\S+) /gm)].map((m) => `${m[1]} v${m[2]}`);
}

/** Runs a piece of work after the one before it finished. */
export type Turn = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * The env a root's init and plan run with, given the stage's shared provider
 * cache. A root whose `.terraform.lock.hcl` pins every provider at the
 * binary's own registry takes its providers from the cache as it is. Any other
 * root (no lock file, or one that names another registry, as an OpenTofu lock
 * does for Terraform) would download its providers again at init, over the
 * copy in the cache that other roots' plans are running, which fails with
 * "text file busy" (#737). A cache per root would hold some 700 MB of the AWS
 * provider for each, so such a root keeps the shared cache and sets
 * TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE, which Terraform and OpenTofu
 * both read: init takes a provider the cache already holds instead of
 * downloading it again. Its lock file has no entry to check that copy
 * against either way. The stage logs how many roots that is, once.
 */
export function rootCacheEnv(env: NodeJS.ProcessEnv, dir: string, binaryName: string): NodeJS.ProcessEnv {
  if (!env.TF_PLUGIN_CACHE_DIR || lockCovers(dir, binaryName)) return env;
  return { ...env, TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE: "true" };
}

/**
 * Whether the root's `.terraform.lock.hcl` pins its providers, all of them at
 * the binary's own registry. A lock with no provider entries, which is what
 * `providers lock` writes for a root of only the built-in `terraform`
 * provider (terraform_data, terraform_remote_state), covers that root: it
 * takes nothing from the cache. It covers no other root.
 */
export function lockCovers(dir: string, binaryName: string): boolean {
  const registry = binaryName === "terraform" ? "registry.terraform.io" : "registry.opentofu.org";
  let lock = "";
  try {
    lock = readFileSync(join(dir, ".terraform.lock.hcl"), "utf8");
  } catch {
    return false;
  }
  const hosts = [...lock.matchAll(/^provider\s+"([^"/]+)\//gm)].map((m) => m[1]!);
  if (hosts.length === 0) return builtinOnly(dir);
  return hosts.every((h) => h === registry);
}

/**
 * Whether a root needs no provider but the built-in `terraform` one: its
 * `.tf` and `.tofu` files call no module, configure no provider, require none
 * and declare only `terraform_` resources and data sources. A module may need
 * providers of its own, and a JSON file is not read, so either answers no.
 */
export function builtinOnly(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  if (names.some((n) => n.endsWith(".tf.json") || n.endsWith(".tofu.json"))) return false;
  const texts = names.filter((n) => n.endsWith(".tf") || n.endsWith(".tofu")).map((n) => readFileSync(join(dir, n), "utf8"));
  if (texts.length === 0) return false;
  for (const text of texts) {
    if (/^\s*(module|provider)\s+"/m.test(text)) return false;
    if (/\brequired_providers\s*\{\s*[A-Za-z_]/.test(text)) return false;
    for (const m of text.matchAll(/^\s*(?:resource|data|ephemeral)\s+"([^"]+)"/gm)) if (!m[1]!.startsWith("terraform_")) return false;
  }
  return true;
}

export function oneAtATime(): Turn {
  let last: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const r = last.then(fn);
    last = r.catch(() => undefined);
    return r;
  };
}

// Root plans at most `limit` at once (../each-limited.ts), re-exported for the callers that take it from here.
export { eachLimited };

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
  /** The names of its `onFailure: "approve"` hooks that failed: its wave waits for an approval. */
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
export function rootsParallelism(repo: string, roots: readonly string[], settings: { parallelism?: number; environments?: ProjectSettings["environments"] }, env: NodeJS.ProcessEnv = {}): { value: number; reason: string } {
  // With environments, each root's environment's parallelism, else the top-level one: the roots plan as many at once as the fewest of them allows.
  if (settings.environments && Object.values(settings.environments).some((e) => e.parallelism !== undefined)) {
    const each = roots.map((r) => {
      const name = environmentOf(r, settings);
      const p = name === undefined ? undefined : settings.environments![name]!.parallelism;
      return p !== undefined ? { value: p, reason: `environments.${name}.parallelism` } : settings.parallelism !== undefined ? { value: settings.parallelism, reason: "terragucci.yml" } : undefined;
    });
    const set = each.filter((x): x is { value: number; reason: string } => x !== undefined);
    if (set.length > 0) {
      const fewest = set.reduce((a, b) => (b.value < a.value ? b : a));
      if (set.length === each.length) return fewest;
      const backend = rootsParallelism(repo, roots, {}, env);
      return backend.value < fewest.value ? backend : fewest;
    }
  }
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
 * wave that settles it. With `dependents: plan` (the default), the dependents of the
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
  options: StageOptions & { selection: (unit: string) => string; drift?: boolean; observer?: StageObserver; graph: TerragruntUnit[]; waveOf: ReadonlyMap<string, number>; hooks?: StageHooks; tools?: UnitBinaries; sources?: SourceChecker },
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
  /** tf-drift: what each unit's refresh found, unredacted, for attribution. */
  found: Map<string, Drifted[]>;
  /** Units a hook after plan with `onFailure: "approve"` holds at the gate. */
  heldBySteps: Set<string>;
}> {
  const drift = options.drift === true;
  const env = options.env ?? process.env;
  const names = new Map<string, Map<string, string>>();
  const found = new Map<string, Drifted[]>();
  const planner = plannerForBinary(binary);
  let inputs: RootInput[] = [];
  const plans = new Map<string, { text?: string; json?: string }>();
  const mockReads: ReportMockRead[] = [];
  let redacted = 0;
  const terragrunt = options.terragruntPath ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  // A drift plan takes no lock. A plan waits for one as long as a plain root's apply-time plan does.
  const timed = drift ? refreshOnlyExec(options.terragruntExec) : lockTimeoutExec(options.terragruntExec, env);
  // sources: what each unit's init fetched and locked, checked between its init and its plan (../sources-terragrunt.ts).
  const sourcesRefused = new Map<string, string[]>();
  const sourcesAsked = new Set<string>();
  const exec = options.sources ? unitSourcesExec(timed, options.sources, binary, env, sourcesRefused, sourcesAsked) : timed;
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
      return exec(file, args, { ...opts, env: { ...opts.env, TG_TF_PATH: wrapper, TERRAGUCCI_TG_NEXT: opts.env.TG_TF_PATH ?? binary, [NO_FETCH_FROM_STATE]: "true", [PHASE_ENV]: phase } });
    };
  };
  /** One group's run: Terragrunt calls the group's binary through the wrappers, the spans one sending each unit's plan spans to the stage. */
  const planGroup: PlanWave = (input) => {
    const inner = servingExec(input.workDir);
    const wrapped = options.observer ? (unitSpansExec(inner, input.binary ?? binary, [...input.units], input.workDir, options.observer, env) ?? inner) : inner;
    return planTerragruntWave({ ...input, exec: wrapped });
  };
  // Units that pin a binary or Terragrunt release of their own run it, installed once per version; one run --all per pair of releases.
  const tools = new Map<string, UnitTools>();
  const pinFailed = new Map<string, string>();
  // Every unit's releases go on its row of the report; only a unit that pins one installs anything.
  if (options.tools) {
    for (const u of [...new Set(layers.flatMap((l) => [...l.roots, ...l.preview]))]) {
      try {
        const t = await options.tools.resolve(u);
        tools.set(u, t);
        if (t.report.pin || t.report.terragrunt?.pin) log(`${u}: ${binaryText(t.report)}`);
      } catch (e) {
        pinFailed.set(u, (e as Error).message);
      }
    }
  }
  const planGroups = async (units: string[], workDir: string): Promise<{ wave: TerragruntWavePlan; groups: UnitGroup[] }> => {
    const groups = groupUnits(units, workDir, { terragrunt, binary }, options.tools?.pinsAny(units) ? tools : undefined);
    return { wave: await planWaveGroups(groups, { dir: repo }, planGroup), groups };
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

  const read = ({ wave, groups }: { wave: TerragruntWavePlan; groups: UnitGroup[] }, number: number, provisional: ReadonlySet<string>, reads: ReadonlyMap<string, ReportRead[]>): void => {
    if (wave.code !== 0 && wave.code !== 2) log(tail(wave.log));
    if (options.observer) for (const g of groups) for (const [unit, t] of unitTimes(join(g.workDir, "plan-report.json"))) options.observer.unitTimed(unit, (t.end - t.start) / 1000, t);
    const results = new Map(wave.results.map((r) => [r.unit, r]));
    for (const part of wave.parts) {
      const path = part.member.member;
      const result = results.get(path);
      const preview = provisional.has(path);
      const unit = { ...unitStack(path), selection: options.selection(path), provisional: preview, run_result: result?.result ?? "not run" };
      const file = join(dirOf(groups, path, groups[0]!.workDir), "json", path, "tfplan.json");
      const bin = tools.get(path)?.report;
      const read = reads.get(path) ?? [];
      let plan: unknown;
      if (part.member.status !== "failed" && existsSync(file)) {
        try {
          plan = JSON.parse(readFileSync(file, "utf-8"));
        } catch {
          plan = undefined;
        }
      }
      const refusedLines = sourcesRefused.get(path);
      if (refusedLines) {
        run.set(path, { wave: number });
        inputs.push({ path, planner, error: refusedLines.join("\n"), preventDestroy: new Set(), terragrunt: unit, ...(bin ? { binary: bin } : {}) });
        log(`${path}: ${UNIT_REFUSED}`);
        for (const l of refusedLines) log(`  ${l}`);
        continue;
      }
      // A unit that planned without the wrapper asking about it was never checked: its plan is not used.
      if (options.sources && plan !== undefined && !sourcesAsked.has(path)) {
        const error = `${path}: ${uncheckedUnit("planned")}`;
        run.set(path, { wave: number });
        inputs.push({ path, planner, error, preventDestroy: new Set(), terragrunt: unit, ...(bin ? { binary: bin } : {}) });
        log(error);
        continue;
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
        inputs.push({ path, planner, error, preventDestroy: new Set(), terragrunt: unit, ...(bin ? { binary: bin } : {}) });
        log(`${path}: ${error.split("\n")[0]}`);
        continue;
      }
      if (!drift) run.set(path, { plan, wave: number });
      const safe = redactPlan(plan);
      redacted += safe.values;
      plans.set(path, { json: JSON.stringify(safe.plan, null, 2) + "\n" });
      if (drift) {
        names.set(path, driftNames(plan));
        if (driftCount(plan) > 0) found.set(path, driftOf(plan));
      }
      inputs.push({ path, plan: drift ? driftPlan(plan) : plan, planner, files: { json: planFiles(path).json }, preventDestroy: new Set(), terragrunt: unit, ...(read.length ? { reads: read } : {}), ...(bin ? { binary: bin } : {}) });
      for (const r of read) log(plannedReadLine(path, r));
      log(drift ? `${path}: ${driftCount(plan) === 0 ? "no drift" : `${driftCount(plan)} resource${driftCount(plan) === 1 ? "" : "s"} drifted`}` : `${path}: ${preview ? "previewed (provisional)" : "planned"}`);
    }
  };

  // ci.hooks: each moment once for a layer's run --all, in the directory of every unit a hook's targets match. A provisional preview runs none.
  const hooks = options.hooks ?? {};
  const heldBySteps = new Set<string>();
  const ran = new Map<string, ReportStep[]>();
  const unitSteps = async (when: HookMoment, units: readonly string[], groups?: UnitGroup[]): Promise<Map<string, string>> => {
    const failed = new Map<string, string>();
    if (hookCount(hooks) === 0) return failed;
    const outcomes = await runUnitHooks(hooks, when, units, {
      repo, stage: drift ? "tf-drift" : "tf-plan", env, log,
      ...(groups ? { planFile: (u: string) => join(dirOf(groups, u, groups[0]!.workDir), "plans", u, "tfplan.tfplan") } : {}),
    });
    for (const [unit, o] of outcomes) {
      ran.set(unit, [...(ran.get(unit) ?? []), ...o.runs]);
      if (o.holds.length) heldBySteps.add(unit);
      if (o.error) failed.set(unit, o.error);
    }
    return failed;
  };
  /** A unit that did not plan for a reason of its own (a hook, a pin): no plan, the error. */
  const unitFailed = (path: string, error: string, number: number, preview: boolean): void => {
    run.set(path, { wave: number });
    inputs.push({ path, planner, error, preventDestroy: new Set(), ...(ran.has(path) ? { steps: ran.get(path) } : {}), terragrunt: { ...unitStack(path), selection: options.selection(path), provisional: preview, run_result: "not run" } });
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
    // A unit whose pinned release could not be installed does not plan; the rest of the layer does.
    for (const u of units.filter((x) => pinFailed.has(x))) {
      unitFailed(u, pinFailed.get(u)!, layer.number, provisional.has(u));
      log(`${u}: ${pinFailed.get(u)!.split("\n")[0]}`);
    }
    units = units.filter((x) => !pinFailed.has(x));
    // Before observe and before the plan, for the layer's real units: a unit whose hook fails does not plan, and the rest of the layer does.
    for (const when of ["before-observe", "before-plan"] as HookMoment[]) {
      for (const [path, error] of await unitSteps(when, units.filter((u) => !provisional.has(u)))) {
        unitFailed(path, error, layer.number, false);
        log(`${path}: a hook ${when.replace("-", " ")} failed`);
        units = units.filter((u) => u !== path);
      }
    }
    // Each refusal names every read of the units it checked, so one pass takes them all out.
    for (let attempt = 0; units.length > 0 && attempt < 2; attempt++) {
      const workDir = join(work, `wave-${layer.number}${attempt ? `-${attempt}` : ""}`);
      try {
        const from = inputs.length;
        const planned = await planGroups(units, workDir);
        read(planned, layer.number, provisional, reads);
        // After the plan, with each unit's saved plan: a unit whose hook fails keeps its plan in the report and fails.
        const after = await unitSteps("after-plan", units.filter((u) => !provisional.has(u) && inputs.slice(from).some((r) => r.path === u && r.plan !== undefined)), planned.groups);
        for (let k = from; k < inputs.length; k++) {
          const r = inputs[k];
          const error = after.get(r.path);
          inputs[k] = { ...r, ...(ran.has(r.path) ? { steps: ran.get(r.path) } : {}), ...(error ? { error } : {}) };
          if (error) log(`${r.path}: a hook after the plan failed`);
        }
        units = [];
      } catch (e) {
        if (!(e instanceof TerragruntMockRefusal)) {
          const error = (e as Error).message;
          for (const path of units) {
            run.set(path, { wave: layer.number });
            inputs.push({ path, planner, error, preventDestroy: new Set(), terragrunt: { ...unitStack(path), selection: options.selection(path), provisional: provisional.has(path), run_result: "not run" } });
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
  return { inputs, plans, redacted, mockReads, waiting: allWaiting, names, unpreviewed, waveReads, found, heldBySteps };
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
  const shape = detectShape(repo, settings);
  if (options.terragrunt ?? shape.engine === "terragrunt") return runTerragruntStage(repo, settings, shape, options, env, log, drift, configPath);
  const all = options.layers ? options.layers.flat() : findRoots(repo, settings.roots);
  // waves.after orders plain roots (and a synth's); the other shapes refuse it and keep their own order.
  const after = shape.after;
  const explicit = explicitOrder(after, all);
  const full = options.layers ?? applyLayers(repo, all, after);
  const layers = full
    .map((l) => (options.root ? l.filter((r) => globMatch(options.root!, r)) : l))
    .filter((l) => l.length > 0);
  if (layers.length === 0) throw new ConfigError(options.root ? `no root matches ${options.root}` : "found no roots");
  // The pipeline names the roots init found. When none is on disk they are written by a command that has not run here.
  // An Atmos repo's instances are written by terragucci atmos write, its synth when terragucci.yml names none.
  const synth = shape.prepare;
  if (!options.root && layers.flat().every((r) => !existsSync(join(repo, r)))) {
    throw new ConfigError(`found no roots: none of the ${layers.flat().length} the pipeline names is on disk${synth ? `; the synth command (${synth}) writes them, so run it first` : "; roots a command writes, such as CDK Terrain's stacks, need synth in terragucci.yml"}`);
  }
  // A pull request plans only the roots its change reaches, and their dependents. Drift reads every root.
  const base = drift ? undefined : (options.base ?? baseRef(env));
  // Roots a synth command writes are not in git, so no diff names them: the command runs on the base too, and the roots whose output differs plan.
  const notices: string[] = [];
  let selected: Set<string> | undefined;
  // Roots git holds (a Terramate repo's stacks, with their generated code) are named by the diff, even with a prepare step.
  if (base && synth && !shape.rootsInGit) {
    const outside = await outsideRoots(repo, base, configPath, options.project, settings, layers.flat(), env, log, false);
    if (shape.kind === "synth" && outside.synth) {
      // The base's roots came from another command, so running this one there compares nothing: every root plans.
      const why = `the synth command changed (${outside.synth})`;
      log(`every root: ${why}`);
      notices.push(`Every synthesized root is planned: ${why}.`);
    } else {
      // An Atmos instance's dependents plan with it: the instances whose dependencies.components or reads name it.
      const synthed = await synthAffected(repo, base, synth, layers.flat(), rootDependencies(repo, all), env, log, withOrder(atmosDependencies(repo, all), explicit));
      selected = synthed.selected;
      for (const [r, keys] of outside.outside.settings ?? []) {
        if (!selected || selected.has(r)) continue;
        selected.add(r);
        log(`affected: ${r}: its terragucci.yml settings changed (${keys.join(", ")})`);
      }
      notices.push(synthed.notice);
    }
  } else if (base) {
    const outside = await outsideRoots(repo, base, configPath, options.project, settings, layers.flat(), env, log, true);
    selected = affectedRoots(repo, base, all, layers.flat(), log, after, outside.outside);
  }
  // ci.hooks: read at base, so the change under review cannot add, edit or remove one. Drift has no base: the default branch's own.
  const hooksRead = readHooks(repo, base);
  if (hooksRead.note) log(hooksRead.note);
  const hooks = hooksUsed(hooksRead.hooks, stage);
  if (hookCount(hooks) > 0) log(`ci.hooks: ${hookCount(hooks)} read from chant.workspace.json at ${hooksRead.from}`);
  const planLayers = selected ? layers.map((l) => l.filter((r) => selected.has(r))).filter((l) => l.length > 0) : layers;
  const roots = planLayers.flat();
  if (roots.length === 0) log("this change reaches no root, so nothing is planned");
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, all).value;
  // A root under live resource markers keeps no state to refresh, and every plan of it reads the live system:
  // drift plans it in full, and what the plan would change is what moved outside the code.
  const live = new Set(drift && fullDriftPlans(binary) ? liveRoots(repo, roots) : []);
  const planner = plannerForBinary(binary);
  // A pull request's plan under choudoufu takes -cone=<base> (../cone.ts). Not under approval: pr-review with the apply
  // after merge: the review binds this plan's digest to the merge commit's plan, which is full, and a cone's never equals it.
  const coneBase = base && !(approvalModeOf(settings.approval) === "pr-review" && settings.apply?.when !== "pull-request") ? base : undefined;
  // Each root's binary: the job's, or the version the root pins, installed once per version.
  const binaries = new RootBinaries(repo, binary, settings.version, env, options.installer);
  const started = new Date().toISOString();
  const observer = new StageObserver(telemetryFromEnv(env), stage, env);
  if (roots.length > 0) await observer.collectSpans(log);
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));
  // apply.branches: drift checks a root another branch applies from that branch, which is what applied it (../branch-checkouts.ts).
  const sources = drift ? branchCheckouts(repo, settings.apply?.branches, roots, work, log) : undefined;
  const checkoutOf = (root: string): string => sources?.dirOf(root) ?? repo;
  const binariesAt = new Map<string, RootBinaries>([[repo, binaries]]);
  /** A root's binaries, read from the checkout it plans from, so a pin its branch sets is the one it runs. */
  const binariesOf = (root: string): RootBinaries => {
    const at = checkoutOf(root);
    if (!binariesAt.has(at)) binariesAt.set(at, new RootBinaries(at, binary, settings.version, env, options.installer));
    return binariesAt.get(at)!;
  };
  const limit = options.parallelism !== undefined ? { value: options.parallelism, reason: "--parallelism" } : rootsParallelism(repo, roots, settings, env);
  if (roots.length > 1) log(`planning ${limit.value === 1 ? "one root at a time" : `up to ${limit.value} roots at once`} (${limit.reason})`);
  // Roots whose lock file does not pin their providers at the binary's registry take them from the shared cache (#737).
  const unlocked = roots.filter((r) => !lockCovers(join(checkoutOf(r), r), binariesOf(r).expected(r).name));
  if (unlocked.length > 0) log(`${unlocked.length === 1 ? `${unlocked[0]} takes its providers` : `${unlocked.length} roots take their providers`} from the shared cache with no lock entry to check them against: commit a .terraform.lock.hcl for the binary's registry to pin them`);
  // The roots share one provider cache, the job's or one of the stage's own, so a provider downloads once per job rather
  // than once per root (some 700 MB for the AWS provider). The binary takes a provider from the cache only for a root
  // whose .terraform.lock.hcl names it; a root without one downloads it again to check the package. The cache is not
  // safe for inits that run together, so they take turns. Plans still run at once. Each download is in the log.
  const binEnv = { ...env, TF_PLUGIN_CACHE_DIR: env.TF_PLUGIN_CACHE_DIR || mkdtempSync(join(work, "plugins-")) };
  const initTurn = oneAtATime();

  // modules.require: attested, checked for every root before any plans, one at a time, since each check fetches into the checkout.
  const pinRefusals = new Map<string, string[]>();
  if (!drift && roots.length > 0) {
    const pins = await pinChecker(repo, settings.modules, base, policyTrust(repo, options), { env, ...(settings.sources?.proxies ? { proxies: settings.sources.proxies } : {}) });
    for (const root of pins ? roots : []) {
      const r = await pins!(root);
      if (r.refused.length) pinRefusals.set(root, r.refused);
      else if (r.verified.length) log(`${root}: attested ${r.verified.join("; ")}`);
    }
  }
  // sources: each root's module and provider sources against the list at base, before anything is downloaded for it (../sources.ts).
  // What init fetched and locked is checked again after each root's init, before its plan.
  const sourceRefusals = new Map<string, string[]>();
  const sourcesOf = roots.length > 0 ? await sourceChecker(repo, settings.sources, base, policyTrust(repo, options), { log }) : undefined;
  for (const root of sourcesOf ? roots : []) {
    const refused = await sourcesOf!.before(root, checkoutOf(root));
    if (refused.length) sourceRefusals.set(root, refused);
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
  // What each root follows: its reads, and the roots waves.after puts before it. An upstream it follows but does not read holds nothing back.
  const orderOf = drift ? readsOf : rootOrder(repo, all, after);
  // Linked states: the terraform_remote_state blocks of each root, and the plans of the roots this run planned, whose outputs a later layer plans on.
  const blocksOf = drift ? new Map<string, { name: string; upstream: string; repeated: boolean }[]>() : remoteStateReads(repo, all);
  // The states the code does not address: their edges are unknown, and the report says so.
  const unaddressedOf = new Map(drift ? [] : unaddressedStates(repo, all).map((u) => [u.root, { ...(u.reads.length ? { unknownReads: u.reads.map((r) => ({ data: r.name, why: r.why })) } : {}), ...(u.own ? { unaddressed: u.own } : {}) }] as const));
  const upstreamPlans = new Map<string, unknown>();
  // choudoufu: each root's terraform_estate_outputs reads and the root that owns each estate, so a reader plans on its
  // upstream's plan in this run (plan -estate-outputs-from, ../estate-planned.ts). An upstream whose estate a root of the
  // run reads keeps its show -json in a file for that flag.
  const estatePlans = !drift && plansOnPlannedEstates(binary);
  const estateReadsOf = new Map(estatePlans ? roots.map((r) => [r, estateOutputReads(join(repo, r))] as const) : []);
  const estateOwner = new Map<string, string>();
  // choudoufu's resolved estate (choudoufu#2293) for each live root, where the binary prints it; else the live block's.
  for (const r of estatePlans ? liveRoots(repo, all) : []) await readLiveSetup(join(repo, r), { binary });
  for (const r of estatePlans ? all : []) {
    const e = resolvedEstate(join(repo, r));
    if (e) estateOwner.set(e, r);
  }
  const readEstates = new Set([...estateReadsOf.values()].flat().map((b) => b.estate));
  // The control repo's records say which project owns each estate; read now, at this plan, never kept (terragucci#753).
  if (estatePlans && (estateOwner.size > 0 || [...estateReadsOf.values()].some((r) => r.length > 0))) {
    const claims = options.controlClaims ? options.controlClaims() : await controlClaimsAt(settings.control, env);
    if (claims) {
      const found = checkOwnership({ self: options.project ?? projectKeyFromEnv(env), local: new Map([...estateOwner]), reads: estateReadsOf, claims });
      for (const n of found.notes) log(n);
      if (found.refusals.length) throw new ConfigError(`estate ownership has ${found.refusals.length} problem(s):\n  ${found.refusals.join("\n  ")}`, found.refusals);
    }
  }
  const upstreamPlanFiles = new Map<string, string>();
  // The apply's waves (canary layers first, one dependency layer each), cut from every root so the numbers match its wave-<k> gates.
  // Drift is not applied, so there are no waves to gate.
  const applyOrder = drift ? [] : applyWaves(full, options.canary ?? settings.waves?.canary);
  const waveOf = new Map(applyOrder.flatMap((w, i) => w.map((r) => [r, i + 1] as const)));
  // An Atmos instance's reads (../atmos.ts): each upstream's outputs, read once, in its own workspace and with its own role.
  const outputsRead = new Map<string, Promise<UpstreamOutputs>>();
  const outputsOf = (up: string): Promise<UpstreamOutputs> => {
    if (!outputsRead.has(up)) {
      const upDir = join(repo, up);
      outputsRead.set(up, binaries.resolve(up).then((b) => b.path, () => binary).then((b) => upstreamOutputs(b, upDir, workspaceEnv(rootRoleEnv(binEnv, up), upDir), initTurn)));
    }
    return outputsRead.get(up)!;
  };
  let redacted = 0;
  // A root a pending estate migration adopts or retags resources into is planned by that migration (../migrate.ts pendingEstateMigrations).
  const byMigration = drift ? new Map<string, PendingEstateRoot>() : pendingEstateMigrations(repo);

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
    // choudoufu refuses to plan it while its resources carry no marker of the estate; the migration's proof stands for its plan.
    const pending = byMigration.get(root);
    if (pending) {
      lines.push(`${root}: planned by migration ${pending.name}`);
      return { root, lines, deferred: { unit: root, after: [], why: `planned by migration ${pending.name}: ${pendingWhy(pending)}, and the root plans on its own once the migration applies`, previewed: false } };
    }
    const dir = join(checkoutOf(root), root);
    const { links, reads } = linksFor(root);
    const estate = estateLinks(root, estateReadsOf.get(root) ?? [], estateOwner, (r) => roots.includes(r), (r) => (upstreamPlanFiles.has(r) ? { plan: upstreamPlans.get(r), file: upstreamPlanFiles.get(r)! } : undefined));
    reads.push(...estate.reads);
    for (const r of unaddressedOf.get(root)?.unknownReads ?? []) lines.push(`${root}: reads state through terraform_remote_state "${r.data}" where the code does not say (${r.why}), so it is not ordered after the root that writes it`);
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
    let bin = binariesOf(root).expected(root);
    let path = binary;
    // The root's own role, when `oidc.roles` names one (../cloud-identity.ts).
    // An Atmos instance names its workspace (../atmos.ts): it plans there, not in default.
    const rootEnv = rootCacheEnv(workspaceEnv(rootRoleEnv(binEnv, root), dir), dir, bin.name);
    // The binary's own: rootEnv with the values `secrets` gives the root, read below as its identity (../root-secrets.ts). Its hooks keep rootEnv.
    let binaryEnv = rootEnv;
    const runIn = (env: NodeJS.ProcessEnv, ...args: string[]) =>
      observer.commandAsync(timing, path, args, env, (e) => spawnAsync(path, [`-chdir=${dir}`, ...args], e));
    const run = (...args: string[]) => runIn(binaryEnv, ...args);
    const ran: ReportStep[] = [];
    const holds: string[] = [];
    /** Run one moment's hooks; the error when one failed the root. */
    const step = async (when: HookMoment, file?: string): Promise<string | undefined> => {
      if (hookCount(hooks) === 0) return undefined;
      const o = await runHooks(hooks, when, { repo: checkoutOf(root), root, stage: drift ? "tf-drift" : "tf-plan", env: rootEnv, ...(file ? { planFile: file } : {}), log: (l) => lines.push(l) });
      ran.push(...o.runs);
      holds.push(...o.holds);
      return o.error;
    };
    const failed = (error: string, line: string): RootOutcome => {
      lines.push(line);
      return { root, lines, ...(holds.length ? { holds } : {}), input: { path: root, planner, binary: bin, error, preventDestroy: new Set(), ...(ran.length ? { steps: ran } : {}), ...(reads.length ? { reads } : {}), ...unaddressedOf.get(root) } };
    };
    const refused = pinRefusals.get(root);
    if (refused) {
      observer.endRoot(timing);
      return failed(refused.join("\n"), `${root}: refused by modules.require: attested`);
    }
    const outside = sourceRefusals.get(root);
    if (outside) {
      observer.endRoot(timing);
      return failed(outside.join("\n"), `${root}: refused by sources, so it was not initialised`);
    }
    const unchecked = sources?.failed.get(root);
    if (unchecked) {
      observer.endRoot(timing);
      return failed(unchecked, `${root}: not checked, its branch could not be checked out`);
    }
    try {
      try {
        binaryEnv = await rootSecretEnv(rootEnv, root, settings.secrets);
      } catch (e) {
        return failed((e as Error).message, `${root}: not ${drift ? "checked" : "planned"}, a value of secrets could not be read: ${(e as Error).message}`);
      }
      try {
        const resolved = await binariesOf(root).resolve(root);
        ({ path } = resolved);
        bin = { name: resolved.name, ...(resolved.version ? { version: resolved.version } : {}), ...(resolved.pin ? { pin: resolved.pin } : {}) };
      } catch (e) {
        return failed((e as Error).message, `${root}: ${(e as Error).message}`);
      }
      if (bin.pin) lines.push(`${root}: ${describeBinary(bin)}`);
      let stepError = await step("before-observe");
      if (stepError) return failed(stepError, `${root}: a hook before observe failed`);
      const wsInit = workspaceInit(binaryEnv, dir);
      const init = await initTurn(() => (wsInit ? runIn(wsInit.init, "init", "-input=false", "-no-color") : run("init", "-input=false", "-no-color")));
      if (init.status !== 0) return failed(`init failed:\n${tail(init.stderr || init.stdout)}`, `${root}: init failed`);
      if (wsInit) {
        const sel = await runIn(wsInit.selectEnv, ...wsInit.select);
        if (sel.status !== 0) return failed(`workspace select failed:\n${tail(sel.stderr || sel.stdout)}`, `${root}: workspace select failed`);
      }
      for (const d of providerDownloads(init.stdout)) lines.push(`${root}: downloaded ${d}`);
      // sources: the modules init fetched and the providers it locked, before any of their code plans (../sources.ts).
      let fetched: string[] = [];
      try {
        fetched = sourcesOf ? await sourcesOf.afterInit(root, checkoutOf(root), rootEnv) : [];
      } catch (e) {
        return failed((e as Error).message, `${root}: ${(e as Error).message}`);
      }
      if (fetched.length) return failed(fetched.join("\n"), `${root}: refused by sources after init, so it was not planned`);
      // An Atmos instance that reads another's outputs plans on their values, never on a stand-in: held back while one has none yet.
      const filled = await fillReads(checkoutOf(root), root, outputsOf);
      if (filled.errors.length > 0) return failed(filled.errors.join("\n"), `${root}: could not read the state its stacks read`);
      if (filled.waiting.length > 0) {
        const after = [...new Set(filled.waiting.map((w) => w.read.upstream))].sort();
        lines.push(`${root}: held back, ${filled.waiting.map((w) => `${w.read.upstream} ${w.why} (${w.read.var}: ${w.read.function})`).join("; ")}`);
        return { root, lines, deferred: { unit: root, after, why: `reads ${filled.waiting.map((w) => `${w.read.var} from ${w.read.upstream}, which ${w.why}`).join(", and ")}, so it cannot plan until then`, previewed: false } };
      }
      for (const v of filled.filled) lines.push(`${root}: ${v} read from the state its stacks name`);
      stepError = await step("before-plan");
      if (stepError) return failed(stepError, `${root}: a hook before the plan failed`);
      // A plan never writes state, so it takes no lock and never blocks an apply.
      // A refresh-only plan compares the state with the real objects and ignores the code.
      // choudoufu: -estate-outputs-from for each estate it reads whose root planned in this run (../estate-planned.ts).
      const planArgs = [...(drift && !live.has(root) ? ["-refresh-only"] : []), "-input=false", "-no-color", "-lock=false", ...estate.args, `-out=${planFile}`];
      // choudoufu plans a pull request's live root as the cone of its change since base (../cone.ts), but not one planned
      // on another estate's planned outputs, which choudoufu would plan in full anyway.
      const cone = estate.args.length > 0 ? [] : coneArgs(bin.name, coneBase, planArgs, coneRoot(checkoutOf(root), root));
      const planOnce = () => run("plan", ...cone, ...planArgs);
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
      if (estate.args.length > 0 && p.status !== 0) {
        // choudoufu refused a read of the upstreams' planned outputs. An unknown one is known once the upstream's wave
        // applies, and the root plans then; a sensitive one never crosses to another estate, so the root fails.
        const refused = estateRefusals(`${p.stderr}\n${p.stdout}`);
        const sensitive = refused.filter((r) => r.kind === "sensitive");
        if (sensitive.length > 0) {
          const why = sensitiveWhy(sensitive, estate.upstreamOf);
          return failed(`${why}:\n${tail(p.stderr || p.stdout)}`, `${root}: not planned, ${why}`);
        }
        const unknown = refused.filter((r) => r.kind === "unknown");
        if (unknown.length > 0) {
          const after = [...new Set(unknown.map((r) => estate.upstreamOf.get(r.estate)).filter((u): u is string => u !== undefined))].sort();
          const why = unknownWhy(unknown, estate.upstreamOf, wavesOf(waveOf, after, waveOf.get(root) ?? 0));
          lines.push(`${root}: not planned: ${why}`);
          return { root, lines, deferred: { unit: root, after, why, previewed: false }, unknownFrom: after };
        }
      }
      if (p.status === 0) for (const r of estate.reads) if (r.outputs === "planned") lines.push(plannedReadLine(root, r));
      reads.sort((a, b) => (a.upstream < b.upstream ? -1 : a.upstream > b.upstream ? 1 : a.data < b.data ? -1 : 1));
      if (p.status !== 0 || !existsSync(planFile)) return failed(`plan failed:\n${tail(p.stderr || p.stdout)}`, `${root}: plan failed`);
      const planCone = cone.length && coneBase ? readPlanCone(`${p.stdout}\n${p.stderr}`, planFile, coneBase) : undefined;
      if (planCone) lines.push(coneLogLine(root, planCone));
      stepError = await step("after-plan", planFile);
      if (stepError) return failed(stepError, `${root}: a hook after the plan failed`);
      const json = await run("show", "-json", planFile);
      const text = await run("show", "-no-color", planFile);
      let plan: unknown;
      try {
        plan = JSON.parse(json.stdout);
      } catch {
        return failed(`show -json printed no plan:\n${tail(json.stderr || json.stdout)}`, `${root}: show -json failed`);
      }
      // The secrets the plan leaves in state, and what could keep each out, from the provider schema the root initialised (../tips/secrets.ts).
      // A choudoufu estate under secrets = "refuse" keeps sensitive arguments out of its records, so its own setting governs them.
      const estateLive = liveEstate(dir);
      const held: Awaited<ReturnType<typeof rootSecrets>> = estateLive?.secrets === "refuse" ? { secrets: [] } : await rootSecrets(plan, bin, () => run("providers", "schema", "-json"));
      if (held.note) lines.push(`${root}: ${held.note}`);
      if (live.has(root)) plan = liveDrift(plan);
      if (!drift) upstreamPlans.set(root, plan);
      if ([...estateOwner].some(([e, r]) => r === root && readEstates.has(e))) {
        const file = join(work, `${index}.tfplan.json`);
        writeFileSync(file, json.stdout);
        upstreamPlanFiles.set(root, file);
      }
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
        input: { path: root, plan: drift ? driftPlan(plan) : plan, planner, binary: bin, files: planFiles(root), preventDestroy: preventDestroyIn(dir), ...(planCone ? { cone: planCone } : {}), ...(ran.length ? { steps: ran } : {}), ...(reads.length ? { reads } : {}), ...(held.secrets.length ? { secrets: held.secrets } : {}), ...(estateLive ? { live: estateLive } : {}), ...unaddressedOf.get(root) },
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

  // waves.compose: the roots the change reaches, and the roots they read, plan as one composed run (../compose.ts), opt-in beside the waves.
  let composition: Composition | undefined;
  let composedPlan: ComposedPlan | undefined;
  if (!drift && !options.root && settings.waves?.compose === true && roots.length > 0) {
    // One apply job per identity: the composed run's roots must be in one group, as the apply checks (../cloud-identity.ts).
    const groups = applyGroups(settings, all);
    const c = await compositionFor(repo, { all, ...(selected ? { selected } : {}), waves: applyOrder, max: settings.waves.compose_max, env: binEnv, binary: (r) => binaries.expected(r), deps: rootDependencies(repo, all), after, ...(groups ? { groupOf: (r: string) => groups.find((g) => g.roots.includes(r))?.name ?? "" } : {}) });
    composition = c;
    const refusedMember = c.fallback ? undefined : c.roots.find((r) => pinRefusals.has(r) || sourceRefusals.has(r));
    if (refusedMember) composition = { ...c, wave: undefined, fallback: { kind: "plan-failed", root: refusedMember, reason: `\`${refusedMember}\` is refused before its init, so the roots plan one by one and the refusal shows against it` } };
    else if (c.wave !== undefined) {
      const planned = await planComposedStage(repo, c, { binaries, binEnv, work, initTurn, hooks, sourcesOf, log, planner });
      if ("fallback" in planned) composition = { ...c, wave: undefined, fallback: planned.fallback };
      else {
        composedPlan = planned.plan;
        for (const o of planned.outcomes) {
          take({ ...o, input: { ...o.input!, ...unaddressedOf.get(o.root) } });
          upstreamPlans.set(o.root, o.input!.plan);
        }
      }
    }
    if (composition.fallback) log(`compose: ${composition.fallback.reason}, so the change applies in waves`);
    else log(`compose: ${composition.roots.join(", ")} plan as one composed run in wave ${composition.wave}`);
  }
  const inRun = composedPlan && composition?.wave !== undefined ? new Set(composition.roots) : undefined;

  try {
    let index = 0;
    // Roots in one layer read none of each other's state, so they plan at once. A later layer waits for the layers it reads.
    for (const whole of planLayers) {
      // A root of the composed run planned in it.
      const layer = inRun ? whole.filter((r) => !inRun.has(r)) : whole;
      // The upstreams this layer reads, each read once, before any root of the layer plans.
      const ups = [...new Set(layer.flatMap((r) => [...(readsOf.get(r) ?? [])]))].filter((up) => !upstreamState.has(up)).sort();
      await eachLimited(ups, limit.value, async (up) => {
        // The upstream's own binary reads its state; the job's when its pin cannot be installed, and its own plan says why.
        const upBinary = await binaries.resolve(up).then((b) => b.path, () => binary);
        upstreamState.set(up, await stateIsEmptyAsync(upBinary, join(repo, up), workspaceEnv(rootRoleEnv(binEnv, up), join(repo, up)), initTurn));
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
    sources?.close();
    rmSync(work, { recursive: true, force: true });
  }

  // A composed run sits in the earliest wave its roots are in, and the later waves no longer list its roots.
  const runWave = inRun ? composition!.wave! : undefined;
  const waveOfRun = inRun ? new Map([...waveOf].map(([r, n]) => [r, inRun.has(r) ? runWave! : n] as const)) : waveOf;
  const waves: WaveInput[] = applyOrder
    .map((w, i) => ({ number: i + 1, roots: inRun ? [...w.filter((r) => roots.includes(r) && !held.has(r) && !inRun.has(r)), ...(i + 1 === runWave ? composition!.order : [])] : w.filter((r) => roots.includes(r) && !held.has(r)) }))
    .filter((w) => w.roots.length > 0)
    .map((w) => {
      const holding = w.roots.filter((r) => heldBySteps.has(r));
      const reads = wavesOf(waveOfRun, w.roots.flatMap((r) => [...(orderOf.get(r) ?? [])]), w.number);
      // A root whose upstream's output is unknown until that upstream applies replans after it, planned in the run or not.
      const replansAfter = wavesOf(waveOfRun, applyOrder[w.number - 1]!.flatMap((r) => unknownFrom.get(r) ?? []), w.number);
      const composed = w.number === runWave && composedPlan
        ? { composed: { target: composeTarget(runWave), planDigest: composedPlan.digest || null, plan: composedPlan.plan, members: composition!.order.map((r) => ({ root: r, module: `module.${composition!.modules.get(r)}` })), ...(composedPlan.unknown.length ? { heldByUnknown: composedPlan.unknown } : {}) } }
        : {};
      return {
        ...w,
        ...composed,
        state: "planned" as const,
        ...(holding.length ? { heldBySteps: holding } : {}),
        ...(reads.length ? { reads } : {}),
        ...(replansAfter.length ? { replansAfter } : {}),
      };
    });

  // The blast radius: the roots whose plan changes something, and every root that reads their state, followed through.
  const changing = inputs.filter((i) => i.plan !== undefined && !i.error && changesSomething(i.plan)).map((i) => i.path);
  const radius = !drift && changing.length > 0 ? blastRadius(orderOf, changing, { waveOf, planned: new Set(roots) }) : undefined;
  // By resource, when a root is downstream: what each changed resource reaches through the plans' references and the outputs roots read.
  const byResource = radius && radius.downstream.length > 0 ? resourceBlast(blastRootsOf(repo, all, inputs.filter((i) => !i.error), blocksOf), radius.roots) : [];
  const blast = radius ? { ...radius, ...(byResource.length ? { resources: byResource } : {}) } : undefined;
  // A plain root's dependencies in the report: the roots waves.after puts before it (its reads are in roots[].reads).
  const dependencies = explicit.size ? new Map([...explicit].map(([r, ups]) => [r, [...ups].sort()])) : undefined;
  const compose = composition ? reportCompose(composition) : undefined;
  return finish(repo, settings, options, env, log, { binary, started, inputs, waves, plans, redacted, all, roots, observer, stage, names, ...(attributing ? { attributions } : {}), ...(deferred.length ? { deferred } : {}), ...(notices.length ? { notices } : {}), ...(blast ? { blast: blast as ReportBlast } : {}), ...(dependencies ? { dependencies } : {}), ...(compose ? { compose } : {}) });
}

/** What the composed plan of a tf-plan needs from the stage: the binaries, the provider cache and its turns, the hooks, the sources check. */
interface ComposeStageContext {
  binaries: RootBinaries;
  binEnv: NodeJS.ProcessEnv;
  work: string;
  initTurn: Turn;
  hooks: StageHooks;
  sourcesOf: SourceChecker | undefined;
  log: (line: string) => void;
  planner: ReturnType<typeof plannerForBinary>;
}

/**
 * A tf-plan's composed run: planned once, taking no lock, then cut back into
 * each root's part, which the report and the note show under the root's own
 * name. A plan that fails falls back (`plan-failed`): the roots then plan one
 * by one, so the error shows against the root it is in.
 */
async function planComposedStage(repo: string, c: Composition, ctx: ComposeStageContext): Promise<{ plan: ComposedPlan; outcomes: RootOutcome[] } | { fallback: ComposeFallback }> {
  const { binaries, binEnv, work, initTurn, hooks, sourcesOf, log, planner } = ctx;
  const first = c.order[0]!;
  let resolved;
  try {
    resolved = await binaries.resolve(first);
  } catch (e) {
    return { fallback: { kind: "plan-failed", root: first, reason: `the binary of \`${first}\` could not be installed (${(e as Error).message.split("\n")[0]}), so the roots plan one by one` } };
  }
  const bin: ReportRootBinary = { name: resolved.name, ...(resolved.version ? { version: resolved.version } : {}), ...(resolved.pin ? { pin: resolved.pin } : {}) };
  const ran = new Map<string, ReportStep[]>();
  const holds = new Map<string, string[]>();
  const run = new ComposedRun({
    repo,
    composition: c,
    binary: { path: resolved.path, name: resolved.name },
    env: binEnv,
    work: mkdtempSync(join(work, "compose-")),
    lock: false,
    initTurn,
    hooks: {
      log,
      step: async (root, when, file) => {
        if (hookCount(hooks) === 0) return undefined;
        const o = await runHooks(hooks, when, { repo, root, stage: "tf-plan", env: rootRoleEnv(binEnv, root), ...(file ? { planFile: file } : {}), log });
        ran.set(root, [...(ran.get(root) ?? []), ...o.runs]);
        if (o.holds.length) holds.set(root, [...(holds.get(root) ?? []), ...o.holds]);
        return o.error;
      },
      afterInit: async (root, renv) => {
        if (!sourcesOf) return undefined;
        try {
          const fetched = await sourcesOf.afterInit(root, repo, renv);
          return fetched.length ? `refused by sources after init, so it was not planned\n${fetched.join("\n")}` : undefined;
        } catch (e) {
          return (e as Error).message;
        }
      },
    },
  });
  let plan: ComposedPlan;
  try {
    plan = await run.plan();
  } finally {
    await run.release();
  }
  if (plan.error) {
    for (const l of plan.error.split("\n").slice(0, 20)) log(`compose: ${l}`);
    return { fallback: { kind: "plan-failed", ...(plan.root ? { root: plan.root } : {}), reason: `the composed plan failed${plan.root ? ` at \`${plan.root}\`` : ""}, so the roots plan one by one and the error shows against the root it is in` } };
  }
  log(`compose: ${plan.summary} across ${c.roots.length} roots, digest ${plan.digest}`);
  const outcomes: RootOutcome[] = c.order.map((root) => {
    const slice = plan.slices.get(root);
    const module = `module.${c.modules.get(root)}`;
    const safe = redactPlan(slice);
    const reads = plan.reads.get(root) ?? [];
    const lines = [`${root}: in the composed run as ${module}: ${plan.texts.get(root)?.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned"}`, ...reads.map((r) => plannedReadLine(root, r))];
    return {
      root,
      lines,
      redacted: safe.values,
      ...(holds.get(root)?.length ? { holds: holds.get(root) } : {}),
      plan: { text: scrubPlanText(plan.texts.get(root) ?? "", slice).text, json: JSON.stringify(safe.plan, null, 2) + "\n" },
      input: { path: root, plan: slice, planner, binary: bin, files: planFiles(root), preventDestroy: preventDestroyIn(join(repo, root)), ...(ran.get(root)?.length ? { steps: ran.get(root) } : {}), ...(reads.length ? { reads } : {}), composed: { wave: c.wave!, module } },
    };
  });
  return { plan, outcomes };
}

export { reportCompose };

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
  /** tf-plan of plain roots: what the change reaches through the roots that read the changed roots' state. */
  blast?: ReportBlast;
  /** A Terragrunt unit's dependency and dependencies blocks: the units whose outputs it reads. A plain root's: the roots waves.after puts before it. */
  dependencies?: ReadonlyMap<string, string[]>;
  /** `waves.compose`: the roots a composed run covers, and its wave or why the change applies in waves. */
  compose?: ReportCompose;
}

/**
 * A Terragrunt repo's tf-plan or tf-drift: its units by wave, as the pipeline
 * names them or as discovery finds them. tf-drift refresh-plans every unit,
 * with no affected selection, and keeps the drift issue.
 */
async function runTerragruntStage(
  repo: string,
  settings: ReturnType<typeof resolveRepo>,
  shape: Shape,
  options: StageOptions,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  drift = false,
  configPath?: string,
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
  } else {
    // The pipeline names the waves, so discovery does not run; an explicit stack's units are still generated before they plan.
    const stacks = await shape.prepareRoots({ binary, ...tool });
    if (stacks.length) log(`generated the units of ${stacks.length} explicit stack${stacks.length === 1 ? "" : "s"}: ${stacks.join(", ")}`);
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
  // ci.hooks: read at base, as for plain roots, so the change under review cannot add, edit or remove one.
  const hooksRead = readHooks(repo, base);
  if (hooksRead.note) log(hooksRead.note);
  const hooks = hooksUsed(hooksRead.hooks, drift ? "tf-drift" : "tf-plan");
  if (hookCount(hooks) > 0) log(`ci.hooks: ${hookCount(hooks)} read from chant.workspace.json at ${hooksRead.from}`);
  // modules.require: attested, checked for every unit before any wave plans, as for plain roots: a refused unit fails and does not plan.
  const refusedUnits: RootInput[] = [];
  if (!drift) {
    const pins = await pinChecker(repo, settings.modules, base, policyTrust(repo, options), { env, ...(settings.sources?.proxies ? { proxies: settings.sources.proxies } : {}) });
    for (const unit of pins ? waves.flat() : []) {
      const r = await pins!(unit);
      if (r.refused.length) {
        log(`${unit}: refused by modules.require: attested`);
        refusedUnits.push({ path: unit, planner: plannerForBinary(binary), error: r.refused.join("\n"), preventDestroy: new Set(), terragrunt: { ...unitStack(unit), selection: reasons.get(unit) ?? everyUnit, provisional: false, run_result: "not run" } });
      } else if (r.verified.length) log(`${unit}: attested ${r.verified.join("; ")}`);
    }
  }
  // sources: each unit's terraform source and the module and provider sources under it, against the list at base (../sources.ts).
  // What each unit's init fetched and locked is checked again before its plan.
  let unitSources: SourceChecker | undefined;
  {
    const sourcesOf = (unitSources = waves.length > 0 ? await sourceChecker(repo, settings.sources, base, policyTrust(repo, options), { log }) : undefined);
    const already = new Set(refusedUnits.map((u) => u.path));
    for (const unit of sourcesOf ? waves.flat() : []) {
      if (already.has(unit)) continue;
      const r = await sourcesOf!.before(unit);
      if (r.length) {
        log(`${unit}: refused by sources, so it was not planned`);
        refusedUnits.push({ path: unit, planner: plannerForBinary(binary), error: r.join("\n"), preventDestroy: new Set(), terragrunt: { ...unitStack(unit), selection: reasons.get(unit) ?? everyUnit, provisional: false, run_result: "not run" } });
      }
    }
  }
  if (refusedUnits.length > 0) {
    const refused = new Set(refusedUnits.map((u) => u.path));
    waves = waves.map((w) => w.filter((u) => !refused.has(u))).filter((w) => w.length > 0);
  }
  const started = new Date().toISOString();
  const observer = new StageObserver(telemetryFromEnv(env), drift ? "tf-drift" : "tf-plan", env);
  // Each unit's plan sends its spans here through the TG_TF_PATH wrapper, for its per-resource timings.
  await observer.collectSpans(log);
  const work = mkdtempSync(join(tmpdir(), "terragucci-plan-"));
  // Each layer: the units it plans, and the dependents it previews (dependents: plan, the default; follow opts out).
  const selected = new Set(waves.flat());
  // shape: Terragrunt's dependents default
  const previewing = new Set(!drift && (settings.terragrunt?.dependents ?? DEFAULT_DEPENDENTS) === "plan" ? preview : []);
  const layers = full
    .map((w, i) => ({ number: i + 1, roots: w.filter((u) => selected.has(u)), preview: w.filter((u) => previewing.has(u)) }))
    .filter((l) => l.roots.length > 0 || l.preview.length > 0);
  // apply.branches: drift checks a unit another branch applies from that branch, which is what applied it (../branch-checkouts.ts).
  const sources = drift ? branchCheckouts(repo, settings.apply?.branches, layers.flatMap((l) => l.roots), work, log) : undefined;
  try {
    const terragrunt = options.terragruntPath ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
    const graph = units ?? walkUnits(repo, settings.terragrunt?.exclude);
    /** One checkout's units planned: the repo's, or a branch's worktree's, with its own pins and its own explicit stacks. */
    const planIn = async (dir: string, own: UnitLayer[], sub: string): Promise<Awaited<ReturnType<typeof planUnits>>> => {
      // shape: another checkout's own stacks, which the repo's shape does not describe.
      if (dir !== repo) await generateStacks(dir, { binary, ...tool });
      const tools = new UnitBinaries(dir, binary, settings.version, terragrunt, env, options.installer);
      return planUnits(dir, own, binary, sub, {
        ...options, env, drift, observer, waveOf, hooks, tools,
        ...(unitSources ? { sources: unitSources } : {}),
        // The edges a preview follows: discovery's, else the plain paths the units' files name.
        graph,
        selection: (u) => reasons.get(u) ?? everyUnit,
      }, log);
    };
    let planned: Awaited<ReturnType<typeof planUnits>>;
    if (!sources) planned = await planIn(repo, layers, work);
    else {
      const parts: Awaited<ReturnType<typeof planUnits>>[] = [];
      for (const [i, g] of sources.groups(layers.flatMap((l) => l.roots)).entries()) {
        const mine = new Set(g.roots);
        const own = layers.map((l) => ({ ...l, roots: l.roots.filter((u) => mine.has(u)), preview: [] })).filter((l) => l.roots.length > 0);
        const sub = join(work, `checkout-${i}`);
        mkdirSync(sub, { recursive: true });
        parts.push(await planIn(g.dir, own, sub));
      }
      planned = mergePlanned(parts);
      for (const [u, why] of sources.failed) {
        log(`${u}: not checked, its branch could not be checked out`);
        planned.inputs.push({ path: u, planner: plannerForBinary(binary), error: why, preventDestroy: new Set(), terragrunt: { ...unitStack(u), selection: everyUnit, provisional: false, run_result: "not run" } });
      }
    }
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
        inputs.push({ path: u, planner: plannerForBinary(binary), error, preventDestroy: new Set(), terragrunt: { ...unitStack(u), selection: everyUnit, provisional: false, run_result: "not run" } });
        continue;
      }
      defer(u, [...new Set(mockReads.filter((r) => r.unit === u).map((r) => r.upstream))].sort(), "would read mock_outputs");
    }
    // Drift names who changed what when the project asks for it, for units as for plain roots: the same audit log and decision.
    const attributing = drift && responseTo(settings, "drift") === "attribute";
    const attributions = new Map<string, Attributed>();
    if (attributing) {
      const audit = options.audit ?? awsAuditLog({ region: settings.audit_region });
      for (const [unit, drifted] of planned.found) {
        try {
          attributions.set(unit, await attribute(unit, drifted, { audit, decide: settings.decide, options: options.decideOptions }));
        } catch (e) {
          log(`${unit}: attribution skipped, ${(e as Error).message}`);
        }
      }
    }
    for (const [u, b] of planned.unpreviewed) defer(u, [...b.after].sort(), b.why);
    const previewed = new Set(inputs.filter((r) => r.terragrunt?.provisional && r.plan !== undefined).map((r) => r.path));
    for (const d of deferred) d.previewed = previewed.has(d.unit);
    const all = (units ?? []).map((u) => u.path);
    const plannedPaths = inputs.map((r) => r.path);
    // A wave covers what it planned for real: no unit that waits for its upstream, and no preview.
    const real = new Set(inputs.filter((r) => !r.terragrunt?.provisional).map((r) => r.path));
    // Each unit's dependencies, from discovery or, when the pipeline named the waves, its terragrunt.hcl.
    const edges = units ?? walkUnits(repo, settings.terragrunt?.exclude);
    // The blast radius, as for plain roots: the units whose own plan changes something (not a preview), and every unit that depends on them, followed through.
    const changing = drift ? [] : inputs.filter((i) => i.plan !== undefined && !i.error && !i.terragrunt?.provisional && changesSomething(i.plan)).map((i) => i.path);
    const blast = changing.length > 0 ? blastRadius(new Map(edges.map((u) => [u.path, u.dependencies])), changing, { waveOf, planned: new Set(plannedPaths) }) : undefined;
    return await finish(repo, settings, options, env, log, {
      ...(blast ? { blast: blast as ReportBlast } : {}),
      binary, started, inputs, plans, redacted, all: all.length ? all : plannedPaths, roots: plannedPaths, observer, mockReads,
      dependencies: new Map(edges.map((u) => [u.path, u.dependencies])),
      ...(drift ? { stage: "tf-drift" as const, names: planned.names } : {}),
      ...(attributing ? { attributions } : {}),
      deferred: deferred.sort((a, b) => (a.unit < b.unit ? -1 : 1)),
      ...(existsSync(join(repo, "root.hcl")) ? { configDirs: ["."] } : {}),
      // Drift is not applied, so there are no waves to gate. Each wave keeps the number its apply job has.
      waves: drift ? [] : layers
        .map((l) => {
          // A unit of the wave not previewed plans once the waves it reads apply: so does the wave, and no review binds it now.
          const replansAfter = wavesOf(waveOf, l.roots.flatMap((u) => planned.unpreviewed.get(u)?.after ?? []), l.number);
          const reads = planned.waveReads.get(l.number) ?? [];
          const roots = l.roots.filter((u) => real.has(u));
          const holding = roots.filter((u) => planned.heldBySteps.has(u));
          return { number: l.number, roots, ...(reads.length ? { reads } : {}), ...(replansAfter.length ? { replansAfter } : {}), ...(holding.length ? { heldBySteps: holding } : {}) };
        })
        .filter((w) => w.roots.length > 0),
    });
  } finally {
    sources?.close();
    rmSync(work, { recursive: true, force: true });
  }
}

/** The units of several checkouts planned, as one run: each checkout's units are its own, so nothing overlaps. */
function mergePlanned(parts: Awaited<ReturnType<typeof planUnits>>[]): Awaited<ReturnType<typeof planUnits>> {
  const waveReads = new Map<number, number[]>();
  for (const p of parts) for (const [w, r] of p.waveReads) waveReads.set(w, [...new Set([...(waveReads.get(w) ?? []), ...r])].sort((a, b) => a - b));
  return {
    inputs: parts.flatMap((p) => p.inputs).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    plans: new Map(parts.flatMap((p) => [...p.plans])),
    redacted: parts.reduce((n, p) => n + p.redacted, 0),
    mockReads: parts.flatMap((p) => p.mockReads),
    waiting: parts.flatMap((p) => p.waiting),
    names: new Map(parts.flatMap((p) => [...p.names])),
    unpreviewed: new Map(parts.flatMap((p) => [...p.unpreviewed])),
    waveReads,
    found: new Map(parts.flatMap((p) => [...p.found])),
    heldBySteps: new Set(parts.flatMap((p) => [...p.heldBySteps])),
  };
}

/**
 * The roots a change from `base` to HEAD reaches: chant's path rules (a file
 * in the root, in a local module it calls, or one of its var files), the
 * files `outside` says a root reads beyond its directory (var files from
 * TF_CLI_ARGS, symlink targets), the roots whose terragucci.yml settings
 * changed, plus every root that reads a reached root's state or that
 * `waves.after` puts after one, followed through. Undefined, so every root
 * plans, when git cannot diff the range.
 */
export function affectedRoots(repo: string, base: string, all: string[], roots: string[], log: (line: string) => void, after?: WavesAfter, outside: OutsideRoots = {}, direct = false): Set<string> | undefined {
  // direct: base is HEAD's parent (an apply), so the change is the diff between the two, which a shallow checkout can take.
  const range = direct ? [base, "HEAD"] : [`${base}...HEAD`];
  const diff = spawnSync("git", ["-C", repo, "diff", "--name-only", "--no-renames", "--relative", ...range], { encoding: "utf-8" });
  if (diff.status !== 0) {
    log(`every root: affected selection failed (git diff ${range.join(" ")}: ${(diff.stderr || "").trim().split("\n")[0]})`);
    return undefined;
  }
  const files = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const watch = outside.watch ?? {};
  const own = changedRoots(repo, Object.fromEntries(roots.map((r) => [r, { dir: r }])), files);
  const read = Object.keys(watch).length ? changedRoots(repo, Object.fromEntries(roots.map((r) => [r, { dir: r, ...(watch[r] ? { varFiles: watch[r] } : {}) }])), files) : own;
  const fromSettings = [...(outside.settings?.keys() ?? [])].filter((r) => roots.includes(r));
  const changed = [...new Set([...read, ...fromSettings])].sort();
  const deps = rootDependencies(repo, all);
  // A Terramate stack's dependents plan with it: the stacks its after, before, nesting or inputs put after it (../terramate.ts).
  const order = withOrder(atmosDependencies(repo, all), explicitOrder(after, all));
  const upstreams = (root: string): string[] => [...new Set([...(deps.get(root) ?? []), ...(order.get(root) ?? [])])];
  const selected = new Set(changed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const root of new Set([...deps.keys(), ...order.keys()])) {
      if (!selected.has(root) && upstreams(root).some((d) => selected.has(d))) {
        selected.add(root);
        grew = true;
      }
    }
  }
  for (const r of changed) {
    if (own.includes(r)) log(`affected: ${r} changed`);
    else if (read.includes(r)) log(`affected: ${r} reads ${outsideFiles(repo, r, watch[r] ?? [], files).join(", ")}, which changed`);
    else log(`affected: ${r}: its terragucci.yml settings changed (${outside.settings!.get(r)!.join(", ")})`);
  }
  for (const r of [...selected].filter((r) => !changed.includes(r)).sort()) {
    const reads = [...(deps.get(r) ?? [])].filter((d) => selected.has(d)).sort();
    const after = [...(order.get(r) ?? [])].filter((d) => selected.has(d) && !reads.includes(d)).sort();
    log(`affected: ${r} ${[...(reads.length ? [`reads the state of ${reads.join(", ")}`] : []), ...(after.length ? [`depends on ${after.join(", ")}`] : [])].join(" and ")}`);
  }
  log(`affected: ${changed.length} of ${roots.length} roots against ${base}, ${selected.size - changed.length} dependents after them`);
  return new Set([...selected].filter((r) => roots.includes(r)));
}

/** The changed files among the paths, relative to `root`, that it reads outside its directory. */
function outsideFiles(repo: string, root: string, paths: string[], files: string[]): string[] {
  const top = resolve(repo);
  const watched = paths.map((p) => relative(top, resolve(top, root, p)).split(sep).join("/"));
  return files.filter((f) => watched.some((w) => f === w || f.startsWith(`${w}/`))).sort();
}

/**
 * What a change reaches from outside every root's directory (../affected.ts):
 * each root's var files and symlink targets (`watch`, plain roots only), and,
 * when the change edits terragucci.yml, the roots whose plan settings differ
 * from the config at the base, and `synth` when its command changed. A
 * control repo's project reads its settings from the control repo, so only
 * the files count there. A base config that cannot be read selects nothing
 * for its settings, and the log says so.
 */
export async function outsideRoots(
  repo: string,
  base: string,
  configPath: string | undefined,
  project: string | undefined,
  settings: ReturnType<typeof resolveRepo>,
  roots: string[],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  files: boolean,
): Promise<{ outside: OutsideRoots; synth?: string }> {
  const outside: OutsideRoots = files ? { watch: outsideWatch(repo, roots, { ...settings.env, ...env }) } : {};
  if (project || !configChanged(repo, base, configPath)) return { outside };
  const read = await configAtBase(repo, base, configPath ? { config: configPath } : {});
  let at: ReturnType<typeof resolveRepo>;
  try {
    if ("error" in read) throw new Error(read.error);
    at = resolveRepo(read.config);
  } catch (e) {
    log(`affected: the config at ${base} could not be read (${(e as Error).message}), so no root is selected for its settings`);
    return { outside };
  }
  outside.settings = settingsChanged(at, settings, roots);
  const synth = (at.synth ?? "") !== (settings.synth ?? "") ? `${at.synth ? `\`${at.synth}\`` : "none"} at the base, ${settings.synth ? `\`${settings.synth}\`` : "none"} here` : undefined;
  return { outside, ...(synth ? { synth } : {}) };
}

/** Whether the change from `base` to HEAD edits the config file, or adds or removes one beside it. */
function configChanged(repo: string, base: string, configPath: string | undefined): boolean {
  const rel = configPath ? relative(resolve(repo), resolve(configPath)).split(sep).join("/") : undefined;
  if (rel !== undefined && (rel.startsWith("../") || rel === "..")) return false;
  const dir = rel && rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
  const paths = [...new Set([...(rel ? [rel] : []), ...CONFIG_NAMES.map((n) => `${dir}${n}`)])];
  const diff = spawnSync("git", ["-C", repo, "diff", "--name-only", "--no-renames", "--relative", `${base}...HEAD`, "--", ...paths], { encoding: "utf-8" });
  return diff.status === 0 && diff.stdout.trim() !== "";
}

/** `a` with `b`'s edges added, each root's upstreams joined. */
function withOrder(a: Map<string, Set<string>>, b: Map<string, Set<string>>): Map<string, Set<string>> {
  const out = new Map([...a].map(([r, ups]) => [r, new Set(ups)]));
  for (const [r, ups] of b) out.set(r, new Set([...(out.get(r) ?? []), ...ups]));
  return out;
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
    if (rule.overriders.length === 0 && !rule.overrideEntries) return inputs;
    // Scoped entries (../override.ts): each denied root has its own overriders, roles read at base under sealed alone.
    const roles = rule.overrideEntries?.some((e) => e.roles?.length) && rule.mode === "sealed" ? trustRolesAt(repo, rule.base) : {};
    const whoFor = (root: string, rules: readonly string[]) => overridersFor({ overriders: rule.overriders, ...(rule.overrideEntries ? { entries: rule.overrideEntries } : {}), roles }, root, rules);
    const union = [...new Set(denied.flatMap((i) => whoFor(i.path, i.policy!.rules ?? []).principals))];
    if (union.length === 0) return inputs;
    policy.overriders = rule.overrideEntries ? union : rule.overriders;
    const ledger = readLedger(repo, OVERRIDE_LEDGER);
    const now = new Date().toISOString();
    const overridden: string[] = [];
    const out = inputs.map((i) => {
      if (!denied.includes(i)) return i;
      const who = whoFor(i.path, i.policy!.rules ?? []);
      const scoped = rule.overrideEntries ? { ...i, policy: { ...i.policy!, overriders: who.shown } } : i;
      const planDigest = terraformChangeSetPart({ member: i.path, plan: i.plan, planner: i.planner ?? "terraform" }).member.planDigest;
      if (!planDigest || who.principals.length === 0) return scoped;
      const judge = overrideRule(repo, { ...rule, overriders: who.principals });
      const decision = decideOverride(ledger, judge, i.path, planDigest, i.policy!.rules ?? [], now);
      if (decision.status !== "overridden") return scoped;
      overridden.push(i.path);
      log(`${i.path}: the policy denial is overridden by ${decision.override.by} at ${decision.override.at}, so tf-apply applies this plan; the plan still fails here`);
      return { ...scoped, policy: { ...scoped.policy!, override: decision.override } };
    });
    if (overridden.length > 0) policy.overridden = overridden.sort();
    return out;
  } catch (e) {
    log(`policy override: ${(e as Error).message}, so no override is shown`);
    return inputs;
  }
}

/** `approval_rules` in the config at base, for a plan's waves; none for a control repo's project, or when the base cannot be read. */
async function baseApprovalRules(repo: string, options: StageOptions, env: NodeJS.ProcessEnv): Promise<GateQuorumRule[] | undefined> {
  if (options.project) return undefined;
  const base = options.base ?? baseRef(env);
  const configPath = options.config ?? findConfig(repo);
  try {
    return (await approvalRule(repo, { ...(base ? { at: base } : {}), ...(configPath ? { config: configPath } : {}) })).approvalRules;
  } catch {
    return undefined;
  }
}

/**
 * Mark the plan's changes on every run (./perpetual.ts) from the project's
 * changes.json in the reports bucket. Without a bucket, or when it cannot be
 * read, nothing is marked and the log says why; the plan goes on either way.
 */
export async function markRecurring(report: Report, reports: { bucket: string; endpoint?: string; prefix?: string; role?: string } | undefined, env: NodeJS.ProcessEnv, fetchFn: S3Fetch | undefined, log: (line: string) => void): Promise<number> {
  if (!reports?.bucket) {
    log("changes on every run: no change is marked, since reports is not set and the applied waves are read from the bucket's changes.json");
    return 0;
  }
  const key = changesKey(report.run.project, reports.prefix);
  let text: string | undefined;
  try {
    text = await storeFromEnv(reports, env, fetchFn).get(key);
  } catch (e) {
    log(`changes on every run: no change is marked, since ${key} could not be read: ${(e as Error).message.split("\n")[0]}`);
    return 0;
  }
  if (text === undefined) {
    log(`changes on every run: no change is marked, since ${key} holds no applied wave yet`);
    return 0;
  }
  const marked = markPerpetual(report, readChanges(text).changes);
  log(`changes on every run: ${marked} marked, each made by its root's last ${PERPETUAL_WAVES} applied waves or more (${key})`);
  return marked;
}

/** Where the policy key is read: the config file and the project the run reads. */
/**
 * The note's line for a change that loosens the top-level `gate`: each wave's
 * job takes the stricter of the pipeline's --gate and the gate at base, so
 * the change's own merge applies under the base's gate. Undefined when the
 * change keeps or tightens it, with no base, or when the base cannot be read.
 */
async function gateLoosening(repo: string, settings: ReturnType<typeof resolveRepo>, options: StageOptions, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const base = options.base ?? baseRef(env);
  if (!base || options.project) return undefined;
  const configPath = options.config ?? findConfig(repo);
  const read = await configAtBase(repo, base, configPath ? { config: configPath } : {});
  if ("error" in read) return undefined;
  const was = topGate(read.config);
  const now = topGate(settings);
  if (GATE_ORDER[now] >= GATE_ORDER[was]) return undefined;
  return `This change loosens \`gate\` from \`${was}\` to \`${now}\`: its own merge applies under \`${was}\`, and \`${now}\` takes effect from the merge after it.`;
}

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
  { binary, started, inputs: planned, waves, plans, redacted, all, roots, observer, mockReads, deferred, configDirs, stage = "tf-plan", names, attributions, notices: selection = [], blast, dependencies, compose }: Planned,
): Promise<StageResult> {
  let inputs = dependencies ? planned.map((i) => ({ ...i, ...(dependencies.get(i.path)?.length ? { dependencies: dependencies.get(i.path) } : {}) })) : planned;
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
    const run = { stage: "tf-plan" as const, project: facts.project, commit: facts.commit, actor: detectActor(repo, env, governing.policy.agents), ...(facts.pull_request ? { pullRequest: facts.pull_request } : {}) };
    // hold and allow_unattended come from the base's policy key alone: a pull request's own outcomes key turns nothing on.
    const settled = governing.from === "base" || !(options.base ?? baseRef(env)) ? governing.policy : { ...governing.policy, outcomes: undefined };
    ({ inputs, policy } = await applyPolicy(repo, settled, inputs, options.base ?? baseRef(env), governing.trust, options.policy, log, run, costOf));
    if (governing.policy.override?.length) inputs = await planOverrides(repo, options, env, inputs, policy, log);
  }
  // With environments, each root names its environment, and each wave its roots' environments and the gate they give it (../environments.ts).
  // A Terragrunt wave finds its units when it applies, so it takes the strictest gate of every environment, as the apply does.
  const envs = settings.environments;
  const terragruntRun = inputs.some((i) => i.terragrunt !== undefined);
  const envNames = (roots: readonly string[]): string[] => [...new Set(roots.map((r) => environmentOf(r, settings)).filter((e): e is string => e !== undefined))].sort();
  // approval_rules at base: what each wave's approval will take, as the base's config has it.
  const approvalRules = drift ? undefined : await baseApprovalRules(repo, options, env);
  const ruled = <W extends { roots: string[] }>(w: W): W & { approvalRules?: ReportApprovalRule[] } => {
    const rules = quorumRulesFor(approvalRules ?? [], w.roots);
    return rules.length ? { ...w, approvalRules: rules.map((r) => ruleReport(quorumRuleProgress(r, []))) } : w;
  };
  const report = buildReport({
    run: { ...runFacts(repo, env, options.forge ?? settings.forge), stage, binary, runtime: settings.runtime, started, finished: new Date().toISOString(), terragucci: VERSION },
    roots: envs ? inputs.map((i) => withEnvironment(i, environmentOf(i.path, settings))) : inputs,
    waves: envs
      ? costWaves.map((w) => {
          const names = envNames(w.roots);
          return ruled({ ...w, ...(drift ? {} : { policy: terragruntRun ? anyRootGate(settings, settings.gate) : rootsGate(w.roots, settings, settings.gate) }), ...(names.length ? { environments: names } : {}) });
        })
      : costWaves.map(ruled),
    redacted,
    // The waves of a plan say which the gate will hold, and carry the digest approval: pr-review binds a review to.
    ...(drift ? {} : { gate: settings.gate }),
    ...(mockReads?.length ? { mockReads } : {}),
    ...(deferred?.length ? { deferred } : {}),
    ...(policy ? { policy } : {}),
  });
  if (blast) report.blast = blast;
  if (compose) report.compose = compose;
  // Tips are advice: they read the repo and the finished report, and change neither.
  if (settings.tips) {
    const parser = await loadHclParser().catch(() => undefined);
    if (!parser) log("tips: the HCL parser is not installed, so the lint tips are left out (npm i -D @cdktn/hcl2json)");
    const destroying = [...new Set(report.named.filter((n) => n.action === "delete" || n.action === "replace").map((n) => n.root))];
    try {
      const renames = inputs.flatMap((i) => (i.plan && !i.error ? renamesIn(i.path, i.plan) : []));
      const secrets = inputs.flatMap((i) => (i.secrets?.length ? [{ root: i.path, binary: `${i.binary?.name ?? binary}${i.binary?.version ? ` ${i.binary.version}` : ""}`, secrets: i.secrets }] : []));
      report.tips = await repoTips(repo, all, { settings, choudoufuRoots: inputs.filter((i) => basename(i.binary?.name ?? binary) === "choudoufu").map((i) => i.path), ...(parser ? { parser } : {}), destroying, planned: roots.length, ...(configDirs ? { configDirs } : {}), ...(renames.length ? { renames } : {}), ...(secrets.length ? { secrets } : {}), ...(catalogHosts(settings).length ? { releaseCatalogs: { hosts: catalogHosts(settings) } } : {}), env });
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
  if (stage === "tf-plan") await markRecurring(report, reports, env, options.fetch, log);
  const limit = noteLimit(options.forge ?? settings.forge ?? forgeOfEnv(env), report);
  // A drift schedule that stopped cannot say so itself; the plan job, which runs on every pull request, does.
  const notices: string[] = [...selection];
  // agent.token_env without agent.login: nothing excludes the agent's account from approving this change (../involved.ts).
  if (stage === "tf-plan" && !drift) {
    const loosening = await gateLoosening(repo, settings, options, env);
    if (loosening) notices.push(loosening);
  }
  if (stage === "tf-plan" && agentLoginWarning(settings.agent) && report.waves.some((w) => w.waits === true)) notices.push(`The agent's account isn't excluded from approving this change: set agent.login to the login agent.token_env's token acts as.`);
  // Without a token the stage asks as a reader, which only a public repo answers; the note job asks again with its token.
  let leftSchedule: { cron: string; added?: string } | undefined;
  if (!drift && typeof settings.drift === "string") {
    const token = options.token ?? env.TG_TOKEN;
    const forge = options.forge ?? settings.forge;
    const reader = targetFromEnv(forge, env, token, true);
    const late = reader ? await checkDriftSchedule(repo, settings.drift, reader, options.forgeFetch ?? (globalThis.fetch as unknown as Fetch), options.now ?? new Date(), log) : undefined;
    if (late) {
      notices.push(late.message);
      report.overdue = [late];
    }
    if (!token && reader && reader.forge !== "gitlab") {
      const added = pipelineAdded(repo, reader.forge);
      leftSchedule = { cron: settings.drift, ...(added ? { added } : {}) };
    }
  }
  // A waiting wave's command in the note asks for --sign when the repo seals its approvals.
  const sealed = (approvalModeOf(settings.approval) ?? (declaredGates(existsSync(join(repo, "chant.workspace.json")) ? readFileSync(join(repo, "chant.workspace.json"), "utf-8") : undefined) > 0 ? "sealed" : "ledger")) === "sealed";
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
          const open = await prForgeOf(reader, options.forgeFetch ?? (globalThis.fetch as unknown as Fetch)).findIssue(DRIFT_MARKER, { match: "anywhere" });
          if (open?.created) observer.drift = { since: open.created };
        } catch (e) {
          if (!(e instanceof ForgeApiError) && !(e instanceof TypeError)) throw e;
        }
      }
    } else {
      try {
        issue = await trackDrift(prForgeOf(target, options.forgeFetch ?? (globalThis.fetch as unknown as Fetch)), report, issueOptions);
        if (issue.action !== "none") log(`drift issue ${issue.action}: ${issue.issue.url}`);
      } catch (e) {
        if (!(e instanceof ForgeApiError) && !(e instanceof TypeError)) throw e;
        issue = { action: "none", error: e.message };
        log(`the drift issue could not be kept: ${e.message}`);
      }
    }
  }
  observer.pins = modulePins(inputs);
  if (drift) {
    // What happened to the issue, for the jobs after this one (agent.drift runs when this run opened it).
    const kept = issue && "issue" in issue ? { action: issue.action, number: issue.issue.number, url: issue.issue.url } : { action: "none" as const };
    writeFileSync(join(dir, DRIFT_ISSUE_FILE), JSON.stringify(kept) + "\n");
  }
  if (drift && issue && "issue" in issue && issue.action !== "closed") {
    // A newly opened issue was opened by this run, so its drift starts now.
    observer.drift = { since: issue.action === "opened" ? report.run.finished : (issue.issue.created ?? report.run.finished) };
  }
  await observer.finish(report, env, log, options.otlpFetch);
  return { report, dir, ...(uploaded ? { uploaded } : {}), ...(issue ? { issue } : {}), failed: report.roots.some((r) => r.status === "failed" && !r.terragrunt?.provisional) || issue?.error !== undefined };
}

