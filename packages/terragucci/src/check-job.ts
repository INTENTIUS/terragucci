/**
 * `terragucci check-job`: the first lines of an environment's apply job
 * (./groups.ts) check that the job runs where the environment's apply is set
 * to run, before any token is traded with a cloud, and stop it otherwise.
 *
 * What the job is expected to see comes from the flags init renders into the
 * job, not from terragucci.yml in the job's checkout: the flags are what the
 * pipeline was rendered from, and the check reads no file of the commit it
 * runs on. What it sees comes from the forge:
 *
 *   forge environment  GitHub: the `environment` claim of an OIDC token the
 *                      check requests for its own audience (CHECK_AUDIENCE),
 *                      decodes and drops; GitHub sets no variable with the
 *                      job's environment. GitLab: CI_ENVIRONMENT_NAME.
 *                      Forgejo has no deployment environments: not checked.
 *   ref                GitHub and Forgejo: GITHUB_REF is refs/heads/<branch>
 *                      for one of the branches the job may apply from.
 *                      GitLab: CI_COMMIT_REF_NAME is one of them, and
 *                      CI_COMMIT_REF_PROTECTED is "true".
 *   runner             GitLab: CI_RUNNER_TAGS holds each of the job's tags.
 *                      GitHub and Forgejo expose no labels, only whether the
 *                      runner is self-hosted: with `--self-hosted`, the
 *                      token's runner_environment claim, else RUNNER_ENVIRONMENT,
 *                      is `self-hosted`. Neither set: not checked.
 *
 * The check catches a hand edit, a dropped `environment:` or a mistyped
 * label. Someone who can edit the workflow can delete it too: the forge's
 * environment and runner settings and the cloud role's trust are what keep a
 * job out.
 */
import type { ForgeName } from "./config";

/** The audience of the token the check requests on GitHub, which no cloud role should trust. */
export const CHECK_AUDIENCE = "terragucci-check-job";

/** Where an environment's apply job is expected to run. */
export interface JobExpectation {
  forge: ForgeName;
  /** The terragucci environment the job applies. */
  environment: string;
  /** The forge environment the job runs in (GitHub and GitLab). Unset: not checked. */
  forgeEnvironment?: string;
  /** The branches the job may apply from. */
  branches: string[];
  /** GitLab: the tags the job's runner must carry. */
  runnerTags?: string[];
  /** GitHub and Forgejo: the runner must be self-hosted. */
  selfHosted?: boolean;
}

/** What the job sees. Undefined: the forge did not say. */
export interface JobSeen {
  /** The job's forge environment; null when the job runs in none. */
  forgeEnvironment?: string | null;
  /** Why the forge environment could not be read, when it could not. */
  forgeEnvironmentError?: string;
  ref?: string;
  refProtected?: string;
  runnerTags?: string[];
  runnerEnvironment?: string;
}

export interface JobCheck {
  /** One line per value that does not match, naming the expected and found values. */
  problems: string[];
  /** What was checked and matched. */
  checked: string[];
  /** What the forge does not expose, so was not checked. */
  skipped: string[];
}

const shown = (v: string | null | undefined): string => (v === undefined || v === null || v === "" ? "none" : v);

/** The tags CI_RUNNER_TAGS lists: a JSON array, or a comma-separated list. */
export function runnerTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      const v = JSON.parse(t) as unknown;
      if (Array.isArray(v)) return v.map(String);
    } catch {
      // fall through to the plain list
    }
  }
  return t === "" ? [] : t.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** A JWT's claims, without checking its signature: the token came from the forge a moment ago and is used for nothing else. */
export function tokenClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("the forge's OIDC token is not a JWT");
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  const claims = JSON.parse(json) as unknown;
  if (!claims || typeof claims !== "object") throw new Error("the forge's OIDC token has no claims");
  return claims as Record<string, unknown>;
}

/** Compare what the job sees with what its environment expects. */
export function checkJob(expect: JobExpectation, seen: JobSeen): JobCheck {
  const out: JobCheck = { problems: [], checked: [], skipped: [] };
  const fe = expect.forgeEnvironment;
  if (fe !== undefined && expect.forge !== "forgejo") {
    if (seen.forgeEnvironmentError !== undefined) out.problems.push(`forge environment: expected ${fe}, and it could not be read: ${seen.forgeEnvironmentError}`);
    else if (seen.forgeEnvironment !== fe) out.problems.push(`forge environment: expected ${fe}, found ${shown(seen.forgeEnvironment)}`);
    else out.checked.push(`forge environment ${fe}`);
  } else if (expect.forge === "forgejo") out.skipped.push("forge environment (Forgejo has none)");

  const branches = expect.branches.filter((b) => b !== "");
  if (branches.length === 0) out.problems.push("ref: no branch to apply from was given (the default branch's name was empty)");
  else if (expect.forge === "gitlab") {
    if (!seen.ref || !branches.includes(seen.ref)) out.problems.push(`ref: expected ${branches.join(" or ")}, found ${shown(seen.ref)}`);
    else out.checked.push(`ref ${seen.ref}`);
    if (seen.refProtected !== "true") out.problems.push(`ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found ${shown(seen.refProtected)}`);
    else out.checked.push("protected ref");
  } else {
    const refs = branches.map((b) => `refs/heads/${b}`);
    if (!seen.ref || !refs.includes(seen.ref)) out.problems.push(`ref: expected ${refs.join(" or ")}, found ${shown(seen.ref)}`);
    else out.checked.push(`ref ${seen.ref}`);
  }

  if (expect.forge === "gitlab") {
    const want = expect.runnerTags ?? [];
    if (want.length > 0) {
      const have = seen.runnerTags;
      const missing = want.filter((t) => !(have ?? []).includes(t));
      if (have === undefined) out.problems.push(`runner: expected tags ${want.join(", ")}, and the job has no CI_RUNNER_TAGS`);
      else if (missing.length > 0) out.problems.push(`runner: expected tags ${want.join(", ")}, found ${have.length ? have.join(", ") : "none"}`);
      else out.checked.push(`runner tags ${want.join(", ")}`);
    }
  } else if (expect.selfHosted) {
    if (seen.runnerEnvironment === undefined) out.skipped.push("runner (the runner says nothing about itself: no RUNNER_ENVIRONMENT)");
    else if (seen.runnerEnvironment !== "self-hosted") out.problems.push(`runner: expected self-hosted, found ${seen.runnerEnvironment}`);
    else out.checked.push("self-hosted runner");
  }
  return out;
}

/** Ask GitHub for an OIDC token for CHECK_AUDIENCE and return its claims; the token itself is dropped. */
async function githubClaims(env: NodeJS.ProcessEnv, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) throw new Error("the job may request no OIDC token (no ACTIONS_ID_TOKEN_REQUEST_URL); it needs permissions: id-token: write");
  const r = await fetchFn(`${url}&audience=${encodeURIComponent(CHECK_AUDIENCE)}`, { headers: { authorization: `bearer ${bearer}` } });
  if (!r.ok) throw new Error(`the OIDC token request answered ${r.status}`);
  const value = ((await r.json()) as { value?: unknown }).value;
  if (typeof value !== "string") throw new Error("the OIDC token request answered no token");
  return tokenClaims(value);
}

/** What the job sees, from the forge's variables, and on GitHub from its token's claims when the forge environment is to be checked. */
export async function jobSeen(expect: JobExpectation, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<JobSeen> {
  if (expect.forge === "gitlab") {
    return {
      forgeEnvironment: env.CI_ENVIRONMENT_NAME || null,
      ...(env.CI_COMMIT_REF_NAME !== undefined ? { ref: env.CI_COMMIT_REF_NAME } : {}),
      ...(env.CI_COMMIT_REF_PROTECTED !== undefined ? { refProtected: env.CI_COMMIT_REF_PROTECTED } : {}),
      ...(env.CI_RUNNER_TAGS !== undefined ? { runnerTags: runnerTags(env.CI_RUNNER_TAGS) } : {}),
    };
  }
  const seen: JobSeen = { ...(env.GITHUB_REF !== undefined ? { ref: env.GITHUB_REF } : {}) };
  let claims: Record<string, unknown> | undefined;
  if (expect.forge === "github" && expect.forgeEnvironment !== undefined) {
    try {
      claims = await githubClaims(env, fetchFn);
      seen.forgeEnvironment = typeof claims.environment === "string" && claims.environment !== "" ? claims.environment : null;
    } catch (e) {
      seen.forgeEnvironmentError = (e as Error).message;
    }
  }
  const runner = typeof claims?.runner_environment === "string" ? claims.runner_environment : env.RUNNER_ENVIRONMENT;
  if (runner) seen.runnerEnvironment = runner;
  return seen;
}

/** The lines the command prints, and whether the job may go on. */
export function describeJobCheck(expect: JobExpectation, result: JobCheck): { ok: boolean; out: string[]; err: string[] } {
  const at = `terragucci check-job: environment ${expect.environment}`;
  if (result.problems.length > 0) {
    return {
      ok: false,
      out: [],
      err: [
        ...result.problems.map((p) => `${at}: ${p}`),
        `${at}: this job does not run where ${expect.environment}'s apply is set to run, so it stops before any cloud credential is taken`,
      ],
    };
  }
  return {
    ok: true,
    out: [`${at}: ${result.checked.length ? result.checked.join(", ") : "nothing to check"}${result.skipped.length ? `; not checked: ${result.skipped.join(", ")}` : ""}`],
    err: [],
  };
}
