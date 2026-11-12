/**
 * What terragucci still reads of a plan note and a GitLab plan job. chant's
 * note job posts the note and `terragucci/plan` on every forge (the product
 * plan, ./product-plan.ts); on GitLab it runs in the plan notes pipeline.
 *
 * - PLAN_MARK: the note's own line, `<!-- terragucci:plan roots=... -->`,
 *   under chant's marker, which a stale mark (./forge-post.ts) and the MCP
 *   server's note read (./mcp.ts) find the note by.
 * - planJobOf: the newest `plan` job of a merge request's head, whose report
 *   the review reads (./gitlab-agent.ts).
 */
import type { ForgeReads, ForgeUser, PullRequestNote, RunJob, WorkflowRun } from "@intentius/chant/pr-forge-reads";

/** The plan note's own line, as `pr-post` writes it under chant's marker. */
export const PLAN_MARK = "<!-- terragucci:plan";

/** True for a note the user `me` wrote. */
export const byUser = (n: PullRequestNote, me: ForgeUser): boolean => (me.id !== undefined && n.authorId === me.id) || (me.id === undefined && n.author === me.login);

/**
 * The newest pipeline of merge request `iid` at `head` (GitLab's merge
 * request pipelines run on `refs/merge-requests/<iid>/head`) and its newest
 * `plan` job, read through chant's reads.
 */
export async function planJobOf(reads: ForgeReads, iid: number, head: string): Promise<{ pipeline?: WorkflowRun; plan?: RunJob }> {
  const pipeline = (await reads.headRuns(head)).filter((p) => p.pullRequests.some((pr) => pr.number === iid)).sort((a, b) => b.id - a.id)[0];
  if (!pipeline) return {};
  const plan = (await reads.runJobs(pipeline.id)).filter((j) => j.name === "plan").sort((a, b) => b.id - a.id)[0];
  return { pipeline, ...(plan ? { plan } : {}) };
}
