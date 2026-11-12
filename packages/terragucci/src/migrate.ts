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
 * terragucci reads the file, finds each root's place (a Terragrunt unit's
 * working directory, an Atmos instance's workspace) and initialises it, and
 * keeps the record, the report and the history. The terraform lexicon plans
 * and writes the migration (chant issue 4806): `planTerraformMigration` reads
 * each state and its version, builds the new states, proves that every root
 * plans with no change against its new one, and hands back the engine that
 * writes them under each state's lock and plans every root again;
 * `planEstateMigration` does the same for roots under choudoufu's live
 * markers (./migrate-estate.ts). A standalone run asks for and spends the
 * approval through chant core's `runStateMigration`, which names the roots
 * whose state moved since an earlier approval; a run inside a wave holds the
 * wave on the migration's gate and writes with `writeStateMigration` once
 * chant found the approval.
 *
 * State contents never leave the job: the record holds version ids and
 * digests. A migration applied once is never run again; the `done.jsonl`
 * lines older releases wrote are still read as its history.
 */
import { spawnSync } from "node:child_process";
import { jobCommit } from "./forge";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { TerragruntExec } from "@intentius/chant-lexicon-terraform/terragrunt/run";
import { terragruntUnitPlace, UnitPlaceError } from "@intentius/chant-lexicon-terraform/terragrunt/place";
import { doneMigrations, migrationHistory as chantMigrationHistory, revertMigration } from "@intentius/chant-lexicon-terraform/migration-history";
import { liveRoots } from "@intentius/chant-lexicon-terraform/live-roots";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computePlanDigest, samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { runStateMigration, writeStateMigration, type MigrationRootPlan, type MigrationSource, type StateMigrationEngine, type StateMigrationResult } from "@intentius/chant/state-migration";
import { parseYAML } from "@intentius/chant/yaml";
import { actorOf } from "@intentius/chant/actor";
import { lastLines, type BinaryExec } from "@intentius/chant-lexicon-terraform/state";
import { StateOpError } from "@intentius/chant-lexicon-terraform/state-ops";
import { backendMoveProblems, MigrationError, planTerraformMigration, PULLED_BACKENDS, type BackendMove, type Move, type Restore, type TerraformMigrationPlan } from "@intentius/chant-lexicon-terraform/state-migration";
import { LEDGER_READ_REF, movedMembers, readLedger, type GateLedger } from "./apply";
import { approvalRule } from "./approval";
import { runBinary, terragruntExec } from "./binary-env";
import { ConfigError, findConfig, resolveRepo, type Approval } from "./config";
import { detectShape, type RootInit, type Shape } from "./shape";
import type { S3Fetch } from "@intentius/chant/object-store";
import type { LockOperation } from "@intentius/chant-lexicon-terraform/state";
import { MARKER, PIPELINE_PATHS } from "./render";
import { requestRules, syncLocalLedger } from "./gated-request";
import { rootRoleEnv } from "./cloud-identity";
import { planEstate, type EstateRun } from "./migrate-estate";
import type { Retag, Stamp } from "@intentius/chant-lexicon-terraform/estate-migration";
import type { MigrationCounts, ProgressSinks } from "./migrate-progress";
import { literal, stateAddress } from "./state-address";
import type { Roster } from "./report/roster";

export type { BackendMove, Move, Restore };
export type { BinaryExec, BinaryIo, Ran, StateFile, StateResource } from "@intentius/chant-lexicon-terraform/state";

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
export const migrateApproveCommand = (name: string, digest: string, sealed = false): string => `terragucci approve ${name} --plan ${digest}${sealed ? " --sign" : ""}`;

/** Exit codes, as `stage tf-apply` gives them. */
const EXIT = { applied: 0, failed: 1, waiting: 3, refused: 4 } as const;

// ── the file ─────────────────────────────────────────────────────────────
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

export const sha = (text: string | Buffer): string => `sha256:${createHash("sha256").update(text).digest("hex")}`;

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

/**
 * The backend moves of a file. The shape is read here; what a move must
 * say (a backend chant reads, where the state is, no credential in the repo,
 * a root that moves once) is the terraform lexicon's `backendMoveProblems`.
 */
function parseBackends(raw: unknown, problems: string[], rootOf: (at: string, k: string, v: unknown) => string | undefined, file: string): BackendMove[] {
  const out: BackendMove[] = [];
  if (!Array.isArray(raw) || raw.length === 0) problems.push("backends is missing or empty");
  for (const [i, b] of (Array.isArray(raw) ? raw : []).entries()) {
    const at = `backends[${i}]`;
    const o = b && typeof b === "object" ? (b as Record<string, unknown>) : {};
    for (const k of Object.keys(o)) if (!["root", "from"].includes(k)) problems.push(`${at}.${k} is not a key of a backend move; it has root and from`);
    const root = rootOf(at, "root", o.root);
    const from = o.from && typeof o.from === "object" ? (o.from as Record<string, unknown>) : undefined;
    // Every move keeps its place in the list, so the lexicon's `backends[<i>]` names the one the file does.
    if (!from) {
      problems.push(`${at}.from must give the backend the state is in now: backend and config`);
      out.push({ root: root ?? `\u0000${i}`, from: { backend: "", config: {} } });
      continue;
    }
    for (const k of Object.keys(from)) if (!["backend", "config"].includes(k)) problems.push(`${at}.from.${k} is not a key; from has backend and config`);
    const config = from.config && typeof from.config === "object" && !Array.isArray(from.config) ? (from.config as Record<string, unknown>) : {};
    out.push({ root: root ?? `\u0000${i}`, from: { backend: typeof from.backend === "string" ? from.backend : "", config } });
  }
  problems.push(...backendMoveProblems(out).filter((p) => !p.includes("\u0000")));
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

/**
 * The repo's migration files, `migrations/<name>.yml` or `.yaml`, by name:
 * the one test of whether a repo carries migrations, which the plan job,
 * wave 1, init and config check all use.
 */
export function migrationFiles(repo: string, dir = MIGRATIONS_DIR): string[] {
  const at = join(repo, dir);
  if (!existsSync(at)) return [];
  return readdirSync(at)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => `${dir}/${f}`);
}

/**
 * Why the repo's generated GitHub pipeline cannot run its migrations: an
 * apply job that may not write `chant/lifecycle` (`contents: read`), where a
 * migration's gate and record are. init gives them `contents: write` when it
 * finds migration files; a pipeline written before them, or by an init that
 * was skipped, lacks it. No migration files, no generated GitHub pipeline, or
 * one terragucci did not write: no problem.
 */
export function migrationPipelineProblems(repo: string): string[] {
  const files = migrationFiles(repo);
  if (files.length === 0) return [];
  const path = join(repo, PIPELINE_PATHS.github);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  if (!text.startsWith(MARKER)) return [];
  let doc: unknown;
  try {
    doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n"));
  } catch {
    return [];
  }
  const jobs = (doc as { jobs?: Record<string, { permissions?: { contents?: string }; steps?: { run?: string }[] }> } | undefined)?.jobs ?? {};
  // Only a job that runs a wave can run a migration: chant's wave jobs (`run wave --spec`), or an older pipeline's `stage tf-apply`;
  // not the status jobs (`run wave --op ... --apply-status`), apply-done, nor an apply-comment that applies nothing.
  const runsWaves = (job: { steps?: { run?: string }[] } | undefined): boolean =>
    (job?.steps ?? []).some((st) => typeof st.run === "string" && (st.run.includes("terragucci run wave --spec") || st.run.includes("terragucci stage tf-apply")));
  const readOnly = Object.entries(jobs)
    .filter(([name, job]) => /^apply/.test(name) && runsWaves(job) && job?.permissions?.contents !== "write")
    .map(([name]) => name)
    .sort();
  if (readOnly.length === 0) return [];
  return [`${MIGRATIONS_DIR}/ holds ${files.length === 1 ? "a migration" : `${files.length} migrations`} (${files.join(", ")}), and in ${PIPELINE_PATHS.github} ${readOnly.join(", ")} may not write chant/lifecycle, where a migration waits for its approval; run terragucci init to write the pipeline again`];
}

/**
 * The generated pipeline that applies each wave in a job per identity
 * (./cloud-identity.ts), or undefined: its group jobs pass `--group` to chant's
 * wave runner (an older pipeline's apply jobs pass `--groups`). Wave 1's
 * deciding job runs the state migrations, and in such a pipeline it holds
 * the plan identities alone, which cannot write a state.
 */
export function groupedPipeline(repo: string): string | undefined {
  for (const rel of Object.values(PIPELINE_PATHS)) {
    const path = join(repo, rel);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");
    if (text.startsWith(MARKER) && /terragucci (?:run wave --spec [^\n]* --group |stage tf-apply [^\n]* --groups )/.test(text)) return rel;
  }
  return undefined;
}

/** Why a pull request's plan refuses `files`, the migrations no run applied yet, in a repo whose pipeline is `grouped` (groupedPipeline). */
export function groupedMigrationProblem(files: readonly string[], grouped: string): string {
  return `${files.join(", ")} ${files.length === 1 ? "is a state migration" : "are state migrations"}, and ${grouped} applies each wave in a job per identity: wave 1's deciding job runs a migration, and it holds the plan roles alone, which cannot write a state, so a grouped repo cannot run state migrations; leave ${files.length === 1 ? "the file" : "the files"} out of this change`;
}

/** The repo's migration files, read, by name. */
export function listMigrations(repo: string, dir = MIGRATIONS_DIR): Migration[] {
  return migrationFiles(repo, dir).map((f) => parseMigration(f, readFileSync(join(repo, f), "utf-8")));
}

// ── the plan record ──────────────────────────────────────────────────────

/** One affected root in a migration's plan, as chant's migration binds it: never its state's contents. */
export interface MigrationRoot extends Omit<MigrationRootPlan, "source"> {
  /** `estate` for a root under choudoufu's live markers; records before chant issue 4806 name each root's backend. */
  backend?: string;
  /** A backend move: the backend the state was read from, where, its version id and its digest. That state is left where it was. */
  source?: MigrationSource & { backend?: string };
  /** A revert: the version put back, null for a root the reverted migration found with no state. */
  restore?: { version_id: string | null };
}

export interface MigrationRecord {
  schema: typeof MIGRATION_SCHEMA;
  name: string;
  file: string;
  file_digest: string;
  /** moves, backends or revert; retag or adopt when the roots are choudoufu estates (./migrate-estate.ts). */
  change: Migration["kind"] | "retag" | "adopt";
  /** A retag: each resource instance that changes estate, and the live resource its markers are on. */
  retags?: Retag[];
  /** An adoption: each resource instance of the old state, as the live system verified it. */
  stamps?: Stamp[];
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
  /** An estate migration whose binary wrote `-progress-json` lines: how many resources each outcome holds, and how many have no line yet (./migrate-progress.ts). */
  progress?: MigrationCounts;
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

/**
 * The roots whose state moved since a migration's approval of another
 * digest: the members of the pending fact that digest answered against the
 * ones planned now. With no such fact on the ledger, every root.
 */
export function movedSinceApproval(ledger: Pick<GateLedger, "pending">, gate: string, approved: string | undefined, members: readonly { member: string; planDigest: string }[], roots: readonly string[]): string[] {
  const fact = [...ledger.pending].reverse().find((p) => p.gate === gate && p.members && samePlanDigest(p.planDigest, approved));
  return fact ? movedMembers(fact.members!, members) : [...roots];
}

// ── running the binary ───────────────────────────────────────────────────

/** The terraform lexicon's run of the binary, with the forge tokens left out of its environment (./binary-env.ts). */
export { runBinary };
// ── planning ─────────────────────────────────────────────────────────────

export interface MigrateOptions {
  binary: string;
  env?: NodeJS.ProcessEnv;
  exec?: BinaryExec;
  /** How a Terragrunt unit is prepared: the `terragrunt` executable and its runner. Default `TERRAGUCCI_TERRAGRUNT`, then `terragrunt` on the path. */
  terragrunt?: { path?: string; exec?: TerragruntExec };
  fetch?: S3Fetch;
  /** Where new states and proof plans are kept; removed by the caller. */
  work: string;
  log?: (line: string) => void;
  /** Each estate root's roster, from the plan it makes after an estate migration's write (./report/roster.ts). */
  roster?: (root: string, roster: Roster) => void;
  /** Where an estate migration's per-resource progress goes beyond `terragucci-report/` (./migrate-progress.ts). */
  progress?: ProgressSinks;
  /** The run's time, which dates an estate root's roster after the write. Default the time of the write. */
  now?: string;
}

/** Why a root cannot take part in a migration, or undefined. */
export function refusal(repo: string, root: string): string | undefined {
  const dir = join(repo, root);
  if (!existsSync(dir)) return `${root} is not a directory in the repo`;
  // A Terragrunt unit's code and backend are what Terragrunt makes of its terragrunt.hcl: placeOf prepares it.
  if (existsSync(join(dir, "terragrunt.hcl"))) return undefined;
  // A CDK Terrain stack is a root whose code is JSON: cdktf.out/stacks/<stack>/cdk.tf.json.
  const files = readdirSync(dir).filter((f) => (f.endsWith(".tf") || f.endsWith(".tf.json")) && f !== OVERRIDE_FILE);
  if (files.length === 0) return `${root} holds no .tf or .tf.json files`;
  const cloud = `${root} uses a cloud block, whose state HCP Terraform keeps; migrations write state to s3, gcs, azurerm, local, pg, kubernetes, consul and http backends, so point its code at one and move the state with a backend move from cloud`;
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf-8");
    if (f.endsWith(".tf")) {
      if (/^\s*cloud\s*\{/m.test(text)) return cloud;
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return `${root}: ${f} is not JSON`;
    }
    if (jsonCloud(doc)) return cloud;
  }
  return undefined;
}

/** Whether a root's JSON code gives a `terraform` block a `cloud` block, as `terraform.cloud` or a list of terraform blocks. */
function jsonCloud(doc: unknown): boolean {
  const tf = doc && typeof doc === "object" ? (doc as Record<string, unknown>).terraform : undefined;
  const blocks = Array.isArray(tf) ? tf : tf ? [tf] : [];
  return blocks.some((b) => b && typeof b === "object" && "cloud" in (b as object));
}

/** Where a root's binary runs: its directory and environment. A plain root runs where it is, with the job's environment. */
export interface Place {
  dir: string;
  env: NodeJS.ProcessEnv;
  /** How a root that names its workspace (an Atmos instance) is initialised: in default, then its own selected. */
  init?: RootInit;
}

/**
 * Where a Terragrunt unit's binary runs, as Terragrunt prepares it: the
 * terraform lexicon's `terragruntUnitPlace` (chant#4910), with terragucci's
 * `terragrunt` (`TERRAGUCCI_TERRAGRUNT`, else the one on the path) and its
 * tokenless runner. A unit Terragrunt cannot prepare is refused in the
 * lexicon's words.
 */
export async function unitPlace(repo: string, unit: string, binary: string, env: NodeJS.ProcessEnv, work: string, tg: MigrateOptions["terragrunt"] = {}): Promise<Place> {
  try {
    return await terragruntUnitPlace({ projectDir: repo, unit, binary, env, work, terragrunt: tg.path ?? env.TERRAGUCCI_TERRAGRUNT ?? "terragrunt", exec: tg.exec ?? terragruntExec });
  } catch (e) {
    throw e instanceof UnitPlaceError ? new ConfigError(e.message) : e;
  }
}

/** Each root's place: a unit's as Terragrunt prepares it, a plain root's where it is. */
export async function placesOf(repo: string, roots: readonly string[], options: MigrateOptions, env: NodeJS.ProcessEnv, shape: Shape): Promise<Map<string, Place>> {
  const out = new Map<string, Place>();
  for (const root of roots) {
    // Each root with its own role, when `oidc.roles` names one (./cloud-identity.ts); a unit is prepared under it too.
    const renv = rootRoleEnv(env, root);
    if (existsSync(join(repo, root, "terragrunt.hcl"))) {
      out.set(root, await unitPlace(repo, root, options.binary, renv, options.work, options.terragrunt));
      continue;
    }
    // A root that names its workspace (an Atmos instance) runs in it, so the migration moves that workspace's state.
    const init = shape.rootInit(root, renv);
    out.set(root, { dir: join(repo, root), env: shape.rootEnv(root, renv), ...(init ? { init } : {}) });
  }
  return out;
}

/** Initialise a root against the backend its code names, in place. `-reconfigure`: a data dir another backend left is not migrated from. A root that names its workspace (an Atmos instance) selects it. */
async function initRoot(exec: BinaryExec, binary: string, root: string, dir: string, env: NodeJS.ProcessEnv, ws?: RootInit): Promise<void> {
  const init = await exec(binary, ["init", "-input=false", "-no-color", "-reconfigure"], dir, ws?.init ?? env);
  if (init.code !== 0) throw new ConfigError(`init in ${root} failed: ${lastLines(init.out)}`);
  if (!ws) return;
  const sel = await exec(binary, ws.select, dir, ws.selectEnv);
  if (sel.code !== 0) throw new ConfigError(`workspace select in ${root} failed: ${lastLines(sel.out)}`);
}

/** What planning leaves for the write: the record, where each root runs, and chant's plan and engine. */
export interface PlannedMigration {
  record: MigrationRecord;
  /** Where each root's binary runs (a Terragrunt unit's working directory). */
  places: Map<string, Place>;
  /** Each root's plan, as chant's migration binds it. */
  roots: MigrationRootPlan[];
  /** What writes the migration under the locks (chant's `StateMigrationEngine`). */
  engine: StateMigrationEngine;
  /** A migration into or between choudoufu estates, which writes markers on live resources instead of states. */
  estate?: EstateRun;
}

/** A migration the lexicon refuses, as the user reads it: the lexicon's words. */
export function planningError(e: unknown): unknown {
  return e instanceof MigrationError || e instanceof StateOpError ? new ConfigError(e.message) : e;
}

/**
 * Plan a migration: find and initialise each root, and have the terraform
 * lexicon read every affected state and its version, build the new states in
 * `work` and plan each root against its new state. The record says
 * `proof-failed` when a root would change; a root that cannot be read or a
 * change that does not fit throws ConfigError.
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
  // A unit an explicit stack generates is generated first, as a wave generates it.
  const shape = detectShape(repo, resolveRepo({}));
  await shape.prepareRoots({ roots, binary: options.binary, ...(options.terragrunt?.path ? { terragrunt: options.terragrunt.path } : {}), ...(options.terragrunt?.exec ? { exec: options.terragrunt.exec } : {}) });
  const problems = roots.map((r) => refusal(repo, r)).filter((x): x is string => x !== undefined);
  if (problems.length > 0) throw new ConfigError(`migration ${m.name} cannot run:\n  ${problems.join("\n  ")}`);
  mkdirSync(options.work, { recursive: true });
  // Roots under choudoufu's live markers keep no state file: a move between them is a retag, a backend move into one an adoption.
  const live = liveRoots(repo, roots);
  if (live.length > 0) {
    if (live.length < roots.length) {
      const stock = roots.filter((r) => !live.includes(r));
      throw new ConfigError(`migration ${m.name} cannot run: ${live.join(", ")} ${live.length === 1 ? "keeps its" : "keep their"} resources under live markers and ${stock.join(", ")} ${stock.length === 1 ? "keeps" : "keep"} a state; ${m.kind === "moves" ? "adopt the state into an estate with a backends migration first" : "write a file for each"}`);
    }
    return planEstate(repo, m, roots, options, shape);
  }
  const places = await placesOf(repo, roots, options, env, shape);
  // terragucci initialises each root where it runs (a workspace selected), so the lexicon reads it as it stands.
  for (const root of roots) {
    const { dir, env: renv, init: ws } = places.get(root)!;
    await initRoot(exec, options.binary, root, dir, renv, ws);
  }
  let planned: TerraformMigrationPlan;
  try {
    planned = await planTerraformMigration({
      name: m.name,
      ...(m.kind === "moves" ? { moves: m.moves } : m.kind === "backends" ? { backends: m.backends } : { restores: m.restores }),
      roots: roots.map((root) => ({ root, binary: options.binary, dir: places.get(root)!.dir, env: places.get(root)!.env, init: false })),
      repo,
      work: options.work,
      exec,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      lock: MIGRATE_LOCK,
      sourceLock: MIGRATE_SOURCE_LOCK,
      who: `terragucci@${hostname()}`,
      overrideFile: OVERRIDE_FILE,
      log,
    });
  } catch (e) {
    throw planningError(e);
  }
  const restored = new Map(m.restores.map((r) => [r.root, r.version_id] as const));
  const from = new Map(m.backends.map((b) => [b.root, b.from.backend] as const));
  const out: MigrationRoot[] = planned.roots.map((r) => ({
    ...r,
    ...(r.source ? { source: { backend: from.get(r.root), ...r.source } } : {}),
    ...(restored.has(r.root) ? { restore: { version_id: restored.get(r.root)! } } : {}),
  }));
  const record: MigrationRecord = {
    schema: MIGRATION_SCHEMA,
    name: m.name,
    file: m.file,
    file_digest: m.digest,
    change: m.kind,
    moves: m.moves,
    ...(m.kind === "backends" ? { backends: m.backends.map((b) => ({ root: b.root, from: out.find((r) => r.root === b.root)?.source?.location ?? b.from.backend })) } : {}),
    ...(m.revert ? { revert: m.revert } : {}),
    roots: out,
    digest: migrationDigest(m, out),
    status: out.some((r) => r.proof.changes.length > 0) ? "proof-failed" : "planned",
  };
  return { record, places, roots: planned.roots, engine: planned.engine };
}

// ── applying ─────────────────────────────────────────────────────────────

/** A state migration's lock. */
export const MIGRATE_LOCK: LockOperation = { operation: "terragucci migrate", info: "a state migration is writing this state" };
/** What the lock of a workspace a state moves from says: the migration reads it. */
export const MIGRATE_SOURCE_LOCK: LockOperation = { operation: "terragucci migrate", info: "a state migration is reading this state" };

/** The record of a written migration: how chant's write ended, each root's versions after it and its plan against its real state. */
export function writtenRecord(plan: PlannedMigration, r: StateMigrationResult): MigrationRecord {
  const byRoot = new Map(r.roots.map((x) => [x.root, x] as const));
  const roots = plan.record.roots.map((x) => {
    const w = byRoot.get(x.root);
    return w ? { ...x, before: w.before, after: w.after, ...(w.verify ? { verify: w.verify } : {}) } : x;
  });
  const progress = plan.estate?.at.progress?.progress;
  return { ...plan.record, roots, status: r.status === "moved" ? "refused" : r.status, ...(r.moved?.length ? { moved: r.moved } : {}), ...(r.error ? { error: r.error } : {}), ...(progress ? { progress } : {}) };
}

/** Each root's plan after the write, one line each. */
function logVerified(record: MigrationRecord, live: boolean, log: (line: string) => void): void {
  for (const r of record.roots) {
    if (!r.verify) continue;
    const against = live ? "" : " against its backend";
    log(`${r.root}: ${r.verify.changes.length === 0 ? `no changes${against}` : `${r.verify.changes.length} changes${against}: ${r.verify.changes.join(", ")}`}`);
  }
}
/** Where a backend move's state is, as a person reads it. */
function fromOf(b: BackendMove): string {
  const c = b.from.config;
  const s = (k: string): string | undefined => (typeof c[k] === "string" ? (c[k] as string) : undefined);
  if (b.from.backend === "file") return `the state file ${String(c.path)}`;
  if (b.from.backend === "remote" || b.from.backend === "cloud") return `its ${b.from.backend} workspace ${typeof c.hostname === "string" ? c.hostname : "app.terraform.io"}/${String(c.organization)}/${String((c.workspaces as { name?: unknown } | undefined)?.name)}`;
  if (PULLED_BACKENDS.includes(b.from.backend)) {
    const a = stateAddress(b.from.backend, (n) => literal(c[n]), "");
    return `its ${b.from.backend} backend${"key" in a ? ` ${a.key}` : ""}`;
  }
  const where = b.from.backend === "s3" && s("bucket") ? ` s3://${s("bucket")}/${s("key")}` : b.from.backend === "gcs" && s("bucket") ? ` gs://${s("bucket")}/${s("prefix") ?? ""}` : b.from.backend === "azurerm" && s("storage_account_name") ? ` az://${s("storage_account_name")}/${s("container_name")}/${s("key")}` : "";
  return `its ${b.from.backend} backend${where}`;
}

/** What a migration does, in one line. */
export function describeChange(m: Migration, live = false): string {
  if (live && m.kind === "backends") return `adopting the state of ${m.backends.map((b) => `${b.root} from ${fromOf(b)}`).join("; ")} into the estate its code names`;
  if (live && m.kind === "moves") return `retagging ${m.moves.map((x) => `${x.addresses.join(", ")} from the estate of ${x.from} to the estate of ${x.to}`).join("; ")}`;
  if (m.kind === "backends") return `moving the state of ${m.backends.map((b) => `${b.root} from ${fromOf(b)}`).join("; ")} to the backend its code names`;
  if (m.kind === "revert") return `putting back the states ${m.revert} wrote: ${m.restores.map((r) => `${r.root} to ${r.version_id ?? "no state"}`).join(", ")}`;
  return `moving ${m.moves.map((x) => `${x.addresses.join(", ")} from ${x.from} to ${x.to}`).join("; ")}`;
}

// ── the reverse ──────────────────────────────────────────────────────────

/**
 * The revert of a migration that applied, from its history line: the
 * terraform lexicon's `revertMigration` (chant#4910) with terragucci's file
 * header. A migration it cannot put back is refused in the lexicon's words.
 */
export function revertFile(name: string, history: string): { name: string; text: string } {
  try {
    const { name: file, text } = revertMigration(name, history, {
      where: `in ${MIGRATE_DONE} or on its gated request in ${MIGRATE_APPLIED}`,
      header: [
        `Puts back the states migration ${name} wrote, to the versions it recorded before it wrote them.`,
        `Written by terragucci migrate revert ${name}. Revert the code of ${name} in the same change, so each root plans with no change.`,
      ],
    });
    return { name: file, text };
  } catch (e) {
    throw planningError(e);
  }
}

/**
 * `terragucci migrate revert <name>`: write `migrations/<name>-revert.yml`
 * from the migration's record on chant/lifecycle as origin holds it. It
 * writes the file and nothing else; the change that carries it is planned,
 * approved and applied like any migration.
 */
export function writeRevert(repo: string, name: string): string {
  readLedger(repo, MIGRATE_LEDGER);
  const { name: file, text } = revertFile(name, migrationHistory(repo));
  const path = join(repo, MIGRATIONS_DIR, `${file}.yml`);
  if (existsSync(path)) throw new ConfigError(`${MIGRATIONS_DIR}/${file}.yml is there already`);
  mkdirSync(join(repo, MIGRATIONS_DIR), { recursive: true });
  writeFileSync(path, text);
  return `${MIGRATIONS_DIR}/${file}.yml`;
}

// ── the gate ─────────────────────────────────────────────────────────────

const at = (iso: string): number => new Date(iso).getTime();

/**
 * The flat facts a migration's `finished` line keeps on chant's gated request
 * (chant#4551, #4618): how it ended, its file's digest, its change, and each
 * root's location and version before and after, which `migrate revert` and
 * the list still to apply read back (finishedMigrationLines). Never a state's
 * contents.
 */
export function migrationDetail(record: MigrationRecord, m: Pick<Migration, "digest" | "kind">): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {
    result: record.status,
    file_digest: m.digest,
    change: m.kind,
    migration_change: record.change,
    roots: record.roots.map((r) => r.root).join(","),
    ...(record.revert ? { revert: record.revert } : {}),
    ...(record.error ? { error: record.error.slice(0, 400) } : {}),
  };
  for (const r of record.roots) {
    if (r.location) out[`${r.root}.location`] = r.location;
    if (r.before.version_id) out[`${r.root}.before`] = r.before.version_id;
    if (r.after.version_id) out[`${r.root}.after`] = r.after.version_id;
    if (r.before.digest) out[`${r.root}.before_digest`] = r.before.digest;
    if (r.after.digest) out[`${r.root}.after_digest`] = r.after.digest;
    // A backend move's state came from another backend: where, and the version it read, as done.jsonl's line keeps them.
    if (r.source?.location) out[`${r.root}.source`] = r.source.location;
    if (r.source?.version_id) out[`${r.root}.source_version`] = r.source.version_id;
  }
  return out;
}

/**
 * A repo's migration history as origin's chant/lifecycle holds it: the
 * terraform lexicon's `migrationHistory` (chant#4910) over the done.jsonl
 * lines written before chant ran the gate and the `finished` lines of
 * chant's gated requests. Fetch first (readLedger); this reads the remote
 * ref as last fetched.
 */
export function migrationHistory(repo: string): string {
  const show = (path: string): string => {
    const r = git(repo, ["show", `${LEDGER_READ_REF}:${path}`]);
    return r.status === 0 ? r.stdout : "";
  };
  return chantMigrationHistory(show, { op: MIGRATE_OP, earlier: MIGRATE_DONE });
}

/** A root a pending estate migration plans for: the migration's name, its file's digest, and whether it adopts the root's state or retags resources into it. */
export interface PendingEstateRoot {
  name: string;
  file_digest: string;
  change: "adopt" | "retag";
}

/** Why a root a pending estate migration plans for is not planned on its own, for the logs and the report. */
export const pendingWhy = (p: PendingEstateRoot): string =>
  p.change === "adopt"
    ? `migration ${p.name} adopts its state into the estate, and live-import's check of every resource is the proof`
    : `migration ${p.name} retags resources into its estate, and live-mv -dry-run of each one is the proof`;

/**
 * The roots a pending choudoufu estate migration plans for, by root: each
 * root a `backends` migration adopts into an estate, and each root a `moves`
 * migration between estates retags resources into. Pending means not
 * recorded applied in `_gates/tf-migrate/done.jsonl` on chant/lifecycle as
 * origin holds it now (fetched here, since a later wave's job has no copy), nor
 * in `applied` (the migrations this job applied). Such a root is not planned
 * on its own: choudoufu refuses a plan while a live object at a resource's
 * identity carries no marker of the root's estate, which is how an adopted
 * root's resources stand before the stamp and a joining root's before the
 * retag. The migration's proof stands for its plan. Once the migration
 * applies, the root plans as any other. A repo whose migrations cannot be
 * read gives none here; the migration step reports why.
 */
export function pendingEstateMigrations(repo: string, applied: ReadonlySet<string> = new Set()): Map<string, PendingEstateRoot> {
  const out = new Map<string, PendingEstateRoot>();
  let migrations: Migration[];
  try {
    migrations = listMigrations(repo).filter((m) => (m.kind === "backends" || m.kind === "moves") && !applied.has(m.name));
  } catch {
    return out;
  }
  if (migrations.length === 0) return out;
  // A wave after the first runs no migration step, and its checkout may hold no copy of chant/lifecycle. Without this fetch
  // every migration read as pending there, and the wave left its roots unplanned. When origin cannot be read, the copy at hand stands.
  try {
    readLedger(repo, MIGRATE_LEDGER);
  } catch {
    // The migration step reports a remote it cannot read.
  }
  const done = doneMigrations(migrationHistory(repo));
  for (const m of migrations) {
    if (done.get(m.name)?.status === "applied") continue;
    let roots: string[];
    if (m.kind === "backends") roots = liveRoots(repo, m.backends.map((b) => b.root));
    else {
      // A moves file is an estate migration only when every root it names is an estate; one that mixes is refused by the migration.
      const all = [...new Set(m.moves.flatMap((x) => [x.from, x.to]))];
      roots = liveRoots(repo, all).length === all.length ? [...new Set(m.moves.map((x) => x.to))] : [];
    }
    for (const root of roots) if (!out.has(root)) out.set(root, { name: m.name, file_digest: m.digest, change: m.kind === "backends" ? "adopt" : "retag" });
  }
  return out;
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
  /** How a Terragrunt unit is prepared (MigrateOptions.terragrunt). */
  terragrunt?: MigrateOptions["terragrunt"];
  /** Read only: prove each pending migration and print its digest, as a pull request's plan job does. */
  planOnly?: boolean;
  /** Prove the first pending migration and go no further: wave 1's `migrations` hook, which fails the wave when one cannot be proved. */
  prove?: boolean;
  /** Under `chant run wave`: chant settles the migration's gate (MigrationHold). */
  hold?: MigrationHold;
  log?: (line: string) => void;
  /** Each estate root's roster after an estate migration writes (MigrateOptions.roster). */
  roster?: MigrateOptions["roster"];
  /** Where an estate migration's per-resource progress goes beyond `terragucci-report/`, given the migration's name (./migrate-progress.ts). */
  progress?: (name: string) => ProgressSinks;
}

/**
 * How wave 1's `migration gate` hook holds the wave on a migration's own
 * gate under `chant run wave`. Without `approved`, the run writes `file`
 * (chant's `CHANT_HOLD`: the op, the gate, the digest and the pending fact's
 * fields) and stops at the first migration not yet applied; chant records the
 * pending fact, or finds the approval and runs the hook again with
 * `approved` (`CHANT_HOLD_APPROVED`), and the migration then writes the
 * states under that approval.
 */
export interface MigrationHold {
  file: string;
  approved?: { op: string; gate: string; digest: string; approvedBy: string; approvedAt: string };
  /**
   * chant's `CHANT_HOLD_FINISHED` (chant#4623), set on the approved re-run
   * once chant wrote the gate's applied line. The migration writes how it
   * ended there, and chant writes the finished line from it; this run writes
   * no ledger line of its own.
   */
  finished?: string;
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
  // A pull request's plan refuses migrations its pipeline could not run, so none is merged to wait where nothing can record it.
  if (options.planOnly) {
    const problems = migrationPipelineProblems(repo);
    for (const p of problems) log(`migrations: ${p}`);
    if (problems.length > 0) return { code: EXIT.failed, records: [] };
  }
  let done = new Map<string, { status: string; file_digest?: string; timestamp: string }>();
  try {
    // The fetch of chant/lifecycle that migrationHistory reads.
    readLedger(repo, MIGRATE_LEDGER);
    done = doneMigrations(migrationHistory(repo));
  } catch (e) {
    if (!options.planOnly) {
      log(`migrations: ${(e as Error).message}`);
      return { code: EXIT.failed, records: [] };
    }
  }
  const records: MigrationRecord[] = [];
  const pending = migrations.filter((m) => done.get(m.name)?.status !== "applied");
  // One apply job per identity: wave 1's deciding job holds the plan roles alone, so a migration cannot run there. Refused before merge.
  const grouped = options.planOnly && pending.length > 0 ? groupedPipeline(repo) : undefined;
  if (grouped) {
    log(`migrations: ${groupedMigrationProblem(pending.map((m) => m.file), grouped)}`);
    return { code: EXIT.failed, records: [] };
  }
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
      const out = await runOne(repo, m, { ...options, env, log }, work);
      records.push(out.record);
      writeRecord(repo, out.record);
      if (out.code !== EXIT.applied) return { code: out.code, records, ...(out.command ? { command: out.command } : {}) };
      // A later migration plans against the states this one writes, so a read-only run proves the first alone.
      if (options.planOnly || options.prove) {
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

/**
 * A standalone migration as chant's gated migration (chant core's
 * `runStateMigration`, chant issue 4806): the request carries the plan of
 * every root as its attachment, so its digest binds each state before and
 * after; the approval is spent on `_gates/tf-migrate/applied.jsonl` before
 * anything is written; and the `finished` line holds what `migrate revert`
 * and the list of migrations still to apply read (migrationDetail,
 * migrationHistory). A waiting request that an earlier approval of the
 * migration no longer fits answers `approval-moved`, naming the roots whose
 * state moved. A migration inside a wave (`hold`) stays on the wave's hold
 * hook, which chant decides already, and chant writes that gate's applied
 * and finished lines too (chant#4623).
 */
async function runGated(
  repo: string,
  m: Migration,
  plan: PlannedMigration,
  o: RunMigrationsOptions & { env: NodeJS.ProcessEnv; log: (l: string) => void; now: string; rule: Awaited<ReturnType<typeof approvalRule>>; label: string; commit: string; runId: string | undefined; sinks: ProgressSinks | undefined },
): Promise<{ code: number; record: MigrationRecord; command?: string }> {
  const { log, env, label } = o;
  const record = plan.record;
  const by = actorOf({ env, repo });
  const sealed = o.rule.mode === "sealed";
  // The plan is the request's attachment, which chant writes to the local branch before it fetches.
  syncLocalLedger(repo);
  const outcome = await runStateMigration({
    name: m.name,
    by,
    roots: plan.roots,
    engine: plan.engine,
    words: { op: MIGRATE_OP, approveCommand: (name, digest) => migrateApproveCommand(name, digest, sealed) },
    fields: { file: m.file, file_digest: m.digest, change: m.kind },
    detail: (r) => migrationDetail(writtenRecord(plan, r), m),
    rules: requestRules(o.rule),
    // chant's attachment binds each root's plan; what the migration does is said here, which `terragucci approve` shows.
    description: `${label}: ${describeChange(m, !!plan.estate)}`,
    expiry: "48h",
    ...(o.rule.base ? { base: o.rule.base } : {}),
    cwd: repo,
    now: o.now,
    ...(o.runId ? { runId: o.runId } : {}),
    ...(o.commit ? { commit: o.commit } : {}),
  });
  const waiting = (digest: string, command: string): void => {
    log(`${label} waits for an approval of digest ${digest} by someone other than ${by}. Read the proof above, then approve it with:`);
    log(`  ${command}`);
    log("Then run this job again.");
  };
  switch (outcome.status) {
    case "proof-failed":
      return { code: EXIT.failed, record: { ...record, status: "proof-failed" } };
    case "applied":
    case "moved":
    case "failed": {
      if (!("result" in outcome) || !outcome.result) {
        log(`${label}: ${outcome.status === "failed" ? outcome.error : "the migration failed"}`);
        o.sinks?.end?.("failed", undefined, outcome.status === "failed" ? outcome.error : undefined);
        return { code: EXIT.failed, record: { ...record, digest: outcome.digest, status: "failed", ...(outcome.status === "failed" ? { error: outcome.error } : {}) } };
      }
      // The record names the request digest the approval named, as a waiting one does.
      const approvedBy = outcome.status === "failed" ? undefined : outcome.approvedBy;
      const applied: MigrationRecord = { ...writtenRecord(plan, outcome.result), digest: outcome.digest, ...(approvedBy ? { approved_by: approvedBy } : {}), finished: new Date().toISOString(), ...(o.commit ? { commit: o.commit } : {}) };
      o.sinks?.end?.(applied.status, applied.progress, applied.error);
      if (approvedBy) log(`${label}: approved by ${approvedBy} for this digest`);
      return ended(applied, plan, label, log, `; recorded in _gates/${MIGRATE_OP}/applied.jsonl on chant/lifecycle`);
    }
    case "spent":
      log(`${label}: request ${outcome.digest} applied already; a migration applies once`);
      return { code: EXIT.applied, record: { ...record, digest: outcome.digest } };
    case "approval-moved":
      log(`${label}: ${outcome.approvedBy} approved ${outcome.approved}, and the states moved since: ${outcome.moved.join(", ") || "the migration file"}; nothing was written`);
      log(`${label}: read the proof above, then approve this plan with:`);
      log(`  ${outcome.command}`);
      return { code: EXIT.refused, record: { ...record, digest: outcome.digest, status: "refused", moved: outcome.moved }, command: outcome.command };
    case "refused":
      log(`${label}: an approval does not count: ${outcome.reason}`);
      waiting(outcome.digest, outcome.command);
      return { code: EXIT.waiting, record: { ...record, digest: outcome.digest, status: "waiting" }, command: outcome.command };
    case "waiting":
      waiting(outcome.digest, outcome.command);
      // On chant's gate the approval binds chant's request digest, so the record names that one.
      return { code: EXIT.waiting, record: { ...record, digest: outcome.digest, status: "waiting" }, command: outcome.command };
  }
}

/** How a written migration ended, as the log says it and the job exits. */
function ended(result: MigrationRecord, plan: PlannedMigration, label: string, log: (l: string) => void, recorded = ""): { code: number; record: MigrationRecord } {
  if (result.status === "refused") {
    log(`${label}: under the lock, the state of ${(result.moved ?? []).join(", ")} is not the one planned; nothing was written. Run this job again to plan from the states as they are`);
    return { code: EXIT.refused, record: result };
  }
  logVerified(result, !!plan.estate, log);
  // The finished line is the migration's history (migrationHistory): `migrate revert` and the list still to apply read it there.
  if (!plan.estate) for (const r of result.roots) log(`${r.root}: version ${r.before.version_id ?? "none"} before, ${r.after.version_id ?? "none"} after`);
  if (result.status !== "applied") {
    log(`${label}: ${result.error}; ${plan.estate ? `the markers were written, and terragucci-report/migrations/${result.name}.json names each resource and its live id` : `the states were written, and each root's version before is in terragucci-report/migrations/${result.name}.json`}`);
    return { code: EXIT.failed, record: result };
  }
  log(`${label} applied${recorded}`);
  return { code: EXIT.applied, record: result };
}

/** What a migration under chant's recorded hold writes to `CHANT_HOLD_FINISHED` (chant#4623): how it ended and the finished line's detail. */
function writeHoldFinished(file: string, result: "applied" | "failed", detail: Record<string, string | number | boolean>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ result, detail }) + "\n");
}

async function runOne(repo: string, m: Migration, options: RunMigrationsOptions & { env: NodeJS.ProcessEnv; log: (l: string) => void }, work: string): Promise<{ code: number; record: MigrationRecord; command?: string }> {
  const { log, env } = options;
  const label = `migration ${m.name}`;
  const live = liveRoots(repo, m.kind === "backends" ? m.backends.map((b) => b.root) : m.moves.flatMap((x) => [x.from, x.to])).length > 0;
  log(`${label}: ${describeChange(m, live)}`);
  const sinks = live ? options.progress?.(m.name) : undefined;
  let plan: PlannedMigration;
  try {
    plan = await planMigration(repo, m, { binary: options.binary, env, work, log, ...(options.exec ? { exec: options.exec } : {}), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.terragrunt ? { terragrunt: options.terragrunt } : {}), ...(options.roster ? { roster: options.roster } : {}), ...(sinks ? { progress: sinks } : {}), ...(options.now ? { now: options.now } : {}) });
  } catch (e) {
    log(`${label}: ${(e as Error).message}`);
    log(`${label}: nothing was written`);
    return { code: EXIT.failed, record: { schema: MIGRATION_SCHEMA, name: m.name, file: m.file, file_digest: m.digest, change: m.kind, moves: m.moves, roots: [], digest: "", status: "failed", error: (e as Error).message } };
  }
  const record = plan.record;
  for (const r of record.roots) log(`${r.root}: state ${r.location ?? r.backend ?? "at its backend"}${r.before.version_id ? ` version ${r.before.version_id}` : ""}, ${r.before.digest ? `digest ${r.before.digest}` : "no state yet"}`);
  const proved = record.change === "retag" ? "live-mv -dry-run finds each resource that moves, and every change a root it leaves plans is one the retag removes" : record.change === "adopt" ? "every resource instance of the state verifies against the live system, so the stamp adopts each one, and the root plans once it is stamped" : "every root plans with no change against its new state";
  if (record.status === "proof-failed") {
    const failing = record.roots.filter((r) => r.proof.changes.length > 0).map((r) => r.root).join(", ");
    log(`${label}: ${record.change === "adopt" ? `every resource instance of the state must verify against the live system, and in ${failing} some do not` : record.change === "retag" ? `${proved}, and ${failing} would still change` : `every root must plan with no change against its new state, and ${failing} would change`}; nothing was written`);
    return { code: EXIT.failed, record };
  }
  log(`${label}: ${proved}; digest ${record.digest}`);
  if (options.planOnly || options.prove) return { code: EXIT.applied, record };

  const now = options.now ?? new Date().toISOString();
  const configPath = options.config ?? findConfig(repo);
  const rule = await approvalRule(repo, { ...(options.base ? { at: options.base } : {}), ...(configPath ? { config: configPath } : {}), ...(options.approval ? { flag: options.approval } : {}) });
  const sealed = rule.mode === "sealed";
  const command = migrateApproveCommand(m.name, record.digest, sealed);
  const runId = env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID;
  const commit = jobCommit(env, repo);
  if (!options.hold) {
    // chant's gated migration: the request, the spend before the write, and the finished line.
    return runGated(repo, m, plan, { ...options, now, rule, label, commit, runId, sinks });
  }
  // chant settles the gate (chant#4623): hold the wave on it, with the proof as the request's attachment, or write
  // the states under the approval chant found and say how it ended in the finished file chant records.
  const a = options.hold.approved;
  if (!a || a.op !== MIGRATE_OP || a.gate !== m.name || !samePlanDigest(a.digest, record.digest)) {
    const description = `${label}: ${record.roots.map((r) => r.root).join(", ")}`;
    const proof = JSON.stringify(record, null, 2) + "\n";
    mkdirSync(dirname(options.hold.file), { recursive: true });
    writeFileSync(options.hold.file, JSON.stringify({ op: MIGRATE_OP, gate: m.name, digest: record.digest, description, pending: { ...(commit ? { commit } : {}), members: beforeMembers(record.roots) }, record: true, attachment: proof }) + "\n");
    log(`${label} waits for an approval of digest ${record.digest}. Read the proof above, then approve it with:`);
    log(`  ${command}`);
    log("Then run this job again.");
    return { code: EXIT.waiting, record: { ...record, status: "waiting" }, command };
  }
  log(`${label}: approved by ${a.approvedBy} for this digest`);
  const finishedFile = options.hold.finished;
  let result: MigrationRecord;
  try {
    // The wave's gate decided the approval: chant's write under the locks, with no request of its own.
    result = writtenRecord(plan, await writeStateMigration(plan.engine, plan.roots));
  } catch (e) {
    log(`${label}: ${(e as Error).message}`);
    sinks?.end?.("failed", undefined, (e as Error).message);
    // No `result` in the detail: the migration threw, and its history skips the line (finishedMigrationLines).
    if (finishedFile) writeHoldFinished(finishedFile, "failed", { approved_by: a.approvedBy, error: (e as Error).message.slice(0, 400) });
    return { code: EXIT.failed, record: { ...record, status: "failed", error: (e as Error).message } };
  }
  sinks?.end?.(result.status, result.progress, result.error);
  result = { ...result, approved_by: a.approvedBy, finished: new Date().toISOString(), ...(commit ? { commit } : {}) };
  if (finishedFile) writeHoldFinished(finishedFile, result.status === "applied" ? "applied" : "failed", { approved_by: a.approvedBy, ...migrationDetail(result, m) });
  return ended(result, plan, label, log);
}
