/**
 * `terragucci unlock-state <root>`: release the backend's state lock that a
 * job killed mid-apply left behind, behind a gate and on the record.
 *
 * A runner that kills a job never lets the binary release its lock, and the
 * next plan of that state then waits for it until its lock timeout. The
 * usual fix is a `force-unlock` by hand, with nothing recorded and nothing
 * checking that the job is really gone. This command does that instead,
 * through chant's lock release (chant#4804): the terraform lexicon's
 * `terraformStateUnlock` reads the lock (the s3 lock file `use_lockfile`
 * takes, the gcs lock object, the azurerm lease, the lock of a
 * GitLab-managed state) and releases it with the binary's fixed
 * `force-unlock` of its ID, or on GitLab a release of that ID on the unlock
 * address. Core's `releaseStateLock` asks the forge which of the
 * repository's runs are alive (`forgeTargetLiveRuns`): while one that began before
 * the lock is, nothing is asked or released. Otherwise the release waits at
 * gate `<root>` of op `tf-unlock` for an approval of that lock by someone
 * other than the requester, checks the runs again just before the spend, and
 * records who released which lock in the request's `finished` line.
 *
 * terragucci prepares the root (its init, a workspace a root names), reads
 * its approval rules and the forge token `token_env` names, keeps
 * choudoufu's live resource markers, which take no lock, and words the
 * command and the messages. A comment never runs it (comment.ts refuses
 * `unlock-state`): a person runs it at a shell. The `done.jsonl` lines older
 * releases wrote stay readable by `terragucci audit`; nothing writes them now.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describeLock, describeRun, forgeTargetLiveRuns, type LiveRun, type LockInfo } from "@intentius/chant/state-unlock";
import { terraformStateUnlock } from "@intentius/chant-lexicon-terraform/state-ops";
import type { StoreFetch } from "@intentius/chant/object-store";
import { approvalRule } from "./approval";
import { binaryEnv } from "./binary-env";
import { ConfigError, findConfig, loadConfig, resolveRepo, type ResolvedSettings } from "./config";
import { liveRoots } from "@intentius/chant-lexicon-terraform/live-roots";
import { detectShape } from "./shape";
import { DEFAULT_TOKEN_ENV, type Fetch } from "./forge";
import { forgeOf } from "./respond/change";
import { asyncExec, opMessage, requestRules } from "./gated-request";

export type { LockInfo };

export const UNLOCK_OP = "tf-unlock";
export const UNLOCK_LEDGER = `_gates/${UNLOCK_OP}.jsonl`;
/** Beside the ledger: the line older releases wrote for each lock released, which `terragucci audit` still reads. */
export const UNLOCK_DONE = `_gates/${UNLOCK_OP}/done.jsonl`;

/** The command that approves releasing a lock. */
export const unlockApproveCommand = (root: string, digest: string, sealed = false): string => `terragucci approve unlock ${root} --plan ${digest}${sealed ? " --sign" : ""}`;

export interface UnlockOptions {
  config?: string;
  binary?: string;
  /** Who releases it, as the record names them. Default the git user, else the login. */
  actor?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
  /** The forge's HTTP calls, for tests. */
  fetch?: Fetch;
  /** The backend's calls (S3, GCS, Azure Blob Storage, or GitLab's state API), for tests. */
  s3Fetch?: StoreFetch;
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
  /** The root is under choudoufu's live resource markers, which take no state lock. */
  live?: boolean;
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
  const shape = detectShape(repo, settings);
  const binary = options.binary ?? settings.binary ?? shape.binary([rel]).value;
  // Under choudoufu's live resource markers there is no state file and so no
  // state lock: each resource is a record written on a condition, and a
  // killed apply leaves nothing held. The binary is never run.
  if (binary === "choudoufu" && liveRoots(repo, [rel]).length > 0) {
    log(`${rel}: choudoufu keeps its resources under live resource markers, with no state file and no state lock; nothing to release`);
    return { code: 0, live: true };
  }

  // A root that names its workspace (an Atmos instance) inits in default and keeps its state, and its lock, under its own.
  const init = exec(binary, ["init", "-input=false", "-no-color"], dir, shape.rootInit(rel, env)?.init ?? env);
  if (init.status !== 0) throw new ConfigError(`${rel}: ${binary} init failed:\n${tail(init.out)}`);

  // Fails closed: a forge that cannot be asked cannot say the holder is gone. Read only once a lock is held.
  const liveRuns = async () => {
    const target = forgeOf(repo, settings, env);
    const tokenEnv = settings.token_env ?? DEFAULT_TOKEN_ENV[target.kind];
    if (!target.token) throw new ConfigError(`${tokenEnv} is not set; unlock-state reads the forge's runs with it, to know no run holding the lock is alive`);
    return forgeTargetLiveRuns(target, fetchFn as never);
  };
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  const now = options.now ?? new Date().toISOString();
  const rule = await approvalRule(repo, { at: "HEAD", ...(configPath ? { config: configPath } : {}) });
  const sealed = rule.mode === "sealed";
  const actor = options.actor || gitOut(repo, ["config", "user.name"]) || env.USER || env.USERNAME || "unknown";
  const commit = gitOut(repo, ["rev-parse", "HEAD"]);
  let result: Awaited<ReturnType<typeof terraformStateUnlock>>;
  try {
    result = await terraformStateUnlock({
      root: rel,
      binary,
      dir,
      env: shape.rootEnv(rel, env),
      exec: asyncExec(exec),
      init: false,
      ...(options.s3Fetch ? { fetch: options.s3Fetch } : {}),
      by: actor,
      liveRuns,
      words: { op: UNLOCK_OP, approveCommand: (subject: string, digest: string) => unlockApproveCommand(subject, digest, sealed) },
      rules: requestRules(rule),
      cwd: repo,
      ...(rule.base ? { base: rule.base } : {}),
      now,
      ...(commit ? { commit } : {}),
    });
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${rel}: ${opMessage(e)}`);
  }
  const location = result.location;
  switch (result.status) {
    case "free":
      log(`${rel}: no lock is held on ${location}; nothing to release`);
      return { code: result.exit, location };
    case "alive":
      log(`${rel}: ${location} holds ${describeLock(result.lock)}`);
      log(`${rel}: ${result.alive.length === 1 ? "a run that began before the lock is" : `${result.alive.length} runs that began before the lock are`} still alive, so the lock may be theirs and is not released:`);
      for (const r of result.alive) log(`  ${describeRun(r)}`);
      log("Run this again once they have finished, or stop them on the forge first.");
      return { code: result.exit, lock: result.lock, location, alive: result.alive };
    case "released":
      log(`${rel}: released ${describeLock(result.lock)}, approved by ${result.approvedBy}; recorded in _gates/${UNLOCK_OP}/applied.jsonl on chant/lifecycle${result.recorded ? "" : " (the finished line was not pushed; the applied line was)"}`);
      return { code: result.exit, lock: result.lock, location, digest: result.digest };
    case "failed":
      throw new ConfigError(`${rel}: ${opMessage(result.error)}`);
    case "held":
      log(`${rel}: ${result.reason}`);
      return { code: result.exit, lock: result.lock, location, digest: result.digest };
    case "spent":
      log(`${rel}: the release of ${describeLock(result.lock)} under request ${result.digest} ran already; a request releases once`);
      return { code: result.exit, lock: result.lock, location, digest: result.digest };
    case "refused":
      log(`${rel}: an approval does not count: ${result.reason}`);
    // falls through: the request still waits for another approver
    case "waiting":
      log(`${rel}: ${location} holds ${describeLock(result.lock)}; no run that began before it is alive`);
      log(`${rel}: releasing ${describeLock(result.lock)} waits for an approval of digest ${result.digest} by someone other than ${actor}. Approve it with:`);
      log(`  ${result.command}`);
      log("Then run this again.");
      return { code: result.exit, lock: result.lock, location, digest: result.digest, command: result.command };
  }
}
