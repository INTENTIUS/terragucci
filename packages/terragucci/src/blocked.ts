/**
 * A failed root blocks only the roots that depend on it (terragucci#1161).
 *
 * Each apply job of a push writes its wave's outcome beside its report, one
 * status per root it handled, in `terragucci-report/outcome-wave-<k>….json`.
 * The pipeline hands each later wave the earlier waves' report artifacts
 * (`--after <dir>`). A wave then plans and applies only the roots whose
 * upstreams, the roots whose state they read and those `waves.after` puts
 * before them (rootOrder, ./detect.ts), all applied in this run or had
 * nothing to apply. The rest are blocked, each naming the root whose failure
 * held it: a root blocked behind a blocked root names the same one.
 *
 *   {
 *     "version": 1, "wave": 2, "at": "2026-10-18T10:00:09.000Z",
 *     "roots": {
 *       "cluster-b": { "status": "applied" },
 *       "cluster-a": { "status": "failed" },
 *       "app-01": { "status": "blocked", "by": "cluster-a" }
 *     }
 *   }
 *
 * A status is applied, unchanged (planned no change), failed (its plan or its
 * apply failed), waiting (its wave waits for an approval), refused (its wave
 * was refused, held or stood down), decided (its wave's job decided it and
 * its share or group job applies it), not-applied (its wave applied nothing
 * because another root of it failed to plan) or blocked. Only applied and
 * unchanged let a dependent through. A wave job runs again on a re-run, so
 * the newest outcome of a root wins.
 *
 * Wave 1 runs the repo's state migrations first, and a state about to be
 * rewritten must not be applied against, so a wave 1 that did not apply in a
 * repo with migrations writes `holds_all`: every later root is blocked by its
 * gate, `wave-1`, as before this change.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUTCOME_VERSION = 1;

/** The directory a wave writes its report and its outcome in: render.ts's REPORT_DIR, which the job keeps as its artifact. */
export const WAVE_REPORT_DIR = "terragucci-report";

/** Where a pipeline's apply job downloads the earlier waves' report artifacts, the directory `--after` names. */
export const EARLIER_DIR = "terragucci-earlier";

export type RootStatus = "applied" | "unchanged" | "failed" | "waiting" | "refused" | "decided" | "not-applied" | "blocked";

export interface RootOutcome {
  status: RootStatus;
  /** A blocked root's: the root whose failure held it, past any root blocked in between. */
  by?: string;
}

export interface WaveOutcomeFile {
  version: typeof OUTCOME_VERSION;
  wave: number;
  /** When the job wrote it: the newest outcome of a root wins. */
  at: string;
  roots: Record<string, RootOutcome>;
  /** Wave 1 of a repo with state migrations that did not apply: it holds every later root (by its gate, wave-1). */
  holds_all?: true;
}

/** The outcome file of a wave's job, or of one group or share of it. */
export function outcomeFileName(wave: number, part: { group?: string; share?: number } = {}): string {
  const group = part.group !== undefined ? `-group-${part.group.replace(/[^A-Za-z0-9._-]/g, "_")}` : "";
  const share = part.share !== undefined ? `-share-${part.share}` : "";
  return `outcome-wave-${wave}${group}${share}.json`;
}

export function writeOutcomeFile(dir: string, wave: number, part: { group?: string; share?: number }, roots: Record<string, RootOutcome>, at = new Date().toISOString(), holdsAll = false): string {
  const file = join(dir, outcomeFileName(wave, part));
  const body: WaveOutcomeFile = { version: OUTCOME_VERSION, wave, at, roots: Object.fromEntries(Object.entries(roots).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), ...(holdsAll ? { holds_all: true as const } : {}) };
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}

/** Every outcome file under `dirs`, at any depth: the downloaded artifacts keep each job's in a directory of its own. */
function outcomeFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let dirEntry = false;
      try {
        dirEntry = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (dirEntry) {
        if (depth < 4) walk(abs, depth + 1);
      } else if (/^outcome-wave-\d+.*\.json$/.test(name)) out.push(abs);
    }
  };
  for (const d of dirs) if (existsSync(d)) walk(d, 0);
  return out.sort();
}

/**
 * The outcome of each root of the waves before `wave`, as their jobs wrote
 * them: for a root more than one job wrote (a re-run, or a split wave's
 * deciding job and the share that applied it), the newest. A file that does
 * not parse, or is of another version, is skipped.
 */
export function earlierOutcomes(dirs: readonly string[], wave: number): Map<string, RootOutcome & { wave: number; at: string }> {
  return earlierRun(dirs, wave).roots;
}

/** earlierOutcomes, and the earlier wave whose newest outcome holds every later root, if any. */
export function earlierRun(dirs: readonly string[], wave: number): { roots: Map<string, RootOutcome & { wave: number; at: string }>; holdsAll?: number } {
  const out = new Map<string, RootOutcome & { wave: number; at: string }>();
  const newest = new Map<number, { at: string; holdsAll: boolean }>();
  for (const file of outcomeFiles(dirs)) {
    let f: WaveOutcomeFile;
    try {
      f = JSON.parse(readFileSync(file, "utf-8")) as WaveOutcomeFile;
    } catch {
      continue;
    }
    if (f?.version !== OUTCOME_VERSION || !Number.isInteger(f.wave) || f.wave >= wave || typeof f.roots !== "object" || f.roots === null) continue;
    for (const [root, o] of Object.entries(f.roots)) {
      const had = out.get(root);
      if (had && had.at > f.at) continue;
      out.set(root, { ...o, wave: f.wave, at: f.at });
    }
    const n = newest.get(f.wave);
    if (!n || n.at <= f.at) newest.set(f.wave, { at: f.at, holdsAll: f.holds_all === true });
  }
  const holding = [...newest].filter(([, n]) => n.holdsAll).map(([k]) => k).sort((a, b) => a - b);
  return { roots: out, ...(holding.length ? { holdsAll: holding[0] } : {}) };
}

const THROUGH: ReadonlySet<RootStatus> = new Set(["applied", "unchanged"]);

/**
 * The roots of `roots` an upstream that did not apply holds, each with the
 * root whose failure holds it. `upstreams` is each root's upstreams; only
 * those in `earlierWaves` count (a root of this wave or a later one is no
 * upstream it waits for here). An upstream with no outcome at all did not
 * apply as far as this run knows, so it holds its dependents and names itself.
 */
export function blockedRoots(
  roots: readonly string[],
  upstreams: ReadonlyMap<string, ReadonlySet<string>>,
  earlierWaves: ReadonlySet<string>,
  outcomes: ReadonlyMap<string, RootOutcome>,
  holdsAll?: number,
): Map<string, string> {
  const out = new Map<string, string>();
  if (holdsAll !== undefined) return new Map(roots.map((r) => [r, `wave-${holdsAll}`]));
  for (const root of roots) {
    const by = [...(upstreams.get(root) ?? [])]
      .filter((u) => earlierWaves.has(u))
      .sort()
      .map((u) => {
        const o = outcomes.get(u);
        if (o && THROUGH.has(o.status)) return undefined;
        return o?.status === "blocked" && o.by ? o.by : u;
      })
      .find((b): b is string => b !== undefined);
    if (by !== undefined) out.set(root, by);
  }
  return out;
}

/**
 * Whether every root that did not apply in the run waits for an approval, or
 * is blocked behind one that does: the run waits rather than failed, so a
 * later wave's job ends as waiting (3), and the approval's re-run applies them.
 */
export function onlyWaiting(outcomes: ReadonlyMap<string, RootOutcome>): boolean {
  let held = false;
  for (const o of outcomes.values()) {
    if (THROUGH.has(o.status)) continue;
    held = true;
    if (o.status === "waiting") continue;
    if (o.status === "blocked" && o.by !== undefined && outcomes.get(o.by)?.status === "waiting") continue;
    return false;
  }
  return held;
}

/** Each blocked root, as the report and the log list it: `app-01 (by cluster-a)`. */
export function blockedWords(blocked: ReadonlyMap<string, string>): string {
  const byRoot = new Map<string, string[]>();
  for (const [root, by] of [...blocked].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) byRoot.set(by, [...(byRoot.get(by) ?? []), root]);
  return [...byRoot].map(([by, rs]) => `${rs.join(", ")} (blocked by ${by})`).join("; ");
}

/**
 * How the run came out, from every root's newest outcome: "8 applied, 1
 * failed, 6 blocked", with waiting, refused and the rest named when there
 * are any, and undefined when every root applied or had nothing to apply.
 */
export function runSummary(outcomes: Iterable<RootOutcome>): string | undefined {
  const counts = new Map<RootStatus, number>();
  for (const o of outcomes) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);
  const bad = [...counts.keys()].some((s) => !THROUGH.has(s));
  if (!bad) return undefined;
  const parts = [`${counts.get("applied") ?? 0} applied`, `${counts.get("failed") ?? 0} failed`, `${counts.get("blocked") ?? 0} blocked`];
  for (const s of ["waiting", "refused", "decided", "not-applied"] as const) if (counts.get(s)) parts.push(`${counts.get(s)} ${s === "decided" ? "not reported by their share" : s}`);
  if (counts.get("unchanged")) parts.push(`${counts.get("unchanged")} unchanged`);
  return parts.join(", ");
}
