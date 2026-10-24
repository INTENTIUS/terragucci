import { describe, expect, it } from "vitest";
import { AUDIT_SCHEMA, appendEntries, readRecord, type AuditEntry } from "../src/report/audit";
import { buildPolicyMetrics, NO_RULE, renderPolicySection } from "../src/report/policy-metrics";
import type { IndexEntry } from "../src/report/store";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const P = "github.com/acme/infra";
const Q = "github.com/acme/net";
const S1 = `sha256:${"1".repeat(64)}`;
const S2 = `sha256:${"2".repeat(64)}`;
const O1 = `sha256:${"a".repeat(64)}`;
const O2 = `sha256:${"b".repeat(64)}`;
const O3 = `sha256:${"c".repeat(64)}`;
const t = (day: number, h: number, m = 0): string => `2026-10-${String(day).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

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
 * A sample record, read back through audit.jsonl. Project P: wave 1 (set S1)
 * is denied on app (s3-public, tags) and db (tags) at 09:00 and again at
 * 09:30, an override request for app at 09:00 is answered at 11:00 and the
 * wave applies under it at 11:10; db's request is never answered and
 * expires. Wave 2 (S2) is denied on app with no rule id, and its request
 * is still open. A wave changed after its approval is refused once, run
 * twice. An apply fails and a state version is written outside terragucci.
 * Project Q: one denial of net (tags), with nothing recorded for an override.
 * A denial ten weeks ago is outside the window.
 */
function sample(): AuditEntry[] {
  const entries = [
    entry({ kind: "refused", at: t(5, 9), result: "denied-by-policy", digest: S1, detail: { denied: ["app", "db"], rules: { app: ["s3-public", "tags"], db: ["tags"] } } }),
    entry({ kind: "refused", at: t(5, 9, 30), result: "denied-by-policy", digest: S1, detail: { denied: ["app", "db"], rules: { app: ["s3-public", "tags"], db: ["tags"] } } }),
    entry({ kind: "override-requested", at: t(5, 9), result: "denied", what: "app", digest: O1, evidence: { source: "ledger" }, detail: { rules: ["s3-public", "tags"], expires: t(12, 9) } }),
    entry({ kind: "override-requested", at: t(5, 9), result: "denied", what: "db", digest: O2, evidence: { source: "ledger" }, detail: { rules: ["tags"], expires: t(6, 9) } }),
    entry({ kind: "override", at: t(5, 11), result: "unsigned", who: "sam", what: "app", digest: O1, evidence: { source: "ledger" }, detail: { reason: "public site", rules: ["s3-public", "tags"] } }),
    entry({ kind: "apply", at: t(5, 11, 10), result: "applied", who: "sam", digest: S1, detail: { roots: ["app"], overrides: [{ root: "app", by: "sam", rules: ["s3-public", "tags"], digest: O1 }] } }),
    entry({ kind: "refused", at: t(6, 8), result: "denied-by-policy", what: "wave-2", digest: S2, detail: { denied: ["app"], rules: { app: [] } } }),
    entry({ kind: "override-requested", at: t(6, 8), result: "denied", what: "app", digest: O3, evidence: { source: "ledger" }, detail: { rules: [], expires: t(13, 8) } }),
    entry({ kind: "refused", at: t(6, 10), result: "changed-after-approval", what: "wave-3", digest: S2, detail: { moved: ["app"] } }),
    entry({ kind: "refused", at: t(6, 10, 5), result: "changed-after-approval", what: "wave-3", digest: S2, detail: { moved: ["app"] } }),
    entry({ kind: "apply", at: t(6, 11), result: "failed", detail: { roots: ["app"], failed: ["app"] } }),
    entry({ kind: "unrecorded-write", at: t(6, 12), result: "unrecorded", what: "app", evidence: { source: "state" } }),
    entry({ kind: "refused", at: t(6, 9), result: "denied-by-policy", what: "wave-1", digest: S1, detail: { denied: ["net"], rules: { net: ["tags"] } } }, Q),
    entry({ kind: "refused", at: "2026-07-28T10:00:00.000Z", result: "denied-by-policy", digest: `sha256:${"9".repeat(64)}`, detail: { denied: ["old"], rules: { old: ["tags"] } } }),
  ];
  // Through the record, as terragucci estate reads it.
  return readRecord(appendEntries(readRecord(undefined), entries)).entries;
}

const drift = (finished: string, changed: number, project = P): IndexEntry => ({
  project,
  path: `2026/10/c/tf-drift`,
  stage: "tf-drift",
  commit: "c",
  finished,
  roots: 1,
  groups: 1,
  totals: { create: 0, update: 0, replace: 0, delete: 0 },
  refused: 0,
  failed: 0,
  changed,
  destroys: [],
  ...(changed ? { drifted_roots: ["app"] } : {}),
});

describe("the policy metrics", () => {
  it("count denials per rule, the override rate, turnaround and age, and blocked before deploy against found after", () => {
    const m = buildPolicyMetrics([{ project: P, rows: [drift(t(6, 15), 1), drift(t(6, 17), 0)] }, { project: Q }], sample(), NOW);
    expect(m.window).toEqual({ from: "2026-08-17T00:00:00.000Z", to: NOW.toISOString() });
    expect(m.audit).toBe(true);
    expect(m.drift).toBe(true);
    const [p, q] = m.projects;
    // app and db in wave 1, counted once for both runs; app in wave 2.
    expect(p.denials).toBe(3);
    expect(p.overridden).toBe(1);
    expect(p.override_rate).toBe(0.333333);
    expect(p.rules).toEqual([
      { rule: "tags", denials: 2, overridden: 1 },
      { rule: NO_RULE, denials: 1, overridden: 0 },
      { rule: "s3-public", denials: 1, overridden: 1 },
    ]);
    expect(p.requests).toEqual({
      requested: 3,
      overridden: 1,
      open: 1,
      expired: 1,
      revoked: 0,
      turnaround_median_seconds: 7200,
      turnaround_max_seconds: 7200,
      open_age_median_seconds: 28 * 3600,
      open_age_max_seconds: 28 * 3600,
    });
    expect(p.blocked).toEqual({ waves: 3, policy: 2, other: 1, by_reason: { "denied-by-policy": 2, "changed-after-approval": 1 } });
    expect(p.found_after).toEqual({ failed_applies: 1, unrecorded_writes: 1, drift: 1, total: 3 });
    expect(p.blocked_share).toBe(0.5);
    expect(q.denials).toBe(1);
    expect(q.requests.requested).toBe(0);
    expect(q.found_after.drift).toBe(0);
    expect(m.estate.denials).toBe(4);
    expect(m.estate.rules[0]).toEqual({ rule: "tags", denials: 3, overridden: 1 });
    expect(m.estate.override_rate).toBe(0.25);
    expect(m.estate.trend).toHaveLength(8);
    expect(m.estate.trend.at(-1)).toEqual({ week: "2026-10-05", denials: 4, overridden: 1, override_rate: 0.25, overrides: 1, blocked: 4, found_after: 3 });
    expect(m.estate.trend.slice(0, -1).every((w) => w.denials === 0 && w.override_rate === null)).toBe(true);
  });

  it("leaves drift null without index rows, and counts nothing without the record", () => {
    const m = buildPolicyMetrics([{ project: P }], sample(), NOW);
    expect(m.drift).toBe(false);
    expect(m.estate.found_after).toEqual({ failed_applies: 1, unrecorded_writes: 1, drift: null, total: 2 });
    const none = buildPolicyMetrics([{ project: P }], undefined, NOW);
    expect(none.audit).toBe(false);
    expect(none.estate.denials).toBe(0);
    expect(none.estate.override_rate).toBeNull();
    expect(renderPolicySection(none, (x) => x)).toContain("No audit trail was read");
  });

  it("renders the section with each rule", () => {
    const html = renderPolicySection(buildPolicyMetrics([{ project: P }], sample(), NOW), (x) => x);
    expect(html).toContain('<table id="policy">');
    expect(html).toContain("<td><code>s3-public</code></td><td>1</td><td>1</td>");
    expect(html).toContain('<table id="policy-weeks">');
  });
});
