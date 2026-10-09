/**
 * What a rollout asks each project's forge: the newest pull request from a
 * wave's branch in any state, opening one, and the checks on the commit a
 * merge made. GitHub, GitLab and Forgejo answer through their own APIs, with
 * the same `fetch` the rest of terragucci uses.
 */
import { call, ForgeError, openPullRequest, type Fetch, type ForgeTarget } from "../forge";

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
          let list: Pull[];
          try {
            list = (await get(`/repos/${t.path}/pulls?state=all&limit=50&page=${page}`)) as Pull[];
          } catch (e) {
            // Forgejo answers 404 for the pull requests of an empty repo, and
            // for a moment after its first push; that repo has none.
            if (!(e instanceof ForgeError && e.status === 404 && ((await get(`/repos/${t.path}`)) as { empty?: boolean }).empty === true)) throw e;
            list = [];
          }
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

    async listPullRequests(prefix) {
      const out: ListedPullRequest[] = [];
      if (t.forge === "gitlab") {
        for (let page = 1; page <= LIST_LIMIT / 100; page++) {
          const list = (await get(`/projects/${id}/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=100&page=${page}`)) as Array<{ web_url: string; title?: string; state: string; description?: string | null; source_branch?: string }>;
          for (const mr of list) {
            if (!mr.source_branch?.startsWith(prefix)) continue;
            out.push({ branch: mr.source_branch, url: mr.web_url, title: mr.title ?? "", state: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed", body: mr.description ?? "" });
          }
          if (list.length < 100) break;
        }
        return out;
      }
      type Pull = { html_url: string; title?: string; state: string; merged?: boolean; merged_at?: string | null; body?: string | null; head?: { ref?: string } };
      const size = t.forge === "github" ? 100 : 50;
      for (let page = 1; page <= LIST_LIMIT / size; page++) {
        let list: Pull[];
        try {
          list = (await get(t.forge === "github" ? `/repos/${t.path}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}` : `/repos/${t.path}/pulls?state=all&sort=recentupdate&limit=50&page=${page}`)) as Pull[];
        } catch (e) {
          // Forgejo answers 404 for the pull requests of an empty repo.
          if (!(t.forge === "forgejo" && e instanceof ForgeError && e.status === 404 && ((await get(`/repos/${t.path}`)) as { empty?: boolean }).empty === true)) throw e;
          list = [];
        }
        for (const pr of list) {
          const branch = pr.head?.ref;
          if (!branch?.startsWith(prefix)) continue;
          const merged = pr.merged === true || !!pr.merged_at;
          out.push({ branch, url: pr.html_url, title: pr.title ?? "", state: merged ? "merged" : pr.state === "open" ? "open" : "closed", body: pr.body ?? "" });
        }
        if (list.length < size) break;
      }
      return out;
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
