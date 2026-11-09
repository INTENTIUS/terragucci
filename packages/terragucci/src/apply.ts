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
 * object's metadata, never from its contents, and the provider and module
 * versions its lock file and modules.json hold (./report/versions.ts).
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
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import { terraformApplyCapabilityWith } from "@intentius/chant-lexicon-terraform/components/capability-plugin";
import { atmosStateReads as terraformAtmosReads } from "@intentius/chant-lexicon-terraform/state-reads";
import type { OpWavesSpec, RunOpWaveResult } from "@intentius/chant/op";
import { detectActor } from "./actor";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { OpWaveDecision } from "@intentius/chant/op";
import { type GateRunLocator } from "@intentius/chant/gate-resume-run";
import { waveSetDigest, type WaveMember } from "@intentius/chant/gated-waves";
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { fetchLifecycleStatus, pushLifecycleRebasing, readBlobBySha, readPathSha, RefCASConflictError, requireLifecycleLedger, writeLedgerFiles } from "@intentius/chant/lifecycle/git";
import { isLifecycleLocalNote } from "@intentius/chant/lifecycle/local-note";
import { gitGateLedgerPort } from "@intentius/chant/op/gate";
import { appliesFrom, routeConflicts, routedBranch } from "@intentius/chant/workspace/ci-branches";
import { plannerForBinary } from "@intentius/chant-lexicon-terraform/change-set";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { terragruntApplyCapability } from "@intentius/chant-lexicon-terraform/terragrunt/capability";
import { APPROVALS, ConfigError, findConfig, GATES, LEDGER_PROVES_NOBODY, loadConfig, normalizeGate, resolveRepo, type Approval, type Gate, type GateName, type ResolvedSettings } from "./config";
import { explicitOrder, globMatch, remoteStateReads, rootDependencies, rootOrder, rootStates, unitStates } from "./detect";
import { detectShape } from "./shape";
import { blockedMembers, blockedWords, earlierWaveOutcomes, onlyWaiting, passesThrough, runSummary, writeWaveOutcomeFile, type WaveMemberOutcome, type WaveMemberStatus } from "@intentius/chant/wave-blocked";
import { runSkeleton, updateRunView, type RunWave } from "./report/run-view";
import type { Span } from "./report/graph";
import { wavesOf } from "./planned-outputs";
import { comparePreview } from "./tg-preview-gate";
import { readsOf, unitTexts } from "./tg-preview";
import { rootOutputsRead } from "./linked";
import { unknownReadLine, unknownReads, type PullReport, type UnknownRead, type WaveRead } from "./unknown-reads";
import { waveCoverage } from "./covered-wave";
import type { RoundCover } from "@intentius/chant/components";
import { runPath, type IndexEntry } from "./report/store";
import { buildReport, planFiles, planTotals, policyGate, withEnvironment, type RootInput } from "./report/build";
import { StageObserver } from "./report/observe";
import { redactPlan } from "./report/redact";
import { storeFromEnv } from "./report/bucket";
import { named } from "./estate";
import type { ObjectStore } from "@intentius/chant/object-store";
import { checkPlans, configAtBase, governingPolicy, type PolicyOptions } from "./report/policy";
import { binaryText, type Report, type ReportCost, type ReportPolicy, type ReportRead, type ReportRootBinary, type ReportRootPolicy, type ReportRecordVersions, type ReportStateVersion, type ReportWave, type ReportWaveCost, type WaveState } from "./report/schema";
import { RootBinaries, type Installer, type RootBinary } from "./pins";
import { approveAbove, costCommand, costMember, costReason, costRule, estimateCosts, policyCost, waveCost, writeCostFiles, type CostRunner } from "./report/cost";
import { affectedRoots, artifactReportUrl, eachLimited, oneAtATime, outsideRoots, reportCompose, reportLinks, rootCacheEnv, rootsParallelism, runFacts, type Turn } from "./report/stage";
import { uploadReport, writeReportDir } from "./report/store";
import { uploadRosters, waveRosters, type Roster, type RosterWrite } from "./report/roster";
import { nowNanos, telemetryFromEnv, type Attrs } from "./telemetry";
import { version as VERSION } from "../package.json";
import { approvalRule, ruleReport, type ApprovalRule } from "./approval";
import { forgePrincipalOf } from "@intentius/chant/pr-forge";
import { quorumRuleLine, quorumWaiting, trustRolesAt, type GateQuorumRuleProgress } from "@intentius/chant/gate-decision";
import { mayOverride, overrideCommand, overridersFor, type Overriders } from "./override";
import { approveCommand } from "./report/marker";
import type { Fetch } from "./forge";
import { changesSomething, forgeCalls, jobForge, pullOf, reviewDigest, reviewWave, type JobForge, type ReviewedPull, type ReviewOutcome } from "./review";
import { AGENT_NOT_EXCLUDED, judge, mergeExcluded, notCounted, pullInvolvement, tokenUsers, whyInvolved, type Excluded, type Involved } from "./involved";
import { gitlabReviewCalls, gitlabReviewOf } from "./gitlab-agent";
import { artifactBytes, noReview, reviewOfPull, type FetchBytes, type PolicyReview } from "./review-agent";
import { baseCommit, sealRefusal, type GateSigners } from "./seal";
import { type PlanCone } from "./cone";
import type { WaveFacts } from "./report/wave-telemetry";
import { discoverUnits, refineWaves, unitEdges, walkUnits } from "./terragrunt";
import { UnitBinaries, type UnitTools } from "./unit-pins";
import { binaryEnv, terragruntExec, tokenlessBinary } from "./binary-env";
import { azureBootstrapRefusal, backendBootstrap, bootstrapUnits } from "./generate";
import { rootWorkspace, stateVersion, workspaceEnv } from "./backend";
import { atmosEdges, type UpstreamOutputs } from "./atmos";
import { rootRoleEnv } from "./cloud-identity";
import { rootSecretEnv } from "./root-secrets";
import type { ProgressSinks } from "./migrate-progress";
import { beforeMembers, MIGRATE_LEDGER, MIGRATIONS_DIR, movedSinceApproval, pendingEstateMigrations, pendingWhy, runMigrations, sha as shaOf, type MigrationHold, type MigrationRecord, type PendingEstateRoot } from "./migrate";
import { sourceChecker, waveSourcesBase, type SourceChecker } from "./sources";
import { UNIT_REFUSED, uncheckedUnit, unitSourcesExec } from "./sources-terragrunt";
import { hookCount, hooksUsed, readHooks, runHooks, runUnitHooks, type HookMoment, type StageHooks } from "./hooks";
import { approvedChanges, coverRemainder, finishOf, stoppedApply, type ApprovedChange } from "./remainder";
import { applyScope, rowHolder, type Liveness } from "./apply-rows";
import { resolveGateRunLocator } from "@intentius/chant/gate-resume-run";
import type { ReportApprovalRule, ReportStep } from "./report/schema";
import { readLiveSetup, resolvedEstate } from "./live-setup";
import { recordVersions, versionsLine } from "./cdf-history";
import { rootVersions } from "./report/versions";
import { planAppliedChanges, readChanges } from "./report/history";
import { answerLine, retractLine } from "./point-gate";
import type { GateAnswerRef } from "@intentius/chant/point-decision";
import { anyRootGate, environmentOf, strictestGate, topGate, waveGate as rootsGate } from "./environments";
import { rootsByGroup } from "./cloud-identity";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { committedSpecAt, WAVES_SPEC, readCallFile, serveWave, specAtBase, waveCallArgv, waveExit, waveRecordPath, wavesStepSpec, writeSpec, type WaveCall, type WaveRequest } from "./chant-waves";
import { compositionFor, compositionLine, composeTarget, isComposeTarget, specWavesWithRun, stepWavesWithRun, wavesWithRun, type Composition } from "./compose";
import { composeGroup } from "@intentius/chant-lexicon-terraform/components/compose-group";
import { groupOf } from "./cloud-identity";
import type { WaveComposedInput } from "./report/build";

/** The op every wave gate is recorded under. */
export const APPLY_OP = "tf-apply";
/** The gate wave `k` waits on. */
export const waveGate = (wave: number): string => `wave-${wave}`;
/** The approval command a waiting wave prints, bound to the digest it planned, and under `approval: sealed` sealed with the approver's key. */
export const approveLine = (wave: number, digest: string, mode: Approval = "ledger"): string => approveCommand(wave, digest, mode === "sealed");

/** The migration files in a repo's migrations/. */

/** Exit codes of `stage tf-apply`: chant's table (chant#4553), under the names terragucci's code reads them by. */
export const EXIT = { applied: CHANT_EXIT.done, failed: CHANT_EXIT.failed, waiting: CHANT_EXIT.waiting, refused: CHANT_EXIT.moved, held: CHANT_EXIT.held, superseded: CHANT_EXIT.superseded, denied: CHANT_EXIT.denied, declined: CHANT_EXIT.declined } as const;
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
/** `--groups`: `<group>=<glob or root>[,...][;...]`, each apply group's selector but `default`'s (./cloud-identity.ts). */
export function parseGroups(spec: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of spec.split(";").filter(Boolean)) {
    const eq = part.indexOf("=");
    const globs = eq > 0 ? part.slice(eq + 1).split(",").filter(Boolean) : [];
    if (eq <= 0 || globs.length === 0) throw new ConfigError(`--groups takes <group>=<glob>[,<glob>...][;...], not ${JSON.stringify(part)}`);
    out[part.slice(0, eq)] = globs;
  }
  return out;
}

export const branchesArg = (branches: Record<string, string[]>): string =>
  Object.entries(branches).map(([b, globs]) => `${b}=${globs.join(",")}`).join(";");

/** Each root of `roots` that two branches of `apply.branches` match, as a problem: a root applies from one branch (chant's `routeConflicts`). */
export function branchRootProblems(roots: readonly string[], branches: Record<string, string[]>): string[] {
  return routeConflicts(branches, roots).map((c) => `apply.branches: ${c.member} matches ${c.branches.join(" and ")}; a root applies from one branch`);
}

/**
 * The layers a push to `branch` applies under `apply.branches`, routed by
 * chant's `ci.branches` rule (`appliesFrom`) with each root as a member: on
 * a branch the map names, only the roots its globs match; anywhere else (the
 * default branch, and a comment's apply of a merge into it), every root but
 * those any branch's globs match. A root two branches match is refused, as
 * chant refuses a member two branches route. Empty layers drop out of the
 * waves.
 */
export function branchLayers(layers: string[][], branches: Record<string, string[]>, branch?: string): { layers: string[][]; note: string } {
  const conflicts = branchRootProblems(layers.flat(), branches);
  if (conflicts.length > 0) throw new ConfigError(conflicts.join("; "));
  const out = layers.map((l) => l.filter((r) => appliesFrom(branches, r, branch ?? "").applies));
  const kept = out.flat();
  const left = layers.flat().filter((r) => !kept.includes(r));
  const note = branch !== undefined && Object.hasOwn(branches, branch)
    ? `apply.branches: ${branch} applies ${kept.length ? kept.join(", ") : "none of this repo's roots"}`
    : `apply.branches: ${left.length ? `${left.join(", ")} ${left.length === 1 ? "applies" : "apply"} from ${[...new Set(left.map((r) => routedBranch(branches, r)))].join(", ")}, not here` : "no root here is another branch's"}`;
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
  /** The approval mode the wave asked under, as chant writes it on the facts it records. */
  approvalMode?: string;
  /** terragucci's addition: on a fact a wave recorded because no approval of its digest counted under the rule (./involved.ts), the people it left out. */
  excluded?: Excluded[];
  /** terragucci's addition: where each `approval_rules` entry the wave takes stood when it recorded the fact. */
  approval_rules?: ReportApprovalRule[];
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
  /** The people the rule left out of this approval (./involved.ts): a review by someone who had a hand in the change. */
  excluded?: Excluded[];
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
  /** On a `changes` line: the people the rule left out of the wave's approval (./involved.ts). */
  excluded?: Excluded[];
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

/**
 * A covered round's approval (./covered-wave.ts): the wave planned again
 * after its upstreams applied and its plans now have `digest`, chant's
 * coveredRound found them covered by the pull request's plan of
 * `cover.digest`, and the approval of that digest at this gate stands for
 * them. Undefined when `digest` is approved already (nothing to add), and
 * when nothing approved `cover.digest` or its approval is spent by an apply.
 */
export function coveredApproval(ledger: GateLedger, gate: string, digest: string, cover: RoundCover, now: string): { by: string; at: string } | undefined {
  if (decideGate(ledger, gate, digest, now).status === "approved") return undefined;
  const d = decideGate(ledger, gate, cover.digest, now);
  if (d.status !== "approved") return undefined;
  // decideGate counts an approval of the digest it is asked about even when a wave applied under it, so the spent
  // check that it makes only for another digest's approval is made here.
  const spent = (ledger.applied ?? []).some((a) => a.gate === gate && samePlanDigest(a.planDigest, cover.digest) && at(a.approvedAt) >= at(d.at));
  return spent ? undefined : { by: d.by, at: d.at };
}

/** The roots whose plan digest differs between the approved members and the ones planned now. */
export function movedMembers(approved: readonly WaveMember[], now: readonly WaveMember[]): string[] {
  const before = new Map(approved.map((m) => [m.member, m.planDigest]));
  const after = new Map(now.map((m) => [m.member, m.planDigest]));
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((n) => before.get(n) !== after.get(n)).sort();
}

const LIFECYCLE = "chant/lifecycle";
/**
 * Where terragucci reads origin's chant/lifecycle: a ref of its own, never
 * `refs/remotes/origin/chant/lifecycle`, which is the lease chant's writer
 * pushes against. Moving that ref without the branch would let chant's push
 * write over records it has not seen.
 */
export const LEDGER_READ_REF = "refs/terragucci/lifecycle";
const LEDGER_PATH = `_gates/${APPLY_OP}.jsonl`;
/** Where the waves record each approval they applied under: beside the reports, out of chant's sight. */
export const APPLIED_PATH = `_gates/${APPLY_OP}/applied.jsonl`;
/** The applied file beside an op's ledger: `_gates/<op>.jsonl` keeps it at `_gates/<op>/applied.jsonl`. */
export const appliedPathFor = (ledgerPath: string): string => `${ledgerPath.replace(/\.jsonl$/, "")}/applied.jsonl`;

function git(repo: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf-8", input, env });
}

/** Fetch `chant/lifecycle` into LEDGER_READ_REF. False when the remote has no such branch yet; throws when the remote cannot be read. */
function fetchLifecycle(repo: string): boolean {
  const heads = git(repo, ["ls-remote", "--heads", "origin", LIFECYCLE]);
  if (heads.status !== 0) throw new ConfigError(`cannot read ${LIFECYCLE} from origin, so the gate cannot be decided: ${heads.stderr.trim()}`);
  if (!heads.stdout.trim()) return false;
  const f = git(repo, ["fetch", "-q", "origin", `+refs/heads/${LIFECYCLE}:${LEDGER_READ_REF}`]);
  if (f.status !== 0) throw new ConfigError(`cannot fetch ${LIFECYCLE}, so the gate cannot be decided: ${f.stderr.trim()}`);
  return true;
}

/** The gate ledger as `chant/lifecycle` on origin holds it now: the waves' gates, or with `path` another op's file. */
export function readLedger(repo: string, path: string = LEDGER_PATH): GateLedger {
  if (!fetchLifecycle(repo)) return { pending: [], resolutions: [] };
  const show = git(repo, ["show", `${LEDGER_READ_REF}:${path}`]);
  const ledger = parseLedger(show.status === 0 ? show.stdout : "");
  const applied = git(repo, ["show", `${LEDGER_READ_REF}:${appliedPathFor(path)}`]);
  const text = applied.status === 0 ? applied.stdout : "";
  return { ...ledger, applied: parseApplied(text), finished: parseFinished(text) };
}

/** A file on origin's chant/lifecycle as readLedger last fetched it; undefined when there is none. */
export function fetchedLedgerFile(repo: string, path: string): string | undefined {
  const show = git(repo, ["show", `${LEDGER_READ_REF}:${path}`]);
  return show.status === 0 ? show.stdout : undefined;
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
  return fetchedLedgerFile(repo, approvedPath(wave, digest));
}

/** Append a pending fact to the ledger and push it, with any `files` beside it. */
export async function appendPending(repo: string, record: PendingRecord, files: Record<string, string> = {}, path: string = LEDGER_PATH): Promise<void> {
  await writeLedger(repo, path, [JSON.stringify(record)], files, `Pending gate record: ${record.op} ${record.gate}`);
}

/**
 * Write one record of a tf-apply wave on chant's gate ledger writers
 * (chant#4623): a pending fact or an approval through `appendPending` and
 * `appendResolution`, an `applied` or `changes` line through `appendApplied`,
 * a `finished` line through `appendFinished`. chant resolves where the lines
 * go from `repo`, the same place its wave reads them, and honours
 * `--no-record`. Throws when the line does not reach the remote.
 */
export async function writeWaveRecord(repo: string, record: PendingRecord | ResolutionRecord | AppliedRecord | FinishedRecord, message: string): Promise<void> {
  // chant's writers append to the checkout's branch and push it with a lease: bring the branch up to origin first,
  // so a record made elsewhere since the wave last read the ledger is appended to, never pushed over.
  await requireLifecycleLedger({ cwd: repo });
  const port = gitGateLedgerPort({ cwd: repo });
  const line = record as unknown as Record<string, unknown>;
  const { version: _version, ...input } = line;
  let push: { pushed: boolean; pushWarning?: string };
  if (record.kind === "pending") {
    const { kind: _kind, ...fact } = input;
    push = await port.appendPending(fact as never);
  } else if (record.kind === "finished") {
    const write = port.appendFinished ?? port.appendApplied;
    if (!write) throw new ConfigError(`chant's gate ledger cannot record how an apply ended (${message})`);
    push = await write.call(port, line as never);
  } else if (record.kind === "applied" || record.kind === "changes") {
    if (!port.appendApplied) throw new ConfigError(`chant's gate ledger cannot record an applied approval (${message})`);
    push = await port.appendApplied(line as never);
  } else {
    if (!port.appendResolution) throw new ConfigError(`chant's gate ledger cannot record an approval (${message})`);
    push = await port.appendResolution(input as never);
  }
  requireLedgerPush(push, message);
}

/** Write `files` on chant/lifecycle beside a pending fact, with chant's writer. */
export async function writeWaveFiles(repo: string, files: Record<string, string>, message: string): Promise<void> {
  await writeLedger(repo, "", [], files, message);
}

function requireLedgerPush(push: { pushed: boolean; pushWarning?: string }, message: string): void {
  if (push.pushed || isLifecycleLocalNote(push.pushWarning)) return;
  throw new ConfigError(`could not push the ledger record (${message}) to ${LIFECYCLE}: ${push.pushWarning ?? "the push did not land"}; check that the job may push to it`);
}

/**
 * Append `lines` to `path` on chant/lifecycle and write `files` beside it in
 * one commit, with chant's ledger writer: chant brings the checkout's branch
 * up to origin, writes with a compare-and-swap on each file, and pushes
 * against its lease, replaying the commit when another writer pushed first.
 * Paths are full branch paths. Throws when the commit does not reach the
 * remote; a checkout with no remote keeps it locally, as chant does.
 */
export async function writeLedger(repo: string, path: string, lines: string[], files: Record<string, string>, message: string): Promise<void> {
  await requireLifecycleLedger({ cwd: repo });
  const at = (p: string): [string, string] => {
    const i = p.lastIndexOf("/");
    return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i + 1)];
  };
  // Full paths: the readers name them from the branch's root, whatever workspace member the checkout is.
  const where = { cwd: repo, ledgerPrefix: "" };
  for (let attempt = 0; ; attempt++) {
    const writes: Array<{ path: string; content: string; expectPriorSha?: string | null }> = Object.entries(files).map(([p, content]) => ({ path: p, content }));
    if (lines.length > 0) {
      const [dir, file] = at(path);
      const prior = await readPathSha(dir, file, where);
      const old = prior ? await readBlobBySha(prior, { cwd: repo }) : null;
      // One record per line, each ending in a newline, so a line appended with `>>` stays its own record.
      writes.unshift({ path, content: `${old && old.trim() ? `${old.replace(/\n$/, "")}\n` : ""}${lines.join("\n")}\n`, expectPriorSha: prior });
    }
    if (writes.length === 0) return;
    try {
      await writeLedgerFiles(writes, message, { cwd: repo });
      break;
    } catch (e) {
      if (!(e instanceof RefCASConflictError) || attempt >= 4) throw e;
    }
  }
  let push: { pushed: boolean; pushWarning?: string };
  try {
    push = await pushLifecycleRebasing({ cwd: repo });
  } catch (e) {
    push = { pushed: false, pushWarning: (e as Error).message };
  }
  requireLedgerPush(push, message);
}

// ── planning and applying ────────────────────────────────────────────────

type RootTiming = ReturnType<StageObserver["root"]>;

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
  /** terragucci#1161: why its apply failed in the binary, the first error line it printed, for the wave report's outcomes. */
  applyError?: string;
  /** The policy's verdict on its plan, when `policy` is on. */
  policy?: ReportRootPolicy;
  /** What it planned with, which its apply runs too: the job's binary or the version it pins. */
  binary: string;
  /** That binary as the report names it. */
  bin: ReportRootBinary;
  /** The `ci.hooks` hooks that ran for it. */
  steps: ReportStep[];
  /** Its `onFailure: "approve"` hooks that failed: the wave waits for an approval. */
  holds: string[];
  /** A choudoufu plan of an open pull request's root with `-cone` (./cone.ts): its targets are in the member's plan digest. */
  cone?: PlanCone;
}

/** The hooks a wave runs, and the context its roots run them in. */
interface WaveSteps {
  hooks: StageHooks;
  env: NodeJS.ProcessEnv;
}

/** Run one moment's hooks for a planned root, keeping what they came to on it. The error when one failed the root. */
async function rootSteps(repo: string, p: Pick<PlannedRoot, "root" | "steps" | "holds">, ws: WaveSteps | undefined, when: HookMoment, planFile?: string): Promise<string | undefined> {
  if (!ws || hookCount(ws.hooks) === 0) return undefined;
  const o = await runHooks(ws.hooks, when, { repo, root: p.root, stage: "tf-apply", env: ws.env, ...(planFile ? { planFile } : {}), log: (l) => console.log(l) });
  p.steps.push(...o.runs);
  p.holds.push(...o.holds);
  return o.error;
}

/** The directory a wave writes its report and its outcome file in: render.ts's REPORT_DIR, which the job keeps as its artifact. */
const WAVE_REPORT_DIR = "terragucci-report";

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

/**
 * `show -json` of a root's state once it applied, from the working state: the values its plan left unknown are read
 * from it for the report. Undefined when the state cannot be shown; the report then leaves those values unknown.
 */
function showAppliedState(repo: string, p: PlannedRoot): unknown {
  const show = spawnSync(p.binary, [`-chdir=${join(repo, p.root)}`, "show", "-json", "-no-color"], { encoding: "utf-8", env: binaryEnv(p.env), maxBuffer: 512 * 1024 * 1024 });
  try {
    return show.status === 0 ? JSON.parse(show.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** The first `Error:` line a binary printed, past its box drawing, or else its last line; at most 300 characters. */
export function firstError(out: string): string {
  const lines = out.split("\n").map((l) => l.replace(/^[\s│╷╵]+/, "").trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith("Error:")) ?? lines[lines.length - 1] ?? "the apply failed";
  return line.slice(0, 300);
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
  /**
   * Plain roots only: one apply job per identity (./cloud-identity.ts). Each group's
   * selector, by name: root globs or roots; a root no selector matches is in
   * `default`. Without `group`, this job plans every root of the wave with the
   * plan identities and decides it, and the groups' jobs apply.
   */
  groups?: Record<string, string[]>;
  /** With `groups`: this job applies group `group` of the wave (with `share`, that share of the group), the plans the wave's job decided on. */
  group?: string;
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
  /** Set by the wave's job with `waves.compose` on: what it comes to for this change (./compose.ts). */
  composition?: Composition;
  /**
   * Plain roots only (terragucci#1161): the directory the pipeline downloads
   * the earlier waves' report artifacts into. With it, the job writes its
   * wave's outcome beside its report, and a root whose upstream did not apply
   * in this run is blocked while the rest of the wave applies (@intentius/chant/wave-blocked).
   */
  after?: string;
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
  if (options.groups && options.terragrunt) throw new ConfigError("--groups splits a wave of plain roots by identity; a Terragrunt repo's units apply with terragrunt.credentials in one job");
  if (options.group !== undefined && !options.groups) throw new ConfigError("--group names one of --groups, so it needs --groups");
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
  /** Each denied root's policy error, for the report of a wave chant refused. */
  denials?: Map<string, string>;
  /** Who policy.override at base lists: everyone who may override a denied root of the wave, as chant's override gate takes them. */
  overriders?: string[];
  /** With scoped `policy.override` entries at base, who may override each denied root (./override.ts). */
  overridersByRoot?: Map<string, Overriders>;
  /** Under pr-review, the merged pull request's review of plans that moved since. */
  reviewMoved?: Extract<ReviewOutcome, { kind: "moved" }>;
  /** The digest of the stopped apply whose rest this one applies under its approval. */
  resumes?: string;
  /** The changes each applied plan makes, when the wave applies per resource: recorded beside the approval it applies under. */
  changes?: ApprovedChange[];
  /** The approval chant let the wave through under. */
  approvedBy?: string;
  approvedAt?: string;
  /** The people behind the change, once the gate asked (./involved.ts). */
  involved?: Involved;
  /** The migration wave 1 is held on, so a refusal names the roots that moved. */
  migration?: HeldMigration;
  /** When the wave's last call back from chant ended, Unix nanoseconds: its gate's span starts there, so it holds chant's decision too. */
  callEnded?: bigint;
}

/** A migration wave 1 is held on: its roots, and each one's state as its pending fact names it. */
export interface HeldMigration {
  roots: string[];
  members: { member: string; planDigest: string }[];
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
  // When the job's run of the stage began: each wave's stage duration counts from here.
  const began = nowNanos();
  const work = mkdtempSync(join(tmpdir(), "terragucci-apply-"));
  const jobs = new Map<number, WaveJob>();
  const jobOf = (k: number): WaveJob => {
    let j = jobs.get(k);
    if (!j) {
      const facts: WaveFacts = {};
      const observer = new StageObserver(telemetryFromEnv(env), APPLY_OP, env, began);
      observer.wave = { number: k, facts };
      j = { k, w: { observer }, facts, label: `wave ${k}` };
      jobs.set(k, j);
    }
    return j;
  };
  let code: number = EXIT.failed;
  let last = options.wave;
  // One apply job per identity: the wave's roots by group, and this job's part of the wave (the run view counts parts across groups).
  let grouped: { name: string; roots: string[]; shares: number }[] | undefined;
  let part: number | undefined;
  try {
    let specWaves: string[][] | number;
    if (options.terragrunt) {
      // Each wave finds its units at plan time. With --rest this job's wave is the last of the spec, and goes on through the waves terragrunt find gives.
      specWaves = options.rest ? options.wave : Math.max(options.layers.filter((l) => l.length > 0).length, options.wave);
    } else {
      let waves = applyWaves(options.layers, options.canary);
      if (!waves[options.wave - 1]) {
        jobOf(options.wave).facts.nothing = true;
        console.log(`wave ${options.wave}: this repo has ${waves.length} waves, so there is nothing to apply`);
        return (code = EXIT.applied);
      }
      // waves.compose: the roots this change reaches run as one target in the earliest wave they are in (./compose.ts).
      const composition = await waveComposition(repo, options, waves);
      if (composition) {
        options = { ...options, composition };
        waves = wavesWithRun(waves, composition, true);
        // Every root of this wave moved into the composed run in an earlier wave: that wave's job applied them, so this one has none.
        if (waves[options.wave - 1]!.length === 0) {
          jobOf(options.wave).facts.nothing = true;
          console.log(`wave ${options.wave}: its roots apply in the composed run in wave ${composition.wave}, so this wave has nothing to apply`);
          return (code = EXIT.applied);
        }
      }
      // terragucci#1161: a root whose upstream did not apply in this run is blocked, and the rest of the wave goes on.
      // A composed run plans its roots as one, so after a change that composes, a root that did not apply holds every later wave, as before.
      if (options.after !== undefined && options.wave > 1) {
        const blocked = composition ? composedBlocked(repo, options, waves[options.wave - 1]!) : await waveBlocked(repo, options, waves);
        if (blocked.size > 0) {
          const j = jobOf(options.wave);
          j.w.blocked = blocked;
          const left = waves[options.wave - 1]!.filter((r) => !blocked.has(r));
          console.log(`wave ${options.wave}: ${blockedWords(blocked)}, so ${blocked.size === 1 ? "it is" : "they are"} not planned${left.length ? `; ${left.join(", ")} ${left.length === 1 ? "goes" : "go"} on` : ""}`);
          waves = waves.map((l, i) => (i === options.wave - 1 ? left : l));
          if (left.length === 0) {
            // Every root of the wave is blocked: the report says so, and the wave applies nothing.
            const read = await waveSettings(repo, options, options.config ?? findConfig(repo));
            if (!("error" in read)) Object.assign(j.w, { settings: read.settings, planned: [], roots: [], started: new Date().toISOString() });
            writeOutcome(env, `wave ${options.wave}: every root is blocked: ${blockedWords(blocked)}`, j.w);
            const run = earlierWaveOutcomes([options.after, join(repo, WAVE_REPORT_DIR)], options.wave).members;
            for (const [root, by] of blocked) run.set(root, { status: "blocked", by, wave: options.wave, at: "" });
            return (code = onlyWaiting(run) ? EXIT.waiting : EXIT.failed);
          }
        }
      }
      // chant's spec numbers waves by place: an emptied wave keeps its place, holding the run's target (./compose.ts).
      specWaves = composition ? specWavesWithRun(applyWaves(options.layers, options.canary), composition) : waves;
      if (options.groups) {
        // Each group's roots spread across its own shares with waves.jobs, as a wave's do.
        const jobs = options.shares;
        grouped = groupsWithRun(waves[options.wave - 1]!, options.groups, options.composition).map((g) => ({ ...g, shares: jobs !== undefined ? shareCount(g.roots, jobs) : 1 }));
        if (options.group !== undefined) {
          const at = grouped.findIndex((g) => g.name === options.group);
          const mine = grouped[at];
          if (!mine || (options.share ?? 1) > mine.shares) {
            jobOf(options.wave).facts.nothing = true;
            console.log(`wave ${options.wave} of ${waves.length}: group ${options.group} has ${mine ? `${mine.roots.length} roots in ${mine.shares} share${mine.shares === 1 ? "" : "s"}` : "no root in this wave"}, so this job has nothing to apply`);
            return (code = EXIT.applied);
          }
          if (mine.shares > 1 && options.share === undefined) throw new ConfigError(`group ${mine.name} of wave ${options.wave} spreads across ${mine.shares} share jobs, so its job needs --share`);
          part = grouped.slice(0, at).reduce((n, g) => n + g.shares, 0) + (options.share ?? 1);
          options = { ...options, shares: mine.shares > 1 ? mine.shares : undefined, share: mine.shares > 1 ? options.share : undefined };
        }
      } else if (options.shares !== undefined) {
        // A wave of one root, or one job, applies in its own job; a share past the wave's roots has nothing to apply.
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
    if (rule?.point && rule.approvalRules) throw new ConfigError("apply.point and approval_rules are both set at base; a wave gate that asks a decision point takes its deciders and quorum from the point, so drop one of them");
    if (rule?.mode === "ledger" && rule.approvalRules?.some((r) => r.roles?.length || r.notAuthor)) throw new ConfigError(`approval_rules at base names roles or not_author, and approval is ledger (${rule.source}): ${LEDGER_PROVES_NOBODY}`);
    // Each wave's gate: the stricter of the pipeline's --gate and the top-level gate at base, or with `environments` at base the
    // strictest gate of the wave's roots (./environments.ts). A composed run's wave takes the strictest gate of its own roots and the run's.
    const { gates, top } = await environmentWaveGates(repo, base, configPath, options, options.composition && typeof specWaves !== "number" ? wavesWithRun(applyWaves(options.layers, options.canary), options.composition, false) : specWaves);
    if (top !== options.gate) {
      console.log(`wave ${options.wave}: gate ${top}, the top-level gate at base, which is stricter than the pipeline's --gate ${options.gate}; a looser gate takes effect from the merge after the change that sets it`);
      options = { ...options, gate: top };
    }
    if (typeof specWaves !== "number" && gates[options.wave - 1] !== options.gate) {
      console.log(`wave ${options.wave}: gate ${gates[options.wave - 1]}, the strictest of its roots' environments at base`);
      options = { ...options, gate: gates[options.wave - 1]! };
    } else if (typeof specWaves === "number" && gates[0] !== options.gate) {
      console.log(`wave ${options.wave}: gate ${gates[0]}, the strictest of the environments at base, since a Terragrunt wave finds its units when it plans`);
      options = { ...options, gate: gates[0]! };
    }
    // allow_unattended at base: the gate is decided once the policy has read the plans, so chant's gate is never and the held hook holds (decideWaveGate).
    const unattended = rule?.policyOutcomes?.includes("allow_unattended") === true;
    if (unattended) console.log(`wave ${options.wave}: policy.outcomes at base names allow_unattended, so the wave's gate (${options.gate}) is decided once the policy reads its plans, and holds the wave through its held hook`);
    const ctx: WavesContext = { rule, configPath, work, ...(part !== undefined ? { part } : {}), planned: (k) => jobs.get(k)?.w.planned, ...(unattended ? { unattended } : {}), migrated: new Set() };
    // terragucci#1303: every wave plans and applies through chant's step, in this process.
    const read = await waveSettings(repo, options, configPath);
    if ("error" in read) {
      console.log(`wave ${options.wave}: ${read.error}, so nothing in it was applied`);
      return (code = EXIT.failed);
    }
    const stepsRead = waveSteps(repo, options);
    if ("error" in stepsRead) {
      console.log(`wave ${options.wave}: ${stepsRead.error}, so nothing in it was applied`);
      return (code = EXIT.failed);
    }
    // The migration hook and the gate's report call back into this process over a local socket: terragucci's own opinion pieces.
    const server = await serveWave(repo, work, (r) => waveCall(repo, options, ctx, r, jobOf));
    let ran: { code: number; result?: RunOpWaveResult };
    try {
      ran = await runStepWave(repo, options, ctx, jobOf, { chant: await import("@intentius/chant/op"), settings: read.settings, specWaves, base, gates, approval: rule?.mode ?? "ledger", ...(rule?.point ? { point: rule.point } : {}), ...(grouped ? { grouped } : {}) });
    } finally {
      await server.close();
    }
    const rest = ran.result?.rest;
    if (rest?.length) last = rest[rest.length - 1]!.wave;
    const j = jobOf(last);
    code = waveExit(ran.code, j.code);
    const piece = options.group !== undefined || options.share !== undefined;
    const pieceName = `${options.group !== undefined ? `group ${options.group}` : ""}${options.group !== undefined && options.share !== undefined ? " " : ""}${options.share !== undefined ? `share ${options.share}` : ""}`;
    if (piece && ran.result?.decision) {
      // A share or group job reports the gate its wave's job decided.
      j.w.digest = ran.result.decision.digest;
      if (ran.result.decision.status === "approved" || ran.result.decision.status === "not-required") j.w.approval = ran.result.decision.status;
    }
    if (piece && ran.code === EXIT.refused && ran.result?.moved.length) {
      const moved = [...ran.result.moved].sort();
      if (ran.result.decision?.status === "approved") j.w.refused = { reason: "approval", approved: ran.result.decision.digest, roots: moved };
      writeOutcome(options.env, `wave ${last} ${pieceName} changed since the wave decided: ${moved.join(", ")}`, j.w);
    }
    if (options.after !== undefined && !options.terragrunt && code === EXIT.applied && !((grouped || options.shares !== undefined) && !piece)) {
      // terragucci#1161: the wave applied what it could. It ends as failed when it blocked a root, and the last wave when
      // the run did not apply every root; as waiting when every root that did not apply waits for an approval, or is
      // blocked behind one, so the commit's status stays pending and the approval's re-run applies them.
      const run = new Map<string, WaveMemberOutcome>(earlierWaveOutcomes([options.after, join(repo, WAVE_REPORT_DIR)], last).members);
      for (const [root, o] of Object.entries(rootOutcomes(code, j.w))) run.set(root, o);
      const held = onlyWaiting(run) ? EXIT.waiting : EXIT.failed;
      const summary = last === applyWaves(options.layers, options.canary).length ? runSummary(run.values()) : undefined;
      if (j.w.blocked?.size || summary) {
        j.w.appliedRest = true;
        code = held;
        if (j.w.blocked?.size) console.log(`${j.label}: applied its other roots; blocked: ${blockedWords(j.w.blocked)}`);
        // The last wave says how the run came out: "the run: 8 applied, 1 failed, 6 blocked".
        if (summary) console.log(`${j.label}: the run: ${summary}`);
        writeOutcome(options.env, summary ? `the run: ${summary}` : `wave ${last} applied its other roots; blocked: ${blockedWords(j.w.blocked!)}`, j.w);
      }
    }
    if ((grouped || options.shares !== undefined) && !piece && code === EXIT.applied) {
      // The share or group jobs apply: chant's decision goes to the decision file the pipeline hands them.
      const file = options.decided ?? join(repo, decidedPath(options.wave));
      mkdirSync(dirname(file), { recursive: true });
      copyFileSync(join(repo, waveRecordPath(options.wave)), file);
      j.w.decided = true;
      const parts = grouped ? grouped.reduce((n, g) => n + g.shares, 0) : options.shares!;
      j.w.shareCount = parts;
      const how = grouped ? `its ${grouped.length} group job${grouped.length === 1 ? "" : "s"} (${grouped.map((g) => g.name).join(", ")})` : `its ${parts} share job${parts === 1 ? "" : "s"}`;
      console.log(`${j.label}: ${ran.result?.decision?.status === "approved" ? "approved" : "no approval needed"}; ${how} apply these plans`);
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
      if (options.after !== undefined && !options.terragrunt) w.outcomes = reportOutcomes(rootOutcomes(c, w), w);
      // The report is written once the wave's roots planned, whatever came of the gate and the apply.
      if (w.planned) await writeWaveReport(repo, options, w as Required<WaveRun>, env).catch((e) => console.log(`wave ${k}: the report was not written: ${(e as Error).message}`));
      // terragucci#1161: each root's outcome, for the waves after this one to read.
      if (options.after !== undefined && !options.terragrunt) {
        try {
          const dir = join(repo, WAVE_REPORT_DIR);
          mkdirSync(dir, { recursive: true });
          // A job with nothing to apply (its roots applied in an earlier composed run, or another share has them) names no root.
          const piece = options.group !== undefined || options.share !== undefined;
          const layer = piece || jobs.get(k)!.facts.nothing ? [] : (applyWaves(options.layers, options.canary)[k - 1] ?? []);
          // A state migration runs in wave 1 before its roots: a wave 1 that did not apply holds every later root.
          const holdsAll = k === 1 && c !== EXIT.applied && existsSync(join(repo, MIGRATIONS_DIR));
          writeWaveOutcomeFile(dir, k, { ...(options.group !== undefined ? { group: options.group } : {}), ...(options.share !== undefined ? { share: options.share } : {}) }, rootOutcomes(c, w, layer), undefined, holdsAll);
        } catch (e) {
          console.log(`wave ${k}: its outcome was not written, so the waves after it take its roots as not applied: ${(e as Error).message}`);
        }
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

/** chant's wave job in this process (`@intentius/chant/op`): the run, a run's plan path and the async exec its command hooks call back through. */
type StepChant = Pick<typeof import("@intentius/chant/op"), "runOpWave" | "opWavePlanPath" | "spawnExecAsync">;

/**
 * A wave's registry with `terraform-apply` (chant#4545, ruling C), built
 * with terragucci's resolver (chant#4857, #4858): each root runs the release
 * it pins, installed and checked as its own plan did, and a read of an
 * upstream's state runs with that upstream's role, workspace and the wave's
 * provider cache. Under `waves.compose` its group methods are chant's
 * composed run (`composeGroup`, chant#4848) over the project terragucci
 * composed the run in; terragucci already left out a root whose identity
 * differs, so chant reads no identity of its own. A composed run keeps the
 * project's binary. chant runs a binary with the job's environment, so each
 * root's binary is a script of its name that leaves the forge tokens out
 * first (tokenlessBinary), as terragucci's own runs left them out.
 */
/**
 * What chant runs for a root's binary: the same-named script that leaves the
 * forge tokens out (tokenlessBinary), by its path. choudoufu is the
 * exception: the terraform lexicon finds a root's estate only for a binary
 * named `choudoufu`, so chant runs it by name and `path` puts the script's
 * directory first on the root's PATH.
 */
function stepBinary(work: string, resolved: string, job: NodeJS.ProcessEnv): { binary: string; path?: (was: string | undefined) => string } {
  const script = tokenlessBinary(join(work, "bin"), resolved, job);
  if (basename(resolved) !== "choudoufu") return { binary: script };
  return { binary: "choudoufu", path: (was) => [dirname(script), was ?? ""].filter(Boolean).join(delimiter) };
}

function waveCapabilities(repo: string, binaries: RootBinaries, cache: WaveCache, work: string, c?: Composition, env: NodeJS.ProcessEnv = process.env): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const job = { ...process.env, ...env };
  const cap = terraformApplyCapabilityWith({
    resolveRoot: async (root) => {
      const run = stepBinary(work, (await binaries.resolve(root)).path, job);
      const readEnv = binaryEnv(workspaceEnv(rootRoleEnv({ ...process.env, TF_PLUGIN_CACHE_DIR: cache.dir }, root), join(repo, root)));
      return { binary: run.binary, readEnv: definedEnv(run.path ? { ...readEnv, PATH: run.path(readEnv.PATH) } : readEnv) };
    },
  });
  const terraform = c?.terraform;
  // The composed run takes the project's binary by name, and the job's environment less its forge tokens.
  const composed = terraform;
  const group = composed ? composeGroup({ project: async () => ({ projectRoot: repo, terraform: composed }), identity: async () => undefined, env: binaryEnv({ ...job, TF_PLUGIN_CACHE_DIR: cache.dir }), log: (l) => console.log(l) }) : undefined;
  registry.register((group ? { ...cap, ...group } : cap) as never);
  return registry;
}

/** The summary line terraform prints, from a plan's change-set entries. */
function stepSummary(entries: readonly { action: string }[]): string {
  const n = (a: string) => entries.filter((e) => e.action === a).length;
  const add = n("create") + n("replace");
  const change = n("update");
  const destroy = n("delete") + n("replace");
  return add + change + destroy === 0 ? "No changes." : `Plan: ${add} to add, ${change} to change, ${destroy} to destroy.`;
}

/** What a root's run hooks gave it on chant's step: the environment it planned with, its binary and the `ci.hooks` that ran for it. */
interface StepRoot {
  env: NodeJS.ProcessEnv;
  binary: string;
  bin: ReportRootBinary;
  steps: ReportStep[];
  holds: string[];
}

/** A root's plan as terragucci's report reads it, from the plan file chant's step wrote and its `show -json` (terragucci#1303). */
function stepPlannedRoot(repo: string, options: ApplyWaveOptions, w: WaveRun, run: { target: string; planDigest: string; plan: string; planJson?: string }, own?: StepRoot): PlannedRoot {
  const timing = w.observer.root(run.target);
  w.observer.endRoot(timing);
  let file: { artifact?: { planFile?: string }; changeSet?: { entries?: { action: string }[] } } = {};
  try {
    file = JSON.parse(readFileSync(join(repo, run.plan), "utf-8")) as typeof file;
  } catch {
    // The report then counts no changes for it.
  }
  let plan: unknown;
  try {
    plan = run.planJson ? JSON.parse(readFileSync(run.planJson, "utf-8")) : undefined;
  } catch {
    plan = undefined;
  }
  const entries = file.changeSet?.entries ?? [];
  const changed = entries.filter((e) => e.action !== "no-op" && e.action !== "read");
  const env = own?.env ?? options.env ?? process.env;
  const base = { root: run.target, timing, planFile: file.artifact?.planFile ?? "", env, binary: own?.binary ?? options.binary, bin: own?.bin ?? { name: basename(options.binary) }, steps: own?.steps ?? ([] as ReportStep[]), holds: own?.holds ?? ([] as string[]) };
  if (plan === undefined) return { ...base, changes: 0, destroys: 0, summary: "", error: "chant's step wrote no plan document to read" };
  return {
    ...base,
    member: { member: run.target, planDigest: run.planDigest },
    plan,
    changes: changed.length,
    destroys: changed.filter((e) => e.action === "delete" || e.action === "replace").length,
    summary: stepSummary(entries),
  };
}

/** What every hook of one wave on chant's step shares (terragucci#1303). */
interface StepContext {
  repo: string;
  options: ApplyWaveOptions;
  ctx: WavesContext;
  settings: ResolvedSettings;
  chant: StepChant;
  spec: OpWavesSpec;
  binaries: RootBinaries;
  cache: WaveCache;
  ws?: WaveSteps;
  sources?: SourceChecker;
  /** What each root's run hooks gave it, by root. */
  roots: Map<string, StepRoot>;
  jobOf: (k: number) => WaveJob;
  /** The roots an estate migration plans until it applies, as digest members of their own (pendingEstateMigrations). */
  migrationMembers: WaveMember[];
  /** A Terragrunt wave's units (chant#4848, #4849). */
  units?: StepUnits;
}

/** What a Terragrunt wave on chant's `terragrunt-apply` step shares (terragucci#1303). */
interface StepUnits {
  /** The Terragrunt the job runs, and how: with terragucci's lock timeout, its backend bootstrap and its sources check. */
  terragrunt: string;
  exec: TerragruntExec;
  /** What each unit runs, a pinned release installed and checked. */
  tools: UnitBinaries;
  /** The units the sources check refused after their init, and those it was asked about. */
  refused: Map<string, string[]>;
  asked: Set<string>;
  /** A unit whose azurerm backend Terragrunt bootstraps. */
  azure: Set<string>;
  /** Each wave's units, as chant's step found them. */
  found: Map<number, string[]>;
  /** The units whose failure the wave already named. */
  said: Set<string>;
  /** The waves Terragrunt's graph cuts the pipeline's into, and which unit reads which. */
  cut?: string[][];
  edges?: Map<string, Set<string>>;
}

/**
 * A Terragrunt wave's units on chant's step: the job's Terragrunt with
 * terragucci's lock timeout, its backend bootstrap when `generate` asks for
 * one, and, with `sources` at base, the check of what each unit's init
 * fetched before it plans (./sources-terragrunt.ts).
 */
function stepUnits(s: StepContext, terragrunt: string): StepUnits {
  const { repo, options, settings } = s;
  const env = options.env ?? process.env;
  // shape: Terragrunt's backend bootstrap. generate's disable_init: false asks Terragrunt to init the backend; only the apply job may create or change the bucket.
  const bootstrap = backendBootstrap(repo, settings) && env.TG_BACKEND_BOOTSTRAP === undefined;
  if (bootstrap) console.log(`wave ${options.wave}: generate gives a unit disable_init: false, so Terragrunt bootstraps its backend (TG_BACKEND_BOOTSTRAP)`);
  const timed = unitLockTimeoutExec(bootstrapExec(options.terragruntExec ?? terragruntExec, bootstrap), env);
  const refused = new Map<string, string[]>();
  const asked = new Set<string>();
  const exec = s.sources ? unitSourcesExec(timed, s.sources, options.binary, env, refused, asked) : timed;
  const azure = bootstrap ? new Set(bootstrapUnits(repo, settings).filter((b) => b.backend === "azurerm").map((b) => b.unit)) : new Set<string>();
  return { terragrunt, exec, tools: new UnitBinaries(repo, options.binary, settings.version, terragrunt, env, options.installer), refused, asked, azure, found: new Map(), said: new Set() };
}

/**
 * A Terragrunt wave's registry: the terraform lexicon's `terragrunt-apply`
 * (chant#4848) with the job's Terragrunt and each unit's pinned releases
 * (chant#4849). Its discovery is the step's, and terragucci reads what it
 * found: each wave's units, the waves the graph cuts the pipeline's into,
 * and the units no wave lists, which it names.
 */
function unitCapabilities(s: StepContext, u: StepUnits): CapabilityRegistry {
  const { repo, options, settings } = s;
  const cap = terragruntApplyCapability({ exec: u.exec, resolveUnit: async (unit) => { const t = await u.tools.resolve(unit); return { terragrunt: t.terragrunt, binary: t.binary }; } });
  const registry = new CapabilityRegistry();
  registry.register({
    ...cap,
    discoverRuns: async (ctx: Parameters<NonNullable<typeof cap.discoverRuns>>[0], input: Parameters<NonNullable<typeof cap.discoverRuns>>[1]) => {
      const k = ctx.wave.number;
      if (!u.cut) {
        // Which unit reads which: only Terragrunt's own discovery knows.
        const units = await discoverUnits(repo, { exclude: settings.terragrunt?.exclude, binary: options.binary, terragrunt: u.terragrunt, exec: u.exec });
        const listed = options.layers.filter((l) => l.length > 0);
        if (units.source !== "terragrunt find") {
          console.log(`wave ${k}: ${units.notes.join("; ")}`);
          console.log(`wave ${k}: without Terragrunt's discovery nobody knows which units read which, so nothing in it was applied`);
          throw new Error("Terragrunt's discovery did not run");
        }
        try {
          u.cut = refineWaves(listed, units.units);
        } catch (e) {
          console.log(`wave ${k}: ${(e as Error).message}, so nothing was applied`);
          throw e;
        }
        u.edges = unitEdges(units.units);
        if (u.cut.length !== listed.length) console.log(`wave ${k}: Terragrunt's edges cut the pipeline's ${waves(listed.length)} into ${u.cut.length}; run terragucci init to give each wave its own job`);
        const unlisted = units.units.map((x) => x.path).filter((p) => !listed.some((l) => l.includes(p)) && !options.elsewhere?.includes(p));
        if (unlisted.length > 0) console.log(`wave ${k}: the pipeline does not list ${unlisted.join(", ")}, so no wave applies it; run terragucci init to add it`);
      }
      const found = await cap.discoverRuns!(ctx, input);
      u.found.set(k, [...found.targets]);
      const w = s.jobOf(k).w;
      w.count = u.cut.length;
      w.units = { waves: u.cut, edges: u.edges ?? new Map() };
      if (found.targets.length === 0) {
        s.jobOf(k).facts.nothing = true;
        console.log(`wave ${k}: this repo has ${waves(u.cut.length)}, so there is nothing to apply`);
      } else console.log(`wave ${k} of ${u.cut.length}: planning ${found.targets.join(", ")}`);
      return found;
    },
  } as never);
  return registry;
}

/** The `ci.hooks` environment of a root: the job's, with its role, workspace and the wave's provider cache, never its secrets. */
function stepHookEnv(s: StepContext, root: string): WaveSteps | undefined {
  if (!s.ws) return undefined;
  const dir = join(s.repo, root);
  return { ...s.ws, env: rootCacheEnv(workspaceEnv(rootRoleEnv({ ...s.ws.env, TF_PLUGIN_CACHE_DIR: s.cache.dir }, root), dir), dir, s.binaries.expected(root).name) };
}

/** Every value set, as chant hands a run's environment to its engine. */
const definedEnv = (env: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

/**
 * The run hooks of a wave on chant's step (chant#4842): before each root
 * plans, its environment (its role, its workspace, the wave's provider cache,
 * and the values `secrets` gives it; the binary it pins is chant's to run, from terragucci's resolver),
 * the sources check before and after its init, and its `before-observe` and
 * `before-plan` hooks; around its apply, its `before-apply` and `after-apply`
 * hooks; after it applied, the state version, the record versions and the
 * applied state the report shows.
 */
function stepRunHooks(s: StepContext): import("@intentius/chant/op").OpWaveRunHooks {
  const { repo, options, settings } = s;
  return {
    name: "terragucci",
    async beforePlan(run) {
      if (s.units) return unitBeforePlan(s, s.units, run.target);
      const root = run.target;
      const dir = join(repo, root);
      const expected = s.binaries.expected(root);
      const own: StepRoot = { env: {}, binary: options.binary, bin: expected, steps: [], holds: [] };
      s.roots.set(root, own);
      const refused = s.sources ? await s.sources.before(root) : [];
      if (refused.length) return { refuse: `refused by sources, so it was not initialised\n${refused.join("\n")}` };
      let resolved: RootBinary;
      try {
        resolved = await s.binaries.resolve(root);
      } catch (e) {
        return { refuse: (e as Error).message };
      }
      own.binary = resolved.path;
      own.bin = { name: resolved.name, ...(resolved.version ? { version: resolved.version } : {}), ...(resolved.pin ? { pin: resolved.pin } : {}) };
      if (own.bin.pin) console.log(`${root}: ${binaryText(own.bin)}`);
      const roleEnv = rootCacheEnv(workspaceEnv(rootRoleEnv({ ...process.env, TF_PLUGIN_CACHE_DIR: s.cache.dir }, root), dir), dir, expected.name);
      try {
        own.env = await rootSecretEnv(roleEnv, root, settings.secrets);
        // choudoufu runs by name, its tokenless script first on PATH (stepBinary).
        const run = stepBinary(s.ctx.work, resolved.path, { ...process.env, ...(options.env ?? {}) });
        if (run.path) own.env = { ...own.env, PATH: run.path(own.env.PATH ?? process.env.PATH) };
      } catch (e) {
        return { refuse: `a value of secrets could not be read, so it was not planned\n${(e as Error).message}` };
      }
      for (const moment of ["before-observe", "before-plan"] as const) {
        const error = await rootSteps(repo, { root, steps: own.steps, holds: own.holds }, stepHookEnv(s, root), moment);
        if (error) return { refuse: error };
      }
      const check = s.sources;
      return {
        env: definedEnv(own.env),
        ...(check
          ? {
              afterInit: async () => {
                const fetched = await check.afterInit(root, repo, own.env);
                if (fetched.length) throw new Error(`refused by sources after init, so it was not planned\n${fetched.join("\n")}`);
              },
            }
          : {}),
      };
    },
    async beforeApply(run) {
      // Under an approval, before the wave's first apply: the changes its plans make, beside the approval (recordChanges).
      const j = s.jobOf(run.wave);
      if (!j.w.applyStarted) {
        j.w.applyStarted = new Date().toISOString();
        await recordChanges(repo, j.label, j, options.now);
      }
      const own = s.roots.get(run.target);
      if (!own) return;
      if (s.units) {
        const error = await unitStep(s, run.target, own, "before-apply", unitPlanFile(repo, run));
        if (error) throw new Error(error);
        return;
      }
      const error = await rootSteps(repo, { root: run.target, steps: own.steps, holds: own.holds }, stepHookEnv(s, run.target), "before-apply", planFileOf(repo, run));
      if (error) throw new Error(error);
    },
    async afterApply(run) {
      const own = s.roots.get(run.target);
      if (!own || run.outcome !== "applied") return;
      if (s.units) {
        // A unit's state is in Terragrunt's cache: its backend comes from its evaluated remote_state block (recordUnitStateVersions).
        const w = s.jobOf(run.wave).w;
        const versions = await recordUnitStateVersions(repo, [run.target], { terragrunt: s.units.terragrunt, exec: s.units.exec, binary: own.binary }, options.env ?? process.env);
        for (const [unit, v] of versions) (w.states ??= new Map()).set(unit, v);
        console.log(`applied ${run.target}`);
        const error = await unitStep(s, run.target, own, "after-apply");
        if (error) throw new Error(error);
        return;
      }
      const error = await rootSteps(repo, { root: run.target, steps: own.steps, holds: own.holds }, stepHookEnv(s, run.target), "after-apply");
      if (error) throw new Error(error);
      const w = s.jobOf(run.wave).w;
      const p = w.planned?.find((x) => x.root === run.target);
      if (!p) return;
      const planned = { ...(p as PlannedRoot), env: own.env, binary: own.binary };
      (w.states ??= new Map()).set(run.target, await stateVersion(join(repo, run.target), own.env));
      logStateVersions([run.target], w.states);
      const versions = await listRecordVersions(repo, [planned], 1);
      if (versions.has(run.target)) (w.recordVersions ??= new Map()).set(run.target, versions.get(run.target)!);
      const shown = showAppliedState(repo, planned);
      if (shown !== undefined) (w.appliedStates ??= new Map()).set(run.target, shown);
    },
  };
}

/**
 * Before a unit of a Terragrunt wave on chant's step plans (chant#4848): the
 * sources check, the releases it pins, the azurerm bootstrap the Terragrunt
 * it runs can make, and its `before-observe` and `before-plan` hooks. The
 * units of one `run --all` run with one environment, the job's.
 */
async function unitBeforePlan(s: StepContext, u: StepUnits, unit: string): Promise<{ refuse?: string }> {
  const own: StepRoot = { env: {}, binary: s.options.binary, bin: { name: basename(s.options.binary) }, steps: [], holds: [] };
  s.roots.set(unit, own);
  const refused = s.sources ? await s.sources.before(unit) : [];
  if (refused.length) return { refuse: `refused by sources, so it was not initialised\n${refused.join("\n")}` };
  let tools: UnitTools;
  try {
    tools = await u.tools.resolve(unit);
  } catch (e) {
    return { refuse: (e as Error).message };
  }
  own.binary = tools.binary;
  own.bin = tools.report;
  if (tools.report.pin || tools.report.terragrunt?.pin) console.log(`${unit}: ${binaryText(tools.report)}`);
  // Terragrunt bootstraps an azurerm backend from 1.2 on; an older release would skip the storage account and the container.
  const old = u.azure.has(unit) ? azureBootstrapRefusal(unit, tools.report.terragrunt?.version) : undefined;
  if (old) {
    console.log(`FAILED ${unit}: ${old}`);
    return { refuse: old };
  }
  for (const moment of ["before-observe", "before-plan"] as const) {
    const error = await unitStep(s, unit, own, moment);
    if (error) return { refuse: error };
  }
  return {};
}

/** Say once that a unit failed, and why, as the wave's lines and its report name it. */
function unitFailed(u: StepUnits, w: WaveRun, unit: string, why: string): void {
  if (u.said.has(unit)) return;
  u.said.add(unit);
  console.log(`FAILED ${unit}: ${why.split("\n")[0]}`);
  console.log(indent(why));
  w.failed = [...(w.failed ?? []), unit];
}

/** A unit's `ci.hooks` at one moment, in its directory, with the job's environment. Returns the error of a hook that failed. */
async function unitStep(s: StepContext, unit: string, own: StepRoot, when: HookMoment, planFile?: string): Promise<string | undefined> {
  if (!s.ws) return undefined;
  const outcomes = await runUnitHooks(s.ws.hooks, when, [unit], { repo: s.repo, stage: "tf-apply", env: s.ws.env, log: (l) => console.log(l), ...(planFile ? { planFile: () => planFile } : {}) });
  const o = outcomes.get(unit);
  if (!o) return undefined;
  own.steps.push(...o.runs);
  if (o.holds.length) own.holds.push(...o.holds);
  return o.error;
}

/** A unit's saved plan, beside the plan document chant's step names in its artifact. */
function unitPlanFile(repo: string, run: { target: string; artifact?: unknown; planJson?: string }): string | undefined {
  const json = (run.artifact as { planJson?: string } | undefined)?.planJson ?? run.planJson;
  const tail = `/json/${run.target}/tfplan.json`;
  if (!json?.endsWith(tail)) return undefined;
  const at = json.startsWith("/") ? json : join(repo, json);
  return `${at.slice(0, at.length - tail.length)}/plans/${run.target}/tfplan.tfplan`;
}

/** The plan file chant's step applies, as a `ci.hooks` hook gets it: the artifact's file in the root's directory. */
function planFileOf(repo: string, run: { target: string; artifact?: unknown }): string | undefined {
  const file = (run.artifact as { planFile?: string } | undefined)?.planFile;
  if (!file) return undefined;
  return file.startsWith("/") ? file : join(repo, run.target, file);
}

/**
 * The after-plan hook of a wave on chant's step (chant#4614, #4842,
 * terragucci#1303). `run` is called once per planned root: the deciding job's
 * first call reads every root's plan file, which chant wrote before it
 * called, builds the wave's report rows from them, prices them and runs the
 * policy over them. Each call runs the root's `after-plan` hooks and gives
 * chant its root's policy row (a denied root is a denial chant settles with
 * an override, by whoever `policy.override` at base names for it) and a
 * `held` row when one of its hooks asks for an approval. `wave` answers for
 * the wave once every root was called: who may override, the cost member,
 * the holds (cost over `cost.approve_above`, an upstream output unknown at
 * review, the policy's hold rules, and under `allow_unattended` a gate that
 * would hold), the pending fact's description and the report chant keeps
 * beside the pending fact. A policy that refuses the wave outright fails the
 * hook, so the wave stops before its gate.
 */
function stepAfterPlan(s: StepContext): import("@intentius/chant/op").OpWaveAfterPlanHook {
  const { repo, options, ctx, settings, chant, spec } = s;
  const waves = applyWaves(options.layers, options.canary);
  return {
    name: "terragucci",
    async run(r) {
      const j = s.jobOf(r.wave);
      const { w, facts } = j;
      const deciding = r.job === "wave" || r.job === "decide";
      // A Terragrunt wave's units are the ones chant's step found for it, and its waves the ones Terragrunt's graph cuts.
      const count = s.units?.cut?.length ?? waves.length;
      if (!w.planned) {
        j.label = deciding ? `wave ${r.wave} of ${count}` : `wave ${r.wave} of ${count}${options.group !== undefined ? `, group ${options.group}` : ""}${options.share !== undefined ? `, share ${options.share}` : ""}`;
        if (ctx.part !== undefined) w.share = ctx.part;
        else if (options.share !== undefined) w.share = options.share;
        w.settings = settings;
        w.started ??= new Date().toISOString();
        const targets = !deciding ? [r.target] : s.units ? (s.units.found.get(r.wave) ?? [r.target]) : (spec.waves[r.wave - 1]?.runs ?? []).map((x) => x.target);
        if (!s.units) {
          const linked = waveReads(repo, waves, targets, r.wave);
          w.reads = linked.reads;
          w.waveReads = afterWaves(repo, settings, options, targets, linked.waves, r.wave);
          logReads(j.label, linked.reads, waves);
        }
        const planned = targets.map((target) => {
          if (target === r.target) return stepPlannedRoot(repo, options, w, r, s.roots.get(target));
          const plan = chant.opWavePlanPath(spec, r.wave, target);
          let file: { planDigest?: string; artifact?: { planJson?: string } } = {};
          try {
            file = JSON.parse(readFileSync(join(repo, plan), "utf-8")) as typeof file;
          } catch {
            // stepPlannedRoot says it has no plan document.
          }
          const planJson = file.artifact?.planJson ? (file.artifact.planJson.startsWith("/") ? file.artifact.planJson : join(repo, file.artifact.planJson)) : undefined;
          return stepPlannedRoot(repo, options, w, { target, planDigest: file.planDigest ?? "", plan, ...(planJson ? { planJson } : {}) }, s.roots.get(target));
        });
        w.planned = planned;
        w.roots = targets;
        w.plannedAt = new Date().toISOString();
        facts.roots = targets;
        for (const p of planned) console.log(p.error ? `FAILED ${p.root}: ${p.error}` : `${p.root}: ${p.summary}`);
        w.changedRoots = planned.filter((p) => changesSomething(p.plan)).map((p) => p.root).sort();
        if (planned.every((p) => p.changes === 0)) facts.nothing = true;
        if (deciding) {
          const unpriced = await priceWave(repo, options, { label: j.label, settings, configPath: ctx.configPath, work: ctx.work }, planned, w);
          if (unpriced !== undefined) {
            j.code = unpriced;
            throw new Error("cost.approve_above could not be read at base");
          }
          const checked = await policyCheck(repo, options, ctx, { label: j.label, settings }, planned, j);
          if (typeof checked === "number") {
            j.code = checked;
            throw new Error(`the policy refused ${w.refused?.roots?.join(", ") ?? "a root"}`);
          }
        }
      } else if (!w.planned.some((p) => p.root === r.target)) {
        w.planned.push(stepPlannedRoot(repo, options, w, r, s.roots.get(r.target)));
        w.roots = [...(w.roots ?? []), r.target];
      }
      const p = w.planned.find((x) => x.root === r.target) as PlannedRoot | undefined;
      const own = s.roots.get(r.target);
      if (s.units) {
        // What a unit's init fetched and locked is checked before it plans (./sources-terragrunt.ts): a refused unit, or one the check never saw, is not applied.
        const refused = s.units.refused.get(r.target);
        const why = refused ? `${UNIT_REFUSED}\n${refused.join("\n")}` : s.sources && !s.units.asked.has(r.target) ? uncheckedUnit("applied") : undefined;
        if (why) {
          unitFailed(s.units, w, r.target, why);
          throw new Error(`${r.target}: ${why.split("\n")[0]}`);
        }
        if (own && p) {
          const error = await unitStep(s, r.target, own, "after-plan", unitPlanFile(repo, r));
          if (error) throw new Error(`${r.target}: ${error}`);
        }
      } else if (own && p) {
        const error = await rootSteps(repo, { root: r.target, steps: own.steps, holds: own.holds }, stepHookEnv(s, r.target), "after-plan", planFileOf(repo, r));
        if (error) throw new Error(`${r.target}: ${error}`);
      }
      const rows: import("@intentius/chant/op").OpWaveAfterPlanResult["policy"] = [];
      if (p?.policy) {
        const denied = j.denials?.has(r.target) === true;
        const rules = p.policy.rules ?? [];
        rows.push({ source: "terragucci", result: denied && rules.length ? "denied" : "passed", rules: denied ? rules : [], ...(denied && j.denials?.get(r.target) ? { reason: j.denials.get(r.target)!.split("\n")[0]! } : {}) });
      }
      if (own?.holds.length) rows.push({ source: "ci.hooks", result: "held", rules: [...own.holds], reason: `hook ${own.holds.join(", ")} asks for an approval` });
      // Scoped policy.override entries at base: who may override this root's denial, in place of the wave's list.
      const scoped = j.overridersByRoot?.get(r.target);
      return { ...(rows.length ? { policy: rows } : {}), ...(scoped && j.denials?.has(r.target) ? { overriders: scoped.principals } : {}) };
    },
    async wave(planned) {
      const j = s.jobOf(planned.wave);
      const { w } = j;
      if (planned.job !== "wave" && planned.job !== "decide") return {};
      const label = j.label;
      const plans = (w.planned ?? []) as PlannedRoot[];
      const changing = plans.filter((p) => changesSomething(p.plan));
      const changes = plans.reduce((n, p) => n + p.changes, 0);
      const destroys = plans.reduce((n, p) => n + p.destroys, 0);
      const gate = options.gate;
      const holds: string[] = [];
      const heldBySteps = plans.filter((p) => p.holds.length > 0).map((p) => p.root).sort();
      for (const p of plans) if (p.holds.length) console.log(`${label}: ${p.root}: hook ${p.holds.join(", ")} asks for an approval, so the gate holds this wave${changes === 0 ? " when it changes something" : ""}`);
      if (heldBySteps.length) w.heldBySteps = heldBySteps;
      // An upstream output unknown when the change was reviewed holds the wave under every gate but never (#1012).
      // An Atmos or Terramate read was reviewed on the upstream's applied state: one the change moved holds it the same way (#1053).
      const moved = new Set(changing.map((p) => p.root));
      const reads = changing.length === 0 || gate === "never" ? [] : s.units ? unitReads(repo, s.units.cut ?? [], planned.wave, s.units.edges ?? new Map(), changing.map((p) => p.root)) : [...rootReads(repo, waves, planned.wave, w.reads, moved), ...toolReads(repo, waves, planned.wave, moved)];
      // A Terragrunt wave compares what it plans with the pull request's preview (./tg-preview-gate.ts).
      if (s.units && changing.length > 0) {
        const units = changing.map((p) => ({ root: p.root, plan: p.plan, ...(p.member ? { member: p.member } : {}), changes: p.changes, destroys: p.destroys, outputs: true }));
        w.preview = await comparePreview({ repo, env: options.env ?? process.env, wave: planned.wave, binary: options.binary, ...(options.fetch ? { fetch: options.fetch } : {}), units }, (l) => console.log(`${label}: ${l}`));
      }
      const unknown = await unknownReadHold(repo, options, ctx, w, label, gate, reads, changing.map((p) => ({ root: p.root, plan: p.plan })));
      if (unknown.length) holds.push(`${unknown.map((u) => u.root).join(", ")} ${unknown.length === 1 ? "reads" : "read"} an output unknown when the change was reviewed`);
      // The policy's hold and allow_unattended rules, over the plans that change something (policy.outcomes at base).
      const ruled = changes > 0 ? waveRules(repo, ctx, j, changing, gate, destroys > 0) : undefined;
      if (ruled?.held) holds.push(ruled.outcome === "held" ? `the policy holds it for an approval (${w.policyGate?.rules.join(", ") ?? "hold"})` : `gate ${gate} holds it, and the policy does not let every root through`);
      if (changes > 0 && w.waveCost?.over === true) {
        console.log(`${label}: ${costReason(w.waveCost, w.costSource)}, so it waits for an approval`);
        holds.push(costReason(w.waveCost, w.costSource));
      }
      const priced = costMember(w.waveCost);
      // The digest chant decides, as it takes it over the plans that change something and the cost: the stored report names it.
      const members = plans.filter((p) => p.member).map((p) => p.member!);
      const moving = new Set(changing.map((p) => p.root));
      w.digest = waveSetDigest([...(moving.size > 0 ? members.filter((m) => moving.has(m.member)) : members), ...s.migrationMembers, ...(priced ? [priced] : [])]);
      const env = options.env ?? process.env;
      const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
      const roots = w.roots ?? [];
      // Only a gate that decides takes the approvals settled before it: under gate never with nothing holding, none is read.
      const approvals = changes > 0 && w.digest && (gate !== "never" || holds.length > 0 || heldBySteps.length > 0) ? await stepGateApprovals(s, j, w.digest, plans) : [];
      // A wave split across jobs is applied by those jobs; a whole one records the changes it applies, so a stopped apply resumes from them.
      const whole = options.shares === undefined && !options.groups;
      j.changes = whole && !s.units ? approvedChanges(plans.map((p) => ({ root: p.root, plan: p.plan, binary: p.bin.name ?? p.binary }))) : undefined;
      if (changing.length === 0 && whole && (gate !== "never" || w.waveCost)) await closeStopped(repo, label, planned.wave, options.now);
      return {
        // The pending fact names the members it asks approval for, as the respond job reads them.
        pending: { description: `${label}: ${(s.units ? changing.map((p) => p.root) : roots).join(", ")}`, ...(commit ? { commit } : {}), members: [...members.filter((m) => moving.has(m.member)), ...(priced && changing.length > 0 ? [priced] : [])] },
        ...(s.migrationMembers.length || (priced && changing.length > 0) ? { members: [...s.migrationMembers, ...(priced && changing.length > 0 ? [priced] : [])] } : {}),
        ...(changes > 0 ? { holds } : {}),
        ...(approvals.length ? { approvals } : {}),
        ...(j.overriders?.length ? { overriders: j.overriders, overridersSource: "policy.override in the config" } : {}),
        report: storedWaveReport(repo, options, planned.wave, w.digest ?? "", roots, plans),
      };
    },
  };
}

/**
 * The approvals a wave on chant's step settled before its gate, which the
 * wave answer hands chant to record for the digest it decides (chant#4859):
 * a covered round's (the approval of the pull request's plan these plans are
 * covered by), the rest of a stopped apply's (the approval that apply ran
 * under), and under `approval: pr-review` the merged pull request's
 * approving review of these plans. chant leaves out the people behind the
 * change and the agent, and counts `approval_rules`. None under
 * `apply.point`, whose gate the decision point answers.
 */
async function stepGateApprovals(s: StepContext, j: WaveJob, digest: string, plans: PlannedRoot[]): Promise<import("@intentius/chant/op").OpWaveAnswerApproval[]> {
  const { repo, options, ctx } = s;
  const rule = ctx.rule;
  if (!rule || rule.point) return [];
  const { w, k: wave, label } = j;
  const env = options.env ?? process.env;
  const name = waveGate(wave);
  const now = new Date().toISOString();
  const ledger = readLedger(repo);
  const stamp = (iso: string): number => new Date(iso).getTime();
  // The approvals chant will count: under sealed a sealed one, and none by someone who had a hand in the change.
  let latest: PendingRecord | undefined;
  for (const p of ledger.pending) if (p.gate === name && (!latest || stamp(p.timestamp) >= stamp(latest.timestamp))) latest = p;
  const since = latest ? stamp(latest.timestamp) : 0;
  const standing = ledger.resolutions.filter((r) => r.gate === name && stamp(r.timestamp) >= since);
  if (standing.length > 0 || rule.mode === "pr-review") {
    j.involved ??= await waveInvolvement(repo, options, rule);
    for (const n of j.involved.notes) console.log(`${label}: ${n}`);
  }
  const involved = j.involved;
  const ruled: GateLedger = {
    ...ledger,
    resolutions: ledger.resolutions.filter((r) => {
      if (r.gate !== name) return true;
      if (rule.mode === "sealed" && sealRefusal(rule.signers, r) !== null) return false;
      return stamp(r.timestamp) < since || !resolutionRefusal(r, { ...(involved ? { involved } : {}), signers: rule.signers, ...(rule.requireSigned ? { requireSigned: true } : {}) });
    }),
  };
  // A wave that planned again after its upstreams applied, covered by the pull request's plan (unknownReadHold): an approval of that plan's digest stands for it.
  if (w.covered) {
    const first = coveredApproval(ruled, name, digest, w.covered, now);
    if (first) {
      console.log(`${label}: ${first.by} approved ${w.covered.digest}, the pull request's plan these plans are covered by, so that approval stands for ${digest}`);
      return [{ resolvedBy: first.by, note: `covered by the approval of ${w.covered.digest} by ${first.by}: only ${w.covered.filledInputs.join(", ") || "inputs previewed as known after apply"} differ` }];
    }
  }
  const decision = decideGate(ruled, name, digest, now);
  if (decision.status !== "waiting") return [];
  // A plain wave whose approved apply stopped before it finished: plans that are the rest of the approved ones apply under that approval.
  const whole = options.shares === undefined && !options.groups;
  if (whole && decision.spent) {
    const stopped = stoppedApply(ledger, name, decision.spent.at);
    if (stopped?.changes) {
      const c = coverRemainder(stopped.changes, plans.map((p) => ({ root: p.root, plan: p.plan, binary: p.bin.name ?? p.binary })));
      if (c.covered) {
        console.log(`${label}: the apply of ${stopped.planDigest}, approved by ${decision.spent.by}, stopped before it finished; ${c.done.length} of its ${stopped.changes.length} change${stopped.changes.length === 1 ? "" : "s"} are done in the records, and these plans make the other ${c.remaining.length}, so that approval covers them`);
        j.resumes = stopped.planDigest;
        return [{ resolvedBy: decision.spent.by, note: `the rest of the apply of ${stopped.planDigest}, which ${decision.spent.by} approved at ${decision.spent.at}` }];
      }
      console.log(`${label}: the apply of ${stopped.planDigest}, approved by ${decision.spent.by}, stopped before it finished, but ${c.why}, so these plans need an approval of their own`);
    }
  }
  if (decision.spent) console.log(`${label}: the approval of ${decision.spent.approved} by ${decision.spent.by} was used by the apply of those plans, so these plans need an approval of their own`);
  if (rule.mode !== "pr-review") return [];
  // Under pr-review the merged pull request's approval of its head counts, when it reviewed these plans.
  const sha = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const priced = costMember(w.waveCost);
  const changesDigest = reviewDigest(plans.filter((p) => p.member).map((p) => ({ member: p.member!.member, planDigest: p.member!.planDigest, plan: p.plan })), priced ? [priced] : []);
  const r = await reviewWave({ env, ...(options.fetch ? { fetch: options.fetch } : {}), forge: forgeOfEnv(env), sha, wave, digest: changesDigest, ...(w.covered ? { covered: w.covered.digest } : {}), ...(involved ? { involved } : {}) });
  if (r.excluded?.length) {
    for (const e of r.excluded) console.log(`${label}: ${notCounted(e, "review")}`);
    w.excluded = mergeExcluded(w.excluded ?? [], r.excluded);
  }
  if (r.kind === "approved") {
    console.log(`${label}: pull request ${r.pr} was approved on its head ${r.head.slice(0, 8)} by ${r.by.join(", ")}, and the plans are the ones it reviewed (${changesDigest})`);
    return [{ resolvedBy: r.by.join(","), note: `the review of pull request ${r.pr} on its head ${r.head}`, review: { pr: r.pr, head: r.head, reviewers: r.by } }];
  }
  if (r.kind === "moved") j.reviewMoved = r;
  else {
    console.log(`${label}: no review approves this wave: ${r.why}`);
    if (r.review) {
      w.review = { pull_request: r.review.pr, url: r.review.url };
      console.log(`${label}: an approving review of pull request ${r.review.pr} on its head approves it: ${r.review.url}`);
    }
  }
  return [];
}

/**
 * Run wave `options.wave` through chant's terraform-apply step in this
 * process (terragucci#1303): `runOpWave` with the lexicon's capability, the
 * run hooks giving each root its environment and running its `ci.hooks`, the
 * after-plan hook building terragucci's report from chant's plans, and the
 * migration and gate hooks calling back into this process as before. The
 * spec init committed is chant's rules at base when it reads the same as the
 * job's; otherwise the job's spec goes on a commit on top of base.
 */
async function runStepWave(
  repo: string,
  options: ApplyWaveOptions,
  ctx: WavesContext,
  jobOf: (k: number) => WaveJob,
  at: { chant: StepChant; settings: ResolvedSettings; specWaves: string[][] | number; base: string; gates: Gate[]; approval: Approval; point?: string; grouped?: { name: string; roots: string[]; shares: number }[] },
): Promise<{ code: number; result?: RunOpWaveResult }> {
  const settings = at.settings;
  const env = options.env ?? process.env;
  // A Terragrunt wave finds its units when it plans (chant#4848). A composed wave lists the run's roots, which chant plans together.
  const c = options.composition?.wave !== undefined && !options.composition.fallback && options.composition.terraform ? options.composition : undefined;
  let listed = typeof at.specWaves === "number" ? undefined : c ? stepWavesWithRun(applyWaves(options.layers, options.canary), c) : at.specWaves;
  // A root an estate migration adopts or retags resources into, until the migration applies: choudoufu refuses its plan while a live
  // object at a resource's identity carries no marker of its estate, so the migration's proof stands for it in the wave's digest (pendingEstateMigrations).
  const pending = listed ? pendingEstateMigrations(repo, ctx.migrated) : new Map<string, PendingEstateRoot>();
  const byMigration = (listed?.[options.wave - 1] ?? []).filter((r) => pending.has(r));
  for (const r of byMigration) console.log(`wave ${options.wave}: ${r}: planned by migration ${pending.get(r)!.name}: ${pendingWhy(pending.get(r)!)}; it plans on its own once the migration applies`);
  if (listed && byMigration.length) {
    const left = listed[options.wave - 1]!.filter((r) => !pending.has(r));
    if (left.length === 0) {
      jobOf(options.wave).facts.nothing = true;
      console.log(`wave ${options.wave}: every root in it is planned by its estate migration, so it has nothing to apply`);
      return { code: EXIT.applied };
    }
    listed = listed.map((w, i) => (i === options.wave - 1 ? left : w));
  }
  const migrationMembers: WaveMember[] = byMigration.map((r) => ({ member: r, planDigest: shaOf(JSON.stringify({ migration: pending.get(r)!.name, file: pending.get(r)!.file_digest })) }));
  const grouped = c ? at.grouped?.map((g) => ({ ...g, roots: g.roots.flatMap((r) => (isComposeTarget(r) ? c.order : [r])) })) : at.grouped;
  const roots = listed?.[options.wave - 1] ?? [];
  const limit = options.parallelism !== undefined ? { value: options.parallelism, reason: "--parallelism" } : rootsParallelism(repo, roots, settings, env);
  const all = listed?.flat() ?? [];
  const terragrunt = options.terragrunt ? (options.terragruntPath ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt") : undefined;
  // A root that names its workspace (an Atmos instance's) plans in it, and an Atmos read is read from the upstream's own workspace (chant#4855, #4858).
  const workspaces = Object.fromEntries(all.flatMap((r) => { const w = rootWorkspace(join(repo, r)); return w ? [[r, w]] : []; }));
  const reads = Object.fromEntries(all.flatMap((r) => {
    const list = terraformAtmosReads(atmosEdges(join(repo, r)), (u) => u, (u) => { const w = rootWorkspace(join(repo, u)); return { dir: u, ...(w ? { workspace: w } : {}) }; });
    return list.length ? [[r, list]] : [];
  }));
  const rule = ctx.rule;
  // The agent's account never approves. With agent.token_env and no agent.login, its login is the one its token acts as, read now.
  let agent = rule?.agentLogin;
  if (!agent && rule?.agentTokenEnv) {
    const users = await tokenUsers({ forge: forgeOfEnv(env), env, ...(options.fetch ? { fetch: options.fetch } : {}), agentTokenEnv: rule.agentTokenEnv });
    agent = users.find((u) => u.which.startsWith("the agent's token") && u.login)?.login;
    if (!agent) console.log(`wave ${options.wave}: ${AGENT_NOT_EXCLUDED}`);
  }
  // Who counts at the gate is chant's (chant#4859): the reviews terragucci records on tf-apply, the people behind the change and the agent left out, and approval_rules.
  const approvals = {
    reviewLedger: APPLY_OP,
    involved: { ...(agent ? { agents: [agent] } : {}), exclude: true as const },
    ...(rule?.approvalRules?.length && !rule.point ? { quorum: rule.approvalRules } : {}),
  };
  const spec = wavesStepSpec({
    ...(Object.keys(workspaces).length ? { workspaces } : {}),
    ...(Object.keys(reads).length ? { reads } : {}),
    ...(rule && !rule.point ? { approvals } : {}),
    waves: listed ?? at.specWaves,
    ...(c ? { together: c.wave! } : {}),
    ...(options.rest ? { rest: true } : {}),
    ...(terragrunt ? { terragrunt: { layers: options.layers.filter((l) => l.length > 0), exclude: settings.terragrunt?.exclude, binary: options.binary, terragrunt, ...(options.parallelism !== undefined ? { parallelism: options.parallelism } : {}) } } : {}),
    // allow_unattended at base: chant's gate is never, and the after-plan hook holds a wave the gate would hold unless the policy lets it through.
    gate: ctx.unattended ? "never" : options.gate,
    ...(!ctx.unattended && listed && at.gates.some((g) => g !== options.gate) ? { gates: at.gates } : {}),
    approval: at.approval,
    ...(grouped
      ? { jobs: { wave: options.wave, groups: grouped.map((g) => ({ name: g.name, runs: g.roots, shares: g.shares })) } }
      : options.shares !== undefined ? { shares: { wave: options.wave, shares: options.shares } } : {}),
    call: waveCallArgv,
    migrations: existsSync(join(repo, MIGRATIONS_DIR)),
    ...(at.point ? { point: at.point } : {}),
    // An open pull request's wave plans a choudoufu live root as the cone of its change since base, as its plan note did (./cone.ts).
    ...(options.base && basename(options.binary) === "choudoufu" ? { cone: options.base } : {}),
    // On the step chant applies, so chant stands the wave down for a newer push (chant#4581), before the approval is spent.
    ...(options.standDown ? { standDown: true } : {}),
  });
  const text = writeSpec(repo, spec);
  let base = at.base;
  if (committedSpecAt(repo, at.base) !== text) {
    console.log(`wave ${options.wave}: the spec at ${at.base.slice(0, 12)} is not this job's (terragucci init writes it), so its rules are read from a commit on top of base`);
    base = specAtBase(repo, at.base, text);
  } else {
    console.log(`wave ${options.wave}: plans and applies through chant's terraform-apply step`);
  }
  if (options.share !== undefined || options.group !== undefined) {
    const file = options.decided ?? join(repo, decidedPath(options.wave));
    if (!existsSync(file)) throw new ConfigError(`the wave's decision ${file} cannot be read; the wave's own job writes it before its shares run`);
    mkdirSync(dirname(join(repo, waveRecordPath(options.wave))), { recursive: true });
    copyFileSync(file, join(repo, waveRecordPath(options.wave)));
  }
  if (limit.value !== 1 && roots.length > 1) console.log(`wave ${options.wave}: chant's step plans one root at a time, since the roots' inits share the wave's provider cache`);
  const stepsRead = waveSteps(repo, options);
  const binaries = new RootBinaries(repo, options.binary, settings.version, options.env ?? process.env, options.installer);
  const cache = waveCache(ctx.work, process.env);
  const s: StepContext = {
    repo,
    options,
    ctx,
    settings,
    chant: at.chant,
    spec,
    binaries,
    cache,
    ...("ws" in stepsRead && stepsRead.ws ? { ws: stepsRead.ws } : {}),
    roots: new Map(),
    migrationMembers,
    jobOf,
  };
  try {
    const sources = await sourceChecker(repo, settings.sources, waveSourcesBase(repo, options.base), ctx.configPath ? { config: ctx.configPath } : {}, { log: (l) => console.log(`wave ${options.wave}: ${l}`) });
    if (sources) s.sources = sources;
  } catch (e) {
    console.log(`wave ${options.wave}: ${(e as Error).message}, so nothing in it was applied`);
    return { code: EXIT.failed };
  }
  if (terragrunt) s.units = stepUnits(s, terragrunt);
  // chant stores the change set on the local ledger before its gate fetches the remote one: bring a stale copy up to date first.
  await fetchLifecycleStatus({ cwd: repo });
  let result: RunOpWaveResult;
  // The terraform lexicon checks choudoufu's release by name on the job's own PATH: the job's choudoufu, through its tokenless script.
  const job = stepBinary(ctx.work, options.binary, { ...process.env, ...env });
  const path = process.env.PATH;
  if (job.path) process.env.PATH = job.path(path);
  try {
    result = await at.chant.runOpWave({
    spec,
    specFile: WAVES_SPEC,
    wave: options.wave,
    base,
    cwd: repo,
    ...((options.shares !== undefined || at.grouped) && options.share === undefined && options.group === undefined ? { decide: true } : {}),
    ...(options.group !== undefined ? { group: options.group } : {}),
    ...(options.share !== undefined ? { share: options.share } : {}),
    capabilities: (s.units ? unitCapabilities(s, s.units) : waveCapabilities(repo, binaries, cache, ctx.work, c, env)) as never,
    // The migration and gate hooks call back into this process: the job waits for them without blocking it.
    hookExec: at.chant.spawnExecAsync,
    afterPlan: stepAfterPlan(s),
    runHooks: stepRunHooks(s),
    log: (line) => console.log(line),
  });
  } catch (e) {
    // A wave whose runs could not be found, such as a Terragrunt pipeline that applies a unit before what it reads, applies nothing.
    console.log(`wave ${options.wave}: ${(e as Error).message}`);
    return { code: EXIT.failed };
  } finally {
    if (job.path) process.env.PATH = path;
    // A unit the sources check refused after its init fails the wave's one run --all: name it, as its own row says.
    for (const [unit, lines] of s.units?.refused ?? []) unitFailed(s.units!, jobOf(options.wave).w, unit, `${UNIT_REFUSED}\n${lines.join("\n")}`);
  }
  const j = jobOf(options.wave);
  if (result.applied.length > 0) {
    j.w.applyStarted ??= j.w.plannedAt;
    j.w.applied = new Set(result.applied);
  }
  // How the apply under an approval that named its changes ended (finishApplied).
  if (j.w.appliedUnder) await finishApplied(repo, j.label, j.w, result.failed.length > 0 ? "failed" : "applied", options.now);
  if (result.failed.length > 0) j.w.failed = [...result.failed];
  if (result.decision?.digest) j.w.digest ??= result.decision.digest;
  // The composed run in the report: its roots by module, and the digest of its one plan, which chant keeps as the wave's group member.
  if (c && c.wave === options.wave) {
    const group = result.decision?.members.find((m) => m.member === "(wave plan)");
    j.w.composed = { target: composeTarget(c.wave), planDigest: group?.planDigest ?? null, members: c.order.map((r) => ({ root: r, module: `module.${c.modules.get(r)}` })) };
  }
  // After an approval of other plans, chant writes the report of the plans now and the one approved; the respond job reads them where terragucci kept its own.
  for (const [dir, path] of Object.entries(result.decision?.reports ?? {})) {
    if (!path || !existsSync(join(repo, path))) continue;
    mkdirSync(join(repo, WAVE_REPORT_DIR, dir), { recursive: true });
    copyFileSync(join(repo, path), join(repo, WAVE_REPORT_DIR, dir, "report.json"));
  }
  return { code: result.exitCode, result };
}

/**
 * terragucci#1161: the roots of this job's wave that an upstream which did
 * not apply in this run holds, each with the root whose failure holds it.
 * The upstreams are the roots whose state a root reads and those
 * `waves.after` puts before it (rootOrder), in the waves before this one; the
 * outcomes are the earlier waves' jobs', from the downloaded artifacts and
 * this checkout's own report directory (a comment's apply runs every wave in
 * one job).
 */
async function waveBlocked(repo: string, options: ApplyWaveOptions, waves: readonly string[][]): Promise<Map<string, string>> {
  const roots = waves[options.wave - 1] ?? [];
  const earlier = new Set(waves.slice(0, options.wave - 1).flat());
  if (roots.length === 0 || earlier.size === 0) return new Map();
  const read = await waveSettings(repo, options, options.config ?? findConfig(repo));
  if ("error" in read) throw new ConfigError(read.error);
  const after = detectShape(repo, read.settings).after;
  const all = options.layers.flat();
  const order = rootOrder(repo, all, after);
  // waves.canary: the canary roots go first so that a failed canary holds the rest, whether or not a root reads one.
  const canary = new Set(all.filter((r) => (options.canary ?? []).some((g) => globMatch(g, r))));
  if (canary.size > 0) for (const r of all) if (!canary.has(r)) order.set(r, new Set([...(order.get(r) ?? []), ...canary]));
  const run = earlierWaveOutcomes([options.after!, join(repo, WAVE_REPORT_DIR)], options.wave);
  return blockedMembers(roots, order, earlier, run.members, run.holdsAll);
}

/** The wave report's outcomes: each root's, sorted, a failed root's with the first line of its plan's or its apply's error. */
function reportOutcomes(roots: Record<string, WaveMemberOutcome>, w: WaveRun): NonNullable<WaveRun["outcomes"]> {
  const planned = new Map((w.planned ?? []).map((p) => [p.root, p] as const));
  return Object.entries(roots)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([root, o]) => {
      const p = planned.get(root);
      const error = o.status === "failed" ? (p?.applyError ?? (p?.error ? firstError(p.error) : undefined)) : undefined;
      return { root, outcome: o.status, ...(error ? { error } : {}), ...(o.by ? { blockedBy: o.by } : {}) };
    });
}

/**
 * With `waves.compose` on: every root of this wave, blocked by the first root
 * of an earlier wave that did not apply in the run (or by the gate of a wave
 * that holds every later root), or none.
 */
function composedBlocked(repo: string, options: ApplyWaveOptions, roots: readonly string[]): Map<string, string> {
  const run = earlierWaveOutcomes([options.after!, join(repo, WAVE_REPORT_DIR)], options.wave);
  if (run.holdsAll !== undefined) return new Map(roots.map((r) => [r, `wave-${run.holdsAll}`]));
  const stop = [...run.members].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).find(([, o]) => !passesThrough(o));
  if (!stop) return new Map();
  const by = stop[1].status === "blocked" && stop[1].by ? stop[1].by : stop[0];
  return new Map(roots.map((r) => [r, by]));
}

/**
 * Each root this job handled, as the waves after it read it (@intentius/chant/wave-blocked).
 * A wave's own job that planned nothing (it waited on a migration, or its
 * roots applied in an earlier composed run) names the wave's roots, `layer`,
 * by how it ended; a share or group job names only the roots it planned.
 */
function rootOutcomes(code: number, w: WaveRun, layer: readonly string[] = []): Record<string, WaveMemberOutcome> {
  const out: Record<string, WaveMemberOutcome> = {};
  const changed = new Set(w.changedRoots ?? []);
  const failed = new Set(w.failed ?? []);
  const planned = new Map((w.planned ?? []).map((p) => [p.root, p] as const));
  if (w.roots === undefined) {
    for (const root of layer) out[root] = { status: code === EXIT.applied ? "unchanged" : code === EXIT.waiting ? "waiting" : "not-applied" };
    return out;
  }
  for (const root of w.roots) {
    const p = planned.get(root);
    const denied = p?.policy !== undefined && p.policy.result !== "passed";
    let status: WaveMemberStatus;
    if (failed.has(root) || (p?.error && !denied)) status = "failed";
    else if (denied) status = "refused";
    else if (!changed.has(root)) status = "unchanged";
    else if (w.applied?.has(root)) status = "applied";
    else if (w.decided) status = "decided";
    else if (code === EXIT.waiting) status = "waiting";
    else if (([EXIT.refused, EXIT.held, EXIT.superseded, EXIT.declined] as number[]).includes(code)) status = "refused";
    else status = "not-applied";
    out[root] = { status };
  }
  for (const [root, by] of w.blocked ?? []) out[root] = { status: "blocked", by };
  return out;
}

/**
 * Each wave's gate, read at base like the approval mode. `top` is the
 * stricter of the pipeline's `--gate` and the top-level `gate` at base
 * (on-destructive when the base sets none): the pipeline is the applied
 * commit's own, so a change that loosens `gate` and renders its pipeline
 * again is still gated by the base's. With no `environments` there, every
 * wave takes `top`. With them, a wave of plain roots takes the strictest gate
 * of its roots, each root its environment's gate or, in none or one that
 * sets no gate, `top` (waveGate in ./environments.ts). A Terragrunt wave
 * finds its units when it plans, after the spec is written, so it takes the
 * strictest of `top` and every environment's gate (one entry, for every wave
 * this job runs). A base whose config cannot be read keeps `--gate` when it
 * is stricter than never and the checkout has no environments either;
 * otherwise the wave fails, since its gate cannot be decided.
 */
async function environmentWaveGates(repo: string, base: string, configPath: string | undefined, options: ApplyWaveOptions, waves: string[][] | number): Promise<{ gates: Gate[]; top: Gate }> {
  const flat = (top: Gate): { gates: Gate[]; top: Gate } => ({ gates: typeof waves === "number" ? [top] : waves.map(() => top), top });
  const read = await configAtBase(repo, base, configPath ? { config: configPath } : {});
  if ("error" in read) {
    const checkout = configPath ? await loadConfig(configPath).catch(() => undefined) : undefined;
    if (checkout?.environments) throw new ConfigError(`environments are read from the config at base, and it could not be read (${read.error}), so the wave's gate cannot be decided`);
    if (options.gate === "never") throw new ConfigError(`the top-level gate is read from the config at base, and it could not be read (${read.error}), so the wave does not apply under --gate never`);
    return flat(options.gate);
  }
  const at = read.config;
  const top = strictestGate([options.gate, topGate(at)]);
  if (!at.environments) return flat(top);
  if (typeof waves === "number") return { gates: [anyRootGate(at, top)], top };
  return { gates: waves.map((roots) => rootsGate(roots, at, top)), top };
}

/** What every call of a wave's job reads. */
interface WavesContext {
  /** The approval rule at base; unset only under gate: never when it could not be read. */
  rule?: ApprovalRule;
  configPath?: string;
  work: string;
  /** A group's job: its part of the wave from 1, counted across the wave's groups and their shares, as the run view counts shares. */
  part?: number;
  /** The plans of a wave this job planned earlier (`--rest`), by wave number: the first carrier of an unknown read (./unknown-reads.ts). */
  planned?: (k: number) => WavePlan[] | undefined;
  /**
   * `allow_unattended` in `policy.outcomes` at base: the spec gives chant
   * `gate: never`, and terragucci holds a wave its gate would hold through
   * the `held` hook, unless the policy lets every changing root through.
   */
  unattended?: boolean;
  /** The migrations this job applied: a root one of them adopted or retagged resources into plans on its own from then on (pendingEstateMigrations). */
  migrated: Set<string>;
}

/** One call chant makes back into the wave's job. Returns the call's exit code. */
async function waveCall(repo: string, options: ApplyWaveOptions, ctx: WavesContext, r: WaveRequest, jobOf: (k: number) => WaveJob): Promise<number> {
  const [what, runsPath] = r.args as [WaveCall, string | undefined];
  const runs = readCallFile<RunsFile>(r.cwd, runsPath);
  const j = jobOf(runs?.number ?? options.wave);
  // Each call is a phase of the wave's trace (behold#571): the gate's starts where the call before it ended.
  const name = what === "migrate-check" ? "migrate check" : what;
  const phase = j.w.observer.phase(name, {}, what === "gate" ? j.callEnded : undefined);
  let code: number | undefined;
  try {
    return (code = await waveCallIn(repo, options, ctx, r, j, what));
  } finally {
    const ended = nowNanos();
    j.callEnded = ended;
    const gate = what === "gate" ? gatePhaseAttrs(r.env, j) : {};
    // A gate an approval let through in this run spans the wait (behold#571).
    if (what === "gate" && j.facts.held) j.w.observer.holdGate(phase, j.facts.held, ended);
    j.w.observer.endPhase(phase, { ...gate, ...(code !== undefined ? { "terragucci.exit_code": code } : {}) }, code === undefined ? "the call threw" : code === EXIT.failed ? `exit ${code}` : undefined);
  }
}

/** What a wave's gate span says: how chant decided it, and the wait an approval ended in this run. */
function gatePhaseAttrs(env: Record<string, string>, j: WaveJob): Attrs {
  const held = j.facts.held;
  const heldSeconds = held ? (Date.parse(held.approvedAt) - Date.parse(held.since)) / 1000 : NaN;
  return {
    "terragucci.gate.status": j.w.approval ?? env.CHANT_GATE_STATUS,
    "terragucci.gate.digest": j.w.digest,
    ...(j.facts.waitingSince ? { "terragucci.gate.waiting_since": j.facts.waitingSince } : {}),
    ...(held && Number.isFinite(heldSeconds) && heldSeconds >= 0 ? { "terragucci.gate.held_seconds": heldSeconds, "terragucci.gate.approved_at": held.approvedAt } : {}),
  };
}

async function waveCallIn(repo: string, options: ApplyWaveOptions, ctx: WavesContext, r: WaveRequest, j: WaveJob, what: WaveCall): Promise<number> {
  switch (what) {
    case "migrate-check":
    case "migrate":
      return migrationCall(repo, options, ctx, j, what === "migrate" ? r.env : undefined, r.cwd);
    case "gate":
      return gateCall(repo, options, ctx, j, r.env, r.cwd);
    default:
      console.log(`terragucci: chant made a call this wave does not know: ${what}`);
      return EXIT.failed;
  }
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
  /** The people whose approval of the wave's digest the rule left out, and why (./involved.ts). */
  excluded?: Excluded[];
  /** Where each `approval_rules` entry the wave takes stands, with the approvers it counted. */
  approvalRules?: ReportApprovalRule[];
  /** What the policy's hold and allow_unattended rules made of the wave's gate, and the commit the policy was read at. */
  policyGate?: ReportWave["policy_gate"];
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
  /** `show -json` of each applied root's state, by root: where the report reads the values its plan left unknown. */
  appliedStates?: Map<string, unknown>;
  /** Each applied choudoufu root's record versions, by the address its apply changed, by root. */
  recordVersions?: Map<string, Map<string, ReportRecordVersions>>;
  /** A wave split across jobs that decided and left the applies to its shares: its report stays with the job, and the shares' go to the bucket. */
  decided?: boolean;
  /** The share of a wave split across jobs this job applies. */
  share?: number;
  /** The roots whose `onFailure: "approve"` hook failed, which hold the wave at its gate. */
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
  /** A wave that planned again after its upstreams applied, covered by the pull request's approval (./covered-wave.ts): that plan's digest and the inputs filled in. */
  covered?: RoundCover;
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
  /** Its changes by action and how many roots they count, for its row in the run view (waveTotals). */
  totals?: ReturnType<typeof planTotals>;
  /** The applied record that named each change its apply makes: the apply records how it ended beside it. */
  appliedUnder?: AppliedRecord;
  /** The composed run this wave carries (./compose.ts), for its row in the report and the run view. */
  composed?: WaveComposedInput;
  /** terragucci#1161: the roots of the wave an upstream that did not apply in this run holds, each with the root whose failure holds it. */
  blocked?: Map<string, string>;
  /** terragucci#1161: the wave applied every root it planned, and its job fails for roots it or an earlier wave did not apply. */
  appliedRest?: boolean;
  /** terragucci#1161: each root's outcome once the wave ended, with a failed root's error, for its report (`waves[].outcomes`). */
  outcomes?: { root: string; outcome: WaveMemberStatus; error?: string; blockedBy?: string }[];
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
export function waveState(code: number, w: Pick<WaveRun, "decided" | "refused" | "blocked" | "appliedRest" | "roots">): WaveState {
  if (code === EXIT.applied) return w.decided ? "applying" : "applied";
  // terragucci#1161: a wave that applied what it planned and blocked the rest stands applied; one that planned nothing, blocked.
  if (w.appliedRest) return "applied";
  if ((code === EXIT.failed || code === EXIT.waiting) && w.blocked?.size && !w.roots?.length) return "blocked";
  if (code === EXIT.waiting) return "waiting";
  // A declined decision point (8) applies nothing, as a refusal does; a denial (7) is a failure.
  if (code === EXIT.refused || code === EXIT.held || code === EXIT.superseded || code === EXIT.declined || w.refused?.reason === "policy") return "refused";
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
 * The wave's totals for its row in the run view, once it planned, as its
 * report counts them. Only the job that plans every root of the wave writes
 * them: a share's or a group's job plans part of it, and its count would
 * replace the wave's. Counted once, since a wave's progress rewrites the row
 * every few seconds.
 */
function waveTotals(options: ApplyWaveOptions, w: WaveRun): Pick<RunWave, "totals" | "totals_roots"> {
  if (!w.planned || w.share !== undefined || options.group !== undefined) return {};
  w.totals ??= planTotals(w.planned.map((p) => ({ path: p.root, plan: p.plan, planner: plannerForBinary(options.binary), ...(p.error ? { error: p.error } : {}), ...(p.policy ? { policy: p.policy } : {}) })));
  return { totals: w.totals.totals, totals_roots: w.totals.roots };
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
    // A unit holds the state its remote_state block names, so a read from another project lines up with it on the estate page.
    const states = options.terragrunt ? unitStates(repo, waves.flat()) : rootStates(repo, options.layers.flat());
    // A composed run's roots are drawn in the wave that runs it, each naming the wave it would be in on its own.
    const c = options.terragrunt ? undefined : options.composition;
    const skeleton = runSkeleton(facts.project, facts.commit, c ? wavesWithRun(waves, c, false) : waves, reads, states, c?.wave !== undefined && !c.fallback ? c : undefined);
    const spans = waveSpans(w);
    const timing = { ...(spans.length ? { spans } : {}), ...(w.changedRoots ? { changed: w.changedRoots } : {}) };
    const key = await updateRunView(storeFromEnv(settings.reports, env), settings.reports.prefix, skeleton, { number: options.wave, gate: waveGate(options.wave), policy: options.gate, ...timing, ...waveTotals(options, w), ...row });
    if (!quiet) console.log(`wave ${options.wave}: run view written to ${named(settings.reports.bucket)}/${key}`);
  } catch (e) {
    console.log(`wave ${options.wave}: the run view was not written: ${(e as Error).message}`);
  }
}

/** A composed run's part of its wave's row in the run view. */
function runComposed(c: WaveComposedInput | undefined): Partial<RunWave> {
  if (!c) return {};
  const done = c.members.some((m) => m.apply !== undefined || m.state !== undefined);
  return {
    composed: {
      roots: c.members.map((m) => m.root),
      digest: c.planDigest,
      ...(c.heldByUnknown?.length ? { unknown: c.heldByUnknown } : {}),
      ...(done ? { members: c.members.map((m) => ({ root: m.root, module: m.module, ...(m.apply ? { apply: m.apply } : {}), ...(m.state ? { state: m.state } : {}) })) } : {}),
    },
  };
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
  // The report and its upload are phases of the wave's trace (behold#571); the trace is sent once both end.
  const reporting = w.observer.phase("report");
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
  // With environments in the settings the wave read, each root names its environment and the wave its roots' environments.
  const envOf = (root: string): string | undefined => (settings.environments ? environmentOf(root, settings) : undefined);
  const waveEnvironments = [...new Set(w.roots.map(envOf).filter((e): e is string => e !== undefined))].sort();
  const report = buildReport({
    run: { ...runFacts(repo, env, settings.forge), ...(settings.policy ? { actor: detectActor(repo, env, settings.policy.agents) } : {}), stage: APPLY_OP, wave, ...(w.share !== undefined ? { share: w.share } : {}), binary, runtime: settings.runtime, started: w.started, finished: new Date().toISOString(), terragucci: VERSION },
    roots: w.planned.map((p) => withEnvironment(planInput(p), envOf(p.root))),
    waves: [{ number: wave, roots: w.roots, ...(waveEnvironments.length ? { environments: waveEnvironments } : {}), ...(w.digest ? { setDigest: w.digest } : {}), ...(w.approval ? { approval: w.approval } : {}), ...(w.gate ? { gate: w.gate } : {}), ...(w.waitingSince ? { waitingSince: w.waitingSince } : {}), ...(w.refused ? { refused: w.refused } : {}), ...(w.review ? { review: w.review } : {}), ...(w.excluded?.length ? { excluded: w.excluded } : {}), ...(w.approvalRules?.length ? { approvalRules: w.approvalRules } : {}), ...(w.policyGate ? { policyGate: w.policyGate } : {}), ...(w.heldBySteps ? { heldBySteps: w.heldBySteps } : {}), ...(w.covered ? { covered: w.covered } : {}), ...(w.waveCost ? { cost: w.waveCost } : {}), ...(w.state ? { state: w.state } : {}), ...(w.blocked?.size ? { blocked: w.blocked } : {}), ...(w.outcomes?.length ? { outcomes: w.outcomes } : {}), ...(w.waveReads?.length ? { reads: w.waveReads } : {}), ...(w.preview ? { preview: w.preview } : {}), ...(w.composed ? { composed: w.composed } : {}) }],
    redacted,
    ...(w.policy ? { policy: w.policy } : {}),
  });
  // waves.compose: what it came to for this change, on every wave's report.
  if (options.composition) report.compose = reportCompose(options.composition);
  function planInput(p: (typeof w.planned)[number]): RootInput {
    // A root of this wave's composed run names the wave and its module; its plan is its part of the composed plan.
    const c = options.composition;
    const policy = { ...(p.policy ? { policy: p.policy } : {}), ...(c?.wave === wave && c.modules.has(p.root) && w.composed ? { composed: { wave, module: `module.${c.modules.get(p.root)}` } } : {}) };
    // A root the policy refused keeps its plan, so the report shows what it would have changed.
    const steps = p.steps?.length ? { steps: p.steps } : {};
    const deps = unitDeps?.get(p.root)?.length ? { dependencies: unitDeps.get(p.root) } : {};
    if (p.error && !(p.policy && p.policy.result !== "passed" && p.plan !== undefined)) return { path: p.root, planner: plannerForBinary(binary), ...(p.bin ? { binary: p.bin } : {}), error: p.error.split("\n")[0], ...policy, ...steps, ...deps };
    const state = w.states?.get(p.root);
    const versions = w.recordVersions?.get(p.root);
    const reads = w.reads?.get(p.root)?.length ? { reads: w.reads.get(p.root) } : {};
    return { path: p.root, plan: p.plan, planner: plannerForBinary(binary), ...(p.bin ? { binary: p.bin } : {}), ...(p.cone ? { cone: p.cone } : {}), files: { json: planFiles(p.root).json }, ...(p.error ? { error: p.error } : {}), ...policy, ...steps, ...reads, ...(w.applied?.has(p.root) ? { applied: true, versions: rootVersions(join(repo, p.root), env) } : {}), ...(state ? { state } : {}), ...(w.appliedStates?.has(p.root) ? { appliedState: w.appliedStates.get(p.root) } : {}), ...(versions ? { recordVersions: versions } : {}), ...deps };
  }
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
  w.observer.endPhase(reporting);
  const uploading = settings.reports?.bucket ? w.observer.phase("upload", { "terragucci.reports.bucket": settings.reports.bucket }) : undefined;
  let uploadProblem: string | undefined;
  if (settings.reports?.bucket && w.decided) {
    console.log(`wave ${wave}: the report stays with the job; the reports of its shares, which apply, go to ${settings.reports.bucket}`);
  } else if (settings.reports?.bucket) {
    try {
      const up = await uploadReport(storeFromEnv(settings.reports, env), dir, report, settings.reports.prefix);
      console.log(`wave ${wave}: report copied to ${up.prefix}${report.run.report_url ? `, at ${report.run.report_url}` : ""}`);
    } catch (e) {
      uploadProblem = (e as Error).message;
      console.log(`wave ${wave}: the report was not copied to ${settings.reports.bucket}: ${(e as Error).message}`);
    }
    // Each applied root's roster, from the plan it applied (./report/roster.ts). A roster that is not written never fails the wave.
    const rosters = waveRosters(report, new Map(w.planned.filter((p) => p.plan !== undefined).map((p) => [p.root, { plan: p.plan, estate: resolvedEstate(join(repo, p.root)) }])));
    try {
      const keys = await uploadRosters(storeFromEnv(settings.reports, env), rosters, settings.reports.prefix);
      if (rosters.length > 0) console.log(`wave ${wave}: rosters of ${rosters.map((r) => `${r.roster.estate} (${r.roster.resources.length})`).join(", ")} written to ${keys[keys.length - 1]}`);
    } catch (e) {
      console.log(`wave ${wave}: the rosters were not written to ${settings.reports.bucket}: ${(e as Error).message}`);
    }
  }
  // The run view: a share that applied adds itself to its wave's row; any other ending is the wave's state.
  if (w.state && w.share !== undefined) {
    await noteRunView(repo, options, w, w.state === "applied" ? { shares_applied: [w.share] } : { state: w.state });
  } else if (w.state) {
    const cmd = w.state === "waiting" && w.command ? { command: w.command } : {};
    await noteRunView(repo, options, w, { state: w.state, ...(w.approval ? { approval: w.approval } : {}), ...(w.digest ? { digest: w.digest } : {}), ...cmd, ...(w.excluded?.length ? { excluded: w.excluded } : {}), ...(w.shareCount ? { shares: w.shareCount } : {}), report: runPath(report), ...runComposed(w.composed) });
  }
  w.observer.endPhase(uploading, {}, uploadProblem);
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
 * The `ci.hooks` a wave runs: those in chant.workspace.json at base (the
 * base the wave was given, else the applied commit's first parent), never
 * the applied commit's own, so a change cannot add a hook that runs with the
 * apply credentials it is applied with. A base that cannot be read runs no
 * hooks when the checkout names none, and fails the wave when it names some.
 */
function waveSteps(repo: string, options: ApplyWaveOptions): { ws?: WaveSteps } | { error: string } {
  let base: string;
  try {
    base = options.base ?? baseCommit(repo);
  } catch (e) {
    try {
      if (hookCount(readHooks(repo, undefined).hooks) === 0) return {};
    } catch {
      // An unreadable checkout declaration fails the wave below, as one with hooks does.
    }
    return { error: `ci.hooks are read from chant.workspace.json at base, and base could not be found (${(e as Error).message})` };
  }
  try {
    const read = readHooks(repo, base);
    if (read.note) console.log(read.note);
    const hooks = hooksUsed(read.hooks, "tf-apply");
    if (hookCount(hooks) === 0) return {};
    console.log(`ci.hooks: ${hookCount(hooks)} read from chant.workspace.json at ${read.from.length === 40 ? read.from.slice(0, 8) : read.from}`);
    return { ws: { hooks, env: options.env ?? process.env } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * What `waves.compose` comes to for this change, with the config the wave
 * reads its settings from. Undefined when the key is off (or that config
 * cannot be read, which the wave's plan then reports). The roots the change
 * reaches are found from the commit before the one applied, as tf-plan finds
 * them from its base; with none to diff against, every root counts. The roots
 * differ from the reviewed plan's only when the change does, and then so do
 * the composed run's generated files and its digest, so the wave waits.
 */
async function waveComposition(repo: string, options: ApplyWaveOptions, waves: string[][]): Promise<Composition | undefined> {
  const configPath = options.config ?? findConfig(repo);
  const read = await waveSettings(repo, options, configPath).catch(() => undefined);
  if (!read || "error" in read || read.settings.waves?.compose !== true) return undefined;
  const settings = read.settings;
  const env = options.env ?? process.env;
  const all = options.layers.flat();
  const after = detectShape(repo, settings).after;
  let selected: Set<string> | undefined;
  try {
    const base = options.base ?? baseCommit(repo);
    const checkout = resolveRepo(configPath ? await loadConfig(configPath) : {});
    const outside = await outsideRoots(repo, base, configPath, undefined, checkout, all, env, () => {}, true);
    // With no --base, base is the parent of the commit applied, so the change is the diff between the two. A merge base needs
    // history the wave's shallow checkout lacks: `base...HEAD` failed there and every root counted, unrelated ones included.
    selected = affectedRoots(repo, base, all, all, (l) => console.log(`wave ${options.wave}: compose: ${l}`), after, outside.outside, options.base === undefined);
  } catch (e) {
    console.log(`wave ${options.wave}: compose: the roots this change reaches could not be found (${(e as Error).message.split("\n")[0]}), so every root counts`);
  }
  const binaries = new RootBinaries(repo, options.binary, settings.version, env, options.installer);
  const c = await compositionFor(repo, {
    all,
    ...(selected ? { selected } : {}),
    waves,
    ...(settings.waves?.compose_max !== undefined ? { max: settings.waves.compose_max } : {}),
    env,
    binary: (r) => binaries.expected(r),
    deps: rootDependencies(repo, all),
    ...(after ? { after } : {}),
    ...(options.groups ? { groupOf: (r: string) => groupOf(r, options.groups!) } : {}),
  });
  console.log(`wave ${options.wave}: ${compositionLine(c)}`);
  return c;
}

/** A wave's roots by apply group, the composed run's target in the group its roots are in (they are all in one, or the change would not compose). */
function groupsWithRun(roots: readonly string[], selectors: Record<string, string[]>, c: Composition | undefined): { name: string; roots: string[] }[] {
  const target = roots.find(isComposeTarget);
  if (!target || !c) return rootsByGroup(roots, selectors);
  const name = groupOf(c.order[0]!, selectors);
  const groups = rootsByGroup(roots.filter((r) => r !== target), selectors);
  const at = groups.find((g) => g.name === name);
  if (at) at.roots.push(target);
  else groups.push({ name, roots: [target] });
  return groups;
}

/**
 * Just before a wave applies `digest`: the approval of that digest standing
 * on its gate is spent, whichever path the wave took to get here. chant
 * writes the `applied` line of an approved wave (its spend rule), but not of
 * a wave its policy let through (`not-required`), and a spend whose push was
 * refused only logs (chant op-waves-run.ts spendApproval). An approval left
 * standing after its plans applied is the changed-set refusal of the next
 * push whose wave plans anything else, as on the demo host (behold#571):
 * wave 2 waited for an approval, the approval came, a comment's apply ran
 * the wave again and no unknown output held it, so it applied under no gate
 * and the approval stood. Undefined when nothing needed writing; the record
 * when this wrote it. Throws when the ledger cannot be read or written.
 */
export async function spendStanding(repo: string, gate: string, digest: string, now?: string, env: NodeJS.ProcessEnv = process.env): Promise<AppliedRecord | undefined> {
  const stamp = now ?? new Date().toISOString();
  const ledger = readLedger(repo);
  const decision = decideGate(ledger, gate, digest, stamp);
  if (decision.status !== "approved") return undefined;
  const spent = (ledger.applied ?? []).some((a) => a.gate === gate && samePlanDigest(a.planDigest, digest) && at(a.approvedAt) >= at(decision.at));
  if (spent) return undefined;
  const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
  const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const record: AppliedRecord = {
    version: 1,
    kind: "applied",
    op: APPLY_OP,
    gate,
    planDigest: digest,
    approvedAt: decision.at,
    approvedBy: decision.by,
    timestamp: stamp,
    ...(runId ? { runId } : {}),
    ...(commit ? { commit } : {}),
  };
  await writeWaveRecord(repo, record, `Applied under ${gate}`);
  return record;
}

/**
 * Under an approval, before the apply: record each change the approved plans
 * make, when every root that changes something applies per resource, so a
 * stopped apply resumes from them (./remainder.ts). chant records the
 * approval as used (`_gates/tf-apply/applied.jsonl`); this line beside it
 * carries the changes. A record that cannot be pushed stops the wave.
 */
async function recordChanges(repo: string, label: string, j: WaveJob, now?: string): Promise<void> {
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
    ...(w.excluded?.length ? { excluded: w.excluded } : {}),
  };
  await writeWaveRecord(repo, record, `Changes approved: ${APPLY_OP} ${record.gate}`);
  w.appliedUnder = record;
  console.log(`${label}: ${j.changes.length} change${j.changes.length === 1 ? "" : "s"} recorded beside the approval, so a stopped apply resumes from them`);
}

/**
 * A wave with nothing left to change whose last approved apply stopped
 * before it finished: something else applied the rest, so that apply is
 * recorded as finished and the resume job leaves the wave alone. Never fails
 * the wave.
 */
async function closeStopped(repo: string, label: string, wave: number, now?: string): Promise<void> {
  try {
    const ledger = readLedger(repo);
    const gate = waveGate(wave);
    const last = (ledger.applied ?? []).filter((a) => a.gate === gate).reduce<AppliedRecord | undefined>((n, a) => (!n || at(a.timestamp) >= at(n.timestamp) ? a : n), undefined);
    if (!last?.changes || finishOf(ledger, last)) return;
    await writeWaveRecord(repo, { version: 1, kind: "finished", op: APPLY_OP, gate, planDigest: last.planDigest, applied: last.timestamp, result: "applied", timestamp: now ?? new Date().toISOString() }, `Apply applied: ${APPLY_OP} ${gate}`);
    console.log(`${label}: the apply of ${last.planDigest} stopped before it finished, and nothing of it is left to apply`);
  } catch {
    // The resume job runs the wave again, which finds nothing to apply.
  }
}

/** Record how the apply under an approval that named its changes ended; a killed one never gets here, and the resume job applies the rest. Never fails the wave. */
async function finishApplied(repo: string, label: string, w: WaveRun, result: FinishedRecord["result"], now?: string): Promise<void> {
  const a = w.appliedUnder;
  if (!a) return;
  try {
    await writeWaveRecord(repo, { version: 1, kind: "finished", op: APPLY_OP, gate: a.gate, planDigest: a.planDigest, applied: a.timestamp, result, timestamp: now ?? new Date().toISOString() }, `Apply ${result}: ${APPLY_OP} ${a.gate}`);
  } catch (e) {
    console.log(`${label}: how its apply ended was not recorded (${(e as Error).message}); the resume job may apply what is left again, and each change it makes is one the approval covered`);
  }
}

/** The report of a wave's plans, as a waiting wave keeps it beside its pending fact and respond wave-refused reads it. */
function storedWaveReport(repo: string, options: ApplyWaveOptions, wave: number, digest: string, roots: string[], planned: WavePlan[]): string {
  const env = options.env ?? process.env;
  const now = new Date().toISOString();
  return JSON.stringify(buildReport({
    run: { ...runFacts(repo, env), stage: "tf-apply", wave, binary: options.binary, runtime: "forge", started: now, finished: now },
    roots: planned.map((p) => ({ path: p.root, plan: p.plan, planner: plannerForBinary(options.binary), ...(p.cone ? { cone: p.cone } : {}) })),
    waves: [{ number: wave, roots, setDigest: digest }],
  }));
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
    await readLiveSetup(dir, { binary: p.binary });
    const estate = resolvedEstate(dir);
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

/** Where migration files go in the reports bucket: `<prefix>/<project>/<path>`. Undefined when the config names no bucket. */
async function migrationBucket(repo: string, options: ApplyWaveOptions, env: NodeJS.ProcessEnv): Promise<{ store: ReturnType<typeof storeFromEnv>; bucket: string; prefix: string; project: string; key: (path: string) => string } | undefined> {
  const configPath = options.config ?? findConfig(repo);
  const read = await waveSettings(repo, options, configPath).catch(() => undefined);
  if (!read || "error" in read || !read.settings.reports?.bucket) return undefined;
  const reports = read.settings.reports;
  const project = runFacts(repo, env, read.settings.forge).project;
  return {
    store: storeFromEnv(reports, env),
    bucket: reports.bucket,
    prefix: reports.prefix ?? "",
    project,
    key: (path) => [reports.prefix ?? "", project, path].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"),
  };
}

/**
 * Copy each migration record to the reports bucket, when the config names
 * one, and the roster of each estate root an estate migration wrote
 * (./report/roster.ts). A copy that fails is logged.
 */
async function uploadMigrationRecords(repo: string, options: ApplyWaveOptions, records: MigrationRecord[], env: NodeJS.ProcessEnv, rosters: { root: string; roster: Roster }[] = []): Promise<void> {
  const b = await migrationBucket(repo, options, env).catch(() => undefined);
  if (!b) return;
  for (const r of records) {
    const key = b.key(`migrations/${r.name}.json`);
    try {
      await b.store.put(key, JSON.stringify(r, null, 2) + "\n", "application/json");
      console.log(`migration ${r.name}: record copied to ${b.store.location}/${key}`);
    } catch (e) {
      console.log(`migration ${r.name}: the record was not copied to ${b.bucket}: ${(e as Error).message}`);
    }
  }
  if (rosters.length === 0) return;
  const writes: RosterWrite[] = rosters.map((r) => ({ ...r, project: b.project }));
  try {
    const keys = await uploadRosters(b.store, writes, b.prefix);
    console.log(`migrations: rosters of ${writes.map((w) => `${w.roster.estate} (${w.roster.resources.length})`).join(", ")} written to ${keys[keys.length - 1]}`);
  } catch (e) {
    console.log(`migrations: the rosters were not written to ${b.bucket}: ${(e as Error).message}`);
  }
}

/**
 * Where an estate migration's per-resource progress goes beyond
 * `terragucci-report/` (./migrate-progress.ts): a span of its own under the
 * wave's `migrate` phase, with an event per resource, and with a reports
 * bucket, `<prefix>/<project>/migrations/<name>/progress.jsonl` and the
 * record with its counts.
 */
function migrationProgress(w: WaveRun, bucket: Awaited<ReturnType<typeof migrationBucket>>): (name: string) => ProgressSinks {
  return (name) => {
    const span = w.observer.child(`migration ${name}`, { "terragucci.migration": name });
    return {
      ...(bucket ? { publish: async (path: string, body: string, type: string) => void (await bucket.store.put(bucket.key(path), body, type)) } : {}),
      event: (n, attributes, at) => w.observer.event(span, n, attributes, at),
      end: (status, counts, error) =>
        w.observer.endPhase(
          span,
          { "terragucci.migration.status": status, ...(counts ? { "terragucci.migration.moved": counts.moved, "terragucci.migration.stamped": counts.stamped, "terragucci.migration.refused": counts.refused, "terragucci.migration.skipped": counts.skipped, "terragucci.migration.left": counts.left } : {}) },
          status === "applied" ? undefined : (error ?? status),
        ),
    };
  };
}

/** What the policy and the gate read of a wave's plans: a plain root's, or a Terragrunt unit's. */
type WavePlan = Pick<PlannedRoot, "root" | "plan" | "member" | "error" | "applyError" | "policy" | "cone"> & { bin?: ReportRootBinary; steps?: ReportStep[] };

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
    const mr = await pullOf(jobForge("gitlab", env, options.fetch), env, sha);
    if (!mr) {
      console.log(`${label}: review: no merge request made ${sha.slice(0, 8) || "this commit"}, so input.review has no review`);
      return noReview();
    }
    const head = mr.head;
    const { job, skipped, ...review } = await gitlabReviewOf(gitlabReviewCalls(env, options.fetch), { number: mr.number, head });
    for (const s of skipped) console.log(`${label}: review: skipped the review job ${s.job === null ? "a note named" : s.job}, since ${s.why}`);
    console.log(review.found
      ? `${label}: review: merge request !${mr.number}'s head ${head.slice(0, 8)} was reviewed with risk ${review.risk} in job ${job} of a default-branch pipeline, which the policy reads as input.review`
      : `${label}: review: no review job of a default-branch pipeline kept a review of merge request !${mr.number}'s head ${head.slice(0, 8)}, so input.review.found is false`);
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
    const pr = await pullOf(jobForge(on, env, options.fetch), env, sha);
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
 * A wave's reads of roots in earlier waves, by each of `readers` (its roots
 * whose plan changes something): each `terraform_remote_state` block's
 * upstream, and the outputs the root's files read from it. Reads of the same
 * upstream by one root are one read.
 */
function rootReads(repo: string, waves: readonly string[][], wave: number, reads: Map<string, ReportRead[]> | undefined, readers: ReadonlySet<string>): WaveRead[] {
  const waveOf = new Map(waves.flatMap((rs, i) => rs.map((r) => [r, i + 1] as const)));
  const out = new Map<string, WaveRead>();
  for (const [root, rs] of reads ?? []) {
    if (!readers.has(root)) continue;
    for (const r of rs) {
      const k = waveOf.get(r.upstream);
      if (k === undefined || k >= wave) continue;
      const outputs = rootOutputsRead(join(repo, root), r.data);
      const id = `${root}\n${r.upstream}`;
      const had = out.get(id);
      const merged = had ? (had.outputs && outputs ? new Set([...had.outputs, ...outputs]) : undefined) : outputs;
      out.set(id, { root, upstream: r.upstream, wave: k, ...(merged ? { outputs: merged } : {}) });
    }
  }
  return [...out.values()];
}

/**
 * A wave's Atmos `!terraform.state` reads and Terramate `input` blocks of
 * roots in earlier waves, by each of `readers`: the reads in the edges beside
 * the root (./atmos.ts), which fillReads filled from the state the
 * upstream's wave applied, and the outputs they read. The pull request
 * planned them on the upstream's applied state, so each is a read of
 * `review: "applied"`. Reads of the same upstream by one root are one read.
 */
function toolReads(repo: string, waves: readonly string[][], wave: number, readers: ReadonlySet<string>): WaveRead[] {
  const waveOf = new Map(waves.flatMap((rs, i) => rs.map((r) => [r, i + 1] as const)));
  const out = new Map<string, WaveRead & { outputs: Set<string> }>();
  for (const root of [...readers].sort()) {
    for (const r of atmosEdges(join(repo, root))?.reads ?? []) {
      const k = waveOf.get(r.upstream);
      if (k === undefined || k >= wave || r.output.length === 0) continue;
      const id = `${root}\n${r.upstream}`;
      const had = out.get(id) ?? { root, upstream: r.upstream, wave: k, outputs: new Set<string>(), review: "applied" as const };
      had.outputs.add(r.output[0]!);
      out.set(id, had);
    }
  }
  return [...out.values()];
}

/** A Terragrunt wave's reads of units in earlier waves, by each of `readers`: each dependency, and the outputs its blocks read. */
function unitReads(repo: string, waves: readonly string[][], wave: number, edges: Map<string, Set<string>>, readers: readonly string[]): WaveRead[] {
  const waveOf = new Map(waves.flatMap((us, i) => us.map((u) => [u, i + 1] as const)));
  const out: WaveRead[] = [];
  for (const unit of readers) {
    const texts = unitTexts(repo, unit);
    for (const up of [...(edges.get(unit) ?? [])].sort()) {
      const k = waveOf.get(up);
      if (k === undefined || k >= wave) continue;
      const read = readsOf(unit, up, texts);
      if (read === null) continue;
      out.push({ root: unit, upstream: up, wave: k, ...(read.outputs ? { outputs: read.outputs } : {}) });
    }
  }
  return out;
}

/**
 * The reads that hold a wave at its gate (#1012): those whose outputs were
 * unknown when the change was reviewed, from the first carrier that can say
 * (./unknown-reads.ts). The upstream's plan in this push: a wave this job
 * planned earlier, else the upstream wave's report this commit put in the
 * reports bucket. A plan of it that changes nothing counts only when the
 * bucket's changes.json has no row of an earlier apply of the upstream at
 * this commit. Then the report of the pull request that merged as this
 * commit, which the forge names and the bucket holds. With neither, every
 * read holds the wave. Each read is logged, with the outputs that were
 * unknown and the wave that settled them.
 */
async function unknownReadHold(repo: string, options: ApplyWaveOptions, ctx: WavesContext, w: WaveRun, label: string, gate: Gate, reads: WaveRead[], fresh?: { root: string; plan: unknown }[]): Promise<UnknownRead[]> {
  if (reads.length === 0) return [];
  const env = options.env ?? process.env;
  const settings = w.settings;
  const facts = runFacts(repo, env, settings?.forge);
  const prefix = settings?.reports?.prefix ?? "";
  const key = (...p: string[]): string => p.map((x) => x.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  let store: ObjectStore | undefined;
  let storeError: string | undefined;
  if (settings?.reports?.bucket) {
    try {
      store = storeFromEnv(settings.reports, env);
    } catch (e) {
      storeError = (e as Error).message.split("\n")[0];
    }
  }
  let rows: Promise<IndexEntry[]> | undefined;
  const indexRows = (): Promise<IndexEntry[]> =>
    (rows ??= store!.get(key(prefix, facts.project, "index.json")).then((text) => {
      if (text === undefined) return [];
      const parsed = JSON.parse(text) as { reports?: IndexEntry[] };
      return Array.isArray(parsed.reports) ? parsed.reports : [];
    }));
  const reportAt = async (path: string): Promise<Report | undefined> => {
    const body = await store!.get(key(prefix, facts.project, path, "report.json"));
    return body === undefined ? undefined : (JSON.parse(body) as Report);
  };
  let pulled: Promise<PullReport & { path?: string }> | undefined;
  const verdict = await unknownReads(reads, {
    async upstreamPlans(upstream, k) {
      // Every plan of the upstream at this commit: this job's, then each run's of its wave in the bucket (a comment's apply plans
      // the upstream again after it applied, and that plan changes nothing; the merge's own plan is the one that was reviewed).
      const out: { plan: unknown; from: string }[] = [];
      const mine = ctx.planned?.(k)?.find((p) => p.root === upstream && p.plan !== undefined);
      if (mine) out.push({ plan: mine.plan, from: `wave ${k}'s plan of ${upstream} in this job` });
      if (!store) return out;
      // The upstream wave's own jobs: their reports in the bucket, with each root's redacted plan, which keeps after_unknown.
      for (const row of (await indexRows()).filter((r) => r.stage === APPLY_OP && r.commit === facts.commit && r.wave === k)) {
        const root = (await reportAt(row.path))?.roots.find((x) => x.path === upstream);
        if (!root?.plan.json) continue;
        const text = await store.get(key(prefix, facts.project, row.path, root.plan.json));
        if (text !== undefined) out.push({ plan: JSON.parse(text), from: `wave ${k}'s plan of ${upstream} in this push (${row.path})` });
      }
      return out;
    },
    async appliedBefore(upstream, k) {
      // A plan of the upstream that changes nothing is the first of this commit unless an earlier run of it applied a change to the
      // upstream. The report path has no run, so a later run's report replaces the earlier one's; changes.json keeps the rows of
      // each wave that changed a root, and a wave that changes nothing adds none, so the earlier run's rows outlive it.
      if (!store) return storeError ? `the reports bucket, which records earlier applies of this commit, could not be read (${storeError})` : "the config names no reports bucket, which records earlier applies of this commit";
      const rows = readChanges(await store.get(key(prefix, facts.project, "changes.json"))).changes;
      const row = rows.find((c) => c.commit === facts.commit && c.root === upstream && (c.wave === undefined || c.wave === k));
      return row ? `${row.path} applied ${upstream} at this commit before this run (${row.address})` : undefined;
    },
    pullReport: () => (pulled ??= pullReport()),
  });
  async function pullReport(): Promise<PullReport & { path?: string }> {
    if (!store) return { missing: storeError ? `the reports bucket could not be read (${storeError})` : "the config names no reports bucket to read the pull request's report from" };
    const sha = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
    let pr: { number: number; head: string } | undefined;
    try {
      pr = await pullOf(jobForge(env.GITLAB_CI === "true" || settings?.forge === "gitlab" ? "gitlab" : forgeOfEnv(env), env, options.fetch), env, sha);
    } catch (e) {
      return { missing: `the forge could not say which pull request made ${sha.slice(0, 8)} (${(e as Error).message.split("\n")[0]})` };
    }
    if (!pr) return { missing: `no pull request made ${sha.slice(0, 8)} (a direct push, or a merge the forge maps to no pull request)` };
    const plans = (await indexRows()).filter((r) => r.stage === "tf-plan" && (r.commit === pr.head || r.pull_request === String(pr.number)));
    // The plan of the head reviewed, else the newest plan of the pull request.
    const row = plans.find((r) => r.commit === pr.head) ?? plans[0];
    if (!row) return { missing: `the reports bucket holds no plan report of pull request ${pr.number}` };
    const report = await reportAt(row.path);
    if (!report) return { missing: `the reports bucket has no ${row.path}/report.json` };
    return { report, from: `pull request ${pr.number}'s plan of ${row.commit.slice(0, 8)}`, path: row.path };
  }
  for (const l of verdict.lines) console.log(`${label}: ${l}`);
  for (const u of verdict.unknown) console.log(`${label}: ${unknownReadLine(u)}`);
  if (verdict.unknown.length && fresh?.length && store) {
    // A covered round (chant#4422): the plan made on those outputs against the pull request's plan of the same roots.
    const got = await (pulled ??= pullReport()).catch((e: Error): PullReport & { path?: string } => ({ missing: `the pull request's report could not be read (${e.message.split("\n")[0]})` }));
    if ("missing" in got) console.log(`${label}: the pull request's plan cannot be compared with this one: ${got.missing}`);
    else {
      const previewed = await Promise.all(
        fresh.map(async (f) => {
          const json = got.report.roots.find((x) => x.path === f.root)?.plan.json;
          const text = json && got.path ? await store!.get(key(prefix, facts.project, got.path, json)).catch(() => undefined) : undefined;
          return { root: f.root, fresh: f.plan, ...(text !== undefined ? { previewed: JSON.parse(text) as unknown } : {}) };
        }),
      );
      const wave = got.report.waves.find((x) => fresh.some((f) => x.roots.includes(f.root)));
      const cover = await waveCoverage(previewed, verdict.unknown, wave?.set_digest ?? "");
      if (cover.covered && cover.digest) {
        w.covered = { digest: cover.digest, filledInputs: cover.filledInputs };
        console.log(`${label}: the plan made on those outputs is covered by ${got.from} (digest ${cover.digest}): it differs only where ${cover.filledInputs.length ? cover.filledInputs.join(", ") : "the outputs it read"}, previewed as known after apply, filled in, so the approval of that plan stands for it`);
        return [];
      }
      console.log(`${label}: the plan made on those outputs is not covered by ${got.from}: ${cover.covered ? "the pull request's wave has no digest to bind it to" : cover.reason}`);
    }
  }
  if (verdict.unknown.length) console.log(`${label}: nobody reviewed the plan it made on those outputs, so it waits for an approval of it${gate === "always" ? "" : ` although gate is ${gate}`}`);
  return verdict.unknown;
}

/**
 * What the policy's `hold` and `allow_unattended` rules make of a wave
 * (policy.outcomes at base), over its plans that change something: `held`
 * waits for an approval whatever `gate` says, `unattended` lets a wave its
 * gate would hold through. `held` on the answer says whether the wave's
 * `held` hook holds it for them: for a hold rule, and with `allow_unattended`
 * (where chant's own gate is never) whenever `gate` holds it and the rules do
 * not let it through. A step, cost.approve_above and an unknown read hold the
 * wave as before, whatever the rules say.
 */
function waveRules(repo: string, ctx: WavesContext, j: WaveJob, changing: readonly WavePlan[], gate: Gate, destroys: boolean): { outcome?: "held" | "unattended"; held: boolean } {
  const { w, label } = j;
  const found = policyGate(changing);
  const gateHolds = gate === "always" || (gate === "on-destructive" && destroys);
  if (found) {
    const commit = ctx.rule ? git(repo, ["rev-parse", "--verify", "-q", `${ctx.rule.base}^{commit}`]).stdout.trim() : "";
    w.policyGate = { ...found, ...(commit ? { commit } : {}) };
    if (found.outcome === "held") console.log(`${label}: the policy holds it for an approval (${found.rules.join(", ")})${gate === "never" ? ", although gate is never" : ""}`);
    else if (gateHolds) console.log(`${label}: the policy allows every root that changes something to apply without an approval (${found.rules.join(", ")}), so gate ${gate} does not hold it`);
  }
  return { ...(found ? { outcome: found.outcome } : {}), held: found?.outcome === "held" || (ctx.unattended === true && gateHolds && found?.outcome !== "unattended") };
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
  // hold and allow_unattended, read at base, judge the policy at the base the approval rule is read at, so a change cannot add a rule that lets itself through.
  const outcomes = ctx.rule?.policyOutcomes;
  const policyBaseRef = outcomes ? ctx.rule!.base : options.base ?? (policyEnv.TG_BASE || undefined);
  const governing = await governingPolicy(repo, settings.policy, policyBaseRef, ctx.configPath ? { config: ctx.configPath } : {});
  if (governing.note) console.log(governing.note);
  if (!governing.policy) return out;
  // The outcomes are the base's alone: a checkout's own outcomes key turns nothing on.
  governing.policy = { ...governing.policy, outcomes: outcomes ?? ["deny"] };
  const runAt = runFacts(repo, policyEnv, settings.forge);
  // With cost on, each root's figures and its wave's: the policy reads the cost of what this wave applies.
  const cost = (root: string) => (w.cost ? { cost: policyCost(w.cost, root, w.waveCost ? { number: wave, cost: w.waveCost } : undefined, w.waveCost?.approve_above) } : {});
  // With review.agent on, the policy reads the review of the merged pull request's head as input.review.
  const review = settings.review?.agent ? await waveReview(repo, policyEnv, options, label, settings.forge) : undefined;
  const found = await checkPlans(repo, governing.policy, planned.map((p) => ({ path: p.root, plan: p.plan, ...cost(p.root) })), policyBaseRef, governing.trust, options.policy ?? {}, (l) => console.log(l), { stage: "tf-apply", project: runAt.project, commit: runAt.commit, actor: detectActor(repo, policyEnv, governing.policy.agents), ...(review ? { review } : {}) });
  w.policy = found.policy;
  for (const p of planned) {
    const verdict = found.roots.get(p.root);
    if (verdict) p.policy = verdict;
  }
  if (found.failed.size === 0) return out;
  // Who may override is policy.override in the config at base, when the policy key in force names any; with nobody listed, no denial is recorded for an override.
  // Its scoped entries name people and roles for the roots their globs match, and the rules they cover (./override.ts).
  const scoped = governing.policy.override?.length ? ctx.rule : undefined;
  const byRoot = new Map<string, Overriders>();
  for (const p of planned) if (found.failed.has(p.root)) byRoot.set(p.root, scoped ? rootOverriders(repo, scoped, p.root, p.policy?.rules ?? []) : { principals: [], shown: [] });
  const overriders = [...new Set([...byRoot.values()].flatMap((o) => o.principals))];
  // A denial with its rules and plan can be overridden by someone named for it; one the policy could not check never is.
  const overridable = (p: WavePlan): boolean => (byRoot.get(p.root)?.principals.length ?? 0) > 0 && found.failed.has(p.root) && p.policy?.result === "denied" && (p.policy.rules?.length ?? 0) > 0 && !p.policy.hard_mandatory?.length && !!p.member?.planDigest;
  const hard = planned.filter((p) => found.failed.has(p.root) && !overridable(p));
  if (scoped?.overrideEntries) {
    j.overridersByRoot = byRoot;
    for (const p of hard) if (p.policy?.result === "denied" && p.policy.rules?.length) console.log(`${p.root}: policy.override at base names nobody who may override it for ${p.policy.rules.join(", ")}`);
  }
  j.denials = new Map(found.failed);
  // A hard-mandatory rule is not overridable: name it, whoever policy.override lists.
  const hardRules = [...new Set(planned.flatMap((p) => (found.failed.has(p.root) ? p.policy?.hard_mandatory ?? [] : [])))].sort();
  for (const p of planned) if (found.failed.has(p.root) && p.policy?.hard_mandatory?.length) console.log(`${p.root}: ${p.policy.hard_mandatory.join(", ")} ${p.policy.hard_mandatory.length === 1 ? "is" : "are"} hard-mandatory, so no override, approval or agent action can pass this denial`);
  if (hard.length > 0) {
    for (const p of planned) {
      const error = found.failed.get(p.root);
      if (error === undefined) continue;
      p.error = error;
      console.log(`FAILED ${p.root}: ${error.split("\n")[0]}`);
      console.log(indent(error));
    }
    console.log(`${label}: policy refused ${found.failed.size} root${found.failed.size === 1 ? "" : "s"}, so nothing in it was applied`);
    w.refused = { reason: "policy", roots: [...found.failed.keys()].sort(), ...(hardRules.length ? { hard_mandatory: hardRules } : {}) };
    writeOutcome(options.env, `wave ${wave} refused by policy: ${[...found.failed.keys()].join(", ")}${hardRules.length ? ` (hard-mandatory: ${hardRules.join(", ")})` : ""}`, w);
    return EXIT.failed;
  }
  j.overriders = overriders;
  if (w.policy) w.policy.overriders = overriders;
  // Scoped entries: each denied root says who may override it.
  if (scoped?.overrideEntries) for (const p of planned) if (p.policy && byRoot.get(p.root)?.shown.length) p.policy = { ...p.policy, overriders: byRoot.get(p.root)!.shown };
  for (const p of planned) {
    if (!found.failed.has(p.root)) continue;
    out.set(p.root, { rules: p.policy!.rules!, reason: found.failed.get(p.root)!.split("\n")[0]! });
  }
  return out;
}

/**
 * Who may override `root`'s denial by `rules` under `policy.override` at
 * base (overridersFor), with the roles of `.chant/trust.json` at base under
 * `sealed` alone, where a seal proves who wrote the override.
 */
function rootOverriders(repo: string, rule: ApprovalRule, root: string, rules: readonly string[]): Overriders {
  const wantsRoles = rule.overrideEntries?.some((e) => e.roles?.length) === true;
  const roles = wantsRoles && rule.mode === "sealed" ? trustRolesAt(repo, rule.base) : {};
  return overridersFor({ overriders: rule.overriders, ...(rule.overrideEntries ? { entries: rule.overrideEntries } : {}), roles }, root, rules);
}

/**
 * Why a ledger approval of a wave does not count under the rule that an
 * approval comes from someone who had no hand in the change (./involved.ts),
 * or null when it counts.
 *
 * A review recorded under `pr-review` counts when one of its reviewers had no
 * hand in it. A signed approval whose seal verifies against the signers file
 * at base is its signer's: the principal it names is the login checked. An
 * unsigned approval names whoever wrote it; it is refused when that name had
 * a hand in the change, and with `approval.require_signed` it is refused
 * whatever it names.
 */
export function resolutionRefusal(r: ResolutionRecord, o: { involved?: Involved; signers?: GateSigners; requireSigned?: boolean }): { reason: string; excluded: Excluded[] } | null {
  const signed = r.seal !== undefined && r.seal !== null;
  const verified = signed && o.signers !== undefined && sealRefusal(o.signers, r) === null;
  if (o.requireSigned && !verified) {
    const what = r.via === "pr-review" && r.reviewers?.length ? `the approval recorded from the review of pull request ${r.pr ?? ""} by ${r.reviewers.join(", ")}`.replace("  ", " ") : `the approval by ${r.resolvedBy}`;
    return { reason: `${what} is ${signed ? "signed, and its seal does not verify against the signers file at base" : "not signed"}, and approval.require_signed counts only a signed one (terragucci approve --sign)`, excluded: [] };
  }
  if (!o.involved) return null;
  if (r.via === "pr-review" && r.reviewers?.length) {
    const { by, excluded } = judge(r.reviewers, o.involved);
    return by.length > 0 ? null : { reason: excluded.map((e) => notCounted(e, "review")).join("; "), excluded };
  }
  const why = whyInvolved(o.involved, r.resolvedBy);
  if (!why) return null;
  const e = { login: r.resolvedBy, reason: why };
  return { reason: notCounted(e), excluded: [e] };
}

/** The forge a job runs on, from its environment. */
const forgeOfEnv = (env: NodeJS.ProcessEnv): "github" | "forgejo" | "gitlab" => (env.GITLAB_CI === "true" ? "gitlab" : env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true" ? "forgejo" : "github");

/**
 * A review's reviewer as chant names a forge principal, from the job's forge
 * and host: `github:alice` on github.com, `gitlab@gitlab.acme.com:bob`, and
 * `forgejo@<host>:carol` on Forgejo and Gitea. `.chant/trust.json` grants a
 * reviewer a role under that name alone.
 */
export function reviewerPrincipal(env: NodeJS.ProcessEnv): (login: string) => string {
  const forge = forgeOfEnv(env);
  // As chant reads the host for a review's principals: the URL's host, port and all.
  const hostOf = (url: string | undefined, fallback: string): string => {
    try {
      return url ? new URL(url).host.toLowerCase() : fallback;
    } catch {
      return fallback;
    }
  };
  const host = forge === "gitlab" ? (env.CI_SERVER_HOST ?? hostOf(env.CI_SERVER_URL, "gitlab.com")) : hostOf(env.GITHUB_SERVER_URL, "github.com");
  return (login) => forgePrincipalOf(forge, host, login);
}

/** Whether every rule is met. */
const rulesMet = (progress: readonly GateQuorumRuleProgress[]): boolean => progress.every((p) => p.met);

/**
 * The people behind the plans a wave applies (./involved.ts): the pull
 * request that made the commit, when the forge names one, its commits, the
 * commits git holds after the base the gate is judged at, and the tokens'
 * users. Never throws.
 */
async function waveInvolvement(repo: string, options: ApplyWaveOptions, rule: ApprovalRule): Promise<Involved> {
  const env = options.env ?? process.env;
  const forge = forgeOfEnv(env);
  const sha = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const notes: string[] = [];
  let f: JobForge | undefined;
  let pr: ReviewedPull | undefined;
  try {
    f = jobForge(forge, env, options.fetch);
    pr = await pullOf(f, env, sha);
  } catch (e) {
    notes.push(`the pull request that made ${sha.slice(0, 8)} could not be read from the forge (${(e as Error).message}), so only git names the people behind it`);
  }
  const inv = await pullInvolvement({ forge, ...(f ? { reads: f.reads } : {}), ...(pr ? { pr } : {}), env, ...(options.fetch ? { fetch: options.fetch } : {}), git: { repo, base: rule.base, head: sha }, ...(rule.agentTokenEnv ? { agentTokenEnv: rule.agentTokenEnv } : {}), ...(rule.agentLogin ? { agentLogin: rule.agentLogin } : {}) });
  return { people: inv.people, notes: [...notes, ...inv.notes] };
}

/**
 * What wave 1 says when chant found an approval of another digest for the
 * migration it is held on: who approved what, and the roots whose state moved
 * since, from the pending fact that digest answered (every root of the
 * migration when the ledger has none to compare).
 */
export function migrationMovedLine(repo: string, gate: string, mismatch: { approved?: string; resolvedBy: string }, held: HeldMigration | undefined): string {
  const { roots, members } = held ?? { roots: [], members: [] };
  let moved = roots;
  try {
    moved = movedSinceApproval(readLedger(repo, MIGRATE_LEDGER), gate, mismatch.approved, members, roots);
  } catch {
    // The ledger could not be read: every root, as with no fact to compare.
  }
  return `wave 1: ${mismatch.resolvedBy} approved ${mismatch.approved ?? "another digest"} of ${gate}, and the states moved since: ${moved.join(", ") || "the migration file"}; nothing was written`;
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
  // Scoped policy.override entries at base: chant counted anyone the wave named for any of its denied roots, so each override is judged for its own root and rules here.
  const unscoped: string[] = [];
  for (const m of d?.members ?? []) {
    const p = w.planned?.find((x) => x.root === m.member);
    if (!m.override || !p?.policy) continue;
    const allowed = j.overridersByRoot?.get(m.member);
    if (allowed && !mayOverride(allowed.principals, m.override.by)) {
      unscoped.push(m.member);
      console.log(`${m.member}: the override by ${m.override.by} does not count: policy.override at base lets ${allowed.shown.join(", ") || "nobody"} override ${m.member} for ${(m.denied?.rules ?? p.policy.rules ?? []).join(", ")}`);
      continue;
    }
    p.policy = { ...p.policy, override: { by: m.override.by, at: m.override.at, rules: m.denied?.rules ?? p.policy.rules ?? [], reason: m.override.reason, plan_digest: m.planDigest, digest: m.override.digest, sealed: mode === "sealed" } };
    overridden.push(m.member);
  }
  if (overridden.length && w.policy) w.policy.overridden = overridden.sort();
  if (unscoped.length > 0 && (status === "approved" || status === "not-required")) {
    // Nothing applied or spent yet: a failing after-gate hook stops the wave before its apply.
    for (const root of unscoped) {
      const p = w.planned?.find((x) => x.root === root);
      if (p) p.error = j.denials?.get(root) ?? "denied by the policy";
      const allowed = j.overridersByRoot!.get(root)!;
      if (allowed.shown.length) console.log(`${root}: ${allowed.shown.join(", ")} may let this plan through with:\n  ${overrideCommand(root, d?.members.find((m) => m.member === root)?.denied?.rules ?? [], mode === "sealed")}`);
    }
    console.log(`${label}: policy refused ${unscoped.length} root${unscoped.length === 1 ? "" : "s"}, whose override policy.override at base does not cover, so nothing in it was applied`);
    w.refused = { reason: "policy", roots: [...unscoped].sort() };
    writeOutcome(options.env, `wave ${wave} refused by policy: ${unscoped.join(", ")}`, w);
    j.code = EXIT.failed;
    return EXIT.failed;
  }
  if (d?.heldOn) {
    // A state migration holds wave 1 on its own gate (migrationCall printed the proof and its command).
    j.code = EXIT.waiting;
    if (d.heldOn.mismatch) {
      console.log(migrationMovedLine(repo, d.heldOn.gate, d.heldOn.mismatch, j.migration));
      j.code = EXIT.refused;
      writeOutcome(options.env, `migration ${d.heldOn.gate}: the states moved since it was approved`, w);
    }
    return EXIT.applied;
  }
  w.digest = d?.digest || env.CHANT_GATE_DIGEST || w.digest;
  const digest = w.digest ?? "";
  if (status === "not-required") {
    w.approval = "not-required";
    // An approval of these plans left standing would refuse the next push's other plans (behold#571): it is spent as they apply.
    if (digest && options.share === undefined && options.group === undefined) {
      try {
        await spendStanding(repo, waveGate(wave), digest, options.now, options.env ?? process.env);
      } catch (e) {
        console.log(`${label}: the approval of these plans was not spent: ${(e as Error).message}`);
      }
    }
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
      const scopedTo = j.overridersByRoot?.get(root);
      if (scopedTo?.shown.length) {
        console.log(`${root}: policy.override at base lets ${scopedTo.shown.join(", ")} override it for ${rules.join(", ")}; one of them can let this plan through with:`);
        console.log(`  ${overrideCommand(root, rules, mode === "sealed")}`);
      } else if (!scopedTo && j.overriders?.length) {
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
  // On chant's step chant counts approval_rules and reads the review (chant#4859): the report takes where each rule stands, and the review, from its decision.
  if (d?.quorumProgress?.length) {
    w.approvalRules = d.quorumProgress.map(ruleReport);
    for (const p of d.quorumProgress) console.log(`${label}: approval_rules: ${quorumRuleLine(p)}`);
  }
  if (!w.review && d?.review?.pr !== undefined && d.review.url) w.review = { pull_request: d.review.pr, url: d.review.url };
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
          facts.held = { since: asked, approvedAt: d.approvedAt };
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
  if (j.reviewMoved) {
    const moved = j.reviewMoved;
    console.log(`${label}: pull request ${moved.pr} was approved on its head ${moved.head.slice(0, 8)} by ${moved.by.join(", ")}, but the plans changed since that review, so nothing in it was applied`);
    console.log(`${label}: the review saw digest ${moved.reviewed}; the changes planned now have another. Read the plans above, then approve them with:`);
    console.log(`  ${approveLine(wave, digest, mode)}`);
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
    // What respond wave-refused compares, the plans approved and the plans made now, chant writes from the reports it keeps beside the pending facts.
    const was = approvedFact?.planDigest ?? mismatch.approved;
    const approved = was ? storedReport(repo, wave, was) : undefined;
    if (!approved) console.log(`${label}: the approved plans were not kept, so only the roots that moved can be named`);
    w.refused = { reason: "approval", ...(mismatch.approved ? { approved: mismatch.approved } : {}), by: mismatch.resolvedBy, roots: moved };
    w.command = approveLine(wave, digest, mode);
    writeOutcome(options.env, `wave ${wave} changed after approval: ${moved.join(", ")}`, w);
    j.code = EXIT.refused;
    return EXIT.applied;
  }
  const progress = d?.quorumProgress;
  const rules = progress?.length && !rulesMet(progress) ? quorumWaiting(progress) : undefined;
  console.log(`${label} waits for ${rules ? "more approvals" : "an approval"} of digest ${digest}. Read its plans above, then approve it with:`);
  if (rules) console.log(`${label}: approval_rules at base: ${rules}`);
  if (w.excluded?.length) console.log(`${label}: approvals that do not count: ${w.excluded.map((e) => `${e.login} (${e.reason})`).join("; ")}`);
  console.log(`  ${approveLine(wave, digest, mode)}`);
  // chant records the approver as --actor, else GITHUB_ACTOR, GITLAB_USER_LOGIN or USER; a seal counts only when that name is a principal in .chant/allowed_signers.
  console.log(mode === "sealed"
    ? "terragucci approve records you as $GITHUB_ACTOR, $GITLAB_USER_LOGIN or $USER. When none of them is your principal in .chant/allowed_signers, add --actor <principal>."
    : "terragucci approve records you as $GITHUB_ACTOR, $GITLAB_USER_LOGIN or $USER; add --actor <name> to name yourself. Under approval: ledger the approval binds these plans, not the person.");
  console.log("Then run this job again.");
  w.command = approveLine(wave, digest, mode);
  writeOutcome(options.env, `wave ${wave} waits${rules ? ` (${rules})` : ""}: ${w.command}`, w);
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
async function migrationCall(repo: string, options: ApplyWaveOptions, ctx: WavesContext, j: WaveJob, hold: Record<string, string> | undefined, cwd: string): Promise<number> {
  delete j.code;
  delete j.migration;
  if (j.k !== 1 || options.share !== undefined || options.group !== undefined || !existsSync(join(repo, MIGRATIONS_DIR))) return EXIT.applied;
  const env = options.env ?? process.env;
  let approved: MigrationHold["approved"];
  try {
    approved = hold?.CHANT_HOLD_APPROVED ? (JSON.parse(hold.CHANT_HOLD_APPROVED) as MigrationHold["approved"]) : undefined;
  } catch {
    approved = undefined;
  }
  const rosters: { root: string; roster: Roster }[] = [];
  // Only a run that may write (under chant's hold) streams progress: a proof writes nothing.
  const bucket = hold ? await migrationBucket(repo, options, env).catch(() => undefined) : undefined;
  const run = await runMigrations(repo, {
    binary: options.binary,
    env,
    roster: (root, roster) => rosters.push({ root, roster }),
    ...(hold ? { progress: migrationProgress(j.w, bucket) } : {}),
    // A Terragrunt unit is prepared by Terragrunt, and its binary then runs where Terragrunt runs it.
    ...(options.terragrunt ? { terragrunt: { ...(options.terragruntPath ? { path: options.terragruntPath } : {}), ...(options.terragruntExec ? { exec: options.terragruntExec } : {}) } } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.approval ? { approval: options.approval } : {}),
    ...(options.base ? { base: options.base } : {}),
    ...(options.config ? { config: options.config } : {}),
    // chant#4623: CHANT_HOLD_FINISHED is set only once chant wrote the gate's applied line; the migration then writes how it ended there.
    ...(hold ? { hold: { file: join(cwd, hold.CHANT_HOLD ?? ".chant/op-waves/tf-apply/wave-1/hold.json"), ...(approved ? { approved } : {}), ...(approved && hold.CHANT_HOLD_FINISHED ? { finished: join(cwd, hold.CHANT_HOLD_FINISHED) } : {}) } } : { prove: true }),
  });
  for (const r of run.records) if (r.status === "applied") ctx.migrated.add(r.name);
  if (run.records.length > 0) await uploadMigrationRecords(repo, options, run.records, env, rosters);
  if (run.code === EXIT.applied) return EXIT.applied;
  const last = run.records[run.records.length - 1];
  if (last) j.migration = { roots: last.roots.map((r) => r.root), members: beforeMembers(last.roots) };
  if (run.command) j.w.command = run.command;
  const what = last ? `migration ${last.name}` : "a migration";
  writeOutcome(options.env, run.code === EXIT.waiting ? `${what} waits: ${run.command ?? ""}` : run.code === EXIT.refused ? `${what}: the states moved since it was approved` : `${what} failed`, j.w);
  if (run.code !== EXIT.waiting) console.log(`wave 1: ${what} did not apply, so no wave plans until it does`);
  // One apply job per identity: wave 1's deciding job runs the migrations, and it holds the plan identities alone.
  if (options.groups && run.code === EXIT.failed) console.log(`wave 1: with one apply job per identity, the wave's deciding job runs ${what} with the plan identities alone, which cannot write a state`);
  // A hold, also one made after an approved migration applied in this run (the next migration's, chant#3847), waits on chant's decision of its gate.
  // A hold waits on chant's decision of the migration's gate (gateCall); anything else is this wave's own code.
  if (run.code !== EXIT.waiting) j.code = run.code;
  return run.code;
}

// ── a Terragrunt wave ────────────────────────────────────────────────────

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

const waves = (n: number): string => `${n} wave${n === 1 ? "" : "s"}`;

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
  const status: OutcomeStatus = code === EXIT.applied ? "applied" : code === EXIT.waiting ? "waiting" : code === EXIT.refused || code === EXIT.held || code === EXIT.superseded || code === EXIT.declined ? "refused" : "failed";
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
