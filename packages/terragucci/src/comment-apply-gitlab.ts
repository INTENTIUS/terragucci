/**
 * Apply before merge on GitLab (`apply.when: pull-request`).
 *
 * GitLab builds a merge request's pipeline from the merge request's own
 * files, so nothing in it may hold the apply role. The apply runs in a
 * pipeline of the default branch instead, which the comments job starts:
 *
 * 1. The comments job (comment-gitlab.ts), on the schedule, reads a
 *    Developer's `/terragucci apply [wave-<n>]`, `/terragucci lock` or
 *    `/terragucci unlock` note on an open merge request. For an apply it
 *    checks `apply.requires` first (openChecks, through chant's requires
 *    checks) and refuses by name. Then it
 *    starts a pipeline on the default branch (`POST /projects/:id/pipeline`)
 *    with the token in `apply.merge_token_env`, which may run pipelines
 *    there, and the variables TERRAGUCCI_MR, TERRAGUCCI_NOTE and
 *    TERRAGUCCI_HEAD.
 * 2. That pipeline's `mr-apply` job runs the default branch's pipeline file.
 *    Before any credential, `terragucci comment-apply --forge gitlab`
 *    (decideGitLabApply) reads the merge request and the note again from the
 *    API, since anyone who can start a pipeline on the default branch can set
 *    those variables: the note must be a command on that merge request by a
 *    Developer or above, and the head the variable names must be the merge
 *    request's head now. It checks every requirement again, takes the root
 *    locks on `chant/lifecycle` (locks.ts), and hands the job the head. The
 *    job applies the head's waves with the gate rule, the signers and the
 *    settings read from the default branch.
 * 3. With `apply.merge: auto`, the `pr-merge` job, which runs none of the
 *    merge request's code and takes no artifact from the job that did,
 *    merges it (mergeGitLabMR) once the mr-apply job replied that every wave
 *    applied.
 *
 * Whatever `apply.requires` says, `terragucci/plan` passed on the head, the
 * merge request leaves `.gitlab-ci.yml` and `.gitlab/terragucci.yml` alone,
 * and no other open merge request holds a lock on a root it reaches.
 */
import { terragucciStatus } from "./ci-words";
import { spawnSync } from "node:child_process";
import { applyWaves } from "./apply";
import { LOGIN, parseComment, parseOptions, SHA } from "./comment";
import { approverFilter, reached, type ApplyCommentDecision, type Git } from "./comment-apply";
import type { WavesAfter } from "./detect";
import type { PrApproverFilter, PrForge } from "@intentius/chant/pr-forge";
import { unmetApplyRequires } from "./apply-requires";
import { chantForgeReads } from "./chant-next";
import { ConfigError, type ApplyRequire } from "./config";
import { call as forgeCall, poster, type Fetch, type ForgeTarget } from "./forge";
import { describeHeld, releaseRootLocks, takeRootLocks } from "./root-locks";
import { agentSettingsAt, pullInvolvement } from "./involved";
import type { ForgeCalls } from "./review";

/** GitLab's Developer access level: the least that may ask for an apply. */
const DEVELOPER = 30;

/** The status the plan job posts on the head it planned. */
const PLAN_CONTEXT = (): string => terragucciStatus("plan");
/** The apply's own status, which never holds it back. */
const APPLY_CONTEXT = (): string => terragucciStatus("apply");

/** The files GitLab builds the default branch's pipeline from: a merge request that changes one applies after it merges. */
export const PIPELINE_FILES_ON_GITLAB = [".gitlab-ci.yml", ".gitlab/terragucci.yml"];

/** The variables the comments job starts the apply pipeline with. */
export const MR_VAR = "TERRAGUCCI_MR";
export const NOTE_VAR = "TERRAGUCCI_NOTE";
export const HEAD_VAR = "TERRAGUCCI_HEAD";

const short = (sha: string): string => sha.slice(0, 8);

/** A call to GitLab's API: a path from `/projects/...`, answered as JSON; a status other than 2xx throws. */
export type GitLabCall = (method: string, path: string, body?: unknown) => Promise<any>;

/** The API calls of the project the job runs in, with `token`. */
export function gitlabApi(env: NodeJS.ProcessEnv, token: string | undefined, doFetch: Fetch): GitLabCall {
  const api = env.CI_API_V4_URL;
  const project = env.CI_PROJECT_ID;
  if (!api || !project || !token) throw new ConfigError("GitLab's apply before merge needs CI_API_V4_URL, CI_PROJECT_ID and a token in the environment");
  const t: ForgeTarget = { forge: "gitlab", origin: env.CI_SERVER_URL ?? api, path: project, token, api };
  return (method, path, body) => forgeCall(doFetch, t, method, path, body) as Promise<any>;
}

/** review.ts's calls, over a GitLabCall. */
const reviewCalls = (api: GitLabCall, id: string): ForgeCalls => ({ repo: `projects/${id}`, get: (p) => api("GET", `/${p}`), post: (p, b) => api("POST", `/${p}`, b) });

/** Why an open merge request does not apply: a refusal to reply with, or a forge answer that broke the check. */
export type Verdict = { refuse: string } | { fail: string };

export interface OpenCheck {
  api: GitLabCall;
  /** The project id, encoded for a path. */
  id: string;
  /** The merge request as GitLab answered it. */
  mr: any;
  /** The default branch. */
  base: string;
  /** `apply.requires`. Default: every requirement. */
  requires?: readonly ApplyRequire[];
  wait?: (ms: number) => Promise<void>;
  /** chant's client the requires checks ask. Default: poster's, with the job's TG_TOKEN. */
  forge?: PrForge;
  /** The job's environment and fetch, for the users its tokens act as. */
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** `agent.login` and `agent.token_env` from the default branch's config (./involved.ts). */
  agentLogin?: string;
  agentTokenEnv?: string;
}

/**
 * What an open merge request needs before it applies, read from GitLab's
 * API alone: the comments job runs it before it starts the apply pipeline,
 * and the pipeline's job runs it again. Each requirement `requires` lists is
 * asked through chant's requires checks (./apply-requires.ts): `approved`,
 * an approval by a member other than its authors, given after the merge
 * request's latest push, and nobody's latest word a request for changes,
 * from someone with Developer or more; `checks`, every commit status on the
 * head passed; `mergeable`, GitLab says it can merge; `undiverged`, the head
 * contains the default branch. Always: `terragucci/plan` passed on the head,
 * and the merge request changes neither pipeline file.
 */
export async function openChecks(c: OpenCheck): Promise<Verdict | undefined> {
  const { api, id, base } = c;
  const iid: number = c.mr.iid;
  const sha: string = c.mr.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) return { fail: `!${iid}'s head is not a commit` };

  // approved counts Developer or more, and never the run's own token or someone who had a hand in the change (./involved.ts).
  // chant's check waits (pending) until GitLab records the latest push as a diff version.
  const approvers = async (): Promise<PrApproverFilter> => {
    const pr = { number: iid, head: sha, ...(typeof c.mr.author?.username === "string" ? { author: c.mr.author.username } : {}) };
    return approverFilter(await pullInvolvement({ forge: "gitlab", calls: reviewCalls(api, id), pr, env: c.env ?? {}, ...(c.fetch ? { fetch: c.fetch } : {}), ...(c.agentLogin ? { agentLogin: c.agentLogin } : {}), ...(c.agentTokenEnv ? { agentTokenEnv: c.agentTokenEnv } : {}) }));
  };
  const forge = c.forge ?? poster("gitlab", c.env ?? process.env, c.fetch);
  const unmet = await unmetApplyRequires(forge, iid, sha, { approvers, ignore: [APPLY_CONTEXT()], ...(c.requires ? { requires: c.requires } : {}), ...(c.wait ? { wait: c.wait } : {}) });
  if (unmet) return { refuse: `!${iid} does not meet apply.requires at ${short(sha)}, so nothing is applied: ${unmet}. Comment again once that is fixed and its plan passes` };

  const reads = chantForgeReads(forge);
  let plan: any;
  try {
    if (reads.commitStatuses) {
      // chant's forge client reads each context's newest status where the installed chant has the read (chant#4554).
      const st = (await reads.commitStatuses(sha)).find((s) => s.context === PLAN_CONTEXT());
      plan = st ? { status: st.state } : undefined;
    } else {
      const statuses: any = await api("GET", `/projects/${id}/repository/commits/${sha}/statuses?per_page=100`);
      for (const st of Array.isArray(statuses) ? statuses : []) {
        if (st?.name === PLAN_CONTEXT() && (!plan || Number(st.id) > Number(plan.id))) plan = st;
      }
    }
  } catch (e) {
    return { fail: `could not read the statuses of ${short(sha)} (${(e as Error).message})` };
  }
  if (plan?.status !== "success") {
    return { refuse: `the plan of !${iid} has not passed on its head ${short(sha)}, so nothing is applied; push to it or comment \`/terragucci plan\`, then comment again` };
  }

  let compare: any;
  try {
    compare = await api("GET", `/projects/${id}/repository/compare?from=${encodeURIComponent(base)}&to=${sha}&straight=false`);
  } catch (e) {
    return { fail: `could not compare ${short(sha)} with ${base} (${(e as Error).message})` };
  }
  const paths = (Array.isArray(compare?.diffs) ? compare.diffs : []).flatMap((d: any) => [d?.old_path, d?.new_path]);
  const touched = PIPELINE_FILES_ON_GITLAB.filter((f) => paths.includes(f));
  if (touched.length > 0) {
    return { refuse: `!${iid} changes ${touched.join(" and ")}, and the apply runs the pipeline of ${base}, so it is not applied before merge. Merge it; the push after the merge runs the pipeline it changes` };
  }
  return undefined;
}

export interface GitLabApplyOptions {
  layers: string[][];
  canary?: string[];
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  git?: Git;
  /** The job's checkout, where the root locks are read and pushed. Default: the working directory. */
  repo?: string;
  requires?: readonly ApplyRequire[];
  /** A Terragrunt repo: the locks are on the units a merge request reaches. */
  terragrunt?: boolean;
  /** `waves.after` of plain roots: a root it puts after a reached root is reached too. */
  after?: WavesAfter;
  /** A repo whose roots a command writes (`synth`): the locks are on every root a change can reach. */
  synth?: boolean;
  wait?: (ms: number) => Promise<void>;
}

/**
 * The `mr-apply` job's decision, before any credential: what the pipeline's
 * variables point at, read again from GitLab. Refusals are replied on the
 * merge request. `go` hands the job the head to apply.
 */
export async function decideGitLabApply(o: GitLabApplyOptions): Promise<ApplyCommentDecision> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const git: Git = o.git ?? ((args) => spawnSync("git", args, { encoding: "utf-8" }) as ReturnType<Git>);
  const repoDir = o.repo ?? process.cwd();
  const stop = (reason: string): ApplyCommentDecision => ({ go: false, reason });
  const broke = (reason: string): ApplyCommentDecision => ({ go: false, fail: true, reason });
  const base = env.CI_DEFAULT_BRANCH;
  const id = env.CI_PROJECT_ID ? encodeURIComponent(env.CI_PROJECT_ID) : "";
  const api = gitlabApi(env, env.TG_TOKEN, doFetch);
  const iidText = (env[MR_VAR] ?? "").trim();
  const noteText = (env[NOTE_VAR] ?? "").trim();
  const named = (env[HEAD_VAR] ?? "").trim();
  if (!/^[1-9][0-9]{0,9}$/.test(iidText) || !/^[1-9][0-9]{0,14}$/.test(noteText) || !SHA.test(named)) {
    return stop(`the pipeline names no merge request, note and head this command passes on (${MR_VAR}, ${NOTE_VAR}, ${HEAD_VAR}), so nothing runs`);
  }
  if (typeof base !== "string" || !base) return broke("comment-apply --forge gitlab needs CI_DEFAULT_BRANCH in the environment");
  const iid = Number(iidText);

  let mr: any;
  let note: any;
  try {
    mr = await api("GET", `/projects/${id}/merge_requests/${iid}`);
  } catch (e) {
    return broke(`could not read !${iid} (${(e as Error).message})`);
  }
  try {
    note = await api("GET", `/projects/${id}/merge_requests/${iid}/notes/${noteText}`);
  } catch (e) {
    if (/ answered 404/.test((e as Error).message)) return stop(`note ${noteText} is not a note on !${iid}, so nothing runs`);
    return broke(`could not read note ${noteText} of !${iid} (${(e as Error).message})`);
  }
  const forge = poster("gitlab", env, doFetch);
  const reply = async (text: string): Promise<void> => {
    try {
      await forge.addComment(iid, `terragucci: ${text}`);
    } catch (e) {
      console.error(`terragucci: could not reply: ${(e as Error).message}`);
    }
  };
  const refuse = async (reason: string): Promise<ApplyCommentDecision> => {
    await reply(reason);
    return stop(reason);
  };

  // The note is the request: what it asks, and who asked, come from GitLab, never from the variables.
  const parsed = parseComment(note?.body, parseOptions(env));
  if (note?.system === true || !parsed || !["apply", "lock", "unlock"].includes(parsed.kind)) return stop(`note ${noteText} on !${iid} asks for no apply, lock or unlock, so nothing runs`);
  const user = note?.author?.username;
  const uid = note?.author?.id;
  if (typeof user !== "string" || !LOGIN.test(user) || !Number.isInteger(uid)) return stop("the note has no usable author");
  let level: unknown;
  try {
    level = (await api("GET", `/projects/${id}/members/all/${uid}`))?.access_level;
  } catch (e) {
    if (/ answered 404/.test((e as Error).message)) return stop(`${user} is not a member of the project, so nothing runs`);
    return broke(`could not read ${user}'s access, so nothing runs (${(e as Error).message})`);
  }
  if (typeof level !== "number" || level < DEVELOPER) return stop(`${user} is below Developer on the project, so nothing runs`);

  if (parsed.kind === "unlock") {
    let released: string[];
    try {
      released = await releaseRootLocks(repoDir, iid);
    } catch (e) {
      return broke(`could not release the locks of !${iid} (${(e as Error).message})`);
    }
    const text = released.length ? `released the locks !${iid} held on ${released.map((r) => `\`${r}\``).join(", ")}, for ${user}` : `!${iid} holds no lock`;
    await reply(text);
    return stop(text);
  }

  const what = parsed.kind === "lock" ? "locked" : "applied";
  if (mr?.state !== "opened") return refuse(`!${iid} is not open, so nothing of it is ${what}`);
  if (mr?.source_project_id !== mr?.target_project_id) return refuse("a merge request from a fork is never applied: its code would run with this project's apply credentials");
  if (mr?.target_branch !== base) return refuse(`!${iid} targets ${String(mr?.target_branch)}, not the default branch ${base}, so it is not ${what}`);
  const sha = mr?.sha;
  if (typeof sha !== "string" || !SHA.test(sha)) return broke(`!${iid}'s head is not a commit`);
  // The variable is a pointer anyone who can start a pipeline here can set: it must name the head the merge request has now.
  if (sha !== named) {
    return refuse(`this pipeline was started for the head ${short(named)}, and !${iid}'s head is ${short(sha)}, so nothing is ${what}. Comment \`/terragucci ${parsed.kind}\` again to ${parsed.kind} the new head`);
  }

  const remote = `refs/remotes/origin/${base}`;
  const headRemote = "refs/remotes/terragucci/merge-request-head";
  const fetched = git(["fetch", "-q", "origin", `+refs/heads/${base}:${remote}`, `+refs/merge-requests/${iid}/head:${headRemote}`]);
  if (fetched.status !== 0) return broke(`could not fetch ${base} and !${iid}'s head (${fetched.stderr.trim()})`);
  const now = git(["rev-parse", headRemote]).stdout.trim();
  if (now !== sha) return refuse(`!${iid} moved while this note was read (its head is now ${short(now)}); comment again once its plan passes`);

  const lock = async (how: "apply" | "lock"): Promise<{ roots: string[]; every?: string; kind: string } | ApplyCommentDecision> => {
    const reach = reached(repoDir, git, remote, sha, o.layers, { ...(o.terragrunt ? { terragrunt: true } : {}), ...(o.synth ? { synth: true } : {}) });
    let locked;
    try {
      locked = await takeRootLocks(repoDir, reach.units, { pr: iid, by: user, at: new Date().toISOString(), head: sha, stage: how }, async (n) => (await api("GET", `/projects/${id}/merge_requests/${n}`))?.state === "opened");
    } catch (e) {
      return broke(`could not take the root locks (${(e as Error).message})`);
    }
    if (!locked.ok) {
      return refuse(`${describeHeld(locked.held, (n) => `merge request !${n}`)}, so !${iid} is not ${how === "lock" ? "locked" : "applied"}. It ${how === "lock" ? "locks" : "applies"} once that merge request merges or closes, or a Developer comments \`/terragucci unlock\` on it`);
    }
    return { roots: reach.units, kind: reach.kind, ...(reach.every ? { every: reach.every } : {}) };
  };
  const isDecision = (x: object): x is ApplyCommentDecision => "go" in x;
  const kind = o.terragrunt ? "unit" : "root";

  if (parsed.kind === "lock") {
    const l = await lock("lock");
    if (isDecision(l)) return l;
    const text = l.roots.length
      ? `${l.every ? `!${iid} locks every ${l.kind}: ${l.every}. ` : ""}locked ${l.roots.map((r) => `\`${r}\``).join(", ")} for !${iid} at ${short(sha)}, for ${user}; nothing was applied. The locks hold until it merges or closes, or a Developer comments \`/terragucci unlock\``
      : `!${iid} reaches no ${kind}, so nothing is locked`;
    await reply(text);
    return stop(text);
  }

  const wave = parsed.kind === "apply" ? parsed.wave : undefined;
  const waves = applyWaves(o.layers, o.canary).length;
  if (wave !== undefined && wave > waves) return refuse(`this repository applies in ${waves} wave${waves === 1 ? "" : "s"}, so there is no wave-${wave}`);
  const verdict = await openChecks({ api, id, mr, base, env, fetch: doFetch, ...(await agentSettingsAt(repoDir)), ...(o.requires ? { requires: o.requires } : {}), ...(o.wait ? { wait: o.wait } : {}) });
  if (verdict && "fail" in verdict) return broke(verdict.fail);
  if (verdict) return refuse(verdict.refuse);
  const l = await lock("apply");
  if (isDecision(l)) return l;
  if (l.every) await reply(`!${iid} locks every ${l.kind}: ${l.every}. Applying its head ${short(sha)}`);
  const through = wave !== undefined ? ` through wave ${wave}` : "";
  const locking = l.roots.length ? `, locking ${l.roots.join(", ")}` : "";
  return { go: true, open: true, reason: `apply !${iid}'s head ${short(sha)}${through} for ${user}${locking}`, pr: iid, sha, base, ...(wave !== undefined ? { wave } : {}) };
}

export interface GitLabMergeOptions {
  pr: number;
  sha: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  repo?: string;
}

/** The marker of the mr-apply job's reply once every wave of `head` applied in pipeline `pipeline`. */
export const appliedMarker = (head: string, pipeline: string): string => `<!-- terragucci:applied head=${head} pipeline=${pipeline} -->`;

/**
 * Merge a merge request whose every wave applied from its head
 * (`apply.merge: auto`), then release its locks. The `pr-merge` job runs it
 * with the pipeline's variables, so it reads GitLab first: a reply from the
 * job's own token user carries appliedMarker for `sha` and this pipeline
 * (else there is nothing to merge, and it says so), the merge request is
 * open, its head is still `sha`, and chant's `approved` passes for that head
 * under the apply's approverFilter (a member with Developer or more, who had
 * no hand in the change, approved it after its latest push). GitLab then merges only while the head is `sha`.
 * It merges with TG_MERGE_TOKEN (apply.merge_token_env's variable). Returns
 * what to say: `merged ...`, or `nothing to merge: ...`; throws with the
 * reason when it does not merge.
 */
export async function mergeGitLabMR(o: GitLabMergeOptions): Promise<string> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  if (!SHA.test(o.sha)) throw new ConfigError("--sha must be a commit sha");
  const pipeline = (env.CI_PIPELINE_ID ?? "").trim();
  if (!/^\d+$/.test(pipeline)) throw new ConfigError("pr-merge --forge gitlab needs CI_PIPELINE_ID in the environment");
  const id = env.CI_PROJECT_ID ? encodeURIComponent(env.CI_PROJECT_ID) : "";
  const read = gitlabApi(env, env.TG_TOKEN, doFetch);
  const me = Number((await read("GET", "/user"))?.id);
  const notes = await read("GET", `/projects/${id}/merge_requests/${o.pr}/notes?order_by=created_at&sort=desc&per_page=100`);
  const marker = appliedMarker(o.sha, pipeline);
  const applied = (Array.isArray(notes) ? notes : []).some((n: any) => n?.author?.id === me && typeof n?.body === "string" && n.body.includes(marker));
  if (!applied) return `nothing to merge: this pipeline did not apply every wave of !${o.pr} at ${short(o.sha)}`;
  const mr = await read("GET", `/projects/${id}/merge_requests/${o.pr}`);
  if (mr?.state !== "opened") throw new Error(`!${o.pr} is not open`);
  if (mr?.sha !== o.sha) throw new Error(`!${o.pr} moved after it applied (its head is now ${short(String(mr?.sha))})`);
  if (mr?.source_project_id !== mr?.target_project_id) throw new Error(`!${o.pr} comes from a fork`);
  if (env.CI_DEFAULT_BRANCH && mr?.target_branch !== env.CI_DEFAULT_BRANCH) throw new Error(`!${o.pr} targets ${String(mr?.target_branch)}, not ${env.CI_DEFAULT_BRANCH}`);
  // approved counts as the apply's decision did: chant's prApproved under approverFilter, read with the job's own token.
  const involved = await pullInvolvement({ forge: "gitlab", calls: reviewCalls(read, id), pr: { number: o.pr, head: o.sha, ...(typeof mr?.author?.username === "string" ? { author: mr.author.username } : {}) }, env, fetch: doFetch, ...(await agentSettingsAt(o.repo ?? process.cwd())) });
  for (const line of involved.notes) console.log(`terragucci: ${line}`);
  const forge = poster("gitlab", env, doFetch, "TG_TOKEN");
  if (!forge.prApproved) throw new Error(`this ${forge.kind} client cannot say whether !${o.pr} is approved`);
  const approval = await forge.prApproved(o.pr, o.sha, approverFilter(involved));
  if (!approval.passed) throw new Error(`!${o.pr} is not approved: ${approval.reason}`);
  // GitLab merges only while the head is still `sha`.
  const merged = await poster("gitlab", env, doFetch, env.TG_MERGE_TOKEN ? "TG_MERGE_TOKEN" : "TG_TOKEN").mergePullRequest(o.pr, { sha: o.sha });
  if (!merged.merged) throw new Error(`GitLab refused the merge${merged.reason ? ` (${merged.reason})` : ""}`);
  const released = await releaseRootLocks(o.repo ?? process.cwd(), o.pr);
  return `merged !${o.pr} at ${short(o.sha)}${released.length ? ` and released its locks on ${released.join(", ")}` : ""}`;
}
