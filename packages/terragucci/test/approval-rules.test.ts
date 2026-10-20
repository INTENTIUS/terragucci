import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, quorumSince, ruleApprovers, type GateLedger, type ResolutionRecord } from "../src/apply";
import { rolesOf, ruleAsks, ruleLine, ruleProgress, rulesFor, rulesWaiting, trustRolesAt, type RuleApprover } from "../src/approval-rules";
import { validateConfig } from "../src/config";
import { gateSealPayload } from "../src/seal";
import { T, approve, pending, setup } from "./apply-helpers";
import { git, tmp, write } from "./helpers";
import { gateSigners, signerLine, sshsig, sshKey } from "./sshsig";

const prod = { roots: ["envs/prod/**"], count: 2, roles: ["platform"], not_author: true };
const staging = { roots: ["envs/staging/**"], roles: ["platform", "app-leads"] };
const by = (who: string, at: number, o: Partial<RuleApprover> = {}): RuleApprover => ({ who, at: T(at), proven: true, roles: ["platform"], author: false, ...o });

describe("approval_rules in the config", () => {
  it("takes rules with roots and count, roles or not_author under sealed and pr-review", () => {
    expect(() => validateConfig({ approval: "sealed", approval_rules: [prod, staging] }, "t")).not.toThrow();
    expect(() => validateConfig({ approval: { mode: "pr-review" }, approval_rules: [prod] }, "t")).not.toThrow();
    // A count alone proves no name, so ledger takes it.
    expect(() => validateConfig({ approval_rules: [{ roots: ["envs/prod/**"], count: 2 }] }, "t")).not.toThrow();
  });
});

describe("the rules a wave takes", () => {
  it("every rule a root of the wave matches, and none for a wave no glob names", () => {
    expect(rulesFor([prod, staging], ["envs/prod/app", "envs/prod/db"])).toEqual([prod]);
    expect(rulesFor([prod, staging], ["envs/prod/app", "envs/staging/app"])).toEqual([prod, staging]);
    expect(rulesFor([prod, staging], ["envs/dev/app"])).toEqual([]);
    expect(rulesFor(undefined, ["envs/prod/app"])).toEqual([]);
  });
});

describe("a rule's progress", () => {
  it("waits after one approval and is met by a second from a distinct approver", () => {
    expect(ruleProgress(prod, [by("alice", 1)])).toMatchObject({ approvers: ["alice"], met: false, count: 2 });
    expect(ruleProgress(prod, [by("alice", 1), by("bob", 2)])).toMatchObject({ approvers: ["alice", "bob"], met: true });
  });

  it("two approvals by one person count once, whatever the case of the name", () => {
    expect(ruleProgress(prod, [by("alice", 1), by("Alice", 2)])).toMatchObject({ approvers: ["alice"], met: false });
  });

  it("two approvals by the author do not meet not_author", () => {
    const p = ruleProgress({ roots: ["envs/prod/**"], not_author: true }, [by("carol", 1, { author: true }), by("carol", 2, { author: true })]);
    expect(p.met).toBe(false);
    expect(ruleLine(p)).toBe("envs/prod/**: 1 of 1 approval (carol), needs an approver who is not the author");
  });

  it("counts toward roles only an approver the approval proves, holding one of them", () => {
    expect(ruleProgress(prod, [by("alice", 1), by("bob", 2, { proven: false })]).approvers).toEqual(["alice"]);
    expect(ruleProgress(prod, [by("alice", 1), by("dave", 2, { roles: ["app-leads"] })]).approvers).toEqual(["alice"]);
    expect(ruleProgress(staging, [by("dave", 2, { roles: ["app-leads"] })])).toMatchObject({ approvers: ["dave"], met: true });
  });

  it("says how many approvals are in and who is still needed", () => {
    const p = ruleProgress(prod, [by("alice", 1)]);
    expect(ruleLine(p)).toBe("envs/prod/**: 1 of 2 approvals (alice), needs 1 more from platform, one of them not the author");
    expect(rulesWaiting([p, ruleProgress(staging, [by("alice", 1)])])).toBe(ruleLine(p));
    expect(ruleAsks(p)).toBe("2 approvals, from platform, one of them not the author");
  });
});

describe("roles from .chant/trust.json", () => {
  const roles = { platform: ["github:alice", "carol@acme.com"], "app-leads": ["dave"] };

  it("a signer's principal, and a reviewer's login on the job's forge", () => {
    expect(rolesOf("carol@acme.com", roles)).toEqual(["platform"]);
    expect(rolesOf("github:alice", roles)).toEqual(["platform"]);
    expect(rolesOf("alice", roles, "github")).toEqual(["platform"]);
    expect(rolesOf("alice", roles, "gitlab")).toEqual([]);
    expect(rolesOf("alice", roles)).toEqual([]);
    expect(rolesOf("dave", roles, "github")).toEqual(["app-leads"]);
  });

  it("are read at base, and a trust.json chant would not read gives nobody a role", () => {
    const repo = tmp("tg-trust-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, { ".chant/trust.json": JSON.stringify({ schema: 1, roles }) });
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    write(repo, { ".chant/trust.json": JSON.stringify({ schema: 1, roles: { platform: ["github:mallory"] } }) });
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "the change");
    expect(trustRolesAt(repo, "HEAD~1").roles).toEqual(roles);
    write(repo, { ".chant/trust.json": JSON.stringify({ roles }) });
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "no schema");
    const read = trustRolesAt(repo, "HEAD");
    expect(read.roles).toEqual({});
    expect(read.problem).toMatch(/is not valid .*gives nobody a role/);
  });
});

describe("the approvers of a wave's digest", () => {
  const D = "jcs1-sha256:aaaa";
  const E = "jcs1-sha256:bbbb";
  const line = (who: string, at: number, digest = D, o: Partial<ResolutionRecord> = {}): ResolutionRecord => ({ version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: who, timestamp: T(at), planDigest: digest, ...o });
  const opts = { mode: "ledger" as const, signers: gateSigners(), roles: {}, forge: "github" };

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

  it("under pr-review a review counts each reviewer with their forge login, proven; an unsigned approval proves no one", () => {
    const ledger: GateLedger = { pending: [pending("wave-1", D, 0)], resolutions: [line("alice,bob", 1, D, { via: "pr-review", pr: 7, head: "abc", reviewers: ["alice", "bob"] }), line("carol", 2)] };
    const got = ruleApprovers(ledger, "wave-1", D, { ...opts, mode: "pr-review", roles: { platform: ["github:alice"] } });
    expect(got.map((a) => [a.who, a.proven, a.roles])).toEqual([["alice", true, ["platform"]], ["bob", true, []], ["carol", false, []]]);
  });

  it("under sealed only an approval whose seal verifies counts, as its signer", () => {
    const alice = sshKey();
    const signers = gateSigners(`${signerLine("alice", alice)}\n`);
    const a = line("alice", 1);
    const sealed = { ...a, seal: { signer: "alice", key: "SHA256:test", signature: sshsig(alice, gateSealPayload(a), "chant-gate") } };
    const ledger: GateLedger = { pending: [pending("wave-1", D, 0)], resolutions: [sealed, line("bob", 2)] };
    const got = ruleApprovers(ledger, "wave-1", D, { ...opts, mode: "sealed", signers, roles: { platform: ["alice"] } });
    expect(got.map((x) => [x.who, x.proven, x.roles])).toEqual([["alice", true, ["platform"]]]);
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
