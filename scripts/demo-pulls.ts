// Delete the demo repos' old pull requests in Forgejo at each reset, and run
// Forgejo's own maintenance now and then, so the repos stay the same size
// however long the loop runs (behold#603). The driver opens a pull request per
// cycle; after a thousand cycles terragucci-admin/demo carried 1,838
// refs/pull/<n>/head and 3,734 loose objects, and each clone took 3 s.
//
// For each repo, it keeps the newest DEMO_PULLS_KEEP (at least 10) closed pull
// requests and deletes older ones, oldest first and at most 50 a reset, with
// DELETE /api/v1/repos/{owner}/{repo}/issues/{index}: in Forgejo 16 that
// deletes a pull request's rows and its refs/pull/<n>/head
// (services/issue/issue.go, DeleteIssue). It never deletes an open pull
// request, the repo's newest one (the cycle that just ended), or one that the
// reports bucket still names: a step of a stored cycle record
// (<prefix>/cycles/<tool>/, which behold's tool page replays) or a run in
// <prefix>/runs/index.json (behold's runs pane). When the bucket cannot be
// read, it deletes nothing.
//
// Then, at most every DEMO_PULLS_MAINTENANCE_EVERY seconds (3600), it asks
// Forgejo to run two of its cron tasks (POST /api/v1/admin/cron/{task}, site
// admin): git_gc_repos, `git gc` in every repo, which packs the loose objects
// and the refs; and cleanup_actions, which removes the artifacts of the runs
// the reset deleted (their logs go with them; Forgejo otherwise clears the
// artifacts at midnight).
//
// Everything comes from the environment the driver sets:
//   DEMO_PULLS_FORGE_URL, DEMO_PULLS_TOKEN       Forgejo, and the admin's token (a site admin, scope all)
//   DEMO_PULLS_REPOS                             the repos, one "<repo> <tool>" a line
//   DEMO_PULLS_KEEP                              the closed pull requests each repo keeps (default 50)
//   DEMO_PULLS_BUCKET_URL, DEMO_PULLS_PREFIX     the reports bucket's URL in floci, and the prefix
//   DEMO_PULLS_STATE                             a directory for maintenance.at, when the maintenance last ran
//   DEMO_PULLS_MAINTENANCE_EVERY                 seconds between two maintenance runs (default 3600)
//
// Exits 1 when something failed; the driver logs that and goes on.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cycleKeys } from "./demo-cycles-lib";
import { type ForgePull, MAINTENANCE_EVERY, maintenanceDue, PULLS_DELETE_MAX, PULLS_KEEP_MIN, pullsToDelete, referencedPulls } from "./demo-pulls-lib";
import { parseRepos } from "./demo-runs-lib";

const env = (k: string, def?: string): string => {
  const v = process.env[k] || def;
  if (v === undefined) throw new Error(`${k} is not set`);
  return v;
};

const forge = env("DEMO_PULLS_FORGE_URL").replace(/\/+$/, "");
const token = env("DEMO_PULLS_TOKEN");
const repos = parseRepos(process.env.DEMO_PULLS_REPOS);
const keep = Number(env("DEMO_PULLS_KEEP", "50"));
const bucket = env("DEMO_PULLS_BUCKET_URL").replace(/\/+$/, "");
const prefix = env("DEMO_PULLS_PREFIX", "demo");
const state = env("DEMO_PULLS_STATE");
const every = Number(env("DEMO_PULLS_MAINTENANCE_EVERY", String(MAINTENANCE_EVERY)));

// Never hold up a reset: the whole prune has two minutes.
setTimeout(() => {
  console.error("pulls: the prune took over 120s; stopped");
  process.exit(1);
}, 120_000).unref();

const TIMEOUT = 10_000;
const auth = { Authorization: `token ${token}` };

async function forgeJson<T>(path: string): Promise<{ body: T; total: number | null }> {
  const res = await fetch(`${forge}/api/v1${path}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  const total = res.headers.get("x-total-count");
  return { body: (await res.json()) as T, total: total === null ? null : Number(total) };
}

async function bucketText(key: string): Promise<string | null> {
  const res = await fetch(`${bucket}/${key}`, { signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${key}: ${res.status}`);
  return res.text();
}

// Every document in the bucket that names a pull request: the runs index and
// each tool's stored cycles. A document that is not there names none; one
// that cannot be read throws, and nothing is deleted.
async function bucketDocs(): Promise<unknown[]> {
  const docs: unknown[] = [];
  const parse = (t: string | null) => {
    if (t === null) return;
    try {
      docs.push(JSON.parse(t));
    } catch {
      throw new Error("a document in the bucket is not JSON");
    }
  };
  parse(await bucketText(`${prefix}/runs/index.json`));
  for (const tool of new Set(repos.map((r) => r.tool))) {
    const list = await fetch(`${bucket}?list-type=2&prefix=${encodeURIComponent(`${prefix}/cycles/${tool}/`)}`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!list.ok) throw new Error(`list ${prefix}/cycles/${tool}/: ${list.status}`);
    parse(await bucketText(`${prefix}/cycles/${tool}/latest.json`));
    for (const n of cycleKeys(await list.text(), prefix, tool)) parse(await bucketText(`${prefix}/cycles/${tool}/${n}.json`));
  }
  return docs;
}

// The start of a repo's closed pull requests, oldest first: enough pages to
// cover the ones past the newest kept, or PULLS_DELETE_MAX of them and those
// the bucket protects.
async function oldestClosed(repo: string, room: number): Promise<{ oldest: ForgePull[]; closed: number }> {
  const oldest: ForgePull[] = [];
  let closed = 0;
  for (let page = 1; page <= 20; page++) {
    const { body, total } = await forgeJson<ForgePull[]>(`/repos/${repo}/pulls?state=closed&sort=oldest&limit=50&page=${page}`);
    if (total !== null) closed = total;
    oldest.push(...body);
    if (body.length < 50 || oldest.length >= room) break;
  }
  return { oldest, closed: Math.max(closed, oldest.length) };
}

async function pruneRepo(repo: string, protect: Set<number>): Promise<boolean> {
  const newest = (await forgeJson<ForgePull[]>(`/repos/${repo}/pulls?state=all&limit=1&page=1`)).body[0]?.number ?? 0;
  const open = (await forgeJson<ForgePull[]>(`/repos/${repo}/pulls?state=open&limit=50&page=1`)).body.map((p) => p.number);
  const guard = new Set([...protect, ...open]);
  const { oldest, closed } = await oldestClosed(repo, PULLS_DELETE_MAX + guard.size);
  const ids = pullsToDelete({ oldest, closed, keep, newest, protect: guard });
  let deleted = 0;
  let ok = true;
  for (const n of ids) {
    try {
      const res = await fetch(`${forge}/api/v1/repos/${repo}/issues/${n}`, { method: "DELETE", headers: auth, signal: AbortSignal.timeout(TIMEOUT) });
      if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
      deleted++;
    } catch (e) {
      ok = false;
      console.error(`pulls: could not delete pull request ${n} of ${repo}: ${(e as Error).message}`);
    }
  }
  console.error(`pulls: deleted ${deleted} closed pull requests of ${repo} past the newest ${Math.max(keep, PULLS_KEEP_MIN)} (${closed} closed before)`);
  return ok;
}

async function maintenance(): Promise<boolean> {
  const stamp = join(state, "maintenance.at");
  let last: number | null = null;
  try {
    last = Number(readFileSync(stamp, "utf8").trim());
  } catch {
    last = null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!maintenanceDue(last, now, every)) return true;
  // Written first, so a maintenance that fails is not asked for again at every reset.
  mkdirSync(state, { recursive: true });
  writeFileSync(stamp, `${now}\n`);
  let ok = true;
  for (const task of ["cleanup_actions", "git_gc_repos"]) {
    const t0 = Date.now();
    try {
      // Forgejo runs the task before it answers; a gc of the demo repos takes seconds.
      const res = await fetch(`${forge}/api/v1/admin/cron/${task}`, { method: "POST", headers: auth, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`${res.status}`);
      console.error(`pulls: Forgejo ran ${task} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      ok = false;
      console.error(`pulls: Forgejo's ${task} failed: ${(e as Error).message}`);
    }
  }
  return ok;
}

async function main(): Promise<void> {
  if (repos.length === 0) throw new Error("DEMO_PULLS_REPOS is not set");
  let ok = true;
  let docs: unknown[] | null = null;
  try {
    docs = await bucketDocs();
  } catch (e) {
    ok = false;
    console.error(`pulls: could not read what the bucket names (${(e as Error).message}); deleting no pull request`);
  }
  if (docs !== null) {
    for (const { repo } of repos) {
      try {
        if (!(await pruneRepo(repo, referencedPulls(repo, docs)))) ok = false;
      } catch (e) {
        ok = false;
        console.error(`pulls: ${repo}: ${(e as Error).message}`);
      }
    }
  }
  if (!(await maintenance())) ok = false;
  if (!ok) process.exit(1);
}

main().catch((e: Error) => {
  console.error(`pulls: ${e.message}`);
  process.exit(1);
});
