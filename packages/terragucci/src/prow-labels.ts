/**
 * `approval: prow-labels` (runtime: prow): Prow's lgtm and approved labels
 * approve a wave.
 *
 * In a Prow repository a reviewer comments `/lgtm` and an owner `/approve`;
 * Prow's plugins put the `lgtm` and `approved` labels on the pull request,
 * and Tide merges it once both are there. A label names no plan, so it
 * approves a wave only through the plan note: the plan presubmit
 * (`prow.plan_before_merge`) writes each wave's review digest into the note
 * on the head, as under pr-review (./review.ts). After the merge, a wave the
 * gate holds reads the merged pull request: both labels on it, the people
 * whose latest `/lgtm` or `/approve` comment stands, less anyone with a
 * hand in the change (./involved.ts) and the jobs' own token, and the note's
 * digest for the wave. With at least one such person and the same digest
 * over the plans the wave just made, the wave applies, and the approval
 * names those people. A different digest means the plans moved after the
 * review, and the wave waits for a `terragucci approve` of its new plans,
 * as under ledger, and so does a wave the note has no row for.
 *
 * The labels say Prow's OWNERS rules were met; the people are read from the
 * comments only to name the approval and to leave out the people behind
 * the change, so a pull request approved by its own author alone, which
 * Prow can allow, approves no wave here.
 */
import { TOKEN_USERS } from "./comment-apply";
import { jobTokenEnv, type Fetch } from "./forge";
import { notCounted, type Excluded, type Involved } from "./involved";
import { jobForge, noteWavesOf, pullOf, type ReviewOutcome } from "./review";

/** The labels Prow's lgtm and approve plugins set, both of which Tide needs before it merges. */
export const PROW_LABELS = ["lgtm", "approved"] as const;

/** A comment's Prow command, as the lgtm and approve plugins read one: `/lgtm`, `/approve`, and their `cancel`. */
const COMMAND = /^\/(lgtm|approve)(?:\s+(\S+))?\s*$/i;

/**
 * Who stands behind the labels: each person whose latest `/lgtm` or
 * `/approve` was not cancelled, in the order they first commented. A
 * comment's lines are read one by one, as Prow reads them.
 */
export function labelApprovers(notes: readonly { body: string; author?: string; system?: boolean }[]): string[] {
  const standing = new Map<string, { lgtm: boolean; approve: boolean }>();
  for (const n of notes) {
    if (n.system || !n.author) continue;
    for (const line of n.body.split(/\r?\n/)) {
      const m = line.trim().match(COMMAND);
      if (!m) continue;
      const which = m[1]!.toLowerCase() as "lgtm" | "approve";
      const cancel = (m[2] ?? "").toLowerCase() === "cancel";
      const now = standing.get(n.author) ?? { lgtm: false, approve: false };
      now[which] = !cancel;
      standing.set(n.author, now);
    }
  }
  return [...standing].filter(([, s]) => s.lgtm || s.approve).map(([who]) => who);
}

/** The labels on a GitHub pull request, read with the job's token. */
async function labelsOf(env: NodeJS.ProcessEnv, doFetch: Fetch, pr: number): Promise<string[]> {
  const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
  const token = env[jobTokenEnv("github", env)];
  const r = await doFetch(`${api}/repos/${env.GITHUB_REPOSITORY}/issues/${pr}/labels?per_page=100`, {
    headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} to the pull request's labels`);
  const body = (await r.json()) as { name?: unknown }[];
  return Array.isArray(body) ? body.map((l) => (typeof l.name === "string" ? l.name : "")).filter(Boolean) : [];
}

/** Decide one wave by the merged pull request's Prow labels. Never throws: a forge it cannot read leaves the wave waiting, with the reason. */
export async function labelWave(o: { env: NodeJS.ProcessEnv; fetch?: Fetch; sha: string; wave: number; digest: string | null; covered?: string; involved?: Involved }): Promise<ReviewOutcome> {
  const doFetch: Fetch = o.fetch ?? (fetch as unknown as Fetch);
  try {
    const f = jobForge("github", o.env, doFetch);
    const pr = await pullOf(f, o.env, o.sha);
    if (!pr) return { kind: "none", why: `no merged pull request made ${o.sha.slice(0, 8)}` };
    const labels = await labelsOf(o.env, doFetch, pr.number);
    const missing = PROW_LABELS.filter((l) => !labels.includes(l));
    if (missing.length) return { kind: "none", why: `pull request ${pr.number} has no ${missing.join(" or ")} label` };
    const notes = await f.reads.pullRequestNotes(pr.number);
    const left = new Map<string, string>([
      ...[...TOKEN_USERS].map((login) => [login.toLowerCase(), `${login} is the pipeline's own token`] as [string, string]),
      ...(o.involved?.people ?? []).map((p) => [p.who.toLowerCase(), p.why] as [string, string]),
    ]);
    const excluded: Excluded[] = [];
    const by: string[] = [];
    for (const who of labelApprovers(notes)) {
      const why = left.get(who.toLowerCase());
      if (why) excluded.push({ login: who, reason: why });
      else by.push(who);
    }
    const out = (r: ReviewOutcome): ReviewOutcome => (excluded.length ? { ...r, excluded } : r);
    if (by.length === 0) {
      return out({ kind: "none", why: `pull request ${pr.number} has the lgtm and approved labels, and no /lgtm or /approve stands from someone with no hand in the change${excluded.length ? ` (${excluded.map((e) => notCounted(e, "approval")).join("; ")})` : ""}` });
    }
    const note = await noteWavesOf(f.reads, pr);
    const row = note?.waves.find((w) => w.number === o.wave);
    if (o.covered && (!row?.digest || row.digest === o.covered)) return out({ kind: "approved", pr: pr.number, head: pr.head, by });
    if (!row || !row.digest) return out({ kind: "none", why: `the plan note of head ${pr.head.slice(0, 8)} has no digest for wave ${o.wave}, so its labels did not cover these plans` });
    if (o.digest !== null && row.digest === o.digest) return out({ kind: "approved", pr: pr.number, head: pr.head, by });
    return out({ kind: "moved", pr: pr.number, head: pr.head, by, reviewed: row.digest });
  } catch (e) {
    return { kind: "none", why: `the labels could not be read (${(e as Error).message})` };
  }
}
