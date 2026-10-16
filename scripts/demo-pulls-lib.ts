// What scripts/demo-pulls.ts decides, kept apart so it can be tested without
// a Forgejo: which closed pull requests of a demo repo to delete, and when
// Forgejo's own maintenance is due.

/** The fewest closed pull requests a repo keeps, whatever DEMO_FORGE_PULLS says: more than the cycles and runs the bucket names. */
export const PULLS_KEEP_MIN = 10;
/** At most this many pull requests are deleted per repo in one reset, so a long backlog never holds one up. */
export const PULLS_DELETE_MAX = 50;
/** Forgejo's maintenance (git gc, the Actions cleanup) runs at most this often by default, in seconds. */
export const MAINTENANCE_EVERY = 3600;

/** What Forgejo returns for a pull request (GET .../pulls), the fields read here. */
export interface ForgePull {
  number: number;
  state: string;
}

/**
 * The pull requests of `repo` that the reports bucket still names: each step
 * of the stored cycle records (<prefix>/cycles/<tool>/<n>.json and
 * latest.json), which behold's tool page replays, and each run in
 * <prefix>/runs/index.json, which its runs pane lists.
 */
export function referencedPulls(repo: string, docs: readonly unknown[]): Set<number> {
  const out = new Set<number>();
  const add = (v: unknown) => {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out.add(v);
  };
  for (const d of docs) {
    if (!d || typeof d !== "object") continue;
    const doc = d as { repo?: unknown; steps?: unknown; runs?: unknown; pull?: unknown };
    // A cycle record: its repo, and the pull each step names.
    if (Array.isArray(doc.steps)) {
      if (doc.repo !== repo) continue;
      add(doc.pull);
      for (const s of doc.steps) if (s && typeof s === "object") add((s as { pull?: unknown }).pull);
      continue;
    }
    // The runs index: each run names its repo (null for a run copied before repos were kept, which may be any).
    if (Array.isArray(doc.runs)) {
      for (const r of doc.runs) {
        if (!r || typeof r !== "object") continue;
        const run = r as { repo?: unknown; pull?: unknown };
        if (run.repo === repo || run.repo === null || run.repo === undefined) add(run.pull);
      }
    }
  }
  return out;
}

/**
 * The closed pull requests to delete, oldest first. `oldest` is the start of
 * the repo's closed pull requests, oldest first, and `closed` how many it has
 * in all. Every one past the newest `keep` (never fewer than PULLS_KEEP_MIN)
 * may go, except one that is open, the newest pull request the repo has (the
 * cycle that just ended), or one the bucket names (`protect`); at most
 * PULLS_DELETE_MAX.
 */
export function pullsToDelete(o: { oldest: readonly ForgePull[]; closed: number; keep: number; newest: number; protect: ReadonlySet<number> }): number[] {
  const past = o.closed - Math.max(o.keep, PULLS_KEEP_MIN);
  if (past <= 0) return [];
  return [...new Map(o.oldest.map((p) => [p.number, p])).values()]
    .sort((a, b) => a.number - b.number)
    .slice(0, past)
    .filter((p) => p.state === "closed" && p.number !== o.newest && !o.protect.has(p.number))
    .map((p) => p.number)
    .slice(0, PULLS_DELETE_MAX);
}

/** Whether Forgejo's maintenance is due: never run, or last run `every` seconds ago or more. */
export function maintenanceDue(lastAt: number | null, now: number, every = MAINTENANCE_EVERY): boolean {
  return lastAt === null || !Number.isFinite(lastAt) || now - lastAt >= every;
}
