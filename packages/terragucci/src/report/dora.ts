/**
 * The four DORA metrics, per project and for the estate, from records
 * terragucci already keeps in the reports bucket and from nothing else:
 *
 *   audit.jsonl   apply entries (applied or failed, with the wave's roots,
 *                 commit and set digest), approval requests and approvals
 *   index.json    tf-plan rows (when a change was first planned, and the
 *                 set digests its waves bind) and tf-drift rows (when drift
 *                 was found and cleared, and on which roots)
 *
 * Deployment frequency   applied waves per week
 * Lead time              first plan of the change to its applied wave, split
 *                        into before the gate, at the gate, after the gate
 * Change failure rate    failed applies, plus applied waves whose roots
 *                        drifted within DRIFT_WINDOW_SECONDS, over all applies.
 *                        A refused wave is the gate working and counts for
 *                        nothing.
 * Time to restore        a failed apply to the next apply that applied those
 *                        roots; drift found to the next drift check that
 *                        found none
 *
 * Every number covers the newest DORA_WEEKS weeks, Monday to Sunday in UTC,
 * and each week has its own row, so a reader sees the trend. Nothing is
 * compared to DORA's performance tiers: infrastructure ships less often than
 * an application does.
 */
import { samePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { METRIC } from "../dashboards/names";
import type { AuditEntry } from "./audit";
import { esc } from "./html";
import type { IndexEntry } from "./store";

export const DORA_SCHEMA = "terragucci.dora/v1";

/** How many weeks the metrics cover, the current one included. */
export const DORA_WEEKS = 8;

/** An applied wave whose roots drift within this long counts as a failed change. */
export const DRIFT_WINDOW_SECONDS = 7 * 86400;

/** The file beside the estate page. */
export const DORA_FILE = "dora.json";

export interface DoraLeadTime {
  /** Applied waves whose first plan was found. */
  changes: number;
  /** Medians in seconds; null when no change counts. */
  median_seconds: number | null;
  /** From the first plan to the wave reaching its gate, or to the apply when no gate held it. */
  before_gate_seconds: number | null;
  /** From the gate asking for an approval to the approval. */
  at_gate_seconds: number | null;
  /** From the approval to the wave applied. */
  after_gate_seconds: number | null;
}

export interface DoraWeek {
  /** The Monday the week starts on, YYYY-MM-DD. */
  week: string;
  deployments: number;
  applies: number;
  /** Failed applies and applied waves followed by drift. */
  failures: number;
  lead_time_seconds: number | null;
  restore_seconds: number | null;
}

export interface DoraMetrics {
  /** Applied waves in the window, and per week. */
  deployments: number;
  per_week: number;
  lead_time: DoraLeadTime;
  change_failure: { applies: number; failed: number; drifted: number; rate: number | null };
  /** Incidents restored in the window and their median; open ones are still failing or drifted. */
  restore: { restored: number; open: number; median_seconds: number | null; apply_restored: number; drift_restored: number };
  /** Oldest week first. */
  trend: DoraWeek[];
}

export interface DoraProject extends DoraMetrics {
  project: string;
}

export interface Dora {
  schema: typeof DORA_SCHEMA;
  generated: string;
  weeks: number;
  /** The first Monday the window holds, and when it ends. */
  window: { from: string; to: string };
  drift_window_seconds: number;
  /** Whether audit.jsonl was read. Without it there are no applies, so only drift counts. */
  audit: boolean;
  estate: DoraMetrics;
  projects: DoraProject[];
}

/** One project's records, as the estate command read them. */
export interface DoraSource {
  project: string;
  /** Its index rows. */
  rows: IndexEntry[];
}

const at = (iso: string): number => Date.parse(iso) || 0;
const secs = (from: number, to: number): number => Math.max(0, Math.round((to - from) / 1000));

/** The Monday, 00:00 UTC, of the week `t` falls in. */
export function weekStart(t: number): number {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** An applied or failed wave, from its apply entry. */
interface Apply {
  project: string;
  at: number;
  applied: boolean;
  gate: string;
  digest: string | null;
  commit?: string;
  roots: string[];
  failed: string[];
  approval?: string;
}

/** A change's lead time, ending when its wave applied. */
interface Lead {
  project: string;
  at: number;
  total: number;
  before: number;
  gate: number;
  after: number;
}

/** A failure that was restored, when it was. */
interface Restore {
  project: string;
  at: number;
  seconds: number;
  kind: "apply" | "drift";
}

/** A failed change: a failed apply, or an applied wave that drifted. */
interface Failure {
  project: string;
  at: number;
}

/** Apply entries that applied or failed, each once, oldest first. A waiting wave is not an apply yet; a refused one is the gate working. */
function appliesOf(entries: AuditEntry[]): Apply[] {
  const seen = new Set<string>();
  const out: Apply[] = [];
  for (const e of entries) {
    if (e.kind !== "apply" || (e.result !== "applied" && e.result !== "failed") || seen.has(e.id)) continue;
    seen.add(e.id);
    const d = e.detail ?? {};
    out.push({
      project: e.project,
      at: at(e.at),
      applied: e.result === "applied",
      gate: e.what,
      digest: e.digest,
      ...(typeof d.commit === "string" ? { commit: d.commit } : {}),
      roots: strings(d.roots),
      failed: strings(d.failed),
      ...(typeof d.approval === "string" ? { approval: d.approval } : {}),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The lead time of an applied wave. Its plan is the tf-plan row of the same
 * commit, or the one whose wave set digests hold the wave's digest (a pull
 * request's head, planned before the merge commit applied); the change
 * starts at the first plan of that row's pull request.
 */
function leadOf(a: Apply, plans: IndexEntry[], requests: AuditEntry[], approvals: Map<string, AuditEntry>): Lead | undefined {
  const before = plans.filter((r) => at(r.finished) <= a.at);
  const matched = before
    .filter((r) => (a.commit !== undefined && r.commit === a.commit) || (a.digest !== null && (r.wave_digests ?? []).some((d) => samePlanDigest(d, a.digest!))))
    .sort((x, y) => at(y.finished) - at(x.finished))[0];
  if (!matched) return undefined;
  const pr = matched.pull_request;
  const first = pr ? Math.min(...before.filter((r) => r.pull_request === pr).map((r) => at(r.finished))) : at(matched.finished);
  const asked = requests
    .filter((q) => q.project === a.project && q.what === a.gate && a.digest !== null && q.digest !== null && samePlanDigest(q.digest, a.digest) && at(q.at) <= a.at)
    .map((q) => at(q.at))
    .sort((x, y) => x - y)[0];
  const approved = a.approval ? approvals.get(a.approval) : undefined;
  const ok = approved ? Math.min(Math.max(at(approved.at), asked ?? first), a.at) : undefined;
  if (asked === undefined) return { project: a.project, at: a.at, total: secs(first, a.at), before: secs(first, a.at), gate: 0, after: 0 };
  const gateEnd = ok ?? asked;
  return { project: a.project, at: a.at, total: secs(first, a.at), before: secs(first, Math.max(first, asked)), gate: secs(asked, gateEnd), after: secs(gateEnd, a.at) };
}

/** Failed applies, each restored by the next apply that applied every root it failed on. A failure of roots already failing joins that incident. */
function applyRestores(applies: Apply[]): { restored: Restore[]; open: number } {
  const restored: Restore[] = [];
  const open = new Map<string, { start: number; roots: Set<string> }>();
  for (const a of applies) {
    if (!a.applied) {
      const roots = (a.failed.length ? a.failed : a.roots).filter((r) => !open.has(r));
      if (roots.length === 0) continue;
      const incident = { start: a.at, roots: new Set(roots) };
      for (const r of roots) open.set(r, incident);
      continue;
    }
    for (const r of a.roots) {
      const incident = open.get(r);
      if (!incident) continue;
      open.delete(r);
      incident.roots.delete(r);
      if (incident.roots.size === 0) restored.push({ project: a.project, at: a.at, seconds: secs(incident.start, a.at), kind: "apply" });
    }
  }
  return { restored, open: new Set(open.values()).size };
}

/** Drift as one incident: when it was first found, on which roots (empty for any root), and when a check first found none. */
interface DriftIncident {
  since: number;
  roots: Set<string>;
  closed?: number;
}

/**
 * The project's drift incidents, from its tf-drift rows oldest first. A row
 * carries when its drift was first found (`drift_since`), and a row that
 * cleared drift names it (`drift_cleared`), since a later check of the same
 * commit replaces the row that found it. A row written before those fields
 * existed opens drift at its own time and a clean row closes it.
 */
export function driftIncidents(drifts: IndexEntry[]): DriftIncident[] {
  const incidents = new Map<number, DriftIncident>();
  const get = (since: number): DriftIncident => {
    let i = incidents.get(since);
    if (!i) incidents.set(since, (i = { since, roots: new Set() }));
    return i;
  };
  let open: number | undefined;
  for (const r of [...drifts].sort((x, y) => at(x.finished) - at(y.finished))) {
    if ((r.changed ?? 0) > 0) {
      const since = r.drift_since ? at(r.drift_since) : (open ?? at(r.finished));
      for (const x of r.drifted_roots ?? []) get(since).roots.add(x);
      open = since;
    } else if (r.drift_cleared) {
      const i = get(at(r.drift_cleared.since));
      for (const x of r.drift_cleared.roots) i.roots.add(x);
      i.closed = Math.min(i.closed ?? Infinity, at(r.finished));
      if (open === i.since) open = undefined;
    } else if (open !== undefined) {
      const i = get(open);
      i.closed ??= at(r.finished);
      open = undefined;
    }
  }
  return [...incidents.values()].sort((a, b) => a.since - b.since);
}

/** Drift found, restored by the next drift check that found none. */
function driftRestores(project: string, incidents: DriftIncident[]): { restored: Restore[]; open: number } {
  const restored = incidents.filter((i) => i.closed !== undefined).map((i) => ({ project, at: i.closed!, seconds: secs(i.since, i.closed!), kind: "drift" as const }));
  return { restored, open: incidents.filter((i) => i.closed === undefined).length };
}

/**
 * Applied waves whose roots drifted within the window, before another apply
 * of those roots. Drift that names no roots matches any root of the project.
 */
function driftedApplies(applies: Apply[], incidents: DriftIncident[]): Set<Apply> {
  const out = new Set<Apply>();
  for (const a of applies) {
    if (!a.applied) continue;
    const hit = incidents.some((i) => {
      const t = i.since;
      if (t < a.at || t - a.at > DRIFT_WINDOW_SECONDS * 1000) return false;
      const shared = i.roots.size ? a.roots.filter((x) => i.roots.has(x)) : a.roots;
      // A later apply of a root before the drift was found is the one the drift follows.
      return shared.some((x) => !applies.some((b) => b !== a && b.applied && b.at > a.at && b.at <= t && b.roots.includes(x)));
    });
    if (hit) out.add(a);
  }
  return out;
}

/** What one project's records hold, every time in the record. */
interface Events {
  applies: Apply[];
  leads: Lead[];
  failures: Failure[];
  /** Applied waves whose roots drifted. */
  drifted: Set<Apply>;
  restores: Restore[];
  open: number;
}

function eventsOf(source: DoraSource, entries: AuditEntry[]): Events {
  const mine = entries.filter((e) => e.project === source.project);
  const applies = appliesOf(mine);
  const rows = source.rows.filter((r) => r.project === source.project);
  const plans = rows.filter((r) => r.stage === "tf-plan");
  const incidents = driftIncidents(rows.filter((r) => r.stage === "tf-drift"));
  const requests = mine.filter((e) => e.kind === "approval-requested");
  const approvals = new Map(mine.filter((e) => e.kind === "approval").map((e) => [e.id, e]));
  const leads = applies.filter((a) => a.applied).flatMap((a) => leadOf(a, plans, requests, approvals) ?? []);
  const drifted = driftedApplies(applies, incidents);
  const failures = applies.filter((a) => !a.applied || drifted.has(a)).map((a) => ({ project: a.project, at: a.at }));
  const ar = applyRestores(applies);
  const dr = driftRestores(source.project, incidents);
  return { applies, leads, failures, drifted, restores: [...ar.restored, ...dr.restored], open: ar.open + dr.open };
}

const merge = (all: Events[]): Events => ({
  applies: all.flatMap((e) => e.applies),
  leads: all.flatMap((e) => e.leads),
  failures: all.flatMap((e) => e.failures),
  drifted: new Set(all.flatMap((e) => [...e.drifted])),
  restores: all.flatMap((e) => e.restores),
  open: all.reduce((n, e) => n + e.open, 0),
});

/** The metrics over the window, and a row per week. Counts are of what happened in the window; open incidents are as of now. */
function metricsOf(ev: Events, from: number, now: number): DoraMetrics {
  const inside = <T extends { at: number }>(xs: T[]): T[] => xs.filter((x) => x.at >= from && x.at <= now);
  const applies = inside(ev.applies);
  const deployments = applies.filter((a) => a.applied).length;
  const failed = applies.filter((a) => !a.applied).length;
  const drift = applies.filter((a) => ev.drifted.has(a)).length;
  const leads = inside(ev.leads);
  const restores = inside(ev.restores);
  const trend: DoraWeek[] = [];
  for (let w = 0; w < DORA_WEEKS; w++) {
    const start = from + w * 7 * 86400 * 1000;
    const end = start + 7 * 86400 * 1000;
    const of = <T extends { at: number }>(xs: T[]): T[] => xs.filter((x) => x.at >= start && x.at < end);
    trend.push({
      week: new Date(start).toISOString().slice(0, 10),
      deployments: of(applies).filter((a) => a.applied).length,
      applies: of(applies).length,
      failures: of(inside(ev.failures)).length,
      lead_time_seconds: median(of(leads).map((l) => l.total)),
      restore_seconds: median(of(restores).map((r) => r.seconds)),
    });
  }
  return {
    deployments,
    per_week: Math.round((deployments / DORA_WEEKS) * 100) / 100,
    lead_time: {
      changes: leads.length,
      median_seconds: median(leads.map((l) => l.total)),
      before_gate_seconds: median(leads.map((l) => l.before)),
      at_gate_seconds: median(leads.map((l) => l.gate)),
      after_gate_seconds: median(leads.map((l) => l.after)),
    },
    change_failure: { applies: applies.length, failed, drifted: drift, rate: applies.length ? Math.round(((failed + drift) / applies.length) * 1000) / 1000 : null },
    restore: {
      restored: restores.length,
      open: ev.open,
      median_seconds: median(restores.map((r) => r.seconds)),
      apply_restored: restores.filter((r) => r.kind === "apply").length,
      drift_restored: restores.filter((r) => r.kind === "drift").length,
    },
    trend,
  };
}

/** The metrics of every project and of the estate. `entries` is the audit record, undefined when there is none. */
export function buildDora(sources: DoraSource[], entries: AuditEntry[] | undefined, now: Date): Dora {
  const end = now.getTime();
  const from = weekStart(end) - (DORA_WEEKS - 1) * 7 * 86400 * 1000;
  const events = sources.map((s) => eventsOf(s, entries ?? []));
  return {
    schema: DORA_SCHEMA,
    generated: now.toISOString(),
    weeks: DORA_WEEKS,
    window: { from: new Date(from).toISOString(), to: now.toISOString() },
    drift_window_seconds: DRIFT_WINDOW_SECONDS,
    audit: entries !== undefined,
    estate: metricsOf(merge(events), from, end),
    projects: sources.map((s, i) => ({ project: s.project, ...metricsOf(events[i], from, end) })),
  };
}

/** "3d 4h", "2h 10m", "5m", "40s": how long, to two units. */
export function duration(seconds: number | null): string {
  if (seconds === null) return "none";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

const rate = (r: number | null): string => (r === null ? "none" : `${Math.round(r * 1000) / 10}%`);

function row(name: string, m: DoraMetrics): string {
  const l = m.lead_time;
  const split = l.changes ? `<br><small>before the gate ${duration(l.before_gate_seconds)}, at the gate ${duration(l.at_gate_seconds)}, after it ${duration(l.after_gate_seconds)}</small>` : "";
  const c = m.change_failure;
  const r = m.restore;
  return `<tr><td>${name}</td><td>${m.per_week} <small>(${m.deployments} in ${DORA_WEEKS} weeks)</small></td><td>${duration(l.median_seconds)}${split}</td><td>${rate(c.rate)} <small>(${c.failed} failed, ${c.drifted} drifted, of ${c.applies})</small></td><td>${duration(r.median_seconds)} <small>(${r.restored} restored${r.open ? `, <span class="warn">${r.open} open</span>` : ""})</small></td></tr>`;
}

/** The estate page's delivery section: the definitions, each project's numbers and the estate's, and a row per week. */
export function renderDoraSection(dora: Dora, link: (project: string) => string): string {
  const weeks = dora.estate.trend.map(
    (w) => `<tr><td>${esc(w.week)}</td><td>${w.deployments}</td><td>${w.applies}</td><td>${w.failures}</td><td>${duration(w.lead_time_seconds)}</td><td>${duration(w.restore_seconds)}</td></tr>`,
  );
  return `<p>The newest ${dora.weeks} weeks, from the audit trail and each project's index${dora.audit ? "" : `. <span class="warn">No audit trail was read, so no apply counts: run terragucci audit before terragucci estate.</span>`}</p>
<dl class="defs">
<dt>Deployment frequency</dt><dd>Applied waves per week. Infrastructure ships less often than an application, so read it as a trend, not against a tier.</dd>
<dt>Lead time</dt><dd>The median time from a change's first plan to its wave applied: before the gate (the plan to the wave reaching its gate, or to the apply when no gate held it), at the gate (until the approval), and after it (until applied).</dd>
<dt>Change failure rate</dt><dd>Failed applies, plus applied waves whose roots drifted within ${duration(dora.drift_window_seconds)}, over all applies. A refused wave is the gate working and does not count.</dd>
<dt>Time to restore</dt><dd>The median time from a failed apply to the next apply of those roots, and from drift found to the next drift check that found none.</dd>
</dl>
<div class="scroll"><table id="dora"><tr><th>Project</th><th>Deployments per week</th><th>Lead time</th><th>Change failure rate</th><th>Time to restore</th></tr>
${[row("<b>Estate</b>", dora.estate), ...dora.projects.map((p) => row(link(p.project), p))].join("\n")}
</table></div>
<h3>By week</h3>
<div class="scroll"><table id="dora-weeks"><tr><th>Week of</th><th>Deployments</th><th>Applies</th><th>Failed changes</th><th>Lead time</th><th>Time to restore</th></tr>
${weeks.join("\n")}
</table></div>`;
}

/** The gauges `terragucci estate` sends, per project and for the estate (project `*`). */
export interface DoraGauge {
  name: string;
  unit: string;
  description: string;
  value: number;
  attributes: Record<string, string>;
}

export const DORA_METRIC = {
  deployments: METRIC.doraDeployments,
  leadTime: METRIC.doraLeadTime,
  failureRate: METRIC.doraFailureRate,
  restore: METRIC.doraRestore,
} as const;

export function doraGauges(dora: Dora): DoraGauge[] {
  const out: DoraGauge[] = [];
  const of = (project: string, m: DoraMetrics): void => {
    const a = { project };
    out.push({ name: DORA_METRIC.deployments, unit: "", description: `Applied waves per week over the newest ${dora.weeks} weeks.`, value: m.per_week, attributes: a });
    const l = m.lead_time;
    for (const [segment, v] of [["total", l.median_seconds], ["before_gate", l.before_gate_seconds], ["at_gate", l.at_gate_seconds], ["after_gate", l.after_gate_seconds]] as const) {
      if (v !== null) out.push({ name: DORA_METRIC.leadTime, unit: "s", description: "Median lead time from a change's first plan to its wave applied, and its split.", value: v, attributes: { ...a, segment } });
    }
    if (m.change_failure.rate !== null) out.push({ name: DORA_METRIC.failureRate, unit: "", description: "Failed applies and applied waves followed by drift, over all applies.", value: m.change_failure.rate, attributes: a });
    if (m.restore.median_seconds !== null) out.push({ name: DORA_METRIC.restore, unit: "s", description: "Median time from a failed apply or drift found to restored.", value: m.restore.median_seconds, attributes: a });
  };
  of("*", dora.estate);
  for (const p of dora.projects) of(p.project, p);
  return out;
}
