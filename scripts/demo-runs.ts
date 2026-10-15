// Copy the demo repo's pipeline runs from Forgejo into the reports bucket, for
// behold's kiosk: <prefix>/runs/index.json and <prefix>/runs/<id>.json (the
// formats are in scripts/demo-runs-lib.ts). stack/demo.sh runs it every few
// seconds while it waits on a run, and once each run ends. It keeps the newest
// 30 runs and deletes the objects of older ones.
//
// Everything comes from the environment the driver sets:
//   DEMO_RUNS_FORGE_URL, DEMO_RUNS_TOKEN, DEMO_RUNS_REPO   Forgejo and the demo repo
//   DEMO_RUNS_BUCKET_URL, DEMO_RUNS_PREFIX                 the reports bucket's URL in floci, and the prefix
//   DEMO_RUNS_STATE                                        a directory: marks.jsonl (the driver's) and cache.json
//   DEMO_RUNS_CYCLE, DEMO_RUNS_SCENARIO, DEMO_RUNS_CYCLE_STARTED
//                                                         the driver's cycle, to place runs it did not mark
//   DEMO_RUNS_DROP                                         more strings no line written may hold, one a line
//
// Exits 1 when it could not list the runs or write the index; the driver logs
// that and goes on.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildIndex,
  buildJob,
  buildRun,
  ENDED,
  type ForgeJob,
  type ForgeRun,
  type IndexEntry,
  type Job,
  KEEP,
  keptIds,
  type Mark,
  readMarks,
  runKeys,
  toPrune,
} from "./demo-runs-lib";

const env = (k: string, def?: string): string => {
  const v = process.env[k] ?? def;
  if (v === undefined) throw new Error(`${k} is not set`);
  return v;
};

const forge = env("DEMO_RUNS_FORGE_URL").replace(/\/+$/, "");
const token = env("DEMO_RUNS_TOKEN");
const repo = env("DEMO_RUNS_REPO");
const bucket = env("DEMO_RUNS_BUCKET_URL").replace(/\/+$/, "");
const prefix = env("DEMO_RUNS_PREFIX", "demo");
const state = env("DEMO_RUNS_STATE");
const cycle = process.env.DEMO_RUNS_CYCLE ? Number(process.env.DEMO_RUNS_CYCLE) : null;
const scenario = process.env.DEMO_RUNS_SCENARIO || null;
const cycleStarted = Number(process.env.DEMO_RUNS_CYCLE_STARTED || 0);
// The secret guard: no line holding the token, the driver's key path, or the secret key's name.
const drop = [token, "AWS_SECRET_ACCESS_KEY", ...(process.env.DEMO_RUNS_DROP ?? "").split("\n")].filter((s) => s !== "");

// Never hang the driver: the whole export has a minute.
setTimeout(() => {
  console.error("runs: the export took over 60s; stopped");
  process.exit(1);
}, 60_000).unref();

const TIMEOUT = 10_000;
const auth = { Authorization: `token ${token}` };

async function forgeGet(path: string): Promise<Response> {
  const res = await fetch(`${forge}/api/v1/repos/${repo}${path}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res;
}

async function put(key: string, body: string): Promise<void> {
  const res = await fetch(`${bucket}/${prefix}/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`PUT ${key}: ${res.status}`);
}

async function del(key: string): Promise<void> {
  const res = await fetch(`${bucket}/${prefix}/${key}`, { method: "DELETE", signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${key}: ${res.status}`);
}

interface Cached {
  forge: string; // the list's status when it was written
  mark: string; // the mark's hash when it was written
  doc: string; // the doc's hash
  entry: IndexEntry;
}
interface Cache {
  runs: Record<string, Cached>;
  index: string;
}

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

function readText(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function writeAtomic(p: string, text: string): void {
  writeFileSync(`${p}.new`, text);
  renameSync(`${p}.new`, p);
}

async function exportRun(run: ForgeRun, mark: Mark | undefined): Promise<{ doc: string; entry: IndexEntry; body: string }> {
  const detail = (await (await forgeGet(`/actions/runs/${run.id}`)).json()) as ForgeRun;
  const forgeJobs = (await (await forgeGet(`/actions/runs/${run.id}/jobs`)).json()) as ForgeJob[] | null;
  const jobs: Job[] = [];
  for (const j of forgeJobs ?? []) {
    let log: string | null = null;
    if (j.task_id) {
      try {
        log = await (await forgeGet(`/actions/jobs/${j.id}/logs`)).text();
      } catch {
        log = null; // a job with no log yet
      }
    }
    jobs.push(buildJob(j, log, drop));
  }
  const { doc, entry } = buildRun(detail, jobs, mark);
  const body = JSON.stringify(doc);
  return { doc: hash(doc), entry, body };
}

async function main(): Promise<void> {
  mkdirSync(state, { recursive: true });
  const marksPath = join(state, "marks.jsonl");
  const cachePath = join(state, "cache.json");
  let cache: Cache = { runs: {}, index: "" };
  try {
    cache = { runs: {}, index: "", ...(JSON.parse(readText(cachePath)) as Partial<Cache>) };
  } catch {
    // no cache yet, or a torn one: every run is written again
  }

  const listed = ((await (await forgeGet("/actions/runs?page=1&limit=50")).json()) as { workflow_runs?: ForgeRun[] })
    .workflow_runs ?? [];
  const byId = new Map(listed.map((r) => [r.id, r]));
  const kept = keptIds([...byId.keys()]);

  // Runs the driver did not mark take its cycle when it first sees them, if
  // they started in it; older ones it cannot place.
  const marks = readMarks(readText(marksPath));
  for (const id of kept) {
    if (marks.has(id) || cache.runs[id]) continue;
    const created = Date.parse(byId.get(id)?.created ?? "") / 1000;
    const placed = cycle !== null && cycleStarted > 0 && created >= cycleStarted - 5;
    marks.set(id, { id, cycle: placed ? cycle : null, scenario: placed ? scenario : null });
  }
  writeAtomic(marksPath, kept.filter((id) => marks.has(id)).map((id) => JSON.stringify(marks.get(id))).join("\n") + "\n");

  const entries: IndexEntry[] = [];
  let failed = 0;
  for (const id of kept) {
    const run = byId.get(id) as ForgeRun;
    const mark = marks.get(id);
    const was = cache.runs[id];
    const markHash = hash(mark ?? null);
    if (was && was.forge === run.status && was.mark === markHash && ENDED.has(was.entry.status)) {
      entries.push(was.entry);
      continue;
    }
    try {
      const out = await exportRun(run, mark);
      if (!was || was.doc !== out.doc) await put(`runs/${id}.json`, out.body);
      cache.runs[id] = { forge: run.status, mark: markHash, doc: out.doc, entry: out.entry };
      entries.push(out.entry);
    } catch (e) {
      failed++;
      console.error(`runs: run ${id}: ${(e as Error).message}`);
      if (was) entries.push(was.entry);
    }
  }

  const index = buildIndex(entries, new Date(), KEEP);
  const indexHash = hash(index.runs);
  if (indexHash !== cache.index) {
    await put("runs/index.json", JSON.stringify(index));
    cache.index = indexHash;
  }

  // Prune: every runs/<id>.json the bucket or the cache holds that is not kept.
  let stored = Object.keys(cache.runs).map(Number);
  try {
    const res = await fetch(`${bucket}?list-type=2&prefix=${encodeURIComponent(`${prefix}/runs/`)}`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (res.ok) stored = stored.concat(runKeys(await res.text(), prefix));
  } catch {
    // the cache's list alone
  }
  for (const id of toPrune(stored, kept)) {
    try {
      await del(`runs/${id}.json`);
      delete cache.runs[id];
    } catch (e) {
      console.error(`runs: could not delete run ${id}: ${(e as Error).message}`);
    }
  }
  writeAtomic(cachePath, JSON.stringify(cache));
  if (failed) console.error(`runs: ${failed} of ${kept.length} runs not written this time`);
}

main().catch((e: Error) => {
  console.error(`runs: ${e.message}`);
  process.exit(1);
});
