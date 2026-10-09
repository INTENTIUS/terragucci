/**
 * `apply.branches` for the drift check: a root (in a Terragrunt repo, a
 * unit) that a branch applies is planned from that branch, since what the
 * cloud holds is what that branch applied. The drift job runs on the default
 * branch; for each branch the map names that holds a root of the run, this
 * fetches the branch from `origin` and checks it out in a worktree of its
 * own, and the root plans there. A root whose branch cannot be fetched fails
 * with the reason: planning it from the default branch would report the
 * difference between the two branches as drift.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { globMatch } from "./detect";

/** The branch whose globs match `root`, if any. */
export function branchOf(branches: Record<string, string[]> | undefined, root: string): string | undefined {
  return Object.keys(branches ?? {}).find((b) => branches![b].some((g) => globMatch(g, root)));
}

export interface BranchCheckouts {
  /** The checkout a root plans from: its branch's worktree, or the repo. */
  dirOf(root: string): string;
  /** The branch a root plans from, when the map names one for it. */
  branchOf(root: string): string | undefined;
  /** The roots whose branch could not be checked out, and why. */
  failed: Map<string, string>;
  /** Each checkout and the roots of the run it holds; the repo's first. */
  groups(roots: readonly string[]): { dir: string; branch?: string; roots: string[] }[];
  /** Remove the worktrees. */
  close(): void;
}

export type Git = (args: string[], cwd: string) => { status: number | null; stdout: string; stderr: string };

const realGit: Git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "" };
};

const firstLine = (s: string): string => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";

/**
 * A worktree for each branch `branches` maps a root of `roots` to, under
 * `work`. Without a map, or with no mapped root among `roots`, every root
 * plans from `repo` and nothing is fetched.
 */
export function branchCheckouts(repo: string, branches: Record<string, string[]> | undefined, roots: readonly string[], work: string, log: (line: string) => void, git: Git = realGit): BranchCheckouts {
  const mapped = new Map<string, string>();
  for (const r of roots) {
    const b = branchOf(branches, r);
    if (b) mapped.set(r, b);
  }
  const dirs = new Map<string, string>();
  const failed = new Map<string, string>();
  const made: string[] = [];
  const shallow = mapped.size > 0 && git(["rev-parse", "--is-shallow-repository"], repo).stdout.trim() === "true";
  for (const b of [...new Set(mapped.values())].sort()) {
    const mine = [...mapped].filter(([, x]) => x === b).map(([r]) => r).sort();
    const fetched = git(["fetch", "--quiet", "--no-tags", ...(shallow ? ["--depth=1"] : []), "origin", `+refs/heads/${b}:refs/remotes/origin/${b}`], repo);
    let why: string | undefined;
    if (fetched.status !== 0) why = `git could not fetch ${b} from origin (${firstLine(fetched.stderr) || `exit ${fetched.status}`})`;
    let dir = "";
    let sha = "";
    if (!why) {
      sha = git(["rev-parse", `refs/remotes/origin/${b}`], repo).stdout.trim();
      dir = join(mkdtempSync(join(work, "branch-")), "tree");
      const added = git(["worktree", "add", "--quiet", "--detach", dir, sha], repo);
      if (added.status !== 0) why = `git could not check out ${b} (${firstLine(added.stderr) || `exit ${added.status}`})`;
      else made.push(dir);
    }
    if (why) {
      for (const r of mine) failed.set(r, `apply.branches: ${b} applies ${r}, so the drift check plans it from ${b}, and ${why}`);
      log(`apply.branches: ${mine.join(", ")} ${mine.length === 1 ? "is" : "are"} not checked: ${why}`);
      continue;
    }
    dirs.set(b, dir);
    log(`apply.branches: ${mine.join(", ")} ${mine.length === 1 ? "plans" : "plan"} from ${b} at ${sha.slice(0, 8)}, the branch that applies ${mine.length === 1 ? "it" : "them"}`);
  }
  const dirOf = (root: string): string => {
    const b = mapped.get(root);
    return (b && dirs.get(b)) || repo;
  };
  return {
    dirOf,
    branchOf: (root) => mapped.get(root),
    failed,
    groups(rs) {
      const out = new Map<string, { dir: string; branch?: string; roots: string[] }>([[repo, { dir: repo, roots: [] }]]);
      for (const r of rs) {
        if (failed.has(r)) continue;
        const dir = dirOf(r);
        const g = out.get(dir) ?? { dir, branch: mapped.get(r), roots: [] };
        g.roots.push(r);
        out.set(dir, g);
      }
      return [...out.values()].filter((g) => g.roots.length > 0);
    },
    close() {
      for (const dir of made) git(["worktree", "remove", "--force", dir], repo);
      if (made.length) git(["worktree", "prune"], repo);
    },
  };
}
