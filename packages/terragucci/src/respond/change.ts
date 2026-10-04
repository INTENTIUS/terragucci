/**
 * How a response proposes a change: a branch from the default branch, one
 * commit, and a pull request for a person to review. A dry run, the default,
 * only lists the files. Nothing here merges, approves or writes the default
 * branch; `fmt` alone pushes, and only to the pull request's own branch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError, type ResolvedSettings } from "../config";
import { detectForge } from "../detect";
import { DEFAULT_TOKEN_ENV, defaultBranch, openPullRequest, type Fetch, type ForgeTarget } from "../forge";
import { IDENTITY } from "../reconcile";
import { targetOfRemote } from "../rollout";

export interface Proposal {
  branch: string;
  title: string;
  body: string;
  /** Repo-relative files and their new content. */
  files: Map<string, string>;
  /** Writes more files in the checkout (a binary's output); returns their paths. Not run on a dry run. */
  run?: (dir: string) => string[];
  /** Files `run` writes, named for a dry run. */
  expect?: string[];
}

export interface Proposed {
  branch: string;
  title: string;
  files: string[];
  state: "would-open" | "opened" | "open" | "nothing-to-change";
  pullRequest?: string;
}

export interface ChangeOptions {
  mode: "dry-run" | "apply";
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
}

export function git(dir: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new ConfigError(`git ${args[0]}: ${String((e as { stderr?: string }).stderr || (e as Error).message).trim()}`);
  }
}

/** The forge the repo's origin is on, with the token from `token_env`. */
export function forgeOf(repo: string, settings: ResolvedSettings, env: NodeJS.ProcessEnv): ForgeTarget {
  let remote = "";
  try {
    remote = git(repo, ["remote", "get-url", "origin"]);
  } catch {
    throw new ConfigError("this repository has no origin remote, so there is nowhere to open a pull request");
  }
  const forge = settings.forge ?? detectForge(repo)?.value;
  const at = targetOfRemote(settings.url ?? remote);
  if (!forge || !at) throw new ConfigError("cannot tell which forge this repository's origin is on; set forge (and url) in terragucci.yml");
  return { forge, origin: at.origin, path: at.path, token: env[settings.token_env ?? DEFAULT_TOKEN_ENV[forge]] ?? "" };
}

/** A detached worktree at `ref`, removed by the returned function. */
export function worktree(repo: string, ref: string): { dir: string; done: () => void } {
  const dir = join(mkdtempSync(join(tmpdir(), "terragucci-respond-")), "tree");
  git(repo, ["worktree", "add", "-q", "--detach", dir, ref]);
  return {
    dir,
    done: () => {
      try {
        git(repo, ["worktree", "remove", "--force", dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Open one pull request per proposal, each on its own branch from the default branch. */
export async function propose(repo: string, settings: ResolvedSettings, proposals: Proposal[], options: ChangeOptions): Promise<Proposed[]> {
  if (options.mode === "dry-run") {
    return proposals.map((p) => ({ branch: p.branch, title: p.title, files: [...p.files.keys(), ...(p.expect ?? [])].sort(), state: "would-open" }));
  }
  const env = options.env ?? process.env;
  const target = forgeOf(repo, settings, env);
  if (!target.token) throw new ConfigError(`${settings.token_env ?? DEFAULT_TOKEN_ENV[target.forge]} is not set; it holds the forge token`);
  const fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  const base = await defaultBranch(fetch, target);
  git(repo, ["fetch", "-q", "origin", base]);
  const out: Proposed[] = [];
  for (const p of proposals) {
    const tree = worktree(repo, "FETCH_HEAD");
    try {
      for (const [file, content] of p.files) {
        mkdirSync(dirname(join(tree.dir, file)), { recursive: true });
        writeFileSync(join(tree.dir, file), content);
      }
      p.run?.(tree.dir);
      git(tree.dir, ["add", "-A"]);
      const files = git(tree.dir, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
      if (files.length === 0) {
        out.push({ branch: p.branch, title: p.title, files, state: "nothing-to-change" });
        continue;
      }
      git(tree.dir, [...IDENTITY, "commit", "-q", "--no-verify", "-m", p.title]);
      git(tree.dir, ["push", "-q", "--force", "origin", `HEAD:refs/heads/${p.branch}`]);
      const pr = await openPullRequest(fetch, target, { head: p.branch, base, title: p.title, body: p.body });
      out.push({ branch: p.branch, title: p.title, files, state: pr.existing ? "open" : "opened", pullRequest: pr.url });
    } finally {
      tree.done();
    }
  }
  return out;
}
