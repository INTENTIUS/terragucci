/**
 * `terragucci stage tf-apply --wave <k>`: one wave of a plain repo's apply,
 * run by the pipeline's wave-k job (chant#3049's gated waves, for Terraform
 * and OpenTofu roots).
 *
 * The wave plans its roots now, after the waves before it applied, and takes
 * the wave's set digest: chant's `waveSetDigest` over each root's plan
 * digest, the same digest the plan report shows for the wave. The gate policy
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
 * A wave gate that `chant.workspace.json` at base names under `identity.gates`
 * (terragucci init lists every wave there) counts only a sealed approval:
 * one made with `chant approve --sign` whose seal verifies against the
 * signers file at base (./seal.ts). Any other approval of it is ignored.
 *
 * Nothing here records an approval. A person does, with `chant approve`.
 *
 * Once its roots planned, the wave writes its report to `terragucci-report/`
 * (and copies it to the config's `reports` bucket when one is named): the
 * wave's plans, and each root's timings, the plan's and the apply's, from the
 * binary's spans as `stage tf-plan` reads them.
 *
 * Exit codes: 0 applied (or nothing to apply); 1 a root failed; 3 the wave
 * waits for an approval; 4 the wave's plans changed after approval.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeChangedWave, waveSetDigest, type WaveMember } from "@intentius/chant/gated-waves";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import { ConfigError, findConfig, GATES, loadConfig, resolveRepo, type Gate } from "./config";
import { globMatch } from "./detect";
import { buildReport, planFiles } from "./report/build";
import { StageObserver } from "./report/observe";
import { redactPlan } from "./report/redact";
import { S3Client, s3FromEnv } from "./report/s3";
import { checkPlans, type PolicyOptions } from "./report/policy";
import type { ReportPolicy, ReportRootPolicy } from "./report/schema";
import { artifactReportUrl, eachLimited, reportLinks, rootsParallelism, runFacts } from "./report/stage";
import { uploadReport, writeReportDir } from "./report/store";
import { telemetryFromEnv } from "./telemetry";
import { version as VERSION } from "../package.json";
import { sealRefusal, sealRule } from "./seal";
import type { WaveFacts } from "./report/wave-telemetry";

/** The op every wave gate is recorded under. */
export const APPLY_OP = "tf-apply";
/** The gate wave `k` waits on. */
export const waveGate = (wave: number): string => `wave-${wave}`;
/** The approval command a waiting wave prints, bound to the digest it planned and sealed with the approver's key. */
export const approveLine = (wave: number, digest: string): string => `chant approve ${APPLY_OP} ${waveGate(wave)} --plan ${digest} --sign`;

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
}

export interface GateLedger {
  pending: PendingRecord[];
  resolutions: ResolutionRecord[];
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
  | { status: "approved"; by: string }
  /** `standing` is set when a pending fact for this digest already stands, so nothing new is recorded. */
  | { status: "waiting"; standing?: PendingRecord }
  /** An approval stands for another digest. `standing` as for waiting. */
  | { status: "refused"; approved: string | undefined; by: string; standing?: PendingRecord };

/**
 * Decide one wave's gate against the ledger, the rule chant's `evaluateGate`
 * applies to a plan-bound gate: an approval counts only when it is newer than
 * the newest pending fact for the gate and names this digest. The newest
 * approval for another digest is the changed-set refusal.
 */
export function decideGate(ledger: GateLedger, gate: string, digest: string, now: string): GateDecision {
  let latest: PendingRecord | undefined;
  for (const p of ledger.pending) if (p.gate === gate && (!latest || at(p.timestamp) >= at(latest.timestamp))) latest = p;
  const since = latest ? at(latest.timestamp) : 0;
  let matched: ResolutionRecord | undefined;
  let mismatched: ResolutionRecord | undefined;
  for (const r of ledger.resolutions) {
    if (r.gate !== gate || at(r.timestamp) < since) continue;
    if (samePlanDigest(r.planDigest, digest)) {
      if (!matched || at(r.timestamp) >= at(matched.timestamp)) matched = r;
    } else if (!mismatched || at(r.timestamp) >= at(mismatched.timestamp)) {
      mismatched = r;
    }
  }
  if (matched) return { status: "approved", by: matched.resolvedBy };
  const standing = latest && at(latest.expiresAt) > at(now) && samePlanDigest(latest.planDigest, digest) ? latest : undefined;
  if (mismatched) return { status: "refused", approved: mismatched.planDigest, by: mismatched.resolvedBy, ...(standing ? { standing } : {}) };
  return { status: "waiting", ...(standing ? { standing } : {}) };
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

/** The gate ledger as `chant/lifecycle` on origin holds it now. */
export function readLedger(repo: string): GateLedger {
  if (!fetchLifecycle(repo)) return { pending: [], resolutions: [] };
  const show = git(repo, ["show", `${REMOTE_REF}:${LEDGER_PATH}`]);
  return parseLedger(show.status === 0 ? show.stdout : "");
}

/**
 * Where a waiting wave keeps the report of the plans it asked approval for,
 * next to the ledger, so a later run refused for another digest can say what
 * moved since. Sensitive values are never in it: the plan's change set does
 * not carry them.
 */
export const approvedPath = (wave: number, digest: string): string => `_gates/${APPLY_OP}/${waveGate(wave)}/${digest.replace(":", "_")}.json`;

/** Append a pending fact to the ledger and push it, with any `files` beside it, retrying when another writer moved the branch. */
export function appendPending(repo: string, record: PendingRecord, files: Record<string, string> = {}): void {
  const line = JSON.stringify(record);
  for (let attempt = 0; attempt < 5; attempt++) {
    const exists = fetchLifecycle(repo);
    const parent = exists ? git(repo, ["rev-parse", REMOTE_REF]).stdout.trim() : "";
    const old = exists ? git(repo, ["show", `${REMOTE_REF}:${LEDGER_PATH}`]) : undefined;
    // One record per line, each ending in a newline, so a line appended with `>>` stays its own record.
    const text = `${old && old.status === 0 && old.stdout.trim() ? `${old.stdout.replace(/\n$/, "")}\n` : ""}${line}\n`;
    const blob = git(repo, ["hash-object", "-w", "--stdin"], text).stdout.trim();
    // A scratch index, so the checkout's own index is left alone.
    const scratch = mkdtempSync(join(tmpdir(), "terragucci-ledger-"));
    const env = { ...process.env, ...GIT_ID, GIT_INDEX_FILE: join(scratch, "index") };
    if (parent) git(repo, ["read-tree", parent], undefined, env);
    for (const [path, b] of [[LEDGER_PATH, blob], ...Object.entries(files).map(([f, t]) => [f, git(repo, ["hash-object", "-w", "--stdin"], t).stdout.trim()])])
      git(repo, ["update-index", "--add", "--cacheinfo", `100644,${b},${path}`], undefined, env);
    const tree = git(repo, ["write-tree"], undefined, env).stdout.trim();
    const commit = git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", `Pending gate record: ${record.op} ${record.gate}`], undefined, env).stdout.trim();
    rmSync(scratch, { recursive: true, force: true });
    if (!commit) throw new ConfigError("could not write the pending gate record");
    const push = git(repo, ["push", "-q", "origin", `${commit}:refs/heads/${LIFECYCLE}`]);
    if (push.status === 0) return;
  }
  throw new ConfigError(`could not push the pending gate record to ${LIFECYCLE}; check that the job may push to it`);
}

// ── planning and applying ────────────────────────────────────────────────

interface Run {
  code: number;
  out: string;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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

async function planRoot(repo: string, binary: string, root: string, work: string, i: number, observer: StageObserver): Promise<PlannedRoot> {
  const timing = observer.root(root);
  try {
    return await planTimed(repo, binary, root, work, i, observer, timing);
  } finally {
    observer.endRoot(timing);
  }
}

async function planTimed(repo: string, binary: string, root: string, work: string, i: number, observer: StageObserver, timing: RootTiming): Promise<PlannedRoot> {
  const dir = join(repo, root);
  // Each root gets its own provider cache: a cache shared by roots that init together is not safe.
  const env = { ...process.env, TF_PLUGIN_CACHE_DIR: mkdtempSync(join(work, "cache-")) };
  const planFile = join(work, `${i}.tfplan`);
  const base = { root, timing, planFile, env, changes: 0, destroys: 0, summary: "" };
  const init = await timed(observer, timing, binary, ["init", "-input=false", "-no-color"], env, dir);
  if (init.code !== 0) return { ...base, error: `init failed\n${init.out}` };
  const plan = await timed(observer, timing, binary, ["plan", "-input=false", "-no-color", ...lockTimeoutArgs("plan", env), `-out=${planFile}`], env, dir);
  if (plan.code !== 0) return { ...base, error: `plan failed\n${plan.out}` };
  const show = spawnSync(binary, [`-chdir=${dir}`, "show", "-json", planFile], { encoding: "utf-8", env, maxBuffer: 512 * 1024 * 1024 });
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
  env?: NodeJS.ProcessEnv;
  now?: string;
  /** How many roots of the wave plan at once. Default: the config's `parallelism`, then from the state backend. */
  parallelism?: number;
  /** The config file; default: the one found from the repo. */
  config?: string;
  /** The ref the policy is read from. Default: TG_BASE, then the checkout (main, when the job runs there). */
  base?: string;
  /** With `policy:` set: how the engine runs and is fetched. Default: the real thing. */
  policy?: PolicyOptions;
}

/** Run one wave. Returns the exit code; what happened is printed. */
export async function applyWave(repo: string, options: ApplyWaveOptions): Promise<number> {
  const work = mkdtempSync(join(tmpdir(), "terragucci-apply-"));
  const env = options.env ?? process.env;
  const observer = new StageObserver(telemetryFromEnv(env), APPLY_OP, env);
  // How the wave ended, for its stage span and the waves dashboard's gauges.
  const facts: WaveFacts = {};
  observer.wave = { number: options.wave, facts };
  const wave: WaveRun = { observer };
  try {
    const code = await runWave(repo, options, work, wave, facts);
    observer.wave.code = code;
    return code;
  } finally {
    // The report is written once the wave's roots planned, whatever came of the gate and the apply.
    if (wave.planned) await writeWaveReport(repo, options, wave as Required<WaveRun>, env).catch((e) => console.log(`wave ${options.wave}: the report was not written: ${(e as Error).message}`));
    rmSync(work, { recursive: true, force: true });
  }
}

/** What a wave run leaves for its report. */
interface WaveRun {
  observer: StageObserver;
  planned?: PlannedRoot[];
  roots?: string[];
  started?: string;
  /** The wave's policy check, when `policy` is on. */
  policy?: ReportPolicy;
}

/**
 * The wave's report: its roots' plans (redacted), the wave, and each root's
 * timings, plan and apply. Written to `terragucci-report/` beside anything a
 * refused wave put there, and copied to the `reports` bucket when the config
 * names one. A copy that fails is logged; it never fails the wave.
 */
async function writeWaveReport(repo: string, options: ApplyWaveOptions, w: Required<WaveRun>, env: NodeJS.ProcessEnv): Promise<void> {
  const { wave, binary } = options;
  const configPath = options.config ?? findConfig(repo);
  const settings = resolveRepo(configPath ? await loadConfig(configPath) : {});
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
    waves: [{ number: wave, roots: w.roots }],
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
      const up = await uploadReport(new S3Client(s3FromEnv(settings.reports, env)), dir, report, settings.reports.prefix);
      console.log(`wave ${wave}: report copied to ${up.prefix}${report.run.report_url ? `, at ${report.run.report_url}` : ""}`);
    } catch (e) {
      console.log(`wave ${wave}: the report was not copied to ${settings.reports.bucket}: ${(e as Error).message}`);
    }
  }
  await w.observer.finish(report, env, (l) => console.log(l));
}

async function runWave(repo: string, options: ApplyWaveOptions, work: string, w: WaveRun, facts: WaveFacts = {}): Promise<number> {
  const { wave, binary, gate } = options;
  if (!GATES.includes(gate)) throw new ConfigError(`--gate must be one of ${GATES.join(", ")}`);
  const waves = applyWaves(options.layers, options.canary);
  if (!Number.isInteger(wave) || wave < 1) throw new ConfigError("--wave must be a wave number from 1");
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
  const settings = resolveRepo(configPath ? await loadConfig(configPath) : {});
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
  await eachLimited(roots, limit.value, async (r, i) => {
    planned[i] = await planRoot(repo, binary, r, work, i, w.observer);
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
  // Policy is opt-in. A wave whose plans the policy denies, or that it cannot check, applies nothing and records no approval to wait for.
  if (settings.policy) {
    const env = options.env ?? process.env;
    const base = options.base ?? (env.TG_BASE || undefined);
    const runAt = runFacts(repo, env, settings.forge);
    const found = await checkPlans(repo, settings.policy, planned.map((p) => ({ path: p.root, plan: p.plan })), base, configPath ? { config: configPath } : {}, options.policy ?? {}, (l) => console.log(l), { stage: "tf-apply", project: runAt.project, commit: runAt.commit });
    const denied = found.failed;
    w.policy = found.policy;
    for (const p of planned) {
      const verdict = found.roots.get(p.root);
      if (verdict) p.policy = verdict;
    }
    if (denied.size > 0) {
      for (const p of planned) {
        const error = denied.get(p.root);
        if (error === undefined) continue;
        p.error = error;
        console.log(`FAILED ${p.root}: ${error.split("\n")[0]}`);
        console.log(indent(error));
      }
      console.log(`${label}: policy refused ${denied.size} root${denied.size === 1 ? "" : "s"}, so nothing in it was applied`);
      writeOutcome(options.env, `wave ${wave} refused by policy: ${[...denied.keys()].join(", ")}`);
      return EXIT.failed;
    }
  }
  const members = planned.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1));
  const digest = waveSetDigest(members);
  const changes = planned.reduce((n, p) => n + p.changes, 0);
  const destroys = planned.reduce((n, p) => n + p.destroys, 0);
  console.log(`${label}: set digest ${digest}, ${changes} change${changes === 1 ? "" : "s"}, ${destroys} destroy${destroys === 1 ? "" : "s"}`);

  if (changes === 0) facts.nothing = true;
  // A wave with nothing to change has nothing to approve.
  const gated = changes > 0 && (gate === "always" || (gate === "on-destroy" && destroys > 0));
  if (gated) {
    const name = waveGate(wave);
    const now = options.now ?? new Date().toISOString();
    const ledger = readLedger(repo);
    const rule = sealRule(repo);
    if (rule.gates.has(name)) {
      // identity.gates names this gate: an approval counts only when its seal verifies.
      ledger.resolutions = ledger.resolutions.filter((r) => {
        if (r.gate !== name) return true;
        const why = sealRefusal(rule.signers, rule.signersPath, r);
        if (why !== null && samePlanDigest(r.planDigest, digest)) console.log(`${label}: an approval does not count: ${why}`);
        return why === null;
      });
    }
    const decision = decideGate(ledger, name, digest, now);
    if (decision.status === "approved") {
      console.log(`${label}: approved by ${decision.by} for this digest`);
    } else {
      const env = options.env ?? process.env;
      facts.waitingSince = decision.standing?.timestamp ?? now;
      // The report of this wave's plans, as respond wave-refused reads it.
      const report = (): string =>
        JSON.stringify(buildReport({
          run: { ...runFacts(repo, env), stage: "tf-apply", wave, binary, runtime: "forge", started: now, finished: now },
          roots: planned.map((p) => ({ path: p.root, plan: p.plan, planner: plannerForBinary(binary) })),
          waves: [{ number: wave, roots }],
        }));
      if (!decision.standing) {
        const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
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
          members,
          neverOverMcp: true,
        }, { [approvedPath(wave, digest)]: report() });
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
        writeOutcome(options.env, `wave ${wave} changed after approval: ${moved.join(", ")}`);
        return EXIT.refused;
      }
      console.log(`${label} waits for an approval of digest ${digest}. Read its plans above, then approve it with:`);
      console.log(`  ${approveLine(wave, digest)}`);
      console.log("and run this job again.");
      writeOutcome(options.env, `wave ${wave} waits: ${approveLine(wave, digest)}`);
      return EXIT.waiting;
    }
  }

  // The roots of a wave do not read each other, so they apply together.
  const ok = await Promise.all(planned.map((p) => applyRoot(repo, binary, p, w.observer)));
  if (ok.includes(false)) {
    console.log(`${label}: an apply failed`);
    return EXIT.failed;
  }
  console.log(`${label} applied`);
  return EXIT.applied;
}

/** The one line the job's status carries, written where the pipeline reads it (`TG_OUTCOME`). */
function writeOutcome(env: NodeJS.ProcessEnv | undefined, line: string): void {
  const file = (env ?? process.env).TG_OUTCOME;
  if (file) writeFileSync(file, line.slice(0, 135));
}
