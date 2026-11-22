// #1541: a pipeline's apply reads its gate policy at the commit before the one
// it applies (chant's HEAD^1), which a repo's first commit lacks. The example
// boots push a fresh tree to a new repo, so lib.sh's push_tree puts a base
// commit of the same tree under it when PUSH_BASE is set.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const lib = readFileSync(join(root, "stack", "lib.sh"), "utf8");

/** One function of lib.sh, from its `name() {` line to the `}` that closes it. */
function fn(name: string): string {
  const start = lib.indexOf(`\n${name}() {`);
  expect(start, `${name} in stack/lib.sh`).toBeGreaterThan(-1);
  const end = lib.indexOf("\n}\n", start);
  return lib.slice(start + 1, end + 2);
}

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A scratch directory with a bare remote `o/<repo>.git` in it. */
function scratch(...repos: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "tg-push-tree-"));
  made.push(d);
  for (const r of repos) spawnSync("git", ["init", "-q", "--bare", join(d, "remote", "o", `${r}.git`)]);
  return d;
}

/** A tree with one file, as a fresh copy of the example is. */
function tree(d: string, name: string): string {
  const t = join(d, name);
  mkdirSync(join(t, ".chant", "op-waves"), { recursive: true });
  writeFileSync(join(t, ".chant", "op-waves", "tf-apply.spec.json"), "{}\n");
  return t;
}

/** Run `body` after push_tree, against the bare remotes under `d`. LIB_FORGE=gitlab skips Forgejo's empty-repo wait. */
function run(d: string, body: string) {
  const script = `set -euo pipefail\nURL=${JSON.stringify(join(d, "remote"))}\nUSER=u\nTOKEN=t\nLIB_FORGE=gitlab\n${fn("local_images")}\n${fn("push_tree")}\n${body}`;
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  delete (env as Record<string, string | undefined>).PUSH_BASE;
  delete (env as Record<string, string | undefined>).TG_FIXED_DATE;
  return spawnSync("bash", ["-c", script], { cwd: d, encoding: "utf8", env });
}

/** `<sha> <parents> <subject>` per commit of main on remote `o/<repo>`, newest first. */
function log(d: string, repo: string): string[] {
  const r = spawnSync("git", ["--git-dir", join(d, "remote", "o", `${repo}.git`), "log", "--format=%H %P|%s", "main"], { encoding: "utf8" });
  return r.stdout.trim().split("\n");
}

describe("push_tree's PUSH_BASE", () => {
  it("pushes a fresh tree on a base commit of the same tree, so the pushed commit has a parent", () => {
    const d = scratch("r");
    const t = tree(d, "t");
    const r = run(d, `PUSH_BASE="the base" push_tree ${JSON.stringify(t)} o/r main "the estate"`);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const [head, base, more] = log(d, "r");
    expect(more).toBeUndefined();
    const [headSha, parent] = head!.split("|")[0]!.split(" ");
    expect(head!.endsWith("|the estate")).toBe(true);
    expect(base!.endsWith("|the base")).toBe(true);
    expect(base!.split("|")[0]!.split(" ")[1]).toBe("");
    expect(parent).toBe(base!.split(" ")[0]);
    expect(r.stdout.trim()).toBe(headSha);
    // The commit the pipeline applies changes nothing: the base holds the same tree.
    const diff = spawnSync("git", ["--git-dir", join(d, "remote", "o", "r.git"), "diff", "--name-only", `${parent}`, headSha!], { encoding: "utf8" });
    expect(diff.stdout).toBe("");
  });

  it("gives the same tree the same shas under TG_FIXED_DATE", () => {
    const d = scratch("a", "b");
    const r = run(d, `TG_FIXED_DATE=1 PUSH_BASE="the base" push_tree ${JSON.stringify(tree(d, "ta"))} o/a main "the estate"
TG_FIXED_DATE=1 PUSH_BASE="the base" push_tree ${JSON.stringify(tree(d, "tb"))} o/b main "the estate"`);
    expect(r.status).toBe(0);
    const [a, b] = r.stdout.trim().split("\n");
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(b).toBe(a);
  });

  it("adds no base to a tree that already has a commit, nor without PUSH_BASE", () => {
    const d = scratch("r", "plain");
    const t = tree(d, "t");
    const r = run(d, `PUSH_BASE="the base" push_tree ${JSON.stringify(t)} o/r main "first" >/dev/null
PUSH_BASE="the base" push_tree ${JSON.stringify(t)} o/r main "second" >/dev/null
push_tree ${JSON.stringify(tree(d, "p"))} o/plain main "root" >/dev/null`);
    expect(r.status).toBe(0);
    expect(log(d, "r").map((l) => l.split("|")[1])).toEqual(["second", "first", "the base"]);
    const plain = log(d, "plain");
    expect(plain).toHaveLength(1);
    expect(plain[0]!.split("|")[0]!.split(" ")[1]).toBe("");
  });
});

describe("the example boots", () => {
  // Each pushes a fresh tree to main and waits for a green apply.
  it.each([
    ["example.sh", /PUSH_BASE="[^"]+" apply_main_tree "The shop's estate"/],
    ["example-terragrunt.sh", /PUSH_BASE="[^"]+" apply_main_tree "The shop's estate, on Terragrunt"/],
    ["example-gitlab.sh", /PUSH_BASE="[^"]+" gl_push "\$WORK\/tree" main "The shop's estate"/],
  ])("%s pushes its first commit on a base", (script, line) => {
    expect(readFileSync(join(root, "stack", script), "utf8")).toMatch(line);
  });
});
