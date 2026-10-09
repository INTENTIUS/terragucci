/**
 * `terragucci.report/v1`: one JSON document per run. Every view (the
 * pull-request note, the HTML report, GitLab's `reports:terraform` and the
 * job-log text) is rendered from this document and from nothing else.
 *
 * The JSON Schema beside this file (`report.schema.json`) is published with
 * the package. A minor version only adds fields, so a reader of 1.0 reads 1.x.
 */
import type { ChangeSetAction, ChangeSetAttribute, ChangeSetDisruption } from "@intentius/chant/change-set";
import type { PlanSummaryChange, PlanSummaryUnit } from "@intentius/chant/plan-summary";

export const REPORT_SCHEMA = "terragucci.report/v1";
export const REPORT_MINOR = 19;

/** What replaces every sensitive value in a stored plan. */
export const REDACTED = "(sensitive, redacted by terragucci)";

/** The stage a report comes from. */
export type ReportStage = "tf-plan" | "tf-apply" | "tf-drift";

/** Whether a reader finds a thing open on the page, or one click away. */
export type Fold = "open" | "folded";

export interface ReportRun {
  /** `<host>/<path>` of the repo, or the directory name when no remote names it. */
  project: string;
  commit: string;
  base?: string;
  stage: ReportStage;
  /** Set on a `tf-apply` wave's report. */
  wave?: number;
  /** On a `tf-apply` wave split across jobs (`waves.jobs`), the share this report applied, from 1 (minor 16); `waves[0].roots` are its roots. */
  share?: number;
  binary: string;
  runtime: string;
  started: string;
  finished: string;
  /** The CI job that produced the report. */
  job_url?: string;
  /** The `terragucci` version that wrote it. */
  terragucci?: string;
  /** The commit's page on the forge (minor 4). */
  commit_url?: string;
  /** The pull or merge request the run planned, by number (minor 4). */
  pull_request?: string;
  /** Its page on the forge (minor 4). */
  pull_request_url?: string;
  /** Where this report.html is served, when `reports.url` names the bucket's address (minor 4). */
  report_url?: string;
  /** The run's trace id, when the stage sent a trace (minor 4). */
  trace_id?: string;
  /** The trace in Grafana, Tempo or another viewer, from `telemetry.trace_url` (minor 4). */
  trace_url?: string;
}

/** Why something is open: one short reason a reader sees beside it. */
export interface Highlight {
  address: string;
  type: string;
  action: ChangeSetAction;
  why: string;
}

export interface ReportGroup {
  /** chant's group id: twelve hex characters, the same for the same change in every run. */
  id: string;
  /** For instance groups, the expansion the instances belong to. */
  resource?: string;
  /** The roots in the group, or instance addresses for a one-root report. */
  units: string[];
  outlier: boolean;
  noChanges: boolean;
  /** The representative change, normalized. */
  changes: PlanSummaryChange[];
  extends?: string;
  plus?: PlanSummaryChange[];
  /** How many destroys and replacements its units make; each is also in `named[]`. */
  destroys: number;
  /** Attributes whose values differ between the group's roots, by address. */
  varies: { address: string; paths: string[] }[];
  fold: Fold;
  /** Why the group is open. Empty when it is folded. */
  why: string[];
}

/** One proposed change in a root, as chant's change set carries it, without the member fields. */
export interface ReportChange {
  address: string;
  type: string;
  action: ChangeSetAction;
  disruption?: ChangeSetDisruption;
  deposed?: string;
  module?: string;
  index?: string | number;
  attributes: ChangeSetAttribute[];
  /** Full attribute paths that forced the replacement, from the plan's `replace_paths`. */
  replace_paths?: (string | number)[][];
  /** The resource is being imported, with this id. */
  importing?: string;
  /** Attributes that are write-only versions (`*_wo_version`): the secret itself is never in the plan. */
  write_only?: string[];
  /** What kind of change it is, for folding: `tags`, `description` or `unknown` when only those move. */
  kind?: "tags" | "description" | "unknown";
  fold: Fold;
  why?: string;
}

/** What a Terragrunt run adds about a unit (minor 1). */
export interface ReportUnit {
  /** The unit's stack: its parent directory, a label for grouping and filters. */
  stack: string;
  /** Why the run selected the unit. */
  selection: string;
  /** A preview planned before its upstream units applied. Its digest never binds an approval. */
  provisional: boolean;
  /** The unit's result in Terragrunt's run report (`succeeded`, `failed`, `early exit`), or `not run`. */
  run_result: string;
}

/** A unit that plans after the units it waits for have applied (minor 1). */
export interface ReportDeferred {
  unit: string;
  /** The units it waits for. */
  after: string[];
  why: string;
  /** Whether this run also planned it as a provisional preview. */
  previewed: boolean;
}

/** One dependency that would have planned on `mock_outputs` (minor 1). */
export interface ReportMockRead {
  /** The unit that reads it. */
  unit: string;
  /** The `dependency` block's label. */
  dependency: string;
  upstream: string;
  /** `no-outputs` and `partial` wait for the upstream to apply; `skip-outputs` and `disabled` need the block fixed. */
  reason: "no-outputs" | "partial" | "skip-outputs" | "disabled";
  /** For `partial`: the mock keys the upstream's outputs lack. */
  keys?: string[];
}

/** One resource instance's time in a root's plan, from the binary's spans (minor 2). */
export interface ReportResourceTiming {
  address: string;
  type?: string;
  action?: string;
  /** The provider instance it is planned with. */
  provider?: string;
  ms: number;
  /** The part of it spent refreshing the resource. */
  refresh_ms?: number;
}

/** One call from the binary to a provider (minor 2). */
export interface ReportProviderCall {
  /** The RPC method: `PlanResourceChange`, `ReadResource`, `GetProviderSchema`... */
  method: string;
  provider?: string;
  type?: string;
  /** The resource instance it was made for, when it was made for one. */
  address?: string;
  ms: number;
}

/**
 * A summary span: the binary counted a set of resource instances or provider
 * calls instead of giving each a span of its own (minor 2).
 */
export interface ReportAggregate {
  /** The name of the spans it stands for, such as `Plan resource instance changes`, or `other`. */
  of: string;
  /** `resource_instance` or `provider_call`. */
  kind?: string;
  type?: string;
  provider?: string;
  method?: string;
  count: number;
  /** How many of them also have a span of their own. */
  detailed: number;
  /** Their total time. */
  ms: number;
  max_ms: number;
  /** The slowest member: an address, or a resource type. */
  slowest?: string;
  /** For `other`: how many groups it folds. */
  groups?: number;
}

/** Where a root's plan spent its time (minor 2). */
export interface ReportRootTimings {
  /** The root's wall time: init, plan and show, and on a tf-apply wave the apply. */
  seconds: number;
  /** The binary's plan run alone. Absent when the root never reached it. */
  plan_seconds?: number;
  /** On a tf-apply wave, the binary's apply run alone. Absent when the root was not applied (minor 3). */
  apply_seconds?: number;
  /**
   * Where the times come from (minor 3): `binary`, terragucci timed each run
   * of the binary itself; `terragrunt`, Terragrunt ran the binary and its run
   * report gives the unit's start and end. Absent means `binary`.
   */
  source?: "binary" | "terragrunt";
  /** How many spans the binary sent for the plan (and, on a tf-apply wave, the apply). */
  spans: number;
  /** `resources`: a span per resource instance; `aggregate`: summed by type only; `none`: nothing per resource. */
  detail: "resources" | "aggregate" | "none";
  /** Why the lists are empty or partial. */
  note?: string;
  /** The slowest resource instances, slowest first. */
  resources: ReportResourceTiming[];
  provider_calls: ReportProviderCall[];
  /** Provider start-up, by provider. */
  provider_init: { provider: string; count: number; ms: number; max_ms: number }[];
  /** Waits for a state lock. */
  lock_waits: { backend?: string; operation?: string; attempts?: number; ms: number }[];
  aggregates: ReportAggregate[];
}

/** The run's slowest roots and resources (minor 2). */
export interface ReportTimings {
  /** Every timed root, slowest first. */
  roots: { root: string; seconds: number; plan_seconds?: number; apply_seconds?: number; source?: ReportRootTimings["source"]; detail: ReportRootTimings["detail"] }[];
  /** The slowest resource instances across the run. */
  resources: { root: string; address: string; type?: string; ms: number }[];
  /** Why the run has no per-root timings, when it has none. */
  note?: string;
}

/** The binary a root ran, and the version it pinned when it pinned one (minor 18). */
export interface ReportRootBinary {
  /** tofu, terraform or choudoufu. */
  name: string;
  /** Absent when the binary did not say. */
  version?: string;
  /** Where the root pinned its version: `.opentofu-version`, `.terraform-version`, `required_version` or `terragucci.yml version <glob>`. Absent when it runs the job's binary unpinned. */
  pin?: string;
}

/** A root's binary as the note, the report and the log name it: `tofu 1.10.6 (.opentofu-version)`. */
export function binaryText(b: ReportRootBinary): string {
  return `${b.name}${b.version ? ` ${b.version}` : ""}${b.pin ? ` (${b.pin})` : ""}`;
}

export interface ReportRoot {
  path: string;
  /** The binary the root ran (minor 18). */
  binary?: ReportRootBinary;
  /** Set when the root is a Terragrunt unit. */
  terragrunt?: ReportUnit;
  status: "planned" | "failed";
  error?: string;
  /** The digest a gate on this root binds, over the unredacted plan. Null when it failed. */
  plan_digest: string | null;
  /** Changes by action; no-ops included. */
  counts: Partial<Record<ChangeSetAction, number>>;
  /** The group it is in. Absent when it failed or the report groups instances. */
  group?: string;
  plan: { text?: string; json?: string };
  job_url?: string;
  /** Every change but no-ops. */
  changes: ReportChange[];
  highlights: Highlight[];
  fold: Fold;
  why: string[];
  /** Where its plan spent its time, from the binary's spans (minor 2). */
  timings?: ReportRootTimings;
  /**
   * What the policy found in its plan, when `policy` is on and the root was
   * checked (minor 6). A denied root is `failed` with the denial as its
   * error, and keeps its changes so a reader sees what was refused.
   */
  policy?: ReportRootPolicy;
  /**
   * On a `tf-apply` wave, a root that applied or had nothing to apply: every
   * managed resource it holds afterwards, from the plan's planned values
   * (minor 14). Never a value. Absent on a root that did not apply.
   */
  resources?: ReportResource[];
  /**
   * On a `tf-apply` wave, a root that applied: what the apply did to each
   * resource, and which top-level attributes an update or a replacement
   * changed, by name (minor 15). Never a value.
   */
  applied_changes?: ReportAppliedChange[];
  /** The steps that ran for it (minor 17), in the order they ran. Absent when none did. */
  steps?: ReportStep[];
}

/** When a step runs: before or after a root's init, plan, apply or drift (minor 17). */
export type ReportStepWhen = `${"before" | "after"}-${"init" | "plan" | "apply" | "drift"}`;

/**
 * One step that ran for a root (minor 17). `passed`: it exited 0. `failed`:
 * it exited otherwise and the root failed. `approval`: it exited otherwise
 * with `on_failure: approve`, so the root's wave waits for an approval.
 * Its output stays in the job log.
 */
export interface ReportStep {
  name: string;
  when: ReportStepWhen;
  status: "passed" | "failed" | "approval";
  /** The exit code; null when it was killed or could not start. */
  exit: number | null;
  seconds: number;
}

/** What one apply did to one resource (minor 15). */
export interface ReportAppliedChange {
  address: string;
  type: string;
  /** In this order when several hold: move, import, then create, update, replace, delete or forget. */
  actions: ("create" | "update" | "replace" | "delete" | "import" | "move" | "forget")[];
  /** The top-level attributes an update or a replacement changed, sorted; empty for the other actions. */
  attributes: string[];
  /** Where a moved resource was. */
  previous_address?: string;
}

/** One resource a root holds (minor 14): its address, type and provider, never a value. */
export interface ReportResource {
  address: string;
  type: string;
  /** The provider's source address, such as `registry.opentofu.org/hashicorp/aws`. */
  provider: string;
}

/** One root's policy verdict (minor 6). */
export interface ReportRootPolicy {
  /** `denied`: a deny rule matched; `error`: the policy could not be read or run. Either fails the root. */
  result: "passed" | "denied" | "error";
  /** The messages of `deny`, `violation` and `deny_*` rules. */
  denials: string[];
  /** The ids of the rules that denied, such as `main.deny_public_bucket`, sorted (minor 10): what an override names. */
  rules?: string[];
  /** The messages of `warn` rules: advice that fails nothing. */
  warnings: string[];
  /** Why the policy could not be checked, with `result: error`. */
  error?: string;
  /**
   * The override that stands for this root's plan and rules (minor 10). On a
   * `tf-apply` wave the root then applies, and is `planned` with its denial
   * still here; on a `tf-plan` run the root still fails.
   */
  override?: ReportOverride;
}

/** A recorded policy override: a listed approver let one denied plan through (minor 10). */
export interface ReportOverride {
  /** Who wrote it, as the ledger names them. */
  by: string;
  /** When, from the ledger line. */
  at: string;
  /** The rule ids it overrides: exactly the rules that denied the plan. */
  rules: string[];
  /** Why, as the approver wrote it. */
  reason: string;
  /** The root's plan digest it names. */
  plan_digest: string;
  /** The digest the ledger line binds: the root, its plan digest and the rules. */
  digest: string;
  /** Whether its seal verified against the signers file at base (`approval: sealed`). */
  sealed: boolean;
}

/** The run's policy check (minor 6). Absent when `policy` is off, and on a drift report. */
export interface ReportPolicy {
  engine: "conftest" | "opa";
  /** What `input` held: the bare plan, or HCP Terraform's `{plan, run}`. */
  input: "plan" | "hcp";
  /** The namespace the config sets, if any. */
  namespace?: string;
  /** Where the policy was read from: the checkout, or the pull request's base branch. */
  from: "checkout" | "base";
  /** The roots it denied or could not check, by path. An overridden root is here and in `overridden`. */
  denied: string[];
  /** How many warnings it gave across the roots. */
  warnings: number;
  /** The denied roots an override stands for (minor 10). */
  overridden?: string[];
  /** Who may override a denial, from `policy.override` in the config at base (minor 10). Absent when nobody may. */
  overriders?: string[];
}

export interface ReportWave {
  number: number;
  roots: string[];
  /** chant's set digest over the wave's roots' plan digests. Null when a root of it failed to plan. */
  set_digest: string | null;
  /** A `tf-apply` wave reports its gate (minor 7): waiting until an approval of its digest stands, approved once one does, not-required when no gate binds it. Other stages say not-requested. */
  approval: "not-requested" | "waiting" | "approved" | "not-required";
  /**
   * A `tf-plan` wave (minor 9): chant's set digest over the wave's roots whose
   * plan changes a resource or an output, the digest `approval: pr-review`
   * binds a pull request's review to. Null when no root of it changes.
   */
  review_digest?: string | null;
  /** A `tf-plan` wave (minor 9): whether the gate will hold it when it applies, as the plans stand. */
  waits?: boolean;
  /** Where the approval record lives (minor 7, on a gated `tf-apply` wave). The report points at it and never copies it. */
  gate?: { branch: string; path: string };
  /** On a waiting wave, when it began waiting for an approval of this digest (minor 8): the first run that asked for it, not the latest. */
  waiting_since?: string;
  /** Why a `tf-apply` wave applied nothing although it planned (minor 11). Absent when it was not refused. */
  refused?: ReportRefusal;
  /**
   * A waiting `tf-apply` wave under `approval: pr-review` (minor 13): the pull
   * request whose approving review of its head would approve the wave, and
   * the page to review it on. Absent when no review can approve it.
   */
  review?: { pull_request: number; url: string };
  /**
   * The roots whose `on_failure: approve` step failed (minor 17): the gate
   * holds the wave whatever the gate policy says, when it changes anything.
   */
  held_by_steps?: string[];
  /** The wave's monthly cost, when `cost` is on (minor 19): the sums over its roots estimated, and with `cost.approve_above` whether it waits for it. */
  cost?: ReportWaveCost;
}

/** One wave's monthly cost (minor 19). */
export interface ReportWaveCost {
  currency: string;
  /** The change over the wave's roots estimated. Null when none was. */
  monthly_delta: number | null;
  monthly_total: number | null;
  past_monthly_total: number | null;
  /** The wave's roots the estimator gave no figure for. */
  unestimated?: string[];
  /** `cost.approve_above` in the config at base, when set. */
  approve_above?: number;
  /** With `approve_above`: the change is over it, or cannot be known, so the wave waits for an approval whatever the gate. */
  over?: boolean;
}

/**
 * A refused wave (minor 11): its plans changed after an approval, a review
 * or an override (exit 4), or the policy denied a root that no override lets
 * through.
 */
export interface ReportRefusal {
  reason: "approval" | "review" | "override" | "policy";
  /** The digest the approval, review or override was for. */
  approved?: string;
  /** Who wrote it, as the ledger or the review names them. */
  by?: string;
  /** The roots that planned differently since (every changing root, for a review), or the roots the policy denied. */
  roots: string[];
}

export type NamedAction = "delete" | "replace" | "refused" | "forget" | "import";

/** Every destroy, replacement and refusal by address. None is folded into a group. */
export interface ReportNamed {
  root: string;
  /** Absent on a refusal: the whole root refused to plan. */
  address?: string;
  type?: string;
  action: NamedAction;
  deposed?: string;
  replace_paths?: (string | number)[][];
  reason?: string;
}

export interface ReportHole {
  root: string;
  address: string;
  type?: string;
  reason: string;
}

/** Advice on how the repo is set up. It never fails a run and no digest covers it. */
export interface ReportTip {
  /** The rule behind it: a chant rule id such as `TF040`, or a terragucci rule such as `terragucci-no-canary`. */
  rule: string;
  /** The root or module the tip is about. Absent when it is about the project. */
  root?: string;
  message: string;
  /** The page that explains the rule. */
  url: string;
}

/**
 * The description check's decision (minor 5): what `respond description`
 * asked about the pull request's text and what the service answered. Present
 * only on a report the check ran against. The decision is advice; no gate
 * reads it.
 */
export interface ReportIntent {
  /** confident, not-confident or unavailable. */
  status: string;
  /** Whether the flag was raised on the note and the report. */
  flagged: boolean;
  /** The decision in a sentence, as the note shows it. */
  decision: string;
  probability?: number;
  threshold?: number;
  model?: string;
  /** The digest of the state the service was asked about. */
  state_digest: string;
  /** The destroys and replacements the text does not mention, by root and address. */
  unmentioned: string[];
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  minor: number;
  run: ReportRun;
  /** The change-set document's digest: the set digest over every root's plan digest. */
  change_set: string;
  unit: PlanSummaryUnit;
  units: number;
  totals: Record<ChangeSetAction, number>;
  groups: ReportGroup[];
  roots: ReportRoot[];
  waves: ReportWave[];
  named: ReportNamed[];
  holes: ReportHole[];
  redaction: { marker: typeof REDACTED; values: number };
  /**
   * Dependencies that would have planned on `mock_outputs`, so their units
   * were not planned as real (Terragrunt). A unit that only waits for its
   * upstream to apply is in no `roots[]` entry unless it was previewed.
   */
  mock_reads?: ReportMockRead[];
  /**
   * Units this run did not plan as real because they plan after other units
   * apply (Terragrunt): dependents of a changed unit, and units whose
   * upstream has no outputs yet. Each names what it waits for.
   */
  deferred?: ReportDeferred[];
  /** Present when tips are on, even when there are none. Absent with `tips: false`. */
  tips?: ReportTip[];
  /** Where the run spent its time (minor 2). Absent from a report built without running the binary. */
  timings?: ReportTimings;
  /** The description check's decision (minor 5). Written by `respond description`; absent when it did not run or `decide:` is unset. */
  intent?: ReportIntent;
  /** The run's policy check, when `policy` is on (minor 6). Each root's verdict is under the root. */
  policy?: ReportPolicy;
  /** The cost estimate of a `tf-plan` run, or of a `tf-apply` wave's plans (minor 19), when `cost` is on (minor 12). */
  cost?: ReportCost;
}

/** One root's monthly cost, from the estimator's output (minor 12). Null where the estimator gave no figure. */
export interface ReportRootCost {
  root: string;
  /** The change in monthly cost this plan makes. */
  monthly_delta: number | null;
  /** The monthly cost once the plan applies. */
  monthly_total: number | null;
  /** The monthly cost before it. */
  past_monthly_total: number | null;
  /** The estimator's output, kept beside the plan (`roots/<root>/cost.json`). Absent when it failed. */
  output?: string;
  /** Why there is no estimate. */
  error?: string;
}

/** The run's cost estimate (minor 12): each root's, and the sums over the roots estimated. */
export interface ReportCost {
  /** The command's first word, such as `infracost`. */
  estimator: string;
  currency: string;
  monthly_delta: number | null;
  monthly_total: number | null;
  past_monthly_total: number | null;
  roots: ReportRootCost[];
}

/**
 * The word for a named change. In a drift report a delete is something gone
 * from the real world, not something a plan will destroy.
 */
export function actionWord(stage: ReportStage, action: NamedAction): string {
  if (stage === "tf-drift" && action === "delete") return "deleted outside Terraform";
  return { delete: "destroy", replace: "replace", refused: "refused to plan", forget: "forget", import: "import" }[action];
}
