/**
 * The little terragucci asks of a forge's API: find an open pull (or merge)
 * request from a branch, and open one. `fetch` is injectable so the clients
 * are tested against recorded requests.
 */
import type { ForgeName } from "./config";

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface ForgeTarget {
  forge: ForgeName;
  /** https://host or http://host:port, with no path. */
  origin: string;
  /** owner/name, or a GitLab group path and name. */
  path: string;
  token: string;
  /** The API's base URL, when the runner names it (GITHUB_API_URL) and the origin alone does not give it. */
  api?: string;
}

export interface PullRequest {
  url: string;
  number: number;
  existing: boolean;
}

export class ForgeError extends Error {}

function apiBase(t: ForgeTarget): string {
  if (t.api) return t.api.replace(/\/+$/, "");
  if (t.forge === "github") {
    return /^https?:\/\/github\.com$/i.test(t.origin) ? "https://api.github.com" : `${t.origin}/api/v3`;
  }
  if (t.forge === "gitlab") return `${t.origin}/api/v4`;
  return `${t.origin}/api/v1`;
}

function headers(t: ForgeTarget): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  // A public repo answers reads without a token.
  if (!t.token) return h;
  if (t.forge === "github") h.authorization = `Bearer ${t.token}`;
  else if (t.forge === "gitlab") h["private-token"] = t.token;
  else h.authorization = `token ${t.token}`;
  return h;
}

/** One API call; a status other than 2xx throws a ForgeError naming it. */
export async function call(fetch: Fetch, t: ForgeTarget, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${apiBase(t)}${path}`, { method, headers: headers(t), body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new ForgeError(`${method} ${path} on ${t.origin} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/** The repo's default branch. */
export async function defaultBranch(fetch: Fetch, t: ForgeTarget): Promise<string> {
  if (t.forge === "gitlab") {
    const p = (await call(fetch, t, "GET", `/projects/${encodeURIComponent(t.path)}`)) as { default_branch?: string };
    return p.default_branch ?? "main";
  }
  const r = (await call(fetch, t, "GET", `/repos/${t.path}`)) as { default_branch?: string };
  return r.default_branch ?? "main";
}

/** Open a pull request from `head` into `base`, or return the open one already there. */
export async function openPullRequest(
  fetch: Fetch,
  t: ForgeTarget,
  pr: { head: string; base: string; title: string; body: string },
): Promise<PullRequest> {
  if (t.forge === "gitlab") {
    const id = encodeURIComponent(t.path);
    const open = (await call(fetch, t, "GET", `/projects/${id}/merge_requests?state=opened&source_branch=${encodeURIComponent(pr.head)}`)) as Array<{ web_url: string; iid: number }>;
    if (open.length) return { url: open[0].web_url, number: open[0].iid, existing: true };
    const mr = (await call(fetch, t, "POST", `/projects/${id}/merge_requests`, {
      source_branch: pr.head,
      target_branch: pr.base,
      title: pr.title,
      description: pr.body,
    })) as { web_url: string; iid: number };
    return { url: mr.web_url, number: mr.iid, existing: false };
  }
  const owner = t.path.split("/")[0];
  const query = t.forge === "github" ? `?state=open&head=${encodeURIComponent(`${owner}:${pr.head}`)}` : `?state=open`;
  const open = (await call(fetch, t, "GET", `/repos/${t.path}/pulls${query}`)) as Array<{ html_url: string; number: number; head?: { ref?: string } }>;
  const mine = open.find((p) => t.forge === "github" || p.head?.ref === pr.head);
  if (mine) return { url: mine.html_url, number: mine.number, existing: true };
  const created = (await call(fetch, t, "POST", `/repos/${t.path}/pulls`, { head: pr.head, base: pr.base, title: pr.title, body: pr.body })) as {
    html_url: string;
    number: number;
  };
  return { url: created.html_url, number: created.number, existing: false };
}

/** The environment variable a forge's token is read from when the config names none. */
export const DEFAULT_TOKEN_ENV: Record<ForgeName, string> = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  forgejo: "FORGEJO_TOKEN",
};

export interface Issue {
  url: string;
  /** GitHub and Forgejo number; GitLab iid. */
  number: number;
  body: string;
}

const gitlabId = (t: ForgeTarget): string => encodeURIComponent(t.path);

/** The open issue whose body carries `marker`, if any. */
export async function findIssue(fetch: Fetch, t: ForgeTarget, marker: string): Promise<Issue | undefined> {
  if (t.forge === "gitlab") {
    const list = (await call(fetch, t, "GET", `/projects/${gitlabId(t)}/issues?state=opened&per_page=100`)) as Array<{ web_url: string; iid: number; description?: string | null }>;
    const hit = list.find((i) => (i.description ?? "").includes(marker));
    return hit ? { url: hit.web_url, number: hit.iid, body: hit.description ?? "" } : undefined;
  }
  const list = (await call(fetch, t, "GET", `/repos/${t.path}/issues?state=open&type=issues&per_page=100`)) as Array<{ html_url: string; number: number; body?: string | null; pull_request?: unknown }>;
  const hit = list.find((i) => !i.pull_request && (i.body ?? "").includes(marker));
  return hit ? { url: hit.html_url, number: hit.number, body: hit.body ?? "" } : undefined;
}

export async function openIssue(fetch: Fetch, t: ForgeTarget, issue: { title: string; body: string }): Promise<Issue> {
  if (t.forge === "gitlab") {
    const i = (await call(fetch, t, "POST", `/projects/${gitlabId(t)}/issues`, { title: issue.title, description: issue.body })) as { web_url: string; iid: number };
    return { url: i.web_url, number: i.iid, body: issue.body };
  }
  const i = (await call(fetch, t, "POST", `/repos/${t.path}/issues`, { title: issue.title, body: issue.body })) as { html_url: string; number: number };
  return { url: i.html_url, number: i.number, body: issue.body };
}

export async function updateIssue(fetch: Fetch, t: ForgeTarget, number: number, issue: { title: string; body: string }): Promise<void> {
  if (t.forge === "gitlab") await call(fetch, t, "PUT", `/projects/${gitlabId(t)}/issues/${number}`, { title: issue.title, description: issue.body });
  else await call(fetch, t, "PATCH", `/repos/${t.path}/issues/${number}`, { title: issue.title, body: issue.body });
}

/** Comment on an issue, then close it. */
export async function closeIssue(fetch: Fetch, t: ForgeTarget, number: number, comment: string): Promise<void> {
  if (t.forge === "gitlab") {
    await call(fetch, t, "POST", `/projects/${gitlabId(t)}/issues/${number}/notes`, { body: comment });
    await call(fetch, t, "PUT", `/projects/${gitlabId(t)}/issues/${number}`, { state_event: "close" });
    return;
  }
  await call(fetch, t, "POST", `/repos/${t.path}/issues/${number}/comments`, { body: comment });
  await call(fetch, t, "PATCH", `/repos/${t.path}/issues/${number}`, { state: "closed" });
}
