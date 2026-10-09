/**
 * State migrations between roots: what `moved`, `import` and `removed`
 * blocks cannot do, because each of them works inside one root's state.
 *
 * A migration is a file in `migrations/` (`<name>.yml`), committed with the
 * code change that moves the resource blocks from one root to another:
 *
 *   moves:
 *     - from: envs/dev/platform
 *       to: envs/dev/queues
 *       addresses: [aws_sqs_queue.jobs, module.search]
 *
 * Each address is a resource (`[module.<m>.]<type>.<name>`) or a module call
 * (`module.<m>`), and moves, with every instance, to the same address in the
 * other root.
 *
 * Planning a migration (planMigration) reads each affected root's state with
 * `state pull` and its backend version id from the object's metadata
 * (./backend.ts), keeps only their digests and version ids, builds each
 * root's new state in the job's temporary directory, and plans every
 * affected root against its new state, through a local-backend override
 * file and a data dir of its own. Every root must plan with no resource
 * change. The migration's digest covers the file, each root's version id
 * and digest before, and the digest of each new state.
 *
 * Applying it (runMigrations, from wave 1 of `stage tf-apply`, before the
 * wave plans) puts that digest behind a gate of its own, `tf-migrate
 * <name>`, on chant/lifecycle: the wave waits until `chant approve
 * tf-migrate <name> --plan <digest>` names it, and refuses when an approval
 * names another digest, naming the roots whose state moved. Approved, the
 * job takes each S3 state's lock file (the lock `use_lockfile` takes),
 * checks under the lock that no state moved since the plan, writes the new
 * states with `state push`, plans every root again against its real backend
 * and requires no change, and records the version ids before and after on
 * chant/lifecycle (`_gates/tf-migrate/done.jsonl`) and in the report. A
 * migration that applied is never run again.
 *
 * State contents never leave the job: the record holds version ids and
 * digests. The first version moves states between `s3` backends that take a
 * lock file and `local` backends, and refuses Terragrunt units and roots with
 * a `cloud` block.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { computePlanDigest, samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { parseYAML } from "@intentius/chant/yaml";
import { appendLifecycle, appendPending, decideGate, movedMembers, readLedger, type AppliedRecord, type GateLedger, type PendingRecord } from "./apply";
import { approvalRule } from "./approval";
import { binaryEnv } from "./binary-env";
import { stateClient, stateObject, type StateObject } from "./backend";
import { ConfigError, findConfig, type Approval } from "./config";
import type { S3Fetch, S3Target } from "./report/s3";
import { sealRefusal } from "./seal";

export const MIGRATE_OP = "tf-migrate";
export const MIGRATE_LEDGER = `_gates/${MIGRATE_OP}.jsonl`;
/** Beside the ledger, out of chant's sight: one line per migration that ran its writes. */
export const MIGRATE_DONE = `_gates/${MIGRATE_OP}/done.jsonl`;
/** Where approvals a migration applied under are recorded. */
export const MIGRATE_APPLIED = `_gates/${MIGRATE_OP}/applied.jsonl`;
export const MIGRATIONS_DIR = "migrations";
export const MIGRATION_SCHEMA = "terragucci.migration/v1";
/** The override file a proof plan writes into a root, and removes. Terraform and OpenTofu merge any `*_override.tf` over the root's files. */
export const OVERRIDE_FILE = "terragucci_migrate_override.tf";

/** The plan record a waiting migration keeps beside the ledger, so a refusal can say what moved. */
export const keptPath = (name: string, digest: string): string => `_gates/${MIGRATE_OP}/${name}/${digest.replace(":", "_")}.json`;
/** The command that approves a migration's digest. */
export const migrateApproveCommand = (name: string, digest: string, sealed = false): string => `chant approve ${MIGRATE_OP} ${name} --plan ${digest}${sealed ? " --sign" : ""}`;

/** Exit codes, as `stage tf-apply` gives them. */
const EXIT = { applied: 0, failed: 1, waiting: 3, refused: 4 } as const;

// ── the file ─────────────────────────────────────────────────────────────

export interface Move {
  from: string;
  to: string;
  addresses: string[];
}

/** A root's state moving to the backend its code now names, from the backend it was in. */
export interface BackendMove {
  root: string;
  /** The backend the state is in now: its type and its configuration, as a backend block gives them. */
  from: { backend: string; config: Record<string, unknown> };
}

/** A root's state put back to a version a migration recorded (a revert, which `terragucci migrate revert` writes). */
export interface Restore {
  root: string;
  /** Where the state is, as the migration recorded it. */
  location: string;
  /** The version to put back; null when the root had no state before the migration, so it gets an empty one. */
  version_id: string | null;
  /** The version the migration left: a state that moved past it is refused. */
  from_version_id: string | null;
}

export interface Migration {
  /** The file's name without `.yml`: the gate's name. */
  name: string;
  /** Its path in the repo. */
  file: string;
  /** sha256 of its text. */
  digest: string;
  /** Which kind of migration the file holds: one kind per file. */
  kind: "moves" | "backends" | "revert";
  moves: Move[];
  backends: BackendMove[];
  restores: Restore[];
  /** The migration a revert puts back. */
  revert?: string;
}

const sha = (text: string | Buffer): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** A migration's name: what its gate is called. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** A resource address with no instance key, in modules with none, or a module call. */
const ADDRESS = /^(?:module\.[A-Za-z_][\w-]*\.)*(?:[A-Za-z_][\w-]*\.[A-Za-z_][\w-]*|module\.[A-Za-z_][\w-]*)$/;

/** Read a migration file's text. Throws ConfigError naming every problem. */
export function parseMigration(file: string, text: string): Migration {
  const name = file.replace(/^.*\//, "").replace(/\.ya?ml$/, "");
  const problems: string[] = [];
  if (!NAME.test(name)) problems.push(`the file name ${name} is not a gate name: lower-case letters, digits, dots, dashes and underscores`);
  let raw: unknown;
  try {
    raw = parseYAML(text);
  } catch (e) {
    throw new ConfigError(`${file}: ${(e as Error).message}`);
  }
  const doc = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  for (const k of Object.keys(doc)) if (!["moves", "backends", "revert", "restores"].includes(k)) problems.push(`${k} is not a key of a migration; it has moves, backends, or revert and restores`);
  const kinds = [doc.moves !== undefined && "moves", doc.backends !== undefined && "backends", (doc.revert !== undefined || doc.restores !== undefined) && "revert"].filter(Boolean) as Migration["kind"][];
  if (kinds.length > 1) problems.push(`a migration holds one kind of change, and this one has ${kinds.join(" and ")}; write a file for each`);
  const kind: Migration["kind"] = kinds[0] ?? "moves";
  const rootOf = (at: string, k: string, v: unknown): string | undefined => {
    if (typeof v !== "string" || !v.trim()) {
      problems.push(`${at}.${k} must name a root directory`);
      return undefined;
    }
    const r = v.trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (r.startsWith("/") || r.split("/").includes("..")) problems.push(`${at}.${k} must be a directory in the repo, not ${v}`);
    return r;
  };
  if (kind === "backends") return { name, file, digest: sha(text), kind, moves: [], backends: parseBackends(doc.backends, problems, rootOf, file), restores: [] };
  if (kind === "revert") {
    const restores = parseRestores(doc, problems, rootOf);
    if (problems.length > 0) throw new ConfigError(`${file}:\n  ${problems.join("\n  ")}`);
    return { name, file, digest: sha(text), kind, moves: [], backends: [], restores, revert: String(doc.revert) };
  }
  const moves: Move[] = [];
  if (!Array.isArray(doc.moves) || doc.moves.length === 0) problems.push("moves is missing or empty");
  for (const [i, m] of (Array.isArray(doc.moves) ? doc.moves : []).entries()) {
    const at = `moves[${i}]`;
    const o = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
    for (const k of Object.keys(o)) if (!["from", "to", "addresses"].includes(k)) problems.push(`${at}.${k} is not a key of a move; it has from, to and addresses`);
    const root = (v: unknown, k: string): string | undefined => {
      if (typeof v !== "string" || !v.trim()) {
        problems.push(`${at}.${k} must name a root directory`);
        return undefined;
      }
      const r = v.trim().replace(/^\.\//, "").replace(/\/+$/, "");
      if (r.startsWith("/") || r.split("/").includes("..")) problems.push(`${at}.${k} must be a directory in the repo, not ${v}`);
      return r;
    };
    const from = root(o.from, "from");
    const to = root(o.to, "to");
    if (from && to && from === to) problems.push(`${at}: from and to are both ${from}; a move inside one root is a moved block`);
    const addresses = Array.isArray(o.addresses) ? o.addresses : [];
    if (addresses.length === 0) problems.push(`${at}.addresses must list the resources or modules to move`);
    for (const a of addresses) {
      if (typeof a === "string" && (a.startsWith("data.") || a.includes(".data."))) problems.push(`${at}.addresses: ${a} is a data source, which has no state to move`);
      else if (typeof a !== "string" || !ADDRESS.test(a)) problems.push(`${at}.addresses: ${JSON.stringify(a)} is not a resource or module address without an instance key`);
    }
    if (from && to) moves.push({ from, to, addresses: addresses.filter((a): a is string => typeof a === "string") });
  }
  if (problems.length > 0) throw new ConfigError(`${file}:\n  ${problems.join("\n  ")}`);
  return { name, file, digest: sha(text), kind, moves, backends: [], restores: [] };
}

/** The backends that take a migration's writes: S3 with a lock file, and a local file. */
const BACKENDS = ["s3", "local"];

function parseBackends(raw: unknown, problems: string[], rootOf: (at: string, k: string, v: unknown) => string | undefined, file: string): BackendMove[] {
  const out: BackendMove[] = [];
  if (!Array.isArray(raw) || raw.length === 0) problems.push("backends is missing or empty");
  const seen = new Set<string>();
  for (const [i, b] of (Array.isArray(raw) ? raw : []).entries()) {
    const at = `backends[${i}]`;
    const o = b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    for (const k of Object.keys(o)) if (!["root", "from"].includes(k)) problems.push(`${at}.${k} is not a key of a backend move; it has root and from`);
    const root = rootOf(at, "root", o.root);
    if (root && seen.has(root)) problems.push(`${at}: ${root} moves twice`);
    if (root) seen.add(root);
    const from = o.from && typeof o.from === "object" ? (o.from as Record<string, unknown>) : undefined;
    if (!from) {
      problems.push(`${at}.from must give the backend the state is in now: backend and config`);
      continue;
    }
    for (const k of Object.keys(from)) if (!["backend", "config"].includes(k)) problems.push(`${at}.from.${k} is not a key; from has backend and config`);
    if (typeof from.backend !== "string" || !BACKENDS.includes(from.backend)) problems.push(`${at}.from.backend must be ${BACKENDS.join(" or ")}`);
    const config = from.config && typeof from.config === "object" && !Array.isArray(from.config) ? (from.config as Record<string, unknown>) : {};
    if (from.backend === "s3" && (typeof config.bucket !== "string" || typeof config.key !== "string")) problems.push(`${at}.from.config must name the bucket and key of the state`);
    if (root && typeof from.backend === "string") out.push({ root, from: { backend: from.backend, config } });
  }
  if (problems.length > 0) throw new ConfigError(`${file}:\n  ${problems.join("\n  ")}`);
  return out;
}

function parseRestores(doc: Record<string, unknown>, problems: string[], rootOf: (at: string, k: string, v: unknown) => string | undefined): Restore[] {
  if (typeof doc.revert !== "string" || !NAME.test(doc.revert)) problems.push("revert must name the migration it puts back");
  const out: Restore[] = [];
  if (!Array.isArray(doc.restores) || doc.restores.length === 0) problems.push("restores is missing or empty");
  for (const [i, r] of (Array.isArray(doc.restores) ? doc.restores : []).entries()) {
    const at = `restores[${i}]`;
    const o = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    for (const k of Object.keys(o)) if (!["root", "location", "version_id", "from_version_id"].includes(k)) problems.push(`${at}.${k} is not a key of a restore`);
    const root = rootOf(at, "root", o.root);
    const id = (k: string): string | null => {
      const v = o[k];
      if (v === null || v === undefined) return null;
      if (typeof v !== "string" || !v) problems.push(`${at}.${k} must be a version id or null`);
      return typeof v === "string" ? v : null;
    };
    if (typeof o.location !== "string" || !o.location) problems.push(`${at}.location must say where the state is`);
    const version_id = id("version_id");
    const from_version_id = id("from_version_id");
    if (from_version_id === null) problems.push(`${at}.from_version_id is missing: the version the migration left, which the revert checks the state is still at`);
    if (root && typeof o.location === "string") out.push({ root, location: o.location, version_id, from_version_id });
  }
  return out;
}

/** The repo's migration files, by name. */
export function listMigrations(repo: string, dir = MIGRATIONS_DIR): Migration[] {
  const at = join(repo, dir);
  if (!existsSync(at)) return [];
  return readdirSync(at)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => parseMigration(`${dir}/${f}`, readFileSync(join(at, f), "utf-8")));
}

// ── the states ───────────────────────────────────────────────────────────

/** A state file as `state pull` prints it (format version 4); only what a move touches is named. */
export interface StateFile {
  version: number;
  terraform_version?: string;
  serial: number;
  lineage: string;
  outputs?: Record<string, unknown>;
  resources: StateResource[];
  check_results?: unknown;
  [k: string]: unknown;
}

export interface StateResource {
  module?: string;
  mode: string;
  type: string;
  name: string;
  provider?: string;
  instances?: unknown[];
  [k: string]: unknown;
}

/** A resource entry's address without instance keys: `module.a.module.b.type.name`, module keys dropped. */
const resourceAddress = (r: StateResource): string => `${r.module ? `${r.module.replace(/\[[^\]]*\]/g, "")}.` : ""}${r.mode === "data" ? "data." : ""}${r.type}.${r.name}`;
const moduleOf = (r: StateResource): string => (r.module ?? "").replace(/\[[^\]]*\]/g, "");

/** Whether a migration address names a state entry: the managed resource itself, or a module call it sits in, with its data sources. */
export function addressMatches(address: string, r: StateResource): boolean {
  if (/(^|\.)module\.[A-Za-z_][\w-]*$/.test(address)) return moduleOf(r) === address || moduleOf(r).startsWith(`${address}.`);
  return r.mode === "managed" && resourceAddress(r) === address;
}

/** A lineage that a migration and a root always give the same: a state planned twice has one digest. */
export function derivedLineage(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\n")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The states after the moves. `before` holds each affected root's state, or
 * null when it has none. A changed state keeps its lineage and gets the next
 * serial; a root with no state gets a new one, its lineage derived from the
 * migration and the root. Throws when an address is in no state or is
 * already in the root it moves to.
 */
export function moveResources(name: string, moves: Move[], before: Map<string, StateFile | null>): Map<string, StateFile> {
  const after = new Map<string, StateFile>();
  const take = (root: string, from?: StateFile | null): StateFile => {
    const held = after.get(root);
    if (held) return held;
    const was = before.get(root) ?? null;
    const s: StateFile = was
      ? { ...structuredClone(was), serial: was.serial + 1 }
      : { version: 4, terraform_version: from?.terraform_version ?? "1.0.0", serial: 1, lineage: derivedLineage(name, root), outputs: {}, resources: [], check_results: null };
    after.set(root, s);
    return s;
  };
  const problems: string[] = [];
  for (const m of moves) {
    const src = before.get(m.from) ?? null;
    if (!src) {
      problems.push(`${m.from} has no state to move ${m.addresses.join(", ")} from`);
      continue;
    }
    const from = take(m.from);
    const to = take(m.to, src);
    for (const address of m.addresses) {
      const found = from.resources.filter((r) => addressMatches(address, r));
      if (found.length === 0) {
        problems.push(`${address} is not in the state of ${m.from}`);
        continue;
      }
      const taken = to.resources.filter((r) => addressMatches(address, r));
      if (taken.length > 0) {
        problems.push(`${address} is already in the state of ${m.to}`);
        continue;
      }
      from.resources = from.resources.filter((r) => !found.includes(r));
      to.resources.push(...found);
    }
  }
  if (problems.length > 0) throw new ConfigError(`migration ${name}:\n  ${problems.join("\n  ")}`);
  return after;
}

/** A state's digest: sha256 of its JSON as parsed and written back, so whitespace never moves it. */
export const stateDigest = (s: StateFile): string => sha(JSON.stringify(s));

// ── the plan record ──────────────────────────────────────────────────────

/** One affected root in a migration's plan: never its state's contents. */
export interface MigrationRoot {
  root: string;
  backend: string;
  location?: string;
  /** Before the migration: the backend's version id, when it keeps versions, and the state's digest, null when the root had none. */
  before: { version_id?: string; digest: string | null };
  /** The new state's digest, and its version id once written. */
  after: { digest: string; version_id?: string };
  /** The proof plan against the new state: resource changes, and the line the binary printed. */
  proof: { changes: string[]; summary: string };
  /** After the write, the plan against the real backend. */
  verify?: { changes: string[]; summary: string };
  /** A backend move: where the state was read from, its version id and its digest. That state is left where it was. */
  source?: { backend: string; location?: string; version_id?: string; digest: string };
  /** A revert: the version put back, null for a root the reverted migration found with no state. */
  restore?: { version_id: string | null };
}

export interface MigrationRecord {
  schema: typeof MIGRATION_SCHEMA;
  name: string;
  file: string;
  file_digest: string;
  /** moves, backends or revert. */
  change: Migration["kind"];
  moves: Move[];
  /** A backend move's roots, and where each state was. */
  backends?: { root: string; from: string }[];
  /** The migration a revert puts back. */
  revert?: string;
  roots: MigrationRoot[];
  /** What an approval binds: the file, each root's version and digest before, and each new state's digest. */
  digest: string;
  /** planned: proved, not applied; waiting, refused, applied or failed once a wave ran it. */
  status: "planned" | "proof-failed" | "waiting" | "refused" | "applied" | "failed";
  approved_by?: string;
  /** Roots whose state moved since the plan or the approval. */
  moved?: string[];
  error?: string;
  finished?: string;
  commit?: string;
}

/** The digest an approval binds. Proof summaries are left out: a binary's wording is not the migration. */
export function migrationDigest(m: Migration, roots: MigrationRoot[]): string {
  return computePlanDigest("terragucci-migration", {
    name: m.name,
    file: m.digest,
    roots: roots
      .map((r) => ({
        root: r.root,
        location: r.location ?? null,
        before: { version_id: r.before.version_id ?? null, digest: r.before.digest },
        after: r.after.digest,
        ...(r.source ? { source: { location: r.source.location ?? null, version_id: r.source.version_id ?? null, digest: r.source.digest } } : {}),
        ...(r.restore ? { restore: r.restore.version_id } : {}),
      }))
      .sort((a, b) => (a.root < b.root ? -1 : 1)),
  });
}

/** What the gate's members hold: each root and its state before, so a refusal names the roots that moved. */
export const beforeMembers = (roots: MigrationRoot[]): { member: string; planDigest: string }[] =>
  roots.map((r) => ({ member: r.root, planDigest: `${r.before.version_id ?? "-"} ${r.before.digest ?? "none"}${r.source ? ` from ${r.source.version_id ?? "-"} ${r.source.digest}` : ""}` })).sort((a, b) => (a.member < b.member ? -1 : 1));

// ── running the binary ───────────────────────────────────────────────────

export interface Ran {
  code: number;
  stdout: string;
  out: string;
}

/** How the binary runs: in `dir`, with `env`. Injectable for tests. */
export type BinaryExec = (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv) => Promise<Ran>;

export const runBinary: BinaryExec = (binary, args, dir, env) =>
  new Promise((done) => {
    const child = spawn(binary, [`-chdir=${dir}`, ...args], { env: binaryEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let out = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      out += d;
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => done({ code: 127, stdout, out: `${out}${e.message}` }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, out }));
  });

/** The resource changes of a plan's JSON, as `<address>: <actions>`; no-ops and reads are not changes. */
export function resourceChanges(plan: unknown): string[] {
  const rc = (plan as { resource_changes?: { address?: string; change?: { actions?: string[] } }[] } | undefined)?.resource_changes ?? [];
  return rc
    .filter((c) => {
      const a = c.change?.actions ?? [];
      return !(a.length === 1 && (a[0] === "no-op" || a[0] === "read"));
    })
    .map((c) => `${c.address}: ${(c.change?.actions ?? []).join("+")}`);
}

const firstLine = (s: string, n = 4): string => s.trim().split("\n").slice(-n).join(" ").slice(0, 400);

/** Plan a root and read its resource changes; with `-lock=false` when the job holds the lock itself. */
async function planChanges(exec: BinaryExec, binary: string, dir: string, env: NodeJS.ProcessEnv, work: string, tag: string, lock: boolean): Promise<{ changes: string[]; summary: string }> {
  const planFile = join(work, `${tag}.tfplan`);
  const plan = await exec(binary, ["plan", "-input=false", "-no-color", ...(lock ? [] : ["-lock=false"]), `-out=${planFile}`], dir, env);
  if (plan.code !== 0) throw new ConfigError(`the plan of ${tag} failed: ${firstLine(plan.out)}`);
  const show = await exec(binary, ["show", "-json", planFile], dir, env);
  let json: unknown;
  try {
    json = JSON.parse(show.stdout);
  } catch {
    throw new ConfigError(`show -json of ${tag} printed no plan: ${firstLine(show.out)}`);
  }
  return { changes: resourceChanges(json), summary: plan.out.match(/Plan: .*|No changes\..*/)?.[0] ?? "planned" };
}

// ── planning ─────────────────────────────────────────────────────────────

export interface MigrateOptions {
  binary: string;
  env?: NodeJS.ProcessEnv;
  exec?: BinaryExec;
  fetch?: S3Fetch;
  /** Where new states and proof plans are kept; removed by the caller. */
  work: string;
  log?: (line: string) => void;
}

/** Why a root cannot take part in a migration, or undefined. */
export function refusal(repo: string, root: string): string | undefined {
  const dir = join(repo, root);
  if (!existsSync(dir)) return `${root} is not a directory in the repo`;
  if (existsSync(join(dir, "terragrunt.hcl"))) return `${root} is a Terragrunt unit, and migrations move the state of Terraform and OpenTofu roots only`;
  const tf = readdirSync(dir).filter((f) => f.endsWith(".tf") && f !== OVERRIDE_FILE);
  if (tf.length === 0) return `${root} holds no .tf files`;
  for (const f of tf) {
    const text = readFileSync(join(dir, f), "utf-8");
    if (/^\s*cloud\s*\{/m.test(text)) return `${root} uses a cloud block, whose state HCP Terraform keeps; migrations move state in s3 and local backends`;
  }
  return undefined;
}

/** Which backends a migration writes to, or why not. */
function backendRefusal(root: string, o: StateObject): string | undefined {
  if ("unsupported" in o) return `${root}: ${o.unsupported.replace("reads state versions from", "migrates state in")}`;
  if (o.backend === "s3" && !(o as { lockfile: boolean }).lockfile) return `${root}: its s3 backend takes no lock file (use_lockfile = true), so a migration could not hold its lock`;
  return undefined;
}

/** A root's state as `state pull` gives it, or null when it has none. */
async function pullState(exec: BinaryExec, binary: string, root: string, dir: string, env: NodeJS.ProcessEnv): Promise<StateFile | null> {
  const pulled = await exec(binary, ["state", "pull"], dir, env);
  if (pulled.code !== 0) throw new ConfigError(`state pull in ${root} failed: ${firstLine(pulled.out)}`);
  if (!pulled.stdout.trim()) return null;
  try {
    const s = JSON.parse(pulled.stdout) as StateFile;
    if (!Array.isArray(s.resources)) s.resources = [];
    // A backend with no state object yet prints an empty state with no lineage: that is no state.
    if (!s.lineage && !s.serial && s.resources.length === 0) return null;
    return s;
  } catch {
    throw new ConfigError(`state pull in ${root} printed something that is not a state`);
  }
}

/** The version id the backend holds for a state object now, when it keeps versions. */
async function versionOf(o: StateObject, fetchFn?: S3Fetch): Promise<string | undefined> {
  if (o.backend !== "s3" || !("target" in o)) return undefined;
  const head = await stateClient(o as Extract<StateObject, { target: S3Target }>, fetchFn).head((o as { key: string }).key);
  return head.versionId;
}

/** Initialise a root against the backend its code names. `-reconfigure`: a data dir another backend left is not migrated from. */
async function initRoot(exec: BinaryExec, binary: string, root: string, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const init = await exec(binary, ["init", "-input=false", "-no-color", "-reconfigure"], dir, env);
  if (init.code !== 0) throw new ConfigError(`init in ${root} failed: ${firstLine(init.out)}`);
}

/** An HCL value from the JSON of a backend's configuration. */
function hcl(v: unknown): string {
  if (v && typeof v === "object" && !Array.isArray(v)) return `{ ${Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => `${k} = ${hcl(x)}`).join(", ")} }`;
  if (Array.isArray(v)) return `[${v.map(hcl).join(", ")}]`;
  return JSON.stringify(v);
}

/** A terraform block whose backend is `type` with `config`, for an override file. */
export function backendBlock(type: string, config: Record<string, unknown>): string {
  const body = Object.entries(config).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `    ${k} = ${hcl(v)}\n`).join("");
  return `terraform {\n  backend ${JSON.stringify(type)} {\n${body}  }\n}\n`;
}

/**
 * Run `fn` with the root's backend switched to `block` by the override file,
 * in the data dir `data`, initialised there first; the override file is
 * removed whatever happens, so the root's own files and `.terraform` are left
 * as they were.
 */
async function withBackend<T>(exec: BinaryExec, binary: string, root: string, dir: string, block: string, data: string, env: NodeJS.ProcessEnv, what: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const override = join(dir, OVERRIDE_FILE);
  const benv = { ...env, TF_DATA_DIR: data };
  writeFileSync(override, block);
  try {
    const init = await exec(binary, ["init", "-input=false", "-no-color", "-reconfigure"], dir, benv);
    if (init.code !== 0) throw new ConfigError(`init of ${root} against ${what} failed: ${firstLine(init.out)}`);
    return await fn(benv);
  } finally {
    rmSync(override, { force: true });
  }
}

/** Where a backend move's state is now: its object, read through the root with the old backend. */
interface Source {
  object: StateObject;
  block: string;
  data: string;
}

/** What planning leaves for the apply: the record, and where each root's new state is. */
export interface PlannedMigration {
  record: MigrationRecord;
  /** By root: the new state's file in the job's work dir, the backend it writes to, and, for a backend move, where the state is now. */
  files: Map<string, { path: string; object: StateObject; state: StateFile; beforeCount: number; source?: Source }>;
}

/** The empty state a root with none gets, or that a revert puts back where a migration found none. */
const emptyState = (lineage: string, serial: number, terraformVersion = "1.0.0"): StateFile => ({ version: 4, terraform_version: terraformVersion, serial, lineage, outputs: {}, resources: [], check_results: null });

/**
 * Plan a migration: read every affected state and its version, build the
 * new states in `work`, and plan each root against its new state. The record
 * says `proof-failed` when a root would change; a root that cannot be read
 * or a change that does not fit throws ConfigError.
 *
 *   moves     each root's state gains or loses the resources moved
 *   backends  the root's state, read from the backend named in the file, is
 *             the new state of the backend its code names, which holds none
 *   revert    each root's state is the version the reverted migration found,
 *             read from the bucket by its version id, or an empty one
 */
export async function planMigration(repo: string, m: Migration, options: MigrateOptions): Promise<PlannedMigration> {
  const exec = options.exec ?? runBinary;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const roots = [...new Set(m.kind === "backends" ? m.backends.map((b) => b.root) : m.kind === "revert" ? m.restores.map((r) => r.root) : m.moves.flatMap((x) => [x.from, x.to]))].sort();
  const problems = roots.map((r) => refusal(repo, r)).filter((x): x is string => x !== undefined);
  if (problems.length > 0) throw new ConfigError(`migration ${m.name} cannot run:\n  ${problems.join("\n  ")}`);
  mkdirSync(options.work, { recursive: true });
  const before = new Map<string, StateFile | null>();
  const objects = new Map<string, StateObject>();
  const versions = new Map<string, string | undefined>();
  for (const root of roots) {
    const dir = join(repo, root);
    await initRoot(exec, options.binary, root, dir, env);
    const o = stateObject(dir, env);
    const why = backendRefusal(root, o);
    if (why) throw new ConfigError(`migration ${m.name} cannot run: ${why}`);
    objects.set(root, o);
    versions.set(root, await versionOf(o, options.fetch));
    before.set(root, await pullState(exec, options.binary, root, dir, env));
  }
  const after = new Map<string, StateFile>();
  const sources = new Map<string, Source & { version?: string; state: StateFile }>();
  const restored = new Map<string, string | null>();
  if (m.kind === "moves") {
    for (const [root, s] of moveResources(m.name, m.moves, before)) after.set(root, s);
  } else if (m.kind === "backends") {
    for (const [i, b] of m.backends.entries()) {
      const dir = join(repo, b.root);
      const object = stateObject(dir, env, { type: b.from.backend, config: b.from.config });
      const why = backendRefusal(b.root, object);
      if (why) throw new ConfigError(`migration ${m.name} cannot run: the backend it moves from: ${why}`);
      if (locationOf(object) === locationOf(objects.get(b.root)!)) throw new ConfigError(`migration ${m.name}: ${b.root}'s code names the backend it moves from, ${locationOf(object)}; change the backend block in the same change`);
      if (before.get(b.root)) throw new ConfigError(`migration ${m.name}: the backend ${b.root}'s code names, ${locationOf(objects.get(b.root)!)}, already holds a state, so a move would overwrite it`);
      const block = backendBlock(b.from.backend, b.from.config);
      const data = join(options.work, `source-${i}`);
      const state = await withBackend(exec, options.binary, b.root, dir, block, data, env, `the backend it moves from`, (benv) => pullState(exec, options.binary, b.root, dir, benv));
      if (!state) throw new ConfigError(`migration ${m.name}: ${locationOf(object)} holds no state of ${b.root} to move`);
      sources.set(b.root, { object, block, data, version: await versionOf(object, options.fetch), state });
      after.set(b.root, state);
    }
  } else {
    for (const r of m.restores) {
      const o = objects.get(r.root)!;
      if (locationOf(o) !== r.location) throw new ConfigError(`migration ${m.name}: ${r.root}'s state is at ${locationOf(o)}, and the revert restores ${r.location}`);
      const now = before.get(r.root) ?? null;
      if (versions.get(r.root) !== r.from_version_id) {
        throw new ConfigError(`migration ${m.name}: ${r.root}'s state is at version ${versions.get(r.root) ?? "none"}, and ${m.revert} left ${r.from_version_id}; it moved since, so putting the older version back would undo that change too`);
      }
      const lineage = now?.lineage || derivedLineage(m.name, r.root);
      const serial = (now?.serial ?? 0) + 1;
      let state: StateFile;
      if (r.version_id === null) {
        state = emptyState(lineage, serial, now?.terraform_version);
      } else {
        if (o.backend !== "s3" || !("target" in o)) throw new ConfigError(`migration ${m.name}: ${r.root}'s backend keeps no versions to put back`);
        const text = await stateClient(o as Extract<StateObject, { target: S3Target }>, options.fetch).readVersion((o as { key: string }).key, r.version_id);
        if (text === undefined) throw new ConfigError(`migration ${m.name}: ${r.location} has no version ${r.version_id}; a lifecycle rule may have expired it`);
        const old = JSON.parse(text) as StateFile;
        state = { ...old, resources: Array.isArray(old.resources) ? old.resources : [], lineage, serial };
      }
      restored.set(r.root, r.version_id);
      after.set(r.root, state);
    }
  }
  const files: PlannedMigration["files"] = new Map();
  const out: MigrationRoot[] = [];
  for (const [i, root] of roots.entries()) {
    const state = after.get(root);
    if (!state) continue;
    const path = join(options.work, `${i}.tfstate`);
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
    const src = sources.get(root);
    files.set(root, { path, object: objects.get(root)!, state, beforeCount: before.get(root)?.resources.length ?? 0, ...(src ? { source: { object: src.object, block: src.block, data: src.data } } : {}) });
    const proof = await proofPlan(exec, options.binary, repo, root, path, options.work, i, env);
    log(`${root}: ${proof.changes.length === 0 ? "no changes against its new state" : `${proof.changes.length} change${proof.changes.length === 1 ? "" : "s"} against its new state: ${proof.changes.join(", ")}`}`);
    const o = objects.get(root)!;
    const b = before.get(root) ?? null;
    const v = versions.get(root);
    out.push({
      root,
      backend: o.backend,
      ...(locationOf(o) ? { location: locationOf(o) } : {}),
      before: { ...(v ? { version_id: v } : {}), digest: b ? stateDigest(b) : null },
      after: { digest: stateDigest(state) },
      ...(src ? { source: { backend: src.object.backend, ...(locationOf(src.object) ? { location: locationOf(src.object) } : {}), ...(src.version ? { version_id: src.version } : {}), digest: stateDigest(src.state) } } : {}),
      ...(restored.has(root) ? { restore: { version_id: restored.get(root)! } } : {}),
      proof,
    });
  }
  const record: MigrationRecord = {
    schema: MIGRATION_SCHEMA,
    name: m.name,
    file: m.file,
    file_digest: m.digest,
    change: m.kind,
    moves: m.moves,
    ...(m.kind === "backends" ? { backends: m.backends.map((b) => ({ root: b.root, from: locationOf(sources.get(b.root)!.object) ?? b.from.backend })) } : {}),
    ...(m.revert ? { revert: m.revert } : {}),
    roots: out,
    digest: migrationDigest(m, out),
    status: out.some((r) => r.proof.changes.length > 0) ? "proof-failed" : "planned",
  };
  return { record, files };
}

const locationOf = (o: StateObject): string | undefined => ("bucket" in o ? `s3://${(o as { bucket: string }).bucket}/${(o as { key: string }).key}` : "path" in o ? (o as { path: string }).path : undefined);

/**
 * Plan a root against a state file: an override file switches its backend
 * to that local file, in a data dir of the job's own, so the root's
 * `.terraform` and its real state are never touched.
 */
async function proofPlan(exec: BinaryExec, binary: string, repo: string, root: string, statePath: string, work: string, i: number, env: NodeJS.ProcessEnv): Promise<{ changes: string[]; summary: string }> {
  const dir = join(repo, root);
  const block = backendBlock("local", { path: resolve(statePath) });
  return withBackend(exec, binary, root, dir, block, join(work, `data-${i}`), env, "its new state", (penv) => planChanges(exec, binary, dir, penv, work, `${root.replace(/[^\w.-]/g, "_")}-proof`, true));
}

// ── applying ─────────────────────────────────────────────────────────────

/** The lock file the S3 backend's `use_lockfile` takes: the state's key and `.tflock`. */
export const lockKey = (key: string): string => `${key}.tflock`;

/** The lock info a migration writes, in the shape the binary writes and prints when it finds a lock held. */
export function lockInfo(path: string, now: string, who = `terragucci@${hostname()}`): string {
  return JSON.stringify({ ID: randomUUID(), Operation: "terragucci migrate", Info: "a state migration is writing this state", Who: who, Version: "", Created: now, Path: path });
}

interface HeldLock {
  root: string;
  release: () => Promise<void>;
}

/** Take the lock file of each S3 state a migration writes or moves from. Releases what it took and throws when one is held. */
async function takeLocks(files: PlannedMigration["files"], now: string, fetchFn?: S3Fetch): Promise<HeldLock[]> {
  const held: HeldLock[] = [];
  const objects = [...files].flatMap(([root, f]) => [{ root, object: f.object }, ...(f.source ? [{ root, object: f.source.object }] : [])]);
  for (const { root, object } of objects) {
    if (object.backend !== "s3" || !("target" in object)) continue;
    const o = object as Extract<StateObject, { target: S3Target }>;
    const client = stateClient(o, fetchFn);
    const key = lockKey(o.key);
    let got: boolean;
    try {
      got = await client.putIfAbsent(key, lockInfo(`${o.bucket}/${o.key}`, now), "application/json");
    } catch (e) {
      for (const h of held) await h.release().catch(() => {});
      throw new ConfigError(`${root}: the lock s3://${o.bucket}/${key} could not be taken: ${(e as Error).message}`);
    }
    if (!got) {
      for (const h of held) await h.release().catch(() => {});
      const info = await client.get(key).catch(() => undefined);
      throw new ConfigError(`${root}: its state is locked (s3://${o.bucket}/${key}${info ? `: ${info.slice(0, 300)}` : ""}), so nothing was written`);
    }
    held.push({ root, release: () => client.remove(key) });
  }
  return held;
}

/** The roots whose state, or whose state at the backend it moves from, moved since the plan: another version id or another digest. */
async function movedSince(repo: string, plan: PlannedMigration, options: MigrateOptions): Promise<string[]> {
  const exec = options.exec ?? runBinary;
  const env = options.env ?? process.env;
  const moved: string[] = [];
  for (const r of plan.record.roots) {
    const f = plan.files.get(r.root)!;
    const dir = join(repo, r.root);
    const v = await versionOf(f.object, options.fetch);
    const s = await pullState(exec, options.binary, r.root, dir, env);
    let same = (v ?? undefined) === r.before.version_id && (s ? stateDigest(s) : null) === r.before.digest;
    if (same && f.source && r.source) {
      const src = f.source;
      const sv = await versionOf(src.object, options.fetch);
      const ss = await withBackend(exec, options.binary, r.root, dir, src.block, src.data, env, "the backend it moves from", (benv) => pullState(exec, options.binary, r.root, dir, benv));
      same = (sv ?? undefined) === r.source.version_id && (ss ? stateDigest(ss) : null) === r.source.digest;
    }
    if (!same) moved.push(r.root);
  }
  return moved;
}

/**
 * Write a planned migration's states. Under each S3 state's lock (and that
 * of each state a backend move reads from): refuse when a state moved since
 * the plan; push the new states, the roots that gain resources first, so a
 * write that stops half way leaves a resource in two states rather than in
 * none; plan every root against its real backend and require no change; read
 * each new version id. A backend move leaves the state it read where it was.
 * The locks are released whatever happens.
 */
export async function applyMigration(repo: string, plan: PlannedMigration, options: MigrateOptions & { now: string }): Promise<MigrationRecord> {
  const exec = options.exec ?? runBinary;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const record = plan.record;
  const locks = await takeLocks(plan.files, options.now, options.fetch);
  try {
    const moved = await movedSince(repo, plan, options);
    if (moved.length > 0) return { ...record, status: "refused", moved };
    const order = [...record.roots].sort((a, b) => gained(plan, b.root) - gained(plan, a.root) || (a.root < b.root ? -1 : 1));
    for (const r of order) {
      const f = plan.files.get(r.root)!;
      const lockArgs = f.object.backend === "s3" ? ["-lock=false"] : [];
      const push = await exec(options.binary, ["state", "push", ...lockArgs, f.path], join(repo, r.root), env);
      if (push.code !== 0) return { ...record, status: "failed", error: `state push in ${r.root} failed: ${firstLine(push.out)}` };
      log(`${r.root}: wrote its new state`);
    }
    const roots: MigrationRoot[] = [];
    for (const [i, r] of record.roots.entries()) {
      const f = plan.files.get(r.root)!;
      const verify = await planChanges(exec, options.binary, join(repo, r.root), env, options.work, `${i}-verify`, f.object.backend !== "s3");
      const v = await versionOf(f.object, options.fetch);
      roots.push({ ...r, after: { ...r.after, ...(v ? { version_id: v } : {}) }, verify });
      log(`${r.root}: ${verify.changes.length === 0 ? "no changes against its backend" : `${verify.changes.length} changes against its backend: ${verify.changes.join(", ")}`}`);
    }
    const changed = roots.filter((r) => r.verify!.changes.length > 0).map((r) => r.root);
    return { ...record, roots, status: changed.length > 0 ? "failed" : "applied", ...(changed.length > 0 ? { error: `after the write, ${changed.join(", ")} plan changes` } : {}) };
  } finally {
    for (const l of locks) await l.release().catch((e: unknown) => log(`${l.root}: the lock could not be released: ${(e as Error).message}`));
  }
}

/** How many resources a root's new state gains over its state before: the roots that gain are written first. */
function gained(plan: PlannedMigration, root: string): number {
  const f = plan.files.get(root)!;
  return f.state.resources.length - f.beforeCount;
}

/** What a migration does, in one line. */
export function describeChange(m: Migration): string {
  if (m.kind === "backends") return `moving the state of ${m.backends.map((b) => `${b.root} from its ${b.from.backend} backend${typeof b.from.config.bucket === "string" ? ` s3://${b.from.config.bucket}/${String(b.from.config.key)}` : ""}`).join("; ")} to the backend its code names`;
  if (m.kind === "revert") return `putting back the states ${m.revert} wrote: ${m.restores.map((r) => `${r.root} to ${r.version_id ?? "no state"}`).join(", ")}`;
  return `moving ${m.moves.map((x) => `${x.addresses.join(", ")} from ${x.from} to ${x.to}`).join("; ")}`;
}

// ── the reverse ──────────────────────────────────────────────────────────

/** The file name a revert of `name` takes. */
export const revertName = (name: string): string => `${name}-revert`;

/**
 * The revert of a migration that applied, from its line in
 * `_gates/tf-migrate/done.jsonl`: each root back to the version the
 * migration recorded before it wrote, and refused when a state moved past
 * the version it recorded after. A backend move is put back with a backend
 * move the other way, and a root whose bucket kept no version cannot be put
 * back: both throw.
 */
export function revertMigration(name: string, done: string): { name: string; text: string } {
  let line: Record<string, unknown> | undefined;
  for (const l of done.split("\n").map((x) => x.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(l) as Record<string, unknown>;
      if (r.kind === "migration" && r.gate === name && r.result === "applied") line = r;
    } catch {
      continue;
    }
  }
  if (!line) throw new ConfigError(`chant/lifecycle records no applied migration ${name} in ${MIGRATE_DONE}`);
  if (line.change === "backends") throw new ConfigError(`${name} moved states to new backends; put it back with a backend move the other way, which reads each state where it is now`);
  if (line.change === "revert") throw new ConfigError(`${name} is a revert; apply the migration it put back again with a new migration file`);
  const roots = Array.isArray(line.roots) ? (line.roots as Record<string, unknown>[]) : [];
  const problems: string[] = [];
  const restores = roots.map((r) => {
    const root = String(r.root);
    if (typeof r.location !== "string" || !r.location.startsWith("s3://")) problems.push(`${root}: its backend keeps no versions, so there is no earlier state to put back`);
    if (r.before === null && r.before_digest !== null) problems.push(`${root}: its bucket kept no version before ${name} wrote, so there is no earlier state to put back`);
    if (typeof r.after !== "string") problems.push(`${root}: ${name} recorded no version after its write, so a later change could not be told apart`);
    return { root, location: String(r.location), version_id: typeof r.before === "string" ? r.before : null, from_version_id: typeof r.after === "string" ? r.after : null };
  });
  if (problems.length > 0) throw new ConfigError(`${name} cannot be put back:\n  ${problems.join("\n  ")}`);
  const q = (v: string | null): string => (v === null ? "null" : JSON.stringify(v));
  const text = [
    `# Puts back the states migration ${name} wrote, to the versions it recorded before it wrote them.`,
    `# Written by terragucci migrate revert ${name}. Revert the code of ${name} in the same change, so each root plans with no change.`,
    `revert: ${name}`,
    "restores:",
    ...restores.flatMap((r) => [`  - root: ${r.root}`, `    location: ${r.location}`, `    version_id: ${q(r.version_id)}`, `    from_version_id: ${q(r.from_version_id)}`]),
    "",
  ].join("\n");
  return { name: revertName(name), text };
}

/**
 * `terragucci migrate revert <name>`: write `migrations/<name>-revert.yml`
 * from the migration's record on chant/lifecycle as origin holds it. It
 * writes the file and nothing else; the change that carries it is planned,
 * approved and applied like any migration.
 */
export function writeRevert(repo: string, name: string): string {
  readLedger(repo, MIGRATE_LEDGER);
  const show = spawnSync("git", ["show", `refs/remotes/origin/chant/lifecycle:${MIGRATE_DONE}`], { cwd: repo, encoding: "utf-8" });
  const { name: file, text } = revertMigration(name, show.status === 0 ? show.stdout : "");
  const path = join(repo, MIGRATIONS_DIR, `${file}.yml`);
  if (existsSync(path)) throw new ConfigError(`${MIGRATIONS_DIR}/${file}.yml is there already`);
  mkdirSync(join(repo, MIGRATIONS_DIR), { recursive: true });
  writeFileSync(path, text);
  return `${MIGRATIONS_DIR}/${file}.yml`;
}

// ── the gate ─────────────────────────────────────────────────────────────

const at = (iso: string): number => new Date(iso).getTime();

/** The migrations chant/lifecycle says ran their writes, by name: the newest line of each. */
export function doneMigrations(text: string): Map<string, { status: string; file_digest?: string; timestamp: string }> {
  const out = new Map<string, { status: string; file_digest?: string; timestamp: string }>();
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.kind !== "migration" || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
      out.set(r.gate, { status: String(r.result), ...(typeof r.file_digest === "string" ? { file_digest: r.file_digest } : {}), timestamp: r.timestamp });
    } catch {
      continue;
    }
  }
  return out;
}

/** One line of `done.jsonl`: what a migration's writes did, with the version ids before and after and never a state's contents. */
export function doneLine(record: MigrationRecord, approvedBy: string, now: string, runId?: string, commit?: string): Record<string, unknown> {
  return {
    version: 1,
    kind: "migration",
    op: MIGRATE_OP,
    gate: record.name,
    timestamp: now,
    planDigest: record.digest,
    file_digest: record.file_digest,
    result: record.status,
    approvedBy,
    change: record.change,
    ...(record.revert ? { revert: record.revert } : {}),
    roots: record.roots.map((r) => ({
      root: r.root,
      location: r.location,
      before: r.before.version_id ?? null,
      after: r.after.version_id ?? null,
      before_digest: r.before.digest,
      after_digest: r.after.digest,
      ...(r.source ? { source: r.source.location, source_version: r.source.version_id ?? null } : {}),
    })),
    ...(record.error ? { error: record.error } : {}),
    ...(runId ? { runId } : {}),
    ...(commit ? { commit } : {}),
  };
}

export interface RunMigrationsOptions {
  binary: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
  /** The pipeline's `--approval`. */
  approval?: Approval;
  /** The ref the approval rule is read from; default the commit before HEAD. */
  base?: string;
  config?: string;
  exec?: BinaryExec;
  fetch?: S3Fetch;
  /** Read only: prove each pending migration and print its digest, as a pull request's plan job does. */
  planOnly?: boolean;
  log?: (line: string) => void;
}

export interface MigrationsRun {
  code: number;
  /** Each migration this run planned or ran, as its record says. */
  records: MigrationRecord[];
  /** The command that approves the waiting migration. */
  command?: string;
}

function git(repo: string, args: string[]) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
}

/** Write a migration's record to `terragucci-report/migrations/<name>.json`, beside the wave's report. */
function writeRecord(repo: string, record: MigrationRecord): string {
  const dir = join(repo, "terragucci-report", "migrations");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.name}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
  return path;
}

/**
 * Run the repo's migrations that have not run, in name order, stopping at
 * the first that does not apply. With no migration to run it returns 0 and
 * prints nothing. Exit codes as `stage tf-apply`: 3 a migration waits for
 * its approval, 4 its states moved since the approval or the plan, 1 it
 * could not be planned, proved or written.
 */
export async function runMigrations(repo: string, options: RunMigrationsOptions): Promise<MigrationsRun> {
  const log = options.log ?? ((l: string) => console.log(l));
  const env = options.env ?? process.env;
  let migrations: Migration[];
  try {
    migrations = listMigrations(repo);
  } catch (e) {
    log(`migrations: ${(e as Error).message}`);
    return { code: EXIT.failed, records: [] };
  }
  if (migrations.length === 0) return { code: EXIT.applied, records: [] };
  let done = new Map<string, { status: string; file_digest?: string; timestamp: string }>();
  let ledger: GateLedger = { pending: [], resolutions: [] };
  try {
    ledger = readLedger(repo, MIGRATE_LEDGER);
    const show = git(repo, ["show", `refs/remotes/origin/chant/lifecycle:${MIGRATE_DONE}`]);
    done = doneMigrations(show.status === 0 ? show.stdout : "");
  } catch (e) {
    if (!options.planOnly) {
      log(`migrations: ${(e as Error).message}`);
      return { code: EXIT.failed, records: [] };
    }
  }
  const records: MigrationRecord[] = [];
  const pending = migrations.filter((m) => done.get(m.name)?.status !== "applied");
  for (const m of migrations) {
    const was = done.get(m.name);
    if (was?.status === "applied") {
      if (was.file_digest && was.file_digest !== m.digest) {
        log(`migration ${m.name}: ${m.file} changed after it applied; a migration runs once, so write a new file for another move`);
        return { code: EXIT.failed, records };
      }
      continue;
    }
    if (was) {
      log(`migration ${m.name}: its last run wrote states and ended ${was.status} at ${was.timestamp}; read terragucci-report/migrations/${m.name}.json of that run, put the states right, and record it before running it again`);
      return { code: EXIT.failed, records };
    }
    const work = mkdtempSync(join(tmpdir(), "terragucci-migrate-"));
    try {
      const out = await runOne(repo, m, ledger, { ...options, env, log }, work);
      records.push(out.record);
      writeRecord(repo, out.record);
      if (out.code !== EXIT.applied) return { code: out.code, records, ...(out.command ? { command: out.command } : {}) };
      // A later migration plans against the states this one writes, so a read-only run proves the first alone.
      if (options.planOnly) {
        const later = pending.length - 1;
        if (later > 0) log(`migrations: ${later} more ${later === 1 ? "migration is" : "migrations are"} proved once ${m.name} applies`);
        return { code: EXIT.applied, records };
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return { code: EXIT.applied, records };
}

async function runOne(repo: string, m: Migration, ledger: GateLedger, options: RunMigrationsOptions & { env: NodeJS.ProcessEnv; log: (l: string) => void }, work: string): Promise<{ code: number; record: MigrationRecord; command?: string }> {
  const { log, env } = options;
  const label = `migration ${m.name}`;
  log(`${label}: ${describeChange(m)}`);
  let plan: PlannedMigration;
  try {
    plan = await planMigration(repo, m, { binary: options.binary, env, work, log, ...(options.exec ? { exec: options.exec } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  } catch (e) {
    log(`${label}: ${(e as Error).message}`);
    log(`${label}: nothing was written`);
    return { code: EXIT.failed, record: { schema: MIGRATION_SCHEMA, name: m.name, file: m.file, file_digest: m.digest, change: m.kind, moves: m.moves, roots: [], digest: "", status: "failed", error: (e as Error).message } };
  }
  const record = plan.record;
  for (const r of record.roots) log(`${r.root}: state ${r.location ?? r.backend}${r.before.version_id ? ` version ${r.before.version_id}` : ""}, ${r.before.digest ? `digest ${r.before.digest}` : "no state yet"}`);
  if (record.status === "proof-failed") {
    log(`${label}: every root must plan with no change against its new state, and ${record.roots.filter((r) => r.proof.changes.length > 0).map((r) => r.root).join(", ")} would change; nothing was written`);
    return { code: EXIT.failed, record };
  }
  log(`${label}: every root plans with no change against its new state; digest ${record.digest}`);
  if (options.planOnly) return { code: EXIT.applied, record };

  const now = options.now ?? new Date().toISOString();
  const configPath = options.config ?? findConfig(repo);
  const rule = await approvalRule(repo, { ...(options.base ? { at: options.base } : {}), ...(configPath ? { config: configPath } : {}), ...(options.approval ? { flag: options.approval } : {}) });
  const sealed = rule.mode === "sealed";
  if (sealed) {
    ledger = {
      ...ledger,
      resolutions: ledger.resolutions.filter((r) => {
        if (r.gate !== m.name) return true;
        const why = sealRefusal(rule.signers, rule.signersPath, r);
        if (why !== null && samePlanDigest(r.planDigest, record.digest)) log(`${label}: an approval does not count: ${why}`);
        return why === null;
      }),
    };
  }
  const decision = decideGate(ledger, m.name, record.digest, now);
  const command = migrateApproveCommand(m.name, record.digest, sealed);
  const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
  const commit = env.TG_SHA || git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const members = beforeMembers(record.roots);
  if (decision.status !== "approved") {
    if (!decision.standing) {
      const pending: PendingRecord = {
        version: 1,
        kind: "pending",
        op: MIGRATE_OP,
        gate: m.name,
        timestamp: now,
        expiresAt: new Date(at(now) + 48 * 3600 * 1000).toISOString(),
        planDigest: record.digest,
        description: `${label}: ${record.roots.map((r) => r.root).join(", ")}`,
        ...(runId ? { runId } : {}),
        ...(commit ? { commit } : {}),
        members,
        neverOverMcp: true,
      };
      appendPending(repo, pending, { [keptPath(m.name, record.digest)]: JSON.stringify(record, null, 2) + "\n" }, MIGRATE_LEDGER);
    }
    if (decision.status === "refused") {
      const approvedFact = [...ledger.pending].reverse().find((p) => p.gate === m.name && p.members && samePlanDigest(p.planDigest, decision.approved));
      const moved = approvedFact ? movedMembers(approvedFact.members!, members) : record.roots.map((r) => r.root);
      log(`${label}: ${decision.by} approved ${decision.approved ?? "another digest"}, and the states moved since: ${moved.join(", ") || "the migration file"}; nothing was written`);
      log(`${label}: read the proof above, then approve this plan with:`);
      log(`  ${command}`);
      return { code: EXIT.refused, record: { ...record, status: "refused", moved }, command };
    }
    log(`${label} waits for an approval of digest ${record.digest}. Read the proof above, then approve it with:`);
    log(`  ${command}`);
    log("Then run this job again.");
    return { code: EXIT.waiting, record: { ...record, status: "waiting" }, command };
  }
  log(`${label}: approved by ${decision.by} for this digest`);
  const applied: AppliedRecord = { version: 1, kind: "applied", op: MIGRATE_OP, gate: m.name, planDigest: record.digest, approvedAt: decision.at, approvedBy: decision.by, timestamp: now, ...(runId ? { runId } : {}), ...(commit ? { commit } : {}) };
  appendLifecycle(repo, MIGRATE_APPLIED, [JSON.stringify(applied)], {}, `Applied under approval: ${MIGRATE_OP} ${m.name}`);
  let result: MigrationRecord;
  try {
    result = await applyMigration(repo, plan, { binary: options.binary, env, work, log, now, ...(options.exec ? { exec: options.exec } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  } catch (e) {
    log(`${label}: ${(e as Error).message}`);
    return { code: EXIT.failed, record: { ...record, status: "failed", error: (e as Error).message } };
  }
  result = { ...result, approved_by: decision.by, finished: new Date().toISOString(), ...(commit ? { commit } : {}) };
  if (result.status === "refused") {
    log(`${label}: under the lock, the state of ${result.moved!.join(", ")} is not the one planned; nothing was written. Run this job again to plan from the states as they are`);
    return { code: EXIT.refused, record: result };
  }
  appendLifecycle(repo, MIGRATE_DONE, [JSON.stringify(doneLine(result, decision.by, now, runId, commit))], {}, `Migration ${result.status}: ${m.name}`);
  for (const r of result.roots) log(`${r.root}: version ${r.before.version_id ?? "none"} before, ${r.after.version_id ?? "none"} after`);
  if (result.status !== "applied") {
    log(`${label}: ${result.error}; the states were written, and each root's version before is in terragucci-report/migrations/${m.name}.json`);
    return { code: EXIT.failed, record: result };
  }
  log(`${label} applied`);
  return { code: EXIT.applied, record: result };
}
