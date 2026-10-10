import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, validateConfig, type ForgeName } from "../src/config";
import { jobStage, renderPipeline, RenderError, type PipelineInput } from "../src/render";
import { reconcile } from "../src/reconcile";
import { bareFrom, twoRootRepo } from "./helpers";

const base = { binary: "tofu", version: "1.13.1", image: "img:1", layers: [["network"], ["app", "cache"]], env: {} } as const;
const render = (forge: ForgeName, extra: Partial<PipelineInput> = {}) => renderPipeline({ ...base, forge, ...extra } as PipelineInput);
const jobsOf = (text: string): Record<string, any> => {
  const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
  return doc.jobs ?? Object.fromEntries(Object.entries(doc).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v) && "script" in v));
};

/** Compare to test/golden/<name>; UPDATE_GOLDEN=1 rewrites it. */
function golden(name: string, text: string): void {
  const path = join(__dirname, "golden", name);
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
}

const BY_STAGE = { default: ["self-hosted", "linux"], plan: "plan-runner", apply: ["self-hosted", "prod"], drift: "drift-runner" };
const PASS = { secrets: ["TF_VAR_db_password"], vars: ["TF_VAR_region"] };
// Enough of the pipeline that every stage has jobs: drift, resume, ephemeral, tips and publish.
const RICH: Partial<PipelineInput> = { drift: "0 6 * * *", resume: 10, ephemeral: { sweep: 30 }, publish: true, respond: { tips: "on" } };

describe("runner", () => {
  it("unset, the pipeline is the one it always was", () => {
    for (const forge of ["github", "forgejo"] as const) {
      expect(render(forge, RICH).content).toBe(render(forge, { ...RICH, runner: undefined }).content);
      // ubuntu-latest is the default, so naming it changes nothing.
      expect(render(forge, { ...RICH, runner: "ubuntu-latest" }).content).toBe(render(forge, RICH).content);
    }
    expect(render("gitlab", RICH).content).not.toContain("tags:");
  });

  it("github: each job runs on its stage's runner, and every other job on the default (golden)", () => {
    const out = render("github", { ...RICH, runner: BY_STAGE, pass: PASS });
    golden("runner-github.yml", out.content);
    const jobs = jobsOf(out.content);
    for (const [name, job] of Object.entries(jobs)) {
      const stage = jobStage(name);
      expect(job["runs-on"], name).toEqual(stage ? BY_STAGE[stage] : BY_STAGE.default);
    }
    expect(jobs.plan["runs-on"]).toBe("plan-runner");
    expect(jobs.replan["runs-on"]).toBe("plan-runner");
    expect(jobs["apply-wave-2"]["runs-on"]).toEqual(["self-hosted", "prod"]);
    expect(jobs["apply-comment"]["runs-on"]).toEqual(["self-hosted", "prod"]);
    expect(jobs.ephemeral["runs-on"]).toEqual(["self-hosted", "prod"]);
    expect(jobs.drift["runs-on"]).toBe("drift-runner");
    expect(jobs.check["runs-on"]).toEqual(["self-hosted", "linux"]);
    expect(jobs["plan-note"]["runs-on"]).toEqual(["self-hosted", "linux"]);
    // The workflows beside the pipeline: resume applies, the sweep destroys.
    const extra = Object.fromEntries((out.extra ?? []).map((f) => [f.path, jobsOf(f.content)]));
    expect(extra[".github/workflows/terragucci-resume.yml"].resume["runs-on"]).toEqual(["self-hosted", "prod"]);
    expect(extra[".github/workflows/terragucci-ephemeral.yml"].sweep["runs-on"]).toEqual(["self-hosted", "prod"]);
  });

  it("github: a runner group, with labels or without", () => {
    expect(jobsOf(render("github", { runner: { group: "infra" } }).content).check["runs-on"]).toEqual({ group: "infra" });
    expect(jobsOf(render("github", { runner: { apply: { group: "infra", labels: ["prod"] } } }).content)["apply-wave-1"]["runs-on"]).toEqual({ group: "infra", labels: ["prod"] });
  });

  it("gitlab: the runner's labels are each job's tags (golden)", () => {
    const out = render("gitlab", { ...RICH, comments: "*/5 * * * *", runner: { default: "docker", apply: ["prod", "docker"], drift: "drift-runner" }, pass: PASS });
    golden("runner-gitlab.yml", out.content);
    const jobs = jobsOf(out.content);
    expect(jobs.check.tags).toEqual(["docker"]);
    expect(jobs.plan.tags).toEqual(["docker"]);
    expect(jobs["apply-wave-1"].tags).toEqual(["prod", "docker"]);
    expect(jobs.ephemeral.tags).toEqual(["prod", "docker"]);
    expect(jobs.drift.tags).toEqual(["drift-runner"]);
    expect(jobs.comments.tags).toEqual(["docker"]);
    // One runner for every job.
    for (const job of Object.values(jobsOf(render("gitlab", { runner: "shared" }).content))) expect(job.tags).toEqual(["shared"]);
  });

  it("forgejo: a label passes through as it is; GitHub's hosted labels still map to docker", () => {
    const jobs = jobsOf(render("forgejo", { runner: { apply: "terragucci-labelled" } }).content);
    expect(jobs["apply-wave-1"]["runs-on"]).toBe("terragucci-labelled");
    expect(jobs.check["runs-on"]).toBe("docker");
    expect(jobsOf(render("forgejo", { runner: ["self-hosted", "arm64"] }).content).plan["runs-on"]).toEqual(["self-hosted", "arm64"]);
  });

  it("a runner group is GitHub's alone", () => {
    for (const forge of ["forgejo", "gitlab"] as const) expect(() => render(forge, { runner: { group: "infra" } })).toThrow(RenderError);
    expect(() => render("forgejo", { runner: { apply: { group: "infra" } } })).toThrow(/runner\.apply\.group: runner groups are GitHub's/);
  });
});

describe("pass", () => {
  it("github and forgejo: the jobs that plan, apply and check drift get each name from secrets or vars, and no other job does", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const out = render(forge, { ...RICH, pass: PASS });
      const jobs = jobsOf(out.content);
      const holders = Object.entries(jobs).filter(([, j]) => j.env?.TF_VAR_db_password).map(([n]) => n).sort();
      expect(holders).toEqual(["apply-comment", "apply-wave-1", "apply-wave-2", "drift", "ephemeral", "plan", "replan"]);
      expect(jobs.plan.env.TF_VAR_db_password).toBe("${{ secrets.TF_VAR_db_password }}");
      expect(jobs.plan.env.TF_VAR_region).toBe("${{ vars.TF_VAR_region }}");
      for (const f of out.extra ?? []) for (const job of Object.values(jobsOf(f.content))) if (job.env?.TG_TOKEN && !f.path.includes("rollout")) expect(job.env.TF_VAR_db_password).toBe("${{ secrets.TF_VAR_db_password }}");
      // The check job runs a branch's code, a fork's too, and plans nothing: it gets none.
      expect(jobs.check.env?.TF_VAR_db_password).toBeUndefined();
      expect(jobs.publish.env?.TF_VAR_db_password).toBeUndefined();
      // Names only: no value is ever written.
      for (const line of out.content.split("\n").filter((l) => /^\s+TF_VAR_db_password:/.test(l))) expect(line.trim()).toBe("TF_VAR_db_password: '${{ secrets.TF_VAR_db_password }}'");
    }
    // confirm, with apply.when: pull-request.
    expect(jobsOf(render("github", { pass: PASS, applyWhen: "pull-request" }).content).confirm.env.TF_VAR_db_password).toBe("${{ secrets.TF_VAR_db_password }}");
  });

  it("gitlab: every job has the project's CI/CD variables already, so the pipeline is unchanged", () => {
    expect(render("gitlab", { ...RICH, pass: PASS }).content).toBe(render("gitlab", RICH).content);
  });

  it("terragucci's own variables win over a passed name", () => {
    const jobs = jobsOf(render("github", { pass: { secrets: ["INFRACOST_API_KEY"] }, cost: { keySecret: "ACME_INFRACOST", install: true } }).content);
    expect(jobs.plan.env.INFRACOST_API_KEY).toBe("${{ secrets.ACME_INFRACOST }}");
  });
});

describe("config check", () => {
  const problems = (s: Record<string, unknown>): string[] => {
    try {
      validateConfig(s, "config");
      return [];
    } catch (e) {
      return (e as ConfigError).problems ?? [(e as Error).message];
    }
  };

  it("takes a label, a list, a GitHub group, or one of those per stage", () => {
    expect(problems({ runner: "self-hosted" })).toEqual([]);
    expect(problems({ runner: ["self-hosted", "linux"] })).toEqual([]);
    expect(problems({ forge: "github", runner: { group: "infra", labels: ["prod"] } })).toEqual([]);
    expect(problems({ runner: { default: "docker", plan: ["a", "b"], apply: { group: "g" }, drift: "d" } })).toEqual([]);
  });

  it("refuses what no forge reads as a runner", () => {
    expect(problems({ runner: "two words" })).toEqual(["config.runner must be a runner label, such as self-hosted, with no spaces or commas"]);
    expect(problems({ runner: [] })[0]).toMatch(/list of distinct runner labels/);
    expect(problems({ runner: ["a", "a"] })[0]).toMatch(/list of distinct runner labels/);
    expect(problems({ runner: { check: "x" } })).toEqual(["config.runner.check is not a setting (settings: default, plan, apply, drift, or group and labels for one GitHub runner group)"]);
    expect(problems({ runner: {} })[0]).toMatch(/must name a runner/);
    expect(problems({ runner: { group: "g", plan: "x" } })).toEqual(["config.runner.plan is not a setting (settings: group, labels)"]);
    expect(problems({ forge: "gitlab", runner: { apply: { group: "g" } } })).toEqual(["config.runner.apply.group: runner groups are GitHub's; on gitlab give a label or a list of labels"]);
  });

  it("pass takes names, never values, and none terragucci or the forge keeps for itself", () => {
    expect(problems({ pass: { secrets: ["TF_VAR_db_password"], vars: ["TF_VAR_region", "AWS_REGION"] } })).toEqual([]);
    expect(problems({ pass: { secrets: ["hunter2!"] } })[0]).toMatch(/is not a name; give the name of the secret/);
    expect(problems({ pass: { secrets: ["GITHUB_TOKEN"] } })[0]).toMatch(/GITHUB_TOKEN is reserved/);
    expect(problems({ pass: { vars: ["TG_SHA"] } })[0]).toMatch(/TG_SHA is reserved/);
    expect(problems({ pass: { secrets: ["X"], vars: ["X"] } })).toEqual(["config.pass: X is listed twice; a job gets one variable of that name"]);
    expect(problems({ env: { X: "1" }, pass: { vars: ["X"] } })).toEqual(["config.pass: env sets X too; set it in env or pass it, not both"]);
    expect(problems({ pass: { secret: ["X"] } })).toEqual(["config.pass.secret is not a setting (settings: secrets, vars)", "config.pass must list secrets or vars"]);
    expect(problems({ pass: { secrets: [] } })[0]).toMatch(/must be a list of secret names/);
  });
});

describe("reconcile", () => {
  it("a control repo's runner and pass reach each project's pipeline, and stay out of its terragucci.yml", async () => {
    const config = validateConfig(
      {
        defaults: { binary: "tofu", runner: { apply: "prod" } },
        projects: {
          "github.com/acme/infra": { url: bareFrom(twoRootRepo()), pass: { secrets: ["TF_VAR_db_password"] } },
          "gitlab.example.com/acme/net": { url: bareFrom(twoRootRepo()), runner: ["shared", "docker"] },
        },
      },
      "t",
    );
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ default_branch: "main" }), text: async () => "{}" });
    const out = await reconcile(config, { mode: "dry-run", fetch: fetch as never, env: {} });
    const file = (i: number, path: string) => out[i].changes.find((c) => c.path === path)?.content ?? "";
    const gh = jobsOf(file(0, ".github/workflows/terragucci.yml"));
    expect(gh["apply-wave-1"]["runs-on"]).toBe("prod");
    expect(gh.check["runs-on"]).toBe("ubuntu-latest");
    expect(gh.plan.env.TF_VAR_db_password).toBe("${{ secrets.TF_VAR_db_password }}");
    // A project's runner replaces the defaults' whole.
    const gl = jobsOf(file(1, ".gitlab/terragucci.yml"));
    expect(gl["apply-wave-1"].tags).toEqual(["shared", "docker"]);
    expect(gl.check.tags).toEqual(["shared", "docker"]);
    for (const r of out) expect(r.changes.find((c) => c.path === "terragucci.yml")?.content ?? "").not.toMatch(/runner|pass/);
  });
});
