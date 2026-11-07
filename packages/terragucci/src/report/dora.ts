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
 * Deployment frequency   applied waves per week, over the span the history
 *                        covers (see spanOf)
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
 * and each week has its own row, so a reader sees the trend. Lead time,
 * change failure rate and time to restore are medians and ratios of what the
 * window holds, so a history shorter than the window does not skew them; only
 * the deployment rate divides by time. Nothing is
 * compared to DORA's performance tiers: infrastructure ships less often than
 * an application does.
 */
import {
  buildRecordDelivery,
  deliveryGauges,
  doraMetricNames,
  recordDriftIncidents,
  DORA_FILE,
  DORA_MIN_SPAN_SECONDS,
  DORA_WEEKS,
  DRIFT_WINDOW_SECONDS,
  duration,
  median,
  spanLabel,
  weekStart,
  type DeliveryGauge,
  type DeliveryRecordSource,
  type Dora,
  type DoraMetrics,
  type DriftIncident,
} from "@intentius/chant/ci-estate";
import type { AuditEntry } from "./audit";
import { esc } from "./html";
import type { IndexEntry } from "./store";

export const DORA_SCHEMA = "terragucci.dora/v1";

// The metrics are chant's (`@intentius/chant/ci-estate`, chant#4612): `buildRecordDelivery`
// reads terragucci's index rows and audit trail, and the ledger path (../estate.ts) reads
// the workspace ledger. The window, the helpers and the gauges are chant's too.
export { DORA_FILE, DORA_MIN_SPAN_SECONDS, DORA_WEEKS, DRIFT_WINDOW_SECONDS, duration, median, spanLabel, weekStart };
export type { Dora, DoraLeadTime, DoraMetrics, DoraProject, DoraWeek } from "@intentius/chant/ci-estate";

const WORDS = { product: "terragucci" } as const;

/** One project's records, as the estate command read them. */
export type DoraSource = DeliveryRecordSource;

/** Drift as incidents, from a project's tf-drift index rows. */
export function driftIncidents(drifts: readonly IndexEntry[]): DriftIncident[] {
  return recordDriftIncidents(drifts);
}

/** The metrics of every project and of the estate. `entries` is the audit record, undefined when there is none. */
export function buildDora(sources: readonly DoraSource[], entries: readonly AuditEntry[] | undefined, now: Date): Dora {
  return buildRecordDelivery(sources, entries, { words: WORDS, now, stages: { plan: "tf-plan", drift: "tf-drift" } });
}

const rate = (r: number | null): string => (r === null ? "none" : `${Math.round(r * 1000) / 10}%`);

function row(name: string, m: DoraMetrics): string {
  const l = m.lead_time;
  const split = l.changes ? `<br><small>before the gate ${duration(l.before_gate_seconds)}, at the gate ${duration(l.at_gate_seconds)}, after it ${duration(l.after_gate_seconds)}</small>` : "";
  const c = m.change_failure;
  const r = m.restore;
  return `<tr><td>${name}</td><td>${m.per_week} <small>(${m.deployments} in ${spanLabel(m.span_seconds)})</small></td><td>${duration(l.median_seconds)}${split}</td><td>${rate(c.rate)} <small>(${c.failed} failed, ${c.drifted} drifted, of ${c.applies})</small></td><td>${duration(r.median_seconds)} <small>(${r.restored} restored${r.open ? `, <span class="warn">${r.open} open</span>` : ""})</small></td></tr>`;
}

/** The estate page's delivery section: the definitions, each project's numbers and the estate's, and a row per week. */
export function renderDoraSection(dora: Dora, link: (project: string) => string): string {
  const weeks = dora.estate.trend.map(
    (w) => `<tr><td>${esc(w.week)}</td><td>${w.deployments}</td><td>${w.applies}</td><td>${w.failures}</td><td>${duration(w.lead_time_seconds)}</td><td>${duration(w.restore_seconds)}</td></tr>`,
  );
  return `<p>The newest ${dora.weeks} weeks, from the audit trail and each project's index${dora.audit ? "" : `. <span class="warn">No audit trail was read, so no apply counts: run terragucci audit before terragucci estate.</span>`}</p>
<dl class="defs">
<dt>Deployment frequency</dt><dd>Applied waves per week, over the span the history covers: from now back to the oldest apply, or to the window's start when the history is older, and at least a day. Beside each rate is the span it divides by. Infrastructure ships less often than an application, so read it as a trend, not against a tier.</dd>
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
export type DoraGauge = DeliveryGauge;

export const DORA_METRIC = doraMetricNames(WORDS);

export function doraGauges(dora: Dora): DoraGauge[] {
  return deliveryGauges(dora, WORDS);
}
