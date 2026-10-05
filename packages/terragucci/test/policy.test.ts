// The opt-in `policy:` key: conftest or OPA over each root's plan JSON, with a
// fake engine so no binary is needed.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { checkPlan, conftestViolations, describeVerdict, engineBinary, opaViolations, CONFTEST_SHA256, type PolicyExec } from "../src/report/policy";
import { runStage } from "../src/report/stage";
import { tmp, write } from "./helpers";

const deny = (...msgs: string[]) => JSON.stringify([{ filename: "plan.json", namespace: "main", successes: 1, failures: msgs.map((msg) => ({ msg })), warnings: [{ msg: "advice only" }] }]);

describe("policy output", () => {
  it("counts conftest failures and not warnings", () => {
    expect(conftestViolations(deny("no public buckets", "tag everything"))).toEqual(["no public buckets", "tag everything"]);
    expect(conftestViolations(deny())).toEqual([]);
    expect(conftestViolations("not json")).toBeUndefined();
  });

  it("reads the deny set from opa eval", () => {
    expect(opaViolations(JSON.stringify({ result: [{ expressions: [{ value: ["a", "b"] }] }] }))).toEqual(["a", "b"]);
    expect(opaViolations("{}")).toEqual([]);
    expect(opaViolations(JSON.stringify({ result: [{ expressions: [{ value: "x" }] }] }))).toBeUndefined();
  });
});

describe("checkPlan", () => {
  const policy = { engine: "conftest" as const, path: "policy" };
  it("passes a plan the policy allows and names what it denies", async () => {
    const repo = tmp();
    const exec: PolicyExec = async () => ({ status: 1, stdout: deny("no public buckets"), stderr: "" });
    expect(await checkPlan("conftest", policy, repo, "{}", { exec })).toEqual({ violations: ["no public buckets"] });
    const ok: PolicyExec = async () => ({ status: 0, stdout: deny(), stderr: "" });
    expect(await checkPlan("conftest", policy, repo, "{}", { exec: ok })).toEqual({ violations: [] });
  });

  it("fails closed when the engine gives no verdict or cannot run", async () => {
    const repo = tmp();
    const broken: PolicyExec = async () => ({ status: 2, stdout: "", stderr: "policy does not compile" });
    const v = await checkPlan("conftest", policy, repo, "{}", { exec: broken });
    expect(v.error).toMatch(/no verdict/);
    expect(describeVerdict("conftest", v)).toMatch(/could not be checked, so the root fails/);
    const crashed: PolicyExec = async () => ({ status: 2, stdout: "[]", stderr: "boom" });
    expect((await checkPlan("conftest", policy, repo, "{}", { exec: crashed })).error).toMatch(/exited 2/);
  });

  it("runs opa with the namespace's deny rule", async () => {
    let seen: string[] = [];
    const exec: PolicyExec = async (_f, args) => ((seen = args), { status: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value: ["x"] }] }] }), stderr: "" });
    const v = await checkPlan("opa", { engine: "opa", namespace: "terraform.plan" }, tmp(), "{}", { exec });
    expect(v.violations).toEqual(["x"]);
    expect(seen).toContain("data.terraform.plan.deny");
  });
});

describe("engineBinary", () => {
  it("uses conftest from the path, and refuses a download that misses its pinned digest", async () => {
    const onPath: PolicyExec = async () => ({ status: 0, stdout: "", stderr: "" });
    expect(await engineBinary({}, tmp(), { exec: onPath })).toBe("conftest");
    const absent: PolicyExec = async () => ({ status: null, stdout: "", stderr: "ENOENT" });
    await expect(engineBinary({}, tmp(), { exec: absent, cache: tmp(), arch: "x64", download: async () => Buffer.from("not conftest") })).rejects.toThrow(/does not match its pinned digest/);
    expect(CONFTEST_SHA256.x86_64).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
  });

  it("will not fetch opa", async () => {
    const absent: PolicyExec = async () => ({ status: null, stdout: "", stderr: "ENOENT" });
    await expect(engineBinary({ engine: "opa" }, tmp(), { exec: absent })).rejects.toThrow(/not on the path/);
  });
});

describe("config", () => {
  it("is off by default and accepts the three keys", () => {
    expect(validateConfig({}, "t").policy).toBeUndefined();
    expect(validateConfig({ policy: { engine: "opa", path: "rego", namespace: "terraform.plan" } }, "t").policy).toEqual({ engine: "opa", path: "rego", namespace: "terraform.plan" });
  });
});

const TOFU = (await import("node:child_process")).spawnSync("tofu", ["version"]).status === 0;

describe.skipIf(!TOFU)("terragucci stage tf-plan with policy", () => {
  const files = (extra: Record<string, string> = {}) => ({
    "terragucci.yml": 'binary: tofu\nroots: ["a"]\npolicy:\n  path: policy\n',
    "a/main.tf": 'resource "terraform_data" "x" {\n  input = 1\n}\n',
    ...extra,
  });

  it("fails the root and names the violation when the policy denies the plan", { timeout: 120_000 }, async () => {
    const repo = write(tmp(), files({ "policy/p.rego": "package main\n" }));
    const exec: PolicyExec = async (_f, args) => (args[0] === "--version" ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: deny("terraform_data.x is not allowed"), stderr: "" });
    const result = await runStage("tf-plan", repo, { policy: { exec } }, () => {});
    expect(result.failed).toBe(true);
    expect(result.report.roots[0].status).toBe("failed");
    expect(JSON.stringify(result.report)).toContain("terraform_data.x is not allowed");
  });

  it("changes nothing when the policy key is absent", { timeout: 120_000 }, async () => {
    const repo = write(tmp(), files({ "terragucci.yml": 'binary: tofu\nroots: ["a"]\n' }));
    const exec: PolicyExec = async () => {
      throw new Error("the engine must not run");
    };
    const result = await runStage("tf-plan", repo, { policy: { exec } }, () => {});
    expect(result.failed).toBe(false);
  });

  it("fails every root when the policy directory is missing", { timeout: 120_000 }, async () => {
    const repo = write(tmp(), files());
    const result = await runStage("tf-plan", repo, {}, () => {});
    expect(result.failed).toBe(true);
    expect(JSON.stringify(result.report)).toContain("policy directory policy does not exist");
  });
});
