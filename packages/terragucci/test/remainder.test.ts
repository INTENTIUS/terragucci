import { describe, expect, it } from "vitest";
import type { AppliedRecord, FinishedRecord, GateLedger } from "../src/apply";
import { recordedAddresses } from "../src/records";
import { approvedChanges, coverRemainder, stoppedApply } from "../src/remainder";

const change = (address: string, actions: string[], after: unknown, before: unknown = null) => ({
  address, mode: "managed", type: address.split(".")[0], name: address.split(".")[1], change: { actions, before, after, after_unknown: {} },
});
/** A plan whose records hold `recorded` and whose changes are `changes`. */
const plan = (changes: unknown[], recorded: string[] = []) => ({
  resource_changes: changes,
  prior_state: { values: { root_module: { resources: recorded.map((address) => ({ address, mode: "managed", values: {} })) } } },
});
const T = (m: number): string => new Date(Date.UTC(2026, 9, 8, 12, m)).toISOString();

describe("recordedAddresses", () => {
  it("is the managed resources a plan read, in every module, and no data source", () => {
    const p = { prior_state: { values: { root_module: {
      resources: [{ address: "terraform_data.a", mode: "managed" }, { address: "data.aws_caller_identity.me", mode: "data" }],
      child_modules: [{ resources: [{ address: "module.m.terraform_data.b", mode: "managed" }] }],
    } } } };
    expect([...recordedAddresses(p)].sort()).toEqual(["module.m.terraform_data.b", "terraform_data.a"]);
    expect(recordedAddresses({}).size).toBe(0);
  });
});

describe("approvedChanges", () => {
  const first = change("terraform_data.first", ["create"], { input: "first" });
  const second = change("terraform_data.second", ["create"], { input: "second" });

  it("names each change of a choudoufu root with a digest of what it writes, and none of a no-op or a read", () => {
    const c = approvedChanges([{ root: "estate", binary: "/usr/local/bin/choudoufu", plan: plan([first, second, change("terraform_data.same", ["no-op"], {}), { ...change("data.x.y", ["read"], {}), mode: "data" }]) }]);
    expect(c?.map((x) => `${x.root} ${x.address} ${x.actions}`)).toEqual(["estate terraform_data.first create", "estate terraform_data.second create"]);
    expect(c![0]!.digest).toMatch(/^jcs1-sha256:/);
    expect(c![0]!.digest).not.toBe(c![1]!.digest);
  });

  it("is undefined once a root that changes something applies per root, and leaves out a stock root that changes nothing", () => {
    expect(approvedChanges([{ root: "a", binary: "tofu", plan: plan([first]) }])).toBeUndefined();
    expect(approvedChanges([{ root: "a", binary: "tofu", plan: plan([]) }, { root: "b", binary: "choudoufu", plan: plan([first]) }])?.map((x) => x.root)).toEqual(["b"]);
  });
});

describe("coverRemainder", () => {
  const first = change("terraform_data.first", ["create"], { input: "first" });
  const second = change("terraform_data.second", ["create"], { input: "second" });
  const gone = change("terraform_data.gone", ["delete"], null, { input: "gone" });
  const approved = approvedChanges([{ root: "estate", binary: "choudoufu", plan: plan([first, second, gone], ["terraform_data.gone"]) }])!;

  it("covers plans that make the rest of the approved changes, the others done in the records", () => {
    const c = coverRemainder(approved, [{ root: "estate", binary: "choudoufu", plan: plan([second], ["terraform_data.first"]) }]);
    expect(c).toMatchObject({ covered: true });
    if (!c.covered) return;
    expect(c.remaining.map((x) => x.address)).toEqual(["terraform_data.second"]);
    expect(c.done.map((x) => x.address)).toEqual(["terraform_data.first", "terraform_data.gone"]);
  });

  it("does not cover a remaining change that moved since the approval, or one the approved plans did not make", () => {
    const moved = coverRemainder(approved, [{ root: "estate", binary: "choudoufu", plan: plan([change("terraform_data.second", ["create"], { input: "other" })], ["terraform_data.first"]) }]);
    expect(moved).toEqual({ covered: false, why: "estate terraform_data.second is a change the approved plans did not make" });
    const added = coverRemainder(approved, [{ root: "estate", binary: "choudoufu", plan: plan([second, change("terraform_data.new", ["create"], {})], ["terraform_data.first"]) }]);
    expect(added).toMatchObject({ covered: false, why: expect.stringContaining("estate terraform_data.new") });
  });

  it("does not cover plans that dropped an approved change the records do not show done", () => {
    // first is neither planned nor recorded, and gone is still recorded: the plans moved, not the apply.
    const c = coverRemainder(approved, [{ root: "estate", binary: "choudoufu", plan: plan([second], ["terraform_data.gone"]) }]);
    expect(c).toEqual({ covered: false, why: "estate terraform_data.first, estate terraform_data.gone were approved but are neither done in the records nor planned" });
  });

  it("does not cover a stock root's plans", () => {
    expect(coverRemainder(approved, [{ root: "estate", binary: "tofu", plan: plan([second], ["terraform_data.first"]) }])).toMatchObject({ covered: false });
  });
});

describe("stoppedApply", () => {
  const applied = (m: number, extra: Partial<AppliedRecord> = {}): AppliedRecord => ({
    version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: `d${m}`, approvedAt: T(1), approvedBy: "alice", timestamp: T(m), changes: [], ...extra,
  });
  const finished = (m: number, result: FinishedRecord["result"]): FinishedRecord => ({ version: 1, kind: "finished", op: "tf-apply", gate: "wave-1", planDigest: `d${m}`, applied: T(m), result, timestamp: T(m + 1) });
  const ledger = (l: Partial<GateLedger>): GateLedger => ({ pending: [], resolutions: [], ...l });

  it("is the newest apply under the approval that did not finish applying: killed or failed", () => {
    expect(stoppedApply(ledger({ applied: [applied(2), applied(5)] }), "wave-1", T(1))?.planDigest).toBe("d5");
    expect(stoppedApply(ledger({ applied: [applied(2)], finished: [finished(2, "failed")] }), "wave-1", T(1))?.planDigest).toBe("d2");
    expect(stoppedApply(ledger({ applied: [applied(2)], finished: [finished(2, "applied")] }), "wave-1", T(1))).toBeUndefined();
  });

  it("is none for another approval, or an apply that recorded no changes", () => {
    expect(stoppedApply(ledger({ applied: [applied(2)] }), "wave-1", T(0))).toBeUndefined();
    expect(stoppedApply(ledger({ applied: [applied(2, { changes: undefined })] }), "wave-1", T(1))).toBeUndefined();
  });
});
