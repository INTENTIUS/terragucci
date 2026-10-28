/**
 * The little terragucci asks of a forge's API: the default branch, and an
 * open pull (or merge) request from a branch, found or opened. `fetch` is
 * injectable so the clients are tested against recorded requests.
 *
 * Pull requests, notes, statuses, replies and the drift issue go through
 * chant's forge clients (`@intentius/chant/pr-forge`): poster, with the job's TG_TOKEN, or
 * prForgeOf, for a target built here. What they say stays with terragucci.
 */
import { ForgeEnvironmentError, forgeClient, forgejoForge, forgeTargetFromEnv, githubForge, gitlabForge, type PrForge } from "@intentius/chant/pr-forge";
import { chantForgeReads } from "./chant-next";
import { ConfigError, type ForgeName } from "./config";

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

export class ForgeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function apiBase(t: ForgeTarget): string {
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
  if (!res.ok) throw new ForgeError(`${method} ${path} on ${t.origin} answered ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  return res.json();
}

/** The repo's default branch: chant's forge client reads it where the installed chant has the read (chant#4554). */
export async function defaultBranch(fetch: Fetch, t: ForgeTarget): Promise<string> {
  const read = chantForgeReads(prForgeOf(t, fetch)).defaultBranch;
  if (read) return read();
  if (t.forge === "gitlab") {
    const p = (await call(fetch, t, "GET", `/projects/${encodeURIComponent(t.path)}`)) as { default_branch?: string };
    return p.default_branch ?? "main";
  }
  const r = (await call(fetch, t, "GET", `/repos/${t.path}`)) as { default_branch?: string };
  return r.default_branch ?? "main";
}

/**
 * Open a pull request from `head` into `base`, or return the open one from
 * `head` already there, through chant's client: a pull request from a fork
 * with the same branch name is never taken for it.
 */
export async function openPullRequest(
  fetch: Fetch,
  t: ForgeTarget,
  pr: { head: string; base: string; title: string; body: string },
): Promise<PullRequest> {
  const forge = prForgeOf(t, fetch);
  const open = await forge.findPullRequest(pr.head);
  if (open) return { url: open.url ?? "", number: open.number, existing: true };
  const made = await forge.openPullRequest(pr);
  return { url: made.url ?? "", number: made.number, existing: false };
}

/**
 * chant's client for the forge a job runs on, holding the job's TG_TOKEN (or
 * the variable `tokenEnv` names): the repository, the API and the run's URL
 * from the CI environment. A missing variable is a ConfigError naming it.
 */
export function poster(kind: ForgeName, env: NodeJS.ProcessEnv, fetch?: Fetch, tokenEnv = "TG_TOKEN"): PrForge {
  try {
    return forgeClient(forgeTargetFromEnv(env, { kind, tokenEnv }), fetch);
  } catch (e) {
    if (e instanceof ForgeEnvironmentError) throw new ConfigError(e.message);
    throw e;
  }
}

/**
 * chant's client for a target terragucci built itself (report/drift.ts's
 * targetFromEnv). A target with no token reads a public repository and sends
 * no credential.
 */
export function prForgeOf(t: ForgeTarget, fetch?: Fetch): PrForge {
  const host = new URL(t.origin).host.toLowerCase();
  const common = { apiBase: apiBase(t), ...(t.token ? { token: t.token } : {}), host, ...(fetch ? { fetch } : {}) };
  if (t.forge === "gitlab") return gitlabForge({ ...common, project: t.path });
  if (t.forge === "forgejo") return forgejoForge({ ...common, repo: t.path });
  return githubForge({ ...common, repo: t.path });
}

/** The environment variable a forge's token is read from when the config names none. */
export const DEFAULT_TOKEN_ENV: Record<ForgeName, string> = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  forgejo: "FORGEJO_TOKEN",
};
