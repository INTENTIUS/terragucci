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

  it("config check without --json prints text", async () => {
    const dir = write(repo(), { "terragucci.yml": "binary: tofu\n" });
    const { code, out } = await run(dir, "config", "check");
    expect(code).toBe(0);
    expect(out).toBe("terragucci.yml: ok");
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
