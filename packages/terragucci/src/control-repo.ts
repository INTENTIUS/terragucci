/**
 * The control repo as the place cross-repo work runs from (terragucci#753).
 *
 * A member repo's pipeline, once its apply on the default branch succeeded,
 * sends one dispatch to the control repo: a repository_dispatch on GitHub, a
 * pipeline trigger on GitLab, a workflow dispatch on Forgejo. The control
 * repo's own pipeline then runs that member's dependents with
 * `chant workspace run --dependents-of <member> --op <op>`. The member holds
 * a token for that one call and no other access to the control repo.
 *
 * This file has both halves: the member's step (`dispatchScript`) and the
 * control repo's pipeline (`controlPipeline`).
 */
import { Job, Step, Workflow } from "@intentius/chant-lexicon-github/generated/index";
import { Image, Job as GitLabJob, Rule } from "@intentius/chant-lexicon-gitlab/generated/index";
import { gitlabSerializer } from "@intentius/chant-lexicon-gitlab/serializer";
import { CONTROL_NAME, CONTROL_READ_TOKEN_ENV, CONTROL_TOKEN_ENV, ConfigError, forgeFromHost, parseProjectKey, type ControlSettings, type ForgeName } from "./config";
import { MARKER, serializeWorkflow } from "./render";
import { CHECKOUT, SETUP_NODE } from "./action-pins";

/** The commit status that marks a commit whose apply the control repo was told about. */
export const CONTROL_STATUS = "terragucci/control";

/** The event type of the GitHub repository_dispatch a member sends. */
export const DISPATCH_EVENT = "terragucci-applied";

/** The control repo's pipeline files, one per forge, beside the repo's own. */
export const CONTROL_PATHS: Record<ForgeName, string> = {
  github: ".github/workflows/terragucci-dependents.yml",
  forgejo: ".forgejo/workflows/terragucci-dependents.yml",
  gitlab: ".gitlab/terragucci-dependents.yml",
};

/** The workflow file name a Forgejo dispatch addresses. */
const FORGEJO_WORKFLOW = "terragucci-dependents.yml";
/** The variables a GitLab trigger carries, and the inputs a Forgejo or GitHub manual dispatch takes. */
const MEMBER_VAR = "TERRAGUCCI_MEMBER";
const OP_VAR = "TERRAGUCCI_OP";
/** The branch a GitLab or Forgejo dispatch runs on when `control.ref` is unset. */
export const CONTROL_REF_DEFAULT = "main";
/** What the control repo's job installs and runs: the chant its own package.json pins. */
export const CONTROL_CHANT_FLOOR = "0.124.47";

/** `control` once the member's name and the control repo's forge are settled. */
export interface ResolvedControl {
  repo: string;
  host: string;
  path: string;
  forge: ForgeName;
  op: string;
  member: string;
  tokenEnv: string;
  readTokenEnv: string;
  ref: string;
}

/** `control` with its defaults filled in; `fallbackMember` is the repo's name, used when `control.member` is unset. */
export function resolveControl(control: ControlSettings, fallbackMember: string): ResolvedControl {
  const pk = parseProjectKey(control.repo);
  const forge = control.forge ?? forgeFromHost(pk.host);
  if (!forge) throw new ConfigError(`control.forge is needed: ${control.repo}'s host does not say which forge it is`);
  const member = control.member ?? fallbackMember;
  if (!CONTROL_NAME.test(member)) throw new ConfigError(`control.member: "${member}" is not a name the control repo's workspace can hold; set control.member`);
  return { repo: control.repo, host: pk.host, path: pk.path, forge, op: control.op, member, tokenEnv: control.token_env ?? CONTROL_TOKEN_ENV, readTokenEnv: control.read_token_env ?? CONTROL_READ_TOKEN_ENV, ref: control.ref ?? CONTROL_REF_DEFAULT };
}

/** Where a tf-plan job puts the control repo's checkout, in the job's workspace. */
export const CONTROL_CHECKOUT_DIR = ".terragucci-control";

/** The plan job's variable that tells estate ownership where the control repo's records are (estate-ownership.ts). */
export function controlDirEnv(forge: ForgeName): Record<string, string> {
  return { TERRAGUCCI_CONTROL_DIR: forge === "gitlab" ? `$CI_PROJECT_DIR/${CONTROL_CHECKOUT_DIR}` : `\${{ github.workspace }}/${CONTROL_CHECKOUT_DIR}` };
}

/** GitHub and Forgejo: the step that checks the control repo out, read-only, with the read secret when it is set and the job's token when not. */
export function controlCheckoutStep(c: ResolvedControl, cond?: string): InstanceType<typeof Step> {
  return new Step({
    ...(cond ? { if: cond } : {}),
    name: `Check out the control repo ${c.repo}, read-only, for estate ownership`,
    uses: CHECKOUT,
    with: { repository: c.path, token: `\${{ secrets.${c.readTokenEnv} || github.token }}`, path: CONTROL_CHECKOUT_DIR, "persist-credentials": false, "fetch-depth": 1 },
  } as never);
}

/** GitLab: the lines that clone the control repo, read-only, with the read variable when it is set and the job token when not. */
export function controlCloneScript(c: ResolvedControl): string {
  const url = `${c.host}/${c.path}.git`;
  return [
    `rm -rf ${CONTROL_CHECKOUT_DIR}`,
    `git clone --quiet --depth 1 "https://oauth2:\${${c.readTokenEnv}:-\${CI_JOB_TOKEN:-}}@${url}" ${CONTROL_CHECKOUT_DIR} || { echo "terragucci: could not read the control repo ${c.repo}" >&2; exit 1; }`,
    `git -C ${CONTROL_CHECKOUT_DIR} remote set-url origin "https://${url}"`,
  ].join("\n");
}

/** A value that passed CONTROL_NAME is safe in a single-quoted shell word and a JSON string; this keeps it so. */
function quoted(v: string): string {
  if (!CONTROL_NAME.test(v)) throw new Error(`not a safe name: ${v}`);
  return `'${v}'`;
}

/**
 * The member's step: one request to the control repo's forge, with the
 * member's name, the Op and the commit that applied. The token is read from
 * `$TG_CONTROL_TOKEN` (the job maps the secret into it) and goes in a header,
 * never on a command line or into the log. A status other than success fails
 * the step, with the status and the forge's answer.
 */
export function dispatchScript(c: ResolvedControl, memberForge?: ForgeName): string {
  const member = quoted(c.member);
  const op = quoted(c.op);
  // The sha may come from another job's output: it is data, and only a commit sha goes into the request.
  const common = [
    "set -u",
    `member=${member}`,
    `op=${op}`,
    'sha="${TG_SHA:-}"',
    'case "$sha" in ""|*[!0-9a-f]*) echo "terragucci: the dispatch names no commit sha, so ' + c.repo + ' was not told" >&2; exit 1 ;; esac',
    // Three paths can complete an apply of a commit (the push's last wave, a resume, a comment): the first to tell the control repo marks the commit, the others find the mark.
    ...(memberForge && memberForge !== "gitlab"
      ? [
          `export TG_FORGE=${memberForge}`,
          `if [ "$(terragucci post sent ${CONTROL_STATUS} 2>/dev/null)" = 1 ]; then echo "terragucci: ${c.repo} was told about \${sha:0:8} already"; exit 0; fi`,
        ]
      : []),
  ];
  const mark = memberForge && memberForge !== "gitlab" ? `; terragucci post status ${CONTROL_STATUS} success "told ${c.repo} that $member applied"` : "";
  const api = (url: string, args: string[]): string[] => [
    `url=${url}`,
    'body="$(mktemp)"',
    `code="$(curl -sS -o "$body" -w '%{http_code}' -X POST ${args.join(" ")} "$url")" || { echo "terragucci: the dispatch to ${c.repo} could not be sent" >&2; exit 1; }`,
    `case "$code" in 2??) echo "terragucci: told ${c.repo} that $member applied (HTTP $code)"${mark} ;; *) echo "terragucci: ${c.repo} refused the dispatch (HTTP $code): $(head -c 400 "$body")" >&2; exit 1 ;; esac`,
  ];
  if (c.forge === "github") {
    const base = c.host === "github.com" ? "https://api.github.com" : `https://${c.host}/api/v3`;
    return [
      ...common,
      ...api(`'${base}/repos/${c.path}/dispatches'`, [
        `-H "Authorization: Bearer $TG_CONTROL_TOKEN"`,
        `-H 'Accept: application/vnd.github+json'`,
        `-H 'Content-Type: application/json'`,
        `-d "{\\"event_type\\":\\"${DISPATCH_EVENT}\\",\\"client_payload\\":{\\"member\\":\\"$member\\",\\"op\\":\\"$op\\",\\"sha\\":\\"$sha\\"}}"`,
      ]),
    ].join("\n");
  }
  if (c.forge === "gitlab") {
    const project = encodeURIComponent(c.path);
    return [
      ...common,
      ...api(`'https://${c.host}/api/v4/projects/${project}/trigger/pipeline'`, [
        `--form "token=$TG_CONTROL_TOKEN"`,
        `--form 'ref=${c.ref}'`,
        `--form "variables[${MEMBER_VAR}]=$member"`,
        `--form "variables[${OP_VAR}]=$op"`,
        `--form "variables[TERRAGUCCI_SHA]=$sha"`,
      ]),
    ].join("\n");
  }
  return [
    ...common,
    ...api(`'https://${c.host}/api/v1/repos/${c.path}/actions/workflows/${FORGEJO_WORKFLOW}/dispatches'`, [
      `-H "Authorization: token $TG_CONTROL_TOKEN"`,
      `-H 'Content-Type: application/json'`,
      `-d "{\\"ref\\":\\"${c.ref}\\",\\"inputs\\":{\\"member\\":\\"$member\\",\\"op\\":\\"$op\\"}}"`,
    ]),
  ].join("\n");
}

/**
 * The control repo's step: runs the member's dependents. The member and the Op
 * arrive in the environment (a dispatch's payload is data, never part of the
 * script) and are checked against the same pattern the member's config used
 * before they reach a command line.
 */
export function dependentsScript(): string {
  return [
    "set -eu",
    `member="\${${MEMBER_VAR}:-}"`,
    `op="\${${OP_VAR}:-}"`,
    `re='${CONTROL_NAME.source}'`,
    '[[ $member =~ $re && $op =~ $re ]] || { echo "terragucci: the dispatch names no usable member and Op (member=\\"$member\\", op=\\"$op\\")" >&2; exit 2; }',
    "npm ci",
    'npx --no-install chant workspace run --dependents-of "$member" --op "$op" --json',
  ].join("\n");
}

/** What the control repo's pipeline is for, as its file's header says. */
const header = (): string => [
  MARKER,
  "# A member repo's pipeline sends a dispatch here after its apply succeeds; this",
  "# runs that member's dependents with `chant workspace run --dependents-of`.",
  "# Run `npx terragucci control init` to rewrite it rather than editing it here.",
  "",
].join("\n");

export interface ControlPipeline {
  path: string;
  content: string;
  /** What a person still sets up on the forge. */
  notes: string[];
}

/** The control repo's pipeline for `forge`. */
export function controlPipeline(forge: ForgeName): ControlPipeline {
  const script = dependentsScript();
  if (forge === "gitlab") {
    const job = new GitLabJob({
      stage: "deploy",
      image: new Image({ name: "node:22" }),
      rules: [new Rule({ if: `$CI_PIPELINE_SOURCE == "trigger" && $${MEMBER_VAR} && $${OP_VAR}` })],
      // One member at a time: two applies upstream should not run the same dependents side by side.
      resource_group: "terragucci-dependents-$" + MEMBER_VAR,
      script: [`bash <<'DEPENDENTS' || exit $?\n${script}\nDEPENDENTS`],
    } as never);
    const out = gitlabSerializer.serialize(new Map([["dependents", job as never]]));
    return {
      path: CONTROL_PATHS.gitlab,
      content: header() + (typeof out === "string" ? out : out.primary),
      notes: [`add \`- local: ${CONTROL_PATHS.gitlab}\` to the include list of .gitlab-ci.yml, and create a pipeline trigger token under Settings > CI/CD > Pipeline trigger tokens for each member's ${CONTROL_TOKEN_ENV}`],
    };
  }
  const member = "${{ github.event.client_payload.member || inputs.member }}";
  const op = "${{ github.event.client_payload.op || inputs.op }}";
  const workflow = new Workflow({
    name: "terragucci dependents",
    on: {
      ...(forge === "github" ? { repository_dispatch: { types: [DISPATCH_EVENT] } } : {}),
      workflow_dispatch: {
        inputs: {
          member: { description: "The member whose dependents run", required: true, type: "string" },
          op: { description: "The Op to run on them", required: true, type: "string" },
        },
      },
    },
    permissions: { contents: "read" },
    // One run per member at a time, and none cancelled: a later apply of the same member waits for the one running.
    concurrency: { group: `terragucci-dependents-${member}`, "cancel-in-progress": false },
  } as never);
  const job = new Job({
    "runs-on": "ubuntu-latest",
    steps: [
      new Step({ uses: CHECKOUT }),
      new Step({ uses: SETUP_NODE, with: { "node-version": "22", cache: "npm" } }),
      new Step({ name: "Run the dependents of the member that applied", shell: "bash", env: { [MEMBER_VAR]: member, [OP_VAR]: op }, run: script }),
    ],
  } as never);
  const jobs = new Map<string, never>([["workflow", workflow as never], ["dependents", job as never]]);
  const notes = [
    `the repo's package.json must pin @intentius/chant at ${CONTROL_CHANT_FLOOR} or later, which has \`chant workspace run --dependents-of\``,
    forge === "github"
      ? `give each member a ${CONTROL_TOKEN_ENV} secret: a token that may send a repository_dispatch to this repo and do nothing else`
      : `give each member a ${CONTROL_TOKEN_ENV} secret: a token that may dispatch workflows in this repo and do nothing else`,
  ];
  return { path: CONTROL_PATHS[forge], content: header() + serializeWorkflow(forge, jobs), notes };
}
