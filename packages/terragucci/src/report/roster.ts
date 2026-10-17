/**
 * Each estate's roster: every resource it holds, by address and type, and
 * whether the resource carries the estate's ownership marker. A viewer draws
 * an estate's resources from it without asking the cloud. It is written to
 * `<prefix>/estates/<estate>/roster.json` after a `tf-apply` wave applies a
 * root and after an estate migration writes its markers, and
 * `<prefix>/estates.json` lists each estate with its count.
 *
 * Both come from plans the job already made. A wave's roster is the applied
 * plan's `planned_values`, the state the apply leaves. A migration's is the
 * plan each root makes after the write, with the live id of each resource it
 * retagged or stamped and, for an instance that moved with another and has
 * no write of its own, the address it follows.
 *
 * A choudoufu root's estate is the one its `live` block names. A stock root
 * holds no markers, so its roster names the root as the estate and every
 * resource as unmarked.
 *
 * `marked` is read from the planned object's marker surface: the
 * `tofu-estate` key of `tags` or `tags_all`, or of the labels of a
 * Kubernetes object's metadata. Only whether it names the estate is kept.
 * No attribute value reaches the roster.
 */
import { isObject } from "./redact";
import { StoreError, type ObjectStore } from "./object-store";
import { updateJson, type Wait } from "./store";
import type { Report } from "./schema";

export const ESTATES_SCHEMA = "terragucci.estates/v1";

/** The marker that names the estate owning a live resource. */
export const ESTATE_MARKER = "tofu-estate";

export interface RosterResource {
  address: string;
  type: string;
  /** The live resource's id, where the job's reads name it: a retag or a stamp. */
  live_id?: string;
  /** The resource carries this estate's `tofu-estate` marker. */
  marked: boolean;
  /** The address of the resource this one moves with, with no marker write of its own. */
  follows?: string;
}

export interface Roster {
  estate: string;
  /** When the job read it: the wave's end, or the migration's write. */
  at: string;
  resources: RosterResource[];
}

/** A roster and where it came from, for the index. */
export interface RosterWrite {
  roster: Roster;
  project: string;
  root: string;
}

export interface EstateEntry {
  estate: string;
  /** How many resources the roster holds. */
  count: number;
  at: string;
  project: string;
  root: string;
  /** The roster's key, relative to estates.json. */
  roster: string;
}

export interface EstatesIndex {
  schema: typeof ESTATES_SCHEMA;
  /** By estate name. */
  estates: EstateEntry[];
}

/** What the job knows of a resource beyond the plan: its live id, and the resource it follows. */
export type RosterFacts = Map<string, { live_id?: string; follows?: string }>;

/** The value of `tofu-estate` in a map, when it holds one. */
const markerIn = (m: unknown): string | undefined => (isObject(m) && typeof m[ESTATE_MARKER] === "string" ? (m[ESTATE_MARKER] as string) : undefined);

/** The first item of a nested block, or the object itself. */
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);

/** The estate a planned object's marker names, read from tags, tags_all, metadata labels or a manifest's metadata labels. */
function markerOf(values: unknown): string | undefined {
  if (!isObject(values)) return undefined;
  const meta = first(values.metadata);
  const manifest = isObject(values.manifest) ? first(values.manifest.metadata) : undefined;
  return markerIn(values.tags) ?? markerIn(values.tags_all) ?? (isObject(meta) ? markerIn(meta.labels) : undefined) ?? (isObject(manifest) ? markerIn(manifest.labels) : undefined);
}

const byAddress = (a: RosterResource, b: RosterResource): number => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0);

/**
 * The managed resources a plan's planned values hold, child modules
 * included, sorted by address. With `estate` (a choudoufu root), each is
 * marked when its marker names that estate; without one (a stock root),
 * none is.
 */
export function rosterResources(plan: unknown, estate: string | undefined, facts: RosterFacts = new Map()): RosterResource[] {
  const out: RosterResource[] = [];
  const walk = (module: unknown): void => {
    if (!isObject(module)) return;
    for (const r of Array.isArray(module.resources) ? module.resources : []) {
      if (!isObject(r) || r.mode !== "managed" || typeof r.address !== "string" || typeof r.type !== "string") continue;
      const f = facts.get(r.address);
      out.push({ address: r.address, type: r.type, ...(f?.live_id ? { live_id: f.live_id } : {}), marked: estate !== undefined && markerOf(r.values) === estate, ...(f?.follows ? { follows: f.follows } : {}) });
    }
    for (const child of Array.isArray(module.child_modules) ? module.child_modules : []) walk(child);
  };
  const values = isObject(plan) ? plan.planned_values : undefined;
  walk(isObject(values) ? values.root_module : undefined);
  return out.sort(byAddress);
}

/** A root's roster: its estate's, or for a stock root (no estate), the root's. */
export function rosterOf(root: string, estate: string | undefined, plan: unknown, at: string, facts?: RosterFacts): Roster {
  return { estate: estate ?? stockEstate(root), at, resources: rosterResources(plan, estate, facts) };
}

/** A stock root's estate name: its path, or `root` for the repo's top. */
export const stockEstate = (root: string): string => root.replace(/^\.(\/+|$)/, "").replace(/\/+$/, "") || "root";

/**
 * The rosters of a `tf-apply` wave's report: one per root that applied (or
 * had nothing to apply), the roots the inventory lists. `plans` holds each
 * root's plan and the estate its live block names, when it has one.
 */
export function waveRosters(report: Report, plans: Map<string, { plan: unknown; estate?: string }>): RosterWrite[] {
  if (report.run.stage !== "tf-apply") return [];
  return report.roots.flatMap((r) => {
    const p = plans.get(r.path);
    if (r.resources === undefined || !p) return [];
    return [{ roster: rosterOf(r.path, p.estate, p.plan, report.run.finished), project: report.run.project, root: r.path }];
  });
}

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const joinKey = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");

/** Where an estate's roster is: `<prefix>/estates/<estate>/roster.json`. */
export const rosterKey = (estate: string, prefix = ""): string => joinKey(prefix, "estates", estate, "roster.json");

/** Where the estates' index is: `<prefix>/estates.json`, beside the reports index. */
export const estatesKey = (prefix = ""): string => joinKey(prefix, "estates.json");

/** Read an estates index; anything unreadable is an empty one, rebuilt from the next roster on. */
export function readEstates(text: string | undefined): EstatesIndex {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<EstatesIndex>;
      if (Array.isArray(parsed.estates)) return { schema: ESTATES_SCHEMA, estates: parsed.estates };
    } catch {
      // An unreadable index is rebuilt.
    }
  }
  return { schema: ESTATES_SCHEMA, estates: [] };
}

const newer = (held: { at: string } | undefined, at: string): boolean => held !== undefined && Date.parse(held.at) > Date.parse(at);

/** The index with each roster's entry replaced, unless the index holds a newer one for that estate. */
export function addToEstates(existing: string | undefined, writes: RosterWrite[]): EstatesIndex {
  const held = new Map(readEstates(existing).estates.map((e) => [e.estate, e]));
  for (const w of writes) {
    if (newer(held.get(w.roster.estate), w.roster.at)) continue;
    held.set(w.roster.estate, { estate: w.roster.estate, count: w.roster.resources.length, at: w.roster.at, project: w.project, root: w.root, roster: rosterKey(w.roster.estate) });
  }
  return { schema: ESTATES_SCHEMA, estates: [...held.values()].sort((a, b) => (a.estate < b.estate ? -1 : a.estate > b.estate ? 1 : 0)) };
}

/** The roster to keep at its key: this one, unless the bucket's copy is newer. */
function keepNewer(existing: string | undefined, roster: Roster): Roster {
  if (existing) {
    try {
      const held = JSON.parse(existing) as Partial<Roster>;
      if (typeof held.at === "string" && Array.isArray(held.resources) && newer({ at: held.at }, roster.at)) return held as Roster;
    } catch {
      // An unreadable roster is replaced.
    }
  }
  return roster;
}

/**
 * Write each roster to `<prefix>/estates/<estate>/roster.json` and its entry
 * to `<prefix>/estates.json`, each conditional on the copy read (updateJson).
 * Returns the keys written. Throws StoreError when the bucket refuses.
 */
export async function uploadRosters(s3: ObjectStore, writes: RosterWrite[], prefix = "", wait?: Wait): Promise<string[]> {
  if (writes.length === 0) return [];
  const keys: string[] = [];
  for (const w of writes) {
    if (!w.roster.estate.split("/").every((s) => s && s !== "." && s !== "..")) throw new StoreError(`estate ${w.roster.estate} names no key under ${joinKey(prefix, "estates")}/`);
    const key = rosterKey(w.roster.estate, prefix);
    await updateJson(s3, key, (body) => keepNewer(body, w.roster), `the roster of ${w.roster.estate}`, wait);
    keys.push(key);
  }
  const index = estatesKey(prefix);
  await updateJson(s3, index, (body) => addToEstates(body, writes), "its estates", wait);
  keys.push(index);
  return keys;
}
