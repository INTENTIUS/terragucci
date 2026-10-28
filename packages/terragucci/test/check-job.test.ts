// An environment's apply job checks, before any token is traded, that it runs in its forge environment,
// on a branch it applies from and on its runner, and stops naming the expected and found values (#976).
import { describe, expect, it, vi } from "vitest";
import { CHECK_AUDIENCE, checkJob, describeJobCheck, jobSeen, runnerTags, tokenClaims, type JobExpectation } from "../src/check-job";
import { main } from "../src/cli";

// chant#4553: on chant's exit-code table a usage error is 1; terragucci's own table made it 2.
const USAGE = 1;

const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const tokenFetch = (claims: Record<string, unknown>) =>
  vi.fn(async (url: string) => {
    expect(url).toBe(`https://token.example/req?x=1&audience=${CHECK_AUDIENCE}`);
    return new Response(JSON.stringify({ value: jwt(claims) }));
  }) as unknown as typeof fetch;
const GH_TOKEN_ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/req?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" };

describe("check-job: GitHub", () => {
  const expect_: JobExpectation = { forge: "github", environment: "prod", forgeEnvironment: "prod", branches: ["main"], selfHosted: true };

  it("passes in its environment, on the default branch, on a self-hosted runner", async () => {
    const seen = await jobSeen(expect_, { ...GH_TOKEN_ENV, GITHUB_REF: "refs/heads/main" }, tokenFetch({ environment: "prod", runner_environment: "self-hosted" }));
    const r = checkJob(expect_, seen);
    expect(r.problems).toEqual([]);
    expect(r.checked).toEqual(["forge environment prod", "ref refs/heads/main", "self-hosted runner"]);
    expect(describeJobCheck(expect_, r)).toEqual({ ok: true, out: ["terragucci check-job: environment prod: forge environment prod, ref refs/heads/main, self-hosted runner"], err: [] });
  });

  it("refuses another environment, no environment, another branch and a hosted runner, naming both values", async () => {
    const seen = await jobSeen(expect_, { ...GH_TOKEN_ENV, GITHUB_REF: "refs/heads/feature" }, tokenFetch({ runner_environment: "github-hosted" }));
    const r = checkJob(expect_, seen);
    expect(r.problems).toEqual([
      "forge environment: expected prod, found none",
      "ref: expected refs/heads/main, found refs/heads/feature",
      "runner: expected self-hosted, found github-hosted",
    ]);
    const told = describeJobCheck(expect_, r);
    expect(told.ok).toBe(false);
    expect(told.err[0]).toBe("terragucci check-job: environment prod: forge environment: expected prod, found none");
    expect(told.err.at(-1)).toContain("stops before any cloud credential is taken");
    const other = checkJob(expect_, await jobSeen(expect_, { ...GH_TOKEN_ENV, GITHUB_REF: "refs/heads/main" }, tokenFetch({ environment: "dev", runner_environment: "self-hosted" })));
    expect(other.problems).toEqual(["forge environment: expected prod, found dev"]);
  });

  it("refuses when it may request no token to read its environment from", async () => {
    const r = checkJob(expect_, await jobSeen(expect_, { GITHUB_REF: "refs/heads/main", RUNNER_ENVIRONMENT: "self-hosted" }, vi.fn() as never));
    expect(r.problems).toEqual([expect.stringMatching(/^forge environment: expected prod, and it could not be read: the job may request no OIDC token/)]);
  });

  it("without --self-hosted the runner is not checked; without a token claim RUNNER_ENVIRONMENT says", async () => {
    const plain: JobExpectation = { forge: "github", environment: "dev", branches: ["main", "release"] };
    const r = checkJob(plain, await jobSeen(plain, { GITHUB_REF: "refs/heads/release", RUNNER_ENVIRONMENT: "github-hosted" }));
    expect(r).toEqual({ problems: [], checked: ["ref refs/heads/release"], skipped: [] });
    const hosted = { ...plain, selfHosted: true };
    expect(checkJob(hosted, await jobSeen(hosted, { GITHUB_REF: "refs/heads/main", RUNNER_ENVIRONMENT: "github-hosted" })).problems).toEqual(["runner: expected self-hosted, found github-hosted"]);
  });

  it("an empty default branch is a refusal, not a pass", () => {
    expect(checkJob({ forge: "github", environment: "prod", branches: [""] }, { ref: "refs/heads/main" }).problems).toEqual([expect.stringContaining("ref: no branch to apply from was given")]);
  });
});

describe("check-job: GitLab", () => {
  const expect_: JobExpectation = { forge: "gitlab", environment: "prod", forgeEnvironment: "production", branches: ["main"], runnerTags: ["self-hosted", "prod"] };
  const env = { CI_ENVIRONMENT_NAME: "production", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: '["prod", "self-hosted", "docker"]' };

  it("passes in its environment, on the protected default branch, on a runner with its tags", async () => {
    const r = checkJob(expect_, await jobSeen(expect_, env));
    expect(r).toEqual({ problems: [], checked: ["forge environment production", "ref main", "protected ref", "runner tags self-hosted, prod"], skipped: [] });
  });

  it("refuses each mismatch, naming the expected and found values", async () => {
    const r = checkJob(expect_, await jobSeen(expect_, { CI_ENVIRONMENT_NAME: "", CI_COMMIT_REF_NAME: "feature", CI_COMMIT_REF_PROTECTED: "false", CI_RUNNER_TAGS: '["self-hosted", "dev"]' }));
    expect(r.problems).toEqual([
      "forge environment: expected production, found none",
      "ref: expected main, found feature",
      "ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found false",
      "runner: expected tags self-hosted, prod, found self-hosted, dev",
    ]);
    expect(checkJob(expect_, await jobSeen(expect_, { ...env, CI_RUNNER_TAGS: undefined })).problems).toEqual(["runner: expected tags self-hosted, prod, and the job has no CI_RUNNER_TAGS"]);
  });

  it("reads CI_RUNNER_TAGS as a JSON array or a comma-separated list", () => {
    expect(runnerTags('["a", "b"]')).toEqual(["a", "b"]);
    expect(runnerTags("a, b")).toEqual(["a", "b"]);
    expect(runnerTags("")).toEqual([]);
    expect(runnerTags(undefined)).toBeUndefined();
  });
});

describe("check-job: Forgejo", () => {
  it("checks the ref, and the runner when the runner says; no forge environment", async () => {
    const e: JobExpectation = { forge: "forgejo", environment: "prod", forgeEnvironment: "prod", branches: ["main"], selfHosted: true };
    const r = checkJob(e, await jobSeen(e, { GITHUB_REF: "refs/heads/main" }));
    expect(r).toEqual({ problems: [], checked: ["ref refs/heads/main"], skipped: ["forge environment (Forgejo has none)", "runner (the runner says nothing about itself: no RUNNER_ENVIRONMENT)"] });
    expect(checkJob(e, { ref: "refs/heads/dev" }).problems).toEqual(["ref: expected refs/heads/main, found refs/heads/dev"]);
  });
});

describe("check-job: the command", () => {
  async function run(argv: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
    const saved = { ...process.env };
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    Object.assign(process.env, env);
    try {
      return { code: await main(argv), out: out.join("\n"), err: err.join("\n") };
    } finally {
      for (const k of Object.keys(env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      log.mockRestore();
      error.mockRestore();
    }
  }

  it("exits 0 when the job matches, 1 naming what does not, and the usage code on a usage error", async () => {
    const argv = ["check-job", "--forge", "gitlab", "--environment", "prod", "--forge-environment", "prod", "--branches", "main", "--runner-tags", "self-hosted,prod"];
    const ok = await run(argv, { CI_ENVIRONMENT_NAME: "prod", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: '["self-hosted","prod"]' });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("terragucci check-job: environment prod: forge environment prod");
    const bad = await run(argv, { CI_ENVIRONMENT_NAME: "dev", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: '["self-hosted","prod"]' });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("forge environment: expected prod, found dev");
    expect((await run(["check-job", "--forge", "gitlab"], {})).code).toBe(USAGE);
    // --self-hosted takes no value: the next flag is still read.
    const forgejo = await run(["check-job", "--forge", "forgejo", "--environment", "prod", "--self-hosted", "--branches", "main"], { GITHUB_REF: "refs/heads/main", RUNNER_ENVIRONMENT: "self-hosted" });
    expect(forgejo.code).toBe(0);
    expect(forgejo.out).toContain("self-hosted runner");
  });

  it("decodes a token's claims without its signature", () => {
    expect(tokenClaims(jwt({ environment: "prod" }))).toEqual({ environment: "prod" });
    expect(() => tokenClaims("nope")).toThrow(/not a JWT/);
  });
});
