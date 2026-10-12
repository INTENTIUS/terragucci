/**
 * `terragucci stage tf-apply --wave <k>`: one wave of a repo's apply, run by
 * the pipeline's wave-k job, for Terraform and OpenTofu roots, and with
 * `--terragrunt` for a Terragrunt repo's units. The wave runs on chant's op
 * waves: the job runs `chant run wave` (./chant-waves.ts), and chant calls
 * back into the job to plan the wave, to apply it and around its gate.
 *
 * The wave plans its roots now, after the waves before it applied (planRoots,
 * planUnits), and hands chant each root's plan digest, whether the plan
 * changes something and whether it destroys. chant takes the wave's set
 * digest over the plans that change something, the digest a pull request's
 * plan note shows for the wave when nothing moved since, and with
 * `cost.approve_above` at base the wave's cost is one more member of it. The
 * gate policy then decides whether the wave waits:
 *
 *   always          every wave with a change waits for an approval of its digest
 *   on-destructive  a wave waits when one of its plans destroys or replaces
 *   never           no wave waits
 *
 * A step with `on_failure: approve` that failed, or a change over
 * `cost.approve_above`, holds the wave whatever the policy says.
 *
 * The gate is `wave-<k>` under op `tf-apply` on the repo's `chant/lifecycle`
 * branch, the gate `chant approve` and `terragucci approve` write. An
 * approval of this digest lets the wave apply the plans it just made, and
 * nothing else. chant spends it: before the wave applies, one line in
 * `_gates/tf-apply/applied.jsonl` names the approval, and it never applies
 * another wave. An approval of other plans that no wave applied means the
 * plans moved after someone approved them: the wave applies nothing, names
 * the roots that moved and exits 4. With no approval chant records a pending
 * fact for the digest, carrying the commit and each root's plan digest, and
 * the wave keeps the report of its plans beside it and stops.
 *
 * Which approvals count is the `approval:` mode at base (./approval.ts),
 * which the spec chant reads at base carries: under `ledger`, the default,
 * any approval of the digest; under `sealed`, only one made with `chant
 * approve --sign` whose seal verifies against the signers file at base.
 * Under `pr-review` the wave records the merged pull request's approving
 * review of these plans before chant decides, and under `apply.point` the
 * decision point's answer (./point-gate.ts). Base is the commit before the
 * one being applied, or `--base`.
 *
 * A root the policy denies applies only under a recorded override of exactly
 * its plan and rules, by someone `policy.override` at base lists: chant
 * decides it through `@intentius/chant/override-gate`, records the denial an
 * override answers and spends the override before the apply.
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
 * gives at run time. It plans its units with one `run --all`, saving each
 * plan, and applies the saved plans with one `run --all` once the gate lets
 * it (planUnits). With `--rest` the job runs its wave and then every wave
 * after it, one by one, each behind its own gate: the pipeline's last job,
 * so a repo that grew a layer since init wrote the pipeline still applies it.
 *
 * A wave can spread across jobs (`waves.jobs`). With `--shares <n>` the
 * wave's job plans every root, runs the policy and decides the gate, but
 * applies nothing: chant's decision goes to `terragucci-wave/wave-<k>.json`
 * and the pipeline's share jobs apply. With `--share <s>` a job plans only
 * its share of the wave's roots, and applies them only when each plan has the
 * digest the wave's job decided on. A share whose plans moved since applies
 * nothing and exits 4. The gate and its records stay one per wave.
 *
 * Applies are kept apart per root, by the backend's state lock, except with
 * choudoufu, whose waves hold the resources their plans change (./apply-rows.ts)
 * once the gate let them through and before they apply. A resource another
 * run's apply holds makes a push's wave wait, then plan again once that run
 * let go; with `--on-held refuse` (the apply a comment starts) the wave exits
 * 5 naming that run. With `--stand-down` (a push's wave) a wave that finds a
 * newer push on its branch, once it may apply, applies nothing and exits 6:
 * the newer push applies the whole tree.
 *
 * Exit codes: 0 applied (or nothing to apply; for a wave split across jobs,
 * decided and its shares may apply); 1 a root failed, or the policy denied
 * one; 3 the wave waits for an approval; 4 the wave's plans changed after an
 * approval or a policy override no run applied, or a share's after its wave
 * decided; 5 another run's apply holds a resource it changes; 6 a newer push
 * superseded it.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpWaveDecision } from "@intentius/chant/op";
import { resolveGateRunLocator, type GateRunLocator } from "@intentius/chant/gate-resume-run";
import { waveSetDigest, type WaveMember } from "@intentius/chant/gated-waves";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { plannerForBinary, terraformChangeSetPart } from "@intentius/chant-lexicon-terraform/change-set";
import {
  applyTerragruntWave,
  planTerragruntWave,
  TerragruntMockRefusal,
  type TerragruntExec,
} from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { APPROVALS, ConfigError, findConfig, GATES, loadConfig, normalizeGate, resolveRepo, type Approval, type Gate, type GateName, type ResolvedSettings } from "./config";
import { estateOf, explicitOrder, globMatch, remoteStateReads, rootDependencies, rootOrder, rootStates } from "./detect";
import { detectShape } from "./shape";
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
import { binaryText, type ReportCost, type ReportPolicy, type ReportRead, type ReportRootBinary, type ReportRootPolicy, type ReportRecordVersions, type ReportStateVersion, type ReportWave, type ReportWaveCost, type WaveState } from "./report/schema";
import { RootBinaries, type Installer, type RootBinary } from "./pins";
import { approveAbove, costCommand, costMember, costReason, costRule, estimateCosts, policyCost, waveCost, writeCostFiles, type CostRunner } from "./report/cost";
import { artifactReportUrl, eachLimited, oneAtATime, reportLinks, rootCacheEnv, rootsParallelism, runFacts, unitTimes, type Turn } from "./report/stage";
import { uploadReport, writeReportDir } from "./report/store";
import { telemetryFromEnv } from "./telemetry";
import { version as VERSION } from "../package.json";
import { approvalRule, type ApprovalRule } from "./approval";
import { overrideCommand } from "./override";
import { approveCommand } from "./report/marker";
import type { Fetch } from "./forge";
import { changesSomething, forgeCalls, gitlabCalls, gitlabMergeRequestOf, pullOf, reviewDigest, reviewWave, type ReviewOutcome } from "./review";
import { gitlabReviewCalls, gitlabReviewOf } from "./gitlab-agent";
import { artifactBytes, noReview, reviewOfPull, type FetchBytes, type PolicyReview } from "./review-agent";
import { baseCommit, sealRefusal } from "./seal";
import type { WaveFacts } from "./report/wave-telemetry";
import { discoverUnits, refineWaves, unitEdges, walkUnits } from "./terragrunt";
import { applyWaveGroups, dirOf, groupUnits, planWaveGroups, UnitBinaries, type UnitTools } from "./unit-pins";
import { binaryEnv, terragruntExec } from "./binary-env";
import { backendBootstrap } from "./generate";
import { stateVersion, workspaceEnv, workspaceInit } from "./backend";
import { fillReads, upstreamOutputs, type UpstreamOutputs } from "./atmos";
import { rootRoleEnv } from "./roles";
import { MIGRATIONS_DIR, runMigrations, type MigrationHold, type MigrationRecord } from "./migrate";
import { readSteps, runSteps, runUnitSteps, stepsUsed, terragruntStepsRefusal, waveStepsBase, type StepWhen } from "./steps";
import { approvedChanges, coverRemainder, finishOf, stoppedApply, type ApprovedChange, type RootPlan } from "./remainder";
import { applyScope, describeHeld, forgeLiveness, heldBy, planRows, readRows, releaseRows, rowHolder, takeRows, type Liveness } from "./apply-rows";
import type { StepSettings } from "./config";
import type { ReportStep } from "./report/schema";
import { ApplyProgress, progressInterval, progressLine } from "./apply-progress";
import { readRecords, recordStoreOf } from "./cdf-records";
import { recordVersions, versionsLine } from "./cdf-history";
import { planAppliedChanges } from "./report/history";
import { answerLine, retractLine } from "./point-gate";
import type { GateAnswerRef } from "@intentius/chant/point-decision";
import { readCallFile, runChantWave, serveWave, specAtBase, waveCallArgv, waveExit, waveRecordPath, wavesSpec, writeSpec, type WaveCall, type WaveRequest } from "./chant-waves";

/** The op every wave gate is recorded under. */
export const APPLY_OP = "tf-apply";
/** The gate wave `k` waits on. */
export const waveGate = (wave: number): string => `wave-${wave}`;
/** The approval command a waiting wave prints, bound to the digest it planned, and under `approval: sealed` sealed with the approver's key. */
export const approveLine = (wave: number, digest: string, mode: Approval = "ledger"): string => approveCommand(wave, digest, mode === "sealed");

/** The migration files in a repo's migrations/. */

/** Exit codes of `stage tf-apply`. */
export const EXIT = { applied: 0, failed: 1, waiting: 3, refused: 4, held: 5, superseded: 6 } as const;
/** runWave's answer when the run it waited for let go: the wave plans again (applyOneWave). Never an exit code. */
const REPLAN = -1;

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
 * How many share jobs a wave's roots spread across with `jobs` jobs: as many
 * as there are jobs, never more than there are roots. chant cuts the roots,
 * sorted, into that many contiguous shares.
 */
export function shareCount(roots: readonly string[], jobs: number): number {
  return Math.max(1, Math.min(Math.floor(jobs), roots.length));
}

/** Where a split wave's job leaves its decision for the share jobs: the run's artifact of that name, chant's decision record. */
export const DECIDED_DIR = "terragucci-wave";
export const decidedPath = (wave: number): string => `${DECIDED_DIR}/wave-${wave}.json`;

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
  /** Where chant recorded the job that waits, in CI (a wave's, a migration's, a decision point's): what `chant run resume` starts again. */
  resume?: GateRunLocator;
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
  /** The decision point question the wave waits on, when the gate asks one (./point-gate.ts). */
  answer?: GateAnswerRef;
}

/** The run a pending fact names: its `runId`, or, for one chant's op waves recorded, the run of its `resume` locator. */
export const runOf = (p: Pick<PendingRecord, "runId" | "resume">): string | undefined => p.runId ?? p.resume?.run;

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
  /** The answer record the wave passed its gate on, when the gate asks a decision point (./point-gate.ts). */
  answer?: GateAnswerRef;
  approver?: { kind: "human" | "agent" };
}

/**
 * What a wave writes before it applies under an approval, in
 * `_gates/<op>/applied.jsonl` beside the ledger: the approval of
 * `planDigest`, made at `approvedAt`, was used. chant writes the `applied`
 * line of a wave's approval (its spend rule); a wave that applies per
 * resource writes a `changes` line beside it with the changes the approved
 * plans make, which chant's readers skip and terragucci's read as the same
 * apply. chant reads only the `.jsonl` files directly under `_gates/` as
 * ledgers, so `chant approve` never sees these lines.
 */
export interface AppliedRecord {
  version: 1;
  kind: "applied" | "changes";
  op: string;
  gate: string;
  planDigest: string;
  /** The approval's own timestamp, as the ledger holds it: every approval of this digest at or before it is spent. */
  approvedAt: string;
  approvedBy: string;
  timestamp: string;
  runId?: string;
  commit?: string;
  /** The run applying, as the rows name it (./apply-rows.ts), so the resume job can ask whether it is gone. */
  holder?: string;
  /** Each change the plans make, when every root that changes something applies per resource: a stopped apply resumes from them (./remainder.ts). */
  changes?: ApprovedChange[];
  /** The digest of the approved plans whose stopped apply this one resumes. */
  resumes?: string;
  /** On a `changes` line: where the apply runs, in CI, so `chant run resume` starts it again once that run is gone (chant#3858). */
  resume?: GateRunLocator;
}

/** How the apply an applied record with `changes` started ended, in the same file. A killed apply writes none. */
export interface FinishedRecord {
  version: 1;
  kind: "finished";
  op: string;
  gate: string;
  planDigest: string;
  /** The applied record's timestamp. */
  applied: string;
  result: "applied" | "failed";
  timestamp: string;
}

export interface GateLedger {
  pending: PendingRecord[];
  resolutions: ResolutionRecord[];
  /** The approvals a wave applied under; absent reads as none. */
  applied?: AppliedRecord[];
  /** How those applies ended, for the ones that recorded their changes. */
  finished?: FinishedRecord[];
}

/** The lines of an `applied.jsonl` file. Malformed lines are skipped. */
export function parseApplied(text: string): AppliedRecord[] {
  const out: AppliedRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.version === 1 && (r.kind === "applied" || r.kind === "changes") && typeof r.gate === "string" && typeof r.planDigest === "string" && typeof r.approvedAt === "string") out.push(r as unknown as AppliedRecord);
    } catch {
      continue;
    }
  }
  return out;
}

/** The finished lines of an `applied.jsonl` file. Malformed lines are skipped. */
export function parseFinished(text: string): FinishedRecord[] {
  const out: FinishedRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.version === 1 && r.kind === "finished" && typeof r.gate === "string" && typeof r.planDigest === "string" && typeof r.applied === "string" && (r.result === "applied" || r.result === "failed")) out.push(r as unknown as FinishedRecord);
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
  | { status: "waiting"; standing?: PendingRecord; spent?: { approved: string; by: string; at: string } }
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
  return { status: "waiting", ...(standing ? { standing } : {}), ...(used ? { spent: { approved: used.planDigest!, by: used.resolvedBy, at: used.timestamp } } : {}) };
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
  const text = applied.status === 0 ? applied.stdout : "";
  return { ...ledger, applied: parseApplied(text), finished: parseFinished(text) };
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
function appendRecord(repo: string, record: PendingRecord | ResolutionRecord | AppliedRecord | AppliedRecord[] | FinishedRecord, files: Record<string, string>, message: string, path: string = LEDGER_PATH): void {
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
  // No lines: only the files are written.
  const appending = lines.length > 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const exists = fetchLifecycle(repo);
    const parent = exists ? git(repo, ["rev-parse", REMOTE_REF]).stdout.trim() : "";
    const old = exists && appending ? git(repo, ["show", `${REMOTE_REF}:${path}`]) : undefined;
    // One record per line, each ending in a newline, so a line appended with `>>` stays its own record.
    const text = `${old && old.status === 0 && old.stdout.trim() ? `${old.stdout.replace(/\n$/, "")}\n` : ""}${line}\n`;
    const blob = appending ? git(repo, ["hash-object", "-w", "--stdin"], text).stdout.trim() : "";
    // A scratch index, so the checkout's own index is left alone.
    const scratch = mkdtempSync(join(tmpdir(), "terragucci-ledger-"));
    const env = { ...process.env, ...GIT_ID, GIT_INDEX_FILE: join(scratch, "index") };
    if (parent) git(repo, ["read-tree", parent], undefined, env);
    for (const [file, b] of [...(appending ? [[path, blob]] : []), ...Object.entries(files).map(([f, t]) => [f, git(repo, ["hash-object", "-w", "--stdin"], t).stdout.trim()])])
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
  /** The outputs of the instances an Atmos instance of the wave reads (./atmos.ts), each read once. */
  outputs: Map<string, Promise<UpstreamOutputs>>;
}

/**
 * The wave's roots share one provider cache: the job's `TF_PLUGIN_CACHE_DIR`,
 * or one of the wave's own. The cache is not safe for inits that run
 * together, so they take turns. A cache per root would download and unpack
 * each provider once per root, some 700 MB for the AWS provider, which a wave
 * of a hundred roots cannot hold on a runner's disk.
 */
function waveCache(work: string, env: NodeJS.ProcessEnv): WaveCache {
  return { dir: env.TF_PLUGIN_CACHE_DIR || mkdtempSync(join(work, "cache-")), initTurn: oneAtATime(), outputs: new Map() };
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
  // An Atmos instance names its workspace (./atmos.ts): it plans and applies there, not in default.
  const expected = binaries.expected(root);
  const env = rootCacheEnv(workspaceEnv(rootRoleEnv({ ...process.env, TF_PLUGIN_CACHE_DIR: cache.dir }, root), dir), dir, expected.name);
  const planFile = join(work, `${i}.tfplan`);
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
  const stepEnv = ws ? { ...ws, env: rootCacheEnv(workspaceEnv(rootRoleEnv({ ...ws.env, TF_PLUGIN_CACHE_DIR: cache.dir }, root), dir), dir, expected.name) } : undefined;
  let stepError = await rootSteps(repo, base, stepEnv, "before-init");
  if (stepError) return { ...base, error: stepError };
  const wsInit = workspaceInit(env, dir);
  const init = await cache.initTurn(() => timed(observer, timing, binary, ["init", "-input=false", "-no-color"], wsInit?.init ?? env, dir));
  if (init.code !== 0) return { ...base, error: `init failed\n${init.out}` };
  if (wsInit) {
    const sel = await timed(observer, timing, binary, wsInit.select, wsInit.selectEnv, dir);
    if (sel.code !== 0) return { ...base, error: `workspace select failed\n${sel.out}` };
  }
  // An Atmos instance that reads another's outputs plans on their values. Its upstreams applied in the waves before, so a missing one stops it.
  const filled = await fillReads(repo, root, (up) => {
    if (!cache.outputs.has(up)) {
      const upDir = join(repo, up);
      const upEnv = workspaceEnv(rootRoleEnv({ ...process.env, TF_PLUGIN_CACHE_DIR: cache.dir }, up), upDir);
      cache.outputs.set(up, binaries.resolve(up).then((b) => b.path, () => binary).then((b) => upstreamOutputs(b, upDir, upEnv, cache.initTurn)));
    }
    return cache.outputs.get(up)!;
  });
  if (filled.errors.length > 0) return { ...base, error: filled.errors.join("\n") };
  if (filled.waiting.length > 0) {
    return { ...base, error: `not planned: ${filled.waiting.map((w) => `it reads ${w.read.var} from ${w.read.upstream}, which ${w.why} (${w.read.function})`).join("; ")}; apply ${[...new Set(filled.waiting.map((w) => w.read.upstream))].join(", ")} first` };
  }
  for (const v of filled.filled) console.log(`${root}: ${v} read from the state its stacks name`);
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
  const stepEnv = ws ? { ...ws, env: workspaceEnv(rootRoleEnv({ ...ws.env, TF_PLUGIN_CACHE_DIR: p.env.TF_PLUGIN_CACHE_DIR }, p.root), join(repo, p.root)) } : undefined;
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

/** The tip of the branch a push's wave applies, when a newer push moved it past the commit the wave runs. */
function newerPush(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const branch = env.GITHUB_REF_NAME || env.CI_COMMIT_BRANCH;
  const sha = env.GITHUB_SHA || env.CI_COMMIT_SHA;
  if (!branch || !sha) return undefined;
  const r = git(repo, ["ls-remote", "origin", `refs/heads/${branch}`]);
  const tip = r.status === 0 ? r.stdout.split(/\s/)[0]?.trim() : "";
  return tip && tip !== sha ? tip : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hold the resources a wave's plans change, once its gate let it through
 * and before it applies (./apply-rows.ts), for the roots whose binary
 * applies per resource. Returns how to let them go, or the wave's answer
 * when it applies nothing: refused (5) when another run holds one and the
 * wave refuses, REPLAN when the run it waited for let go, superseded (6)
 * when a newer push is on the branch, failed after an hour's wait.
 */
async function holdRows(
  repo: string,
  options: ApplyWaveOptions,
  label: string,
  plans: { root: string; plan?: unknown; binary: string }[],
  w: WaveRun,
): Promise<{ code?: number; release: () => Promise<void> }> {
  const env = options.env ?? process.env;
  const free = { release: async () => {} };
  const standDown = (release: () => Promise<void>): Promise<{ code: number; release: () => Promise<void> }> | undefined => {
    const tip = options.standDown ? newerPush(repo, env) : undefined;
    if (!tip) return undefined;
    console.log(`${label}: a newer push to ${env.GITHUB_REF_NAME || env.CI_COMMIT_BRANCH} (${tip.slice(0, 8)}) applies everything; standing down`);
    w.refused = { reason: "superseded", roots: w.changedRoots ?? [] };
    writeOutcome(env, `superseded by a newer push`, w);
    return release().then(() => ({ code: EXIT.superseded, release: free.release }));
  };
  // shape: only a binary that applies per resource holds rows; the others rely on the backend's state lock.
  const rows = plans.filter((p) => p.plan && applyScope(p.binary) === "resource").flatMap((p) => planRows(p.root, estateOf(join(repo, p.root)).estate, p.plan));
  if (rows.length === 0) return (await standDown(free.release)) ?? free;
  // Outside a clone (no origin to hold them on) no other run can be told, so nothing is held.
  if (git(repo, ["remote", "get-url", "origin"]).status !== 0) {
    console.log(`${label}: this checkout has no origin, so nothing holds the resources it changes`);
    return free;
  }
  const keys = [...new Set(rows.map((r) => r.key))];
  const me = rowHolder(env);
  const alive = options.liveness ?? forgeLiveness(env);
  const poll = (Number(env.TG_LOCK_POLL) > 0 ? Number(env.TG_LOCK_POLL) : 10) * 1000;
  let waited = false;
  for (let tries = 0; ; tries++) {
    const r = await takeRows(repo, rows, me, alive);
    if (r.ok) {
      for (const h of r.tookOver) console.log(`${label}: run ${h.run} held resources and is gone; this wave takes them over, and each apply re-reads what that run left`);
      const n = new Set(rows.map((x) => `${x.root} ${x.address}`)).size;
      console.log(`${label}: holding ${n === 1 ? "the resource" : `the ${n} resources`} its plans change, as run ${me.run}`);
      const release = async () => {
        if (await releaseRows(repo, keys, me.run)) console.log(`${label}: let go of the resources it held`);
        else console.log(`${label}: could not let go of the resources it held; the next apply takes them over once this run is gone`);
      };
      return (await standDown(release)) ?? { release };
    }
    const line = describeHeld(r.held, rows);
    if (options.onHeld === "refuse") {
      console.log(`${label}: ${line}, so nothing in it was applied; apply again once that run is done`);
      const holder = r.held[0]!.holder;
      w.refused = { reason: "held", roots: [...new Set(r.held.map((h) => rows.find((x) => x.key === h.key)?.root ?? ""))].filter(Boolean).sort(), holder: { run: holder.run, ...(holder.url ? { url: holder.url } : {}) } };
      writeOutcome(env, `held: ${line}`, w);
      return { code: EXIT.held, release: free.release };
    }
    if (!waited) console.log(`${label}: ${line}; waiting for it`);
    waited = true;
    if (tries >= 360) {
      console.log(`${label}: another run has held resources this wave changes for an hour (${line}), so nothing in it was applied`);
      writeOutcome(env, `held for an hour: ${line}`, w);
      return { code: EXIT.failed, release: free.release };
    }
    await sleep(poll);
    // A run that let go may have changed what these plans were made against: plan again. One that is gone is taken over on the next try.
    const now = await heldBy(readRows(repo), keys, me.run, alive);
    if (now.live.length === 0 && now.gone.length === 0) return { code: REPLAN, release: free.release };
  }
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
  /** Set by `apply.branches`: the roots (units) the pipeline lists that another branch applies, which this push leaves alone. */
  elsewhere?: string[];
  /** What a wave does when another run's apply holds a resource it changes: wait for it (a push's wave, the default) or refuse at once (the apply a comment starts). */
  onHeld?: "wait" | "refuse";
  /** A push's wave: once it holds its resources, it stands down if a newer push is on its branch. */
  standDown?: boolean;
  /** Whether a run that holds resources is gone. Default: ask the forge (forgeLiveness). */
  liveness?: Liveness;
  /** The chant executable that runs the wave. Default: the bin of the @intentius/chant installed with terragucci. */
  chant?: string;
}

/** Run one wave, or with `rest` a Terragrunt repo's wave and the waves after it, on `chant run wave`. Returns the exit code; what happened is printed. */
export async function applyWave(repo: string, input: Omit<ApplyWaveOptions, "gate"> & { gate: GateName }): Promise<number> {
  // A pipeline rendered before on-destructive passes --gate on-destroy; the rest of the wave sees the policy's one name.
  const gate = normalizeGate(input.gate);
  if (gate === undefined) throw new ConfigError(`--gate must be one of ${GATES.join(", ")}`);
  let options: ApplyWaveOptions = { ...input, gate };
  if (options.approval !== undefined && !APPROVALS.includes(options.approval)) throw new ConfigError(`--approval must be one of ${APPROVALS.join(", ")}`);
  if (!Number.isInteger(options.wave) || options.wave < 1) throw new ConfigError("--wave must be a wave number from 1");
  if (options.shares !== undefined && !(Number.isInteger(options.shares) && options.shares >= 1)) throw new ConfigError("--shares must be a whole number of 1 or more");
  if (options.share !== undefined && (options.shares === undefined || !Number.isInteger(options.share) || options.share < 1 || options.share > options.shares)) {
    throw new ConfigError("--share must be a share number from 1 to --shares");
  }
  if (options.rest && !options.terragrunt) throw new ConfigError("--rest runs the waves of a Terragrunt repo, so it needs --terragrunt");
  if (options.branches && Object.keys(options.branches).length > 0) {
    // A Terragrunt repo's units map to branches by the same globs: the waves are then cut from the units this branch applies.
    const cut = branchLayers(options.layers, options.branches, options.branch || undefined);
    console.log(`wave ${options.wave}: ${cut.note}`);
    if (cut.layers.flat().length === 0) {
      console.log(`wave ${options.wave}: no ${options.terragrunt ? "unit" : "root"} applies from ${options.branch || "this branch"}, so there is nothing to apply`);
      return EXIT.applied;
    }
    const elsewhere = options.layers.flat().filter((r) => !cut.layers.flat().includes(r));
    options = { ...options, layers: cut.layers, branches: undefined, ...(elsewhere.length ? { elsewhere } : {}) };
  }
  return runWaves(repo, options);
}

/** One wave of this job, as chant's calls back into it fill it in. */
interface WaveJob {
  k: number;
  w: WaveRun;
  facts: WaveFacts;
  label: string;
  /** terragucci's own exit code for the wave, when one of its calls came to one: a non-zero exit of chant's takes it. */
  code?: number;
  /** Set once the wave planned: applies the plans it made of `targets`, the runs chant hands it. `outcome` is chant's CHANT_APPLY_OUTCOME. */
  apply?: (outcome: string | undefined, targets: ReadonlySet<string>) => Promise<number>;
  /** The hold the `held` hook reports: a step with on_failure: approve, or a change over cost.approve_above. */
  held?: boolean;
  /** Each denied root's policy error, for the report of a wave chant refused. */
  denials?: Map<string, string>;
  /** Who policy.override at base lists. */
  overriders?: string[];
  /** Under pr-review, the merged pull request's review of plans that moved since. */
  reviewMoved?: Extract<ReviewOutcome, { kind: "moved" }>;
  /** The digest of the stopped apply whose rest this one applies under its approval. */
  resumes?: string;
  /** The changes each applied plan makes, when the wave applies per resource: recorded beside the approval it applies under. */
  changes?: ApprovedChange[];
  /** The plans, for the stored report a waiting wave keeps. */
  stored?: () => string;
  /** The approval chant let the wave through under. */
  approvedBy?: string;
  approvedAt?: string;
}

/** What chant hands a wave-level call in `{runs}`. */
interface RunsFile {
  wave: string;
  number: number;
  digest?: string;
  discover?: true;
  runs: { target: string; op: string; planDigest?: string }[];
}

/**
 * The wave's job: render the op-waves spec and the base commit it is read
 * at, serve chant's calls, run `chant run wave` and map its exit code onto
 * terragucci's. Each wave this job ran writes its outcome and report once
 * chant is done.
 */
async function runWaves(repo: string, given: ApplyWaveOptions): Promise<number> {
  let options = given;
  const env = options.env ?? process.env;
  const work = mkdtempSync(join(tmpdir(), "terragucci-apply-"));
  const jobs = new Map<number, WaveJob>();
  const jobOf = (k: number): WaveJob => {
    let j = jobs.get(k);
    if (!j) {
      const facts: WaveFacts = {};
      const observer = new StageObserver(telemetryFromEnv(env), APPLY_OP, env);
      observer.wave = { number: k, facts };
      j = { k, w: { observer }, facts, label: `wave ${k}` };
      jobs.set(k, j);
    }
    return j;
  };
  let code: number = EXIT.failed;
  let last = options.wave;
  try {
    let specWaves: string[][] | number;
    if (options.terragrunt) {
      // Each wave finds its units at plan time. With --rest this job's wave is the last of the spec, and goes on through the waves terragrunt find gives.
      specWaves = options.rest ? options.wave : Math.max(options.layers.filter((l) => l.length > 0).length, options.wave);
    } else {
      const waves = applyWaves(options.layers, options.canary);
      if (!waves[options.wave - 1]) {
        jobOf(options.wave).facts.nothing = true;
        console.log(`wave ${options.wave}: this repo has ${waves.length} waves, so there is nothing to apply`);
        return (code = EXIT.applied);
      }
      specWaves = waves;
      // A wave of one root, or one job, applies in its own job; a share past the wave's roots has nothing to apply.
      if (options.shares !== undefined) {
        const count = shareCount(waves[options.wave - 1]!, options.shares);
        if (options.share !== undefined && options.share > count) {
          jobOf(options.wave).facts.nothing = true;
          console.log(`wave ${options.wave} of ${waves.length}: its ${waves[options.wave - 1]!.length} roots make ${count} share${count === 1 ? "" : "s"}, so share ${options.share} has nothing to apply`);
          return (code = EXIT.applied);
        }
        options = count > 1 ? { ...options, shares: count } : { ...options, shares: undefined, share: undefined };
      }
    }
    const configPath = options.config ?? findConfig(repo);
    const base = options.base ?? baseCommit(repo);
    // Which approvals count, as terragucci.yml, chant.workspace.json and the pipeline's --approval say at base.
    let rule: ApprovalRule | undefined;
    try {
      rule = await approvalRule(repo, { ...(options.base ? { at: options.base } : {}), ...(configPath ? { config: configPath } : {}), ...(options.approval ? { flag: options.approval } : {}) });
    } catch (e) {
      if (options.gate !== "never") throw e;
    }
    if (rule?.point && rule.mode !== "ledger") throw new ConfigError(`apply.point is set at base and approval is ${rule.mode}; a wave gate that asks a decision point takes its quorum from the point, so set approval to ledger or drop apply.point`);
    const ctx: WavesContext = { rule, configPath, work };
    const server = await serveWave(repo, work, (r) => waveCall(repo, options, ctx, r, jobOf));
    let ran: Awaited<ReturnType<typeof runChantWave>>;
    try {
      const spec = wavesSpec({
        waves: specWaves,
        ...(options.rest ? { rest: true } : {}),
        gate: options.gate,
        approval: rule?.mode ?? "ledger",
        ...(options.shares !== undefined ? { shares: { wave: options.wave, shares: options.shares } } : {}),
        call: waveCallArgv,
        migrations: existsSync(join(repo, MIGRATIONS_DIR)),
        ...(rule?.point ? { point: rule.point } : {}),
      });
      const at = specAtBase(repo, base, writeSpec(repo, spec));
      // A share job applies the plans its wave's job decided on: chant's record, which the pipeline hands over in the decision file.
      if (options.share !== undefined) {
        const file = options.decided ?? join(repo, decidedPath(options.wave));
        if (!existsSync(file)) throw new ConfigError(`the wave's decision ${file} cannot be read; the wave's own job writes it before its shares run`);
        mkdirSync(dirname(join(repo, waveRecordPath(options.wave))), { recursive: true });
        copyFileSync(file, join(repo, waveRecordPath(options.wave)));
      }
      ran = await runChantWave(repo, {
        wave: options.wave,
        base: at,
        ...(options.shares !== undefined && options.share === undefined ? { decide: true } : {}),
        ...(options.share !== undefined ? { share: options.share } : {}),
        env: { ...process.env, ...env },
        ...(options.chant ? { chant: options.chant } : {}),
      });
    } finally {
      await server.close();
    }
    const rest = ran.result?.rest;
    if (rest?.length) last = rest[rest.length - 1]!.wave;
    const j = jobOf(last);
    code = waveExit(ran.code, j.code);
    if (options.share !== undefined && ran.result?.decision) {
      // A share reports the gate its wave's job decided.
      j.w.digest = ran.result.decision.digest;
      if (ran.result.decision.status === "approved" || ran.result.decision.status === "not-required") j.w.approval = ran.result.decision.status;
    }
    if (options.share !== undefined && ran.code === EXIT.refused && ran.result?.moved.length) {
      const moved = [...ran.result.moved].sort();
      if (ran.result.decision?.status === "approved") j.w.refused = { reason: "approval", approved: ran.result.decision.digest, roots: moved };
      writeOutcome(options.env, `wave ${last} share ${options.share} changed since the wave decided: ${moved.join(", ")}`, j.w);
    }
    if (options.shares !== undefined && options.share === undefined && code === EXIT.applied) {
      // The share jobs apply: chant's decision goes to the decision file the pipeline hands them.
      const file = options.decided ?? join(repo, decidedPath(options.wave));
      mkdirSync(dirname(file), { recursive: true });
      copyFileSync(join(repo, waveRecordPath(options.wave)), file);
      j.w.decided = true;
      j.w.shareCount = options.shares;
      console.log(`${j.label}: ${ran.result?.decision?.status === "approved" ? "approved" : "no approval needed"}; its ${options.shares} share job${options.shares === 1 ? "" : "s"} apply these plans`);
    }
    return code;
  } finally {
    for (const k of [...jobs.keys()].sort((a, b) => a - b)) {
      const { w } = jobs.get(k)!;
      const c = k === last ? code : EXIT.applied;
      w.observer.wave!.code = c;
      writeOutcomeJson(env, k, c, w);
      w.state = waveState(c, w);
      w.ended = new Date().toISOString();
      // The report is written once the wave's roots planned, whatever came of the gate and the apply.
      if (w.planned) await writeWaveReport(repo, options, w as Required<WaveRun>, env).catch((e) => console.log(`wave ${k}: the report was not written: ${(e as Error).message}`));
    }
    rmSync(work, { recursive: true, force: true });
  }
}

/** What every call of a wave's job reads. */
interface WavesContext {
  /** The approval rule at base; unset only under gate: never when it could not be read. */
  rule?: ApprovalRule;
  configPath?: string;
  work: string;
}

/** One call chant makes back into the wave's job. Returns the call's exit code. */
async function waveCall(repo: string, options: ApplyWaveOptions, ctx: WavesContext, r: WaveRequest, jobOf: (k: number) => WaveJob): Promise<number> {
  const [what, runsPath, plansPath] = r.args as [WaveCall, string | undefined, string | undefined];
  const runs = readCallFile<RunsFile>(r.cwd, runsPath);
  const j = jobOf(runs?.number ?? options.wave);
  switch (what) {
    case "plan": {
      if (!runs || !plansPath) throw new Error("chant called the plan with no runs file");
      if (j.apply || j.w.planned) {
        // The run this wave waited for let go: what it applied may be what these plans were made against, so the wave plans again.
        console.log(`wave ${j.k}: the run it waited for let go; planning again`);
        const observer = j.w.observer;
        j.w = { observer };
        for (const key of Object.keys(j.facts)) delete (j.facts as Record<string, unknown>)[key];
        for (const key of ["code", "apply", "held", "denials", "overriders", "reviewMoved", "resumes", "changes", "stored"] as const) delete j[key];
      }
      const plans = join(r.cwd, plansPath);
      const c = options.terragrunt ? await planUnits(repo, options, ctx, j, runs, plans) : await planRoots(repo, options, ctx, j, runs, plans);
      if (c !== 0) j.code = c;
      return c;
    }
    case "apply":
      if (!j.apply) {
        console.log(`${j.label}: chant asked to apply a wave this job did not plan`);
        return EXIT.failed;
      }
      // chant applies the runs it hands over: a share job leaves out the ones whose plans moved since its wave decided.
      return j.apply(r.env.CHANT_APPLY_OUTCOME ? join(r.cwd, r.env.CHANT_APPLY_OUTCOME) : undefined, new Set((runs?.runs ?? []).map((x) => x.target)));
    case "hold":
      return j.held ? 1 : 0;
    case "migrate-check":
    case "migrate":
      return migrationCall(repo, options, j, what === "migrate" ? r.env : undefined, r.cwd);
    case "gate":
      return gateCall(repo, options, ctx, j, r.env, r.cwd);
    default:
      console.log(`terragucci: chant made a call this wave does not know: ${what}`);
      return EXIT.failed;
  }
}

/** Tell chant how an apply that applied nothing came out, when it was not a failure. */
function applyOutcome(path: string | undefined, o: { outcome: "stood-down" | "held" | "replan"; reason?: string; holder?: { run: string; url?: string } }): void {
  if (path) writeFileSync(path, JSON.stringify(o) + "\n");
}

/** What a wave run leaves for its report. */
export interface WaveRun {
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
  /** Each applied choudoufu root's record versions, by the address its apply changed, by root. */
  recordVersions?: Map<string, Map<string, ReportRecordVersions>>;
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
  /** The applied record that named each change its apply makes: the apply records how it ended beside it. */
  appliedUnder?: AppliedRecord;
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
  if (code === EXIT.refused || code === EXIT.held || code === EXIT.superseded || w.refused?.reason === "policy") return "refused";
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

/** The waves a wave's roots follow: `reads`, and the waves of the roots `waves.after` puts before them. */
function afterWaves(repo: string, settings: ResolvedSettings, options: Pick<ApplyWaveOptions, "layers" | "canary">, roots: readonly string[], reads: number[], wave: number): number[] {
  const after = detectShape(repo, settings).after;
  if (!after) return reads;
  const waves = applyWaves(options.layers, options.canary);
  const waveOf = new Map(waves.flatMap((w, i) => w.map((r) => [r, i + 1] as const)));
  const order = explicitOrder(after, options.layers.flat());
  const ups = roots.flatMap((r) => [...(order.get(r) ?? [])]);
  return [...new Set([...reads, ...wavesOf(waveOf, ups, wave)])].sort((a, b) => a - b);
}

/** For each plain root `waves.after` orders, the roots it puts before it. */
function plainDependencies(repo: string, settings: ResolvedSettings, roots: string[]): Map<string, string[]> | undefined {
  const order = explicitOrder(detectShape(repo, settings).after, roots);
  return order.size ? new Map([...order].map(([r, ups]) => [r, [...ups].sort()])) : undefined;
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
async function noteRunView(repo: string, options: ApplyWaveOptions, w: WaveRun, row: Partial<RunWave>, quiet = false): Promise<void> {
  const settings = w.settings;
  if (!settings?.reports?.bucket) return;
  const env = options.env ?? process.env;
  try {
    const facts = runFacts(repo, env, settings.forge);
    // A Terragrunt repo's waves and edges are the ones the wave cut from terragrunt find; before it did, the units' files give the edges.
    const waves = options.terragrunt ? (w.units?.waves ?? options.layers) : applyWaves(options.layers, options.canary);
    const reads = options.terragrunt ? (w.units?.edges ?? unitEdges(walkUnits(repo, w.settings?.terragrunt?.exclude))) : rootOrder(repo, options.layers.flat(), detectShape(repo, settings).after);
    const states = options.terragrunt ? new Map() : rootStates(repo, options.layers.flat());
    const skeleton = runSkeleton(facts.project, facts.commit, waves, reads, states);
    const spans = waveSpans(w);
    const timing = { ...(spans.length ? { spans } : {}), ...(w.changedRoots ? { changed: w.changedRoots } : {}) };
    const key = await updateRunView(storeFromEnv(settings.reports, env), settings.reports.prefix, skeleton, { number: options.wave, gate: waveGate(options.wave), policy: options.gate, ...timing, ...row });
    if (!quiet) console.log(`wave ${options.wave}: run view at ${key}`);
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
  // A plain root's: the roots waves.after puts before it.
  const unitDeps = options.terragrunt ? new Map(walkUnits(repo, settings.terragrunt?.exclude).map((u) => [u.path, u.dependencies])) : plainDependencies(repo, settings, options.layers.flat());
  const report = buildReport({
    run: { ...runFacts(repo, env, settings.forge), stage: APPLY_OP, wave, ...(w.share !== undefined ? { share: w.share } : {}), binary, runtime: settings.runtime, started: w.started, finished: new Date().toISOString(), terragucci: VERSION },
    roots: w.planned.map((p) => {
      const policy = p.policy ? { policy: p.policy } : {};
      // A root the policy refused keeps its plan, so the report shows what it would have changed.
      const steps = p.steps?.length ? { steps: p.steps } : {};
      const deps = unitDeps?.get(p.root)?.length ? { dependencies: unitDeps.get(p.root) } : {};
      if (p.error && !(p.policy && p.policy.result !== "passed" && p.plan !== undefined)) return { path: p.root, planner: plannerForBinary(binary), ...(p.bin ? { binary: p.bin } : {}), error: p.error.split("\n")[0], ...policy, ...steps, ...deps };
      const state = w.states?.get(p.root);
      const versions = w.recordVersions?.get(p.root);
      const reads = w.reads?.get(p.root)?.length ? { reads: w.reads.get(p.root) } : {};
      return { path: p.root, plan: p.plan, planner: plannerForBinary(binary), ...(p.bin ? { binary: p.bin } : {}), files: { json: planFiles(p.root).json }, ...(p.error ? { error: p.error } : {}), ...policy, ...steps, ...reads, ...(w.applied?.has(p.root) ? { applied: true } : {}), ...(state ? { state } : {}), ...(versions ? { recordVersions: versions } : {}), ...deps };
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

/** What `planWave` writes to `{plans}`, as chant reads it. */
interface PlansFile {
  runs: { target: string; planDigest: string; empty?: boolean; destructive?: boolean; denied?: { rules: string[]; reason?: string } }[];
  /** Digest members that are no root: the wave's cost under cost.approve_above. */
  members?: WaveMember[];
  /** A Terragrunt repo: how many waves `terragrunt find` gave. */
  waves?: number;
  pending?: Record<string, unknown>;
  overriders?: string[];
}

function writePlans(path: string, plans: PlansFile): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(plans, null, 2) + "\n");
}

/** A plans file entry for a root's plan, with the policy's denial when chant decides whether an override lets it through. */
const planEntry = (root: string, planDigest: string, empty: boolean, destroys: number, denied?: { rules: string[]; reason?: string }): PlansFile["runs"][number] => ({
  target: root,
  planDigest,
  ...(empty ? { empty: true } : {}),
  ...(destroys > 0 ? { destructive: true } : {}),
  ...(denied ? { denied } : {}),
});

/**
 * Plan a plain wave's roots for chant (`planWave`): the roots of its runs
 * file, or of a share job's slice. The wave's job also prices them, runs the
 * policy and works out what holds the wave; a share job plans its slice
 * alone, and chant applies only the plans its wave's job decided on.
 * Returns 0 once `{plans}` is written; the exit code when the wave stops.
 */
async function planRoots(repo: string, options: ApplyWaveOptions, ctx: WavesContext, j: WaveJob, runs: RunsFile, plansPath: string): Promise<number> {
  const { binary, gate } = options;
  const { w, facts, k: wave } = j;
  const waves = applyWaves(options.layers, options.canary);
  const roots = runs.runs.map((r) => r.target);
  const share = options.share;
  const label = (j.label = share !== undefined ? `wave ${wave} of ${waves.length}, share ${share} of ${options.shares}` : `wave ${wave} of ${waves.length}`);
  if (share !== undefined) w.share = share;
  if (roots.length === 0) {
    facts.nothing = true;
    console.log(`${label}: the wave's roots make fewer shares than ${options.shares}, so this one has nothing to apply`);
    writePlans(plansPath, { runs: [] });
    j.apply = async () => EXIT.applied;
    return EXIT.applied;
  }
  facts.roots = roots;
  console.log(`${label}: planning ${roots.join(", ")}`);
  const linked = waveReads(repo, waves, roots, wave);
  w.reads = linked.reads;
  w.waveReads = linked.waves;
  logReads(label, linked.reads, waves);
  const { configPath, work } = ctx;
  const read = await waveSettings(repo, options, configPath);
  if ("error" in read) {
    console.log(`${label}: ${read.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const settings = (w.settings = read.settings);
  w.waveReads = afterWaves(repo, settings, options, roots, w.waveReads ?? [], wave);
  const stepsRead = await waveSteps(repo, options, configPath, settings.steps);
  if ("error" in stepsRead) {
    console.log(`${label}: ${stepsRead.error}, so nothing in it was applied`);
    return EXIT.failed;
  }
  const ws = stepsRead.ws;
  const limit = options.parallelism !== undefined ? { value: options.parallelism, reason: "--parallelism" } : rootsParallelism(repo, roots, settings, options.env ?? process.env);
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
  const deciding = share === undefined;
  const denied = new Map<string, { rules: string[]; reason?: string }>();
  if (deciding) {
    const unpriced = await priceWave(repo, options, { label, settings, configPath, work }, planned, w);
    if (unpriced !== undefined) return unpriced;
    const checked = await policyCheck(repo, options, ctx, { label, settings }, planned, j);
    if (typeof checked === "number") return checked;
    for (const [root, d] of checked) denied.set(root, d);
  }
  // The set digest covers the roots whose plan changes something, as a Terragrunt wave's and the plan note's do, so the digest a
  // pull request's note shows is the one this wave asks approval for when nothing moved. chant takes it over the plans that are not empty.
  const all = planned.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1));
  const changing = new Set(planned.filter((p) => changesSomething(p.plan)).map((p) => p.root));
  w.changedRoots = [...changing].sort();
  // With cost.approve_above at base the wave's cost is one more member: an approval of these plans at one cost does not apply them at another.
  const priced = deciding ? costMember(w.waveCost) : undefined;
  const members = [...all.filter((m) => changing.has(m.member)), ...(priced && changing.size > 0 ? [priced] : [])];
  const digest = waveSetDigest([...(changing.size > 0 ? all.filter((m) => changing.has(m.member)) : all), ...(priced ? [priced] : [])]);
  const changes = planned.reduce((n, p) => n + p.changes, 0);
  const destroys = planned.reduce((n, p) => n + p.destroys, 0);
  console.log(`${label}: set digest ${digest}, ${changes} change${changes === 1 ? "" : "s"}, ${destroys} destroy${destroys === 1 ? "" : "s"}`);
  if (changes === 0) facts.nothing = true;
  const heldBySteps = planned.filter((p) => p.holds.length > 0).map((p) => p.root).sort();
  for (const p of planned) if (p.holds.length) console.log(`${label}: ${p.root}: step ${p.holds.join(", ")} asks for an approval, so the gate holds this wave${changes === 0 ? " when it changes something" : ""}`);
  if (heldBySteps.length) w.heldBySteps = heldBySteps;
  // A step that asks for an approval, or a change over cost.approve_above at base, holds the wave whatever the gate policy says.
  const byGate = gate === "always" || (gate === "on-destructive" && destroys > 0) || heldBySteps.length > 0;
  const byCost = w.waveCost?.over === true;
  if (changes > 0 && byCost) console.log(`${label}: ${costReason(w.waveCost!, w.costSource)}, so it waits for an approval${byGate ? "" : ` although gate is ${gate}`}`);
  j.held = changes > 0 && (heldBySteps.length > 0 || byCost);
  const plans = planned.map((p) => ({ root: p.root, plan: p.plan, binary: p.bin.name ?? p.binary }));
  w.digest = digest;
  if (deciding) {
    const gated = changes > 0 && (byGate || byCost);
    if (gated) {
      const stop = await beforeGate(repo, options, ctx, j, { label, digest, planned, plans, resume: options.shares === undefined, members, roots });
      if (stop !== undefined) return stop;
    }
    if (changes === 0 && options.shares === undefined && (gate !== "never" || w.waveCost)) closeStopped(repo, label, wave, options.now);
    j.changes = options.shares === undefined ? approvedChanges(plans) : undefined;
    j.stored = () => storedWaveReport(repo, options, wave, digest, roots, planned);
  }
  const env = options.env ?? process.env;
  const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  writePlans(plansPath, {
    runs: planned.map((p) => planEntry(p.root, p.member!.planDigest, !changing.has(p.root), p.destroys, denied.get(p.root))),
    ...(priced ? { members: [priced] } : {}),
    pending: { description: `${label}: ${roots.join(", ")}`, ...(commit ? { commit } : {}), members },
    ...(j.overriders ? { overriders: j.overriders, overridersSource: "policy.override" } : {}),
  });

  j.apply = async (outcome, targets) => {
    if (!deciding && changes === 0) {
      console.log(`${label}: its plans change nothing, so there is nothing to apply`);
      return EXIT.applied;
    }
    const applying = planned.filter((p) => targets.has(p.root));
    const hold = await holdRows(repo, options, label, plans.filter((p) => targets.has(p.root)), w);
    if (hold.code !== undefined) return heldOutcome(j, hold.code, outcome);
    w.applyStarted = new Date().toISOString();
    if (changes > 0) await noteRunView(repo, options, w, { state: "applying", ...(w.approval ? { approval: w.approval } : {}), digest });
    recordChanges(repo, label, j, options.now);
    // The roots of a wave do not read each other, so they apply together, as many at once as plan at once: each apply
    // starts its own provider, and a wave of a hundred roots started together runs the job out of memory.
    const ok: boolean[] = new Array(applying.length);
    const progress = changes > 0 ? await watchProgress(repo, options, w, label, applying) : undefined;
    try {
      await eachLimited(applying, limit.value, async (p, i) => {
        await progress?.phase(p.root, "applying");
        ok[i] = await applyRoot(repo, p, w.observer, ws);
        await progress?.phase(p.root, ok[i] ? "applied" : "failed");
      });
    } finally {
      await progress?.stop();
      await hold.release();
    }
    finishApplied(repo, label, w, ok.includes(false) ? "failed" : "applied", options.now);
    w.applied = new Set(applying.filter((_, i) => ok[i]).map((p) => p.root));
    w.states = await recordStateVersions(repo, applying.filter((_, i) => ok[i]), limit.value);
    w.recordVersions = await listRecordVersions(repo, applying.filter((_, i) => ok[i]), limit.value);
    if (ok.includes(false)) {
      w.failed = applying.filter((_, i) => !ok[i]).map((p) => p.root);
      console.log(`${label}: an apply failed`);
      return (j.code = EXIT.failed);
    }
    console.log(`${label} applied`);
    return EXIT.applied;
  };
  return EXIT.applied;
}

/**
 * An apply that held its resources came back without applying (holdRows):
 * tell chant why, so it plans again, or ends the wave as stood down (6) or
 * held by another run (5) rather than failed.
 */
function heldOutcome(j: WaveJob, code: number, outcome: string | undefined): number {
  if (code === REPLAN) {
    applyOutcome(outcome, { outcome: "replan", reason: "the run it waited for let go" });
    return EXIT.applied;
  }
  if (code === EXIT.superseded) applyOutcome(outcome, { outcome: "stood-down", reason: "a newer push applies everything" });
  if (code === EXIT.held && j.w.refused?.holder) applyOutcome(outcome, { outcome: "held", holder: j.w.refused.holder });
  return (j.code = code);
}

/**
 * Under an approval, before the apply: record each change the approved plans
 * make, when every root that changes something applies per resource, so a
 * stopped apply resumes from them (./remainder.ts). chant records the
 * approval as used (`_gates/tf-apply/applied.jsonl`); this line beside it
 * carries the changes. A record that cannot be pushed stops the wave.
 */
function recordChanges(repo: string, label: string, j: WaveJob, now?: string): void {
  const { w } = j;
  if (w.approval !== "approved" || !j.changes || !w.digest || !j.approvedBy || !j.approvedAt) return;
  const env = process.env;
  const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
  const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const locator = resolveGateRunLocator(env);
  const record: AppliedRecord = {
    version: 1,
    kind: "changes",
    op: APPLY_OP,
    gate: waveGate(j.k),
    planDigest: w.digest,
    approvedAt: j.approvedAt,
    approvedBy: j.approvedBy,
    timestamp: now ?? new Date().toISOString(),
    ...(runId ? { runId } : {}),
    ...(commit ? { commit } : {}),
    holder: rowHolder(env).run,
    ...(locator ? { resume: locator } : {}),
    changes: j.changes,
    ...(j.resumes ? { resumes: j.resumes } : {}),
  };
  appendRecord(repo, record, {}, `Changes approved: ${APPLY_OP} ${record.gate}`, APPLIED_PATH);
  w.appliedUnder = record;
  console.log(`${label}: ${j.changes.length} change${j.changes.length === 1 ? "" : "s"} recorded beside the approval, so a stopped apply resumes from them`);
}

/** The report of a wave's plans, as a waiting wave keeps it beside its pending fact and respond wave-refused reads it. */
function storedWaveReport(repo: string, options: ApplyWaveOptions, wave: number, digest: string, roots: string[], planned: WavePlan[]): string {
  const env = options.env ?? process.env;
  const now = new Date().toISOString();
  return JSON.stringify(buildReport({
    run: { ...runFacts(repo, env), stage: "tf-apply", wave, binary: options.binary, runtime: "forge", started: now, finished: now },
    roots: planned.map((p) => ({ path: p.root, plan: p.plan, planner: plannerForBinary(options.binary) })),
    waves: [{ number: wave, roots, setDigest: digest }],
  }));
}

/**
 * A wave with nothing left to change whose last approved apply stopped
 * before it finished: something else applied the rest, so that apply is
 * recorded as finished and the resume job leaves the wave alone. Never fails
 * the wave.
 */
function closeStopped(repo: string, label: string, wave: number, now?: string): void {
  try {
    const ledger = readLedger(repo);
    const gate = waveGate(wave);
    const last = (ledger.applied ?? []).filter((a) => a.gate === gate).reduce<AppliedRecord | undefined>((n, a) => (!n || at(a.timestamp) >= at(n.timestamp) ? a : n), undefined);
    if (!last?.changes || finishOf(ledger, last)) return;
    appendRecord(repo, { version: 1, kind: "finished", op: APPLY_OP, gate, planDigest: last.planDigest, applied: last.timestamp, result: "applied", timestamp: now ?? new Date().toISOString() }, {}, `Apply applied: ${APPLY_OP} ${gate}`, APPLIED_PATH);
    console.log(`${label}: the apply of ${last.planDigest} stopped before it finished, and nothing of it is left to apply`);
  } catch {
    // The resume job runs the wave again, which finds nothing to apply.
  }
}

/** Record how the apply under an approval that named its changes ended; a killed one never gets here, and the resume job applies the rest. Never fails the wave. */
function finishApplied(repo: string, label: string, w: WaveRun, result: FinishedRecord["result"], now?: string): void {
  const a = w.appliedUnder;
  if (!a) return;
  try {
    appendRecord(repo, { version: 1, kind: "finished", op: APPLY_OP, gate: a.gate, planDigest: a.planDigest, applied: a.timestamp, result, timestamp: now ?? new Date().toISOString() }, {}, `Apply ${result}: ${APPLY_OP} ${a.gate}`, APPLIED_PATH);
  } catch (e) {
    console.log(`${label}: how its apply ended was not recorded (${(e as Error).message}); the resume job may apply what is left again, and each change it makes is one the approval covered`);
  }
}

/**
 * Follow a choudoufu wave's applies per resource (./apply-progress.ts): each
 * time the records move, the progress goes to `terragucci-report/progress.json`
 * and to the wave's row in the run view. Undefined when no root of the wave
 * is a choudoufu estate that changes something.
 */
async function watchProgress(repo: string, options: ApplyWaveOptions, w: WaveRun, label: string, planned: PlannedRoot[]): Promise<ApplyProgress | undefined> {
  const roots = planned.flatMap((p) => {
    if (!p.plan || !changesSomething(p.plan) || applyScope(p.bin.name ?? p.binary) !== "resource") return [];
    const dir = join(repo, p.root);
    const { estate } = estateOf(dir);
    const store = estate ? recordStoreOf(dir, estate) : undefined;
    return store ? [{ root: p.root, plan: p.plan, store, env: p.env }] : [];
  });
  if (roots.length === 0) return undefined;
  const env = options.env ?? process.env;
  const file = join(repo, "terragucci-report", "progress.json");
  const watch = new ApplyProgress(roots, {
    intervalMs: progressInterval(env),
    read: (store, e) => readRecords(store, e),
    log: (l) => console.log(`${label}: ${l}`),
    changed: async (p) => {
      console.log(`${label}: progress ${progressLine(p)}`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, JSON.stringify({ wave: options.wave, ...p }, null, 2) + "\n");
      await noteRunView(repo, options, w, { progress: p }, true);
    },
  });
  console.log(`${label}: following ${watch.total} resource${watch.total === 1 ? "" : "s"} in the records of ${roots.map((r) => r.root).join(", ")}`);
  await watch.start();
  return watch;
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
 * The past versions of each record a choudoufu root's apply changed
 * (./cdf-history.ts), listed by `choudoufu live-history` in the root under the
 * identity its records are read with, one line per root. A listing that
 * fails keeps its error and never fails the wave.
 */
async function listRecordVersions(repo: string, applied: PlannedRoot[], limit: number): Promise<Map<string, Map<string, ReportRecordVersions>>> {
  const out = new Map<string, Map<string, ReportRecordVersions>>();
  await eachLimited(applied, limit, async (p) => {
    if (!p.plan || applyScope(p.bin.name ?? p.binary) !== "resource") return;
    const dir = join(repo, p.root);
    const { estate } = estateOf(dir);
    if (!estate) return;
    const addresses = planAppliedChanges(p.plan).map((c) => c.address);
    if (addresses.length === 0) return;
    const byAddress = new Map<string, ReportRecordVersions>();
    for (const a of addresses) byAddress.set(a, await recordVersions(p.binary, dir, a, estate, p.env));
    out.set(p.root, byAddress);
    console.log(`${p.root}: record versions: ${[...byAddress].map(([a, v]) => `${a} ${versionsLine(v)}`).join("; ")}`);
  });
  return out;
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
 * `input.review` on GitLab: the verdict of the review job a note on the merge
 * request points at, once GitLab says it is the default branch's (gitlabReviewOf).
 */
async function gitlabWaveReview(repo: string, env: NodeJS.ProcessEnv, options: ApplyWaveOptions, label: string): Promise<PolicyReview> {
  const sha = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  try {
    const mr = await gitlabMergeRequestOf(gitlabCalls(env, options.fetch), sha, env);
    if (!mr) {
      console.log(`${label}: review: no merge request made ${sha.slice(0, 8) || "this commit"}, so input.review has no review`);
      return noReview();
    }
    const head = typeof mr.sha === "string" ? mr.sha : "";
    const { job, skipped, ...review } = await gitlabReviewOf(gitlabReviewCalls(env, options.fetch), { number: mr.iid, head });
    for (const s of skipped) console.log(`${label}: review: skipped the review job ${s.job === null ? "a note named" : s.job}, since ${s.why}`);
    console.log(review.found
      ? `${label}: review: merge request !${mr.iid}'s head ${head.slice(0, 8)} was reviewed with risk ${review.risk} in job ${job} of a default-branch pipeline, which the policy reads as input.review`
      : `${label}: review: no review job of a default-branch pipeline kept a review of merge request !${mr.iid}'s head ${head.slice(0, 8)}, so input.review.found is false`);
    return review;
  } catch (e) {
    console.log(`${label}: review: could not read the merge request's review (${(e as Error).message.split("\n")[0]}), so input.review.found is false`);
    return noReview();
  }
}

/**
 * What the wave's policy reads as `input.review`: the verdict the review job
 * kept as its artifact, in a run of the default branch's review workflow that
 * reviewed the head of the pull request this commit merged (or `TG_PR`'s,
 * applied before merge). Notes on the pull request are not read: any run's
 * token can post one. Nor is an artifact a run of the pull request's own
 * pipeline kept, which the pull request can edit. On GitLab the review job is in
 * a pipeline of the default branch (gitlabWaveReview). A commit no pull request
 * made has no review: it reads as not found.
 */
async function waveReview(repo: string, env: NodeJS.ProcessEnv, options: ApplyWaveOptions, label: string, forge: string | undefined): Promise<PolicyReview> {
  if (env.GITLAB_CI === "true" || forge === "gitlab") return gitlabWaveReview(repo, env, options, label);
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
 * Run the policy over a wave's plans, when `policy` is on. A root the policy
 * denies with rule ids goes to chant as a denial (`denied` in `{plans}`), and
 * chant lets it through only under an override on `_gates/policy-override.jsonl`
 * by someone `policy.override` at base lists, refusing the wave otherwise. A
 * root the policy could not check, or denied with no rule to override, stops
 * the wave here: returns the exit code. Otherwise the denials, by root.
 */
async function policyCheck(
  repo: string,
  options: ApplyWaveOptions,
  ctx: WavesContext,
  at: { label: string; settings: ResolvedSettings },
  planned: WavePlan[],
  j: WaveJob,
): Promise<Map<string, { rules: string[]; reason?: string }> | number> {
  const { k: wave, w } = j;
  const { label, settings } = at;
  const out = new Map<string, { rules: string[]; reason?: string }>();
  // Policy is opt-in. With a base, the base's policy key decides whether it runs, as in tf-plan.
  const policyEnv = options.env ?? process.env;
  const policyBaseRef = options.base ?? (policyEnv.TG_BASE || undefined);
  const governing = await governingPolicy(repo, settings.policy, policyBaseRef, ctx.configPath ? { config: ctx.configPath } : {});
  if (governing.note) console.log(governing.note);
  if (!governing.policy) return out;
  const runAt = runFacts(repo, policyEnv, settings.forge);
  // With cost on, each root's figures and its wave's: the policy reads the cost of what this wave applies.
  const cost = (root: string) => (w.cost ? { cost: policyCost(w.cost, root, w.waveCost ? { number: wave, cost: w.waveCost } : undefined, w.waveCost?.approve_above) } : {});
  // With review.agent on, the policy reads the review of the merged pull request's head as input.review.
  const review = settings.review?.agent ? await waveReview(repo, policyEnv, options, label, settings.forge) : undefined;
  const found = await checkPlans(repo, governing.policy, planned.map((p) => ({ path: p.root, plan: p.plan, ...cost(p.root) })), policyBaseRef, governing.trust, options.policy ?? {}, (l) => console.log(l), { stage: "tf-apply", project: runAt.project, commit: runAt.commit, ...(review ? { review } : {}) });
  w.policy = found.policy;
  for (const p of planned) {
    const verdict = found.roots.get(p.root);
    if (verdict) p.policy = verdict;
  }
  if (found.failed.size === 0) return out;
  // Who may override is policy.override in the config at base, when the policy key in force names any; with nobody listed, no denial is recorded for an override.
  const overriders = governing.policy.override?.length ? (ctx.rule?.overriders ?? []) : [];
  // A denial with its rules and plan can be overridden; one the policy could not check never is.
  const overridable = (p: WavePlan): boolean => overriders.length > 0 && found.failed.has(p.root) && p.policy?.result === "denied" && (p.policy.rules?.length ?? 0) > 0 && !!p.member?.planDigest;
  const hard = planned.filter((p) => found.failed.has(p.root) && !overridable(p));
  j.denials = new Map(found.failed);
  if (hard.length > 0) {
    for (const p of planned) {
      const error = found.failed.get(p.root);
      if (error === undefined) continue;
      p.error = error;
      console.log(`FAILED ${p.root}: ${error.split("\n")[0]}`);
      console.log(indent(error));
    }
    console.log(`${label}: policy refused ${found.failed.size} root${found.failed.size === 1 ? "" : "s"}, so nothing in it was applied`);
    w.refused = { reason: "policy", roots: [...found.failed.keys()].sort() };
    writeOutcome(options.env, `wave ${wave} refused by policy: ${[...found.failed.keys()].join(", ")}`, w);
    return EXIT.failed;
  }
  j.overriders = overriders;
  if (w.policy) w.policy.overriders = overriders;
  for (const p of planned) {
    if (!found.failed.has(p.root)) continue;
    out.set(p.root, { rules: p.policy!.rules!, reason: found.failed.get(p.root)!.split("\n")[0]! });
  }
  return out;
}

/**
 * What a gated wave settles before chant decides its gate, each recorded on
 * the ledger as the approval chant then counts: the rest of a stopped apply,
 * which its approval covers (./remainder.ts), and under `approval:
 * pr-review`, the merged pull request's approving review of these plans.
 * Nothing is recorded when an approval of the digest already stands, nor
 * under `apply.point`, whose gate chant asks the decision point for.
 */
async function beforeGate(
  repo: string,
  options: ApplyWaveOptions,
  ctx: WavesContext,
  j: WaveJob,
  at: { label: string; digest: string; planned: WavePlan[]; plans: RootPlan[]; resume: boolean; members?: WaveMember[]; roots?: string[] },
): Promise<number | undefined> {
  const { k: wave, w, facts } = j;
  const { label, digest, planned, plans } = at;
  const rule = ctx.rule;
  if (!rule) return undefined;
  const env = options.env ?? process.env;
  const name = waveGate(wave);
  const now = new Date().toISOString();
  // With apply.point at base chant asks the decision point, and only its answer passes the wave.
  if (rule.point) return undefined;
  const ledger = readLedger(repo);
  // Under sealed every wave gate needs a seal: a wave added after init is never left open. chant counts only these; the log says why the others do not.
  if (rule.mode === "sealed") {
    if (rule.gates.size > 0 && !rule.gates.has(name)) console.log(`${label}: chant.workspace.json at base does not list ${name} under identity.gates, so it counts only a sealed approval, like the gates it lists`);
    ledger.resolutions = ledger.resolutions.filter((r) => {
      if (r.gate !== name) return true;
      const why = sealRefusal(rule.signers, r);
      if (why !== null && samePlanDigest(r.planDigest, digest)) console.log(`${label}: an approval does not count: ${why}`);
      return why === null;
    });
  }
  const decision = decideGate(ledger, name, digest, now);
  if (decision.status !== "waiting") return undefined;
  // A plain wave whose approved apply stopped before it finished: plans that are the rest of the approved ones apply under that approval.
  if (at.resume && decision.spent) {
    const stopped = stoppedApply(ledger, name, decision.spent.at);
    if (stopped?.changes) {
      const c = coverRemainder(stopped.changes, plans);
      if (c.covered) {
        console.log(`${label}: the apply of ${stopped.planDigest}, approved by ${decision.spent.by}, stopped before it finished; ${c.done.length} of its ${stopped.changes.length} change${stopped.changes.length === 1 ? "" : "s"} are done in the records, and these plans make the other ${c.remaining.length}, so that approval covers them`);
        appendRecord(repo, { version: 1, kind: "resolution", op: APPLY_OP, gate: name, resolvedBy: decision.spent.by, timestamp: now, planDigest: digest, note: `the rest of the apply of ${stopped.planDigest}, which ${decision.spent.by} approved at ${decision.spent.at}` }, {}, `Approved as the rest of a stopped apply: ${APPLY_OP} ${name}`);
        j.resumes = stopped.planDigest;
        return undefined;
      }
      console.log(`${label}: the apply of ${stopped.planDigest}, approved by ${decision.spent.by}, stopped before it finished, but ${c.why}, so these plans need an approval of their own`);
    }
  }
  if (decision.spent) console.log(`${label}: the approval of ${decision.spent.approved} by ${decision.spent.by} was used by the apply of those plans, so these plans need an approval of their own`);
  // Under pr-review the merged pull request's approval of its head counts, when it reviewed these plans.
  if (rule.mode === "pr-review") {
    const forge = env.GITLAB_CI === "true" ? "gitlab" : env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" ? "forgejo" : "github";
    const sha = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    const priced = costMember(w.waveCost);
    const changesDigest = reviewDigest(planned.filter((p) => p.member).map((p) => ({ member: p.member!.member, planDigest: p.member!.planDigest, plan: p.plan })), priced ? [priced] : []);
    const r = await reviewWave({ env, ...(options.fetch ? { fetch: options.fetch } : {}), forge, sha, wave, digest: changesDigest });
    if (r.kind === "approved") {
      appendRecord(repo, { version: 1, kind: "resolution", op: APPLY_OP, gate: name, resolvedBy: r.by.join(","), timestamp: now, planDigest: digest, via: "pr-review", pr: r.pr, head: r.head, reviewers: r.by }, {}, `Approved by the review of pull request ${r.pr}: ${APPLY_OP} ${name}`);
      console.log(`${label}: pull request ${r.pr} was approved on its head ${r.head.slice(0, 8)} by ${r.by.join(", ")}, and the plans are the ones it reviewed (${changesDigest})`);
    } else if (r.kind === "moved") {
      j.reviewMoved = r;
    } else {
      console.log(`${label}: no review approves this wave: ${r.why}`);
      if (r.review) {
        w.review = { pull_request: r.review.pr, url: r.review.url };
        console.log(`${label}: an approving review of pull request ${r.review.pr} on its head approves it: ${r.review.url}`);
      }
    }
  }
  return undefined;
}

/** chant's decision record, as an `after-gate` hook reads it. */
type GateRecord = OpWaveDecision;

/**
 * The `after-gate` hook: chant decided the wave's gate. terragucci says what
 * that means in its own words and exit codes, keeps the report of the plans
 * a new pending fact asks approval for, and writes the outcome of a wave that
 * does not apply. A wave that applies reports from its apply.
 */
async function gateCall(repo: string, options: ApplyWaveOptions, ctx: WavesContext, j: WaveJob, env: Record<string, string>, cwd: string): Promise<number> {
  const { k: wave, w, facts, label } = j;
  const status = env.CHANT_GATE_STATUS as GateRecord["status"] | undefined;
  const d = readCallFile<GateRecord>(cwd, env.CHANT_DECISION);
  const mode: Approval = ctx.rule?.mode ?? "ledger";
  // The overrides chant let denied roots through under, for the report.
  const overridden: string[] = [];
  for (const m of d?.members ?? []) {
    const p = w.planned?.find((x) => x.root === m.member);
    if (!m.override || !p?.policy) continue;
    p.policy = { ...p.policy, override: { by: m.override.by, at: m.override.at, rules: m.denied?.rules ?? p.policy.rules ?? [], reason: m.override.reason, plan_digest: m.planDigest, digest: m.override.digest, sealed: mode === "sealed" } };
    overridden.push(m.member);
  }
  if (overridden.length && w.policy) w.policy.overridden = overridden.sort();
  if (d?.heldOn) {
    // A state migration holds wave 1 on its own gate (migrationCall printed the proof and its command).
    j.code = EXIT.waiting;
    if (d.heldOn.mismatch) {
      console.log(`wave 1: ${d.heldOn.mismatch.resolvedBy} approved ${d.heldOn.mismatch.approved ?? "another digest"} of ${d.heldOn.gate}, and the states moved since; nothing was written`);
      j.code = EXIT.refused;
      writeOutcome(options.env, `migration ${d.heldOn.gate}: the states moved since it was approved`, w);
    }
    return EXIT.applied;
  }
  w.digest = d?.digest || env.CHANT_GATE_DIGEST || w.digest;
  const digest = w.digest ?? "";
  if (status === "not-required") {
    w.approval = "not-required";
    return EXIT.applied;
  }
  if (status === "refused" && (d?.refused?.reason as string | undefined) === "point") {
    // The decision point answered otherwise: nothing applies until the answer is taken back and the point asked again.
    const answer = d?.point?.answer as { id?: string; answer?: unknown } | undefined;
    console.log(`${label}: nothing was applied: ${(d?.refused as { message?: string } | undefined)?.message ?? `decision point ${d?.point?.name ?? ""} answered ${JSON.stringify(answer?.answer)}`}`);
    if (answer?.id) w.command = retractLine(answer.id);
    writeOutcome(options.env, `wave ${wave}: decision point ${d?.point?.name ?? ctx.rule?.point ?? ""} answered ${JSON.stringify(answer?.answer)}`, w);
    j.code = EXIT.refused;
    return EXIT.applied;
  }
  if (status === "refused") {
    const moved = d?.refused?.reason === "override-moved";
    const runs = d?.refused?.runs ?? [];
    for (const root of runs) {
      const p = w.planned?.find((x) => x.root === root);
      const error = j.denials?.get(root) ?? "denied by the policy";
      if (p) p.error = error;
      console.log(`FAILED ${root}: ${error.split("\n")[0]}`);
      console.log(indent(error));
      const rules = d?.members.find((m) => m.member === root)?.denied?.rules ?? [];
      if (j.overriders?.length) {
        console.log(`${root}: policy.override at base lists ${j.overriders.join(", ")}; one of them can let this plan through with:`);
        console.log(`  ${overrideCommand(root, rules, mode === "sealed")}`);
      }
    }
    console.log(`${label}: policy refused ${runs.length} root${runs.length === 1 ? "" : "s"}, so nothing in it was applied`);
    w.refused = { reason: moved ? "override" : "policy", roots: [...runs].sort() };
    writeOutcome(options.env, moved ? `wave ${wave} changed after its policy override: ${runs.join(", ")}` : `wave ${wave} refused by policy: ${runs.join(", ")}`, w);
    j.code = moved ? EXIT.refused : EXIT.failed;
    return EXIT.applied;
  }
  w.gate = { branch: LIFECYCLE, path: LEDGER_PATH };
  w.mode = mode;
  if (ctx.rule) console.log(`${label}: approval ${ctx.rule.mode} (${ctx.rule.source})`);
  if (ctx.rule?.note) console.log(`${label}: note: ${ctx.rule.note}`);
  if (status === "approved") {
    w.approval = "approved";
    j.approvedBy = d?.approvedBy;
    j.approvedAt = d?.approvedAt;
    console.log(`${label}: approved by ${d?.approvedBy ?? "an approval"} for this digest`);
    // The wait the approval ended: from the newest pending record of the gate made before it.
    if (d?.approvedAt) {
      try {
        const asked = readLedger(repo).pending.filter((p) => p.gate === waveGate(wave) && at(p.timestamp) <= at(d.approvedAt!)).reduce<string | undefined>((a, p) => (!a || at(p.timestamp) > at(a) ? p.timestamp : a), undefined);
        if (asked) {
          w.gateSince = asked;
          w.approvedAt = d.approvedAt;
        }
      } catch {
        // The run view's gate span is left out.
      }
    }
    return EXIT.applied;
  }
  // Waiting.
  w.approval = "waiting";
  const since = env.CHANT_GATE_WAITING_SINCE || d?.waitingSince || new Date().toISOString();
  facts.waitingSince = since;
  w.waitingSince = since;
  w.gateSince = since;
  // The report of the plans this pending fact asks approval for, kept beside it, as respond wave-refused reads it.
  if (env.CHANT_GATE_RECORDED === "true" && j.stored && digest) {
    try {
      appendLifecycle(repo, "", [], { [approvedPath(wave, digest)]: j.stored() }, `The plans of ${APPLY_OP} ${waveGate(wave)}: ${digest}`);
    } catch (e) {
      console.log(`${label}: the report of these plans was not kept beside the pending fact: ${(e as Error).message}`);
    }
  }
  // Under apply.point the decision point's question is what waits.
  const question = d?.point?.question?.id ?? d?.pendingFact?.answer?.id;
  if (question) {
    console.log(`${label} waits for decision point ${d?.point?.name ?? ctx.rule?.point ?? ""} to answer question ${question} for digest ${digest}. Read its plans above, then answer it (a chat message's Approve button, through terragucci relay, answers it too):`);
    console.log(`  ${answerLine(question)}`);
    console.log("The point's quorum decides; an answer sent over MCP or ACP counts nobody toward it. Then run this job again.");
    w.command = answerLine(question);
    writeOutcome(options.env, `wave ${wave} waits: ${w.command}`, w);
    j.code = EXIT.waiting;
    return EXIT.applied;
  }
  const report = j.stored;
  if (j.reviewMoved) {
    const moved = j.reviewMoved;
    console.log(`${label}: pull request ${moved.pr} was approved on its head ${moved.head.slice(0, 8)} by ${moved.by.join(", ")}, but the plans changed since that review, so nothing in it was applied`);
    console.log(`${label}: the review saw digest ${moved.reviewed}; the changes planned now have another. Read the plans above, then approve them with:`);
    console.log(`  ${approveLine(wave, digest, mode)}`);
    if (report) {
      mkdirSync(join(repo, "terragucci-report", "current"), { recursive: true });
      writeFileSync(join(repo, "terragucci-report", "current", "report.json"), report());
    }
    w.refused = { reason: "review", approved: moved.reviewed, by: moved.by.join(", "), roots: (w.changedRoots ?? []).slice().sort() };
    w.command = approveLine(wave, digest, mode);
    writeOutcome(options.env, `wave ${wave} changed since its review in pull request ${moved.pr}`, w);
    j.code = EXIT.refused;
    return EXIT.applied;
  }
  if (d?.mismatch) {
    // An approval of other plans that no wave applied: the plans moved after it, and terragucci refuses (4) where chant waits.
    const mismatch = d.mismatch;
    const ledger = readLedger(repo);
    const members = (d.members ?? []).filter((m) => !m.empty).map((m) => ({ member: m.member, planDigest: m.planDigest }));
    const approvedFact = [...ledger.pending].reverse().find((p) => p.gate === waveGate(wave) && p.members && samePlanDigest(p.planDigest, mismatch.approved));
    const moved = approvedFact ? movedMembers(approvedFact.members!, [...members, ...(d.extras ?? [])]) : (w.roots ?? []).slice().sort();
    // chant's describeChangedWave words the same refusal with a chant approve hint; the reader runs terragucci approve.
    console.log(`wave ${wave} changed after it was approved, so nothing in it was applied. approved: ${mismatch.approved ?? "(none)"}; planned now: ${digest}. Read the new plan, then approve it: ${approveLine(wave, digest, mode)}`);
    console.log(`${label}: approved by ${mismatch.resolvedBy}, but these roots planned differently since: ${moved.join(", ")}`);
    // What respond wave-refused compares: the plans approved, as the run that waited for them kept them, and the plans made now.
    const was = approvedFact?.planDigest ?? mismatch.approved;
    const approved = was ? storedReport(repo, wave, was) : undefined;
    for (const [dir, text] of [["current", report?.() ?? ""], ["approved", approved ?? ""]] as const) {
      if (!text) continue;
      mkdirSync(join(repo, "terragucci-report", dir), { recursive: true });
      writeFileSync(join(repo, "terragucci-report", dir, "report.json"), text);
    }
    if (!approved) console.log(`${label}: the approved plans were not kept, so only the roots that moved can be named`);
    w.refused = { reason: "approval", ...(mismatch.approved ? { approved: mismatch.approved } : {}), by: mismatch.resolvedBy, roots: moved };
    w.command = approveLine(wave, digest, mode);
    writeOutcome(options.env, `wave ${wave} changed after approval: ${moved.join(", ")}`, w);
    j.code = EXIT.refused;
    return EXIT.applied;
  }
  console.log(`${label} waits for an approval of digest ${digest}. Read its plans above, then approve it with:`);
  console.log(`  ${approveLine(wave, digest, mode)}`);
  // chant records the approver as --actor, else GITHUB_ACTOR, GITLAB_USER_LOGIN or USER; a seal counts only when that name is a principal in .chant/allowed_signers.
  console.log(mode === "sealed"
    ? "terragucci approve records you as $GITHUB_ACTOR, $GITLAB_USER_LOGIN or $USER. When none of them is your principal in .chant/allowed_signers, add --actor <principal>."
    : "terragucci approve records you as $GITHUB_ACTOR, $GITLAB_USER_LOGIN or $USER; add --actor <name> to name yourself. Under approval: ledger the approval binds these plans, not the person.");
  console.log("Then run this job again.");
  w.command = approveLine(wave, digest, mode);
  writeOutcome(options.env, `wave ${wave} waits: ${w.command}`, w);
  j.code = EXIT.waiting;
  return EXIT.applied;
}

/**
 * The repo's state migrations that have not run (./migrate.ts), before wave
 * 1 plans: every later wave waits on wave 1, so no root applies against a
 * state a migration is about to rewrite. Two `before-plan` hooks of wave 1
 * call this: `migrations` proves the first one, and fails the wave when it
 * cannot be proved; `migration gate` (onFailure: approve) holds the wave on
 * that migration's own gate, `tf-migrate <name>`, through chant's CHANT_HOLD,
 * and once chant found the approval (CHANT_HOLD_APPROVED) writes the states.
 * Each record goes to `terragucci-report/migrations/` and, with
 * `reports.bucket`, to `<prefix>/<project>/migrations/<name>.json`. A share
 * job leaves the migrations to its wave's job.
 */
async function migrationCall(repo: string, options: ApplyWaveOptions, j: WaveJob, hold: Record<string, string> | undefined, cwd: string): Promise<number> {
  delete j.code;
  if (j.k !== 1 || options.share !== undefined || !existsSync(join(repo, MIGRATIONS_DIR))) return EXIT.applied;
  const env = options.env ?? process.env;
  let approved: MigrationHold["approved"];
  try {
    approved = hold?.CHANT_HOLD_APPROVED ? (JSON.parse(hold.CHANT_HOLD_APPROVED) as MigrationHold["approved"]) : undefined;
  } catch {
    approved = undefined;
  }
  const run = await runMigrations(repo, {
    binary: options.binary,
    env,
    // A Terragrunt unit is prepared by Terragrunt, and its binary then runs where Terragrunt runs it.
    ...(options.terragrunt ? { terragrunt: { ...(options.terragruntPath ? { path: options.terragruntPath } : {}), ...(options.terragruntExec ? { exec: options.terragruntExec } : {}) } } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.approval ? { approval: options.approval } : {}),
    ...(options.base ? { base: options.base } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(hold ? { hold: { file: join(cwd, hold.CHANT_HOLD ?? ".chant/op-waves/tf-apply/wave-1/hold.json"), ...(approved ? { approved } : {}) } } : { prove: true }),
  });
  if (run.records.length > 0) await uploadMigrationRecords(repo, options, run.records, env);
  if (run.code === EXIT.applied) return EXIT.applied;
  const last = run.records[run.records.length - 1];
  if (run.command) j.w.command = run.command;
  const what = last ? `migration ${last.name}` : "a migration";
  writeOutcome(options.env, run.code === EXIT.waiting ? `${what} waits: ${run.command ?? ""}` : run.code === EXIT.refused ? `${what}: the states moved since it was approved` : `${what} failed`, j.w);
  if (run.code !== EXIT.waiting) console.log(`wave 1: ${what} did not apply, so no wave plans until it does`);
  // A hold, also one made after an approved migration applied in this run (the next migration's, chant#3847), waits on chant's decision of its gate.
  // A hold waits on chant's decision of the migration's gate (gateCall); anything else is this wave's own code.
  if (run.code !== EXIT.waiting) j.code = run.code;
  return run.code;
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
/** The runner with TG_BACKEND_BOOTSTRAP set when `on`, so Terragrunt creates or updates the backend of a unit whose remote_state has disable_init = false. */
function bootstrapExec(inner: TerragruntExec, on: boolean): TerragruntExec {
  return on ? (file, args, opts) => inner(file, args, { ...opts, env: { ...opts.env, TG_BACKEND_BOOTSTRAP: "true" } }) : inner;
}

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
 * Plan one wave of a Terragrunt repo for chant (`planWave`), behind the same
 * gate as a plain wave.
 *
 * Every wave of the spec discovers its runs: the waves are the pipeline's
 * `--layers`, each split again by the edges `terragrunt find` gives in the
 * job's checkout (refineWaves), and `{plans}` names wave k's units and how
 * many waves there are. A pipeline whose init saw every edge comes back as it
 * is; one whose init missed an edge (a dependency path built with a function)
 * gets more waves than jobs, and the last job (`--rest`, the spec's `rest`
 * wave) runs them. No unit of a wave reads another unit of it, and a unit
 * that reads one of a later wave fails the job.
 *
 * The wave plans its units with one `run --all`, each plan saved; chant takes
 * the set digest over the units whose plan changes a resource or an output.
 * With `cost` set the plans are priced first, and with `cost.approve_above`
 * at base the wave's cost is one more member of the digest, as for plain
 * roots. Once chant lets the wave through, it applies exactly those saved
 * plans with one `run --all`, never planning anew. A unit whose plan would
 * read mock_outputs fails the wave: its upstream applies in an earlier wave,
 * so it has no outputs only when it lies outside the units.
 *
 * `steps:` run around the wave's `run --all`: each moment once for the wave,
 * in the directory of every unit a step's `roots` globs match (runUnitSteps).
 * Before init and before plan come before the plan, after plan after it with
 * each unit's saved plan, and before and after apply around the apply of the
 * units that change. A step that fails fails the wave, and one with
 * `on_failure: approve` holds it at its gate.
 *
 * With `waves.jobs` (`--shares`) a wave's units split across share jobs: the
 * wave's job plans every unit, prices, runs the policy and decides the gate,
 * and chant hands each share job its units, which it plans again with `run
 * --all --filter` and applies only when each plan has the digest decided.
 */
async function planUnits(repo: string, options: ApplyWaveOptions, ctx: WavesContext, j: WaveJob, runs: RunsFile, plansPath: string): Promise<number> {
  const { binary } = options;
  const { k: wave, w, facts } = j;
  const env = options.env ?? process.env;
  const terragrunt = options.terragruntPath ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt";
  const { configPath, work } = ctx;
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
  if (cut.length !== listed.length && wave === options.wave) {
    console.log(`wave ${wave}: Terragrunt's edges cut the pipeline's ${waves(listed.length)} into ${cut.length}; run terragucci init to give each wave its own job`);
  }
  const unlisted = found.units.map((u) => u.path).filter((u) => !listed.some((l) => l.includes(u)) && !options.elsewhere?.includes(u));
  if (unlisted.length > 0 && wave === options.wave) console.log(`wave ${wave}: the pipeline does not list ${unlisted.join(", ")}, so no wave applies it; run terragucci init to add it`);
  const whole = cut[wave - 1];
  const deciding = options.share === undefined;
  if (runs.discover && !whole) {
    facts.nothing = true;
    console.log(`wave ${wave}: this repo has ${waves(cut.length)}, so there is nothing to apply`);
    writePlans(plansPath, { runs: [], waves: cut.length });
    j.apply = async () => EXIT.applied;
    return EXIT.applied;
  }
  // A share job plans the units chant hands it: its slice of what the wave's job planned.
  const roots = runs.discover ? whole! : runs.runs.map((r) => r.target);
  const label = (j.label = options.share !== undefined ? `wave ${wave} of ${cut.length}, share ${options.share} of ${options.shares}` : `wave ${wave} of ${cut.length}`);
  if (options.share !== undefined) w.share = options.share;
  if (roots.length === 0) {
    facts.nothing = true;
    console.log(`${label}: the wave's units make fewer shares than ${options.shares}, so this one has nothing to apply`);
    writePlans(plansPath, { runs: [], waves: cut.length });
    j.apply = async () => EXIT.applied;
    return EXIT.applied;
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
  // shape: Terragrunt's backend bootstrap. generate's disable_init: false asks Terragrunt to init the backend; only the apply job may create or change the bucket.
  const bootstrap = backendBootstrap(repo, settings) && env.TG_BACKEND_BOOTSTRAP === undefined;
  if (bootstrap) console.log(`wave ${wave}: generate gives a unit disable_init: false, so Terragrunt bootstraps its backend (TG_BACKEND_BOOTSTRAP)`);
  const exec = unitLockTimeoutExec(bootstrapExec(options.terragruntExec ?? terragruntExec, bootstrap), env);
  const run = { dir: repo, binary, terragrunt, exec };
  w.started = new Date().toISOString();
  w.roots = roots;
  const planDir = join(work, `plan-${wave}`);
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
  const changingAll = changing;
  const changes = changing.reduce((n, p) => n + p.changes, 0);
  const destroys = changing.reduce((n, p) => n + p.destroys, 0);
  w.changedRoots = changing.map((p) => p.root).sort();
  const denied = new Map<string, { rules: string[]; reason?: string }>();
  if (deciding) {
    const unpriced = await priceWave(repo, options, { label, settings, configPath, work }, units, w);
    if (unpriced !== undefined) return unpriced;
    const checked = await policyCheck(repo, options, ctx, { label, settings }, units, j);
    if (typeof checked === "number") return checked;
    for (const [root, d] of checked) denied.set(root, d);
  }
  const all = units.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1));
  // With cost.approve_above at base the wave's cost is one more member: an approval of these plans at one cost does not apply them at another.
  const priced = deciding && changing.length > 0 ? costMember(w.waveCost) : undefined;
  const members = [...changing.map((p) => p.member!).sort((a, b) => (a.member < b.member ? -1 : 1)), ...(priced ? [priced] : [])];
  const digest = changing.length > 0 ? waveSetDigest(members) : waveSetDigest(all);
  w.digest = digest;
  if (changing.length === 0) {
    facts.nothing = true;
  } else {
    console.log(`${label}: set digest ${digest} over the ${changing.length} unit${changing.length === 1 ? "" : "s"} that change, ${changes} change${changes === 1 ? "" : "s"}, ${destroys} destroy${destroys === 1 ? "" : "s"}`);
    for (const u of heldBySteps) console.log(`${label}: ${u}: step ${holds.get(u)!.join(", ")} asks for an approval, so the gate holds this wave`);
  }
  if (heldBySteps.length) w.heldBySteps = heldBySteps;
  const byGate = options.gate === "always" || (options.gate === "on-destructive" && destroys > 0) || heldBySteps.length > 0;
  const byCost = w.waveCost?.over === true;
  if (changing.length > 0 && byCost) console.log(`${label}: ${costReason(w.waveCost!, w.costSource)}, so it waits for an approval${byGate ? "" : ` although gate is ${options.gate}`}`);
  j.held = changing.length > 0 && (heldBySteps.length > 0 || byCost);
  if (deciding && changing.length > 0) {
    w.preview = await comparePreview({ repo, env, wave, binary, ...(options.fetch ? { fetch: options.fetch } : {}), units }, (l) => console.log(`${label}: ${l}`));
    if (byGate || byCost) {
      const stop = await beforeGate(repo, options, ctx, j, { label, digest, planned: changing, plans: changing.map((p) => ({ root: p.root, plan: p.plan, binary: p.bin?.name ?? binary })), resume: false, members, roots: changing.map((p) => p.root) });
      if (stop !== undefined) return stop;
    }
    j.stored = () => storedWaveReport(repo, options, wave, digest, changing.map((p) => p.root), changing);
  }
  const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  writePlans(plansPath, {
    runs: units.map((p) => planEntry(p.root, p.member!.planDigest, !(p.changes > 0 || p.outputs), p.destroys, denied.get(p.root))),
    ...(priced ? { members: [priced] } : {}),
    waves: cut.length,
    pending: { description: `${label}: ${changing.map((p) => p.root).join(", ")}`, ...(commit ? { commit } : {}), members },
    ...(j.overriders ? { overriders: j.overriders, overridersSource: "policy.override" } : {}),
  });

  /** Apply the saved plans of the units that change, with the steps around them. */
  j.apply = async (outcome, targets) => {
    const changing = changingAll.filter((p) => targets.has(p.root));
    if (changing.length === 0) {
      w.applied = new Set(units.map((p) => p.root));
      w.states = await recordUnitStateVersions(repo, roots, run, env);
      console.log(`${label}: no changes`);
      console.log(`${label} applied`);
      return EXIT.applied;
    }
    const beforeApply = await unitSteps("before-apply", changing.map((p) => p.root), savedPlan);
    for (const p of units) p.steps = ran.get(p.root) ?? [];
    if (stepsFailed(beforeApply, "a step before the apply failed, so nothing in it was applied")) {
      w.failed = [...beforeApply.keys()];
      return (j.code = EXIT.failed);
    }
    // The saved plans, and nothing planned anew.
    const hold = await holdRows(repo, options, label, changing.map((p) => ({ root: p.root, plan: p.plan, binary: p.bin?.name ?? binary })), w);
    if (hold.code !== undefined) return heldOutcome(j, hold.code, outcome);
    w.applyStarted = new Date().toISOString();
    await noteRunView(repo, options, w, { state: "applying", ...(w.approval ? { approval: w.approval } : {}), ...(w.digest ? { digest: w.digest } : {}) });
    const applied = await applyWaveGroups(groups, changing.map((p) => p.root), { dir: repo, exec }).finally(() => hold.release());
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
      return (j.code = EXIT.failed);
    }
    for (const p of changing) console.log(`applied ${p.root}`);
    const afterApply = await unitSteps("after-apply", changing.map((p) => p.root));
    for (const p of units) p.steps = ran.get(p.root) ?? [];
    if (stepsFailed(afterApply, "applied, then a step after the apply failed")) {
      w.failed = [...afterApply.keys()];
      for (const [unit, error] of afterApply) planned.get(unit)!.error = error;
      return (j.code = EXIT.failed);
    }
    console.log(`${label} applied`);
    return EXIT.applied;
  };
  return EXIT.applied;
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
  /** The stage's exit code: 0, 3, 4, 5, 6 or 1. */
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
  const status: OutcomeStatus = code === EXIT.applied ? "applied" : code === EXIT.waiting ? "waiting" : code === EXIT.refused || code === EXIT.held || code === EXIT.superseded ? "refused" : "failed";
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
