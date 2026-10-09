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
 *        after it. One apply per project at a time; posts one
 *        terragucci/apply status and marks plan notes the push made stale.
 *        A Terragrunt repo's waves are the same jobs over its units' dependency
 *        layers, each behind the same gate; the last job also runs any layer
 *        the repo grew after init wrote the pipeline.
 * apply-comment  `/terragucci apply [wave-<n>]` on a merged pull request
 *        (GitHub and Forgejo, plain roots and Terragrunt units): the same
 *        stage at its merge commit, under the same lock, approving nothing.
 * mr-apply  GitLab with `apply.when: pull-request`: the default branch's
 *        pipeline the comments job starts for an open merge request's
 *        `/terragucci apply`, `lock` or `unlock`; it reads the merge request
 *        again and applies its head in waves, and `pr-merge` merges it.
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
 *        `apply.when: pull-request`, start the `mr-apply` pipeline).
 *
 * Each stage is one job here; the file holds all of them.
 */
// Each lexicon's serializer and generated entities, never its entry point: the
// entry points carry lint rules, codegen and the TypeScript compiler, which the
// bundle must not (terragucci#18).
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
import { APPLY_REQUIRES, COMMENTS_GITLAB_ONLY, WAVE_JOBS_NOT_GITLAB, WAVE_JOBS_NOT_PR_APPLY, PR_APPLY_NEEDS_ON_GITLAB, PROTECTED_TOKEN_NEEDS_COMMENTS, NO_GITLAB_PLAN_LOCKS, responseTo, type ApplyMerge, type ApplyRequire, type ApplyWhen, type Approval, type Binary, type ForgeName, type Gate, type GitLabToken, type OidcSettings, type RespondEvent, type RolePair } from "./config";
import { DEFAULT_TOKEN_ENV } from "./forge";
import { MR_VAR } from "./comment-apply-gitlab";
import { PLAN_NOTE_FILE, PLAN_STATUS_FILE } from "./plan-note-gitlab";
import type { AgentCommentInput } from "./agent-comment";
import { AGENT_COMMENT_IF, agentCommentJobs } from "./render-agent";
import { ATLANTIS_COMMENTS_ENV } from "./comment";
import { applyWaves, DECIDED_DIR, waveShares } from "./apply";
import { CHECK_DIR } from "./check";
import { COSIGN_VERSION, INFRACOST_VERSION, type Tool } from "./install";
import {
  cacheExports,
  credentialsScript,
  forgeCache,
  terragruntCheckScript,
  terragruntJobEnv,
  type TerragruntPipelineInput,
} from "./render-terragrunt";

export const MARKER = "# Generated by terragucci.";

/** The rollout workflow, beside the pipeline on GitHub and Forgejo. GitLab's rollout job is in the pipeline's file. */
export const ROLLOUT_PATHS: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: ".github/workflows/terragucci-rollout.yml",
  forgejo: ".forgejo/workflows/terragucci-rollout.yml",
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
  /** Roots in apply order: each inner list applies together. In Terragrunt mode, units by wave. */
  layers: string[][];
  /** Set for a Terragrunt repo: the jobs run Terragrunt over its units. */
  terragrunt?: TerragruntPipelineInput & { installs: { tool: Tool; version: string }[] };
  /** `synth`: the command that writes the roots (CDK Terrain's `npx cdktn synth`), run in every job that reads them. */
  synth?: string;
  /** `notify`: the secrets holding a Slack or Teams incoming webhook, or a generic webhook and its signing key, which the apply jobs post a waiting, refused or failed wave to. */
  notify?: { slack?: string; teams?: string; webhook?: string; webhook_key?: string };
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
  /** Set when `modules.publish` is: the pipeline gets a job that publishes changed modules after apply. */
  publish?: boolean;
  /** Set when `modules.attest` is: the publish job gets the signing key's two secrets (GitHub and Forgejo; GitLab's CI variables are already there). */
  attest?: boolean;
  /** A cron schedule: the pipeline gets a drift job that runs on it. */
  drift?: string;
  /** `rollouts:`, when `respond.rollout` is not off: the cron of the job that continues every rollout in flight. */
  rollouts?: string;
  /** GitLab only: the comments schedule's cron. The pipeline gets a `comments` job for the pipelines that schedule starts. */
  comments?: string;
  /**
   * `apply.resume`: minutes between the resume job's runs. On GitHub and
   * Forgejo the job is a workflow of its own on that schedule; on GitLab a
   * pipeline schedule with TERRAGUCCI_SCHEDULE=resume starts it.
   */
  resume?: number;
  /** The repo carries state migration files (migrate.ts migrationFiles): under gate: never, GitHub's apply jobs still need to write chant/lifecycle, where a migration's gate is. */
  migrations?: boolean;
  /** GitLab only, `gitlab.token`: with `protected`, no merge request pipeline holds the token, and the comments job posts the plan notes. */
  gitlabToken?: GitLabToken;
  /** Globs for the canary wave, which applies first. Plain roots only: a Terragrunt repo's layers are its waves already. */
  canary?: string[];
  /** `waves.jobs`: the most jobs one wave's roots or units spread across. A wave of more than one gets a job that decides it and a share job per part (GitHub and Forgejo). */
  waveJobs?: number;
  /** When a wave waits for an approval. Default on-destroy. */
  gate?: Gate;
  /** A control repo's `approval:`, which the project's repo has no config to carry: the waves' `--approval`. */
  approval?: Approval;
  /** `approval: pr-review`: on GitHub and Forgejo the plan job and a review job post `terragucci/approval` on the pull request's head. */
  prReview?: boolean;
  /** The response to each event, from `respond:`; the jobs call `terragucci respond` for each one that is not off. */
  respond?: Partial<Record<RespondEvent, string>>;
  /** `policy:` is set; the check job then runs the policy's tests, which read the policy from the default branch, so it clones with full history. */
  policy?: boolean;
  /** `agent.comment` is set: `/terragucci agent <ask>` gets the agent and agent-push jobs (render-agent.ts). GitHub and Forgejo only. */
  agentComment?: AgentCommentInput;
  /** `atlantis_comments: true`: `atlantis plan` and `atlantis apply` comments start the jobs `/terragucci plan` and `/terragucci apply` do, and every job gets TG_ATLANTIS_COMMENTS=1, so the comment commands read them (comment.ts). */
  atlantisComments?: boolean;
  /** `apply.when: pull-request`: an open pull request applies on `/terragucci apply` (on GitLab through the comments job and the `mr-apply` pipeline), and the push after the merge only confirms. In a Terragrunt repo its waves are the waves of units. */
  applyWhen?: ApplyWhen;
  /** `apply.merge`: with `auto`, a pull request whose every wave applied is merged. */
  applyMerge?: ApplyMerge;
  /** `apply.merge_token_env`: the secret whose token the `pr-merge` job merges with, in place of the job's own. Only that job gets it; on GitLab the comments job too, which starts the `mr-apply` pipeline with it. */
  applyMergeTokenEnv?: string;
  /** `apply.requires`: what an open pull request needs before it applies. Every requirement when unset. */
  applyRequires?: ApplyRequire[];
  /** `locks: plan`: the `pr-lock` job locks a pull request's roots from its first plan (GitHub and Forgejo). */
  locksPlan?: boolean;
}

export interface RenderedPipeline {
  path: string;
  content: string;
  /** Further workflow files on GitHub and Forgejo: the resume workflow, and the rollout workflow with `rollouts`. */
  extra?: { path: string; content: string }[];
}

/** The resume workflow's file, beside the pipeline's. A workflow of its own, since Forgejo does not say which of a workflow's schedules started a run. */
export const RESUME_PATHS: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: ".github/workflows/terragucci-resume.yml",
  forgejo: ".forgejo/workflows/terragucci-resume.yml",
};

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

/** The fmt commit after a failing check, on a branch other than the default branch. Never an approval, never a push to the default branch. */
export function fmtScript(binary: Binary, forge: ForgeName, tokenEnv?: string): string {
  return [
    "set -u",
    ...respondSetup(forge, tokenEnv),
    `terragucci respond fmt --mode apply --binary ${binary} --branch "${forge === "gitlab" ? "$CI_COMMIT_BRANCH" : "$GITHUB_REF_NAME"}" || true`,
  ].join("\n");
}

/** The tips response: one small pull request per tip, from the default branch after the apply. A response that fails never fails the job. */
export function tipsScript(binary: Binary, forge: ForgeName, tokenEnv?: string): string {
  return ["set -u", ...respondSetup(forge, tokenEnv), `terragucci respond tips --mode apply --binary ${binary} || true`].join("\n");
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
export function installScript(binary: Binary | Tool, version: string, forge: ForgeName): string {
  const dir = `dir="$(terragucci install ${binary} ${version})"`;
  return forge === "gitlab" ? `${dir}\nexport PATH="$dir:$PATH"` : `${dir}\necho "$dir" >> "$GITHUB_PATH"`;
}

/** The AWS CLI v2 release the drift job installs when attribution needs it, with each build's sha256 (the zips also verify against the AWS CLI team's PGP signature). */
export const AWS_CLI = {
  version: "2.37.9",
  sha256: {
    x86_64: "6b3a6a3d7bb3997928f0bdf7b866914224abf242c2e54e1dcebbe84bee64f356",
    aarch64: "e7d2cca3622af4765871fe9ce7eeed03acd09dca10a99ebc46e92f79d78765c0",
  },
} as const;

/**
 * The step that installs AWS CLI v2 for drift attribution, skipped when the job
 * already has `aws`. The CI images carry node but not curl or unzip, so node
 * downloads the zip and `unzip` comes from apt. The zip must match the pinned
 * sha256 for the runner's architecture before it is unpacked.
 */
export function awsCliScript(forge: ForgeName): string {
  const url = `https://awscli.amazonaws.com/awscli-exe-linux-$arch-${AWS_CLI.version}.zip`;
  return [
    "if ! command -v aws >/dev/null 2>&1; then",
    '  case "$(uname -m)" in',
    `    aarch64|arm64) arch=aarch64; sum=${AWS_CLI.sha256.aarch64} ;;`,
    `    *) arch=x86_64; sum=${AWS_CLI.sha256.x86_64} ;;`,
    "  esac",
    '  dir="$(mktemp -d)"',
    "  command -v unzip >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq --no-install-recommends unzip; }",
    `  node -e 'fetch(process.argv[1]).then((r) => { if (!r.ok) throw new Error("the AWS CLI download answered " + r.status); return r.arrayBuffer(); }).then((b) => require("fs").writeFileSync(process.argv[2], Buffer.from(b))).catch((e) => { console.error(e.message); process.exit(1); })' "${url}" "$dir/awscliv2.zip"`,
    '  echo "$sum  $dir/awscliv2.zip" | sha256sum -c -',
    '  unzip -q "$dir/awscliv2.zip" -d "$dir"',
    '  "$dir/aws/install" --install-dir "$dir/aws-cli" --bin-dir "$dir/bin"',
    forge === "gitlab" ? '  export PATH="$dir/bin:$PATH"' : '  echo "$dir/bin" >> "$GITHUB_PATH"',
    "fi",
  ].join("\n");
}

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

/** With `notify`, the line a wave's outcome runs: post it to the chat webhooks. A webhook that fails never fails the job. */
function notifyLine(event: "waiting" | "refused" | "failed", wave: string): string {
  return `terragucci notify ${event} --wave ${wave} --outcome "$outcome" --outcome-json "$outcome_json" || true; `;
}

/** With `notify`, the stage also writes its outcome as JSON (`TG_OUTCOME_JSON`), which notify reads. */
const OUTCOME_JSON = 'outcome_json="$(mktemp)"';
const outcomeEnv = (notify: boolean | undefined): string => (notify ? 'TG_OUTCOME_JSON="$outcome_json" ' : "");

export function checkScript(binary: Binary, roots: string[], synth?: string, rootPins = false): string {
  // With roots that pin their own version, each root inits and validates with its own binary, installed when the job's is not it.
  const loop = rootPins
    ? [
        `  bin="$(terragucci binary "$dir" --binary ${binary})" || { failed=1; continue; }`,
        '  "$bin" -chdir="$dir" init -backend=false -input=false -no-color >/dev/null',
        '  terragucci check-root "$dir" --binary "$bin" || failed=1',
      ]
    : [
        `  ${binary} -chdir="$dir" init -backend=false -input=false -no-color >/dev/null`,
        // validate's diagnostics and, for choudoufu, live-check's refusals go to the log and the check report; a root that fails does not stop the next.
        `  terragucci check-root "$dir" --binary ${binary} || failed=1`,
      ];
  return [
    "set -eu",
    ...(synth
      ? [
          synthScript(synth),
          // The files git tracks, one directory at a time: what synth installs (node_modules) carries .tf files of its own.
          `git ls-files '*.tf' '*.tofu' '*.tfvars' | sed 's#/[^/]*$##; s#^[^/]*$#.#' | sort -u | while IFS= read -r d; do ${binary} fmt -check -diff "$d" || exit 1; done`,
        ]
      : [`${binary} fmt -check -recursive -diff .`]),
    "failed=0",
    `for dir in ${roots.map(sh).join(" ")}; do`,
    ...loop,
    "done",
    // With `policy:` set, the policy's own tests; no `policy:` key prints nothing.
    "terragucci check-policy || failed=1",
    'exit "$failed"',
  ].join("\n");
}

/**
 * The forge calls the pipeline makes beyond running the binary: commit statuses,
 * the plan note, marking a note stale, and the OIDC token. Plain Node, because
 * the CI images carry node and git but not curl or jq. A failed status or note
 * never fails the job; a failed token request does.
 */
const FORGE_API_JS = [
  'import { writeFileSync, readFileSync } from "node:fs";',
  "const [cmd, ...a] = process.argv.slice(1);",
  "const e = process.env, gl = e.TG_FORGE === \"gitlab\", tok = e.TG_TOKEN;",
  'const MARK = "<!-- terragucci:plan";',
  "try {",
  '  if (cmd === "oidc") {',
  '    const r = await fetch(e.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=" + encodeURIComponent(a[1]), { headers: { authorization: "bearer " + e.ACTIONS_ID_TOKEN_REQUEST_TOKEN } });',
  '    if (!r.ok) throw new Error("the OIDC token request answered " + r.status + "; the job needs permission to request an OIDC token");',
  "    writeFileSync(a[0], (await r.json()).value, { mode: 0o600 });",
  "  } else if (!tok) {",
  '    console.log("terragucci: no forge token, so no " + cmd);',
  "  } else {",
  '    const api = gl ? e.CI_API_V4_URL : e.GITHUB_API_URL || e.GITHUB_SERVER_URL + "/api/v1";',
  '    const repo = gl ? "projects/" + e.CI_PROJECT_ID : "repos/" + e.GITHUB_REPOSITORY;',
  "    const call = async (m, p, b) => {",
  '      const r = await fetch(api + "/" + p, { method: m, headers: { "content-type": "application/json", ...(gl ? { "private-token": tok } : { authorization: "token " + tok }) }, body: b ? JSON.stringify(b) : undefined });',
  '      if (!r.ok) throw new Error(m + " " + p + " answered " + r.status);',
  "      return r.status === 204 ? null : r.json();",
  "    };",
  '    const notes = (n) => gl ? repo + "/merge_requests/" + n + "/notes" : repo + "/issues/" + n + "/comments";',
  '    const find = async (n) => (await call("GET", notes(n) + "?per_page=100")).find((c) => c.body.startsWith(MARK));',
  '    const edit = (n, id, body) => gl ? call("PUT", notes(n) + "/" + id, { body }) : call("PATCH", repo + "/issues/comments/" + id, { body });',
  '    if (cmd === "status") {',
  "      const [context, state, description] = a;",
  '      const url = gl ? e.CI_PIPELINE_URL : e.GITHUB_SERVER_URL + "/" + e.GITHUB_REPOSITORY + "/actions/runs/" + e.GITHUB_RUN_ID;',
  '      const sha = e.TG_SHA;',
  '      if (gl) await call("POST", repo + "/statuses/" + sha, { name: context, state: { pending: "running", success: "success", failure: "failed" }[state], description, target_url: url });',
  '      else await call("POST", repo + "/statuses/" + sha, { context, state, description, target_url: url });',
  '    } else if (cmd === "note") {',
  "      const body = readFileSync(a[0], \"utf-8\"), old = await find(e.TG_PR);",
  '      if (old) await edit(e.TG_PR, old.id, body); else await call("POST", notes(e.TG_PR), { body });',
  '    } else if (cmd === "reply") {',
  '      await call("POST", notes(e.TG_PR), { body: "terragucci: " + a[0] });',
  '    } else if (cmd === "alive") {',
  '      const run = await call("GET", repo + "/actions/runs/" + a[0]);',
  '      console.log(["success", "failure", "cancelled", "skipped", "completed"].includes(run.status) ? "dead" : "alive");',
  '    } else if (cmd === "stale") {',
  '      const moved = a[0].split(",");',
  '      const open = gl ? await call("GET", repo + "/merge_requests?state=opened&target_branch=" + a[1] + "&per_page=100") : await call("GET", repo + "/pulls?state=open&base=" + a[1] + "&per_page=100");',
  "      for (const pr of open) {",
  "        const n = gl ? pr.iid : pr.number, note = await find(n);",
  "        if (!note || note.body.includes(\"<!-- terragucci:stale -->\")) continue;",
  '        const hit = (note.body.match(/roots=(\\S*) -->/)?.[1] ?? "").split(",").filter((r) => moved.includes(r));',
  "        if (!hit.length) continue;",
  '        const lines = note.body.split("\\n");',
  '        lines.splice(1, 0, "> This plan is stale: " + a[1] + " moved under " + hit.join(", ") + ". Push to this pull request to plan again. <!-- terragucci:stale -->");',
  '        await edit(n, note.id, lines.join("\\n"));',
  "      }",
  "    }",
  "  }",
  "} catch (err) {",
  '  console.log("terragucci: " + cmd + " failed: " + err.message);',
  '  if (cmd === "oidc") process.exit(1);',
  "}",
].join("\n");

/**
 * GitLab's copy: a status on the job's own commit names the job's pipeline.
 * Without it GitLab files the status under the newest pipeline of that
 * commit, which may be another one (the comments schedule's, after the poll
 * retried a wave), and a waiting wave's failed status then fails that one.
 */
const FORGE_API_JS_GITLAB = FORGE_API_JS.replace(
  `{ name: context, state: { pending: "running", success: "success", failure: "failed" }[state], description, target_url: url });`,
  '{ name: context, state: { pending: "running", success: "success", failure: "failed" }[state], description, target_url: url, ...(sha === e.CI_COMMIT_SHA && /^[0-9]+$/.test(e.CI_PIPELINE_ID || "") ? { pipeline_id: Number(e.CI_PIPELINE_ID) } : {}) });',
);

/** Shell that defines `tg`, the forge calls above. */
export function forgeApi(forge: ForgeName): string {
  return [`export TG_FORGE=${forge}`, `tg() { node --input-type=module -e '${forge === "gitlab" ? FORGE_API_JS_GITLAB : FORGE_API_JS}' -- "$@"; }`].join("\n");
}

const AUDIENCE = "sts.amazonaws.com";

/** What a job that got no OIDC token needs, by forge. */
const NO_TOKEN: Record<Exclude<ForgeName, "gitlab">, string> = {
  github: "the job needs permissions: id-token: write",
  forgejo: "Forgejo serves one from version 15, with Forgejo Runner 12.5 or later, to a job that sets enable-openid-connect: true; on an older Forgejo leave oidc unset and give the runner static credentials",
};

/**
 * Write the job's OIDC token for one audience to `file` (by default
 * `$AWS_WEB_IDENTITY_TOKEN_FILE`), or stop the job: the scripts that read a
 * stage's exit code turn `-e` off (READS_EXIT), and a job that went on would
 * plan or apply with whatever credentials the runner happens to hold. On GitLab the token is the job's
 * `id_tokens` entry `gitlabVar`, one per audience.
 */
export function tokenScript(forge: ForgeName, audience = AUDIENCE, file = "$AWS_WEB_IDENTITY_TOKEN_FILE", gitlabVar = "TERRAGUCCI_OIDC", check = true): string {
  if (forge === "gitlab") return `printf '%s' "$${gitlabVar}" >"${file}"`;
  return [...(check ? [tokenCheck(forge)] : []), `tg oidc "${file}" ${sh(audience)} || exit 1`].join("\n");
}

/** Stops the job when the runner served no token. A script that fetches several tokens runs it once, before the first. GitLab has none: its tokens are job variables. */
export function tokenCheck(forge: ForgeName): string {
  if (forge === "gitlab") return "";
  return [
    'if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then',
    `  echo ${sh(`terragucci: the runner served this job no OIDC token (no ACTIONS_ID_TOKEN_REQUEST_URL); ${NO_TOKEN[forge]}`)} >&2`,
    "  exit 1",
    "fi",
  ].join("\n");
}

export function oidcScript(forge: ForgeName, role: string, session: string, audience = AUDIENCE, check = true): string {
  const token = tokenScript(forge, audience, undefined, undefined, check);
  return [
    `export AWS_ROLE_ARN=${sh(role)} AWS_ROLE_SESSION_NAME=${sh(session)}`,
    'export AWS_WEB_IDENTITY_TOKEN_FILE="$(mktemp)"',
    token,
  ].join("\n");
}

/** Google's global STS endpoint; `oidc.gcp.token_url` names a regional one. */
export const GCP_TOKEN_URL = "https://sts.googleapis.com/v1/token";

/** The audience GCP's Workload Identity Federation accepts by default: the provider's full name. */
export const gcpAudience = (provider: string): string => `https://iam.googleapis.com/${provider}`;

/** The audience Entra ID accepts on a federated credential in the public cloud; `oidc.azure.audience` names a sovereign cloud's. */
export const AZURE_AUDIENCE = "api://AzureADTokenExchange";

/** GitLab's `id_tokens` entries for GCP's and Azure's tokens. AWS's (and Terragrunt's) is TERRAGUCCI_OIDC. */
const GITLAB_GCP_TOKEN = "TERRAGUCCI_OIDC_GCP";
const GITLAB_AZURE_TOKEN = "TERRAGUCCI_OIDC_AZURE";

/**
 * GCP: the job's token for the Workload Identity Federation provider, and an
 * `external_account` credential file that trades it at Google's STS and
 * impersonates the stage's service account. The google provider, the gcs
 * backend and the gcloud tools read it through GOOGLE_APPLICATION_CREDENTIALS.
 */
export function gcpScript(forge: ForgeName, provider: string, serviceAccount: string, tokenUrl = GCP_TOKEN_URL, check = true): string {
  const json = (v: string): string => sh(JSON.stringify(v));
  return [
    'export TERRAGUCCI_GCP_TOKEN_FILE="$(mktemp)" GOOGLE_APPLICATION_CREDENTIALS="$(mktemp)"',
    tokenScript(forge, gcpAudience(provider), "$TERRAGUCCI_GCP_TOKEN_FILE", GITLAB_GCP_TOKEN, check),
    "printf '" +
      '{"type":"external_account","audience":%s,"subject_token_type":"urn:ietf:params:oauth:token-type:jwt","token_url":%s,' +
      '"service_account_impersonation_url":%s,"credential_source":{"file":"%s"}}\\n' +
      `' ${json(`//iam.googleapis.com/${provider}`)} ${json(tokenUrl)} ${json(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`)} "$TERRAGUCCI_GCP_TOKEN_FILE" >"$GOOGLE_APPLICATION_CREDENTIALS"`,
  ].join("\n");
}

/** Azure: the job's token for Entra ID in a file, and the ARM_* variables the azurerm provider and backend read for OIDC. */
export function azureScript(forge: ForgeName, azure: NonNullable<OidcSettings["azure"]>, clientId: string, check = true): string {
  return [
    `export ARM_USE_OIDC=true ARM_CLIENT_ID=${sh(clientId)} ARM_TENANT_ID=${sh(azure.tenant_id)} ARM_SUBSCRIPTION_ID=${sh(azure.subscription_id)}`,
    'export ARM_OIDC_TOKEN_FILE_PATH="$(mktemp)"',
    tokenScript(forge, azure.audience ?? AZURE_AUDIENCE, "$ARM_OIDC_TOKEN_FILE_PATH", GITLAB_AZURE_TOKEN, check),
  ].join("\n");
}

/** Whether `oidc` names AWS roles. */
const hasAws = (oidc: OidcSettings | undefined): boolean => Boolean(oidc?.plan_role && oidc.apply_role);

/**
 * Shell for a stage's cloud identities: the AWS role, the GCP service
 * account and the Azure client `oidc` names for it, each with the forge's
 * token for that cloud's audience. Drift takes the plan identities.
 */
export function cloudScripts(forge: ForgeName, oidc: OidcSettings | undefined, stage: "plan" | "apply", session: string): string[] {
  if (!oidc) return [];
  const plan = stage === "plan";
  // With GCP or Azure the check runs once, ahead of every token; an AWS-only script keeps it inside the AWS step.
  const shared = Boolean(oidc.gcp || oidc.azure) && forge !== "gitlab";
  return [
    ...(shared ? [tokenCheck(forge)] : []),
    ...(hasAws(oidc) ? [oidcScript(forge, (plan ? oidc.plan_role : oidc.apply_role) as string, session, oidc.audience, !shared)] : []),
    ...(oidc.gcp ? [gcpScript(forge, oidc.gcp.workload_identity_provider, plan ? oidc.gcp.plan_service_account : oidc.gcp.apply_service_account, oidc.gcp.token_url, !shared)] : []),
    ...(oidc.azure ? [azureScript(forge, oidc.azure, plan ? oidc.azure.plan_client_id : oidc.azure.apply_client_id, !shared)] : []),
  ];
}

/**
 * Roots that changed in the push, or all of them when the push cannot be diffed.
 * grep reads the whole list (no -q): under pipefail, a grep -q that quits at its
 * first match can leave printf with SIGPIPE on a long list and report no match.
 */
export function movedRoots(roots: string[]): string {
  return [
    'if [ -n "${TG_BEFORE:-}" ] && [ "${TG_BEFORE#0000000}" = "$TG_BEFORE" ] && git fetch -q --depth=1 origin "$TG_BEFORE" 2>/dev/null; then',
    '  changed="$(git diff --name-only "$TG_BEFORE" HEAD)"',
    "else",
    "  changed=",
    "fi",
    'moved=""',
    `for dir in ${roots.map(sh).join(" ")}; do`,
    '  if [ -z "$changed" ] || printf \'%s\\n\' "$changed" | grep "^$dir/" >/dev/null; then moved="${moved:+$moved,}$dir"; fi',
    "done",
  ].join("\n");
}

/**
 * Applies on Forgejo run one at a time through a tag on the remote. The tag
 * points at a commit whose subject is the holder's lease, "run <id> <epoch>".
 * A runner that kills a job never runs its exit trap, so a waiter takes the
 * lock over, atomically, when the holder's run is no longer running or the
 * lease is older than TG_LOCK_STALE seconds. A run that finds a newer push on
 * the branch stands down, since that push applies the whole tree. An apply a
 * comment started does not: it applies a merge commit that is not the tip by
 * design, and `terragucci comment-apply`, run again once it holds the lock,
 * decides whether a later apply superseded it.
 */
export function forgejoLock(standDown = true): string {
  const id = '${GITHUB_RUN_ID:-$$}';
  return [
    'lock_ref="refs/tags/terragucci-apply-lock"',
    'empty="$(git mktree </dev/null)"',
    `mine="$(GIT_AUTHOR_NAME=terragucci GIT_AUTHOR_EMAIL=terragucci@localhost GIT_COMMITTER_NAME=terragucci GIT_COMMITTER_EMAIL=terragucci@localhost git commit-tree "$empty" -m "run ${id} $(date +%s)")"`,
    "tries=0",
    'until git push -q origin "$mine:$lock_ref" 2>/dev/null; do',
    '  held="$(git ls-remote origin "$lock_ref" | cut -f1)"',
    '  if [ -n "$held" ] && git fetch -q origin "+$lock_ref:$lock_ref" 2>/dev/null; then',
    '    lease="$(git log -1 --format=%s "$lock_ref")"',
    '    holder="$(echo "$lease" | cut -d" " -f2)"; since="$(echo "$lease" | cut -d" " -f3)"',
    '    if [ "$(tg alive "$holder")" = dead ] || [ $(( $(date +%s) - ${since:-0} )) -ge "${TG_LOCK_STALE:-7200}" ]; then',
    '      echo "the apply lock was held by run $holder, which is gone; taking it over"',
    '      git push -q --force-with-lease="$lock_ref:$held" origin "+$mine:$lock_ref" 2>/dev/null && break',
    "    fi",
    "  fi",
    '  if [ "$tries" -ge 360 ]; then echo "another apply has held $lock_ref for an hour" >&2; exit 1; fi',
    '  sleep "${TG_LOCK_POLL:-10}"; tries=$((tries + 1))',
    "done",
    "trap 'git push -q --force-with-lease=\"$lock_ref:$mine\" origin \":$lock_ref\" || true' EXIT",
    ...(standDown ? [STAND_DOWN] : []),
  ].join("\n");
}

/**
 * The apply lock of a pipeline that splits a wave across jobs (`waves.jobs`),
 * on GitHub and Forgejo alike: forgejoLock's tag, held by a run rather than a
 * job, so the share jobs of a wave apply side by side while no other run
 * applies. Each job first pushes a hold tag naming its run and itself, then
 * takes the lock, or joins it when its own run holds it. On exit a job drops
 * its hold, and the last of its run to leave lets go of the lock. Two that
 * leave at once may each still see the other's hold and both leave the lock
 * held: the run's next job joins it and lets it go, and once the run ends a
 * waiter takes it over, as from any run that is gone, and drops that run's
 * holds.
 */
export function sharedApplyLock(job: string): string {
  const id = "${GITHUB_RUN_ID:-$$}";
  return [
    'lock_ref="refs/tags/terragucci-apply-lock"',
    `hold_prefix="refs/tags/terragucci-apply-hold-${id}-"`,
    `hold_ref="\${hold_prefix}${job}"`,
    'empty="$(git mktree </dev/null)"',
    `mine="$(GIT_AUTHOR_NAME=terragucci GIT_AUTHOR_EMAIL=terragucci@localhost GIT_COMMITTER_NAME=terragucci GIT_COMMITTER_EMAIL=terragucci@localhost git commit-tree "$empty" -m "run ${id} $(date +%s) ${job}")"`,
    // The hold goes up before the lock is taken, so a job of this run that leaves never lets go of a lock another still needs.
    'git push -q --force origin "$mine:$hold_ref" 2>/dev/null || { echo "could not push $hold_ref, so the apply lock cannot be shared" >&2; exit 1; }',
    "release_lock() {",
    '  git push -q origin ":$hold_ref" 2>/dev/null || true',
    '  [ -z "$(git ls-remote origin "${hold_prefix}*")" ] || return 0',
    '  held="$(git ls-remote origin "$lock_ref" | cut -f1)"',
    '  { [ -n "$held" ] && git fetch -q origin "+$lock_ref:$lock_ref" 2>/dev/null; } || return 0',
    `  [ "$(git log -1 --format=%s "$lock_ref" | cut -d" " -f2)" = "${id}" ] || return 0`,
    '  git push -q --force-with-lease="$lock_ref:$held" origin ":$lock_ref" 2>/dev/null || true',
    "}",
    "trap release_lock EXIT",
    "tries=0",
    'until git push -q origin "$mine:$lock_ref" 2>/dev/null; do',
    '  held="$(git ls-remote origin "$lock_ref" | cut -f1)"',
    '  if [ -n "$held" ] && git fetch -q origin "+$lock_ref:$lock_ref" 2>/dev/null; then',
    '    lease="$(git log -1 --format=%s "$lock_ref")"',
    '    holder="$(echo "$lease" | cut -d" " -f2)"; since="$(echo "$lease" | cut -d" " -f3)"',
    `    if [ "$holder" = "${id}" ]; then echo "this run holds the apply lock; ${job} joins it"; break; fi`,
    '    if [ "$(tg alive "$holder")" = dead ] || [ $(( $(date +%s) - ${since:-0} )) -ge "${TG_LOCK_STALE:-7200}" ]; then',
    '      echo "the apply lock was held by run $holder, which is gone; taking it over"',
    '      if git push -q --force-with-lease="$lock_ref:$held" origin "+$mine:$lock_ref" 2>/dev/null; then',
    '        for gone in $(git ls-remote origin "refs/tags/terragucci-apply-hold-$holder-*" | cut -f2); do git push -q origin ":$gone" 2>/dev/null || true; done',
    "        break",
    "      fi",
    "    fi",
    "  fi",
    '  if [ "$tries" -ge 360 ]; then echo "another apply has held $lock_ref for an hour" >&2; exit 1; fi',
    '  sleep "${TG_LOCK_POLL:-10}"; tries=$((tries + 1))',
    "done",
    STAND_DOWN,
  ].join("\n");
}

/**
 * A push's wave that runs once the branch has moved past its commit stands
 * down, because the newer push applies the whole tree. On Forgejo it runs
 * once the wave holds the lock tag; on GitHub at the top of the wave, which
 * the apply concurrency group starts only when no other apply runs.
 */
export const STAND_DOWN = [
  'tip="$([ -z "${GITHUB_REF_NAME:-}" ] || git ls-remote origin "refs/heads/${GITHUB_REF_NAME}" 2>/dev/null | cut -f1)"',
  'if [ -n "$tip" ] && [ "$tip" != "${GITHUB_SHA:-}" ]; then',
  '  echo "a newer push to ${GITHUB_REF_NAME} applies everything; standing down"',
  '  tg status terragucci/apply success "superseded by a newer push"',
  "  exit 0",
  "fi",
].join("\n");

/**
 * The concurrency group of every apply job on GitHub: each wave of a push and
 * the apply a comment starts. One runs at a time. `queue: max` keeps up to 100
 * waiting, in the order they began to wait; with the default (`single`) a job
 * that starts waiting cancels the one already waiting, whatever
 * cancel-in-progress says, so a push and a comment could cancel each other.
 * Nothing is cancelled now, so a push's wave that finds a newer push on the
 * branch stands down instead (STAND_DOWN), and the comment's apply decides
 * once the group starts it, when no other apply runs. Forgejo runs a
 * workflow's jobs whatever their concurrency says, and holds the lock tag.
 */
export function applyConcurrency(forge: ForgeName): Record<string, unknown> {
  return { group: "terragucci-apply-${{ github.repository }}", "cancel-in-progress": false, ...(forge === "github" ? { queue: "max" } : {}) };
}

/**
 * The first line of a script that reads a stage's exit code: the plan and
 * re-plan, the apply waves (a Terragrunt repo's too), the apply a comment
 * starts and the drift sweep. A step with `shell: bash` runs as
 * `bash --noprofile --norc -e -o pipefail {0}` on GitHub and on Forgejo's
 * runner, so without `set +e` a stage that fails, a wave that waits (3) or
 * one that is refused (4) ends the step at the stage, before its status, its
 * note, its response or the comment's reply. On GitLab these scripts run in
 * their own `bash` from a heredoc, which starts without `-e`; the line says
 * the same there, and the heredoc's `|| exit $?` hands its code to the job.
 */
export const READS_EXIT = "set +e -uo pipefail";

/** One apply job of a push: a wave's, a share of a wave split across jobs, or the job after the last wave's shares. */
interface ApplyJob {
  name: string;
  wave: number;
  /** The jobs it runs after: none for wave 1. */
  needs: string[];
  /** Its step's name. */
  step: string;
  body: string;
  /** It decides a wave split across jobs, and hands its decision to the shares. */
  decides?: boolean;
  share?: number;
  /** The job after the last wave's shares. */
  done?: boolean;
}

/** Which wave an apply job runs, and how the waves are cut and gated. */
export interface ApplyWaveInput {
  /** 1-based. */
  wave: number;
  /** Globs for wave 1, from `waves.canary`. */
  canary?: string[];
  gate?: Gate;
  /** The waves' `--approval`, when the pipeline carries one (PipelineInput.approval). */
  approval?: Approval;
  /** The response to each event; apply-failed and wave-refused are called from the wave's exit code. */
  respond?: PipelineInput["respond"];
  /** A Terragrunt repo: the layers are its waves of units, and the stage runs Terragrunt after this shell (credentials, caches). */
  terragrunt?: { prelude: string };
  /** `synth`: the command that writes the roots, run before the credentials. */
  synth?: string;
  /** `notify` is set: a wave that waits, is refused or fails posts to the chat webhooks. */
  notify?: boolean;
  /** `policy:` is set: a denial is recorded on chant/lifecycle for an override, whatever the gate. */
  policy?: boolean;
  /** `cost.approve_above` is set: a wave over it waits, and records its plan on chant/lifecycle, whatever the gate. */
  costGate?: boolean;
  /** `waves.jobs`, on the job of a wave that splits across jobs: it decides the wave, and its share jobs apply. */
  shares?: number;
  /** With `shares`: the share this job applies, from 1. */
  share?: number;
  /** The pipeline splits a wave across jobs, so every apply job holds the run's shared lock (sharedApplyLock) under this job name. */
  sharedLock?: string;
}

/**
 * One wave's apply job: `terragucci stage tf-apply` plans the wave's roots,
 * decides the wave's gate against its set digest, and applies the plans it
 * made. The first wave marks stale plan notes and posts the pending status;
 * the last posts the one success. A wave that waits for an approval, or whose
 * plans changed after one, says so in the status and fails the job, so the
 * waves after it do not start. In a Terragrunt repo the stage cuts the waves
 * from `terragrunt find` when it runs, and the last job passes `--rest`: it
 * also runs every wave the repo has past the ones init gave a job.
 */
export function applyScript(
  binary: Binary,
  layers: string[][],
  forge: ForgeName = "github",
  oidc?: PipelineInput["oidc"],
  input: ApplyWaveInput = { wave: 1 },
): string {
  const roots = layers.flat().sort();
  const total = layers.flat().length;
  const gate = input.gate ?? "on-destroy";
  const count = applyWaves(layers, input.canary).length;
  const tg = input.terragrunt;
  // A wave split across jobs: its own job decides (first, as wave 1's always is), and its shares apply; the done job posts the last success.
  const share = input.shares !== undefined ? input.share : undefined;
  const first = input.wave === 1 && share === undefined;
  // A Terragrunt pipeline whose last wave splits ends with a job past it, which runs any later wave with --rest.
  const last = input.wave >= count && input.shares === undefined;
  const triage = responds(input.respond, "apply-failed");
  // A share refused for plans that moved since its wave decided has no approved report for respond to compare.
  const refused = responds(input.respond, "wave-refused") && share === undefined;
  const args = [
    "--wave", String(input.wave),
    "--layers", sh(layers.map((l) => l.join(",")).join(";")),
    ...(input.canary?.length ? ["--canary", sh(input.canary.join(","))] : []),
    "--binary", binary,
    "--gate", gate,
    ...(input.approval ? ["--approval", input.approval] : []),
    ...(tg ? ["--terragrunt"] : []),
    ...(tg && last ? ["--rest"] : []),
    ...(input.shares !== undefined ? ["--shares", String(input.shares)] : []),
    ...(share !== undefined ? ["--share", String(share)] : []),
  ];
  // With --rest the wave that stopped may be a later one: its outcome line names it.
  const waveNow = tg && last ? `"$(sed -n 's/^wave \\([0-9]*\\) .*/\\1/p' "$outcome")"` : String(input.wave);
  return [
    READS_EXIT,
    forgeApi(forge),
    ...(input.synth ? [synthScript(input.synth, first ? "terragucci/apply" : undefined)] : []),
    ...cloudScripts(forge, oidc, "apply", "terragucci-apply"),
    ...(tg ? [tg.prelude] : []),
    ...(first
      ? [movedRoots(roots), '# The base branch moved under these roots: plan notes that cover them are stale.', 'tg stale "$moved" "${TG_BRANCH:-}"']
      : []),
    ...(input.sharedLock ? [sharedApplyLock(input.sharedLock)] : forge === "forgejo" ? [forgejoLock()] : forge === "github" ? [STAND_DOWN] : []),
    ...(first ? ['tg status terragucci/apply pending "applying"'] : []),
    // A waiting wave records what it planned on the chant/lifecycle branch, and so does a policy denial, under any
    // gate, so the job's checkout must be able to push. GitLab's own job token cannot.
    ...(forge === "gitlab" && (gate !== "never" || input.policy || input.costGate) ? [gitlabPushRemote] : []),
    'outcome="$(mktemp)"',
    ...(input.notify ? [OUTCOME_JSON] : []),
    ...(triage ? ['log="$(mktemp)"'] : []),
    `TG_OUTCOME="$outcome" ${outcomeEnv(input.notify)}terragucci stage tf-apply ${args.join(" ")}${triage ? ' 2>&1 | tee "$log"' : ""}`,
    triage ? "rc=${PIPESTATUS[0]}" : "rc=$?",
    'case "$rc" in',
    "  0) ;;",
    // GitLab reuses a running status and refuses to move it to pending or running again (400), and a status left running keeps the pipeline running, so a waiting wave fails it there; a retry posts a new one.
    `  3) tg status terragucci/apply ${forge === "gitlab" ? "failure" : "pending"} "$(cat "$outcome")"; ${input.notify ? notifyLine("waiting", waveNow) : ""}exit 3 ;;`,
    // A wave waiting at a gate (3) is not a failure. A refused wave (4) and a failed apply are, and each gets its response before the job fails.
    `  4) tg status terragucci/apply failure "$(cat "$outcome")"; ${refused ? `terragucci respond wave-refused --wave ${waveNow} --approved ${REPORT_DIR}/approved --current ${REPORT_DIR}/current || true; ` : ""}${input.notify ? notifyLine("refused", waveNow) : ""}exit 4 ;;`,
    `  *) tg status terragucci/apply failure "an apply failed"; ${triage ? 'terragucci respond apply-failed --log "$log" || true; ' : ""}${input.notify ? notifyLine("failed", waveNow) : ""}exit 1 ;;`,
    "esac",
    ...(last
      ? tg
        ? ['tg status terragucci/apply success "every wave of units applied"', 'echo "all units applied"']
        : [`tg status terragucci/apply success "${total} roots in ${layers.length} groups applied"`, 'echo "all roots applied"']
      : [share !== undefined ? `echo "wave ${input.wave} of ${count}, share ${share}, applied"` : input.shares !== undefined ? `echo "wave ${input.wave} of ${count} decided; its shares apply"` : `echo "wave ${input.wave} of ${count} applied"`]),
  ].join("\n");
}

/** The job after the shares of a last wave split across jobs: every share applied, so the commit gets the one success. */
export function applyDoneScript(layers: string[][], forge: ForgeName = "github"): string {
  return [
    READS_EXIT,
    forgeApi(forge),
    `tg status terragucci/apply success "${layers.flat().length} roots in ${layers.length} groups applied"`,
    'echo "all roots applied"',
  ].join("\n");
}

/** Reads the decision file `terragucci comment-apply` wrote: the pull request, the merge commit and the last wave ("-" for every wave). */
const APPLY_DECISION_JS = 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));console.log(d.go?[d.pr,d.sha,d.wave||"-"].join(" "):"")';
/** With `apply.when: pull-request`: also whether the pull request is open (1), so its head applies, and its base branch. */
const PR_DECISION_JS = 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));console.log(d.go?[d.pr,d.sha,d.wave||"-",d.open?1:0,d.base].join(" "):"")';

/** What a waiting wave's reply asks for next, as the comment's job says it. */
const COMMENT_AGAIN = "A comment approves nothing: approve the plans with \\\`$cmd\\\` and comment \\\`/terragucci apply\\\` again";

/** How the apply a comment starts is cut, gated and answered. */
export interface CommentApplyInput {
  canary?: string[];
  gate?: Gate;
  /** The waves' `--approval`, when the pipeline carries one. */
  approval?: Approval;
  respond?: PipelineInput["respond"];
  /** `apply.when`. With `pull-request` an open pull request applies from its head. */
  when?: ApplyWhen;
  /** `apply.merge`. With `auto` a pull request whose every wave applied from its head is merged. */
  merge?: ApplyMerge;
  /** `apply.requires`. Unset, or every requirement, writes no `--requires`. */
  requires?: ApplyRequire[];
  /** A Terragrunt repo: the layers are its waves of units, and each wave runs Terragrunt after this shell (credentials, caches). */
  terragrunt?: { prelude: string };
  /** `synth`: the command that writes the roots, run on the checked-out commit before the credentials. */
  synth?: string;
  /** `notify` is set: a wave that waits, is refused or fails posts to the chat webhooks. */
  notify?: boolean;
  /** GitHub, when the pipeline splits a wave across jobs: the apply takes the lock tag those jobs hold, as on Forgejo, since the shares run outside the concurrency group. */
  lockTag?: boolean;
}

/**
 * The waves of an apply a comment started, from wave 1 to
 * `$last`, as a re-run does: a wave already applied plans no change, a gated
 * wave counts only an approval of the plans it makes now, and the
 * first wave that does not apply stops the run, with a reply that says why.
 * In a Terragrunt repo a comment that asks for every wave runs the last one
 * with `--rest`, so the waves past the pipeline's jobs apply too.
 */
function waveLoop(binary: Binary, layers: string[][], input: CommentApplyInput, base: string, again = COMMENT_AGAIN, statuses = true): string[] {
  // GitLab's mr-apply job posts no status on the head: a failed one would fail the merge request's own pipeline, and with it the next apply's checks.
  const status = (line: string): string[] => (statuses ? [line] : []);
  const triage = responds(input.respond, "apply-failed");
  const refused = responds(input.respond, "wave-refused");
  const layerArg = sh(layers.map((l) => l.join(",")).join(";"));
  const args = ["--layers", layerArg, ...(input.canary?.length ? ["--canary", sh(input.canary.join(","))] : []), "--binary", binary, "--gate", input.gate ?? "on-destroy", ...(input.approval ? ["--approval", input.approval] : []), ...(input.terragrunt ? ["--terragrunt"] : []), ...(base ? [base] : [])];
  return [
    'outcome="$(mktemp)"',
    ...(input.notify ? [OUTCOME_JSON] : []),
    ...(triage ? ['log="$(mktemp)"'] : []),
    'done_waves=""',
    'for wave in $(seq 1 "$last"); do',
    '  : >"$outcome"',
    ...(input.terragrunt ? ['  rest=""; if [ "$TG_WAVE" = "-" ] && [ "$wave" = "$last" ]; then rest="--rest"; fi'] : []),
    `  TG_OUTCOME="$outcome" ${outcomeEnv(input.notify)}terragucci stage tf-apply --wave "$wave" ${args.join(" ")}${input.terragrunt ? " $rest" : ""}${triage ? ' 2>&1 | tee "$log"' : ""}`,
    triage ? "  rc=${PIPESTATUS[0]}" : "  rc=$?",
    // With --rest the wave that stopped may be a later one: its outcome line names it.
    ...(input.terragrunt ? [`  [ -s "$outcome" ] && wave="$(sed -n 's/^wave \\([0-9]*\\) .*/\\1/p' "$outcome")"`] : []),
    '  case "$rc" in',
    input.terragrunt
      ? '    0) done_waves="${done_waves:+$done_waves, }$wave${rest:+ and every wave after it}" ;;'
      : '    0) done_waves="${done_waves:+$done_waves, }$wave" ;;',
    "    3)",
    ...status('      tg status terragucci/apply pending "$(cat "$outcome")"'),
    `      digest="$(sed -n 's/.*--plan \\([^ ]*\\).*/\\1/p' "$outcome")"`,
    `      cmd="$(sed -n 's/^wave [0-9]* waits: //p' "$outcome")"`,
    `      tg reply "wave $wave waits for an approval of its set digest $digest, so nothing in it was applied\${done_waves:+ (applied: wave $done_waves)}. ${again}. $run_url"`,
    ...(input.notify ? [`      ${notifyLine("waiting", '"$wave"').trimEnd().replace(/;$/, "")}`] : []),
    "      exit 3 ;;",
    "    4)",
    ...status('      tg status terragucci/apply failure "$(cat "$outcome")"'),
    // The responses a push's wave runs, on the same exit codes (applyScript).
    ...(refused ? [`      terragucci respond wave-refused --wave "$wave" --approved ${REPORT_DIR}/approved --current ${REPORT_DIR}/current${base ? ` ${base}` : ""} || true`] : []),
    '      tg reply "wave $wave was refused: its plans changed since it was approved, so nothing in it was applied (${done_waves:+applied: wave $done_waves; }$(cat "$outcome")). $run_url"',
    ...(input.notify ? [`      ${notifyLine("refused", '"$wave"').trimEnd().replace(/;$/, "")}`] : []),
    "      exit 4 ;;",
    "    *)",
    ...status('      tg status terragucci/apply failure "an apply failed"'),
    ...(triage ? [`      terragucci respond apply-failed --log "$log"${base ? ` ${base}` : ""} || true`] : []),
    '      why="$(cat "$outcome")"',
    '      tg reply "wave $wave did not apply${why:+ ($why)}${done_waves:+; applied: wave $done_waves}. The run has the log: $run_url"',
    ...(input.notify ? [`      ${notifyLine("failed", '"$wave"').trimEnd().replace(/;$/, "")}`] : []),
    "      exit 1 ;;",
    "  esac",
    "done",
  ];
}

/**
 * After every wave of an open pull request applied from its head. With
 * `apply.merge: auto` the step hands the pull request's head and its applied
 * waves to the `pr-merge` job as outputs, and that job merges it (mergeScript):
 * this job ran the pull request's code, so it never holds the merge token.
 * With `manual` it says the pull request is left for a person. A run that
 * stopped at a wave never gets here, so a pull request whose apply partly
 * failed is never merged.
 */
function openReply(count: number, merge: ApplyMerge | undefined, forge: ForgeName = "github"): string[] {
  const applied = forge === "gitlab" ? "applied wave $done_waves of !$TG_PR at ${TG_SHA:0:8}" : "applied wave $done_waves of pull request $TG_PR at ${TG_SHA:0:8}";
  // On GitLab the reply is what pr-merge looks for, through the API: no artifact or dotenv of this job, which ran the merge request's code, reaches the job with the merge token.
  const handOn = forge === "gitlab" ? `  tg reply "${applied}; pr-merge merges it next. $run_url ${APPLIED_MARKER}"` : '  { echo "merge=1"; echo "sha=$TG_SHA"; echo "waves=$done_waves"; } >> "$GITHUB_OUTPUT"';
  return [
    `if [ "$last" = ${count} ]; then`,
    ...(merge === "auto"
      ? [handOn]
      : [`  tg reply "${applied}. Merge it when you are ready; its root locks hold until it merges or closes. $run_url"`]),
    "else",
    `  tg reply "${applied}. $run_url"`,
    "fi",
  ];
}

/**
 * The `pr-merge` job's script (`apply.merge: auto`): merge the pull request
 * the comment named, at the head the apply step handed on, through
 * `terragucci pr-merge`, which merges only while that head is still the pull
 * request's head and approved by a reviewer other than its author, then
 * releases its locks. It runs in a job of its own, from the default branch's
 * checkout, so the merge token never shares a job with the pull request's
 * code. The outputs it reads come from a step that ran that code, so they
 * are read as data: the head must be a commit sha and the waves only digits.
 */
export function mergeScript(forge: Exclude<ForgeName, "gitlab">): string {
  const applied = "applied wave $waves of pull request $TG_PR at ${TG_SHA:0:8}";
  return [
    READS_EXIT,
    forgeApi(forge),
    'run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
    'case "$TG_SHA" in ""|*[!0-9a-f]*) echo "terragucci: the apply job handed on no commit sha, so nothing is merged" >&2; exit 1 ;; esac',
    // A Terragrunt run's last wave reads "2 and every wave after it": the words go, and so do the spaces they leave.
    `waves="$(printf '%s' "\${TG_WAVES:-}" | tr -cd '0-9, ' | tr -s ' ' | sed 's/ *$//')"`,
    `if merged="$(terragucci pr-merge --pr "$TG_PR" --sha "$TG_SHA"${forge === "github" ? "" : ` --forge ${forge}`} 2>&1)"; then`,
    `  tg reply "${applied}, and \${merged#terragucci pr-merge: }. $run_url"`,
    "else",
    `  tg reply "${applied}, and it was not merged: \${merged#terragucci pr-merge: not merged: }. Merge it by hand. $run_url"`,
    "  exit 1",
    "fi",
  ].join("\n");
}

/** What the GitLab mr-apply job's reply carries once every wave applied: the head and the pipeline, which pr-merge looks for. */
const APPLIED_MARKER = "<!-- terragucci:applied head=$TG_SHA pipeline=$CI_PIPELINE_ID -->";

/**
 * The GitLab `pr-merge` job's script (`apply.merge: auto`). It runs in the
 * mr-apply pipeline after that job, from the default branch's checkout, with
 * the merge token, and takes nothing from the mr-apply job, which ran the
 * merge request's code: the merge request and its head are the pipeline's
 * variables, which that job's decision checked against GitLab. `terragucci
 * pr-merge` merges only when the mr-apply job's reply says every wave of that
 * head applied in this pipeline, and checks the merge request again. A
 * decision that refused, a lock, a run of some waves or a wave that stopped
 * leaves no such reply, and nothing merges.
 */
export function gitlabMergeScript(): string {
  return [
    READS_EXIT,
    forgeApi("gitlab"),
    gitlabPushRemote,
    'run_url="$CI_PIPELINE_URL"',
    'case "${TERRAGUCCI_MR:-}" in ""|*[!0-9]*) echo "terragucci: the pipeline names no merge request, so nothing is merged" >&2; exit 1 ;; esac',
    'case "${TERRAGUCCI_HEAD:-}" in ""|*[!0-9a-f]*) echo "terragucci: the pipeline names no head commit, so nothing is merged" >&2; exit 1 ;; esac',
    'export TG_PR="$TERRAGUCCI_MR" TG_SHA="$TERRAGUCCI_HEAD"',
    'merged="$(terragucci pr-merge --forge gitlab --pr "$TG_PR" --sha "$TG_SHA" 2>&1)"',
    'if [ $? -ne 0 ]; then',
    '  tg reply "!$TG_PR was not merged: ${merged#terragucci pr-merge: not merged: }. Merge it by hand. $run_url"',
    "  exit 1",
    "fi",
    'case "$merged" in',
    '  "terragucci pr-merge: merged "*) tg reply "${merged#terragucci pr-merge: }. $run_url" ;;',
    '  *) echo "$merged" ;;',
    "esac",
  ].join("\n");
}

/**
 * The GitLab `mr-apply` job's script (`apply.when: pull-request`): the
 * default branch's pipeline file, in the pipeline the comments job starts
 * for an open merge request's note. `terragucci comment-apply --forge
 * gitlab` decides before any credential, from GitLab's answers and never
 * from the pipeline's variables alone, and takes the root locks (it also
 * answers `/terragucci lock` and `unlock`, which apply nothing). The job then
 * checks out the head the decision checked and runs its waves from wave 1,
 * reading the gate rule, the signers and the settings from the default
 * branch (`--base`), under the apply jobs' resource group. It posts no
 * status on the head; its replies say what happened.
 */
export function gitlabApplyScript(binary: Binary, layers: string[][], oidc?: PipelineInput["oidc"], input: CommentApplyInput = {}): string {
  const count = applyWaves(layers, input.canary).length;
  const layerArg = sh(layers.map((l) => l.join(",")).join(";"));
  const canaryArg = input.canary?.length ? ` --canary ${sh(input.canary.join(","))}` : "";
  const requires = input.requires && !APPLY_REQUIRES.every((r) => input.requires!.includes(r)) ? ` --requires ${input.requires.length ? input.requires.join(",") : "none"}` : "";
  return [
    READS_EXIT,
    forgeApi("gitlab"),
    // The locks and a waiting wave's record are pushed to chant/lifecycle.
    gitlabPushRemote,
    `terragucci comment-apply --forge gitlab --layers ${layerArg}${canaryArg} --when pull-request${requires}${input.terragrunt ? " --terragrunt" : ""} --out terragucci-comment.json || exit 1`,
    "read -r TG_PR TG_SHA TG_WAVE TG_OPEN TG_BASE <<EOF",
    `$(node -e '${PR_DECISION_JS}' terragucci-comment.json)`,
    "EOF",
    '[ -n "$TG_PR" ] || exit 0',
    "export TG_PR TG_SHA",
    `last=${count}`,
    '[ "$TG_WAVE" = "-" ] || last="$TG_WAVE"',
    'run_url="$CI_JOB_URL"',
    'tf_base="--base origin/$TG_BASE"',
    'git checkout --quiet --detach "$TG_SHA" || { tg reply "could not check out the head ${TG_SHA:0:8}, so nothing was applied: $run_url"; exit 1; }',
    ...(input.synth ? [synthScript(input.synth)] : []),
    ...cloudScripts("gitlab", oidc, "apply", "terragucci-apply"),
    ...(input.terragrunt ? [input.terragrunt.prelude] : []),
    ...waveLoop(binary, layers, input, "$tf_base", COMMENT_AGAIN, false),
    ...openReply(count, input.merge, "gitlab"),
  ].join("\n");
}

/**
 * The apply a comment starts, `/terragucci apply [wave-<n>]`. The workflow
 * and this script are the default branch's (the comment event's);
 * `terragucci comment-apply` decides from the event file and the forge,
 * before any credential is asked for, whether the comment may apply. On a
 * merged pull request the job then checks out its merge commit. With
 * `apply.when: pull-request`, on an open pull request it checks out the head
 * the decision checked (approved, green, up to date, its roots locked), and
 * each wave reads the gate rule and the signers from the default branch
 * (`--base`), never from the pull request. It holds the lock a push's apply
 * holds (on Forgejo the lock tag, and the decision is made again once it is
 * held; on GitHub the apply concurrency group, which starts the job only when
 * no other apply runs), and runs `stage tf-apply` wave by wave from wave 1
 * (waveLoop). A refused wave and a failed apply get the responses a push's
 * wave gets (respond wave-refused, respond apply-failed) before the reply.
 * The reply says what happened and links the run. In a Terragrunt repo the
 * waves are its waves of units, and each runs `stage tf-apply --terragrunt`
 * after the apply jobs' prelude (caches, the auth provider's apply roles),
 * so a comment applies them through the gate a push's wave job uses.
 */
export function commentApplyScript(binary: Binary, layers: string[][], forge: Exclude<ForgeName, "gitlab"> = "github", oidc?: PipelineInput["oidc"], input: CommentApplyInput = {}): string {
  const total = layers.flat().length;
  const count = applyWaves(layers, input.canary).length;
  const prMode = input.when === "pull-request";
  const layerArg = sh(layers.map((l) => l.join(",")).join(";"));
  const canaryArg = input.canary?.length ? ` --canary ${sh(input.canary.join(","))}` : "";
  // Fewer requirements than every one are written out; `none` for an empty list.
  const requires = prMode && input.requires && !APPLY_REQUIRES.every((r) => input.requires!.includes(r)) ? ` --requires ${input.requires.length ? input.requires.join(",") : "none"}` : "";
  // Before merge, a Terragrunt repo's locks are on the units a pull request reaches.
  const tgLocks = prMode && input.terragrunt ? " --terragrunt" : "";
  const decideWith = (again: string) => `terragucci comment-apply --layers ${layerArg}${canaryArg}${forge === "forgejo" ? " --forge forgejo" : ""}${prMode ? " --when pull-request" : ""}${requires}${tgLocks}${again} --out terragucci-comment.json || exit 1`;
  const decide = decideWith("");
  const decisionJs = prMode ? PR_DECISION_JS : APPLY_DECISION_JS;
  return [
    READS_EXIT,
    forgeApi(forge),
    // Before any credential: the comment, the commenter, the pull request and the merge commit (or, open, the head and its locks).
    decide,
    prMode ? "read -r TG_PR TG_SHA TG_WAVE TG_OPEN TG_BASE <<EOF" : "read -r TG_PR TG_SHA TG_WAVE <<EOF",
    `$(node -e '${decisionJs}' terragucci-comment.json)`,
    "EOF",
    '[ -n "$TG_PR" ] || exit 0',
    'export TG_PR TG_SHA',
    `last=${count}`,
    '[ "$TG_WAVE" = "-" ] || last="$TG_WAVE"',
    'run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
    ...(forge === "forgejo" || input.lockTag
      ? [
          forgejoLock(false),
          // A push may have applied while this run waited for the lock: decide again, now that nothing else applies.
          decideWith(tgLocks ? " --again" : ""),
          prMode ? "read -r again _ _ _ _ <<EOF" : "read -r again _ _ <<EOF",
          `$(node -e '${decisionJs}' terragucci-comment.json)`,
          "EOF",
          '[ -n "$again" ] || exit 0',
        ]
      : []),
    ...(prMode
      ? [
          'what="the merge commit"; tf_base=""',
          // An open pull request applies its head, and the waves read the gate rule and the signers from its base.
          'if [ "$TG_OPEN" = 1 ]; then what="the head"; tf_base="--base origin/$TG_BASE"; fi',
          'git checkout --quiet --detach "$TG_SHA" || { tg reply "could not check out $what ${TG_SHA:0:8}, so nothing was applied: $run_url"; exit 1; }',
        ]
      : ['git checkout --quiet --detach "$TG_SHA" || { tg reply "could not check out the merge commit ${TG_SHA:0:8}, so nothing was applied: $run_url"; exit 1; }']),
    ...(input.synth ? [synthScript(input.synth)] : []),
    ...cloudScripts(forge, oidc, "apply", "terragucci-apply"),
    ...(input.terragrunt ? [input.terragrunt.prelude] : []),
    'tg status terragucci/apply pending "applying on a comment"',
    ...waveLoop(binary, layers, input, prMode ? "$tf_base" : ""),
    `if [ "$last" = ${count} ]; then`,
    input.terragrunt
      ? '  tg status terragucci/apply success "every wave of units applied"'
      : `  tg status terragucci/apply success "${total} roots in ${layers.length} groups applied"`,
    "else",
    `  tg status terragucci/apply pending "wave $last of ${count} applied"`,
    "fi",
    ...(prMode
      ? ['if [ "$TG_OPEN" = 1 ]; then', ...openReply(count, input.merge).map((l) => `  ${l}`), "else", '  tg reply "applied wave $done_waves of pull request $TG_PR at ${TG_SHA:0:8}. $run_url"', "fi"]
      : ['tg reply "applied wave $done_waves of pull request $TG_PR at ${TG_SHA:0:8}. $run_url"']),
  ].join("\n");
}

const RESUME_AGAIN = "Approve the plans with \\`$cmd\\`; the resume job applies them on its next run";

/**
 * The resume job's script (GitHub and Forgejo): `terragucci resume` reads the
 * ledger and, when a waiting wave's digest has an approval no apply used,
 * names the default branch's commit (and the pull request that made it, for
 * replies). The waves then run from wave 1 at that commit as a comment's
 * apply does: a wave already applied plans no change, and each gate decides
 * against the plans it makes now. With nothing to resume it stops before any
 * credential.
 */
export function resumeScript(binary: Binary, layers: string[][], forge: Exclude<ForgeName, "gitlab"> = "github", oidc?: PipelineInput["oidc"], input: CommentApplyInput = {}): string {
  const total = layers.flat().length;
  const count = applyWaves(layers, input.canary).length;
  return [
    READS_EXIT,
    forgeApi(forge),
    `terragucci resume --forge ${forge} --out terragucci-resume.env || exit 1`,
    "[ -s terragucci-resume.env ] || exit 0",
    ". ./terragucci-resume.env",
    "export TG_PR TG_SHA",
    // A commit no pull request made has nowhere to reply: its replies are log lines.
    'eval "tg_forge () $(declare -f tg | tail -n +2)"',
    'tg() { if [ "$1" = reply ] && [ -z "$TG_PR" ]; then echo "terragucci: $2"; else tg_forge "$@"; fi; }',
    `last=${count}`,
    'TG_WAVE="-"',
    'run_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"',
    ...(forge === "forgejo" || input.lockTag ? [forgejoLock(false)] : []),
    'git checkout --quiet --detach "$TG_SHA" || { echo "terragucci: could not check out ${TG_SHA:0:8}" >&2; exit 1; }',
    ...(input.synth ? [synthScript(input.synth)] : []),
    ...cloudScripts(forge, oidc, "apply", "terragucci-apply"),
    ...(input.terragrunt ? [input.terragrunt.prelude] : []),
    'tg status terragucci/apply pending "applying after an approval"',
    ...waveLoop(binary, layers, input, "", RESUME_AGAIN),
    input.terragrunt ? 'tg status terragucci/apply success "every wave of units applied"' : `tg status terragucci/apply success "${total} roots in ${layers.length} groups applied"`,
    'tg reply "applied wave $done_waves at ${TG_SHA:0:8} after its approval. $run_url"',
  ].join("\n");
}

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

/** Shell for a Terragrunt job's credentials: the auth provider, and the AWS OIDC token when `oidc` did not fetch it. */
function terragruntCredentials(forge: ForgeName, phase: "plan" | "apply", oidc: PipelineInput["oidc"], credentials?: Record<string, RolePair>): string[] {
  if (!credentials || Object.keys(credentials).length === 0) return [];
  return [credentialsScript(credentials, phase, hasAws(oidc) ? undefined : tokenScript(forge, AUDIENCE, undefined, undefined, !(oidc?.gcp || oidc?.azure)))];
}

/** Where a plan job's report is kept, and what the stage needs beyond the roots. */
export interface PlanReportInput {
  /** Copy the report to this bucket as well as keeping it with the job. */
  reports?: { bucket: string; endpoint?: string; prefix?: string; url?: string; role?: string };
  /** Globs for the canary wave the report shows. */
  canary?: string[];
  /** A Terragrunt repo: the stage runs Terragrunt, after this shell (credentials, caches). */
  terragrunt?: { prelude: string };
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

/** The status line from the report: roots, groups, destroys and replacements, and refusals. */
const COUNTS_JS =
  'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));' +
  'const n=(a)=>r.named.filter((x)=>a.includes(x.action)).length;' +
  'const f=n(["refused"]);' +
  'console.log((f?f+" failed: ":"")+r.roots.length+" roots, "+r.groups.length+" groups, "+n(["delete","replace"])+" destroys")';

/** The roots (or units) a plan report planned, comma-separated, for the note's first line. */
const PLANNED_JS = 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8")).roots.map((x)=>x.path).join(","))';

/**
 * GitLab's plan job by default: `terragucci stage tf-plan` plans the roots the
 * change reaches, in apply order, and writes the plan report. The job posts
 * the report's note as the one plan note, and its counts as the one
 * terragucci/plan status, with the project token the job holds. GitHub and
 * Forgejo plan with planFilesScript and post from the plan-note job.
 */
export function planScript(binary: Binary, layers: string[][], forge: ForgeName = "gitlab", oidc?: PipelineInput["oidc"], report: PlanReportInput = {}): string {
  const args = [
    "--out", REPORT_DIR,
    "--binary", binary,
    "--layers", sh(layers.map((l) => l.join(",")).join(";")),
    "--report-url", reportUrl(forge),
    ...(report.canary?.length ? ["--canary", sh(report.canary.join(","))] : []),
    ...(report.terragrunt ? ["--terragrunt"] : []),
    ...(report.reports ? ["--bucket", sh(report.reports.bucket)] : []),
    ...(report.reports?.endpoint ? ["--bucket-endpoint", sh(report.reports.endpoint)] : []),
    ...(report.reports?.prefix ? ["--bucket-prefix", sh(report.reports.prefix)] : []),
    ...(report.reports?.url ? ["--bucket-url", sh(report.reports.url)] : []),
  ];
  return [
    READS_EXIT,
    forgeApi(forge),
    ...(report.synth ? [synthScript(report.synth, "terragucci/plan")] : []),
    ...cloudScripts(forge, oidc, "plan", "terragucci-plan"),
    ...(report.terragrunt ? [report.terragrunt.prelude] : []),
    'tg status terragucci/plan pending "planning"',
    `terragucci stage tf-plan ${args.join(" ")}`,
    "rc=$?",
    `if [ ! -f ${REPORT_DIR}/report.json ]; then`,
    '  tg status terragucci/plan failure "the plan report was not written"',
    "  exit 1",
    "fi",
    `counts="$(node -e '${COUNTS_JS}' ${REPORT_DIR}/report.json)"`,
    'if [ -n "${TG_PR:-}" ]; then',
    ...(report.description ? [`  terragucci respond description --mode apply --report ${REPORT_DIR} || true`] : []),
    '  note="$(mktemp)"',
    "  # The first line says which roots the note covers, so an apply can mark it stale.",
    `  { echo "<!-- terragucci:plan roots=$(node -e '${PLANNED_JS}' ${REPORT_DIR}/report.json) -->"; cat ${REPORT_DIR}/note.md; } >"$note"`,
    '  tg note "$note"',
    "fi",
    'if [ "$rc" -ne 0 ]; then tg status terragucci/plan failure "$counts"; exit 1; fi',
    'tg status terragucci/plan success "$counts"',
  ].join("\n");
}

/**
 * A plan job that holds no forge token: the same stage, with the note and the
 * status written into the report directory (PLAN_NOTE_FILE,
 * PLAN_STATUS_FILE), which the job keeps as its artifact. Another job that
 * runs none of the change's code posts them: on GitHub and Forgejo the
 * `plan-note` job (plan-note.ts), on GitLab with `gitlab.token: protected`
 * the comments job (plan-note-gitlab.ts). A re-plan names its root
 * (`TG_ROOT`) and reads its range from `TG_BASE`; its checkout must be the
 * head the comment's decision read.
 */
export function planFilesScript(binary: Binary, layers: string[][], forge: ForgeName, oidc?: PipelineInput["oidc"], report: PlanReportInput = {}, options: { tokenCheck?: string; replan?: boolean } = {}): string {
  const args = [
    "--out", REPORT_DIR,
    "--binary", binary,
    "--layers", sh(layers.map((l) => l.join(",")).join(";")),
    "--report-url", reportUrl(forge),
    ...(options.replan ? ['${TG_ROOT:+--root "$TG_ROOT"}'] : []),
    ...(report.canary?.length ? ["--canary", sh(report.canary.join(","))] : []),
    ...(report.terragrunt ? ["--terragrunt"] : []),
    ...(report.reports ? ["--bucket", sh(report.reports.bucket)] : []),
    ...(report.reports?.endpoint ? ["--bucket-endpoint", sh(report.reports.endpoint)] : []),
    ...(report.reports?.prefix ? ["--bucket-prefix", sh(report.reports.prefix)] : []),
    ...(report.reports?.url ? ["--bucket-url", sh(report.reports.url)] : []),
  ];
  const status = `${REPORT_DIR}/${PLAN_STATUS_FILE}`;
  return [
    READS_EXIT,
    ...(options.tokenCheck ? [options.tokenCheck] : []),
    // The OIDC token request; no forge token is in the job.
    ...(forge !== "gitlab" && oidc ? [forgeApi(forge)] : []),
    ...(options.replan ? ['if [ "$(git rev-parse HEAD)" != "${TG_SHA:-}" ]; then echo "terragucci: the pull request moved while the comment was read; its push plans it" >&2; exit 0; fi'] : []),
    ...(report.synth
      ? [
          "# synth in terragucci.yml: write the roots before reading them.",
          `( set -e; ${report.synth} ) || { mkdir -p ${REPORT_DIR} && echo "failure the synth command failed" >${status}; echo "terragucci: the synth command failed" >&2; exit 1; }`,
        ]
      : []),
    ...cloudScripts(forge, oidc, "plan", "terragucci-plan"),
    ...(report.terragrunt ? [report.terragrunt.prelude] : []),
    `terragucci stage tf-plan ${args.join(" ")}`,
    "rc=$?",
    `if [ ! -f ${REPORT_DIR}/report.json ]; then`,
    `  mkdir -p ${REPORT_DIR} && echo "failure the plan report was not written" >${status}`,
    "  exit 1",
    "fi",
    `counts="$(node -e '${COUNTS_JS}' ${REPORT_DIR}/report.json)"`,
    'if [ -n "${TG_PR:-}" ]; then',
    ...(report.description ? [`  terragucci respond description --mode apply --report ${REPORT_DIR} || true`] : []),
    "  # The first line says which roots the note covers, so an apply can mark it stale.",
    `  { echo "<!-- terragucci:plan roots=$(node -e '${PLANNED_JS}' ${REPORT_DIR}/report.json) -->"; cat ${REPORT_DIR}/note.md; } >${REPORT_DIR}/${PLAN_NOTE_FILE}`,
    "fi",
    `if [ "$rc" -ne 0 ]; then echo "failure $counts" >${status}; exit 1; fi`,
    `echo "success $counts" >${status}`,
  ].join("\n");
}

/**
 * GitLab's plan job with `gitlab.token: protected`: planFilesScript, which
 * stops first when the token reaches it anyway, since then the variable is
 * not protected and the merge request's code holds it.
 */
export function gitlabProtectedPlanScript(binary: Binary, layers: string[][], oidc?: PipelineInput["oidc"], report: PlanReportInput = {}, tokenEnv = "GITLAB_TOKEN"): string {
  return planFilesScript(binary, layers, "gitlab", oidc, report, { tokenCheck: gitlabTokenCheck(tokenEnv) });
}

/** The variables a runner or a job may hold a forge token in. A step that runs the change's code starts again without them. */
export const STEP_TOKEN_VARS = ["TG_TOKEN", "TG_MERGE_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "FORGEJO_TOKEN", "GITEA_TOKEN", "ACTIONS_RUNTIME_TOKEN"] as const;

/**
 * The first line of a GitHub or Forgejo step that runs the change's code. The
 * step's shell starts again, with `exec`, without any forge token variable:
 * Forgejo's runner gives every step the run's token (as GITHUB_TOKEN,
 * GITEA_TOKEN and ACTIONS_RUNTIME_TOKEN) whatever `permissions:` says, and
 * `unset` alone would leave it in the shell's own process environment, which
 * the shell's children can read. The OIDC request variables stay: the step
 * asks for its cloud role with them.
 *
 * The restart needs the step's script file (a runner runs `<shell> <file>`,
 * so `$0` is its path, never the shell's own) and `env` and the shell on the
 * PATH. When any of them is missing (the script given to `sh -c`, or no PATH), the shell does not
 * restart and drops the variables with `unset`, so its children still start
 * without them, and the script runs on.
 */
export function dropForgeTokens(shell: "bash" | "sh" = "bash"): string {
  const again = shell === "bash" ? 'bash --noprofile --norc -e -o pipefail "$0"' : 'sh -e "$0"';
  const can = `[ -z "\${TG_NO_FORGE_TOKEN:-}" ] && [ "\${0#*/}" != "$0" ] && [ -f "$0" ] && ! { [ "\${0##*/}" = sh ] || [ "\${0##*/}" = bash ] || [ "\${0##*/}" = dash ]; } && command -v env >/dev/null 2>&1 && command -v ${shell} >/dev/null 2>&1`;
  return `if ${can}; then exec env ${STEP_TOKEN_VARS.map((v) => `-u ${v}`).join(" ")} TG_NO_FORGE_TOKEN=1 ${again}; fi; unset ${STEP_TOKEN_VARS.join(" ")}`;
}

/**
 * The re-plan's first step, before any of the change's code is checked out:
 * `terragucci comment` reads the comment and writes a decision file; the
 * shell reads four values from it (a number, a sha, a branch and a root, each
 * already checked against a pattern with no shell syntax), never the comment,
 * and hands them on as the step's outputs. On Forgejo the command reads the
 * commenter's permission from the event, since the job's token may not ask
 * the API for it. A re-plan of the whole change says it is planning.
 */
export function replanDecideScript(layers: string[][], forge: Exclude<ForgeName, "gitlab">, agentComment?: boolean): string {
  return [
    READS_EXIT,
    forgeApi(forge),
    `terragucci comment --layers ${sh(layers.map((l) => l.join(",")).join(";"))}${forge === "forgejo" ? " --forge forgejo" : ""}${agentComment ? " --agent on" : ""} --out terragucci-comment.json || exit 1`,
    `read -r TG_PR TG_SHA TG_BASE TG_ROOT <<EOF`,
    `$(node -e '${DECISION_JS}' terragucci-comment.json)`,
    "EOF",
    '[ -n "$TG_PR" ] || exit 0',
    '[ "$TG_ROOT" = "-" ] && TG_ROOT=""',
    'export TG_SHA',
    '{ echo "go=1"; echo "pr=$TG_PR"; echo "sha=$TG_SHA"; echo "base=$TG_BASE"; echo "root=$TG_ROOT"; } >>"$GITHUB_OUTPUT"',
    '[ -n "$TG_ROOT" ] || tg status terragucci/plan pending "planning"',
  ].join("\n");
}

/**
 * The `plan-note` and `replan-note` jobs' script: post the plan job's note
 * and `terragucci/plan` from its report (`terragucci plan-note`), and under
 * `approval: pr-review` `terragucci/approval` from the same report.
 */
export function planNoteScript(forge: Exclude<ForgeName, "gitlab">, options: { replan?: boolean; prReview?: boolean } = {}): string {
  return [
    "set -u",
    `terragucci plan-note --forge ${forge} --report ${REPORT_DIR} --plan-result "\${TG_PLAN_RESULT:-}"${options.replan ? ' ${TG_ROOT:+--root "$TG_ROOT"}' : ""}${options.prReview ? " --approval-status" : ""}`,
  ].join("\n");
}

/**
 * The protected plan job's first check: with `gitlab.token: protected` the
 * forge token is a protected variable, which a merge request's pipeline never
 * sees. When the job sees it, the merge request's code can too, so the job
 * plans nothing and says why.
 */
export function gitlabTokenCheck(tokenEnv = "GITLAB_TOKEN"): string {
  return `if [ -n "\${${tokenEnv}:-}" ]; then echo "terragucci: ${tokenEnv} reaches this merge request's pipeline, so its code can use the token; gitlab.token is protected, so mark the variable Protected" >&2; exit 1; fi`;
}

/** Reads the decision file `terragucci comment` wrote. */
const DECISION_JS = 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf-8"));console.log(d.go?[d.pr,d.sha,d.base,d.root||"-"].join(" "):"")';

/** The pipeline variable that tells the comments schedule's pipelines from drift's on GitLab. */
export const SCHEDULE_VAR = "TERRAGUCCI_SCHEDULE";

/** The GitLab environment whose jobs see apply.merge_token_env's variable when it is scoped to it: comments and pr-merge, which run no merge request code. */
export const MERGE_ENVIRONMENT = "terragucci-merge";

/**
 * The comments job's script (GitLab). `terragucci comment --poll` reads the
 * merge request notes since the last polls, answers each `/terragucci` note
 * once, and starts or retries pipelines through the API; with `--plan-notes`
 * (`gitlab.token: protected`) it first posts the plan notes from the plan
 * jobs' reports. It runs nothing itself: no plan, no apply and no cloud
 * credentials.
 */
export function commentsScript(layers: string[][], prApply?: { requires?: ApplyRequire[] }, planNotes = false): string {
  const requires = prApply?.requires && !APPLY_REQUIRES.every((r) => prApply.requires!.includes(r)) ? ` --requires ${prApply.requires.length ? prApply.requires.join(",") : "none"}` : "";
  return `terragucci comment --forge gitlab --poll --layers ${sh(layers.map((l) => l.join(",")).join(";"))}${prApply ? ` --when pull-request${requires}` : ""}${planNotes ? " --plan-notes" : ""}`;
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
export function driftScript(binary: Binary, layers: string[][], forge: ForgeName = "github", oidc?: PipelineInput["oidc"], report: PlanReportInput = {}, pullRequest?: { tokenEnv?: string }): string {
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
  return [
    READS_EXIT,
    // The stage keeps the issue itself; the forge calls here are only for the OIDC token.
    ...(report.synth ? [synthScript(report.synth)] : []),
    ...(oidc ? [forgeApi(forge), ...cloudScripts(forge, oidc, "plan", "terragucci-drift")] : []),
    ...(report.terragrunt ? [report.terragrunt.prelude] : []),
    `terragucci stage tf-drift ${args.join(" ")}`,
    // The drift pull request: a person reviews and merges it, or closes it.
    ...(pullRequest
      ? ["rc=$?", ...respondSetup(forge, pullRequest.tokenEnv), `if [ "$rc" -eq 0 ]; then terragucci respond drift --mode apply --binary ${binary} || true; fi`, 'exit "$rc"']
      : []),
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
  return [
    READS_EXIT,
    forgeApi(forge),
    ...(report.synth ? [synthScript(report.synth, "terragucci/apply")] : []),
    ...cloudScripts(forge, oidc, "plan", "terragucci-confirm"),
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

function text(result: string | { primary: string }): string {
  return typeof result === "string" ? result : result.primary;
}

export function renderPipeline(input: PipelineInput): RenderedPipeline {
  const { forge, binary, image, install, layers, env, oidc, tokenEnv, headersSecret } = input;
  const tg = input.terragrunt;
  // waves.jobs: a wave of more roots than one job spreads across share jobs, after a job of its own plans it and decides its gate.
  const waveJobs = input.waveJobs !== undefined && input.waveJobs > 1 ? input.waveJobs : undefined;
  if (waveJobs && forge === "gitlab") throw new RenderError(`waves.jobs: ${WAVE_JOBS_NOT_GITLAB}`);
  if (waveJobs && input.applyWhen === "pull-request") throw new RenderError(`waves.jobs: ${WAVE_JOBS_NOT_PR_APPLY}`);
  const credentials = tg?.credentials && Object.keys(tg.credentials).length > 0 ? tg.credentials : undefined;
  // approval: pr-review posts terragucci/approval from the plan job and a review job on GitHub and Forgejo; GitLab's approval rules do that there.
  const prReview = input.prReview === true && forge !== "gitlab";
  // A job asks the forge for an OIDC token when it assumes a role, by oidc or by unit path.
  const needsToken = Boolean(oidc || credentials);
  // The canary wave comes from the repo's terragucci.yml at plan time, so a repo
  // with no config file gets the same pipeline as one whose config only sets waves.
  const report: PlanReportInput = {
    ...(input.reports ? { reports: input.reports } : {}),
    ...(responds(input.respond, "description") ? { description: true } : {}),
    ...(tg ? { terragrunt: { prelude: [cacheExports(), ...terragruntCredentials(forge, "plan", oidc, credentials)].join("\n") } } : {}),
    ...(prReview ? { prReview: true } : {}),
    ...(input.synth ? { synth: input.synth } : {}),
    ...(input.cost ? { cost: true } : {}),
  };
  const drift = input.drift;
  const rollouts = input.rollouts;
  const roots = layers.flat().sort();
  if (roots.length === 0) throw new RenderError(tg ? "there are no Terragrunt units to run" : "there are no roots to run");
  const jobEnv = { TF_IN_AUTOMATION: "1", TF_INPUT: "0", ...(tg ? terragruntJobEnv(binary, tg) : {}), ...env, ...(input.atlantisComments ? { [ATLANTIS_COMMENTS_ENV]: "1" } : {}) };
  // Only the jobs that run a stage send telemetry (plan, apply, drift), so only they get the headers secret; check and publish never see it.
  const headersEnv = headersSecret ? { OTEL_EXPORTER_OTLP_HEADERS: forge === "gitlab" ? `$${headersSecret}` : `\${{ secrets.${headersSecret} }}` } : {};
  // The service's key reaches the jobs that ask it: the plan jobs for the description check, the drift job
  // when it attributes (plain roots only; a Terragrunt drift run does not attribute), and the version-bump job.
  const decideSecret = input.decideTokenEnv ? { [input.decideTokenEnv]: `\${{ secrets.${input.decideTokenEnv} }}` } : {};
  const decideEnv = responds(input.respond, "description") ? decideSecret : {};
  const driftDecideEnv = !tg && responseTo({ respond: input.respond }, "drift") === "attribute" ? decideSecret : {};
  const bumpOn = responds(input.respond, "version-bump");
  const installs = tg ? tg.installs : install ? [{ tool: install.binary as Tool | Binary, version: install.version }] : [];
  const installStep = installs.length > 0 ? installs.map((i) => installScript(i.tool, i.version, forge)).join("\n") : undefined;
  const installName = `Install ${installs.map((i) => `${i.tool} ${i.version}`).join(", ")}`;
  const audience = oidc?.audience ?? AUDIENCE;
  const checkBody = tg ? terragruntCheckScript(tg, binary) : checkScript(binary, roots, input.synth, input.rootPins === true);
  const synth = input.synth ? { synth: input.synth } : {};
  // cost: the plan jobs, and the apply jobs that price a wave's plans for the policy and cost.approve_above, get the estimator's key
  // as INFRACOST_API_KEY, and Infracost unless cost.command names another estimator.
  const costEnv: Record<string, string> = input.cost ? { INFRACOST_API_KEY: forge === "gitlab" ? `$${input.cost.keySecret}` : `\${{ secrets.${input.cost.keySecret} }}` } : {};
  // GitLab gives every job the project's variables by name, so a key already named INFRACOST_API_KEY needs no mapping.
  const glCostEnv = input.cost && input.cost.keySecret !== "INFRACOST_API_KEY" ? costEnv : {};
  const costInstall = input.cost?.install ? installScript("infracost", INFRACOST_VERSION, forge) : undefined;
  // notify: the apply jobs post a waiting, refused or failed wave to the webhooks, read from the secrets the key names.
  const notifyOn = input.notify ? { notify: true } : {};
  const notifyEnv = Object.fromEntries(
    ([["slack", "TERRAGUCCI_SLACK_WEBHOOK"], ["teams", "TERRAGUCCI_TEAMS_WEBHOOK"], ["webhook", "TERRAGUCCI_WEBHOOK"], ["webhook_key", "TERRAGUCCI_WEBHOOK_KEY"]] as const)
      .filter(([k]) => input.notify?.[k])
      .map(([k, v]) => [v, forge === "gitlab" ? `$${input.notify![k]}` : `\${{ secrets.${input.notify![k]} }}`]),
  );
  // A wave per job, each behind its gate. A Terragrunt repo's layers are its units' dependency layers, canary first, as init found them;
  // the stage cuts them again from terragrunt find, and the last job also runs any wave past them.
  const gate = input.gate ?? "on-destroy";
  const waveCount = tg ? layers.length : applyWaves(layers, input.canary).length;
  const tgApply = tg ? { terragrunt: { prelude: [cacheExports(), ...terragruntCredentials(forge, "apply", oidc, credentials)].join("\n") } } : {};
  // With apply.when: pull-request a pull request applies before it merges, and the push after the merge runs the confirm job instead of the waves.
  const prApply = input.applyWhen === "pull-request";
  // A Terragrunt repo's layers are its waves already; the stage splits a wave's units across its share jobs as it cuts them.
  const cut = tg ? layers : applyWaves(layers, input.canary);
  const sharesOf = (i: number): number => (waveJobs && cut[i] ? waveShares(cut[i], waveJobs).length : 1);
  // Once one wave splits, every apply job holds the run's shared lock, so the shares apply side by side and no other run applies meanwhile.
  const split = cut.some((_, i) => sharesOf(i) > 1);
  const applyJobs: ApplyJob[] = [];
  let before: string[] = [];
  for (let i = 0; i < waveCount; i++) {
    const wave = i + 1;
    const n = sharesOf(i);
    const name = `apply-wave-${wave}`;
    const waveInput: ApplyWaveInput = { wave, ...(tg ? {} : { canary: input.canary }), gate, ...(input.approval ? { approval: input.approval } : {}), respond: input.respond, ...tgApply, ...synth, ...notifyOn, ...(input.policy ? { policy: true } : {}), ...(input.cost?.approveAbove ? { costGate: true } : {}), ...(n > 1 ? { shares: waveJobs } : {}) };
    applyJobs.push({ name, wave, needs: before, step: n > 1 ? `Plan wave ${wave} of ${waveCount} and decide its gate` : `Apply wave ${wave} of ${waveCount}`, body: applyScript(binary, layers, forge, oidc, { ...waveInput, ...(split ? { sharedLock: name } : {}) }), ...(n > 1 ? { decides: true } : {}) });
    before = [name];
    if (n > 1) {
      before = Array.from({ length: n }, (_, s) => `${name}-share-${s + 1}`);
      for (const [s, share] of before.entries()) {
        applyJobs.push({ name: share, wave, share: s + 1, needs: [name], step: `Apply share ${s + 1} of ${n} of wave ${wave}`, body: applyScript(binary, layers, forge, oidc, { ...waveInput, share: s + 1, sharedLock: share }) });
      }
    }
  }
  // The last wave's shares end side by side: one job after them all posts the success. In a Terragrunt repo that job
  // also runs, with --rest, any wave Terragrunt's edges cut past the pipeline's, so it applies like a wave's job.
  if (before.length > 1 && tg) {
    const rest: ApplyWaveInput = { wave: waveCount + 1, gate, ...(input.approval ? { approval: input.approval } : {}), respond: input.respond, ...tgApply, ...notifyOn, ...(input.policy ? { policy: true } : {}), ...(input.cost?.approveAbove ? { costGate: true } : {}), sharedLock: "apply-rest" };
    applyJobs.push({ name: "apply-rest", wave: waveCount + 1, needs: before, step: "Apply any wave past the pipeline's, then say every wave applied", body: applyScript(binary, layers, forge, oidc, rest) });
  } else if (before.length > 1) {
    applyJobs.push({ name: "apply-done", wave: waveCount, needs: before, step: "Say every wave applied", body: applyDoneScript(layers, forge), done: true });
  }
  // Forgejo pushes a merge as the user who asked for it, and refuses a push to a branch from the job's own token.
  if (prApply && input.applyMerge === "auto" && forge === "forgejo" && !input.applyMergeTokenEnv) throw new RenderError("apply.merge: auto on Forgejo needs apply.merge_token_env: Forgejo refuses a merge made with the job's own token, so name the secret holding the token of a user who may push to the default branch");
  // GitLab: the comments job reads `/terragucci apply` and starts the mr-apply pipeline with the merge token.
  if (prApply && forge === "gitlab" && !input.comments) throw new RenderError(`apply.when: ${PR_APPLY_NEEDS_ON_GITLAB.comments}`);
  if (prApply && forge === "gitlab" && !input.applyMergeTokenEnv) throw new RenderError(`apply.when: ${PR_APPLY_NEEDS_ON_GITLAB.token}`);
  const locksPlan = input.locksPlan === true;
  if (locksPlan && forge === "gitlab") throw new RenderError(`locks: ${NO_GITLAB_PLAN_LOCKS}`);
  const pushApplyJobs = prApply ? [] : applyJobs;
  const autoMerge = prApply && input.applyMerge === "auto";
  const lastApply = prApply ? "confirm" : applyJobs[applyJobs.length - 1].name;
  const prInput: CommentApplyInput = { ...(tg ? tgApply : { canary: input.canary }), ...synth, ...notifyOn, ...(split && forge === "github" ? { lockTag: true } : {}), gate, ...(input.approval ? { approval: input.approval } : {}), respond: input.respond, ...(prApply ? { when: "pull-request" as const, ...(input.applyMerge ? { merge: input.applyMerge } : {}), ...(input.applyRequires ? { requires: input.applyRequires } : {}) } : {}) };
  // A wave that waits records its plan on the chant/lifecycle branch; under gate: never only cost.approve_above makes one wait.
  // The resume job is written whenever apply.resume is set, whatever the gate: a state migration waits in wave 1 under gate: never too.
  // A state migration waits in wave 1 whatever the gate, so a repo that carries one writes the ledger under gate: never too.
  const writesLedger = gate !== "never" || input.cost?.approveAbove === true || (forge === "github" && input.migrations === true);
  const what = tg ? "unit" : "root";
  // The fmt commit: the binary's fmt, and in a Terragrunt repo terragrunt hcl fmt too. The drift pull request is for plain roots, where respond finds the roots itself.
  const fmtOn = responds(input.respond, "fmt");
  const driftPr = !tg && responds(input.respond, "drift") ? { tokenEnv } : undefined;
  // Tips are pull requests from the default branch, for plain roots and Terragrunt repos alike.
  const tipsOn = responds(input.respond, "tips");
  // An agent response writes its input file; the job keeps it as an artifact.
  const agentApply = responseTo({ respond: input.respond }, "apply-failed") === "agent";
  const agentDrift = !tg && responseTo({ respond: input.respond }, "drift") === "agent";
  // Attribution reads CloudTrail through the aws CLI, which the images do not carry.
  const awsStep = !tg && responseTo({ respond: input.respond }, "drift") === "attribute" ? awsCliScript(forge) : undefined;

  if (input.comments && forge !== "gitlab") throw new RenderError(`comments: ${COMMENTS_GITLAB_ONLY}`);
  if (forge === "gitlab") {
    if (input.agentComment) throw new RenderError("agent.comment needs a pipeline a pull request comment can start, and GitLab starts none for a merge request note; leave agent.comment unset on GitLab");
    // With gitlab.token: protected no merge request pipeline holds the token, and the comments job posts the plan notes.
    const protectedToken = input.gitlabToken === "protected";
    if (protectedToken && !input.comments) throw new RenderError(`gitlab.token: ${PROTECTED_TOKEN_NEEDS_COMMENTS}`);
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
    // One id_token per audience: AWS's (which the Terragrunt auth provider uses too), GCP's provider, Entra ID.
    const idTokens = needsToken
      ? {
          id_tokens: {
            ...(hasAws(oidc) || credentials ? { TERRAGUCCI_OIDC: { aud: audience } } : {}),
            ...(oidc?.gcp ? { [GITLAB_GCP_TOKEN]: { aud: gcpAudience(oidc.gcp.workload_identity_provider) } } : {}),
            ...(oidc?.azure ? { [GITLAB_AZURE_TOKEN]: { aud: AZURE_AUDIENCE } } : {}),
          },
        }
      : {};
    // A scheduled pipeline is drift's, the comments poll's, the resume's or the rollouts'; the push and merge request jobs sit it out.
    const scheduled = Boolean(drift || input.comments || input.resume || rollouts);
    // With apply.when: pull-request the comments job starts a pipeline on the default branch for a merge request; only mr-apply and pr-merge run in it.
    const notMrApply = prApply ? ` && $${MR_VAR} == null` : "";
    const notScheduled = scheduled ? { rules: [new Rule({ if: `$CI_PIPELINE_SOURCE != "schedule"${notMrApply}` })] } : {};
    const onDefault = `${scheduled ? '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule"' : "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH"}${notMrApply}`;
    const mrApplyRule = `$CI_PIPELINE_SOURCE == "api" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $${MR_VAR}`;
    // Only the jobs that run no merge request code see the merge token: GitLab gives a variable scoped to this environment to the jobs that name it.
    const mergeEnvironment = { environment: { name: MERGE_ENVIRONMENT, action: "access" } };
    // A branch's pipeline is built from the branch's files too, and with gitlab.token: protected it never sees the
    // token: then there is no fmt job, and nothing commits formatting.
    const glFmt = fmtOn && !protectedToken;
    // The check runs the branch's code (synth, validate's providers, the policy engine). Its shell drops every forge
    // token variable GitLab hands the job before it runs anything, so none of that code inherits one.
    const glCheckBody = [`unset ${[...new Set(["TG_TOKEN", "TG_MERGE_TOKEN", "GITLAB_TOKEN", "CI_JOB_TOKEN", ...(tokenEnv ? [tokenEnv] : [])])].join(" ")}`, checkBody].join("\n");
    const check = new GitLabJob({
      stage: "check",
      image: jobImage,
      // The policy tests read the policy from the default branch, so with `policy:` the job has its history.
      variables: { ...jobEnv, TG_BRANCH: gitlabEnv.TG_BRANCH, ...(input.policy ? { GIT_DEPTH: "0" } : {}) },
      ...notScheduled,
      script: script(glCheckBody),
      // The check report (validate's diagnostics, live-check's refusals, the policy tests) stays with the job.
      artifacts: { name: CHECK_DIR, when: "always", paths: [`${CHECK_DIR}/`] },
    } as never);
    // Plan runs a merge request's code, so it gets the read-only role, and never runs for a merge request from a fork.
    // By default it posts its note and status with the project token, which the merge request's code can read too;
    // with gitlab.token: protected it gets no token, and the comments job posts them from its report.
    const { TG_TOKEN: _planToken, ...planEnv } = gitlabEnv;
    const plan = new GitLabJob({
      stage: "plan",
      image: jobImage,
      variables: { ...(protectedToken ? planEnv : gitlabEnv), TG_PR: "$CI_MERGE_REQUEST_IID", GIT_DEPTH: "0", ...glCostEnv },
      rules: [new Rule({ if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_PATH == $CI_PROJECT_PATH' })],
      ...idTokens,
      ...(tg ? forgeCache("gitlab") : {}),
      script: [...(costInstall ? [costInstall] : []), ...script(bash("PLAN", protectedToken ? gitlabProtectedPlanScript(binary, layers, oidc, report, tokenEnv) : planScript(binary, layers, forge, oidc, report)))],
      // The report stays with the job; its counts feed the merge request's widget.
      artifacts: { name: REPORT_DIR, when: "always", paths: [`${REPORT_DIR}/`], reports: { terraform: `${REPORT_DIR}/gitlab-terraform.json` } },
    } as never);
    const jobs = new Map<string, never>([["check", check as never]]);
    if (glFmt) {
      // After a failing check on a branch, commit the formatting: a job of its own, so the check job, which runs the
      // branch's code, holds no token that pushes. It runs fmt, which parses the files and runs none of them.
      // It shares the check stage, so a repo whose own stages list terragucci's needs no new one; `needs` runs it after check.
      jobs.set("fmt", new GitLabJob({
        stage: "check",
        image: jobImage,
        needs: ["check"],
        variables: { ...jobEnv, TG_TOKEN: gitlabEnv.TG_TOKEN },
        rules: [new Rule({ if: `$CI_COMMIT_BRANCH && $CI_COMMIT_BRANCH != $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "schedule"${notMrApply}`, when: "on_failure" } as never)],
        script: script(bash("FMT", fmtScript(binary, forge, tokenEnv))),
      } as never) as never);
    }
    jobs.set("plan", plan as never);
    for (const job of pushApplyJobs) {
      jobs.set(job.name, new GitLabJob({
        stage: "apply",
        image: jobImage,
        ...(job.needs.length > 0 ? { needs: job.needs } : {}),
        variables: { ...gitlabEnv, TG_BEFORE: "$CI_COMMIT_BEFORE_SHA", ...notifyEnv, ...glCostEnv },
        rules: [new Rule({ if: onDefault })],
        resource_group: "terragucci-apply",
        ...idTokens,
        ...(tg ? forgeCache("gitlab") : {}),
        script: [...(costInstall ? [costInstall] : []), ...script(bash("APPLY", job.body))],
        // The wave's report stays with the job, like the plan's; the agent's input joins it when there is one.
        artifacts: { name: `${REPORT_DIR}-${job.name}`, when: "always", paths: [`${REPORT_DIR}/`, ...(agentApply ? [`${RESPOND_DIR}/`] : [])] },
      } as never) as never);
    }
    if (prApply) {
      // The push after a merge applies nothing: the merge request applied before it merged. confirm plans every root with the read-only role.
      jobs.set("confirm", new GitLabJob({
        stage: "apply",
        image: jobImage,
        variables: gitlabEnv,
        rules: [new Rule({ if: onDefault })],
        ...idTokens,
        ...(tg ? forgeCache("gitlab") : {}),
        script: script(bash("CONFIRM", confirmScript(binary, layers, forge, oidc, report))),
        artifacts: { name: `${REPORT_DIR}-confirm`, when: "always", paths: [`${REPORT_DIR}/`] },
      } as never) as never);
      // The pipeline the comments job starts on the default branch for an open merge request: its file is the default branch's,
      // and the job reads the merge request again before it takes the apply role.
      jobs.set("mr-apply", new GitLabJob({
        stage: "apply",
        image: jobImage,
        variables: { ...gitlabEnv, GIT_DEPTH: "0", ...notifyEnv, ...glCostEnv },
        rules: [new Rule({ if: mrApplyRule })],
        resource_group: "terragucci-apply",
        ...idTokens,
        ...(tg ? forgeCache("gitlab") : {}),
        script: [...(costInstall ? [costInstall] : []), ...script(bash("APPLY", gitlabApplyScript(binary, layers, oidc, prInput)))],
        artifacts: { name: `${REPORT_DIR}-mr-apply`, when: "always", paths: [`${REPORT_DIR}/`, ...(agentApply ? [`${RESPOND_DIR}/`] : [])] },
      } as never) as never);
      if (autoMerge) {
        // Merges after mr-apply, in a job of its own that runs none of the merge request's code and takes none of mr-apply's artifacts.
        jobs.set("pr-merge", new GitLabJob({
          stage: "apply",
          image: jobImage,
          needs: [{ job: "mr-apply", artifacts: false }],
          variables: { TG_TOKEN: gitlabEnv.TG_TOKEN, TG_MERGE_TOKEN: `$${input.applyMergeTokenEnv}` },
          rules: [new Rule({ if: mrApplyRule })],
          ...mergeEnvironment,
          script: [bash("MERGE", gitlabMergeScript())],
        } as never) as never);
      }
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
        script: script(bash("TIPS", tipsScript(binary, forge, tokenEnv))),
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
    if (drift) {
      jobs.set("drift", new GitLabJob({
        stage: "drift",
        image: jobImage,
        variables: gitlabEnv,
        // The comments, resume and rollouts schedules' pipelines carry TERRAGUCCI_SCHEDULE=comments, resume or rollouts; any other schedule, with or without a variable, is drift's.
        rules: [new Rule({ if: `$CI_PIPELINE_SOURCE == "schedule" && $${SCHEDULE_VAR} != "comments"${input.resume ? ` && $${SCHEDULE_VAR} != "resume"` : ""}${rollouts ? ` && $${SCHEDULE_VAR} != "rollouts"` : ""}` })],
        ...idTokens,
        ...(tg ? forgeCache("gitlab") : {}),
        script: [...(installStep ? [installStep] : []), ...(awsStep ? [awsStep] : []), bash("DRIFT", driftScript(binary, layers, forge, oidc, report, driftPr))],
        artifacts: { name: `${REPORT_DIR}-drift`, when: "always", paths: [`${REPORT_DIR}/`, ...(agentDrift ? [`${RESPOND_DIR}/`] : [])] },
      } as never) as never);
    }
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
      // With apply.when: pull-request it also holds the merge token, to start the mr-apply pipeline on the protected default branch.
      jobs.set("comments", new GitLabJob({
        stage: "comments",
        image: jobImage,
        variables: { TG_TOKEN: gitlabEnv.TG_TOKEN, ...(prApply ? { TG_MERGE_TOKEN: `$${input.applyMergeTokenEnv}` } : {}), ...(input.atlantisComments ? { [ATLANTIS_COMMENTS_ENV]: "1" } : {}), GIT_STRATEGY: "none" },
        rules: [new Rule({ if: `$CI_PIPELINE_SOURCE == "schedule" && $${SCHEDULE_VAR} == "comments"` })],
        resource_group: "terragucci-comments",
        ...(prApply ? mergeEnvironment : {}),
        script: [bash("COMMENTS", commentsScript(layers, prApply ? { ...(input.applyRequires ? { requires: input.applyRequires } : {}) } : undefined, protectedToken))],
      } as never) as never);
    }
    if (input.resume) {
      // A pipeline schedule with TERRAGUCCI_SCHEDULE=resume: retry the default branch's waiting apply job once its approval stands.
      // It reads the ledger and calls the API with the project's token; it takes no cloud credentials.
      jobs.set("resume", new GitLabJob({
        stage: "resume",
        image: jobImage,
        variables: { TG_TOKEN: gitlabEnv.TG_TOKEN },
        rules: [new Rule({ if: `$CI_PIPELINE_SOURCE == "schedule" && $${SCHEDULE_VAR} == "resume"` })],
        resource_group: "terragucci-resume",
        script: [bash("RESUME", "terragucci resume --forge gitlab")],
      } as never) as never);
    }
    const out = text(gitlabSerializer.serialize(jobs)).replace(/^stages:\n((?: {2}- .*\n)+)/, (_, list: string) => {
      const ours = list.trimEnd().split("\n").map((l) => l.replace(/^ {2}- /, ""));
      return `${emitYAMLEntry("stages", [...GL_DEFAULT_STAGES.before, ...ours, ...GL_DEFAULT_STAGES.after])}\n`;
    });
    return { path: PIPELINE_PATHS.gitlab, content: header(image, input.imageFromConfig) + out };
  }

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
      // `/terragucci plan [root]` in a pull request comment re-plans it (comment.ts); `/terragucci apply` on a merged one re-runs its apply (comment-apply.ts).
      issue_comment: { types: ["created"] },
      // approval: pr-review: a review of the head re-posts terragucci/approval.
      ...(prReview ? { pull_request_review: {} } : {}),
      // locks: plan: the pr-lock job, from the default branch's workflow, locks a pull request's roots and releases them when it closes.
      ...(locksPlan ? { pull_request_target: { types: ["opened", "reopened", "synchronize", "closed"] } } : {}),
      ...(drift ? { schedule: [{ cron: drift }], workflow_dispatch: {} } : {}),
    },
    env: jobEnv,
    permissions: { contents: "read" },
    // Forgejo cancels the runs of an earlier push to a branch, even one that is
    // applying, unless the workflow names a concurrency group. A group that does
    // not cancel makes a later run wait instead.
    // A pull_request_target run's ref is the default branch's, so with locks: plan it gets a group of its own pull request's.
    ...(forge === "forgejo"
      ? { concurrency: { group: locksPlan
        ? "terragucci-${{ github.event_name == 'issue_comment' && format('comment-{0}', github.event.issue.number) || github.event_name == 'pull_request_target' && format('lock-{0}', github.event.pull_request.number) || github.ref }}"
        : "terragucci-${{ github.event_name == 'issue_comment' && format('comment-{0}', github.event.issue.number) || github.ref }}", "cancel-in-progress": false } }
      : {}),
  } as never);
  // A plan reads the range from the target branch, so its checkout has the history.
  const steps = (main: InstanceType<typeof Step>, cached = false, history = false, before?: string, estimator = false, fetch?: InstanceType<typeof Step>): InstanceType<typeof Step>[] => [
    new Step({ uses: "actions/checkout@v4", ...(history ? { with: { "fetch-depth": 0 } } : {}) }),
    ...(installStep ? [new Step({ name: installName, run: installStep })] : []),
    ...(estimator && costInstall ? [new Step({ name: `Install Infracost ${INFRACOST_VERSION}`, run: costInstall })] : []),
    ...(before ? [new Step({ name: `Install the AWS CLI ${AWS_CLI.version} unless the job has it`, shell: "bash", run: before })] : []),
    ...(cached && tg ? [new Step({ name: "Cache Terragrunt sources and providers", ...forgeCache(forge) } as never)] : []),
    ...(fetch ? [fetch] : []),
    main,
  ];
  const upload = forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4";
  const download = forge === "forgejo" ? "actions/download-artifact@v3" : "actions/download-artifact@v4";
  // A job that runs the change's code checks it out with no credentials left in the git config.
  const bareCheckout = (history: boolean, ref?: string, cond?: string): InstanceType<typeof Step> =>
    new Step({ ...(cond ? { if: cond } : {}), uses: "actions/checkout@v4", with: { ...(ref ? { ref } : {}), ...(history ? { "fetch-depth": 0 } : {}), "persist-credentials": false } });
  // The steps between the checkout and the main step of a job that runs the change's code.
  const toolSteps = (cached: boolean, estimator: boolean, cond?: string): InstanceType<typeof Step>[] => [
    ...(installStep ? [new Step({ ...(cond ? { if: cond } : {}), name: installName, run: installStep })] : []),
    ...(estimator && costInstall ? [new Step({ ...(cond ? { if: cond } : {}), name: `Install Infracost ${INFRACOST_VERSION}`, run: costInstall })] : []),
    ...(cached && tg ? [new Step({ ...(cond ? { if: cond } : {}), name: "Cache Terragrunt sources and providers", ...forgeCache(forge) } as never)] : []),
  ];
  // Check runs for a push, and for a fork's pull request, which has no push here. It runs the branch's code
  // (synth, validate's providers, the policy engine) and holds no forge token: the checkout keeps no credentials,
  // and the step starts without the runner's token variables.
  const check = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    if: `github.event_name == 'push' || (github.event_name == 'pull_request' && ${isFork})`,
    env: { TG_BRANCH: "${{ github.event.repository.default_branch }}" },
    steps: [
      // The policy tests read the policy from the default branch, so with `policy:` the checkout has the history.
      bareCheckout(Boolean(input.policy)),
      ...toolSteps(false, false),
      new Step({ name: `Format check and validate, every ${what}`, run: `${dropForgeTokens("sh")}\n${checkBody}` }),
      // The check report stays with the run, beside the job summary.
      new Step({
        name: "Keep the check report",
        if: "always()",
        uses: upload,
        with: { name: CHECK_DIR, path: `${CHECK_DIR}/`, "if-no-files-found": "ignore" },
      }),
    ],
  } as never);
  // With a drift schedule the plan note says when the schedule has stopped, from the drift job's runs.
  const driftRead = drift && forge === "github" ? { actions: "read" } : {};
  // Plan runs a pull request's code, so it gets the read-only role, and never
  // runs for a fork, whose pull requests carry no token and no OIDC. It holds
  // no forge token while that code runs: it posts the pending status before
  // the checkout, writes the note and the status into its report, and the
  // plan-note job posts them.
  const plan = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    if: `github.event_name == 'pull_request' && ${sameRepo}`,
    permissions: { contents: "read", statuses: "write", ...(needsToken ? { "id-token": "write" } : {}) },
    ...openid(needsToken),
    env: {
      TG_SHA: "${{ github.event.pull_request.head.sha }}",
      TG_PR: "${{ github.event.pull_request.number }}",
      ...headersEnv,
      ...decideEnv,
      ...costEnv,
      ...reportKeyEnv(forge, input.reports),
    },
    steps: [
      new Step({ name: "Say on the head that the plan started", shell: "bash", env: { TG_TOKEN: "${{ github.token }}" }, run: [forgeApi(forge), 'tg status terragucci/plan pending "planning"'].join("\n") }),
      bareCheckout(true),
      ...toolSteps(true, true),
      new Step({ name: `Plan the ${what}s the change reaches and write the plan report`, shell: "bash", run: `${dropForgeTokens()}\n${planFilesScript(binary, layers, forge, oidc, report)}` }),
      // The report stays with the run, and the plan-note job reads the note and the status from it. Forgejo's artifact store speaks the v3 protocol.
      new Step({
        name: "Keep the plan report",
        if: "always()",
        uses: upload,
        with: { name: REPORT_DIR, path: `${REPORT_DIR}/`, "if-no-files-found": "ignore" },
      }),
    ],
  } as never);
  // The note job of a plan: a fresh container that checks nothing out and runs none of the change's code. It reads the
  // plan job's note and status as data and posts them with the job's token.
  const noteJob = (needs: string, cond: string, artifact: string, env: Record<string, string>, replan: boolean): InstanceType<typeof Job> =>
    new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      needs,
      if: `always() && (needs.${needs}.result == 'success' || needs.${needs}.result == 'failure') && ${cond}`,
      permissions: { statuses: "write", "pull-requests": "write", ...driftRead },
      env: { TG_TOKEN: "${{ github.token }}", TG_PLAN_RESULT: `\${{ needs.${needs}.result }}`, ...env },
      steps: [
        new Step({ name: "Fetch the plan report", uses: download, "continue-on-error": true, with: { name: artifact, path: REPORT_DIR } } as never),
        // Forgejo ignores continue-on-error, so the post runs whatever the download did: a plan job that failed before its report still fails terragucci/plan.
        new Step({ name: "Post the plan note and terragucci/plan", if: "always()", shell: "bash", run: planNoteScript(forge, { replan, prReview }) }),
      ],
    } as never);
  const planNote = noteJob("plan", `github.event_name == 'pull_request' && ${sameRepo}`, REPORT_DIR, { TG_SHA: "${{ github.event.pull_request.head.sha }}", TG_PR: "${{ github.event.pull_request.number }}" }, false);
  // A comment's first words, as the jobs' conditions test them; with atlantis_comments, `atlantis plan` and `atlantis apply` start the same jobs.
  const says = (p: string): string => `startsWith(github.event.comment.body, '${p}')`;
  const atlantis = input.atlantisComments === true;
  const applySays = atlantis ? `${says("/terragucci apply")} || ${says("atlantis apply")}` : says("/terragucci apply");
  const planSays = atlantis ? `(${says("/terragucci plan")} || ${says("atlantis plan")})` : says("/terragucci plan");
  // With apply.when: pull-request, `/terragucci lock` and `/terragucci unlock` are the apply-comment job's too: it holds the locks.
  const APPLY_COMMENT = prApply
    ? `(${applySays} || ${says("/terragucci lock")} || ${says("/terragucci unlock")})`
    : atlantis ? `(${applySays})` : applySays;
  // With locks: plan and apply.when: merge, `/terragucci lock` and `/terragucci unlock` are the pr-lock job's.
  const LOCK_COMMENT = "(startsWith(github.event.comment.body, '/terragucci lock') || startsWith(github.event.comment.body, '/terragucci unlock'))";
  const lockElsewhere = locksPlan && !prApply ? ` && !${LOCK_COMMENT}` : "";
  // A comment re-plans a pull request of this repository for someone who can write to it. The comment is
  // never an expression in the script: the command reads it from the event file (comment.ts). The decision
  // step holds the job's token and runs before the change is checked out; the plan step holds none, and the
  // replan-note job posts the note.
  const go = "steps.decide.outputs.go == '1'";
  const replanEnv = { ...headersEnv, ...decideEnv, ...costEnv, ...reportKeyEnv(forge, input.reports) };
  const replan = new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    if: `github.event_name == 'issue_comment' && ${atlantis ? `(${says("/terragucci")} || ${says("atlantis plan")})` : says("/terragucci")} && !${APPLY_COMMENT}${lockElsewhere}${input.agentComment ? ` && !${AGENT_COMMENT_IF}` : ""}`,
    permissions: { contents: "read", statuses: "write", "pull-requests": "write", ...(needsToken ? { "id-token": "write" } : {}) },
    ...openid(needsToken),
    concurrency: { group: "terragucci-replan-${{ github.repository }}-${{ github.event.issue.number }}", "cancel-in-progress": false },
    ...(Object.keys(replanEnv).length ? { env: replanEnv } : {}),
    outputs: { go: "${{ steps.decide.outputs.go }}", pr: "${{ steps.decide.outputs.pr }}", sha: "${{ steps.decide.outputs.sha }}", root: "${{ steps.decide.outputs.root }}" },
    steps: [
      bareCheckout(false),
      new Step({ id: "decide", name: "Read the comment and decide whether it re-plans", shell: "bash", env: { TG_TOKEN: "${{ github.token }}" }, run: replanDecideScript(layers, forge, input.agentComment !== undefined) }),
      // The head comes from the pull request, by number; the base branch comes with the history, for the range.
      bareCheckout(true, "refs/pull/${{ steps.decide.outputs.pr }}/head", go),
      ...toolSteps(true, true, go),
      new Step({
        if: go,
        name: "Re-plan the pull request on request and write the plan report",
        shell: "bash",
        env: { TG_PR: "${{ steps.decide.outputs.pr }}", TG_SHA: "${{ steps.decide.outputs.sha }}", TG_ROOT: "${{ steps.decide.outputs.root }}", TG_BASE: "origin/${{ steps.decide.outputs.base }}" },
        run: `${dropForgeTokens()}\n${planFilesScript(binary, layers, forge, oidc, report, { replan: true })}`,
      }),
      new Step({
        name: "Keep the plan report",
        if: `always() && ${go}`,
        uses: upload,
        with: { name: `${REPORT_DIR}-replan`, path: `${REPORT_DIR}/`, "if-no-files-found": "ignore" },
      }),
    ],
  } as never);
  const replanNote = noteJob("replan", "needs.replan.outputs.go == '1'", `${REPORT_DIR}-replan`, { TG_PR: "${{ needs.replan.outputs.pr }}", TG_SHA: "${{ needs.replan.outputs.sha }}", TG_ROOT: "${{ needs.replan.outputs.root }}" }, true);
  const entities = new Map<string, never>([
    ["workflow", workflow as never],
    ["check", check as never],
    ["plan", plan as never],
    ["plan-note", planNote as never],
    ["replan", replan as never],
    ["replan-note", replanNote as never],
  ]);
  // After a failing check on a branch, commit the formatting to it; a fork's pull request has no push here. A job of
  // its own, so the check job, which runs the branch's code, never holds the token that pushes. It runs fmt, which
  // parses the files and runs none of them.
  if (fmtOn) {
    entities.set("fmt", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      needs: "check",
      if: "always() && needs.check.result == 'failure' && github.event_name == 'push' && github.ref != format('refs/heads/{0}', github.event.repository.default_branch)",
      permissions: { contents: "write" },
      env: { TG_TOKEN: "${{ github.token }}" },
      steps: [
        new Step({ uses: "actions/checkout@v4" }),
        ...(installStep ? [new Step({ name: installName, run: installStep })] : []),
        new Step({ name: "Commit the formatting", shell: "bash", run: fmtScript(binary, forge, tokenEnv) }),
      ],
    } as never) as never);
  }
  // `/terragucci apply` on a merged pull request re-runs its apply from the merge commit, with the
  // apply role, under the lock a push's apply holds. The workflow is the default branch's, as for
  // every comment; commentApplyScript decides before it asks for any credential. A Terragrunt repo's
  // job runs its waves of units with --terragrunt, after the apply jobs' prelude.
  entities.set("apply-comment", new Job({
    "runs-on": "ubuntu-latest",
    container: { image },
    if: `github.event_name == 'issue_comment' && ${APPLY_COMMENT}`,
    // Before merge it also pushes the root locks and merges (contents: write), and reads the head's checks.
    permissions: { contents: writesLedger || prApply || split ? "write" : "read", statuses: "write", "pull-requests": "write", ...(prApply && forge === "github" ? { checks: "read" } : {}), ...(needsToken ? { "id-token": "write" } : {}) },
    ...openid(needsToken),
    concurrency: applyConcurrency(forge),
    // The job runs the pull request's code, so it never holds the merge token; with apply.merge: auto it hands the head on to pr-merge.
    env: { TG_TOKEN: "${{ github.token }}", ...headersEnv, ...notifyEnv, ...costEnv },
    ...(autoMerge ? { outputs: { merge: "${{ steps.apply.outputs.merge }}", sha: "${{ steps.apply.outputs.sha }}", waves: "${{ steps.apply.outputs.waves }}" } } : {}),
    steps: [
      ...steps(new Step({ ...(autoMerge ? { id: "apply" } : {}), name: prApply ? "Apply a pull request on request, from its head before merge or its merge commit after" : "Apply a merged pull request on request, from its merge commit", shell: "bash", run: commentApplyScript(binary, layers, forge, oidc, prInput) } as never), true, true, undefined, true),
      new Step({ name: "Keep the apply report", if: "always()", uses: forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4", with: { name: `${REPORT_DIR}-apply-comment`, path: `${REPORT_DIR}/`, "if-no-files-found": "ignore" } }),
    ],
  } as never) as never);
  // apply.merge: auto merges in a job of its own, after the apply-comment job applied every wave from the head. It runs no
  // code of the pull request: a fresh container, the default branch's checkout (to release the locks), and the merge token.
  if (autoMerge) {
    entities.set("pr-merge", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      needs: "apply-comment",
      if: "needs.apply-comment.outputs.merge == '1'",
      permissions: { contents: "write", "pull-requests": "write" },
      env: {
        TG_TOKEN: "${{ github.token }}",
        ...(input.applyMergeTokenEnv ? { TG_MERGE_TOKEN: `\${{ secrets.${input.applyMergeTokenEnv} }}` } : {}),
        TG_PR: "${{ github.event.issue.number }}",
        TG_SHA: "${{ needs.apply-comment.outputs.sha }}",
        TG_WAVES: "${{ needs.apply-comment.outputs.waves }}",
      },
      steps: [
        new Step({ uses: "actions/checkout@v4" }),
        new Step({ name: "Merge the pull request whose every wave applied", shell: "bash", run: mergeScript(forge) }),
      ],
    } as never) as never);
  }
  if (prReview) {
    // A review of the head says again whether the waves the gate will hold are approved.
    entities.set("approval", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      if: `github.event_name == 'pull_request_review' && ${sameRepo}`,
      permissions: { contents: "read", statuses: "write", "pull-requests": "read" },
      env: { TG_TOKEN: "${{ github.token }}", TG_SHA: "${{ github.event.pull_request.head.sha }}", TG_PR: "${{ github.event.pull_request.number }}" },
      steps: [new Step({ name: "Say on the head whether its waiting waves are approved", shell: "bash", run: `terragucci approval-status --forge ${forge}` })],
    } as never) as never);
  }
  if (input.agentComment) for (const [name, job] of agentCommentJobs(forge, image, input.agentComment)) entities.set(name, job);
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
        new Step({ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } }),
        new Step({ name: "Lock the roots the pull request reaches, or release them", shell: "bash", run: planLockScript(layers, forge, prApply, Boolean(tg)) }),
      ],
    } as never) as never);
  }
  const applyIf = `${drift ? "github.event_name == 'push' && " : ""}github.ref == format('refs/heads/{0}', github.event.repository.default_branch)`;
  for (const job of pushApplyJobs) {
    if (job.done) {
      // After the last wave's shares: it runs no code and holds no credential, and posts the one success.
      entities.set(job.name, new Job({
        "runs-on": "ubuntu-latest",
        container: { image },
        needs: job.needs,
        if: applyIf,
        permissions: { contents: "read", statuses: "write" },
        env: { TG_TOKEN: "${{ github.token }}", TG_SHA: "${{ github.sha }}" },
        steps: [new Step({ name: job.step, shell: "bash", run: job.body })],
      } as never) as never);
      continue;
    }
    entities.set(job.name, new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      // Each wave needs the one before, so a wave that waits holds back every later one; a wave's shares need its own job, which decided it.
      needs: job.needs.length === 0 ? "check" : job.needs.length === 1 ? job.needs[0] : job.needs,
      if: applyIf,
      // contents: write only to record a waiting wave's plan on the chant/lifecycle branch, and with a wave split across jobs to hold the shared lock's tags.
      permissions: { contents: writesLedger || split ? "write" : "read", statuses: "write", "pull-requests": "write", ...(needsToken ? { "id-token": "write" } : {}) },
      ...openid(needsToken),
      // One apply per project at a time; nothing that waits is cancelled (applyConcurrency). A wave's shares apply side by side, under the run's shared lock.
      ...(job.share === undefined ? { concurrency: applyConcurrency(forge) } : {}),
      env: {
        TG_TOKEN: "${{ github.token }}",
        TG_SHA: "${{ github.sha }}",
        TG_BEFORE: "${{ github.event.before }}",
        TG_BRANCH: "${{ github.event.repository.default_branch }}",
        ...headersEnv,
        ...notifyEnv,
        ...costEnv,
      },
      steps: [
        ...steps(new Step({ name: job.step, shell: "bash", run: job.body }), true, false, undefined, true, job.share !== undefined ? new Step({ name: "Fetch the wave's decision", uses: download, with: { name: `${DECIDED_DIR}-${job.wave}`, path: DECIDED_DIR } } as never) : undefined),
        ...(job.decides ? [new Step({ name: "Hand the decision to the wave's shares", uses: upload, with: { name: `${DECIDED_DIR}-${job.wave}`, path: `${DECIDED_DIR}/`, "if-no-files-found": "error" } })] : []),
        new Step({ name: "Keep the apply report", if: "always()", uses: forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4", with: { name: `${REPORT_DIR}-${job.name}`, path: `${REPORT_DIR}/`, "if-no-files-found": "ignore" } }),
        ...(agentApply
          ? [new Step({ name: "Keep the agent input", if: "failure()", uses: forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4", with: { name: `${RESPOND_DIR}-${job.name}`, path: `${RESPOND_DIR}/`, "if-no-files-found": "ignore" } })]
          : []),
      ],
    } as never) as never);
  }
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
      env: { TG_TOKEN: "${{ github.token }}", TG_SHA: "${{ github.sha }}", ...headersEnv },
      steps: [
        ...steps(new Step({ name: `Plan every ${what} to confirm the merge applied`, shell: "bash", run: confirmScript(binary, layers, forge, oidc, report) }), true),
        new Step({ name: "Keep the plan report", if: "always()", uses: forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4", with: { name: `${REPORT_DIR}-confirm`, path: `${REPORT_DIR}/`, "if-no-files-found": "ignore" } }),
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
        new Step({ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } }),
        ...(installStep ? [new Step({ name: installName, run: installStep })] : []),
        new Step({ name: "Open a pull request for each tip", shell: "bash", run: tipsScript(binary, forge, tokenEnv) }),
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
        new Step({ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } }),
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
      },
      steps: [
        new Step({ uses: "actions/checkout@v4", with: { "fetch-depth": 0 } }),
        ...(installStep && install ? [new Step({ name: `Install ${install.binary} ${install.version}`, run: installStep })] : []),
        ...(input.attest ? [new Step({ name: `Install cosign ${COSIGN_VERSION}`, run: installScript("cosign", COSIGN_VERSION, forge) })] : []),
        new Step({ name: "Publish the modules that changed", shell: "bash", run: publishScript(forge) }),
      ],
    } as never) as never);
  }
  if (drift) {
    // Reads every root, so it takes the plan job's read-only role, and writes only the issue.
    entities.set("drift", new Job({
      "runs-on": "ubuntu-latest",
      container: { image },
      if: "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
      permissions: { contents: driftPr ? "write" : "read", issues: "write", ...(driftPr ? { "pull-requests": "write" } : {}), ...(oidc ? { "id-token": "write" } : {}) },
      ...openid(Boolean(oidc)),
      env: {
        TG_TOKEN: "${{ github.token }}",
        TG_SHA: "${{ github.sha }}",
        ...headersEnv,
        ...driftDecideEnv,
        ...reportKeyEnv(forge, input.reports),
      },
      steps: [
        ...steps(new Step({ name: `Plan every ${what} against what exists, and keep the drift issue`, shell: "bash", run: driftScript(binary, layers, forge, oidc, report, driftPr) }), true, false, awsStep),
        new Step({
          name: "Keep the drift report",
          if: "always()",
          uses: forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4",
          with: { name: `${REPORT_DIR}-drift`, path: `${REPORT_DIR}/`, "if-no-files-found": "ignore" },
        }),
        ...(agentDrift
          ? [new Step({ name: "Keep the agent input", if: "always()", uses: forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4", with: { name: `${RESPOND_DIR}-drift`, path: `${RESPOND_DIR}/`, "if-no-files-found": "ignore" } })]
          : []),
      ],
    } as never) as never);
  }
  const serializer = forge === "forgejo" ? forgejoSerializer : githubSerializer;
  const extra: { path: string; content: string }[] = [];
  if (input.resume) {
    // apply.resume: a schedule of its own reads the ledger and applies a wave whose approval stands, as a comment's apply does.
    const resume = new Map<string, never>([
      ["workflow", new Workflow({ name: "terragucci resume", on: { schedule: [{ cron: resumeCron(input.resume) }], workflow_dispatch: {} }, env: jobEnv, permissions: { contents: "read" } }) as never],
      ["resume", new Job({
        "runs-on": "ubuntu-latest",
        container: { image },
        permissions: { contents: "write", statuses: "write", "pull-requests": "write", ...(needsToken ? { "id-token": "write" } : {}) },
        ...openid(needsToken),
        concurrency: applyConcurrency(forge),
        env: { TG_TOKEN: "${{ github.token }}", ...headersEnv, ...notifyEnv, ...costEnv },
        steps: [
          ...steps(new Step({ name: "Apply a waiting wave once its approval stands", shell: "bash", run: resumeScript(binary, layers, forge, oidc, prInput) } as never), true, true, undefined, true),
          new Step({ name: "Keep the apply report", if: "always()", uses: forge === "forgejo" ? "actions/upload-artifact@v3" : "actions/upload-artifact@v4", with: { name: `${REPORT_DIR}-resume`, path: `${REPORT_DIR}/`, "if-no-files-found": "ignore" } }),
        ],
      } as never) as never],
    ]);
    extra.push({ path: RESUME_PATHS[forge], content: header(image, input.imageFromConfig) + text(serializer.serialize(resume)) });
  }
  if (rollouts) extra.push({ path: ROLLOUT_PATHS[forge], content: header(image, input.imageFromConfig) + text(serializer.serialize(rolloutWorkflow(forge, image, rollouts, jobEnv, tokenEnv, installStep ? { name: installName, run: installStep } : undefined))) });
  return { path: PIPELINE_PATHS[forge], content: header(image, input.imageFromConfig) + text(serializer.serialize(entities)), ...(extra.length ? { extra } : {}) };
}

/**
 * The rollout workflow (GitHub and Forgejo): on its schedule, or by hand,
 * `terragucci respond rollout --mode apply` from the default branch. It opens
 * pull requests and pushes their branches with `token_env`'s secret when the
 * config names one: GitHub starts no workflow for a pull request the job's own
 * token opens, so the wave would get no plan. Without it, the job's own token.
 */
function rolloutWorkflow(forge: Exclude<ForgeName, "gitlab">, image: string, cron: string, env: Record<string, string>, tokenEnv: string | undefined, install?: { name: string; run: string }): Map<string, never> {
  const token = tokenEnv ? `\${{ secrets.${tokenEnv} }}` : "${{ github.token }}";
  const workflow = new Workflow({
    name: "terragucci-rollout",
    on: { schedule: [{ cron }], workflow_dispatch: {} },
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
    env: { TG_TOKEN: token },
    steps: [
      new Step({ uses: "actions/checkout@v4", with: { "fetch-depth": 0, ...(tokenEnv ? { token } : {}) } }),
      ...(install ? [new Step(install)] : []),
      new Step({ name: "Open the next wave of each rollout whose last wave merged and applied", shell: "bash", run: rolloutScript(forge, tokenEnv) }),
    ],
  } as never);
  return new Map<string, never>([["workflow", workflow as never], ["rollout", rollout as never]]);
}
