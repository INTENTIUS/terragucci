// The opt-in `policy:` key: conftest or OPA over each root's plan JSON, with a
// fake engine so no binary is needed.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPlan, checkPlans, trustedPolicy, conftestFindings, conftestViolations, describeVerdict, engineBinary, hcpRun, opaFindings, opaViolations, policyInput, resolvePolicySettings, CONFTEST_SHA256, OPA_SHA256, OPA_VERSION, type PolicyExec } from "../src/report/policy";
import { buildReport } from "../src/report/build";
import { renderNote } from "../src/report/views";
import { plan, rc, RUN } from "./report-fixtures";
import { runStage } from "../src/report/stage";
import { git, tmp, write } from "./helpers";

const deny = (...msgs: string[]) => JSON.stringify([{ filename: "plan.json", namespace: "main", successes: 1, failures: msgs.map((msg) => ({ msg })), warnings: [{ msg: "advice only" }] }]);

describe("policy output", () => {
  it("counts conftest failures and not warnings", () => {
    expect(conftestViolations(deny("no public buckets", "tag everything"))).toEqual(["no public buckets", "tag everything"]);
    expect(conftestViolations(deny())).toEqual([]);
    expect(conftestViolations("not json")).toBeUndefined();
  });

  it("reads conftest warnings apart from its failures", () => {
    expect(conftestFindings(deny("no public buckets"))).toEqual({ violations: ["no public buckets"], warnings: ["advice only"] });
  });

  it("reads the deny set from opa eval", () => {
    expect(opaViolations(JSON.stringify({ result: [{ expressions: [{ value: ["a", "b"] }] }] }))).toEqual(["a", "b"]);
    expect(opaViolations("{}")).toEqual([]);
    expect(opaViolations(JSON.stringify({ result: [{ expressions: [{ value: "x" }] }] }))).toBeUndefined();
    expect(opaViolations(JSON.stringify({ errors: [{ message: "rego_parse_error" }] }))).toBeUndefined();
  });

  it("counts deny, violation and deny_* from an opa package as conftest does, and reads warn apart", () => {
    const pkg = {
      deny: ["d"],
      violation: [{ msg: "v", details: {} }],
      deny_public: ["dp"],
      violation_tags: ["vt"],
      warn: ["w"],
      warn_cost: ["wc"],
      denylist: ["not a rule that counts"],
      allowed: true,
      sub: { deny: ["a child package"] },
    };
    const out = JSON.stringify({ result: [{ expressions: [{ value: pkg }] }] });
    const found = opaFindings(out)!;
    expect(found.violations.sort()).toEqual(["d", "dp", "v", "vt"]);
    expect(found.warnings.sort()).toEqual(["w", "wc"]);
    // Nested: each child package of terraform.policies is one policy of an HCP set.
    expect(opaFindings(out, true)!.violations).toContain("a child package");
    expect(opaFindings(JSON.stringify({ result: [{ expressions: [{ value: { deny: true } }] }] }))!.violations).toEqual(["deny"]);
  });
});

describe("policy input", () => {
  it("passes the bare plan by default, and {plan, run} with input: hcp", () => {
    expect(policyInput({}, '{"resource_changes":[]}')).toBe('{"resource_changes":[]}');
    const wrapped = JSON.parse(policyInput({ input: "hcp" }, '{"resource_changes":[]}', { root: "envs/dev/app", stage: "tf-plan", project: "github.com/acme/infra", commit: "abc", pullRequest: "7" }));
    expect(wrapped.plan).toEqual({ resource_changes: [] });
    expect(wrapped.run.workspace.name).toBe("envs/dev/app");
    expect(wrapped.run.workspace.working_directory).toBe("envs/dev/app");
    expect(wrapped.run.organization.name).toBe("acme");
    expect(wrapped.run.project.name).toBe("infra");
    expect(wrapped.run.commit_sha).toBe("abc");
    expect(wrapped.run.speculative).toBe(true);
    expect(wrapped.run.message).toBe("pull request 7");
  });

  it("marks a tf-apply run as not speculative", () => {
    expect(hcpRun({ root: "a", stage: "tf-apply" }).speculative).toBe(false);
  });
});

describe("checkPlan", () => {
  const policy = { engine: "conftest" as const, path: "policy" };
  it("passes a plan the policy allows and names what it denies", async () => {
    const repo = tmp();
    const exec: PolicyExec = async () => ({ status: 1, stdout: deny("no public buckets"), stderr: "" });
    expect(await checkPlan("conftest", policy, repo, "{}", { exec })).toEqual({ violations: ["no public buckets"], warnings: ["advice only"] });
    const ok: PolicyExec = async () => ({ status: 0, stdout: deny(), stderr: "" });
    expect(await checkPlan("conftest", policy, repo, "{}", { exec: ok })).toEqual({ violations: [], warnings: ["advice only"] });
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

  it("runs opa over the namespace's package, counting deny_* and showing warn", async () => {
    let seen: string[] = [];
    const exec: PolicyExec = async (_f, args) => ((seen = args), { status: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value: { deny_public: ["x"], warn: ["y"] } }] }] }), stderr: "" });
    const v = await checkPlan("opa", { engine: "opa", namespace: "terraform.plan" }, tmp(), "{}", { exec });
    expect(v).toEqual({ violations: ["x"], warnings: ["y"] });
    expect(seen).toContain("data.terraform.plan");
    await checkPlan("opa", { engine: "opa" }, tmp(), "{}", { exec });
    expect(seen).toContain("data.main");
  });

  it("runs an HCP policy set with input: hcp: every package under terraform.policies, input wrapped as {plan, run}", async () => {
    let seen: string[] = [];
    let input: { plan?: unknown; run?: { workspace?: { name?: string } } } = {};
    const exec: PolicyExec = async (_f, args) => {
      seen = args;
      input = JSON.parse(readFileSync(args[args.indexOf("--input") + 1], "utf-8"));
      return { status: 0, stdout: JSON.stringify({ result: [{ expressions: [{ value: { no_public: { deny: ["public"] }, tags: { deny: [] } } }] }] }), stderr: "" };
    };
    const v = await checkPlan("opa", { engine: "opa", input: "hcp" }, tmp(), '{"format_version":"1.2"}', { exec }, { root: "envs/dev/app" });
    expect(seen).toContain("data.terraform.policies");
    expect(input.plan).toEqual({ format_version: "1.2" });
    expect(input.run?.workspace?.name).toBe("envs/dev/app");
    expect(v.violations).toEqual(["public"]);
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

  it("fetches opa on demand from its pinned release, and refuses a download that misses the digest", async () => {
    const absent: PolicyExec = async () => ({ status: null, stdout: "", stderr: "ENOENT" });
    let url = "";
    const download = async (u: string) => ((url = u), Buffer.from("not opa"));
    await expect(engineBinary({ engine: "opa" }, tmp(), { exec: absent, cache: tmp(), arch: "arm64", download })).rejects.toThrow(/opa .* does not match its pinned digest/);
    expect(url).toBe(`https://github.com/open-policy-agent/opa/releases/download/v${OPA_VERSION}/opa_linux_arm64_static`);
    expect(OPA_SHA256.x86_64).toMatch(/^[0-9a-f]{64}$/);
    expect(OPA_SHA256.arm64).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("config", () => {
  it("is off by default and accepts the three keys", () => {
    expect(validateConfig({}, "t").policy).toBeUndefined();
    expect(validateConfig({ policy: { engine: "opa", path: "rego", namespace: "terraform.plan" } }, "t").policy).toEqual({ engine: "opa", path: "rego", namespace: "terraform.plan" });
    expect(validateConfig({ policy: { input: "hcp" } }, "t").policy).toEqual({ input: "hcp" });
    expect(() => validateConfig({ policy: { input: "spacelift" } }, "t")).toThrow(/policy.input/);
  });
});

/** A repo whose main commits `files`, then a branch `pr` that overwrites `edits` and commits them. */
function prRepo(files: Record<string, string>, edits: Record<string, string>): string {
  const repo = tmp();
  git(repo, "init", "-q", "-b", "main");
  write(repo, files);
  const commit = (m: string) => {
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", m);
  };
  commit("main");
  git(repo, "checkout", "-q", "-b", "pr");
  write(repo, edits);
  commit("pr");
  return repo;
}

const readTree = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf-8")]));

describe("trustedPolicy", () => {
  const yml = "policy:\n  path: policy\n";
  const checkout = { path: "policy" };

  it("reads the policy directory from the base, not from the pull request's edit", async () => {
    const repo = prRepo({ "terragucci.yml": yml, "policy/p.rego": "package main\ndeny contains 1\n" }, { "policy/p.rego": "package main\n" });
    const t = await trustedPolicy(repo, checkout, "main", { config: join(repo, "terragucci.yml") });
    try {
      expect(t.error).toBeUndefined();
      expect(t.from).toBe("base");
      expect(readTree(t.policy.path!)["p.rego"]).toContain("deny contains 1");
    } finally {
      t.cleanup();
    }
  });

  it("reads the policy key from the base, so deleting it in the pull request waives nothing", async () => {
    const repo = prRepo({ "terragucci.yml": "policy:\n  engine: opa\n  path: rego\n", "rego/p.rego": "package main\n" }, { "terragucci.yml": "roots: []\n" });
    const t = await trustedPolicy(repo, {}, "main", { config: join(repo, "terragucci.yml") });
    try {
      expect(t.policy.engine).toBe("opa");
      expect(readTree(t.policy.path!)["p.rego"]).toBe("package main\n");
    } finally {
      t.cleanup();
    }
  });

  it("uses the checkout without a base, and when the base has no policy key", async () => {
    const repo = prRepo({ "terragucci.yml": "roots: []\n" }, { "terragucci.yml": yml, "policy/p.rego": "package main\n" });
    expect((await trustedPolicy(repo, checkout, undefined, {})).from).toBe("checkout");
    const t = await trustedPolicy(repo, checkout, "main", { config: join(repo, "terragucci.yml") });
    expect(t.from).toBe("checkout");
    expect(t.error).toBeUndefined();
  });

  it("reads a terragucci.ts config's policy key from the base, folded and not run", async () => {
    const repo = prRepo(
      { "terragucci.ts": 'export default { policy: { engine: "opa", path: "rego", input: "hcp" } };\n', "rego/p.rego": "package main\n" },
      { "terragucci.ts": "export default { roots: [] };\n" },
    );
    const t = await trustedPolicy(repo, {}, "main", { config: join(repo, "terragucci.ts") });
    try {
      expect(t.error).toBeUndefined();
      expect(t.from).toBe("base");
      expect(t.policy.engine).toBe("opa");
      expect(t.policy.input).toBe("hcp");
      expect(readTree(t.policy.path!)["p.rego"]).toBe("package main\n");
    } finally {
      t.cleanup();
    }
  });

  it("fails closed when a terragucci.ts config at the base is not data", async () => {
    const repo = prRepo({ "terragucci.ts": "export default { policy: { engine: process.env.E } };\n", "policy/p.rego": "package main\n" }, { "terragucci.ts": "export default {};\n" });
    const t = await trustedPolicy(repo, {}, "main", { config: join(repo, "terragucci.ts") });
    expect(t.error).toMatch(/could not read the config at main/);
  });

  it("resolves the settings tf-check reads: directory, engine, namespace and input", async () => {
    const repo = prRepo({ "terragucci.yml": "policy:\n  engine: opa\n  path: rego\n  input: hcp\n", "rego/p.rego": "package main\n" }, { "README.md": "pr\n" });
    const r = await resolvePolicySettings(repo, {}, "main", { config: join(repo, "terragucci.yml") });
    try {
      expect(r).toMatchObject({ engine: "opa", input: "hcp", from: "base" });
      expect(r.namespace).toBeUndefined();
      expect(readTree(r.dir)["p.rego"]).toBe("package main\n");
    } finally {
      r.cleanup();
    }
    const own = await resolvePolicySettings(repo, { path: "nothing" }, undefined);
    expect(own).toMatchObject({ engine: "conftest", input: "plan", from: "checkout" });
    expect(own.error).toMatch(/does not exist/);
  });

  it("fails closed when the base has the key but not the directory, or is not a ref", async () => {
    const repo = prRepo({ "terragucci.yml": yml }, { "policy/p.rego": "package main\n" });
    const t = await trustedPolicy(repo, checkout, "main", { config: join(repo, "terragucci.yml") });
    expect(t.error).toMatch(/does not exist at main/);
    const bad = await trustedPolicy(repo, checkout, "origin/nothing", { config: join(repo, "terragucci.yml") });
    expect(bad.error).toMatch(/could not read/);
  });
});

describe("checkPlans and the report", () => {
  const onPath = (stdout: string, status = 1): PolicyExec => async (_f, args) => (args[0] === "--version" ? { status: 0, stdout: "", stderr: "" } : { status, stdout, stderr: "" });

  it("gives each root its verdict and warnings, and the run's settings", async () => {
    const repo = write(tmp(), { "policy/p.rego": "package main\n" });
    const found = await checkPlans(repo, { path: "policy" }, [{ path: "a", plan: {} }], undefined, {}, { exec: onPath(deny("no")) }, () => {});
    expect(found.roots.get("a")).toEqual({ result: "denied", denials: ["no"], warnings: ["advice only"] });
    expect(found.failed.get("a")).toMatch(/policy violation \(conftest\)/);
    expect(found.policy).toEqual({ engine: "conftest", input: "plan", from: "checkout", denied: ["a"], warnings: 1 });
    const passed = await checkPlans(repo, { path: "policy" }, [{ path: "a", plan: {} }], undefined, {}, { exec: onPath(deny(), 0) }, () => {});
    expect(passed.roots.get("a")).toEqual({ result: "passed", denials: [], warnings: ["advice only"] });
    expect(passed.failed.size).toBe(0);
  });

  it("keeps a denied root's changes in the report, failed with no plan digest, and shows warnings in the note", () => {
    const p = plan([rc("aws_s3_bucket.logs", ["create"], null, { bucket: "logs" })]);
    const report = buildReport({
      run: RUN,
      roots: [
        { path: "envs/dev/a", plan: p, error: "policy violation (conftest):\n- no buckets", policy: { result: "denied", denials: ["no buckets"], warnings: [] } },
        { path: "envs/dev/b", plan: p, policy: { result: "passed", denials: [], warnings: ["tag it"] } },
      ],
      waves: [{ number: 1, roots: ["envs/dev/a", "envs/dev/b"] }],
      policy: { engine: "conftest", input: "plan", from: "checkout", denied: ["envs/dev/a"], warnings: 1 },
    });
    const a = report.roots.find((r) => r.path === "envs/dev/a")!;
    expect(a.status).toBe("failed");
    expect(a.plan_digest).toBeNull();
    expect(a.changes.map((c) => c.address)).toEqual(["aws_s3_bucket.logs"]);
    expect(a.policy?.denials).toEqual(["no buckets"]);
    expect(a.why).toContain("refused by policy");
    expect(report.waves[0].set_digest).toBeNull();
    expect(report.policy?.denied).toEqual(["envs/dev/a"]);
    // Only b's create can apply, so only it counts.
    expect(report.totals.create).toBe(1);
    expect(report.named.find((n) => n.root === "envs/dev/a" && n.action === "refused")?.reason).toMatch(/no buckets/);
    const b = report.roots.find((r) => r.path === "envs/dev/b")!;
    expect(b.status).toBe("planned");
    expect(b.policy?.warnings).toEqual(["tag it"]);
    const note = renderNote(report);
    expect(note).toContain("Policy warnings (1), which fail nothing");
    expect(note).toContain("tag it");
  });

  it("still fails a root whose plan never came, with no changes", () => {
    const report = buildReport({ run: RUN, roots: [{ path: "x", error: "plan failed" }] });
    expect(report.roots[0]).toMatchObject({ status: "failed", changes: [] });
    expect(report.roots[0].policy).toBeUndefined();
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
    expect(result.report.roots[0].policy?.result).toBe("denied");
    expect(result.report.roots[0].changes.map((c) => c.address)).toEqual(["terraform_data.x"]);
    expect(result.report.policy).toMatchObject({ engine: "conftest", input: "plan", denied: ["a"] });
    expect(JSON.stringify(result.report)).toContain("terraform_data.x is not allowed");
  });

  it("checks a pull request against the base's policy, so editing the policy to allow itself does not pass", { timeout: 120_000 }, async () => {
    const repo = prRepo(files({ "policy/p.rego": "package main\n# base\n" }), { "policy/p.rego": "package main\n# allow everything\n", "a/main.tf": 'resource "terraform_data" "x" {\n  input = 2\n}\n' });
    const seen: string[] = [];
    const exec: PolicyExec = async (_f, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "", stderr: "" };
      seen.push(readFileSync(join(args[args.indexOf("--policy") + 1], "p.rego"), "utf-8"));
      return { status: 1, stdout: deny("terraform_data.x is not allowed"), stderr: "" };
    };
    const result = await runStage("tf-plan", repo, { base: "main", policy: { exec } }, () => {});
    expect(seen).toEqual(["package main\n# base\n"]);
    expect(result.failed).toBe(true);
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
