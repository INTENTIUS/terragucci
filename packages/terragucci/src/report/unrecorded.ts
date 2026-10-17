/**
 * State versions no wave or migration recorded: the `unrecorded-write`
 * entries of the audit trail (./audit.ts).
 *
 * terragucci records the versions it writes: each `tf-apply` wave the
 * version of each root's state after it (`states.json`, ./state-versions.ts),
 * and each state migration every root's version after its write (the
 * `migration` entries, from `_gates/tf-migrate/done.jsonl`). A version the
 * state's store lists that is neither is a write from somewhere else, such
 * as an apply from a laptop. For each root, `terragucci audit` lists the
 * versions of its state where it is now (../backend.ts listStateVersions)
 * and adds one entry per version that is:
 *
 *   newer than the oldest version terragucci recorded for the root that the
 *     store still lists (versions from before terragucci recorded the root
 *     are not judged);
 *   not a version a wave or a migration recorded;
 *   not written while a wave that recorded the root was running (its report's
 *     start to its finish), which is where a binary's own writes during an
 *     apply land;
 *   older than SETTLE_SECONDS, so a wave still running has time to report.
 *
 * A root whose backend keeps no versions, or whose versions terragucci does
 * not read, is skipped and counted. Only ids and times are read, never a
 * state's contents.
 */
import type { StateVersionList } from "../backend";
import type { StateWriters } from "../state-writers";
import { AUDIT_SCHEMA, sha, type AuditEntry } from "./audit";
import type { ObjectVersion } from "./object-store";
import type { StateVersions } from "./state-versions";

/** How long a version waits before it is judged: a wave applies, and then uploads its report, within this. */
export const SETTLE_SECONDS = 6 * 3600;

/** What the check found for one project's roots, for audit.json. */
export interface UnrecordedCheck {
  /** Roots whose versions were listed and compared. */
  checked: number;
  /** Roots not compared, with why: versioning off or unknown, a backend terragucci does not list, or no version listed. */
  skipped: { root: string; reason: string }[];
  /** Roots whose store could not be listed, with the error. */
  unreadable: { root: string; error: string }[];
  /** Unrecorded versions younger than SETTLE_SECONDS, left for a later run. */
  pending: number;
}

export interface UnrecordedOptions {
  project: string;
  /** The project's states.json. */
  states?: StateVersions;
  /** The project's `migration` entries. */
  migrations: AuditEntry[];
  /** The store's versions of a state, by its location. */
  list: (location: string) => Promise<StateVersionList>;
  /** Who wrote a version; without it `who` is null. */
  writers?: StateWriters;
  /** Entry ids the record holds already: skipped, so each writer is looked up once. */
  known?: Set<string>;
  now: Date;
  settleSeconds?: number;
}

/** The id of the entry for one version of a state. */
export const unrecordedId = (project: string, location: string, versionId: string): string => sha("unrecorded", project, location, versionId);

const at = (iso: string | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

interface RootRecord {
  /** The state's location now, and when terragucci last recorded it there. */
  location?: string;
  since: number;
  versioning: "on" | "off" | "unknown";
  note?: string;
  ids: Set<string>;
  /** The oldest time terragucci recorded a version of the root. */
  first: number;
  /** When each wave that recorded the root ran. */
  windows: [number, number][];
}

/** What terragucci recorded of each root: from states.json and the migrations. */
function recorded(states: StateVersions | undefined, migrations: AuditEntry[]): Map<string, RootRecord> {
  const roots = new Map<string, RootRecord>();
  for (const r of states?.roots ?? []) {
    roots.set(r.root, {
      ...(r.location !== undefined ? { location: r.location } : {}),
      since: at(r.checked),
      versioning: r.versioning,
      ...(r.note !== undefined ? { note: r.note } : {}),
      ids: new Set(r.versions.map((v) => v.version_id)),
      first: Math.min(...r.versions.map((v) => at(v.finished)), Infinity),
      // A store writes LastModified to the second: the window opens a second early.
      windows: r.versions.filter((v) => v.started).map((v) => [at(v.started) - 1000, at(v.finished)]),
    });
  }
  for (const m of migrations) {
    // A migration that failed after its write still wrote the version it recorded.
    if (m.kind !== "migration") continue;
    const when = at(m.at);
    for (const x of Array.isArray(m.detail?.roots) ? (m.detail.roots as Record<string, unknown>[]) : []) {
      if (typeof x.root !== "string") continue;
      const after = typeof x.after === "string" ? x.after : undefined;
      const location = typeof x.location === "string" ? x.location : undefined;
      const r = roots.get(x.root) ?? { since: 0, versioning: "on" as const, ids: new Set<string>(), first: Infinity, windows: [] };
      if (after) {
        r.ids.add(after);
        r.first = Math.min(r.first, when);
      }
      // A migration that moved the state is where it is now, until a wave records it again.
      if (m.result === "applied" && location && when > r.since) {
        r.location = location;
        r.since = when;
        if (after) r.versioning = "on";
      }
      roots.set(x.root, r);
    }
  }
  return roots;
}

/** The `unrecorded-write` entries of one project, and what the check found. */
export async function unrecordedWrites(o: UnrecordedOptions): Promise<{ entries: AuditEntry[]; check: UnrecordedCheck }> {
  const settle = (o.settleSeconds ?? SETTLE_SECONDS) * 1000;
  const check: UnrecordedCheck = { checked: 0, skipped: [], unreadable: [], pending: 0 };
  const entries: AuditEntry[] = [];
  const roots = [...recorded(o.states, o.migrations)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [root, r] of roots) {
    if (r.versioning !== "on") {
      check.skipped.push({ root, reason: r.note ?? (r.versioning === "off" ? "its backend keeps no versions" : "its versions are not read") });
      continue;
    }
    if (!r.location) {
      check.skipped.push({ root, reason: "no location was recorded" });
      continue;
    }
    if (r.ids.size === 0) {
      check.skipped.push({ root, reason: "no version was recorded" });
      continue;
    }
    const listed = await o.list(r.location);
    if ("skipped" in listed) {
      check.skipped.push({ root, reason: listed.skipped });
      continue;
    }
    if ("error" in listed) {
      check.unreadable.push({ root, error: listed.error });
      continue;
    }
    check.checked++;
    const versions = [...listed.versions].sort((a, b) => at(b.written_at) - at(a.written_at));
    const kept = versions.filter((v) => r.ids.has(v.version_id));
    // Versions from before terragucci recorded the root are not judged.
    const from = kept.length > 0 ? Math.min(...kept.map((v) => at(v.written_at))) : r.first;
    for (const v of versions) {
      const when = at(v.written_at);
      if (when <= from || r.ids.has(v.version_id)) continue;
      if (r.windows.some(([a, b]) => when >= a && when <= b)) continue;
      if (when > o.now.getTime() - settle) {
        check.pending++;
        continue;
      }
      const id = unrecordedId(o.project, r.location, v.version_id);
      if (o.known?.has(id)) continue;
      entries.push(await entry(o, root, r.location, v, versions.find((x) => at(x.written_at) < when && r.ids.has(x.version_id)), id));
    }
  }
  return { entries, check };
}

async function entry(o: UnrecordedOptions, root: string, location: string, v: ObjectVersion, before: ObjectVersion | undefined, id: string): Promise<AuditEntry> {
  const answer = o.writers ? await o.writers.writer({ location, version_id: v.version_id, written_at: v.written_at, ...(v.deleted ? { deleted: true } : {}) }) : { status: "none" as const, why: "no log of the state's writes is read" };
  return {
    schema: AUDIT_SCHEMA,
    id,
    kind: "unrecorded-write",
    project: o.project,
    at: v.written_at,
    who: answer.status === "found" ? answer.who : null,
    what: root,
    digest: null,
    result: "unrecorded",
    evidence: { source: "state", location, version_id: v.version_id },
    detail: {
      location,
      recorded_version: before?.version_id ?? null,
      current_version: v.version_id,
      current_written_at: v.written_at,
      latest: v.latest,
      ...(v.deleted ? { deleted: true } : {}),
      who_source: answer.status === "found" ? answer.how : answer.why,
    },
  };
}
