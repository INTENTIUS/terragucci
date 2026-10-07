/**
 * Root locks for `apply.when: pull-request`. A pull request that applies
 * before it merges holds a lock on each root its change reaches, so no other
 * pull request applies those roots until it merges or closes, or someone with
 * write access comments `/terragucci unlock` on it.
 *
 * The locks are one file, `_locks/tf-apply.json`, on the repo's
 * `chant/lifecycle` branch, next to the gate ledger the apply waves already
 * write. Every change is a new commit on the branch pushed without force, so
 * two jobs that lock at once cannot both win: the second push is refused, and
 * it reads the branch again and decides again.
 *
 * A lock held by a pull request that is no longer open is released: the
 * holder merged or closed, and the next pull request that needs the root
 * takes it over. So merging or closing needs no job of its own.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./config";

const LIFECYCLE = "chant/lifecycle";
const REMOTE_REF = `refs/remotes/origin/${LIFECYCLE}`;
/** Where the locks are kept on `chant/lifecycle`. */
export const LOCKS_PATH = "_locks/tf-apply.json";
const GIT_ID = { GIT_AUTHOR_NAME: "terragucci", GIT_AUTHOR_EMAIL: "terragucci@localhost", GIT_COMMITTER_NAME: "terragucci", GIT_COMMITTER_EMAIL: "terragucci@localhost" };

/** One root's lock: the pull request that holds it, who asked, when, and the head it applied. */
export interface RootLock {
  pr: number;
  by: string;
  at: string;
  head: string;
}

export interface LockFile {
  version: 1;
  locks: Record<string, RootLock>;
}

/** A lock another open pull request holds on a root this one needs. */
export interface HeldLock extends RootLock {
  root: string;
}

export type TakeResult = { ok: true; taken: string[] } | { ok: false; held: HeldLock[] };

function git(repo: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf-8", input, env });
}

/** Fetch `chant/lifecycle`. False when the remote has no such branch yet. */
function fetchLifecycle(repo: string): boolean {
  const heads = git(repo, ["ls-remote", "--heads", "origin", LIFECYCLE]);
  if (heads.status !== 0) throw new ConfigError(`cannot read ${LIFECYCLE} from origin, so the locks cannot be read: ${heads.stderr.trim()}`);
  if (!heads.stdout.trim()) return false;
  const f = git(repo, ["fetch", "-q", "origin", `+refs/heads/${LIFECYCLE}:${REMOTE_REF}`]);
  if (f.status !== 0) throw new ConfigError(`cannot fetch ${LIFECYCLE}, so the locks cannot be read: ${f.stderr.trim()}`);
  return true;
}

/** The lock file's text: anything that is not a version 1 file with a map of locks reads as no locks. */
export function parseLocks(text: string): LockFile {
  try {
    const doc = JSON.parse(text);
    if (doc?.version === 1 && doc.locks && typeof doc.locks === "object" && !Array.isArray(doc.locks)) {
      const locks: Record<string, RootLock> = {};
      for (const [root, l] of Object.entries(doc.locks as Record<string, any>)) {
        if (Number.isInteger(l?.pr) && typeof l.by === "string" && typeof l.at === "string" && typeof l.head === "string") locks[root] = { pr: l.pr, by: l.by, at: l.at, head: l.head };
      }
      return { version: 1, locks };
    }
  } catch {
    // An unreadable file holds no locks.
  }
  return { version: 1, locks: {} };
}

function current(repo: string): { parent: string; file: LockFile } {
  if (!fetchLifecycle(repo)) return { parent: "", file: { version: 1, locks: {} } };
  const parent = git(repo, ["rev-parse", REMOTE_REF]).stdout.trim();
  const show = git(repo, ["show", `${REMOTE_REF}:${LOCKS_PATH}`]);
  return { parent, file: parseLocks(show.status === 0 ? show.stdout : "") };
}

/** The locks as `chant/lifecycle` on origin holds them now. */
export function readLocks(repo: string): LockFile {
  return current(repo).file;
}

/** Commit `file` on top of `parent` and push it without force. False when another writer moved the branch first. */
function write(repo: string, parent: string, file: LockFile, message: string): boolean {
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const blob = git(repo, ["hash-object", "-w", "--stdin"], text).stdout.trim();
  // A scratch index, so the checkout's own index is left alone.
  const scratch = mkdtempSync(join(tmpdir(), "terragucci-locks-"));
  const env = { ...process.env, ...GIT_ID, GIT_INDEX_FILE: join(scratch, "index") };
  try {
    if (parent) git(repo, ["read-tree", parent], undefined, env);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${LOCKS_PATH}`], undefined, env);
    const tree = git(repo, ["write-tree"], undefined, env).stdout.trim();
    const commit = git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], undefined, env).stdout.trim();
    if (!commit) throw new ConfigError("could not write the root locks");
    return git(repo, ["push", "-q", "origin", `${commit}:refs/heads/${LIFECYCLE}`]).status === 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Lock `roots` for pull request `holder.pr`. A root locked by another pull
 * request that `isOpen` says is still open is held, and nothing is locked;
 * a root locked by one that merged or closed is taken over. Roots this pull
 * request already holds stay its own, with the new head.
 */
export async function takeLocks(repo: string, roots: readonly string[], holder: RootLock, isOpen: (pr: number) => Promise<boolean>): Promise<TakeResult> {
  const open = new Map<number, boolean>();
  const stillOpen = async (pr: number): Promise<boolean> => {
    if (!open.has(pr)) open.set(pr, await isOpen(pr));
    return open.get(pr)!;
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const { parent, file } = current(repo);
    const held: HeldLock[] = [];
    for (const root of [...roots].sort()) {
      const l = file.locks[root];
      if (l && l.pr !== holder.pr && (await stillOpen(l.pr))) held.push({ root, ...l });
    }
    if (held.length > 0) return { ok: false, held };
    const next: LockFile = { version: 1, locks: { ...file.locks } };
    for (const root of roots) next.locks[root] = holder;
    if (roots.length === 0 || write(repo, parent, next, `Lock ${roots.length} root${roots.length === 1 ? "" : "s"} for pull request ${holder.pr}`)) return { ok: true, taken: [...roots].sort() };
  }
  throw new ConfigError(`could not push the root locks to ${LIFECYCLE}; check that the job may push to it`);
}

/** Release every lock pull request `pr` holds. Returns the roots it held. */
export function releaseLocks(repo: string, pr: number): string[] {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { parent, file } = current(repo);
    const mine = Object.keys(file.locks).filter((r) => file.locks[r]!.pr === pr).sort();
    if (mine.length === 0) return [];
    const next: LockFile = { version: 1, locks: Object.fromEntries(Object.entries(file.locks).filter(([, l]) => l.pr !== pr)) };
    if (write(repo, parent, next, `Unlock the roots of pull request ${pr}`)) return mine;
  }
  throw new ConfigError(`could not push the root locks to ${LIFECYCLE}; check that the job may push to it`);
}

/** One line naming the roots others hold, for a reply. */
export function describeHeld(held: readonly HeldLock[]): string {
  const byPr = new Map<number, HeldLock[]>();
  for (const h of held) byPr.set(h.pr, [...(byPr.get(h.pr) ?? []), h]);
  return [...byPr].map(([pr, hs]) => `${hs.map((h) => `\`${h.root}\``).join(", ")} ${hs.length === 1 ? "is" : "are"} locked by pull request ${pr} (applied by ${hs[0]!.by})`).join("; ");
}
