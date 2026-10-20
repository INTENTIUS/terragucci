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
 * The proof is read-only.
 *
 *   moves     `live-mv -dry-run -json`, choudoufu's own preview of each
 *             retag, run in the root the resource joins: each one must
 *             find the live resource in the estate it leaves, and a
 *             refusal stops the migration. A root that resources join is
 *             not planned first: until the retag its resources carry the
 *             markers of another estate, and choudoufu refuses to plan a
 *             root while a live object at a resource's identity carries no
 *             marker of its own estate. A root they only leave is planned,
 *             which names the instances that leave (its destroys), and
 *             every change it plans must be one of those destroys. A root
 *             that both gives and takes is not planned, and its leaving
 *             addresses are retagged as the file names them. The digest
 *             covers the planned changes of each planned root and the live
 *             id of each resource.
 *   backends  `live-import` without `-approve`: its ratification of every
 *             resource instance the old state holds. The root is not
 *             planned first. Before the stamp each resource is a live
 *             object that carries no marker of the estate, and choudoufu
 *             refuses to plan a root with one at a resource's identity, so
 *             no plan exists until the markers do. Every instance must
 *             verify (or be outside the taggable subset and follow a
 *             verified parent); each one that does not is a change of the
 *             proof, and the migration does not apply. The digest covers
 *             the ratification's entries and the old state's version and
 *             digest.
 *
 * After the write every root plans and must show no change, which for an
 * adoption is the first plan its root makes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stateClient, stateObject, type StateObject } from "./backend";
import { ConfigError, resolveRepo } from "./config";
import { estateOf } from "./detect";
import { eachLimited } from "./each-limited";
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
  type BinaryIo,
  type MigrateOptions,
  type Migration,
  type MigrationRecord,
  type MigrationRoot,
  type Place,
  type PlannedMigration,
  type StateFile,
  MIGRATION_SCHEMA,
} from "./migrate";
import { MigrationProgress, PROGRESS_FLAG, takesProgressJson } from "./migrate-progress";
import { detectShape } from "./shape";
import { rosterOf, type RosterFacts } from "./report/roster";
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

/**
 * How many roots of an estate migration plan at once, and how many roots take
 * their live-mv dry runs at once. Inits take turns before any of them: the
 * roots share the job's provider cache, which is not safe for inits that run
 * together (./apply.ts waveCache). Plans read the cache and write nothing to
 * it, so they run side by side, as a wave's do. Each root's dry runs still go
 * one at a time in its own directory, and every result keeps its place in the
 * order the roots and addresses were given, so the record, its digest and the
 * log read as they would one at a time.
 */
export const ESTATE_PARALLELISM = 4;

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

/** Run `live-mv -json -from-estate` for one instance in the root it moves to; a dry run writes nothing. With `progress`, the write's `-progress-json` lines go to it. */
async function liveMv(exec: BinaryExec, binary: string, place: Place, fromEstate: string, address: string, dry: boolean, progress?: MigrationProgress): Promise<MoveDoc> {
  const io: BinaryIo | undefined = progress && !dry ? { stderr: progress.take } : undefined;
  const ran = await exec(binary, ["live-mv", "-no-color", "-json", ...(dry ? ["-dry-run"] : []), ...(io ? [PROGRESS_FLAG] : []), `-from-estate=${fromEstate}`, address, address], place.dir, place.env, ...(io ? [io] : []));
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
async function writeRetag(exec: BinaryExec, binary: string, place: Place, t: Retag, log: (line: string) => void, progress?: MigrationProgress): Promise<void> {
  const doc = await liveMv(exec, binary, place, t.from_estate, t.address, false, progress);
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

async function liveImport(exec: BinaryExec, binary: string, place: Place, state: string, estate: string, write: boolean, progress?: MigrationProgress): Promise<string> {
  const io: BinaryIo | undefined = progress && write ? { stderr: progress.take } : undefined;
  const ran = await exec(binary, ["live-import", "-no-color", `-state=${resolve(state)}`, `-estate=${estate}`, ...(write ? [STAMP] : []), ...(io ? [PROGRESS_FLAG] : [])], place.dir, place.env, ...(io ? [io] : []));
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
  // An adopted root is not planned before its stamp: choudoufu refuses a plan while an unmarked live object sits at a resource's identity.
  if (m.kind === "backends") return planAdopt(m, estates, places, exec, options);
  // A root resources join is not planned before the retag either: their live objects carry another estate's markers until then.
  const joining = new Set(m.moves.map((x) => x.to));
  const planned = roots.filter((r) => !joining.has(r));
  const got = new Map<string, { changes: string[]; summary: string }>();
  await eachLimited(planned, ESTATE_PARALLELISM, async (root) => {
    const p = places.get(root)!;
    got.set(root, await planChanges(exec, options.binary, p.dir, p.env, options.work, `estate-${roots.indexOf(root)}`, true));
  });
  const plans = new Map(planned.map((r) => [r, got.get(r)!] as const));
  return planRetag(m, roots, estates, plans, places, exec, options);
}

async function planRetag(m: Migration, roots: string[], estates: Map<string, string>, plans: Map<string, { changes: string[]; summary: string }>, places: Map<string, Place>, exec: BinaryExec, options: MigrateOptions): Promise<PlannedMigration> {
  const log = options.log ?? (() => {});
  // Each slot is a problem, or an instance to dry-run, in the order the file names them.
  type Slot = { problem: string } | { mv: Migration["moves"][number]; inst: string; fromEstate: string; toEstate: string; result?: { doc: MoveDoc } | { problem: string } };
  const slots: Slot[] = [];
  for (const mv of m.moves) {
    const fromEstate = estates.get(mv.from)!;
    const toEstate = estates.get(mv.to)!;
    if (fromEstate === toEstate) {
      slots.push({ problem: `${mv.from} and ${mv.to} are both estate ${fromEstate}; a move inside one estate is a moved block` });
      continue;
    }
    for (const address of mv.addresses) {
      if (/(^|\.)module\.[A-Za-z_][\w-]*$/.test(address)) {
        slots.push({ problem: `${address} is a module call; a retag names each resource in it` });
        continue;
      }
      // A root that is not planned (it takes resources too) names no instances: the address moves as the file names it.
      const source = plans.get(mv.from);
      const instances = source ? instancesOf(address, source.changes, "delete") : [address];
      if (instances.length === 0) {
        slots.push({ problem: `${address}: the plan of ${mv.from} does not destroy it, so estate ${fromEstate} holds no live resource it leaves` });
        continue;
      }
      for (const inst of instances) slots.push({ mv, inst, fromEstate, toEstate });
    }
  }
  // The dry runs: one at a time in each root they join, ESTATE_PARALLELISM roots at once.
  const runs = slots.filter((x): x is Extract<Slot, { inst: string }> => "inst" in x);
  const byRoot = new Map<string, typeof runs>();
  for (const r of runs) byRoot.set(r.mv.to, [...(byRoot.get(r.mv.to) ?? []), r]);
  await eachLimited([...byRoot.entries()], ESTATE_PARALLELISM, async ([to, theirs]) => {
    for (const r of theirs) {
      try {
        r.result = { doc: await liveMv(exec, options.binary, places.get(to)!, r.fromEstate, r.inst, true) };
      } catch (e) {
        r.result = { problem: (e as Error).message };
      }
    }
  });
  const problems: string[] = [];
  const retags: Retag[] = [];
  for (const x of slots) {
    if ("problem" in x) {
      problems.push(x.problem);
      continue;
    }
    const result = x.result!;
    if ("problem" in result) {
      problems.push(result.problem);
      continue;
    }
    const { doc } = result;
    if (!doc.resource?.live_id) {
      problems.push(`live-mv -dry-run names no live resource for ${x.inst}`);
      continue;
    }
    const followers = (doc.followers ?? []).map((f) => f.address).filter((a): a is string => typeof a === "string").sort();
    retags.push({ address: x.inst, from: x.mv.from, to: x.mv.to, from_estate: x.fromEstate, to_estate: x.toEstate, live_id: doc.resource.live_id, followers });
    log(`${x.inst}: ${doc.resource.live_id} moves from estate ${x.fromEstate} to estate ${x.toEstate}${followers.length ? `, with ${followers.join(", ")}` : ""}`);
  }
  if (problems.length > 0) throw new ConfigError(`migration ${m.name}:\n  ${problems.join("\n  ")}`);
  const out: MigrationRoot[] = [];
  for (const root of roots) {
    const leaving = retags.filter((t) => t.from === root);
    const joining = retags.filter((t) => t.to === root);
    const accounted = new Set(leaving.flatMap((t) => [t.address, ...t.followers].map((a) => `${a}: delete`)));
    const plan = plans.get(root);
    const ids = (ts: Retag[]) => ts.map((t) => ({ address: t.address, live_id: t.live_id, followers: t.followers }));
    out.push({
      root,
      backend: "estate",
      location: `estate ${estates.get(root)}`,
      before: { digest: sha(JSON.stringify({ estate: estates.get(root), ...(plan ? { changes: [...plan.changes].sort() } : {}), leaving: ids(leaving), joining: ids(joining) })) },
      after: { digest: sha(JSON.stringify({ estate: estates.get(root), changes: [] })) },
      // A joining root has no plan before the retag: its dry runs are its proof, and each one that refused stopped the migration above.
      proof: plan ? { changes: plan.changes.filter((c) => !accounted.has(c)), summary: plan.summary } : { changes: [], summary: `live-mv -dry-run: ${joining.length === 1 ? "1 resource found in the estate it leaves" : `${joining.length} resources found in the estates they leave`}` },
    });
    log(`${root}: ${plan ? proofLine(plan.changes, accounted, "the retag") : `not planned before the retag; live-mv -dry-run found ${joining.length === 1 ? "the resource that joins" : `each of the ${joining.length} resources that join`} it`}`);
  }
  const record = estateRecord(m, "retag", out, { retags });
  return { record, places, files: new Map(), estate: { kind: "retag", retags } };
}

/**
 * An adoption's proof: `live-import`'s ratification of the old state, with
 * no plan of the root. Each entry that does not verify is a change of the
 * proof; the plan with no change comes after the stamp (writeEstate).
 */
async function planAdopt(m: Migration, estates: Map<string, string>, places: Map<string, Place>, exec: BinaryExec, options: MigrateOptions): Promise<PlannedMigration> {
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
    const unverified = entries.filter((e) => !ADOPTED.includes(e.status)).map((e) => `${e.address}: ${e.status.toLowerCase().replace("_", " ")}`);
    for (const e of entries) stamps.push({ root: b.root, estate, ...e });
    const digest = stateDigest(read.state);
    out.push({
      root: b.root,
      backend: "estate",
      location: `estate ${estate}`,
      before: { digest: sha(JSON.stringify({ estate, entries })) },
      after: { digest: sha(JSON.stringify({ estate, changes: [] })) },
      source: { backend: source.backend, ...(locationOf(source) ? { location: locationOf(source) } : {}), ...(read.version ? { version_id: read.version } : {}), digest },
      proof: { changes: unverified, summary: ratificationSummary(entries) },
    });
    adopts.push({ root: b.root, estate, state: path, source, ...(read.version ? { version: read.version } : {}), digest });
    files.set(b.root, { path, object: { backend: "estate", unsupported: "an estate keeps no state file" }, state: read.state, beforeCount: 0, source: { object: source, block: "", data: "" } });
    const verified = entries.length - unverified.length;
    log(`${b.root}: ${verified} of ${entries.length} resource instances in ${locationOf(source)} verify against the live system${unverified.length ? `; ${unverified.length} do${unverified.length === 1 ? "es" : ""} not: ${unverified.join(", ")}` : ", so the stamp adopts each one"}`);
  }
  const record = estateRecord(m, "adopt", out, { stamps, backends: m.backends.map((b) => ({ root: b.root, from: locationOf(adopts.find((a) => a.root === b.root)!.source) ?? b.from.backend })) });
  return { record, places, files, estate: { kind: "adopt", adopts } };
}

/** What an adoption's proof says in place of a plan's summary: how many instances the ratification verified. */
const ratificationSummary = (entries: { status: string }[]): string => {
  const verified = entries.filter((e) => ADOPTED.includes(e.status)).length;
  return `live-import: ${verified} of ${entries.length} resource instance${entries.length === 1 ? "" : "s"} verified`;
};

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
 * What an estate migration's write names beyond the plans, by root: each
 * root's estate, the live id of each resource it retagged or stamped, and
 * the resource each follower moved with.
 */
function rosterFacts(e: EstatePlan, record: MigrationRecord): { estates: Map<string, string>; byRoot: Map<string, RosterFacts> } {
  const estates = new Map<string, string>();
  const byRoot = new Map<string, RosterFacts>();
  const of = (root: string): RosterFacts => byRoot.get(root) ?? byRoot.set(root, new Map()).get(root)!;
  if (e.kind === "retag") {
    for (const t of e.retags) {
      estates.set(t.from, t.from_estate);
      estates.set(t.to, t.to_estate);
      of(t.to).set(t.address, { live_id: t.live_id });
      for (const f of t.followers) of(t.to).set(f, { follows: t.address });
    }
  } else {
    for (const a of e.adopts) estates.set(a.root, a.estate);
    for (const s of record.stamps ?? []) if (s.live_id) of(s.root).set(s.address, { live_id: s.live_id });
  }
  return { estates, byRoot };
}

/**
 * Write an approved estate migration: rewrite each resource's markers
 * (retag) or stamp them (adopt), then plan every root and require no
 * change. An adoption holds the old state's lock file while it stamps,
 * and refuses when that state moved since the plan; it leaves the state
 * where it was. When the binary takes `-progress-json`, each resource's
 * line goes to the migration's progress (./migrate-progress.ts) as its
 * write lands, and the record ends with the counts.
 */
export async function applyEstateMigration(repo: string, plan: PlannedMigration, options: MigrateOptions & { now: string }): Promise<MigrationRecord> {
  const exec = options.exec ?? runBinary;
  const log = options.log ?? (() => {});
  const progress = await progressOf(repo, plan, exec, options, log);
  let result: MigrationRecord;
  try {
    result = await writeEstate(plan, options, exec, log, progress);
  } finally {
    await progress?.stop();
  }
  return progress ? { ...result, progress: progress.progress } : result;
}

/** The migration's progress, when the binary writes `-progress-json` lines; undefined for one that does not. */
async function progressOf(repo: string, plan: PlannedMigration, exec: BinaryExec, options: MigrateOptions, log: (line: string) => void): Promise<MigrationProgress | undefined> {
  const e = plan.estate!;
  const first = plan.places.get(e.kind === "retag" ? (e.retags[0]?.to ?? "") : (e.adopts[0]?.root ?? ""));
  if (!first || !(await takesProgressJson(exec, options.binary, first.dir, first.env))) return undefined;
  // A follower of two leaders is one resource: each address counts once.
  const total = e.kind === "retag" ? new Set(e.retags.flatMap((t) => [t.address, ...t.followers])).size : (plan.record.stamps?.length ?? 0);
  const p: MigrationProgress = new MigrationProgress({
    repo,
    name: plan.record.name,
    change: e.kind,
    total,
    record: () => ({ ...plan.record, progress: p.progress }),
    ...(options.env ? { env: options.env } : {}),
    ...(options.progress?.publish ? { publish: options.progress.publish } : {}),
    ...(options.progress?.event ? { event: options.progress.event } : {}),
    log,
  });
  log(`migration ${plan.record.name}: each resource's write goes to terragucci-report/migrations/${plan.record.name}/progress.jsonl as it lands`);
  return p;
}

async function writeEstate(plan: PlannedMigration, options: MigrateOptions & { now: string }, exec: BinaryExec, log: (line: string) => void, progress: MigrationProgress | undefined): Promise<MigrationRecord> {
  const record = plan.record;
  const e = plan.estate!;
  const locks = e.kind === "adopt" ? await takeLocks(plan.files, options.now, options.fetch) : [];
  try {
    if (e.kind === "retag") {
      const done: string[] = [];
      for (const t of e.retags) {
        try {
          await writeRetag(exec, options.binary, plan.places.get(t.to)!, t, log, progress);
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
          out = await liveImport(exec, options.binary, plan.places.get(a.root)!, a.state, a.estate, true, progress);
        } catch (err) {
          return { ...record, status: "failed", error: (err as Error).message };
        }
        const failed = stampFailures(out);
        if (failed === undefined || failed > 0) return { ...record, status: "failed", error: `live-import ${failed === undefined ? "printed no stamp report" : `failed to stamp ${failed} resource${failed === 1 ? "" : "s"}`} in ${a.root}: ${firstLine(out)}` };
        log(`${a.root}: stamped estate ${a.estate} on the resources of ${locationOf(a.source)}, which is left where it was`);
      }
    }
    const facts = rosterFacts(e, record);
    // Every root plans after the write, ESTATE_PARALLELISM at once; the results, rosters and log lines keep the record's order.
    const verified: { verify: { changes: string[]; summary: string }; json?: unknown }[] = [];
    await eachLimited(record.roots, ESTATE_PARALLELISM, async (r, i) => {
      const at = plan.places.get(r.root)!;
      let json: unknown;
      const verify = await planChanges(exec, options.binary, at.dir, at.env, options.work, `estate-${i}-verify`, true, (j) => (json = j));
      verified[i] = { verify, json };
    });
    const roots: MigrationRoot[] = [];
    for (const [i, r] of record.roots.entries()) {
      const { verify, json } = verified[i]!;
      // The plan after the write is the estate as it stands: its roster, with the live ids the write named.
      if (options.roster && json !== undefined) options.roster(r.root, rosterOf(r.root, facts.estates.get(r.root), json, options.now, facts.byRoot.get(r.root)));
      roots.push({ ...r, verify });
      log(`${r.root}: ${verify.changes.length === 0 ? "no changes" : `${verify.changes.length} changes: ${verify.changes.join(", ")}`}`);
    }
    const changed = roots.filter((r) => r.verify!.changes.length > 0).map((r) => r.root);
    return { ...record, roots, status: changed.length > 0 ? "failed" : "applied", ...(changed.length > 0 ? { error: `after the ${record.change === "retag" ? "retag" : "stamp"}, ${changed.join(", ")} plan changes` } : {}) };
  } finally {
    for (const l of locks) await l.release().catch((err: unknown) => log(`${l.root}: the lock could not be released: ${(err as Error).message}`));
  }
}
