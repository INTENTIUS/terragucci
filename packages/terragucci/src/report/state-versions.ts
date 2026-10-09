/**
 * The state versions each root's applies left: `<prefix>/<project>/states.json`,
 * `terragucci.state-versions/v1`. A `tf-apply` wave's report carries, for each
 * root it applied or that had nothing to apply, the backend's version id of
 * the root's state afterwards (`roots[].state`, read by ../backend.ts from
 * the object's metadata). The upload adds each new version to the root's list
 * here, newest first, so the estate page can list the exact version a person
 * restores, and the run, commit and wave that wrote it. A root whose backend
 * keeps no versions is listed with `versioning: off` and no version.
 *
 * Only version ids, locations and run facts are kept: never a state's contents.
 */
import type { Report, ReportStateVersion } from "./schema";

export const STATES_SCHEMA = "terragucci.state-versions/v1";

/** How many versions each root keeps in the file, newest first. */
export const STATE_VERSIONS_KEPT = 20;

/** One version an apply left. */
export interface StateVersionRow {
  version_id: string;
  commit: string;
  /** When the wave that recorded it finished. */
  finished: string;
  wave?: number;
  /** The wave's directory, relative to the project's index. */
  path: string;
}

/** One root's state: where it is, whether its backend keeps versions, and the versions its applies left. */
export interface StateRoot {
  root: string;
  backend: string;
  location?: string;
  /** As the newest apply found it. */
  versioning: ReportStateVersion["versioning"];
  note?: string;
  /** When the newest apply that recorded the root finished. */
  checked: string;
  /** Newest first, at most STATE_VERSIONS_KEPT. */
  versions: StateVersionRow[];
}

export interface StateVersions {
  schema: typeof STATES_SCHEMA;
  /** By root path. */
  roots: StateRoot[];
}

/** What a report adds: each root that recorded its state, with the run that recorded it. */
export interface StateRecord {
  root: string;
  state: ReportStateVersion;
  commit: string;
  finished: string;
  wave?: number;
  path: string;
}

/** The roots of a `tf-apply` wave's report that recorded their state. */
export function stateRecords(report: Report, path: string): StateRecord[] {
  if (report.run.stage !== "tf-apply") return [];
  return report.roots
    .filter((r) => r.state !== undefined)
    .map((r) => ({ root: r.path, state: r.state!, commit: report.run.commit, finished: report.run.finished, ...(report.run.wave !== undefined ? { wave: report.run.wave } : {}), path }));
}

/** Read the file; anything unreadable is an empty one, rebuilt from the next apply on. */
export function readStateVersions(text: string | undefined): StateVersions {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<StateVersions>;
      if (parsed.schema === STATES_SCHEMA && Array.isArray(parsed.roots)) return { schema: STATES_SCHEMA, roots: parsed.roots };
    } catch {
      // An unreadable file is rebuilt.
    }
  }
  return { schema: STATES_SCHEMA, roots: [] };
}

const at = (iso: string): number => Date.parse(iso) || 0;

/**
 * The file with each record added. A version already listed for the root is
 * not listed twice: a wave with nothing to apply finds the version the last
 * apply left. The root's location and versioning follow the newest record,
 * and an older wave's record never replaces them.
 */
export function addToStateVersions(existing: string | undefined, records: StateRecord[]): StateVersions {
  const held = new Map(readStateVersions(existing).roots.map((r) => [r.root, r]));
  for (const rec of records) {
    const old = held.get(rec.root);
    const newer = !old || !(at(old.checked) > at(rec.finished));
    const versions = [...(old?.versions ?? [])];
    const id = rec.state.version_id;
    if (id && !versions.some((v) => v.version_id === id)) {
      versions.push({ version_id: id, commit: rec.commit, finished: rec.finished, ...(rec.wave !== undefined ? { wave: rec.wave } : {}), path: rec.path });
    }
    versions.sort((a, b) => at(b.finished) - at(a.finished));
    const { backend, location, versioning, note } = newer ? rec.state : old!;
    held.set(rec.root, {
      root: rec.root,
      backend,
      ...(location !== undefined ? { location } : {}),
      versioning,
      ...(note !== undefined ? { note } : {}),
      checked: newer ? rec.finished : old!.checked,
      versions: versions.slice(0, STATE_VERSIONS_KEPT),
    });
  }
  return { schema: STATES_SCHEMA, roots: [...held.values()].sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)) };
}
