/**
 * `terragucci plan-note`: terragucci's own line in the plan note on GitHub
 * and Forgejo, which chant's note job posts (terragucci issue 1411).
 *
 * The note job is chant's (the product plan, ./product-plan.ts): it takes
 * the plan job's report, renders the hand-off `terragucci plan-handoff`
 * wrote, and posts the note and `terragucci/plan` with `pr-post`. Before it
 * posts, this command runs in the same job, which holds the token and none
 * of the change's code, and writes the notice naming whose review would not
 * count toward a wave's approval into the file chant adds under the note's
 * counts (`CHANT_PLAN_NOTE_NOTICES`).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobReads, type Fetch } from "./forge";
import { pullInvolvement, sameLogin } from "./involved";

export interface PlanNoteOptions {
  forge: "github" | "forgejo";
  /** The plan job's report directory, as the note job took it back. */
  report: string;
  /** The file chant reads the notices from, one a line. */
  notices: string;
  /** `agent.login`, as the pipeline was written with it: the agent's account, whose review never counts. */
  agentLogin?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  log?: (line: string) => void;
}

/**
 * The note's line naming whose review of this pull request would not count,
 * when a wave of it will wait for an approval: the people who had a hand in
 * the change (./involved.ts). Undefined when no wave waits or nobody is named.
 */
export async function notCountingNotice(reportText: string | undefined, pr: number, sha: string, forge: "github" | "forgejo", env: NodeJS.ProcessEnv, doFetch: Fetch, log: (l: string) => void, agentLogin?: string): Promise<string | undefined> {
  let waits = false;
  try {
    waits = ((JSON.parse(reportText ?? "null") as { waves?: { waits?: boolean }[] } | null)?.waves ?? []).some((w) => w.waits === true);
  } catch {
    waits = false;
  }
  if (!waits) return undefined;
  try {
    const reads = jobReads(forge, env, doFetch);
    const raw = await reads.pullRequest(pr);
    const inv = await pullInvolvement({ forge, reads, pr: { number: pr, head: sha, ...(raw?.author ? { author: raw.author } : {}) }, env, fetch: doFetch, ...(agentLogin ? { agentLogin } : {}) });
    // Logins only: an address from a commit is not repeated on the pull request.
    const named: { who: string; why: string }[] = [];
    for (const p of inv.people) if (!p.who.includes("@") && !named.some((n) => sameLogin(n.who, p.who))) named.push(p);
    if (named.length === 0) return undefined;
    return `A review by ${named.map((n) => n.who).join(", ")} doesn't count toward the gate, because ${named.length === 1 ? "they" : "each"} had a hand in this change: ${named.map((n) => n.why).join("; ")}.`;
  } catch (e) {
    log(`terragucci plan-note: the people behind the change could not be read (${(e as Error).message})`);
    return undefined;
  }
}

/** Write the notice for the note, when there is one. A forge call that fails is said and never fails the job. */
export async function writePlanNoteNotices(o: PlanNoteOptions): Promise<string[]> {
  const env = o.env ?? process.env;
  const doFetch: Fetch = o.fetch ?? (globalThis.fetch as unknown as Fetch);
  const said: string[] = [];
  const log = o.log ?? ((l: string) => said.push(l));
  const pr = (env.TG_PR ?? "").trim();
  const sha = (env.TG_SHA ?? "").trim();
  if (!/^\d+$/.test(pr) || !/^[0-9a-f]{40}$/.test(sha)) {
    log("terragucci plan-note: TG_PR and TG_SHA must name the pull request and its head, so the note gets no notice");
    return said;
  }
  const file = join(o.report, "report.json");
  const who = await notCountingNotice(existsSync(file) ? readFileSync(file, "utf-8") : undefined, Number(pr), sha, o.forge, env, doFetch, log, o.agentLogin);
  if (who && o.notices) {
    appendFileSync(o.notices, `${who}\n`);
    log(`terragucci plan-note: the note says whose review does not count`);
  }
  return said;
}
