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
 * binary's spans as `stage tf-plan` reads them. For each root that applied,
 * or had nothing to apply, it names the state version the root's backend
 * holds afterwards (./backend.ts): an S3 version id, read from the state
 * object's metadata, never from its contents.
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
 * A wave can spread across jobs (`waves.jobs`); a Terragrunt wave's shares
 * plan and apply their units with `run --all --filter` (runTerragruntWave). With
 * `--shares <n>` the wave's job plans every root, runs the policy, decides the
 * gate and records the approval it uses, all as above, but applies nothing:
 * it writes the plan digest of each root to `terragucci-wave/wave-<k>.json`
 * and the pipeline's share jobs apply. With `--share <s>` a job plans only
 * its share of the wave's roots (waveShares), and applies them only when each
 * plan has the digest the wave's job decided on. A share whose plans moved
 * since applies nothing and exits 4. The gate, its ledger record and the
 * applied record stay one per wave.
 *
 * Exit codes: 0 applied (or nothing to apply; for a wave split across jobs,
 * decided and its shares may apply); 1 a root failed; 3 the wave waits for an
 * approval; 4 the wave's plans changed after approval, or a share's after its
 * wave decided.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { APPROVALS, BRANCHES_NOT_TERRAGRUNT, ConfigError, findConfig, GATES, loadConfig, resolveRepo, type Approval, type Gate, type ResolvedSettings } from "./config";
import { globMatch, remoteStateReads, rootDependencies, rootStates } from "./detect";
import { runSkeleton, updateRunView, type RunWave } from "./report/run-view";
import type { Span } from "./report/graph";
import { wavesOf } from "./planned-outputs";
import { comparePreview } from "./tg-preview-gate";
import { runPath } from "./report/store";
import { buildReport, planFiles } from "./report/build";
import { StageObserver } from "./report/observe";
import { redactPlan } from "./report/redact";
import { storeFromEnv } from "./report/bucket";
import { checkPlans, configAtBase, governingPolicy, type PolicyOptions } from "./report/policy";
import { binaryText, type ReportCost, type ReportPolicy, type ReportRead, type ReportRootBinary, type ReportRootPolicy, type ReportStateVersion, type ReportWave, type ReportWaveCost, type WaveState } from "./report/schema";
import { RootBinaries, type Installer, type RootBinary } from "./pins";
import { approveAbove, costCommand, costMember, costReason, costRule, estimateCosts, policyCost, waveCost, writeCostFiles, type CostRunner } from "./report/cost";
import { artifactReportUrl, eachLimited, oneAtATime, reportLinks, rootsParallelism, runFacts, unitTimes, type Turn } from "./report/stage";
import { uploadReport, writeReportDir } from "./report/store";
import { telemetryFromEnv } from "./telemetry";
import { version as VERSION } from "../package.json";
import { approvalRule, type ApprovalRule } from "./approval";
import { decideOverride, OVERRIDE_LEDGER, OVERRIDE_OP, overrideCommand, overrideDigest, type OverridePending } from "./override";
import { approveCommand } from "./report/marker";
import type { Fetch } from "./forge";
import { changesSomething, forgeCalls, pullOf, reviewDigest, reviewWave, type ReviewOutcome } from "./review";
import { artifactBytes, noReview, reviewOfPull, type FetchBytes, type PolicyReview } from "./review-agent";
import { baseCommit, sealRefusal } from "./seal";
import type { WaveFacts } from "./report/wave-telemetry";
import { discoverUnits, refineWaves, unitEdges, walkUnits } from "./terragrunt";
import { applyWaveGroups, dirOf, groupUnits, planWaveGroups, UnitBinaries, type UnitTools } from "./unit-pins";
import { binaryEnv, terragruntExec } from "./binary-env";
import { stateVersion } from "./backend";
import { rootRoleEnv } from "./roles";
import { migrationFiles, MIGRATIONS_DIR, runMigrations, type MigrationRecord } from "./migrate";
import { readSteps, runSteps, runUnitSteps, stepsUsed, terragruntStepsRefusal, waveStepsBase, type StepWhen } from "./steps";
import type { StepSettings } from "./config";
import type { ReportStep } from "./report/schema";

/** The op every wave gate is recorded under. */
export const APPLY_OP = "tf-apply";
/** The gate wave `k` waits on. */
export const waveGate = (wave: number): string => `wave-${wave}`;
/** The approval command a waiting wave prints, bound to the digest it planned, and under `approval: sealed` sealed with the approver's key. */
export const approveLine = (wave: number, digest: string, mode: Approval = "ledger"): string => approveCommand(wave, digest, mode === "sealed");

/** The migration files in a repo's migrations/. */

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

/**
 * `apply.branches` as the pipeline passes it: `release=envs/prod/*,envs/dr/*;staging=envs/staging/*`.
 */
export function parseBranches(spec: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of spec.split(";").filter(Boolean)) {
    const eq = part.indexOf("=");
    const globs = eq > 0 ? part.slice(eq + 1).split(",").filter(Boolean) : [];
    if (eq <= 0 || globs.length === 0) throw new ConfigError(`--branches takes <branch>=<glob>[,<glob>...][;...], not ${JSON.stringify(part)}`);
    out[part.slice(0, eq)] = globs;
  }
  return out;
}

/** `apply.branches` for `--branches`. */
export const branchesArg = (branches: Record<string, string[]>): string =>
  Object.entries(branches).map(([b, globs]) => `${b}=${globs.join(",")}`).join(";");

/**
 * The layers a push to `branch` applies under `apply.branches`: on a branch
 * the map names, only the roots its globs match; anywhere else (the default
 * branch, and a comment's apply of a merge into it), every root but those
 * any branch's globs match. Empty layers drop out of the waves.
 */
export function branchLayers(layers: string[][], branches: Record<string, string[]>, branch?: string): { layers: string[][]; note: string } {
  const own = branch !== undefined ? branches[branch] : undefined;
  const mapped = Object.values(branches).flat();
  const keep = own
    ? (r: string): boolean => own.some((g) => globMatch(g, r))
    : (r: string): boolean => !mapped.some((g) => globMatch(g, r));
  const out = layers.map((l) => l.filter(keep));
  const kept = out.flat();
  const left = layers.flat().filter((r) => !kept.includes(r));
  const note = own
    ? `apply.branches: ${branch} applies ${kept.length ? kept.join(", ") : "none of this repo's roots"}`
    : `apply.branches: ${left.length ? `${left.join(", ")} ${left.length === 1 ? "applies" : "apply"} from ${[...new Set(left.map((r) => Object.keys(branches).find((b) => branches[b].some((g) => globMatch(g, r)))))].join(", ")}, not here` : "no root here is another branch's"}`;
  return { layers: out, note };
}

/**
 * A wave's roots split across `jobs` jobs: as many shares as there are jobs,
 * never more than there are roots, the roots dealt out in wave order. One
 * share is the whole wave.
 */
export function waveShares(roots: readonly string[], jobs: number): string[][] {
  const n = Math.max(1, Math.min(Math.floor(jobs), roots.length));
  const shares: string[][] = Array.from({ length: n }, () => []);
  roots.forEach((r, i) => shares[i % n].push(r));
  return shares;
}

/** Where a split wave's job leaves its decision for the share jobs: the run's artifact of that name. */
export const DECIDED_DIR = "terragucci-wave";
export const decidedPath = (wave: number): string => `${DECIDED_DIR}/wave-${wave}.json`;

/**
 * What the job of a wave split across jobs decided, for its shares: the set
 * digest, how the gate let it through, and every root's plan digest. A share
 * applies only plans with these digests. Digests only, never a plan.
 */
export interface WaveDecision {
  version: 1;
  wave: number;
  /** How many shares the wave is split into. */
  shares: number;
  digest: string;
  approval: "approved" | "not-required";
  /** The changes the wave's plans make; with none a share has nothing to apply. */
  changes: number;
  commit?: string;
  members: WaveMember[];
}

/** Read a decision file. Throws a ConfigError naming what is wrong with it. */
export function readDecision(file: string): WaveDecision {
  let d: Partial<WaveDecision>;
  try {
    d = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new ConfigError(`the wave's decision ${file} cannot be read (${(e as Error).message.split("\n")[0]}); the wave's own job writes it before its shares run`);
  }
  if (d.version !== 1 || typeof d.wave !== "number" || typeof d.shares !== "number" || typeof d.digest !== "string" || !Array.isArray(d.members) || typeof d.changes !== "number") {
    throw new ConfigError(`the wave's decision ${file} is not one terragucci wrote`);
  }
  return d as WaveDecision;
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
  /** Set when the apply job recorded the approval from a pull request's review (`approval: pr-review`), or a relay from a click in Slack or Teams (./relay.ts). */
  via?: "pr-review" | "slack" | "teams";
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
/** The applied file beside an op's ledger: `_gates/<op>.jsonl` keeps it at `_gates/<op>/applied.jsonl`. */
export const appliedPathFor = (ledgerPath: string): string => `${ledgerPath.replace(/\.jsonl$/, "")}/applied.jsonl`;
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
  const applied = git(repo, ["show", `${REMOTE_REF}:${appliedPathFor(path)}`]);
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

/** Append an approval of a wave's gate to the ledger and push it: what the relay records for the person who clicked. */
export function appendResolution(repo: string, record: ResolutionRecord): void {
  appendRecord(repo, record, {}, `Approved: ${record.op} ${record.gate}${record.relayedBy ? `, relayed by ${record.relayedBy}` : ""}`);
}

/** Append lines to the ledger (`path`, the waves' file by default) and push them in one commit, as appendPending does. */
function appendRecord(repo: string, record: PendingRecord | ResolutionRecord | AppliedRecord | AppliedRecord[], files: Record<string, string>, message: string, path: string = LEDGER_PATH): void {
  appendLifecycle(repo, path, (Array.isArray(record) ? record : [record]).map((r) => JSON.stringify(r)), files, message);
}

/**
 * Append `lines` to `path` on chant/lifecycle, write `files` beside it, and
 * push the commit, retrying when another writer moved the branch. `refs` are
 * pushed with it in one atomic push (a release tag), so the branch and the
 * refs move together or not at all.
 */
export function appendLifecycle(repo: string, path: string, lines: string[], files: Record<string, string>, message: string, refs: string[] = []): void {
  const line = lines.join("\n");
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
    if (!commit) throw new ConfigError(`could not write the ledger record (${message})`);
    const push = git(repo, ["push", "-q", ...(refs.length ? ["--atomic"] : []), "origin", `${commit}:refs/heads/${LIFECYCLE}`, ...refs]);
    if (push.status === 0) return;
  }
  throw new ConfigError(`could not push the ledger record (${message}) to ${LIFECYCLE}${refs.length ? ` with ${refs.join(", ")}` : ""}; check that the job may push to it`);
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
  /** What it planned with, which its apply runs too: the job's binary or the version it pins. */
  binary: string;
  /** That binary as the report names it. */
  bin: ReportRootBinary;
  /** The steps that ran for it. */
  steps: ReportStep[];
  /** Its `on_failure: approve` steps that failed: the wave waits for an approval. */
  holds: string[];
}

/** The steps a wave runs, and the context its roots run them in. */
interface WaveSteps {
  steps: StepSettings[];
  env: NodeJS.ProcessEnv;
}

/** Run one moment's steps for a planned root, keeping what they came to on it. The error when one failed the root. */
async function rootSteps(repo: string, p: Pick<PlannedRoot, "root" | "steps" | "holds">, ws: WaveSteps | undefined, when: StepWhen, planFile?: string): Promise<string | undefined> {
  if (!ws || ws.steps.length === 0) return undefined;
  const o = await runSteps(ws.steps, when, { repo, root: p.root, stage: "tf-apply", env: ws.env, ...(planFile ? { planFile } : {}), log: (l) => console.log(l) });
  p.steps.push(...o.runs);
  p.holds.push(...o.holds);
  return o.error;
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

async function planRoot(repo: string, binaries: RootBinaries, root: string, work: string, i: number, observer: StageObserver, cache: WaveCache, ws?: WaveSteps): Promise<PlannedRoot> {
  const timing = observer.root(root);
  try {
    return await planTimed(repo, binaries, root, work, i, observer, timing, cache, ws);
  } finally {
    observer.endRoot(timing);
  }
}

async function planTimed(repo: string, binaries: RootBinaries, root: string, work: string, i: number, observer: StageObserver, timing: RootTiming, cache: WaveCache, ws?: WaveSteps): Promise<PlannedRoot> {
  const dir = join(repo, root);
  // The root's own role, when `oidc.roles` names one (./roles.ts); it applies and reads its state version with it too.
  const env = rootRoleEnv({ ...process.env, TF_PLUGIN_CACHE_DIR: cache.dir }, root);
  const planFile = join(work, `${i}.tfplan`);
  const expected = binaries.expected(root);
  const failed = { root, timing, planFile, env, changes: 0, destroys: 0, summary: "", binary: binaries.binary, bin: expected, steps: [] as ReportStep[], holds: [] as string[] };
  let resolved: RootBinary;
  try {
    resolved = await binaries.resolve(root);
  } catch (e) {
    return { ...failed, error: (e as Error).message };
  }
  const binary = resolved.path;
  const bin: ReportRootBinary = { name: resolved.name, ...(resolved.version ? { version: resolved.version } : {}), ...(resolved.pin ? { pin: resolved.pin } : {}) };
  if (bin.pin) console.log(`${root}: ${binaryText(bin)}`);
  const base = { ...failed, binary, bin };
  const stepEnv = ws ? { ...ws, env: rootRoleEnv({ ...ws.env, TF_PLUGIN_CACHE_DIR: cache.dir }, root) } : undefined;
  let stepError = await rootSteps(repo, base, stepEnv, "before-init");
  if (stepError) return { ...base, error: stepError };
  const init = await cache.initTurn(() => timed(observer, timing, binary, ["init", "-input=false", "-no-color"], env, dir));
  if (init.code !== 0) return { ...base, error: `init failed\n${init.out}` };
  stepError = (await rootSteps(repo, base, stepEnv, "after-init")) ?? (await rootSteps(repo, base, stepEnv, "before-plan"));
  if (stepError) return { ...base, error: stepError };
  const plan = await timed(observer, timing, binary, ["plan", "-input=false", "-no-color", ...lockTimeoutArgs("plan", env), `-out=${planFile}`], env, dir);
  if (plan.code !== 0) return { ...base, error: `plan failed\n${plan.out}` };
  stepError = await rootSteps(repo, base, stepEnv, "after-plan", planFile);
  if (stepError) return { ...base, error: stepError };
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

async function applyRoot(repo: string, p: PlannedRoot, observer: StageObserver, ws?: WaveSteps): Promise<boolean> {
  const stepEnv = ws ? { ...ws, env: rootRoleEnv({ ...ws.env, TF_PLUGIN_CACHE_DIR: p.env.TF_PLUGIN_CACHE_DIR }, p.root) } : undefined;
  const before = await rootSteps(repo, p, stepEnv, "before-apply", p.planFile);
  if (before) {
    console.log(`FAILED ${p.root}: nothing applied`);
    console.log(indent(before));
    p.error = before;
    return false;
  }
  observer.reopen(p.timing);
  let r: Run;
  try {
    r = await timed(observer, p.timing, p.binary, ["apply", "-input=false", "-no-color", ...lockTimeoutArgs("apply", p.env), p.planFile], p.env, join(repo, p.root));
  } finally {
    observer.endRoot(p.timing);
  }
  if (r.code === 0) {
    const after = await rootSteps(repo, p, stepEnv, "after-apply");
    if (after) {
      console.log(`FAILED ${p.root}: applied, then a step after the apply failed`);
      console.log(indent(after));
      p.error = after;
      return false;
    }
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
  /** Plain roots only: the most jobs the wave's roots spread across (`waves.jobs`). Without `share`, this job decides the wave and its share jobs apply. */
  shares?: number;
  /** With `shares`: this job applies share `share` (from 1) of the wave, the plans the wave's job decided on. */
  share?: number;
  /** The decision file the wave's job writes and its shares read. Default: terragucci-wave/wave-<k>.json in the checkout. */
  decided?: string;
  /** How a version a root pins is installed. Default: the release, checked against its SHA256SUMS. */
  installer?: Installer;
  /** Runs the cost estimator, with `cost` set; tests pass one. */
  costRunner?: CostRunner;
  /** `apply.branches`: the roots another branch applies. With it the layers are cut to the branch's (branchLayers). */
  branches?: Record<string, string[]>;
  /** The branch the push applies; unset means the default branch. */
  branch?: string;
}

/** Run one wave, or with `rest` a Terragrunt repo's wave and the waves after it. Returns the exit code; what happened is printed. */
export async function applyWave(repo: string, options: ApplyWaveOptions): Promise<number> {
  if (options.branches && Object.keys(options.branches).length > 0) {
    if (options.terragrunt) throw new ConfigError(`--branches: ${BRANCHES_NOT_TERRAGRUNT}`);
    const cut = branchLayers(options.layers, options.branches, options.branch || undefined);
    console.log(`wave ${options.wave}: ${cut.note}`);
    if (cut.layers.flat().length === 0) {
      console.log(`wave ${options.wave}: no root applies from ${options.branch || "this branch"}, so there is nothing to apply`);
      return EXIT.applied;
    }
    options = { ...options, layers: cut.layers, branches: undefined };
  }
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
    if (code !== undefined) wave.state = waveState(code, wave);
    wave.ended = new Date().toISOString();
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
  /** A Terragrunt wave: the waves as it cut them, and the units with the units each depends on, for the run view. */
  units?: { waves: string[][]; edges: Map<string, Set<string>> };
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
  /** The roots it applied, and those it had nothing to apply to: the report lists the resources each holds. */
  applied?: Set<string>;
  /** The state version each applied root's backend holds afterwards, by root. */
  states?: Map<string, ReportStateVersion>;
  /** A wave split across jobs that decided and left the applies to its shares: its report stays with the job, and the shares' go to the bucket. */
  decided?: boolean;
  /** The share of a wave split across jobs this job applies. */
  share?: number;
  /** The roots whose `on_failure: approve` step failed, which hold the wave at its gate. */
  heldBySteps?: string[];
  /** The estimate of the wave's plans, with `cost` set. */
  cost?: ReportCost;
  /** The wave's monthly cost, and with `cost.approve_above` at base whether it waits for it. */
  waveCost?: ReportWaveCost;
  /** Where `cost.approve_above` was read. */
  costSource?: string;
  /** The estimator's output per root, kept beside the plans in the report. */
  costOutputs?: Map<string, string>;
  /** Where the wave stands once it ended, for its report and the run view. */
  state?: WaveState;
  /** A wave split across jobs that decided: how many share jobs apply it. */
  shareCount?: number;
  /** Each root's `terraform_remote_state` reads of other roots: planned now, after the waves before it applied, on their state. */
  reads?: Map<string, ReportRead[]>;
  /** The waves whose roots its roots read. */
  waveReads?: number[];
  /** A Terragrunt wave: its plans against the merged pull request's preview of them. */
  preview?: ReportWave["preview"];
  /** When its roots finished planning. */
  plannedAt?: string;
  /** When the wait at its gate began: the pending record its approval answered, or the first run that asked. */
  gateSince?: string;
  /** When the approval that let it through was given. */
  approvedAt?: string;
  /** When it began applying. */
  applyStarted?: string;
  /** When the job ended. */
  ended?: string;
  /** The roots whose plan changes something. */
  changedRoots?: string[];
}

/**
 * A wave job's spans for the run view's timeline: its plan, its wait at the
 * gate (open while it waits), and its apply (open while it applies).
 */
export function waveSpans(w: Pick<WaveRun, "started" | "plannedAt" | "gateSince" | "approvedAt" | "applyStarted" | "ended" | "share" | "state">): Span[] {
  const share = w.share !== undefined ? { share: w.share } : {};
  const out: Span[] = [];
  if (w.started) out.push({ phase: "plan", start: w.started, ...(w.plannedAt ? { end: w.plannedAt } : {}), ...share });
  if (w.gateSince) out.push({ phase: "gate", start: w.gateSince, ...(w.approvedAt ? { end: w.approvedAt } : w.state !== undefined && w.state !== "waiting" && w.ended ? { end: w.ended } : {}) });
  if (w.applyStarted) out.push({ phase: "apply", start: w.applyStarted, ...(w.ended && w.state !== "applying" ? { end: w.ended } : {}), ...share });
  return out;
}

/** Where a wave stands, from how it ended. */
export function waveState(code: number, w: Pick<WaveRun, "decided" | "refused">): WaveState {
  if (code === EXIT.applied) return w.decided ? "applying" : "applied";
  if (code === EXIT.waiting) return "waiting";
  if (code === EXIT.refused || w.refused?.reason === "policy") return "refused";
  return "failed";
}

/**
 * The reads of a wave's roots: each `terraform_remote_state` block that reads
 * another root of the repo, and the waves those roots are in. The wave plans
 * after the waves before it applied, so every read is of applied state.
 */
export function waveReads(repo: string, waves: readonly string[][], roots: readonly string[], wave: number): { reads: Map<string, ReportRead[]>; waves: number[] } {
  const blocks = remoteStateReads(repo, waves.flat());
  const waveOf = new Map(waves.flatMap((w, i) => w.map((r) => [r, i + 1] as const)));
  const reads = new Map(roots.map((r) => [r, (blocks.get(r) ?? []).map((b): ReportRead => ({ upstream: b.upstream, data: b.name, outputs: "applied" }))]));
  return { reads, waves: wavesOf(waveOf, [...reads.values()].flat().map((r) => r.upstream), wave) };
}

/** Say what a wave's roots read, as they plan: the state of roots an earlier wave applied. */
function logReads(label: string, reads: Map<string, ReportRead[]>, waves: readonly string[][]): void {
  const waveOf = new Map(waves.flatMap((w, i) => w.map((r) => [r, i + 1] as const)));
  for (const [root, rs] of reads) {
    if (rs.length === 0) continue;
    const ups = [...new Set(rs.map((r) => r.upstream))].sort();
    console.log(`${label}: ${root} plans on the state ${ups.map((u) => `${u}${waveOf.has(u) ? ` (wave ${waveOf.get(u)})` : ""}`).join(", ")} applied`);
  }
}

/**
 * Replace this wave's row in the bucket's run view (./report/run-view.ts),
 * when the config names a reports bucket. A view that cannot be written is
 * logged; it never fails the wave.
 */
async function noteRunView(repo: string, options: ApplyWaveOptions, w: WaveRun, row: Partial<RunWave>): Promise<void> {
  const settings = w.settings;
  if (!settings?.reports?.bucket) return;
  const env = options.env ?? process.env;
  try {
    const facts = runFacts(repo, env, settings.forge);
    // A Terragrunt repo's waves and edges are the ones the wave cut from terragrunt find; before it did, the units' files give the edges.
    const waves = options.terragrunt ? (w.units?.waves ?? options.layers) : applyWaves(options.layers, options.canary);
    const reads = options.terragrunt ? (w.units?.edges ?? unitEdges(walkUnits(repo, w.settings?.terragrunt?.exclude))) : rootDependencies(repo, options.layers.flat());
    const states = options.terragrunt ? new Map() : rootStates(repo, options.layers.flat());
    const skeleton = runSkeleton(facts.project, facts.commit, waves, reads, states);
    const spans = waveSpans(w);
    const timing = { ...(spans.length ? { spans } : {}), ...(w.changedRoots ? { changed: w.changedRoots } : {}) };
    const key = await updateRunView(storeFromEnv(settings.reports, env), settings.reports.prefix, skeleton, { number: options.wave, gate: waveGate(options.wave), policy: options.gate, ...timing, ...row });
    console.log(`wave ${options.wave}: run view at ${key}`);
  } catch (e) {
    console.log(`wave ${options.wave}: the run view was not written: ${(e as Error).message}`);
  }
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
  // The roots whose state each root reads, from the code: remote state for plain roots, dependency blocks for units.
  // A Terragrunt unit's dependency and dependencies blocks, from its terragrunt.hcl: the units whose outputs it reads.
  const unitDeps = options.terragrunt ? new Map(walkUnits(repo, settings.terragrunt?.exclude).map((u) => [u.path, u.dependencies])) : undefined;
  const report = buildReport({
    run: { ...runFacts(repo, env, settings.forge), stage: APPLY_OP, wave, ...(w.share !== undefined ? { share: w.share } : {}), binary, runtime: settings.runtime, started: w.started, finished: new Date().toISOString(), terragucci: VERSION },
    roots: w.planned.map((p) => {
      const policy = p.policy ? { policy: p.policy } : {};
      // A root the policy refused keeps its plan, so the report shows what it would have changed.
      const steps = p.steps?.length ? { steps: p.steps } : {};
      const deps = unitDeps?.get(p.root)?.length ? { dependencies: unitDeps.get(p.root) } : {};
      if (p.error && !(p.policy && p.policy.result !== "passed" && p.plan !== undefined)) return { path: p.root, planner: plannerForBinary(binary), ...(p.bin ? { binary: p.bin } : {}), error: p.error.split("\n")[0], ...policy, ...steps, ...deps };
      const state = w.states?.get(p.root);
      const reads = w.reads?.get(p.root)?.length ? { reads: w.reads.get(p.root) } : {};
      return { path: p.root, plan: p.plan, planner: plannerForBinary(binary), ...(p.bin ? { binary: p.bin } : {}), files: { json: planFiles(p.root).json }, ...(p.error ? { error: p.error } : {}), ...policy, ...steps, ...reads, ...(w.applied?.has(p.root) ? { applied: true } : {}), ...(state ? { state } : {}), ...deps };
    }),
    waves: [{ number: wave, roots: w.roots, ...(w.digest ? { setDigest: w.digest } : {}), ...(w.approval ? { approval: w.approval } : {}), ...(w.gate ? { gate: w.gate } : {}), ...(w.waitingSince ? { waitingSince: w.waitingSince } : {}), ...(w.refused ? { refused: w.refused } : {}), ...(w.review ? { review: w.review } : {}), ...(w.heldBySteps ? { heldBySteps: w.heldBySteps } : {}), ...(w.waveCost ? { cost: w.waveCost } : {}), ...(w.state ? { state: w.state } : {}), ...(w.waveReads?.length ? { reads: w.waveReads } : {}), ...(w.preview ? { preview: w.preview } : {}) }],
    redacted,
    ...(w.policy ? { policy: w.policy } : {}),
  });
  if (w.cost) report.cost = w.cost;
  w.observer.addTimings(report, ["plan", "apply"]);
  const dir = join(repo, "terragucci-report");
  // An absolute address, as the plan report has: the bucket's copy once reports.url says where the bucket is served, else the job's artifact.
  const given = artifactReportUrl(env);
  const links = reportLinks(report, { reports: settings.reports, ...(given ? { given } : {}), traceId: w.observer.trace?.traceId, traceUrl: settings.telemetry?.trace_url });
  Object.assign(report.run, links.run);
  w.observer.reportUrl = links.run.report_url;
  writeReportDir(dir, report, plans, links.note);
  if (w.costOutputs) writeCostFiles(dir, w.costOutputs);
  const slowest = report.timings?.roots[0];
  if (slowest) console.log(`wave ${wave}: report in terragucci-report/, slowest root ${slowest.root} (${slowest.seconds}s)`);
  if (settings.reports?.bucket && w.decided) {
    console.log(`wave ${wave}: the report stays with the job; the reports of its shares, which apply, go to ${settings.reports.bucket}`);
  } else if (settings.reports?.bucket) {
    try {
      const up = await uploadReport(storeFromEnv(settings.reports, env), dir, report, settings.reports.prefix);
      console.log(`wave ${wave}: report copied to ${up.prefix}${report.run.report_url ? `, at ${report.run.report_url}` : ""}`);
    } catch (e) {
      console.log(`wave ${wave}: the report was not copied to ${settings.reports.bucket}: ${(e as Error).message}`);
    }
  }
  // The run view: a share that applied adds itself to its wave's row; any other ending is the wave's state.
  if (w.state && w.share !== undefined) {
    await noteRunView(repo, options, w, w.state === "applied" ? { shares_applied: [w.share] } : { state: w.state });
  } else if (w.state) {
    const cmd = w.state === "waiting" && w.command ? { command: w.command } : {};
    await noteRunView(repo, options, w, { state: w.state, ...(w.approval ? { approval: w.approval } : {}), ...(w.digest ? { digest: w.digest } : {}), ...cmd, ...(w.shareCount ? { shares: w.shareCount } : {}), report: runPath(report) });
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

/**
 * The steps a wave runs: those in terragucci.yml at base (the base the wave
 * was given, else the applied commit's first parent), never the applied
 * commit's own, so a change cannot add a step that runs with the apply
 * credentials it is applied with. A base that cannot be read runs no steps
 * when the checkout names none, and fails the wave when it names some.
 */
async function waveSteps(repo: string, options: ApplyWaveOptions, configPath: string | undefined, checkout: StepSettings[] | undefined): Promise<{ ws?: WaveSteps } | { error: string }> {
  let base: string;
  try {
    base = waveStepsBase(repo, options.base);
  } catch (e) {
    if (!checkout?.length) return {};
    return { error: `steps are read from the config at base, and base could not be found (${(e as Error).message})` };
  }
  try {
    const read = await readSteps(repo, base, checkout, configPath ? { config: configPath } : {});
    if (read.note) console.log(read.note);
    const steps = stepsUsed(read.steps, "tf-apply");
    if (steps.length === 0) return {};
    console.log(`steps: ${steps.length} read from terragucci.yml at ${read.from.length === 40 ? read.from.slice(0, 8) : read.from}`);
    return { ws: { steps, env: options.env ?? process.env } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function runWave(repo: string, options: ApplyWaveOptions, work: string, w: WaveRun, facts: WaveFacts = {}): Promise<number> {
  const { wave, binary, gate } = options;
  if (!GATES.includes(gate)) throw new ConfigError(`--gate must be one of ${GATES.join(", ")}`);
  if (options.approval !== undefined && !APPROVALS.includes(options.approval)) throw new ConfigError(`--approval must be one of ${APPROVALS.join(", ")}`);
  if (!Number.isInteger(wave) || wave < 1) throw new ConfigError("--wave must be a wave number from 1");
  if (options.shares !== undefined && !(Number.isInteger(options.shares) && options.shares >= 1)) throw new ConfigError("--shares must be a whole number of 1 or more");
  if (options.share !== undefined && (options.shares === undefined || !Number.isInteger(options.share) || options.share < 1 || options.share > options.shares)) {
    throw new ConfigError("--share must be a share number from 1 to --shares");
  }
  // A state migration in the change runs before the first wave plans, behind its own gate (./migrate.ts); a share of a split wave leaves that to the wave's job.
  if (wave === 1 && options.share === undefined) {
    const held = await migrationsFirst(repo, options, w);
    if (held !== undefined) return held;
  }
  if (options.terragrunt) return runTerragruntWave(repo, options, work, w, facts);
  const waves = applyWaves(options.layers, options.canary);
  const whole = waves[wave - 1];
  if (!whole) {
    facts.nothing = true;
    console.log(`wave ${wave}: this repo has ${waves.length} waves, so there is nothing to apply`);
    return EXIT.applied;
  }
  const shares = options.shares !== undefined ? waveShares(whole, options.shares) : [whole];
  if (options.share !== undefined) return runShare(repo, options, work, w, facts, { whole, shares, count: waves.length });
  const roots = whole;
  facts.roots = roots;
  const label = `wave ${wave} of ${waves.length}`;
  console.log(`${label}: planning ${roots.join(", ")}`);
  const linked = waveReads(repo, waves, roots, wave);
  w.reads = linked.reads;
  w.waveReads = linked.waves;
  logReads(label, linked.reads, waves);
  const configPath = options.config ?? findConfig(repo);
  const read = await waveSettings(repo, options, configPath);
  if ("error" in read) {
    console.log(`${label}: ${read.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const settings = (w.settings = read.settings);
  const stepsRead = await waveSteps(repo, options, configPath, settings.steps);
  if ("error" in stepsRead) {
    console.log(`${label}: ${stepsRead.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const ws = stepsRead.ws;
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
  const binaries = new RootBinaries(repo, binary, settings.version, options.env ?? process.env, options.installer);
  await eachLimited(roots, limit.value, async (r, i) => {
    planned[i] = await planRoot(repo, binaries, r, work, i, w.observer, cache, ws);
  });
  w.plannedAt = new Date().toISOString();
  w.planned = planned;
  w.roots = roots;
  const failed = planned.filter((p) => p.error);
  for (const p of planned) console.log(p.error ? `FAILED ${p.root}: ${p.error.split("\n")[0]}` : `${p.root}: ${p.summary}`);
  if (failed.length > 0) {
    for (const p of failed) console.log(indent(p.error!));
    console.log(`${label}: ${failed.length} root${failed.length === 1 ? "" : "s"} failed to plan, so nothing in it was applied`);
    return EXIT.failed;
  }
  const unpriced = await priceWave(repo, options, { label, settings, configPath, work }, planned, w);
  if (unpriced !== undefined) return unpriced;
  const refusedByPolicy = await policyGate(repo, options, { label, settings, configPath }, planned, w);
  if (refusedByPolicy !== undefined) return refusedByPolicy;
  // The set digest covers the roots whose plan changes something, as a Terragrunt wave's and the plan note's do, so the digest a
  // pull request's note shows is the one this wave asks approval for when nothing moved.
  const all = planned.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1));
  const changing = new Set(planned.filter((p) => changesSomething(p.plan)).map((p) => p.root));
  w.changedRoots = [...changing].sort();
  // With cost.approve_above at base the wave's cost is one more member: an approval of these plans at one cost does not apply them at another.
  const priced = costMember(w.waveCost);
  const members = [...all.filter((m) => changing.has(m.member)), ...(priced && changing.size > 0 ? [priced] : [])];
  const digest = waveSetDigest(members.length > 0 ? members : [...all, ...(priced ? [priced] : [])]);
  const changes = planned.reduce((n, p) => n + p.changes, 0);
  const destroys = planned.reduce((n, p) => n + p.destroys, 0);
  console.log(`${label}: set digest ${digest}, ${changes} change${changes === 1 ? "" : "s"}, ${destroys} destroy${destroys === 1 ? "" : "s"}`);

  if (changes === 0) facts.nothing = true;
  const heldBySteps = planned.filter((p) => p.holds.length > 0).map((p) => p.root).sort();
  for (const p of planned) if (p.holds.length) console.log(`${label}: ${p.root}: step ${p.holds.join(", ")} asks for an approval, so the gate holds this wave${changes === 0 ? " when it changes something" : ""}`);
  if (heldBySteps.length) w.heldBySteps = heldBySteps;
  const held = await gateWave(repo, options, { label, roots, planned, members, digest, changes, destroys, heldBySteps }, facts, w);
  if (held !== undefined) return held;
  recordOverridesUsed(repo, options, planned);

  if (shares.length > 1) {
    // The share jobs apply: this job hands them the digest of every plan it decided on, and applies nothing itself.
    const env = options.env ?? process.env;
    const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    const decision: WaveDecision = {
      version: 1,
      wave,
      shares: shares.length,
      digest,
      approval: w.approval === "approved" ? "approved" : "not-required",
      changes,
      ...(commit ? { commit } : {}),
      members: all,
    };
    const file = options.decided ?? join(repo, decidedPath(wave));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify(decision, null, 2) + "\n");
    w.decided = true;
    w.shareCount = shares.length;
    for (const [i, share] of shares.entries()) console.log(`${label}: share ${i + 1} of ${shares.length} applies ${share.join(", ")}`);
    console.log(`${label}: ${changes === 0 ? "nothing to apply" : w.approval === "approved" ? "approved" : "no approval needed"}; its ${shares.length} share jobs apply these plans`);
    return EXIT.applied;
  }

  w.applyStarted = new Date().toISOString();
  if (changes > 0) await noteRunView(repo, options, w, { state: "applying", ...(w.approval ? { approval: w.approval } : {}), digest });
  // The roots of a wave do not read each other, so they apply together, as many at once as plan at once: each apply
  // starts its own provider, and a wave of a hundred roots started together runs the job out of memory.
  const ok: boolean[] = new Array(planned.length);
  await eachLimited(planned, limit.value, async (p, i) => {
    ok[i] = await applyRoot(repo, p, w.observer, ws);
  });
  w.applied = new Set(planned.filter((_, i) => ok[i]).map((p) => p.root));
  w.states = await recordStateVersions(repo, planned.filter((_, i) => ok[i]), limit.value);
  if (ok.includes(false)) {
    w.failed = planned.filter((_, i) => !ok[i]).map((p) => p.root);
    console.log(`${label}: an apply failed`);
    return EXIT.failed;
  }
  console.log(`${label} applied`);
  return EXIT.applied;
}

/**
 * The state version each root's backend holds now that the wave applied it:
 * read from the state object's metadata, never its body (./backend.ts), and
 * printed one line per root. A version that cannot be read is recorded as
 * unknown and never fails the wave.
 */
async function recordStateVersions(repo: string, applied: PlannedRoot[], limit: number): Promise<Map<string, ReportStateVersion>> {
  const out = new Map<string, ReportStateVersion>();
  await eachLimited(applied, limit, async (p) => {
    out.set(p.root, await stateVersion(join(repo, p.root), p.env));
  });
  logStateVersions(applied.map((p) => p.root), out);
  return out;
}

/**
 * Run the repo's state migrations that have not run (./migrate.ts), before
 * wave 1 plans: every later wave waits on wave 1, so no root applies against
 * a state a migration is about to rewrite. Returns the exit code when a
 * migration waits, is refused or fails; undefined to go on. Each record goes
 * to `terragucci-report/migrations/` and, with `reports.bucket`, to
 * `<prefix>/<project>/migrations/<name>.json`.
 */
async function migrationsFirst(repo: string, options: ApplyWaveOptions, w: WaveRun): Promise<number | undefined> {
  if (!existsSync(join(repo, MIGRATIONS_DIR))) return undefined;
  const env = options.env ?? process.env;
  const run = await runMigrations(repo, {
    binary: options.binary,
    env,
    // A Terragrunt unit is prepared by Terragrunt, and its binary then runs where Terragrunt runs it.
    ...(options.terragrunt ? { terragrunt: { ...(options.terragruntPath ? { path: options.terragruntPath } : {}), ...(options.terragruntExec ? { exec: options.terragruntExec } : {}) } } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.approval ? { approval: options.approval } : {}),
    ...(options.base ? { base: options.base } : {}),
    ...(options.config ? { config: options.config } : {}),
  });
  if (run.records.length > 0) await uploadMigrationRecords(repo, options, run.records, env);
  if (run.code === EXIT.applied) return undefined;
  const last = run.records[run.records.length - 1];
  if (run.command) w.command = run.command;
  const what = last ? `migration ${last.name}` : "a migration";
  writeOutcome(options.env, run.code === EXIT.waiting ? `${what} waits: ${run.command ?? ""}` : run.code === EXIT.refused ? `${what}: the states moved since it was approved` : `${what} failed`, w);
  console.log(`wave 1: ${what} did not apply, so no wave plans until it does`);
  return run.code;
}

/** Copy each migration record to the reports bucket, when the config names one. A copy that fails is logged. */
async function uploadMigrationRecords(repo: string, options: ApplyWaveOptions, records: MigrationRecord[], env: NodeJS.ProcessEnv): Promise<void> {
  const configPath = options.config ?? findConfig(repo);
  const read = await waveSettings(repo, options, configPath).catch(() => undefined);
  if (!read || "error" in read || !read.settings.reports?.bucket) return;
  const reports = read.settings.reports;
  const project = runFacts(repo, env, read.settings.forge).project;
  const store = storeFromEnv(reports, env);
  for (const r of records) {
    const key = [reports.prefix ?? "", project, "migrations", `${r.name}.json`].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
    try {
      await store.put(key, JSON.stringify(r, null, 2) + "\n", "application/json");
      console.log(`migration ${r.name}: record copied to ${store.location}/${key}`);
    } catch (e) {
      console.log(`migration ${r.name}: the record was not copied to ${reports.bucket}: ${(e as Error).message}`);
    }
  }
}

/**
 * One share of a wave split across jobs. The wave's job already planned every
 * root, ran the policy, decided the gate and recorded the approval it used;
 * this job plans its own share again and applies those plans only when each
 * has the digest the wave's job decided on. A share whose plans moved since
 * applies nothing (exit 4), as a wave whose plans moved after an approval.
 */
async function runShare(
  repo: string,
  options: ApplyWaveOptions,
  work: string,
  w: WaveRun,
  facts: WaveFacts,
  ctx: { whole: string[]; shares: string[][]; count: number },
): Promise<number> {
  const { wave, binary } = options;
  const share = options.share!;
  const roots = ctx.shares[share - 1];
  const label = `wave ${wave} of ${ctx.count}, share ${share} of ${ctx.shares.length}`;
  if (!roots) {
    facts.nothing = true;
    console.log(`wave ${wave} of ${ctx.count}: its ${ctx.whole.length} roots make ${ctx.shares.length} shares, so share ${share} has nothing to apply`);
    return EXIT.applied;
  }
  facts.roots = roots;
  w.share = share;
  const env = options.env ?? process.env;
  const decision = readDecision(options.decided ?? join(repo, decidedPath(wave)));
  const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  if (decision.wave !== wave || decision.shares !== ctx.shares.length || (decision.commit && commit && decision.commit !== commit)) {
    console.log(`${label}: the decision it was handed is for wave ${decision.wave} in ${decision.shares} shares${decision.commit ? ` at ${decision.commit.slice(0, 8)}` : ""}, not this one, so nothing in it was applied`);
    return EXIT.failed;
  }
  const decided = new Map(decision.members.map((m) => [m.member, m.planDigest]));
  const missing = roots.filter((r) => !decided.has(r));
  if (missing.length > 0) {
    console.log(`${label}: the wave's job decided on no plan of ${missing.join(", ")}, so nothing in it was applied`);
    return EXIT.failed;
  }
  w.digest = decision.digest;
  w.approval = decision.approval;
  if (decision.changes === 0) {
    facts.nothing = true;
    console.log(`${label}: the wave's plans change nothing, so there is nothing to apply`);
    return EXIT.applied;
  }
  console.log(`${label}: planning ${roots.join(", ")}`);
  const allWaves = applyWaves(options.layers, options.canary);
  const linked = waveReads(repo, allWaves, roots, wave);
  w.reads = linked.reads;
  w.waveReads = linked.waves;
  logReads(label, linked.reads, allWaves);
  const configPath = options.config ?? findConfig(repo);
  const read = await waveSettings(repo, options, configPath);
  if ("error" in read) {
    console.log(`${label}: ${read.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const settings = (w.settings = read.settings);
  const stepsRead = await waveSteps(repo, options, configPath, settings.steps);
  if ("error" in stepsRead) {
    console.log(`${label}: ${stepsRead.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const ws = stepsRead.ws;
  const limit = options.parallelism !== undefined ? { value: options.parallelism, reason: "--parallelism" } : rootsParallelism(repo, roots, settings, env);
  if (roots.length > 1) console.log(`${label}: planning ${limit.value === 1 ? "one root at a time" : `up to ${limit.value} roots at once`} (${limit.reason})`);
  const planned: PlannedRoot[] = new Array(roots.length);
  w.started = new Date().toISOString();
  await w.observer.collectSpans((l) => console.log(l));
  const cache = waveCache(work, process.env);
  const binaries = new RootBinaries(repo, binary, settings.version, options.env ?? process.env, options.installer);
  await eachLimited(roots, limit.value, async (r, i) => {
    planned[i] = await planRoot(repo, binaries, r, work, i, w.observer, cache, ws);
  });
  w.plannedAt = new Date().toISOString();
  w.planned = planned;
  w.roots = roots;
  w.changedRoots = planned.filter((p) => !p.error && changesSomething(p.plan)).map((p) => p.root).sort();
  for (const p of planned) console.log(p.error ? `FAILED ${p.root}: ${p.error.split("\n")[0]}` : `${p.root}: ${p.summary}`);
  const failed = planned.filter((p) => p.error);
  if (failed.length > 0) {
    for (const p of failed) console.log(indent(p.error!));
    console.log(`${label}: ${failed.length} root${failed.length === 1 ? "" : "s"} failed to plan, so nothing in it was applied`);
    return EXIT.failed;
  }
  // A step that asks for an approval holds the share unless the wave's job decided under one.
  const holding = planned.filter((p) => p.holds.length > 0).map((p) => p.root).sort();
  if (holding.length > 0 && decision.approval !== "approved") {
    w.heldBySteps = holding;
    console.log(`${label}: a step of ${holding.join(", ")} asks for an approval, and wave ${wave} decided without one, so nothing in this share was applied; run the pipeline again so the wave's job holds it at its gate`);
    writeOutcome(options.env, `wave ${wave} share ${share} held by a step of ${holding.join(", ")}`, w);
    return EXIT.refused;
  }
  const moved = planned.filter((p) => !samePlanDigest(decided.get(p.root), p.member!.planDigest)).map((p) => p.root).sort();
  if (moved.length > 0) {
    console.log(`${label}: these roots planned differently since wave ${wave} decided on ${decision.digest}: ${moved.join(", ")}`);
    console.log(`${label}: nothing in this share was applied; run the pipeline again to plan and decide the wave anew`);
    if (decision.approval === "approved") w.refused = { reason: "approval", approved: decision.digest, roots: moved };
    writeOutcome(options.env, `wave ${wave} share ${share} changed since the wave decided: ${moved.join(", ")}`, w);
    return EXIT.refused;
  }
  w.applyStarted = new Date().toISOString();
  const ok: boolean[] = new Array(planned.length);
  await eachLimited(planned, limit.value, async (p, i) => {
    ok[i] = await applyRoot(repo, p, w.observer, ws);
  });
  w.applied = new Set(planned.filter((_, i) => ok[i]).map((p) => p.root));
  w.states = await recordStateVersions(repo, planned.filter((_, i) => ok[i]), limit.value);
  if (ok.includes(false)) {
    w.failed = planned.filter((_, i) => !ok[i]).map((p) => p.root);
    console.log(`${label}: an apply failed`);
    return EXIT.failed;
  }
  console.log(`${label} applied`);
  return EXIT.applied;
}

/** What the policy and the gate read of a wave's plans: a plain root's, or a Terragrunt unit's. */
type WavePlan = Pick<PlannedRoot, "root" | "plan" | "member" | "error" | "policy"> & { bin?: ReportRootBinary; steps?: ReportStep[] };

/**
 * Price a wave's plans, with `cost` set (at the checkout or at base): the
 * estimator over each plan, redacted as the report keeps it, as tf-plan runs
 * it. `cost.approve_above` is read at base: `--base`, else the commit before
 * the one applied, so a change cannot raise the amount its own apply is
 * judged by. Leaves the figures on the wave for the policy, the gate and the
 * report. Returns the exit code when the amount cannot be read, so whether
 * the wave waits cannot be decided; undefined to go on. An estimate that
 * fails fails nothing; under an amount the wave then waits.
 */
async function priceWave(
  repo: string,
  options: ApplyWaveOptions,
  ctx: { label: string; settings: ResolvedSettings; configPath: string | undefined; work: string },
  planned: WavePlan[],
  w: WaveRun,
): Promise<number | undefined> {
  const { label, settings, configPath, work } = ctx;
  const env = options.env ?? process.env;
  const own = settings.cost;
  let base: string | undefined = options.base;
  if (!base) {
    try {
      base = baseCommit(repo);
    } catch (e) {
      if (approveAbove(own) !== undefined) {
        console.log(`${label}: cost.approve_above is read from the commit before this one, and ${(e as Error).message}, so nothing in it was applied`);
        writeOutcome(options.env, `wave ${options.wave}: cost.approve_above could not be read at base`, w);
        return EXIT.failed;
      }
    }
  }
  const rule = await costRule(repo, own, base, configPath ? { config: configPath } : {});
  if (rule.error) {
    console.log(`${label}: ${rule.error}, so whether it waits cannot be decided and nothing in it was applied`);
    writeOutcome(options.env, `wave ${options.wave}: cost.approve_above could not be read at base`, w);
    return EXIT.failed;
  }
  if (rule.note) console.log(`${label}: ${rule.note}`);
  if (!rule.setting) return undefined;
  const stored = planned.filter((p) => p.plan !== undefined).map((p) => ({ root: p.root, json: JSON.stringify(redactPlan(p.plan).plan) }));
  if (stored.length === 0) return undefined;
  const dir = mkdtempSync(join(work, "cost-"));
  const estimate = await estimateCosts(stored, costCommand(rule.setting), env, dir, repo, (l) => console.log(`${label}: ${l}`), options.costRunner);
  w.cost = estimate.cost;
  w.costOutputs = estimate.outputs;
  w.waveCost = waveCost(estimate.cost, planned.map((p) => p.root), rule.approveAbove);
  if (rule.source) w.costSource = rule.source;
  return undefined;
}

/**
 * What the wave's policy reads as `input.review`: the verdict the review job
 * kept as its artifact, in a run of the default branch's review workflow that
 * reviewed the head of the pull request this commit merged (or `TG_PR`'s,
 * applied before merge). Notes on the pull request are not read: any run's
 * token can post one. Nor is an artifact a run of the pull request's own
 * pipeline kept, which the pull request can edit. GitLab has no review job, and a
 * commit no pull request made has no review: both read as not found.
 */
async function waveReview(repo: string, env: NodeJS.ProcessEnv, options: ApplyWaveOptions, label: string, forge: string | undefined): Promise<PolicyReview> {
  if (env.GITLAB_CI === "true" || forge === "gitlab") return noReview();
  const on: "github" | "forgejo" = forge === "forgejo" || forge === "github" ? forge : env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" ? "forgejo" : "github";
  const sha = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  try {
    const f = forgeCalls(env, options.fetch);
    const pr = await pullOf(f, env, sha);
    if (!pr) {
      console.log(`${label}: review: no pull request made ${sha.slice(0, 8) || "this commit"}, so input.review has no review`);
      return noReview();
    }
    const { run, skipped, ...review } = await reviewOfPull(f, pr, artifactBytes(env, (options.fetch ?? fetch) as unknown as FetchBytes), on);
    for (const s of skipped) console.log(`${label}: review: skipped the review artifact of ${s.run === null ? "an unnamed run" : `run ${s.run}`}, since ${s.why}`);
    console.log(review.found
      ? `${label}: review: pull request ${pr.number}'s head ${pr.head.slice(0, 8)} was reviewed with risk ${review.risk} in run ${run} of the default branch's review workflow, which the policy reads as input.review`
      : `${label}: review: no run of the default branch's review workflow kept a review of pull request ${pr.number}'s head ${pr.head.slice(0, 8)}, so input.review.found is false`);
    return review;
  } catch (e) {
    console.log(`${label}: review: could not read the pull request's review (${(e as Error).message.split("\n")[0]}), so input.review.found is false`);
    return noReview();
  }
}

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
    // With cost on, each root's figures and its wave's: the policy reads the cost of what this wave applies.
    const cost = (root: string) => (w.cost ? { cost: policyCost(w.cost, root, w.waveCost ? { number: wave, cost: w.waveCost } : undefined, w.waveCost?.approve_above) } : {});
    // With review.agent on, the policy reads the review of the merged pull request's head as input.review.
    const review = settings.review?.agent ? await waveReview(repo, policyEnv, options, label, settings.forge) : undefined;
    const found = await checkPlans(repo, governing.policy, planned.map((p) => ({ path: p.root, plan: p.plan, ...cost(p.root) })), policyBaseRef, governing.trust, options.policy ?? {}, (l) => console.log(l), { stage: "tf-apply", project: runAt.project, commit: runAt.commit, ...(review ? { review } : {}) });
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
 * earlier plan or other rules that no wave applied: the changed-wave refusal.
 * An override a wave applied under refuses nothing.
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
    if (decision.status === "none" && decision.spent) {
      console.log(`${p.root}: the override of ${decision.spent.digest} by ${decision.spent.by} was used by the apply of that plan, so this plan needs an override of its own`);
    }
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
 * Record each override the wave is about to apply under, in
 * `_gates/policy-override/applied.jsonl`, so the root's next denial is not
 * refused for it (decideOverride). Written before anything applies, as the
 * approvals are; a record that cannot be pushed stops the wave.
 */
function recordOverridesUsed(repo: string, options: ApplyWaveOptions, applying: WavePlan[]): void {
  const used = applying.filter((p) => p.policy?.override);
  if (used.length === 0) return;
  const env = options.env ?? process.env;
  const now = options.now ?? new Date().toISOString();
  const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
  const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const records: AppliedRecord[] = used.map((p) => {
    const o = p.policy!.override!;
    return {
      version: 1,
      kind: "applied",
      op: OVERRIDE_OP,
      gate: p.root,
      planDigest: o.digest,
      approvedAt: o.at,
      approvedBy: o.by,
      timestamp: now,
      ...(runId ? { runId } : {}),
      ...(commit ? { commit } : {}),
    };
  });
  appendRecord(repo, records, {}, `Applied under override: ${OVERRIDE_OP} ${used.map((p) => p.root).join(", ")}`, appliedPathFor(OVERRIDE_LEDGER));
}

/**
 * Decide a wave's gate for the plans it just made. Returns the exit code
 * when the wave waits (3) or its plans changed after the approval (4);
 * undefined when it applies.
 */
async function gateWave(
  repo: string,
  options: ApplyWaveOptions,
  ctx: { label: string; roots: string[]; planned: WavePlan[]; members: WaveMember[]; digest: string; changes: number; destroys: number; heldBySteps?: string[] },
  facts: WaveFacts,
  w: WaveRun,
): Promise<number | undefined> {
  const { wave, binary, gate } = options;
  const { label, roots, planned, members, digest, changes, destroys } = ctx;
  let mode: Approval = "ledger";
  // A wave with nothing to change has nothing to approve. A step that asks for an approval, or a change over cost.approve_above at base, holds it whatever the gate policy says.
  const byGate = gate === "always" || (gate === "on-destroy" && destroys > 0) || (ctx.heldBySteps?.length ?? 0) > 0;
  const byCost = w.waveCost?.over === true;
  const gated = changes > 0 && (byGate || byCost);
  if (changes > 0 && byCost) console.log(`${label}: ${costReason(w.waveCost!, w.costSource)}, so it waits for an approval${byGate ? "" : ` although gate is ${gate}`}`);
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
      const priced = costMember(w.waveCost);
      const changesDigest = reviewDigest(planned.filter((p) => p.member).map((p) => ({ member: p.member!.member, planDigest: p.member!.planDigest, plan: p.plan })), priced ? [priced] : []);
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
      // The wait the approval ended: from the newest pending record of the gate made before it.
      const asked = ledger.pending.filter((p) => p.gate === name && at(p.timestamp) <= at(decision.at)).reduce<string | undefined>((a, p) => (!a || at(p.timestamp) > at(a) ? p.timestamp : a), undefined);
      if (asked) {
        w.gateSince = asked;
        w.approvedAt = decision.at;
      }
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
      w.gateSince = facts.waitingSince;
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
  /** The steps that ran in its directory. */
  steps?: ReportStep[];
  /** What it ran, when the unit pins a release (unit-pins.ts). */
  bin?: ReportRootBinary;
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
 * the set digest over the units whose plan changes something. With `cost`
 * set the plans are priced first, and with `cost.approve_above` at base the
 * wave's cost is one more member of the digest, as for plain roots. The gate
 * decides, as it decides a plain wave, and the wave applies exactly those
 * saved plans with one `run --all`, never planning anew. A unit whose plan
 * would read mock_outputs fails the wave: its upstream applies in an earlier
 * wave, so it has no outputs only when it lies outside the units.
 *
 * `steps:` run around the wave's `run --all`: each moment once for the wave,
 * in the directory of every unit a step's `roots` globs match (runUnitSteps).
 * Before init and before plan come before the plan, after plan after it with
 * each unit's saved plan, and before and after apply around the apply of the
 * units that change. A step that fails fails the wave, and one with
 * `on_failure: approve` holds it at its gate.
 *
 * With `waves.jobs` (`--shares`) a wave's units split across share jobs as a
 * plain wave's roots do (waveShares): this job plans every unit, prices,
 * runs the policy and decides the gate, then hands the plan digest of each
 * unit to the shares, which plan their units again with `run --all
 * --filter` and apply them only when each plan has the digest decided.
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
  w.units = { waves: cut, edges: unitEdges(found.units) };
  if (cut.length !== listed.length) {
    console.log(`wave ${wave}: Terragrunt's edges cut the pipeline's ${waves(listed.length)} into ${cut.length}; run terragucci init to give each wave its own job`);
  }
  const unlisted = found.units.map((u) => u.path).filter((u) => !listed.some((l) => l.includes(u)));
  if (unlisted.length > 0) console.log(`wave ${wave}: the pipeline does not list ${unlisted.join(", ")}, so no wave applies it; run terragucci init to add it`);
  const whole = cut[wave - 1];
  const deciding = options.shares !== undefined && options.share === undefined;
  if (!whole) {
    facts.nothing = true;
    console.log(`wave ${wave}: this repo has ${waves(cut.length)}, so there is nothing to apply`);
    // The share jobs read a decision whatever the wave came to.
    if (deciding) writeDecision(repo, options, { version: 1, wave, shares: 0, digest: "", approval: "not-required", changes: 0, members: [] });
    return EXIT.applied;
  }
  const shares = options.shares !== undefined ? waveShares(whole, options.shares) : [whole];
  let roots = whole;
  let label = `wave ${wave} of ${cut.length}`;
  let decision: WaveDecision | undefined;
  if (options.share !== undefined) {
    const share = options.share;
    const mine = shares[share - 1];
    if (!mine) {
      facts.nothing = true;
      console.log(`${label}: its ${whole.length} units make ${shares.length} share${shares.length === 1 ? "" : "s"}, so share ${share} has nothing to apply`);
      return EXIT.applied;
    }
    roots = mine;
    label = `${label}, share ${share} of ${shares.length}`;
    w.share = share;
    decision = readDecision(options.decided ?? join(repo, decidedPath(wave)));
    const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    if (decision.wave !== wave || decision.shares !== shares.length || (decision.commit && commit && decision.commit !== commit)) {
      console.log(`${label}: the decision it was handed is for wave ${decision.wave} in ${decision.shares} shares${decision.commit ? ` at ${decision.commit.slice(0, 8)}` : ""}, not this one, so nothing in it was applied`);
      return EXIT.failed;
    }
    const decided = new Set(decision.members.map((m) => m.member));
    const missing = roots.filter((r) => !decided.has(r));
    if (missing.length > 0) {
      console.log(`${label}: the wave's job decided on no plan of ${missing.join(", ")}, so nothing in it was applied`);
      return EXIT.failed;
    }
    w.digest = decision.digest;
    w.approval = decision.approval;
    if (decision.changes === 0) {
      facts.nothing = true;
      console.log(`${label}: the wave's plans change nothing, so there is nothing to apply`);
      return EXIT.applied;
    }
  }
  facts.roots = roots;
  console.log(`${label}: planning ${roots.join(", ")}`);
  const stepsRead = await waveSteps(repo, options, configPath, settings.steps);
  if ("error" in stepsRead) {
    console.log(`${label}: ${stepsRead.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const stepsRefused = terragruntStepsRefusal(stepsRead.ws?.steps);
  if (stepsRefused) {
    console.log(`${label}: ${stepsRefused}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const exec = unitLockTimeoutExec(options.terragruntExec ?? terragruntExec, env);
  const run = { dir: repo, binary, terragrunt, exec };
  w.started = new Date().toISOString();
  w.roots = roots;
  const planDir = join(work, "plan");
  // A unit that pins its binary or Terragrunt release runs it, installed here: one run --all per pair of releases, plan and apply alike.
  const unitTools = new UnitBinaries(repo, binary, settings.version, terragrunt, env, options.installer);
  const tools = new Map<string, UnitTools>();
  const pinned = unitTools.pinsAny(roots);
  {
    const bad: string[] = [];
    for (const u of roots) {
      try {
        const t = await unitTools.resolve(u);
        tools.set(u, t);
        if (t.report.pin || t.report.terragrunt?.pin) console.log(`${u}: ${binaryText(t.report)}`);
      } catch (e) {
        bad.push(u);
        console.log(`FAILED ${u}: ${(e as Error).message}`);
      }
    }
    if (bad.length > 0) {
      w.failed = bad;
      console.log(`${label}: a pinned release could not be installed, so nothing in it was planned or applied`);
      return EXIT.failed;
    }
  }
  const groups = groupUnits(roots, planDir, { terragrunt, binary }, pinned ? tools : undefined);
  const unitDir = (unit: string): string => dirOf(groups, unit, planDir);
  const savedPlan = (unit: string): string => join(unitDir(unit), "plans", unit, "tfplan.tfplan");
  // What each unit's steps came to, for the report; and the steps that hold the wave at its gate.
  const ran = new Map<string, ReportStep[]>();
  const holds = new Map<string, string[]>();
  const unitSteps = async (when: StepWhen, units: readonly string[], planFile?: (unit: string) => string): Promise<Map<string, string>> => {
    const failed = new Map<string, string>();
    if (!stepsRead.ws) return failed;
    const outcomes = await runUnitSteps(stepsRead.ws.steps, when, units, { repo, stage: "tf-apply", env: stepsRead.ws.env, log: (l) => console.log(l), ...(planFile ? { planFile } : {}) });
    for (const [unit, o] of outcomes) {
      ran.set(unit, [...(ran.get(unit) ?? []), ...o.runs]);
      if (o.holds.length) holds.set(unit, [...(holds.get(unit) ?? []), ...o.holds]);
      if (o.error) failed.set(unit, o.error);
    }
    return failed;
  };
  const stepsFailed = (failed: Map<string, string>, what: string): boolean => {
    if (failed.size === 0) return false;
    for (const [unit, error] of failed) {
      console.log(`FAILED ${unit}: ${error.split("\n")[0]}`);
      console.log(indent(error));
    }
    console.log(`${label}: ${what}`);
    return true;
  };
  // The wave plans with one run --all, so a step before init or plan runs before it for every unit.
  let before = await unitSteps("before-init", roots);
  if (before.size === 0) before = await unitSteps("before-plan", roots);
  if (stepsFailed(before, `a step before the plan failed, so nothing in it was planned or applied`)) {
    w.failed = [...before.keys()];
    return EXIT.failed;
  }
  let result: Awaited<ReturnType<typeof planTerragruntWave>>;
  try {
    result = await planWaveGroups(groups, { dir: repo, exec });
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
  for (const g of groups) for (const [unit, t] of unitTimes(join(g.workDir, "plan-report.json"))) w.observer.unitTimed(unit, (t.end - t.start) / 1000, t);
  const planned = new Map<string, PlannedUnit>();
  for (const part of result.parts) {
    const path = part.member.member;
    let plan: unknown;
    if (part.member.status !== "failed") {
      try {
        plan = JSON.parse(readFileSync(join(unitDir(path), "json", path, "tfplan.json"), "utf-8"));
      } catch {
        plan = undefined;
      }
    }
    const bin = tools.get(path)?.report;
    if (plan === undefined) {
      planned.set(path, { root: path, changes: 0, destroys: 0, outputs: false, error: part.member.error ?? "Terragrunt reported the unit planned but wrote no plan JSON for it", ...(bin ? { bin } : {}) });
      continue;
    }
    const changed = part.entries.filter((e) => e.action !== "no-op" && e.action !== "read");
    planned.set(path, {
      ...(bin ? { bin } : {}),
      root: path,
      plan,
      member: { member: path, planDigest: part.member.planDigest ?? "" },
      changes: changed.length,
      destroys: changed.filter((e) => e.action === "delete" || e.action === "replace").length,
      outputs: changesOutputs(plan),
    });
  }
  const units = roots.filter((r) => planned.has(r)).map((r) => planned.get(r)!);
  // The steps each unit ran, on the unit's row of the report, filled in as they run.
  for (const p of units) p.steps = ran.get(p.root) ?? [];
  w.plannedAt = new Date().toISOString();
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
  const afterPlan = await unitSteps("after-plan", roots, savedPlan);
  for (const p of units) {
    p.steps = ran.get(p.root) ?? [];
    if (afterPlan.has(p.root)) p.error = afterPlan.get(p.root);
  }
  if (stepsFailed(afterPlan, `a step after the plan failed, so nothing in it was applied`)) return EXIT.failed;
  const heldBySteps = [...holds.keys()].filter((u) => roots.includes(u)).sort();
  // A unit applies when its plan changes a resource or an output: a later wave reads the outputs.
  const changing = units.filter((p) => p.changes > 0 || p.outputs);
  const changes = changing.reduce((n, p) => n + p.changes, 0);
  const destroys = changing.reduce((n, p) => n + p.destroys, 0);
  w.changedRoots = changing.map((p) => p.root).sort();
  /** Apply the saved plans of the units that change, with the steps around them. */
  const applyUnits = async (): Promise<number> => {
    const beforeApply = await unitSteps("before-apply", changing.map((p) => p.root), savedPlan);
    for (const p of units) p.steps = ran.get(p.root) ?? [];
    if (stepsFailed(beforeApply, "a step before the apply failed, so nothing in it was applied")) {
      w.failed = [...beforeApply.keys()];
      return EXIT.failed;
    }
    // The saved plans, and nothing planned anew.
    w.applyStarted = new Date().toISOString();
    await noteRunView(repo, options, w, { state: "applying", ...(w.approval ? { approval: w.approval } : {}), ...(w.digest ? { digest: w.digest } : {}) });
    const applied = await applyWaveGroups(groups, changing.map((p) => p.root), { dir: repo, exec });
    console.log(applied.log.trim());
    const bad = applied.results.filter((r) => r.status !== "succeeded");
    // A unit with no change had nothing to apply; a changing one applied when Terragrunt says it succeeded.
    const succeeded = new Set(applied.results.filter((r) => r.status === "succeeded").map((r) => r.unit));
    w.applied = new Set(units.filter((p) => !changing.includes(p) || (applied.code === 0 && succeeded.has(p.root))).map((p) => p.root));
    w.states = await recordUnitStateVersions(repo, roots.filter((r) => w.applied!.has(r)), run, env);
    if (applied.code !== 0 || bad.length > 0) {
      for (const r of bad) console.log(`FAILED ${r.unit}: ${r.result}${r.error ? `: ${r.error}` : ""}`);
      w.failed = bad.map((r) => r.unit);
      console.log(`${label}: an apply failed`);
      return EXIT.failed;
    }
    for (const p of changing) console.log(`applied ${p.root}`);
    const afterApply = await unitSteps("after-apply", changing.map((p) => p.root));
    for (const p of units) p.steps = ran.get(p.root) ?? [];
    if (stepsFailed(afterApply, "applied, then a step after the apply failed")) {
      w.failed = [...afterApply.keys()];
      for (const [unit, error] of afterApply) planned.get(unit)!.error = error;
      return EXIT.failed;
    }
    console.log(`${label} applied`);
    return EXIT.applied;
  };

  if (decision) {
    // A share: the wave's job planned, priced, checked and gated every unit; this share applies only the plans it decided on.
    if (heldBySteps.length > 0 && decision.approval !== "approved") {
      w.heldBySteps = heldBySteps;
      console.log(`${label}: a step of ${heldBySteps.join(", ")} asks for an approval, and wave ${wave} decided without one, so nothing in this share was applied; run the pipeline again so the wave's job holds it at its gate`);
      writeOutcome(options.env, `wave ${wave} share ${options.share} held by a step of ${heldBySteps.join(", ")}`, w);
      return EXIT.refused;
    }
    const decided = new Map(decision.members.map((m) => [m.member, m.planDigest]));
    const moved = units.filter((p) => !samePlanDigest(decided.get(p.root), p.member!.planDigest)).map((p) => p.root).sort();
    if (moved.length > 0) {
      console.log(`${label}: these units planned differently since wave ${wave} decided on ${decision.digest}: ${moved.join(", ")}`);
      console.log(`${label}: nothing in this share was applied; run the pipeline again to plan and decide the wave anew`);
      if (decision.approval === "approved") w.refused = { reason: "approval", approved: decision.digest, roots: moved };
      writeOutcome(options.env, `wave ${wave} share ${options.share} changed since the wave decided: ${moved.join(", ")}`, w);
      return EXIT.refused;
    }
    if (changing.length === 0) {
      facts.nothing = true;
      w.applied = new Set(units.map((p) => p.root));
      w.states = await recordUnitStateVersions(repo, roots, run, env);
      console.log(`${label}: no changes`);
      console.log(`${label} applied`);
      return EXIT.applied;
    }
    return applyUnits();
  }

  const unpriced = await priceWave(repo, options, { label, settings, configPath, work }, units, w);
  if (unpriced !== undefined) return unpriced;
  const refusedByPolicy = await policyGate(repo, options, { label, settings, configPath }, units, w);
  if (refusedByPolicy !== undefined) return refusedByPolicy;
  const all = units.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1));
  const handOff = (digest: string): number => {
    // The share jobs apply: this job hands them the digest of every unit's plan it decided on, and applies nothing itself.
    const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    writeDecision(repo, options, {
      version: 1,
      wave,
      shares: shares.length,
      digest,
      approval: w.approval === "approved" ? "approved" : "not-required",
      // A unit whose plan changes only an output applies too, so it counts as a change.
      changes: changes + changing.filter((p) => p.changes === 0).length,
      ...(commit ? { commit } : {}),
      members: all,
    });
    w.decided = true;
    for (const [i, share] of shares.entries()) console.log(`${label}: share ${i + 1} of ${shares.length} applies ${share.join(", ")}`);
    console.log(`${label}: ${changing.length === 0 ? "nothing to apply" : w.approval === "approved" ? "approved" : "no approval needed"}; its ${shares.length} share job${shares.length === 1 ? "" : "s"} apply these plans`);
    return EXIT.applied;
  };
  if (changing.length === 0) {
    facts.nothing = true;
    if (deciding) {
      w.digest = waveSetDigest(all);
      w.approval = "not-required";
      return handOff(w.digest);
    }
    w.applied = new Set(units.map((p) => p.root));
    w.states = await recordUnitStateVersions(repo, roots, run, env);
    console.log(`${label}: no changes`);
    console.log(`${label} applied`);
    return EXIT.applied;
  }
  // With cost.approve_above at base the wave's cost is one more member: an approval of these plans at one cost does not apply them at another.
  const priced = costMember(w.waveCost);
  const members = [...changing.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1)), ...(priced ? [priced] : [])];
  const digest = waveSetDigest(members);
  console.log(`${label}: set digest ${digest} over the ${changing.length} unit${changing.length === 1 ? "" : "s"} that change, ${changes} change${changes === 1 ? "" : "s"}, ${destroys} destroy${destroys === 1 ? "" : "s"}`);
  for (const u of heldBySteps) console.log(`${label}: ${u}: step ${holds.get(u)!.join(", ")} asks for an approval, so the gate holds this wave`);
  if (heldBySteps.length) w.heldBySteps = heldBySteps;
  w.preview = await comparePreview({ repo, env: options.env ?? process.env, wave: options.wave, binary: options.binary, ...(options.fetch ? { fetch: options.fetch } : {}), units }, (l) => console.log(`${label}: ${l}`));
  const stop = await gateWave(repo, options, { label, roots: changing.map((p) => p.root), planned: changing, members, digest, changes: changes + changing.filter((p) => p.changes === 0).length, destroys, heldBySteps }, facts, w);
  if (stop !== undefined) return stop;
  recordOverridesUsed(repo, options, changing);
  if (deciding) return handOff(digest);
  return applyUnits();
}

/** One line per root or unit: where its state is, and its version or why there is none. */
function logStateVersions(roots: readonly string[], versions: Map<string, ReportStateVersion>): void {
  for (const root of roots) {
    const v = versions.get(root);
    if (!v) continue;
    const where = v.location ? ` ${v.location}` : "";
    console.log(`${root}: state${where}${v.version_id ? ` version ${v.version_id}` : `, versions ${v.versioning}${v.note ? ` (${v.note})` : ""}`}`);
  }
}

/**
 * The state version each unit's backend holds now that the wave applied it.
 * A unit's working directory is in Terragrunt's cache, so the backend comes
 * from its evaluated `remote_state` block (`terragrunt render --json`), and
 * the version from the state object's metadata, as for a plain root. A unit
 * with no `remote_state` and no `terraform.source` is its own working
 * directory, read as a plain root is. Anything else is recorded as unknown,
 * with why; nothing here fails the wave.
 */
async function recordUnitStateVersions(
  repo: string,
  units: readonly string[],
  run: { terragrunt: string; exec: TerragruntExec; binary: string },
  env: NodeJS.ProcessEnv,
): Promise<Map<string, ReportStateVersion>> {
  const out = new Map<string, ReportStateVersion>();
  await eachLimited([...units], 8, async (unit) => {
    const dir = join(repo, unit);
    const r = await run.exec(run.terragrunt, ["render", "--json", "--non-interactive", "--no-color", "--working-dir", unit], { cwd: repo, env: { TG_TF_PATH: run.binary, TG_NON_INTERACTIVE: "true" } });
    let rendered: { remote_state?: { backend?: unknown; config?: unknown } | null; terraform?: { source?: unknown } | null } | undefined;
    try {
      rendered = r.code === 0 ? JSON.parse(r.stdout) : undefined;
    } catch {
      rendered = undefined;
    }
    if (!rendered) {
      out.set(unit, { backend: "unknown", versioning: "unknown", note: `terragrunt render could not say the unit's backend (exit ${r.code}): ${(r.stderr || r.stdout).trim().split("\n").pop() ?? ""}` });
      return;
    }
    const backend = typeof rendered.remote_state?.backend === "string" && rendered.remote_state.backend ? rendered.remote_state.backend : undefined;
    if (backend) {
      const config = rendered.remote_state?.config && typeof rendered.remote_state.config === "object" ? (rendered.remote_state.config as Record<string, unknown>) : {};
      out.set(unit, await stateVersion(dir, env, undefined, { type: backend, config }));
      return;
    }
    if (typeof rendered.terraform?.source !== "string" || !rendered.terraform.source) {
      out.set(unit, await stateVersion(dir, env));
      return;
    }
    out.set(unit, { backend: "unknown", versioning: "unknown", note: "the unit names no remote_state block and runs from Terragrunt's cache, so its backend cannot be read" });
  });
  logStateVersions(units, out);
  return out;
}

/** Write the decision a wave split across jobs hands its shares. */
function writeDecision(repo: string, options: ApplyWaveOptions, decision: WaveDecision): void {
  const file = options.decided ?? join(repo, decidedPath(decision.wave));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(decision, null, 2) + "\n");
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
