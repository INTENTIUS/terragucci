/**
 * Where a report is kept. Locally (the CI artifact), a run's directory holds
 * `report.json`, `report.html`, `note.md`, `summary.txt`,
 * `gitlab-terraform.json` and `roots/<root>/plan.{txt,json}`. With
 * `reports.bucket`, the same files are copied to
 * `<prefix>/<project>/<yyyy>/<mm>/<commit>/<stage>[-wave-N]/`, and the
 * index at the project's path and at the top of the prefix gains a row.
 * Links inside a report are relative, so they resolve in both layouts.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { renderHtml } from "./html";
import type { S3Client } from "./s3";
import type { Report } from "./schema";
import { renderGitLabTerraform, renderNote, renderText, type NoteOptions } from "./views";

/** Write a run's report directory. `plans` maps each root to its full plan text and redacted JSON. */
export function writeReportDir(dir: string, report: Report, plans: Map<string, { text?: string; json?: string }>, note: NoteOptions = {}): string[] {
  const files: Record<string, string> = {
    "report.json": JSON.stringify(report, null, 2) + "\n",
    "report.html": renderHtml(report),
    "note.md": renderNote(report, note),
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
  /** Every destroy and replacement, as `root: address`. */
  destroys: string[];
}

export interface ReportIndex {
  schema: typeof INDEX_SCHEMA;
  reports: IndexEntry[];
}

export function indexEntry(report: Report, path: string): IndexEntry {
  const t = report.totals;
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
    destroys: report.named.filter((n) => n.action === "delete" || n.action === "replace").map((n) => `${n.root}: ${n.address}`),
  };
}

/** The index with `entry` added. A row at the same path is replaced, so a rerun does not list twice. Newest first. */
export function addToIndex(existing: string | undefined, entry: IndexEntry): ReportIndex {
  let reports: IndexEntry[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as Partial<ReportIndex>;
      if (Array.isArray(parsed.reports)) reports = parsed.reports;
    } catch {
      // An unreadable index is rebuilt from this run on.
    }
  }
  reports = reports.filter((r) => r.path !== entry.path);
  reports.push(entry);
  reports.sort((a, b) => (a.finished < b.finished ? 1 : a.finished > b.finished ? -1 : a.path < b.path ? -1 : 1));
  return { schema: INDEX_SCHEMA, reports };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderIndexHtml(index: ReportIndex, title: string): string {
  const rows = index.reports.map((r) => {
    const t = r.totals;
    const destroys = r.destroys.length ? `<details><summary>${r.destroys.length}</summary><ul>${r.destroys.map((d) => `<li><code>${esc(d)}</code></li>`).join("")}</ul></details>` : "0";
    return `<tr><td>${esc(r.project)}</td><td><code>${esc(r.commit.slice(0, 12))}</code></td><td>${esc(r.stage)}${r.wave !== undefined ? ` wave ${r.wave}` : ""}</td><td>${esc(r.finished)}</td><td>${r.roots}</td><td>+${t.create} ~${t.update} -/+${t.replace} -${t.delete}${r.refused ? `, ${r.refused} refused` : ""}</td><td>${destroys}</td><td><a href="${esc(r.path)}/report.html">report</a> <a href="${esc(r.path)}/report.json">json</a></td></tr>`;
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<style>:root{--bg:#fbfbfa;--fg:#1d1d1b;--line:#deded8;--link:#1f5fbf}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--line:#34342f;--link:#8ab4ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px;overflow-x:auto}a{color:var(--link)}table{border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:4px 12px 4px 0;text-align:left;vertical-align:top}code{font:12.5px ui-monospace,Menlo,monospace}</style>
</head><body><main><h1>${esc(title)}</h1><p>${index.reports.length} reports, newest first.</p>
<table><tr><th>Project</th><th>Commit</th><th>Stage</th><th>Finished</th><th>Roots</th><th>Changes</th><th>Destroys</th><th></th></tr>
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
}

/**
 * Copy a run's report directory to the bucket, then rewrite the index at
 * the project's path and at the top of the prefix. Two runs finishing at
 * the same moment can race on an index; the later write wins, and the next
 * upload's row is added to it.
 */
export async function uploadReport(s3: S3Client, dir: string, report: Report, prefix = ""): Promise<Uploaded> {
  const top = prefix.replace(/^\/+|\/+$/g, "");
  const join2 = (...p: string[]) => p.filter(Boolean).join("/");
  const project = report.run.project;
  const run = runPath(report);
  const runKey = join2(top, project, run);
  const files = walk(dir);
  for (const f of files) await s3.put(join2(runKey, relative(dir, f).split("\\").join("/")), readFileSync(f), typeOf(f));
  const indexes: string[] = [];
  for (const [at, path, title] of [
    [join2(top, project), run, `Plan reports: ${project}`],
    [top, join2(project, run), "Plan reports"],
  ] as const) {
    const key = join2(at, "index.json");
    const index = addToIndex(await s3.get(key), indexEntry(report, path));
    await s3.put(key, JSON.stringify(index, null, 2) + "\n", TYPES.json);
    await s3.put(join2(at, "index.html"), renderIndexHtml(index, title), TYPES.html);
    indexes.push(key);
  }
  return { prefix: runKey, files: files.length, indexes };
}
