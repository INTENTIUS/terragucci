/**
 * `runtime: prow`: the stages as Prow jobs (./prow-config.ts), written as
 * one Prow job config file in place of a workflow. Prow's job config is
 * data: `presubmits`, `postsubmits` and `periodics` keyed by the
 * repository, each job a pod spec Prow runs on a build cluster.
 *
 * terragucci-check  presubmit on `prow.cluster`, every pull request against
 *        the default branch: format check, validate, the source allowlist
 *        and the policy tests, the same script as the forge's check job. It
 *        holds no credential and mounts no service account token, so it is
 *        the job a fork's pull request runs once Prow's `/ok-to-test` lets
 *        it.
 * terragucci-plan  presubmit on `prow.trusted_cluster`, only with
 *        `prow.plan_before_merge`: plans a pull request from this repository
 *        with the plan service account and posts the plan note and
 *        terragucci/plan. A fork's pull request is skipped before any of its
 *        code runs. `/terragucci plan` (or `/test terragucci-plan`) runs it
 *        again; Prow hands a job no comment text, so it plans every root.
 * terragucci-plan  postsubmit on the default branch, on the trusted
 *        cluster with the plan service account: the merged commit's plan
 *        against its first parent, kept in the job's artifacts.
 * terragucci-apply  postsubmit on the default branch, on the trusted
 *        cluster with the apply service account: every wave in order in the
 *        one pod (`terragucci run wave`, as each forge wave job runs it),
 *        each wave reading the earlier waves' outcomes from the pod's disk,
 *        and terragucci/apply posted after each. At most one runs at a time.
 *        A wave the gate holds stops the job; once its plans are approved,
 *        rerun the job from Deck.
 * terragucci-drift  periodic on the trusted cluster with the plan service
 *        account, on `drift:`'s cron: tf-drift, which keeps the drift issue.
 *
 * Every job runs the terragucci image. Its first lines give the pod the
 * variables a GitHub job has (GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF and
 * the rest) from Prow's own (REPO_OWNER, PULL_BASE_SHA, PULL_PULL_SHA,
 * PULL_NUMBER), so the stages, chant's wave runner and the GitHub API calls
 * read the job as they read a GitHub one. Prow's decoration clones the
 * repository with its history and keeps `$ARTIFACTS`, where each job copies
 * its report. Its checkout has no remote, so each job adds `origin`
 * (ORIGIN_LINES), and the jobs that hold the token let git use it there
 * (ORIGIN_CREDENTIAL): the apply job reads and pushes chant/lifecycle.
 *
 * The jobs are plain Prow job data, and chant's prow lexicon writes the file:
 * `forgeJobConfig` keys the presubmits and postsubmits by the repository's
 * owner/name on GitHub and puts the header above them as comment lines.
 */
import { defaultForgeOf } from "@intentius/chant/ci-system";
import { forgeJobConfig } from "@intentius/chant-lexicon-prow/forge-jobs";
import { WAVES_SPEC } from "./chant-waves";
import type { Binary } from "./config";
import { PROW_CI, PROW_JOBS_PATH, PROW_TOKEN_KEY, type ProwSettings } from "./prow-config";
import { checkScript, driftScript, installScript, MARKER, planVerbScript, REPORT_DIR, type PipelineApplyJob, type PlanReportInput } from "./render";
// After ./render, which ./product-plan imports in turn.
import { PLAN_ENV, PLAN_NAMES, githubPlanJobs } from "./product-plan";
import { APPLY_STATUS } from "./render-waves";

/** The jobs' names, as Prow's contexts on the pull request and Deck show them. */
export const PROW_JOBS = {
  check: "terragucci-check",
  plan: "terragucci-plan",
  apply: "terragucci-apply",
  drift: "terragucci-drift",
} as const;

/** The comment that runs the plan presubmit again, beside Prow's own `/test terragucci-plan`. */
export const PROW_REPLAN = "/terragucci plan";

/** The variable Prow's decoration names the job's artifacts directory with. */
const ARTIFACTS = "ARTIFACTS";

/** Where a pod reads the GitHub token from: the Secret's key, as an environment variable. */
const TOKEN_VAR = "GITHUB_TOKEN";

export interface ProwJobsInput {
  /** owner/name on GitHub. */
  repo: string;
  defaultBranch: string;
  prow: ProwSettings;
  binary: Binary;
  image: string;
  layers: string[][];
  /** The pinned version the image does not carry: the jobs install it. */
  install?: { binary: Binary; version: string };
  env: Record<string, string>;
  /** The spec of the waves, which init writes beside the job config. */
  wavesSpec?: string;
  /** checkScript's flags. */
  check: { rootPins?: boolean; generate?: boolean; sources?: boolean; mirror?: boolean; parallelism?: number; synth?: string };
  report: PlanReportInput;
  drift?: string;
  /** The environment `plan-handoff` and `pr-post` name (./product-plan.ts `planEnv`); unset, `default`. */
  planEnv?: string;
}

export interface RenderedProwJobs {
  path: string;
  content: string;
  extra: { path: string; content: string }[];
  applyJobs: PipelineApplyJob[];
  notes: string[];
}

const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * clonerefs makes the checkout with `git init` and fetches by URL, so it has
 * no remote. The wave gate reads chant/lifecycle from origin and the waves
 * push their records there, as in a forge's checkout, so the job names
 * origin itself: the repository on the GitHub the jobs talk to.
 */
export const ORIGIN_LINES = ['git remote get-url origin >/dev/null 2>&1 || git remote add origin "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY.git"'];

/**
 * How git authenticates to origin in a job that holds the token: a
 * credential helper that answers with GITHUB_TOKEN as it is when git asks.
 * Nothing is written to the checkout or the disk, and a shell that has
 * dropped the token (the plan, which runs the change's code) gives git none.
 */
export const ORIGIN_CREDENTIAL = `git config --global "credential.$GITHUB_SERVER_URL.helper" '!f() { test "$1" = get && test -n "\${${TOKEN_VAR}:-}" && printf "username=x-access-token\\npassword=%s\\n" "$${TOKEN_VAR}"; }; f'`;

/** The pod's first lines: GitHub's variables from Prow's, for a job of `type`. `token`: the job holds the GitHub token, which git may use with origin. */
export function prowPrelude(type: "presubmit" | "postsubmit" | "periodic", repo: string, prow: ProwSettings, defaultBranch: string, token = true): string[] {
  const lines = [
    "set -eu",
    'git config --global --add safe.directory "$PWD" 2>/dev/null || true',
    // The stages and chant read a GitHub job's variables; a ProwJob's pod gets the same from Prow's.
    `export GITHUB_ACTIONS=true GITHUB_SERVER_URL="\${GITHUB_SERVER_URL:-https://github.com}" GITHUB_API_URL="\${GITHUB_API_URL:-https://api.github.com}" GITHUB_REPOSITORY=${sq(repo)}`,
    'export GITHUB_SHA="$(git rev-parse HEAD)" TF_IN_AUTOMATION=1 TF_INPUT=0',
    ...ORIGIN_LINES,
    ...(token ? [ORIGIN_CREDENTIAL] : []),
  ];
  if (type === "presubmit") {
    lines.push(
      'export GITHUB_EVENT_NAME=pull_request GITHUB_REF="refs/pull/${PULL_NUMBER}/merge" GITHUB_BASE_REF="$PULL_BASE_REF"',
      'export TG_PR="$PULL_NUMBER" TG_SHA="$PULL_PULL_SHA" TG_BASE="$PULL_BASE_SHA" TG_BRANCH="$PULL_BASE_REF"',
    );
  } else {
    // A periodic has no Prow refs of its own: it runs on the default branch, which its extra_refs check out.
    const ref = type === "postsubmit" ? '"$PULL_BASE_REF"' : sq(defaultBranch);
    lines.push(
      `export GITHUB_EVENT_NAME=${type === "postsubmit" ? "push" : "schedule"} GITHUB_REF_NAME=${ref}`,
      'export GITHUB_REF="refs/heads/$GITHUB_REF_NAME" TG_BRANCH="$GITHUB_REF_NAME"',
    );
  }
  if (prow.deck) lines.push(`export TG_JOB_URL=${sq(`${prow.deck.replace(/\/+$/, "")}/prowjob?prowjob=`)}"\${PROW_JOB_ID:-}"`);
  // What the job wrote goes to Prow's artifacts, which Deck links, however the job ends.
  lines.push(`tg_keep() { [ -z "\${${ARTIFACTS}:-}" ] || for d in ${REPORT_DIR} terragucci-check .chant/op-waves; do [ ! -d "$d" ] || cp -R "$d" "$${ARTIFACTS}/" 2>/dev/null || true; done; }`, "trap tg_keep EXIT");
  return lines;
}

/**
 * A fork's pull request does not plan with credentials: before any of its
 * code runs, the plan presubmit asks GitHub where the head lives, and a
 * head outside this repository ends the job, which passes.
 */
export const FORK_GUARD = [
  "(cd / && node -e 'const api=String(process.env.GITHUB_API_URL).replace(/\\/+$/,\"\"),repo=process.env.GITHUB_REPOSITORY;fetch(api+\"/repos/\"+repo+\"/pulls/\"+process.env.PULL_NUMBER,{headers:{authorization:\"Bearer \"+process.env.GITHUB_TOKEN,accept:\"application/vnd.github+json\"}}).then((r)=>r.ok?r.json():Promise.reject(new Error(\"GitHub answered \"+r.status+\" to the pull request\"))).then((p)=>process.exit(p&&p.head&&p.head.repo&&p.head.repo.full_name===repo?0:3),(e)=>{console.error(\"terragucci: \"+e.message);process.exit(1)})') || tg_fork=$?",
  'if [ "${tg_fork:-0}" -eq 3 ]; then echo "terragucci: pull request $PULL_NUMBER is from a fork, so it is not planned before merge; terragucci-check covers it, and it plans and applies after it merges"; exit 0; fi',
  '[ "${tg_fork:-0}" -eq 0 ] || exit 1',
];

/** The drift stage keeps the drift issue with TG_TOKEN, as the forge pipelines' drift jobs set it; the periodic's token is GITHUB_TOKEN. */
export const DRIFT_TOKEN = `export TG_TOKEN="\${TG_TOKEN:-\${${TOKEN_VAR}:-}}"`;

/** A forge job's report link, which the stages' scripts carry; a ProwJob's is Deck's, or none. */
const forgeRunLink = '"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"';
const onProw = (script: string): string => script.split(forgeRunLink).join('"${TG_JOB_URL:-}"');

/** The plan note step's words, as chant's plan-note job carries them on GitHub (./product-plan.ts). */
function noteEnv(image: string): Record<string, string> {
  const jobs = githubPlanJobs({ forge: "github", image, command: "true", env: {}, setup: [], others: [] });
  const note = jobs.find(([n]) => n === PLAN_NAMES.jobNames.note)?.[1] as { steps?: { env?: Record<string, string> }[] } | undefined;
  const post = note?.steps?.find((s) => s.env?.CHANT_PLAN_NOTE_WORDS !== undefined);
  const out: Record<string, string> = {};
  if (post?.env?.CHANT_PLAN_NOTE_WORDS !== undefined) out.CHANT_PLAN_NOTE_WORDS = post.env.CHANT_PLAN_NOTE_WORDS;
  return out;
}

/** The container of a job: the image, bash running `script`, the variables, and on the trusted cluster the token from its Secret. */
function container(image: string, script: string, env: Record<string, string>, token?: { name: string; key: string }): Record<string, unknown> {
  const vars = [
    ...Object.entries(env).map(([name, value]) => ({ name, value })),
    ...(token ? [{ name: TOKEN_VAR, valueFrom: { secretKeyRef: { name: token.name, key: token.key } } }] : []),
  ];
  return { name: "terragucci", image, command: ["bash", "-c"], args: [script], ...(vars.length ? { env: vars } : {}) };
}

const exportEnv = (env: Record<string, string>): string[] => (Object.keys(env).length ? [`export ${Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`).join(" ")}`] : []);

export function renderProwJobs(input: ProwJobsInput): RenderedProwJobs {
  const { prow, repo, image, binary, layers } = input;
  const [org, name] = repo.split("/") as [string, string];
  const branches = [`^${input.defaultBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`];
  const roots = layers.flat();
  const token = { name: prow.token_secret.name, key: prow.token_secret.key ?? PROW_TOKEN_KEY };
  const trusted = { cluster: prow.trusted_cluster, ...(prow.namespace ? { namespace: prow.namespace } : {}) };
  const untrusted = { cluster: prow.cluster ?? "default", ...(prow.namespace ? { namespace: prow.namespace } : {}) };
  const install = input.install ? [installScript(input.install.binary, input.install.version, "github", true)] : [];
  const layerArg = layers.map((l) => l.join(",")).join(";");
  const planEnvName = input.planEnv ?? PLAN_ENV;

  // ── checks, before merge, no credential ───────────────────────────────────
  const c = input.check;
  const check = [
    ...prowPrelude("presubmit", repo, prow, input.defaultBranch, false),
    ...install,
    "(",
    checkScript(binary, roots, c.synth, c.rootPins === true, c.generate === true, false, c.sources === true, c.mirror === true, c.parallelism),
    ")",
  ].join("\n");
  const presubmits: Record<string, unknown>[] = [
    {
      name: PROW_JOBS.check,
      ...untrusted,
      always_run: true,
      decorate: true,
      branches,
      annotations: { description: "terragucci: format check, validate, the source allowlist and the policy tests of every root. No credential; a fork's pull request runs it after /ok-to-test." },
      spec: { automountServiceAccountToken: false, containers: [container(image, check, input.env)] },
    },
  ];

  // ── the plan before merge, on the trusted cluster ─────────────────────────
  const plan = (when: "presubmit" | "postsubmit"): string => {
    const lines = [
      ...prowPrelude(when, repo, prow, input.defaultBranch),
      ...(when === "presubmit" ? FORK_GUARD : ['export BASE_SHA="$(git rev-parse -q --verify HEAD^ || true)"']),
      ...install,
      // The plan runs the change's code: it runs in a shell without the token.
      "(",
      `unset ${TOKEN_VAR} TG_TOKEN`,
      onProw(planVerbScript(binary, layers, "github", input.report, { env: planEnvName })),
      ") && tg_rc=0 || tg_rc=$?",
    ];
    if (when === "presubmit") {
      lines.push(
        ...exportEnv(noteEnv(image)),
        'export CHANT_PLAN_NOTE_NOTICES="$(mktemp)"',
        `TG_TOKEN="$${TOKEN_VAR}" terragucci plan-note --forge github --report ${REPORT_DIR} --notices "$CHANT_PLAN_NOTE_NOTICES" || true`,
        `terragucci components pr-post --pr "$PULL_NUMBER" --head "$PULL_PULL_SHA" --env ${planEnvName} --output ${REPORT_DIR} --forge github --result "$([ "$tg_rc" -eq 0 ] && echo success || echo failure)" --context ${PLAN_NAMES.statusContext}`,
      );
    } else if (prow.plan_before_merge) {
      lines.push(`terragucci components pr-post --stale --tip "$GITHUB_SHA" --env ${planEnvName} --forge github --context ${PLAN_NAMES.statusContext} --preview-comment || true`);
    }
    lines.push('exit "$tg_rc"');
    return lines.join("\n");
  };
  if (prow.plan_before_merge) {
    presubmits.push({
      name: PROW_JOBS.plan,
      ...trusted,
      always_run: true,
      decorate: true,
      branches,
      trigger: `(?m)^/(test (all|${PROW_JOBS.plan})|terragucci plan)( .*)?$`,
      rerun_command: PROW_REPLAN,
      annotations: { description: "terragucci: plans a pull request from this repository with the plan service account and posts the plan note. A fork's pull request is not planned before merge." },
      spec: { serviceAccountName: prow.service_accounts.plan, containers: [container(image, plan("presubmit"), input.env, token)] },
    });
  }

  // ── after merge: the plan, and the waves in order ──────────────────────────
  const count = layers.length;
  const waves: string[] = [];
  for (let k = 1; k <= count; k++) {
    waves.push(
      `terragucci run wave --spec ${WAVES_SPEC} --wave ${k} --render-spec || { rc=$?; [ "$tg_rc" -ne 0 ] || tg_rc=$rc; }`,
      `[ -z "\${${ARTIFACTS}:-}" ] || { mkdir -p "$${ARTIFACTS}/wave-${k}"; [ ! -d ${REPORT_DIR} ] || cp -R ${REPORT_DIR}/. "$${ARTIFACTS}/wave-${k}/"; }`,
      `terragucci run wave --op tf-apply --wave ${k} --of ${count} --apply-status ${APPLY_STATUS} --at "$GITHUB_SHA" --forge github || true`,
    );
  }
  const apply = [
    ...prowPrelude("postsubmit", repo, prow, input.defaultBranch),
    ...install,
    // No --own-run-jobs here: the forges name the wave jobs of the run their release cut counts, and prow runs every wave in this one pod, with no sibling jobs of the run to name.
    // chant's wave runner, as a forge wave job sets it up: the spec rendered at the commit, the branch it applies on.
    `export CHANT_LOCK_WAIT=10500 CHANT_WAVES_SPEC_COMMAND='["terragucci","waves-spec"]' CHANT_WAVES_SPEC_RUNS=head CHANT_DEFAULT_BRANCH="$GITHUB_REF_NAME"`,
    // Each wave reads the earlier waves' outcomes from this pod's disk, and stands down when one did not apply.
    "tg_rc=0",
    ...waves,
    'exit "$tg_rc"',
  ].join("\n");
  const postsubmits = [
    {
      name: PROW_JOBS.plan,
      ...trusted,
      decorate: true,
      branches,
      annotations: { description: "terragucci: the merged commit's plan against its first parent, with the plan service account, kept in the job's artifacts." },
      spec: { serviceAccountName: prow.service_accounts.plan, containers: [container(image, plan("postsubmit"), input.env, token)] },
    },
    {
      name: PROW_JOBS.apply,
      ...trusted,
      decorate: true,
      decoration_config: { timeout: "3h" },
      max_concurrency: 1,
      branches,
      annotations: { description: `terragucci: applies the ${count === 1 ? "wave" : `${count} waves in order`} with the apply service account, each behind its gate. Rerun it from Deck once a held wave is approved.` },
      spec: { serviceAccountName: prow.service_accounts.apply, containers: [container(image, apply, input.env, token)] },
    },
  ];

  // ── drift, on a schedule ──────────────────────────────────────────────────
  const periodics = input.drift
    ? [
        {
          name: PROW_JOBS.drift,
          ...trusted,
          cron: input.drift,
          decorate: true,
          extra_refs: [{ org, repo: name, base_ref: input.defaultBranch, workdir: true }],
          annotations: { description: "terragucci: plans every root with -refresh-only and keeps the drift issue. It never applies." },
          spec: {
            serviceAccountName: prow.service_accounts.plan,
            containers: [container(image, [...prowPrelude("periodic", repo, prow, input.defaultBranch), ...install, DRIFT_TOKEN, onProw(driftScript(binary, layers, "github", undefined, input.report))].join("\n"), input.env, token)],
          },
        },
      ]
    : [];

  const where = prow.config_repo && prow.config_repo !== repo
    ? `# Prow reads its job config from ${prow.config_repo}: copy this file into that repository's job config,\n# and copy it again each time terragucci init writes it.`
    : "# Add this file to your Prow installation's job config (its job_config_path).";
  const header = [
    MARKER,
    "# terragucci writes this file from terragucci.yml (runtime: prow). Change terragucci.yml",
    "# and run `npx terragucci init` rather than editing it here.",
    where,
    `# The plan, apply and drift jobs run on ${prow.trusted_cluster} as the service accounts ${prow.service_accounts.plan} (plan, drift)`,
    `# and ${prow.service_accounts.apply} (apply), and read the GitHub token from the Secret ${token.name}.`,
  ].join("\n");
  const path = prow.path ?? PROW_JOBS_PATH;
  const notes = [
    prow.config_repo && prow.config_repo !== repo
      ? `runtime: prow: ${path} holds the jobs; Prow reads job config from ${prow.config_repo}, so copy it there under the job config directory, and copy it again whenever init writes it`
      : `runtime: prow: ${path} holds the jobs; add it to your Prow installation's job config`,
    `runtime: prow: on ${prow.trusted_cluster}, bind ${prow.service_accounts.plan} to a read-only cloud identity and ${prow.service_accounts.apply} to a write one (Workload Identity, IRSA or Pod Identity), and create the Secret ${token.name} with a GitHub token under the key ${token.key}; terragucci config identities lists them`,
    prow.plan_before_merge
      ? `runtime: prow: ${PROW_JOBS.plan} plans pull requests from this repository on ${prow.trusted_cluster} before merge; a fork's pull request runs ${PROW_JOBS.check} after /ok-to-test and plans after it merges`
      : `runtime: prow: before merge only ${PROW_JOBS.check} runs, with no credential, and the plan and the apply run after the merge; a wave the gate holds waits for terragucci approve of its plans, then rerun ${PROW_JOBS.apply} from Deck`,
  ];
  return {
    path,
    content: forgeJobConfig({ forge: defaultForgeOf(PROW_CI), repo }, { presubmits, postsubmits, periodics }, { header }),
    extra: input.wavesSpec ? [{ path: WAVES_SPEC, content: input.wavesSpec }] : [],
    applyJobs: [{ name: PROW_JOBS.apply, needs: [], applies: roots }],
    notes,
  };
}
