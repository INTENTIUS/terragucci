/**
 * Change history per resource address. A `tf-apply` wave reads, from each
 * root's plan once the root applied, what it did to each resource: created,
 * updated, replaced, deleted, imported, moved or forgot it, and for an update
 * or a replacement which top-level attributes changed, by name. The report
 * carries it as `roots[].applied_changes`, and the upload adds a row per
 * resource to `<prefix>/<project>/changes.json`.
 *
 * `terragucci estate` joins those rows to the audit trail (`audit.jsonl`,
 * ./audit.ts), whose apply entry names the approval each wave applied under,
 * and writes `history.json` and `history.html` beside the estate page: every
 * address with the applies that changed it, oldest first, each with its plan
 * digest, approver and time.
 *
 * For a choudoufu root the wave also lists each changed resource's record
 * versions with `choudoufu live-history` (../cdf-history.ts), and the history
 * keeps the newest listing per address: version ids and times, never what a
 * version holds.
 *
 * Values never leave planAppliedChanges: it compares an attribute's value
 * before and after to say whether it changed, and keeps only its name.
 */
import { createHash } from "node:crypto";
import type { AuditEntry } from "./audit";
import { esc } from "./html";
import { isObject } from "./redact";
import type { Report, ReportAppliedChange, ReportRecordVersions } from "./schema";
import { TACO_CSS, TACO_ICON, TACO_IMG } from "./taco";

export const CHANGES_SCHEMA = "terragucci.changes/v1";
export const HISTORY_SCHEMA = "terragucci.history/v1";

/** At most this many rows in a project's changes.json, newest kept. */
export const CHANGES_ROWS = 20000;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Whether an `after_unknown` mark marks anything. */
const anyTrue = (v: unknown): boolean => v === true || (Array.isArray(v) ? v.some(anyTrue) : isObject(v) ? Object.values(v).some(anyTrue) : false);

/** The top-level attributes an update or a replacement changes, by name: their value differs, or is known only after apply. */
function changedNames(change: Record<string, unknown>): string[] {
  const before = isObject(change.before) ? change.before : {};
  const after = isObject(change.after) ? change.after : {};
  const unknown = isObject(change.after_unknown) ? change.after_unknown : {};
  const names = new Set<string>();
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (!sameJson(before[k], after[k])) names.add(k);
  for (const [k, v] of Object.entries(unknown)) if (anyTrue(v)) names.add(k);
  return [...names].sort();
}

/** What a plan does to each managed resource, by address, without a value. No-ops that neither import nor move are left out. */
export function planAppliedChanges(plan: unknown): ReportAppliedChange[] {
  const list = isObject(plan) && Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const out: ReportAppliedChange[] = [];
  for (const r of list) {
    if (!isObject(r) || r.mode !== "managed" || typeof r.address !== "string" || typeof r.type !== "string" || r.deposed !== undefined) continue;
    const change = isObject(r.change) ? r.change : {};
    const raw = Array.isArray(change.actions) ? change.actions.map(String) : [];
    const actions: ReportAppliedChange["actions"] = [];
    if (typeof r.previous_address === "string" && r.previous_address !== r.address) actions.push("move");
    if (change.importing !== undefined && change.importing !== null) actions.push("import");
    if (raw.includes("delete") && raw.includes("create")) actions.push("replace");
    else if (raw.includes("create")) actions.push("create");
    else if (raw.includes("update")) actions.push("update");
    else if (raw.includes("delete")) actions.push("delete");
    else if (raw.includes("forget")) actions.push("forget");
    if (actions.length === 0) continue;
    const attributes = actions.includes("update") || actions.includes("replace") ? changedNames(change) : [];
    out.push({
      address: r.address,
      type: r.type,
      actions,
      attributes,
      ...(typeof r.previous_address === "string" && r.previous_address !== r.address ? { previous_address: r.previous_address } : {}),
    });
  }
  return out.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
}

/** One apply of one resource, as changes.json keeps it. */
export interface ChangeRow extends ReportAppliedChange {
  root: string;
  commit: string;
  wave?: number;
  finished: string;
  /** The wave's run directory, relative to the project's index. */
  path: string;
  /** The root's plan digest, the plan that applied. */
  plan_digest: string | null;
  /** The wave's set digest, the digest its approval binds. */
  set_digest: string | null;
  pull_request?: string;
}

export interface Changes {
  schema: typeof CHANGES_SCHEMA;
  /** Newest first. */
  changes: ChangeRow[];
}

/** The rows of a report: a `tf-apply` wave's applied roots, one per resource it changed. */
export function changeRows(report: Report, path: string): ChangeRow[] {
  if (report.run.stage !== "tf-apply") return [];
  const wave = report.waves[0];
  return report.roots.flatMap((r) =>
    (r.applied_changes ?? []).map((c) => ({
      ...c,
      root: r.path,
      commit: report.run.commit,
      ...(report.run.wave !== undefined ? { wave: report.run.wave } : {}),
      finished: report.run.finished,
      path,
      plan_digest: r.plan_digest,
      set_digest: wave?.set_digest ?? null,
      ...(report.run.pull_request ? { pull_request: report.run.pull_request } : {}),
    })),
  );
}

export function readChanges(text: string | undefined): Changes {
  if (text) {
    try {
      const parsed = JSON.parse(text) as Partial<Changes>;
      if (Array.isArray(parsed.changes)) return { schema: CHANGES_SCHEMA, changes: parsed.changes };
    } catch {
      // An unreadable file is rebuilt from the next apply on.
    }
  }
  return { schema: CHANGES_SCHEMA, changes: [] };
}

/** The rows with a run's rows added. Rows of the same run and root are replaced, so a rerun does not list twice. Newest first, capped at CHANGES_ROWS. */
export function addToChanges(existing: string | undefined, rows: ChangeRow[], cap = CHANGES_ROWS): Changes {
  const runs = new Set(rows.map((r) => `${r.path}\n${r.root}`));
  const kept = readChanges(existing).changes.filter((c) => !runs.has(`${c.path}\n${c.root}`));
  const all = [...kept, ...rows].sort((a, b) => Date.parse(b.finished) - Date.parse(a.finished) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : a.address < b.address ? -1 : 1));
  return { schema: CHANGES_SCHEMA, changes: all.slice(0, cap) };
}

/** The history page's anchor of one resource: its project, root and address, digested. */
export const historyId = (project: string, root: string, address: string): string => `h-${createHash("sha256").update(`${project}\n${root}\n${address}`).digest("hex").slice(0, 16)}`;

/** One apply in a resource's history. */
export interface HistoryApply {
  actions: ReportAppliedChange["actions"];
  attributes: string[];
  previous_address?: string;
  commit: string;
  wave?: number;
  finished: string;
  plan_digest: string | null;
  set_digest: string | null;
  /** Who approved the wave, from its apply entry in the audit trail. Null when no gate held the wave; absent when the audit trail has no entry for it. */
  approver?: string | null;
  /** The approval entry's id in the audit trail. */
  approval?: string;
  report?: string;
  pull_request?: string;
}

export interface HistoryResource {
  id: string;
  project: string;
  root: string;
  address: string;
  type: string;
  /** A choudoufu record's versions, newest first, as the newest apply that changed it listed them. */
  record_versions?: ReportRecordVersions;
  /** Oldest first. */
  applies: HistoryApply[];
}

export interface History {
  schema: typeof HISTORY_SCHEMA;
  generated: string;
  /** Whether an audit trail was read for the approvers. */
  audit: boolean;
  resources: HistoryResource[];
}

/** A project's changes, as the estate command read them. */
export interface ProjectChanges {
  project: string;
  changes: ChangeRow[];
  /** Where the project's run directories are, from the page. */
  base?: string;
}

/** The audit trail's apply entries, by project and run path. */
export function appliesByRun(entries: AuditEntry[]): Map<string, AuditEntry> {
  const out = new Map<string, AuditEntry>();
  for (const e of entries) {
    if (e.kind !== "apply" || e.evidence?.source !== "report" || typeof e.evidence.key !== "string") continue;
    const tail = e.evidence.key.replace(/\/report\.json$/, "");
    const i = tail.lastIndexOf(`${e.project}/`);
    if (i < 0) continue;
    out.set(`${e.project}\n${tail.slice(i + e.project.length + 1)}`, e);
  }
  return out;
}

/** Every address's applies, oldest first, with the approver the audit trail names for each wave. */
export function buildHistory(projects: ProjectChanges[], audit: AuditEntry[] | undefined, now: Date): History {
  const applies = appliesByRun(audit ?? []);
  const byResource = new Map<string, HistoryResource>();
  for (const p of projects) {
    const base = p.base === undefined || p.base === "" || p.base.endsWith("/") ? p.base : `${p.base}/`;
    for (const c of p.changes) {
      const id = historyId(p.project, c.root, c.address);
      const held = byResource.get(id) ?? { id, project: p.project, root: c.root, address: c.address, type: c.type, applies: [] };
      byResource.set(id, held);
      const entry = applies.get(`${p.project}\n${c.path}`);
      if (c.record_versions && (!held.record_versions || Date.parse(c.record_versions.read) >= Date.parse(held.record_versions.read))) held.record_versions = c.record_versions;
      held.applies.push({
        actions: c.actions,
        attributes: c.attributes,
        ...(c.previous_address ? { previous_address: c.previous_address } : {}),
        commit: c.commit,
        ...(c.wave !== undefined ? { wave: c.wave } : {}),
        finished: c.finished,
        plan_digest: c.plan_digest,
        set_digest: c.set_digest,
        ...(audit ? { approver: entry ? entry.who : undefined } : {}),
        ...(entry && typeof entry.detail?.approval === "string" ? { approval: entry.detail.approval } : {}),
        ...(base !== undefined ? { report: `${base}${c.path}/report.html` } : {}),
        ...(c.pull_request ? { pull_request: c.pull_request } : {}),
      });
    }
  }
  const resources = [...byResource.values()];
  for (const r of resources) {
    r.applies.sort((a, b) => Date.parse(a.finished) - Date.parse(b.finished));
    for (const a of r.applies) if (a.approver === undefined) delete a.approver;
  }
  resources.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : a.root < b.root ? -1 : a.root > b.root ? 1 : a.address < b.address ? -1 : 1));
  return { schema: HISTORY_SCHEMA, generated: now.toISOString(), audit: audit !== undefined, resources };
}

const ACTION_WORD: Record<ReportAppliedChange["actions"][number], string> = { create: "created", update: "updated", replace: "replaced", delete: "destroyed", import: "imported", move: "moved", forget: "forgotten" };

/** A choudoufu record's versions under its applies: a row per version, that the store keeps none, or why they were not listed. */
function renderRecordVersions(v: ReportRecordVersions): string {
  const when = `<time datetime="${esc(v.read)}">${esc(v.read)}</time>`;
  if (v.error !== undefined) return `\n<p class="record-versions" data-kept="error"><small>Record versions not listed at ${when}:</small></p><pre class="none">${esc(v.error)}</pre>`;
  if (!v.kept) return `\n<p class="record-versions" data-kept="false"><small>The ${esc(v.store ?? "")} record store keeps no past versions: it replaces a record in place.</small></p>`;
  const list = v.versions ?? [];
  const rows = list.map((x) => `<tr data-version="${esc(x.version_id)}"><td><time datetime="${esc(x.last_modified)}">${esc(x.last_modified)}</time></td><td><code>${esc(x.version_id)}</code></td><td>${x.deleted ? "deleted" : x.current ? "current" : ""}</td></tr>`);
  return `\n<p class="record-versions" data-kept="true" data-versions="${list.length}"><small>Its record: ${list.length} ${list.length === 1 ? "version" : "versions"}, newest first, listed ${when}. Reading one takes <code>aws s3api get-object --version-id</code>.</small></p>
<div class="scroll"><table><tr><th>Written</th><th>Version id</th><th></th></tr>
${rows.join("\n")}
</table></div>`;
}

/** The page: one section per address, its applies oldest first. The JSON rides inline, as on the estate page. */
export function renderHistoryHtml(history: History): string {
  const sections = history.resources.map((r) => {
    const rows = r.applies.map((a) => {
      const what = a.actions.map((x) => ACTION_WORD[x]).join(", ") + (a.previous_address ? ` from <code>${esc(a.previous_address)}</code>` : "");
      const attrs = a.attributes.length ? a.attributes.map((n) => `<code>${esc(n)}</code>`).join(", ") : "";
      const who = a.approver === undefined ? `<span class="none">${history.audit ? "not in the audit trail" : "no audit trail read"}</span>` : a.approver === null ? `<span class="none">no gate held it</span>` : esc(a.approver);
      const run = `${a.wave !== undefined ? `wave ${a.wave}` : "apply"} <code>${esc(a.commit.slice(0, 12))}</code>`;
      return `<tr><td><time datetime="${esc(a.finished)}">${esc(a.finished)}</time></td><td>${what}</td><td>${attrs}</td><td>${who}</td><td>${a.report ? `<a href="${esc(a.report)}">${run}</a>` : run}${a.pull_request ? ` #${esc(a.pull_request)}` : ""}</td><td><code>${esc(a.plan_digest ?? "")}</code></td></tr>`;
    });
    return `<section id="${r.id}"><h2><code>${esc(r.address)}</code></h2><p><small>${esc(r.project)}, root <code>${esc(r.root)}</code>, <code>${esc(r.type)}</code>: ${r.applies.length} ${r.applies.length === 1 ? "apply" : "applies"}</small></p>
<div class="scroll"><table><tr><th>Applied</th><th>What</th><th>Attributes changed</th><th>Approved by</th><th>Run</th><th>Plan digest</th></tr>
${rows.join("\n")}
</table></div>${r.record_versions ? renderRecordVersions(r.record_versions) : ""}</section>`;
  });
  const json = JSON.stringify(history).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>terragucci resource history</title>
${TACO_ICON}
<style>${TACO_CSS}:root{--bg:#fbfbfa;--fg:#1d1d1b;--dim:#6b6b64;--line:#deded8;--link:#1f5fbf}@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--dim:#a3a39a;--line:#34342f;--link:#8ab4ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:16px}a{color:var(--link)}h2{font-size:15px;margin:24px 0 2px}p{margin:0 0 6px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 12px 6px 0;text-align:left;vertical-align:top}th{color:var(--dim);font-weight:600}small,.none{color:var(--dim)}code,pre{font:12.5px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;margin:0 0 6px}section:target h2{color:var(--link)}</style>
</head><body><main><h1 class="brand">${TACO_IMG}Resource history</h1>
<p>Every apply that changed a resource, oldest first, from the reports in the bucket${history.audit ? " and the audit trail" : ""}, built <time datetime="${esc(history.generated)}">${esc(history.generated)}</time>. Attributes are named, never their values. <a href="estate.html">Estate</a></p>
${sections.length ? sections.join("\n") : `<p class="none">No apply has recorded a change yet.</p>`}
</main>
<script type="application/json" id="terragucci-history">${json}</script>
</body></html>
`;
}

/** The history JSON inlined in a page renderHistoryHtml wrote. */
export function readInlineHistory(html: string): History | undefined {
  const m = /<script type="application\/json" id="terragucci-history">([\s\S]*?)<\/script>/.exec(html);
  return m ? (JSON.parse(m[1]) as History) : undefined;
}
