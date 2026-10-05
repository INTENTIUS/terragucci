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
export const REPORT_MINOR = 2;

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
  binary: string;
  runtime: string;
  started: string;
  finished: string;
  /** The CI job that produced the report. */
  job_url?: string;
  /** The `terragucci` version that wrote it. */
  terragucci?: string;
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
  /** The root's wall time: init, plan and show. */
  seconds: number;
  /** The binary's plan run alone. Absent when the root never reached it. */
  plan_seconds?: number;
  /** How many spans the binary sent for the plan. */
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
  roots: { root: string; seconds: number; plan_seconds?: number; detail: ReportRootTimings["detail"] }[];
  /** The slowest resource instances across the run. */
  resources: { root: string; address: string; type?: string; ms: number }[];
  /** Why the run has no per-root timings, when it has none. */
  note?: string;
}

export interface ReportRoot {
  path: string;
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
}

export interface ReportWave {
  number: number;
  roots: string[];
  /** chant's set digest over the wave's roots' plan digests. Null when a root of it failed to plan. */
  set_digest: string | null;
  approval: "not-requested" | "waiting" | "approved" | "not-required";
  /** Where the approval record lives. The report points at it and never copies it. */
  gate?: { branch: string; path: string };
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
}

/**
 * The word for a named change. In a drift report a delete is something gone
 * from the real world, not something a plan will destroy.
 */
export function actionWord(stage: ReportStage, action: NamedAction): string {
  if (stage === "tf-drift" && action === "delete") return "deleted outside Terraform";
  return { delete: "destroy", replace: "replace", refused: "refused to plan", forget: "forget", import: "import" }[action];
}
