import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateSealPayload, parseSigners, sealRefusal, sealRule, verifySshSignature, type SealedApproval } from "../src/seal";
import { tmp, write } from "./helpers";
import { signerLine, sshsig, sshKey } from "./sshsig";

const approval: SealedApproval = { op: "tf-apply", gate: "wave-2", planDigest: "sha256:abc", resolvedBy: "github:alice", timestamp: "2026-10-04T10:00:00.000Z" };
const alice = sshKey();
const other = sshKey();
const sealWith = (key = alice, a: SealedApproval = approval, ns = "chant-gate") => ({ ...a, seal: { signer: a.resolvedBy, key: "SHA256:x", signature: sshsig(key, gateSealPayload(a), ns) } });

describe("gateSealPayload", () => {
  it("is chant's six lines, with a seventh for a relay", () => {
    expect(gateSealPayload(approval).toString()).toBe("tf-apply\nwave-2\n\nsha256:abc\ngithub:alice\n2026-10-04T10:00:00.000Z");
    expect(gateSealPayload({ ...approval, relayedBy: "hud" }).toString()).toMatch(/\nrelayed-by hud$/);
  });
});

describe("parseSigners", () => {
  it("keeps plain and namespaced lines, and leaves out windows, CAs and patterns as chant does", () => {
    const text = [
      "# people who approve",
      signerLine("github:Alice,bob", alice),
      signerLine("carol", alice, 'namespaces="git,chant-gate"'),
      signerLine("dave", alice, 'valid-after="20260101"'),
      signerLine("erin", alice, "cert-authority"),
      signerLine("*", alice),
      "frank not-a-key AAAA",
    ].join("\n");
    expect(parseSigners(text).map((s) => [s.principals, s.namespaces])).toEqual([
      [["github:alice", "bob"], undefined],
      [["carol"], ["git", "chant-gate"]],
    ]);
  });
});

describe("sealRefusal", () => {
  const signers = parseSigners(`${signerLine("github:alice", alice)}\n`);

  it("counts an approval sealed by a key the signers file lists for its approver", () => {
    expect(sealRefusal(signers, ".chant/allowed_signers", sealWith())).toBeNull();
  });

  it("refuses an unsigned approval, and every approval when there is no signers file", () => {
    expect(sealRefusal(signers, ".chant/allowed_signers", approval)).toMatch(/not signed/);
    expect(sealRefusal(null, ".chant/allowed_signers", sealWith())).toMatch(/no signers file/);
  });

  it("refuses a seal by a key the file does not list, by another signer, or in another namespace", () => {
    expect(sealRefusal(signers, ".chant/allowed_signers", sealWith(other))).toMatch(/does not verify/);
    expect(sealRefusal(signers, ".chant/allowed_signers", { ...sealWith(), resolvedBy: "github:bob" })).toMatch(/seal is by/);
    expect(sealRefusal(signers, ".chant/allowed_signers", sealWith(alice, approval, "chant-review"))).toMatch(/does not verify/);
  });

  it("refuses a seal whose approval was edited after sealing", () => {
    const s = sealWith();
    expect(sealRefusal(signers, ".chant/allowed_signers", { ...s, planDigest: "sha256:def" })).toMatch(/does not verify/);
    expect(sealRefusal(signers, ".chant/allowed_signers", { ...s, timestamp: "2026-10-05T10:00:00.000Z" })).toMatch(/does not verify/);
  });

  it("refuses a key whose namespaces leave out chant-gate", () => {
    const git = parseSigners(signerLine("github:alice", alice, 'namespaces="git"'));
    expect(sealRefusal(git, ".chant/allowed_signers", sealWith())).toMatch(/no key/);
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
      ".chant/trust.json": JSON.stringify({ signers: "keys/signers" }),
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
    expect(rule.signers?.map((s) => s.principals)).toEqual([["alice"]]);
  });

  it("fetches that commit when the checkout is shallow", () => {
    const origin = merged();
    const clone = join(tmp("tg-rule-clone-"), "c");
    execFileSync("git", ["clone", "-q", "--depth=1", `file://${origin}`, clone]);
    expect(spawnSync("git", ["-C", clone, "rev-parse", "--verify", "-q", "HEAD^1"]).status).not.toBe(0);
    expect(sealRule(clone).signers?.map((s) => s.principals)).toEqual([["alice"]]);
  });

  it("reads a root commit as it is, and another base when one is named", () => {
    const repo = tmp("tg-rule-root-");
    git(repo, "init", "-q", "-b", "main");
    write(repo, { "chant.workspace.json": declared("wave-1"), ".chant/trust.json": JSON.stringify({ signers: "keys/signers" }), "keys/signers": `${signerLine("bob", bob)}\n` });
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
    const rule = sealRule(repo);
    expect([...rule.gates]).toEqual(["wave-1"]);
    expect(rule.signersPath).toBe("keys/signers");
    expect(rule.signers?.map((s) => s.principals)).toEqual([["bob"]]);
    const later = merged();
    expect(sealRule(later, "HEAD").gates.size).toBe(0);
  });
});

// The format check that matters: a seal ssh-keygen made, as `chant approve --sign` makes it.
const hasSshKeygen = spawnSync("ssh-keygen", ["-?"]).error === undefined;

describe.skipIf(!hasSshKeygen)("a seal ssh-keygen made", () => {
  it.each(["ed25519", "rsa"])("verifies for an %s key, and only over the bytes it signed", (type) => {
    const dir = tmp("tg-seal-");
    const key = join(dir, "id");
    expect(spawnSync("ssh-keygen", ["-q", "-t", type, "-N", "", "-f", key]).status).toBe(0);
    const payload = gateSealPayload(approval);
    const signed = spawnSync("ssh-keygen", ["-q", "-Y", "sign", "-n", "chant-gate", "-f", key], { input: payload, encoding: "utf-8" });
    expect(signed.status).toBe(0);
    const pub = readFileSync(`${key}.pub`, "utf-8").trim().split(" ");
    writeFileSync(join(dir, "allowed_signers"), `github:alice ${pub[0]} ${pub[1]}\n`);
    const keys = parseSigners(readFileSync(join(dir, "allowed_signers"), "utf-8")).map((s) => s.key);
    expect(verifySshSignature(signed.stdout, payload, "chant-gate", keys)).toBe(true);
    expect(verifySshSignature(signed.stdout, gateSealPayload({ ...approval, gate: "wave-3" }), "chant-gate", keys)).toBe(false);
    expect(verifySshSignature(signed.stdout, payload, "chant-review", keys)).toBe(false);
    expect(verifySshSignature(signed.stdout, payload, "chant-gate", [other.blob])).toBe(false);
  });
});
