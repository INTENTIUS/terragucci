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
 * `terragucci approval-status` posts the `terragucci/approval` status on the
 * head: pending while a wave the gate will hold has no approving review of
 * that head, success otherwise, so branch protection can require it.
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

/** What a wave the gate holds gets from the review path. */
export type ReviewOutcome =
  | { kind: "approved"; pr: number; head: string; by: string[] }
  /** The reviewed digest differs from the one planned now. */
  | { kind: "moved"; pr: number; head: string; by: string[]; reviewed: string }
  /** Nothing to go on: no pull request, no approval of its head, or no row for the wave in its note. */
  | { kind: "none"; why: string };

/** Decide one wave by the merged pull request's reviews. Never throws: a forge it cannot read leaves the wave waiting, with the reason. */
export async function reviewWave(o: { env: NodeJS.ProcessEnv; fetch?: Fetch; forge: "github" | "forgejo"; sha: string; wave: number; digest: string | null }): Promise<ReviewOutcome> {
  try {
    const f = forgeCalls(o.env, o.fetch);
    const pr = await pullOf(f, o.env, o.sha);
    if (!pr) return { kind: "none", why: `no merged pull request made ${o.sha.slice(0, 8)}` };
    const { by, changes } = await reviewsOf(f, pr, o.forge);
    if (changes.length > 0) return { kind: "none", why: `${changes.join(", ")} asked for changes on pull request ${pr.number}` };
    if (by.length === 0) return { kind: "none", why: `no reviewer other than its author approved head ${pr.head.slice(0, 8)} of pull request ${pr.number}` };
    const note = await noteWavesOf(f, pr);
    const row = note?.waves.find((w) => w.number === o.wave);
    if (!row || !row.digest) return { kind: "none", why: `the plan note of head ${pr.head.slice(0, 8)} has no digest for wave ${o.wave}, so its review did not cover these plans` };
    if (o.digest !== null && row.digest === o.digest) return { kind: "approved", pr: pr.number, head: pr.head, by };
    return { kind: "moved", pr: pr.number, head: pr.head, by, reviewed: row.digest };
  } catch (e) {
    return { kind: "none", why: `the reviews could not be read (${(e as Error).message})` };
  }
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
