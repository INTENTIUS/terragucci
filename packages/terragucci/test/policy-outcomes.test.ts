import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { validateConfig } from "../src/config";
import { policyGate } from "../src/report/build";
import { checkPlan, opaFindings, rootPolicy, type PolicyExec } from "../src/report/policy";
import { T, setup } from "./apply-helpers";
import { tmp } from "./helpers";

/** opa on the path, answering every query with `value` as the package's document. */
const opa = (value: Record<string, unknown>): PolicyExec => async (_f, args) =>
  args[0] === "version" ? { status: 0, stdout: "", stderr: "" } : { status: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value }] }] }), stderr: "" };

describe("policy.outcomes in the config", () => {
  it.each([
    [{ policy: { engine: "opa", outcomes: "hold" } }, /config\.policy\.outcomes must be a list of deny, hold, allow_unattended/],
    [{ policy: { engine: "opa", outcomes: ["deny", "release"] } }, /config\.policy\.outcomes must be a list of deny, hold, allow_unattended/],
    [{ policy: { engine: "opa", outcomes: ["deny", "hold", "hold"] } }, /config\.policy\.outcomes names an outcome twice/],
    [{ policy: { engine: "opa", outcomes: ["hold"] } }, /config\.policy\.outcomes leaves out deny/],
    [{ policy: { outcomes: ["deny", "allow_unattended"] } }, /config\.policy\.outcomes names allow_unattended, which only engine: opa reads/],
  ])("%j is refused", (raw, message) => {
    expect(() => validateConfig(raw, "t")).toThrow(message);
  });

  it("takes deny alone under either engine, and hold and allow_unattended under opa", () => {
    expect(() => validateConfig({ policy: { outcomes: ["deny"] } }, "t")).not.toThrow();
    expect(() => validateConfig({ policy: { engine: "opa", outcomes: ["deny", "hold", "allow_unattended"] } }, "t")).not.toThrow();
  });
});

describe("hold and allow_unattended rules", () => {
  const answer = (value: Record<string, unknown>) => JSON.stringify({ result: [{ expressions: [{ value }] }] });

  it("opa's answer names each hold rule that holds with its message, and each allow_unattended rule that holds", () => {
    const found = opaFindings(answer({ deny: [], hold_iam: ["aws_iam_role.x changes IAM"], allow_unattended: true, allow_unattended_tags: false, allow_unattended_routine: [] }))!;
    expect(found.holds).toEqual([{ rule: "main.hold_iam", message: "aws_iam_role.x changes IAM" }]);
    expect(found.allows).toEqual(["main.allow_unattended"]);
    expect(found.violations).toEqual([]);
  });

  it("count only when policy.outcomes names them", async () => {
    const exec = opa({ hold: ["needs a person"], allow_unattended_tags: true });
    const on = await checkPlan("opa", { engine: "opa", outcomes: ["deny", "hold", "allow_unattended"] }, tmp(), "{}", { exec });
    expect(on).toEqual({ violations: [], holds: [{ rule: "main.hold", message: "needs a person" }], allows: ["main.allow_unattended_tags"] });
    expect(await checkPlan("opa", { engine: "opa" }, tmp(), "{}", { exec })).toEqual({ violations: [] });
    expect(await checkPlan("opa", { engine: "opa", outcomes: ["deny", "hold"] }, tmp(), "{}", { exec })).toEqual({ violations: [], holds: [{ rule: "main.hold", message: "needs a person" }] });
    expect(rootPolicy(on)).toMatchObject({ result: "passed", held_by: ["main.hold"], holds: ["needs a person"], allowed_by: ["main.allow_unattended_tags"] });
  });
});

describe("a wave's gate under the rules", () => {
  const passed = { result: "passed" as const, denials: [], warnings: [] };
  it("any hold holds it; an allow for every changing root and no hold releases it; otherwise gate decides", () => {
    expect(policyGate([{ policy: { ...passed, allowed_by: ["main.allow_unattended"] } }, { policy: { ...passed, held_by: ["main.hold_iam"] } }])).toEqual({ outcome: "held", rules: ["main.hold_iam"] });
    expect(policyGate([{ policy: { ...passed, allowed_by: ["main.allow_b"] } }, { policy: { ...passed, allowed_by: ["main.allow_a"] } }])).toEqual({ outcome: "unattended", rules: ["main.allow_a", "main.allow_b"] });
    expect(policyGate([{ policy: { ...passed, allowed_by: ["main.allow_a"] } }, { policy: passed }])).toBeUndefined();
    expect(policyGate([{}])).toBeUndefined();
    expect(policyGate([])).toBeUndefined();
  });
});

describe("tf-apply with policy.outcomes", () => {
  afterEach(() => vi.restoreAllMocks());
  const config = (outcomes?: string) => `policy:\n  engine: opa\n  path: policy\n${outcomes ? `  outcomes: ${outcomes}\n` : ""}`;
  const files = (outcomes?: string) => ({ "terragucci.yml": config(outcomes), "policy/p.rego": "package main\n\ndeny contains \"never\" if { false }\n\nallow_unattended if { true }\n\nhold contains \"x\" if { false }\n" });
  const run = (bin: string, gate: "always" | "never", exec: PolicyExec) => ({ wave: 1, layers: [["a"]], binary: bin, gate, env: {}, now: T(1), policy: { exec } });
  const report = (work: string) => JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8"));

  it("a wave whose every changing root is allowed applies under gate: always with no approval, and its report names the rules and the policy commit", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const { work, bin, log } = setup(files("[deny, allow_unattended]"));
    expect(await applyWave(work, run(bin, "always", opa({ allow_unattended: true })))).toBe(0);
    expect(existsSync(log)).toBe(true);
    const wave = report(work).waves[0];
    expect(wave).toMatchObject({ approval: "not-required", policy_gate: { outcome: "unattended", rules: ["main.allow_unattended"] } });
    expect(wave.policy_gate.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report(work).roots[0].policy).toMatchObject({ allowed_by: ["main.allow_unattended"] });
    expect(lines.join("\n")).toContain("so gate always does not hold it");
  });

  it("with outcomes unset an allow_unattended rule changes nothing: the wave waits under gate: always", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { work, bin, log } = setup(files());
    expect(await applyWave(work, run(bin, "always", opa({ allow_unattended: true })))).toBe(3);
    expect(existsSync(log)).toBe(false);
    expect(report(work).waves[0].policy_gate).toBeUndefined();
  });

  it("a hold rule makes a wave wait under gate: never", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const { work, bin, log } = setup(files("[deny, hold]"));
    expect(await applyWave(work, run(bin, "never", opa({ hold: ["needs a person"] })))).toBe(3);
    expect(existsSync(log)).toBe(false);
    expect(report(work).waves[0]).toMatchObject({ approval: "waiting", policy_gate: { outcome: "held", rules: ["main.hold"] } });
    expect(lines.join("\n")).toContain("the policy holds it for an approval (main.hold), although gate is never");
  });

  it("with allow_unattended on, a wave the rules do not release waits under gate: always, held by its held hook", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { work, bin, log } = setup(files("[deny, allow_unattended]"));
    expect(await applyWave(work, run(bin, "always", opa({})))).toBe(3);
    expect(existsSync(log)).toBe(false);
    expect(report(work).waves[0].approval).toBe("waiting");
  });
});
