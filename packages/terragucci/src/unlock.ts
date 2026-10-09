/**
 * `terragucci unlock-state <root>`: release the backend's state lock that a
 * job killed mid-apply left behind, behind a gate and on the record.
 *
 * A runner that kills a job never lets the binary release its lock, and the
 * next plan of that state then waits for it until its lock timeout. The
 * usual fix is a `force-unlock` by hand, with nothing recorded and nothing
 * checking that the job is really gone. This command does that instead:
 *
 *   1. It inits the root and reads the lock: the lock file the S3 backend's
 *      `use_lockfile` takes, `<key>.tflock`, with its ID, who took it and when.
 *   2. It asks the forge which of the repository's runs are still running or
 *      waiting. A run that began before the lock was taken may be the one
 *      holding it, so while any such run is alive the lock is not released.
 *   3. The lock waits at a gate of its own, `tf-unlock <root>`, on
 *      chant/lifecycle, bound to a digest of the root, the lock's location and
 *      its ID: `chant approve tf-unlock <root> --plan <digest>` approves that
 *      lock and no other. Under `approval: sealed` only a sealed approval counts.
 *   4. Approved, it checks again that no such run is alive, releases the lock
 *      with the binary's `force-unlock` of that ID, and records who released
 *      which lock, under whose approval, in `_gates/tf-unlock/done.jsonl`,
 *      which `terragucci audit` reads.
 *
 * A comment never runs it (comment.ts refuses `unlock-state`): a person runs
 * it at a shell, with the forge token in the variable `token_env` names.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { computePlanDigest, samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { appendLifecycle, appendPending, decideGate, readLedger, type GateLedger, type PendingRecord } from "./apply";
import { approvalRule } from "./approval";
import { binaryEnv } from "./binary-env";
import { stateClient, stateObject, type StateObject } from "./backend";
import { ConfigError, findConfig, loadConfig, resolveRepo, type ResolvedSettings } from "./config";
import { detectBinary } from "./detect";
import { call, DEFAULT_TOKEN_ENV, type Fetch, type ForgeTarget } from "./forge";
import { lockKey } from "./migrate";
import type { S3Fetch, S3Target } from "./report/s3";
import { forgeOf } from "./respond/change";
import { sealRefusal } from "./seal";

export const UNLOCK_OP = "tf-unlock";
export const UNLOCK_LEDGER = `_gates/${UNLOCK_OP}.jsonl`;
/** Beside the ledger, out of chant's sight: one line per lock released. */
export const UNLOCK_DONE = `_gates/${UNLOCK_OP}/done.jsonl`;

/** Exit codes, as the waves give them. */
export const UNLOCK_EXIT = { released: 0, refused: 1, waiting: 3, other: 4 } as const;

/** How far a run's start may be after the lock's and still count as a run that could hold it: the clocks of the job and the forge differ. */
export const CLOCK_SKEW_MS = 2 * 60 * 1000;

/** The lock info the binary writes, and prints when it finds a lock held. */
export interface LockInfo {
  ID: string;
  Operation?: string;
  Info?: string;
  Who?: string;
  Version?: string;
  Created?: string;
  Path?: string;
}

/** A lock file's text, or undefined when it holds no lock ID. */
export function parseLockInfo(text: string): LockInfo | undefined {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (!v || typeof v !== "object" || typeof v.ID !== "string" || v.ID === "") return undefined;
    const s = (k: string): string | undefined => (typeof v[k] === "string" ? (v[k] as string) : undefined);
    return { ID: v.ID, Operation: s("Operation"), Info: s("Info"), Who: s("Who"), Version: s("Version"), Created: s("Created"), Path: s("Path") };
  } catch {
    return undefined;
  }
}

/** The digest an approval of this lock binds: the root, where the lock is and its ID. */
export const lockDigest = (root: string, location: string, id: string): string => computePlanDigest("terragucci-state-lock", { root, location, id });

/** The command that approves releasing a lock. */
export const unlockApproveCommand = (root: string, digest: string, sealed = false): string => `chant approve ${UNLOCK_OP} ${root} --plan ${digest}${sealed ? " --sign" : ""}`;

/** A run or pipeline of the repository that has not finished. */
export interface LiveRun {
  id: string;
  status: string;
  /** When it began, or was created when the forge gives no start. */
  started?: string;
  url?: string;
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The repository's runs that have not finished: Forgejo's and GitHub's
 * Actions runs, GitLab's pipelines, read with the token.
 */
export async function liveRuns(fetchFn: Fetch, t: ForgeTarget): Promise<LiveRun[]> {
  const out = new Map<string, LiveRun>();
  if (t.forge === "gitlab") {
    for (const status of ["running", "pending", "preparing", "waiting_for_resource"]) {
      const rows = (await call(fetchFn, t, "GET", `/projects/${encodeURIComponent(t.path)}/pipelines?status=${status}&per_page=100`)) as Array<Record<string, unknown>>;
      for (const p of Array.isArray(rows) ? rows : []) {
        out.set(String(p.id), { id: String(p.id), status: String(p.status ?? status), started: (p.started_at ?? p.created_at) as string | undefined, url: p.web_url as string | undefined });
      }
    }
    return [...out.values()];
  }
  const statuses = t.forge === "github" ? ["in_progress", "queued", "waiting", "pending", "requested"] : ["running", "waiting", "blocked"];
  const limit = t.forge === "github" ? "per_page=100" : "limit=50";
  for (const status of statuses) {
    const body = (await call(fetchFn, t, "GET", `/repos/${t.path}/actions/runs?status=${status}&${limit}`)) as { workflow_runs?: Array<Record<string, unknown>> };
    for (const r of body.workflow_runs ?? []) {
      const started = (t.forge === "github" ? (r.run_started_at ?? r.created_at) : (r.started ?? r.created)) as string | undefined;
      // Forgejo leaves `started` at the epoch until a job starts.
      const begun = started && time(started) > 0 ? started : ((r.created ?? r.created_at) as string | undefined);
      out.set(String(r.id), { id: String(r.id), status: String(r.status ?? status), started: begun, url: r.html_url as string | undefined });
    }
  }
  return [...out.values()];
}

/**
 * The live runs that may hold a lock taken at `created`: those that began
 * before it, give or take the clocks' skew. A lock with no time it was taken,
 * or a run with no start, keeps every run in.
 */
export function possibleHolders(runs: readonly LiveRun[], created: string | undefined, skewMs = CLOCK_SKEW_MS): LiveRun[] {
  const taken = time(created);
  return runs.filter((r) => Number.isNaN(taken) || Number.isNaN(time(r.started)) || time(r.started) <= taken + skewMs);
}

export interface UnlockOptions {
  config?: string;
  binary?: string;
  /** Who releases it, as the record names them. Default the git user, else the login. */
  actor?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
  /** The forge's HTTP calls, for tests. */
  fetch?: Fetch;
  /** The S3 calls, for tests. */
  s3Fetch?: S3Fetch;
  /** Runs the binary in the root, for tests. */
  exec?: (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv) => { status: number; out: string };
  log?: (line: string) => void;
}

export interface UnlockResult {
  code: number;
  lock?: LockInfo;
  location?: string;
  digest?: string;
  /** The runs that kept the lock held. */
  alive?: LiveRun[];
  command?: string;
}

/** One line of `_gates/tf-unlock/done.jsonl`. */
export interface UnlockRecord {
  version: 1;
  kind: "unlock";
  op: typeof UNLOCK_OP;
  gate: string;
  root: string;
  location: string;
  lock: LockInfo;
  planDigest: string;
  approvedBy: string;
  approvedAt: string;
  releasedBy: string;
  timestamp: string;
  /** How many of the repository's runs were alive when it was released, none of which began before the lock. */
  liveRuns: number;
  commit?: string;
}

const runBinary = (binary: string, args: string[], dir: string, env: NodeJS.ProcessEnv): { status: number; out: string } => {
  const p = spawnSync(binary, [`-chdir=${dir}`, ...args], { encoding: "utf-8", env: binaryEnv(env), maxBuffer: 1 << 26 });
  return { status: p.status ?? 1, out: `${p.stdout ?? ""}${p.stderr ?? ""}${p.error ? p.error.message : ""}` };
};

const tail = (s: string): string => s.trim().split("\n").slice(-10).join("\n");

function gitOut(repo: string, args: string[]): string {
  const p = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  return p.status === 0 ? p.stdout.trim() : "";
}

const describeLock = (l: LockInfo): string => `lock ${l.ID}${l.Operation ? `, ${l.Operation}` : ""}${l.Who ? ` by ${l.Who}` : ""}${l.Created ? ` at ${l.Created}` : ""}`;

const describeRun = (r: LiveRun): string => `run ${r.id} (${r.status}${r.started ? `, began ${r.started}` : ""})${r.url ? ` ${r.url}` : ""}`;

/** The S3 state a root's lock file guards, or why this command cannot read its lock. */
function lockedObject(root: string, o: StateObject): Extract<StateObject, { target: S3Target }> {
  if ("unsupported" in o) throw new ConfigError(`${root}: ${o.unsupported}; unlock-state reads the lock file of an s3 backend`);
  if (o.backend === "local") throw new ConfigError(`${root} keeps its state in a local file, whose lock goes with the process that took it; unlock-state releases the lock file of an s3 backend`);
  const s3 = o as Extract<StateObject, { target: S3Target }>;
  if (!s3.lockfile) throw new ConfigError(`${root}: its s3 backend takes no lock file (use_lockfile = true)${s3.dynamodb ? ", only a DynamoDB lock," : ""} and unlock-state releases the lock file`);
  return s3;
}

/**
 * Release a root's state lock that no live run can hold, once an approval
 * of that lock stands. Throws ConfigError for what a person must fix first
 * (no root, no backend it can read, no forge token).
 */
export async function unlockState(repo: string, root: string, options: UnlockOptions = {}): Promise<UnlockResult> {
  const log = options.log ?? ((l: string) => console.log(l));
  const env = options.env ?? process.env;
  const exec = options.exec ?? runBinary;
  const rel = root.replace(/\/+$/, "");
  const dir = resolve(repo, rel);
  if (!rel || rel.split("/").includes("..") || !existsSync(dir) || !statSync(dir).isDirectory()) throw new ConfigError(`${root} is not a root of this repository`);
  const configPath = options.config ?? findConfig(repo);
  const config = configPath ? await loadConfig(resolve(configPath)) : {};
  if (config.projects) throw new ConfigError("unlock-state runs in a project's own checkout, not a control repo");
  const settings: ResolvedSettings = resolveRepo(config);
  const binary = options.binary ?? settings.binary ?? detectBinary(repo, [rel]).value;

  const init = exec(binary, ["init", "-input=false", "-no-color"], dir, env);
  if (init.status !== 0) throw new ConfigError(`${rel}: ${binary} init failed:\n${tail(init.out)}`);
  const object = lockedObject(rel, stateObject(dir, env));
  const location = `s3://${object.bucket}/${lockKey(object.key)}`;
  const client = stateClient(object, options.s3Fetch);
  const text = await client.get(lockKey(object.key));
  if (text === undefined) {
    log(`${rel}: no lock is held on ${location}; nothing to release`);
    return { code: UNLOCK_EXIT.released, location };
  }
  const lock = parseLockInfo(text);
  if (!lock) throw new ConfigError(`${rel}: ${location} holds no lock ID the binary wrote; read it, and remove it by hand if it is not a lock`);
  const digest = lockDigest(rel, location, lock.ID);
  log(`${rel}: ${location} holds ${describeLock(lock)}`);

  // Fails closed: a forge that cannot be asked cannot say the holder is gone.
  const target = forgeOf(repo, settings, env);
  const tokenEnv = settings.token_env ?? DEFAULT_TOKEN_ENV[target.forge];
  if (!target.token) throw new ConfigError(`${tokenEnv} is not set; unlock-state reads the forge's runs with it, to know no run holding the lock is alive`);
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  let live = 0;
  const holders = async (): Promise<LiveRun[]> => {
    let runs: LiveRun[];
    try {
      runs = await liveRuns(fetchFn, target);
    } catch (e) {
      throw new ConfigError(`${rel}: the forge's runs could not be read (${(e as Error).message}), so nothing says the run holding the lock is gone`);
    }
    live = runs.length;
    return possibleHolders(runs, lock.Created);
  };
  const alive = await holders();
  if (alive.length > 0) {
    log(`${rel}: ${alive.length === 1 ? "a run that began before the lock is" : `${alive.length} runs that began before the lock are`} still alive, so the lock may be theirs and is not released:`);
    for (const r of alive) log(`  ${describeRun(r)}`);
    log("Run this again once they have finished, or stop them on the forge first.");
    return { code: UNLOCK_EXIT.refused, lock, location, digest, alive };
  }
  log(`${rel}: no run that began before the lock is alive`);

  const now = options.now ?? new Date().toISOString();
  const rule = await approvalRule(repo, { at: "HEAD", ...(configPath ? { config: configPath } : {}) });
  const sealed = rule.mode === "sealed";
  let ledger: GateLedger = readLedger(repo, UNLOCK_LEDGER);
  if (sealed) {
    ledger = {
      ...ledger,
      resolutions: ledger.resolutions.filter((r) => {
        if (r.gate !== rel) return true;
        const why = sealRefusal(rule.signers, rule.signersPath, r);
        if (why !== null && samePlanDigest(r.planDigest, digest)) log(`${rel}: an approval does not count: ${why}`);
        return why === null;
      }),
    };
  }
  const decision = decideGate(ledger, rel, digest, now);
  const command = unlockApproveCommand(rel, digest, sealed);
  const commit = gitOut(repo, ["rev-parse", "HEAD"]);
  if (decision.status !== "approved") {
    if (!decision.standing) {
      const pending: PendingRecord = {
        version: 1,
        kind: "pending",
        op: UNLOCK_OP,
        gate: rel,
        timestamp: now,
        expiresAt: new Date(time(now) + 48 * 3600 * 1000).toISOString(),
        planDigest: digest,
        description: `release ${describeLock(lock)} on ${location}`,
        ...(commit ? { commit } : {}),
        neverOverMcp: true,
      };
      appendPending(repo, pending, {}, UNLOCK_LEDGER);
    }
    if (decision.status === "refused") {
      log(`${rel}: ${decision.by} approved ${decision.approved ?? "another digest"}, the release of another lock; this one is not released`);
      log(`${rel}: to release ${describeLock(lock)}, approve it with:`);
      log(`  ${command}`);
      return { code: UNLOCK_EXIT.other, lock, location, digest, command };
    }
    log(`${rel}: releasing ${describeLock(lock)} waits for an approval of digest ${digest}. Approve it with:`);
    log(`  ${command}`);
    log("Then run this again.");
    return { code: UNLOCK_EXIT.waiting, lock, location, digest, command };
  }
  log(`${rel}: approved by ${decision.by} for this lock`);

  // The approval may be hours old: ask again just before the release.
  const still = await holders();
  if (still.length > 0) {
    log(`${rel}: a run that began before the lock is alive again, so the lock is not released:`);
    for (const r of still) log(`  ${describeRun(r)}`);
    return { code: UNLOCK_EXIT.refused, lock, location, digest, alive: still };
  }
  const unlock = exec(binary, ["force-unlock", "-force", "-no-color", lock.ID], dir, env);
  if (unlock.status !== 0) throw new ConfigError(`${rel}: ${binary} force-unlock ${lock.ID} failed:\n${tail(unlock.out)}`);
  if ((await client.head(lockKey(object.key))).exists) throw new ConfigError(`${rel}: ${binary} force-unlock ran, and ${location} is still there`);
  const actor = options.actor || gitOut(repo, ["config", "user.name"]) || env.USER || env.USERNAME || "unknown";
  const record: UnlockRecord = {
    version: 1,
    kind: "unlock",
    op: UNLOCK_OP,
    gate: rel,
    root: rel,
    location,
    lock,
    planDigest: digest,
    approvedBy: decision.by,
    approvedAt: decision.at,
    releasedBy: actor,
    timestamp: new Date().toISOString(),
    liveRuns: live,
    ...(commit ? { commit } : {}),
  };
  appendLifecycle(repo, UNLOCK_DONE, [JSON.stringify(record)], {}, `Released the state lock of ${rel}: ${lock.ID}`);
  log(`${rel}: released ${describeLock(lock)}, approved by ${decision.by}; recorded in ${UNLOCK_DONE} on chant/lifecycle`);
  return { code: UNLOCK_EXIT.released, lock, location, digest };
}

/** The locks released, from a done.jsonl text. Malformed lines are skipped. */
export function parseUnlocks(text: string): UnlockRecord[] {
  const out: UnlockRecord[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as UnlockRecord;
      if (r.version === 1 && r.kind === "unlock" && typeof r.gate === "string") out.push(r);
    } catch {
      continue;
    }
  }
  return out;
}

