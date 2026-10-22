import { afterEach, describe, expect, it, vi } from "vitest";
import { quorumRuleProgress, quorumRulesFor } from "@intentius/chant/gate-decision";
import { applyWave, quorumSince, reviewerPrincipal, ruleApprovers, type GateLedger, type ResolutionRecord } from "../src/apply";
import { quorumOf, reportRuleLine, ruleAsks, ruleReport } from "../src/approval";
import { validateConfig } from "../src/config";
import { gateSealPayload } from "../src/seal";
import { T, approve, pending, setup } from "./apply-helpers";
import { gateSigners, signerLine, sshsig, sshKey } from "./sshsig";

const prod = { roots: ["envs/prod/**"], count: 2, roles: ["platform"], not_author: true };
const staging = { roots: ["envs/staging/**"], roles: ["platform", "app-leads"] };

describe("approval_rules in the config", () => {
  it("takes rules with roots and count, roles or not_author under sealed and pr-review", () => {
    expect(() => validateConfig({ approval: "sealed", approval_rules: [prod, staging] }, "t")).not.toThrow();
    expect(() => validateConfig({ approval: { mode: "pr-review" }, approval_rules: [prod] }, "t")).not.toThrow();
    // A count alone proves no name, so ledger takes it.
    expect(() => validateConfig({ approval_rules: [{ roots: ["envs/prod/**"], count: 2 }] }, "t")).not.toThrow();
  });
});

describe("approval_rules as chant's quorum rules", () => {
  it("maps roots to targets and not_author to notAuthor, with a count of 1 when unset", () => {
    expect(quorumOf([prod, staging])).toEqual([
      { targets: ["envs/prod/**"], count: 2, roles: ["platform"], notAuthor: true },
      { targets: ["envs/staging/**"], count: 1, roles: ["platform", "app-leads"] },
    ]);
  });

  it("a wave takes every rule a root of it matches", () => {
    const rules = quorumOf([prod, staging]);
    expect(quorumRulesFor(rules, ["envs/prod/app", "envs/staging/app"])).toEqual(rules);
    expect(quorumRulesFor(rules, ["envs/dev/app"])).toEqual([]);
  });

  it("keeps a rule's progress in the report's terms, and says what it asks for", () => {
    const [rule] = quorumOf([prod]);
    const p = ruleReport(quorumRuleProgress(rule!, [{ who: "alice", at: T(1), judged: { proven: true, roles: ["platform"], author: false } }]));
    expect(p).toEqual({ roots: ["envs/prod/**"], count: 2, roles: ["platform"], not_author: true, approvers: ["alice"], met: false });
    expect(reportRuleLine(p)).toBe("envs/prod/**: 1 of 2 approvals (alice), needs 1 more from platform, one of them not the author");
    expect(ruleAsks(p)).toBe("2 approvals, from platform, one of them not the author");
  });
});

describe("a reviewer's principal", () => {
  it("is the forge principal chant names, from the job's forge and host", () => {
    expect(reviewerPrincipal({})("Alice")).toBe("github:alice");
    expect(reviewerPrincipal({ GITHUB_SERVER_URL: "https://ghe.acme.com" })("alice")).toBe("github@ghe.acme.com:alice");
    expect(reviewerPrincipal({ GITLAB_CI: "true", CI_SERVER_HOST: "gitlab.com" })("bob")).toBe("gitlab:bob");
    expect(reviewerPrincipal({ GITLAB_CI: "true", CI_SERVER_HOST: "gitlab.acme.com" })("bob")).toBe("gitlab@gitlab.acme.com:bob");
    expect(reviewerPrincipal({ GITEA_ACTIONS: "true", GITHUB_SERVER_URL: "https://code.acme.com:3000" })("carol")).toBe("forgejo@code.acme.com:3000:carol");
  });
});

describe("the approvers of a wave's digest", () => {
  const D = "jcs1-sha256:aaaa";
  const E = "jcs1-sha256:bbbb";
  const line = (who: string, at: number, digest = D, o: Partial<ResolutionRecord> = {}): ResolutionRecord => ({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: who, timestamp: T(at), planDigest: digest, ...o });
  const opts = { mode: "ledger" as const, signers: gateSigners(), roles: {}, reviewer: reviewerPrincipal({}) };

  it("an approval of another digest counts toward nothing", () => {
    const ledger: GateLedger = { pending: [pending("wave-1", D, 0)], resolutions: [line("alice", 1), line("bob", 2, E)] };
    expect(ruleApprovers(ledger, "wave-1", D, opts).map((a) => a.who)).toEqual(["alice"]);
  });

  it("keeps the approvals made before the pending facts a waiting wave recorded for the same digest", () => {
    const ledger: GateLedger = { pending: [pending("wave-1", E, 0), pending("wave-1", D, 1), pending("wave-1", D, 3)], resolutions: [line("zed", 0.5), line("alice", 2), line("bob", 4)] };
    expect(quorumSince(ledger, "wave-1", D)).toBe(Date.parse(T(1)));
    expect(ruleApprovers(ledger, "wave-1", D, opts).map((a) => a.who)).toEqual(["alice", "bob"]);
  });

  it("leaves out an approval a wave already applied under", () => {
    const ledger: GateLedger = {
      pending: [pending("wave-1", D, 0)],
      resolutions: [line("alice", 1), line("bob", 3)],
      applied: [{ version: 1, kind: "applied", op: "tf-apply", gate: "wave-1", planDigest: D, approvedAt: T(1), approvedBy: "alice", timestamp: T(2) }],
    };
    expect(ruleApprovers(ledger, "wave-1", D, opts).map((a) => a.who)).toEqual(["bob"]);
  });

  it("under pr-review a review counts each reviewer with their forge login, proven, with the roles of their forge principal; an unsigned approval proves no one", () => {
    const ledger: GateLedger = { pending: [pending("wave-1", D, 0)], resolutions: [line("alice,bob", 1, D, { via: "pr-review", pr: 7, head: "abc", reviewers: ["alice", "bob"] }), line("carol", 2)] };
    const got = ruleApprovers(ledger, "wave-1", D, { ...opts, mode: "pr-review", roles: { platform: ["github:alice", "bob"] } });
    // A grant to the bare login bob is not bob's forge principal, github:bob.
    expect(got.map((a) => [a.who, a.judged.proven, a.judged.roles])).toEqual([["alice", true, ["platform"]], ["bob", true, []], ["carol", false, []]]);
  });

  it("under sealed only an approval whose seal verifies counts, as its signer", () => {
    const alice = sshKey();
    const signers = gateSigners(`${signerLine("alice", alice)}\n`);
    const a = line("alice", 1);
    const sealed = { ...a, seal: { signer: "alice", key: "SHA256:test", signature: sshsig(alice, gateSealPayload(a), "chant-gate") } };
    const ledger: GateLedger = { pending: [pending("wave-1", D, 0)], resolutions: [sealed, line("bob", 2)] };
    const got = ruleApprovers(ledger, "wave-1", D, { ...opts, mode: "sealed", signers, roles: { platform: ["alice"] } });
    expect(got.map((x) => [x.who, x.judged.proven, x.judged.roles])).toEqual([["alice", true, ["platform"]]]);
  });
});

describe("a wave under approval_rules", () => {
  afterEach(() => vi.restoreAllMocks());
  const alice = sshKey();
  const bob = sshKey();
  const files = {
    "terragucci.yml": `approval: sealed\napproval_rules:\n  - roots: ["a"]\n    count: 2\n    roles: [platform]\n`,
    ".chant/allowed_signers": `${signerLine("alice", alice)}\n${signerLine("bob", bob)}\n`,
    ".chant/trust.json": JSON.stringify({ schema: 1, roles: { platform: ["alice", "bob"] } }),
  };
  const opts = (bin: string, now: number) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "always" as const, env: {}, now: T(now) });
  const sealedBy = (who: "alice" | "bob", digest: string, at: number) => {
    const a = { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: who, timestamp: T(at), planDigest: digest };
    return { ...a, seal: { signer: who, key: "SHA256:test", signature: sshsig(who === "alice" ? alice : bob, gateSealPayload(a), "chant-gate") } };
  };
  const digestOf = (lines: string[]): string => /set digest (\S+),/.exec(lines.find((l) => /set digest/.test(l)) ?? "")?.[1] ?? "";

  it("waits after one approval, again after a second by the same person, and applies after one by a distinct listed approver", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const { work, origin, bin } = setup(files);
    expect(await applyWave(work, opts(bin, 0))).toBe(3);
    const digest = digestOf(lines);
    expect(digest).toMatch(/^jcs1-sha256:/);
    expect(lines.some((l) => l.includes("approval_rules: a: 0 of 2 approvals, needs 2 more from platform"))).toBe(true);

    approve(origin, sealedBy("alice", digest, 1));
    lines.length = 0;
    expect(await applyWave(work, opts(bin, 2))).toBe(3);
    expect(lines.some((l) => l.includes("approval_rules at base are not met (a: 1 of 2 approvals (alice), needs 1 more from platform)"))).toBe(true);

    approve(origin, sealedBy("alice", digest, 3));
    lines.length = 0;
    expect(await applyWave(work, opts(bin, 4))).toBe(3);
    expect(lines.some((l) => l.includes("a: 1 of 2 approvals (alice), needs 1 more from platform"))).toBe(true);

    approve(origin, sealedBy("bob", digest, 5));
    lines.length = 0;
    expect(await applyWave(work, opts(bin, 6))).toBe(0);
    expect(lines.some((l) => l.includes("approval_rules at base are met: a by alice, bob"))).toBe(true);
  });
});
