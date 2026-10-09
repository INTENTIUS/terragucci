/**
 * Where a report is kept. Locally (the CI artifact), a run's directory holds
 * `report.json`, `report.html`, `note.md`, `summary.txt`,
 * `gitlab-terraform.json` and `roots/<root>/plan.{txt,json}`. With
 * `reports.bucket` (S3, GCS or Azure Blob: bucket.ts), the same files are copied to
 * `<prefix>/<project>/<yyyy>/<mm>/<commit>/<stage>[-wave-N]/`, and the
 * index at the project's path and at the top of the prefix gains a row.
 * Links inside a report are relative, so they resolve in both layouts.
 * A `tf-apply` wave's upload also replaces the resource lists of the roots it
 * applied in `<prefix>/<project>/inventory.json` (inventory.ts), and adds
 * what it did to each resource to `<prefix>/<project>/changes.json`
 * (history.ts).
 * An index keeps INDEX_ROWS rows and the newest of each project, stage and
 * wave; `terragucci estate` (estate.ts) reads nothing else.
 *
 * With `reports.url`, the address that serves the bucket to a browser, the
 * run's copy has an absolute address (`reportUrl`), which the note, the drift
 * issue, the stage span and the dashboards link. Each trace also gets a page
 * at `<prefix>/traces/<trace id>.html` that sends the reader on to its
 * run's report, so a dashboard that lists traces can link the report.
 *
 * `<prefix>/views/` is a viewer's: no upload writes under it (VIEWS_DIR).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { esc, renderHtml } from "./html";
import { addToChanges, changeRows } from "./history";
import { addToInventory, inventoryRoots } from "./inventory";
import { PRESIGN_MAX_SECONDS, StoreConflict, StoreError, type ObjectStore } from "./object-store";
import type { Report } from "./schema";
import { TACO_CSS, TACO_ICON, TACO_IMG } from "./taco";
import { renderGitLabTerraform, renderNote, renderText, type NoteOptions } from "./views";

/** Write a run's report directory. `plans` maps each root to its full plan text and redacted JSON. */
export function writeReportDir(dir: string, report: Report, plans: Map<string, { text?: string; json?: string }>, note: NoteOptions = {}): string[] {
  const files: Record<string, string> = {
    "report.json": JSON.stringify(report, null, 2) + "\n",
    "report.html": renderHtml(report),
    // The note shows each root's rendered plan: the same text as its plan.txt.
    "note.md": renderNote(report, { plans: new Map([...plans].flatMap(([root, p]) => (p.text !== undefined ? [[root, p.text] as const] : []))), ...note }),
    "summary.txt": renderText(report),
    "gitlab-terraform.json": JSON.stringify(renderGitLabTerraform(report)) + "\n",
  };
  for (const r of report.roots) {
    const p = plans.get(r.path);
    if (p?.text !== undefined && r.plan.text) files[r.plan.text] = p.text;
    if (p?.json !== undefined && r.plan.json) files[r.plan.json] = p.json;
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return Object.keys(files).sort();
}

/** The run's path under the project: `<yyyy>/<mm>/<commit>/<stage>[-wave-N]`. */
export function runPath(report: Report): string {
  const at = new Date(report.run.finished);
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const stage = report.run.wave !== undefined ? `${report.run.stage}-wave-${report.run.wave}` : report.run.stage;
  return `${yyyy}/${mm}/${report.run.commit}/${stage}`;
}

/** Where a bucket's objects are: `reports` without `bucket`. */
export interface ReportsAddress {
  prefix?: string;
  /** The http(s) address that serves the bucket's objects. */
  url?: string;
}

const trim = (s: string): string => s.replace(/^\/+|\/+$/g, "");
const joinKey = (...p: string[]): string => p.map(trim).filter(Boolean).join("/");

/** The run's directory under the bucket: `<prefix>/<project>/<yyyy>/<mm>/<commit>/<stage>[-wave-N]`. */
export const runKey = (report: Report, prefix = ""): string => joinKey(prefix, report.run.project, runPath(report));

/** Kept for a viewer's own files under `<prefix>/`: terragucci never writes there. */
export const VIEWS_DIR = "views";

/** The run's key, refused when the project's name would put it under `<prefix>/views/` (a repo with no remote is named after its directory). */
function writableRunKey(report: Report, prefix: string): string {
  if (trim(report.run.project).split("/")[0] === VIEWS_DIR) throw new StoreError(`project ${report.run.project} would write under ${joinKey(prefix, VIEWS_DIR)}/, which is kept for viewers; give the repo a git remote, which names the project <host>/<path>`);
  return runKey(report, prefix);
}

/** The address of the bucket's `<prefix>`, or undefined when `reports.url` is not set. Never guessed from the bucket's name. */
export function reportsBase(reports: ReportsAddress | undefined): string | undefined {
  if (!reports?.url) return undefined;
  return [reports.url.replace(/\/+$/, ""), trim(reports.prefix ?? "")].filter(Boolean).join("/");
}

/** Where the run's report.html is served from the bucket, when `reports.url` says. */
export function bucketReportUrl(report: Report, reports: ReportsAddress | undefined): string | undefined {
  const base = reports?.url?.replace(/\/+$/, "");
  return base ? `${base}/${runKey(report, reports?.prefix)}/report.html` : undefined;
}

/**
 * Presigned links to the run's report.html and to each root's plan.txt in the
 * bucket, for a bucket no `reports.url` serves: what the note links. They
 * are made before the objects are written, which a presigned link allows,
 * and live PRESIGN_MAX_SECONDS, the longest the stores allow.
 */
export async function presignedLinks(
  store: ObjectStore,
  report: Report,
  prefix: string | undefined,
  roots: string[],
  seconds = PRESIGN_MAX_SECONDS,
  now = new Date(),
): Promise<{ reportUrl: string; planUrls: Map<string, string>; expires: string }> {
  const key = runKey(report, prefix);
  const html = await store.presign(`${key}/report.html`, seconds, now);
  const planUrls = new Map<string, string>();
  for (const root of roots) {
    const rel = report.roots.find((r) => r.path === root)?.plan.text;
    if (rel) planUrls.set(root, (await store.presign(`${key}/${rel}`, seconds, now)).url);
  }
  return { reportUrl: html.url, planUrls, expires: html.expires.toISOString() };
}

/** The key of the page that sends a trace's reader on to its run's report. */
export const traceKey = (traceId: string, prefix = ""): string => joinKey(prefix, "traces", `${traceId}.html`);

/** That page: a redirect to the report, relative, so it works wherever the bucket is served. */
export function renderTracePage(report: Report): string {
  const target = `../${report.run.project}/${runPath(report)}/report.html`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${esc(target)}"><title>terragucci report</title></head>
<body><p><a href="${esc(target)}">${esc(report.run.project)}: ${esc(report.run.stage)}${report.run.wave !== undefined ? ` wave ${report.run.wave}` : ""} at ${esc(report.run.commit.slice(0, 12))}</a></p></body></html>
`;
}

export const INDEX_SCHEMA = "terragucci.report-index/v1";

export interface IndexEntry {
  project: string;
  commit: string;
  stage: string;
  wave?: number;
  finished: string;
  /** The run's directory, relative to the index. */
  path: string;
  roots: number;
  groups: number;
  totals: { create: number; update: number; replace: number; delete: number };
  refused: number;
  /** Roots that failed to plan or apply (a provisional preview never counts). Absent on rows written before it was kept. */
  failed?: number;
  /** Roots with at least one change; on a tf-drift row, the roots that drifted. */
  changed?: number;
  /** A tf-apply wave's gate: waiting, approved or not-required. */
  approval?: "waiting" | "approved" | "not-required";
  /** When a waiting wave began waiting for an approval of its digest. */
  waiting_since?: string;
  /** When a tf-apply wave finished applying: its gate let it through and no root failed. */
  applied?: string;
  /** Roots the policy denied that a recorded override let through. Absent when none. */
  overridden?: number;
  /** A tf-plan row: each wave's set digest and review digest, the digests an apply of the same plans binds. Absent when no wave has one. */
  wave_digests?: string[];
  /** A tf-drift row: the roots that drifted, the first INDEX_DESTROYS of them. Absent when none drifted. */
  drifted_roots?: string[];
  /** A tf-drift row that found drift: when the project's open drift was first found, by this run or an earlier one. */
  drift_since?: string;
  /** A tf-drift row that found none after a row that found some: when that drift was first found, and its roots. Kept here because a later check of the same commit replaces the row that found it. */
  drift_cleared?: { since: string; roots: string[] };
  /** Destroys and replacements, as `root: address`: the first INDEX_DESTROYS of them. */
  destroys: string[];
  /** How many there are, when there are more than the row lists. */
  destroys_total?: number;
  /** The commit's page on the forge. */
  commit_url?: string;
  /** The pull or merge request, by number, and its page. */
  pull_request?: string;
  pull_request_url?: string;
  /** The CI job that produced the report. */
  job_url?: string;
  /** The run's trace, when a viewer is configured. */
  trace_url?: string;
}

export interface ReportIndex {
  schema: typeof INDEX_SCHEMA;
  reports: IndexEntry[];
}

/** At most this many rows in an index, beyond the newest row of each project, stage and wave (capIndex). */
export const INDEX_ROWS = 500;

/** At most this many destroys listed in a row. */
export const INDEX_DESTROYS = 50;

export function indexEntry(report: Report, path: string): IndexEntry {
  const t = report.totals;
  const destroys = report.named.filter((n) => n.action === "delete" || n.action === "replace").map((n) => `${n.root}: ${n.address}`);
  const failed = report.roots.filter((r) => r.status === "failed" && !r.terragrunt?.provisional).length;
  const wave = report.run.stage === "tf-apply" ? report.waves[0] : undefined;
  const approval = wave && wave.approval !== "not-requested" ? wave.approval : undefined;
  const overridden = report.roots.filter((r) => r.policy?.override).length;
  const digests = report.run.stage === "tf-plan" ? [...new Set(report.waves.flatMap((w) => [w.set_digest, w.review_digest]).filter((d): d is string => !!d))] : [];
  const drifted = report.run.stage === "tf-drift" ? report.roots.filter((r) => r.status === "planned" && r.changes.length > 0).map((r) => r.path).sort() : [];
  return {
    project: report.run.project,
    commit: report.run.commit,
    stage: report.run.stage,
    ...(report.run.wave !== undefined ? { wave: report.run.wave } : {}),
    finished: report.run.finished,
    path,
    roots: report.roots.length,
    groups: report.groups.length,
    totals: { create: t.create, update: t.update, replace: t.replace, delete: t.delete },
    refused: report.named.filter((n) => n.action === "refused").length,
    failed,
    changed: report.roots.filter((r) => r.status === "planned" && r.changes.length > 0).length,
    ...(approval ? { approval } : {}),
    ...(approval === "waiting" ? { waiting_since: wave!.waiting_since ?? report.run.finished } : {}),
    ...(approval && approval !== "waiting" && failed === 0 ? { applied: report.run.finished } : {}),
    ...(overridden > 0 ? { overridden } : {}),
    ...(digests.length > 0 ? { wave_digests: digests } : {}),
    ...(drifted.length > 0 ? { drifted_roots: drifted.slice(0, INDEX_DESTROYS) } : {}),
    destroys: destroys.slice(0, INDEX_DESTROYS),
    ...(destroys.length > INDEX_DESTROYS ? { destroys_total: destroys.length } : {}),
    ...(report.run.commit_url ? { commit_url: report.run.commit_url } : {}),
    ...(report.run.pull_request ? { pull_request: report.run.pull_request } : {}),
    ...(report.run.pull_request_url ? { pull_request_url: report.run.pull_request_url } : {}),
    ...(report.run.job_url ? { job_url: report.run.job_url } : {}),
    ...(report.run.trace_url ? { trace_url: report.run.trace_url } : {}),
  };
}

/** What makes a row the latest of its kind: its project, stage and wave. */
const rowKind = (r: IndexEntry): string => `${r.project}\n${r.stage}\n${r.wave ?? ""}`;

/**
 * The first `rows` of a newest-first list, and after them the newest row of
 * each project, stage and wave the cut left out, so an index never loses the
 * latest state of anything (the estate page reads it).
 */
export function capIndex(reports: IndexEntry[], rows = INDEX_ROWS): IndexEntry[] {
  if (reports.length <= rows) return reports;
  const seen = new Set(reports.slice(0, rows).map(rowKind));
  const kept = reports.slice(0, rows);
  for (const r of reports.slice(rows)) {
    const kind = rowKind(r);
    if (seen.has(kind)) continue;
    seen.add(kind);
    kept.push(r);
  }
  return kept;
}

/** The index with `entry` added (or as it is, without one). A row at the same path is replaced, so a rerun does not list twice. Newest first, capped by capIndex. */
/**
 * A tf-drift row with its project's open drift carried over from the row
 * before it (that of the same commit too, which this row replaces): a row
 * that finds drift keeps when it was first found, and a row that finds none
 * after one that found some names when that drift was first found.
 */
export function withDriftSince(reports: IndexEntry[], entry: IndexEntry): IndexEntry {
  const before = reports
    .filter((r) => r.project === entry.project && r.stage === "tf-drift" && r.finished <= entry.finished && !(r.path === entry.path && r.finished === entry.finished))
    .sort((a, b) => (a.finished < b.finished ? 1 : -1))[0];
  const open = before && (before.changed ?? 0) > 0 ? { since: before.drift_since ?? before.finished, roots: before.drifted_roots ?? [] } : undefined;
  const { drift_since: _s, drift_cleared: _c, ...row } = entry;
  if ((entry.changed ?? 0) > 0) return { ...row, drift_since: open?.since ?? entry.finished };
  return open ? { ...row, drift_cleared: open } : row;
}

export function addToIndex(existing: string | undefined, entry?: IndexEntry): ReportIndex {
  let reports: IndexEntry[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Partial<ReportIndex>;
      if (Array.isArray(parsed.reports)) reports = parsed.reports;
    } catch {
      // An unreadable index is rebuilt from this run on.
    }
  }
  if (entry) reports = [...reports.filter((r) => r.path !== entry.path), entry.stage === "tf-drift" ? withDriftSince(reports, entry) : entry];
  reports.sort((a, b) => (a.finished < b.finished ? 1 : a.finished > b.finished ? -1 : a.path < b.path ? -1 : 1));
  return { schema: INDEX_SCHEMA, reports: capIndex(reports) };
}

export function renderIndexHtml(index: ReportIndex, title: string): string {
  const rows = index.reports.map((r) => {
    const t = r.totals;
    const more = (r.destroys_total ?? r.destroys.length) - r.destroys.length;
    const destroys = r.destroys.length ? `<details><summary>${r.destroys_total ?? r.destroys.length}</summary><ul>${r.destroys.map((d) => `<li><code>${esc(d)}</code></li>`).join("")}${more > 0 ? `<li>${more} more in the report</li>` : ""}</ul></details>` : "0";
    const commit = `<code>${esc(r.commit.slice(0, 12))}</code>`;
    const pr = r.pull_request ? (r.pull_request_url ? `<a href="${esc(r.pull_request_url)}">#${esc(r.pull_request)}</a>` : `#${esc(r.pull_request)}`) : "";
    const links = [
      `<a href="${esc(r.path)}/report.html">report</a>`,
      `<a href="${esc(r.path)}/report.json">json</a>`,
      ...(r.job_url ? [`<a href="${esc(r.job_url)}">job</a>`] : []),
      ...(r.trace_url ? [`<a href="${esc(r.trace_url)}">trace</a>`] : []),
    ];
    return `<tr><td>${esc(r.project)}</td><td>${r.commit_url ? `<a href="${esc(r.commit_url)}">${commit}</a>` : commit}</td><td>${pr}</td><td>${esc(r.stage)}${r.wave !== undefined ? ` wave ${r.wave}` : ""}</td><td>${esc(r.finished)}</td><td>${r.roots}</td><td>+${t.create} ~${t.update} -/+${t.replace} -${t.delete}${r.refused ? `, ${r.refused} refused` : ""}</td><td>${destroys}</td><td>${links.join(" ")}</td></tr>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
${TACO_ICON}
<style>${TACO_CSS}:root{--bg:#fbfbfa;--fg:#1d1d1b;--line:#deded8;--link:#1f5fbf}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--line:#34342f;--link:#8ab4ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px;overflow-x:auto}a{color:var(--link)}table{border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:4px 12px 4px 0;text-align:left;vertical-align:top}code{font:12.5px ui-monospace,Menlo,monospace}</style>
</head><body><main><h1 class="brand">${TACO_IMG}${esc(title)}</h1><p>${index.reports.length} reports, newest first.</p>
<table><tr><th>Project</th><th>Commit</th><th>Pull request</th><th>Stage</th><th>Finished</th><th>Roots</th><th>Changes</th><th>Destroys</th><th></th></tr>
${rows.join("\n")}
</table></main></body></html>
`;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const TYPES: Record<string, string> = { json: "application/json", html: "text/html; charset=utf-8", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8" };
const typeOf = (p: string): string => TYPES[p.split(".").pop() ?? ""] ?? "application/octet-stream";

export interface Uploaded {
  /** The run's key prefix in the bucket. */
  prefix: string;
  files: number;
  indexes: string[];
  /** The project's inventory, when a tf-apply wave's roots applied. */
  inventory?: string;
  /** The project's resource changes, when an applied root changed something. */
  changes?: string;
}

/** How many times an index is read and written again when another run wrote it in between. */
export const INDEX_TRIES = 8;

/** Between tries: a growing, jittered pause, so runs that collided do not collide again in step. */
const backoff = (attempt: number): Promise<void> => new Promise((r) => setTimeout(r, Math.round((50 + Math.random() * 100) * 2 ** Math.min(attempt, 5))));

export type Wait = (attempt: number) => Promise<void>;

/**
 * Write the JSON object at `key` that `build` makes from the copy read. The
 * write is conditional on that copy: If-Match its ETag, or If-None-Match `*`
 * when there was none. When another run wrote the object in between, the
 * write is refused, and the object is read and built again, up to
 * INDEX_TRIES times. A store that sends no ETag gets an unconditional write,
 * the last one winning.
 */
export async function updateJson<T>(s3: ObjectStore, key: string, build: (existing: string | undefined) => T, what: string, wait: Wait = backoff): Promise<{ value: T; etag?: string }> {
  for (let attempt = 1; ; attempt++) {
    const read = await s3.read(key);
    const value = build(read.body);
    const when = read.etag ? { ifMatch: read.etag } : read.body === undefined ? { ifNoneMatch: "*" as const } : undefined;
    try {
      const put = await s3.put(key, JSON.stringify(value, null, 2) + "\n", TYPES.json, when);
      return { value, ...(put.etag ? { etag: put.etag } : {}) };
    } catch (e) {
      if (!(e instanceof StoreConflict)) throw e;
      if (attempt >= INDEX_TRIES) throw new StoreError(`${key} changed under this run ${INDEX_TRIES} times in a row; ${what} was not added`);
      await wait(attempt);
    }
  }
}

/** Add `entry` to the index at `key`, conditional on the copy read (updateJson). */
export async function updateIndex(s3: ObjectStore, key: string, entry: IndexEntry, wait: Wait = backoff): Promise<{ index: ReportIndex; etag?: string }> {
  const { value, etag } = await updateJson(s3, key, (body) => addToIndex(body, entry), "its row", wait);
  return { index: value, ...(etag ? { etag } : {}) };
}

/** The key of a project's inventory: `<prefix>/<project>/inventory.json`. */
export const inventoryKey = (project: string, prefix = ""): string => joinKey(prefix, project, "inventory.json");

/** The key of a project's resource changes: `<prefix>/<project>/changes.json`. */
export const changesKey = (project: string, prefix = ""): string => joinKey(prefix, project, "changes.json");

/**
 * Write index.html from the index this run wrote, then check index.json
 * still has that ETag. When a later run has written it since, its page may
 * have gone up before this one, so the page is written again from the newer
 * index. Without ETags the page is written once.
 */
async function writeIndexHtml(s3: ObjectStore, at: string, title: string, index: ReportIndex, etag: string | undefined): Promise<void> {
  const join2 = (...p: string[]) => p.filter(Boolean).join("/");
  for (let attempt = 1; ; attempt++) {
    await s3.put(join2(at, "index.html"), renderIndexHtml(index, title), TYPES.html);
    if (!etag || attempt >= INDEX_TRIES) return;
    const now = await s3.read(join2(at, "index.json"));
    if (!now.etag || now.etag === etag || now.body === undefined) return;
    etag = now.etag;
    index = addToIndex(now.body, undefined);
  }
}

/**
 * Copy a run's report directory to the bucket, then add its row to the index
 * at the project's path and at the top of the prefix. Runs that finish at
 * the same moment each keep their row: see updateIndex.
 */
export async function uploadReport(s3: ObjectStore, dir: string, report: Report, prefix = "", wait: Wait = backoff): Promise<Uploaded> {
  const top = trim(prefix);
  const join2 = (...p: string[]) => p.filter(Boolean).join("/");
  const project = report.run.project;
  const run = runPath(report);
  const key = writableRunKey(report, top);
  const files = walk(dir);
  for (const f of files) await s3.put(join2(key, relative(dir, f).split("\\").join("/")), readFileSync(f), typeOf(f));
  if (report.run.trace_id) await s3.put(traceKey(report.run.trace_id, top), renderTracePage(report), TYPES.html);
  const indexes: string[] = [];
  for (const [at, path, title] of [
    [join2(top, project), run, `Plan reports: ${project}`],
    [top, join2(project, run), "Plan reports"],
  ] as const) {
    const key = join2(at, "index.json");
    const { index, etag } = await updateIndex(s3, key, indexEntry(report, path), wait);
    await writeIndexHtml(s3, at, title, index, etag);
    indexes.push(key);
  }
  // A tf-apply wave's roots that applied replace their resource lists in the project's inventory.
  const applied = inventoryRoots(report, run);
  let inventory: string | undefined;
  if (applied.length > 0) {
    inventory = inventoryKey(project, top);
    await updateJson(s3, inventory, (body) => addToInventory(body, applied), "its resources", wait);
  }
  const rows = changeRows(report, run);
  let changes: string | undefined;
  if (rows.length > 0) {
    changes = changesKey(project, top);
    await updateJson(s3, changes, (body) => addToChanges(body, rows), "its changes", wait);
  }
  return { prefix: key, files: files.length, indexes, ...(inventory ? { inventory } : {}), ...(changes ? { changes } : {}) };
}

/**
 * Copy files a later step changed in a run's report directory (respond
 * description's flag in note.md and report.html, its intent.json) over the
 * bucket's copy, so the bucket holds what the job's artifact holds.
 */
export async function copyToRun(s3: ObjectStore, dir: string, report: Report, files: string[], prefix = ""): Promise<string[]> {
  const key = writableRunKey(report, prefix);
  const put: string[] = [];
  for (const f of files) {
    const k = `${key}/${f.split("\\").join("/")}`;
    await s3.put(k, readFileSync(join(dir, f)), typeOf(f));
    put.push(k);
  }
  return put;
}
