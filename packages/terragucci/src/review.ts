/**
 * `approval: pr-review`: the forge's pull request review approves a wave.
 *
 * The plan job of a pull request writes each wave's review digest into its
 * plan note, in a marker line (`noteMarker`): chant's set digest over the
 * plan digests of the wave's roots whose plan changes a resource or an
 * output, planned at the pull request's head. After the merge, a wave the
 * gate holds looks for the merged pull request's reviews: an approval of its
 * head by a reviewer other than its author, with write access, while nobody's
 * latest review asks for changes. With one, the wave takes the same digest
 * over the plans it just made. Equal, it records a resolution on the ledger
 * (`via: pr-review`, the pull request, its head and the reviewers) and
 * applies. Different, the plans moved after the review: the wave applies
 * nothing (exit 4) and records a pending fact for its new digest, which a
 * `chant approve` can answer as under ledger.
 *
 * A wave the review never saw (no row in the note) waits for a `chant
 * approve`, as under ledger. Under pr-review any `chant approve` of the
 * wave's digest counts too: a writer can still write one in anyone's name.
 *
 * Every forge counts through chant's prApproved under approverFilter. On
 * GitLab a merge request's approvals name no commit, so chant counts an
 * approval only when it came after the newest diff version, and waits
 * (pending) until that version is of the head. The approver holds Developer
 * access or more; an approval withdrawn later, or a later request for
 * changes, counts for nothing.
 *
 * A review counts only from someone who had no hand in the change
 * (./involved.ts): not the pull request's author, nor anyone who wrote or
 * committed one of its commits, asked an agent for one (`Requested-by:`),
 * or is the user the pipeline's or the agent's token acts as.
 *
 * An approval by the identity the pipeline's own token acts as never counts:
 * on GitLab the user `GET /user` names for the token (the project's bot,
 * whose token a merge request's code can read by default), on GitHub
 * `github-actions[bot]`, on Forgejo its actions user. The token is the
 * pipeline's, not a reviewer's.
 *
 * `terragucci approval-status` posts the `terragucci/approval` status on the
 * head (GitHub and Forgejo): pending while a wave the gate will hold has no
 * approving review of that head, success otherwise, so branch protection can
 * require it. GitLab's own approval rules do that job there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changeSetDigest } from "@intentius/chant/change-set";
import { apiOf } from "./comment";
import type { PrForge } from "@intentius/chant/pr-forge";
import { approverFilter } from "./comment-apply";
import { ConfigError } from "./config";
import { changesSomething } from "./report/changing";
import { parseMarker, type NoteWaves } from "./report/marker";
import { poster, type Fetch } from "./forge";
import { notCounted, pullInvolvement, type Excluded, type Involved } from "./involved";

/** The status a pull request's head carries under pr-review. */
export const APPROVAL_CONTEXT = "terragucci/approval";

export { changesSomething, destroysSomething } from "./report/changing";
export { noteMarker, parseMarker, WAVES_MARKER, type NoteWaves } from "./report/marker";

/** The review digest: the set digest over the members whose plan changes something, and `extra` (the wave's cost under `cost.approve_above`). Null when none does. */
export function reviewDigest(members: readonly { member: string; planDigest: string; plan: unknown }[], extra: readonly { member: string; planDigest: string }[] = []): string | null {
  const changing = members.filter((m) => changesSomething(m.plan));
  return changing.length === 0 ? null : changeSetDigest([...changing.map(({ member, planDigest }) => ({ member, planDigest })), ...extra]);
}

/** A forge's REST API, as the jobs call it with their own token. */
export interface ForgeCalls {
  repo: string;
  get: (path: string) => Promise<any>;
  post: (path: string, body: unknown) => Promise<any>;
}

export function forgeCalls(env: NodeJS.ProcessEnv, doFetch: Fetch = fetch): ForgeCalls {
  const { api, repo, token } = apiOf(env);
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await doFetch(`${api}/${path}`, { method, headers: { "content-type": "application/json", authorization: `token ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
  return { repo, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) };
}

/** A pull request as the review path reads it. */
export interface ReviewedPull {
  number: number;
  head: string;
  author?: string;
}

/**
 * The pull request a wave answers to: `TG_PR` when the job names one (a
 * comment's apply), else the one the forge says merged as `sha`. Undefined
 * when no merged pull request made the commit (a direct push).
 */
export async function pullOf(f: ForgeCalls, env: NodeJS.ProcessEnv, sha: string): Promise<ReviewedPull | undefined> {
  const named = (env.TG_PR ?? "").trim();
  let pr: any;
  if (/^\d+$/.test(named)) pr = await f.get(`repos/${f.repo}/pulls/${named}`);
  else {
    let found: any;
    try {
      found = await f.get(`repos/${f.repo}/commits/${sha}/pull`);
    } catch {
      // GitHub has no /pull: it lists the pull requests a commit belongs to.
      const list = await f.get(`repos/${f.repo}/commits/${sha}/pulls`).catch(() => []);
      found = (Array.isArray(list) ? list : []).find((p: any) => p?.merge_commit_sha === sha && (p?.merged_at || p?.merged));
    }
    pr = found;
  }
  if (!pr || !Number.isInteger(pr.number) || typeof pr.head?.sha !== "string") return undefined;
  return { number: pr.number, head: pr.head.sha, ...(typeof pr.user?.login === "string" ? { author: pr.user.login } : {}) };
}

/**
 * Whether the pull request's head is approved, by chant's prApproved under
 * approverFilter(involved), as the apply before merge counts it. `by` is the
 * approvers chant counted; `excluded` the ones who approved the head and did
 * not count, with chant's reason.
 */
export async function approvedBy(forge: PrForge, pr: ReviewedPull, involved: Involved | undefined): Promise<{ by: string[]; reason: string; excluded: Excluded[] }> {
  if (!forge.prApproved) throw new Error(`this ${forge.kind} client cannot say whether a pull request is approved`);
  const r = await forge.prApproved(pr.number, pr.head, approverFilter(involved ?? { people: [], notes: [] }));
  return { by: r.passed ? r.approvers : [], reason: r.reason, excluded: r.excluded };
}

/** The newest plan note marker of the pull request's head, read from its comments. */
export async function noteWavesOf(f: ForgeCalls, pr: ReviewedPull): Promise<NoteWaves | undefined> {
  const comments = await f.get(`repos/${f.repo}/issues/${pr.number}/comments?per_page=100&limit=50`);
  let found: NoteWaves | undefined;
  for (const c of Array.isArray(comments) ? comments : []) {
    const w = parseMarker(c?.body);
    if (w && w.head === pr.head) found = w;
  }
  return found;
}

/** The calls of GitLab's API, with the job's token, against the project the job runs in. */
export function gitlabCalls(env: NodeJS.ProcessEnv, doFetch: Fetch = fetch): ForgeCalls {
  const api = env.CI_API_V4_URL;
  const id = env.CI_PROJECT_ID;
  const token = env.TG_TOKEN;
  if (!api || !id || !token) throw new ConfigError("pr-review on GitLab needs CI_API_V4_URL, CI_PROJECT_ID and TG_TOKEN in the environment");
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const r = await doFetch(`${api}/${path}`, { method, headers: { "content-type": "application/json", "private-token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}`);
    return r.status === 204 ? null : r.json();
  };
  return { repo: `projects/${id}`, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b) };
}

/**
 * A merged merge request's plan note, read from GitLab: the merge request
 * whose merge (or squash) commit is `sha`, or the one `TG_PR` names when the
 * job applies an open merge request before it merges.
 */
export async function gitlabReviews(f: ForgeCalls, sha: string, env: NodeJS.ProcessEnv = {}): Promise<{ pr: ReviewedPull; note?: NoteWaves; own?: string } | undefined> {
  const mr = await gitlabMergeRequestOf(f, sha, env);
  return mr ? gitlabNotes(f, mr) : undefined;
}

/** The merge request a wave answers to on GitLab: `TG_PR`'s when the job names one, else the merged one whose merge (or squash) commit is `sha`. */
export async function gitlabMergeRequestOf(f: ForgeCalls, sha: string, env: NodeJS.ProcessEnv = {}): Promise<any | undefined> {
  const named = (env.TG_PR ?? "").trim();
  let mr: any;
  if (/^\d+$/.test(named)) mr = await f.get(`${f.repo}/merge_requests/${named}`);
  else {
    const list = await f.get(`${f.repo}/repository/commits/${sha}/merge_requests`);
    mr = (Array.isArray(list) ? list : []).find((m: any) => m?.state === "merged" && (m?.merge_commit_sha === sha || m?.squash_commit_sha === sha));
  }
  return mr && Number.isInteger(mr.iid) ? mr : undefined;
}

/**
 * What a merge request's notes say beside its approvals, which chant's
 * prApproved counts: the plan note marker of its head, and `own`, the token's
 * user when it approved (chant skips that approval without naming it).
 */
export async function gitlabNotes(f: ForgeCalls, mr: any): Promise<{ pr: ReviewedPull; note?: NoteWaves; own?: string }> {
  let me: any;
  try {
    me = await f.get("user");
  } catch (e) {
    throw new Error(`could not read which user the job's token acts as, so no approval counts (${(e as Error).message})`);
  }
  if (!Number.isInteger(me?.id)) throw new Error("GitLab did not say which user the job's token acts as, so no approval counts");
  const pr: ReviewedPull = { number: mr.iid, head: mr.sha, ...(typeof mr.author?.username === "string" ? { author: mr.author.username } : {}) };
  const notes = await f.get(`${f.repo}/merge_requests/${mr.iid}/notes?per_page=100&sort=asc&order_by=created_at`);
  let note: NoteWaves | undefined;
  let own: string | undefined;
  for (const n of Array.isArray(notes) ? notes : []) {
    if (!n?.system) {
      const w = parseMarker(n?.body);
      if (w && w.head === pr.head) note = w;
    } else if ((n.author?.id === me.id || n.author?.username === me.username) && /^approved this merge request/.test(String(n.body ?? "").trim())) own = n.author.username;
  }
  return { pr, ...(note ? { note } : {}), ...(own ? { own } : {}) };
}

/** What a wave the gate holds gets from the review path. */
export type ReviewOutcome =
  | { kind: "approved"; pr: number; head: string; by: string[]; excluded?: Excluded[] }
  /** The reviewed digest differs from the one planned now. */
  | { kind: "moved"; pr: number; head: string; by: string[]; reviewed: string; excluded?: Excluded[] }
  /**
   * Nothing to go on: no pull request, no approval of its head, or no row for
   * the wave in its note. `review` names the pull request when an approving
   * review of its head would still count: its note has a digest for the wave,
   * and the forge takes a review of it (GitLab refuses an approval once a
   * merge request merged).
   */
  | { kind: "none"; why: string; review?: { pr: number; url: string }; excluded?: Excluded[] };

/** The page where a reviewer approves the pull request: GitHub's and Forgejo's Files changed tab, GitLab's merge request. */
export function reviewUrl(env: NodeJS.ProcessEnv, forge: "github" | "forgejo" | "gitlab", pr: number): string | undefined {
  if (forge === "gitlab") return env.CI_PROJECT_URL ? `${env.CI_PROJECT_URL}/-/merge_requests/${pr}` : undefined;
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY) return undefined;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/${forge === "github" ? "pull" : "pulls"}/${pr}/files`;
}

/** Decide one wave by the merged pull request's reviews. Never throws: a forge it cannot read leaves the wave waiting, with the reason. */
export async function reviewWave(o: { env: NodeJS.ProcessEnv; fetch?: Fetch; forge: "github" | "forgejo" | "gitlab"; sha: string; wave: number; digest: string | null; involved?: Involved }): Promise<ReviewOutcome> {
  let excluded: Excluded[] = [];
  const out = (r: ReviewOutcome): ReviewOutcome => (excluded.length ? { ...r, excluded } : r);
  try {
    let pr: ReviewedPull | undefined;
    let note: NoteWaves | undefined;
    // A merge request named by TG_PR is open (applied before it merges); GitLab takes no approval of a merged one.
    let reviewable = true;
    let own = "";
    if (o.forge === "gitlab") {
      const got = await gitlabReviews(gitlabCalls(o.env, o.fetch), o.sha, o.env);
      if (!got) return { kind: "none", why: `no merged merge request made ${o.sha.slice(0, 8)}` };
      ({ pr, note } = got);
      reviewable = /^\d+$/.test((o.env.TG_PR ?? "").trim());
      if (got.own) own = `; the approval by ${got.own}, the user the job's token acts as, never counts`;
    } else {
      const f = forgeCalls(o.env, o.fetch);
      pr = await pullOf(f, o.env, o.sha);
      if (!pr) return { kind: "none", why: `no merged pull request made ${o.sha.slice(0, 8)}` };
      note = await noteWavesOf(f, pr);
    }
    const got = await approvedBy(poster(o.forge, o.env, o.fetch), pr, o.involved);
    const by = got.by;
    excluded = got.excluded;
    if (by.length === 0) return out({ kind: "none", why: `${o.forge === "gitlab" ? "merge request" : "pull request"} ${pr.number} is not approved: ${got.reason}${own}`, ...reviewOf(o, pr.number, note, reviewable) });
    const row = note?.waves.find((w) => w.number === o.wave);
    if (!row || !row.digest) return out({ kind: "none", why: `the plan note of head ${pr.head.slice(0, 8)} has no digest for wave ${o.wave}, so its review did not cover these plans` });
    if (o.digest !== null && row.digest === o.digest) return out({ kind: "approved", pr: pr.number, head: pr.head, by });
    return out({ kind: "moved", pr: pr.number, head: pr.head, by, reviewed: row.digest });
  } catch (e) {
    return out({ kind: "none", why: `the reviews could not be read (${(e as Error).message})` });
  }
}

/** The review that would still approve the wave: its pull request's note has a digest for it, and the forge takes a review. */
function reviewOf(o: { env: NodeJS.ProcessEnv; forge: "github" | "forgejo" | "gitlab"; wave: number }, pr: number, note: NoteWaves | undefined, reviewable: boolean): { review?: { pr: number; url: string } } {
  if (!reviewable || !note?.waves.find((w) => w.number === o.wave)?.digest) return {};
  const url = reviewUrl(o.env, o.forge, pr);
  return url ? { review: { pr, url } } : {};
}

/**
 * `terragucci approval-status`: post `terragucci/approval` on the pull
 * request's head (`TG_PR`, `TG_SHA`). The waves come from the report in
 * `report` (the plan job) or from the head's plan note (the review job).
 */
export async function approvalStatus(o: { env?: NodeJS.ProcessEnv; fetch?: Fetch; forge: "github" | "forgejo"; report?: string; agentTokenEnv?: string; agentLogin?: string; log?: (line: string) => void }): Promise<{ state: "pending" | "success"; description: string }> {
  const env = o.env ?? process.env;
  const f = forgeCalls(env, o.fetch);
  const number = (env.TG_PR ?? "").trim();
  if (!/^\d+$/.test(number)) throw new ConfigError("approval-status needs TG_PR, the pull request number");
  const raw = await f.get(`repos/${f.repo}/pulls/${number}`);
  const pr: ReviewedPull = { number: Number(number), head: env.TG_SHA || raw?.head?.sha, ...(typeof raw?.user?.login === "string" ? { author: raw.user.login } : {}) };
  if (typeof pr.head !== "string" || !pr.head) throw new ConfigError("approval-status needs the head commit: TG_SHA, or a pull request the forge names a head for");
  let waits: number[];
  if (o.report) {
    const report = JSON.parse(readFileSync(join(o.report, "report.json"), "utf-8")) as { waves?: { number: number; waits?: boolean }[] };
    waits = (report.waves ?? []).filter((w) => w.waits).map((w) => w.number);
  } else {
    const note = await noteWavesOf(f, pr);
    waits = (note?.waves ?? []).filter((w) => w.waits).map((w) => w.number);
  }
  let state: "pending" | "success";
  let description: string;
  if (waits.length === 0) {
    state = "success";
    description = "no wave waits for an approval";
  } else {
    const involved = await pullInvolvement({ forge: o.forge, calls: f, pr, env, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.agentTokenEnv ? { agentTokenEnv: o.agentTokenEnv } : {}), ...(o.agentLogin ? { agentLogin: o.agentLogin } : {}) });
    const { by, reason, excluded } = await approvedBy(poster(o.forge, env, o.fetch ?? fetch), pr, involved);
    for (const e of excluded) o.log?.(notCounted(e, "review"));
    const which = `wave ${waits.join(", ")}`;
    if (by.length > 0) {
      state = "success";
      description = `${which} approved on ${pr.head.slice(0, 8)} by ${by.join(", ")}`;
    } else {
      o.log?.(`not approved: ${reason}`);
      state = "pending";
      description = excluded.length ? `${which} waits: ${excluded.map((e) => e.reason).join("; ")}; another writer approves` : `${which} waits: approve this pull request on ${pr.head.slice(0, 8)}`;
    }
  }
  await poster(o.forge, env, o.fetch ?? fetch).setStatus(pr.head, { state, context: APPROVAL_CONTEXT, description: description.slice(0, 135) });
  return { state, description };
}
