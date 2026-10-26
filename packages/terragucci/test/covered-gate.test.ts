// A covered round at the gate (terragucci#1268): a wave that read an upstream output unknown at review plans again once
// its upstream applied, and its new plans have another digest. When chant's coveredRound finds them covered by the pull
// request's plan (src/covered-wave.ts), the approval of that plan's digest at the wave's gate lets the wave through.
// On its own decideGate refuses the new digest, since the only approval names the old one; coveredApproval is what
// beforeGateRules records the approval from, before that refusal stands.
import { describe, expect, it } from "vitest";
import { coveredApproval, decideGate, type AppliedRecord, type GateLedger } from "../src/apply";
import { T, pending, resolution } from "./apply-helpers";

const PR = "sha256:pull-request-wave-2";
const NOW = "sha256:wave-2-replanned";
const cover = { digest: PR, filledInputs: ["a.id"] };

/** The pull request's plan of wave 2 held, and alice approved it. */
const approved = (): GateLedger => ({ pending: [pending("wave-2", PR, 0)], resolutions: [{ ...resolution("wave-2", PR, 1), kind: "resolution" }] });

describe("a covered wave at its gate", () => {
  it("is refused by the plain gate, since the approval names the pull request's digest", () => {
    expect(decideGate(approved(), "wave-2", NOW, T(2))).toEqual({ status: "refused", approved: PR, by: "alice" });
  });

  it("goes through under the original approval, by whoever gave it and when", () => {
    expect(coveredApproval(approved(), "wave-2", NOW, cover, T(2))).toEqual({ by: "alice", at: T(1) });
  });

  it("goes through once the approval it records for the new digest is on the ledger, with nothing more to add", () => {
    const l = approved();
    const got = coveredApproval(l, "wave-2", NOW, cover, T(2))!;
    l.resolutions.push({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-2", resolvedBy: got.by, timestamp: T(2), planDigest: NOW, note: `covered by the approval of ${PR}` });
    expect(decideGate(l, "wave-2", NOW, T(3))).toEqual({ status: "approved", by: "alice", at: T(2) });
    expect(coveredApproval(l, "wave-2", NOW, cover, T(3))).toBeUndefined();
  });

  it("waits when nothing approved the pull request's plan", () => {
    const l: GateLedger = { pending: [pending("wave-2", PR, 0)], resolutions: [] };
    expect(coveredApproval(l, "wave-2", NOW, cover, T(2))).toBeUndefined();
  });

  it("does not take an approval at another gate, or of another plan", () => {
    const l: GateLedger = { pending: [], resolutions: [{ ...resolution("wave-3", PR, 1), kind: "resolution" }, { ...resolution("wave-2", "sha256:other", 1), kind: "resolution" }] };
    expect(coveredApproval(l, "wave-2", NOW, cover, T(2))).toBeUndefined();
  });

  it("does not take an approval an apply already spent", () => {
    const spent: AppliedRecord = { version: 1, kind: "applied", op: "tf-apply", gate: "wave-2", planDigest: PR, approvedAt: T(1), approvedBy: "alice", timestamp: T(1.5) };
    expect(coveredApproval({ ...approved(), applied: [spent] }, "wave-2", NOW, cover, T(2))).toBeUndefined();
  });

  it("does not take an approval made before the gate last held", () => {
    const l = approved();
    l.pending.push(pending("wave-2", NOW, 1.5));
    expect(coveredApproval(l, "wave-2", NOW, cover, T(2))).toBeUndefined();
  });
});
