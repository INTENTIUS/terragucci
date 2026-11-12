/**
 * The pipeline terragucci writes into a repo, rendered through chant's forge
 * lexicons so GitHub, Forgejo and GitLab get the same jobs in their own syntax.
 *
 * check  every push: format check and validate, for every root.
 * plan   pull requests from the same repo: `terragucci stage tf-plan` plans
 *        the roots the change reaches against the target branch, and the
 *        roots that read their state, in apply order, and writes the plan
 *        report, kept as the job's artifact (and in a bucket when one is
 *        named). Its note, chant's grouped summary across those roots, is the
 *        one plan note and its counts the one terragucci/plan status.
 *        Read-only role. On GitLab with `gitlab.token: protected` it holds no
 *        forge token: it writes the note and the status into its report, and
 *        the comments job posts them.
 * apply  pushes to the default branch: one job per wave, canary first, each
 *        needing the one before. `terragucci stage tf-apply` plans the wave,
 *        and a wave the gate policy holds waits for a person's approval of
 *        its set digest (`chant approve`); one whose plans changed after the
 *        approval applies nothing. A root that reads another's state applies
 *        after it. Applies of different roots run at once, and the
 *        backend's state lock keeps one root's apart; with choudoufu a
 *        wave holds only the resources its plans change (./apply-rows.ts).
 *        A wave that finds a newer push on its branch stands down. Posts one
 *        terragucci/apply status and marks plan notes the push made stale.
 *        A Terragrunt repo's waves are the same jobs over its units' dependency
 *        layers, each behind the same gate; the last job also runs any layer
 *        the repo grew after init wrote the pipeline. The wave jobs, their
 *        status and stale-notes jobs, the resume and the control dispatch
 *        are chant's Op waves jobs (./render-waves.ts).
 * apply-comment  `/terragucci apply [wave-<n>]` (GitHub and Forgejo): chant's
 *        comment job, which re-runs a merged pull request's wave jobs, or
 *        with `apply.when: pull-request` decides an open one's head and
 *        dispatches its waves (./product-plan.ts). On GitLab the comments
 *        job hands an open merge request's apply to chant's decision
 *        (./comment-gitlab.ts).
 *
 * drift  only when `drift:` names a schedule: `terragucci stage tf-drift` plans
 *        every root with -refresh-only, keeps the same report, and opens,
 *        updates or closes the project's one drift issue. It never applies.
 *        Read-only role. On GitLab the schedule itself is set in the
 *        project's CI/CD schedules; the job runs for scheduled pipelines
 *        other than the comments schedule's.
 * rollout  only when `rollouts:` names a schedule and `respond.rollout` is not
 *        off: `terragucci respond rollout --mode apply` on that schedule, which
 *        opens the next wave of every rollout in flight once the last one
 *        merged and applied. On GitHub and Forgejo it is a workflow of its own
 *        (ROLLOUT_PATHS), so the pipeline's file is the same with or without
 *        it; on GitLab it runs for the schedule whose TERRAGUCCI_SCHEDULE is
 *        rollouts.
 * comments  GitLab only, when `comments:` is set: the comments schedule's
 *        pipelines (TERRAGUCCI_SCHEDULE=comments) poll merge request notes
 *        (and with `gitlab.token: protected` post each merge request's plan
 *        note and status from its plan job's report), and start a merge
 *        request pipeline for `/terragucci plan`, or retry
 *        the merge commit's apply jobs for `/terragucci apply` (with
 *        `apply.when: pull-request`, chant decides the head and starts the
 *        waves' pipeline for it).
 *
 * Each stage is one job here; the file holds all of them.
 */
// Each lexicon's serializer and generated entities, never its entry point: the
// entry points carry lint rules, codegen and the TypeScript compiler, which the
// bundle must not (terragucci#18).
import { applyScope } from "./apply-rows";
import { Job, Step, Workflow } from "@intentius/chant-lexicon-github/generated/index";
import { githubSerializer } from "@intentius/chant-lexicon-github/serializer";
import { applyForgejoDialect } from "@intentius/chant-lexicon-forgejo/dialect";
import { Image, Job as GitLabJob, Rule } from "@intentius/chant-lexicon-gitlab/generated/index";
import { gitlabSerializer } from "@intentius/chant-lexicon-gitlab/serializer";
import { emitYAMLEntry } from "@intentius/chant/yaml";

/** Forgejo is the github dialect with Forgejo's runner labels and action refs. */
const forgejoSerializer = {
  serialize(entities: Map<string, never>): ReturnType<typeof githubSerializer.serialize> {
    return githubSerializer.serialize(applyForgejoDialect(entities as never, {}).entities as never);
  },
};

/** Serializes a workflow's entities for GitHub or Forgejo (the control repo's pipeline, control-repo.ts, writes one too). */
export function serializeWorkflow(forge: Exclude<ForgeName, "gitlab">, jobs: Map<string, never>): string {
  // Each action is pinned by SHA (./action-pins.ts); its release goes beside it as a comment.
  return tagComments(text((forge === "forgejo" ? forgejoSerializer : githubSerializer).serialize(jobs)));
}

/**
 * How many levels of `needs` Forgejo 16 settles while it creates a run. It
 * evaluates a job with no `needs` whose `if` is false as skipped on the spot,
 * then, in the same transaction, skips each job below it one level of `needs`
 * at a time, and past this many levels it gives up (checkJobsOfRun's recursion
 * limit) and creates no run at all. A pull request on a repo with five waves
 * and the tips job below `check` got no plan.
 */
export const forgejoSkipLevels = 5;

/**
 * An `if` that refers to `env` is one Forgejo cannot evaluate when it creates
 * a run, so it hands the job to the runner, which skips it. The jobs below are
 * then skipped by Forgejo's job queue, which retries past the limit, so the run
 * goes on. This one is always true.
 */
export const runnerEvaluatedIf = "(env.TF_IN_AUTOMATION || 'set') != ''";

/**
 * The stage `runner` places a job by: the jobs that plan a pull request, the
 * jobs that apply (the waves, comment and pull request applies, confirm,
 * resume and the ephemeral copies), and the drift job. Every other job runs
 * on `runner.default`.
 */
export function jobStage(name: string): RunnerStage | undefined {
  if (name === "plan" || name === "replan") return "plan";
  if (name === "drift") return "drift";
  // chant's comment job applies nothing itself: it re-runs or dispatches the waves' jobs.
  if (name === "apply-comment") return undefined;
  if (name.startsWith("apply-") || ["confirm", "resume", "ephemeral", "ephemeral-sweep", "sweep"].includes(name)) return "apply";
  return undefined;
}

/** A job's `needs`, as the names it lists (GitHub's string or list, GitLab's `{ job }` entries). */
function needsOf(needs: unknown): string[] {
  const list = Array.isArray(needs) ? needs : needs === undefined ? [] : [needs];
  return list.map((n) => (typeof n === "string" ? n : (n as { job: string }).job));
}

/** The runner `runner` gives a job of `stage`, or undefined to keep the job's default. */
export function runnerOf(runner: RunnerSettings | undefined, stage: RunnerStage | undefined): RunnerSpec | undefined {
  if (runner === undefined || !runnerByStage(runner)) return runner;
  return (stage ? runner[stage] : undefined) ?? runner.default;
}

/**
 * `runner`: each job's `runs-on` on GitHub and Forgejo (where the dialect
 * passes any label but GitHub's hosted ones through), its `tags` on GitLab,
 * by its stage. A job `runner` gives nothing keeps what it has, so a pipeline
 * without the key is the one it always was.
 */
export function placeJobs(jobs: Map<string, unknown>, runner: RunnerSettings | undefined, forge: ForgeName, own?: ReadonlyMap<string, RunnerSpec>): void {
  if (runner === undefined && !own?.size) return;
  for (const [name, job] of jobs) {
    // A group's apply jobs run on its environment's runner (./cloud-identity.ts), over the pipeline's.
    const spec = name === "workflow" ? undefined : (own?.get(name) ?? runnerOf(runner, jobStage(name)));
    const props = (job as { props?: Record<string, unknown> }).props;
    if (spec === undefined || !props) continue;
    if (forge === "gitlab") props.tags = typeof spec === "string" ? [spec] : Array.isArray(spec) ? [...spec] : [...(spec.labels ?? [])];
    else props["runs-on"] = typeof spec === "string" ? spec : Array.isArray(spec) ? [...spec] : { group: spec.group, ...(spec.labels ? { labels: [...spec.labels] } : {}) };
  }
}

/** `pass` as a job's environment: each secret as `secrets.<name>` and each variable as `vars.<name>`, under its own name. Empty on GitLab, whose jobs have the project's variables already. */
export function passEnv(pass: PassSettings | undefined, forge: ForgeName): Record<string, string> {
  if (!pass || forge === "gitlab") return {};
  return Object.fromEntries([...(pass.secrets ?? []).map((n) => [n, `\${{ secrets.${n} }}`]), ...(pass.vars ?? []).map((n) => [n, `\${{ vars.${n} }}`])]);
}

/** The number of jobs on the longest chain of `needs` below each job. */
export function needsDepths(entities: Map<string, unknown>): Map<string, number> {
  const below = new Map<string, string[]>();
  for (const [name, job] of entities) {
    if (name === "workflow") continue;
    const needs = (job as { props?: { needs?: string | string[] } }).props?.needs;
    for (const n of needs === undefined ? [] : Array.isArray(needs) ? needs : [needs]) below.set(n, [...(below.get(n) ?? []), name]);
  }
  const depths = new Map<string, number>();
  const depth = (name: string, seen: Set<string>): number => {
    const known = depths.get(name);
    if (known !== undefined) return known;
    if (seen.has(name)) return 0;
    seen.add(name);
    const d = Math.max(0, ...(below.get(name) ?? []).map((c) => 1 + depth(c, seen)));
    depths.set(name, d);
    return d;
  };
  for (const name of entities.keys()) if (name !== "workflow") depth(name, new Set());
  return depths;
}

/**
 * On Forgejo, a job with no `needs` and an `if`, with more than
 * forgejoSkipLevels jobs on a chain of `needs` below it, gets its `if`
 * evaluated by the runner, so an event that skips it still creates the run.
 */
export function deferDeepSkips(entities: Map<string, unknown>): void {
  const depths = needsDepths(entities);
  for (const [name, job] of entities) {
    const props = (job as { props?: { needs?: unknown; if?: unknown } }).props;
    if (name === "workflow" || !props || props.needs !== undefined || typeof props.if !== "string") continue;
    if ((depths.get(name) ?? 0) > forgejoSkipLevels) props.if = `${runnerEvaluatedIf} && (${props.if})`;
  }
}
import { ATMOS_WRITE } from "./atmos";
import { ATMOS_DRIFT_PR, ATMOS_DRIFT_PR_SHORT, ATMOS_ROLLOUTS } from "./refusals";
import { AGENT_LOGIN, APPLY_REQUIRES, BRANCHES_NOT_PR_APPLY, COMMENTS_GITLAB_ONLY, SYNTH_DRIFT_PR, SYNTH_DRIFT_PR_SHORT, SYNTH_ROLLOUTS, WAVE_JOBS_NOT_PR_APPLY, PR_APPLY_NEEDS_ON_GITLAB, NEEDS_COMMENTS_ON_GITLAB, NO_GITLAB_PLAN_LOCKS, ENVIRONMENTS_PR_APPLY, ENVIRONMENTS_RESUME, ENVIRONMENTS_EPHEMERAL, responseTo, type ApplyMerge, type ApplyRequire, type ApplyWhen, type Approval, type Binary, type ForgeName, type Gate, type GitLabToken, type OidcSettings, type RespondEvent, type RolePair, AGENT_DRIFT_RESPOND, EPHEMERAL_NOT_PROTECTED, passProblems, runnerByStage, runnerProblems, type PassSettings, type RunnerSettings, type RunnerSpec, type RunnerStage, type AudienceStage } from "./config";
import { DEFAULT_TOKEN_ENV } from "./forge";
import type { ResolvedControl } from "./control-repo";
import { rootRoles } from "./cloud-identity";
import { cloudLogin, LOGIN_RESTART_MARKER, type CloudLoginSpec } from "@intentius/chant/ci-login";
import { BEFORE_MERGE_HEAD_ENV } from "@intentius/chant/op/before-merge";
import type { PipelineEvidence } from "@intentius/chant/ci-evidence-jobs";
import { applyTrade, githubCommentJob, githubPlanJobs, gitlabPlanJobs, PLAN_ENV, PLAN_EVIDENCE_JOB, PLAN_NOTES_SCHEDULE, PLAN_NOTES_VAR, planOptions, planTrade, type PlanJobsInput } from "./product-plan";
import { githubWaves, gitlabWaves, wavesBeforeMerge, wavesJobNames, wavesShape, type WavesInput } from "./render-waves";
import { driftWatch } from "./report/overdue";
import type { AgentCommentInput } from "./agent-comment";
import { chantAgentFiles, CHANT_AGENT_PATHS, CHANT_AGENT_PR_VAR } from "./render-chant-agent";
import { chantDriftExitLines, chantDriftFiles, CHANT_DRIFT_GITLAB_STAGE, CHANT_DRIFT_PATHS } from "./render-chant-drift";
import { DRIFT_ISSUE_FILE, DRIFT_ISSUE_JS } from "./drift-agent";
import { ATLANTIS_COMMENTS_ENV } from "./comment";
import { commentLine, productPipelineJobs, type CiProductCommand } from "@intentius/chant/ci-product";
import { TERRAGUCCI_WORDS } from "./ci-words";
import { WAVES_OP, WAVES_SPEC, waveCallArgv, wavesSpec } from "./chant-waves";
import { gitlabReviewScript, reviewWorkflow } from "./render-review";
import { GL_REVIEW_ARTIFACT, REVIEW_JOB, REVIEW_MR_VAR } from "./gitlab-agent";
import { REVIEW_PATHS, type ReviewInput } from "./review-agent";
import { applyWaves, shareCount } from "./apply";
import type { ApplyGroup } from "./cloud-identity";
import { CHECK_DIR } from "./check";
import { dropForgeTokens as chantDropForgeTokens, FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { checkoutScript, handoverOutputs, handoverTrap, takeOverScript } from "./handover";
import { COSIGN_VERSION, INFRACOST_VERSION, type Tool } from "./install";
import {
  cacheExports,
  credentialsScript,
  forgeCache,
  forgeCacheRestore,
  terragruntCheckScript,
  terragruntJobEnv,
  type TerragruntPipelineInput,
} from "./render-terragrunt";
import { CHECKOUT, tagComments, uploadArtifact } from "./action-pins";
import { resolveCommitSpec } from "@intentius/chant/ci-commit";
import { ciToolInstallLine } from "@intentius/chant/ci-image";
import { githubCommitJobs } from "@intentius/chant-lexicon-github/components/commit-jobs";
import { gitlabCommitJobs } from "@intentius/chant-lexicon-gitlab/components/commit-jobs";
import { FMT_FINDING, fmtCommitSpec } from "./fmt";

export const MARKER = "# Generated by terragucci.";

/** The rollout workflow, beside the pipeline on GitHub and Forgejo. GitLab's rollout job is in the pipeline's file. */
export const ROLLOUT_PATHS: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: ".github/workflows/terragucci-rollout.yml",
  forgejo: ".forgejo/workflows/terragucci-rollout.yml",
};

/**
 * The rollout workflow's dispatch inputs. With `module` it starts that module's rollout
 * (`terragucci rollout <module> [<version>] --mode apply`), which opens its first wave; an
 * empty `version` is the module's newest published one. Without `module`, and on the
 * schedule, it continues every rollout in flight. A client such as an Upgrade button
 * dispatches it by its file name, ROLLOUT_PATHS.
 */
export const ROLLOUT_INPUTS = {
  module: { description: "The module or template to roll out, such as acme/bucket/aws; empty continues every rollout in flight", required: false, type: "string" },
  version: { description: "The version to move to; empty for the newest published one", required: false, type: "string" },
};

/**
 * The request workflow, beside the pipeline on GitHub and Forgejo, with `templates` set: a
 * `workflow_dispatch` whose inputs are REQUEST_INPUTS, which opens a pull request adding an
 * app's root from a template. A form dispatches it by this file name.
 */
export const REQUEST_PATHS: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: ".github/workflows/terragucci-request.yml",
  forgejo: ".forgejo/workflows/terragucci-request.yml",
};

/**
 * The request workflow's dispatch inputs: the template, its version, the app's (or add-on's)
 * name and its inputs as JSON; `app` for an add-on, naming the app it goes into; and
 * `claimed_by`, the person the dispatching client says asked, which the request shows as
 * claimed next to the run's actor.
 */
export const REQUEST_INPUTS = {
  template: { description: "The template's address, such as acme/bucket/aws", required: true, type: "string" },
  version: { description: "The template version; empty for its newest one a request may name", required: false, type: "string" },
  name: { description: "The app's name, or with app the add-on's: a lowercase letter, then lowercase letters, digits and -", required: true, type: "string" },
  inputs: { description: "The template's inputs as one JSON object, by name", required: false, default: "{}", type: "string" },
  app: { description: "For an add-on template: the existing app it goes into; empty for a new app", required: false, type: "string" },
  claimed_by: { description: "Who the client says asked; shown as claimed, next to the run's actor", required: false, type: "string" },
};

export const PIPELINE_PATHS: Record<ForgeName, string> = {
  github: ".github/workflows/terragucci.yml",
  forgejo: ".forgejo/workflows/terragucci.yml",
  // The repo's .gitlab-ci.yml stays the repo's: init adds an include of this file to it (gitlab-ci.ts).
  gitlab: ".gitlab/terragucci.yml",
};

/**
 * GitLab's default stages, around terragucci's in the included file. GitLab
 * reads the stages of an included file only when the including file lists
 * none, and then a job of the repo's own that names no stage is in `test`, so
 * the defaults stay: build and test before terragucci's stages, deploy after
 * the apply. A stage no job is in does not show in the pipeline.
 */
export const GL_DEFAULT_STAGES = { before: ["build", "test"], after: ["deploy"] };

/** Why drift needs chant's Op generator: the drift job is a chant drift Op on every forge (terragucci#1305, chant issue 4622). */
export const CHANT_DRIFT_NEEDS_OP = "the drift job is a chant drift Op, and the installed chant has no Op generator; install the chant release terragucci pins";

/** `stages` with `stage` after the last of `after` the list holds, else first. */
export function insertStage(stages: readonly string[], stage: string, after: readonly string[]): string[] {
  const at = Math.max(-1, ...after.map((s) => stages.indexOf(s)));
  return [...stages.slice(0, at + 1), stage, ...stages.slice(at + 1)];
}

export interface PipelineInput {
  forge: ForgeName;
  binary: Binary;
  version: string;
  /** The job image, as a pipeline names it (tag, and digest once published). */
  image: string;
  /** Set when `image` is the one terragucci.yml names, built FROM terragucci's. */
  imageFromConfig?: boolean;
  /** Set when the repo pins a version the image does not carry: the job installs it. */
  install?: { binary: Binary; version: string };
  /** Some roots pin their own version: the check job runs each root with the binary `terragucci binary` names for it. */
  rootPins?: boolean;
  /** `generate` is set: the check job runs `terragucci generate --check`, which refuses a generated file out of line with terragucci.yml. */
  generate?: boolean;
  /** `sources` is set: the check job runs `terragucci check-sources` on each root before its init. */
  sources?: boolean;
  /** `image.mirror` is set: the check job runs `terragucci check-mirror` before any init, with the history it compares against. */
  mirror?: boolean;
  /** `parallelism` from terragucci.yml: at most this many roots check at once. Unset: all of them. */
  parallelism?: number;
  /**
   * The check job runs `terragucci ci check` last: chant's `ci.hooks.check`, read at base, with the history that
   * reads it. Set when `check.pre_commit` is on (`preCommit`, ./pre-commit.ts) or chant.workspace.json names check hooks.
   */
  checkHooks?: { preCommit: boolean };
  /**
   * `evidence` (terragucci issue 1413): chant's runner identity. The plan note job (GitLab: `plan-evidence`)
   * signs `plan` and `policy`, and each wave `plan:<wave>` and `policy:<wave>`, a wave that trades cloud
   * credentials and signs keyless in its `<wave job>-evidence` job.
   */
  evidence?: PipelineEvidence;
  /** Roots in apply order: each inner list applies together. In Terragrunt mode, units by wave. */
  layers: string[][];
  /**
   * Plain roots: the op-waves spec of the repo's apply on chant's terraform-apply step (terragucci#1303), as
   * `.chant/op-waves/tf-apply.spec.json` holds it. Written once beside the pipeline, so a wave job reads its rules at
   * base from the commit it applies after, and puts a commit of its own on top only when its spec differs.
   */
  wavesSpec?: string;
  /** Set for a Terragrunt repo: the jobs run Terragrunt over its units. */
  terragrunt?: TerragruntPipelineInput & { installs: { tool: Tool; version: string }[] };
  /** `synth`: the command that writes the roots (CDK Terrain's `npx cdktn synth`), run in every job that reads them. */
  synth?: string;
  /** An Atmos repo: every job installs this Atmos release, which its synth (`terragucci atmos write`) runs. */
  atmos?: { version: string };
  /** A Terramate repo: every job installs this Terramate release, which its synth (`terragucci terramate generate`) runs. */
  terramate?: { version: string };
  /** `notify`: the secrets holding a Slack or Teams incoming webhook, or a generic webhook and its signing key, which the apply jobs post a waiting, refused or failed wave to. */
  notify?: { slack?: string; teams?: string; webhook?: string; webhook_key?: string; relay?: string; relay_key?: string };
  /** `cost`: the secret holding the estimator's key, whether the jobs install Infracost (no `cost.command`), and whether `cost.approve_above` can make a wave wait. */
  cost?: { keySecret: string; install: boolean; approveAbove?: boolean };
  env: Record<string, string>;
  /** Cloud identities the jobs take over OIDC (AWS roles, GCP service accounts, Azure clients): plan reads, apply writes. */
  oidc?: OidcSettings;
  /** The environment variable holding the forge token, where the forge's own job token cannot post statuses (GitLab). */
  tokenEnv?: string;
  /** The secret holding `OTEL_EXPORTER_OTLP_HEADERS`, mapped into the environment of the plan, apply and drift jobs. */
  headersSecret?: string;
  /** The variable holding the decision service's key (`decide.token_env`), for the plan jobs of a repo with respond.description on. A secret of that name is mapped into their environment on GitHub and Forgejo; GitLab's CI variables are already there. */
  decideTokenEnv?: string;
  /** A bucket for plan reports, besides the job's artifact. */
  reports?: PlanReportInput["reports"];
  /** Set when `modules.publish` or `modules.registry` is: the pipeline gets a job that publishes changed modules after apply. */
  publish?: boolean;
  /** `modules.registry.bucket`: the publish job gets the bucket's key secrets, as a job that writes reports does (GitHub and Forgejo). */
  publishBucket?: string;
  /** Set when `modules.attest` is: the publish job gets the signing key's two secrets (GitHub and Forgejo; GitLab's CI variables are already there). */
  attest?: boolean;
  /** Set when `modules.publish` names a `gitlab://` project: the secret the publish job passes as `GITLAB_TOKEN` (`modules.gitlab_token`, GitHub and Forgejo; GitLab's CI variables are already there). */
  publishGitlabToken?: string;
  /** A cron schedule: the pipeline gets a drift job that runs on it. */
  drift?: string;
  /** `templates:` is set: the request workflow, on GitHub and Forgejo. */
  templates?: boolean;
  /** `rollouts:`, when `respond.rollout` is not off: the cron of the job that continues every rollout in flight. */
  rollouts?: string;
  /** `control`, settled: after the last apply succeeds on the default branch, a job sends the control repo a dispatch (control-repo.ts). */
  control?: ResolvedControl;
  /** GitLab only: the comments schedule's cron. The pipeline gets a `comments` job for the pipelines that schedule starts. */
  comments?: string;
  /**
   * `apply.resume`: minutes between the resume job's runs. On GitHub and
   * Forgejo the job is a workflow of its own on that schedule; on GitLab a
   * pipeline schedule with TERRAGUCCI_SCHEDULE=resume starts it.
   */
  resume?: number;
  /** GitLab only, `gitlab.token`: with `protected`, no merge request pipeline holds the token, and the comments job posts the plan notes. */
  gitlabToken?: GitLabToken;
  /** Globs for the canary wave, which applies first. Plain roots only: a Terragrunt repo's layers are its waves already. */
  canary?: string[];
  /** `waves.jobs`: the most jobs one wave's roots or units spread across. A wave of more than one gets a job that decides it and a share job per part (GitHub and Forgejo). */
  waveJobs?: number;
  /** When a wave waits for an approval. Default on-destructive. */
  gate?: Gate;
  /** A control repo's `approval:`, which the project's repo has no config to carry: the waves' `--approval`. */
  approval?: Approval;
  /** `approval: pr-review`: on GitHub and Forgejo the plan job and a review job post `terragucci/approval` on the pull request's head. */
  prReview?: boolean;
  /** `agent.login`: the agent's account, which the plan note and `terragucci/approval` never count as an approver (./involved.ts). */
  agentLogin?: string;
  /** The response to each event, from `respond:`; the jobs call `terragucci respond` for each one that is not off. */
  respond?: Partial<Record<RespondEvent, string>>;
  /** `policy:` is set; the check job then runs the policy's tests, which read the policy from the default branch, so it clones with full history. */
  policy?: boolean;
  /** `agent.comment` is set: `/terragucci agent <ask>` gets the agent and agent-push jobs (render-agent.ts). GitHub and Forgejo only. */
  agentComment?: AgentCommentInput;
  /** `agent.drift` is set: when the drift job opens the drift issue, the drift-agent and drift-agent-push jobs open a pull request with an agent's change (render-agent.ts). GitHub and Forgejo only. */
  agentDrift?: AgentCommentInput;
  /** `atlantis_comments: true`: `atlantis plan` and `atlantis apply` comments start the jobs `/terragucci plan` and `/terragucci apply` do, and every job gets TG_ATLANTIS_COMMENTS=1, so the comment commands read them (comment.ts). */
  atlantisComments?: boolean;
  /** `review.agent` is on: the review workflow, run from the default branch, reviews a pull request after its plan (render-review.ts). GitHub and Forgejo only. */
  review?: ReviewInput;
  /** `apply.when: pull-request`: an open pull request applies on `/terragucci apply` (on GitLab through the comments job and the waves' pipeline it starts), and the push after the merge only confirms. In a Terragrunt repo its waves are the waves of units. */
  applyWhen?: ApplyWhen;
  /** `apply.merge`: with `auto`, a pull request whose every wave applied is merged. */
  applyMerge?: ApplyMerge;
  /** `apply.merge_token_env`: the secret whose token the `pr-merge` job merges with, in place of the job's own. Only that job gets it; on GitLab the comments job too, which starts the waves' pipeline with it. */
  applyMergeTokenEnv?: string;
  /** `apply.requires`: what an open pull request needs before it applies. Every requirement when unset. */
  applyRequires?: ApplyRequire[];
  /** `locks: plan`: the `pr-lock` job locks a pull request's roots from its first plan (GitHub and Forgejo). */
  locksPlan?: boolean;
  /** `apply.branches`: a push to a named branch runs the apply waves for that branch's roots alone, and the default branch skips them. Plain roots, `apply.when: merge`. */
  applyBranches?: Record<string, string[]>;
  /** `own_jobs`: jobs of the repo's own, written after terragucci's as they are (ownJobsYAML). */
  ownJobs?: Record<string, Record<string, unknown>>;
  /**
   * `ephemeral`: a pull request's job applies its copy of the ephemeral roots
   * and destroys it when the pull request closes, and a sweep on a schedule of
   * `sweep` minutes destroys the copies whose TTL passed or whose pull request
   * closed (ephemeral.ts). The roots and the TTL are read from terragucci.yml
   * at base when the jobs run, so the pipeline carries only the schedule.
   */
  ephemeral?: { sweep: number };
  /** `runner`: the runner each job runs on, as `runs-on` (GitHub, Forgejo) or `tags` (GitLab); see placeJobs. Unset, every job keeps the default. */
  runner?: RunnerSettings;
  /** `pass`: secret and variable names the jobs that plan, apply and check drift get as environment variables (GitHub and Forgejo). */
  pass?: PassSettings;
  /**
   * One apply job per identity (./cloud-identity.ts): each wave of plain roots gets a
   * job that plans every root with the plan identities and decides the gate,
   * and a job per group with roots in the wave, with the group's identities,
   * runner, forge environment and audience. Unset, a wave applies in one job.
   */
  applyGroups?: ApplyGroup[];
}

/**
 * A job of the pipeline that applies roots, as the rendered workflow names it:
 * what `terragucci.components.json` lists under `pipeline.jobs` (./components-decl.ts).
 */
export interface PipelineApplyJob {
  name: string;
  /** Its `needs`, as the workflow has them: wave 1's job needs `check` on GitHub and Forgejo, and nothing on GitLab. */
  needs: string[];
  /** The wave it runs; unset for a job that applies no single wave. */
  wave?: number;
  /** The roots it applies: a wave's, a share's or a group's. A job that only decides a split wave, or only says every wave applied, applies none. */
  applies: string[];
}

export interface RenderedPipeline {
  path: string;
  content: string;
  /** The jobs that apply roots, built from the same list the workflow's jobs are. */
  applyJobs: PipelineApplyJob[];
  /** Further workflow files on GitHub and Forgejo: the resume workflow, the review workflow with `review.agent`, the rollout workflow with `rollouts`, and the request workflow with `templates`. */
  extra?: { path: string; content: string }[];
}

/** The resume workflow's file, beside the pipeline's. A workflow of its own, since Forgejo does not say which of a workflow's schedules started a run. */
export const RESUME_PATHS: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: ".github/workflows/terragucci-resume.yml",
  forgejo: ".forgejo/workflows/terragucci-resume.yml",
};

/** The day-2 action workflow (./action.ts), beside the pipeline (GitHub and Forgejo). behold dispatches it by this name with inputs `root` and `address`. */
export const ACTION_WORKFLOW = "terragucci-action.yml";
export const ACTION_PATHS: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: `.github/workflows/${ACTION_WORKFLOW}`,
  forgejo: `.forgejo/workflows/${ACTION_WORKFLOW}`,
};
/** The action workflow's workflow_dispatch inputs. */
export const ACTION_INPUTS = {
  root: { description: "The root the action is in, a path from the repository root", required: true, type: "string" },
  address: { description: "The action's address, such as module.app.action.aws_lambda_invoke.rotate", required: true, type: "string" },
};

/** The first words of an action comment, as the jobs' conditions test them. */
const ACTION_COMMENT = "/terragucci action ";

/**
 * The action job's first step (./action.ts): `terragucci action --decide`
 * reads the comment or the dispatch from the event file, checks who asked,
 * the root and the address, and replies to a refusal. No credential is taken
 * before it says go.
 */
export function actionDecideScript(layers: string[][], forge: Exclude<ForgeName, "gitlab">): string {
  return [
    "set -uo pipefail",
    `terragucci action --decide --layers ${sh(layers.map((l) => l.join(",")).join(";"))}${forge === "forgejo" ? " --forge forgejo" : ""} --out terragucci-action.json || exit 1`,
    `node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).go?0:1)' terragucci-action.json || exit 0`,
    'echo "go=1" >>"$GITHUB_OUTPUT"',
  ].join("\n");
}

/**
 * The action job's second step: the apply credentials, then `terragucci
 * action --from`, which asks for the action as the person who asked, runs
 * it once an approval by someone else stands, and replies on the pull
 * request. A request that waits ends the step green: the reply carries the
 * approve line.
 */
export function actionRunScript(forge: Exclude<ForgeName, "gitlab">, oidc: OidcSettings | undefined): string {
  return [
    ...cloudLoginLines(forge, oidc, "apply", "terragucci-action"),
    "set -uo pipefail",
    `terragucci action --from terragucci-action.json${forge === "forgejo" ? " --forge forgejo" : ""}`,
    "code=$?",
    '[ "$code" -eq 3 ] && exit 0',
    'exit "$code"',
  ].join("\n");
}

/**
 * The resume job's action step: `terragucci action --resume --dry-run` lists
 * the requests an approval now stands for, and with none the step stops
 * before any credential; otherwise each runs as the person who asked. The
 * login's restart runs the step again from its top, past the list it made.
 */
export function actionResumeScript(forge: Exclude<ForgeName, "gitlab">, oidc: OidcSettings | undefined): string {
  const login = cloudLoginLines(forge, oidc, "apply", "terragucci-action");
  return [
    "set -uo pipefail",
    ...onceBeforeLogin(login, forge, ["terragucci action --resume --dry-run --out terragucci-actions.txt || exit 1", "[ -s terragucci-actions.txt ] || exit 0"]),
    ...login,
    "terragucci action --resume",
  ].join("\n");
}

/** The ephemeral sweep's workflow file, beside the pipeline's (GitHub and Forgejo). */
export const EPHEMERAL_PATHS: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: ".github/workflows/terragucci-ephemeral.yml",
  forgejo: ".forgejo/workflows/terragucci-ephemeral.yml",
};

/**
 * The ephemeral job's script (GitHub and Forgejo): on the pull request's
 * closed event its copy is destroyed, on any other its head's copy applies.
 * The job runs the default branch's workflow (pull_request_target) on its
 * checkout, and `terragucci ephemeral` checks the head out apart.
 */
export function ephemeralScript(forge: ForgeName, oidc: OidcSettings | undefined, binary: Binary, prelude?: string): string {
  return [
    ...cloudLoginLines(forge, oidc, "apply", "terragucci-ephemeral"),
    ...(prelude ? [prelude] : []),
    'if [ "${TG_ACTION:-}" = closed ]; then',
    `  terragucci ephemeral down --pr "$TG_PR" --reason closed --binary ${binary}`,
    "else",
    `  terragucci ephemeral up --pr "$TG_PR" --head "$TG_SHA" --binary ${binary}`,
    "fi",
  ].join("\n");
}

/**
 * The ephemeral job on GitLab, in the merge request's pipeline: the head's
 * copy applies, with terragucci.yml read from the default branch, fetched
 * first. GitLab starts no pipeline when a merge request closes, so the sweep
 * destroys a closed merge request's copy.
 */
export function gitlabEphemeralScript(oidc: OidcSettings | undefined, binary: Binary, prelude?: string): string {
  return [
    gitlabPushRemote,
    'git fetch -q origin "+refs/heads/${CI_DEFAULT_BRANCH}:refs/remotes/origin/${CI_DEFAULT_BRANCH}"',
    ...cloudLoginLines("gitlab", oidc, "apply", "terragucci-ephemeral"),
    ...(prelude ? [prelude] : []),
    `terragucci ephemeral up --pr "$CI_MERGE_REQUEST_IID" --head "\${CI_MERGE_REQUEST_SOURCE_BRANCH_SHA:-$CI_COMMIT_SHA}" --base "origin/\${CI_DEFAULT_BRANCH}" --binary ${binary}`,
  ].join("\n");
}

/** The sweep: destroy every copy whose TTL passed or whose pull request closed. */
export function ephemeralSweepScript(forge: ForgeName, oidc: OidcSettings | undefined, binary: Binary, prelude?: string): string {
  return [...(forge === "gitlab" ? [gitlabPushRemote] : []), ...cloudLoginLines(forge, oidc, "apply", "terragucci-ephemeral"), ...(prelude ? [prelude] : []), `terragucci ephemeral sweep --binary ${binary}`].join("\n");
}

/** The cron for `apply.resume`'s minutes. */
export const resumeCron = (minutes: number): string => (minutes >= 60 ? "0 * * * *" : `*/${minutes} * * * *`);

export class RenderError extends Error {}

/**
 * The remote a GitLab job pushes with: the server's own protocol, host and port.
 * CI_SERVER_FQDN carries the port when it is not the scheme's default (GitLab 16.10
 * and later), where CI_SERVER_HOST never does, so a GitLab on http or another port works.
 */
const gitlabPushRemote = 'git remote set-url origin "${CI_SERVER_PROTOCOL}://oauth2:${TG_TOKEN}@${CI_SERVER_FQDN}/${CI_PROJECT_PATH}.git"';

/** Whether the pipeline calls `terragucci respond` for an event: its setting is not off. */
const responds = (r: PipelineInput["respond"], event: RespondEvent): boolean => responseTo({ respond: r }, event) !== "off";

/**
 * A response that pushes or opens a pull request needs the forge token under the
 * name respond reads, and on GitLab a remote that can push. A response that
 * fails never fails the job: it is help on top of a result already decided.
 */
function respondSetup(forge: ForgeName, tokenEnv?: string): string[] {
  return [
    `export ${tokenEnv ?? DEFAULT_TOKEN_ENV[forge]}="$TG_TOKEN"`,
    ...(forge === "gitlab" ? [gitlabPushRemote] : []),
  ];
}

/**
 * The tips response: one small pull request per tip, from the default branch after the apply. A response that fails never
 * fails the job. With `synth` the job writes the roots first, as the apply did, so the tips read the same stacks.
 */
export function tipsScript(binary: Binary, forge: ForgeName, tokenEnv?: string, synth?: string): string {
  return ["set -u", ...(synth ? [synthScript(synth)] : []), ...respondSetup(forge, tokenEnv), `terragucci respond tips --mode apply --binary ${binary} || true`].join("\n");
}

/**
 * The rollout response: continue every rollout in flight, opening a wave's
 * pull requests once the last wave merged and applied. It runs alone on its
 * schedule, so a failure shows as the job's.
 */
export function rolloutScript(forge: ForgeName, tokenEnv?: string): string {
  return ["set -u", ...respondSetup(forge, tokenEnv), "terragucci respond rollout --mode apply"].join("\n");
}

/**
 * The rollout workflow's run (GitHub and Forgejo): with TG_MODULE, a person's start of that
 * rollout, where exit 3 (a wave already open, or its apply not yet reported) is no failure;
 * without it, the scheduled continue of every rollout in flight.
 */
export function rolloutDispatchScript(forge: Exclude<ForgeName, "gitlab">, tokenEnv?: string): string {
  return [
    "set -u",
    ...respondSetup(forge, tokenEnv),
    'if [ -n "${TG_MODULE:-}" ]; then',
    '  set -- "$TG_MODULE"',
    '  [ -z "${TG_VERSION:-}" ] || set -- "$@" "$TG_VERSION"',
    "  code=0",
    '  terragucci rollout "$@" --mode apply || code=$?',
    '  [ "$code" -eq 3 ] || exit "$code"',
    "else",
    "  terragucci respond rollout --mode apply",
    "fi",
  ].join("\n");
}

/**
 * The version-bump response: a release pull request per module whose next version the commits do not
 * settle, from the default branch after the apply. It needs the full history and the tags, and the
 * decision service's key when `decide:` is set. A response that fails never fails the job.
 */
export function versionBumpScript(forge: ForgeName, tokenEnv?: string): string {
  return ["set -u", ...respondSetup(forge, tokenEnv), "terragucci respond version-bump --mode apply || true"].join("\n");
}

/** Where `terragucci respond` writes an agent's input, kept with the job when a response is `agent`. */
const RESPOND_DIR = "terragucci-respond";

const sh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** The step that puts a pinned version the image does not carry on the path. */
export function installScript(binary: Binary | Tool, version: string, forge: ForgeName, sameShell = false): string {
  const dir = `dir="$(terragucci install ${binary} ${version})"`;
  // In a script that goes on to use it (GitLab's job, the drift Op's script), the PATH of this shell; else the next steps'.
  return forge === "gitlab" || sameShell ? `${dir}\nexport PATH="$dir:$PATH"` : `${dir}\necho "$dir" >> "$GITHUB_PATH"`;
}

/** The AWS CLI v2 release the drift job installs when attribution needs it; chant records each build's sha256. */
export const AWS_CLI = { version: "2.37.9" } as const;

/**
 * The line that installs AWS CLI v2 for drift attribution, skipped when the job
 * already has `aws`: chant's install line (chant#4952), which downloads and
 * unpacks with node, since the CI images carry node but not curl or unzip, and
 * checks the zip against the sha256 chant records before it runs the installer.
 */
export const awsCliScript = (): string => ciToolInstallLine("aws-cli", AWS_CLI.version, { download: "node", onPath: true });

/**
 * `synth`: the roots are written by a command (CDK Terrain's `npx cdktn
 * synth`), not committed, so each job that reads them runs it on its own
 * checkout first: after the commit to plan or apply is checked out, and
 * before any cloud credential is asked for. A command that fails ends the
 * job, with the status the job posts when one is given.
 */
export function synthScript(command: string, status?: string): string {
  return [
    "# synth in terragucci.yml: write the roots before reading them.",
    `( set -e; ${command} ) || { ${status ? `tg status ${status} failure "the synth command failed"; ` : ""}echo "terragucci: the synth command failed" >&2; exit 1; }`,
  ].join("\n");
}

export function checkScript(binary: Binary, roots: string[], synth?: string, rootPins = false, generate = false, atmos = false, sources = false, mirror = false, parallelism?: number): string {
  // With roots that pin their own version, each root inits and validates with its own binary, installed when the job's is not it.
  // The steps are the same in both shapes; `miss` is what a step that fails does: the serial loop goes on to the next root, the function returns.
  const steps = (miss: string): string[] => [
    // With `sources` set, a root using a module or provider outside the list at base is refused before its init downloads anything.
    ...(sources ? [`  terragucci check-sources "$dir" || ${miss}`] : []),
    ...(rootPins
      ? [
          `  bin="$(terragucci binary "$dir" --binary ${binary})" || ${miss}`,
          '  "$bin" -chdir="$dir" init -backend=false -input=false -no-color >/dev/null',
          '  terragucci check-root "$dir" --binary "$bin"',
        ]
      : [
          `  ${binary} -chdir="$dir" init -backend=false -input=false -no-color >/dev/null`,
          // validate's diagnostics and, for choudoufu, live-check's refusals go to the log and the check report; a root that fails does not stop the next.
          `  terragucci check-root "$dir" --binary ${binary}`,
        ]),
  ];
  const list = roots.map(sh).join(" ");
  // One root, or parallelism 1: the roots check one after another, as they always did.
  const limit = parallelism !== undefined && parallelism < roots.length ? parallelism : roots.length;
  const serial = roots.length < 2 || limit === 1;
  const loop = steps("{ failed=1; continue; }").map((l) => l.replace(/^(\s+(?:terragucci check-root|.*init) .*)$/, (m) => (m.includes("check-root") ? `${m} || failed=1` : m)));
  const parallel = [
    // Each root's init and check run in the background, writing to a file of their own; the files are printed in root order after the last one.
    // A step that fails ends only that root's function, and the root counts as failed through its status file.
    "tg_check() {",
    '  dir="$1"',
    ...steps("return 1").map((l) => (l.includes("init -backend=false") ? `  tg_init ${l.trim()} || return 1` : l)),
    "}",
    // The provider cache is not safe for inits that run together: with TF_PLUGIN_CACHE_DIR set, they take turns.
    "tg_init() {",
    '  if [ -n "${TF_PLUGIN_CACHE_DIR:-}" ]; then until mkdir "$tgtmp/init.lock" 2>/dev/null; do sleep 1; done; fi',
    '  "$@"; rc=$?',
    '  if [ -n "${TF_PLUGIN_CACHE_DIR:-}" ]; then rmdir "$tgtmp/init.lock"; fi',
    "  return $rc",
    "}",
    'tgtmp="$(mktemp -d)"',
    "n=0",
    `for dir in ${list}; do`,
    "  n=$((n+1))",
    // A bound below the number of roots: the next root starts when the one `limit` places back is done.
    ...(limit < roots.length ? [`  if [ "$n" -gt ${limit} ]; then eval "wait \\$tgpid$((n-${limit}))" || true; fi`] : []),
    '  { export TERRAGUCCI_CHECK_PART="$tgtmp/$n.md"; if tg_check "$dir"; then echo 0 >"$tgtmp/$n.rc"; else echo 1 >"$tgtmp/$n.rc"; fi; } >"$tgtmp/$n.out" 2>&1 &',
    '  eval "tgpid$n=$!"',
    "done",
    "wait",
    "n=0",
    `for dir in ${list}; do`,
    "  n=$((n+1))",
    '  cat "$tgtmp/$n.out"',
    '  if [ -s "$tgtmp/$n.md" ]; then',
    `    mkdir -p ${CHECK_DIR}; cat "$tgtmp/$n.md" >>${CHECK_DIR}/report.md`,
    '    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$tgtmp/$n.md" >>"$GITHUB_STEP_SUMMARY"; fi',
    "  fi",
    '  [ "$(cat "$tgtmp/$n.rc" 2>/dev/null)" = 0 ] || failed=1',
    "done",
  ];
  return [
    "set -eu",
    // An Atmos repo: its stack manifests must pass Atmos's own validation before the instances are written from them.
    ...(atmos ? ['ATMOS_TELEMETRY_ENABLED=false atmos validate stacks || { echo "terragucci: atmos validate stacks failed" >&2; exit 1; }'] : []),
    ...(synth
      ? [
          synthScript(synth),
          // The files git tracks, one directory at a time: what synth installs (node_modules) carries .tf files of its own.
          `git ls-files '*.tf' '*.tofu' '*.tfvars' | sed 's#/[^/]*$##; s#^[^/]*$#.#' | sort -u | while IFS= read -r d; do ${binary} fmt -check -diff "$d" || exit ${FMT_FINDING}; done`,
        ]
      : [`${binary} fmt -check -recursive -diff . || exit ${FMT_FINDING}`]),
    "failed=0",
    // With `generate` set, every generated backend, provider and version file must be what terragucci generate writes.
    ...(generate ? ["terragucci generate --check || failed=1"] : []),
    // With image.mirror set, the image's provider mirror must cover every lock file: a gap warns once, then fails.
    ...(mirror ? ["terragucci check-mirror || failed=1"] : []),
    ...(serial ? [`for dir in ${list}; do`, ...loop, "done"] : parallel),
    // With `policy:` set, the policy's own tests; no `policy:` key prints nothing.
    "terragucci check-policy || failed=1",
    'exit "$failed"',
  ].join("\n");
}

/**
 * tf-check's last step with `checkHooks` set: `terragucci ci check`, chant's
 * check stage (chant issue 4914), which runs `ci.hooks.check` read at base
 * over the roots, appends its section to the check report and fails the check
 * when a hook fails. A Terragrunt check stops at its first failing line, so
 * the step is its last line there; a plain check counts it with the rest.
 */
/**
 * With `control` set, the check job holds the project's consumers.json to its
 * roots' module pins (`terragucci modules consumers --check`, terragucci#1289),
 * so a publisher's catalog joins what the roots pin. On a chant without the
 * consumer scan the command says so and passes.
 */
export function withConsumersCheck(body: string, control: boolean, terragrunt: boolean): string {
  if (!control) return body;
  const line = "terragucci modules consumers --check";
  if (terragrunt) return `${body}\n${line}`;
  const lines = body.split("\n");
  const last = lines.pop();
  return [...lines, `${line} || failed=1`, last].join("\n");
}

export function withCheckHooks(body: string, roots: readonly string[], hooks: PipelineInput["checkHooks"], terragrunt: boolean): string {
  if (!hooks) return body;
  const line = `terragucci ci check --output ${CHECK_DIR}/hooks --summary ${CHECK_DIR}/report.md${roots.map((r) => ` ${sh(r)}`).join("")}`;
  if (terragrunt) return `${body}\n${line}`;
  const lines = body.split("\n");
  const last = lines.pop();
  return [...lines, `${line} || failed=1`, last].join("\n");
}

/**
 * The forge call the pipeline makes that is not something said on a pull
 * request or commit: whether a run still runs (`tg alive`, for the shared
 * apply lock of waves.jobs). Plain Node, because the CI images carry node
 * and git but not curl or jq. The OIDC token is chant's login's
 * (cloudLoginLines).
 */
const FORGE_API_JS = [
  "const [cmd, ...a] = process.argv.slice(1);",
  "const e = process.env, gl = e.TG_FORGE === \"gitlab\", tok = e.TG_TOKEN;",
  "try {",
  "  if (!tok) {",
  '    console.log("terragucci: no forge token, so no " + cmd);',
  '  } else if (cmd === "alive") {',
  '    const api = gl ? e.CI_API_V4_URL : e.GITHUB_API_URL || e.GITHUB_SERVER_URL + "/api/v1";',
  '    const repo = gl ? "projects/" + e.CI_PROJECT_ID : "repos/" + e.GITHUB_REPOSITORY;',
  '    const r = await fetch(api + "/" + repo + "/actions/runs/" + a[0], { headers: { "content-type": "application/json", ...(gl ? { "private-token": tok } : { authorization: "token " + tok }) } });',
  '    if (!r.ok) throw new Error("GET run " + a[0] + " answered " + r.status);',
  "    const run = await r.json();",
  '    console.log(["success", "failure", "cancelled", "skipped", "completed"].includes(run.status) ? "dead" : "alive");',
  "  }",
  "} catch (err) {",
  '  console.log("terragucci: " + cmd + " failed: " + err.message);',
  "}",
].join("\n");

/** GitLab's copy: a run is a pipeline there (`tg alive`). */
const FORGE_API_JS_GITLAB = FORGE_API_JS.replace(
  `"/actions/runs/" + a[0]`,
  `"/pipelines/" + a[0]`,
).replace(
  `["success", "failure", "cancelled", "skipped", "completed"]`,
  `["success", "failed", "canceled", "skipped"]`,
);

/**
 * Shell that defines `tg`. What a job says on the forge (`tg status`, `tg
 * reply`, `tg stale`) goes through `terragucci post`, which the
 * job's image carries (forge-post.ts); `tg alive` is the Node above.
 */
export function forgeApi(forge: ForgeName): string {
  return [
    `export TG_FORGE=${forge}`,
    `tg() { case "$1" in status|note|reply|stale) terragucci post "$@" ;; *) node --input-type=module -e '${forge === "gitlab" ? FORGE_API_JS_GITLAB : FORGE_API_JS}' -- "$@" ;; esac; }`,
  ].join("\n");
}

const AUDIENCE = "sts.amazonaws.com";

/** The AWS token's audience for a job of `stage`: `oidc.audience` as a string for every job, or its map's entry for the stage, else `sts.amazonaws.com`. */
export function stageAudience(oidc: OidcSettings | undefined, stage: AudienceStage): string {
  const a = oidc?.audience;
  if (a === undefined) return AUDIENCE;
  return typeof a === "string" ? a : (a[stage] ?? AUDIENCE);
}

/** The audience GCP's Workload Identity Federation accepts by default: the provider's full name. */
export const gcpAudience = (provider: string): string => `https://iam.googleapis.com/${provider}`;

/** The audience Entra ID accepts on a federated credential in the public cloud; `oidc.azure.audience` names a sovereign cloud's. */
export const AZURE_AUDIENCE = "api://AzureADTokenExchange";

/** Whether `oidc` names AWS roles: a pair for every root, or roles by root glob. */
const hasAws = (oidc: OidcSettings | undefined): boolean => Boolean((oidc?.plan_role && oidc.apply_role) || hasRootRoles(oidc));

const hasRootRoles = (oidc: OidcSettings | undefined): boolean => Boolean(oidc?.roles && Object.keys(oidc.roles).length > 0);

/**
 * `oidc` as the pipeline's steps log in with it. `terragruntToken`: a
 * Terragrunt repo's `credentials` name roles and `oidc` names no AWS role,
 * so the login writes the AWS token file alone, which the auth provider
 * assumes each unit's role with.
 */
export type LoginOidc = OidcSettings & { terragruntToken?: boolean };

/** `oidc`, with the AWS token file alone added when a Terragrunt repo's `credentials` need it and `oidc` names no AWS role. */
export function withTerragruntToken(oidc: OidcSettings | undefined, credentials: Record<string, RolePair> | undefined): LoginOidc | undefined {
  return credentials && Object.keys(credentials).length > 0 && !hasAws(oidc) ? { ...(oidc ?? {}), terragruntToken: true } : oidc;
}

/** The glob rules of one stage, as chant's login takes a cloud's `targets`. */
const loginTargets = <K extends string>(roles: Record<string, RolePair> | undefined, stage: "plan" | "apply", key: K): Array<{ targets: string[] } & Record<K, string>> | undefined =>
  roles && Object.keys(roles).length > 0 ? rootRoles(roles, stage).map(([glob, id]) => ({ targets: [glob], [key]: id }) as { targets: string[] } & Record<K, string>) : undefined;

/**
 * A stage's identities as chant's login spec (`@intentius/chant/ci-login`):
 * the AWS role, the GCP service account and the Azure client `oidc` names
 * for it, and with `roles` (under `oidc`, `gcp` or `azure`) the stage's
 * identities by root glob as each cloud's `targets`, which chant writes to
 * the CHANT_CLOUD_TARGETS file and rootRoleEnv hands each root (chant's
 * targetCloudEnv). Drift takes the plan identities. The AWS token carries
 * the audience of `audienceStage`, the job's stage (jobStage): drift's for
 * drift, and apply's for confirm, which plans with the plan identities from
 * an apply job. `oidc.gcp.token_url` is chant's `stsEndpoint`.
 */
export function loginSpec(oidc: LoginOidc | undefined, stage: "plan" | "apply", session: string, audienceStage: AudienceStage = stage): CloudLoginSpec {
  if (!oidc) return {};
  const plan = stage === "plan";
  const spec: CloudLoginSpec = {};
  if (hasAws(oidc) || oidc.terragruntToken) {
    const role = hasAws(oidc) ? (plan ? oidc.plan_role : oidc.apply_role) : undefined;
    const targets = loginTargets(oidc.roles, stage, "role");
    spec.aws = { ...(role ? { role } : {}), ...(targets ? { targets } : {}), audience: stageAudience(oidc, audienceStage), sessionName: session };
  }
  if (oidc.gcp) {
    const targets = loginTargets(oidc.gcp.roles, stage, "serviceAccount");
    spec.gcp = {
      provider: oidc.gcp.workload_identity_provider,
      serviceAccount: plan ? oidc.gcp.plan_service_account : oidc.gcp.apply_service_account,
      ...(targets ? { targets } : {}),
      ...(oidc.gcp.token_url ? { stsEndpoint: oidc.gcp.token_url } : {}),
    };
  }
  if (oidc.azure) {
    const targets = loginTargets(oidc.azure.roles, stage, "clientId");
    spec.azure = {
      tenantId: oidc.azure.tenant_id,
      clientId: plan ? oidc.azure.plan_client_id : oidc.azure.apply_client_id,
      subscriptionId: oidc.azure.subscription_id,
      ...(targets ? { targets } : {}),
      ...(oidc.azure.audience ? { audience: oidc.azure.audience } : {}),
    };
  }
  return spec;
}

/**
 * A step's cloud login, chant's (chant issues 4788, 4912 and 4930): per
 * cloud the forge's OIDC token in a file of its own and the variables the
 * cloud's tools read, in the step that runs them. On GitHub and Forgejo the
 * step logs in once, then starts again from its first line without the
 * token-request variables (ACTIONS_ID_TOKEN_REQUEST_URL and _TOKEN), so the
 * change's code (the synth command among it) and the binary cannot ask for
 * another token, on Forgejo the run's runtime token among them: the lines
 * go before any of that code (loginFirst), and a line above them that must
 * run once goes in onceBeforeLogin. On GitLab the job's `id_tokens` are read
 * and unset where the lines stand (loginInline). Nothing when the stage
 * names no identity.
 */
export function cloudLoginLines(forge: ForgeName, oidc: LoginOidc | undefined, stage: "plan" | "apply", session: string, audienceStage: AudienceStage = stage): string[] {
  const spec = loginSpec(oidc, stage, session, audienceStage);
  if (Object.keys(spec).length === 0) return [];
  return cloudLogin(forge, spec, forge === "gitlab" ? { sameStep: true } : { restart: true }).steps.flatMap((s) => s.run);
}

/**
 * `lines`, above a step's login, run once: on GitHub and Forgejo the login
 * starts the step again (cloudLoginLines), and the second pass skips them.
 * terragucci's own decision, say, runs before any credential.
 */
function onceBeforeLogin(login: readonly string[], forge: ForgeName, lines: string[]): string[] {
  return forge !== "gitlab" && login.length > 0 && lines.length > 0 ? [`if [ -z "\${${LOGIN_RESTART_MARKER}:-}" ]; then`, ...lines, "fi"] : lines;
}

/** A step's login (cloudLoginLines) at its top on GitHub and Forgejo, before the change's code; on GitLab, none (loginInline). */
const loginFirst = (forge: ForgeName, login: string[]): string[] => (forge === "gitlab" ? [] : login);

/** A step's login where a GitLab script logs in, after the synth command; on GitHub and Forgejo, none (loginFirst). */
const loginInline = (forge: ForgeName, login: string[]): string[] => (forge === "gitlab" ? login : []);

/** A GitLab job's `id_tokens:` for a stage's login, each `{ aud }`; none when the stage names no identity. */
export function loginIdTokens(oidc: LoginOidc | undefined, stage: "plan" | "apply", audienceStage: AudienceStage = stage): Record<string, { aud: string }> {
  const spec = loginSpec(oidc, stage, "terragucci", audienceStage);
  if (Object.keys(spec).length === 0) return {};
  return Object.fromEntries(Object.entries(cloudLogin("gitlab", spec).idTokens).map(([v, aud]) => [v, { aud }]));
}

/**
 * The first line of a script that reads a stage's exit code: the plan and
 * re-plan and the drift sweep. A step with `shell: bash` runs as
 * `bash --noprofile --norc -e -o pipefail {0}` on GitHub and on Forgejo's
 * runner, so without `set +e` a stage that fails, a wave that waits (3) or
 * one that is refused (4) ends the step at the stage, before its status, its
 * note, its response or the comment's reply. On GitLab these scripts run in
 * their own `bash` from a heredoc, which starts without `-e`; the line says
 * the same there, and the heredoc's `|| exit $?` hands its code to the job.
 */
export const READS_EXIT = "set +e -uo pipefail";

/** A job of chant's waves that applies roots, as the components declaration names it. */
interface ApplyJob {
  name: string;
  wave: number;
  /** The roots it applies (PipelineApplyJob.applies). */
  applies: string[];
}

/** Share `share` of `shares` of a wave's roots: sorted, cut into contiguous slices whose sizes differ by at most one, as chant's opWaveShare cuts them. */
export function shareRoots(roots: readonly string[], share: number, shares: number): string[] {
  const sorted = [...roots].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const base = Math.floor(sorted.length / shares);
  const extra = sorted.length % shares;
  const start = (share - 1) * base + Math.min(share - 1, extra);
  return sorted.slice(start, start + base + (share <= extra ? 1 : 0));
}

/**
 * The check's body on GitHub and Forgejo with respond.fmt on: it runs as
 * before, and when it exits FMT_FINDING (formatting found) the step says so
 * as its `finding` output, which starts chant's commit job (chant#4749).
 */
export function githubFindingBody(body: string): string {
  return ["set +e", "(", body, ")", "code=$?", `if [ "$code" -eq ${FMT_FINDING} ]; then echo "finding=true" >>"$GITHUB_OUTPUT"; fi`, 'exit "$code"'].join("\n");
}

/**
 * The check's body on GitLab with respond.fmt on: as before, and when it exits
 * FMT_FINDING the job leaves chant's finding dotenv, which starts the commit job.
 */
export function gitlabFindingBody(body: string): string {
  return [
    `mkdir -p ${gitlabFindingDir}`,
    "set +e",
    "(",
    body,
    ")",
    "code=$?",
    `if [ "$code" -eq ${FMT_FINDING} ]; then echo "CHANT_COMMIT_FINDING=1" >${gitlabFindingDir}/finding.env; else echo "CHANT_COMMIT_FINDING=0" >${gitlabFindingDir}/finding.env; fi`,
    'exit "$code"',
  ].join("\n");
}

/** Where chant's GitLab commit job reads the check's finding from. */
const gitlabFindingDir = ".chant/commit";

/**
 * The `pr-lock` job's script (`locks: plan`): `terragucci pr-lock` reads the
 * event and the change, takes or releases the locks and posts
 * `terragucci/lock`. A pull request held by another fails the status, not the
 * job: the job fails only when the locks could not be read or written.
 */
export function planLockScript(layers: string[][], forge: Exclude<ForgeName, "gitlab"> = "github", prMode = false, terragrunt = false): string {
  return [
    "set -euo pipefail",
    `terragucci pr-lock --layers ${sh(layers.map((l) => l.join(",")).join(";"))}${forge === "forgejo" ? " --forge forgejo" : ""}${prMode ? " --when pull-request" : ""}${terragrunt ? " --terragrunt" : ""}`,
  ].join("\n");
}

/** Shell for a Terragrunt job's credentials: the auth provider, with the AWS token file the step's login wrote (LoginOidc's `terragruntToken`). */
function terragruntCredentials(phase: "plan" | "apply", credentials?: Record<string, RolePair>): string[] {
  if (!credentials || Object.keys(credentials).length === 0) return [];
  return [credentialsScript(credentials, phase)];
}

/** Where a plan job's report is kept, and what the stage needs beyond the roots. */
export interface PlanReportInput {
  /** Copy the report to this bucket as well as keeping it with the job. */
  reports?: { bucket: string; endpoint?: string; prefix?: string; url?: string; role?: string };
  /** Globs for the canary wave the report shows. */
  canary?: string[];
  /** A Terragrunt repo: the stage runs Terragrunt, after this shell (credentials, caches); a re-plan's plan step, which holds traded credentials and no token, after `tradedPrelude`. */
  terragrunt?: { prelude: string; tradedPrelude?: string };
  /** respond.description is on: before the note is posted, flag a pull request whose description does not match its plan. */
  description?: boolean;
  /** `approval: pr-review`: after the note, post `terragucci/approval` on the head (review.ts). */
  prReview?: boolean;
  /** `synth`: the command that writes the roots, run on the checkout before the credentials. */
  synth?: string;
  /** `cost` is set: the confirm job's plan leaves the estimate out, since it posts no note. */
  cost?: boolean;
}

/**
 * The secrets a GitHub or Forgejo job that writes reports carries for the
 * static-keys route: empty when the repo has not made them. Not mapped when
 * `reports.role` is set, where the job assumes that role instead. GitLab jobs
 * already see the project's CI/CD variables, so they need no mapping.
 */
export const REPORT_KEY_SECRETS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;
/** An Azure container's account key; a GCS bucket has no static route, only the job's `oidc.gcp` identity. */
export const AZURE_KEY_SECRET = "AZURE_STORAGE_KEY";
function reportKeyEnv(forge: ForgeName, reports: PlanReportInput["reports"]): Record<string, string> {
  if (forge === "gitlab" || !reports || reports.role) return {};
  const scheme = /^(gs|az):\/\//.exec(reports.bucket.trim())?.[1];
  if (scheme === "gs") return {};
  const names = scheme === "az" ? [AZURE_KEY_SECRET] : REPORT_KEY_SECRETS;
  return Object.fromEntries(names.map((k) => [k, `\${{ secrets.${k} }}`]));
}

/** The plan report's directory in the job's workspace. */
export const REPORT_DIR = "terragucci-report";

/**
 * Where the note links the HTML report when the bucket's address is not
 * configured: the job's artifact on GitLab, the run elsewhere, where the
 * report is a download in the run's artifacts and the note says so. With
 * `reports.url` the stage links the bucket's copy instead.
 */
function reportUrl(forge: ForgeName): string {
  return forge === "gitlab"
    ? `"$CI_JOB_URL/artifacts/file/${REPORT_DIR}/report.html"`
    : '"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"';
}

/**
 * The plan verb, the product plan's `command` (./product-plan.ts): one
 * shell, run with bash, that plans the roots the change reaches and writes
 * the plan note hand-off for chant's note job.
 *
 * `terragucci stage tf-plan` plans in apply order and writes the plan report
 * (./report/store.ts), the note's data among it; `terragucci plan-handoff`
 * writes `pr-plan-note.json` from it: the note, the counts as the
 * terragucci/plan status's description, and the roots it covers as the
 * note's `terragucci:plan roots=` line. The step exits as the plan did.
 *
 * A re-plan reads its root from CHANT_PLAN_ARGUMENT and, with no pull
 * request event to name the target branch, its range from BASE_SHA. The
 * head is TG_SHA when the job sets it (a pull request's plan on GitHub and
 * Forgejo, whose checkout is the merge commit), else the commit checked out.
 * The plan identities come from chant's trade or login before this runs,
 * and the job's forge tokens are dropped before it, by chant.
 */
export function planVerbScript(binary: Binary, layers: string[][], forge: ForgeName, report: PlanReportInput = {}, options: { traded?: boolean } = {}): string {
  const args = [
    "--out", REPORT_DIR,
    "--binary", binary,
    "--layers", sh(layers.map((l) => l.join(",")).join(";")),
    "--report-url", reportUrl(forge),
    '${TG_ROOT:+--root "$TG_ROOT"}',
    ...(report.canary?.length ? ["--canary", sh(report.canary.join(","))] : []),
    ...(report.terragrunt ? ["--terragrunt"] : []),
    ...(report.reports ? ["--bucket", sh(report.reports.bucket)] : []),
    ...(report.reports?.endpoint ? ["--bucket-endpoint", sh(report.reports.endpoint)] : []),
    ...(report.reports?.prefix ? ["--bucket-prefix", sh(report.reports.prefix)] : []),
    ...(report.reports?.url ? ["--bucket-url", sh(report.reports.url)] : []),
  ];
  return [
    "bash <<'PLAN' || exit $?",
    // Off first: every later line reads an exit code itself.
    READS_EXIT,
    'export TG_SHA="${TG_SHA:-$(git rev-parse HEAD)}" TG_PR="${TG_PR:-${PR_NUMBER:-}}" TG_ROOT="${CHANT_PLAN_ARGUMENT:-}"',
    '[ -n "${GITHUB_BASE_REF:-}${CI_MERGE_REQUEST_TARGET_BRANCH_NAME:-}" ] || export TG_BASE="${TG_BASE:-${BASE_SHA:-}}"',
    ...(report.synth
      ? [
          "# synth in terragucci.yml: write the roots before reading them.",
          `( set -e; ${report.synth} ) || { echo "terragucci: the synth command failed" >&2; exit 1; }`,
        ]
      : []),
    ...(report.terragrunt ? [options.traded ? report.terragrunt.tradedPrelude ?? report.terragrunt.prelude : report.terragrunt.prelude] : []),
    `terragucci stage tf-plan ${args.join(" ")}`,
    "rc=$?",
    ...(report.description ? [`[ ! -f ${REPORT_DIR}/report.json ] || terragucci respond description --mode apply --report ${REPORT_DIR} || true`] : []),
    `terragucci plan-handoff --report ${REPORT_DIR} --env ${PLAN_ENV} --exit "$rc"`,
    "PLAN",
  ].join("\n");
}

/**
 * The variables a GitHub or Forgejo step asks for an OIDC token with. A
 * re-plan's plan step starts again without them too: any token they serve
 * there carries the default branch's subject, which the apply identities
 * trust, and the step runs the pull request's code.
 */
export const OIDC_REQUEST_VARS = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"] as const;

/**
 * The first line of a GitHub or Forgejo step that runs the change's code:
 * chant's dropForgeTokens, with TG_TOKEN and TG_MERGE_TOKEN dropped too. The
 * step's shell starts again, with `exec`, without any forge token variable:
 * Forgejo's runner gives every step the run's token (as GITHUB_TOKEN,
 * GITEA_TOKEN and ACTIONS_RUNTIME_TOKEN) whatever `permissions:` says, and
 * `unset` alone would leave it in the shell's own process environment, which
 * the shell's children can read. The OIDC request variables stay unless
 * `oidcRequest`: the step asks for its cloud role with them.
 *
 * The restart needs the step's script file (a runner runs `<shell> <file>`,
 * so `$0` is its path, never the shell's own) and `env` and the shell on the
 * PATH. When any of them is missing (the script given to `sh -c`, or no PATH), the shell does not
 * restart and drops the variables with `unset`, so its children still start
 * without them, and the script runs on. A restarted step has CHANT_NO_FORGE_TOKEN set.
 */
export function dropForgeTokens(shell: "bash" | "sh" = "bash", oidcRequest = false): string {
  return chantDropForgeTokens(shell, ["TG_TOKEN", "TG_MERGE_TOKEN", ...(oidcRequest ? OIDC_REQUEST_VARS : [])]);
}

/**
 * The note job's lines (the product plan's `noteSteps`) on GitHub and
 * Forgejo, in the job that holds the token and runs none of the change's
 * code. Before `pr-post`: the notice naming whose review does not count
 * toward a wave's approval (`terragucci plan-note`), written to the file
 * chant adds under the note's counts. After it, under `approval: pr-review`:
 * `terragucci/approval` on the head, from the same report. They read the
 * job's token as GITHUB_TOKEN, and the pull request and its head as
 * PR_NUMBER and HEAD_SHA.
 */
export function planNoteLines(forge: Exclude<ForgeName, "gitlab">, options: { prReview?: boolean; agentLogin?: string } = {}): { before: string[]; after: string[] } {
  const env = 'TG_TOKEN="$GITHUB_TOKEN" TG_PR="$PR_NUMBER" TG_SHA="$HEAD_SHA"';
  const agent = options.agentLogin ? ` --agent-login ${options.agentLogin}` : "";
  return {
    before: [`${env} terragucci plan-note --forge ${forge} --report ${REPORT_DIR} --notices "$CHANT_PLAN_NOTE_NOTICES"${agent} || true`],
    after: options.prReview ? [`[ ! -f ${REPORT_DIR}/report.json ] || ${env} terragucci approval-status --forge ${forge} --report ${REPORT_DIR}${agent} || true`] : [],
  };
}

/** The plan workflow's workflow_dispatch inputs: a pull request to re-plan, and optionally one root of it. */
export const REPLAN_INPUTS = {
  pr: { description: "The number of a pull request to re-plan", required: false, type: "string" },
  root: { description: "One root of it to re-plan, a path from the repository root", required: false, type: "string" },
};
/** A dispatch that names a pull request: the replan job's, never the drift job's. */
export const REPLAN_DISPATCH = "(github.event_name == 'workflow_dispatch' && github.event.inputs.pr != '')";
/** Forgejo's concurrency group for such a dispatch: the pull request's comment group, not the default branch's, whose runs apply. */
const DISPATCH_GROUP = `${REPLAN_DISPATCH} && format('comment-{0}', github.event.inputs.pr)`;

/** The pipeline variable that tells the comments schedule's pipelines from drift's on GitLab. */
export const SCHEDULE_VAR = "TERRAGUCCI_SCHEDULE";

/**
 * The values of SCHEDULE_VAR that name terragucci's other GitLab schedules.
 * The drift job runs for every schedule whose SCHEDULE_VAR is none of them,
 * and the plan job's overdue check asks chant for the same schedules
 * (./report/overdue.ts).
 */
export const OTHER_SCHEDULES = ["comments", "resume", "rollouts", "ephemeral", PLAN_NOTES_SCHEDULE] as const;

/** The GitLab environment whose jobs see apply.merge_token_env's variable when it is scoped to it: comments and pr-merge, which run no merge request code. */
export const MERGE_ENVIRONMENT = "terragucci-merge";

/**
 * The comments job's script (GitLab). `terragucci comment --poll` reads the
 * merge request notes since the last polls, answers each `/terragucci` note
 * once, and starts or retries pipelines through the API. It runs nothing
 * itself: no plan, no apply and no cloud credentials. The plan notes are
 * chant's plan-note job's, in the plan notes pipeline.
 */
export function commentsScript(layers: string[][], prApply?: { requires?: ApplyRequire[]; waves?: number }, start: { agent?: boolean | "chant"; review?: boolean } = {}): string {
  const requires = prApply?.requires && !APPLY_REQUIRES.every((r) => prApply.requires!.includes(r)) ? ` --requires ${prApply.requires.length ? prApply.requires.join(",") : "none"}` : "";
  // Before merge the decision names the waves by number, so the poll is told how many there are (the canary wave counts).
  const waves = prApply?.waves !== undefined && prApply.waves !== layers.length ? ` --waves ${prApply.waves}` : "";
  return `terragucci comment --forge gitlab --poll --layers ${sh(layers.map((l) => l.join(",")).join(";"))}${prApply ? ` --when pull-request${requires}${waves}` : ""}${start.agent === "chant" ? " --agent chant" : start.agent ? " --agent on" : ""}${start.review ? " --review" : ""}`;
}

/**
 * The publish job's script. It needs the whole history and the module tags
 * (publish reads the last release from them), and on GitLab a remote that can
 * push, since the job's checkout carries no write credentials.
 */
export function publishScript(forge: ForgeName): string {
  return [
    "set -eu",
    ...(forge === "gitlab"
      ? [
          gitlabPushRemote,
          'git fetch --quiet --tags origin',
        ]
      : []),
    "terragucci publish",
  ].join("\n");
}

/**
 * The scheduled stage: `terragucci stage tf-drift` plans every root with
 * -refresh-only, writes the plan report, and keeps the drift issue. A root
 * that cannot be refreshed fails the job; drift alone does not.
 */
export function driftScript(binary: Binary, layers: string[][], forge: ForgeName = "github", oidc?: PipelineInput["oidc"], report: PlanReportInput = {}, pullRequest?: { tokenEnv?: string }, notify = false, agent: false | "chant" = false): string {
  const args = [
    "--out", REPORT_DIR,
    "--binary", binary,
    "--forge", forge,
    "--layers", sh(layers.map((l) => l.join(",")).join(";")),
    "--report-url", reportUrl(forge),
    ...(report.terragrunt ? ["--terragrunt"] : []),
    ...(report.reports ? ["--bucket", sh(report.reports.bucket)] : []),
    ...(report.reports?.endpoint ? ["--bucket-endpoint", sh(report.reports.endpoint)] : []),
    ...(report.reports?.prefix ? ["--bucket-prefix", sh(report.reports.prefix)] : []),
    ...(report.reports?.url ? ["--bucket-url", sh(report.reports.url)] : []),
  ];
  const login = cloudLoginLines(forge, oidc, "plan", "terragucci-drift", "drift");
  return [
    ...loginFirst(forge, login),
    READS_EXIT,
    // The stage keeps the issue itself.
    ...(report.synth ? [synthScript(report.synth)] : []),
    ...loginInline(forge, login),
    ...(report.terragrunt ? [report.terragrunt.prelude] : []),
    `terragucci stage tf-drift ${args.join(" ")}`,
    ...(pullRequest || notify || agent ? ["rc=$?"] : []),
    // With agent.drift, the step's outputs say whether this run opened the drift issue, and which; the drift-agent jobs run when it did.
    // On chant's drift Op (terragucci#1305) the run exits with chant's drift code instead, which starts chant's agent jobs.
    ...(agent === "chant" ? chantDriftExitLines(DRIFT_ISSUE_JS, `${REPORT_DIR}/${DRIFT_ISSUE_FILE}`) : []),
    ...(report.synth && !pullRequest ? [`echo "terragucci: no drift pull request: ${report.synth === ATMOS_WRITE ? ATMOS_DRIFT_PR_SHORT : SYNTH_DRIFT_PR_SHORT}"`] : []),
    // With notify, drift goes to Slack and Teams with a Re-plan button; a webhook that fails never fails the job.
    ...(notify ? [`terragucci notify drift --report ${REPORT_DIR} || true`] : []),
    // The drift pull request: a person reviews and merges it, or closes it.
    ...(pullRequest ? [...respondSetup(forge, pullRequest.tokenEnv), `if [ "$rc" -eq 0 ]; then terragucci respond drift --mode apply --binary ${binary} || true; fi`] : []),
    ...(pullRequest || notify || agent ? ['exit "$rc"'] : []),
  ].join("\n");
}

/** The roots of a plan report that plan a change, comma-separated. */
const CHANGED_JS = 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));console.log(r.roots.filter((x)=>(x.changes||[]).some((c)=>c.action!=="read"&&c.action!=="no-op")).map((x)=>x.path).join(","))';

/**
 * With `apply.when: pull-request`, the push to the default branch after a
 * merge applies nothing: its pull request applied before it merged. The
 * confirm job plans every root with the read-only role, keeps the plan
 * report, and posts `terragucci/apply` on the commit: success when every
 * root plans no change, failure naming the roots that still plan one (a
 * change pushed without a pull request, or the world moving since the apply).
 * In a Terragrunt repo it plans every unit with `--terragrunt`, after the plan
 * jobs' prelude (caches, the auth provider's plan roles).
 */
export function confirmScript(binary: Binary, layers: string[][], forge: ForgeName = "github", oidc?: PipelineInput["oidc"], report: PlanReportInput = {}): string {
  const args = [
    "--out", REPORT_DIR,
    "--binary", binary,
    "--layers", sh(layers.map((l) => l.join(",")).join(";")),
    "--report-url", reportUrl(forge),
    ...(report.reports ? ["--bucket", sh(report.reports.bucket)] : []),
    ...(report.reports?.endpoint ? ["--bucket-endpoint", sh(report.reports.endpoint)] : []),
    ...(report.reports?.prefix ? ["--bucket-prefix", sh(report.reports.prefix)] : []),
    ...(report.reports?.url ? ["--bucket-url", sh(report.reports.url)] : []),
    ...(report.terragrunt ? ["--terragrunt"] : []),
    ...(report.cost ? ["--no-cost"] : []),
  ];
  const what = report.terragrunt ? "unit" : "root";
  // confirm is an apply job (jobStage): the plan identities, with the apply audience.
  const login = cloudLoginLines(forge, oidc, "plan", "terragucci-confirm", "apply");
  return [
    ...loginFirst(forge, login),
    READS_EXIT,
    forgeApi(forge),
    ...(report.synth ? [synthScript(report.synth, "terragucci/apply")] : []),
    ...loginInline(forge, login),
    ...(report.terragrunt ? [report.terragrunt.prelude] : []),
    'tg status terragucci/apply pending "confirming the merge applied"',
    `terragucci stage tf-plan ${args.join(" ")}`,
    "rc=$?",
    `if [ "$rc" -ne 0 ] || [ ! -f ${REPORT_DIR}/report.json ]; then`,
    '  tg status terragucci/apply failure "the plan after the merge failed"',
    "  exit 1",
    "fi",
    `changed="$(node -e '${CHANGED_JS}' ${REPORT_DIR}/report.json)"`,
    'if [ -n "$changed" ]; then',
    `  echo "applied before merge, and these ${what}s still plan a change: $changed"`,
    `  tg status terragucci/apply failure "${what}s still plan a change after the merge: $changed"`,
    "  exit 1",
    "fi",
    `tg status terragucci/apply success "applied before merge; every ${what} plans no change"`,
  ].join("\n");
}

function header(image: string, fromConfig?: boolean): string {
  return [
    MARKER,
    "# terragucci writes this file from terragucci.yml, or from its defaults when",
    "# the repo has none. Change terragucci.yml and run `npx terragucci init`",
    "# rather than editing it here.",
    fromConfig
      ? `# Every job runs in ${image}, the image terragucci.yml names.`
      : image.includes("@")
      ? `# Every job runs in ${image.split("@")[0]}, pinned by digest.`
      : `# Every job runs in ${image}; init pins its digest once the image is published.`,
    "",
  ].join("\n");
}

/** Keys of a GitLab pipeline that are not jobs, so no job of your own may take one as its name. */
const GL_KEYWORDS_NOT_JOBS = ["default", "include", "stages", "variables", "workflow", "image", "services", "cache", "before_script", "after_script", "pages", "spec"];

/** The line above the jobs `own_jobs` adds, which says where they come from. */
export const OWN_JOBS_LINE = "# Your own jobs, from own_jobs in terragucci.yml, as they are there.";

/**
 * `own_jobs`, after the jobs terragucci writes: on GitHub and Forgejo under
 * the workflow's `jobs:`, which the serializer writes last, and on GitLab as
 * top-level jobs. Each job is written as it is. A name terragucci already
 * gives a job, or one GitLab reads as a keyword, is refused.
 */
export function ownJobsYAML(own: PipelineInput["ownJobs"], ours: string[], forge: ForgeName): string {
  if (!own || Object.keys(own).length === 0) return "";
  for (const name of Object.keys(own)) {
    if (ours.includes(name)) throw new RenderError(`own_jobs.${name}: terragucci writes a job of that name; give yours another`);
    if (forge === "gitlab" && GL_KEYWORDS_NOT_JOBS.includes(name)) throw new RenderError(`own_jobs.${name}: GitLab reads ${name} as a keyword, not a job; give yours another name`);
  }
  const indent = forge === "gitlab" ? 0 : 1;
  return [`${forge === "gitlab" ? "" : "  "}${OWN_JOBS_LINE}`, ...Object.entries(own).map(([name, job]) => emitYAMLEntry(name, job, indent))].join("\n") + "\n";
}

function text(result: string | { primary: string }): string {
  return typeof result === "string" ? result : result.primary;
}

/** The comments the pipeline's jobs answer, and the words they start with. */
interface CommentWords {
  prefix: string;
  plan: string;
  apply: string;
  lock: string;
  unlock: string;
  alias: { plan: string; apply: string };
}

/**
 * The comments the jobs answer. chant's product pipeline (chant#4550)
 * `productPipelineJobs` takes terragucci's words, refuses them when a command
 * names a job this pipeline lacks, and names each comment; the waves spec it
 * gives must keep op `tf-apply` and gates `wave-{k}`, so the approvals
 * already on the ledger keep counting.
 */
function commentWords(input: PipelineInput, forge: ForgeName, prApply: boolean, locksPlan: boolean): CommentWords {
  const own: CommentWords = {
    prefix: "/terragucci",
    plan: "/terragucci plan",
    apply: "/terragucci apply",
    lock: "/terragucci lock",
    unlock: "/terragucci unlock",
    alias: { plan: "atlantis plan", apply: "atlantis apply" },
  };
  const count = input.terragrunt ? input.layers.length : undefined;
  const spec = wavesSpec({ waves: count ?? input.layers, gate: "always", approval: "ledger", call: waveCallArgv, migrations: false });
  // chant refuses a command with no job to answer it, so the words name only the commands this pipeline has jobs for.
  const locks = locksPlan || prApply;
  const has: CiProductCommand[] = ["plan", "apply", ...(locks ? (["lock", "unlock"] as const) : []), ...(input.agentComment ? (["agent"] as const) : [])];
  const words = { ...TERRAGUCCI_WORDS, commands: Object.fromEntries(Object.entries(TERRAGUCCI_WORDS.commands).filter(([, c]) => has.includes(c))) };
  const jobs = productPipelineJobs(forge, "default", {
    words,
    // The apply on merge runs on op waves; with apply.when: pull-request the comment applies the open pull request.
    ...(prApply ? { applyBeforeMerge: true } : { waves: spec }),
    ...(locks ? { locks: "plan" as const } : {}),
    ...(input.agentComment ? { agent: true } : {}),
  });
  const named = jobs.waves?.spec;
  if (named && (named.name !== WAVES_OP || (named.gateName ?? "{gate}-wave-{k}") !== "wave-{k}")) {
    throw new RenderError(`chant names the waves ${named.name} / ${named.gateName ?? "{gate}-wave-{k}"}, and the approvals on _gates/${WAVES_OP}.jsonl are under ${WAVES_OP} / wave-{k}`);
  }
  const line = (c: CiProductCommand, fallback: string): string => jobs.comments[c] ?? commentLine(jobs.words, c) ?? fallback;
  const alias = (c: CiProductCommand, fallback: string): string => jobs.words.aliases.find((a) => a.command === c)?.from ?? fallback;
  return {
    prefix: `/${jobs.words.product}`,
    plan: line("plan", own.plan),
    apply: line("apply", own.apply),
    lock: line("lock", own.lock),
    unlock: line("unlock", own.unlock),
    alias: { plan: alias("plan", own.alias.plan), apply: alias("apply", own.alias.apply) },
  };
}

/** An environment with the unset entries left out. */
const definedEnv = (env: Record<string, string | undefined>): Record<string, string> => Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

export function renderPipeline(input: PipelineInput): RenderedPipeline {
  const { forge, binary, image, install, layers, env, tokenEnv, headersSecret } = input;
  const tg = input.terragrunt;
  // init validates both keys with the config; this holds for a pipeline input built another way, and for the forge init settled on.
  const keyProblems = [...(input.runner !== undefined ? runnerProblems(input.runner, "runner", forge) : []), ...(input.pass !== undefined ? passProblems(input.pass, "pass", env) : [])];
  if (keyProblems.length > 0) throw new RenderError(keyProblems.join("; "));
  // pass: the named secrets and variables, in the jobs that plan, apply and check drift, under terragucci's own keys so those win.
  const passed = passEnv(input.pass, forge);
  // waves.jobs: a wave of more roots than one job spreads across share jobs, after a job of its own plans it and decides its gate.
  const waveJobs = input.waveJobs !== undefined && input.waveJobs > 1 ? input.waveJobs : undefined;
  if (waveJobs && input.applyWhen === "pull-request") throw new RenderError(`waves.jobs: ${WAVE_JOBS_NOT_PR_APPLY}`);
  const credentials = tg?.credentials && Object.keys(tg.credentials).length > 0 ? tg.credentials : undefined;
  // The steps' login: with Terragrunt's credentials and no AWS role in oidc, the AWS token file alone, which the auth provider reads.
  const oidc = withTerragruntToken(input.oidc, credentials);
  const applyBranches = input.applyBranches && Object.keys(input.applyBranches).length > 0 ? input.applyBranches : undefined;
  if (applyBranches && input.applyWhen === "pull-request") throw new RenderError(`apply.branches: ${BRANCHES_NOT_PR_APPLY}`);
  const branchNames = applyBranches ? Object.keys(applyBranches) : [];
  const ephemeral = input.ephemeral;
  // ephemeral in a Terragrunt repo: the jobs prepare units through Terragrunt, with the caches and the apply roles every apply job has.
  const ephemeralPrelude = ephemeral && tg ? [cacheExports(), ...terragruntCredentials("apply", credentials)].join("\n") : undefined;
  if (ephemeral && forge === "gitlab" && input.gitlabToken === "protected") throw new RenderError(`ephemeral: ${EPHEMERAL_NOT_PROTECTED}`);
  // approval: pr-review posts terragucci/approval from the plan job and a review job on GitHub and Forgejo; GitLab's approval rules do that there.
  const prReview = input.prReview === true && forge !== "gitlab";
  // agent.login is checked against a login's pattern (config.ts), so it is safe on a command line.
  const agentLogin = input.agentLogin && AGENT_LOGIN.test(input.agentLogin) ? input.agentLogin : undefined;
  // A job asks the forge for an OIDC token when it assumes a role, by oidc or by unit path.
  const needsToken = Boolean(oidc || credentials);
  // The canary wave comes from the repo's terragucci.yml at plan time, so a repo
  // with no config file gets the same pipeline as one whose config only sets waves.
  const report: PlanReportInput = {
    ...(input.reports ? { reports: input.reports } : {}),
    ...(responds(input.respond, "description") ? { description: true } : {}),
    ...(tg
      ? {
          terragrunt: {
            prelude: [cacheExports(), ...terragruntCredentials("plan", credentials)].join("\n"),
            tradedPrelude: [cacheExports(), ...(credentials && Object.keys(credentials).length > 0 ? [credentialsScript(credentials, "plan", true)] : [])].join("\n"),
          },
        }
      : {}),
    ...(prReview ? { prReview: true } : {}),
    ...(input.synth ? { synth: input.synth } : {}),
    ...(input.cost ? { cost: true } : {}),
  };
  const drift = input.drift;
  const rollouts = input.rollouts;
  const roots = layers.flat().sort();
  if (roots.length === 0) throw new RenderError(tg ? "there are no Terragrunt units to run" : "there are no roots to run");
  // A day-2 action (./action.ts) runs from a workflow of its own, for plain roots on Terraform, which alone invokes an action block.
  const actionFlow = forge !== "gitlab" && binary === "terraform" && !tg;
  const jobEnv = { TF_IN_AUTOMATION: "1", TF_INPUT: "0", ...(tg ? terragruntJobEnv(binary, tg) : {}), ...env, ...(input.atlantisComments ? { [ATLANTIS_COMMENTS_ENV]: "1" } : {}) };
  // Only the jobs that run a stage send telemetry (plan, apply, drift), so only they get the headers secret; check and publish never see it.
  const headersEnv = headersSecret ? { OTEL_EXPORTER_OTLP_HEADERS: forge === "gitlab" ? `$${headersSecret}` : `\${{ secrets.${headersSecret} }}` } : {};
  // The service's key reaches the jobs that ask it: the plan jobs for the description check, the drift job
  // when it attributes (plain roots and Terragrunt units alike), and the version-bump job.
  const decideSecret = input.decideTokenEnv ? { [input.decideTokenEnv]: `\${{ secrets.${input.decideTokenEnv} }}` } : {};
  const decideEnv = responds(input.respond, "description") ? decideSecret : {};
  const driftDecideEnv = responseTo({ respond: input.respond }, "drift") === "attribute" ? decideSecret : {};
  const bumpOn = responds(input.respond, "version-bump");
  const installs = [
    ...(tg ? tg.installs : install ? [{ tool: install.binary as Tool | Binary, version: install.version }] : []),
    ...(input.atmos ? [{ tool: "atmos" as Tool, version: input.atmos.version }] : []),
    // A Terramate repo: the release its prepare runs.
    ...(input.terramate ? [{ tool: "terramate" as Tool, version: input.terramate.version }] : []),
  ];
  const installStep = installs.length > 0 ? installs.map((i) => installScript(i.tool, i.version, forge)).join("\n") : undefined;
  const installName = `Install ${installs.map((i) => `${i.tool} ${i.version}`).join(", ")}`;
  const checkBody = withConsumersCheck(withCheckHooks(tg ? terragruntCheckScript(tg, binary) : checkScript(binary, roots, input.synth, input.rootPins === true, input.generate === true, input.atmos !== undefined, input.sources === true, input.mirror === true, input.parallelism), roots, input.checkHooks, tg !== undefined), input.control !== undefined, tg !== undefined);
  // The check hooks are read from the declaration at base, so the check job takes the history, as the policy tests do.
  const checkHistory = Boolean(input.policy) || input.mirror === true || input.terragrunt?.mirror === true || input.checkHooks !== undefined;
  // cost: the plan jobs, and the apply jobs that price a wave's plans for the policy and cost.approve_above, get the estimator's key
  // as INFRACOST_API_KEY, and Infracost unless cost.command names another estimator.
  const costEnv: Record<string, string> = input.cost ? { INFRACOST_API_KEY: forge === "gitlab" ? `$${input.cost.keySecret}` : `\${{ secrets.${input.cost.keySecret} }}` } : {};
  // GitLab gives every job the project's variables by name, so a key already named INFRACOST_API_KEY needs no mapping.
  const glCostEnv = input.cost && input.cost.keySecret !== "INFRACOST_API_KEY" ? costEnv : {};
  const costInstall = input.cost?.install ? installScript("infracost", INFRACOST_VERSION, forge) : undefined;
  // notify: the drift job posts drift to Slack and Teams, so it gets their secrets alone, never the generic webhook's.
  // The waves read notify from wavesInput (./render-waves.ts).
  const driftNotifyEnv = Object.fromEntries(
    ([["slack", "TERRAGUCCI_SLACK_WEBHOOK"], ["teams", "TERRAGUCCI_TEAMS_WEBHOOK"]] as const)
      .filter(([k]) => input.notify?.[k])
      .map(([k, v]) => [v, forge === "gitlab" ? `$${input.notify![k]}` : `\${{ secrets.${input.notify![k]} }}`]),
  );
  const driftNotify = Object.keys(driftNotifyEnv).length > 0;
  // A wave per job, each behind its gate. A Terragrunt repo's layers are its units' dependency layers, canary first, as init found them;
  // the stage cuts them again from terragrunt find, and the last job also runs any wave past them.
  const waveCount = tg ? layers.length : applyWaves(layers, input.canary).length;
  // With apply.when: pull-request a pull request applies before it merges, and the push after the merge runs the confirm job instead of the waves.
  const prApply = input.applyWhen === "pull-request";
  // A Terragrunt repo's layers are its waves already; the stage splits a wave's units across its share jobs as it cuts them.
  const cut = tg ? layers : applyWaves(layers, input.canary);
  const sharesOf = (i: number): number => (waveJobs && cut[i] ? shareCount(cut[i], waveJobs) : 1);
  // One apply job per identity, for plain roots: the groups' jobs of a wave apply side by side, as shares do.
  const groups = !tg && input.applyGroups && input.applyGroups.length > 0 ? input.applyGroups : undefined;
  const environmentGroups = groups?.some((g) => g.environment !== undefined) === true;
  if (environmentGroups) {
    // These apply every wave in one job with every group's identities, so environments refuse them (config check says so first).
    if (input.applyWhen === "pull-request") throw new RenderError(`apply.when: ${ENVIRONMENTS_PR_APPLY}`);
    if (input.resume && forge !== "gitlab") throw new RenderError(`apply.resume: ${ENVIRONMENTS_RESUME}`);
    if (input.ephemeral) throw new RenderError(`ephemeral: ${ENVIRONMENTS_EPHEMERAL}`);
  }
  // An environment's audience: every group's job, and the deciding job, fetch their tokens first and drop the token-request variables
  // (GitHub and Forgejo), so a job's code cannot ask for another environment's audience. GitLab declares each job's in id_tokens.
  // The jobs that apply roots, named as chant's wave jobs are (./render-waves.ts): a wave's job, each share's and each
  // group's. Before merge each wave's applying job applies it. Their needs come from the jobs the generator writes.
  const applyJobs: ApplyJob[] = [];
  for (let i = 0; i < waveCount; i++) {
    const wave = i + 1;
    const name = `apply-wave-${wave}`;
    if (groups) {
      for (const g of groups) {
        const mine = cut[i]!.filter((r) => g.roots.includes(r));
        if (mine.length === 0) continue;
        const n = waveJobs ? shareCount(mine, waveJobs) : 1;
        for (let s = 1; s <= n; s++) applyJobs.push({ name: n > 1 ? `${name}-${g.name}-share-${s}` : `${name}-${g.name}`, wave, applies: n > 1 ? shareRoots(mine, s, n) : mine });
      }
      continue;
    }
    const n = sharesOf(i);
    if (n > 1) for (let s = 1; s <= n; s++) applyJobs.push({ name: `${name}-share-${s}`, wave, applies: shareRoots(cut[i]!, s, n) });
    else applyJobs.push({ name, wave, applies: [...cut[i]!] });
  }
  // Forgejo pushes a merge as the user who asked for it, and refuses a push to a branch from the job's own token.
  if (prApply && input.applyMerge === "auto" && forge === "forgejo" && !input.applyMergeTokenEnv) throw new RenderError("apply.merge: auto on Forgejo needs apply.merge_token_env: Forgejo refuses a merge made with the job's own token, so name the secret holding the token of a user who may push to the default branch");
  // GitLab: the comments job reads `/terragucci apply` and starts the waves' pipeline before merge with the merge token.
  if (prApply && forge === "gitlab" && !input.comments) throw new RenderError(`apply.when: ${PR_APPLY_NEEDS_ON_GITLAB.comments}`);
  if (prApply && forge === "gitlab" && !input.applyMergeTokenEnv) throw new RenderError(`apply.when: ${PR_APPLY_NEEDS_ON_GITLAB.token}`);
  const locksPlan = input.locksPlan === true;
  if (locksPlan && forge === "gitlab") throw new RenderError(`locks: ${NO_GITLAB_PLAN_LOCKS}`);
  // shape: how the binary keeps applies apart (./apply-rows.ts); a repo-wide scope keeps a push's run apart from the next one's.
  const repoWide = applyScope(binary) === "repo";
  // The jobs after every wave applied wait for the last wave's status job; after a merge applied before it, for confirm.
  const lastApply = prApply ? "confirm" : "apply-done";
  // The waves on chant's Op waves generators (./render-waves.ts). The shape decides the jobs and their steps; each job renders
  // the rules from the spec file and terragucci.yml at base through `terragucci waves-spec`.
  const applyAudience = stageAudience(oidc, "apply");
  const azure = Boolean(input.oidc?.azure);
  const wavesInput: WavesInput = {
    forge,
    image,
    waves: cut,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(tg ? { terragrunt: { binary, ...(tg.exclude?.length ? { exclude: tg.exclude } : {}), parallelism: tg.parallelism } } : {}),
    shares: sharesOf,
    ...(groups ? { groups } : {}),
    ...(runnerOf(input.runner, "apply") !== undefined ? { runner: runnerOf(input.runner, "apply") } : {}),
    ...(needsToken && !azure ? { trade: applyTrade(input.oidc, credentials, input.reports?.role, env, applyAudience) } : {}),
    // One apply job per identity: the deciding job plans with the plan identities, and each group's job takes its own on its audience.
    ...(groups && needsToken && !azure ? { decideTrade: planTrade(input.oidc, credentials, input.reports?.role, env, stageAudience(oidc, "plan")) } : {}),
    ...(groups ? { groupTrade: (g: ApplyGroup) => (g.oidc ? applyTrade(g.oidc, credentials, undefined, env, g.audience ?? applyAudience) : undefined) } : {}),
    ...(needsToken && azure ? { azureLogin: loginSpec(oidc, "apply", "terragucci-apply") } : {}),
    setup: [
      ...(installStep ? [{ name: installName, run: installStep }] : []),
      ...(costInstall ? [{ name: `Install Infracost ${INFRACOST_VERSION}`, run: costInstall }] : []),
      ...(tg && forge !== "gitlab" ? [{ name: "Cache Terragrunt sources and providers", ...forgeCache(forge) }] : []),
    ],
    prelude: tg ? [cacheExports(), ...(credentials ? [credentialsScript(credentials, "apply", true)] : [])] : [],
    ...(input.synth ? { synth: synthScript(input.synth) } : {}),
    variables: forge === "gitlab" ? definedEnv({ ...jobEnv, ...headersEnv, ...glCostEnv }) : definedEnv({ ...passed, ...headersEnv, ...costEnv }),
    ...(forge === "gitlab" && tokenEnv && tokenEnv !== "GITLAB_TOKEN" ? { pipelineVariables: { CHANT_FORGE_TOKEN: `$${tokenEnv}` } } : {}),
    ...(responseTo({ respond: input.respond }, "apply-failed") === "agent" ? { agentInput: true } : {}),
    ...(input.review ? { review: true } : {}),
    branches: branchNames,
    ...(prApply ? { beforeMerge: { merge: input.applyMerge ?? "manual", ...(input.applyMergeTokenEnv ? { tokenSecret: input.applyMergeTokenEnv } : {}) } } : {}),
    ...(input.resume ? { resume: resumeCron(input.resume) } : {}),
    ...(input.notify ? { notify: input.notify } : {}),
    ...(input.respond ? { respond: input.respond as Record<string, string> } : {}),
    ...(input.control ? { control: input.control } : {}),
    ...(tg && forge === "gitlab" ? { cache: (forgeCache("gitlab") as { cache: unknown }).cache } : {}),
  };
  // The resume job is written whenever apply.resume is set, whatever the gate: a state migration waits in wave 1 under gate: never too.
  const what = tg ? "unit" : "root";
  // The fmt commit: the binary's fmt, and in a Terragrunt repo terragrunt hcl fmt too. The drift pull request, for roots and units:
  // respond finds a Terragrunt repo's drifted units in the stage's report. With synth the config refuses respond.drift:
  // pull-request (SYNTH_DRIFT_PR); attribute names who changed each attribute in the drift issue, and the job says why no
  // pull request follows.
  const fmtOn = responds(input.respond, "fmt");
  // init refuses these first, through the repo's shape (./shape.ts), in that shape's words; this holds for a pipeline input built another way.
  if (input.synth && drift && responseTo({ respond: input.respond }, "drift") === "pull-request") throw new RenderError(`respond.drift: ${input.atmos ? ATMOS_DRIFT_PR : SYNTH_DRIFT_PR}`);
  if (input.synth && rollouts) throw new RenderError(`rollouts: ${input.atmos ? ATMOS_ROLLOUTS : SYNTH_ROLLOUTS}`);
  const driftPr = !input.synth && responds(input.respond, "drift") ? { tokenEnv } : undefined;
  if (input.agentDrift && !drift) throw new RenderError("agent.drift runs when the drift job opens the drift issue; set drift to a cron schedule");
  if (input.agentDrift && driftPr) throw new RenderError(`respond.drift: ${AGENT_DRIFT_RESPOND}`);
  // Tips are pull requests from the default branch, for plain roots and Terragrunt repos alike.
  const tipsOn = responds(input.respond, "tips");
  // An agent response writes its input file; the job keeps it as an artifact.
  const agentDrift = !tg && responseTo({ respond: input.respond }, "drift") === "agent";
  // Attribution reads CloudTrail through the aws CLI, which the images do not carry.
  const awsStep = responseTo({ respond: input.respond }, "drift") === "attribute" ? awsCliScript() : undefined;

  // The plan jobs on chant's product plan (./product-plan.ts). The plan identities are traded before the change is
  // checked out (a re-plan's token carries the default branch's subject, which the apply identities trust); with
  // oidc.azure, whose provider and backend take only the token, the jobs log in instead.
  const planTradeSpec = needsToken ? planTrade(input.oidc, credentials, input.reports?.role, env, stageAudience(oidc, "plan")) : undefined;
  const planLogin = needsToken && !planTradeSpec ? loginSpec(oidc, "plan", "terragucci-plan") : undefined;
  const planInput: PlanJobsInput = {
    forge,
    image,
    command: planVerbScript(binary, layers, forge, report, { traded: planTradeSpec !== undefined }),
    // GitLab hands every job the project's variables, so its plan job needs only the pipeline's own.
    env: forge === "gitlab"
      ? definedEnv({ ...jobEnv, ...headersEnv, TG_SHA: "$CI_COMMIT_SHA", TG_BRANCH: "$CI_DEFAULT_BRANCH", TG_PR: "$CI_MERGE_REQUEST_IID", GIT_DEPTH: "0", ...glCostEnv })
      : definedEnv({ ...passed, TG_SHA: "${{ github.event.pull_request.head.sha }}", TG_PR: "${{ github.event.pull_request.number }}", ...headersEnv, ...decideEnv, ...costEnv, ...reportKeyEnv(forge, input.reports) }),
    ...(planTradeSpec ? { trade: planTradeSpec } : {}),
    ...(planLogin ? { login: planLogin } : {}),
    setup: [
      // GitLab: a project variable named by token_env reaches every job, so the plan job drops it before any of the change's code runs.
      ...(forge === "gitlab" ? [{ run: `unset ${[...new Set(["TG_TOKEN", "TG_MERGE_TOKEN", tokenEnv ?? "GITLAB_TOKEN"])].join(" ")}` }] : []),
      ...(installStep ? [{ name: installName, run: installStep }] : []),
      ...(costInstall ? [{ name: `Install Infracost ${INFRACOST_VERSION}`, run: costInstall }] : []),
      // The plan job restores the Terragrunt cache and saves none: a save is a step after the change's code.
      ...(tg && forge !== "gitlab" ? [{ name: "Restore the Terragrunt sources and providers cache", ...(forgeCacheRestore() as { uses: string; with: Record<string, unknown> }) }] : []),
    ],
    ...(tg && forge === "gitlab" ? { cache: (forgeCache("gitlab") as { cache: unknown }).cache } : {}),
    ...(input.control ? { control: input.control } : {}),
    // The note job asks when the drift job last ran and says so when it stopped.
    ...(drift ? { watches: [driftWatch(drift, forge)] } : {}),
    others: [],
    ...(input.atlantisComments ? { atlantis: true } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
  // chant's product pipeline gives the generator the apply status, the stale marking of the plan notes, the before-merge
  // mode and the names its comment job re-runs or dispatches by, from the same shape and names (./render-waves.ts).
  // On GitLab terragucci's comments poll decides the head before merge through chant (./comment-gitlab.ts), so the generator
  // takes the before-merge settings as they are.
  const wavesNames = wavesJobNames(cut.length);
  const wavesBm = prApply ? wavesBeforeMerge(forge, wavesInput.beforeMerge!, input.applyRequires) : undefined;
  // Before merge chant takes the locks of what the change reaches as it decides the head, in terragucci's lock file (gate tf-apply).
  const reachLine = prApply ? `terragucci reach --layers ${sh(layers.map((l) => l.join(",")).join(";"))}${tg ? " --terragrunt" : ""}` : undefined;
  const wavesProduct = productPipelineJobs(forge, PLAN_ENV, {
    // The waves' jobs answer apply; the plan's answer plan.
    words: { ...TERRAGUCCI_WORDS, commands: { plan: "plan", apply: "apply" }, aliases: [] },
    // GitLab's comments poll is terragucci's, and carries the reach line itself (CHANT_LOCK_REACH).
    productPlan: planOptions(planInput, { noReply: forge !== "gitlab", ...(reachLine && forge !== "gitlab" ? { reach: reachLine } : {}) }),
    waves: wavesShape(wavesInput),
    wavesSpecFile: WAVES_SPEC,
    wavesJobNames: wavesNames,
    applyStatus: true,
    // The plan notes a push made stale, marked beside wave 1 (chant's pr-post --stale, in place of terragucci's own).
    staleNotes: true,
    ...(forge !== "gitlab" ? { commentJob: { jobName: "apply-comment" }, ...(wavesBm ? { wavesBeforeMerge: wavesBm } : {}) } : {}),
  } as never) as { waves?: { pipeline: Record<string, unknown> } };
  const wavesPipeline = { ...(wavesProduct.waves?.pipeline ?? {}), ...(forge === "gitlab" && wavesBm ? { beforeMerge: { ...wavesBm, gate: "tf-apply" } } : {}) };

  if (input.comments && forge !== "gitlab") throw new RenderError(`comments: ${COMMENTS_GITLAB_ONLY}`);
  // agent.comment is chant's agent job (chant#4616), in a workflow of its own.
  const chantAgent = input.agentComment && !(forge === "gitlab" && !input.comments) ? chantAgentFiles(forge, image, input.agentComment, MARKER) : undefined;
  if (input.agentComment && !(forge === "gitlab" && !input.comments) && !chantAgent) throw new RenderError("agent.comment: chant's agent job wrote no jobs for this pipeline");
  if (forge === "gitlab") {
    if (input.agentComment && !input.comments) throw new RenderError(`agent.comment: ${NEEDS_COMMENTS_ON_GITLAB.agent}`);
    if (input.agentDrift) throw new RenderError("agent.drift runs on GitHub and Forgejo; leave agent.drift unset on GitLab");
    if (input.review && !input.comments) throw new RenderError(`review: ${NEEDS_COMMENTS_ON_GITLAB.review}`);
    // With gitlab.token: protected no branch pipeline holds the token, so nothing commits formatting.
    const protectedToken = input.gitlabToken === "protected";
    const jobImage = new Image({ name: image });
    const script = (main: string): string[] => (installStep ? [installStep, main] : [main]);
    // The runner evals the job's script in a pipeline under errexit, where a command that fails ends the job with 1
    // whatever its code; `exit` keeps the code, so a waiting wave ends 3 and a refused one 4, as on the other forges.
    const bash = (tag: string, body: string): string => `bash <<'${tag}' || exit $?\n${body}\n${tag}`;
    const gitlabEnv = {
      ...jobEnv,
      ...headersEnv,
      TG_TOKEN: `$${tokenEnv ?? "GITLAB_TOKEN"}`,
      TG_SHA: "$CI_COMMIT_SHA",
      TG_BRANCH: "$CI_DEFAULT_BRANCH",
    };
    // One id_token per cloud the job logs in to, as chant's login reads them: AWS's (which the Terragrunt auth provider
    // uses too), GCP's provider, Entra ID. AWS's is the job's stage's (jobStage), which with oidc.audience a map differs
    // by stage. A group's job (./cloud-identity.ts) declares its own identities' tokens, with its environment's audience.
    const idTokens = (stage: AudienceStage, o: LoginOidc | undefined = oidc): Record<string, unknown> => needsToken
      ? { id_tokens: loginIdTokens(o, stage === "drift" ? "plan" : stage, stage) }
      : {};
    // A scheduled pipeline is the plan notes', drift's, the comments poll's, the resume's or the rollouts'; the push and merge request jobs sit it out.
    // The plan notes schedule (PLAN_NOTES_VAR) runs on every project, so every GitLab pipeline has a scheduled one.
    const scheduled = true;
    // The agent's and the review's pipelines, which the comments job starts on the default branch, run only their own jobs,
    // and the plan notes pipeline, started by its schedule or by hand, runs chant's plan-note job alone.
    const others = [PLAN_NOTES_VAR, ...(input.agentComment ? [CHANT_AGENT_PR_VAR] : []), ...(input.review ? [REVIEW_MR_VAR] : [])];
    // Before merge chant's waves run in a pipeline of the default branch started with the decided head (CHANT_BEFORE_MERGE_HEAD).
    const startedBy = [...others, ...(prApply ? [BEFORE_MERGE_HEAD_ENV] : [])];
    const notMrApply = startedBy.map((v) => ` && $${v} == null`).join("");
    const notOthers = others.map((v) => ` && $${v} == null`).join("");
    const notScheduled = scheduled ? { rules: [new Rule({ if: `$CI_PIPELINE_SOURCE != "schedule"${notMrApply}` })] } : {};
    const onDefault = `${scheduled ? '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule"' : "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH"}${notMrApply}`;
    // apply.branches: a push to a named branch runs chant's wave jobs too, so no fmt job runs there.
    const notBranches = branchNames.map((b) => ` && $CI_COMMIT_BRANCH != "${b}"`).join("");
    // Only the jobs that run no merge request code see the merge token: GitLab gives a variable scoped to this environment to the jobs that name it.
    const mergeEnvironment = { environment: { name: MERGE_ENVIRONMENT, action: "access" } };
    // A branch's pipeline is built from the branch's files too, and with gitlab.token: protected it never sees the
    // token: then there is no fmt job, and nothing commits formatting.
    const glFmt = fmtOn && !protectedToken;
    // The check runs the branch's code (synth, validate's providers, the policy engine). Its shell drops every forge
    // token variable GitLab hands the job before it runs anything, so none of that code inherits one.
    // With respond.fmt on, the body leaves the finding dotenv for chant's commit job; the tokens are dropped before either.
    const glCheckBody = [`unset ${[...new Set(["TG_TOKEN", "TG_MERGE_TOKEN", ...FORGE_TOKEN_VARS, ...(tokenEnv ? [tokenEnv] : [])])].join(" ")}`, glFmt ? gitlabFindingBody(checkBody) : checkBody].join("\n");
    const check = new GitLabJob({
      stage: "check",
      image: jobImage,
      // The policy tests read the policy from the default branch, and check-mirror the commit before, so either takes the history.
      variables: { ...jobEnv, TG_BRANCH: gitlabEnv.TG_BRANCH, ...(checkHistory ? { GIT_DEPTH: "0" } : {}) },
      ...notScheduled,
      script: script(glCheckBody),
      // The check report (validate's diagnostics, live-check's refusals, the policy tests) stays with the job. With
      // respond.fmt on, so does the finding dotenv that starts chant's commit job (chant#4749).
      artifacts: glFmt
        ? { name: CHECK_DIR, when: "always", paths: [`${CHECK_DIR}/`, ".chant/commit/finding.env"], reports: { dotenv: ".chant/commit/finding.env" } }
        : { name: CHECK_DIR, when: "always", paths: [`${CHECK_DIR}/`] },
    } as never);
    // Plan runs a merge request's code, so it gets the plan identities, never runs for a merge request from a fork, and
    // drops every forge token first: chant's product plan (./product-plan.ts). Its report stays with the job, beside the
    // terraform report the merge request's widget reads. chant's plan-note job posts the note and terragucci/plan from it
    // in the plan notes pipeline of the default branch, which the plan notes schedule starts.
    const chantPlan = gitlabPlanJobs(planInput);
    // Every job names its image as the pipeline's other jobs do.
    const plan = new GitLabJob({ ...chantPlan.plan, image: jobImage } as never);
    // The note job runs in the plan stage: the plan notes pipeline runs no other job, so the project's stages need no new one.
    // It posts with the project token token_env names, which chant reads as CHANT_GITLAB_TOKEN before GITLAB_TOKEN.
    const noteVars = (chantPlan.note.variables as Record<string, string> | undefined) ?? {};
    // With evidence, chant's plan-evidence job signs first, in the same stage, and the note waits for it (a failed one leaves the note to post).
    const planEvidence = chantPlan.evidence ? new GitLabJob({ ...chantPlan.evidence, stage: "plan", image: jobImage } as never) : undefined;
    const planNote = new GitLabJob({ ...chantPlan.note, stage: "plan", image: jobImage, ...(planEvidence ? { needs: [{ job: PLAN_EVIDENCE_JOB, artifacts: true }] } : {}), variables: { ...noteVars, ...(tokenEnv && tokenEnv !== "GITLAB_TOKEN" ? { CHANT_GITLAB_TOKEN: `$${tokenEnv}` } : {}) } } as never);
    const jobs = new Map<string, never>([["check", check as never]]);
    if (glFmt) {
      // After a check that found formatting on a branch with a merge request, chant's commit job (chant#4749) runs
      // `terragucci fmt` and commits what changed. GitLab's job token cannot push, so the push job pushes with the
      // project token terragucci already names. Both share the check stage, so a repo's own stages list needs no new one.
      const settings = resolveCommitSpec("terragucci-fmt", fmtCommitSpec(binary, Boolean(tg), [], tokenEnv ?? DEFAULT_TOKEN_ENV.gitlab), "terragucci");
      const { commit, push } = gitlabCommitJobs({
        jobName: "fmt",
        stage: "check",
        // The job's image as the pipeline names it (a declared image with its entrypoint), passed through unchanged.
        image: jobImage as never,
        settings,
        script: installStep ? [installStep] : [],
        tokenEnv: tokenEnv ?? DEFAULT_TOKEN_ENV.gitlab,
        bin: TERRAGUCCI_WORDS.bin,
        onPush: true,
        after: { job: "check", rules: [{ if: `$CI_COMMIT_BRANCH && $CI_COMMIT_BRANCH != $CI_DEFAULT_BRANCH${notBranches} && $CI_PIPELINE_SOURCE != "schedule"${notMrApply}` }] },
      });
      jobs.set("fmt", new GitLabJob(commit as never) as never);
      // chant scopes the push token to an environment of its own; terragucci's is the project token, and only an
      // environment's apply jobs run in a forge environment, so the push job runs in none.
      const { environment: _scoped, ...pushJob } = push;
      jobs.set("fmt-push", new GitLabJob(pushJob as never) as never);
    }
    jobs.set("plan", plan as never);
    if (planEvidence) jobs.set(PLAN_EVIDENCE_JOB, planEvidence as never);
    jobs.set("plan-note", planNote as never);
    // The waves are chant's jobs (./render-waves.ts): every wave job, the status jobs, the stale marking, before merge the
    // split jobs and pr-merge, the control dispatch and the resume. Every other job of terragucci's waits on apply-done.
    // They sit out the schedules and pipelines terragucci's other jobs run in, but the resume schedule's.
    const glWaves = gitlabWaves({
      ...wavesInput,
      forge: "gitlab",
      ...(tokenEnv ? { tokenEnv } : {}),
      gitlabRunIf: `($CI_PIPELINE_SOURCE != "schedule" || $${SCHEDULE_VAR} == "resume")${notOthers}${prApply ? ' && $CI_PIPELINE_SOURCE != "push"' : ""}`,
    }, wavesPipeline);
    const chantJobs = new Set(glWaves.jobs.map(([n]) => n));
    for (const [name, job] of glWaves.jobs) jobs.set(name, new GitLabJob(job as never) as never);
    if (prApply) {
      // The push after a merge applies nothing: the merge request applied before it merged. confirm plans every root with the read-only role.
      jobs.set("confirm", new GitLabJob({
        stage: "apply",
        image: jobImage,
        variables: gitlabEnv,
        rules: [new Rule({ if: onDefault })],
        ...idTokens("apply"),
        ...(tg ? forgeCache("gitlab") : {}),
        script: script(bash("CONFIRM", confirmScript(binary, layers, forge, oidc, report))),
        artifacts: { name: `${REPORT_DIR}-confirm`, when: "always", paths: [`${REPORT_DIR}/`] },
      } as never) as never);
    }
    if (tipsOn) {
      // Runs after the last apply, so a wave that waits or fails holds the tips back too.
      jobs.set("tips", new GitLabJob({
        stage: "tips",
        image: jobImage,
        needs: [lastApply],
        variables: { ...gitlabEnv, GIT_DEPTH: "0" },
        rules: [new Rule({ if: onDefault })],
        resource_group: "terragucci-tips",
        script: script(bash("TIPS", tipsScript(binary, forge, tokenEnv, input.synth))),
      } as never) as never);
    }
    if (bumpOn) {
      // Runs after the last apply, from the default branch, with the history and tags the commits are counted from.
      jobs.set("version-bump", new GitLabJob({
        stage: "version-bump",
        image: jobImage,
        needs: [lastApply],
        variables: { ...gitlabEnv, GIT_DEPTH: "0" },
        rules: [new Rule({ if: onDefault })],
        resource_group: "terragucci-version-bump",
        script: [bash("BUMP", versionBumpScript(forge, tokenEnv))],
      } as never) as never);
    }
    if (input.publish) {
      // GitLab hands project variables (TERRAGUCCI_REGISTRY_USER and _PASSWORD, and with
      // attest COSIGN_PRIVATE_KEY and COSIGN_PASSWORD) to every job, so mark them
      // protected and masked to keep them off merge requests.
      jobs.set("publish", new GitLabJob({
        stage: "publish",
        image: jobImage,
        needs: [lastApply],
        variables: { ...jobEnv, TG_TOKEN: gitlabEnv.TG_TOKEN, TG_SHA: gitlabEnv.TG_SHA, TG_BRANCH: gitlabEnv.TG_BRANCH, GIT_DEPTH: "0" },
        // A scheduled pipeline has no apply job for its needs to name.
        rules: [new Rule({ if: onDefault })],
        resource_group: "terragucci-publish",
        script: [...(input.attest ? [installScript("cosign", COSIGN_VERSION, forge)] : []), ...script(bash("PUBLISH", publishScript(forge)))],
      } as never) as never);
    }
    // terragucci#1305 and chant issues 4622 and 4753: the drift job is a chant drift Op in a file of its own, which
    // .gitlab-ci.yml includes. It keeps the drift stage's id_tokens, a Terragrunt repo's cache and the rule that picks
    // drift's schedule, so no project adds a variable to its drift schedule.
    // The plan notes schedule is none of drift's, whatever its TERRAGUCCI_SCHEDULE says.
    const driftRule = `$CI_PIPELINE_SOURCE == "schedule"${OTHER_SCHEDULES.map((v) => ` && $${SCHEDULE_VAR} != "${v}"`).join("")} && $${PLAN_NOTES_VAR} == null`;
    const glDrift = drift
      ? chantDriftFiles({
          forge,
          image,
          schedule: drift,
          script: [...(installStep ? [installStep] : []), ...(awsStep ? [awsStep] : []), driftScript(binary, layers, forge, oidc, report, driftPr, driftNotify)].join("\n"),
          workflowEnv: {},
          jobEnv: definedEnv({ ...gitlabEnv, ...driftNotifyEnv }),
          pullRequest: Boolean(driftPr),
          oidc: Boolean(oidc),
          artifacts: [{ name: `${REPORT_DIR}-drift`, paths: [`${REPORT_DIR}/`, ...(agentDrift ? [`${RESPOND_DIR}/`] : [])] }],
          ...(!input.atmos && !input.terramate && !tg ? { roots: layers.flat() } : {}),
          marker: MARKER,
          ...(runnerOf(input.runner, "drift") !== undefined ? { runner: runnerOf(input.runner, "drift") } : {}),
          gitlab: {
            ...((idTokens("drift") as { id_tokens?: Record<string, unknown> }).id_tokens ? { idTokens: (idTokens("drift") as { id_tokens: Record<string, unknown> }).id_tokens } : {}),
            ...(tg ? { cache: (forgeCache("gitlab") as { cache: unknown }).cache } : {}),
            scheduleRule: driftRule,
          },
        })
      : undefined;
    if (drift && !glDrift) throw new RenderError(`drift: ${CHANT_DRIFT_NEEDS_OP}`);
    if (rollouts) {
      // The rollouts schedule's pipelines: continue every rollout in flight, from the default branch, with the project's token.
      jobs.set("rollout", new GitLabJob({
        stage: "rollout",
        image: jobImage,
        variables: { ...jobEnv, TG_TOKEN: gitlabEnv.TG_TOKEN, GIT_DEPTH: "0" },
        rules: [new Rule({ if: `$CI_PIPELINE_SOURCE == "schedule" && $${SCHEDULE_VAR} == "rollouts"` })],
        resource_group: "terragucci-rollout",
        script: script(bash("ROLLOUT", rolloutScript(forge, tokenEnv))),
      } as never) as never);
    }
    if (input.comments) {
      // GitLab starts no pipeline for a merge request note, so a schedule polls for them. The job runs from the
      // default branch, reads notes and calls the API with the project's token; it takes no cloud credentials,
      // and one poll at a time answers a note.
      // With apply.when: pull-request it also holds the merge token, to start the waves' pipeline on the protected default branch.
      jobs.set("comments", new GitLabJob({
        stage: "comments",
        image: jobImage,
        // Before merge the poll records chant's decision on chant/lifecycle, from a checkout of the default branch it may push from.
        variables: { TG_TOKEN: gitlabEnv.TG_TOKEN, ...(prApply ? { TG_MERGE_TOKEN: `$${input.applyMergeTokenEnv}`, GIT_DEPTH: "0", ...(reachLine ? { CHANT_LOCK_REACH: reachLine } : {}) } : {}), ...(input.atlantisComments ? { [ATLANTIS_COMMENTS_ENV]: "1" } : {}), ...(prApply ? {} : { GIT_STRATEGY: "none" }) },
        rules: [new Rule({ if: `$CI_PIPELINE_SOURCE == "schedule" && $${SCHEDULE_VAR} == "comments"` })],
        resource_group: "terragucci-comments",
        ...(prApply ? mergeEnvironment : {}),
        script: [bash("COMMENTS", [...(prApply ? [gitlabPushRemote] : []), commentsScript(layers, prApply ? { ...(input.applyRequires ? { requires: input.applyRequires } : {}), waves: cut.length } : undefined, { agent: chantAgent ? "chant" : false, review: Boolean(input.review) })].join("\n"))],
      } as never) as never);
    }
    if (input.review) {
      // review.agent: the comments job starts a pipeline of the default branch for each merge request head once its plan
      // ended. The review command runs with the model's key alone (its environment cleared); a fresh job posts the note.
      const onReview = `$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $${REVIEW_MR_VAR}`;
      jobs.set(REVIEW_JOB, new GitLabJob({
        stage: "comments",
        image: jobImage,
        variables: { TG_TOKEN: gitlabEnv.TG_TOKEN, TG_DEFAULT_BRANCH: "$CI_DEFAULT_BRANCH", GIT_DEPTH: "0" },
        rules: [new Rule({ if: onReview })],
        timeout: `${input.review.timeout} minutes`,
        script: [bash("REVIEW", gitlabReviewScript(input.review, GL_REVIEW_ARTIFACT))],
        artifacts: { name: GL_REVIEW_ARTIFACT, when: "always", paths: [`${GL_REVIEW_ARTIFACT}/`] },
      } as never) as never);
      jobs.set("review-note", new GitLabJob({
        stage: "comments",
        image: jobImage,
        needs: [REVIEW_JOB],
        variables: { TG_TOKEN: gitlabEnv.TG_TOKEN, GIT_STRATEGY: "none" },
        rules: [new Rule({ if: onReview, when: "always" } as never)],
        script: [bash("REVIEW_NOTE", `set -uo pipefail\nterragucci review post --forge gitlab --dir ${GL_REVIEW_ARTIFACT}`)],
      } as never) as never);
    }
    if (ephemeral) {
      // ephemeral: a merge request from this project applies its copy of the ephemeral roots with the apply role, as its
      // own pipeline runs it; a schedule with TERRAGUCCI_SCHEDULE=ephemeral destroys the copies whose TTL passed or
      // whose merge request closed, since GitLab starts no pipeline when one closes.
      jobs.set("ephemeral", new GitLabJob({
        stage: "apply",
        image: jobImage,
        variables: { ...gitlabEnv, TG_PR: "$CI_MERGE_REQUEST_IID", GIT_DEPTH: "0" },
        rules: [new Rule({ if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_PATH == $CI_PROJECT_PATH' })],
        resource_group: "terragucci-ephemeral-$CI_MERGE_REQUEST_IID",
        ...idTokens("apply"),
        script: script(bash("EPHEMERAL", gitlabEphemeralScript(oidc, binary, ephemeralPrelude))),
      } as never) as never);
      jobs.set("ephemeral-sweep", new GitLabJob({
        stage: "apply",
        image: jobImage,
        variables: { ...gitlabEnv, GIT_DEPTH: "0" },
        rules: [new Rule({ if: `$CI_PIPELINE_SOURCE == "schedule" && $${SCHEDULE_VAR} == "ephemeral"` })],
        resource_group: "terragucci-ephemeral-sweep",
        ...idTokens("apply"),
        script: script(bash("SWEEP", ephemeralSweepScript(forge, oidc, binary, ephemeralPrelude))),
      } as never) as never);
    }
    // chant's jobs run where the spec's runner and job groups put them.
    placeJobs(new Map([...jobs].filter(([n]) => !chantJobs.has(n))), input.runner, forge);
    const out = text(gitlabSerializer.serialize(jobs)).replace(/^stages:\n((?: {2}- .*\n)+)/, (_, list: string) => {
      const listed = list.trimEnd().split("\n").map((l) => l.replace(/^ {2}- /, ""));
      // The drift Op's job is in the included file; its stage keeps the place terragucci's drift job had, after publish.
      const ours = glDrift && !listed.includes(CHANT_DRIFT_GITLAB_STAGE) ? insertStage(listed, CHANT_DRIFT_GITLAB_STAGE, ["check", "plan", "apply", "tips", "publish"]) : listed;
      return `${emitYAMLEntry("stages", [...GL_DEFAULT_STAGES.before, ...ours, ...GL_DEFAULT_STAGES.after])}\n`;
    });
    // The agent's jobs on chant's job are in a file of their own, included here; they share the comments stage.
    const included = [...(chantAgent ? [CHANT_AGENT_PATHS.gitlab] : []), ...(glDrift ? [CHANT_DRIFT_PATHS.gitlab] : [])];
    const agentInclude = included.length ? `include:\n${included.map((f) => `  - local: ${f}\n`).join("")}` : "";
    const glExtra = [...(chantAgent ? chantAgent.files : []), ...(glDrift ?? [])];
    const glNeeds = new Map(glWaves.jobs.map(([n, j]) => [n, needsOf(j.needs)]));
    const glApplyJobs = applyJobs.map((j) => ({ name: j.name, needs: glNeeds.get(j.name) ?? [], wave: j.wave, applies: j.applies }));
    return { path: PIPELINE_PATHS.gitlab, content: header(image, input.imageFromConfig) + agentInclude + out + ownJobsYAML(input.ownJobs, [...jobs.keys()], forge), applyJobs: glApplyJobs, ...(glExtra.length ? { extra: glExtra } : {}) };
  }

  // terragucci#1305 and chant issue 4622: the drift job is a chant drift Op in a workflow of its own, keeping the drift report
  // (and respond.drift: agent's input) as artifacts, with a Terragrunt repo's cache as a setup step and attribution's AWS CLI
  // install in its script. On Forgejo with oidc chant's job sets enable-openid-connect (chant issue 4753).
  const chantDrift = drift
    ? chantDriftFiles({
        forge,
        image,
        schedule: drift,
        // The pinned binaries and the AWS CLI are installed in the script that runs them, so they go on this shell's PATH.
        script: [...installs.map((i) => installScript(i.tool, i.version, forge, true)), ...(awsStep ? [awsStep] : []), driftScript(binary, layers, forge, oidc, report, driftPr, driftNotify, input.agentDrift ? "chant" : false)].join("\n"),
        workflowEnv: jobEnv,
        jobEnv: definedEnv({ ...passed, TG_TOKEN: "${{ github.token }}", TG_SHA: "${{ github.sha }}", ...headersEnv, ...driftDecideEnv, ...reportKeyEnv(forge, input.reports), ...driftNotifyEnv }),
        pullRequest: Boolean(driftPr),
        oidc: Boolean(oidc),
        ...(input.agentDrift ? { agent: input.agentDrift } : {}),
        artifacts: [{ name: `${REPORT_DIR}-drift`, paths: [`${REPORT_DIR}/`] }, ...(agentDrift ? [{ name: `${RESPOND_DIR}-drift`, paths: [`${RESPOND_DIR}/`] }] : [])],
        ...(tg ? { setup: [forgeCache(forge)] } : {}),
        ...(!input.atmos && !input.terramate && !tg ? { roots: layers.flat() } : {}),
        marker: MARKER,
        // The drift stage's runner (runner.drift, else runner.default), as terragucci's own drift job took it.
        ...(runnerOf(input.runner, "drift") !== undefined ? { runner: runnerOf(input.runner, "drift") } : {}),
      })
    : undefined;
  // The waves are chant's jobs (./render-waves.ts), with the resume workflow's.
  const ghWaves = githubWaves({ ...wavesInput, forge }, wavesPipeline);
  const sameRepo = "github.event.pull_request.head.repo.full_name == github.repository";
  const isFork = "github.event.pull_request.head.repo.full_name != github.repository";
  // Forgejo (15 and later, with runner 12.5 or later) serves a job an OIDC token
  // only when the job sets enable-openid-connect; it does not read id-token: write.
  const openid = (on: boolean): Record<string, boolean> => (on && forge === "forgejo" ? { "enable-openid-connect": true } : {});
  const workflow = new Workflow({
    name: "terragucci",
    on: {
      push: { branches: ["**"] },
      pull_request: {},
      // `/terragucci plan [root]` in a pull request comment re-plans it (comment.ts); `/terragucci apply` is chant's comment job (apply-comment).
      issue_comment: { types: ["created"] },
      // approval: pr-review: a review of the head re-posts terragucci/approval.
      ...(prReview ? { pull_request_review: {} } : {}),
      // locks: plan: the pr-lock job, from the default branch's workflow, locks a pull request's roots and releases them when it closes.
      // ephemeral: the same events apply a pull request's copy of the ephemeral roots and destroy it on close.
      ...(locksPlan || ephemeral ? { pull_request_target: { types: ["opened", "reopened", "synchronize", "closed"] } } : {}),
      ...(drift && !chantDrift ? { schedule: [{ cron: drift }] } : {}),
      // A dispatch with pr re-plans that pull request as `/terragucci plan [root]` does (comment.ts). The drift job is dispatched from terragucci-drift.yml.
      // The waves' dispatch (a decided head before merge, the rest of a stopped apply) takes inputs of its own.
      workflow_dispatch: { inputs: { ...REPLAN_INPUTS, ...ghWaves.inputs } },
    },
    env: jobEnv,
    permissions: { contents: "read" },
    // Forgejo cancels the runs of an earlier push to a branch, even one that is
    // applying, unless the workflow names a concurrency group. A group that does
    // not cancel makes a later run wait instead.
    // A pull_request_target run's ref is the default branch's, so with locks: plan it gets a group of its own pull request's.
    // shape: unless one apply at a time is the rule (a repo-wide scope), each push to the default branch gets a group of its own
    // commit, so a later push's run neither cancels nor waits for an earlier one's: their waves apply side by side, kept apart per
    // root by the backend's state lock (with choudoufu by the rows each holds), and a wave a newer push superseded stands down.
    ...(forge === "forgejo"
      ? { concurrency: { group: `terragucci-\${{ github.event_name == 'issue_comment' && format('comment-{0}', github.event.issue.number) || ${DISPATCH_GROUP} || ${locksPlan || ephemeral ? "github.event_name == 'pull_request_target' && format('lock-{0}', github.event.pull_request.number) || " : ""}${repoWide ? "" : "github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) && format('{0}-{1}', github.ref, github.sha) || "}github.ref }}`, "cancel-in-progress": false } }
      : {}),
  } as never);
  // A plan reads the range from the target branch, so its checkout has the history.
  const steps = (main: InstanceType<typeof Step>, cached = false, history = false, before?: string, estimator = false, fetch?: InstanceType<typeof Step> | InstanceType<typeof Step>[]): InstanceType<typeof Step>[] => [
    new Step({ uses: CHECKOUT, ...(history ? { with: { "fetch-depth": 0 } } : {}) }),
    ...(installStep ? [new Step({ name: installName, run: installStep })] : []),
    ...(estimator && costInstall ? [new Step({ name: `Install Infracost ${INFRACOST_VERSION}`, run: costInstall })] : []),
    ...(before ? [new Step({ name: `Install the AWS CLI ${AWS_CLI.version} unless the job has it`, shell: "bash", run: before })] : []),
    ...(cached && tg ? [new Step({ name: "Cache Terragrunt sources and providers", ...forgeCache(forge) } as never)] : []),
    ...(fetch ? (Array.isArray(fetch) ? fetch : [fetch]) : []),
    main,
  ];
  const upload = uploadArtifact(forge);
  // A job that runs the change's code checks it out with no credentials left in the git config, and with a script,
  // not actions/checkout, whose post step runs at the job's end with the token as its input (./handover.ts).
  const bareCheckout = (history: boolean, ref?: string, cond?: string, name = "Check out the change"): InstanceType<typeof Step> =>
    new Step({ ...(cond ? { if: cond } : {}), name, shell: "bash", env: { TG_TOKEN: "${{ github.token }}", ...(ref ? { TG_REF: ref } : {}) }, run: checkoutScript(history) });
  // The steps between the checkout and the main step of a job that runs the change's code. A job that runs a pull
  // request's code from the default branch's workflow (the re-plan) restores the cache and never saves it: it saves
  // into the default branch's scope, which the apply jobs restore from (GHSA-75r4-jwvp-8pg3).
  const toolSteps = (cached: boolean, estimator: boolean, cond?: string, restoreOnly = false): InstanceType<typeof Step>[] => [
    ...(installStep ? [new Step({ ...(cond ? { if: cond } : {}), name: installName, run: installStep })] : []),
    ...(estimator && costInstall ? [new Step({ ...(cond ? { if: cond } : {}), name: `Install Infracost ${INFRACOST_VERSION}`, run: costInstall })] : []),
    ...(cached && tg
      ? [
          restoreOnly
            ? new Step({ ...(cond ? { if: cond } : {}), name: "Restore the Terragrunt sources and providers cache", ...forgeCacheRestore() } as never)
            : new Step({ ...(cond ? { if: cond } : {}), name: "Cache Terragrunt sources and providers", ...forgeCache(forge) } as never),
        ]
      : []),
  ];
  // Check runs for a push, and for a fork's pull request, which has no push here. It runs the branch's code
  // (synth, validate's providers, the policy engine) and holds no forge token: the checkout keeps no credentials,
  // and the step starts without the runner's token variables.
  // The check step is the job's last, and the check-report job keeps its report.
  const check = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    if: `github.event_name == 'push' || (github.event_name == 'pull_request' && ${isFork})`,
    env: { TG_BRANCH: "${{ github.event.repository.default_branch }}" },
    // With respond.fmt on, the check says it found formatting (exit FMT_FINDING) as its `finding` output, which starts chant's commit job (chant#4749).
    outputs: { ...handoverOutputs("check", forge), ...(fmtOn ? { finding: "${{ steps.check.outputs.finding }}" } : {}) },
    steps: [
      // The policy tests read the policy from the default branch, and check-mirror the commit before, so either takes the history.
      bareCheckout(checkHistory),
      ...toolSteps(false, false),
      new Step({ id: "check", name: `Format check and validate, every ${what}`, run: `${dropForgeTokens("sh")}\n${handoverTrap(CHECK_DIR, forge).join("\n")}\n${fmtOn ? githubFindingBody(checkBody) : checkBody}` }),
    ],
  } as never);
  // A fresh container that runs none of the change's code keeps the check report the check job handed on, beside the job summary.
  const checkReport = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    needs: "check",
    if: "always() && (needs.check.result == 'success' || needs.check.result == 'failure')",
    steps: [
      new Step({ name: "Take the check report from the check job", shell: "bash", run: takeOverScript("check", CHECK_DIR, forge) }),
      new Step({ name: "Keep the check report", if: "always()", uses: upload, with: { name: CHECK_DIR, path: `${CHECK_DIR}/`, "if-no-files-found": "ignore" } }),
    ],
  } as never);
  // A comment's first words, as the jobs' conditions test them; with atlantis_comments, `atlantis plan` and `atlantis apply` start the same jobs.
  const says = (p: string): string => `startsWith(github.event.comment.body, '${p}')`;
  const atlantis = input.atlantisComments === true;
  // The comments each job answers: chant's product pipeline names them from terragucci's words when the installed chant has it.
  const comment = commentWords(input, forge, prApply, locksPlan);
  const applySays = atlantis ? `${says(comment.apply)} || ${says(comment.alias.apply)}` : says(comment.apply);
  const planSays = atlantis ? `(${says(comment.plan)} || ${says(comment.alias.plan)})` : says(comment.plan);
  // With locks: plan and apply.when: merge, `/terragucci lock` and `/terragucci unlock` are the pr-lock job's.
  const LOCK_COMMENT = `(${says(comment.lock)} || ${says(comment.unlock)})`;
  // The plan, plan-note, replan and replan-note jobs are chant's product plan (./product-plan.ts), under terragucci's names.
  // The plan job runs a pull request's code: it gets the plan identities, never runs for a fork, and holds no forge token
  // while that code runs. A comment (or a dispatch) re-plans a pull request of this repository for someone who can write
  // to it; chant's re-plan job leaves the comments terragucci's other jobs answer alone, and replies to any other.
  const others = [
    comment.apply,
    ...(locksPlan || prApply ? [comment.lock, comment.unlock] : []),
    ...(input.agentComment ? [`${comment.prefix} agent`] : []),
    ...(actionFlow ? [ACTION_COMMENT.trimEnd()] : []),
  ];
  const planJobs = githubPlanJobs({ ...planInput, others, noteSteps: planNoteLines(forge, { prReview, ...(agentLogin ? { agentLogin } : {}) }) }).map(([name, job]): [string, never] => {
    // Forgejo serves a job an OIDC token only with enable-openid-connect, which its dialect does not add from id-token: write.
    const oidcJob = forge === "forgejo" && (job.permissions as Record<string, string> | undefined)?.["id-token"] === "write" ? { "enable-openid-connect": true } : {};
    // One re-plan at a time per pull request; a later comment waits for the one before.
    const queued = name === "replan" ? { concurrency: { group: "terragucci-replan-${{ github.repository }}-${{ github.event.issue.number || github.event.inputs.pr }}", "cancel-in-progress": false } } : {};
    return [name, new Job({ ...job, ...oidcJob, ...queued } as never) as never];
  });
  const entities = new Map<string, never>([
    ["workflow", workflow as never],
    ["check", check as never],
    ["check-report", checkReport as never],
    ...planJobs,
  ]);
  // After a check that found formatting, chant's commit job (chant#4749) runs `terragucci fmt` and commits what changed to
  // the pull request's branch: the commit job holds no token that pushes, and the push job pushes with the job's own
  // token. That push starts no run, so with locks: plan the push job takes the branch's plan lock itself, as before.
  if (fmtOn) {
    const settings = resolveCommitSpec("terragucci-fmt", fmtCommitSpec(binary, Boolean(tg), locksPlan ? planLockScript(layers, forge, prApply, Boolean(tg)).split("\n") : []), "terragucci");
    const { commit, push } = githubCommitJobs({ forge, jobName: "fmt", image, settings, setup: installStep ? [{ name: installName, run: installStep }] : [], beforeScript: [], onPush: true, after: "check", bin: TERRAGUCCI_WORDS.bin });
    // Every job of the pipeline names its container as `{ image }`; chant's jobs name the same image.
    entities.set("fmt", new Job({ ...commit, container: { image } } as never) as never);
    const lockPush = locksPlan
      ? { env: { ...(push.env as Record<string, string>), TG_TOKEN: "${{ github.token }}" }, permissions: { ...(push.permissions as Record<string, string>), statuses: "write" } }
      : {};
    entities.set("fmt-push", new Job({ ...push, container: { image }, ...lockPush } as never) as never);
  }
  // `/terragucci apply` is chant's comment job under terragucci's name: on a merged pull request it re-runs the waves' jobs of
  // its merge commit that did not succeed, and before merge it decides the open pull request's head and dispatches the waves
  // for it. It runs from the default branch's workflow, holds no cloud credential and runs none of the change's code.
  const commentJob = githubCommentJob({ ...planInput, others: [] }, {
    waves: wavesShape(wavesInput),
    wavesSpecFile: WAVES_SPEC,
    commentJob: { jobName: "apply-comment" },
    wavesJobNames: wavesNames,
    ...(wavesBm ? { wavesBeforeMerge: wavesBm } : {}),
  // Before merge it also answers `/terragucci lock` and `/terragucci unlock` by the reach line (chant issue 5061).
  }, `github.event_name == 'issue_comment' && ${prApply ? `(${applySays} || ${says(comment.lock)} || ${says(comment.unlock)})` : atlantis ? `(${applySays})` : applySays}`, reachLine);
  entities.set("apply-comment", new Job(commentJob as never) as never);
  if (prReview) {
    // A review of the head says again whether the waves the gate will hold are approved.
    entities.set("approval", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      if: `github.event_name == 'pull_request_review' && ${sameRepo}`,
      permissions: { contents: "read", statuses: "write", "pull-requests": "read" },
      env: { TG_TOKEN: "${{ github.token }}", TG_SHA: "${{ github.event.pull_request.head.sha }}", TG_PR: "${{ github.event.pull_request.number }}" },
      steps: [new Step({ name: "Say on the head whether its waiting waves are approved", shell: "bash", run: `terragucci approval-status --forge ${forge}${agentLogin ? ` --agent-login ${agentLogin}` : ""}` })],
    } as never) as never);
  }
  if (locksPlan) {
    // locks: plan. The workflow is the default branch's on pull_request_target and on a comment, and the job checks out
    // only the default branch: it reads the change as data from git, runs no binary and assumes no cloud role. So it may
    // push the locks to chant/lifecycle (contents: write) and post terragucci/lock.
    const planLockIf = prApply ? planSays : `(${planSays} || ${LOCK_COMMENT})`;
    entities.set("pr-lock", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      if: `github.event_name == 'pull_request_target' || (github.event_name == 'issue_comment' && ${planLockIf})`,
      permissions: { contents: "write", statuses: "write", "pull-requests": "write" },
      concurrency: { group: "terragucci-lock-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number }}", "cancel-in-progress": false },
      env: { TG_TOKEN: "${{ github.token }}" },
      steps: [
        new Step({ uses: CHECKOUT, with: { "fetch-depth": 0 } }),
        new Step({ name: "Lock the roots the pull request reaches, or release them", shell: "bash", run: planLockScript(layers, forge, prApply, Boolean(tg)) }),
      ],
    } as never) as never);
  }
  if (ephemeral) {
    // ephemeral: the default branch's workflow on pull_request_target, so a pull request cannot change the job that applies
    // its copy or drop the destroy on close. The job checks out the default branch, and terragucci ephemeral reads its
    // settings there and checks the head out apart. Forks never apply.
    entities.set("ephemeral", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      if: `github.event_name == 'pull_request_target' && ${sameRepo}`,
      permissions: { contents: "write", "pull-requests": "read", ...(needsToken ? { "id-token": "write" } : {}) },
      ...openid(needsToken),
      concurrency: { group: "terragucci-ephemeral-${{ github.repository }}-${{ github.event.pull_request.number }}", "cancel-in-progress": false },
      env: { ...passed, TG_TOKEN: "${{ github.token }}", TG_PR: "${{ github.event.pull_request.number }}", TG_SHA: "${{ github.event.pull_request.head.sha }}", TG_ACTION: "${{ github.event.action }}", ...headersEnv },
      steps: steps(new Step({ name: "Apply the pull request's copy of the ephemeral roots, or destroy it once it closes", shell: "bash", run: ephemeralScript(forge, oidc, binary, ephemeralPrelude) }), false, true),
    } as never) as never);
  }
  for (const [name, job] of ghWaves.jobs) entities.set(name, new Job(job as never) as never);
  if (prApply) {
    // The push after a merge applies nothing: its pull request applied before it merged. The job plans every root
    // with the read-only role and says on the commit whether any still plans a change.
    entities.set("confirm", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      needs: "check",
      if: `${drift ? "github.event_name == 'push' && " : ""}github.ref == format('refs/heads/{0}', github.event.repository.default_branch)`,
      permissions: { contents: "read", statuses: "write", ...(needsToken ? { "id-token": "write" } : {}) },
      ...openid(needsToken),
      env: { ...passed, TG_TOKEN: "${{ github.token }}", TG_SHA: "${{ github.sha }}", ...headersEnv },
      steps: [
        ...steps(new Step({ name: `Plan every ${what} to confirm the merge applied`, shell: "bash", run: confirmScript(binary, layers, forge, oidc, report) }), true),
        new Step({ name: "Keep the plan report", if: "always()", uses: uploadArtifact(forge), with: { name: `${REPORT_DIR}-confirm`, path: `${REPORT_DIR}/`, "if-no-files-found": "ignore" } }),
      ],
    } as never) as never);
  }
  if (tipsOn) {
    // One small pull request per tip, from the default branch once every wave has applied.
    entities.set("tips", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      needs: lastApply,
      if: `${drift ? "github.event_name == 'push' && " : ""}github.ref == format('refs/heads/{0}', github.event.repository.default_branch)`,
      permissions: { contents: "write", "pull-requests": "write" },
      concurrency: { group: "terragucci-tips-${{ github.repository }}", "cancel-in-progress": false },
      env: { TG_TOKEN: "${{ github.token }}" },
      steps: [
        new Step({ uses: CHECKOUT, with: { "fetch-depth": 0 } }),
        ...(installStep ? [new Step({ name: installName, run: installStep })] : []),
        new Step({ name: "Open a pull request for each tip", shell: "bash", run: tipsScript(binary, forge, tokenEnv, input.synth) }),
      ],
    } as never) as never);
  }
  if (bumpOn) {
    // A release pull request per module the commits do not settle, from the default branch once every wave has applied.
    entities.set("version-bump", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      needs: lastApply,
      if: `${drift ? "github.event_name == 'push' && " : ""}github.ref == format('refs/heads/{0}', github.event.repository.default_branch)`,
      permissions: { contents: "write", "pull-requests": "write" },
      concurrency: { group: "terragucci-version-bump-${{ github.repository }}", "cancel-in-progress": false },
      env: { TG_TOKEN: "${{ github.token }}", ...decideSecret },
      steps: [
        new Step({ uses: CHECKOUT, with: { "fetch-depth": 0 } }),
        new Step({ name: "Suggest the next version of each module that changed", shell: "bash", run: versionBumpScript(forge, tokenEnv) }),
      ],
    } as never) as never);
  }
  if (input.publish) {
    // The only job that sees the registry credentials. It pushes tags, so it is
    // the only one with write access to contents, and it runs after apply.
    entities.set("publish", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      needs: lastApply,
      if: "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
      permissions: { contents: "write" },
      concurrency: { group: "terragucci-publish-${{ github.repository }}", "cancel-in-progress": false },
      env: {
        TERRAGUCCI_REGISTRY_USER: "${{ secrets.TERRAGUCCI_REGISTRY_USER }}",
        TERRAGUCCI_REGISTRY_PASSWORD: "${{ secrets.TERRAGUCCI_REGISTRY_PASSWORD }}",
        TERRAGUCCI_REGISTRY_INSECURE: "${{ secrets.TERRAGUCCI_REGISTRY_INSECURE }}",
        ...(input.attest ? { COSIGN_PRIVATE_KEY: "${{ secrets.COSIGN_PRIVATE_KEY }}", COSIGN_PASSWORD: "${{ secrets.COSIGN_PASSWORD }}" } : {}),
        ...(input.publishBucket ? reportKeyEnv(forge, { bucket: input.publishBucket }) : {}),
        ...(input.publishGitlabToken ? { GITLAB_TOKEN: `\${{ secrets.${input.publishGitlabToken} }}` } : {}),
      },
      steps: [
        new Step({ uses: CHECKOUT, with: { "fetch-depth": 0 } }),
        ...(installStep && install ? [new Step({ name: `Install ${install.binary} ${install.version}`, run: installStep })] : []),
        ...(input.attest ? [new Step({ name: `Install cosign ${COSIGN_VERSION}`, run: installScript("cosign", COSIGN_VERSION, forge) })] : []),
        new Step({ name: "Publish the modules that changed", shell: "bash", run: publishScript(forge) }),
      ],
    } as never) as never);
  }
  if (drift && !chantDrift) throw new RenderError(`drift: ${CHANT_DRIFT_NEEDS_OP}`);
  if (forge === "forgejo") deferDeepSkips(entities);
  // Every workflow file goes through here, so its jobs run where runner places them.
  // chant's jobs run where the spec's runner and job groups put them; the comment job, which applies nothing, on runner.default.
  const chantJobs = new Set([...ghWaves.jobs.map(([n]) => n), ...(ghWaves.resume ?? []).map(([n]) => n)]);
  const serialize = (jobs: Map<string, never>): string => {
    placeJobs(new Map([...jobs].filter(([n]) => !chantJobs.has(n))), input.runner, forge);
    // Each action is pinned by SHA (./action-pins.ts); its release goes beside it as a comment.
    return tagComments(text((forge === "forgejo" ? forgejoSerializer : githubSerializer).serialize(jobs)));
  };
  const extra: { path: string; content: string }[] = [];
  if (input.wavesSpec) extra.push({ path: WAVES_SPEC, content: input.wavesSpec });
  if (chantAgent) extra.push(...chantAgent.files);
  if (chantDrift) extra.push(...chantDrift);
  if (input.resume) {
    // apply.resume: chant's resume, a schedule of its own that starts a waiting wave's job again once its approval stands.
    const resume = new Map<string, never>([
      ["workflow", new Workflow({ name: "terragucci resume", on: { schedule: [{ cron: resumeCron(input.resume) }], workflow_dispatch: {} }, env: jobEnv, permissions: { contents: "read" } }) as never],
      ...(ghWaves.resume ?? []).map(([name, job]): [string, never] => [name, new Job(job as never) as never]),
    ]);
    // A day-2 action whose approval now stands runs as the person who asked (./action.ts resumeActions), in a job of its own.
    if (actionFlow) {
      resume.set("action", new Job({
        "runs-on": "ubuntu-latest",
        container: { image },
        permissions: { contents: "write", ...(needsToken ? { "id-token": "write" } : {}) },
        ...openid(needsToken),
        concurrency: { group: "terragucci-action-${{ github.repository }}", "cancel-in-progress": false },
        env: { ...passed, TG_TOKEN: "${{ github.token }}", ...headersEnv },
        steps: steps(new Step({ name: "Run each day-2 action whose approval stands", shell: "bash", run: actionResumeScript(forge, oidc) }), false, true),
      } as never) as never);
    }
    extra.push({ path: RESUME_PATHS[forge], content: header(image, input.imageFromConfig) + serialize(resume) });
  }
  if (actionFlow) {
    // Day-2 actions: a workflow of its own, on a `/terragucci action` comment or a dispatch with root and address (behold's button).
    const action = new Map<string, never>([
      ["workflow", new Workflow({ name: "terragucci action", on: { issue_comment: { types: ["created"] }, workflow_dispatch: { inputs: ACTION_INPUTS } }, env: jobEnv, permissions: { contents: "read" } }) as never],
      ["action", new Job({
        "runs-on": "ubuntu-latest",
        container: { image },
        if: `(github.event_name == 'issue_comment' && ${says(ACTION_COMMENT)}) || github.event_name == 'workflow_dispatch'`,
        // It pushes the request and its records to chant/lifecycle and replies on the pull request.
        permissions: { contents: "write", "pull-requests": "write", ...(needsToken ? { "id-token": "write" } : {}) },
        ...openid(needsToken),
        concurrency: { group: "terragucci-action-${{ github.repository }}", "cancel-in-progress": false },
        env: { ...passed, TG_TOKEN: "${{ github.token }}", ...headersEnv },
        steps: [
          ...steps(new Step({ id: "decide", name: "Read the comment or the dispatch and decide whether an action runs", shell: "bash", run: actionDecideScript(layers, forge) }), false, true),
          new Step({ if: "steps.decide.outputs.go == '1'", name: "Ask for the action, and run it once an approval by someone else stands", shell: "bash", run: actionRunScript(forge, oidc) }),
        ],
      } as never) as never],
    ]);
    extra.push({ path: ACTION_PATHS[forge], content: header(image, input.imageFromConfig) + serialize(action) });
  }
  if (ephemeral) {
    // ephemeral: a schedule of its own destroys the copies whose TTL passed or whose pull request closed.
    const sweep = new Map<string, never>([
      ["workflow", new Workflow({ name: "terragucci ephemeral", on: { schedule: [{ cron: resumeCron(ephemeral.sweep) }], workflow_dispatch: {} }, env: jobEnv, permissions: { contents: "read" } }) as never],
      ["sweep", new Job({
        "runs-on": "ubuntu-latest",
        container: { image },
        permissions: { contents: "write", "pull-requests": "read", ...(needsToken ? { "id-token": "write" } : {}) },
        ...openid(needsToken),
        concurrency: { group: "terragucci-ephemeral-sweep-${{ github.repository }}", "cancel-in-progress": false },
        env: { ...passed, TG_TOKEN: "${{ github.token }}", ...headersEnv },
        steps: steps(new Step({ name: "Destroy the ephemeral copies whose TTL passed or whose pull request closed", shell: "bash", run: ephemeralSweepScript(forge, oidc, binary) }), false, true),
      } as never) as never],
    ]);
    extra.push({ path: EPHEMERAL_PATHS[forge], content: header(image, input.imageFromConfig) + serialize(sweep) });
  }
  // review.agent: the review is a workflow of its own, which the forge runs from the default branch (render-review.ts).
  if (input.review) extra.push({ path: REVIEW_PATHS[forge], content: header(image, input.imageFromConfig) + serialize(reviewWorkflow(forge, image, input.review, { pipelineName: "terragucci", env: jobEnv })) });
  if (input.templates) extra.push({ path: REQUEST_PATHS[forge], content: header(image, input.imageFromConfig) + serialize(requestWorkflow(image, jobEnv, tokenEnv)) });
  if (rollouts) extra.push({ path: ROLLOUT_PATHS[forge], content: header(image, input.imageFromConfig) + serialize(rolloutWorkflow(forge, image, rollouts, jobEnv, tokenEnv, installStep ? { name: installName, run: installStep } : undefined)) });
  const ghNeeds = new Map(ghWaves.jobs.map(([n, j]) => [n, needsOf(j.needs)]));
  const ghApplyJobs = applyJobs.map((j) => ({ name: j.name, needs: ghNeeds.get(j.name) ?? [], wave: j.wave, applies: j.applies }));
  return { path: PIPELINE_PATHS[forge], content: header(image, input.imageFromConfig) + serialize(entities) + ownJobsYAML(input.ownJobs, [...entities.keys()].filter((k) => k !== "workflow"), forge), applyJobs: ghApplyJobs, ...(extra.length ? { extra } : {}) };
}

/**
 * The request job's script: the dispatch's inputs, read from the environment so
 * no value is pasted into the shell, become `terragucci request --via form`,
 * with the person who dispatched the run as the requester, and `--app` and
 * `--claimed-by` when the dispatch gave them.
 */
export function requestScript(): string {
  return [
    "set -eu",
    'inputs="$(mktemp)"',
    'printf \'%s\' "${TG_INPUTS:-}" > "$inputs"',
    '[ -s "$inputs" ] || printf \'{}\' > "$inputs"',
    'set -- "$TG_TEMPLATE" --name "$TG_NAME" --inputs-file "$inputs" --via form --requested-by "$TG_REQUESTED_BY"',
    '[ -z "${TG_VERSION:-}" ] || set -- "$@" --version "$TG_VERSION"',
    '[ -z "${TG_APP:-}" ] || set -- "$@" --app "$TG_APP"',
    '[ -z "${TG_CLAIMED_BY:-}" ] || set -- "$@" --claimed-by "$TG_CLAIMED_BY"',
    'terragucci request "$@"',
  ].join("\n");
}

/**
 * The request workflow (GitHub and Forgejo): dispatched with REQUEST_INPUTS, it runs
 * `terragucci request` from the default branch, which pushes `request/<template>/<app>`
 * (`request/<template>/<app>/<addon>` for an add-on) and opens its pull request. It pushes and opens with `token_env`'s secret when the config
 * names one: GitHub starts no workflow for a pull request the job's own token opens, so
 * the app's root would get no plan. Without it, the job's own token.
 */
function requestWorkflow(image: string, env: Record<string, string>, tokenEnv: string | undefined): Map<string, never> {
  const token = tokenEnv ? `\${{ secrets.${tokenEnv} }}` : "${{ github.token }}";
  const workflow = new Workflow({
    name: "terragucci-request",
    on: { workflow_dispatch: { inputs: REQUEST_INPUTS } },
    env,
    permissions: { contents: "read" },
    // One run per app (or add-on of an app) at a time: two would race to push its branch.
    concurrency: { group: "terragucci-request-${{ github.repository }}-${{ github.event.inputs.app }}-${{ github.event.inputs.name }}", "cancel-in-progress": false },
  } as never);
  const request = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    // It pushes the request's branch, records the request on chant/lifecycle and opens the pull request.
    permissions: { contents: "write", "pull-requests": "write" },
    env: {
      TG_TOKEN: token,
      TG_TEMPLATE: "${{ github.event.inputs.template }}",
      TG_VERSION: "${{ github.event.inputs.version }}",
      TG_NAME: "${{ github.event.inputs.name }}",
      TG_INPUTS: "${{ github.event.inputs.inputs }}",
      TG_APP: "${{ github.event.inputs.app }}",
      TG_REQUESTED_BY: "${{ github.triggering_actor || github.actor }}",
      TG_CLAIMED_BY: "${{ github.event.inputs.claimed_by }}",
    },
    steps: [
      new Step({ uses: CHECKOUT, with: { "fetch-depth": 0, ...(tokenEnv ? { token } : {}) } }),
      new Step({ name: "Open the pull request that adds the app's root or the add-on from the template", shell: "bash", run: requestScript() }),
    ],
  } as never);
  return new Map<string, never>([["workflow", workflow as never], ["request", request as never]]);
}

/**
 * The rollout workflow (GitHub and Forgejo): on its schedule, or by hand,
 * `terragucci respond rollout --mode apply` from the default branch; dispatched
 * with `module` (ROLLOUT_INPUTS), it starts that rollout instead. It opens
 * pull requests and pushes their branches with `token_env`'s secret when the
 * config names one: GitHub starts no workflow for a pull request the job's own
 * token opens, so the wave would get no plan. Without it, the job's own token.
 */
function rolloutWorkflow(forge: Exclude<ForgeName, "gitlab">, image: string, cron: string, env: Record<string, string>, tokenEnv: string | undefined, install?: { name: string; run: string }): Map<string, never> {
  const token = tokenEnv ? `\${{ secrets.${tokenEnv} }}` : "${{ github.token }}";
  const workflow = new Workflow({
    name: "terragucci-rollout",
    on: { schedule: [{ cron }], workflow_dispatch: { inputs: ROLLOUT_INPUTS } },
    env,
    permissions: { contents: "read" },
    // One run at a time: two would both see a wave due and race to open it.
    concurrency: { group: "terragucci-rollout-${{ github.repository }}", "cancel-in-progress": false },
  } as never);
  const rollout = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    // It reads each wave's merge commit's checks and statuses, pushes the next wave's branch and opens its pull request.
    permissions: { contents: "write", "pull-requests": "write", statuses: "read", ...(forge === "github" ? { checks: "read" } : {}) },
    env: { TG_TOKEN: token, TG_MODULE: "${{ github.event.inputs.module }}", TG_VERSION: "${{ github.event.inputs.version }}" },
    steps: [
      new Step({ uses: CHECKOUT, with: { "fetch-depth": 0, ...(tokenEnv ? { token } : {}) } }),
      ...(install ? [new Step(install)] : []),
      new Step({ name: "Start the dispatched rollout, or open the next wave of each rollout whose last wave merged and applied", shell: "bash", run: rolloutDispatchScript(forge, tokenEnv) }),
    ],
  } as never);
  return new Map<string, never>([["workflow", workflow as never], ["rollout", rollout as never]]);
}
