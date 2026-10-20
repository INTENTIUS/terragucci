import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateSealPayload, sealRefusal, sealRule, type SealedApproval } from "../src/seal";
import { tmp, write } from "./helpers";
import { gateSigners, signerLine, sshsig, sshKey } from "./sshsig";

const approval: SealedApproval = { op: "tf-apply", gate: "wave-2", planDigest: "sha256:abc", resolvedBy: "github:alice", timestamp: "2026-10-04T10:00:00.000Z" };
const alice = sshKey();
const other = sshKey();
const sealWith = (key = alice, a: SealedApproval = approval, ns = "chant-gate") => ({ ...a, seal: { signer: a.resolvedBy, key: "SHA256:x", signature: sshsig(key, gateSealPayload(a), ns) } });

describe("sealRefusal, through chant's gate-decision", () => {
  const signers = gateSigners(`${signerLine("github:alice", alice)}\n`);

  it("counts an approval sealed by a key the signers file lists for its approver", () => {
    expect(sealRefusal(signers, sealWith())).toBeNull();
  });

  it("refuses an unsigned approval, a seal by an unlisted key or another signer, an edited approval, and every approval with no signers file", () => {
    expect(sealRefusal(signers, approval)).toMatch(/carries no seal/);
    expect(sealRefusal(signers, sealWith(other))).toMatch(/does not verify/);
    expect(sealRefusal(signers, { ...sealWith(), resolvedBy: "github:bob" })).toMatch(/is by github:alice/);
    expect(sealRefusal(signers, { ...sealWith(), planDigest: "sha256:def" })).toMatch(/does not verify/);
    expect(sealRefusal(gateSigners(), sealWith())).toMatch(/no signers file/);
  });
});

describe("sealRule", () => {
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf-8" });
  const declared = (...gates: string[]) => JSON.stringify({ name: "x", schema: 1, members: [], identity: { gates: Object.fromEntries(gates.map((g) => [g, {}])) } });
  const bob = sshKey();

  /** A repo whose second commit, the merge being applied, adds bob as a signer, moves the signers file and drops the gates. */
  function merged(): string {
    const repo = tmp("tg-rule-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, { "chant.workspace.json": declared("wave-1", "wave-2"), ".chant/allowed_signers": `${signerLine("alice", alice)}\n` });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    write(repo, {
      "chant.workspace.json": declared(),
      ".chant/allowed_signers": `${signerLine("alice", alice)}\n${signerLine("bob", bob)}\n`,
      ".chant/trust.json": JSON.stringify({ schema: 1, signers: "keys/signers" }),
      "keys/signers": `${signerLine("bob", bob)}\n`,
    });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "the merge");
    return repo;
  }

  it("reads the gates and the signers from the commit before the one being applied, so a merge does not judge its own apply", () => {
    const rule = sealRule(merged());
    expect([...rule.gates].sort()).toEqual(["wave-1", "wave-2"]);
    expect(rule.signersPath).toBe(".chant/allowed_signers");
    expect(rule.signers.signers.map((s) => s.principal)).toEqual(["alice"]);
  });

  it("fetches that commit when the checkout is shallow", () => {
    const origin = merged();
    const clone = join(tmp("tg-rule-clone-"), "c");
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${origin}`, clone]);
    expect(spawnSync("git", ["-C", clone, "rev-parse", "--verify", "-q", "HEAD^1"]).status).not.toBe(0);
    expect(sealRule(clone).signers.signers.map((s) => s.principal)).toEqual(["alice"]);
  });

  it("reads a root commit as it is, and another base when one is named", () => {
    const repo = tmp("tg-rule-root-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, { "chant.workspace.json": declared("wave-1"), ".chant/trust.json": JSON.stringify({ schema: 1, signers: "keys/signers" }), "keys/signers": `${signerLine("bob", bob)}\n` });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    const rule = sealRule(repo);
    expect([...rule.gates]).toEqual(["wave-1"]);
    expect(rule.signersPath).toBe("keys/signers");
    expect(rule.signers.signers.map((s) => s.principal)).toEqual(["bob"]);
    const later = merged();
    expect(sealRule(later, "HEAD").gates.size).toBe(0);
  });

  it("reads no signers through a trust.json without \"schema\": 1, as chant does", () => {
    const repo = tmp("tg-rule-schema-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, { "chant.workspace.json": declared("wave-1"), ".chant/trust.json": JSON.stringify({ signers: "keys/signers" }), "keys/signers": `${signerLine("bob", bob)}\n` });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    const rule = sealRule(repo);
    expect(rule.signers.active).toBe(false);
    expect(sealRefusal(rule.signers, sealWith())).toMatch(/no signers file/);
  });
});
