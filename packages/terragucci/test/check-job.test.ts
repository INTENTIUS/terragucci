// An environment's apply job checks, before any token is traded, that it runs in its forge environment,
// on a branch it applies from and on its runner, and stops naming the expected and found values (#976).
// The check is chant's apply-job guard (chant#4624), which tests its own reading of each forge; these
// tests check that terragucci hands it the environment's expectation and speaks in terragucci's words.
import { describe, expect, it, vi } from "vitest";
import { JOB_GUARD_AUDIENCE } from "@intentius/chant/ci-job-guard";
import { jobGuardSpecFor, runCheckJob, type JobExpectation } from "../src/check-job";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { main } from "../src/cli";

// chant#4553: on chant's exit-code table a usage error is 1; terragucci's own table made it 2.
const USAGE = 1;

const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const tokenFetch = (claims: Record<string, unknown>) =>
  vi.fn(async (url: string) => {
    expect(url).toBe(`https://token.example/req?x=1&audience=${JOB_GUARD_AUDIENCE}`);
    return new Response(JSON.stringify({ value: jwt(claims) }));
  }) as unknown as typeof fetch;
const GH_TOKEN_ENV = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example/req?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t" };

describe("check-job: the spec terragucci hands chant's guard", () => {
  it("names the environment and the product, and carries only the values set", () => {
    expect(jobGuardSpecFor({ forge: "gitlab", environment: "prod", forgeEnvironment: "prod", branches: ["main"], runnerTags: ["prod"] })).toEqual({ forge: "gitlab", job: "environment prod", product: "terragucci", branches: ["main"], forgeEnvironment: "prod", runnerTags: ["prod"] });
    expect(jobGuardSpecFor({ forge: "github", environment: "dev", branches: ["main", "release"], selfHosted: true })).toEqual({ forge: "github", job: "environment dev", product: "terragucci", branches: ["main", "release"], selfHosted: true });
  });
});

describe("check-job: GitHub", () => {
  const expect_: JobExpectation = { forge: "github", environment: "prod", forgeEnvironment: "prod", branches: ["main"], selfHosted: true };

  it("passes in its environment, on the default branch, on a self-hosted runner, asking for chant's audience", async () => {
    const told = await runCheckJob(expect_, { ...GH_TOKEN_ENV, GITHUB_REF: "refs/heads/main" }, tokenFetch({ environment: "prod", runner_environment: "self-hosted" }));
    expect(told).toEqual({ ok: true, out: ["terragucci check-job: environment prod: forge environment prod, ref refs/heads/main, self-hosted runner"], err: [] });
  });

  it("refuses another environment, no environment, another branch and a hosted runner, naming both values", async () => {
    const told = await runCheckJob(expect_, { ...GH_TOKEN_ENV, GITHUB_REF: "refs/heads/feature" }, tokenFetch({ runner_environment: "github-hosted" }));
    expect(told.ok).toBe(false);
    expect(told.err.slice(0, -1)).toEqual([
      "terragucci check-job: environment prod: forge environment: expected prod, found none",
      "terragucci check-job: environment prod: ref: expected refs/heads/main, found refs/heads/feature",
      "terragucci check-job: environment prod: runner: expected self-hosted, found github-hosted",
    ]);
    expect(told.err.at(-1)).toContain("stops before any credential is taken");
    const other = await runCheckJob(expect_, { ...GH_TOKEN_ENV, GITHUB_REF: "refs/heads/main" }, tokenFetch({ environment: "dev", runner_environment: "self-hosted" }));
    expect(other.err[0]).toBe("terragucci check-job: environment prod: forge environment: expected prod, found dev");
  });

  it("refuses when it may request no token to read its environment from", async () => {
    const told = await runCheckJob(expect_, { GITHUB_REF: "refs/heads/main", RUNNER_ENVIRONMENT: "self-hosted" }, vi.fn() as never);
    expect(told.err[0]).toMatch(/^terragucci check-job: environment prod: forge environment: expected prod, and it could not be read: the job may request no OIDC token/);
  });

  it("an empty default branch is a refusal, not a pass", async () => {
    const told = await runCheckJob({ forge: "github", environment: "prod", branches: [""] }, { GITHUB_REF: "refs/heads/main" });
    expect(told.ok).toBe(false);
    expect(told.err[0]).toContain("ref: ");
  });
});

describe("check-job: GitLab", () => {
  const expect_: JobExpectation = { forge: "gitlab", environment: "prod", forgeEnvironment: "production", branches: ["main"], runnerTags: ["self-hosted", "prod"] };
  const env = { CI_ENVIRONMENT_NAME: "production", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: '["prod", "self-hosted", "docker"]' };

  it("passes in its environment, on the protected default branch, on a runner with its tags", async () => {
    expect(await runCheckJob(expect_, env)).toEqual({ ok: true, out: ["terragucci check-job: environment prod: forge environment production, ref main, protected ref, runner tags self-hosted, prod"], err: [] });
  });

  it("refuses each mismatch, naming the expected and found values", async () => {
    const told = await runCheckJob(expect_, { CI_ENVIRONMENT_NAME: "", CI_COMMIT_REF_NAME: "feature", CI_COMMIT_REF_PROTECTED: "false", CI_RUNNER_TAGS: '["self-hosted", "dev"]' });
    expect(told.err.slice(0, -1).map((l) => l.replace("terragucci check-job: environment prod: ", ""))).toEqual([
      "forge environment: expected production, found none",
      "ref: expected main, found feature",
      "ref: expected a protected ref (CI_COMMIT_REF_PROTECTED true), found false",
      "runner: expected tags self-hosted, prod, found self-hosted, dev",
    ]);
  });
});

describe("check-job: Forgejo", () => {
  it("checks the ref, and the runner when the runner says; no forge environment", async () => {
    const e: JobExpectation = { forge: "forgejo", environment: "prod", forgeEnvironment: "prod", branches: ["main"], selfHosted: true };
    expect(await runCheckJob(e, { GITHUB_REF: "refs/heads/main" })).toEqual({ ok: true, out: ["terragucci check-job: environment prod: ref refs/heads/main; not checked: forge environment (Forgejo has none), runner (the runner says nothing about itself: no RUNNER_ENVIRONMENT)"], err: [] });
    expect((await runCheckJob(e, { GITHUB_REF: "refs/heads/dev" })).err[0]).toBe("terragucci check-job: environment prod: ref: expected refs/heads/main, found refs/heads/dev");
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

  it("exits 0 when the job matches, 9 (`misplaced`) naming what does not, and the usage code on a usage error", async () => {
    const argv = ["check-job", "--forge", "gitlab", "--environment", "prod", "--forge-environment", "prod", "--branches", "main", "--runner-tags", "self-hosted,prod"];
    const ok = await run(argv, { CI_ENVIRONMENT_NAME: "prod", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: '["self-hosted","prod"]' });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("terragucci check-job: environment prod: forge environment prod");
    const bad = await run(argv, { CI_ENVIRONMENT_NAME: "dev", CI_COMMIT_REF_NAME: "main", CI_COMMIT_REF_PROTECTED: "true", CI_RUNNER_TAGS: '["self-hosted","prod"]' });
    expect(bad.code).toBe(CHANT_EXIT.misplaced);
    expect(bad.err).toContain("forge environment: expected prod, found dev");
    expect((await run(["check-job", "--forge", "gitlab"], {})).code).toBe(USAGE);
    // --self-hosted takes no value: the next flag is still read.
    const forgejo = await run(["check-job", "--forge", "forgejo", "--environment", "prod", "--self-hosted", "--branches", "main"], { GITHUB_REF: "refs/heads/main", RUNNER_ENVIRONMENT: "self-hosted" });
    expect(forgejo.code).toBe(0);
    expect(forgejo.out).toContain("self-hosted runner");
  });
});
