// #976: an environment's apply jobs start with `terragucci check-job`, before any token is fetched or traded,
// and config check gives tips for runners, apply identities and audiences that environments share.
// With no `environments`, no job checks and no new tip.
import { describe, expect, it, vi } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { ForgeName, ProjectSettings } from "../src/config";
import { applyGroups } from "../src/cloud-identity";
import { SHARED_SUBJECT_TIP, sharedSubjectTip } from "../src/environment-tips";
import { environmentAudienceTips, environmentTips, planApplyRunnerTip, sharedApplyRoleTips, sharedRunnerTips } from "../src/environment-tips";
import { SHARED_AUDIENCE_TIP, PERSISTENT_RUNNER_TIP, ENVIRONMENT_ROLE_TIP } from "../src/tips";
import { renderPipeline, type PipelineInput } from "../src/render";
import { withEnvironmentRoles } from "../src/environments";
import { main } from "../src/cli";
import { backend, tmp, write } from "./helpers";

const PROD = { plan_role: "arn:aws:iam::222222222222:role/prod-plan", apply_role: "arn:aws:iam::222222222222:role/prod-apply" };
const DEV = { plan_role: "arn:aws:iam::111111111111:role/dev-plan", apply_role: "arn:aws:iam::111111111111:role/dev-apply" };
const TOP = { plan_role: "arn:aws:iam::333333333333:role/plan", apply_role: "arn:aws:iam::333333333333:role/apply" };
const layers = [["envs/dev/network", "envs/prod/network", "shared/dns"], ["envs/dev/app", "envs/prod/app"]];
const roots = layers.flat();
const ENVS: ProjectSettings = {
  oidc: TOP,
  environments: {
    prod: { roots: ["envs/prod/**"], gate: "always", oidc: { ...PROD, audience: "sts.amazonaws.com/prod" }, runner: { apply: ["self-hosted", "prod"] } },
    dev: { roots: ["envs/dev/**"], oidc: DEV, forge_environment: "development" },
  },
};

const input = (forge: ForgeName, settings: ProjectSettings = ENVS, extra: Partial<PipelineInput> = {}): PipelineInput => {
  const groups = applyGroups(settings, roots);
  return { forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: withEnvironmentRoles(settings.oidc, settings.environments), ...(groups ? { applyGroups: groups } : {}), ...(settings.runner !== undefined ? { runner: settings.runner } : {}), ...extra } as PipelineInput;
};
const jobsOf = (text: string): Record<string, any> => {
  const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
  return doc.jobs ?? Object.fromEntries(Object.entries(doc).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v) && "script" in v));
};
/** The apply step's script: GitHub and Forgejo's named step, GitLab's heredoc body. */
const applyBody = (job: any): string => (job.steps ? job.steps.find((s: any) => /^Apply group/.test(s.name ?? "")).run : job.script.join("\n").replace(/^bash <<'APPLY' \|\| exit \$\?\n/, ""));

describe("check-job in an environment's apply jobs", () => {
  it("github: the first line, before the token is fetched, with the forge environment, the default branch and self-hosted", () => {
    const jobs = jobsOf(renderPipeline(input("github")).content);
    const prod = applyBody(jobs["apply-wave-1-prod"]).split("\n");
    expect(prod[0]).toBe(`if [ -z "\${TG_NO_OIDC_REQUEST:-}" ]; then terragucci check-job --forge github --environment 'prod' --branches "$TG_BRANCH" --forge-environment 'prod' --self-hosted || exit 1; fi`);
    // The token fetch and the restart come after it.
    expect(prod.findIndex((l) => l.includes("tg oidc"))).toBeGreaterThan(0);
    const dev = applyBody(jobs["apply-wave-1-dev"]).split("\n");
    expect(dev[0]).toBe(`if [ -z "\${TG_NO_OIDC_REQUEST:-}" ]; then terragucci check-job --forge github --environment 'dev' --branches "$TG_BRANCH" --forge-environment 'development' || exit 1; fi`);
    // The roots in no environment, and the deciding job, check nothing.
    expect(applyBody(jobs["apply-wave-1-default"])).not.toContain("check-job");
    expect(JSON.stringify(jobs["apply-wave-1"])).not.toContain("check-job");
  });

  it("gitlab: the first line of the script, with the environment, the default branch and the runner's tags", () => {
    const jobs = jobsOf(renderPipeline(input("gitlab")).content);
    expect(applyBody(jobs["apply-wave-1-prod"]).split("\n")[0]).toBe(`terragucci check-job --forge gitlab --environment 'prod' --branches "$CI_DEFAULT_BRANCH" --forge-environment 'prod' --runner-tags 'self-hosted,prod' || exit 1`);
    expect(applyBody(jobs["apply-wave-2-dev"]).split("\n")[0]).toBe(`terragucci check-job --forge gitlab --environment 'dev' --branches "$CI_DEFAULT_BRANCH" --forge-environment 'development' || exit 1`);
    expect(applyBody(jobs["apply-wave-1-default"])).not.toContain("check-job");
  });

  it("forgejo: no forge environment; the ref and self-hosted", () => {
    const settings = { ...ENVS, environments: { prod: ENVS.environments!.prod, dev: { roots: ["envs/dev/**"], oidc: DEV } } };
    const jobs = jobsOf(renderPipeline(input("forgejo", settings)).content);
    expect(applyBody(jobs["apply-wave-1-prod"]).split("\n")[0]).toBe(`if [ -z "\${TG_NO_OIDC_REQUEST:-}" ]; then terragucci check-job --forge forgejo --environment 'prod' --branches "$TG_BRANCH" --self-hosted || exit 1; fi`);
  });

  it("apply.branches: each branch is one the job may apply from; the top-level apply runner when the environment names none", () => {
    const jobs = jobsOf(renderPipeline(input("gitlab", { ...ENVS, runner: { apply: "apply-runners" } }, { applyBranches: { release: ["envs/dev/**"] } })).content);
    expect(applyBody(jobs["apply-wave-1-dev"]).split("\n")[0]).toBe(`terragucci check-job --forge gitlab --environment 'dev' --branches "$CI_DEFAULT_BRANCH,release" --forge-environment 'development' --runner-tags 'apply-runners' || exit 1`);
  });

  it("github without oidc: the job may request no token, so the forge environment is left to the forge", () => {
    const jobs = jobsOf(renderPipeline(input("github", { environments: { prod: { roots: ["envs/prod/**"] } } })).content);
    expect(applyBody(jobs["apply-wave-1-prod"]).split("\n")[0]).toBe(`if [ -z "\${TG_NO_OIDC_REQUEST:-}" ]; then terragucci check-job --forge github --environment 'prod' --branches "$TG_BRANCH" || exit 1; fi`);
  });

  it("no environments: no job checks, identity groups included", () => {
    const identity = { oidc: { ...TOP, roles: { "envs/prod/**": { plan: PROD.plan_role, apply: PROD.apply_role }, "envs/dev/**": { plan: DEV.plan_role, apply: DEV.apply_role } } } };
    for (const forge of ["github", "gitlab", "forgejo"] as const) {
      expect(renderPipeline(input(forge, { oidc: TOP })).content).not.toContain("check-job");
      expect(renderPipeline(input(forge, identity)).content).not.toContain("check-job");
    }
  });
});

describe("config check tips for environments", () => {
  const groups = (s: ProjectSettings) => applyGroups(s, roots);

  it("persistent runner: an environment's apply runner that plan jobs or another environment's apply can take", () => {
    const shared: ProjectSettings = { runner: { plan: ["self-hosted"], apply: ["self-hosted", "apply"] }, environments: { prod: { roots: ["envs/prod/**"], runner: { apply: ["self-hosted", "prod"] } }, dev: { roots: ["envs/dev/**"] } } };
    const tips = sharedRunnerTips(groups(shared), shared.runner, "github");
    expect(tips).toEqual([
      { rule: PERSISTENT_RUNNER_TIP, message: expect.stringMatching(/^the apply jobs of environment prod \(labels self-hosted, prod\) and the plan jobs \(labels self-hosted\) can run on the same runner/) },
      { rule: PERSISTENT_RUNNER_TIP, message: expect.stringMatching(/^the apply jobs of environment dev \(labels self-hosted, apply\) and the plan jobs \(labels self-hosted\)/) },
    ]);
    // Two environments on the same labels.
    const same: ProjectSettings = { runner: { plan: "plan-runners" }, environments: { prod: { roots: ["envs/prod/**"], runner: "deploy" }, dev: { roots: ["envs/dev/**"], runner: "deploy" } } };
    expect(sharedRunnerTips(groups(same), same.runner, "gitlab").map((t) => t.message)).toEqual([expect.stringMatching(/^the apply jobs of environments prod \(labels deploy\) and dev \(labels deploy\) can run on the same runner/)]);
    // Silent for labels apart, for GitHub's hosted runners, and for no runner named.
    const apart: ProjectSettings = { runner: { plan: ["self-hosted", "plan"] }, environments: { prod: { roots: ["envs/prod/**"], runner: ["self-hosted", "prod"] }, dev: { roots: ["envs/dev/**"], runner: ["self-hosted", "dev"] } } };
    expect(sharedRunnerTips(groups(apart), apart.runner, "github")).toEqual([]);
    const hosted: ProjectSettings = { runner: "ubuntu-24.04", environments: { prod: { roots: ["envs/prod/**"] }, dev: { roots: ["envs/dev/**"] } } };
    expect(sharedRunnerTips(groups(hosted), hosted.runner, "github")).toEqual([]);
    expect(sharedRunnerTips(groups({ environments: hosted.environments }), undefined, "gitlab")).toEqual([]);
    // A runner group of its own keeps an environment apart; the same group with no label to tell them apart does not.
    const grouped: ProjectSettings = { runner: { plan: { group: "plans" } }, environments: { prod: { roots: ["envs/prod/**"], runner: { group: "prod" } }, dev: { roots: ["envs/dev/**"], runner: { group: "plans", labels: ["dev"] } } } };
    expect(sharedRunnerTips(groups(grouped), grouped.runner, "github").map((t) => t.message)).toEqual([expect.stringContaining("environment dev (group plans and labels dev) and the plan jobs (group plans)")]);
  });

  it("shared apply role: environments that take the project's own apply identity", () => {
    const s: ProjectSettings = { oidc: TOP, environments: { prod: { roots: ["envs/prod/**"], oidc: PROD }, dev: { roots: ["envs/dev/**"] } } };
    expect(sharedApplyRoleTips(groups(s), s.oidc)).toEqual([{ rule: ENVIRONMENT_ROLE_TIP, message: `the apply jobs of the groups dev and default all apply as ${TOP.apply_role} (oidc.apply_role), so its trust must accept each of their jobs and no condition keeps one environment's job from another's role; set environments.<name>.oidc.apply_role for dev` }]);
    const both: ProjectSettings = { oidc: TOP, environments: { prod: { roots: ["envs/prod/**", "shared/**"] }, dev: { roots: ["envs/dev/**"] } } };
    expect(sharedApplyRoleTips(groups(both), both.oidc)[0]!.message).toMatch(/^the apply jobs of environments prod and dev all apply as/);
    // Each environment its own role: silent. No oidc: silent.
    expect(sharedApplyRoleTips(groups(ENVS), ENVS.oidc)).toEqual([]);
    expect(sharedApplyRoleTips(groups({ environments: both.environments }), undefined)).toEqual([]);
    // Identity groups without environments: the roles by glob are theirs, and the default group alone takes the project's.
    const identity = { oidc: { ...TOP, roles: { "envs/prod/**": { plan: PROD.plan_role, apply: PROD.apply_role }, "envs/dev/**": { plan: DEV.plan_role, apply: DEV.apply_role } } } };
    expect(sharedApplyRoleTips(groups(identity), identity.oidc)).toEqual([]);
  });

  it("environment audience: on GitLab with AWS, environments on one audience", () => {
    // prod has its own audience; dev and the default group share sts.amazonaws.com.
    expect(environmentAudienceTips(groups(ENVS), ENVS.oidc, "gitlab")).toEqual([{ rule: SHARED_AUDIENCE_TIP, message: expect.stringContaining("on GitLab the apply jobs of the groups dev and default carry the same AWS token audience sts.amazonaws.com, and AWS cannot read GitLab's environment claims") }]);
    expect(environmentAudienceTips(groups(ENVS), ENVS.oidc, "gitlab")[0]!.message).toContain("set environments.<name>.oidc.audience for dev");
    const apart: ProjectSettings = { ...ENVS, environments: { prod: ENVS.environments!.prod, dev: { ...ENVS.environments!.dev, oidc: { ...DEV, audience: "sts.amazonaws.com/dev" } } } };
    expect(environmentAudienceTips(groups(apart), apart.oidc, "gitlab")).toEqual([]);
    // Off GitLab, AWS's trust reads GitHub's environment subject: no tip.
    expect(environmentAudienceTips(groups(ENVS), ENVS.oidc, "github")).toEqual([]);
  });

  it("shared subject: environments that name one forge environment; Forgejo's wording names the ref", () => {
    const one: ProjectSettings = { environments: { prod: { roots: ["envs/prod/**"], forge_environment: "live" }, dev: { roots: ["envs/dev/**"], forge_environment: "live" } } };
    expect(sharedSubjectTip(groups(one), "github")).toBe("the apply jobs of the environments prod and dev run in the same forge environment live, so their tokens carry the same environment and a role's trust cannot tell one environment's jobs from another's; give each environment a forge_environment of its own");
    expect(sharedSubjectTip(groups(ENVS), "github")).toBeUndefined();
    expect(sharedSubjectTip(groups({ environments: { prod: { roots: ["envs/prod/**"] }, dev: { roots: ["envs/dev/**"] } } }), "forgejo")).toContain("they apply from the same ref, and Forgejo has no deployment environments");
  });

  it("no environments: none of these tips", () => {
    expect(environmentTips(applyGroups({ oidc: TOP }, roots), { oidc: TOP }, "gitlab")).toEqual([]);
    expect(environmentTips(undefined, { runner: { plan: "x", apply: "x" } }, "gitlab")).toEqual([]);
  });

  // #949: without environments, plan and apply on one self-hosted runner get the tip from runner alone.
  it("plan and apply runner: names both stages and the labels, and what keeps other jobs off per forge", () => {
    const one = planApplyRunnerTip({ runner: ["self-hosted", "linux"] }, "github")!;
    expect(one.rule).toBe(PERSISTENT_RUNNER_TIP);
    expect(one.message).toMatch(/^the plan jobs and the apply jobs can run on the same runner \(both on labels self-hosted, linux\), so a pull request's code planned there can leave files, caches or processes for an apply; give runner.apply labels no plan job uses/);
    expect(one.message).toContain("only a runner group limited to selected workflows keeps those off");
    // The default runner counts for a stage that names none.
    expect(planApplyRunnerTip({ runner: { default: "deploy", apply: ["deploy", "prod"] } }, "gitlab")!.message).toContain("(plan on labels deploy, apply on labels deploy, prod)");
    expect(planApplyRunnerTip({ runner: { default: "deploy", apply: ["deploy", "prod"] } }, "gitlab")!.message).toContain("only protected runners, which take jobs of protected refs alone, keep those off");
    expect(planApplyRunnerTip({ runner: { plan: "box", apply: "box" } }, "forgejo")!.message).toContain("Forgejo has no per-workflow limit on a runner");
    expect(planApplyRunnerTip({ runner: { plan: { group: "infra" }, apply: { group: "infra" } } }, "github")!.message).toContain("(both on group infra)");
  });

  it("plan and apply runner: silent for hosted runners, separate labels, no runner, and an environment with no runner of its own", () => {
    expect(planApplyRunnerTip({}, "github")).toBeUndefined();
    expect(planApplyRunnerTip({ runner: "ubuntu-24.04" }, "github")).toBeUndefined();
    expect(planApplyRunnerTip({ runner: "ubuntu-24.04" }, undefined)).toBeUndefined();
    expect(planApplyRunnerTip({ runner: { plan: "saas-linux-small-amd64", apply: "saas-linux-small-amd64" } }, "gitlab")).toBeUndefined();
    expect(planApplyRunnerTip({ runner: { plan: ["self-hosted", "plan"], apply: ["self-hosted", "apply"] } }, "github")).toBeUndefined();
    expect(planApplyRunnerTip({ runner: { plan: { group: "plans" }, apply: { group: "applies" } } }, "github")).toBeUndefined();
    // Only the plan stage named: apply runs on the forge's default runner.
    expect(planApplyRunnerTip({ runner: { plan: "deploy" } }, "gitlab")).toBeUndefined();
    // An environment that takes runner.apply has its own tip naming the same runner.
    expect(planApplyRunnerTip({ runner: "deploy", environments: { prod: { roots: ["envs/prod/**"] } } }, "gitlab")).toBeUndefined();
    // Every environment on a runner of its own: the roots outside them still apply on runner.apply.
    expect(planApplyRunnerTip({ runner: "deploy", environments: { prod: { roots: ["envs/prod/**"], runner: "prod" } } }, "gitlab")).toBeDefined();
  });

  it("GitLab.com's hosted runners (saas- tags) get no environment runner tip", () => {
    const s: ProjectSettings = { runner: { plan: "saas-linux-small-amd64" }, environments: { prod: { roots: ["envs/prod/**"], runner: "saas-linux-small-amd64" }, dev: { roots: ["envs/dev/**"], runner: "saas-linux-small-amd64" } } };
    expect(sharedRunnerTips(groups(s), s.runner, "gitlab")).toEqual([]);
  });

  async function check(dir: string): Promise<{ code: number; out: string }> {
    const cwd = process.cwd();
    const out: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    process.chdir(dir);
    try {
      return { code: await main(["config", "check", "--json"]), out: out.join("\n") };
    } finally {
      process.chdir(cwd);
      log.mockRestore();
      error.mockRestore();
    }
  }
  const files = Object.fromEntries(roots.map((r) => [`${r}/main.tf`, backend(`${r}.tfstate`)]));

  it("config check lists them under tips and exits 0; a config without environments gets the plan and apply runner tip alone", async () => {
    const yml = [
      "forge: gitlab",
      "runner: { plan: deploy, apply: deploy }",
      `oidc: { plan_role: "${TOP.plan_role}", apply_role: "${TOP.apply_role}" }`,
      "environments:",
      '  prod: { roots: ["envs/prod/**"] }',
      '  dev: { roots: ["envs/dev/**"] }',
      "",
    ].join("\n");
    const r = await check(write(tmp(), { ...files, "terragucci.yml": yml }));
    expect(r.code).toBe(0);
    const results = JSON.parse(r.out).results;
    expect(results.ok).toBe(true);
    expect(results.tips.map((t: { rule: string }) => t.rule)).toEqual([PERSISTENT_RUNNER_TIP, PERSISTENT_RUNNER_TIP, PERSISTENT_RUNNER_TIP, ENVIRONMENT_ROLE_TIP, SHARED_AUDIENCE_TIP]);
    expect(JSON.stringify(results.warnings ?? [])).not.toContain("runner");
    const plain = await check(write(tmp(), { ...files, "terragucci.yml": `forge: gitlab\nrunner: { plan: deploy, apply: deploy }\noidc: { plan_role: "${TOP.plan_role}", apply_role: "${TOP.apply_role}" }\n` }));
    expect(plain.code).toBe(0);
    // Without environments, the one tip is plan and apply on one runner (#949).
    expect(JSON.parse(plain.out).results.tips).toEqual([{ rule: PERSISTENT_RUNNER_TIP, message: expect.stringMatching(/^the plan jobs and the apply jobs can run on the same runner \(both on labels deploy\)/) }]);
    const apart = await check(write(tmp(), { ...files, "terragucci.yml": `forge: gitlab\nrunner: { plan: plans, apply: applies }\noidc: { plan_role: "${TOP.plan_role}", apply_role: "${TOP.apply_role}" }\n` }));
    expect(apart.code).toBe(0);
    expect(JSON.parse(apart.out).results.tips).toBeUndefined();
    expect(SHARED_SUBJECT_TIP).toBe("terragucci-shared-subject");
  });
});
