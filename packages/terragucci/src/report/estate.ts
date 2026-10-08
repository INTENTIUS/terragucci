/**
 * The estate page: one self-contained `estate.html` and its `estate.json`,
 * built from the report index of every project and from nothing else. A row
 * of an index holds the counts a run's report summed (see IndexEntry), so the
 * page never opens a report, a plan's text or a root's plan JSON.
 *
 * Per project it shows the latest plan, the latest drift check, and the waves
 * of the newest commit that ran tf-apply: each wave's gate, how long a waiting
 * wave has waited, and the roots that failed. Below that, the newest runs
 * across every project.
 */
import { esc } from "./html";
import type { IndexEntry } from "./store";

export const ESTATE_SCHEMA = "terragucci.estate/v1";

/** How many of the newest runs the page lists. */
export const RECENT_RUNS = 20;

/** One project's index, as the estate command read it. */
export interface ProjectIndex {
  project: string;
  /** Its rows, newest first. Absent when there is no index yet or it could not be read. */
  reports?: IndexEntry[];
  /** Why the index could not be read. */
  error?: string;
  /** Where the project's index.html and run directories are, from the page: relative, or absolute on another bucket's address. Absent when the page cannot link them. */
  base?: string;
}

/** A run as the page shows it. */
export interface EstateRun {
  project: string;
  commit: string;
  stage: string;
  wave?: number;
  finished: string;
  roots: number;
  changed?: number;
  failed?: number;
  refused: number;
  totals: IndexEntry["totals"];
  destroys: number;
  approval?: IndexEntry["approval"];
  waiting_since?: string;
  applied?: string;
  /** The run's report.html, when the page can link it. */
  report?: string;
  pull_request?: string;
  pull_request_url?: string;
  job_url?: string;
}

export interface EstateWaiting {
  project: string;
  wave: number;
  commit: string;
  since: string;
  /** Seconds it had waited when the page was built. */
  age_seconds: number;
  report?: string;
}

export interface EstateProject {
  project: string;
  /** No index yet, or one that could not be read. */
  status: "ok" | "no-index" | "error";
  error?: string;
  /** The project's index.html, when the page can link it. */
  index?: string;
  plan?: EstateRun;
  drift?: EstateRun;
  /** The waves of the newest commit that ran tf-apply, by wave number. */
  apply?: { commit: string; waves: EstateRun[] };
  waiting: EstateWaiting[];
  /** Roots that drifted in the latest drift check. */
  drifted: number;
  /** Roots that failed in the latest plan, drift check and apply waves. */
  failed: number;
}

export interface Estate {
  schema: typeof ESTATE_SCHEMA;
  generated: string;
  totals: { projects: number; waiting: number; drifted_projects: number; drifted_roots: number; failed_roots: number; unreadable: number };
  projects: EstateProject[];
  /** The newest runs across every project, newest first. */
  recent: EstateRun[];
}

const at = (iso: string): number => Date.parse(iso) || 0;
const secondsSince = (iso: string, now: Date): number => Math.max(0, Math.round((now.getTime() - at(iso)) / 1000));

function run(e: IndexEntry, base: string | undefined): EstateRun {
  return {
    project: e.project,
    commit: e.commit,
    stage: e.stage,
    ...(e.wave !== undefined ? { wave: e.wave } : {}),
    finished: e.finished,
    roots: e.roots,
    ...(e.changed !== undefined ? { changed: e.changed } : {}),
    ...(e.failed !== undefined ? { failed: e.failed } : {}),
    refused: e.refused,
    totals: e.totals,
    destroys: e.destroys_total ?? e.destroys.length,
    ...(e.approval ? { approval: e.approval } : {}),
    ...(e.waiting_since ? { waiting_since: e.waiting_since } : {}),
    ...(e.applied ? { applied: e.applied } : {}),
    ...(base !== undefined ? { report: `${base}${e.path}/report.html` } : {}),
    ...(e.pull_request ? { pull_request: e.pull_request } : {}),
    ...(e.pull_request_url ? { pull_request_url: e.pull_request_url } : {}),
    ...(e.job_url ? { job_url: e.job_url } : {}),
  };
}

/** A base that ends in a slash, so a run's path can follow it. */
const dirOf = (base: string | undefined): string | undefined => (base === undefined || base === "" || base.endsWith("/") ? base : `${base}/`);

const newest = (rows: IndexEntry[]): IndexEntry | undefined => rows.reduce<IndexEntry | undefined>((a, r) => (!a || at(r.finished) > at(a.finished) ? r : a), undefined);

/** One project's state from its index rows. A row of another project (a top-of-prefix index) is left out. */
export function projectState(p: ProjectIndex, now: Date): EstateProject {
  const base = dirOf(p.base);
  const index = base !== undefined ? { index: `${base}index.html` } : {};
  if (p.error !== undefined) return { project: p.project, status: "error", error: p.error, ...index, waiting: [], drifted: 0, failed: 0 };
  if (!p.reports) return { project: p.project, status: "no-index", waiting: [], drifted: 0, failed: 0 };
  const rows = p.reports.filter((r) => r.project === p.project);
  const plan = newest(rows.filter((r) => r.stage === "tf-plan"));
  const drift = newest(rows.filter((r) => r.stage === "tf-drift"));
  const applies = rows.filter((r) => r.stage === "tf-apply");
  // The newest commit that ran tf-apply holds the estate's apply state; an older commit's waiting wave is behind it.
  const last = newest(applies);
  let apply: EstateProject["apply"];
  const waiting: EstateWaiting[] = [];
  if (last) {
    const byWave = new Map<number, IndexEntry>();
    for (const r of applies.filter((x) => x.commit === last.commit)) {
      const n = r.wave ?? 0;
      const held = byWave.get(n);
      if (!held || at(r.finished) > at(held.finished)) byWave.set(n, r);
    }
    const waves = [...byWave.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    apply = { commit: last.commit, waves: waves.map((r) => run(r, base)) };
    for (const r of waves) {
      if (r.approval !== "waiting") continue;
      const since = r.waiting_since ?? r.finished;
      waiting.push({
        project: p.project,
        wave: r.wave ?? 0,
        commit: r.commit,
        since,
        age_seconds: secondsSince(since, now),
        ...(base !== undefined ? { report: `${base}${r.path}/report.html` } : {}),
      });
    }
  }
  const failedIn = (r: IndexEntry | undefined): number => r?.failed ?? 0;
  return {
    project: p.project,
    status: "ok",
    ...index,
    ...(plan ? { plan: run(plan, base) } : {}),
    ...(drift ? { drift: run(drift, base) } : {}),
    ...(apply ? { apply } : {}),
    waiting,
    drifted: drift?.changed ?? 0,
    failed: failedIn(plan) + failedIn(drift) + (apply ? apply.waves.reduce((n, w) => n + (w.failed ?? 0), 0) : 0),
  };
}

/** The estate from every project's index. Projects keep the order given. */
export function buildEstate(indexes: ProjectIndex[], now: Date = new Date()): Estate {
  const projects = indexes.map((p) => projectState(p, now));
  const recent = indexes
    .flatMap((p) => (p.reports ?? []).filter((r) => r.project === p.project).map((r) => ({ r, base: dirOf(p.base) })))
    .sort((a, b) => at(b.r.finished) - at(a.r.finished) || (a.r.path < b.r.path ? -1 : 1))
    .slice(0, RECENT_RUNS)
    .map(({ r, base }) => run(r, base));
  return {
    schema: ESTATE_SCHEMA,
    generated: now.toISOString(),
    totals: {
      projects: projects.length,
      waiting: projects.reduce((n, p) => n + p.waiting.length, 0),
      drifted_projects: projects.filter((p) => p.drifted > 0).length,
      drifted_roots: projects.reduce((n, p) => n + p.drifted, 0),
      failed_roots: projects.reduce((n, p) => n + p.failed, 0),
      unreadable: projects.filter((p) => p.status === "error").length,
    },
    projects,
    recent,
  };
}

/** "3d 4h", "2h 10m", "5m": how long, to two units. */
export function age(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const changes = (r: EstateRun): string => {
  const t = r.totals;
  return `+${t.create} ~${t.update} -/+${t.replace} -${t.delete}`;
};

const link = (href: string | undefined, text: string): string => (href ? `<a href="${esc(href)}">${text}</a>` : text);

/** How long ago; the page's script moves it forward while the page is open. */
const when = (iso: string, now: Date): string => `<time datetime="${esc(iso)}">${esc(age(secondsSince(iso, now)))} ago</time>`;

/** How long since, as a duration ("waiting 2h 10m"). */
const lasting = (iso: string, now: Date): string => `<time datetime="${esc(iso)}" data-for>${esc(age(secondsSince(iso, now)))}</time>`;

const short = (commit: string): string => `<code>${esc(commit.slice(0, 12))}</code>`;

function stageCell(r: EstateRun | undefined, now: Date, drift = false): string {
  if (!r) return `<td class="none">none yet</td>`;
  const bits = [drift ? `${r.changed ?? 0} of ${r.roots} roots drifted` : `${r.roots} roots, ${changes(r)}`];
  if (r.failed) bits.push(`<span class="bad">${r.failed} failed</span>`);
  if (r.refused) bits.push(`${r.refused} refused`);
  return `<td${drift && (r.changed ?? 0) > 0 ? ` class="warn"` : ""}>${link(r.report, bits.join(", "))}<br><small>${short(r.commit)} ${when(r.finished, now)}</small></td>`;
}

function applyCell(p: EstateProject, now: Date): string {
  if (!p.apply) return `<td class="none">none yet</td>`;
  const waves = p.apply.waves.map((w) => {
    const state = w.approval === "waiting"
      ? `<span class="warn">waiting ${lasting(w.waiting_since ?? w.finished, now)}</span>`
      : w.failed
        ? `<span class="bad">${w.failed} failed</span>`
        : w.applied
          ? "applied"
          : w.approval ?? "ran";
    return `<li>${link(w.report, `wave ${w.wave ?? 0}`)}: ${state}</li>`;
  });
  return `<td><ul>${waves.join("")}</ul><small>${short(p.apply.commit)}</small></td>`;
}

/**
 * The page. Its numbers are in the HTML, so it reads with scripts off; a
 * small script only moves the "ago" times forward while it is open, and the
 * estate JSON rides inline for a reader that wants it.
 */
export function renderEstateHtml(estate: Estate): string {
  const now = new Date(estate.generated);
  const t = estate.totals;
  const tiles = [
    [t.projects, "projects"],
    [t.waiting, t.waiting === 1 ? "wave waiting" : "waves waiting"],
    [t.drifted_projects, t.drifted_projects === 1 ? "project drifted" : "projects drifted"],
    [t.failed_roots, t.failed_roots === 1 ? "root failed" : "roots failed"],
  ].map(([n, label]) => `<div class="tile${Number(n) > 0 && label !== "projects" ? " hot" : ""}"><b>${n}</b><span>${label}</span></div>`);
  const waiting = estate.projects.flatMap((p) => p.waiting).sort((a, b) => b.age_seconds - a.age_seconds);
  const waitingRows = waiting.map((w) => `<tr><td>${esc(w.project)}</td><td>${link(w.report, `wave ${w.wave}`)}</td><td>${short(w.commit)}</td><td>${lasting(w.since, now)}</td></tr>`);
  const projectRows = estate.projects.map((p) => {
    const name = link(p.index, esc(p.project));
    if (p.status === "no-index") return `<tr><td>${name}</td><td colspan="3" class="none">no runs in the bucket yet</td></tr>`;
    if (p.status === "error") return `<tr><td>${name}</td><td colspan="3" class="bad">the index could not be read: ${esc(p.error ?? "")}</td></tr>`;
    return `<tr><td>${name}</td>${stageCell(p.plan, now)}${stageCell(p.drift, now, true)}${applyCell(p, now)}</tr>`;
  });
  const recentRows = estate.recent.map((r) => {
    const pr = r.pull_request ? link(r.pull_request_url, `#${esc(r.pull_request)}`) : "";
    const state = r.approval === "waiting" ? `<span class="warn">waiting</span>` : r.failed ? `<span class="bad">${r.failed} failed</span>` : r.applied ? "applied" : r.stage === "tf-drift" ? `${r.changed ?? 0} drifted` : "";
    return `<tr><td>${esc(r.project)}</td><td>${link(r.report, `${esc(r.stage)}${r.wave !== undefined ? ` wave ${r.wave}` : ""}`)}</td><td>${short(r.commit)}</td><td>${pr}</td><td>${changes(r)}</td><td>${state}</td><td>${when(r.finished, now)}</td>${r.job_url ? `<td><a href="${esc(r.job_url)}">job</a></td>` : "<td></td>"}</tr>`;
  });
  // The JSON is inert data in a script tag; "</" is escaped so no value can close it.
  const json = JSON.stringify(estate).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>terragucci estate</title>
<style>:root{--bg:#fbfbfa;--fg:#1d1d1b;--dim:#6b6b64;--line:#deded8;--link:#1f5fbf;--warn:#9a5b00;--bad:#b3261e;--tile:#f0f0ec}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--dim:#a3a39a;--line:#34342f;--link:#8ab4ff;--warn:#f0b35a;--bad:#ff8a80;--tile:#1f1f1d}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px}a{color:var(--link)}h2{font-size:16px;margin:24px 0 8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.tile{background:var(--tile);border-radius:6px;padding:10px 12px}.tile b{display:block;font-size:24px}.tile span{color:var(--dim)}.tile.hot b{color:var(--warn)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 12px 6px 0;text-align:left;vertical-align:top}th{color:var(--dim);font-weight:600}ul{margin:0;padding-left:16px}small,.none{color:var(--dim)}.warn{color:var(--warn)}.bad{color:var(--bad)}code{font:12.5px ui-monospace,Menlo,monospace}</style>
</head><body><main><h1>Estate</h1>
<p>${estate.projects.length} projects, built from their report indexes <time datetime="${esc(estate.generated)}">${esc(estate.generated)}</time>.</p>
<div class="tiles">${tiles.join("")}</div>
<h2>Waiting for an approval</h2>
${waitingRows.length ? `<div class="scroll"><table><tr><th>Project</th><th>Wave</th><th>Commit</th><th>Waiting for</th></tr>\n${waitingRows.join("\n")}\n</table></div>` : `<p class="none">No wave is waiting.</p>`}
<h2>Projects</h2>
<div class="scroll"><table><tr><th>Project</th><th>Latest plan</th><th>Latest drift check</th><th>Apply waves</th></tr>
${projectRows.join("\n")}
</table></div>
<h2>Recent runs</h2>
${recentRows.length ? `<div class="scroll"><table><tr><th>Project</th><th>Stage</th><th>Commit</th><th>Pull request</th><th>Changes</th><th></th><th>Finished</th><th></th></tr>\n${recentRows.join("\n")}\n</table></div>` : `<p class="none">No runs yet.</p>`}
</main>
<script type="application/json" id="terragucci-estate">${json}</script>
<script>(function(){function f(s){var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?d+"d "+h+"h":h>0?h+"h "+m+"m":m+"m"}var n=Date.now();document.querySelectorAll("td time[datetime]").forEach(function(t){var s=Math.max(0,Math.round((n-Date.parse(t.getAttribute("datetime")))/1000));if(!isNaN(s))t.textContent=f(s)+(t.hasAttribute("data-for")?"":" ago")})})()</script>
</body></html>
`;
}

/** The estate JSON inlined in a page renderEstateHtml wrote. */
export function readInlineEstate(html: string): Estate | undefined {
  const m = /<script type="application\/json" id="terragucci-estate">([\s\S]*?)<\/script>/.exec(html);
  return m ? (JSON.parse(m[1]) as Estate) : undefined;
}
