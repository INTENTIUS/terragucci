import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { approvalRule, checkoutApproval, declaredGates, effectiveApproval } from "../src/approval";
import { approveLine } from "../src/apply";
import { tmp, write } from "./helpers";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf-8" });
const declared = (...gates: string[]) => JSON.stringify({ name: "x", schema: 1, members: [], identity: { gates: Object.fromEntries(gates.map((g) => [g, {}])) } });

/** A repo of two commits: `base`, then `merge`, the commit a wave applies. */
function twoCommits(base: Record<string, string>, merge: Record<string, string>): string {
  const repo = tmp("tg-approval-");
  git(repo, "init", "-q", "-b", "main");
  write(repo, base);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base");
  write(repo, merge);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", "the merge");
  return repo;
}

describe("effectiveApproval", () => {
  it("is ledger by default, and the key wins over everything else", () => {
    expect(effectiveApproval(undefined, 0, undefined, "at base")).toEqual({ mode: "ledger", source: "the default" });
    expect(effectiveApproval("sealed", 0, "ledger", "at base")).toMatchObject({ mode: "sealed", source: "approval: sealed in the config at base" });
    expect(effectiveApproval("ledger", 0, "sealed", "at base")).toEqual({ mode: "ledger", source: "approval: ledger in the config at base" });
  });

  it("with no key, gates under identity.gates mean sealed, with a note on how to choose", () => {
    const m = effectiveApproval(undefined, 2, "ledger", "at base");
    expect(m).toMatchObject({ mode: "sealed", source: "identity.gates in chant.workspace.json at base, with no approval key" });
    expect(m.note).toMatch(/set approval: sealed/);
  });

  it("the pipeline's --approval counts only when the config names none and no gate is sealed", () => {
    expect(effectiveApproval(undefined, 0, "sealed", "at base")).toEqual({ mode: "sealed", source: "the pipeline's --approval" });
  });

  it("approval: ledger beside listed gates says chant approve would still ask for a seal", () => {
    expect(effectiveApproval("ledger", 1, undefined, "at base").note).toMatch(/chant approve refuses an unsigned approval/);
  });
});

describe("declaredGates", () => {
  it("counts the gates under identity.gates, and reads nothing from a missing or broken file", () => {
    expect(declaredGates(declared("wave-1", "wave-2"))).toBe(2);
    expect(declaredGates(JSON.stringify({ name: "x" }))).toBe(0);
    expect(declaredGates(undefined)).toBe(0);
    expect(declaredGates("{")).toBe(0);
  });
});

describe("approvalRule", () => {
  it("a merge that switches approval: sealed to ledger is judged sealed: the key is read at base", async () => {
    const repo = twoCommits({ "terragucci.yml": "approval: sealed\n" }, { "terragucci.yml": "approval: ledger\n" });
    const rule = await approvalRule(repo, { config: `${repo}/terragucci.yml` });
    expect(rule).toMatchObject({ mode: "sealed", source: "approval: sealed in the config at base" });
    // The merge itself governs the next apply.
    expect((await approvalRule(repo, { at: "HEAD", config: `${repo}/terragucci.yml` })).mode).toBe("ledger");
  });

  it("a merge that deletes the key and the gates of a repo set up before the key is judged sealed too", async () => {
    const repo = twoCommits({ "chant.workspace.json": declared("wave-1") }, { "chant.workspace.json": declared() });
    expect(await approvalRule(repo)).toMatchObject({ mode: "sealed", source: "identity.gates in chant.workspace.json at base, with no approval key" });
  });

  it("reads the signers at base under approval: sealed even when no gate is declared", async () => {
    const repo = twoCommits({ "terragucci.yml": "approval: sealed\n", ".chant/allowed_signers": "alice ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb6\n" }, {});
    const rule = await approvalRule(repo, { config: `${repo}/terragucci.yml` });
    expect(rule.mode).toBe("sealed");
    expect(rule.signers?.map((s) => s.principals)).toEqual([["alice"]]);
  });

  it("a config at base that cannot be read decides nothing", async () => {
    const repo = twoCommits({ "terragucci.yml": "approval: maybe\n" }, { "terragucci.yml": "approval: ledger\n" });
    await expect(approvalRule(repo, { config: `${repo}/terragucci.yml` })).rejects.toThrow(/approval is read from the config at base/);
  });
});

describe("checkoutApproval", () => {
  it("is what config check reports: the key, else the declaration beside the config, else the default", () => {
    expect(checkoutApproval(tmp(), {})).toEqual({ mode: "ledger", source: "the default" });
    expect(checkoutApproval(tmp(), { approval: "sealed" })).toMatchObject({ mode: "sealed", source: "approval: sealed in the config here" });
    expect(checkoutApproval(write(tmp(), { "chant.workspace.json": declared("wave-1") }), {})?.mode).toBe("sealed");
    expect(checkoutApproval(tmp(), { projects: {} })).toBeUndefined();
  });
});

describe("approveLine", () => {
  it("asks for --sign only under approval: sealed, and always names the digest", () => {
    expect(approveLine(2, "jcs1-sha256:ab")).toBe("chant approve tf-apply wave-2 --plan jcs1-sha256:ab");
    expect(approveLine(2, "jcs1-sha256:ab", "sealed")).toBe("chant approve tf-apply wave-2 --plan jcs1-sha256:ab --sign");
  });
});
