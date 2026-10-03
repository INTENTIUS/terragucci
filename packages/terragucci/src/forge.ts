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
}

export interface PullRequest {
  url: string;
  number: number;
  existing: boolean;
}

export class ForgeError extends Error {}

function apiBase(t: ForgeTarget): string {
  if (t.forge === "github") {
    return /^https?:\/\/github\.com$/i.test(t.origin) ? "https://api.github.com" : `${t.origin}/api/v3`;
  }
  if (t.forge === "gitlab") return `${t.origin}/api/v4`;
  return `${t.origin}/api/v1`;
}

function headers(t: ForgeTarget): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  if (t.forge === "github") h.authorization = `Bearer ${t.token}`;
  else if (t.forge === "gitlab") h["private-token"] = t.token;
  else h.authorization = `token ${t.token}`;
  return h;
}

async function call(fetch: Fetch, t: ForgeTarget, method: string, path: string, body?: unknown): Promise<unknown> {
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
