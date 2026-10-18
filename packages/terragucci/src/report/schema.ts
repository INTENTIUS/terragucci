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
export const REPORT_MINOR = 41;

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
  /** On a `tf-apply` wave split across jobs (`waves.jobs`), the share this report applied, from 1 (minor 20); `waves[0].roots` are its roots. */
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
  /** The unit's stack, a label for grouping and filters: the directory of the explicit stack that generates it, else its parent directory. */
  stack: string;
  /** The `terragrunt.stack.hcl` that generates the unit, when an explicit stack does (minor 29). */
  stack_file?: string;
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
  /** A Terragrunt unit: the Terragrunt release that ran it, and `terragrunt_version_constraint` when the unit pinned it (minor 24). */
  terragrunt?: { version: string; pin?: string };
}

/** A root's binary as the note, the report and the log name it: `tofu 1.10.6 (.opentofu-version)`. */
export function binaryText(b: ReportRootBinary): string {
  const tg = b.terragrunt?.pin ? ` under Terragrunt ${b.terragrunt.version} (${b.terragrunt.pin})` : "";
  return `${b.name}${b.version ? ` ${b.version}` : ""}${b.pin ? ` (${b.pin})` : ""}${tg}`;
}

export interface ReportRoot {
  path: string;
  /** The environment of `environments:` the root is in (minor 33). Absent when the config names no environments or the root is in none. */
  environment?: string;
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
  /**
   * On a `tf-apply` wave, a root that applied or had nothing to apply: the
   * state version its backend holds afterwards (minor 20). The version id
   * and where the state is, never its contents.
   */
  state?: ReportStateVersion;
  /** The steps that ran for it (minor 17), in the order they ran. Absent when none did. */
  steps?: ReportStep[];
  /** The roots whose state it reads through `terraform_remote_state`, and which outputs it planned on (minor 21). Absent when it reads none. */
  reads?: ReportRead[];
  /**
   * Its `terraform_remote_state` blocks whose state the code does not address
   * (minor 30): an expression, or a value the backend takes from the
   * environment. No edge orders the root after the root that writes that
   * state, so the edge is unknown. Absent when it has none.
   */
  unknown_reads?: ReportUnknownRead[];
  /**
   * Why the code does not address the root's own state, when a root of the
   * run reads state through `terraform_remote_state` (minor 30): a reader of
   * it is not ordered after it.
   */
  unaddressed?: string;
  /**
   * A Terragrunt unit's `dependency` and `dependencies` blocks (minor 23): the
   * units whose outputs it reads, as plain paths in its `terragrunt.hcl`.
   * For a plain root, the roots `waves.after` puts before it.
   * Absent when it names none.
   */
  dependencies?: string[];
  /**
   * A choudoufu plan of a pull request's root under a `live` block, run with
   * `-cone=<base>` (minor 34): the cone it planned, or why choudoufu's guard
   * planned the whole estate. Absent on every other plan.
   */
  cone?: ReportCone;
  /**
   * A root in a composed run (`waves.compose`, minor 38): the wave whose run
   * holds it and its module there. Its other fields come from its part of the
   * composed plan, as if it had planned alone; its `plan_digest` is that
   * part's, which groups and compares it and binds nothing on its own.
   */
  composed?: { wave: number; module: string };
}

/** What a root's `plan -cone=<base>` planned (minor 34). */
export interface ReportCone {
  /** The revision the change is measured from: the pull request's base. */
  base: string;
  /** With a cone: the blocks it holds, and the estate's, when choudoufu said. */
  blocks?: number;
  of?: number;
  /** With a cone: how many addresses it targets. Its targets join the root's plan digest. */
  targets?: number;
  /** The guard planned the whole estate: its kind (`provider-changed`, `cone-too-large`, ...) and why. */
  fallback?: { kind: string; reason: string };
}

/**
 * One `terraform_remote_state` block of a root that reads another root's
 * state (minor 21). In a `tf-plan`, a root whose upstream planned in the same
 * run plans on that plan's outputs (`planned`), each value known only once
 * the upstream applies left unknown. A `tf-apply` wave plans after the waves
 * before it applied, on their state (`applied`).
 */
export interface ReportRead {
  upstream: string;
  /** The block's label: a `terraform_remote_state` or `terraform_estate_outputs` data block's, or a Terragrunt unit's `dependency` blocks' (minor 25), `dependency` when no block names the upstream plainly. */
  data: string;
  /** `planned`: the outputs the upstream's plan in this run makes. `applied`: its state as it stands. */
  outputs: "planned" | "applied";
  /** With `planned`: the outputs it reads that are known only once the upstream applies. */
  unknown?: string[];
  /** With `applied` in a `tf-plan`: why it did not plan on the upstream's planned outputs. */
  why?: string;
  /**
   * A read of another root in the same composed run (`waves.compose`, minor
   * 38): `outputs` is `planned`, and `unknown` names the outputs known only
   * once the upstream's part of the run applies, which the run applies before
   * the resources that read them.
   */
  composed?: true;
}

/** A `terraform_remote_state` block whose state the code does not address (minor 30). */
export interface ReportUnknownRead {
  /** The block's label. */
  data: string;
  /** Which part of the address the code does not say. */
  why: string;
}

/**
 * Where a wave stands (minor 21). A `tf-plan` wave is `planned`. A `tf-apply`
 * wave is `waiting` for an approval, `applying` while it applies (or its
 * share jobs do), then `applied`, or `refused` (its plans changed after an
 * approval, or the policy denied a root) or `failed`.
 */
/** blocked (minor 41): a `tf-apply` wave none of whose roots ran, since an upstream of each did not apply in the run. */
export type WaveState = "planned" | "waiting" | "applying" | "applied" | "refused" | "failed" | "blocked";

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

/**
 * The state a root's backend holds after an apply (minor 20): read from the
 * object's metadata, never from its body.
 */
export interface ReportStateVersion {
  /** The backend the root initialised: `s3`, `local`, `gcs` and so on. */
  backend: string;
  /** Where the state is: `s3://<bucket>/<key>`, `gs://<bucket>/<key>`, `az://<account>/<container>/<key>`, or the local file's path in the root. */
  location?: string;
  /** The backend's id for this version of the state: an S3 version id, a GCS generation, an Azure blob version id or snapshot time. Absent when the backend keeps no versions or none could be read. */
  version_id?: string;
  /** `on`: the backend keeps each version; `off`: it keeps only the latest; `unknown`: terragucci could not tell. */
  versioning: "on" | "off" | "unknown";
  /** Why the version could not be read, or what `off` means for this backend. */
  note?: string;
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
  /** For a choudoufu root: its record's versions once the apply finished, from `choudoufu live-history` (minor 32). */
  record_versions?: ReportRecordVersions;
}

/**
 * A choudoufu record's versions, newest first, as `choudoufu live-history
 * -json` lists them (minor 32): each version's id, when it was written, and
 * whether it is current or a delete marker; never what it holds. `kept` is
 * false for a store that keeps none (`local`, `kubernetes`). `error` is
 * live-history's error as it printed it, when it could not list them, such as
 * an identity without s3:ListBucketVersions.
 */
export interface ReportRecordVersions {
  kept?: boolean;
  /** The record store's type: `s3`, `local` or `kubernetes`. */
  store?: string;
  versions?: ReportRecordVersion[];
  error?: string;
  /** When they were listed. */
  read: string;
}

export interface ReportRecordVersion {
  version_id: string;
  last_modified: string;
  current: boolean;
  deleted: boolean;
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
  /** With `hold` in `policy.outcomes` at base (minor 40): the ids of the `hold` rules that matched, sorted. Its wave waits for an approval. */
  held_by?: string[];
  /** The messages of those `hold` rules (minor 40). */
  holds?: string[];
  /** With `allow_unattended` in `policy.outcomes` at base (minor 40): the ids of the `allow_unattended` rules that matched, sorted. */
  allowed_by?: string[];
  /**
   * With scoped `policy.override` entries at base (minor 40): who may override
   * this root's denial by its rules, names first, then each role as `role
   * <name> (<holders>)`. Absent with a flat list, where `policy.overriders`
   * says it for every root.
   */
  overriders?: string[];
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

/** One `approval_rules` entry a wave takes, and where it stands (minor 40). */
export interface ReportApprovalRule {
  roots: string[];
  /** How many distinct approvers it asks for. */
  count: number;
  /** The roles of `.chant/trust.json` at base an approver counted holds one of. */
  roles?: string[];
  /** At least one approver counted is not the change's author. */
  not_author?: boolean;
  /** A `tf-apply` wave's: the approvers of its digest the rule counted, oldest first. Empty on a plan. */
  approvers: string[];
  met: boolean;
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
   * A `tf-apply` wave (minor 39): the people whose approval of its digest did
   * not count, because they had a hand in the change. `reason` says how, such
   * as `bob asked for abc1234`. Absent when nobody was left out.
   */
  excluded_approvers?: { login: string; reason: string }[];
  /**
   * The `approval_rules` entries at base its roots take (minor 40): what each
   * asks for and, on a `tf-apply` wave, the approvers of its digest it
   * counted and whether it is met. Absent when no rule applies to the wave.
   */
  approval_rules?: ReportApprovalRule[];
  /**
   * What the policy's `hold` and `allow_unattended` rules did to the wave's
   * gate (minor 40): `held`, a root that changes something matched a `hold`
   * rule, so it waits for an approval whatever `gate` says; `unattended`,
   * every root that changes something matched an `allow_unattended` rule and
   * none holds, so `gate` does not hold it. `rules` are those rules' ids, and
   * on a `tf-apply` wave `commit` is the commit the policy was read at.
   * Absent when no such rule decided anything.
   */
  policy_gate?: { outcome: "held" | "unattended"; rules: string[]; commit?: string };
  /**
   * The roots whose `on_failure: approve` step failed (minor 17): the gate
   * holds the wave whatever the gate policy says, when it changes anything.
   */
  held_by_steps?: string[];
  /** The wave's monthly cost, when `cost` is on (minor 19): the sums over its roots estimated, and with `cost.approve_above` whether it waits for it. */
  cost?: ReportWaveCost;
  /** Where the wave stands (minor 21). */
  state?: WaveState;
  /**
   * A `tf-apply` wave's roots that did not run (minor 41): an upstream of
   * each, a root whose state it reads or one `waves.after` puts before it, did
   * not apply in this run. `blocked_by` names the root whose failure held it,
   * past any root blocked in between. The wave's other roots plan and apply,
   * and they are not in `roots`. Absent when none is blocked.
   */
  blocked?: { root: string; blocked_by: string }[];
  /** The waves whose roots' state its roots read (minor 21). Absent when it reads none. */
  reads?: number[];
  /**
   * A `tf-plan` wave whose plans read outputs that are known only once these
   * waves apply (minor 21). It plans again after they apply. When that plan
   * changes something, its gate holds it for an approval of that plan under
   * `gate: always` and `gate: on-destructive`, whether or not it destroys
   * anything; under `gate: never` it applies without one. Its review digest
   * is null, and no approval of this run's digests applies it.
   */
  replans_after?: number[];
  /**
   * A `tf-apply` wave of Terragrunt units (minor 25): its plans against the
   * preview of them the merged pull request's plan note showed, made on the
   * planned outputs of the waves before it. Absent when no pull request
   * previewed any of its units.
   */
  preview?: ReportWavePreview;
  /** The environments of `environments:` its roots are in, sorted (minor 33). Absent when none of its roots is in one. */
  environments?: string[];
  /**
   * The wave that carries a composed run (`waves.compose`, minor 38). Its
   * `roots` list its own roots and the composed ones; its digests cover the
   * composed plan as one member.
   */
  composed?: ReportComposedRun;
}

/** A wave's composed run (minor 38): one plan and one apply across several roots, each root keeping its own state. */
export interface ReportComposedRun {
  /** The composed plan's digest: the one member of the wave's digests that covers these roots. Null when it failed to plan. */
  plan_digest: string | null;
  /** Each root in the run, upstreams first. */
  members: ReportComposedMember[];
  /** The members that read a value of another member unknown at plan time: the gate holds the run under every gate but never. Absent when there are none. */
  held_by_unknown?: string[];
  /** Why the run failed before or in its apply, when no member's own error says it. */
  error?: string;
}

/** One root of a composed run (minor 38). */
export interface ReportComposedMember {
  root: string;
  /** Its address in the run, such as `module.network`. */
  module: string;
  /**
   * `tf-apply` only: how its part of the apply ended, from the binary's apply
   * events. applied: every change it planned completed. partial: some did.
   * failed: one errored and none completed. not-started: the apply stopped
   * before any of its changes began. no-changes: it planned none.
   */
  apply?: "applied" | "partial" | "failed" | "not-started" | "no-changes";
  /** `tf-apply` only: how many of its planned changes completed. */
  changes?: { done: number; planned: number };
  /**
   * `tf-apply` only: its state after the run. written: the run wrote it to
   * its backend, and `roots[].state` names the version. unchanged: the run
   * left it as it was pulled. not-written: the write failed.
   */
  state?: "written" | "unchanged" | "not-written";
  /** With not-written: where the state the run holds for it was kept, and whether its lock is still held. */
  kept?: string;
  lock_held?: boolean;
  /** Why the write failed, or the first error of its part of the apply. */
  error?: string;
}

/** `waves.compose` on a run (minor 38). */
export interface ReportCompose {
  /** The roots the change reaches plus the roots they read, followed upstream, sorted. */
  roots: string[];
  /** `waves.compose_max`. */
  max: number;
  /** The wave whose run composes them. Absent when the change applies in waves. */
  wave?: number;
  /** Why the change applies in waves: a kind, the root it is about when there is one, and a sentence. */
  fallback?: { kind: string; root?: string; reason: string };
}

/** A wave's plans against the pull request's preview of them (minor 25). */
export interface ReportWavePreview {
  pull_request: number;
  /** Each unit of the wave the note previewed. `differences` is absent when it plans as previewed. */
  units: { unit: string; differences?: string[] }[];
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
  /**
   * `held` (minor 30): another run's apply held a resource the wave changes, and the wave refuses rather than waits (the apply a comment starts).
   * `superseded` (minor 30): a push's wave found a newer push on its branch once it held its resources, and stood down for it.
   */
  reason: "approval" | "review" | "override" | "policy" | "held" | "superseded";
  /** The digest the approval, review or override was for. */
  approved?: string;
  /** Who wrote it, as the ledger or the review names them. */
  by?: string;
  /** The roots that planned differently since (every changing root, for a review), or the roots the policy denied, or those whose resources another run held. */
  roots: string[];
  /** With `held`, the run that held them, and its page (minor 30). */
  holder?: { run: string; url?: string };
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
  /** How many roots `totals` counts a change of: each root whose plan creates, updates, replaces, deletes or forgets a resource, less a root the policy refused (minor 35). */
  totals_roots?: number;
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
  /**
   * A `tf-plan` run's blast radius (minor 22): the roots whose plan changes
   * something, and every root of the repo that reads their state through
   * `terraform_remote_state` (in a Terragrunt repo, every unit that depends
   * on them through a `dependency` or `dependencies` block), followed
   * through. Absent when no root's plan changes anything, and on other
   * stages.
   */
  blast?: ReportBlast;
  /**
   * `waves.compose` (minor 38), on a `tf-plan` and on a `tf-apply` wave's
   * report, when the run's config turns it on: the roots it covers, and the
   * wave that composes them or why the change applies in waves.
   */
  compose?: ReportCompose;
}

/** A change's blast radius (minor 22). */
export interface ReportBlast {
  /** The roots whose plan changes a resource or an output. */
  roots: string[];
  /** Nearest first: each root that reads the state of a root in the radius. */
  downstream: ReportBlastRoot[];
  /**
   * The radius by resource (minor 31), when a root is downstream: each resource
   * a plan changes and the resources that depend on it, from the plans'
   * references and the outputs each root reads. Absent in a Terragrunt repo.
   */
  resources?: ReportBlastResource[];
}

/** A resource a plan changes, and what depends on it (minor 31). */
export interface ReportBlastResource {
  root: string;
  /** The changed resource instance's address. */
  address: string;
  /** Its change's actions, as the plan gives them. */
  actions: string[];
  /** Nearest first: its own root's resources, then each root's that reads an output the change reaches. */
  reaches: ReportBlastReach[];
}

/** A resource that depends on a changed one (minor 31). */
export interface ReportBlastReach {
  root: string;
  /** Its address in the root's configuration, with no instance key. */
  address: string;
  /**
   * Its distance from the changed resource (minor 36): 1 when it refers to
   * it, directly or through locals, variables and modules, and one more for
   * each resource in between and each hop from a root's output into a root
   * that reads it. A reader's resource that reads an output made from the
   * changed resource is 2.
   */
  depth: number;
  /** In another root: the output it reads, and the root that makes it. */
  through?: { root: string; output: string };
}

/** A root downstream of a change (minor 22). */
export interface ReportBlastRoot {
  root: string;
  /** The roots in the radius whose state it reads. */
  reads: string[];
  /** 1 when it reads a changed root's state itself, 2 when it reads such a reader's, and so on. */
  depth: number;
  /** The apply wave it is in. */
  wave?: number;
  /** Whether this run planned it. */
  planned: boolean;
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

/**
 * The roots a report failed, by path. A root's status is its plan's. A wave
 * whose apply failed says so in its state (minor 21) while its roots still
 * read planned, as SQL Yodeler's refused migration did on the demo
 * (behold#571); its roots are the ones that failed, since the report names
 * no root's apply. A provisional preview's failure is not the run's.
 */
export function failedRoots(report: Report): string[] {
  const planFailed = report.roots.filter((r) => r.status === "failed" && !r.terragrunt?.provisional).map((r) => r.path);
  if (planFailed.length > 0) return planFailed;
  const wave = report.run.stage === "tf-apply" ? report.waves[0] : undefined;
  return wave?.state === "failed" ? [...wave.roots] : [];
}
