// tf-check's steps beyond the format check, with a fake exec so no binary is needed.
import { describe, expect, it } from "vitest";
import { checkPolicyTests, checkRoot, diagnosticWhere, hasPolicyTests, parseLiveCheck, parseValidate, policyBase } from "../src/check";
import type { PolicyExec } from "../src/report/policy";
import { git, tmp, write } from "./helpers";

const bad = JSON.stringify({
  format_version: "1.0",
  valid: false,
  error_count: 1,
  warning_count: 1,
  diagnostics: [
    { severity: "error", summary: "Unsupported argument", detail: 'An argument named "bogus" is not expected here.', range: { filename: "main.tf", start: { line: 12, column: 3 }, end: { line: 12, column: 8 } } },
    { severity: "warning", summary: "Deprecated", range: { filename: "main.tf", start: { line: 3, column: 1 }, end: { line: 3, column: 1 } } },
  ],
});
const good = JSON.stringify({ format_version: "1.0", valid: true, error_count: 0, warning_count: 0, diagnostics: [] });

const fake = (answers: Record<string, { status: number; stdout?: string; stderr?: string }>): { exec: PolicyExec; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (file, args) => {
      calls.push([file, ...args]);
      const key = args.includes("validate") ? "validate" : args[0] === "live-check" && !args.includes("-json") ? "live-check-text" : args[0];
      const a = answers[key] ?? answers[args[0]] ?? { status: 0, stdout: "" };
      return { status: a.status, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
    },
  };
};

describe("validate -json", () => {
  it("names each diagnostic with its file and range", () => {
    const [error] = parseValidate(bad)!.diagnostics;
    expect(diagnosticWhere("app", error)).toBe("app/main.tf:12:3-12:8");
    expect(diagnosticWhere(".", error)).toBe("main.tf:12:3-12:8");
    expect(parseValidate("Error: no")).toBeUndefined();
  });

  it("fails the root on an error, prints every diagnostic and does not stop at the first", async () => {
    const { exec, calls } = fake({ validate: { status: 1, stdout: bad } });
    const r = await checkRoot("tofu", "app", "/repo", { exec });
    expect(r.ok).toBe(false);
    expect(r.log.join("\n")).toContain("error: app/main.tf:12:3-12:8: Unsupported argument");
    expect(r.log.join("\n")).toContain("warning: app/main.tf:3:1: Deprecated");
    expect(r.report.join("\n")).toContain("`app/main.tf:12:3-12:8`");
    expect(calls).toEqual([["tofu", "-chdir=app", "validate", "-json"]]);
  });

  it("passes a valid root and runs no live-check for tofu", async () => {
    const { exec, calls } = fake({ validate: { status: 0, stdout: good } });
    const r = await checkRoot("tofu", "app", "/repo", { exec });
    expect(r.ok).toBe(true);
    expect(r.log).toEqual(["valid app"]);
    expect(calls).toHaveLength(1);
  });

  it("fails a root whose validate printed nothing parseable", async () => {
    const r = await checkRoot("tofu", "app", "/repo", { exec: fake({ validate: { status: 1, stderr: "boom" } }).exec });
    expect(r.ok).toBe(false);
    expect(r.log.join("\n")).toContain("boom");
  });
});

describe("choudoufu live-check", () => {
  const refused = JSON.stringify({ blocked: true, exit_code: 1, instances: [{ address: "aws_x.y", type: "aws_x", refused: true, rule: "count-index", reason: "count.index in a resource name" }, { address: "aws_ok.z", type: "aws_ok", refused: false }] });

  it("runs after validate and fails the check on a refusal, naming it", async () => {
    const { exec, calls } = fake({ validate: { status: 0, stdout: good }, "live-check": { status: 1, stdout: refused } });
    const r = await checkRoot("choudoufu", "app", "/repo", { exec });
    expect(r.ok).toBe(false);
    expect(calls.map((c) => c[1])).toEqual(["-chdir=app", "live-check"]);
    expect(calls[1]).toEqual(["choudoufu", "live-check", "-json", "app"]);
    expect(r.log.join("\n")).toContain("refused: app: count-index: count.index in a resource name [aws_x]: aws_x.y");
    expect(r.log.join("\n")).not.toContain("aws_ok.z");
    expect(r.report.join("\n")).toContain("refused: `app`: count-index: count.index in a resource name [aws_x]: aws_x.y");
  });

  it("passes when nothing is refused, and fails when live-check could not read the directory", async () => {
    const clean = JSON.stringify({ blocked: false, exit_code: 0, instances: [] });
    expect((await checkRoot("choudoufu", "app", "/repo", { exec: fake({ validate: { status: 0, stdout: good }, "live-check": { status: 0, stdout: clean } }).exec })).ok).toBe(true);
    const unreadable = await checkRoot("choudoufu", "app", "/repo", { exec: fake({ validate: { status: 0, stdout: good }, "live-check": { status: 1, stderr: "Error: cannot parse" } }).exec });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.log.join("\n")).toContain("cannot parse");
    expect(parseLiveCheck("nope")).toBeUndefined();
  });

  it("reads the text output when live-check blocks but the JSON lists no refused instance", async () => {
    const blockedOnly = JSON.stringify({ blocked: true, exit_code: 1, instances: [{ address: "terraform_data.probe", type: "terraform_data" }] });
    const text = [". cannot move under live resource markers yet.", "1 refusal(s) across 1 site(s); 1 managed resource instance(s) resolved.", "", "Logical resource is not admitted  (1 site(s), lint)", "    terraform_data                           1"].join("\n");
    const { exec, calls } = fake({ validate: { status: 0, stdout: good }, "live-check": { status: 1, stdout: blockedOnly }, "live-check-text": { status: 1, stdout: text } });
    const r = await checkRoot("choudoufu", "app", "/repo", { exec });
    expect(r.ok).toBe(false);
    expect(calls[2]).toEqual(["choudoufu", "live-check", "app"]);
    const log = r.log.join("\n");
    expect(log).toContain("refused: app: Logical resource is not admitted  (1 site(s), lint)");
    expect(log).toContain("refused: app:     terraform_data                           1");
    expect(log).not.toContain("refused: app: \n");
    expect(r.report.join("\n")).toContain("refused: `app`: Logical resource is not admitted");
    expect(log).toContain("FAILED app: choudoufu live-check refused 0 resources (exit 1)");
  });

  it("falls back to the text output when the JSON does not parse", async () => {
    const unparsed = await checkRoot("choudoufu", "app", "/repo", { exec: fake({ validate: { status: 0, stdout: good }, "live-check": { status: 1, stdout: "garbage" }, "live-check-text": { status: 1, stdout: "Logical resource is not admitted" } }).exec });
    expect(unparsed.log.join("\n")).toContain("refused: app: Logical resource is not admitted");
  });

  it("reads live-check's refusals array (choudoufu 0.22.0) and does not run the text output", async () => {
    const arr = JSON.stringify({
      blocked: true,
      instances: [{ address: "terraform_data.probe", type: "terraform_data" }],
      refusals: [
        { rule: "logical", reason: "Logical resource is not admitted", count: 2, types: [{ type: "terraform_data", count: 2 }], sites: [{ address: "terraform_data.probe", location: "main.tf:1" }, { address: "terraform_data.other", location: "main.tf:5" }] },
        { rule: "count-index", reason: "count.index in a resource name", count: 1, types: [{ type: "aws_x", count: 1 }], sites: [] },
      ],
    });
    const { exec, calls } = fake({ validate: { status: 0, stdout: good }, "live-check": { status: 1, stdout: arr } });
    const r = await checkRoot("choudoufu", "app", "/repo", { exec });
    const log = r.log.join("\n");
    expect(r.ok).toBe(false);
    expect(log).toContain("refused: app: logical: Logical resource is not admitted [terraform_data x2]: terraform_data.probe (main.tf:1), terraform_data.other (main.tf:5)");
    expect(log).toContain("refused: app: count-index: count.index in a resource name [aws_x]");
    expect(log).toContain("FAILED app: choudoufu live-check refused 3 resources (exit 1)");
    expect(r.report.join("\n")).toContain("refused: `app`: logical: Logical resource is not admitted");
    expect(calls).toHaveLength(2);
    const parsed = parseLiveCheck(arr);
    expect(parsed?.refused.map((x) => x.count)).toEqual([2, 1]);
  });

  it("still runs live-check when validate failed, so one run shows both", async () => {
    const { exec, calls } = fake({ validate: { status: 1, stdout: bad }, "live-check": { status: 0, stdout: JSON.stringify({ blocked: false, instances: [] }) } });
    const r = await checkRoot("choudoufu", "app", "/repo", { exec });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe("policy tests", () => {
  const repoWith = (policy: string, files: Record<string, string>): string => write(tmp(), { "terragucci.yml": policy, ...files });

  it("does nothing without a policy: key", async () => {
    const repo = write(tmp(), { "terragucci.yml": "binary: tofu\n" });
    const { exec, calls } = fake({});
    expect(await checkPolicyTests(repo, { exec, env: {} })).toEqual({ ok: true, log: [], report: [] });
    expect(calls).toEqual([]);
  });

  it("skips with a note when the directory has no tests", async () => {
    const repo = repoWith("policy:\n  engine: conftest\n", { "policy/main.rego": "package main\n" });
    const { exec, calls } = fake({});
    const r = await checkPolicyTests(repo, { exec, env: {}, policy: { exec } });
    expect(r.ok).toBe(true);
    expect(r.log[0]).toMatch(/policy tests skipped: policy has no \*_test\.rego files/);
    expect(calls).toEqual([]);
    expect(hasPolicyTests(`${repo}/policy`)).toBe(false);
  });

  it("runs conftest verify and fails on a failing test, with the output in the log", async () => {
    const repo = repoWith("policy:\n  engine: conftest\n", { "policy/main.rego": "package main\n", "policy/main_test.rego": "package main\n" });
    const { exec, calls } = fake({ verify: { status: 1, stdout: "FAIL - test_no_public_bucket" } });
    const r = await checkPolicyTests(repo, { exec, env: {}, policy: { exec } });
    expect(r.ok).toBe(false);
    expect(calls.at(-1)).toEqual(["conftest", "verify", "--no-color", "--policy", `${repo}/policy`]);
    expect(r.log.join("\n")).toContain("FAIL - test_no_public_bucket");
  });

  it("runs opa test for the opa engine and passes", async () => {
    const repo = repoWith("policy:\n  engine: opa\n  path: rules\n", { "rules/p_test.rego": "package main\n" });
    const { exec, calls } = fake({ test: { status: 0, stdout: "PASS: 1/1" } });
    const r = await checkPolicyTests(repo, { exec, env: {}, policy: { exec } });
    expect(r.ok).toBe(true);
    expect(calls.at(-1)).toEqual(["opa", "test", `${repo}/rules`]);
  });

  it("runs the base's policy tests when the change deletes the policy key", async () => {
    const repo = repoWith("policy:\n  engine: opa\n", { "policy/p.rego": "package main\n", "policy/p_test.rego": "package main\n" });
    git(repo, "init", "-q", "-b", "main");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main");
    git(repo, "checkout", "-q", "-b", "pr");
    write(repo, { "terragucci.yml": "binary: tofu\n" });
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "drop policy");
    const { exec, calls } = fake({ test: { status: 1, stdout: "FAIL: test_denies" } });
    const r = await checkPolicyTests(repo, { exec, env: {}, base: "main", policy: { exec } });
    expect(r.ok).toBe(false);
    expect(calls.at(-1)?.[1]).toBe("test");
    expect(r.log[0]).toMatch(/read from main, not from this checkout/);
  });

  it("reads the base from the pull request's target, or the default branch for a push to another branch", () => {
    expect(policyBase({ GITHUB_BASE_REF: "main" })).toBe("origin/main");
    expect(policyBase({ GITHUB_REF_NAME: "feature", TG_BRANCH: "main" })).toBe("origin/main");
    expect(policyBase({ GITHUB_REF_NAME: "main", TG_BRANCH: "main" })).toBeUndefined();
    expect(policyBase({ TG_BASE: "origin/dev" })).toBe("origin/dev");
  });
});
