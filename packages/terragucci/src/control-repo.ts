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
 * the product plan's `controlRead` (./product-plan.ts). On GitLab chant's trigger names the
 * variables CHANT_CONTROL_MEMBER, CHANT_CONTROL_OP and CHANT_CONTROL_SHA.
 */
import * as chant from "@intentius/chant/ci-control";
import { generateControlPipeline as githubControlPipeline } from "@intentius/chant-lexicon-github/components/control-pipeline";
import { generateControlPipeline as gitlabControlPipeline } from "@intentius/chant-lexicon-gitlab/components/control-pipeline";
import { generateControlPipeline as forgejoControlPipeline } from "@intentius/chant-lexicon-forgejo/components/control-pipeline";
import { CONTROL_NAME, CONTROL_READ_TOKEN_ENV, CONTROL_TOKEN_ENV, ConfigError, forgeFromHost, parseProjectKey, type ControlSettings, type ForgeName } from "./config";
import { MARKER } from "./render";
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
