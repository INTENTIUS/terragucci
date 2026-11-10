/**
 * What a rollout asks each project's forge: the newest pull request from a
 * wave's branch in any state, opening one, and the checks on the commit a
 * merge made, through chant's forge client and reads, with the same `fetch`
 * the rest of terragucci uses.
 */
import { forgeClient, type ForgeTarget } from "@intentius/chant/pr-forge";
import { forgeReadsFor } from "@intentius/chant/pr-forge-reads";
import { commitStatuses, defaultBranch, openPullRequest, type Fetch } from "../forge";

export interface WavePullRequest {
  url: string;
  state: "open" | "merged" | "closed";
  body: string;
  /** The commit the merge made on the base branch, once merged. */
  mergeCommit?: string;
}

/** A pull request from a rollout's branch, as the list of the repo's pull requests gives it. */
export interface ListedPullRequest {
  branch: string;
  url: string;
  title: string;
  state: "open" | "merged" | "closed";
  body: string;
}

/** How many pull requests a list reads, newest update first: a wave that merged since the last run is among them. */
export const LIST_LIMIT = 500;

export interface CommitCheck {
  name: string;
  state: "success" | "pending" | "failure";
}

export interface RolloutForge {
  /** The default branch, which every wave's pull request targets. */
  defaultBranch(): Promise<string>;
  /** The newest pull request whose head is `branch`, in any state, or null. */
  findPullRequest(branch: string): Promise<WavePullRequest | null>;
  /** Open a pull request, or return the open one from `head`, and give its URL. */
  createPullRequest(pr: { base: string; head: string; title: string; body: string }): Promise<string>;
  /** The checks and statuses on a commit, newest per name. */
  commitChecks(sha: string): Promise<CommitCheck[]>;
  /** Pull requests in any state whose head branch starts with `prefix`, from the newest LIST_LIMIT by last update. */
  listPullRequests(prefix: string): Promise<ListedPullRequest[]>;
}

const STATE: Record<string, CommitCheck["state"]> = {
  success: "success",
  neutral: "success",
  skipped: "success",
  failure: "failure",
  failed: "failure",
  error: "failure",
  cancelled: "failure",
  canceled: "failure",
  timed_out: "failure",
  action_required: "failure",
  startup_failure: "failure",
  stale: "failure",
  warning: "failure",
};

const checkState = (s: string | undefined): CommitCheck["state"] => STATE[s ?? ""] ?? "pending";

export function fetchForge(fetch: Fetch, t: ForgeTarget): RolloutForge {
  const reads = forgeReadsFor(t, fetch);
  return {
    defaultBranch: () => defaultBranch(fetch, t),

    async findPullRequest(branch) {
      const pr = (await reads.pullRequestsFrom(branch, { limit: LIST_LIMIT }))[0];
      if (!pr) return null;
      return { url: pr.url ?? "", state: pr.state, body: pr.body, ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}) };
    },

    async listPullRequests(prefix) {
      const listed = await reads.pullRequestsFrom(prefix, { prefix: true, limit: LIST_LIMIT });
      return listed.map((pr) => ({ branch: pr.head, url: pr.url ?? "", title: pr.title, state: pr.state, body: pr.body }));
    },

    async createPullRequest(pr) {
      return (await openPullRequest(fetch, t, pr)).url;
    },

    async commitChecks(sha) {
      const checks: CommitCheck[] = [];
      // GitHub's check runs, newest per name, and each status's newest, through chant's client (chant#4554, chant#4809).
      for (const r of await reads.checkRuns(sha)) {
        checks.push({ name: r.name, state: r.status === "completed" ? (STATE[r.conclusion ?? ""] ?? "failure") : "pending" });
      }
      for (const st of await commitStatuses(forgeClient(t, fetch), sha)) checks.push({ name: st.context, state: checkState(st.state) });
      return checks;
    },
  };
}

/**
 * Whether a root has applied on a merge commit. A per-root check named
 * `apply/<root>` decides when there is one. Otherwise the `terragucci/apply`
 * status the apply jobs write decides: it turns success only once the last
 * wave has applied. Without it, every apply job counts: one per wave, named
 * `apply-wave-<n>` (or `apply` before waves), which GitHub and GitLab report
 * by that name and Forgejo as `<workflow> / apply-wave-<n> (push)`.
 */
export function appliedState(checks: CommitCheck[], root: string): CommitCheck["state"] {
  const own = checks.find((c) => c.name === `apply/${root}`);
  if (own) return own.state;
  const status = checks.find((c) => c.name === "terragucci/apply");
  if (status) return status.state;
  const jobs = checks.filter((c) => /(^|\/ )apply(-wave-\d+)?( \(|$)/.test(c.name));
  if (jobs.some((j) => j.state === "failure")) return "failure";
  if (jobs.length === 0 || jobs.some((j) => j.state === "pending")) return "pending";
  return "success";
}
