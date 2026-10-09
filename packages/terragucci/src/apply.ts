/**
 * `terragucci stage tf-apply --wave <k>`: one wave of a repo's apply, run by
 * the pipeline's wave-k job (chant#3049's gated waves, for Terraform and
 * OpenTofu roots, and with `--terragrunt` for a Terragrunt repo's units).
 *
 * The wave plans its roots now, after the waves before it applied, and takes
 * the wave's set digest: chant's `waveSetDigest` over the plan digest of each
 * root whose plan changes something, the digest a pull request's plan note
 * shows for the wave when nothing moved since. The gate policy
 * then decides whether the wave waits:
 *
 *   always      every wave with a change waits for an approval of its digest
 *   on-destroy  a wave waits when one of its plans destroys or replaces
 *   never       no wave waits
 *
 * A waiting wave reads the gate ledger (`_gates/tf-apply.jsonl` on the
 * repo's `chant/lifecycle` branch, the file `chant approve` writes). An
 * approval of this digest lets the wave apply the plans it just made, and
 * nothing else. An approval of another digest means the wave's plans moved
 * after someone approved them: the wave applies nothing and names the roots
 * that moved. With no approval the wave records a pending fact for its digest,
 * so `chant approve tf-apply wave-<k>` has the plan to approve, and stops.
 *
 * Before a wave applies under an approval it records that the approval was
 * used: one line in `_gates/tf-apply/applied.jsonl` naming the gate, the
 * digest and the approval's time. An approval of another digest that a wave
 * has applied is spent: it does not refuse the next plans of that wave, which
 * wait for their own approval. Only an approval of plans no wave applied
 * refuses (decideGate).
 *
 * Which approvals count is the `approval:` mode at base (./approval.ts):
 * under `ledger`, the default, any approval of the digest; under `sealed`,
 * only one made with `chant approve --sign` whose seal verifies against the
 * signers file at base (./seal.ts). Base is the commit before the one being
 * applied.
 *
 * Nothing here records an approval, except that under `approval: pr-review`
 * the wave records the review it counted. A person approves with `chant
 * approve`.
 *
 * A root the policy denies applies only under a recorded override of exactly
 * its plan and rules, by someone `policy.override` at base lists
 * (./override.ts); the wave records the denial an override answers, never the
 * override itself.
 *
 * Once its roots planned, the wave writes its report to `terragucci-report/`
 * (and copies it to the config's `reports` bucket when one is named): the
 * wave's plans, and each root's timings, the plan's and the apply's, from the
 * binary's spans as `stage tf-plan` reads them.
 *
 * A Terragrunt wave (`--terragrunt`) is one dependency layer of the repo's
 * units: the pipeline's wave, split again by the edges `terragrunt find`
 * gives at run time. It plans its units with one
 * `run --all`, saving each plan, and applies the saved plans with one
 * `run --all` once the gate lets it (runTerragruntWave). With `--rest` the job
 * runs its wave and then every wave after it, one by one, each behind its own
 * gate: the pipeline's last job, so a repo that grew a layer since init wrote
 * the pipeline still applies it. The gate, the ledger and the seals are the
 * ones above.
 *
 * Exit codes: 0 applied (or nothing to apply); 1 a root failed; 3 the wave
 * waits for an approval; 4 the wave's plans changed after approval.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeChangedWave, waveSetDigest, type WaveMember } from "@intentius/chant/gated-waves";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import {
  applyTerragruntWave,
  planTerragruntWave,
  TerragruntMockRefusal,
  type TerragruntExec,
} from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { APPROVALS, ConfigError, findConfig, GATES, loadConfig, resolveRepo, type Approval, type Gate, type ResolvedSettings } from "./config";
import { globMatch } from "./detect";
import { buildReport, planFiles } from "./report/build";
import { StageObserver } from "./report/observe";
import { redactPlan } from "./report/redact";
import { storeFromEnv } from "./report/bucket";
import { checkPlans, configAtBase, governingPolicy, type PolicyOptions } from "./report/policy";
import type { ReportPolicy, ReportRootPolicy, ReportWave } from "./report/schema";
import { artifactReportUrl, eachLimited, oneAtATime, reportLinks, rootsParallelism, runFacts, unitTimes, type Turn } from "./report/stage";
import { uploadReport, writeReportDir } from "./report/store";
import { telemetryFromEnv } from "./telemetry";
import { version as VERSION } from "../package.json";
import { approvalRule, type ApprovalRule } from "./approval";
import { decideOverride, OVERRIDE_LEDGER, OVERRIDE_OP, overrideCommand, overrideDigest, type OverridePending } from "./override";
import { approveCommand } from "./report/marker";
import type { Fetch } from "./forge";
import { changesSomething, reviewDigest, reviewWave, type ReviewOutcome } from "./review";
import { sealRefusal } from "./seal";
import type { WaveFacts } from "./report/wave-telemetry";
import { discoverUnits, refineWaves } from "./terragrunt";
import { binaryEnv, terragruntExec } from "./binary-env";

/** The op every wave gate is recorded under. */
export const APPLY_OP = "tf-apply";
/** The gate wave `k` waits on. */
export const waveGate = (wave: number): string => `wave-${wave}`;
/** The approval command a waiting wave prints, bound to the digest it planned, and under `approval: sealed` sealed with the approver's key. */
export const approveLine = (wave: number, digest: string, mode: Approval = "ledger"): string => approveCommand(wave, digest, mode === "sealed");

/** Exit codes of `stage tf-apply`. */
export const EXIT = { applied: 0, failed: 1, waiting: 3, refused: 4 } as const;

/**
 * The waves a plain repo applies in: the canary roots first, then the rest,
 * each in dependency order. A wave is one layer, so no root in a wave reads
 * another's state: every root plans against what the waves before it applied,
 * and the wave's digest covers plans that can all be made before it applies.
 */
export function applyWaves(layers: string[][], canary: readonly string[] = []): string[][] {
  const isCanary = (r: string): boolean => canary.some((g) => globMatch(g, r));
  const first = layers.map((l) => l.filter(isCanary));
  const rest = layers.map((l) => l.filter((r) => !isCanary(r)));
  return [...first, ...rest].filter((l) => l.length > 0);
}

// ── the gate ledger ──────────────────────────────────────────────────────

export interface PendingRecord {
  version: 1;
  kind: "pending";
  op: string;
  gate: string;
  timestamp: string;
  expiresAt: string;
  planDigest?: string;
  description?: string;
  runId?: string;
  url?: string;
  /** terragucci's addition: the commit the wave planned, so an approval can find the run or pull request to resume. */
  commit?: string;
  /** terragucci's addition: each root's plan digest, so a later refusal can name the roots that moved. */
  members?: WaveMember[];
  /**
   * The gate is never resolved over MCP or ACP (chant#3485). tf-apply is no
   * Op chant can discover, so the record carries the rule: `op-approve`
   * refuses the gate whichever channel reached it.
   */
  neverOverMcp?: true;
}

export interface ResolutionRecord {
  version: 1;
  kind?: "resolution";
  op: string;
  gate: string;
  resolvedBy: string;
  timestamp: string;
  planDigest?: string;
  /** The fields below are what a seal covers or is (chant#3163). */
  environment?: string;
  relayedBy?: string;
  seal?: { signer?: unknown; key?: unknown; signature?: unknown } | null;
  /** `chant approve --note`: the reason a policy override gives. */
  note?: string;
  /** Set when the apply job recorded the approval from a pull request's review (`approval: pr-review`). */
  via?: "pr-review";
  pr?: number;
  head?: string;
  reviewers?: string[];
}

/**
 * What a wave writes before it applies under an approval, in
 * `_gates/<op>/applied.jsonl` beside the ledger: the approval of
 * `planDigest`, made at `approvedAt`, was used. chant reads only the
 * `.jsonl` files directly under `_gates/`, so it never sees these lines.
 */
export interface AppliedRecord {
  version: 1;
  kind: "applied";
  op: string;
  gate: string;
  planDigest: string;
  /** The approval's own timestamp, as the ledger holds it: every approval of this digest at or before it is spent. */
  approvedAt: string;
  approvedBy: string;
  timestamp: string;
  runId?: string;
  commit?: string;
}

export interface GateLedger {
  pending: PendingRecord[];
  resolutions: ResolutionRecord[];
  /** The approvals a wave applied under; absent reads as none. */
  applied?: AppliedRecord[];
}

/** The lines of an `applied.jsonl` file. Malformed lines are skipped. */
export function parseApplied(text: string): AppliedRecord[] {
  const out: AppliedRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.version === 1 && r.kind === "applied" && typeof r.gate === "string" && typeof r.planDigest === "string" && typeof r.approvedAt === "string") out.push(r as unknown as AppliedRecord);
    } catch {
      continue;
    }
  }
  return out;
}

/** The lines of a `_gates/<op>.jsonl` file, as chant's `parseGateLedger` reads them. Malformed lines are skipped. */
export function parseLedger(text: string): GateLedger {
  const out: GateLedger = { pending: [], resolutions: [] };
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.version !== 1 || typeof r.op !== "string" || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
    if (r.planDigest !== undefined && typeof r.planDigest !== "string") continue;
    if (r.kind === "pending") {
      if (typeof r.expiresAt === "string") out.pending.push(r as unknown as PendingRecord);
    } else if (typeof r.resolvedBy === "string") {
      out.resolutions.push(r as unknown as ResolutionRecord);
    }
  }
  return out;
}

const at = (iso: string): number => new Date(iso).getTime();

export type GateDecision =
  /** `at` is the approval's timestamp, which the applied record names. */
  | { status: "approved"; by: string; at: string }
  /**
   * `standing` is set when a pending fact for this digest already stands, so
   * nothing new is recorded. `spent` names the newest approval of another
   * digest that a wave applied under, which therefore does not refuse.
   */
  | { status: "waiting"; standing?: PendingRecord; spent?: { approved: string; by: string } }
  /** An approval stands for another digest. `standing` as for waiting. */
  | { status: "refused"; approved: string | undefined; by: string; standing?: PendingRecord };

/**
 * Decide one wave's gate against the ledger, the rule chant's `evaluateGate`
 * applies to a plan-bound gate: an approval counts only when it is newer than
 * the newest pending fact for the gate and names this digest. The newest
 * approval for another digest is the changed-set refusal, unless it is spent:
 * a wave applied under an approval of that digest made at or after it (the
 * ledger's `applied` records). A spent approval approves nothing new and
 * refuses nothing; the wave waits for an approval of its own digest.
 */
export function decideGate(ledger: GateLedger, gate: string, digest: string, now: string): GateDecision {
  let latest: PendingRecord | undefined;
  for (const p of ledger.pending) if (p.gate === gate && (!latest || at(p.timestamp) >= at(latest.timestamp))) latest = p;
  const since = latest ? at(latest.timestamp) : 0;
  const spent = (r: ResolutionRecord): boolean =>
    r.planDigest !== undefined && (ledger.applied ?? []).some((a) => a.gate === gate && samePlanDigest(a.planDigest, r.planDigest) && at(a.approvedAt) >= at(r.timestamp));
  let matched: ResolutionRecord | undefined;
  let mismatched: ResolutionRecord | undefined;
  let used: ResolutionRecord | undefined;
  for (const r of ledger.resolutions) {
    if (r.gate !== gate || at(r.timestamp) < since) continue;
    if (samePlanDigest(r.planDigest, digest)) {
      if (!matched || at(r.timestamp) >= at(matched.timestamp)) matched = r;
    } else if (spent(r)) {
      if (!used || at(r.timestamp) >= at(used.timestamp)) used = r;
    } else if (!mismatched || at(r.timestamp) >= at(mismatched.timestamp)) {
      mismatched = r;
    }
  }
  if (matched) return { status: "approved", by: matched.resolvedBy, at: matched.timestamp };
  const standing = latest && at(latest.expiresAt) > at(now) && samePlanDigest(latest.planDigest, digest) ? latest : undefined;
  if (mismatched) return { status: "refused", approved: mismatched.planDigest, by: mismatched.resolvedBy, ...(standing ? { standing } : {}) };
  return { status: "waiting", ...(standing ? { standing } : {}), ...(used ? { spent: { approved: used.planDigest!, by: used.resolvedBy } } : {}) };
}

/** The roots whose plan digest differs between the approved members and the ones planned now. */
export function movedMembers(approved: readonly WaveMember[], now: readonly WaveMember[]): string[] {
  const before = new Map(approved.map((m) => [m.member, m.planDigest]));
  const after = new Map(now.map((m) => [m.member, m.planDigest]));
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

const LIFECYCLE = "chant/lifecycle";
const REMOTE_REF = `refs/remotes/origin/${LIFECYCLE}`;
const LEDGER_PATH = `_gates/${APPLY_OP}.jsonl`;
/** Where the waves record each approval they applied under: beside the reports, out of chant's sight. */
export const APPLIED_PATH = `_gates/${APPLY_OP}/applied.jsonl`;
const GIT_ID = { GIT_AUTHOR_NAME: "terragucci", GIT_AUTHOR_EMAIL: "terragucci@localhost", GIT_COMMITTER_NAME: "terragucci", GIT_COMMITTER_EMAIL: "terragucci@localhost" };

function git(repo: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf-8", input, env });
}

/** Fetch `chant/lifecycle`. False when the remote has no such branch yet; throws when the remote cannot be read. */
function fetchLifecycle(repo: string): boolean {
  const heads = git(repo, ["ls-remote", "--heads", "origin", LIFECYCLE]);
  if (heads.status !== 0) throw new ConfigError(`cannot read ${LIFECYCLE} from origin, so the gate cannot be decided: ${heads.stderr.trim()}`);
  if (!heads.stdout.trim()) return false;
  const f = git(repo, ["fetch", "-q", "origin", `+refs/heads/${LIFECYCLE}:${REMOTE_REF}`]);
  if (f.status !== 0) throw new ConfigError(`cannot fetch ${LIFECYCLE}, so the gate cannot be decided: ${f.stderr.trim()}`);
  return true;
}

/** The gate ledger as `chant/lifecycle` on origin holds it now: the waves' gates, or with `path` another op's file. */
export function readLedger(repo: string, path: string = LEDGER_PATH): GateLedger {
  if (!fetchLifecycle(repo)) return { pending: [], resolutions: [] };
  const show = git(repo, ["show", `${REMOTE_REF}:${path}`]);
  const ledger = parseLedger(show.status === 0 ? show.stdout : "");
  if (path !== LEDGER_PATH) return ledger;
  const applied = git(repo, ["show", `${REMOTE_REF}:${APPLIED_PATH}`]);
  return { ...ledger, applied: parseApplied(applied.status === 0 ? applied.stdout : "") };
}

/**
 * Where a waiting wave keeps the report of the plans it asked approval for,
 * next to the ledger, so a later run refused for another digest can say what
 * moved since. Sensitive values are never in it: the plan's change set does
 * not carry them.
 */
export const approvedPath = (wave: number, digest: string): string => `_gates/${APPLY_OP}/${waveGate(wave)}/${digest.replace(":", "_")}.json`;

/** The report a waiting wave kept for `digest` on chant/lifecycle, as last fetched; undefined when it kept none. */
export function storedReport(repo: string, wave: number, digest: string): string | undefined {
  const show = git(repo, ["show", `${REMOTE_REF}:${approvedPath(wave, digest)}`]);
  return show.status === 0 ? show.stdout : undefined;
}

/** Append a pending fact to the ledger and push it, with any `files` beside it, retrying when another writer moved the branch. */
export function appendPending(repo: string, record: PendingRecord, files: Record<string, string> = {}, path: string = LEDGER_PATH): void {
  appendRecord(repo, record, files, `Pending gate record: ${record.op} ${record.gate}`, path);
}

/** Append one line to the ledger (`path`, the waves' file by default) and push it, as appendPending does. */
function appendRecord(repo: string, record: PendingRecord | ResolutionRecord | AppliedRecord, files: Record<string, string>, message: string, path: string = LEDGER_PATH): void {
  const line = JSON.stringify(record);
  for (let attempt = 0; attempt < 5; attempt++) {
    const exists = fetchLifecycle(repo);
    const parent = exists ? git(repo, ["rev-parse", REMOTE_REF]).stdout.trim() : "";
    const old = exists ? git(repo, ["show", `${REMOTE_REF}:${path}`]) : undefined;
    // One record per line, each ending in a newline, so a line appended with `>>` stays its own record.
    const text = `${old && old.status === 0 && old.stdout.trim() ? `${old.stdout.replace(/\n$/, "")}\n` : ""}${line}\n`;
    const blob = git(repo, ["hash-object", "-w", "--stdin"], text).stdout.trim();
    // A scratch index, so the checkout's own index is left alone.
    const scratch = mkdtempSync(join(tmpdir(), "terragucci-ledger-"));
    const env = { ...process.env, ...GIT_ID, GIT_INDEX_FILE: join(scratch, "index") };
    if (parent) git(repo, ["read-tree", parent], undefined, env);
    for (const [file, b] of [[path, blob], ...Object.entries(files).map(([f, t]) => [f, git(repo, ["hash-object", "-w", "--stdin"], t).stdout.trim()])])
      git(repo, ["update-index", "--add", "--cacheinfo", `100644,${b},${file}`], undefined, env);
    const tree = git(repo, ["write-tree"], undefined, env).stdout.trim();
    const commit = git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], undefined, env).stdout.trim();
    rmSync(scratch, { recursive: true, force: true });
    if (!commit) throw new ConfigError(`could not write the gate record (${message})`);
    const push = git(repo, ["push", "-q", "origin", `${commit}:refs/heads/${LIFECYCLE}`]);
    if (push.status === 0) return;
  }
  throw new ConfigError(`could not push the gate record (${message}) to ${LIFECYCLE}; check that the job may push to it`);
}

// ── planning and applying ────────────────────────────────────────────────

interface Run {
  code: number;
  out: string;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: binaryEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ code: 127, out: `${out}${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

type RootTiming = ReturnType<StageObserver["root"]>;

/** `run` as the stage observer times it: a span of its own, and the binary's spans collected for the root. */
function timed(observer: StageObserver, t: RootTiming, binary: string, args: string[], env: NodeJS.ProcessEnv, dir: string): Promise<Run> {
  return observer
    .commandAsync(t, binary, args, env, (e) => run(binary, [`-chdir=${dir}`, ...args], e).then((r) => ({ ...r, status: r.code })))
    .then(({ code, out }) => ({ code, out }));
}

interface PlannedRoot {
  root: string;
  timing: RootTiming;
  planFile: string;
  env: NodeJS.ProcessEnv;
  member?: WaveMember;
  plan?: unknown;
  changes: number;
  destroys: number;
  summary: string;
  error?: string;
  /** The policy's verdict on its plan, when `policy` is on. */
  policy?: ReportRootPolicy;
}

/** How long a plan or an apply waits for a state lock unless the job set a `-lock-timeout` of its own. */
export const DEFAULT_LOCK_TIMEOUT = "5m";

/** The `-lock-timeout` flag to add: none when `TF_CLI_ARGS` or `TF_CLI_ARGS_<command>` already names one. */
export function lockTimeoutArgs(command: "plan" | "apply", env: NodeJS.ProcessEnv = process.env): string[] {
  const set = `${env.TF_CLI_ARGS ?? ""} ${env[`TF_CLI_ARGS_${command}`] ?? ""}`;
  return /(^|\s)-{1,2}lock-timeout[=\s]/.test(set) ? [] : [`-lock-timeout=${DEFAULT_LOCK_TIMEOUT}`];
}

const indent = (s: string): string => s.trim().split("\n").map((l) => `    ${l}`).join("\n");

/** The provider cache a wave's roots share, and the turns their inits take in it. */
interface WaveCache {
  dir: string;
  initTurn: Turn;
}

/**
 * The wave's roots share one provider cache: the job's `TF_PLUGIN_CACHE_DIR`,
 * or one of the wave's own. The cache is not safe for inits that run
 * together, so they take turns. A cache per root would download and unpack
 * each provider once per root, some 700 MB for the AWS provider, which a wave
 * of a hundred roots cannot hold on a runner's disk.
 */
function waveCache(work: string, env: NodeJS.ProcessEnv): WaveCache {
  return { dir: env.TF_PLUGIN_CACHE_DIR || mkdtempSync(join(work, "cache-")), initTurn: oneAtATime() };
}

async function planRoot(repo: string, binary: string, root: string, work: string, i: number, observer: StageObserver, cache: WaveCache): Promise<PlannedRoot> {
  const timing = observer.root(root);
  try {
    return await planTimed(repo, binary, root, work, i, observer, timing, cache);
  } finally {
    observer.endRoot(timing);
  }
}

async function planTimed(repo: string, binary: string, root: string, work: string, i: number, observer: StageObserver, timing: RootTiming, cache: WaveCache): Promise<PlannedRoot> {
  const dir = join(repo, root);
  const env = { ...process.env, TF_PLUGIN_CACHE_DIR: cache.dir };
  const planFile = join(work, `${i}.tfplan`);
  const base = { root, timing, planFile, env, changes: 0, destroys: 0, summary: "" };
  const init = await cache.initTurn(() => timed(observer, timing, binary, ["init", "-input=false", "-no-color"], env, dir));
  if (init.code !== 0) return { ...base, error: `init failed\n${init.out}` };
  const plan = await timed(observer, timing, binary, ["plan", "-input=false", "-no-color", ...lockTimeoutArgs("plan", env), `-out=${planFile}`], env, dir);
  if (plan.code !== 0) return { ...base, error: `plan failed\n${plan.out}` };
  const show = spawnSync(binary, [`-chdir=${dir}`, "show", "-json", planFile], { encoding: "utf-8", env: binaryEnv(env), maxBuffer: 512 * 1024 * 1024 });
  let json: unknown;
  try {
    json = JSON.parse(show.stdout);
  } catch {
    return { ...base, error: `show -json printed no plan\n${show.stderr || show.stdout}` };
  }
  const part = terraformChangeSetPart({ member: root, plan: json, planner: plannerForBinary(binary) });
  const changed = part.entries.filter((e) => e.action !== "no-op" && e.action !== "read");
  return {
    ...base,
    member: { member: root, planDigest: part.member.planDigest ?? "" },
    plan: json,
    changes: changed.length,
    destroys: changed.filter((e) => e.action === "delete" || e.action === "replace").length,
    summary: plan.out.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned",
  };
}

async function applyRoot(repo: string, binary: string, p: PlannedRoot, observer: StageObserver): Promise<boolean> {
  observer.reopen(p.timing);
  let r: Run;
  try {
    r = await timed(observer, p.timing, binary, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", p.env), p.planFile], p.env, join(repo, p.root));
  } finally {
    observer.endRoot(p.timing);
  }
  if (r.code === 0) {
    console.log(`applied ${p.root}: ${[...r.out.matchAll(/Resources: .*destroyed/g)].pop()?.[0] ?? "done"}`);
    return true;
  }
  console.log(`FAILED ${p.root}`);
  console.log(indent(r.out));
  return false;
}

export interface ApplyWaveOptions {
  wave: number;
  layers: string[][];
  canary?: string[];
  binary: string;
  gate: Gate;
  /** The pipeline's `--approval`: the mode when the config at base names none and no gate is sealed there. */
  approval?: Approval;
  env?: NodeJS.ProcessEnv;
  now?: string;
  /** How many roots of the wave plan at once. Default: the config's `parallelism`, then from the state backend. */
  parallelism?: number;
  /** The config file; default: the one found from the repo. */
  config?: string;
  /** The ref the policy is read from (default: TG_BASE, then the checkout), and, when set, the gate rule and signers (default: the commit before the one applied) and every other setting the wave reads (default: the checkout's config). */
  base?: string;
  /** With `policy:` set: how the engine runs and is fetched. Default: the real thing. */
  policy?: PolicyOptions;
  /** A Terragrunt repo: the waves are its units' dependency layers, from `terragrunt find` now; the layers only say how many the pipeline has jobs for. */
  terragrunt?: boolean;
  /** Terragrunt only: run this wave, then every wave after it, stopping at the first that does not apply. */
  rest?: boolean;
  /** The `terragrunt` executable. Default: `TERRAGUCCI_TERRAGRUNT`, then `terragrunt` on the path. */
  terragruntPath?: string;
  terragruntExec?: TerragruntExec;
  /** The forge API calls of `approval: pr-review`. Default: fetch. */
  fetch?: Fetch;
}

/** Run one wave, or with `rest` a Terragrunt repo's wave and the waves after it. Returns the exit code; what happened is printed. */
export async function applyWave(repo: string, options: ApplyWaveOptions): Promise<number> {
  if (!options.rest) return (await applyOneWave(repo, options)).code;
  if (!options.terragrunt) throw new ConfigError("--rest runs the waves of a Terragrunt repo, so it needs --terragrunt");
  for (let k = options.wave; ; k++) {
    const { code, count } = await applyOneWave(repo, { ...options, wave: k, rest: false });
    if (code !== EXIT.applied || count === undefined || k >= count) return code;
  }
}

async function applyOneWave(repo: string, options: ApplyWaveOptions): Promise<{ code: number; count?: number }> {
  const work = mkdtempSync(join(tmpdir(), "terragucci-apply-"));
  const env = options.env ?? process.env;
  const observer = new StageObserver(telemetryFromEnv(env), APPLY_OP, env);
  // How the wave ended, for its stage span and the waves dashboard's gauges.
  const facts: WaveFacts = {};
  observer.wave = { number: options.wave, facts };
  const wave: WaveRun = { observer };
  let code: number | undefined;
  try {
    code = await runWave(repo, options, work, wave, facts);
    observer.wave.code = code;
    return { code, ...(wave.count !== undefined ? { count: wave.count } : {}) };
  } finally {
    if (code !== undefined) writeOutcomeJson(env, options.wave, code, wave);
    // The report is written once the wave's roots planned, whatever came of the gate and the apply.
    if (wave.planned) await writeWaveReport(repo, options, wave as Required<WaveRun>, env).catch((e) => console.log(`wave ${options.wave}: the report was not written: ${(e as Error).message}`));
    rmSync(work, { recursive: true, force: true });
  }
}

/** What a wave run leaves for its report. */
interface WaveRun {
  observer: StageObserver;
  /** The settings the wave runs with (waveSettings), for its report. */
  settings?: ResolvedSettings;
  /** How many waves the repo has, once a Terragrunt wave cut them. */
  count?: number;
  planned?: WavePlan[];
  roots?: string[];
  started?: string;
  /** The wave's policy check, when `policy` is on. */
  policy?: ReportPolicy;
  /** The wave's gate state and the ledger that holds its record, as the report's wave row shows them. */
  approval?: ReportWave["approval"];
  gate?: ReportWave["gate"];
  /** The digest the gate decided, which the report shows as the wave's set digest. */
  digest?: string;
  /** Why the wave applied nothing although it planned, as the report's wave row shows it. */
  refused?: ReportWave["refused"];
  /** When a waiting wave began waiting for an approval of its digest. */
  waitingSince?: string;
  /** Under `approval: pr-review`, the pull request whose review would approve the waiting wave. */
  review?: ReportWave["review"];
  /** The approval mode in force at the wave's gate. */
  mode?: Approval;
  /** The command that approves the wave's digest, when it waits or its plans moved after an approval or a review. */
  command?: string;
  /** The `TG_OUTCOME` line, when the wave wrote one. */
  line?: string;
  /** The roots whose apply failed. */
  failed?: string[];
}

/**
 * The wave's report: its roots' plans (redacted), the wave, and each root's
 * timings, plan and apply. Written to `terragucci-report/` beside anything a
 * refused wave put there, and copied to the `reports` bucket when the config
 * names one. A copy that fails is logged; it never fails the wave.
 */
async function writeWaveReport(repo: string, options: ApplyWaveOptions, w: Required<WaveRun>, env: NodeJS.ProcessEnv): Promise<void> {
  const { wave, binary } = options;
  const settings = w.settings;
  const plans = new Map<string, { json?: string }>();
  let redacted = 0;
  for (const p of w.planned) {
    if (p.plan === undefined) continue;
    const safe = redactPlan(p.plan);
    redacted += safe.values;
    plans.set(p.root, { json: JSON.stringify(safe.plan, null, 2) + "\n" });
  }
  const report = buildReport({
    run: { ...runFacts(repo, env, settings.forge), stage: APPLY_OP, wave, binary, runtime: settings.runtime, started: w.started, finished: new Date().toISOString(), terragucci: VERSION },
    roots: w.planned.map((p) => {
      const policy = p.policy ? { policy: p.policy } : {};
      // A root the policy refused keeps its plan, so the report shows what it would have changed.
      if (p.error && !(p.policy && p.policy.result !== "passed" && p.plan !== undefined)) return { path: p.root, planner: plannerForBinary(binary), error: p.error.split("\n")[0], ...policy };
      return { path: p.root, plan: p.plan, planner: plannerForBinary(binary), files: { json: planFiles(p.root).json }, ...(p.error ? { error: p.error } : {}), ...policy };
    }),
    waves: [{ number: wave, roots: w.roots, ...(w.digest ? { setDigest: w.digest } : {}), ...(w.approval ? { approval: w.approval } : {}), ...(w.gate ? { gate: w.gate } : {}), ...(w.waitingSince ? { waitingSince: w.waitingSince } : {}), ...(w.refused ? { refused: w.refused } : {}), ...(w.review ? { review: w.review } : {}) }],
    redacted,
    ...(w.policy ? { policy: w.policy } : {}),
  });
  w.observer.addTimings(report, ["plan", "apply"]);
  const dir = join(repo, "terragucci-report");
  // An absolute address, as the plan report has: the bucket's copy once reports.url says where the bucket is served, else the job's artifact.
  const given = artifactReportUrl(env);
  const links = reportLinks(report, { reports: settings.reports, ...(given ? { given } : {}), traceId: w.observer.trace?.traceId, traceUrl: settings.telemetry?.trace_url });
  Object.assign(report.run, links.run);
  w.observer.reportUrl = links.run.report_url;
  writeReportDir(dir, report, plans, links.note);
  const slowest = report.timings?.roots[0];
  if (slowest) console.log(`wave ${wave}: report in terragucci-report/, slowest root ${slowest.root} (${slowest.seconds}s)`);
  if (settings.reports?.bucket) {
    try {
      const up = await uploadReport(storeFromEnv(settings.reports, env), dir, report, settings.reports.prefix);
      console.log(`wave ${wave}: report copied to ${up.prefix}${report.run.report_url ? `, at ${report.run.report_url}` : ""}`);
    } catch (e) {
      console.log(`wave ${wave}: the report was not copied to ${settings.reports.bucket}: ${(e as Error).message}`);
    }
  }
  await w.observer.finish(report, env, (l) => console.log(l));
}

/**
 * The settings a wave runs with. Without a base, the checkout's config. With
 * one (a pull request applied before it merges), the config at the base:
 * reports, telemetry, parallelism and every other key come from the default
 * branch, so the pull request's own edits to its config take effect once it
 * merges. The `policy:` key stays the checkout's here because policyGate
 * reads it through governingPolicy, which takes the base's key and keeps the
 * checkout's only where the base has none. A base whose config cannot be read
 * fails the wave.
 */
async function waveSettings(repo: string, options: ApplyWaveOptions, configPath: string | undefined): Promise<{ settings: ResolvedSettings } | { error: string }> {
  const checkout = resolveRepo(configPath ? await loadConfig(configPath) : {});
  if (!options.base) return { settings: checkout };
  const read = await configAtBase(repo, options.base, configPath ? { config: configPath } : {});
  if ("error" in read) return { error: `the settings are read from ${options.base} and its config could not be read (${read.error})` };
  let atBase: ResolvedSettings;
  try {
    atBase = resolveRepo(read.config);
  } catch (e) {
    return { error: `the settings are read from ${options.base} and its config could not be read (${(e as Error).message})` };
  }
  const { policy: _policy, ...rest } = atBase;
  return { settings: { ...rest, ...(checkout.policy ? { policy: checkout.policy } : {}) } };
}

async function runWave(repo: string, options: ApplyWaveOptions, work: string, w: WaveRun, facts: WaveFacts = {}): Promise<number> {
  const { wave, binary, gate } = options;
  if (!GATES.includes(gate)) throw new ConfigError(`--gate must be one of ${GATES.join(", ")}`);
  if (options.approval !== undefined && !APPROVALS.includes(options.approval)) throw new ConfigError(`--approval must be one of ${APPROVALS.join(", ")}`);
  if (!Number.isInteger(wave) || wave < 1) throw new ConfigError("--wave must be a wave number from 1");
  if (options.terragrunt) return runTerragruntWave(repo, options, work, w, facts);
  const waves = applyWaves(options.layers, options.canary);
  const roots = waves[wave - 1];
  if (!roots) {
    facts.nothing = true;
    console.log(`wave ${wave}: this repo has ${waves.length} waves, so there is nothing to apply`);
    return EXIT.applied;
  }
  facts.roots = roots;
  const label = `wave ${wave} of ${waves.length}`;
  console.log(`${label}: planning ${roots.join(", ")}`);
  const configPath = options.config ?? findConfig(repo);
  const read = await waveSettings(repo, options, configPath);
  if ("error" in read) {
    console.log(`${label}: ${read.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const settings = (w.settings = read.settings);
  let limit: { value: number; reason: string };
  if (options.parallelism !== undefined) {
    limit = { value: options.parallelism, reason: "--parallelism" };
  } else {
    limit = rootsParallelism(repo, roots, settings, options.env ?? process.env);
  }
  if (roots.length > 1) console.log(`${label}: planning ${limit.value === 1 ? "one root at a time" : `up to ${limit.value} roots at once`} (${limit.reason})`);
  const planned: PlannedRoot[] = new Array(roots.length);
  w.started = new Date().toISOString();
  await w.observer.collectSpans((l) => console.log(l));
  const cache = waveCache(work, process.env);
  await eachLimited(roots, limit.value, async (r, i) => {
    planned[i] = await planRoot(repo, binary, r, work, i, w.observer, cache);
  });
  w.planned = planned;
  w.roots = roots;
  const failed = planned.filter((p) => p.error);
  for (const p of planned) console.log(p.error ? `FAILED ${p.root}: ${p.error.split("\n")[0]}` : `${p.root}: ${p.summary}`);
  if (failed.length > 0) {
    for (const p of failed) console.log(indent(p.error!));
    console.log(`${label}: ${failed.length} root${failed.length === 1 ? "" : "s"} failed to plan, so nothing in it was applied`);
    return EXIT.failed;
  }
  const refusedByPolicy = await policyGate(repo, options, { label, settings, configPath }, planned, w);
  if (refusedByPolicy !== undefined) return refusedByPolicy;
  // The set digest covers the roots whose plan changes something, as a Terragrunt wave's and the plan note's do, so the digest a
  // pull request's note shows is the one this wave asks approval for when nothing moved.
  const all = planned.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1));
  const changing = new Set(planned.filter((p) => changesSomething(p.plan)).map((p) => p.root));
  const members = all.filter((m) => changing.has(m.member));
  const digest = waveSetDigest(members.length > 0 ? members : all);
  const changes = planned.reduce((n, p) => n + p.changes, 0);
  const destroys = planned.reduce((n, p) => n + p.destroys, 0);
  console.log(`${label}: set digest ${digest}, ${changes} change${changes === 1 ? "" : "s"}, ${destroys} destroy${destroys === 1 ? "" : "s"}`);

  if (changes === 0) facts.nothing = true;
  const held = await gateWave(repo, options, { label, roots, planned, members, digest, changes, destroys }, facts, w);
  if (held !== undefined) return held;

  // The roots of a wave do not read each other, so they apply together, as many at once as plan at once: each apply
  // starts its own provider, and a wave of a hundred roots started together runs the job out of memory.
  const ok: boolean[] = new Array(planned.length);
  await eachLimited(planned, limit.value, async (p, i) => {
    ok[i] = await applyRoot(repo, binary, p, w.observer);
  });
  if (ok.includes(false)) {
    w.failed = planned.filter((_, i) => !ok[i]).map((p) => p.root);
    console.log(`${label}: an apply failed`);
    return EXIT.failed;
  }
  console.log(`${label} applied`);
  return EXIT.applied;
}

/** What the policy and the gate read of a wave's plans: a plain root's, or a Terragrunt unit's. */
type WavePlan = Pick<PlannedRoot, "root" | "plan" | "member" | "error" | "policy">;

/**
 * Run the policy over a wave's plans, when `policy` is on. Returns the exit
 * code when the policy refused a root or could not check it, so nothing in
 * the wave applies and no approval is waited for; undefined to go on.
 */
async function policyGate(
  repo: string,
  options: ApplyWaveOptions,
  ctx: { label: string; settings: ReturnType<typeof resolveRepo>; configPath: string | undefined },
  planned: WavePlan[],
  w: WaveRun,
): Promise<number | undefined> {
  const { wave } = options;
  const { label, settings, configPath } = ctx;
  // Policy is opt-in. A wave whose plans the policy denies, or that it cannot check, applies nothing and records no approval to wait for.
  // With a base, the base's policy key decides whether it runs, as in tf-plan.
  const policyEnv = options.env ?? process.env;
  const policyBaseRef = options.base ?? (policyEnv.TG_BASE || undefined);
  const governing = await governingPolicy(repo, settings.policy, policyBaseRef, configPath ? { config: configPath } : {});
  if (governing.note) console.log(governing.note);
  if (governing.policy) {
    const runAt = runFacts(repo, policyEnv, settings.forge);
    const found = await checkPlans(repo, governing.policy, planned.map((p) => ({ path: p.root, plan: p.plan })), policyBaseRef, governing.trust, options.policy ?? {}, (l) => console.log(l), { stage: "tf-apply", project: runAt.project, commit: runAt.commit });
    const denied = found.failed;
    w.policy = found.policy;
    for (const p of planned) {
      const verdict = found.roots.get(p.root);
      if (verdict) p.policy = verdict;
    }
    // An override is looked up only when the policy key in force names who may write one; the list that counts is the one at base.
    const moved = denied.size > 0 && !!governing.policy.override?.length && (await overrideDenials(repo, options, label, planned, denied, w));
    if (denied.size > 0) {
      for (const p of planned) {
        const error = denied.get(p.root);
        if (error === undefined) continue;
        p.error = error;
        console.log(`FAILED ${p.root}: ${error.split("\n")[0]}`);
        console.log(indent(error));
      }
      console.log(`${label}: policy refused ${denied.size} root${denied.size === 1 ? "" : "s"}, so nothing in it was applied`);
      const roots = [...denied.keys()].sort();
      w.refused = { reason: moved ? "override" : "policy", roots };
      if (moved) {
        writeOutcome(options.env, `wave ${wave} changed after its policy override: ${[...denied.keys()].join(", ")}`, w);
        return EXIT.refused;
      }
      writeOutcome(options.env, `wave ${wave} refused by policy: ${[...denied.keys()].join(", ")}`, w);
      return EXIT.failed;
    }
  }
  return undefined;
}

/**
 * Look up an override for each root the policy denied, when `policy.override`
 * in the config at base names who may write one (./override.ts). An
 * overridden root leaves `denied` and carries its override; a denied root
 * with none gets a pending fact for its plan and rules, and the command that
 * overrides it. A root the policy could not check is never overridden.
 * Returns true when, for a root still denied, an override stands for an
 * earlier plan or other rules: the changed-wave refusal.
 */
async function overrideDenials(repo: string, options: ApplyWaveOptions, label: string, planned: WavePlan[], denied: Map<string, string>, w: WaveRun): Promise<boolean> {
  const overridable = planned.filter((p) => denied.has(p.root) && p.policy?.result === "denied" && p.member?.planDigest);
  if (overridable.length === 0) return false;
  const configPath = options.config ?? findConfig(repo);
  let rule: ApprovalRule;
  let ledger: GateLedger;
  try {
    rule = await approvalRule(repo, { ...(options.base ? { at: options.base } : {}), ...(configPath ? { config: configPath } : {}), ...(options.approval ? { flag: options.approval } : {}) });
    if (rule.overriders.length === 0) return false;
    ledger = readLedger(repo, OVERRIDE_LEDGER);
  } catch (e) {
    console.log(`${label}: policy override: ${(e as Error).message}, so no override counts`);
    return false;
  }
  if (w.policy) w.policy.overriders = rule.overriders;
  const now = options.now ?? new Date().toISOString();
  const env = options.env ?? process.env;
  let moved = false;
  const overridden: string[] = [];
  for (const p of overridable) {
    const rules = p.policy!.rules ?? [];
    const planDigest = p.member!.planDigest;
    const decision = decideOverride(ledger, rule, p.root, planDigest, rules, now);
    if (decision.status === "overridden") {
      const o = decision.override;
      p.policy = { ...p.policy!, override: o };
      denied.delete(p.root);
      overridden.push(p.root);
      console.log(`${p.root}: the policy denial (${o.rules.join(", ")}) is overridden by ${o.by} at ${o.at}${o.sealed ? ", sealed" : ""}: ${o.reason}`);
      continue;
    }
    for (const why of decision.refusals) console.log(`${p.root}: an override does not count: ${why}`);
    const digest = overrideDigest(p.root, planDigest, rules);
    if (decision.status === "moved") {
      moved = true;
      console.log(`${p.root}: ${decision.by} overrode an earlier plan or other rules (${decision.was ?? "no digest"}); this plan and its rules give ${digest}, so that override counts for nothing`);
    }
    if (!decision.standing) {
      const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
      const pending: OverridePending = {
        version: 1,
        kind: "pending",
        op: OVERRIDE_OP,
        gate: p.root,
        timestamp: now,
        expiresAt: new Date(at(now) + 48 * 3600 * 1000).toISOString(),
        planDigest: digest,
        description: `${p.root}: plan ${planDigest} denied by ${rules.join(", ")}`,
        ...(runId ? { runId } : {}),
        members: [p.member!],
        rules,
        neverOverMcp: true,
      };
      try {
        appendPending(repo, pending, {}, OVERRIDE_LEDGER);
      } catch (e) {
        console.log(`${p.root}: the denial was not recorded for an override: ${(e as Error).message}`);
      }
    }
    console.log(`${p.root}: policy.override at base lists ${rule.overriders.join(", ")}; one of them can let this plan through with:`);
    console.log(`  ${overrideCommand(p.root, rules, rule.mode === "sealed")}`);
  }
  if (overridden.length > 0 && w.policy) w.policy.overridden = overridden.sort();
  return moved;
}

/**
 * Decide a wave's gate for the plans it just made. Returns the exit code
 * when the wave waits (3) or its plans changed after the approval (4);
 * undefined when it applies.
 */
async function gateWave(
  repo: string,
  options: ApplyWaveOptions,
  ctx: { label: string; roots: string[]; planned: WavePlan[]; members: WaveMember[]; digest: string; changes: number; destroys: number },
  facts: WaveFacts,
  w: WaveRun,
): Promise<number | undefined> {
  const { wave, binary, gate } = options;
  const { label, roots, planned, members, digest, changes, destroys } = ctx;
  let mode: Approval = "ledger";
  // A wave with nothing to change has nothing to approve.
  const gated = changes > 0 && (gate === "always" || (gate === "on-destroy" && destroys > 0));
  w.approval = gated ? "waiting" : "not-required";
  w.digest = digest;
  if (gated) {
    w.gate = { branch: LIFECYCLE, path: LEDGER_PATH };
    const name = waveGate(wave);
    const now = options.now ?? new Date().toISOString();
    const ledger = readLedger(repo);
    // A pull request applied before it merges names its base (apply.when: pull-request): the rule is the default branch's, never the pull request's own.
    const configPath = options.config ?? findConfig(repo);
    const rule = await approvalRule(repo, { ...(options.base ? { at: options.base } : {}), ...(configPath ? { config: configPath } : {}), ...(options.approval ? { flag: options.approval } : {}) });
    console.log(`${label}: approval ${rule.mode} (${rule.source})`);
    if (rule.note) console.log(`${label}: note: ${rule.note}`);
    mode = rule.mode;
    w.mode = mode;
    // Under sealed every wave gate needs a seal: a wave added after init is never left open.
    if (rule.mode === "sealed") {
      if (rule.gates.size > 0 && !rule.gates.has(name)) console.log(`${label}: chant.workspace.json at base does not list ${name} under identity.gates, so it counts only a sealed approval, like the gates it lists`);
      ledger.resolutions = ledger.resolutions.filter((r) => {
        if (r.gate !== name) return true;
        const why = sealRefusal(rule.signers, rule.signersPath, r);
        if (why !== null && samePlanDigest(r.planDigest, digest)) console.log(`${label}: an approval does not count: ${why}`);
        return why === null;
      });
    }
    let decision = decideGate(ledger, name, digest, now);
    // Under pr-review the merged pull request's approving review of its head counts, when it reviewed these plans.
    let moved: Extract<ReviewOutcome, { kind: "moved" }> | undefined;
    if (decision.status === "waiting" && mode === "pr-review") {
      const env = options.env ?? process.env;
      const forge = env.GITLAB_CI === "true" ? "gitlab" : env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" ? "forgejo" : "github";
      const sha = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
      const changesDigest = reviewDigest(planned.filter((p) => p.member).map((p) => ({ member: p.member!.member, planDigest: p.member!.planDigest, plan: p.plan })));
      const r = await reviewWave({ env, ...(options.fetch ? { fetch: options.fetch } : {}), forge, sha, wave, digest: changesDigest });
      if (r.kind === "approved") {
        appendRecord(repo, { version: 1, kind: "resolution", op: APPLY_OP, gate: name, resolvedBy: r.by.join(","), timestamp: now, planDigest: digest, via: "pr-review", pr: r.pr, head: r.head, reviewers: r.by }, {}, `Approved by the review of pull request ${r.pr}: ${APPLY_OP} ${name}`);
        console.log(`${label}: pull request ${r.pr} was approved on its head ${r.head.slice(0, 8)} by ${r.by.join(", ")}, and the plans are the ones it reviewed (${changesDigest})`);
        decision = { status: "approved", by: r.by.join(", "), at: now };
      } else if (r.kind === "moved") {
        moved = r;
      } else {
        console.log(`${label}: no review approves this wave: ${r.why}`);
        if (r.review) {
          w.review = { pull_request: r.review.pr, url: r.review.url };
          console.log(`${label}: an approving review of pull request ${r.review.pr} on its head approves it: ${r.review.url}`);
        }
      }
    }
    if (decision.status === "approved") {
      console.log(`${label}: approved by ${decision.by} for this digest`);
      w.approval = "approved";
      // Recorded before anything applies, so no approval is ever used without the ledger saying so; a record that cannot be pushed stops the wave.
      const env = options.env ?? process.env;
      const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
      const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
      appendRecord(repo, {
        version: 1,
        kind: "applied",
        op: APPLY_OP,
        gate: name,
        planDigest: digest,
        approvedAt: decision.at,
        approvedBy: decision.by,
        timestamp: now,
        ...(runId ? { runId } : {}),
        ...(commit ? { commit } : {}),
      }, {}, `Applied under approval: ${APPLY_OP} ${name}`, APPLIED_PATH);
    } else {
      if (decision.status === "waiting" && decision.spent) {
        console.log(`${label}: the approval of ${decision.spent.approved} by ${decision.spent.by} was used by the apply of those plans, so these plans need an approval of their own`);
      }
      const env = options.env ?? process.env;
      facts.waitingSince = decision.standing?.timestamp ?? now;
      w.waitingSince = facts.waitingSince;
      // The report of this wave's plans, as respond wave-refused reads it.
      const report = (): string =>
        JSON.stringify(buildReport({
          run: { ...runFacts(repo, env), stage: "tf-apply", wave, binary, runtime: "forge", started: now, finished: now },
          roots: planned.map((p) => ({ path: p.root, plan: p.plan, planner: plannerForBinary(binary) })),
          waves: [{ number: wave, roots, setDigest: digest }],
        }));
      if (!decision.standing) {
        const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
        const atCommit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
        appendPending(repo, {
          version: 1,
          kind: "pending",
          op: APPLY_OP,
          gate: name,
          timestamp: now,
          expiresAt: new Date(at(now) + 48 * 3600 * 1000).toISOString(),
          planDigest: digest,
          description: `${label}: ${roots.join(", ")}`,
          ...(runId ? { runId } : {}),
          ...(atCommit ? { commit: atCommit } : {}),
          members,
          neverOverMcp: true,
        }, { [approvedPath(wave, digest)]: report() });
      }
      if (moved) {
        console.log(`${label}: pull request ${moved.pr} was approved on its head ${moved.head.slice(0, 8)} by ${moved.by.join(", ")}, but the plans changed since that review, so nothing in it was applied`);
        console.log(`${label}: the review saw digest ${moved.reviewed}; the changes planned now have another. Read the plans above, then approve them with:`);
        console.log(`  ${approveLine(wave, digest, mode)}`);
        mkdirSync(join(repo, "terragucci-report", "current"), { recursive: true });
        writeFileSync(join(repo, "terragucci-report", "current", "report.json"), report());
        w.refused = { reason: "review", approved: moved.reviewed, by: moved.by.join(", "), roots: members.map((m) => m.member).sort() };
        w.command = approveLine(wave, digest, mode);
        writeOutcome(options.env, `wave ${wave} changed since its review in pull request ${moved.pr}`, w);
        return EXIT.refused;
      }
      if (decision.status === "refused") {
        const approvedFact = [...ledger.pending].reverse().find((p) => p.gate === name && p.members && samePlanDigest(p.planDigest, decision.approved));
        const moved = approvedFact ? movedMembers(approvedFact.members!, members) : roots.slice().sort();
        console.log(describeChangedWave({ wave, op: APPLY_OP, gate: name, digest, approved: decision.approved }));
        console.log(`${label}: approved by ${decision.by}, but these roots planned differently since: ${moved.join(", ")}`);
        // What respond wave-refused compares: the plans approved, as the run that waited for them kept them, and the plans made now.
        const was = approvedFact?.planDigest ?? decision.approved;
        const approved = was && git(repo, ["show", `${REMOTE_REF}:${approvedPath(wave, was)}`]);
        for (const [dir, text] of [["current", report()], ["approved", approved && approved.status === 0 ? approved.stdout : ""]]) {
          if (!text) continue;
          mkdirSync(join(repo, "terragucci-report", dir), { recursive: true });
          writeFileSync(join(repo, "terragucci-report", dir, "report.json"), text);
        }
        if (!approved || approved.status !== 0) console.log(`${label}: the approved plans were not kept, so only the roots that moved can be named`);
        w.refused = { reason: "approval", ...(decision.approved ? { approved: decision.approved } : {}), by: decision.by, roots: moved };
        w.command = approveLine(wave, digest, mode);
        writeOutcome(options.env, `wave ${wave} changed after approval: ${moved.join(", ")}`, w);
        return EXIT.refused;
      }
      console.log(`${label} waits for an approval of digest ${digest}. Read its plans above, then approve it with:`);
      console.log(`  ${approveLine(wave, digest, mode)}`);
      // chant records the approver as --actor, else GITHUB_ACTOR, GITLAB_USER_LOGIN or USER; a seal counts only when that name is a principal in .chant/allowed_signers.
      console.log(mode === "sealed"
        ? "chant records you as $GITHUB_ACTOR, $GITLAB_USER_LOGIN or $USER. When none of them is your principal in .chant/allowed_signers, add --actor <principal>."
        : "chant records you as $GITHUB_ACTOR, $GITLAB_USER_LOGIN or $USER; add --actor <name> to name yourself. Under approval: ledger the approval binds these plans, not the person.");
      console.log("Then run this job again.");
      w.command = approveLine(wave, digest, mode);
      writeOutcome(options.env, `wave ${wave} waits: ${w.command}`, w);
      return EXIT.waiting;
    }
  }
  return undefined;
}

// ── a Terragrunt wave ────────────────────────────────────────────────────

/** One unit's plan in a Terragrunt wave. */
interface PlannedUnit {
  root: string;
  plan?: unknown;
  member?: WaveMember;
  changes: number;
  destroys: number;
  /** The plan changes one of the unit's outputs, which a unit in a later wave reads. */
  outputs: boolean;
  error?: string;
  policy?: ReportRootPolicy;
}

/** Whether a plan changes any of the root's outputs. */
export function changesOutputs(plan: unknown): boolean {
  const out = (plan as { output_changes?: Record<string, { actions?: string[] }> } | undefined)?.output_changes ?? {};
  return Object.values(out).some((c) => (c.actions ?? []).some((a) => a !== "no-op"));
}

/**
 * The runner with the default `-lock-timeout` added to the binary's plan and
 * apply commands (`lockTimeoutArgs`), unless the job's `TF_CLI_ARGS` names one.
 */
function unitLockTimeoutExec(inner: TerragruntExec, env: NodeJS.ProcessEnv): TerragruntExec {
  return (file, args, opts) => {
    const at = args.indexOf("--");
    const command = at < 0 ? undefined : args[at + 1];
    if (command !== "plan" && command !== "apply") return inner(file, args, opts);
    return inner(file, [...args.slice(0, at + 2), ...lockTimeoutArgs(command, env), ...args.slice(at + 2)], opts);
  };
}

const tail = (s: string, n = 40): string => s.trim().split("\n").slice(-n).join("\n");
const waves = (n: number): string => `${n} wave${n === 1 ? "" : "s"}`;

/**
 * One wave of a Terragrunt repo, behind the same gate as a plain wave.
 *
 * The waves are the pipeline's `--layers`, each split again by the edges
 * `terragrunt find` gives in the job's checkout (refineWaves). A pipeline
 * whose init saw every edge comes back as it is; one whose init missed an
 * edge (a dependency path built with a function) gets more waves than jobs,
 * and the last job runs them with `--rest`. No unit of a wave reads another
 * unit of it, and a unit that reads one of a later wave fails the job.
 *
 * The wave plans its units with one `run --all`, each plan saved, and takes
 * the set digest over the units whose plan changes something. The gate
 * decides, as it decides a plain wave, and the wave applies exactly those
 * saved plans with one `run --all`, never planning anew. A unit whose plan
 * would read mock_outputs fails the wave: its upstream applies in an earlier
 * wave, so it has no outputs only when it lies outside the units.
 */
async function runTerragruntWave(repo: string, options: ApplyWaveOptions, work: string, w: WaveRun, facts: WaveFacts): Promise<number> {
  const { wave, binary } = options;
  const env = options.env ?? process.env;
  const terragrunt = options.terragruntPath ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  const configPath = options.config ?? findConfig(repo);
  const read = await waveSettings(repo, options, configPath);
  if ("error" in read) {
    console.log(`wave ${wave}: ${read.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const settings = (w.settings = read.settings);
  // Which unit reads which: only Terragrunt's own discovery knows.
  const found = await discoverUnits(repo, { exclude: settings.terragrunt?.exclude, binary, terragrunt, ...(options.terragruntExec ? { exec: options.terragruntExec } : {}) });
  if (found.source !== "terragrunt find") {
    console.log(`wave ${wave}: ${found.notes.join("; ")}`);
    console.log(`wave ${wave}: without Terragrunt's discovery nobody knows which units read which, so nothing in it was applied`);
    return EXIT.failed;
  }
  const listed = options.layers.filter((l) => l.length > 0);
  let cut: string[][];
  try {
    cut = refineWaves(listed, found.units);
  } catch (e) {
    console.log(`wave ${wave}: ${(e as Error).message}, so nothing was applied`);
    return EXIT.failed;
  }
  w.count = cut.length;
  if (cut.length !== listed.length) {
    console.log(`wave ${wave}: Terragrunt's edges cut the pipeline's ${waves(listed.length)} into ${cut.length}; run terragucci init to give each wave its own job`);
  }
  const unlisted = found.units.map((u) => u.path).filter((u) => !listed.some((l) => l.includes(u)));
  if (unlisted.length > 0) console.log(`wave ${wave}: the pipeline does not list ${unlisted.join(", ")}, so no wave applies it; run terragucci init to add it`);
  const roots = cut[wave - 1];
  if (!roots) {
    facts.nothing = true;
    console.log(`wave ${wave}: this repo has ${waves(cut.length)}, so there is nothing to apply`);
    return EXIT.applied;
  }
  facts.roots = roots;
  const label = `wave ${wave} of ${cut.length}`;
  console.log(`${label}: planning ${roots.join(", ")}`);
  const exec = unitLockTimeoutExec(options.terragruntExec ?? terragruntExec, env);
  const run = { dir: repo, binary, terragrunt, exec };
  w.started = new Date().toISOString();
  w.roots = roots;
  const planDir = join(work, "plan");
  let result: Awaited<ReturnType<typeof planTerragruntWave>>;
  try {
    result = await planTerragruntWave({ ...run, units: roots, workDir: planDir });
  } catch (e) {
    if (e instanceof TerragruntMockRefusal) {
      for (const r of e.reads) console.log(`${r.unit} would plan on the mock_outputs of ${r.upstream}, which has no outputs`);
      console.log(`${label}: an upstream outside the waves before this one has no outputs, so nothing in it was applied`);
    } else {
      console.log(`${label}: ${(e as Error).message}`);
      console.log(`${label}: the units did not plan, so nothing in it was applied`);
    }
    return EXIT.failed;
  }
  if (result.code !== 0 && result.code !== 2) console.log(tail(result.log));
  for (const [unit, t] of unitTimes(join(planDir, "plan-report.json"))) w.observer.unitTimed(unit, (t.end - t.start) / 1000, t);
  const planned = new Map<string, PlannedUnit>();
  for (const part of result.parts) {
    const path = part.member.member;
    let plan: unknown;
    if (part.member.status !== "failed") {
      try {
        plan = JSON.parse(readFileSync(join(planDir, "json", path, "tfplan.json"), "utf-8"));
      } catch {
        plan = undefined;
      }
    }
    if (plan === undefined) {
      planned.set(path, { root: path, changes: 0, destroys: 0, outputs: false, error: part.member.error ?? "Terragrunt reported the unit planned but wrote no plan JSON for it" });
      continue;
    }
    const changed = part.entries.filter((e) => e.action !== "no-op" && e.action !== "read");
    planned.set(path, {
      root: path,
      plan,
      member: { member: path, planDigest: part.member.planDigest ?? "" },
      changes: changed.length,
      destroys: changed.filter((e) => e.action === "delete" || e.action === "replace").length,
      outputs: changesOutputs(plan),
    });
  }
  const units = roots.filter((r) => planned.has(r)).map((r) => planned.get(r)!);
  w.planned = units;
  for (const p of units) console.log(p.error ? `FAILED ${p.root}: ${p.error.split("\n")[0]}` : `${p.root}: ${p.changes === 0 ? "no changes" : `${p.changes} change${p.changes === 1 ? "" : "s"}, ${p.destroys} destroy${p.destroys === 1 ? "" : "s"}`}`);
  const failed = units.filter((p) => p.error !== undefined);
  const unplanned = roots.filter((r) => !planned.has(r));
  if (failed.length > 0 || unplanned.length > 0) {
    for (const p of failed) console.log(indent(p.error!));
    if (unplanned.length > 0) console.log(`${label}: Terragrunt planned no ${unplanned.join(", ")}`);
    console.log(`${label}: ${failed.length + unplanned.length} unit${failed.length + unplanned.length === 1 ? "" : "s"} failed to plan, so nothing in it was applied`);
    return EXIT.failed;
  }
  const refusedByPolicy = await policyGate(repo, options, { label, settings, configPath }, units, w);
  if (refusedByPolicy !== undefined) return refusedByPolicy;
  // A unit applies when its plan changes a resource or an output: a later wave reads the outputs.
  const changing = units.filter((p) => p.changes > 0 || p.outputs);
  if (changing.length === 0) {
    facts.nothing = true;
    console.log(`${label}: no changes`);
    console.log(`${label} applied`);
    return EXIT.applied;
  }
  const changes = changing.reduce((n, p) => n + p.changes, 0);
  const destroys = changing.reduce((n, p) => n + p.destroys, 0);
  const members = changing.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1));
  const digest = waveSetDigest(members);
  console.log(`${label}: set digest ${digest} over the ${changing.length} unit${changing.length === 1 ? "" : "s"} that change, ${changes} change${changes === 1 ? "" : "s"}, ${destroys} destroy${destroys === 1 ? "" : "s"}`);
  const stop = await gateWave(repo, options, { label, roots: changing.map((p) => p.root), planned: changing, members, digest, changes, destroys }, facts, w);
  if (stop !== undefined) return stop;
  // The saved plans, and nothing planned anew.
  const applied = await applyTerragruntWave({ ...run, units: changing.map((p) => p.root), workDir: planDir });
  console.log(applied.log.trim());
  const bad = applied.results.filter((r) => r.status !== "succeeded");
  if (applied.code !== 0 || bad.length > 0) {
    for (const r of bad) console.log(`FAILED ${r.unit}: ${r.result}${r.error ? `: ${r.error}` : ""}`);
    w.failed = bad.map((r) => r.unit);
    console.log(`${label}: an apply failed`);
    return EXIT.failed;
  }
  for (const p of changing) console.log(`applied ${p.root}`);
  console.log(`${label} applied`);
  return EXIT.applied;
}

/** The one line the job's status carries, written where the pipeline reads it (`TG_OUTCOME`). */
function writeOutcome(env: NodeJS.ProcessEnv | undefined, line: string, w: WaveRun): void {
  w.line = line.slice(0, 135);
  const file = (env ?? process.env).TG_OUTCOME;
  if (file) writeFileSync(file, w.line);
}

/** `terragucci.outcome/v1`: how a `tf-apply` wave ended, as JSON, for a program (notify, a chat front end) to read instead of the line. */
export const OUTCOME_SCHEMA = "terragucci.outcome/v1";

export type OutcomeStatus = "applied" | "waiting" | "refused" | "failed";

export interface WaveOutcome {
  schema: typeof OUTCOME_SCHEMA;
  status: OutcomeStatus;
  /** The stage's exit code: 0, 3, 4 or 1. */
  exit: number;
  wave: number;
  /** The wave's roots (units, in a Terragrunt repo). Empty when the repo has no such wave. */
  roots: string[];
  /** The `TG_OUTCOME` line, when the wave wrote one. */
  line?: string;
  /** chant's set digest over the roots that change: the digest an approval binds. */
  set_digest?: string;
  /** Where the gate's record lives, when a gate holds the wave. */
  gate?: { name: string; branch: string; path: string };
  approval?: ReportWave["approval"];
  /** The mode in force at the gate: which approvals count. */
  approval_mode?: Approval;
  /** The command that approves `set_digest`, when the wave waits or its plans moved after an approval or a review. */
  approve_command?: string;
  waiting_since?: string;
  /** Under `approval: pr-review`, the pull request whose approving review of its head would approve the waiting wave. */
  review?: { pull_request: number; url: string };
  /** Why the wave applied nothing although it planned: the reason, the digest approved, by whom, and the roots that moved or were denied. */
  refused?: ReportWave["refused"];
  /** The roots the policy denied. */
  policy_denied?: string[];
  /** The roots that failed to plan or apply. */
  failed_roots?: string[];
}

/** The wave's outcome as `terragucci.outcome/v1`. */
export function waveOutcome(wave: number, code: number, w: WaveRun): WaveOutcome {
  const status: OutcomeStatus = code === EXIT.applied ? "applied" : code === EXIT.waiting ? "waiting" : code === EXIT.refused ? "refused" : "failed";
  const denied = w.refused && (w.refused.reason === "policy" || w.refused.reason === "override") ? w.refused.roots : [];
  const failed = [...new Set([...(w.planned ?? []).filter((p) => p.error && !denied.includes(p.root)).map((p) => p.root), ...(w.failed ?? [])])].sort();
  return {
    schema: OUTCOME_SCHEMA,
    status,
    exit: code,
    wave,
    roots: w.roots ?? [],
    ...(w.line ? { line: w.line } : {}),
    ...(w.digest ? { set_digest: w.digest } : {}),
    ...(w.gate ? { gate: { name: waveGate(wave), ...w.gate } } : {}),
    ...(w.approval ? { approval: w.approval } : {}),
    ...(w.mode && w.gate ? { approval_mode: w.mode } : {}),
    ...(w.command && (status === "waiting" || status === "refused") ? { approve_command: w.command } : {}),
    ...(w.waitingSince && status === "waiting" ? { waiting_since: w.waitingSince } : {}),
    ...(w.review && status === "waiting" ? { review: w.review } : {}),
    ...(w.refused ? { refused: w.refused } : {}),
    ...(denied.length > 0 && w.refused?.reason === "policy" ? { policy_denied: denied } : {}),
    ...(status === "failed" && failed.length > 0 ? { failed_roots: failed } : {}),
  };
}

/** Write the wave's outcome where the pipeline asks for it (`TG_OUTCOME_JSON`), whatever came of the wave. */
function writeOutcomeJson(env: NodeJS.ProcessEnv, wave: number, code: number, w: WaveRun): void {
  const file = env.TG_OUTCOME_JSON;
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify(waveOutcome(wave, code, w)) + "\n");
  } catch (e) {
    console.log(`wave ${wave}: the outcome was not written to ${file}: ${(e as Error).message}`);
  }
}
