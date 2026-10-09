import { describe, expect, it } from "vitest";
import { buildReport } from "../src/report/build";
import {
  appendEntries,
  APPLY_LEDGER,
  AUDIT_SCHEMA,
  ledgerEntries,
  missingEntries,
  OVERRIDE_LEDGER_FILE,
  parseLedgerLog,
  readRecord,
  renderAuditHtml,
  reportEntry,
  reportEntryId,
  summarize,
  type LedgerChange,
} from "../src/report/audit";
import { RUN, smallFixture } from "./report-fixtures";

const D = `sha256:${"a".repeat(64)}`;
const E = `sha256:${"b".repeat(64)}`;
const P = "github.com/acme/infra";

const pending = { version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: "2026-10-07T10:00:00.000Z", expiresAt: "2026-10-09T10:00:00.000Z", planDigest: D, members: [{ member: "envs/dev/orders", planDigest: "sha256:1" }] };
const bob = { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "bob", timestamp: "2026-10-07T10:05:00.000Z", planDigest: D };
const carol = { ...bob, resolvedBy: "carol", timestamp: "2026-10-07T10:10:00.000Z", seal: { signer: "carol", key: "k", signature: "s" } };

const commit = (sha: string, author: string, date: string, lines: string[]): string => `\x1e${sha}\x1f${author}\x1f${date}\n\ndiff --git a/${APPLY_LEDGER} b/${APPLY_LEDGER}\n--- a/${APPLY_LEDGER}\n+++ b/${APPLY_LEDGER}\n@@ -1 +1 @@\n${lines.join("\n")}\n`;

describe("the ledger's history", () => {
  const log = [
    commit("c1", "ci", "2026-10-07T10:00:00Z", [`+${JSON.stringify(pending)}`]),
    commit("c2", "bob", "2026-10-07T10:05:00Z", [`+${JSON.stringify(bob)}`]),
    commit("c3", "alice", "2026-10-07T10:07:00-06:00", [`-${JSON.stringify(bob)}`, "\\ No newline at end of file"]),
    // The same line out and in again (a newline fixed at the end of the file) is no change.
    commit("c4", "carol", "2026-10-07T10:10:00Z", [`-${JSON.stringify(pending)}`, `+${JSON.stringify(pending)}`, `+${JSON.stringify(carol)}`]),
  ].join("");

  it("reads the lines each commit added and removed, in order", () => {
    const changes = parseLedgerLog(log);
    expect(changes.map((c) => [c.commit, c.added, JSON.parse(c.line).resolvedBy ?? "pending"])).toEqual([
      ["c1", true, "pending"],
      ["c2", true, "bob"],
      ["c3", false, "bob"],
      ["c4", true, "carol"],
    ]);
    expect(changes[2].date).toBe("2026-10-07T16:07:00.000Z");
  });

  it("gives a request, each approval with how it was signed, and a revocation with who removed the line", () => {
    const entries = ledgerEntries(P, APPLY_LEDGER, parseLedgerLog(log), (c) => `https://github.com/acme/infra/commit/${c}`);
    expect(entries.map((e) => [e.kind, e.who, e.result])).toEqual([
      ["approval-requested", null, "waiting"],
      ["approval", "bob", "unsigned"],
      ["approval-revoked", "alice", "revoked"],
      ["approval", "carol", "sealed"],
    ]);
    expect(entries.every((e) => e.schema === AUDIT_SCHEMA && e.digest === D && e.what === "wave-1")).toBe(true);
    expect(entries[3].detail).toMatchObject({ signer: "carol" });
    expect(entries[2].detail).toMatchObject({ approved_by: "bob" });
    expect(entries[1].evidence).toEqual({ source: "ledger", branch: "chant/lifecycle", path: APPLY_LEDGER, commit: "c2", url: "https://github.com/acme/infra/commit/c2" });
    // Built again from the same history, the ids are the same.
    expect(ledgerEntries(P, APPLY_LEDGER, parseLedgerLog(log)).map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it("keeps who relayed an approval, and leaves it out when nobody did", () => {
    const relayed = { ...bob, resolvedBy: "github:dana", relayedBy: "chat-bot", timestamp: "2026-10-07T10:06:00.000Z" };
    const [own, other] = ledgerEntries(P, APPLY_LEDGER, [bob, relayed].map((l, i) => ({ line: JSON.stringify(l), added: true, commit: `r${i}`, author: "x", date: l.timestamp })));
    expect(other).toMatchObject({ kind: "approval", who: "github:dana", detail: { relayed_by: "chat-bot", committed_by: "x" } });
    expect(own!.detail).not.toHaveProperty("relayed_by");
  });

  it("gives an override its reason, and the rules and plan digest of the denial it answers", () => {
    const denial = { version: 1, kind: "pending", op: "policy-override", gate: "app", timestamp: "2026-10-07T09:00:00.000Z", expiresAt: "2026-10-09T09:00:00.000Z", planDigest: "sha256:o1", members: [{ member: "app", planDigest: "sha256:p1" }], rules: ["main.deny_public"] };
    const dave = { version: 1, kind: "resolution", op: "policy-override", gate: "app", resolvedBy: "dave", timestamp: "2026-10-07T09:30:00.000Z", planDigest: "sha256:o1", note: "the probe goes out" };
    const changes: LedgerChange[] = [denial, dave].map((l, i) => ({ line: JSON.stringify(l), added: true, commit: `o${i}`, author: "x", date: "2026-10-07T09:00:00.000Z" }));
    const [requested, override] = ledgerEntries(P, OVERRIDE_LEDGER_FILE, changes);
    expect(requested).toMatchObject({ kind: "override-requested", what: "app", result: "denied", detail: { rules: ["main.deny_public"], plan_digest: "sha256:p1" } });
    expect(override).toMatchObject({ kind: "override", who: "dave", digest: "sha256:o1", result: "unsigned", detail: { reason: "the probe goes out", rules: ["main.deny_public"], plan_digest: "sha256:p1" } });
  });
});

describe("a wave report's entry", () => {
  const wave = (o: { approval: "approved" | "waiting" | "not-required"; digest: string; finished: string; refused?: { reason: "approval" | "policy"; approved?: string; by?: string; roots: string[] } }) =>
    buildReport({
      run: { ...RUN, project: P, stage: "tf-apply", wave: 1, finished: o.finished },
      roots: smallFixture().slice(0, 1),
      waves: [{ number: 1, roots: ["envs/dev/orders"], approval: o.approval, setDigest: o.digest, ...(o.refused ? { refused: o.refused } : {}) }],
    });
  const approvals = ledgerEntries(P, APPLY_LEDGER, [bob, carol].map((l, i) => ({ line: JSON.stringify(l), added: true, commit: `c${i}`, author: "x", date: l.timestamp })));
  const evidence = { source: "report" as const, bucket: "s3://b", key: "k" };

  it("names the newest approval of its gate and digest written before it finished", () => {
    const e = reportEntry(wave({ approval: "approved", digest: D, finished: "2026-10-07T10:20:00.000Z" }), "p", evidence, approvals)!;
    expect(e).toMatchObject({ kind: "apply", who: "carol", result: "applied", digest: D, what: "wave-1" });
    expect(e.detail?.approval).toBe(approvals[1].id);
    expect(e.id).toBe(reportEntryId(P, "p", "2026-10-07T10:20:00.000Z"));
    const early = reportEntry(wave({ approval: "approved", digest: D, finished: "2026-10-07T10:06:00.000Z" }), "p", evidence, approvals)!;
    expect(early.who).toBe("bob");
  });

  it("is a refusal when the wave's plans changed after approval, or the policy denied a root", () => {
    const e = reportEntry(wave({ approval: "waiting", digest: E, finished: "2026-10-07T11:00:00.000Z", refused: { reason: "approval", approved: D, by: "carol", roots: ["envs/dev/orders"] } }), "p", evidence, approvals)!;
    expect(e).toMatchObject({ kind: "refused", who: "carol", result: "changed-after-approval", digest: E, detail: { approved: D, moved: ["envs/dev/orders"] } });
    const denied = reportEntry(wave({ approval: "not-required", digest: E, finished: "2026-10-07T11:00:00.000Z", refused: { reason: "policy", roots: ["envs/dev/orders"] } }), "p", evidence, approvals)!;
    expect(denied).toMatchObject({ kind: "refused", who: null, result: "denied-by-policy", detail: { denied: ["envs/dev/orders"] } });
  });

  it("is a waiting apply when the wave waits", () => {
    expect(reportEntry(wave({ approval: "waiting", digest: E, finished: "2026-10-07T11:00:00.000Z" }), "p", evidence, approvals)).toMatchObject({ kind: "apply", who: null, result: "waiting" });
  });
});

describe("the record", () => {
  const entries = ledgerEntries(P, APPLY_LEDGER, [pending, bob].map((l, i) => ({ line: JSON.stringify(l), added: true, commit: `c${i}`, author: "x", date: l.timestamp })));

  it("keeps every line it holds and appends what it lacks, once", () => {
    const first = appendEntries(readRecord(undefined), missingEntries(readRecord(undefined), entries.slice(0, 1)));
    const kept = `${first}not an entry\n`;
    const record = readRecord(kept);
    const missing = missingEntries(record, [...entries, ...entries]);
    expect(missing.map((e) => e.kind)).toEqual(["approval"]);
    const next = appendEntries(record, missing);
    expect(next.startsWith(kept)).toBe(true);
    expect(missingEntries(readRecord(next), entries)).toEqual([]);
    expect(Object.keys(JSON.parse(next.split("\n")[2]))).toEqual(["schema", "id", "kind", "project", "at", "who", "what", "digest", "result", "evidence", "detail"]);
  });

  it("renders a page with the counts and the entries", () => {
    const summary = summarize(entries, 2, [{ project: P, ledger: "read", reports: 0 }], new Date("2026-10-08T00:00:00.000Z"));
    expect(summary.kinds).toEqual({ "approval-requested": 1, approval: 1 });
    const html = renderAuditHtml(summary, entries);
    expect(html).toContain("<b>1</b><span>approval</span>");
    expect(html).toContain("<td>bob</td>");
    expect(html).toContain('id="terragucci-audit"');
  });
});
