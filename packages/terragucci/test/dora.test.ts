import { describe, expect, it } from "vitest";
import { estate } from "../src/estate";
import { AUDIT_SCHEMA, appendEntries, readRecord, type AuditEntry } from "../src/report/audit";
import { buildDora, DORA_METRIC, DORA_WEEKS, doraGauges, driftIncidents, duration, median, renderDoraSection, weekStart, type DoraSource } from "../src/report/dora";
import { readInlineEstate } from "../src/report/estate";
import { addToIndex, type IndexEntry } from "../src/report/store";
import type { OtlpFetch } from "../src/telemetry";
import { tmp } from "./helpers";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const P = "github.com/acme/infra";
const Q = "github.com/acme/net";
const D1 = `sha256:${"1".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const t = (day: number, h: number, m = 0): string => `2026-10-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const row = (o: Partial<IndexEntry> & Pick<IndexEntry, "stage" | "finished" | "commit">, project = P): IndexEntry => ({
  project,
  path: `2026/10/${o.commit}/${o.stage}`,
  roots: 1,
  groups: 1,
  totals: { create: 0, update: 1, replace: 0, delete: 0 },
  refused: 0,
  failed: 0,
  changed: 0,
  destroys: [],
  ...o,
});

let n = 0;
const entry = (o: Partial<AuditEntry> & Pick<AuditEntry, "kind" | "at" | "result">, project = P): AuditEntry => ({
  schema: AUDIT_SCHEMA,
  id: `sha256:e${n++}`,
  project,
  who: null,
  what: "wave-1",
  digest: null,
  evidence: { source: "report" },
  ...o,
});

/**
 * One project's week. Change 1: planned on its pull request at 08:00 and
 * again at 09:00, the wave waits from 09:30, approved at 10:00, applied 10:10.
 * Change 2: planned 09:00 the next day, no gate, applied 09:20. Change 3
 * fails at 12:00 and change 4 applies the root again at 13:00. Drift is
 * found on the root at 15:00 and cleared at 17:00. A refused wave, a waiting
 * one, and an apply ten weeks ago count for nothing.
 */
function oneProject(): { sources: DoraSource[]; entries: AuditEntry[] } {
  const approval = entry({ kind: "approval", at: t(5, 10), result: "unsigned", who: "alice", digest: D1, evidence: { source: "ledger" } });
  const entries = [
    entry({ kind: "approval-requested", at: t(5, 9, 30), result: "waiting", digest: D1, evidence: { source: "ledger" } }),
    approval,
    entry({ kind: "apply", at: t(5, 10, 10), result: "applied", who: "alice", digest: D1, detail: { commit: "c1", roots: ["app"], approval: approval.id } }),
    entry({ kind: "apply", at: t(6, 9, 20), result: "applied", detail: { commit: "c2", roots: ["app"] } }),
    entry({ kind: "apply", at: t(6, 12), result: "failed", detail: { commit: "c3", roots: ["app"], failed: ["app"] } }),
    entry({ kind: "apply", at: t(6, 13), result: "applied", detail: { commit: "c4", roots: ["app"] } }),
    entry({ kind: "refused", at: t(6, 14), result: "changed-after-approval", detail: { commit: "c5", roots: ["app"] } }),
    entry({ kind: "apply", at: t(6, 14, 30), result: "waiting", detail: { commit: "c6", roots: ["app"] } }),
    entry({ kind: "apply", at: "2026-07-28T10:00:00.000Z", result: "applied", detail: { commit: "old", roots: ["app"] } }),
  ];
  const rows = [
    row({ stage: "tf-plan", commit: "c0", finished: t(5, 8), pull_request: "1" }),
    row({ stage: "tf-plan", commit: "c1", finished: t(5, 9), pull_request: "1" }),
    row({ stage: "tf-plan", commit: "c2", finished: t(6, 9) }),
    row({ stage: "tf-drift", commit: "c4", finished: t(6, 15), changed: 1, drifted_roots: ["app"] }),
    row({ stage: "tf-drift", commit: "c4", finished: t(6, 17), changed: 0 }),
  ];
  return { sources: [{ project: P, rows }], entries };
}

describe("the DORA metrics", () => {
  it("count applied waves, the lead time and its split, failed changes, and the time to restore", () => {
    const { sources, entries } = oneProject();
    const d = buildDora(sources, entries, NOW);
    expect(d.window).toEqual({ from: "2026-08-17T00:00:00.000Z", to: NOW.toISOString() });
    const m = d.projects[0];
    expect(m.deployments).toBe(3);
    expect(m.per_week).toBe(Math.round((3 / DORA_WEEKS) * 100) / 100);
    // 7800s (08:00 to 10:10: 5400 before the gate, 1800 at it, 600 after) and 1200s (no gate); change 4 had no plan.
    expect(m.lead_time).toEqual({ changes: 2, median_seconds: 4500, before_gate_seconds: 3300, at_gate_seconds: 900, after_gate_seconds: 300 });
    // Four applies: change 3 failed, change 4 drifted within the window.
    expect(m.change_failure).toEqual({ applies: 4, failed: 1, drifted: 1, rate: 0.5 });
    // The failed apply restored in an hour, the drift cleared in two.
    expect(m.restore).toEqual({ restored: 2, open: 0, median_seconds: 5400, apply_restored: 1, drift_restored: 1 });
    expect(m.trend).toHaveLength(DORA_WEEKS);
    expect(m.trend.at(-1)).toEqual({ week: "2026-10-05", deployments: 3, applies: 4, failures: 2, lead_time_seconds: 4500, restore_seconds: 5400 });
    expect(m.trend.slice(0, -1).every((w) => w.deployments === 0 && w.lead_time_seconds === null)).toBe(true);
    const { project: _p, ...rest } = m;
    expect(d.estate).toEqual(rest);
  });

  it("each record left out moves the numbers", () => {
    const { sources, entries } = oneProject();
    const full = buildDora(sources, entries, NOW).estate;
    const withoutFailure = buildDora(sources, entries.filter((e) => e.result !== "failed"), NOW).estate;
    expect(withoutFailure.change_failure).toEqual({ applies: 3, failed: 0, drifted: 1, rate: 0.333 });
    expect(withoutFailure.restore.apply_restored).toBe(0);
    const noDrift = buildDora([{ project: P, rows: sources[0].rows.filter((r) => r.stage !== "tf-drift") }], entries, NOW).estate;
    expect(noDrift.change_failure.rate).toBe(0.25);
    expect(noDrift.restore.drift_restored).toBe(0);
    expect(full.change_failure.rate).toBe(0.5);
  });

  it("joins a merge commit's apply to its pull request's plan by the wave's digest, and sums the estate across projects", () => {
    const { sources, entries } = oneProject();
    const q: DoraSource = {
      project: Q,
      rows: [
        row({ stage: "tf-plan", commit: "h0", finished: t(6, 8), pull_request: "5" }, Q),
        row({ stage: "tf-plan", commit: "h1", finished: t(6, 9), pull_request: "5", wave_digests: [D3] }, Q),
        // Drift on another root than the apply's counts against no apply.
        row({ stage: "tf-drift", commit: "m1", finished: t(6, 11), changed: 1, drifted_roots: ["other"] }, Q),
      ],
    };
    const qEntries = [entry({ kind: "apply", at: t(6, 10), result: "applied", digest: D3, detail: { commit: "m1", roots: ["net"] } }, Q)];
    const d = buildDora([...sources, q], [...entries, ...qEntries], NOW);
    expect(d.projects[1].lead_time.median_seconds).toBe(7200);
    expect(d.projects[1].change_failure).toEqual({ applies: 1, failed: 0, drifted: 0, rate: 0 });
    // The drift found and never cleared is open.
    expect(d.projects[1].restore.open).toBe(1);
    expect(d.estate.deployments).toBe(4);
    expect(d.estate.change_failure).toEqual({ applies: 5, failed: 1, drifted: 1, rate: 0.4 });
    expect(d.estate.lead_time.changes).toBe(3);
    expect(d.estate.lead_time.median_seconds).toBe(7200);
  });

  it("keeps drift the next check of the same commit replaced: the clean row names the drift it cleared", () => {
    // Three checks of one commit share one row path, so each replaces the one before in the index.
    const check = (finished: string, changed: number) => row({ stage: "tf-drift", commit: "c9", finished, changed, ...(changed ? { drifted_roots: ["app"] } : {}) });
    let index = addToIndex(undefined, check(t(6, 15), 1));
    index = addToIndex(JSON.stringify(index), check(t(6, 16), 1));
    expect(index.reports).toEqual([expect.objectContaining({ finished: t(6, 16), drift_since: t(6, 15) })]);
    index = addToIndex(JSON.stringify(index), check(t(6, 17), 0));
    expect(index.reports).toEqual([expect.objectContaining({ finished: t(6, 17), drift_cleared: { since: t(6, 15), roots: ["app"] } })]);
    expect(index.reports[0].drift_since).toBeUndefined();
    // The next clean check clears nothing.
    expect(addToIndex(JSON.stringify(index), { ...check(t(6, 18), 0), commit: "c10", path: "x" }).reports[0].drift_cleared).toBeUndefined();
    expect(driftIncidents(index.reports)).toEqual([{ since: Date.parse(t(6, 15)), roots: new Set(["app"]), closed: Date.parse(t(6, 17)) }]);
    const { entries } = oneProject();
    const m = buildDora([{ project: P, rows: index.reports }], entries.filter((e) => e.result !== "failed"), NOW).projects[0];
    expect(m.restore).toMatchObject({ drift_restored: 1, median_seconds: 7200, open: 0 });
    expect(m.change_failure.drifted).toBe(1);
  });

  it("a failure of roots already failing joins that incident, and one no apply restores stays open", () => {
    const entries = [
      entry({ kind: "apply", at: t(6, 1), result: "failed", detail: { roots: ["a", "b"], failed: ["a", "b"] } }),
      entry({ kind: "apply", at: t(6, 2), result: "failed", detail: { roots: ["a"], failed: ["a"] } }),
      entry({ kind: "apply", at: t(6, 3), result: "applied", detail: { roots: ["a"] } }),
      entry({ kind: "apply", at: t(6, 4), result: "applied", detail: { roots: ["b"] } }),
      entry({ kind: "apply", at: t(6, 5), result: "failed", detail: { roots: ["c"], failed: ["c"] } }),
    ];
    const r = buildDora([{ project: P, rows: [] }], entries, NOW).projects[0].restore;
    expect(r).toEqual({ restored: 1, open: 1, median_seconds: 3 * 3600, apply_restored: 1, drift_restored: 0 });
  });

  it("without an audit trail counts no apply, and says so", () => {
    const { sources } = oneProject();
    const d = buildDora(sources, undefined, NOW);
    expect(d.audit).toBe(false);
    expect(d.estate.deployments).toBe(0);
    expect(d.estate.change_failure.rate).toBeNull();
    expect(d.estate.restore.drift_restored).toBe(1);
    expect(renderDoraSection(d, (p) => p)).toContain("No audit trail was read");
  });

  it("weeks start on Monday in UTC; medians and durations read as the page shows them", () => {
    expect(new Date(weekStart(Date.parse("2026-10-11T23:59:00Z"))).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(new Date(weekStart(Date.parse("2026-10-05T00:00:00Z"))).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2])).toBe(2);
    expect([duration(null), duration(40), duration(300), duration(7800), duration(90000)]).toEqual(["none", "40s", "5m", "2h 10m", "1d 1h"]);
  });

  it("the page states each definition beside the numbers, with a row per project and per week, escaped", () => {
    const { sources, entries } = oneProject();
    const d = buildDora([{ project: "<p>", rows: sources[0].rows.map((r) => ({ ...r, project: "<p>" })) }], entries.map((e) => ({ ...e, project: "<p>" })), NOW);
    const html = renderDoraSection(d, (p) => `<a href="x">${p.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</a>`);
    for (const term of ["Deployment frequency", "Lead time", "Change failure rate", "Time to restore", "A refused wave is the gate working"]) expect(html).toContain(term);
    expect(html).toContain("before the gate 55m, at the gate 15m, after it 5m");
    expect(html).toContain("50%");
    expect(html).toContain('<a href="x">&lt;p&gt;</a>');
    expect(html.match(/<tr><td>2026-/g)).toHaveLength(DORA_WEEKS);
  });

  it("gauges each metric per project and for the estate", () => {
    const { sources, entries } = oneProject();
    const g = doraGauges(buildDora(sources, entries, NOW));
    const of = (name: string, project: string, segment?: string) => g.find((x) => x.name === name && x.attributes.project === project && x.attributes.segment === segment)?.value;
    expect(of(DORA_METRIC.deployments, "*")).toBe(0.38);
    expect(of(DORA_METRIC.leadTime, P, "total")).toBe(4500);
    expect(of(DORA_METRIC.leadTime, P, "at_gate")).toBe(900);
    expect(of(DORA_METRIC.failureRate, P)).toBe(0.5);
    expect(of(DORA_METRIC.restore, "*")).toBe(5400);
    expect(g.filter((x) => x.attributes.project === "*")).toHaveLength(7);
  });
});

describe("terragucci estate and the DORA metrics", () => {
  function bucket(objects: Map<string, string>) {
    const fetch = async (url: string, init: { method: string; body?: unknown }) => {
      const [, name, ...rest] = new URL(url).pathname.split("/");
      const key = `${name}:${decodeURIComponent(rest.join("/"))}`;
      if (init.method === "PUT") {
        objects.set(key, typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf-8"));
        return { ok: true, status: 200, text: async () => "" };
      }
      const body = objects.get(key);
      return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
    };
    return fetch;
  }
  const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };

  it("reads audit.jsonl and each index, writes dora.json beside the page, shows the section, and sends the gauges when an endpoint is set", async () => {
    const { sources, entries } = oneProject();
    const objects = new Map<string, string>();
    const index = JSON.stringify({ schema: "terragucci.report-index/v1", reports: sources[0].rows });
    objects.set("acme:r/index.json", index);
    objects.set(`acme:r/${P}/index.json`, index);
    objects.set("acme:r/audit.jsonl", appendEntries(readRecord(undefined), entries));
    const sent: { url: string; body: string }[] = [];
    const otlpFetch: OtlpFetch = async (url, init) => {
      sent.push({ url, body: init.body });
      return { ok: true, status: 200, text: async () => "" };
    };
    const r = await estate(tmp(), { reports: { bucket: "s3://acme", endpoint: "http://minio:9000", prefix: "r" } }, { fetch: bucket(objects), otlpFetch, env: { ...ENV, OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel:4318" }, now: NOW });
    const dora = JSON.parse(objects.get("acme:r/dora.json")!);
    expect(dora).toEqual(r.dora);
    expect(dora.projects[0].change_failure.rate).toBe(0.5);
    expect(r.estate.dora).toEqual({ file: "dora.json", generated: NOW.toISOString(), deployments: 3 });
    const html = objects.get("acme:r/estate.html")!;
    expect(readInlineEstate(html)?.dora?.deployments).toBe(3);
    expect(html).toContain('<h2 id="delivery">Delivery</h2>');
    expect(html).toContain('<table id="dora">');
    expect(sent.map((s) => s.url)).toEqual(["http://otel:4318/v1/metrics"]);
    expect(sent[0].body).toContain(DORA_METRIC.failureRate);
    expect(r.metrics).toEqual({ sent: doraGauges(r.dora).length });
  });

  it("sends nothing without an endpoint", async () => {
    const objects = new Map<string, string>([["acme:r/index.json", JSON.stringify({ schema: "terragucci.report-index/v1", reports: [] })]]);
    const otlpFetch: OtlpFetch = async () => {
      throw new Error("no endpoint is set");
    };
    const r = await estate(tmp(), { reports: { bucket: "s3://acme", endpoint: "http://minio:9000", prefix: "r" } }, { fetch: bucket(objects), otlpFetch, env: ENV, now: NOW });
    expect(r.metrics).toBeUndefined();
    expect(r.dora.audit).toBe(false);
  });
});
