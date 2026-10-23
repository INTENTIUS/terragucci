/**
 * Root locks are chant's target locks (@intentius/chant/lifecycle/target-lock,
 * the code behind `chant lock` and `chant unlock`). A pull request that
 * applies before it merges (`apply.when: pull-request`), that a writer locks
 * with `/terragucci lock`, or, with `locks: plan`, that planned, holds a lock
 * on each root its change reaches, so no other pull request applies or locks
 * those roots until it merges or closes, or someone with write access
 * comments `/terragucci unlock` on it.
 *
 * The gate is `tf-apply`, so the locks are `_locks/tf-apply.json` on the
 * repo's `chant/lifecycle` branch, next to the gate ledger the apply waves
 * write, and `chant lock --list --gate tf-apply` prints them. Each root (in a
 * Terragrunt repo, each unit) is a target. A lock held by a pull request the
 * forge says is no longer open is taken over.
 */
import {
  describeHeldTargetLocks,
  releaseTargetLocks,
  renderTargetLocks,
  takeTargetLocks,
  type HeldTargetLock,
  type PullRequestOpen,
  type TakeTargetLocksResult,
  type TargetLock,
  type TargetLockFile,
} from "@intentius/chant/lifecycle/target-lock";
import { fetchLifecycleStatus, pushLifecycleStatus, readBlobBySha, readPathSha, writeBlobToPath } from "@intentius/chant/lifecycle/git";

/** The gate whose locks the roots are: `_locks/tf-apply.json`. */
export const LOCK_GATE = "tf-apply";

export type { HeldTargetLock, TakeTargetLocksResult, TargetLock };

/**
 * Lock `roots` for pull request `holder.pr`, or name the roots another open
 * pull request holds. With `release`, the pull request's plan locks on roots
 * it no longer reaches are released.
 */
export async function takeRootLocks(repo: string, roots: readonly string[], holder: TargetLock, isOpen: PullRequestOpen, o: { release?: boolean } = {}): Promise<TakeTargetLocksResult> {
  await upgradeLegacyLocks(repo);
  return takeTargetLocks(LOCK_GATE, roots, holder, { cwd: repo, isOpen, ...(o.release ? { releaseStalePlan: true } : {}) });
}

/** Release every lock pull request `pr` holds. Returns the roots it held. */
export async function releaseRootLocks(repo: string, pr: number): Promise<string[]> {
  await upgradeLegacyLocks(repo);
  return (await releaseTargetLocks(LOCK_GATE, pr, { cwd: repo })).released;
}

/**
 * One line naming the roots others hold, for a reply, in chant's words with
 * terragucci's command for a lock taken without an apply. `name` says how the
 * forge names a holder (GitLab: `merge request !7`).
 */
export function describeHeld(held: readonly HeldTargetLock[], name?: (pr: number) => string): string {
  return describeHeldTargetLocks(held.map((h) => ({ ...h, target: `\`${h.target}\`` })), name).replace(/locked with chant lock/g, "locked with `/terragucci lock`");
}

/**
 * Locks terragucci wrote before it used chant's carry no `stage`: an apply's
 * had none, and `/terragucci lock`'s had `via: "lock"`. chant reads an entry
 * without a stage as no lock, so such entries are rewritten once, with the
 * stage they meant, before chant reads the file.
 */
async function upgradeLegacyLocks(repo: string): Promise<void> {
  const fetched = await fetchLifecycleStatus({ cwd: repo });
  if (fetched.status === "diverged" || fetched.status === "unreachable") return;
  const sha = await readPathSha("_locks", `${LOCK_GATE}.json`, { cwd: repo });
  const text = sha ? await readBlobBySha(sha, { cwd: repo }) : null;
  let doc: { version?: unknown; locks?: Record<string, Record<string, unknown>> };
  try {
    doc = JSON.parse(text ?? "null");
  } catch {
    return;
  }
  if (doc?.version !== 1 || !doc.locks || typeof doc.locks !== "object") return;
  const next: TargetLockFile = { version: 1, locks: {} };
  let upgraded = 0;
  for (const [root, l] of Object.entries(doc.locks)) {
    if (!l || !Number.isInteger(l.pr) || typeof l.by !== "string" || typeof l.at !== "string") continue;
    const stage = l.stage === "plan" || l.stage === "apply" || l.stage === "lock" ? l.stage : l.via === "lock" ? "lock" : "apply";
    if (l.stage !== stage) upgraded++;
    next.locks[root] = { pr: l.pr as number, by: l.by, at: l.at, stage, ...(typeof l.head === "string" ? { head: l.head } : {}) };
  }
  if (upgraded === 0) return;
  await writeBlobToPath("_locks", `${LOCK_GATE}.json`, renderTargetLocks(next), `Give ${upgraded} root lock${upgraded === 1 ? "" : "s"} of ${LOCK_GATE} the stage chant reads`, { cwd: repo, expectPriorPathSha: sha });
  const pushed = await pushLifecycleStatus({ cwd: repo });
  if (pushed.status === "stale" || pushed.status === "failed") throw new Error(`could not push the upgraded root locks to chant/lifecycle (${pushed.stderr.trim()}); run the job again`);
}
