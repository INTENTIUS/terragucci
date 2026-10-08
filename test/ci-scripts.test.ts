import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/diff-guard.sh, scripts/release-preflight.sh and scripts/ci-red on
// throwaway repos.
const SCRIPTS = join(import.meta.dirname, "..", "scripts");
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

const tmp = () => mkdtempSync(join(tmpdir(), "tg-ci-scripts-"));
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: ENV, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const run = (cwd: string, script: string, args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync(join(SCRIPTS, script), args, { cwd, env: { ...ENV, ...env }, encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
};
const commit = (dir: string, files: Record<string, string>, message: string) => {
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
};
const repo = () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  return dir;
};

describe("diff-guard", () => {
  const lines = (n: number, change: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => change[i] ?? `line ${i}`).join("\n") + "\n";

  it("passes a pull request that changes its own lines, and fails one whose stale copy undoes a commit main merged", () => {
    const dir = repo();
    commit(dir, { "a.txt": lines(20), "b.txt": "b\n" }, "start");
    const branchPoint = git(dir, "rev-parse", "HEAD");
    // main merges a change to a.txt while the pull request is open.
    const merged = commit(dir, { "a.txt": lines(20, { 15: "main changed this" }) }, "main's change (#1)");
    // A good pull request, rebased: its own line, main's change kept.
    git(dir, "checkout", "-q", "-b", "good", merged);
    const good = commit(dir, { "a.txt": lines(20, { 2: "the pull request", 15: "main changed this" }), "b.txt": "b2\n" }, "good");
    expect(run(dir, "diff-guard.sh", ["main", good])).toMatchObject({ status: 0 });
    // A bad rebase: the branch's stale a.txt on top of main.
    git(dir, "checkout", "-q", "-b", "bad", merged);
    const bad = commit(dir, { "a.txt": lines(20, { 2: "the pull request" }) }, "bad");
    const r = run(dir, "diff-guard.sh", ["main", bad]);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`a.txt: this pull request undoes ${merged.slice(0, 12)} (main's change (#1))`);
    expect(r.out).not.toContain("b.txt");
    // The revert label.
    expect(run(dir, "diff-guard.sh", ["main", bad], { DIFF_GUARD_ALLOW: "1" })).toMatchObject({ status: 0 });
    expect(branchPoint).not.toBe(merged);
  });

  it("leaves an older change a pull request undoes on purpose out of its window", () => {
    const dir = repo();
    commit(dir, { "a.txt": lines(5) }, "start");
    const old = commit(dir, { "a.txt": lines(5, { 1: "old change" }) }, "old");
    for (let i = 0; i < 3; i++) commit(dir, { [`n${i}.txt`]: `${i}\n` }, `other ${i}`);
    git(dir, "checkout", "-q", "-b", "pr");
    const pr = commit(dir, { "a.txt": lines(5) }, "undo the old change");
    expect(run(dir, "diff-guard.sh", ["main", pr], { DIFF_GUARD_DEPTH: "2" })).toMatchObject({ status: 0 });
    expect(run(dir, "diff-guard.sh", ["main", pr]).out).toContain(`undoes ${old.slice(0, 12)}`);
  });
});

describe("release-preflight", () => {
  const setup = () => {
    const origin = tmp();
    git(origin, "init", "-q", "--bare", "-b", "main");
    const dir = repo();
    git(dir, "remote", "add", "origin", origin);
    const pkg = (v: string) => ({ "packages/terragucci/package.json": JSON.stringify({ version: v }) });
    const a = commit(dir, pkg("0.3.1"), "a");
    const b = commit(dir, pkg("0.3.2"), "bump");
    git(dir, "push", "-q", "origin", "main");
    return { dir, a, b };
  };
  const tag = (dir: string, name: string, sha: string) => {
    git(dir, "tag", "-a", "-m", name, `ci/${name}/${sha}`, sha);
    git(dir, "push", "-q", "origin", `ci/${name}/${sha}`);
  };

  it("names the newest green commit at the version, and the tag commands", () => {
    const { dir, b } = setup();
    tag(dir, "green", b);
    const r = run(dir, "release-preflight.sh", ["0.3.2"]);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`git tag v0.3.2 ${b} && git push origin v0.3.2`);
  });

  it("refuses a green commit at another version, a revoked one, and one with no tag; the skip variable releases it", () => {
    const { dir, a, b } = setup();
    tag(dir, "green", a);
    expect(run(dir, "release-preflight.sh", ["0.3.2"]).out).toMatch(/at 0\.3\.1, not 0\.3\.2/);
    expect(run(dir, "release-preflight.sh", ["0.3.2", b]).out).toMatch(/has no ci\/green tag/);
    tag(dir, "green", b);
    tag(dir, "revoked", b);
    expect(run(dir, "release-preflight.sh", ["0.3.2", b])).toMatchObject({ status: 1, out: expect.stringContaining(`ci/revoked/${b}`) });
    expect(run(dir, "release-preflight.sh", ["0.3.2", b], { TERRAGUCCI_RELEASE_SKIP_GREEN: "1" })).toMatchObject({ status: 0 });
  });

  it("says why when main has no green commit, and releases main with the skip variable", () => {
    const { dir, b } = setup();
    const r = run(dir, "release-preflight.sh", ["0.3.2"]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("no commit among main's last 200 has a ci/green tag");
    expect(r.out).toContain("TERRAGUCCI_RELEASE_SKIP_GREEN=1");
    const s = run(dir, "release-preflight.sh", ["0.3.2"], { TERRAGUCCI_RELEASE_SKIP_GREEN: "1" });
    expect(s.status).toBe(0);
    expect(s.out).toContain(`git tag v0.3.2 ${b}`);
  });
});

describe("ci-red", () => {
  // A gh on PATH that lists the given issues ("<number> <state>" lines, as
  // ci-red's --jq prints them) and logs every call.
  const fakeGh = (dir: string, issues: string) => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(dir, "list"), issues);
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(join(dir, "calls"))}\ncase "$1 $2" in\n  "issue list") cat ${JSON.stringify(join(dir, "list"))} 2>/dev/null ;;\n  "issue view") echo "body" ;;\nesac\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    return { PATH: `${bin}:${process.env.PATH}` };
  };
  const calls = (dir: string) => {
    try {
      return readFileSync(join(dir, "calls"), "utf-8");
    } catch {
      return "";
    }
  };

  it("opens the issue when main has had no green commit for longer than the hours, and says nothing while it is green", () => {
    const dir = repo();
    const sha = commit(dir, { "a.txt": "a\n" }, "a red commit");
    const env = { ...fakeGh(dir, ""), GITHUB_REPOSITORY: "INTENTIUS/terragucci", TERRAGUCCI_RED_MAIN: "main", TERRAGUCCI_RED_HOURS: "6", TERRAGUCCI_RED_NOW: String(Math.floor(Date.now() / 1000) + 7 * 3600) };
    const r = run(dir, "ci-red", [], env);
    expect(r.out).toContain('opened "main is red"');
    expect(r.status).toBe(0);
    expect(r.out).toContain('opened "main is red"');
    expect(calls(dir)).toContain(`issue create -R INTENTIUS/terragucci --title main is red`);
    expect(calls(dir)).toContain(`red since ${sha}`);

    git(dir, "tag", `ci/green/${sha}`, sha);
    writeFileSync(join(dir, "calls"), "");
    const g = run(dir, "ci-red", [], env);
    expect(g.out).toContain("nothing to say: main's newest green commit is");
    expect(calls(dir)).not.toContain("issue create");
  });
});
