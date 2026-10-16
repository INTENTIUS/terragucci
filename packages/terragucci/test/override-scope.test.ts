import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave, parseLedger } from "../src/apply";
import { validateConfig } from "../src/config";
import { mayOverride, OVERRIDE_LEDGER, OVERRIDE_OP, overridersFor } from "../src/override";
import type { PolicyExec } from "../src/report/policy";
import { T, setup } from "./apply-helpers";
import { git, tmp } from "./helpers";

describe("scoped policy.override entries in the config", () => {
  it.each([
    [{ approval: "sealed", policy: { override: [{ roots: ["envs/dev/**"] }] } }, /config\.policy\.override\[0\] names nobody; give who, roles or both/],
    [{ approval: "sealed", policy: { override: [{ roots: "envs/dev/**", who: ["github:alice"] }] } }, /config\.policy\.override\[0\]\.roots must be a list of root globs/],
    [{ approval: "sealed", policy: { override: [{ roots: ["envs/dev/**"], people: ["github:alice"] }] } }, /config\.policy\.override\[0\]\.people is not a key of an override entry/],
    [{ approval: "sealed", policy: { override: [{ roots: ["envs/dev/**"], who: ["github:alice"], rules: [] }] } }, /config\.policy\.override\[0\]\.rules must be a list of rule ids/],
    [{ policy: { override: [{ roots: ["envs/prod/**"], roles: ["platform"] }] } }, /config\.policy\.override\[0\]\.roles: an override names whoever wrote it, and only approval: sealed proves who that was/],
    [{ approval: "pr-review", policy: { override: [{ roots: ["envs/prod/**"], roles: ["platform"] }] } }, /config\.policy\.override\[0\]\.roles: .*set approval to sealed/],
  ])("%j is refused", (raw, message) => {
    expect(() => validateConfig(raw, "t")).toThrow(message);
  });

  it("takes the flat list, entries, and both together", () => {
    expect(() => validateConfig({ policy: { override: ["github:alice"] } }, "t")).not.toThrow();
    expect(() => validateConfig({ approval: "sealed", policy: { override: [{ roots: ["envs/dev/**"], who: ["github:alice", "github:bob"] }, { roots: ["envs/prod/**"], roles: ["platform"], rules: ["main.deny_untagged"] }, "github:carol"] } }, "t")).not.toThrow();
  });
});

describe("who may override a root's denial", () => {
  const entries = [
    { roots: ["envs/dev/**"], who: ["github:alice", "github:bob"] },
    { roots: ["envs/prod/**"], roles: ["platform"], rules: ["main.deny_untagged"] },
  ];
  const roles = { platform: ["github:carol"] };

  it("a person listed only for envs/dev/** may not override envs/prod/app, and the answer names who may", () => {
    const prod = overridersFor({ overriders: [], entries, roles }, "envs/prod/app", ["main.deny_untagged"]);
    expect(prod).toEqual({ principals: ["github:carol"], shown: ["role platform (github:carol)"] });
    expect(mayOverride(prod.principals, "github:alice")).toBe(false);
    expect(mayOverride(prod.principals, "GitHub:Carol")).toBe(true);
    expect(overridersFor({ overriders: [], entries, roles }, "envs/dev/app", ["main.deny_public"]).principals).toEqual(["github:alice", "github:bob"]);
  });

  it("an entry with rules covers an override only when it lists every rule the override names", () => {
    expect(overridersFor({ overriders: [], entries, roles }, "envs/prod/app", ["main.deny_public"]).principals).toEqual([]);
    expect(overridersFor({ overriders: [], entries, roles }, "envs/prod/app", ["main.deny_untagged", "main.deny_public"]).principals).toEqual([]);
  });

  it("a role names its holders at base, and nobody without the grants (roles is {} off sealed)", () => {
    expect(overridersFor({ overriders: [], entries, roles: {} }, "envs/prod/app", ["main.deny_untagged"])).toEqual({ principals: [], shown: ["role platform (nobody holds it at base)"] });
  });

  it("the flat list means every root and every rule, beside the entries", () => {
    const o = overridersFor({ overriders: ["github:dave"], entries, roles }, "envs/prod/app", ["main.deny_public"]);
    expect(o).toEqual({ principals: ["github:dave"], shown: ["github:dave"] });
    expect(overridersFor({ overriders: ["github:dave"], roles: {} }, "anything", ["any.rule"]).principals).toEqual(["github:dave"]);
  });
});

describe("tf-apply under scoped policy.override entries", () => {
  afterEach(() => vi.restoreAllMocks());
  const deny: PolicyExec = async (_f, args) =>
    args[0] === "--version"
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 1, stdout: JSON.stringify([{ namespace: "main", failures: [{ msg: "terraform_data.x is not allowed", metadata: { query: "data.main.deny_data" } }] }]), stderr: "" };
  const opts = (bin: string, layers: string[][], now: number) => ({ wave: 1, layers, binary: bin, gate: "never" as const, env: {}, policy: { exec: deny }, now: T(now) });
  const facts = (origin: string) => parseLedger(git(origin, "show", `chant/lifecycle:${OVERRIDE_LEDGER}`)).pending;
  /** Append one override to origin's override ledger, as `chant approve policy-override` would. */
  function record(origin: string, root: string, digest: string, by: string, at: number): void {
    const clone = join(tmp("tg-override-"), "l");
    execFileSync("git", ["clone", "-q", "-b", "chant/lifecycle", origin, clone]);
    const file = join(clone, OVERRIDE_LEDGER);
    const line = { version: 1, kind: "resolution", op: OVERRIDE_OP, gate: root, resolvedBy: by, timestamp: T(at), planDigest: digest, note: "the incident needs it" };
    writeFileSync(file, `${readFileSync(file, "utf-8").replace(/\n$/, "")}\n${JSON.stringify(line)}\n`);
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "override");
    git(clone, "push", "-q", "origin", "chant/lifecycle");
  }
  const config = "policy:\n  path: policy\n  override:\n    - roots: [\"b\"]\n      who: [alice]\n    - roots: [\"a\"]\n      who: [bob]\n";

  it("someone listed only for another root cannot override, and the denial names who can", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const { work, origin, bin, log } = setup({ "terragucci.yml": config, "policy/p.rego": "package main\n" });
    expect(await applyWave(work, opts(bin, [["a"]], 1))).toBe(1);
    const fact = facts(origin).find((p) => p.gate === "a")!;
    record(origin, "a", fact.planDigest!, "alice", 2);
    lines.length = 0;
    expect(await applyWave(work, opts(bin, [["a"]], 3))).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(lines.join("\n")).toContain("a: policy.override at base lets bob override it for main.deny_data; one of them can let this plan through with:");
    record(origin, "a", fact.planDigest!, "bob", 4);
    expect(await applyWave(work, opts(bin, [["a"]], 5))).toBe(0);
    expect(existsSync(log)).toBe(true);
  });

  it("in a wave with roots of two entries, an override by someone named only for the other root is refused before anything applies", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const { work, origin, bin, log } = setup({ "terragucci.yml": config, "policy/p.rego": "package main\n" });
    mkdirSync(join(work, "b"), { recursive: true });
    copyFileSync(join(process.env.PLANS!, "a.json"), join(process.env.PLANS!, "b.json"));
    expect(await applyWave(work, opts(bin, [["a", "b"]], 1))).toBe(1);
    const of = (root: string) => facts(origin).find((p) => p.gate === root)!.planDigest!;
    record(origin, "b", of("b"), "alice", 2);
    record(origin, "a", of("a"), "alice", 2);
    lines.length = 0;
    expect(await applyWave(work, opts(bin, [["a", "b"]], 3))).toBe(1);
    expect(existsSync(log)).toBe(false);
    expect(lines.join("\n")).toContain("a: the override by alice does not count: policy.override at base lets bob override a for main.deny_data");
    // Nothing was spent: bob's override of a, beside alice's of b, lets the wave through.
    record(origin, "a", of("a"), "bob", 4);
    expect(await applyWave(work, opts(bin, [["a", "b"]], 5))).toBe(0);
    expect(existsSync(log)).toBe(true);
  });
});
