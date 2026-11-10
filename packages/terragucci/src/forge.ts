/**
 * The little terragucci asks of a forge's API: the default branch, and an
 * open pull (or merge) request from a branch, found or opened. `fetch` is
 * injectable so the clients are tested against recorded requests.
 *
 * Pull requests, notes, statuses, replies and the drift issue go through
 * chant's forge clients (`@intentius/chant/pr-forge`): poster, with the job's TG_TOKEN, or
 * chant's `forgeClient` for a target built with `forgeTargetFromFlags` or `jobForgeTarget`
 * (chant issue 4888). What they say stays with terragucci.
 */
import { forgeTargetFromFlags } from "@intentius/chant/forge-flags";
import { ForgeEnvironmentError, forgeClient, forgeTargetFromEnv, type ForgeTarget, type PrForge, type ReadCommitStatus } from "@intentius/chant/pr-forge";
import { forgeReadsFor, type ForgeReads } from "@intentius/chant/pr-forge-reads";
import { ConfigError, type ForgeName } from "./config";

export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

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

/**
 * chant's target for the repository at `origin` and `path` the config or the
 * origin remote names, with `token`. A target with no token reads a public
 * repository and sends no credential.
 */
export function targetAt(forge: ForgeName, origin: string, path: string, token: string): ForgeTarget {
  return forgeTargetFromFlags({ forge, repo: path, url: origin, ...(token ? { token } : {}) }, {}, { tokenOptional: true });
}

/** The repo's default branch, as chant's forge client reads it (chant#4554). */
export async function defaultBranch(fetch: Fetch, t: ForgeTarget): Promise<string> {
  const forge = forgeClient(t, fetch);
  if (!forge.defaultBranch) throw new ForgeError(`chant's ${t.kind} client reads no default branch`);
  return forge.defaultBranch();
}

/**
 * Each context's newest status on `sha`, as chant's forge client reads it
 * (chant#4554); with `ref`, GitLab's statuses of that ref alone (chant#4584).
 */
export async function commitStatuses(forge: PrForge, sha: string, ref?: string): Promise<ReadCommitStatus[]> {
  if (!forge.commitStatuses) throw new ForgeError("the forge client reads no commit statuses");
  return forge.commitStatuses(sha, ref);
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
  const forge = forgeClient(t, fetch);
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

/** chant's reads for the forge a job runs on, with the job's TG_TOKEN (or the variable `tokenEnv` names), as poster builds its client. */
export function jobReads(kind: ForgeName, env: NodeJS.ProcessEnv, fetch?: Fetch, tokenEnv = "TG_TOKEN"): ForgeReads {
  try {
    return forgeReadsFor(forgeTargetFromEnv(env, { kind, tokenEnv }), fetch);
  } catch (e) {
    if (e instanceof ForgeEnvironmentError) throw new ConfigError(e.message);
    throw e;
  }
}

/** The environment variable a forge's token is read from when the config names none. */
export const DEFAULT_TOKEN_ENV: Record<ForgeName, string> = {
  github: "GITHUB_TOKEN",
  gitlab: "GITLAB_TOKEN",
  forgejo: "FORGEJO_TOKEN",
};
