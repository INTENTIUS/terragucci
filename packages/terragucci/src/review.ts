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
import type { ForgeReads } from "@intentius/chant/pr-forge-reads";
import { jobReads, poster, type Fetch } from "./forge";
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

/**
 * A forge's REST API, as the jobs call it with their own token: the review
 * agent's reads of a workflow run's jobs and artifacts (./review-agent.ts),
 * which chant's reads have no call for.
 */
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

/** chant's client and reads for the forge a job runs on, with the job's TG_TOKEN. */
export interface JobForge {
  client: PrForge;
  reads: ForgeReads;
}

export function jobForge(kind: "github" | "forgejo" | "gitlab", env: NodeJS.ProcessEnv, doFetch?: Fetch): JobForge {
  return { client: poster(kind, env, doFetch), reads: jobReads(kind, env, doFetch) };
}

/** A pull request as the review path reads it. */
export interface ReviewedPull {
  number: number;
  head: string;
  author?: string;
}

/**
 * The pull request (merge request on GitLab) a wave answers to: `TG_PR` when
 * the job names one (a comment's apply, or an apply before merge), else the
 * merged one the forge says made `sha`. Undefined when no merged pull request
 * made the commit (a direct push).
 */
export async function pullOf(f: JobForge, env: NodeJS.ProcessEnv, sha: string): Promise<ReviewedPull | undefined> {
  const named = (env.TG_PR ?? "").trim();
  const number = /^\d+$/.test(named) ? Number(named) : await f.client.pullRequestFor(sha);
  if (!number) return undefined;
  const pr = await f.reads.pullRequest(number);
  if (!pr?.headSha) return undefined;
  return { number: pr.number, head: pr.headSha, ...(pr.author ? { author: pr.author } : {}) };
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

/** The newest plan note marker of the pull request's head, read from its notes. */
export async function noteWavesOf(reads: ForgeReads, pr: ReviewedPull): Promise<NoteWaves | undefined> {
  let found: NoteWaves | undefined;
  for (const n of await reads.pullRequestNotes(pr.number)) {
    if (n.system) continue;
    const w = parseMarker(n.body);
    if (w && w.head === pr.head) found = w;
  }
  return found;
}

/**
 * A merged merge request's plan note, read from GitLab: the merge request
 * whose merge (or squash) commit is `sha`, or the one `TG_PR` names when the
 * job applies an open merge request before it merges.
 */
export async function gitlabReviews(f: JobForge, sha: string, env: NodeJS.ProcessEnv = {}): Promise<{ pr: ReviewedPull; note?: NoteWaves; own?: string } | undefined> {
  const pr = await pullOf(f, env, sha);
  return pr ? gitlabNotes(f.reads, pr) : undefined;
}

/**
 * What a merge request's notes say beside its approvals, which chant's
 * prApproved counts: the plan note marker of its head, and `own`, the token's
 * user when it approved (chant skips that approval without naming it).
 */
export async function gitlabNotes(reads: ForgeReads, pr: ReviewedPull): Promise<{ pr: ReviewedPull; note?: NoteWaves; own?: string }> {
  let me: { login: string; id?: number } | undefined;
  try {
    me = await reads.tokenUser();
  } catch (e) {
    throw new Error(`could not read which user the job's token acts as, so no approval counts (${(e as Error).message})`);
  }
  if (!me || !Number.isInteger(me.id)) throw new Error("GitLab did not say which user the job's token acts as, so no approval counts");
  let note: NoteWaves | undefined;
  let own: string | undefined;
  for (const n of await reads.pullRequestNotes(pr.number)) {
    if (!n.system) {
      const w = parseMarker(n.body);
      if (w && w.head === pr.head) note = w;
    } else if ((n.authorId === me.id || n.author === me.login) && /^approved this merge request/.test(n.body.trim())) own = n.author;
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
export async function reviewWave(o: { env: NodeJS.ProcessEnv; fetch?: Fetch; forge: "github" | "forgejo" | "gitlab"; sha: string; wave: number; digest: string | null; covered?: string; involved?: Involved }): Promise<ReviewOutcome> {
  let excluded: Excluded[] = [];
  const out = (r: ReviewOutcome): ReviewOutcome => (excluded.length ? { ...r, excluded } : r);
  try {
    let pr: ReviewedPull | undefined;
    let note: NoteWaves | undefined;
    // A merge request named by TG_PR is open (applied before it merges); GitLab takes no approval of a merged one.
    let reviewable = true;
    let own = "";
    if (o.forge === "gitlab") {
      const got = await gitlabReviews(jobForge("gitlab", o.env, o.fetch), o.sha, o.env);
      if (!got) return { kind: "none", why: `no merged merge request made ${o.sha.slice(0, 8)}` };
      ({ pr, note } = got);
      reviewable = /^\d+$/.test((o.env.TG_PR ?? "").trim());
      if (got.own) own = `; the approval by ${got.own}, the user the job's token acts as, never counts`;
    } else {
      const f = jobForge(o.forge, o.env, o.fetch);
      pr = await pullOf(f, o.env, o.sha);
      if (!pr) return { kind: "none", why: `no merged pull request made ${o.sha.slice(0, 8)}` };
      note = await noteWavesOf(f.reads, pr);
    }
    const got = await approvedBy(poster(o.forge, o.env, o.fetch), pr, o.involved);
    const by = got.by;
    excluded = got.excluded;
    if (by.length === 0) return out({ kind: "none", why: `${o.forge === "gitlab" ? "merge request" : "pull request"} ${pr.number} is not approved: ${got.reason}${own}`, ...reviewOf(o, pr.number, note, reviewable) });
    const row = note?.waves.find((w) => w.number === o.wave);
    // A covered round (`covered`, the digest of the pull request's plan it is covered by): the review of that plan approves it.
    // The note shows no digest for a wave that plans again once its upstreams apply, so the review of the head is that review.
    if (o.covered && (!row?.digest || row.digest === o.covered)) return out({ kind: "approved", pr: pr.number, head: pr.head, by });
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
  const reads = jobReads(o.forge, env, o.fetch);
  const number = (env.TG_PR ?? "").trim();
  if (!/^\d+$/.test(number)) throw new ConfigError("approval-status needs TG_PR, the pull request number");
  const raw = await reads.pullRequest(Number(number));
  const pr: ReviewedPull = { number: Number(number), head: env.TG_SHA || raw?.headSha || "", ...(raw?.author ? { author: raw.author } : {}) };
  if (typeof pr.head !== "string" || !pr.head) throw new ConfigError("approval-status needs the head commit: TG_SHA, or a pull request the forge names a head for");
  let waits: number[];
  if (o.report) {
    const report = JSON.parse(readFileSync(join(o.report, "report.json"), "utf-8")) as { waves?: { number: number; waits?: boolean }[] };
    waits = (report.waves ?? []).filter((w) => w.waits).map((w) => w.number);
  } else {
    const note = await noteWavesOf(reads, pr);
    waits = (note?.waves ?? []).filter((w) => w.waits).map((w) => w.number);
  }
  let state: "pending" | "success";
  let description: string;
  if (waits.length === 0) {
    state = "success";
    description = "no wave waits for an approval";
  } else {
    const involved = await pullInvolvement({ forge: o.forge, reads, pr, env, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.agentTokenEnv ? { agentTokenEnv: o.agentTokenEnv } : {}), ...(o.agentLogin ? { agentLogin: o.agentLogin } : {}) });
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
