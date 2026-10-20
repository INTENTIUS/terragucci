import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { bareFrom, git, tmp, twoRootRepo, write } from "./helpers";

/** Run the CLI in `dir` and return its exit code and stdout. */
async function run(dir: string, ...argv: string[]): Promise<{ code: number; out: string }> {
  const cwd = process.cwd();
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  process.chdir(dir);
  try {
    return { code: await main(argv), out: lines.join("\n") };
  } finally {
    process.chdir(cwd);
    log.mockRestore();
    err.mockRestore();
  }
}

/** Compare to test/golden/<name>.json; UPDATE_GOLDEN=1 rewrites it. Paths and temp dirs are not in the output. */
function golden(name: string, out: string): void {
  const path = join(__dirname, "golden", `${name}.json`);
  const text = `${JSON.stringify(JSON.parse(out), null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
}

function repo(): string {
  const dir = twoRootRepo();
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
  return dir;
}

/** A repo's own GitLab pipeline: a job with no stage, which GitLab puts in test. */
const OWN_JOBS = "# The repo's own pipeline.\nvariables:\n  APP: shop\n\nunit-tests:\n  script:\n    - echo the repo's own job ran\n";

afterEach(() => vi.restoreAllMocks());

describe("--json", () => {
  it("init --dry-run lists each root with its reason, and each file with its content", async () => {
    const { code, out } = await run(repo(), "init", "--dry-run", "--binary", "tofu", "--json");
    expect(code).toBe(0);
    golden("init-dry-run", out);
    const j = JSON.parse(out);
    expect(j.results.roots).toEqual([
      { path: "app", reason: "backend s3" },
      { path: "network", reason: "backend s3" },
    ]);
  });

  it("init --dry-run writes nothing", async () => {
    const dir = repo();
    await run(dir, "init", "--dry-run", "--binary", "tofu", "--json");
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });

  it("a root found by a provider block or a glob says so", async () => {
    const dir = write(repo(), { "edge/main.tf": 'provider "aws" {\n  region = "us-east-1"\n}\n' });
    const r = JSON.parse((await run(dir, "init", "--dry-run", "--binary", "tofu", "--json")).out).results.roots;
    expect(r).toContainEqual({ path: "edge", reason: "provider aws" });
    write(dir, { "terragucci.yml": 'roots: ["network"]\n' });
    const g = JSON.parse((await run(dir, "init", "--dry-run", "--binary", "tofu", "--json")).out).results.roots;
    expect(g).toEqual([{ path: "network", reason: "matches roots glob network" }]);
  });

  it("reconcile without a control repo config is a usage error", async () => {
    const { code, out } = await run(repo(), "reconcile", "--json");
    expect(code).toBe(2);
    golden("reconcile-usage", out);
  });

  it("reconcile --json reports each project", async () => {
    const dir = write(tmp(), { "terragucci.yml": `defaults:\n  binary: tofu\nprojects:\n  github.com/acme/infra:\n    url: ${bareFrom(twoRootRepo())}\n` });
    const { code, out } = await run(dir, "reconcile", "--json");
    expect(code).toBe(0);
    golden("reconcile-dry-run", out);
  });

  it("init --dry-run in a GitLab repo with its own .gitlab-ci.yml writes the jobs beside it and adds the include", async () => {
    const dir = twoRootRepo();
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", "git@gitlab.com:acme/infra.git");
    write(dir, { ".gitlab-ci.yml": OWN_JOBS });
    const { code, out } = await run(dir, "init", "--dry-run", "--binary", "tofu", "--json");
    expect(code).toBe(0);
    golden("init-gitlab-own-jobs", out);
  });

  it("reconcile --json on a GitLab project with its own .gitlab-ci.yml adds the include and keeps its jobs", async () => {
    const project = write(twoRootRepo(), { ".gitlab-ci.yml": OWN_JOBS });
    const dir = write(tmp(), { "terragucci.yml": `defaults:\n  binary: tofu\nprojects:\n  gitlab.example.com/platform/network:\n    url: ${bareFrom(project)}\n` });
    const { code, out } = await run(dir, "reconcile", "--json");
    expect(code).toBe(0);
    golden("reconcile-gitlab-own-jobs", out);
  });

  it("plan with no match is a usage error", async () => {
    const { code, out } = await run(repo(), "plan", "--root", "nope", "--json");
    expect(code).toBe(2);
    golden("plan-usage", out);
  });

  it("config check passes a good file", async () => {
    const dir = write(repo(), { "terragucci.yml": "binary: tofu\nforge: github\n" });
    const { code, out } = await run(dir, "config", "check", "--json");
    expect(code).toBe(0);
    golden("config-check-ok", out);
  });

  it("config check lists every problem", async () => {
    const dir = write(repo(), { "terragucci.yml": "binary: nope\nforge: svn\nbogus: 1\n" });
    const { code, out } = await run(dir, "config", "check", "--json");
    expect(code).toBe(2);
    golden("config-check-problems", out);
    expect(JSON.parse(out).results.problems).toHaveLength(3);
  });

  it("config check asks apply before merge on GitLab for comments and a merge token, named in the config or detected from the repo", async () => {
    for (const files of [{ "terragucci.yml": "forge: gitlab\napply:\n  when: pull-request\n" }, { "terragucci.yml": "apply:\n  when: pull-request\n", ".gitlab-ci.yml": "# x\n" }] as Record<string, string>[]) {
      const { code, out } = await run(write(repo(), files), "config", "check", "--json");
      expect(code).toBe(2);
      const problems = JSON.parse(out).results.problems.join("\n");
      expect(problems).toMatch(/apply\.when: pull-request on GitLab needs comments: <cron>/);
      expect(problems).toMatch(/apply\.when: pull-request on GitLab needs apply\.merge_token_env/);
    }
    const ok = await run(write(repo(), { "terragucci.yml": "forge: gitlab\ncomments: \"*/5 * * * *\"\napply:\n  when: pull-request\n  merge_token_env: MERGE_TOKEN\n" }), "config", "check", "--json");
    expect(ok.code).toBe(0);
    const { code } = await run(write(repo(), { "terragucci.yml": "apply:\n  when: pull-request\n", ".forgejo/workflows/x.yml": "# x\n" }), "config", "check", "--json");
    expect(code).toBe(0);
  });

  it("config check without --json prints text", async () => {
    const dir = write(repo(), { "terragucci.yml": "binary: tofu\n" });
    const { code, out } = await run(dir, "config", "check");
    expect(code).toBe(0);
    expect(out).toBe("terragucci.yml: ok\napproval: ledger (the default)");
  });

  it("config check names itself in the envelope when it cannot run", async () => {
    const { code, out } = await run(repo(), "config", "--json");
    const e = JSON.parse(out);
    expect(code).toBe(2);
    expect(e.command).toBe("config check");
    expect(e.results).toBeNull();
  });

  it("--json on a command without it is refused", async () => {
    const { code, out } = await run(repo(), "profiles", "--json");
    expect(code).toBe(2);
    expect(JSON.parse(out).error).toMatch(/not available on profiles/);
  });
});
