/**
 * terragucci.yml: one schema for one repo or many.
 *
 * In a repo, the file sits at the root and its keys are that repo's settings.
 * In a control repo, `projects:` maps `<host>/<path>` keys to settings, and
 * `defaults:` applies to every project. A project's own keys override the
 * defaults, which override terragucci's built-in defaults. With no file at
 * all, the built-in defaults apply.
 *
 * The file may be YAML, JSON, or TypeScript. A `.ts` file is folded to its
 * value without running it (the data-host profile of typescript-as-data), so
 * a config that reads the environment is refused with its line.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseYAML } from "@intentius/chant/yaml";
import { parseReportsBucket, type BucketRef } from "./report/object-store";
import { checkGenerate, combineGenerate, type GenerateSettings } from "./generate-config";

export const BINARIES = ["terraform", "tofu", "choudoufu"] as const;
export const FORGES = ["github", "gitlab", "forgejo"] as const;
export const GATES = ["always", "on-destroy", "never"] as const;
/**
 * What counts as the approval of a waiting wave (`approval:`). `ledger` (the
 * default): any `chant approve` of the wave's set digest on chant/lifecycle,
 * signed or not. `pr-review`: also the merged pull request's approving review
 * of its head (on GitLab, an approval after its latest push), when the plans
 * have not moved since (./review.ts). `sealed`: only one sealed with a key the signers file at base
 * lists for its approver. Every mode binds the digest.
 */
export const APPROVALS = ["ledger", "pr-review", "sealed"] as const;
/** Every stage runs on the forge's CI. */
export const RUNTIMES = ["forge"] as const;
export const DEPENDENTS = ["follow", "plan"] as const;
export const POLICY_ENGINES = ["conftest", "opa"] as const;
export const POLICY_INPUTS = ["plan", "hcp"] as const;
/**
 * When a pull request takes its root locks (`locks:`). `apply` (the default):
 * when it applies before merge, or a writer comments `/terragucci lock`.
 * `plan`: from its first plan, through the `pr-lock` job (GitHub and Forgejo;
 * NO_GITLAB_PLAN_LOCKS), until it merges or closes, or a writer comments
 * `/terragucci unlock`.
 */
export const LOCKS = ["apply", "plan"] as const;
/** When a change applies: after it merges (default), or from its open pull request before it merges. */
export const APPLY_WHEN = ["merge", "pull-request"] as const;
/** With `apply.when: pull-request`, who merges once every wave applied: a person (default), or terragucci. */
export const APPLY_MERGE = ["manual", "auto"] as const;
/**
 * With `apply.when: pull-request`, what an open pull request needs before a
 * comment applies it: a reviewer's approval of its head (`approved`), a
 * forge that says it can merge (`mergeable`: no conflicts, and on GitHub no
 * branch protection blocking it), a head that contains the default branch
 * (`undiverged`), and every status and check on the head passed (`checks`).
 * All four by default.
 */
export const APPLY_REQUIRES = ["approved", "mergeable", "undiverged", "checks"] as const;

export type Binary = (typeof BINARIES)[number];
export type ForgeName = (typeof FORGES)[number];
export type Gate = (typeof GATES)[number];
export type Approval = (typeof APPROVALS)[number];

/**
 * `gitlab.token`: how a GitLab project keeps its forge token. `unprotected`
 * (the default): the plan job posts its note with the token at once, so a
 * merge request's code, which can rewrite the job, can use the token too.
 * `protected`: the token is a protected variable that no merge request or
 * branch pipeline sees, and the comments schedule's job posts the plan notes.
 */
export const TOKEN_PROTECTIONS = ["unprotected", "protected"] as const;
export type GitLabToken = (typeof TOKEN_PROTECTIONS)[number];
export type Runtime = (typeof RUNTIMES)[number];
export type Dependents = (typeof DEPENDENTS)[number];
export type PolicyEngine = (typeof POLICY_ENGINES)[number];
export type PolicyInput = (typeof POLICY_INPUTS)[number];
export type ApplyWhen = (typeof APPLY_WHEN)[number];
export type Locks = (typeof LOCKS)[number];
export type ApplyMerge = (typeof APPLY_MERGE)[number];
export type ApplyRequire = (typeof APPLY_REQUIRES)[number];

/** The stages a step runs before or after (`steps:`). `drift` is the drift job's refresh-only plan. */
export const STEP_STAGES = ["init", "plan", "apply", "drift"] as const;
export type StepStage = (typeof STEP_STAGES)[number];
/** What a step's non-zero exit does: fail the root (the default), or hold its wave for an approval. */
export const STEP_FAILURES = ["fail", "approve"] as const;
export type StepFailure = (typeof STEP_FAILURES)[number];
export const STEP_KEYS = ["name", "run", "before", "after", "roots", "on_failure"] as const;

/**
 * One entry of `steps:`. `run` is a shell command, run in the root's
 * directory. Exactly one of `before` and `after` names the stage. `roots`
 * are globs of the roots it runs for (every root when unset).
 * `on_failure: approve` turns a non-zero exit into a hold: the root's wave
 * waits for an approval of its set digest, whatever `gate` says. Only a step
 * that runs before the gate is decided can hold it: one before or after
 * init or plan.
 */
export interface StepSettings {
  run: string;
  name?: string;
  before?: StepStage;
  after?: StepStage;
  roots?: string[];
  on_failure?: StepFailure;
}

/**
 * `apply:`: when a change applies. `when: merge` (the default) applies the
 * default branch after a merge. `when: pull-request` applies an open pull
 * request's head on `/terragucci apply`, under the same waves and gates, and
 * the push after the merge plans and reports drift without applying.
 * `merge: auto` merges the pull request once every wave applied, in a job of
 * its own, with the token in the secret `merge_token_env` names when it is
 * set (required on Forgejo, whose job token cannot push to the default
 * branch). `requires` lists what an open pull request needs before it
 * applies (APPLY_REQUIRES, all by default). On every forge, for plain
 * roots and Terragrunt units alike. On GitLab a merge request note starts no
 * pipeline, so `when: pull-request` needs `comments:` (the schedule whose
 * job reads `/terragucci apply`) and `merge_token_env`, a variable whose
 * token may run pipelines on the default branch and merge there, with
 * `merge: manual` too (PR_APPLY_NEEDS_ON_GITLAB).
 */
export interface ApplySettings {
  when?: ApplyWhen;
  merge?: ApplyMerge;
  merge_token_env?: string;
  requires?: ApplyRequire[];
  /**
   * Minutes between runs of the resume job, which applies a waiting wave once
   * an approval of its digest is on chant/lifecycle (resume.ts). Off when
   * unset. 5 to 60.
   */
  resume?: number;
}

/**
 * Policy as code, off unless set. `tf-plan` runs the engine over each planned
 * root's plan JSON and fails the root on a denial. No response, agent or
 * comment can waive it.
 */
export interface PolicySettings {
  /** The engine. Default `conftest`, which terragucci installs on demand when it is not on the path. */
  engine?: PolicyEngine;
  /** The directory of Rego policy, relative to the repo root, or to the root of `source` when that is set. Default `policy`. */
  path?: string;
  /**
   * A shared policy repo, `git+https://<host>/<path>@<ref>`, read at that ref
   * instead of the repo's own directory. The ref is a tag, a branch or a
   * commit. Like the rest of the key, it is read at the base.
   */
  source?: string;
  /** The Rego package whose `deny`, `violation`, `deny_*` and `warn` rules count. conftest default: every namespace. opa default: `main`, or every package under `terraform.policies` with `input: hcp`. */
  namespace?: string;
  /** What `input` holds: `plan`, the bare plan JSON (default); `hcp`, `{plan, run}` as HCP Terraform's OPA policies read it. */
  input?: PolicyInput;
  /**
   * Who may override a denial: the forge identities or signers whose recorded
   * override (`terragucci override`) lets `tf-apply` apply one denied plan.
   * Read at base, like `approval:`. Unset, no override counts.
   */
  override?: string[];
}

/**
 * The jobs' cloud identities over the forge's OIDC token. `plan_role` and
 * `apply_role` are AWS roles; `gcp` and `azure` set those clouds, beside AWS
 * or instead of it.
 */
export interface OidcSettings {
  plan_role?: string;
  apply_role?: string;
  /** The AWS token's audience. Default `sts.amazonaws.com`. */
  audience?: string;
  /** GCP Workload Identity Federation: the provider's resource name and a service account per stage. */
  gcp?: { workload_identity_provider: string; plan_service_account: string; apply_service_account: string; /** Default `https://sts.googleapis.com/v1/token`; a regional endpoint such as `https://sts.europe-west3.rep.googleapis.com/v1/token`. */ token_url?: string };
  /** An Entra app registration or managed identity per stage, with a federated credential for the forge. */
  azure?: { tenant_id: string; subscription_id: string; plan_client_id: string; apply_client_id: string; /** The token's audience. Default `api://AzureADTokenExchange`; `api://AzureADTokenExchangeUSGov` for Azure US Government, `api://AzureADTokenExchangeChina` for Azure China. */ audience?: string };
}

/** A plan role and an apply role, for the units under one path. */
export interface RolePair {
  plan: string;
  apply: string;
}

/**
 * Terragrunt settings. Terragrunt mode is detected (`root.hcl`,
 * `terragrunt.hcl` or `terragrunt.stack.hcl`); this block only tunes it.
 */
export interface TerragruntSettings {
  /** The Terragrunt release the pipeline installs. Default: the one terragucci's image carries. */
  version?: string;
  /** Unit globs discovery leaves out, beside `catalog/**` and the module cache. */
  exclude?: string[];
  /** How many units one `run --all` runs at once. Default: from the state backend. */
  parallelism?: number;
  /** Units that depend on a changed unit: `follow` plans them in later waves, `plan` also previews them at pull-request time. */
  dependents?: Dependents;
  /**
   * Plan and apply roles by unit path glob, assumed over OIDC through a
   * generated auth-provider-cmd. A unit that sets its own `iam_role` keeps it.
   */
  credentials?: Record<string, RolePair>;
}

/**
 * Pipeline events and the responses each takes. The first mode is the
 * default and needs no model. `drift: attribute` also names who changed each drifted attribute (a known-writes
 * table, then the audit log, then a typed decision when `decide:` is set).
 */
export const RESPONSES = {
  plan: ["summary"],
  "wave-refused": ["diff", "off"],
  "apply-failed": ["triage", "off"],
  drift: ["pull-request", "attribute", "off"],
  tips: ["pull-request", "off"],
  fmt: ["commit", "off"],
  publish: ["notes", "off"],
  /** next-wave: with `rollouts:` set, init writes a job that runs `respond rollout` on that schedule, so a merged and applied wave's next one opens within one interval. off leaves the job out. */
  rollout: ["next-wave", "off"],
  "version-bump": ["off", "suggest"],
  /** terragucci#30: a typed decision flags a pull request whose description leaves out what its plan destroys or replaces. Needs `decide:`. */
  description: ["off", "check"],
} as const;
export type RespondEvent = keyof typeof RESPONSES;
export const AGENT_VIA = ["forge"] as const;

/** The services `decide:` can name; each speaks the Jev request and response shape. */
export const DECIDE_BACKENDS = ["laya", "von", "decider", "jev"] as const;
export type DecideBackend = (typeof DECIDE_BACKENDS)[number];
export const QUESTION_TYPES = ["noul", "choice", "score"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

/**
 * `decide:`: the typed-decision service the opt-in uses ask (terragucci#28).
 * With no `decide:`, every use runs its deterministic response.
 */
export interface DecideSettings {
  /** Which service answers: laya (the terragucci-decide image), von, decider or jev. */
  backend: DecideBackend;
  /** The service's base URL; `/v1/systemone` is appended. Required except for jev, which defaults to TypeSafe's. */
  url?: string;
  /** The pinned model version. Required except for laya, which defaults to the version terragucci-decide serves. */
  model?: string;
  /** The environment variable holding the service's bearer token. Required for jev. */
  token_env?: string;
  /** The probability an answer needs before a use acts on it, per question type, between 0 and 1. */
  thresholds?: Partial<Record<QuestionType, number>>;
}

/** `dashboards:` in terragucci.yml, as a map. `true` takes every default. */
export interface DashboardSettings {
  /** Where the files go, relative to the repo. Default `observability/terragucci`. */
  dir?: string;
  /** The uid of the Grafana datasource that reads the Prometheus holding the metrics. Default `prometheus`. */
  prometheus?: string;
  /** The uid of the Grafana datasource that reads Tempo. Default `tempo`. */
  tempo?: string;
  /** The Grafana folder the dashboards and Grafana-managed rules go in. Default `terragucci`. */
  folder?: string;
  /** Where Grafana's container finds the dashboard files. Default `/var/lib/grafana/dashboards/terragucci`. */
  path?: string;
  /** Alert when a project's drift is older than this. Default `1d`. */
  drift_age?: string;
  /** Alert when a wave has waited for its approval longer than this. Default `4h`. */
  wave_wait?: string;
  /** Alert when a project's drift run has not run for this long. Default `2d`. */
  schedule?: string;
}

export const DASHBOARD_KEYS = ["dir", "prometheus", "tempo", "folder", "path", "drift_age", "wave_wait", "schedule"] as const;
export const DASHBOARD_DURATION_KEYS = ["drift_age", "wave_wait", "schedule"] as const;

/**
 * `agent.comment`: the `/terragucci agent <ask>` pull request comment, off
 * unless set. The comment starts a job that runs a coding agent on the pull
 * request's head branch and pushes what it changes with `agent.token_env`'s
 * token. The job gets no cloud credentials: no `oidc` role. `true` takes every
 * default.
 */
export interface AgentCommentSettings {
  /** The agent's command line, run in the checkout with the prompt on stdin. Default: Claude Code in print mode with file tools only (AGENT_COMMAND in agent-comment.ts). */
  command?: string;
  /** The secret holding the model's API key, mapped into the agent's step alone. Default `ANTHROPIC_API_KEY`. */
  key_secret?: string;
  /** The most turns the agent takes, as `$TG_AGENT_MAX_TURNS`. Default 30. */
  max_turns?: number;
  /** Minutes before the agent's job is stopped. Default 30. */
  timeout?: number;
}

export const AGENT_COMMENT_KEYS = ["command", "key_secret", "max_turns", "timeout"] as const;

/**
 * `agent.drift`: when the drift job opens the drift issue, a job runs a coding
 * agent on the default branch with the drift report, and a second job opens a
 * pull request with what it changed, with `agent.token_env`'s token. The
 * agent's job holds no forge token and no cloud role. Its settings are
 * `agent.comment`'s (AgentCommentSettings); `true` takes every default.
 */
export const AGENT_DRIFT_KEYS = AGENT_COMMENT_KEYS;

/** Why `agent.drift` and `respond.drift: pull-request` do not go together. */
export const AGENT_DRIFT_RESPOND = "agent.drift opens the drift pull request itself, so the codified one would be a second; set respond.drift to attribute or off";

/**
 * `review`: a model reviews each pull request's intent against its plan
 * (review-agent.ts), off unless `agent` is true. It posts a note and never
 * approves; a `tf-apply` wave's policy reads its risk as `input.review`.
 */
export interface ReviewSettings {
  /** Turns the review on. */
  agent?: boolean;
  /** The command line, run with the prompt on stdin; it prints the review. Default: Claude Code in print mode with no tools (REVIEW_COMMAND in review-agent.ts). */
  command?: string;
  /** The secret holding the model's API key, mapped into the review command's step alone. Default `ANTHROPIC_API_KEY`. */
  key_secret?: string;
  /** The instructions file, read from the default branch. Default `.terragucci/review.md`. */
  instructions?: string;
  /** Minutes before the review job is stopped. Default 10. */
  timeout?: number;
}

export const REVIEW_KEYS = ["agent", "command", "key_secret", "instructions", "timeout"] as const;

/** The settings one project (or one repo) can carry. Every key is optional. */
export interface ProjectSettings {
  /** Globs of root directories. Detected when absent. */
  roots?: string[];
  /** The binary the pipeline runs. Detected when absent. */
  binary?: Binary;
  /**
   * The binary's version. Read from the roots' `required_version` when it pins one. As a map of root
   * glob to release, the version each root it matches runs (tofu and terraform, plain roots only).
   */
  version?: string | Record<string, string>;
  /** Each plain root's backend, provider and version files, which `terragucci generate` writes; see generate.ts. */
  generate?: GenerateSettings;
  /** The forge, for a host terragucci cannot name. */
  forge?: ForgeName;
  /** Where the project lives, for a forge not on https or the default port. */
  url?: string;
  /** When a wave waits for an approval. */
  gate?: Gate;
  /** What counts as a waiting wave's approval; see APPROVALS. Read from the config at base, never the applied commit's own. */
  approval?: Approval;
  /** When a change applies; see ApplySettings. */
  apply?: ApplySettings;
  /** When a pull request takes its root locks; see LOCKS. */
  locks?: Locks;
  /** `canary`: globs for the wave that applies first. `jobs`: the most jobs one wave's roots spread across (plain roots, GitHub and Forgejo). */
  waves?: { canary?: string[]; jobs?: number };
  /** A cron schedule for tf-drift, or false. */
  drift?: string | false;
  /**
   * The command that writes the roots before any job reads them, such as
   * CDK Terrain's `npx cdktn synth`. Run from the repo's root, in the check,
   * plan, apply and drift jobs, on their own checkout.
   */
  synth?: string;
  /**
   * Commands run before and after a root's init, plan, apply and drift, in
   * the stage's own job, on its checkout, with its environment less the forge
   * tokens. Read from terragucci.yml at base, never from the change under
   * review (./steps.ts).
   */
  steps?: StepSettings[];
  /**
   * The image every job runs in, in place of terragucci's: one built FROM
   * the terragucci image for the binary, so the job still has terragucci and
   * the binary, plus what the steps need.
   */
  image?: string;
  /**
   * Notifications: the names of the secrets holding a Slack or Teams
   * incoming webhook, and a generic webhook's address with the key that
   * signs its body. An apply job whose wave waits, is refused or fails posts
   * to each (notify.ts), and the drift job posts drift to Slack and Teams.
   * `relay` names the customer's relay (relay.ts): a waiting wave's Slack
   * message gets Approve and Decline buttons, its Teams card the reply
   * `@<relay> approve wave-<k> <digest>`.
   */
  notify?: { slack?: string; teams?: string; webhook?: string; webhook_key?: string; relay?: string };
  /**
   * Cost estimates per root in the plan note: Infracost on the customer's
   * own key (`key_secret`, default INFRACOST_API_KEY), or a `command` that
   * prints Infracost's JSON (report/cost.ts).
   */
  cost?: CostSettings;
  /**
   * GitLab only: the cron of the comments schedule, or false. The pipeline
   * gets a `comments` job that reads new merge request notes on that
   * schedule (comment-gitlab.ts), since GitLab starts no pipeline for a note.
   */
  comments?: string | false;
  /**
   * A cron schedule, or false: init writes a job that runs `terragucci respond
   * rollout --mode apply` on it, which opens the next wave of every rollout in
   * flight once the last one merged and applied. A single repo's key: a
   * control repo's rollout spans its projects, so it is continued from the
   * control repo. `respond.rollout: off` leaves the job out.
   */
  rollouts?: string | false;
  /** GitLab only: how the project keeps its forge token; see TOKEN_PROTECTIONS. */
  gitlab?: { token?: GitLabToken };
  runtime?: Runtime;
  /**
   * A bucket for plan reports: `s3://<bucket>`, `gs://<bucket>` or
   * `az://<account>/<container>`. `url` is the address that serves the bucket's
   * objects to a browser (a static site, a CDN, the store's public endpoint);
   * with it, the note, the index and the dashboards link the bucket's copy.
   * `role` is an AWS role the job assumes with its OIDC token to write the
   * reports, apart from the job's own role.
   */
  reports?: { bucket: string; endpoint?: string; prefix?: string; url?: string; role?: string };
  /** The environment variable holding the forge token. */
  token_env?: string;
  /** Environment variables every job gets. Values only, never secrets. */
  env?: Record<string, string>;
  /**
   * The secret holding `OTEL_EXPORTER_OTLP_HEADERS`, such as a collector's API
   * key, and `trace_url`: a link to a run's trace with `{trace_id}` in it
   * (Grafana's Explore, Tempo, Jaeger), which the report links.
   */
  telemetry?: { headers_secret?: string; trace_url?: string };
  tips?: boolean;
  modules?: ModulesSettings;
  /**
   * Cloud identities the pipeline takes over OIDC, so no long-lived keys sit in CI.
   * Plan runs pull-request code and gets the read-only identity; apply gets the
   * write one. The two must differ, on every cloud set.
   */
  oidc?: OidcSettings;
  /** How many roots of one dependency layer plan at once. Default: from the state backend. */
  parallelism?: number;
  /** Terragrunt settings, for a repo terragucci finds Terragrunt in. */
  terragrunt?: TerragruntSettings;
  /** Opt-in policy checks over each plan; see PolicySettings. */
  policy?: PolicySettings;
  /**
   * `atlantis plan` and `atlantis apply` comments read as `/terragucci plan`
   * and `/terragucci apply`. Off by default. The alias changes the words
   * only: the same checks decide (comment.ts).
   */
  atlantis_comments?: boolean;
  /** The response to each pipeline event; see RESPONSES. */
  respond?: Partial<Record<RespondEvent, string>>;
  /**
   * The agent integration behind `agent.comment` and `agent.drift`. Its token
   * can comment, push a branch and open a pull request; the agent itself never
   * holds it.
   */
  agent?: { via: (typeof AGENT_VIA)[number]; token_env: string; comment?: boolean | AgentCommentSettings; drift?: boolean | AgentCommentSettings };
  /** The AI review of a pull request's intent against its plan; see ReviewSettings. Off when absent. */
  review?: ReviewSettings;
  /** The typed-decision service; see DecideSettings. Off when absent. A project's `decide` replaces the defaults' whole. */
  decide?: DecideSettings;
  /** The AWS region whose CloudTrail drift attribution reads. Default: the region the aws CLI already uses. */
  audit_region?: string;
  /** Dashboards and alert rules written next to the pipeline. Off unless set. */
  dashboards?: boolean | DashboardSettings;
}

/** The whole file: one repo's settings, or `defaults` and `projects` for many repos. */
export interface TerragucciConfig extends ProjectSettings {
  defaults?: ProjectSettings;
  projects?: Record<string, ProjectSettings>;
}

/** The response a project takes to an event: its setting, or the event's default. */
export function responseTo(settings: ProjectSettings, event: RespondEvent): string {
  return settings.respond?.[event] ?? RESPONSES[event][0];
}

/** `cost: true`, or the secret holding the estimator's key and the command to run instead of Infracost. */
export type CostSettings = true | { key_secret?: string; command?: string; approve_above?: number };

/** The secret Infracost's key is read from when `cost.key_secret` is unset; the job gets it as this variable too. */
export const COST_KEY_SECRET = "INFRACOST_API_KEY";

/** Settings with terragucci's defaults filled in. Detection fills `roots`, `binary` and `forge` later. */
export interface ResolvedSettings extends ProjectSettings {
  gate: Gate;
  drift: string | false;
  runtime: Runtime;
  tips: boolean;
  env: Record<string, string>;
}

export const BUILT_IN: ResolvedSettings = {
  gate: "on-destroy",
  drift: false,
  runtime: "forge",
  tips: true,
  env: {},
};

/**
 * The keys a project's jobs read from the project's own terragucci.yml: the
 * plan and apply stages, `respond`, `approve` and `check-policy` read them
 * there, and no pipeline flag carries them. A control repo's `reconcile`
 * writes each one its settings give the project, other than the built-in
 * value, into that file (init.ts). Every other key reaches a project through
 * the pipeline init writes (flags, the job's environment, its steps and
 * files, such as `apply.resume` and `notify.webhook`). `url` is the project's
 * own clone URL and `rollouts` belongs to a single repo, so `defaults`
 * refuses both.
 */
export const PROJECT_FILE_KEYS = [
  "policy",
  "reports",
  "approval",
  "gate",
  "roots",
  "waves",
  "parallelism",
  "synth",
  "steps",
  "drift",
  "cost",
  "tips",
  "runtime",
  "telemetry",
  "respond",
  "review",
  "decide",
  "audit_region",
  "modules",
  "terragrunt",
  "token_env",
  "generate",
] as const satisfies ReadonlyArray<keyof ProjectSettings>;

export class ConfigError extends Error {
  /** Every problem found, when the error is a validation failure. */
  readonly problems?: string[];
  constructor(message: string, problems?: string[]) {
    super(message);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** A `--mode` value: dry-run or apply. */
export function checkMode(mode: string): "dry-run" | "apply" {
  if (mode !== "dry-run" && mode !== "apply") throw new ConfigError("--mode must be dry-run or apply");
  return mode;
}

export const CONFIG_NAMES = ["terragucci.yml", "terragucci.yaml", "terragucci.json", "terragucci.ts"];

/** The config file in `dir`, or undefined. Two of them is an error. */
export function findConfig(dir: string): string | undefined {
  const found = CONFIG_NAMES.filter((n) => existsSync(join(dir, n)));
  if (found.length > 1) throw new ConfigError(`${dir} has ${found.join(" and ")}; keep one`);
  return found.length ? join(dir, found[0]) : undefined;
}

// ── validation ───────────────────────────────────────────────────────────────

const SETTING_KEYS = new Set([
  "roots", "binary", "version", "forge", "url", "gate", "approval", "apply", "locks", "waves", "drift", "comments", "gitlab", "runtime",
  "reports", "token_env", "env", "telemetry", "tips", "modules", "oidc", "parallelism", "terragrunt", "policy", "respond", "agent", "decide", "audit_region", "dashboards", "synth", "steps", "image", "notify", "cost", "rollouts", "atlantis_comments", "generate", "review",
]);

const TERRAGRUNT_KEYS = ["version", "exclude", "parallelism", "dependents", "credentials"];

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function oneOf(v: unknown, allowed: readonly string[], where: string, problems: string[]): void {
  if (v !== undefined && !allowed.includes(v as string)) {
    problems.push(`${where} is ${JSON.stringify(v)}; use one of ${allowed.join(", ")}`);
  }
}

function stringList(v: unknown, where: string, problems: string[]): void {
  if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) {
    problems.push(`${where} must be a list of strings`);
  }
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

/** `version`: one release for the repo, or, in a repo's own file, a map of root glob to the release those roots run. */
function checkVersion(v: unknown, binary: unknown, where: string, problems: string[]): void {
  if (v === undefined || typeof v === "string") return;
  if (!isObject(v)) {
    problems.push(`${where}.version must be a release version, or a map of root glob to release version`);
    return;
  }
  if (where !== "config") {
    problems.push(`${where}.version: a version per root glob goes in the project's own terragucci.yml, which its jobs read; here, give one release version`);
    return;
  }
  if (binary === "choudoufu") problems.push(`${where}.version: choudoufu runs one release for every root; give one release version`);
  for (const [glob, release] of Object.entries(v)) {
    if (typeof release !== "string" || !RELEASE_VERSION.test(release)) {
      problems.push(`${where}.version["${glob}"] must be a release version such as 1.10.6, quoted when YAML would read it as a number`);
    }
  }
}

function checkSettings(s: unknown, where: string, problems: string[]): void {
  if (!isObject(s)) {
    problems.push(`${where} must be a map of settings`);
    return;
  }
  for (const k of Object.keys(s)) {
    if (!SETTING_KEYS.has(k)) problems.push(`${where}.${k} is not a setting (settings: ${[...SETTING_KEYS].join(", ")})`);
  }
  stringList(s.roots, `${where}.roots`, problems);
  oneOf(s.binary, BINARIES, `${where}.binary`, problems);
  oneOf(s.forge, FORGES, `${where}.forge`, problems);
  oneOf(s.gate, GATES, `${where}.gate`, problems);
  oneOf(s.approval, APPROVALS, `${where}.approval`, problems);
  if (s.apply !== undefined) checkApply(s.apply, `${where}.apply`, problems, s.forge);
  if (s.forge === "gitlab") problems.push(...gitlabPrApplyProblems(s, where));
  oneOf(s.locks, LOCKS, `${where}.locks`, problems);
  if (s.forge === "gitlab" && s.locks === "plan") problems.push(`${where}.locks: ${NO_GITLAB_PLAN_LOCKS}`);
  if (s.runtime === "fountain") problems.push(`${where}.runtime: fountain is not supported; every stage runs on the forge's CI, so remove runtime`);
  else oneOf(s.runtime, RUNTIMES, `${where}.runtime`, problems);
  for (const k of ["url", "token_env"] as const) {
    if (s[k] !== undefined && typeof s[k] !== "string") problems.push(`${where}.${k} must be a string`);
  }
  checkVersion(s.version, s.binary, where, problems);
  checkGenerate(s.generate, `${where}.generate`, problems, s.terragrunt);
  if (s.audit_region !== undefined && !(typeof s.audit_region === "string" && /^[a-z]{2}(-[a-z]+)+-\d+$/.test(s.audit_region))) {
    problems.push(`${where}.audit_region must be an AWS region, such as us-east-1`);
  }
  if (s.notify !== undefined) {
    const n = s.notify;
    const keys = ["slack", "teams", "webhook", "webhook_key", "relay"];
    if (!isObject(n) || Object.keys(n).length === 0) problems.push(`${where}.notify must be a map naming the secret of a webhook (settings: ${keys.join(", ")})`);
    else {
      for (const [k, v] of Object.entries(n)) {
        if (!keys.includes(k)) problems.push(`${where}.notify.${k} is not a setting (settings: ${keys.join(", ")})`);
        else if (k === "relay") {
          // The relay's name, as Teams shows its outgoing webhook: not a secret.
          if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(v)) problems.push(`${where}.notify.relay must name your relay as your Teams outgoing webhook is named, such as terragucci`);
          else if (n.slack === undefined && n.teams === undefined) problems.push(`${where}.notify.relay needs notify.slack or notify.teams: the buttons go on their messages`);
        }
        else if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) problems.push(`${where}.notify.${k} must name the secret that holds the ${k === "webhook_key" ? "key that signs the webhook's body, such as WEBHOOK_KEY; never the key" : `webhook, such as ${k.toUpperCase()}_WEBHOOK_URL; never the address`} itself`);
      }
      // A generic webhook is always signed, so its receiver can tell terragucci's posts from anyone's.
      if ((n.webhook === undefined) !== (n.webhook_key === undefined)) problems.push(`${where}.notify.webhook and notify.webhook_key go together: the key signs every body posted to the webhook`);
    }
  }
  if (s.cost !== undefined && s.cost !== true) {
    if (!isObject(s.cost)) problems.push(`${where}.cost must be true or a map (settings: key_secret, command, approve_above)`);
    else {
      for (const k of Object.keys(s.cost)) if (k !== "key_secret" && k !== "command" && k !== "approve_above") problems.push(`${where}.cost.${k} is not a setting (settings: key_secret, command, approve_above)`);
      if (s.cost.approve_above !== undefined && !(typeof s.cost.approve_above === "number" && Number.isFinite(s.cost.approve_above) && s.cost.approve_above >= 0)) problems.push(`${where}.cost.approve_above must be an amount of 0 or more, in the estimator's currency a month, such as 100`);
      if (s.cost.key_secret !== undefined && !(typeof s.cost.key_secret === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.cost.key_secret))) problems.push(`${where}.cost.key_secret must name the secret that holds the estimator's key, such as INFRACOST_API_KEY`);
      if (s.cost.command !== undefined && !(typeof s.cost.command === "string" && s.cost.command.trim() !== "")) problems.push(`${where}.cost.command must be a command that prints Infracost's JSON`);
    }
  }
  if (s.atlantis_comments !== undefined && typeof s.atlantis_comments !== "boolean") problems.push(`${where}.atlantis_comments must be true or false`);
  if (s.synth !== undefined && !(typeof s.synth === "string" && s.synth.trim() !== "")) {
    problems.push(`${where}.synth must be the command that writes the roots, such as npx cdktn synth`);
  }
  if (typeof s.synth === "string" && s.synth.trim() !== "") problems.push(...synthProblems(s as ProjectSettings, where));
  if (s.steps !== undefined) checkSteps(s.steps, `${where}.steps`, problems);
  if (s.image !== undefined && !(typeof s.image === "string" && /^[^\s]+$/.test(s.image))) {
    problems.push(`${where}.image must be an image reference, such as registry.example.com/infra/terragucci-tofu:1.2.3, built FROM the terragucci image for the binary`);
  }
  if (s.drift !== undefined && s.drift !== false && typeof s.drift !== "string") {
    problems.push(`${where}.drift must be a cron schedule or false`);
  }
  if (s.comments !== undefined && s.comments !== false && typeof s.comments !== "string") {
    problems.push(`${where}.comments must be a cron schedule or false`);
  }
  if (s.comments && s.forge !== undefined && s.forge !== "gitlab") problems.push(`${where}.comments: ${COMMENTS_GITLAB_ONLY}`);
  if (s.rollouts !== undefined && s.rollouts !== false && !(typeof s.rollouts === "string" && s.rollouts.trim() !== "")) {
    problems.push(`${where}.rollouts must be a cron schedule or false`);
  }
  if (s.gitlab !== undefined) {
    if (!isObject(s.gitlab)) problems.push(`${where}.gitlab must be a map (settings: token)`);
    else {
      for (const k of Object.keys(s.gitlab)) if (k !== "token") problems.push(`${where}.gitlab.${k} is not a setting (settings: token)`);
      oneOf(s.gitlab.token, TOKEN_PROTECTIONS, `${where}.gitlab.token`, problems);
    }
    if (s.forge !== undefined && s.forge !== "gitlab") problems.push(`${where}.gitlab is for GitLab projects; leave it unset on ${String(s.forge)}`);
  }
  if (s.tips !== undefined && typeof s.tips !== "boolean") problems.push(`${where}.tips must be true or false`);
  if (s.waves !== undefined) {
    if (!isObject(s.waves)) problems.push(`${where}.waves must be a map`);
    else {
      stringList(s.waves.canary, `${where}.waves.canary`, problems);
      const jobs = s.waves.jobs;
      if (jobs !== undefined && !(Number.isInteger(jobs) && (jobs as number) >= 1)) problems.push(`${where}.waves.jobs must be a whole number of 1 or more`);
      else if (typeof jobs === "number" && jobs > 1) {
        if (s.forge === "gitlab") problems.push(`${where}.waves.jobs: ${WAVE_JOBS_NOT_GITLAB}`);
        if (isObject(s.apply) && s.apply.when === "pull-request") problems.push(`${where}.waves.jobs: ${WAVE_JOBS_NOT_PR_APPLY}`);
        if (s.terragrunt !== undefined) problems.push(`${where}.waves.jobs: ${WAVE_JOBS_NOT_TERRAGRUNT}`);
      }
    }
  }
  if (s.env !== undefined) {
    if (!isObject(s.env) || !Object.values(s.env).every((x) => typeof x === "string")) {
      problems.push(`${where}.env must map names to string values`);
    }
  }
  if (s.telemetry !== undefined) {
    const t = s.telemetry;
    if (!isObject(t)) problems.push(`${where}.telemetry must be a map (settings: headers_secret, trace_url)`);
    else {
      for (const k of Object.keys(t)) if (k !== "headers_secret" && k !== "trace_url") problems.push(`${where}.telemetry.${k} is not a setting (settings: headers_secret, trace_url)`);
      if (t.headers_secret === undefined && t.trace_url === undefined) problems.push(`${where}.telemetry must set headers_secret, trace_url or both`);
      if (t.headers_secret !== undefined && (typeof t.headers_secret !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.headers_secret))) {
        problems.push(`${where}.telemetry.headers_secret must name the secret holding the OTLP headers, such as OTLP_HEADERS`);
      }
      if (t.trace_url !== undefined && !(typeof t.trace_url === "string" && /^https?:\/\/[^\s]+$/.test(t.trace_url) && t.trace_url.includes("{trace_id}"))) {
        problems.push(`${where}.telemetry.trace_url must be an http(s) URL with {trace_id} in it, such as https://grafana.example/explore?left=...{trace_id}...`);
      }
    }
  }
  if (s.reports !== undefined) {
    if (!(isObject(s.reports) && typeof s.reports.bucket === "string")) problems.push(`${where}.reports must name a bucket`);
    else if (s.reports.url !== undefined && !(typeof s.reports.url === "string" && /^https?:\/\/[^\s?#]+$/.test(s.reports.url))) {
      problems.push(`${where}.reports.url must be the http(s) address that serves the bucket, such as https://reports.example.com`);
    }
    let store: BucketRef | undefined;
    if (isObject(s.reports) && typeof s.reports.bucket === "string") {
      try {
        store = parseReportsBucket(s.reports.bucket);
      } catch (e) {
        problems.push(`${where}.${(e as Error).message}`);
      }
    }
    if (isObject(s.reports) && s.reports.role !== undefined) {
      if (store && store.kind !== "s3") problems.push(`${where}.reports.role is an AWS role, and ${s.reports.bucket} is not an S3 bucket: the job writes it with its own oidc identity`);
      else if (typeof s.reports.role !== "string" || !/^arn:aws[\w-]*:iam::\d{12}:role\/\S+$/.test(s.reports.role)) problems.push(`${where}.reports.role must be an AWS role ARN, such as arn:aws:iam::123456789012:role/terragucci-reports`);
      else if (isObject(s.oidc) && (s.reports.role === s.oidc.plan_role || s.reports.role === s.oidc.apply_role)) {
        problems.push(`${where}.reports.role is a job's own role; give reports a role of its own that can write only under the bucket's prefix`);
      }
    }
  }
  if (s.oidc !== undefined) checkOidc(s.oidc, `${where}.oidc`, problems);
  if (s.parallelism !== undefined && !(Number.isInteger(s.parallelism) && (s.parallelism as number) >= 1)) {
    problems.push(`${where}.parallelism must be a whole number of 1 or more`);
  }
  if (s.terragrunt !== undefined) checkTerragrunt(s.terragrunt, `${where}.terragrunt`, problems);
  if (s.policy !== undefined) checkPolicy(s.policy, `${where}.policy`, problems);
  if (s.respond !== undefined) {
    if (!isObject(s.respond)) problems.push(`${where}.respond must map events to responses`);
    else {
      for (const [event, mode] of Object.entries(s.respond)) {
        const modes = (RESPONSES as Record<string, readonly string[]>)[event];
        if (event === "question") problems.push(`${where}.respond.question is not supported; remove it`);
        else if (!modes) problems.push(`${where}.respond.${event} is not an event (events: ${Object.keys(RESPONSES).join(", ")})`);
        else if (mode === "agent") problems.push(`${where}.respond.${event}: agent is not supported; remove it, and ${event} takes its default response, ${modes[0]}`);
        else oneOf(mode, modes, `${where}.respond.${event}`, problems);
      }
    }
  }
  if (s.agent !== undefined) {
    const a = s.agent;
    if (!isObject(a)) problems.push(`${where}.agent must be a map with via and token_env`);
    else {
      for (const k of Object.keys(a)) if (!["via", "token_env", "comment", "drift"].includes(k)) problems.push(`${where}.agent.${k} is not a setting (settings: via, token_env, comment, drift)`);
      if (a.via === undefined) problems.push(`${where}.agent.via is missing; use forge`);
      else if (a.via === "fountain") problems.push(`${where}.agent.via: fountain is not supported; the agent runs in a forge job, so use forge`);
      else oneOf(a.via, AGENT_VIA, `${where}.agent.via`, problems);
      if (typeof a.token_env !== "string" || a.token_env === "") problems.push(`${where}.agent.token_env must name the variable holding the agent's forge token`);
      if (a.comment !== undefined) checkAgentComment(a.comment, a.token_env, `${where}.agent.comment`, problems);
      if (a.drift !== undefined) {
        checkAgentComment(a.drift, a.token_env, `${where}.agent.drift`, problems);
        // A control repo's defaults and projects are checked apart; init checks the merged settings (render.ts).
        if (a.drift !== false && where === "config") {
          if (!s.drift) problems.push(`${where}.agent.drift runs when the drift job opens the drift issue; set drift to a cron schedule`);
          else if (responseTo(s as ProjectSettings, "drift") === "pull-request") problems.push(`${where}.respond.drift: ${AGENT_DRIFT_RESPOND}`);
        }
      }
    }
  }
  if (s.review !== undefined) checkReview(s.review, `${where}.review`, problems);
  if (s.decide !== undefined) checkDecide(s.decide, `${where}.decide`, problems);
  if (s.dashboards !== undefined) checkDashboards(s.dashboards, `${where}.dashboards`, problems);
  if (s.modules !== undefined) {
    if (!isObject(s.modules)) problems.push(`${where}.modules must be a map`);
    else checkModules(s.modules as Record<string, unknown>, `${where}.modules`, problems);
  }
}

function checkSteps(v: unknown, where: string, problems: string[]): void {
  if (!Array.isArray(v)) {
    problems.push(`${where} must be a list of steps, each with run and before or after`);
    return;
  }
  v.forEach((step, i) => {
    const at = `${where}[${i}]`;
    if (!isObject(step)) return void problems.push(`${at} must be a map with run and before or after`);
    for (const k of Object.keys(step)) if (!(STEP_KEYS as readonly string[]).includes(k)) problems.push(`${at}.${k} is not a setting (settings: ${STEP_KEYS.join(", ")})`);
    if (!(typeof step.run === "string" && step.run.trim() !== "")) problems.push(`${at}.run must be the command the step runs`);
    if (step.name !== undefined && !(typeof step.name === "string" && step.name.trim() !== "")) problems.push(`${at}.name must be a string`);
    if ((step.before === undefined) === (step.after === undefined)) problems.push(`${at} needs one of before or after, naming ${STEP_STAGES.join(", ")}`);
    oneOf(step.before, STEP_STAGES, `${at}.before`, problems);
    oneOf(step.after, STEP_STAGES, `${at}.after`, problems);
    stringList(step.roots, `${at}.roots`, problems);
    oneOf(step.on_failure, STEP_FAILURES, `${at}.on_failure`, problems);
    const stage = step.before ?? step.after;
    if (step.on_failure === "approve" && (stage === "apply" || stage === "drift")) {
      problems.push(`${at}.on_failure: approve holds the wave at its gate, which is decided after the plans and before any apply; give it a step before or after init or plan`);
    }
  });
}

const MODULES_KEYS = new Set(["path", "publish", "attest", "require", "trusted"]);

function checkModules(m: Record<string, unknown>, where: string, problems: string[]): void {
  for (const k of Object.keys(m)) if (!MODULES_KEYS.has(k)) problems.push(`${where}.${k} is not a setting; use ${[...MODULES_KEYS].join(", ")}`);
  if (m.path !== undefined && typeof m.path !== "string") problems.push(`${where}.path must be a glob`);
  const targets = Array.isArray(m.publish) ? m.publish : m.publish === undefined ? [] : [m.publish];
  for (const t of targets) {
    if (typeof t !== "string" || !(t === "git-tags" || /^oci:\/\/[^/]+\/.+/.test(t))) {
      problems.push(`${where}.publish is ${JSON.stringify(t)}; use an oci:// registry address or git-tags`);
    }
  }
  if (m.attest !== undefined) {
    // true reads the public key at cosign.pub.
    if (isObject(m.attest)) {
      for (const k of Object.keys(m.attest)) if (k !== "key") problems.push(`${where}.attest.${k} is not a setting; use key`);
      const key = m.attest.key;
      if (key !== undefined && (typeof key !== "string" || key === "")) problems.push(`${where}.attest.key must be the path of the public key, such as cosign.pub`);
    } else if (typeof m.attest !== "boolean") problems.push(`${where}.attest must be true or a map with key`);
    if (m.attest !== false && m.publish === undefined) problems.push(`${where}.attest signs what publish writes, so set ${where}.publish too`);
  }
  if (m.trusted !== undefined) {
    if (!Array.isArray(m.trusted)) problems.push(`${where}.trusted must be a list of sources, each with source, key and ledger`);
    else {
      m.trusted.forEach((t, i) => {
        const at = `${where}.trusted[${i}]`;
        if (!isObject(t)) return void problems.push(`${at} must be a map with source, key and ledger`);
        for (const k of Object.keys(t)) if (!["source", "key", "ledger"].includes(k)) problems.push(`${at}.${k} is not a setting; use source, key, ledger`);
        if (typeof t.source !== "string" || !/^(oci:\/\/[^/]+\/.+|(git::)?(https?|ssh):\/\/.+)$/.test(t.source)) problems.push(`${at}.source must be an oci:// prefix or a git URL, as the roots' module sources begin`);
        if (typeof t.key !== "string" || t.key === "") problems.push(`${at}.key must be the path of the publisher's cosign public key`);
        if (typeof t.ledger !== "string" || !/^(https?|ssh|file):\/\/.+/.test(t.ledger)) problems.push(`${at}.ledger must be the URL of the git repository whose chant/lifecycle branch holds the release ledger`);
      });
    }
  }
  if (m.require !== undefined) {
    if (m.require !== "attested") problems.push(`${where}.require is ${JSON.stringify(m.require)}; the one setting is attested`);
    else if (!m.attest && !(Array.isArray(m.trusted) && m.trusted.length > 0)) {
      problems.push(`${where}.require: attested checks the releases this repo attests and the sources ${where}.trusted lists; set ${where}.attest or ${where}.trusted`);
    }
  }
}

/** A publisher in another repo whose releases `modules.require: attested` checks. */
export interface TrustedModuleSource {
  /** How the roots' module sources begin: an `oci://` prefix, or the publisher's git URL with or without `git::`. */
  source: string;
  /** The publisher's cosign public key, a path in this repo. */
  key: string;
  /** The git repository whose `chant/lifecycle` branch holds the publisher's release ledger. */
  ledger: string;
}

export interface ModulesSettings {
  path?: string;
  publish?: string | string[];
  /** Sign each release, write its provenance and SBOM, and record it in the release ledger. `true` reads the key at cosign.pub. */
  attest?: boolean | { key?: string };
  /** `attested`: tf-check and tf-plan refuse a root that pins a release of a checked source unless it verifies. */
  require?: "attested";
  /** Publishers in other repos whose releases `require` checks. */
  trusted?: TrustedModuleSource[];
}

/** Why a control repo's projects take no `rollouts` job: each project's pipeline sees only its own roots. */
/** Why `waves.jobs` is refused on GitLab: a split wave's shares hold one apply lock between them on GitHub and Forgejo, and GitLab's apply jobs take a resource group one job at a time. */
export const WAVE_JOBS_NOT_GITLAB = "a wave splits across jobs on GitHub and Forgejo; GitLab runs one apply job at a time in its resource group, so leave waves.jobs unset there";
export const WAVE_JOBS_NOT_PR_APPLY = "apply.when: pull-request applies every wave in the one job a comment starts, so a wave has no jobs to spread across; leave waves.jobs unset";
export const WAVE_JOBS_NOT_TERRAGRUNT = "a Terragrunt wave applies its units with one run --all in one job; waves.jobs splits a wave of plain roots, so leave it unset";
export const ROLLOUTS_SINGLE_REPO = "a control repo's rollout plans its waves across every project, and a project's pipeline sees only its own roots; leave rollouts unset and run terragucci respond rollout --mode apply on a schedule in the control repo";

/**
 * What `synth` rules out, each because it would edit the roots the synth
 * command writes. Those files are output, not in git: a change to them is
 * lost at the next synth, and their source is the app's code (a CDK Terrain
 * app's TypeScript), which terragucci does not edit.
 */
export const SYNTH_DRIFT_PR_SHORT = "synth writes the roots, so a live value belongs in the app that writes them, which terragucci does not edit";
export const SYNTH_DRIFT_PR = "the drift pull request writes each live value into a root's own files, and with synth the command writes those files and git does not hold them, so the value belongs in the app that writes them, which terragucci does not edit; set respond.drift to attribute, which names who changed each value in the drift issue, or to off";
export const SYNTH_ROLLOUTS = "a rollout moves a pin in each root's files or its lock file, and with synth the command writes those files and git does not hold them, so the pin is in the app that writes them; move it there";

/** The problems `synth` finds in one project's settings: a drift schedule whose response is the pull request, and a rollouts schedule. */
export function synthProblems(s: ProjectSettings, where: string): string[] {
  if (!s.synth) return [];
  const out: string[] = [];
  if (s.drift && responseTo(s, "drift") === "pull-request") out.push(`${where}.respond.drift: ${SYNTH_DRIFT_PR}`);
  if (s.rollouts && responseTo(s, "rollout") !== "off") out.push(`${where}.rollouts: ${SYNTH_ROLLOUTS}, and leave rollouts unset`);
  return out;
}

/** Why `comments` is GitLab's alone: the other forges start a job for each comment. */
export const COMMENTS_GITLAB_ONLY = "comments is for GitLab, which starts no pipeline for a merge request note; GitHub and Forgejo start the comment jobs from the comment itself, so leave comments unset";

/**
 * What GitLab's apply before merge needs. A merge request's own pipeline
 * runs its own `.gitlab-ci.yml`, so the apply runs in a pipeline of the
 * default branch, which the comments job starts on a `/terragucci apply`
 * note: so `comments:` must be set, and `apply.merge_token_env` must name the
 * variable whose token may start a pipeline on the protected default branch
 * (and, with `merge: auto`, merge there).
 */
export const PR_APPLY_NEEDS_ON_GITLAB = {
  comments: "pull-request on GitLab needs comments: <cron>: a merge request note starts no pipeline, so the comments schedule's job is what reads `/terragucci apply`",
  token: "pull-request on GitLab needs apply.merge_token_env: the comments job starts the apply pipeline on the default branch with that variable's token, which must be allowed to merge there, so name a protected, masked variable holding one",
};

/**
 * Why `gitlab.token: protected` needs `comments:`: no merge request pipeline
 * then holds a token that may post the plan note, so the comments schedule's
 * job posts it.
 */
export const PROTECTED_TOKEN_NEEDS_COMMENTS = "protected needs comments: <cron>: a merge request's pipeline then holds no token that may post the plan note, so the comments schedule's job posts it";

/** The problems with a GitLab project's `apply.when: pull-request` and `gitlab.token: protected`, when it has any. */
export function gitlabPrApplyProblems(s: Record<string, unknown>, where: string): string[] {
  const token = isObject(s.gitlab) && s.gitlab.token === "protected" && !s.comments ? [`${where}.gitlab.token: ${PROTECTED_TOKEN_NEEDS_COMMENTS}`] : [];
  const a = s.apply;
  if (!isObject(a) || a.when !== "pull-request") return token;
  return [
    ...token,
    ...(s.comments ? [] : [`${where}.apply.when: ${PR_APPLY_NEEDS_ON_GITLAB.comments}`]),
    ...(a.merge_token_env ? [] : [`${where}.apply.when: ${PR_APPLY_NEEDS_ON_GITLAB.token}`]),
  ];
}

/** Why GitLab has no plan-time locks: no merge request event runs a pipeline from the default branch. */
export const NO_GITLAB_PLAN_LOCKS = "plan is not supported on GitLab, where no merge request event runs a job from the default branch that could hold the lock; leave locks unset, and with apply.when: pull-request a merge request locks its roots on `/terragucci apply` or `/terragucci lock`";

function checkApply(a: unknown, where: string, problems: string[], forge?: unknown): void {
  if (!isObject(a)) {
    problems.push(`${where} must be a map (settings: ${APPLY_KEYS.join(", ")})`);
    return;
  }
  for (const k of Object.keys(a)) if (!APPLY_KEYS.includes(k)) problems.push(`${where}.${k} is not a setting (settings: ${APPLY_KEYS.join(", ")})`);
  oneOf(a.when, APPLY_WHEN, `${where}.when`, problems);
  oneOf(a.merge, APPLY_MERGE, `${where}.merge`, problems);
  // GitHub runs a schedule at most every 5 minutes.
  if (a.resume !== undefined && !(Number.isInteger(a.resume) && (a.resume as number) >= 5 && (a.resume as number) <= 60)) problems.push(`${where}.resume must be the minutes between the resume job's runs, from 5 to 60`);
  if (a.merge !== undefined && a.when !== "pull-request") problems.push(`${where}.merge is set, and only a pull request applied before it merges is merged by terragucci; set ${where}.when to pull-request or drop merge`);
  if (a.merge_token_env !== undefined) {
    if (!(typeof a.merge_token_env === "string" && SECRET_NAME.test(a.merge_token_env))) problems.push(`${where}.merge_token_env must name the secret holding the token the merge is made with, such as MERGE_TOKEN`);
    // On GitLab the token also starts the apply pipeline, so it is set with merge: manual too.
    else if (a.merge !== "auto" && forge !== "gitlab") problems.push(`${where}.merge_token_env is set, and only apply.merge: auto merges; set ${where}.merge to auto or drop merge_token_env (on GitLab, where the token also starts the apply pipeline, set forge: gitlab)`);
  }
  if (a.requires !== undefined) {
    if (!Array.isArray(a.requires) || a.requires.some((r) => !(APPLY_REQUIRES as readonly unknown[]).includes(r))) problems.push(`${where}.requires must be a list of ${APPLY_REQUIRES.join(", ")}`);
    else if (new Set(a.requires).size !== a.requires.length) problems.push(`${where}.requires names a requirement twice`);
    else if (a.when !== "pull-request") problems.push(`${where}.requires is set, and only a pull request applied before it merges is checked against it; set ${where}.when to pull-request or drop requires`);
    // pr-merge merges only a head a reviewer approved, so an auto merge without the approval would never merge.
    else if (a.merge === "auto" && !a.requires.includes("approved")) problems.push(`${where}.requires leaves out approved, and apply.merge: auto merges only an approved head; add approved or set ${where}.merge to manual`);
  }
}

const APPLY_KEYS = ["when", "merge", "merge_token_env", "requires", "resume"];

function checkPolicy(p: unknown, where: string, problems: string[]): void {
  if (!isObject(p)) {
    problems.push(`${where} must be a map (settings: engine, path, namespace, input, source, override)`);
    return;
  }
  for (const k of Object.keys(p)) if (!["engine", "path", "namespace", "input", "source", "override"].includes(k)) problems.push(`${where}.${k} is not a setting (settings: engine, path, namespace, input, source, override)`);
  if (p.override !== undefined && !(Array.isArray(p.override) && p.override.length > 0 && p.override.every((o) => typeof o === "string" && o.trim() !== "" && !/[\r\n]/.test(o)))) {
    problems.push(`${where}.override must be a list of the forge identities or signers who may override a denial, such as [github:alice]`);
  }
  oneOf(p.engine, POLICY_ENGINES, `${where}.engine`, problems);
  oneOf(p.input, POLICY_INPUTS, `${where}.input`, problems);
  if (p.path !== undefined && (typeof p.path !== "string" || p.path === "" || p.path.startsWith("/") || p.path.split("/").includes(".."))) {
    problems.push(`${where}.path must be a directory inside the repo, such as policy`);
  }
  if (p.source !== undefined && !(typeof p.source === "string" && parsePolicySource(p.source))) {
    problems.push(`${where}.source must be a git repo and a ref, git+https://<host>/<path>@<ref>, such as git+https://github.com/acme/policy.git@v1`);
  }
  if (p.namespace !== undefined && !(typeof p.namespace === "string" && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(p.namespace))) {
    problems.push(`${where}.namespace must be a Rego package name, such as terraform.plan`);
  }
}

/** Where a shared policy is fetched from: the git URL and the ref. */
export interface PolicySource {
  url: string;
  ref: string;
}

/**
 * Split `git+<scheme>://<host>/<path>@<ref>` into the URL git fetches and
 * the ref. The ref is what follows the last `@` after the host, so a user
 * name in the URL (`git+https://ci@host/...`) stays in the URL. https and
 * http (a forge on a private network) and file (a repo on the job's disk).
 * Undefined when it is not that shape.
 */
export function parsePolicySource(source: string): PolicySource | undefined {
  const m = /^git\+(https?|file):\/\//.exec(source);
  if (!m) return undefined;
  const rest = source.slice(4);
  const hostEnd = rest.indexOf("/", m[1].length + 3);
  const at = rest.lastIndexOf("@");
  if (hostEnd < 0 || at <= hostEnd) return undefined;
  const url = rest.slice(0, at);
  const ref = rest.slice(at + 1);
  if (url.length <= hostEnd + 1 || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(ref) || ref.includes("..") || /\s/.test(url)) return undefined;
  return { url, ref };
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `agent.comment`: true, false, or a map of AGENT_COMMENT_KEYS. Its token is `agent.token_env`, read as a secret of that name. */
function checkAgentComment(c: unknown, tokenEnv: unknown, where: string, problems: string[]): void {
  if (typeof c === "boolean") {
    if (!c) return;
  } else if (!isObject(c)) {
    problems.push(`${where} must be true, false or a map (settings: ${AGENT_COMMENT_KEYS.join(", ")})`);
    return;
  } else {
    for (const k of Object.keys(c)) {
      if (!(AGENT_COMMENT_KEYS as readonly string[]).includes(k)) problems.push(`${where}.${k} is not a setting (settings: ${AGENT_COMMENT_KEYS.join(", ")})`);
    }
    if (c.command !== undefined && (typeof c.command !== "string" || c.command.trim() === "" || /[\r\n]/.test(c.command))) {
      problems.push(`${where}.command must be one command line, such as claude -p --max-turns "$TG_AGENT_MAX_TURNS"`);
    }
    if (c.key_secret !== undefined && !(typeof c.key_secret === "string" && SECRET_NAME.test(c.key_secret))) {
      problems.push(`${where}.key_secret must name the secret holding the model's API key, such as ANTHROPIC_API_KEY`);
    }
    for (const k of ["max_turns", "timeout"] as const) {
      if (c[k] !== undefined && !(Number.isInteger(c[k]) && (c[k] as number) >= 1)) problems.push(`${where}.${k} must be a whole number of 1 or more`);
    }
  }
  if (typeof tokenEnv === "string" && tokenEnv !== "" && !SECRET_NAME.test(tokenEnv)) {
    problems.push(`${where} reads agent.token_env as a secret name, so token_env must be one, such as AGENT_FORGE_TOKEN`);
  }
}

/** `review`: a map of REVIEW_KEYS. */
function checkReview(r: unknown, where: string, problems: string[]): void {
  if (!isObject(r)) {
    problems.push(`${where} must be a map (settings: ${REVIEW_KEYS.join(", ")})`);
    return;
  }
  for (const k of Object.keys(r)) {
    if (!(REVIEW_KEYS as readonly string[]).includes(k)) problems.push(`${where}.${k} is not a setting (settings: ${REVIEW_KEYS.join(", ")})`);
  }
  if (r.agent !== undefined && typeof r.agent !== "boolean") problems.push(`${where}.agent must be true or false`);
  if (r.command !== undefined && (typeof r.command !== "string" || r.command.trim() === "" || /[\r\n]/.test(r.command))) {
    problems.push(`${where}.command must be one command line that reads the prompt on stdin and prints the review, such as claude -p`);
  }
  if (r.key_secret !== undefined && !(typeof r.key_secret === "string" && SECRET_NAME.test(r.key_secret))) {
    problems.push(`${where}.key_secret must name the secret holding the model's API key, such as ANTHROPIC_API_KEY`);
  }
  if (r.instructions !== undefined) {
    const p = typeof r.instructions === "string" ? r.instructions.replace(/^\.\//, "") : "";
    if (!p || p.startsWith("/") || p.split("/").some((x) => x === ".." || x === "") || !/^[A-Za-z0-9_.\/-]+$/.test(p)) {
      problems.push(`${where}.instructions must be a file path inside the repository, such as .terragucci/review.md`);
    }
  }
  if (r.timeout !== undefined && !(Number.isInteger(r.timeout) && (r.timeout as number) >= 1)) problems.push(`${where}.timeout must be a whole number of 1 or more`);
  if (r.agent === undefined && Object.keys(r).length > 0) problems.push(`${where}.agent is missing, so no review runs; set ${where}.agent: true`);
}

const DECIDE_KEYS = ["backend", "url", "model", "token_env", "thresholds"];

function checkDecide(d: unknown, where: string, problems: string[]): void {
  if (!isObject(d)) {
    problems.push(`${where} must be a map (settings: ${DECIDE_KEYS.join(", ")})`);
    return;
  }
  for (const k of Object.keys(d)) {
    if (!DECIDE_KEYS.includes(k)) problems.push(`${where}.${k} is not a setting (settings: ${DECIDE_KEYS.join(", ")})`);
  }
  if (d.backend === undefined) problems.push(`${where}.backend is missing; use one of ${DECIDE_BACKENDS.join(", ")}`);
  else oneOf(d.backend, DECIDE_BACKENDS, `${where}.backend`, problems);
  for (const k of ["url", "model", "token_env"] as const) {
    if (d[k] !== undefined && (typeof d[k] !== "string" || d[k] === "")) problems.push(`${where}.${k} must be a string`);
  }
  if (typeof d.url === "string" && !/^https?:\/\/[^/\s]+/.test(d.url)) problems.push(`${where}.url must be an http or https URL, such as http://localhost:8790`);
  if (d.url === undefined && d.backend !== "jev" && d.backend !== undefined) problems.push(`${where}.url is missing; name the service's base URL`);
  if (d.model === undefined && d.backend !== "laya" && d.backend !== undefined) {
    problems.push(`${where}.model is missing; pin the model version the ${String(d.backend)} service answers as`);
  }
  if (typeof d.model === "string" && /(^|[-_.])(latest|preview)$/.test(d.model)) {
    problems.push(`${where}.model is ${d.model}, an alias that moves when a new version ships; pin a versioned id, such as jev-1.13.0`);
  }
  if (d.backend === "jev" && d.token_env === undefined) problems.push(`${where}.token_env is missing; name the variable holding the Jev API key`);
  if (typeof d.token_env === "string" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d.token_env)) problems.push(`${where}.token_env must name an environment variable`);
  if (d.thresholds !== undefined) {
    if (!isObject(d.thresholds)) problems.push(`${where}.thresholds must map question types (${QUESTION_TYPES.join(", ")}) to a probability`);
    else {
      for (const [k, v] of Object.entries(d.thresholds)) {
        if (!(QUESTION_TYPES as readonly string[]).includes(k)) problems.push(`${where}.thresholds.${k} is not a question type (types: ${QUESTION_TYPES.join(", ")})`);
        else if (typeof v !== "number" || !(v > 0 && v <= 1)) problems.push(`${where}.thresholds.${k} must be a probability above 0 and at most 1`);
      }
    }
  }
}

const DURATION = /^(\d+(ms|s|m|h|d|w|y))+$/;

function checkDashboards(d: unknown, where: string, problems: string[]): void {
  if (typeof d === "boolean") return;
  if (!isObject(d)) {
    problems.push(`${where} must be true, false or a map (settings: ${DASHBOARD_KEYS.join(", ")})`);
    return;
  }
  for (const k of Object.keys(d)) {
    if (!(DASHBOARD_KEYS as readonly string[]).includes(k)) problems.push(`${where}.${k} is not a setting (settings: ${DASHBOARD_KEYS.join(", ")})`);
  }
  for (const k of DASHBOARD_KEYS) {
    const v = d[k];
    if (v === undefined) continue;
    if (typeof v !== "string" || v === "") problems.push(`${where}.${k} must be a string`);
    else if (/[\r\n]/.test(v)) problems.push(`${where}.${k} must be one line`);
    else if ((DASHBOARD_DURATION_KEYS as readonly string[]).includes(k) && !DURATION.test(v)) problems.push(`${where}.${k} is ${JSON.stringify(v)}; use a duration such as 4h or 1d`);
  }
  if (typeof d.dir === "string" && (d.dir.startsWith("/") || d.dir.split("/").includes(".."))) problems.push(`${where}.dir must be a path inside the repo`);
}

function checkTerragrunt(t: unknown, where: string, problems: string[]): void {
  if (!isObject(t)) {
    problems.push(`${where} must be a map (settings: ${TERRAGRUNT_KEYS.join(", ")})`);
    return;
  }
  for (const k of Object.keys(t)) {
    if (!TERRAGRUNT_KEYS.includes(k)) problems.push(`${where}.${k} is not a setting (settings: ${TERRAGRUNT_KEYS.join(", ")})`);
  }
  if (t.version !== undefined) {
    const m = typeof t.version === "string" ? /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.]+)?$/.exec(t.version) : null;
    if (!m) problems.push(`${where}.version must be a release version such as 1.1.6`);
    else if (Number(m[1]) < 1 || (Number(m[1]) === 1 && Number(m[2]) < 1)) {
      problems.push(`${where}.version is ${t.version}; terragucci needs Terragrunt 1.1 or later`);
    }
  }
  stringList(t.exclude, `${where}.exclude`, problems);
  if (t.parallelism !== undefined && !(Number.isInteger(t.parallelism) && (t.parallelism as number) >= 1)) {
    problems.push(`${where}.parallelism must be a whole number of 1 or more`);
  }
  oneOf(t.dependents, DEPENDENTS, `${where}.dependents`, problems);
  if (t.credentials !== undefined) {
    if (!isObject(t.credentials)) {
      problems.push(`${where}.credentials must map unit path globs to a plan role and an apply role`);
      return;
    }
    for (const [glob, pair] of Object.entries(t.credentials)) {
      const at = `${where}.credentials["${glob}"]`;
      if (!isObject(pair)) {
        problems.push(`${at} must be a map with plan and apply`);
        continue;
      }
      for (const k of Object.keys(pair)) {
        if (k !== "plan" && k !== "apply") problems.push(`${at}.${k} is not a setting (settings: plan, apply)`);
      }
      for (const k of ["plan", "apply"] as const) {
        if (typeof pair[k] !== "string" || pair[k] === "") problems.push(`${at}.${k} must name a role`);
      }
      if (typeof pair.plan === "string" && pair.plan === pair.apply) {
        problems.push(`${at} uses one role for plan and apply; plan runs pull-request code, so give it a read-only role of its own`);
      }
    }
  }
}

/** The GCP Workload Identity Federation provider's resource name. */
const WIF_PROVIDER = /^projects\/[0-9]+\/locations\/global\/workloadIdentityPools\/[^/\s]+\/providers\/[^/\s]+$/;

function checkOidc(o: unknown, where: string, problems: string[]): void {
  if (!isObject(o)) {
    problems.push(`${where} must be a map with plan_role and apply_role (AWS), gcp, azure, or several`);
    return;
  }
  for (const k of Object.keys(o)) {
    if (!["plan_role", "apply_role", "audience", "gcp", "azure"].includes(k)) problems.push(`${where}.${k} is not a setting (settings: plan_role, apply_role, audience, gcp, azure)`);
  }
  const aws = o.plan_role !== undefined || o.apply_role !== undefined || o.audience !== undefined;
  if (!aws && o.gcp === undefined && o.azure === undefined) problems.push(`${where} must set plan_role and apply_role (AWS), gcp, azure, or several`);
  if (aws) {
    for (const k of ["plan_role", "apply_role"] as const) {
      if (typeof o[k] !== "string" || o[k] === "") problems.push(`${where}.${k} must name a role, one for plan and one for apply`);
    }
    if (o.audience !== undefined && typeof o.audience !== "string") problems.push(`${where}.audience must be a string`);
    if (typeof o.plan_role === "string" && o.plan_role === o.apply_role) {
      problems.push(`${where}.plan_role and apply_role are the same role; plan runs pull-request code, so give it a read-only role of its own`);
    }
  }
  const pair = (cloud: string, c: unknown, keys: string[], stages: [string, string], what: string, optional: string[] = []): Record<string, unknown> | undefined => {
    if (!isObject(c)) {
      problems.push(`${where}.${cloud} must be a map with ${keys.join(", ")}`);
      return undefined;
    }
    const all = [...keys, ...optional];
    for (const k of Object.keys(c)) if (!all.includes(k)) problems.push(`${where}.${cloud}.${k} is not a setting (settings: ${all.join(", ")})`);
    for (const k of optional) if (c[k] !== undefined && (typeof c[k] !== "string" || c[k] === "")) problems.push(`${where}.${cloud}.${k} must be a non-empty string`);
    for (const k of keys) if (typeof c[k] !== "string" || c[k] === "") problems.push(`${where}.${cloud}.${k} must be set`);
    if (typeof c[stages[0]] === "string" && c[stages[0]] !== "" && c[stages[0]] === c[stages[1]]) {
      problems.push(`${where}.${cloud}.${stages[0]} and ${stages[1]} are the same ${what}; plan runs pull-request code, so give it a read-only ${what} of its own`);
    }
    return c;
  };
  if (o.gcp !== undefined) {
    const g = pair("gcp", o.gcp, ["workload_identity_provider", "plan_service_account", "apply_service_account"], ["plan_service_account", "apply_service_account"], "service account", ["token_url"]);
    if (g && typeof g.token_url === "string" && g.token_url !== "" && !/^https:\/\/[^\s/]+\/\S*$/.test(g.token_url)) problems.push(`${where}.gcp.token_url must be an https URL, such as https://sts.googleapis.com/v1/token`);
    if (g && typeof g.workload_identity_provider === "string" && g.workload_identity_provider !== "" && !WIF_PROVIDER.test(g.workload_identity_provider)) {
      problems.push(`${where}.gcp.workload_identity_provider must be the provider's resource name, projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`);
    }
    for (const k of ["plan_service_account", "apply_service_account"]) {
      if (g && typeof g[k] === "string" && g[k] !== "" && !/^[^@\s]+@[^@\s]+$/.test(g[k] as string)) problems.push(`${where}.gcp.${k} must be a service account's email`);
    }
  }
  if (o.azure !== undefined) pair("azure", o.azure, ["tenant_id", "subscription_id", "plan_client_id", "apply_client_id"], ["plan_client_id", "apply_client_id"], "client", ["audience"]);
}

/** Check a parsed config and return it typed, or throw with every problem listed. */
export function validateConfig(raw: unknown, where: string): TerragucciConfig {
  const problems: string[] = [];
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new ConfigError(`${where}: the config must be a map`);
  const { defaults, projects, ...rest } = raw;
  if (projects !== undefined) {
    if (!isObject(projects)) problems.push(`${where}: projects must map <host>/<path> to settings`);
    else {
      for (const [key, s] of Object.entries(projects)) {
        try {
          parseProjectKey(key);
        } catch (e) {
          problems.push(`${where}: ${(e as Error).message}`);
        }
        checkSettings(s ?? {}, `projects["${key}"]`, problems);
        if (isObject(s) && s.rollouts) problems.push(`projects["${key}"].rollouts: ${ROLLOUTS_SINGLE_REPO}`);
      }
    }
    if (Object.keys(rest).length) {
      problems.push(`${where}: a control repo keeps shared settings under defaults; move ${Object.keys(rest).join(", ")} there`);
    }
  } else {
    checkSettings(rest, "config", problems);
  }
  if (defaults !== undefined) checkSettings(defaults, "defaults", problems);
  if (isObject(defaults) && defaults.rollouts) problems.push(`defaults.rollouts: ${ROLLOUTS_SINGLE_REPO}`);
  if (isObject(defaults) && defaults.url !== undefined) {
    problems.push(`${where}: defaults.url would clone one repo for every project; set url on each project that needs one`);
  }
  if (defaults !== undefined && projects === undefined) problems.push(`${where}: defaults only makes sense with projects`);
  if (problems.length) throw new ConfigError(`${where} has ${problems.length} problem(s):\n  ${problems.join("\n  ")}`, problems);
  // JSON's view: an undefined property is the same as an absent one.
  return JSON.parse(JSON.stringify(raw)) as TerragucciConfig;
}

// ── loading ──────────────────────────────────────────────────────────────────

export type ConfigMode = "fold" | "run" | "check";

function projectFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) continue;
      if (name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts")) {
        files.set(relative(root, abs).split("\\").join("/"), readFileSync(abs, "utf-8"));
      }
    }
  };
  walk(root);
  return files;
}

/** The TypeScript folder ships separately; only a `.ts` config needs it. */
export const TSAD_INSTALL = "npm i -D @intentius/tsad-reference";

async function foldConfig(path: string): Promise<unknown> {
  let tsad: typeof import("@intentius/tsad-reference");
  try {
    tsad = await import("@intentius/tsad-reference");
  } catch {
    throw new ConfigError(`${path} is TypeScript, which needs the TypeScript folder: ${TSAD_INSTALL}`);
  }
  const { foldProject, EMPTY_HOST } = tsad;
  const root = dirname(resolve(path));
  const key = relative(root, resolve(path)).split("\\").join("/");
  const verdict = foldProject(projectFiles(root), { ...EMPTY_HOST, profile: "data-host" }).verdicts.get(key);
  if (!verdict) throw new ConfigError(`${path}: not found`);
  if (verdict.kind === "run") throw new ConfigError(`${path} is not data (${verdict.rule}): ${verdict.reason}`);
  const exports = Object.fromEntries(verdict.exports);
  if (!("default" in exports)) throw new ConfigError(`${path} must export the config as \`export default\``);
  return exports.default;
}

async function runConfig(path: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>;
  if (!("default" in mod)) throw new ConfigError(`${path} must export the config as \`export default\``);
  return mod.default;
}

const canonical = (v: unknown): string => {
  const sort = (x: unknown): unknown =>
    x === null || typeof x !== "object"
      ? x
      : Array.isArray(x)
        ? x.map(sort)
        : Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
  return JSON.stringify(sort(JSON.parse(JSON.stringify(v ?? {}))));
};

/** Load and validate a config file. A `.ts` file is folded unless `mode` says otherwise. */
export async function loadConfig(path: string, mode: ConfigMode = "fold"): Promise<TerragucciConfig> {
  if (!existsSync(path)) throw new ConfigError(`${path} does not exist`);
  if (path.endsWith(".ts")) {
    if (mode === "run") return validateConfig(await runConfig(path), path);
    const folded = await foldConfig(path);
    if (mode === "check") {
      const ran = await runConfig(path);
      if (canonical(folded) !== canonical(ran)) {
        throw new ConfigError(`${path}: folding and running the config disagree, so it is not data`);
      }
    }
    return validateConfig(folded, path);
  }
  const text = readFileSync(path, "utf-8");
  let raw: unknown;
  try {
    raw = path.endsWith(".json") ? JSON.parse(text) : text.trim() === "" ? {} : parseYAML(text);
  } catch (e) {
    throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
  return validateConfig(raw, path);
}

// ── projects ─────────────────────────────────────────────────────────────────

export interface ProjectKey {
  key: string;
  host: string;
  /** Everything after the host: owner/name, or a GitLab group path and name. */
  path: string;
  owner: string;
  name: string;
}

/** Split `<host>/<path>`. The host is the first segment; the path needs an owner and a name. */
export function parseProjectKey(key: string): ProjectKey {
  const clean = key.replace(/^https?:\/\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const parts = clean.split("/");
  if (parts.length < 3 || parts.some((p) => p === "")) {
    throw new ConfigError(`project key "${key}" must be <host>/<owner>/<name>, such as github.com/acme/infra`);
  }
  const [host, ...rest] = parts;
  return { key, host, path: rest.join("/"), owner: rest.slice(0, -1).join("/"), name: rest[rest.length - 1] };
}

/** The forge a host belongs to, when the host says so. */
export function forgeFromHost(host: string): ForgeName | undefined {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (h === "github.com" || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.startsWith("gitlab.") || h.includes(".gitlab.")) return "gitlab";
  if (h === "codeberg.org" || h.startsWith("forgejo.") || h.startsWith("gitea.") || h.includes("forgejo")) return "forgejo";
  return undefined;
}

/** One repo's settings: built-in defaults, then the file's own keys. */
export function resolveRepo(config: TerragucciConfig): ResolvedSettings {
  if (config.projects) {
    throw new ConfigError("this config lists projects, so it belongs to a control repo; run terragucci reconcile instead");
  }
  return merge(BUILT_IN, config);
}

/** A control repo's project: built-in defaults, then `defaults`, then the project's own keys. */
export function resolveProject(config: TerragucciConfig, key: string): ResolvedSettings {
  const project = config.projects?.[key];
  if (project === undefined) throw new ConfigError(`no project "${key}" in the config`);
  return merge(merge(BUILT_IN, config.defaults ?? {}), project ?? {});
}

function merge(base: ResolvedSettings, over: ProjectSettings): ResolvedSettings {
  const { defaults: _d, projects: _p, ...settings } = over as TerragucciConfig;
  const out: ResolvedSettings = { ...base, ...settings, env: { ...base.env, ...(settings.env ?? {}) } };
  if (settings.oidc) out.oidc = { ...base.oidc, ...settings.oidc };
  if (base.terragrunt || settings.terragrunt) out.terragrunt = { ...base.terragrunt, ...settings.terragrunt };
  if (base.respond || settings.respond) out.respond = { ...base.respond, ...settings.respond };
  if (base.policy || settings.policy) out.policy = { ...base.policy, ...settings.policy };
  if (base.waves || settings.waves) out.waves = { ...base.waves, ...settings.waves };
  if (base.apply || settings.apply) out.apply = { ...base.apply, ...settings.apply };
  if (base.generate || settings.generate) out.generate = combineGenerate(base.generate, settings.generate);
  return out;
}
