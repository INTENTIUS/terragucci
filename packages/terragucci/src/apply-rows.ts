/**
 * How the applies of one binary are kept apart, and the rows a choudoufu
 * apply holds while it applies.
 *
 * Every binary but choudoufu applies per root: two applies of different roots
 * run at once, and the backend's own state lock keeps two applies of one root
 * apart. choudoufu keeps one record per resource, writes each conditionally,
 * and its `apply <planfile>` re-reads the live system and refuses a plan one
 * of whose changes moved since it was made. So a choudoufu wave holds the
 * resources its approved plans change, not the root: before its apply, so
 * before that re-read, it takes one row per changed resource, and two waves
 * that change different resources of one estate apply at the same time.
 *
 * The rows are chant's (chant#4552, #4594): the grain and the keys come from
 * the terraform lexicon (`terraformDefaultLockGrain`, `terraformLockRows`),
 * and the take, release and read go through chant's
 * `lifecycle/resource-lock`, in `_locks/rows/pr-apply.json`, the file chant's
 * own applies hold rows in (a pull request's apply, a fan-out, a promote, an
 * op wave). A terragucci wave and a chant apply that change one resource then
 * meet on one row. A wave takes all its rows in one commit, and a row held by
 * a run that is gone, or whose lease is older than `TG_LOCK_STALE` seconds,
 * is taken over in the same commit, so nothing needs unlocking.
 */
import { basename } from "node:path";
import {
  forgeLockLiveness,
  heldLockRowsIn,
  lockRowHolder,
  readLockRows,
  releaseLockRows,
  takeLockRows,
  type LockLiveness,
  type LockRowHolder,
  type LockRowsFile,
} from "@intentius/chant/lifecycle/resource-lock";
import { terraformDefaultLockGrain, terraformLockRows } from "@intentius/chant-lexicon-terraform/lock-rows";

/**
 * shape: the one decision a binary makes about concurrent applies.
 * `resource`: the wave holds rows for the resources its plans change.
 * `root`: nothing is held; the backend's state lock keeps one root's applies apart.
 * `repo`: one apply at a time in the repo (a concurrency group, or the lock tag on Forgejo).
 */
export type ApplyScope = "resource" | "root" | "repo";

/** The lexicon's default grain for the binary: `resource` under choudoufu, a root under every other. */
export function applyScope(binary: string): ApplyScope {
  const name = basename(binary).replace(/\.exe$/, "");
  return terraformDefaultLockGrain(name === "choudoufu" ? "choudoufu" : undefined) === "resource" ? "resource" : "root";
}

/** One row a wave takes: what it keys, and the change it stands for. */
export interface ApplyRow {
  key: string;
  root: string;
  address: string;
}

/** The run holding rows: chant's holder. */
export type RowHolder = LockRowHolder;

/** chant's rows file. */
export type RowsFile = LockRowsFile;

/** A row another run holds, keyed by the row this wave wanted. */
export interface HeldRow {
  key: string;
  holder: RowHolder;
}

/** Whether a holder is still running: `dead` when it is gone, `alive` when it runs or nobody can say. */
export type Liveness = LockLiveness;

/** The gate whose rows file chant's applies hold rows in: the pull-request loop's (`PR_APPLY_GATE`). */
export const CHANT_ROWS_GATE = "pr-apply";

/** The rows a plan's changes key, from the terraform lexicon. */
export function planRows(root: string, estate: string | undefined, plan: unknown): ApplyRow[] {
  return terraformLockRows(root, estate, plan).map((r) => ({ key: r.key, root: r.target, address: r.address }));
}

/** Who this wave is, as the rows name it: chant's holder, with the commit `TG_SHA` names when set. */
export function rowHolder(env: NodeJS.ProcessEnv, now: Date = new Date()): RowHolder {
  const h = lockRowHolder(env, now);
  return env.TG_SHA ? { ...h, sha: env.TG_SHA } : h;
}

/** Ask the forge whether a holder's run is gone: chant's liveness, which reads `TG_TOKEN` and `TG_LOCK_STALE`. */
export const forgeLiveness = (env: NodeJS.ProcessEnv, fetch?: Parameters<typeof forgeLockLiveness>[1], now?: () => number): Liveness => forgeLockLiveness(env, fetch, now);

export type TakeResult = { ok: true; tookOver: RowHolder[] } | { ok: false; held: HeldRow[] };

/** Take `rows` for `me` with chant's row leases; a held row names the row this take wanted. */
export async function takeRows(repo: string, rows: readonly ApplyRow[], me: RowHolder, alive: Liveness): Promise<TakeResult> {
  const taken = await takeLockRows(CHANT_ROWS_GATE, rows.map((r) => ({ key: r.key, target: r.root, address: r.address })), me, { cwd: repo, alive });
  return taken.ok ? { ok: true, tookOver: taken.tookOver } : { ok: false, held: taken.held.map((h) => ({ key: h.wanted, holder: h.holder })) };
}

/** Let go of `keys` where `me` still holds them. Never throws: a row left held is taken over once the run is gone. */
export function releaseRows(repo: string, keys: readonly string[], me: string): Promise<boolean> {
  return releaseLockRows(CHANT_ROWS_GATE, keys, me, { cwd: repo });
}

/** The rows as origin holds them now. */
export function readRows(repo: string): Promise<RowsFile> {
  return readLockRows(CHANT_ROWS_GATE, { cwd: repo });
}

/** Who else holds a row that meets any of `keys`, split into runs still going and runs that are gone. */
export async function heldBy(file: RowsFile, keys: readonly string[], me: string, alive: Liveness): Promise<{ live: HeldRow[]; gone: string[] }> {
  const { live, gone } = await heldLockRowsIn(file, keys, me, alive);
  return { live: live.map((h) => ({ key: h.wanted, holder: h.holder })), gone };
}

/** One line naming the runs that hold rows, and the resources, for a log line and a reply. */
export function describeHeld(held: readonly HeldRow[], rows: readonly ApplyRow[]): string {
  const byRun = new Map<string, { holder: RowHolder; addresses: Set<string> }>();
  const address = new Map(rows.map((r) => [r.key, `${r.root}: ${r.address}`]));
  for (const h of held) {
    const e = byRun.get(h.holder.run) ?? { holder: h.holder, addresses: new Set<string>() };
    e.addresses.add(address.get(h.key) ?? h.key);
    byRun.set(h.holder.run, e);
  }
  return [...byRun.values()]
    .map(({ holder, addresses }) => `run ${holder.run}${holder.url ? ` (${holder.url})` : ""} is applying ${[...addresses].sort().join(", ")}`)
    .join("; ");
}
