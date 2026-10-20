import { execFileSync } from "node:child_process";

export function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    }).trimEnd();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")}: ${(err.stderr || err.message).trim()}`);
  }
}

export function tryGit(dir: string, args: string[]): string | undefined {
  try {
    return git(dir, args);
  } catch {
    return undefined;
  }
}

/** Messages of the commits after `since` that touched `path`, newest first. Every commit when `since` is absent. */
export function commitsSince(dir: string, since: string | undefined, path: string): string[] {
  const range = since ? [`${since}..HEAD`] : ["HEAD"];
  const out = git(dir, ["log", "--format=%B%x1e", ...range, "--", path]);
  return out.split("\x1e").map((m) => m.trim()).filter(Boolean);
}

export function hasCommit(dir: string, sha: string): boolean {
  return tryGit(dir, ["cat-file", "-e", `${sha}^{commit}`]) !== undefined;
}
