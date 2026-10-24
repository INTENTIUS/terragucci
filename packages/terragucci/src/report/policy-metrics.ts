/**
 * Policy metrics, per project and for the estate, from the audit record
 * (`audit.jsonl`) and nothing else, plus the drift the index rows found when
 * the estate command has them:
 *
 *   denials       one per root a wave's policy denied, counted once per wave
 *                 plan (project, gate, set digest, root): a `refused` entry
 *                 with result `denied-by-policy` names the roots and their
 *                 rules, and an `apply` entry's `overrides` names the denied
 *                 roots an override let through
 *   override rate denials an override let through, over all denials
 *   requests      `override-requested` lines on the ledger (a denial someone
 *                 may override), each answered by the first `override` of the
 *                 same root and digest: the turnaround is the time between,
 *                 and an unanswered one is open until its `expires`, then
 *                 expired
 *   blocked       refused waves, once per project, gate, set digest and
 *                 reason: changes stopped before they deployed
 *   found after   failed applies, writes outside terragucci
 *                 (`unrecorded-write`), and drift found by drift checks
 *
 * The window is DORA's: the newest DORA_WEEKS weeks, with a row per week.
 */
import type { AuditEntry } from "./audit";
import { DORA_WEEKS, driftIncidents, duration, median, weekStart } from "./dora";
import { esc } from "./html";
import type { IndexEntry } from "./store";

export const POLICY_METRICS_SCHEMA = "terragucci.policy-metrics/v1";

/** The file beside the estate page. */
export const POLICY_METRICS_FILE = "policy-metrics.json";

/** The rule a denial with no rule id is counted under. */
export const NO_RULE = "(no rule id)";

export interface PolicyRuleCount {
  rule: string;
  denials: number;
  overridden: number;
}

export interface PolicyWeek {
  /** The Monday the week starts on, YYYY-MM-DD. */
  week: string;
  denials: number;
  overridden: number;
  /** overridden over denials; null with no denial. */
  override_rate: number | null;
  /** Overrides written to the ledger that week. */
  overrides: number;
  blocked: number;
  found_after: number;
}

export interface PolicyMetricSet {
  /** Roots a wave's policy denied, each wave plan once. */
  denials: number;
  /** Of those, the ones an override let through. */
  overridden: number;
  override_rate: number | null;
  /** Most denials first. */
  rules: PolicyRuleCount[];
  /** The ledger's denials someone may override, and their answers. */
  requests: {
    requested: number;
    overridden: number;
    /** Unanswered and not yet expired, as of now. */
    open: number;
    /** Unanswered past `expires`. */
    expired: number;
    /** Overrides a commit removed. */
    revoked: number;
    /** From the request to its override: the median and the longest, in seconds. */
    turnaround_median_seconds: number | null;
    turnaround_max_seconds: number | null;
    /** How long the open ones have waited: the median and the oldest. */
    open_age_median_seconds: number | null;
    open_age_max_seconds: number | null;
  };
  /** Changes stopped before they deployed against problems found after. */
  blocked: { waves: number; policy: number; other: number; by_reason: Record<string, number> };
  found_after: { failed_applies: number; unrecorded_writes: number; drift: number | null; total: number };
  /** blocked over blocked plus found after; null when both are zero. */
  blocked_share: number | null;
  /** Oldest week first. */
  trend: PolicyWeek[];
}

export interface PolicyMetricsProject extends PolicyMetricSet {
  project: string;
}

export interface PolicyMetrics {
  schema: typeof POLICY_METRICS_SCHEMA;
  generated: string;
  weeks: number;
  window: { from: string; to: string };
  /** Whether audit.jsonl was read. Without it, only drift counts. */
  audit: boolean;
  /** Whether drift checks were read; without them `found_after.drift` is null. */
  drift: boolean;
  estate: PolicyMetricSet;
  projects: PolicyMetricsProject[];
}

/** One project, and its index rows when the caller read them. */
export interface PolicySource {
  project: string;
  rows?: IndexEntry[];
}

const at = (iso: string): number => Date.parse(iso) || 0;
const secs = (from: number, to: number): number => Math.max(0, Math.round((to - from) / 1000));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const ratio = (n: number, d: number): number | null => (d ? Math.round((n / d) * 1e6) / 1e6 : null);

interface Denial {
  project: string;
  at: number;
  rules: string[];
  overridden: boolean;
}

interface Request {
  project: string;
  at: number;
  expires?: number;
  answered?: number;
}

interface Stamp {
  project: string;
  at: number;
}

interface Blocked extends Stamp {
  reason: string;
}

interface Events {
  denials: Denial[];
  requests: Request[];
  overrides: Stamp[];
  revoked: Stamp[];
  blocked: Blocked[];
  failed: Stamp[];
  unrecorded: Stamp[];
  drift: Stamp[];
}

/** The denials of the record: one per project, gate, set digest and root, at its first wave; overridden when any wave applied it under an override. */
function denialsOf(entries: AuditEntry[]): Denial[] {
  const out = new Map<string, Denial>();
  const add = (e: AuditEntry, root: string, rules: string[], overridden: boolean): void => {
    const k = [e.project, e.what, e.digest ?? "", root].join("\n");
    const d = out.get(k);
    if (!d) {
      out.set(k, { project: e.project, at: at(e.at), rules: [...new Set(rules)].sort(), overridden });
      return;
    }
    d.at = Math.min(d.at, at(e.at));
    d.overridden ||= overridden;
    if (d.rules.length === 0) d.rules = [...new Set(rules)].sort();
  };
  for (const e of entries) {
    const detail = e.detail ?? {};
    if (e.kind === "refused" && e.result === "denied-by-policy") {
      const byRoot = detail.rules && typeof detail.rules === "object" && !Array.isArray(detail.rules) ? (detail.rules as Record<string, unknown>) : {};
      for (const root of strings(detail.denied)) add(e, root, strings(byRoot[root]), false);
    } else if (e.kind === "apply" && Array.isArray(detail.overrides)) {
      for (const o of detail.overrides as { root?: unknown; rules?: unknown }[]) if (typeof o?.root === "string") add(e, o.root, strings(o.rules), true);
    }
  }
  return [...out.values()];
}

/** The ledger's denials someone may override, each answered by the first override of its root and digest written after it. */
function requestsOf(entries: AuditEntry[]): Request[] {
  const key = (e: AuditEntry): string => [e.project, e.what, e.digest ?? ""].join("\n");
  const overrides = new Map<string, number[]>();
  for (const e of entries) if (e.kind === "override") overrides.set(key(e), [...(overrides.get(key(e)) ?? []), at(e.at)]);
  const first = new Map<string, AuditEntry>();
  for (const e of entries) {
    if (e.kind !== "override-requested") continue;
    const seen = first.get(key(e));
    if (!seen || at(e.at) < at(seen.at)) first.set(key(e), e);
  }
  return [...first.entries()].map(([k, e]) => {
    const asked = at(e.at);
    const answered = (overrides.get(k) ?? []).filter((t) => t >= asked).sort((a, b) => a - b)[0];
    const expires = typeof e.detail?.expires === "string" ? at(e.detail.expires) : undefined;
    return { project: e.project, at: asked, ...(expires ? { expires } : {}), ...(answered !== undefined ? { answered } : {}) };
  });
}

/** Refused waves, once per project, gate, set digest and reason. */
function blockedOf(entries: AuditEntry[]): Blocked[] {
  const out = new Map<string, Blocked>();
  for (const e of entries) {
    if (e.kind !== "refused") continue;
    const k = [e.project, e.what, e.digest ?? e.id, e.result].join("\n");
    const b = out.get(k);
    if (!b || at(e.at) < b.at) out.set(k, { project: e.project, at: at(e.at), reason: e.result });
  }
  return [...out.values()];
}

function eventsOf(source: PolicySource, entries: AuditEntry[]): Events {
  const mine = entries.filter((e) => e.project === source.project);
  const once = (kind: string, result?: string): Stamp[] => {
    const ids = new Set<string>();
    return mine.filter((e) => e.kind === kind && (result === undefined || e.result === result) && !ids.has(e.id) && ids.add(e.id)).map((e) => ({ project: e.project, at: at(e.at) }));
  };
  const drifts = (source.rows ?? []).filter((r) => r.project === source.project && r.stage === "tf-drift");
  return {
    denials: denialsOf(mine),
    requests: requestsOf(mine),
    overrides: once("override"),
    revoked: once("override-revoked"),
    blocked: blockedOf(mine),
    failed: once("apply", "failed"),
    unrecorded: once("unrecorded-write"),
    drift: driftIncidents(drifts).map((i) => ({ project: source.project, at: i.since })),
  };
}

const merge = (all: Events[]): Events => ({
  denials: all.flatMap((e) => e.denials),
  requests: all.flatMap((e) => e.requests),
  overrides: all.flatMap((e) => e.overrides),
  revoked: all.flatMap((e) => e.revoked),
  blocked: all.flatMap((e) => e.blocked),
  failed: all.flatMap((e) => e.failed),
  unrecorded: all.flatMap((e) => e.unrecorded),
  drift: all.flatMap((e) => e.drift),
});

function rulesOf(denials: Denial[]): PolicyRuleCount[] {
  const counts = new Map<string, PolicyRuleCount>();
  for (const d of denials) {
    for (const rule of d.rules.length ? d.rules : [NO_RULE]) {
      const c = counts.get(rule) ?? { rule, denials: 0, overridden: 0 };
      c.denials++;
      if (d.overridden) c.overridden++;
      counts.set(rule, c);
    }
  }
  return [...counts.values()].sort((a, b) => b.denials - a.denials || a.rule.localeCompare(b.rule));
}

const max = (xs: number[]): number | null => (xs.length ? Math.max(...xs) : null);

function metricsOf(ev: Events, from: number, now: number, drift: boolean): PolicyMetricSet {
  const inside = <T extends { at: number }>(xs: T[], start = from, end = now + 1): T[] => xs.filter((x) => x.at >= start && x.at < end);
  const denials = inside(ev.denials);
  const overridden = denials.filter((d) => d.overridden).length;
  const requests = inside(ev.requests);
  const answered = requests.filter((r) => r.answered !== undefined);
  const unanswered = requests.filter((r) => r.answered === undefined);
  const open = unanswered.filter((r) => r.expires === undefined || r.expires > now);
  const turnaround = answered.map((r) => secs(r.at, r.answered!));
  const ages = open.map((r) => secs(r.at, now));
  const blocked = inside(ev.blocked);
  const byReason: Record<string, number> = {};
  for (const b of blocked) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1;
  const policy = byReason["denied-by-policy"] ?? 0;
  const failed = inside(ev.failed).length;
  const unrecorded = inside(ev.unrecorded).length;
  const drifted = drift ? inside(ev.drift).length : null;
  const after = failed + unrecorded + (drifted ?? 0);
  const trend: PolicyWeek[] = [];
  for (let w = 0; w < DORA_WEEKS; w++) {
    const start = from + w * 7 * 86400 * 1000;
    const end = Math.min(start + 7 * 86400 * 1000, now + 1);
    const d = inside(ev.denials, start, end);
    const o = d.filter((x) => x.overridden).length;
    trend.push({
      week: new Date(start).toISOString().slice(0, 10),
      denials: d.length,
      overridden: o,
      override_rate: ratio(o, d.length),
      overrides: inside(ev.overrides, start, end).length,
      blocked: inside(ev.blocked, start, end).length,
      found_after: inside(ev.failed, start, end).length + inside(ev.unrecorded, start, end).length + (drift ? inside(ev.drift, start, end).length : 0),
    });
  }
  return {
    denials: denials.length,
    overridden,
    override_rate: ratio(overridden, denials.length),
    rules: rulesOf(denials),
    requests: {
      requested: requests.length,
      overridden: answered.length,
      open: open.length,
      expired: unanswered.length - open.length,
      revoked: inside(ev.revoked).length,
      turnaround_median_seconds: median(turnaround),
      turnaround_max_seconds: max(turnaround),
      open_age_median_seconds: median(ages),
      open_age_max_seconds: max(ages),
    },
    blocked: { waves: blocked.length, policy, other: blocked.length - policy, by_reason: byReason },
    found_after: { failed_applies: failed, unrecorded_writes: unrecorded, drift: drifted, total: after },
    blocked_share: ratio(blocked.length, blocked.length + after),
    trend,
  };
}

/**
 * The policy metrics of every project and of the estate. `entries` is the
 * audit record, undefined when there is none; a source's `rows` are its index
 * rows, for the drift its checks found.
 */
export function buildPolicyMetrics(sources: PolicySource[], entries: AuditEntry[] | undefined, now: Date): PolicyMetrics {
  const end = now.getTime();
  const from = weekStart(end) - (DORA_WEEKS - 1) * 7 * 86400 * 1000;
  const drift = sources.some((s) => s.rows !== undefined);
  const events = sources.map((s) => eventsOf(s, entries ?? []));
  return {
    schema: POLICY_METRICS_SCHEMA,
    generated: now.toISOString(),
    weeks: DORA_WEEKS,
    window: { from: new Date(from).toISOString(), to: now.toISOString() },
    audit: entries !== undefined,
    drift,
    estate: metricsOf(merge(events), from, end, drift),
    projects: sources.map((s, i) => ({ project: s.project, ...metricsOf(events[i], from, end, drift) })),
  };
}

const pct = (r: number | null): string => (r === null ? "none" : `${Math.round(r * 1000) / 10}%`);

function row(name: string, m: PolicyMetricSet): string {
  const q = m.requests;
  const f = m.found_after;
  const after = `${f.total} <small>(${f.failed_applies} failed, ${f.unrecorded_writes} unrecorded${f.drift === null ? "" : `, ${f.drift} drift`})</small>`;
  const waiting = q.open ? `, <span class="warn">${q.open} open, oldest ${duration(q.open_age_max_seconds)}</span>` : "";
  return `<tr><td>${name}</td><td>${m.denials}</td><td>${pct(m.override_rate)} <small>(${m.overridden} of ${m.denials})</small></td><td>${duration(q.turnaround_median_seconds)} <small>(${q.overridden} of ${q.requested} answered${waiting}${q.expired ? `, ${q.expired} expired` : ""})</small></td><td>${m.blocked.waves} <small>(${m.blocked.policy} by policy)</small></td><td>${after}</td></tr>`;
}

/** The estate page's policy section: the definitions, each project's numbers and the estate's, the rules that deny most, and a row per week. */
export function renderPolicySection(p: PolicyMetrics, link: (project: string) => string): string {
  const rules = p.estate.rules.map((r) => `<tr><td><code>${esc(r.rule)}</code></td><td>${r.denials}</td><td>${r.overridden}</td></tr>`);
  const weeks = p.estate.trend.map((w) => `<tr><td>${esc(w.week)}</td><td>${w.denials}</td><td>${w.overridden}</td><td>${pct(w.override_rate)}</td><td>${w.overrides}</td><td>${w.blocked}</td><td>${w.found_after}</td></tr>`);
  return `<p>The newest ${p.weeks} weeks, from the audit trail${p.drift ? " and each project's drift checks" : ""}${p.audit ? "" : `. <span class="warn">No audit trail was read, so no denial counts: run terragucci audit before terragucci estate.</span>`}</p>
<dl class="defs">
<dt>Denials</dt><dd>Roots a wave's policy denied, each wave plan once, however often the wave ran.</dd>
<dt>Override rate</dt><dd>Denials an override let through, over all denials.</dd>
<dt>Override turnaround</dt><dd>The median time from a denial recorded for an override to the override. An unanswered denial is open until it expires.</dd>
<dt>Blocked before deploy</dt><dd>Refused waves: denied by the policy, or changed after their approval, review or override, held, or superseded.</dd>
<dt>Found after</dt><dd>Failed applies, state versions written outside terragucci${p.drift ? ", and drift found by a drift check" : ""}.</dd>
</dl>
<div class="scroll"><table id="policy"><tr><th>Project</th><th>Denials</th><th>Override rate</th><th>Override turnaround</th><th>Blocked before deploy</th><th>Found after</th></tr>
${[row("<b>Estate</b>", p.estate), ...p.projects.map((x) => row(link(x.project), x))].join("\n")}
</table></div>
<h3>Denials by rule</h3>
${rules.length ? `<div class="scroll"><table id="policy-rules"><tr><th>Rule</th><th>Denials</th><th>Overridden</th></tr>\n${rules.join("\n")}\n</table></div>` : `<p class="none">No policy denied a root in the window.</p>`}
<h3>By week</h3>
<div class="scroll"><table id="policy-weeks"><tr><th>Week of</th><th>Denials</th><th>Overridden</th><th>Override rate</th><th>Overrides written</th><th>Blocked</th><th>Found after</th></tr>
${weeks.join("\n")}
</table></div>`;
}
