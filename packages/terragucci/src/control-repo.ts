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
 * chant core holds the control repo (chant#4568): the member's step is
 * chant's `controlDispatchScript` with terragucci's words, its token piped to
 * curl on stdin rather than put in curl's arguments; the control repo's
 * pipeline is the forge lexicon's `generateControlPipeline`
 * (`chantControlPipelineFile`); and the plan job reads the control repo's
 * `chant/lifecycle`, where its entries live (./control-records.ts), with
 * chant's `controlNoteCheckout`. On GitLab chant's trigger names the
 * variables CHANT_CONTROL_MEMBER, CHANT_CONTROL_OP and CHANT_CONTROL_SHA.
 */
import { Step } from "@intentius/chant-lexicon-github/generated/index";
import * as chant from "@intentius/chant/ci-control";
import { generateControlPipeline as githubControlPipeline } from "@intentius/chant-lexicon-github/components/control-pipeline";
import { generateControlPipeline as gitlabControlPipeline } from "@intentius/chant-lexicon-gitlab/components/control-pipeline";
import { generateControlPipeline as forgejoControlPipeline } from "@intentius/chant-lexicon-forgejo/components/control-pipeline";
import { CONTROL_NAME, CONTROL_READ_TOKEN_ENV, CONTROL_TOKEN_ENV, ConfigError, forgeFromHost, parseProjectKey, type ControlSettings, type ForgeName } from "./config";
import { MARKER } from "./render";
import { CHECKOUT } from "./action-pins";
import type { ChantControlTarget } from "./chant-next";
import { TERRAGUCCI_WORDS } from "./ci-words";

/** The commit status that marks a commit whose apply the control repo was told about. */
export const CONTROL_STATUS = "terragucci/control";

/** The branch a GitLab or Forgejo dispatch runs on when `control.ref` is unset. */
export const CONTROL_REF_DEFAULT = "main";
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

/**
 * chant's read of the control repo (chant#4619): `controlNoteCheckout`
 * fetches the control repo's `chant/lifecycle` alone into a directory
 * outside the checkout and sets CHANT_CONTROL_DIR to it.
 */
export function chantNoteCheckout(c: ResolvedControl, memberForge: ForgeName): { stepName: string; env: Record<string, string>; script: string } {
  return chant.controlNoteCheckout(memberForge, chantControlTarget(c), TERRAGUCCI_WORDS);
}

/** Where chant's control entries are on the control repo's chant/lifecycle (./control-records.ts LEDGER_PATH). */
const ENTRIES_ON_LEDGER = 'git -C "$CHANT_CONTROL_DIR" cat-file -e "refs/heads/chant/lifecycle:_control/entries.jsonl" 2>/dev/null';

/**
 * GitHub and Forgejo: the plan job's read of the control repo: chant's
 * step, then a step that says whether the control repo's entries are on its
 * chant/lifecycle, and terragucci's checkout only when they are not, for a
 * control repo whose records are still files (it has not run `terragucci
 * control records migrate`). Estate ownership reads whichever one is there
 * (./estate-ownership.ts).
 */
export function controlReadSteps(c: ResolvedControl, memberForge: Exclude<ForgeName, "gitlab">, cond?: string): InstanceType<typeof Step>[] {
  const note = chantNoteCheckout(c, memberForge);
  const files = `${cond ? `(${cond}) && ` : ""}steps.control-store.outputs.files == '1'`;
  return [
    new Step({ ...(cond ? { if: cond } : {}), name: note.stepName, shell: "bash", env: note.env, run: note.script } as never),
    new Step({
      ...(cond ? { if: cond } : {}),
      id: "control-store",
      name: "Say whether the control repo's entries are on its chant/lifecycle",
      shell: "bash",
      run: `if [ -n "\${CHANT_CONTROL_DIR:-}" ] && ${ENTRIES_ON_LEDGER}; then echo "files=0"; else echo "files=1"; echo "terragucci: the control repo's entries are not on its chant/lifecycle, so its record files are read" >&2; fi >>"$GITHUB_OUTPUT"`,
    } as never),
    controlCheckoutStep(c, files),
  ];
}

/** GitLab: the lines that clone the control repo, read-only, with the read variable when it is set and the job token when not. */
export function controlCloneScript(c: ResolvedControl): string {
  // chant's read first; the clone only for a control repo whose entries are not on its chant/lifecycle.
  const note = chantNoteCheckout(c, "gitlab");
  return [note.script, `if [ -n "\${CHANT_CONTROL_DIR:-}" ] && ${ENTRIES_ON_LEDGER}; then`, `  echo "terragucci: read the control repo's entries from its chant/lifecycle"`, "else", ...recordsCloneScript(c).split("\n").map((l) => `  ${l}`), "fi"].join("\n");
}

/** terragucci's clone of a control repo whose records are still files, for GitLab. */
function recordsCloneScript(c: ResolvedControl): string {
  const url = `${c.host}/${c.path}.git`;
  return [
    `rm -rf ${CONTROL_CHECKOUT_DIR}`,
    `git clone --quiet --depth 1 "https://oauth2:\${${c.readTokenEnv}:-\${CI_JOB_TOKEN:-}}@${url}" ${CONTROL_CHECKOUT_DIR} || { echo "terragucci: could not read the control repo ${c.repo}" >&2; exit 1; }`,
    `git -C ${CONTROL_CHECKOUT_DIR} remote set-url origin "https://${url}"`,
  ].join("\n");
}

/**
 * The member's step, through chant (chant#4568): one request to the control
 * repo's forge, with the member's name, the Op and the commit that applied.
 * The job's variables stay terragucci's (TG_CONTROL_TOKEN, TG_SHA); the
 * script hands them to chant's names first. The mark that stops a second
 * send is terragucci's.
 */
export function dispatchScript(c: ResolvedControl, memberForge?: ForgeName): string {
  const target = chantControlTarget(c);
  const status = chant.controlStatusContext(TERRAGUCCI_WORDS);
  const marks = memberForge && memberForge !== "gitlab";
  return [
    'export CHANT_CONTROL_TOKEN="${TG_CONTROL_TOKEN:-}"',
    'export CHANT_CONTROL_SHA="${TG_SHA:-}"',
    ...(marks ? [`export TG_FORGE=${memberForge}`] : []),
    chant.controlDispatchScript(target, {
      words: TERRAGUCCI_WORDS,
      ...(marks ? { sentCheck: `terragucci post sent ${status}`, markSent: `terragucci post status ${status} success "told ${c.repo} that $member applied"` } : {}),
    }),
  ].join("\n");
}

/** terragucci's `control` settings as chant's control target (chant#4568): `token_env` is chant's `tokenSecret`, `read_token_env` its `readTokenSecret`. */
export function chantControlTarget(c: ResolvedControl): ChantControlTarget {
  return chant.resolveControlTarget({ repo: c.repo, forge: c.forge, op: c.op, member: c.member, tokenSecret: c.tokenEnv, readTokenSecret: c.readTokenEnv, ref: c.ref }, c.member);
}

export interface ControlPipeline {
  path: string;
  content: string;
  /** What a person still sets up on the forge. */
  notes: string[];
}

/**
 * The control repo's pipeline from the forge lexicon (chant#4568), in
 * terragucci's words. The file keeps terragucci's first line, which marks a
 * file terragucci wrote.
 */
export function chantControlPipelineFile(forge: ForgeName): ControlPipeline {
  const generate = forge === "github" ? githubControlPipeline : forge === "gitlab" ? gitlabControlPipeline : forgejoControlPipeline;
  const file = generate({ words: TERRAGUCCI_WORDS });
  return { path: file.path, content: file.content.startsWith(MARKER) ? file.content : `${MARKER}\n${file.content}`, notes: file.notes };
}
