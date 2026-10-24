// A hard-mandatory rule: denies like any rule, and no override can pass it.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLedger, applyWave } from "../src/apply";
import { overrideDenial } from "../src/approve";
import { OVERRIDE_LEDGER, OVERRIDE_OP, overrideDigest } from "../src/override";
import { checkPlan, declaredHardMandatory, describeVerdict, hardMandatoryRules, rootPolicy, type PolicyExec } from "../src/report/policy";
import { git, tmp, write } from "./helpers";
import { T, setup } from "./apply-helpers";

const REGO = [
  "package main",
  "",
  "# Public buckets are never acceptable.",
  "# terragucci: hard-mandatory",
  "# (the level is read from the comment above)",
  "deny_public contains msg if {",
  '  msg := "bucket is public"',
  "}",
  "",
  "# terragucci: hard-mandatory",
  "",
  "deny_blank contains msg if { msg := \"a blank line cuts the annotation off\" }",
  "",
  "deny_data contains msg if { msg := \"data is not allowed\" }",
  "",
].join("\n");

const conftest = (...rules: [string, string][]): PolicyExec => async (_f, args) =>
  args[0] === "--version"
    ? { status: 0, stdout: "", stderr: "" }
    : { status: 1, stdout: JSON.stringify([{ namespace: "main", failures: rules.map(([rule, msg]) => ({ msg, metadata: { query: `data.main.${rule}` } })) }]), stderr: "" };

describe("hard-mandatory rules in Rego", () => {
  it("reads the annotation on the comment lines above a rule head, and only there", () => {
    const dir = write(tmp(), { "p.rego": REGO, "p_test.rego": "package main\n# terragucci: hard-mandatory\ndeny_tested if true\n" });
    expect([...hardMandatoryRules(dir)]).toEqual(["main.deny_public"]);
  });

  it("marks the verdict's hard rules and leaves the others overridable", async () => {
    const policy = write(tmp(), { "policy/p.rego": REGO });
    const repo = policy;
    const v = await checkPlan("conftest", { path: "policy" }, repo, "{}", { exec: conftest(["deny_public", "bucket is public"], ["deny_data", "data is not allowed"]) });
    expect(v.rules).toEqual(["main.deny_data", "main.deny_public"]);
    expect(v.hard).toEqual(["main.deny_public"]);
    expect(rootPolicy(v)).toMatchObject({ result: "denied", hard_mandatory: ["main.deny_public"] });
    expect(describeVerdict("conftest", v)).toContain("main.deny_public is hard-mandatory: no override, approval or agent action can pass it");
    const soft = await checkPlan("conftest", { path: "policy" }, repo, "{}", { exec: conftest(["deny_data", "data is not allowed"]) });
    expect(soft.hard).toBeUndefined();
    expect(rootPolicy(soft).hard_mandatory).toBeUndefined();
  });
});

describe("hard-mandatory in policies.hcl", () => {
  const hcl = [
    'policy "no_public" {\n  query = "data.terraform.policies.no_public.deny"\n  enforcement_level = "hard-mandatory"\n}',
    'policy "tags" {\n  query = "data.terraform.policies.tags.deny"\n  enforcement_level = "mandatory"\n}',
  ].join("\n");

  it("denies like mandatory and marks the policy hard", async () => {
    const dir = write(tmp(), { "policies.hcl": hcl });
    const exec: PolicyExec = async (_f, args) => ({ status: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value: [args[args.length - 1].includes("no_public") ? "bucket is public" : "no owner tag"] }] }] }), stderr: "" });
    const v = await checkPlan("opa", { engine: "opa", input: "hcp", path: dir }, tmp(), "{}", { exec }, { root: "a" });
    expect(v).toEqual({ violations: ["no_public: bucket is public", "tags: no owner tag"], rules: ["no_public", "tags"], hard: ["no_public"] });
    expect([...declaredHardMandatory(dir)]).toEqual(["no_public"]);
  });
});

describe("terragucci override", () => {
  const plan = "jcs1-sha256:" + "1".repeat(64);
  const rules = ["main.deny_data", "main.deny_public"];
  const denial = { version: 1, kind: "pending", op: OVERRIDE_OP, gate: "a", timestamp: T(1), expiresAt: T(49), planDigest: overrideDigest("a", plan, rules), members: [{ member: "a", planDigest: plan }], rules };

  it("refuses a hard-mandatory rule even when a denial is on the ledger and policy.override lists the person", async () => {
    const dir = tmp("tg-hard-");
    const origin = join(dir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    const life = join(dir, "life");
    git(dir, "init", "-q", "-b", "chant/lifecycle", life);
    write(life, { [OVERRIDE_LEDGER]: JSON.stringify(denial) + "\n" });
    git(life, "add", "-A");
    git(life, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ledger");
    git(life, "push", "-q", origin, "chant/lifecycle");
    const work = join(dir, "work");
    git(dir, "init", "-q", "-b", "main", work);
    write(work, { "terragucci.yml": "policy:\n  path: policy\n  override: [alice]\n", "policy/p.rego": REGO });
    git(work, "remote", "add", "origin", origin);
    await expect(overrideDenial(work, { root: "a", rules, reason: "the incident needs it", dryRun: true, log: () => {} })).rejects.toThrow(/main\.deny_public is hard-mandatory: no override, whoever policy\.override lists, can pass/);
    // The rules that are not hard-mandatory still override.
    const ok = await overrideDenial(work, { root: "a", rules: ["main.deny_data"], reason: "x", dryRun: true, log: () => {} }).catch((e: Error) => e);
    expect(String(ok)).not.toMatch(/hard-mandatory/);
  });
});

describe("a wave denied by a hard-mandatory rule", () => {
  afterEach(() => vi.restoreAllMocks());
  const config = "policy:\n  path: policy\n  override: [alice]\n";
  const opts = (bin: string, exec: PolicyExec) => ({ wave: 1, layers: [["a"]], binary: bin, gate: "never" as const, env: {}, policy: { exec } });
  const ledger = (origin: string) => parseLedger(git(origin, "show", `chant/lifecycle:${OVERRIDE_LEDGER}`));
  const report = (work: string) => JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));
  const logs = () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    return lines;
  };

  it("records no denial to override, refuses naming the rule, and an override written to the ledger passes nothing", async () => {
    const lines = logs();
    const { work, origin, bin, log } = setup({ "terragucci.yml": config, "policy/p.rego": REGO });
    const exec = conftest(["deny_public", "bucket is public"]);
    expect(await applyWave(work, { ...opts(bin, exec), now: T(1) })).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("main.deny_public is hard-mandatory, so no override, approval or agent action can pass this denial");
    expect(text).not.toContain("terragucci override");
    expect(existsSync(log)).toBe(false);
    expect(report(work).waves[0].refused).toMatchObject({ reason: "policy", roots: ["a"], hard_mandatory: ["main.deny_public"] });
    expect(report(work).roots[0].policy).toMatchObject({ rules: ["main.deny_public"], hard_mandatory: ["main.deny_public"] });
    // A pending fact for it never exists, but a line written to the ledger by a listed person still passes nothing.
    let facts: ReturnType<typeof ledger>["pending"] = [];
    try { facts = ledger(origin).pending; } catch { /* no ledger at all */ }
    expect(facts).toHaveLength(0);
    const digest = overrideDigest("a", "jcs1-sha256:" + "0".repeat(64), ["main.deny_public"]);
    const clone = join(tmp("tg-hard-"), "l");
    execFileSync("git", ["clone", "-q", origin, clone]);
    git(clone, "checkout", "-q", "-B", "chant/lifecycle");
    write(clone, { [OVERRIDE_LEDGER]: JSON.stringify({ version: 1, kind: "resolution", op: OVERRIDE_OP, gate: "a", resolvedBy: "alice", timestamp: T(2), planDigest: digest, note: "please" }) + "\n" });
    git(clone, "add", "-A");
    git(clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "override");
    git(clone, "push", "-q", "-f", "origin", "chant/lifecycle");
    expect(await applyWave(work, { ...opts(bin, exec), now: T(3) })).toBe(1);
    expect(existsSync(log)).toBe(false);
  });

  it("leaves the other rules of the repo overridable", async () => {
    const lines = logs();
    const { work, origin, bin, log } = setup({ "terragucci.yml": config, "policy/p.rego": REGO });
    expect(await applyWave(work, { ...opts(bin, conftest(["deny_data", "data is not allowed"])), now: T(1) })).toBe(1);
    expect(lines.join("\n")).toContain('terragucci override a --rule main.deny_data --reason "<why>"');
    expect(ledger(origin).pending[0]).toMatchObject({ op: OVERRIDE_OP, gate: "a", rules: ["main.deny_data"] });
    expect(existsSync(log)).toBe(false);
  });
});
