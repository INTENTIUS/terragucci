/**
 * How the applies of one binary are kept apart, and the rows a choudoufu
 * apply holds while it applies.
 *
 * Every binary but choudoufu applies per root: two applies of different roots
 * run at once, and the backend's own state lock keeps two applies of one root
 * apart. choudoufu keeps one record per resource, writes each conditionally,
 * and its `apply <planfile>` re-reads the live system and refuses a plan one
 * of whose changes moved since it was made. So a choudoufu wave holds the
 * resources its approved plans change, not the root: before its apply, so
 * before that re-read, it takes one row per changed resource, and two waves
 * that change different resources of one estate apply at the same time.
 *
 * The rows are one file, `_locks/apply-rows.json`, on the repo's
 * `chant/lifecycle` branch, beside the pull request locks (./locks.ts). A
 * wave takes all its rows in one commit pushed without force, so a take is
 * all or nothing and two waves cannot deadlock. A row held by a run that is
 * gone, or whose lease is older than `TG_LOCK_STALE` seconds, is taken over
 * in the same commit, so nothing needs unlocking.
 *
 * A row is keyed by the estate and the resource's address, its previous
 * address for a moved instance, and the live object's identity for an
 * update or a delete, so two estates that meet on one object meet on its row.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ConfigError, type Binary } from "./config";
import { BINARY } from "./shape";

/**
 * shape: the one decision a binary makes about concurrent applies.
 * `resource`: the wave holds rows for the resources its plans change.
 * `root`: nothing is held; the backend's state lock keeps one root's applies apart.
 * `repo`: one apply at a time in the repo (a concurrency group, or the lock tag on Forgejo).
 */
export type ApplyScope = "resource" | "root" | "repo";

export function applyScope(binary: string): ApplyScope {
  const name = basename(binary).replace(/\.exe$/, "");
  return Object.hasOwn(BINARY, name) ? BINARY[name as Binary].applyScope : "root";
}

const LIFECYCLE = "chant/lifecycle";
const REMOTE_REF = `refs/remotes/origin/${LIFECYCLE}`;
/** Where the rows are kept on `chant/lifecycle`. */
export const ROWS_PATH = "_locks/apply-rows.json";
const GIT_ID = { GIT_AUTHOR_NAME: "terragucci", GIT_AUTHOR_EMAIL: "terragucci@localhost", GIT_COMMITTER_NAME: "terragucci", GIT_COMMITTER_EMAIL: "terragucci@localhost" };
/** A lease older than this many seconds is taken over, as the lock tag's is (TG_LOCK_STALE). */
export const DEFAULT_STALE_SECONDS = 7200;

/** One row a wave takes: what it keys, and the change it stands for. */
export interface ApplyRow {
  key: string;
  root: string;
  address: string;
}

/** The run holding rows: the forge's run id, or this host and process outside CI. */
export interface RowHolder {
  run: string;
  at: string;
  /** The run's page, for a reply that names it. */
  url?: string;
  sha?: string;
}

export interface RowsFile {
  version: 1;
  holders: Record<string, RowHolder>;
  /** Row key to the run that holds it. */
  rows: Record<string, string>;
}

/** A row another run holds. */
export interface HeldRow {
  key: string;
  holder: RowHolder;
}

const CHANGING = new Set(["create", "update", "delete", "forget"]);

/**
 * The rows a plan's changes key: one per resource instance the apply acts on
 * (a create, update, delete, replace or forget), read from `show -json`'s
 * `resource_changes`. Data reads and no-ops take none. A root with no estate
 * of its own is keyed by its path.
 */
export function planRows(root: string, estate: string | undefined, plan: unknown): ApplyRow[] {
  const scope = estate ? `estate ${estate}` : `root ${root}`;
  const out = new Map<string, ApplyRow>();
  const changes = (plan as { resource_changes?: unknown[] } | undefined)?.resource_changes ?? [];
  for (const c of changes as Array<Record<string, any>>) {
    if (c?.mode === "data" || typeof c?.address !== "string") continue;
    const actions: string[] = Array.isArray(c.change?.actions) ? c.change.actions : [];
    if (!actions.some((a) => CHANGING.has(a))) continue;
    const address = c.address as string;
    const add = (key: string) => out.has(key) || out.set(key, { key, root, address });
    add(`${scope} ${address}`);
    if (typeof c.previous_address === "string" && c.previous_address !== address) add(`${scope} ${c.previous_address}`);
    // The live object an update or a delete acts on: two estates that meet on one object meet here.
    const id = c.change?.before?.id;
    if (actions.some((a) => a !== "create") && (typeof id === "string" || typeof id === "number") && String(id) !== "") add(`object ${String(id)}`);
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Who this wave is, as the rows name it: the forge's run, or this host and process outside CI. */
export function rowHolder(env: NodeJS.ProcessEnv, now: Date = new Date()): RowHolder {
  const gitlab = Boolean(env.CI_PIPELINE_ID);
  const run = env.GITHUB_RUN_ID || env.CI_PIPELINE_ID || `local:${hostname()}:${process.pid}`;
  const url = gitlab
    ? env.CI_PIPELINE_URL
    : env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const sha = env.TG_SHA || env.GITHUB_SHA || env.CI_COMMIT_SHA;
  return { run, at: now.toISOString(), ...(url ? { url } : {}), ...(sha ? { sha } : {}) };
}

/** Whether a holder is still running: `dead` when it is gone, `alive` when it runs or nobody can say. */
export type Liveness = (holder: RowHolder) => Promise<"alive" | "dead">;

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Ask the forge whether the run is gone, as the lock tag's `tg alive` does,
 * with the job's token (TG_TOKEN). A lease older than `TG_LOCK_STALE` counts
 * as gone. A local holder on this host is gone when its process is. Anything
 * nobody can answer counts as alive.
 */
export function forgeLiveness(env: NodeJS.ProcessEnv, fetch: Fetch = globalThis.fetch as unknown as Fetch, now: () => number = Date.now): Liveness {
  const stale = Number(env.TG_LOCK_STALE) > 0 ? Number(env.TG_LOCK_STALE) : DEFAULT_STALE_SECONDS;
  return async (h) => {
    const since = new Date(h.at).getTime();
    if (Number.isFinite(since) && now() - since >= stale * 1000) return "dead";
    const local = /^local:(.*):(\d+)$/.exec(h.run);
    if (local) {
      if (local[1] !== hostname()) return "alive";
      try {
        process.kill(Number(local[2]), 0);
        return "alive";
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
      }
    }
    const token = env.TG_TOKEN;
    if (!token) return "alive";
    try {
      if (env.CI_API_V4_URL && env.CI_PROJECT_ID) {
        const r = await fetch(`${env.CI_API_V4_URL}/projects/${env.CI_PROJECT_ID}/pipelines/${h.run}`, { headers: { "private-token": token } });
        if (!r.ok) return "alive";
        const status = String(((await r.json()) as { status?: string }).status ?? "");
        return ["success", "failed", "canceled", "skipped"].includes(status) ? "dead" : "alive";
      }
      const api = env.GITHUB_API_URL || (env.GITHUB_SERVER_URL ? `${env.GITHUB_SERVER_URL}/api/v1` : "");
      if (!api || !env.GITHUB_REPOSITORY) return "alive";
      const r = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${h.run}`, { headers: { authorization: `token ${token}` } });
      if (!r.ok) return "alive";
      const status = String(((await r.json()) as { status?: string }).status ?? "");
      return ["success", "failure", "cancelled", "skipped", "completed"].includes(status) ? "dead" : "alive";
    } catch {
      return "alive";
    }
  };
}

function git(repo: string, args: string[], input?: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf-8", input, env });
}

/** The rows file's text: anything that is not a version 1 file reads as no rows. */
export function parseRows(text: string): RowsFile {
  try {
    const doc = JSON.parse(text);
    if (doc?.version === 1 && doc.rows && typeof doc.rows === "object" && doc.holders && typeof doc.holders === "object") {
      const holders: Record<string, RowHolder> = {};
      for (const [id, h] of Object.entries(doc.holders as Record<string, any>)) {
        if (typeof h?.run === "string" && typeof h.at === "string") holders[id] = { run: h.run, at: h.at, ...(typeof h.url === "string" ? { url: h.url } : {}), ...(typeof h.sha === "string" ? { sha: h.sha } : {}) };
      }
      const rows: Record<string, string> = {};
      for (const [k, id] of Object.entries(doc.rows as Record<string, unknown>)) if (typeof id === "string" && holders[id]) rows[k] = id;
      return { version: 1, holders, rows };
    }
  } catch {
    // An unreadable file holds no rows.
  }
  return { version: 1, holders: {}, rows: {} };
}

function current(repo: string): { parent: string; file: RowsFile } {
  const heads = git(repo, ["ls-remote", "--heads", "origin", LIFECYCLE]);
  if (heads.status !== 0) throw new ConfigError(`cannot read ${LIFECYCLE} from origin, so the rows this apply changes cannot be held: ${heads.stderr.trim()}`);
  if (!heads.stdout.trim()) return { parent: "", file: { version: 1, holders: {}, rows: {} } };
  const f = git(repo, ["fetch", "-q", "origin", `+refs/heads/${LIFECYCLE}:${REMOTE_REF}`]);
  if (f.status !== 0) throw new ConfigError(`cannot fetch ${LIFECYCLE}, so the rows this apply changes cannot be held: ${f.stderr.trim()}`);
  const parent = git(repo, ["rev-parse", REMOTE_REF]).stdout.trim();
  const show = git(repo, ["show", `${REMOTE_REF}:${ROWS_PATH}`]);
  return { parent, file: parseRows(show.status === 0 ? show.stdout : "") };
}

/** Commit `file` on top of `parent` and push it without force. False when another writer moved the branch first. */
function write(repo: string, parent: string, file: RowsFile, message: string): boolean {
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const blob = git(repo, ["hash-object", "-w", "--stdin"], text).stdout.trim();
  const scratch = mkdtempSync(join(tmpdir(), "terragucci-rows-"));
  const env = { ...process.env, ...GIT_ID, GIT_INDEX_FILE: join(scratch, "index") };
  try {
    if (parent) git(repo, ["read-tree", parent], undefined, env);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${ROWS_PATH}`], undefined, env);
    const tree = git(repo, ["write-tree"], undefined, env).stdout.trim();
    const commit = git(repo, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], undefined, env).stdout.trim();
    if (!commit) throw new ConfigError("could not write the rows this apply holds");
    return git(repo, ["push", "-q", "origin", `${commit}:refs/heads/${LIFECYCLE}`]).status === 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The rows as `chant/lifecycle` on origin holds them now. */
export function readRows(repo: string): RowsFile {
  return current(repo).file;
}

/** Who else holds any of `keys`, split into runs still going and runs that are gone. */
export async function heldBy(file: RowsFile, keys: readonly string[], me: string, alive: Liveness): Promise<{ live: HeldRow[]; gone: string[] }> {
  const verdict = new Map<string, "alive" | "dead">();
  const live: HeldRow[] = [];
  const gone = new Set<string>();
  for (const key of keys) {
    const id = file.rows[key];
    if (!id || id === me) continue;
    const holder = file.holders[id]!;
    if (!verdict.has(id)) verdict.set(id, await alive(holder));
    if (verdict.get(id) === "dead") gone.add(id);
    else live.push({ key, holder });
  }
  return { live, gone: [...gone].sort() };
}

export type TakeResult = { ok: true; tookOver: RowHolder[] } | { ok: false; held: HeldRow[] };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Take `rows` for `me` in one commit. A row a live run holds refuses the
 * whole take and nothing is written. The rows of a run that is gone are
 * dropped in the same commit, all of them, so it holds nothing afterwards.
 */
export async function takeRows(repo: string, rows: readonly ApplyRow[], me: RowHolder, alive: Liveness): Promise<TakeResult> {
  const keys = [...new Set(rows.map((r) => r.key))];
  if (keys.length === 0) return { ok: true, tookOver: [] };
  for (let attempt = 0; attempt < 30; attempt++) {
    const { parent, file } = current(repo);
    const { live, gone } = await heldBy(file, keys, me.run, alive);
    if (live.length > 0) return { ok: false, held: live };
    const next: RowsFile = { version: 1, holders: { ...file.holders }, rows: { ...file.rows } };
    const tookOver = gone.map((id) => file.holders[id]!);
    for (const id of gone) {
      delete next.holders[id];
      for (const [k, h] of Object.entries(next.rows)) if (h === id) delete next.rows[k];
    }
    next.holders[me.run] = me;
    for (const k of keys) next.rows[k] = me.run;
    const took = gone.length ? `, taken over from run ${gone.join(", ")}` : "";
    if (write(repo, parent, next, `Hold ${keys.length} row${keys.length === 1 ? "" : "s"} for run ${me.run}${took}`)) return { ok: true, tookOver };
    // Another wave moved the branch first: read it again after a moment.
    await pause(200 + Math.floor(Math.random() * 800));
  }
  throw new ConfigError(`could not push the rows this apply holds to ${LIFECYCLE}; check that the job may push to it`);
}

/** Let go of `keys` where `me` still holds them. Never throws: a row left held is taken over once the run is gone. */
export async function releaseRows(repo: string, keys: readonly string[], me: string): Promise<boolean> {
  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const { parent, file } = current(repo);
      const mine = keys.filter((k) => file.rows[k] === me);
      if (mine.length === 0) return true;
      const next: RowsFile = { version: 1, holders: { ...file.holders }, rows: { ...file.rows } };
      for (const k of mine) delete next.rows[k];
      if (!Object.values(next.rows).includes(me)) delete next.holders[me];
      if (write(repo, parent, next, `Release ${mine.length} row${mine.length === 1 ? "" : "s"} of run ${me}`)) return true;
      await pause(200 + Math.floor(Math.random() * 800));
    }
  } catch {
    // Falls through: the rows stay until a later wave takes them over.
  }
  return false;
}

/** One line naming the runs that hold rows, and the resources, for a log line and a reply. */
export function describeHeld(held: readonly HeldRow[], rows: readonly ApplyRow[]): string {
  const byRun = new Map<string, { holder: RowHolder; addresses: Set<string> }>();
  const address = new Map(rows.map((r) => [r.key, `${r.root}: ${r.address}`]));
  for (const h of held) {
    const e = byRun.get(h.holder.run) ?? { holder: h.holder, addresses: new Set<string>() };
    e.addresses.add(address.get(h.key) ?? h.key);
    byRun.set(h.holder.run, e);
  }
  return [...byRun.values()]
    .map(({ holder, addresses }) => `run ${holder.run}${holder.url ? ` (${holder.url})` : ""} is applying ${[...addresses].sort().join(", ")}`)
    .join("; ");
}
