// Delete the demo's old wave reports from the reports bucket at each reset, so
// the bucket in floci stays the same size however long the loop runs (#1117).
// The pipelines write a directory per run under
// <prefix>/<project>/<yyyy>/<mm>/<commit>/ and a run view per applied commit
// under <prefix>/<project>/runs/<commit>/, and nothing deleted them: after 42
// hours floci held 40,000 of them, 180 MB, in memory.
//
// For each project the top-of-prefix index lists, it keeps the reports of the
// newest DEMO_REPORTS_KEEP (50, at least 20) commits the project's index
// lists, and of every commit something still names: the newest row of each
// stage and wave (the estate page's latest state), inventory.json, edges.json,
// the newest state version of each root in states.json, a stored cycle record
// (<prefix>/cycles/<tool>/, which behold's tool page replays) and demo.json
// (the commit behold's kiosk pins), and any commit with an object written in
// the last 15 minutes. The other commits' objects are deleted, oldest first,
// at most 5,000 a reset.
//
// Before it deletes anything, it rewrites each document that names a run it
// deletes, with a write conditional on the copy read: the project's and the
// top index.json (and their index.html), changes.json, states.json,
// history.json and history.html beside the estate page, and audit.jsonl, from
// which it drops the report entries of those runs (audit.json and audit.html
// are written again with the new counts). It drops audit.jsonl's ledger
// entries too once the repo's chant/lifecycle no longer holds their commit
// (each cycle puts it back to its base, stack/demo.sh lifecycle_back) and
// they are older than the project's oldest kept report; one the branch holds
// stays, since terragucci audit builds it again. When a document cannot be
// read or written, it deletes nothing.
//
// Everything comes from the environment the driver sets:
//   DEMO_REPORTS_BUCKET_URL, DEMO_REPORTS_PREFIX   the reports bucket's URL in floci, and the prefix
//   DEMO_REPORTS_KEEP                              the commits each project keeps (default 50)
//   DEMO_REPORTS_LEDGER                            a file of the commits each repo's chant/lifecycle holds,
//                                                  "<repo> <sha>" a line ("<repo>" alone for none); unset or
//                                                  unreadable, no ledger entry is dropped
//
// Exits 1 when something failed; the driver logs that and goes on.
import { readFileSync } from "node:fs";
import { AUDIT_FILES, renderAuditHtml } from "../packages/terragucci/src/report/audit";
import { renderHistoryHtml } from "../packages/terragucci/src/report/history";
import { encodePath } from "../packages/terragucci/src/report/object-store";
import { renderIndexHtml, type IndexEntry, type ReportIndex } from "../packages/terragucci/src/report/store";
import {
  keeps,
  keptCommits,
  type LedgerHeld,
  type Listed,
  listPage,
  objectsToDelete,
  protectedCommits,
  pruneAudit,
  pruneChanges,
  pruneHistory,
  pruneIndex,
  pruneStates,
  readLedgerCommits,
  recount,
  REPORTS_DELETE_MAX,
  REPORTS_KEEP,
  REPORTS_KEEP_MIN,
} from "./demo-reports-lib";

const env = (k: string, def?: string): string => {
  const v = process.env[k] || def;
  if (v === undefined) throw new Error(`${k} is not set`);
  return v;
};

const bucket = env("DEMO_REPORTS_BUCKET_URL").replace(/\/+$/, "");
const prefix = env("DEMO_REPORTS_PREFIX", "demo").replace(/^\/+|\/+$/g, "");
const keep = Number(env("DEMO_REPORTS_KEEP", String(REPORTS_KEEP)));

// Never hold up a reset: the whole prune has two minutes.
setTimeout(() => {
  console.error("reports: the prune took over 120s; stopped");
  process.exit(1);
}, 120_000).unref();

const TIMEOUT = 10_000;
const TRIES = 5;
const JSON_TYPE = "application/json";
const HTML_TYPE = "text/html; charset=utf-8";

const k = (...p: string[]): string => p.filter(Boolean).join("/");
const url = (key: string): string => `${bucket}/${encodePath(key)}`;

async function read(key: string): Promise<{ text: string | undefined; etag: string | undefined }> {
  const res = await fetch(url(key), { signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 404) return { text: undefined, etag: undefined };
  if (!res.ok) throw new Error(`GET ${key}: ${res.status}`);
  return { text: await res.text(), etag: res.headers.get("etag") ?? undefined };
}

async function put(key: string, body: string, type: string, etag?: string): Promise<"ok" | "conflict"> {
  const cond: Record<string, string> = etag ? { "if-match": etag } : {};
  let res = await fetch(url(key), { method: "PUT", headers: { "content-type": type, ...cond }, body, signal: AbortSignal.timeout(TIMEOUT) });
  // A store that takes no conditional write gets an unconditional one, as terragucci's own uploads do (report/s3.ts).
  if (res.status === 501 && etag) res = await fetch(url(key), { method: "PUT", headers: { "content-type": type }, body, signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 412 || res.status === 409) return "conflict";
  if (!res.ok) throw new Error(`PUT ${key}: ${res.status}`);
  return "ok";
}

/**
 * Write the document at `key` that `build` makes from the copy read,
 * conditional on that copy; read and build again when another writer got
 * there first. `build` returns null when there is nothing to change.
 */
async function rewrite<T>(key: string, type: string, build: (text: string | undefined) => { body: string; value: T } | null): Promise<T | null> {
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const { text, etag } = await read(key);
    const built = build(text);
    if (built === null) return null;
    if ((await put(key, built.body, type, etag)) === "ok") return built.value;
    await new Promise((r) => setTimeout(r, 100 * attempt));
  }
  throw new Error(`${key} changed under the prune ${TRIES} times in a row`);
}

async function list(p: string): Promise<Listed[]> {
  const out: Listed[] = [];
  let token: string | null = null;
  for (let page = 0; page < 500; page++) {
    const q = new URLSearchParams({ "list-type": "2", prefix: p });
    if (token) q.set("continuation-token", token);
    const res = await fetch(`${bucket}?${q.toString()}`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`list ${p}: ${res.status}`);
    const { objects, next } = listPage(await res.text());
    out.push(...objects);
    if (!next) return out;
    token = next;
  }
  throw new Error(`list ${p}: more than 500 pages`);
}

const parse = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const rows = (text: string | undefined): IndexEntry[] | null => {
  const doc = parse(text) as Partial<ReportIndex> | undefined;
  return doc && Array.isArray(doc.reports) ? doc.reports : null;
};

const json = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

// demo.json and each stored cycle record: the commits behold's kiosk pins and replays.
async function demoDocs(): Promise<unknown[]> {
  const docs: unknown[] = [parse((await read(k(prefix, "demo.json"))).text)];
  for (const o of await list(`${k(prefix, "cycles")}/`)) if (o.key.endsWith(".json")) docs.push(parse((await read(o.key)).text));
  return docs.filter((d) => d !== undefined);
}

interface Plan {
  project: string;
  kept: Set<string>;
  keys: string[];
  commits: string[];
  /** When the project's oldest kept report finished, in ms; undefined when it keeps none. */
  oldest: number | undefined;
}

const ledgerCommits = (): Map<string, Set<string>> => {
  const file = process.env.DEMO_REPORTS_LEDGER;
  if (!file) return new Map();
  try {
    return readLedgerCommits(readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
};

// One project: what it keeps, and its own documents rewritten without the rest.
async function planProject(project: string, demo: unknown[]): Promise<Plan | null> {
  const dir = `${k(prefix, project)}/`;
  const index = await read(k(prefix, project, "index.json"));
  const listedRows = rows(index.text);
  if (listedRows === null) {
    console.error(`reports: ${project} has no index.json that reads; nothing of it is pruned`);
    return null;
  }
  const [inventory, edges, states] = await Promise.all(["inventory.json", "edges.json", "states.json"].map(async (f) => parse((await read(k(prefix, project, f))).text)));
  const listed = await list(dir);
  const protect = protectedCommits({ project, rows: listedRows, inventory, edges, states, demo });
  const kept = keptCommits({ project, rows: listedRows, listed, projectDir: dir, keep, protect, now: new Date() });
  const { keys, commits } = objectsToDelete({ listed, projectDir: dir, kept, max: REPORTS_DELETE_MAX });

  const title = `Plan reports: ${project}`;
  const own = await rewrite(k(prefix, project, "index.json"), JSON_TYPE, (t) => {
    const p = pruneIndex(t, project, kept);
    return p && { body: json(p.index), value: p.index };
  });
  if (own) await put(k(prefix, project, "index.html"), renderIndexHtml(own, title), HTML_TYPE);
  const top = await rewrite(k(prefix, "index.json"), JSON_TYPE, (t) => {
    const p = pruneIndex(t, project, kept, true);
    return p && { body: json(p.index), value: p.index };
  });
  if (top) await put(k(prefix, "index.html"), renderIndexHtml(top, "Plan reports"), HTML_TYPE);
  await rewrite(k(prefix, project, "changes.json"), JSON_TYPE, (t) => {
    const p = pruneChanges(t, kept);
    return p && { body: json(p.doc), value: p.dropped };
  });
  await rewrite(k(prefix, project, "states.json"), JSON_TYPE, (t) => {
    const p = pruneStates(t, kept);
    return p && { body: json(p.doc), value: p.dropped };
  });
  const keep2 = keeps(kept);
  const times = listedRows.filter((r) => r.project === project && keep2(r.commit)).map((r) => Date.parse(r.finished) || 0);
  return { project, kept, keys, commits, oldest: times.length ? Math.min(...times) : undefined };
}

async function remove(keys: string[]): Promise<number> {
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < keys.length) {
      const key = keys[next++];
      try {
        const res = await fetch(url(key), { method: "DELETE", signal: AbortSignal.timeout(TIMEOUT) });
        if (!res.ok && res.status !== 404) throw new Error(`${res.status}`);
      } catch (e) {
        failed++;
        if (failed <= 5) console.error(`reports: could not delete ${key}: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return failed;
}

async function main(): Promise<void> {
  const top = rows((await read(k(prefix, "index.json"))).text);
  if (top === null) {
    console.error(`reports: ${prefix}/index.json lists no project yet; nothing to prune`);
    return;
  }
  const demo = await demoDocs();
  let ok = true;
  const plans: Plan[] = [];
  for (const project of [...new Set(top.map((r) => r.project))].sort()) {
    try {
      const p = await planProject(project, demo);
      if (p) plans.push(p);
    } catch (e) {
      ok = false;
      console.error(`reports: ${project}: ${(e as Error).message}; nothing of it is pruned`);
    }
  }
  if (plans.length === 0) {
    if (!ok) process.exit(1);
    return;
  }

  // The documents of every project: the audit trail and the history beside the estate page.
  const kept = new Map(plans.map((p) => [p.project, p.kept]));
  const ledger: LedgerHeld = { commits: ledgerCommits(), oldest: new Map(plans.flatMap((p) => (p.oldest === undefined ? [] : [[p.project, p.oldest] as [string, number]]))) };
  try {
    const record = await rewrite(k(prefix, AUDIT_FILES.record), "application/x-ndjson", (t) => {
      const p = pruneAudit(t, kept, ledger);
      return p && { body: p.text, value: p };
    });
    if (record) {
      const summary = recount((await read(k(prefix, AUDIT_FILES.summary))).text, record.entries);
      if (summary) {
        await put(k(prefix, AUDIT_FILES.summary), json(summary), JSON_TYPE);
        await put(k(prefix, AUDIT_FILES.page), renderAuditHtml(summary, record.entries), HTML_TYPE);
      }
      console.error(`reports: dropped ${record.dropped} entries of pruned runs and of gate lines chant/lifecycle no longer holds from ${AUDIT_FILES.record}`);
    }
    const history = await rewrite(k(prefix, "history.json"), JSON_TYPE, (t) => {
      const p = pruneHistory(t, kept);
      return p && { body: json(p.history), value: p.history };
    });
    if (history) await put(k(prefix, "history.html"), renderHistoryHtml(history), HTML_TYPE);
  } catch (e) {
    console.error(`reports: ${(e as Error).message}; deleting no report`);
    process.exit(1);
  }

  for (const p of plans) {
    const failed = await remove(p.keys);
    if (failed > 0) ok = false;
    console.error(`reports: deleted ${p.keys.length - failed} objects of ${p.commits.length} commits of ${p.project}, keeping ${p.kept.size} commits (the newest ${Math.max(keep, REPORTS_KEEP_MIN)} and those still named)`);
  }
  if (!ok) process.exit(1);
}

main().catch((e: Error) => {
  console.error(`reports: ${e.message}`);
  process.exit(1);
});
