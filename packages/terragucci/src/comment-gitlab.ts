/**
 * `terragucci comment --forge gitlab --poll`: comment commands on GitLab.
 *
 * GitLab starts no pipeline for a merge request note, so the comments
 * schedule's pipeline (TERRAGUCCI_SCHEDULE=comments, from the default
 * branch) runs this poll. It lists the merge requests updated in the last
 * day, reads their notes, and answers each `/terragucci` note once. A note is
 * answered when a reply from the job's own token carries
 * `<!-- terragucci:note=<id> -->`, so the cursor lives in the merge requests
 * and the job keeps no state.
 *
 * Each note goes through the grammar in comment.ts. Its author must be a
 * Developer or above on the project; anyone else gets no reply and nothing
 * runs, as on GitHub. Then:
 *
 * - `/terragucci plan [root]` on an open merge request from this project
 *   starts a new merge request pipeline, whose plan job plans and updates the
 *   plan note as a push does. GitLab takes no variables for that pipeline, so
 *   a named root must be one of the pipeline's roots and the whole merge
 *   request is planned.
 * - `/terragucci apply` on a merged merge request retries the first apply
 *   job that did not succeed in the default branch's pipeline at its merge
 *   commit. `stage tf-apply` decides the gate again, so a wave with no
 *   approval waits again, and GitLab then runs the waves after it, each
 *   behind its own gate. A merge commit a later apply superseded is refused,
 *   as on GitHub. GitLab cannot stop the waves after a retried one, so
 *   `wave-<n>` is refused.
 * - With `apply.when: pull-request`, `/terragucci apply [wave-<n>]` on an
 *   open merge request is checked against `apply.requires` here, then starts
 *   a pipeline on the default branch whose `mr-apply` job applies the head
 *   (comment-apply-gitlab.ts); `/terragucci lock` and `/terragucci unlock`
 *   start the same pipeline, which locks or releases the merge request's
 *   roots. It is started with TG_MERGE_TOKEN (apply.merge_token_env), since
 *   a pipeline on a protected default branch needs a token that may merge
 *   there. A merged merge request has nothing to apply: it applied before it
 *   merged.
 * - Otherwise `/terragucci lock` and `/terragucci unlock` are answered as
 *   unsupported, and so is `/terragucci agent`.
 *
 * With `gitlab.token: protected` (`--plan-notes`), before the notes of each
 * open merge request the poll posts its plan note and `terragucci/plan`
 * status from the report its head's plan job kept (plan-note-gitlab.ts): a
 * merge request's own pipeline then holds no token that may post them.
 *
 * The job runs nothing it reads: it calls GitLab's API with the project's
 * token and holds no cloud credentials.
 */
import { allowRoot, LOGIN, parseComment, parseOptions, SHA } from "./comment";
import { gitlabApi, HEAD_VAR, MR_VAR, NOTE_VAR, openChecks } from "./comment-apply-gitlab";
import { ConfigError, type ApplyRequire, type ApplyWhen } from "./config";
import { call as forgeCall, type Fetch, type ForgeTarget } from "./forge";
import { postPlanNote, type PlanNoteOutcome } from "./plan-note-gitlab";

/** How far back the poll reads: merge requests updated, and notes written, in this many minutes. */
export const POLL_WINDOW_MINUTES = 24 * 60;

/** GitLab's Developer access level: the least that may ask for a plan or an apply. */
export const DEVELOPER = 30;

/** How many default-branch pipelines after the merge commit's are read for a later apply. */
export const NEWER_PIPELINES = 50;

/** The status every apply posts on the commit it applied. */
const APPLY_CONTEXT = "terragucci/apply";

/** The marker a reply carries, naming the note it answers. */
export const noteMarker = (id: number): string => `<!-- terragucci:note=${id} -->`;
const MARKER = /<!-- terragucci:note=(\d+) -->/g;

/** What the poll did with one note. */
export interface NoteOutcome {
  mr: number;
  note: number;
  /** True when a pipeline was started or a job retried. */
  ran: boolean;
  /** True when something broke (a forge answer), not because the note asked for nothing. */
  fail?: boolean;
  /** False when the note got no reply (an author without access). */
  replied: boolean;
  reason: string;
}

export interface GitLabPollOptions {
  /** The roots the pipeline was written with, one array per layer. */
  layers: string[][];
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  /** The poll's clock. Default: now. */
  now?: Date;
  /** `apply.when`. With `pull-request` an open merge request applies from its head. Default `merge`. */
  when?: ApplyWhen;
  /** `apply.requires`: what an open merge request needs before it applies. Default: every requirement. */
  requires?: readonly ApplyRequire[];
  /** How the checks wait between reads of a merge request GitLab has not finished checking. Default: a timer. */
  wait?: (ms: number) => Promise<void>;
  /** `gitlab.token: protected`: post each open merge request's plan note and status from its plan job's report. */
  planNotes?: boolean;
  /** The directory the plan job keeps its report in. Default terragucci-report. */
  reportDir?: string;
}

export interface GitLabPoll {
  outcomes: NoteOutcome[];
  /** The plan notes and statuses posted, or that failed to post. */
  plans?: PlanNoteOutcome[];
  /** Set when the poll could not list the merge requests or their notes. */
  fail?: string;
}

const short = (sha: string): string => sha.slice(0, 8);

/** The project, its API and the job's token, from the job's environment. */
function targetOf(env: NodeJS.ProcessEnv): { t: ForgeTarget; base: string } {
  const api = env.CI_API_V4_URL;
  const project = env.CI_PROJECT_ID;
  const token = env.TG_TOKEN;
  const base = env.CI_DEFAULT_BRANCH;
  if (!api || !project || !token || !base) throw new ConfigError("comment --forge gitlab --poll needs CI_API_V4_URL, CI_PROJECT_ID, CI_DEFAULT_BRANCH and TG_TOKEN in the environment");
  return { t: { forge: "gitlab", origin: env.CI_SERVER_URL ?? api, path: project, token, api }, base };
}

export async function pollGitLabComments(o: GitLabPollOptions): Promise<GitLabPoll> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? fetch;
  const now = o.now ?? new Date();
  const { t, base } = targetOf(env);
  const id = encodeURIComponent(t.path);
  const api = (method: string, path: string, body?: unknown): Promise<any> => forgeCall(doFetch, t, method, path, body);
  const since = new Date(now.getTime() - POLL_WINDOW_MINUTES * 60_000).toISOString();

  let me: number;
  let mrs: any[];
  try {
    me = Number((await api("GET", "/user"))?.id);
    mrs = (await api("GET", `/projects/${id}/merge_requests?state=all&updated_after=${encodeURIComponent(since)}&order_by=updated_at&sort=desc&per_page=100`)) as any[];
  } catch (e) {
    return { outcomes: [], fail: `could not list the merge requests (${(e as Error).message})` };
  }
  if (!Array.isArray(mrs)) return { outcomes: [], fail: "GitLab answered the merge request list with something other than a list" };

  const outcomes: NoteOutcome[] = [];
  const plans: PlanNoteOutcome[] = [];
  const planContext = { api, id, me, apiUrl: t.api!, token: t.token, fetch: doFetch, reportDir: o.reportDir ?? "terragucci-report" };
  for (const mr of mrs) {
    const iid = mr?.iid;
    if (!Number.isInteger(iid) || iid < 1) continue;
    let notes: any[];
    try {
      notes = (await api("GET", `/projects/${id}/merge_requests/${iid}/notes?order_by=created_at&sort=desc&per_page=100`)) as any[];
    } catch (e) {
      return { outcomes, plans, fail: `could not read the notes of !${iid} (${(e as Error).message})` };
    }
    if (!Array.isArray(notes)) continue;
    // The plan first, so a `/terragucci apply` answered below finds terragucci/plan on the head.
    const plan = o.planNotes ? await postPlanNote(planContext, mr, notes) : undefined;
    if (plan) plans.push(plan);
    // Only the job's own replies mark a note answered: anyone else writing the marker answers nothing.
    const answered = new Set<number>();
    for (const n of notes) {
      if (n?.author?.id !== me || typeof n?.body !== "string") continue;
      for (const m of n.body.matchAll(MARKER)) answered.add(Number(m[1]));
    }
    const asks = notes
      .filter((n) => Number.isInteger(n?.id) && n.system !== true && !answered.has(n.id))
      .filter((n) => typeof n.created_at === "string" && n.created_at >= since)
      .filter((n) => parseComment(n.body, parseOptions(env)) !== undefined)
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
    for (const note of asks) outcomes.push(await answer({ api, id, base, layers: o.layers, mr, note, env, fetch: doFetch, ...(o.when ? { when: o.when } : {}), ...(o.requires ? { requires: o.requires } : {}), ...(o.wait ? { wait: o.wait } : {}) }));
  }
  return { outcomes, plans };
}

interface Ask {
  api: (method: string, path: string, body?: unknown) => Promise<any>;
  /** The project id, encoded for a path. */
  id: string;
  /** The default branch. */
  base: string;
  layers: string[][];
  mr: any;
  note: any;
  env: NodeJS.ProcessEnv;
  fetch: Fetch;
  when?: ApplyWhen;
  requires?: readonly ApplyRequire[];
  wait?: (ms: number) => Promise<void>;
}

async function answer(ask: Ask): Promise<NoteOutcome> {
  const { api, id, base, layers, mr, note } = ask;
  const prMode = ask.when === "pull-request";
  const iid: number = mr.iid;
  const at = { mr: iid, note: note.id as number };
  const reply = async (text: string, ran = false): Promise<NoteOutcome> => {
    try {
      await api("POST", `/projects/${id}/merge_requests/${iid}/notes`, { body: `terragucci: ${text}\n\n${noteMarker(note.id)}` });
    } catch (e) {
      return { ...at, ran, replied: false, fail: true, reason: `${text}; and the reply failed (${(e as Error).message})` };
    }
    return { ...at, ran, replied: true, reason: text };
  };
  const broke = (reason: string): NoteOutcome => ({ ...at, ran: false, replied: false, fail: true, reason });
  const silent = (reason: string): NoteOutcome => ({ ...at, ran: false, replied: false, reason });

  const parsed = parseComment(note.body, parseOptions(ask.env))!;
  const user = note.author?.username;
  const uid = note.author?.id;
  if (typeof user !== "string" || !LOGIN.test(user) || !Number.isInteger(uid)) return silent("the note has no usable author");

  // Who asked comes first: someone below Developer gets no reply and nothing runs.
  let level: unknown;
  try {
    level = (await api("GET", `/projects/${id}/members/all/${uid}`))?.access_level;
  } catch (e) {
    if (/ answered 404/.test((e as Error).message)) return silent(`${user} is not a member of the project, so the note is ignored`);
    return broke(`could not read ${user}'s access, so nothing runs (${(e as Error).message})`);
  }
  if (typeof level !== "number" || level < DEVELOPER) return silent(`${user} is below Developer on the project, so the note is ignored`);

  if (parsed.kind === "refused") return reply(parsed.reason);
  if (parsed.kind === "agent") return reply("`/terragucci agent` does not run on GitLab: a merge request note starts no job that could push to its branch");
  if ((parsed.kind === "lock" || parsed.kind === "unlock") && !prMode) {
    return reply(`\`/terragucci ${parsed.kind}\` does not run here: this project applies after merge, so merge requests take no locks`);
  }

  const fork = mr.source_project_id !== undefined && mr.target_project_id !== undefined && mr.source_project_id !== mr.target_project_id;

  // apply.when: pull-request: an open merge request's apply, lock and unlock run in a pipeline of the default branch.
  if (prMode && parsed.kind !== "plan") {
    if (mr.state !== "opened") {
      if (parsed.kind === "apply") {
        return reply(mr.state === "merged"
          ? `!${iid} is merged, and this project applies a merge request from its head before it merges, so there is nothing of it left to apply; the push after the merge ran \`confirm\``
          : `!${iid} was closed without merging, so there is nothing of it to apply`);
      }
      return reply(`!${iid} is not open, so it holds no lock: the next merge request that reaches its roots takes them over`);
    }
    if (fork) return reply("a merge request from a fork is never applied: its code would run with this project's apply credentials");
    if (mr.target_branch !== base) return reply(`!${iid} targets ${String(mr.target_branch)}, not the default branch ${base}, so it is not applied`);
    const sha = mr.sha;
    if (typeof sha !== "string" || !SHA.test(sha)) return broke(`!${iid}'s head is not a commit`);
    if (parsed.kind === "apply") {
      const verdict = await openChecks({ api, id, mr, base, ...(ask.requires ? { requires: ask.requires } : {}), ...(ask.wait ? { wait: ask.wait } : {}) });
      if (verdict && "fail" in verdict) return broke(verdict.fail);
      if (verdict) return reply(verdict.refuse);
    }
    // A pipeline on a protected default branch needs a token that may merge there; the comments job's own may not.
    if (!ask.env.TG_MERGE_TOKEN) return broke(`the comments job has no TG_MERGE_TOKEN, the token apply.merge_token_env names, so it cannot start a pipeline on ${base} for !${iid}`);
    let pipeline: any;
    try {
      const start = gitlabApi(ask.env, ask.env.TG_MERGE_TOKEN, ask.fetch);
      pipeline = await start("POST", `/projects/${id}/pipeline`, {
        ref: base,
        variables: [
          { key: MR_VAR, value: String(iid), variable_type: "env_var" },
          { key: NOTE_VAR, value: String(note.id), variable_type: "env_var" },
          { key: HEAD_VAR, value: sha, variable_type: "env_var" },
        ],
      });
    } catch (e) {
      return broke(`could not start a pipeline on ${base} for !${iid} (${(e as Error).message})`);
    }
    const link = typeof pipeline?.web_url === "string" && /^https?:\/\//.test(pipeline.web_url) ? ` ${pipeline.web_url}` : "";
    const wave = parsed.kind === "apply" ? parsed.wave : undefined;
    const through = wave !== undefined ? ` through wave ${wave}` : "";
    const doing = parsed.kind === "apply" ? `apply !${iid}'s head ${short(sha)}${through}` : `${parsed.kind} the roots of !${iid}`;
    return reply(`started pipeline${link} on ${base} to ${doing} for ${user}; its job reads !${iid} again before it ${parsed.kind === "apply" ? "applies" : parsed.kind + "s"}`, true);
  }

  if (parsed.kind === "plan") {
    if (parsed.root !== undefined && !allowRoot(parsed.root, layers)) {
      return reply(`${parsed.root} is not a root of this repository. The roots are ${layers.flat().sort().map((r) => `\`${r}\``).join(", ")}.`);
    }
    if (mr.state !== "opened") return reply(`!${iid} is not open, so it is not planned`);
    // A fork's code never meets the read-only plan role, here or in the plan job.
    if (fork) return reply("a merge request from a fork is not re-planned: its code never runs with this project's credentials");
    let pipeline: any;
    try {
      pipeline = await api("POST", `/projects/${id}/merge_requests/${iid}/pipelines`);
    } catch (e) {
      return broke(`could not start a pipeline for !${iid} (${(e as Error).message})`);
    }
    const link = typeof pipeline?.web_url === "string" && /^https?:\/\//.test(pipeline.web_url) ? ` ${pipeline.web_url}` : "";
    // GitLab takes no variables for a merge request pipeline, so the plan job plans what the merge request reaches.
    const whole = parsed.root !== undefined ? `; GitLab re-plans every root the merge request reaches, \`${parsed.root}\` among them` : "";
    return reply(`started pipeline${link} to re-plan !${iid} for ${user}${whole}`, true);
  }

  // apply (a lock or unlock got its answer above)
  if (parsed.kind !== "apply") return reply(`\`/terragucci ${parsed.kind}\` does not run here`);
  if (parsed.wave !== undefined) {
    return reply(`GitLab runs the waves after a retried apply job by itself, so \`wave-${parsed.wave}\` cannot stop them; write \`/terragucci apply\`, and each wave still waits behind its own gate`);
  }
  if (mr.state === "opened") {
    return reply(`!${iid} is not merged: \`/terragucci apply\` retries the apply of a merged merge request, from the default branch, and never applies a merge request's branch`);
  }
  if (mr.state !== "merged") return reply(`!${iid} was closed without merging, so there is nothing of it to apply`);
  if (fork) return reply("a merge request from a fork is not applied on a note: its apply runs when it reaches the default branch");
  if (mr.target_branch !== base) return reply(`!${iid} was merged into ${String(mr.target_branch)}, not the default branch ${base}, so nothing applies from it`);
  const sha = [mr.merge_commit_sha, mr.squash_commit_sha, mr.sha].find((s) => typeof s === "string" && SHA.test(s)) as string | undefined;
  if (!sha) return broke(`!${iid} has no merge commit`);

  let pipeline: any;
  let newer: any[];
  try {
    const list = (await api("GET", `/projects/${id}/pipelines?sha=${sha}&ref=${encodeURIComponent(base)}&source=push&order_by=id&sort=desc&per_page=1`)) as any[];
    pipeline = Array.isArray(list) ? list[0] : undefined;
    if (!pipeline) return reply(`no pipeline ran on ${base} at the merge commit ${short(sha)} of !${iid}, so there is no apply job to retry; push to ${base} again`);
    newer = (await api("GET", `/projects/${id}/pipelines?ref=${encodeURIComponent(base)}&source=push&order_by=id&sort=desc&per_page=${NEWER_PIPELINES}`)) as any[];
  } catch (e) {
    return broke(`could not read the pipelines of ${base} (${(e as Error).message})`);
  }
  // A later commit whose apply started applied a newer tree: going back to this one would undo it.
  const later = [...new Set((Array.isArray(newer) ? newer : []).filter((p) => Number(p?.id) > Number(pipeline.id) && p?.sha !== sha).map((p) => p.sha as string))];
  for (const c of later) {
    if (typeof c !== "string" || !SHA.test(c)) continue;
    let statuses: any;
    try {
      statuses = await api("GET", `/projects/${id}/repository/commits/${c}/statuses?name=${encodeURIComponent(APPLY_CONTEXT)}&ref=${encodeURIComponent(base)}`);
    } catch (e) {
      return broke(`could not read the statuses of ${short(c)} (${(e as Error).message})`);
    }
    const applied = Array.isArray(statuses) ? statuses.find((s: any) => s?.name === APPLY_CONTEXT) : undefined;
    if (applied) {
      const run = typeof applied.target_url === "string" && /^https?:\/\//.test(applied.target_url) ? ` (${applied.target_url})` : "";
      return reply(`a later apply already ran on ${base} at ${short(c)}${run}, so the merge commit ${short(sha)} of !${iid} is not applied: comment on the merge request that commit came from, or push again`);
    }
  }

  let jobs: any[];
  try {
    jobs = (await api("GET", `/projects/${id}/pipelines/${pipeline.id}/jobs?per_page=100`)) as any[];
  } catch (e) {
    return broke(`could not read the jobs of pipeline ${pipeline.id} (${(e as Error).message})`);
  }
  const waves = (Array.isArray(jobs) ? jobs : [])
    .map((j) => ({ j, n: Number(/^apply-wave-([1-9][0-9]*)$/.exec(String(j?.name))?.[1]) }))
    .filter((w) => Number.isInteger(w.n))
    .sort((a, b) => a.n - b.n);
  if (waves.length === 0) return reply(`pipeline ${pipeline.id} at ${short(sha)} has no apply jobs, so there is nothing to retry`);
  const next = waves.find((w) => w.j.status !== "success");
  if (!next) return reply(`every wave of !${iid}'s merge commit ${short(sha)} already applied`);
  const name = `apply-wave-${next.n}`;
  if (["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"].includes(next.j.status)) {
    return reply(`${name} at ${short(sha)} is ${next.j.status} already, so it is not retried`);
  }
  if (next.j.status !== "failed" && next.j.status !== "canceled") {
    return reply(`${name} at ${short(sha)} was ${String(next.j.status)}, and GitLab retries only a failed or canceled job; push to ${base} again`);
  }
  let retried: any;
  try {
    retried = await api("POST", `/projects/${id}/jobs/${next.j.id}/retry`);
  } catch (e) {
    return broke(`could not retry ${name} of pipeline ${pipeline.id} (${(e as Error).message})`);
  }
  const link = typeof retried?.web_url === "string" && /^https?:\/\//.test(retried.web_url) ? ` (${retried.web_url})` : "";
  return reply(`retried ${name} of !${iid}'s merge commit ${short(sha)}${link} for ${user}; its gate decides again, and the waves after it follow, each behind its own gate`, true);
}
