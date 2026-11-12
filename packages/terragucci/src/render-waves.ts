/**
 * terragucci's apply waves on chant's Op waves generators (terragucci issue
 * 1411): `buildGithubOpWavesDoc`, `buildForgejoOpWavesDoc` and
 * `generateGitlabOpWavesPipeline` write the wave jobs, the status jobs, the
 * stale notes job, the control dispatch, the resume and, with
 * `apply.when: pull-request`, the split jobs before merge and the merge job.
 *
 * terragucci gives the jobs' shape and its names. The rules of each wave
 * (its gate, the approval mode, the branches, the resume and the notify
 * settings) are rendered at run time by `terragucci waves-spec` from the
 * spec file and terragucci.yml at base (`renderSpec`), and each job runs
 * `terragucci run wave`, chant's line with terragucci's hooks in its
 * process. So the shape here carries only what decides the jobs and their
 * steps: the waves, their shares and job groups, the runner, the cloud
 * identities, the installs and each job's variables.
 *
 * The names stay terragucci's: `apply-wave-<k>`, `apply-wave-<k>-share-<n>`,
 * `apply-wave-<k>-<group>`, `apply-rest`, `apply-done`, `pr-merge`,
 * `control`, `resume`, the `terragucci/apply` status and the
 * `terragucci-report-<job>` artifacts.
 */
import { buildGithubOpWavesDoc } from "@intentius/chant-lexicon-github/components/generate-op-waves-pipeline";
import { buildForgejoOpWavesDoc } from "@intentius/chant-lexicon-forgejo/components/generate-op-waves-pipeline";
import { generateGitlabOpWavesPipeline } from "@intentius/chant-lexicon-gitlab/components/generate-op-waves-pipeline";
import { cloudLogin, type CloudLoginSpec } from "@intentius/chant/ci-login";
import type { CloudTradeSpec } from "@intentius/chant/ci-identity";
import { parseYAML } from "@intentius/chant/yaml";
import { WAVES_OP, WAVES_SPEC } from "./chant-waves";
import { TERRAGUCCI_WORDS } from "./ci-words";
import type { ResolvedControl } from "./control-repo";
import type { ApplyGroup } from "./cloud-identity";
import type { ApplyMerge, ApplyRequire, ForgeName, RunnerSpec } from "./config";

/** The status context the waves' status jobs post, which branch protection names. */
export const APPLY_STATUS = "terragucci/apply";
/** The control status a commit carries once the control repo was told. */
export const CONTROL_STATUS = "terragucci/control";
/** The report each wave job keeps, as it did. */
const REPORT_DIR = "terragucci-report";
/** The agent's input of `respond.apply-failed: agent`, kept in the report's artifact. */
const RESPOND_DIR = "terragucci-respond";
/** The GitLab forge environment the merge token is scoped to. */
export const MERGE_ENVIRONMENT = "terragucci-merge";

/** The dispatch inputs of the waves on GitHub and Forgejo, beside the re-plan's `pr` and `root`. */
export const WAVES_DISPATCH_INPUTS = { pr: "apply_pr", head: "apply_head", digest: "apply_digest", wave: "apply_wave", commit: "apply_commit" } as const;

/** The artifacts chant's wave jobs keep beside terragucci's report. */
const ARTIFACT_NAMES = {
  outcome: "terragucci-report-{job}-outcome",
  decision: "terragucci-wave-{wave}",
  plan: "terragucci-plan-wave-{wave}",
  checks: "terragucci-checks-{job}",
  earlier: "terragucci-report-apply-wave-*",
};

/** A job the generator names, as `OpWavesJobRef` gives it. */
interface JobRef {
  role: string;
  wave?: number;
  share?: number;
  group?: string;
  rest?: true;
}

/**
 * terragucci's names for chant's wave jobs, the same on every forge: a
 * wave's job (and a wide wave's deciding job) `apply-wave-<k>`, a share's
 * `-share-<n>`, a group's `-<group>`, the split jobs before merge
 * `-plan`, `-gate` and `-record` beside the applying job `apply-wave-<k>`,
 * the last wave's status job `apply-done`, and `pr-merge`, `control` and
 * `resume`. The rest keep chant's names (`stale-notes`, a job's `-policy`).
 */
export function wavesJobNames(count: number): (j: JobRef) => string | undefined {
  return (j) => {
    const w = j.rest ? "apply-rest" : `apply-wave-${j.wave}`;
    const part = `${j.group !== undefined ? `-${j.group}` : ""}${j.share !== undefined ? `-share-${j.share}` : ""}`;
    switch (j.role) {
      case "wave":
      case "decide":
        return w;
      case "share":
      case "group":
      case "apply":
        return `${w}${part}`;
      case "plan":
      case "gate":
      case "record":
        return `${w}-${j.role}`;
      case "apply-status":
        return j.rest || j.wave === count ? "apply-done" : `${w}-status`;
      case "before-merge-done":
        return "pr-merge";
      case "control":
        return "control";
      case "resume":
        return "resume";
      default:
        return undefined;
    }
  };
}

/** What the pipeline hands the waves. */
export interface WavesInput {
  forge: ForgeName;
  image: string;
  /** Each wave's roots, as the pipeline cut them (canary first). A Terragrunt repo: its layers, each a wave of units found at plan time. */
  waves: string[][];
  terragrunt?: { binary: string; exclude?: string[]; parallelism?: number };
  /** `waves.jobs`: a wave's share count, by its index from 0. */
  shares: (i: number) => number;
  /** One apply job per identity. */
  groups?: ApplyGroup[];
  /** The runner of the apply jobs (`runner.apply`, else `runner.default`). */
  runner?: RunnerSpec;
  /** Each wave's (or a deciding job's) cloud identities, traded before the checkout. */
  trade?: CloudTradeSpec;
  /** With groups: the deciding job's trade, on the plan identities. */
  decideTrade?: CloudTradeSpec;
  /** A group's trade, by its name. */
  groupTrade?: (g: ApplyGroup) => CloudTradeSpec | undefined;
  /** oidc.azure: the login in the command's step, and the job's token. */
  azureLogin?: CloudLoginSpec;
  /** The installs and the Terragrunt cache: each wave job's steps before its command. */
  setup: Array<{ name: string; run: string } | ({ name: string } & Record<string, unknown>)>;
  /** Shell lines in the command's own step, before the command (Terragrunt's cache exports and unit roles). */
  prelude: string[];
  /** `synth`: a step that writes the roots, before the command. */
  synth?: string;
  /** Each wave job's own variables: GitHub and Forgejo `env:`, GitLab `variables:`. */
  variables: Record<string, string>;
  /** GitLab: the pipeline's variables every wave job takes (the project token under chant's name). */
  pipelineVariables?: Record<string, string>;
  /** `respond.apply-failed: agent`: the agent's input joins the report's artifact. */
  agentInput?: boolean;
  /** `review.agent`: the waves read the review's verdict from the pull request's run. */
  review?: boolean;
  /** `apply.branches`: the other branches whose pushes apply. */
  branches: string[];
  /** `apply.when: pull-request`, with `apply.merge` and the merge token's secret. */
  beforeMerge?: { merge: ApplyMerge; tokenSecret?: string };
  /** `apply.resume`: the schedule. */
  resume?: string;
  /** `notify`, as terragucci.yml names its secrets. */
  notify?: { slack?: string; teams?: string; webhook?: string; webhook_key?: string; relay?: string; relay_key?: string };
  /** `respond`'s apply-failed and wave-refused, as chant posts them. */
  respond?: Record<string, string>;
  control?: ResolvedControl;
  /** Terragrunt: GitLab's `cache:` of each wave job. */
  cache?: unknown;
  /** GitLab: the condition every wave job's rule adds (the schedules and pipelines the waves sit out). */
  gitlabRunIf?: string;
}

/** The spec's `respond`: apply-failed's agent is chant's triage, and the agent's input terragucci's report keeps. */
function respondOf(respond: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!respond) return undefined;
  const out = Object.fromEntries(Object.entries(respond).filter(([k, v]) => (k === "wave-refused" || k === "apply-failed") && v !== "off").map(([k, v]) => [k, v === "agent" ? "triage" : v]));
  return Object.keys(out).length ? out : undefined;
}

/**
 * The waves' shape for the generator: each wave's runs, shares and job
 * groups, with the job's runner, cloud identities, installs and variables.
 * The rules here are placeholders the rendered spec replaces in each job:
 * every wave is gated, as chant treats a wave the rendered spec lacks.
 */
export function wavesShape(input: WavesInput): Record<string, unknown> {
  const forge = input.forge;
  const groups = input.groups;
  const waves = input.waves.map((roots, i) => {
    const own = groups
      ? groups.filter((g) => roots.some((r) => g.roots.includes(r))).map((g) => {
          const mine = roots.filter((r) => g.roots.includes(r));
          const n = input.shares(i) > 1 ? Math.min(input.shares(i), mine.length) : 1;
          const cloud = input.groupTrade?.(g);
          return {
            name: g.name,
            runs: mine,
            ...(n > 1 ? { shares: n } : {}),
            ...(g.runner !== undefined ? { runner: g.runner } : {}),
            // Forgejo refuses a group's forge environment (init says so first).
            ...(g.forgeEnvironment !== undefined && forge !== "forgejo" ? { environment: { name: g.forgeEnvironment } } : {}),
            ...(cloud ? { cloud } : {}),
          };
        })
      : undefined;
    const n = input.shares(i);
    const cloud = groups ? input.decideTrade : input.trade;
    return {
      name: `wave-${i + 1}`,
      runs: input.terragrunt ? [] : roots.map((target) => ({ target })),
      ...(input.terragrunt ? { discover: true } : {}),
      gate: "always",
      ...(n > 1 && !own ? { shares: n } : {}),
      ...(own ? { jobs: own } : {}),
      ...(Object.keys(input.variables).length ? { variables: input.variables } : {}),
      ...(input.setup.length ? { setup: input.setup } : {}),
      ...(cloud ? { cloud } : {}),
      ...(input.azureLogin ? { idTokens: azureIdTokens(forge, input.azureLogin) } : {}),
    };
  });
  const notify = input.notify
    ? {
        ...(input.notify.slack ? { slack: input.notify.slack } : {}),
        ...(input.notify.teams ? { teams: input.notify.teams } : {}),
        ...(input.notify.webhook ? { webhook: input.notify.webhook, ...(input.notify.webhook_key ? { key: input.notify.webhook_key } : {}) } : {}),
        ...(input.notify.relay_key ? { relay: input.notify.relay_key } : {}),
        ...(input.notify.relay ? { relayName: input.notify.relay } : {}),
      }
    : undefined;
  const respond = respondOf(input.respond);
  const c = input.control;
  return {
    name: WAVES_OP,
    op: WAVES_OP,
    gateName: "wave-{k}",
    approvals: { spend: true, remainder: true, spendStanding: true },
    defaultBranch: true,
    standDown: true,
    ...(input.branches.length ? { branches: input.branches } : {}),
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    ...(input.resume ? { resume: { schedule: input.resume } } : {}),
    ...(notify && Object.keys(notify).length ? { notify } : {}),
    ...(respond ? { respond } : {}),
    ...(c
      ? {
          control: {
            member: c.member,
            repo: c.repo,
            forge: c.forge,
            ...(c.op ? { op: c.op } : {}),
            ref: c.ref,
            tokenSecret: c.tokenEnv,
            readTokenSecret: c.readTokenEnv,
            // GitLab's control job runs once per pipeline in its resource group; GitHub and Forgejo mark the commit.
            ...(forge !== "gitlab"
              ? { sentCheck: `terragucci post sent ${CONTROL_STATUS} --forge ${forge}`, markSent: `terragucci post status ${CONTROL_STATUS} success "told ${c.repo} that $member applied" --forge ${forge}` }
              : {}),
          },
        }
      : {}),
    step: input.terragrunt
      ? { kind: "terragrunt-apply", unit: "{target}", layers: input.waves, ...(input.terragrunt.exclude?.length ? { exclude: input.terragrunt.exclude } : {}), binary: input.terragrunt.binary, terragrunt: "terragrunt", ...(input.terragrunt.parallelism !== undefined ? { parallelism: input.terragrunt.parallelism } : {}) }
      : { kind: "terraform-apply", root: "{target}", dir: "{target}" },
    waves: input.terragrunt ? waves.map((w) => ({ ...w, together: true })) : waves,
  };
}

/** oidc.azure's tokens, as the login names them. */
function azureIdTokens(forge: ForgeName, login: CloudLoginSpec): Record<string, string> {
  const l = cloudLogin(forge, login, forge === "gitlab" ? { sameStep: true } : { restart: true }) as { idTokens?: Record<string, string | { aud: string }> };
  return Object.fromEntries(Object.entries(l.idTokens ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : v.aud]));
}

/** The lines each wave job runs in its command's step before the command: oidc.azure's login, then the prelude. */
function preludeOf(input: WavesInput): string[] {
  const login = input.azureLogin ? (cloudLogin(input.forge, input.azureLogin, input.forge === "gitlab" ? { sameStep: true } : { restart: true }) as { steps: { run: string[] }[] }).steps.flatMap((s) => s.run) : [];
  return [...login, ...input.prelude];
}

/**
 * The options every forge's generator takes. `pipeline` is what chant's
 * product pipeline gives the generator (`productPipelineJobs(...).waves.pipeline`):
 * the apply status, the stale marking of the plan notes beside wave 1, the
 * before-merge mode and the names the comment job re-runs or dispatches by.
 */
function commonOptions(input: WavesInput, spec: { waves: unknown[] }, pipeline: Record<string, unknown>): Record<string, unknown> {
  const prelude = preludeOf(input);
  const job = {
    artifact: { step: "Keep the apply report", name: `${REPORT_DIR}-{job}`, path: input.agentInput ? [`${REPORT_DIR}/`, `${RESPOND_DIR}/`] : `${REPORT_DIR}/` },
    ...(input.synth ? { before: [{ name: "Write the roots", run: [input.synth] }] } : {}),
    ...(prelude.length ? { prelude } : {}),
  };
  return {
    specFile: WAVES_SPEC,
    bin: "terragucci",
    // terragucci's words: the control dispatch's event and the control repo's workflow are terragucci-applied and
    // terragucci-dependents.yml, as the control repo's pipeline (./control-repo.ts) listens for them.
    words: TERRAGUCCI_WORDS,
    image: input.image,
    renderSpec: { command: ["terragucci", "waves-spec"], runsAtHead: true },
    ...pipeline,
    applyStatus: { context: APPLY_STATUS },
    waveJobs: Object.fromEntries((spec.waves as { name: string }[]).map((w) => [w.name, job])),
    jobNames: wavesJobNames(input.waves.length),
  };
}

/** chant's before-merge settings for the product pipeline (`wavesBeforeMerge`), from apply.merge and its token, and apply.requires (unset: every one). */
export function wavesBeforeMerge(forge: ForgeName, bm: { merge: ApplyMerge; tokenSecret?: string }, requires?: readonly ApplyRequire[]): Record<string, unknown> {
  return {
    ...(requires ? { requires: [...requires] } : {}),
    merge: bm.merge,
    ...(bm.tokenSecret ? { mergeTokenSecret: bm.tokenSecret } : {}),
    ...(forge === "gitlab" ? { environment: MERGE_ENVIRONMENT } : { workflowFile: "terragucci.yml", dispatchInputs: { pr: WAVES_DISPATCH_INPUTS.pr, head: WAVES_DISPATCH_INPUTS.head, digest: WAVES_DISPATCH_INPUTS.digest } }),
  };
}

/** What the waves add to the GitHub or Forgejo workflow. */
export interface GithubWaves {
  /** The jobs, by name, in the generator's order. */
  jobs: Array<[string, Record<string, unknown>]>;
  /** The workflow's dispatch inputs the waves read. */
  inputs: Record<string, unknown>;
  /** `apply.resume`: the resume workflow's jobs. */
  resume?: Array<[string, Record<string, unknown>]>;
  /** The shape the jobs were built from. */
  spec: Record<string, unknown>;
}

/** GitHub and Forgejo: the waves' jobs in terragucci.yml, and the resume workflow's. */
export function githubWaves(input: WavesInput & { forge: "github" | "forgejo" }, pipeline: Record<string, unknown>): GithubWaves {
  const spec = wavesShape(input);
  const onDefault = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
  const refs = [onDefault, ...input.branches.map((b) => `github.ref == 'refs/heads/${b}'`)];
  const options = {
    ...commonOptions(input, spec as { waves: unknown[] }, pipeline),
    workflowFile: "terragucci.yml",
    resumeWorkflowFile: "terragucci-resume.yml",
    artifactNames: ARTIFACT_NAMES,
    // Before merge a push runs the confirm job alone, and the waves run on a decided head's dispatch.
    runIf: input.beforeMerge ? "false" : refs.length > 1 ? `(${refs.join(" || ")})` : refs[0]!,
    dispatchInputs: WAVES_DISPATCH_INPUTS,
    firstWaveNeeds: ["check"],
    // The responses post on the pull request, and review.agent's verdict is read from its run.
    commandToken: { permissions: { "pull-requests": "write", ...(input.review ? { actions: "read" } : {}) } },
    ...(input.control ? { controlGroup: "terragucci-control-${{ github.repository }}-{commit}" } : {}),
  };
  const built = input.forge === "github" ? buildGithubOpWavesDoc(spec as never, options as never) : buildForgejoOpWavesDoc(spec as never, options as never);
  const doc = built.doc as unknown as { jobsDoc: Record<string, Record<string, unknown>>; on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } } };
  const resume = built.resumeDoc as unknown as { jobsDoc: Record<string, Record<string, unknown>> } | undefined;
  const asJobs = (jobs: Record<string, Record<string, unknown>>): Array<[string, Record<string, unknown>]> => Object.entries(jobs).map(([n, j]) => [n, withContainer(j)]);
  return {
    jobs: asJobs(doc.jobsDoc),
    inputs: doc.on?.workflow_dispatch?.inputs ?? {},
    ...(resume ? { resume: asJobs(resume.jobsDoc).map(([n, j]): [string, Record<string, unknown>] => [n, n === "resume" ? withMigrationResume(j) : j]) } : {}),
    spec,
  };
}

/** The resume line of the waves' op, as chant writes it, and the same line for the state migrations' gates. */
const RESUME_WAVES = `terragucci run resume --op ${WAVES_OP}`;
// The migrations' op, migrate.ts's MIGRATE_OP (migrate.ts imports render.ts, which imports this file).
const RESUME_MIGRATIONS = "terragucci run resume --op tf-migrate";

/**
 * The resume job also starts a wave 1 that waits on a state migration's own
 * gate (`tf-migrate`, ./migrate.ts) once that approval stands, as
 * terragucci's own resume did: chant's resume takes one op, so a second step
 * (GitHub, Forgejo) or line (GitLab) runs it for the migrations' gates.
 */
function withMigrationResume(job: Record<string, unknown>): Record<string, unknown> {
  const steps = (job.steps as Array<Record<string, unknown>> | undefined) ?? [];
  const at = steps.findIndex((s) => typeof s.run === "string" && s.run.includes(RESUME_WAVES));
  if (at < 0) return job;
  const waves = steps[at]!;
  const migrations = { ...waves, name: "Resume the state migrations whose approval arrived", if: "${{ !cancelled() }}", run: String(waves.run).replace(RESUME_WAVES, RESUME_MIGRATIONS) };
  return { ...job, steps: [...steps.slice(0, at + 1), migrations, ...steps.slice(at + 1)] };
}

/** GitLab's resume job runs both resumes, and fails when either failed. */
function withGitlabMigrationResume(job: Record<string, unknown>): Record<string, unknown> {
  const script = (job.script as string[] | undefined) ?? [];
  if (!script.some((l) => l.includes(RESUME_WAVES))) return job;
  return { ...job, script: script.map((l) => (l.includes(RESUME_WAVES) ? `rc=0; ${l} || rc=$?; ${l.replace(RESUME_WAVES, RESUME_MIGRATIONS)} || rc=$?; exit $rc` : l)) };
}

/** Every job of terragucci's workflow names its container as `{ image }`. */
function withContainer(job: Record<string, unknown>): Record<string, unknown> {
  return typeof job.container === "string" ? { ...job, container: { image: job.container } } : job;
}

/** What the waves add to GitLab's pipeline. */
export interface GitlabWaves {
  /** The jobs, by name, in the generator's order. */
  jobs: Array<[string, Record<string, unknown>]>;
  /** The stages the jobs run in. */
  stages: string[];
  spec: Record<string, unknown>;
}

/** GitLab: the waves' jobs in `.gitlab/terragucci.yml`, the resume job among them. */
export function gitlabWaves(input: WavesInput & { forge: "gitlab"; tokenEnv?: string }, pipeline: Record<string, unknown>): GitlabWaves {
  const spec = wavesShape(input);
  const bm = input.beforeMerge;
  // Before merge the split plan and applying jobs drop chant's token names; a project token by another name goes too.
  const tokenUnset = bm && input.tokenEnv && input.tokenEnv !== "GITLAB_TOKEN" ? [`unset ${input.tokenEnv}`] : [];
  const common = commonOptions({ ...input, prelude: [...tokenUnset, ...input.prelude] }, spec as { waves: unknown[] }, pipeline);
  const gen = generateGitlabOpWavesPipeline(spec as never, {
    ...common,
    opsFileName: ".gitlab/terragucci.yml",
    // The waves in terragucci's apply stage, the resume in its resume stage, the control dispatch in its control stage.
    stageNames: (s: { role: string }) => (s.role === "resume" ? "resume" : s.role === "control" ? "control" : "apply"),
    ...(input.gitlabRunIf ? { runIf: input.gitlabRunIf } : {}),
    ...(input.cache !== undefined ? { cache: input.cache } : {}),
    ...(input.control ? { controlGroup: "terragucci-control" } : {}),
    ...(input.resume ? { resumeGroup: "terragucci-resume" } : {}),
  } as never) as unknown as { files: { yaml: string }[] };
  const doc = parseYAML(gen.files[0]!.yaml) as Record<string, unknown>;
  const stages = Array.isArray(doc.stages) ? (doc.stages as string[]) : [];
  // The project token under chant's name, in the waves' jobs alone: the plan jobs never see it.
  const own = { ...(input.pipelineVariables ?? {}) };
  const jobs = Object.entries(doc)
    .filter(([k, v]) => k !== "stages" && k !== "variables" && k !== "workflow" && k !== "default" && v !== null && typeof v === "object" && !Array.isArray(v) && "script" in (v as Record<string, unknown>))
    .map(([k, v]): [string, Record<string, unknown>] => {
      const job = k === "resume" ? withGitlabMigrationResume(v as Record<string, unknown>) : (v as Record<string, unknown>);
      return [k, Object.keys(own).length ? { ...job, variables: { ...own, ...((job.variables as Record<string, string> | undefined) ?? {}) } } : job];
    });
  return { jobs, stages, spec };
}
