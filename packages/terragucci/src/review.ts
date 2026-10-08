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
 * On GitLab a merge request's approvals name no commit, so an approval counts
 * only when it came after the merge request's latest version (its newest
 * push): the approval's system note is newer than the newest entry of
 * `merge_requests/:iid/versions`, whose head is the head reviewed. The
 * approver is not the author and holds Developer access or more; an
 * approval withdrawn later, or a later request for changes, counts for
 * nothing.
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
import { approvalOf, MAY_APPLY, type Review } from "./comment-apply";
import { ConfigError } from "./config";
import { changesSomething } from "./report/changing";
import { parseMarker, type NoteWaves } from "./report/marker";
import type { Fetch } from "./forge";

/** The status a pull request's head carries under pr-review. */
export const APPROVAL_CONTEXT = "terragucci/approval";

export { changesSomething, destroysSomething } from "./report/changing";
export { noteMarker, parseMarker, WAVES_MARKER, type NoteWaves } from "./report/marker";

/** The review digest: the set digest over the members whose plan changes something. Null when none does. */
export function reviewDigest(members: readonly { member: string; planDigest: string; plan: unknown }[]): string | null {
  const changing = members.filter((m) => changesSomething(m.plan));
  return changing.length === 0 ? null : changeSetDigest(changing.map(({ member, planDigest }) => ({ member, planDigest })));
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

/** The reviewers who approved the pull request's head, and those whose latest review asks for changes. */
export async function reviewsOf(f: ForgeCalls, pr: ReviewedPull, forge: "github" | "forgejo"): Promise<{ by: string[]; changes: string[] }> {
  const reviews: Review[] = await f.get(`repos/${f.repo}/pulls/${pr.number}/reviews?per_page=100&limit=50`);
  const mayWrite = async (login: string): Promise<boolean> => {
    // Forgejo marks a review by someone with write access as official, which approvalOf reads.
    if (forge === "forgejo") return true;
    try {
      const p = (await f.get(`repos/${f.repo}/collaborators/${encodeURIComponent(login)}/permission`))?.permission;
      return typeof p === "string" && MAY_APPLY.has(p);
    } catch {
      return false;
    }
  };
  return approvalOf(Array.isArray(reviews) ? reviews : [], pr.author, pr.head, mayWrite);
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

/** GitLab's access level for Developer, the least that may push. */
const DEVELOPER = 30;

/**
 * A merged merge request's approvals that count, read from GitLab: the merge
 * request whose merge (or squash) commit is `sha`, or the one `TG_PR` names
 * when the job applies an open merge request before it merges.
 */
export async function gitlabReviews(f: ForgeCalls, sha: string, env: NodeJS.ProcessEnv = {}): Promise<{ pr: ReviewedPull; by: string[]; changes: string[]; note?: NoteWaves; own?: string } | undefined> {
  const named = (env.TG_PR ?? "").trim();
  let mr: any;
  if (/^\d+$/.test(named)) mr = await f.get(`${f.repo}/merge_requests/${named}`);
  else {
    const list = await f.get(`${f.repo}/repository/commits/${sha}/merge_requests`);
    mr = (Array.isArray(list) ? list : []).find((m: any) => m?.state === "merged" && (m?.merge_commit_sha === sha || m?.squash_commit_sha === sha));
  }
  if (!mr || !Number.isInteger(mr.iid)) return undefined;
  return gitlabApprovals(f, mr);
}

/**
 * A merge request's approvals that count: its latest version (the head
 * reviewed), and each user's latest approval note, counted when it is newer
 * than that version and its author is not the merge request's and holds
 * Developer or more. A later request for changes is named in `changes`.
 */
export async function gitlabApprovals(f: ForgeCalls, mr: any): Promise<{ pr: ReviewedPull; by: string[]; changes: string[]; note?: NoteWaves; own?: string }> {
  // The token's own user: its approval is the pipeline's, never a reviewer's. Unknown, no approval counts.
  let me: any;
  try {
    me = await f.get("user");
  } catch (e) {
    throw new Error(`could not read which user the job's token acts as, so no approval counts (${(e as Error).message})`);
  }
  if (!Number.isInteger(me?.id)) throw new Error("GitLab did not say which user the job's token acts as, so no approval counts");
  const versions = await f.get(`${f.repo}/merge_requests/${mr.iid}/versions`);
  const latest = (Array.isArray(versions) ? versions : []).reduce((a: any, v: any) => (!a || Date.parse(v?.created_at) > Date.parse(a.created_at) ? v : a), undefined);
  const head = latest?.head_commit_sha ?? mr.sha;
  const pr: ReviewedPull = { number: mr.iid, head, ...(typeof mr.author?.username === "string" ? { author: mr.author.username } : {}) };
  const since = latest ? Date.parse(latest.created_at) : Number.POSITIVE_INFINITY;
  const notes = await f.get(`${f.repo}/merge_requests/${mr.iid}/notes?per_page=100&sort=asc&order_by=created_at`);
  const said = new Map<string, { what: "approved" | "unapproved" | "changes"; at: number; id: number }>();
  let note: NoteWaves | undefined;
  let own: string | undefined;
  for (const n of Array.isArray(notes) ? notes : []) {
    if (!n?.system) {
      const w = parseMarker(n?.body);
      if (w && w.head === head) note = w;
      continue;
    }
    const who = n.author?.username;
    if (typeof who !== "string" || who === pr.author) continue;
    const body = String(n.body ?? "").trim();
    const what = /^approved this merge request/.test(body) ? "approved" : /^unapproved this merge request/.test(body) ? "unapproved" : /^requested changes/.test(body) ? "changes" : undefined;
    if (n.author?.id === me.id || who === me.username) {
      if (what === "approved") own = who;
      continue;
    }
    const at = Date.parse(n.created_at);
    if (!what || !Number.isFinite(at)) continue;
    const before = said.get(who);
    if (!before || at >= before.at) said.set(who, { what, at, id: n.author?.id });
  }
  const by: string[] = [];
  const changes: string[] = [];
  for (const [who, last] of said) {
    if (last.what === "changes") changes.push(who);
    if (last.what !== "approved" || !(last.at > since)) continue;
    try {
      const member = await f.get(`${f.repo}/members/all/${last.id}`);
      if ((member?.access_level ?? 0) >= DEVELOPER) by.push(who);
    } catch {
      // Not a member: the approval does not count.
    }
  }
  return { pr, by: by.sort(), changes: changes.sort(), ...(note ? { note } : {}), ...(own ? { own } : {}) };
}

/** What a wave the gate holds gets from the review path. */
export type ReviewOutcome =
  | { kind: "approved"; pr: number; head: string; by: string[] }
  /** The reviewed digest differs from the one planned now. */
  | { kind: "moved"; pr: number; head: string; by: string[]; reviewed: string }
  /**
   * Nothing to go on: no pull request, no approval of its head, or no row for
   * the wave in its note. `review` names the pull request when an approving
   * review of its head would still count: its note has a digest for the wave,
   * and the forge takes a review of it (GitLab refuses an approval once a
   * merge request merged).
   */
  | { kind: "none"; why: string; review?: { pr: number; url: string } };

/** The page where a reviewer approves the pull request: GitHub's and Forgejo's Files changed tab, GitLab's merge request. */
export function reviewUrl(env: NodeJS.ProcessEnv, forge: "github" | "forgejo" | "gitlab", pr: number): string | undefined {
  if (forge === "gitlab") return env.CI_PROJECT_URL ? `${env.CI_PROJECT_URL}/-/merge_requests/${pr}` : undefined;
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY) return undefined;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/${forge === "github" ? "pull" : "pulls"}/${pr}/files`;
}

/** Decide one wave by the merged pull request's reviews. Never throws: a forge it cannot read leaves the wave waiting, with the reason. */
export async function reviewWave(o: { env: NodeJS.ProcessEnv; fetch?: Fetch; forge: "github" | "forgejo" | "gitlab"; sha: string; wave: number; digest: string | null }): Promise<ReviewOutcome> {
  try {
    let pr: ReviewedPull | undefined;
    let by: string[];
    let changes: string[];
    let note: NoteWaves | undefined;
    // A merge request named by TG_PR is open (applied before it merges); GitLab takes no approval of a merged one.
    let reviewable = true;
    if (o.forge === "gitlab") {
      const got = await gitlabReviews(gitlabCalls(o.env, o.fetch), o.sha, o.env);
      if (!got) return { kind: "none", why: `no merged merge request made ${o.sha.slice(0, 8)}` };
      ({ pr, by, changes, note } = got);
      reviewable = /^\d+$/.test((o.env.TG_PR ?? "").trim());
      const own = got.own ? `; the approval by ${got.own}, the user the job's token acts as, never counts` : "";
      if (by.length === 0 && changes.length === 0) return { kind: "none", why: `no member other than its author approved merge request ${pr.number} after its latest push, ${pr.head.slice(0, 8)}${own}`, ...reviewOf(o, pr.number, note, reviewable) };
    } else {
      const f = forgeCalls(o.env, o.fetch);
      pr = await pullOf(f, o.env, o.sha);
      if (!pr) return { kind: "none", why: `no merged pull request made ${o.sha.slice(0, 8)}` };
      ({ by, changes } = await reviewsOf(f, pr, o.forge));
      note = await noteWavesOf(f, pr);
    }
    if (changes.length > 0) return { kind: "none", why: `${changes.join(", ")} asked for changes on pull request ${pr.number}`, ...reviewOf(o, pr.number, note, reviewable) };
    if (by.length === 0) return { kind: "none", why: `no reviewer other than its author approved head ${pr.head.slice(0, 8)} of pull request ${pr.number}`, ...reviewOf(o, pr.number, note, reviewable) };
    const row = note?.waves.find((w) => w.number === o.wave);
    if (!row || !row.digest) return { kind: "none", why: `the plan note of head ${pr.head.slice(0, 8)} has no digest for wave ${o.wave}, so its review did not cover these plans` };
    if (o.digest !== null && row.digest === o.digest) return { kind: "approved", pr: pr.number, head: pr.head, by };
    return { kind: "moved", pr: pr.number, head: pr.head, by, reviewed: row.digest };
  } catch (e) {
    return { kind: "none", why: `the reviews could not be read (${(e as Error).message})` };
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
export async function approvalStatus(o: { env?: NodeJS.ProcessEnv; fetch?: Fetch; forge: "github" | "forgejo"; report?: string }): Promise<{ state: "pending" | "success"; description: string }> {
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
    const { by, changes } = await reviewsOf(f, pr, o.forge);
    const which = `wave ${waits.join(", ")}`;
    if (changes.length === 0 && by.length > 0) {
      state = "success";
      description = `${which} approved on ${pr.head.slice(0, 8)} by ${by.join(", ")}`;
    } else {
      state = "pending";
      description = `${which} waits: approve this pull request on ${pr.head.slice(0, 8)}`;
    }
  }
  await f.post(`repos/${f.repo}/statuses/${pr.head}`, { state, context: APPROVAL_CONTEXT, description: description.slice(0, 135) });
  return { state, description };
}
