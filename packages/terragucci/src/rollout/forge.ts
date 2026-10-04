/**
 * What a rollout asks each project's forge: the newest pull request from a
 * wave's branch in any state, opening one, and the checks on the commit a
 * merge made. GitHub, GitLab and Forgejo answer through their own APIs, with
 * the same `fetch` the rest of terragucci uses.
 */
import { call, openPullRequest, type Fetch, type ForgeTarget } from "../forge";

export interface WavePullRequest {
  url: string;
  state: "open" | "merged" | "closed";
  body: string;
  /** The commit the merge made on the base branch, once merged. */
  mergeCommit?: string;
}

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

/** Keep the newest entry per name, by id. */
function newest<T extends { id?: number }>(items: T[], name: (t: T) => string): T[] {
  const best = new Map<string, T>();
  for (const it of items) {
    const n = name(it);
    const had = best.get(n);
    if (!had || (it.id ?? 0) > (had.id ?? 0)) best.set(n, it);
  }
  return [...best.values()];
}

export function fetchForge(fetch: Fetch, t: ForgeTarget): RolloutForge {
  const get = (path: string) => call(fetch, t, "GET", path);
  const id = encodeURIComponent(t.path);
  return {
    async defaultBranch() {
      if (t.forge === "gitlab") return ((await get(`/projects/${id}`)) as { default_branch?: string }).default_branch ?? "main";
      return ((await get(`/repos/${t.path}`)) as { default_branch?: string }).default_branch ?? "main";
    },

    async findPullRequest(branch) {
      if (t.forge === "gitlab") {
        const list = (await get(`/projects/${id}/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}&order_by=created_at&sort=desc`)) as Array<{
          web_url: string;
          state: string;
          description?: string | null;
          merge_commit_sha?: string | null;
          squash_commit_sha?: string | null;
          sha?: string;
        }>;
        const mr = list[0];
        if (!mr) return null;
        const state = mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed";
        // A fast-forward merge makes no merge commit; the head is then what main points at.
        const sha = mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha;
        return { url: mr.web_url, state, body: mr.description ?? "", ...(state === "merged" && sha ? { mergeCommit: sha } : {}) };
      }
      type Pull = { html_url: string; number: number; state: string; merged?: boolean; merged_at?: string | null; merge_commit_sha?: string | null; body?: string | null; head?: { ref?: string } };
      let found: Pull[] = [];
      if (t.forge === "github") {
        const owner = t.path.split("/")[0];
        found = (await get(`/repos/${t.path}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`)) as Pull[];
      } else {
        // Forgejo has no head filter on the list; read pages until one comes back short.
        for (let page = 1; page <= 20; page++) {
          const list = (await get(`/repos/${t.path}/pulls?state=all&limit=50&page=${page}`)) as Pull[];
          found.push(...list.filter((p) => p.head?.ref === branch));
          if (list.length < 50) break;
        }
      }
      const pr = found.sort((a, b) => b.number - a.number)[0];
      if (!pr) return null;
      const merged = pr.merged === true || !!pr.merged_at;
      const state = merged ? "merged" : pr.state === "open" ? "open" : "closed";
      return { url: pr.html_url, state, body: pr.body ?? "", ...(merged && pr.merge_commit_sha ? { mergeCommit: pr.merge_commit_sha } : {}) };
    },

    async createPullRequest(pr) {
      return (await openPullRequest(fetch, t, pr)).url;
    },

    async commitChecks(sha) {
      if (t.forge === "gitlab") {
        const list = (await get(`/projects/${id}/repository/commits/${sha}/statuses?per_page=100`)) as Array<{ id?: number; name: string; status: string }>;
        return newest(list, (s) => s.name).map((s) => ({ name: s.name, state: checkState(s.status) }));
      }
      const checks: CommitCheck[] = [];
      if (t.forge === "github") {
        const runs = (await get(`/repos/${t.path}/commits/${sha}/check-runs?per_page=100`)) as { check_runs?: Array<{ id?: number; name: string; status: string; conclusion?: string | null }> };
        for (const r of newest(runs.check_runs ?? [], (r) => r.name)) {
          checks.push({ name: r.name, state: r.status === "completed" ? (STATE[r.conclusion ?? ""] ?? "failure") : "pending" });
        }
      }
      const statuses = (await get(`/repos/${t.path}/commits/${sha}/statuses?${t.forge === "github" ? "per_page" : "limit"}=100`)) as Array<{
        id?: number;
        context: string;
        state?: string;
        status?: string;
      }>;
      for (const s of newest(statuses, (s) => s.context)) checks.push({ name: s.context, state: checkState(s.status ?? s.state) });
      return checks;
    },
  };
}

/**
 * Whether a root has applied on a merge commit. A per-root check named
 * `apply/<root>` decides when there is one. Otherwise the pipeline
 * terragucci writes applies every root in one job named `apply`, which
 * GitHub and GitLab report as `apply` and Forgejo as `<workflow> / apply (push)`.
 */
export function appliedState(checks: CommitCheck[], root: string): CommitCheck["state"] {
  const own = checks.find((c) => c.name === `apply/${root}`);
  if (own) return own.state;
  const job = checks.find((c) => c.name === "apply" || /(^|\/ )apply( \(|$)/.test(c.name));
  return job?.state ?? "pending";
}
