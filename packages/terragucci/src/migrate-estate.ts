/**
 * Migrations into and between choudoufu estates: roots whose `terraform`
 * block holds a `live` block keep no state file, so `state pull` and `state
 * push` have nothing to read or write. Ownership is a marker on each live
 * resource (the `tofu-estate` and `tofu-address` tags), so:
 *
 *   moves     between two estates is a retag: `choudoufu live-mv
 *             -from-estate` rewrites the markers of each resource, run in
 *             the root it moves to
 *   backends  from an s3 or local state into an estate is an adoption:
 *             `choudoufu live-import` reads the old state once and stamps
 *             the markers on every resource it verifies; the old state is
 *             left where it was
 *
 * The proof is read-only: each root's plan as the code stands, and the
 * binary's own preview of the write (`live-mv -dry-run -json`, or
 * `live-import` without `-approve`). Every change a root plans must be one
 * the write removes: a destroy in the estate a resource leaves and a create
 * in the one it joins, or a create of a resource the old state holds and
 * the live system verifies. The digest covers each root's planned changes,
 * the live id of each resource, and the old state's version and digest.
 * After the write every root plans again and must show no change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stateClient, stateObject, type StateObject } from "./backend";
import { ConfigError, resolveRepo } from "./config";
import { estateOf } from "./detect";
import {
  backendRefusal,
  firstLine,
  locationOf,
  migrationDigest,
  placesOf,
  planChanges,
  runBinary,
  sha,
  stateDigest,
  takeLocks,
  versionOf,
  type BinaryExec,
  type MigrateOptions,
  type Migration,
  type MigrationRecord,
  type MigrationRoot,
  type Place,
  type PlannedMigration,
  type StateFile,
  MIGRATION_SCHEMA,
} from "./migrate";
import { detectShape } from "./shape";
import type { S3Target } from "./report/s3";

/** One resource instance a retag moves: its address in both roots, the estates, and the live resource the markers are on. */
export interface Retag {
  address: string;
  from: string;
  to: string;
  from_estate: string;
  to_estate: string;
  live_id: string;
  /** Instances whose identity composes from this one and follow it with no write of their own. */
  followers: string[];
}

/** One resource instance of an adopted state, as `live-import` verified it. */
export interface Stamp {
  root: string;
  estate: string;
  address: string;
  type: string;
  status: string;
  live_id?: string;
}

/** What an estate migration's apply needs beyond the record. */
export type EstatePlan = { kind: "retag"; retags: Retag[] } | { kind: "adopt"; adopts: { root: string; estate: string; state: string; source: StateObject; version?: string; digest: string }[] };

/** Whether the binary is choudoufu: the one that reads and writes ownership markers. */
export const isChoudoufu = (binary: string): boolean => /(^|\/)choudoufu[^/]*$/.test(binary);

/** Init a live root. choudoufu refuses `-reconfigure` under a live block: there is no backend to reconfigure. */
async function initEstate(exec: BinaryExec, binary: string, root: string, place: Place): Promise<void> {
  const init = await exec(binary, ["init", "-input=false", "-no-color"], place.dir, place.init?.init ?? place.env);
  if (init.code !== 0) throw new ConfigError(`init in ${root} failed: ${firstLine(init.out)}`);
}

function estateName(repo: string, root: string): string {
  const e = estateOf(join(repo, root)).estate;
  if (!e) throw new ConfigError(`${root} has a live block that names no estate`);
  return e;
}

/** `<address>: <actions>` split back into its parts. */
const parseChange = (c: string): { address: string; actions: string } => {
  const i = c.lastIndexOf(": ");
  return { address: c.slice(0, i), actions: c.slice(i + 2) };
};

/** The instances of a resource address among a plan's changes: the address itself, or it with an instance key. */
const instancesOf = (address: string, changes: string[], actions: string): string[] =>
  changes
    .map(parseChange)
    .filter((c) => c.actions === actions && (c.address === address || c.address.startsWith(`${address}[`)))
    .map((c) => c.address)
    .sort();

// ── live-mv ──────────────────────────────────────────────────────────────

/** What `live-mv -json` prints: the parts a retag reads. */
interface MoveDoc {
  resource?: { live_id?: string };
  from?: { estate?: string; address?: string };
  to?: { estate?: string; address?: string };
  followers?: { address?: string }[];
  dry_run?: boolean;
  written?: boolean;
  refusal?: { code?: string; summary?: string; detail?: string } | null;
}

/** Run `live-mv -json -from-estate` for one instance in the root it moves to; a dry run writes nothing. */
async function liveMv(exec: BinaryExec, binary: string, place: Place, fromEstate: string, address: string, dry: boolean): Promise<MoveDoc> {
  const ran = await exec(binary, ["live-mv", "-no-color", "-json", ...(dry ? ["-dry-run"] : []), `-from-estate=${fromEstate}`, address, address], place.dir, place.env);
  let doc: MoveDoc | undefined;
  try {
    doc = JSON.parse(ran.stdout) as MoveDoc;
  } catch {
    doc = undefined;
  }
  const refused = doc?.refusal ? [doc.refusal.summary, doc.refusal.detail].filter(Boolean).join(": ") : undefined;
  if (ran.code !== 0 || !doc || refused) throw new ConfigError(`live-mv ${dry ? "-dry-run " : ""}refuses ${address}: ${refused ?? firstLine(ran.out)}`);
  return doc;
}

/** Rewrite one resource's markers, and check the binary says it wrote them on the resource the plan found. */
async function writeRetag(exec: BinaryExec, binary: string, place: Place, t: Retag, log: (line: string) => void): Promise<void> {
  const doc = await liveMv(exec, binary, place, t.from_estate, t.address, false);
  if (doc.written !== true) throw new ConfigError(`live-mv wrote nothing on ${t.address}`);
  if (doc.resource?.live_id !== t.live_id) throw new ConfigError(`live-mv rewrote ${doc.resource?.live_id ?? "an unnamed resource"} for ${t.address}, not ${t.live_id}`);
  log(`${t.address}: retagged from estate ${t.from_estate} to estate ${t.to_estate}`);
}

// ── live-import ──────────────────────────────────────────────────────────

/** `live-import`'s ratification report: one entry per resource instance, by status. */
export function parseRatification(text: string): { address: string; type: string; status: string; live_id?: string }[] {
  const out: { address: string; type: string; status: string; live_id?: string }[] = [];
  let status: string | undefined;
  for (const line of text.split("\n")) {
    const head = /^([A-Z_]+) \(\d+\) - /.exec(line);
    if (head) {
      status = ["VERIFIED", "DRIFTED", "MISSING", "UNTAGGABLE", "UNADMITTED_TYPE"].includes(head[1]!) ? head[1] : undefined;
      continue;
    }
    if (!line.trim()) continue;
    const row = /^ {2}(\S+)\s+(\S+)\s+live id: (\S+)\s*$/.exec(line);
    if (status && row) out.push({ address: row[1]!, type: row[2]!, status, ...(row[3] !== "-" ? { live_id: row[3]! } : {}) });
    if (/eligible for stamping/.test(line)) status = undefined;
  }
  return out;
}

/** Statuses a stamp makes plan with no change: verified and stamped, or outside the taggable subset and composed from a stamped parent. */
const ADOPTED = ["VERIFIED", "UNTAGGABLE"];

/** `live-import -approve`'s last count line: how many failed. */
export function stampFailures(text: string): number | undefined {
  const m = /(\d+) failed, \d+ skipped\./.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** The flag that makes `live-import` write the markers. */
const STAMP = "-approve";

async function liveImport(exec: BinaryExec, binary: string, place: Place, state: string, estate: string, write: boolean): Promise<string> {
  const ran = await exec(binary, ["live-import", "-no-color", `-state=${resolve(state)}`, `-estate=${estate}`, ...(write ? [STAMP] : [])], place.dir, place.env);
  if (ran.code !== 0) throw new ConfigError(`live-import ${write ? "could not stamp" : "could not verify"} ${state.replace(/^.*\//, "")}: ${firstLine(ran.out)}`);
  return ran.stdout;
}

// ── planning ─────────────────────────────────────────────────────────────

/**
 * Plan a migration whose roots are choudoufu estates (every root it names
 * has a live block): a retag for `moves`, an adoption for `backends`.
 */
export async function planEstateMigration(repo: string, m: Migration, options: MigrateOptions): Promise<PlannedMigration> {
  const exec = options.exec ?? runBinary;
  const env = options.env ?? process.env;
  if (!isChoudoufu(options.binary)) throw new ConfigError(`migration ${m.name} cannot run: its roots keep their resources under live markers, which only choudoufu reads, and this job runs ${options.binary}`);
  if (m.kind === "revert") throw new ConfigError(`migration ${m.name} cannot run: an estate keeps no state file to put back; move the resources back with a moves migration the other way`);
  const roots = [...new Set(m.kind === "backends" ? m.backends.map((b) => b.root) : m.moves.flatMap((x) => [x.from, x.to]))].sort();
  const places = await placesOf(repo, roots, options, env, detectShape(repo, resolveRepo({})));
  const estates = new Map(roots.map((r) => [r, estateName(repo, r)]));
  for (const root of roots) await initEstate(exec, options.binary, root, places.get(root)!);
  const plans = new Map<string, { changes: string[]; summary: string }>();
  for (const [i, root] of roots.entries()) {
    const p = places.get(root)!;
    plans.set(root, await planChanges(exec, options.binary, p.dir, p.env, options.work, `estate-${i}`, true));
  }
  return m.kind === "moves" ? planRetag(m, roots, estates, plans, places, exec, options) : planAdopt(repo, m, roots, estates, plans, places, exec, options);
}

async function planRetag(m: Migration, roots: string[], estates: Map<string, string>, plans: Map<string, { changes: string[]; summary: string }>, places: Map<string, Place>, exec: BinaryExec, options: MigrateOptions): Promise<PlannedMigration> {
  const log = options.log ?? (() => {});
  const problems: string[] = [];
  const retags: Retag[] = [];
  for (const mv of m.moves) {
    const fromEstate = estates.get(mv.from)!;
    const toEstate = estates.get(mv.to)!;
    if (fromEstate === toEstate) {
      problems.push(`${mv.from} and ${mv.to} are both estate ${fromEstate}; a move inside one estate is a moved block`);
      continue;
    }
    for (const address of mv.addresses) {
      if (/(^|\.)module\.[A-Za-z_][\w-]*$/.test(address)) {
        problems.push(`${address} is a module call; a retag names each resource in it`);
        continue;
      }
      const instances = instancesOf(address, plans.get(mv.from)!.changes, "delete");
      if (instances.length === 0) {
        problems.push(`${address}: the plan of ${mv.from} does not destroy it, so estate ${fromEstate} holds no live resource it leaves`);
        continue;
      }
      for (const inst of instances) {
        const doc = await liveMv(exec, options.binary, places.get(mv.to)!, fromEstate, inst, true);
        if (!doc.resource?.live_id) throw new ConfigError(`live-mv -dry-run names no live resource for ${inst}`);
        const followers = (doc.followers ?? []).map((f) => f.address).filter((a): a is string => typeof a === "string").sort();
        retags.push({ address: inst, from: mv.from, to: mv.to, from_estate: fromEstate, to_estate: toEstate, live_id: doc.resource.live_id, followers });
        log(`${inst}: ${doc.resource.live_id} moves from estate ${fromEstate} to estate ${toEstate}${followers.length ? `, with ${followers.join(", ")}` : ""}`);
      }
    }
  }
  if (problems.length > 0) throw new ConfigError(`migration ${m.name}:\n  ${problems.join("\n  ")}`);
  const out: MigrationRoot[] = [];
  for (const root of roots) {
    const leaving = retags.filter((t) => t.from === root);
    const joining = retags.filter((t) => t.to === root);
    const accounted = new Set([...leaving.flatMap((t) => [t.address, ...t.followers].map((a) => `${a}: delete`)), ...joining.flatMap((t) => [t.address, ...t.followers].map((a) => `${a}: create`))]);
    const plan = plans.get(root)!;
    const ids = (ts: Retag[]) => ts.map((t) => ({ address: t.address, live_id: t.live_id, followers: t.followers }));
    out.push({
      root,
      backend: "estate",
      location: `estate ${estates.get(root)}`,
      before: { digest: sha(JSON.stringify({ estate: estates.get(root), changes: [...plan.changes].sort(), leaving: ids(leaving), joining: ids(joining) })) },
      after: { digest: sha(JSON.stringify({ estate: estates.get(root), changes: [] })) },
      proof: { changes: plan.changes.filter((c) => !accounted.has(c)), summary: plan.summary },
    });
    log(`${root}: ${proofLine(plan.changes, accounted, "the retag")}`);
  }
  const record = estateRecord(m, "retag", out, { retags });
  return { record, places, files: new Map(), estate: { kind: "retag", retags } };
}

async function planAdopt(repo: string, m: Migration, roots: string[], estates: Map<string, string>, plans: Map<string, { changes: string[]; summary: string }>, places: Map<string, Place>, exec: BinaryExec, options: MigrateOptions): Promise<PlannedMigration> {
  const log = options.log ?? (() => {});
  const out: MigrationRoot[] = [];
  const stamps: Stamp[] = [];
  const adopts: Extract<EstatePlan, { kind: "adopt" }>["adopts"] = [];
  const files: PlannedMigration["files"] = new Map();
  for (const [i, b] of m.backends.entries()) {
    const place = places.get(b.root)!;
    const estate = estates.get(b.root)!;
    const source = stateObject(place.dir, place.env, { type: b.from.backend, config: b.from.config });
    const why = backendRefusal(b.root, source);
    if (why) throw new ConfigError(`migration ${m.name} cannot run: the backend it adopts from: ${why}`);
    const read = await readSource(source, place.dir, options);
    if (!read) throw new ConfigError(`migration ${m.name}: ${locationOf(source)} holds no state of ${b.root} to adopt`);
    const path = join(options.work, `adopt-${i}.tfstate`);
    writeFileSync(path, read.text);
    const report = await liveImport(exec, options.binary, place, path, estate, false);
    const entries = parseRatification(report);
    if (entries.length === 0 && read.state.resources.some((r) => r.mode === "managed")) throw new ConfigError(`migration ${m.name}: live-import printed no ratification for ${b.root}: ${firstLine(report)}`);
    const plan = plans.get(b.root)!;
    const accounted = new Set(entries.filter((e) => ADOPTED.includes(e.status)).map((e) => `${e.address}: create`));
    const unverified = entries.filter((e) => !ADOPTED.includes(e.status)).map((e) => `${e.address}: ${e.status.toLowerCase().replace("_", " ")}`);
    for (const e of entries) stamps.push({ root: b.root, estate, ...e });
    const digest = stateDigest(read.state);
    out.push({
      root: b.root,
      backend: "estate",
      location: `estate ${estate}`,
      before: { digest: sha(JSON.stringify({ estate, changes: [...plan.changes].sort(), entries })) },
      after: { digest: sha(JSON.stringify({ estate, changes: [] })) },
      source: { backend: source.backend, ...(locationOf(source) ? { location: locationOf(source) } : {}), ...(read.version ? { version_id: read.version } : {}), digest },
      proof: { changes: [...unverified, ...plan.changes.filter((c) => !accounted.has(c))], summary: plan.summary },
    });
    adopts.push({ root: b.root, estate, state: path, source, ...(read.version ? { version: read.version } : {}), digest });
    files.set(b.root, { path, object: { backend: "estate", unsupported: "an estate keeps no state file" }, state: read.state, beforeCount: 0, source: { object: source, block: "", data: "" } });
    log(`${b.root}: ${entries.filter((e) => ADOPTED.includes(e.status)).length} of ${entries.length} resource instances in ${locationOf(source)} verify against the live system; ${proofLine(plan.changes, accounted, "the stamp")}`);
  }
  const record = estateRecord(m, "adopt", out, { stamps, backends: m.backends.map((b) => ({ root: b.root, from: locationOf(adopts.find((a) => a.root === b.root)!.source) ?? b.from.backend })) });
  return { record, places, files, estate: { kind: "adopt", adopts } };
}

/** Where an adoption's state is now: its text, parsed, and its version id when the bucket keeps versions. */
async function readSource(o: StateObject, dir: string, options: MigrateOptions): Promise<{ text: string; state: StateFile; version?: string } | undefined> {
  let text: string | undefined;
  let version: string | undefined;
  if (o.backend === "s3" && "target" in o) {
    const s3 = o as Extract<StateObject, { target: S3Target }>;
    version = await versionOf(o, options.fetch);
    text = version ? await stateClient(s3, options.fetch).readVersion(s3.key, version) : await stateClient(s3, options.fetch).get(s3.key);
  } else if (o.backend === "local" && "path" in o) {
    try {
      text = readFileSync(resolve(dir, (o as { path: string }).path), "utf-8");
    } catch {
      text = undefined;
    }
  }
  if (!text?.trim()) return undefined;
  let state: StateFile;
  try {
    state = JSON.parse(text) as StateFile;
  } catch {
    throw new ConfigError(`${locationOf(o)} is not a state`);
  }
  if (!Array.isArray(state.resources)) state.resources = [];
  return { text, state, ...(version ? { version } : {}) };
}

const proofLine = (changes: string[], accounted: Set<string>, what: string): string => {
  const left = changes.filter((c) => !accounted.has(c));
  if (changes.length === 0) return "no changes";
  if (left.length === 0) return `${changes.length} planned change${changes.length === 1 ? "" : "s"}, each one ${what} removes`;
  return `${left.length} change${left.length === 1 ? "" : "s"} ${what} does not remove: ${left.join(", ")}`;
};

function estateRecord(m: Migration, change: "retag" | "adopt", roots: MigrationRoot[], extra: Partial<MigrationRecord>): MigrationRecord {
  return {
    schema: MIGRATION_SCHEMA,
    name: m.name,
    file: m.file,
    file_digest: m.digest,
    change,
    moves: m.moves,
    ...extra,
    roots,
    digest: migrationDigest(m, roots),
    status: roots.some((r) => r.proof.changes.length > 0) ? "proof-failed" : "planned",
  };
}

// ── applying ─────────────────────────────────────────────────────────────

/**
 * Write an approved estate migration: rewrite each resource's markers
 * (retag) or stamp them (adopt), then plan every root and require no
 * change. An adoption holds the old state's lock file while it stamps,
 * and refuses when that state moved since the plan; it leaves the state
 * where it was.
 */
export async function applyEstateMigration(plan: PlannedMigration, options: MigrateOptions & { now: string }): Promise<MigrationRecord> {
  const exec = options.exec ?? runBinary;
  const log = options.log ?? (() => {});
  const record = plan.record;
  const e = plan.estate!;
  const locks = e.kind === "adopt" ? await takeLocks(plan.files, options.now, options.fetch) : [];
  try {
    if (e.kind === "retag") {
      const done: string[] = [];
      for (const t of e.retags) {
        try {
          await writeRetag(exec, options.binary, plan.places.get(t.to)!, t, log);
        } catch (err) {
          return { ...record, status: "failed", error: `${(err as Error).message}${done.length ? `; already retagged: ${done.join(", ")}` : "; nothing was retagged"}` };
        }
        done.push(t.address);
      }
    } else {
      const moved: string[] = [];
      for (const a of e.adopts) {
        const now = await readSource(a.source, plan.places.get(a.root)!.dir, options);
        if (!now || now.version !== a.version || stateDigest(now.state) !== a.digest) moved.push(a.root);
      }
      if (moved.length > 0) return { ...record, status: "refused", moved };
      for (const a of e.adopts) {
        let out: string;
        try {
          out = await liveImport(exec, options.binary, plan.places.get(a.root)!, a.state, a.estate, true);
        } catch (err) {
          return { ...record, status: "failed", error: (err as Error).message };
        }
        const failed = stampFailures(out);
        if (failed === undefined || failed > 0) return { ...record, status: "failed", error: `live-import ${failed === undefined ? "printed no stamp report" : `failed to stamp ${failed} resource${failed === 1 ? "" : "s"}`} in ${a.root}: ${firstLine(out)}` };
        log(`${a.root}: stamped estate ${a.estate} on the resources of ${locationOf(a.source)}, which is left where it was`);
      }
    }
    const roots: MigrationRoot[] = [];
    for (const [i, r] of record.roots.entries()) {
      const at = plan.places.get(r.root)!;
      const verify = await planChanges(exec, options.binary, at.dir, at.env, options.work, `estate-${i}-verify`, true);
      roots.push({ ...r, verify });
      log(`${r.root}: ${verify.changes.length === 0 ? "no changes" : `${verify.changes.length} changes: ${verify.changes.join(", ")}`}`);
    }
    const changed = roots.filter((r) => r.verify!.changes.length > 0).map((r) => r.root);
    return { ...record, roots, status: changed.length > 0 ? "failed" : "applied", ...(changed.length > 0 ? { error: `after the ${record.change === "retag" ? "retag" : "stamp"}, ${changed.join(", ")} plan changes` } : {}) };
  } finally {
    for (const l of locks) await l.release().catch((err: unknown) => log(`${l.root}: the lock could not be released: ${(err as Error).message}`));
  }
}
