// One apply job per identity (#948, #974, #975): with environments, or roles by glob that tell roots apart,
// each wave of plain roots plans every root in a job of its own with the plan identities and decides its gate,
// then applies in one job per group, each with only its group's identities, runner, forge environment and
// audience. With neither, a wave applies in one job, as it always has.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, validateConfig, type ForgeName, type ProjectSettings } from "../src/config";
import { configSchemaProblems } from "../src/config-schema";
import { applyGroups, groupOidc, groupsArg, rootsByGroup, SHARED_SUBJECT_TIP, sharedSubjectTip } from "../src/groups";
import { main } from "../src/cli";
import { parseGroups } from "../src/apply";
import { wavesSpec, waveCallArgv } from "../src/chant-waves";
import { renderPipeline, RenderError, type PipelineInput } from "../src/render";
import { withEnvironmentRoles } from "../src/environments";
import { shapeProblems } from "../src/refusals";
import { groupedPipeline, runMigrations } from "../src/migrate";
import { PIPELINE_PATHS } from "../src/render";
import { backend, tmp, write } from "./helpers";

const PROD = { plan_role: "arn:aws:iam::222222222222:role/prod-plan", apply_role: "arn:aws:iam::222222222222:role/prod-apply" };
const DEV = { plan_role: "arn:aws:iam::111111111111:role/dev-plan", apply_role: "arn:aws:iam::111111111111:role/dev-apply" };
const TOP = { plan_role: "arn:aws:iam::333333333333:role/plan", apply_role: "arn:aws:iam::333333333333:role/apply" };
const layers = [["envs/dev/network", "envs/prod/network", "shared/dns"], ["envs/dev/app", "envs/prod/app"]];
const ENVS: ProjectSettings = {
  oidc: TOP,
  environments: {
    prod: { roots: ["envs/prod/**"], gate: "always", oidc: { ...PROD, audience: "sts.amazonaws.com/prod" }, runner: { apply: ["self-hosted", "prod"] } },
    dev: { roots: ["envs/dev/**"], oidc: DEV, forge_environment: "development" },
  },
};

const input = (forge: ForgeName, settings: ProjectSettings = ENVS, extra: Partial<PipelineInput> = {}): PipelineInput => {
  const groups = applyGroups(settings, layers.flat());
  return { forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: withEnvironmentRoles(settings.oidc, settings.environments), ...(groups ? { applyGroups: groups } : {}), ...extra } as PipelineInput;
};
const jobsOf = (text: string): Record<string, any> => {
  const doc = parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
  return doc.jobs ?? Object.fromEntries(Object.entries(doc).filter(([, v]) => v && typeof v === "object" && !Array.isArray(v) && "script" in v));
};
const script = (job: any): string => (job.steps ? job.steps.map((s: any) => s.run ?? "").join("\n") : job.script.join("\n"));

/** Compare to test/golden/<name>; UPDATE_GOLDEN=1 rewrites it. */
function golden(name: string, text: string): void {
  const path = join(__dirname, "golden", name);
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
}

function problems(raw: unknown): string[] {
  try {
    validateConfig(raw, "config");
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems ?? [e.message];
  }
}

describe("apply groups", () => {
  it("with environments: one group per environment with roots, and default for the rest", () => {
    const g = applyGroups(ENVS, layers.flat())!;
    expect(g.map((x) => [x.name, x.roots])).toEqual([
      ["prod", ["envs/prod/app", "envs/prod/network"]],
      ["dev", ["envs/dev/app", "envs/dev/network"]],
      ["default", ["shared/dns"]],
    ]);
    const [prod, dev, rest] = g;
    expect(prod).toMatchObject({ environment: "prod", selectors: ["envs/prod/**"], runner: ["self-hosted", "prod"], forgeEnvironment: "prod", audience: "sts.amazonaws.com/prod" });
    expect(dev).toMatchObject({ environment: "dev", forgeEnvironment: "development" });
    expect(dev.runner).toBeUndefined();
    // Each group carries its own roles alone; a group whose every root has a role drops the job's own.
    expect(prod.oidc).toEqual({ roles: { "envs/prod/**": { plan: PROD.plan_role, apply: PROD.apply_role } } });
    expect(dev.oidc).toEqual({ roles: { "envs/dev/**": { plan: DEV.plan_role, apply: DEV.apply_role } } });
    // The roots in no environment keep the job's own identity, and no environment's role.
    expect(rest.oidc).toEqual(TOP);
    expect(rest.forgeEnvironment).toBeUndefined();
    expect(groupsArg(g)).toBe("prod=envs/prod/**;dev=envs/dev/**");
  });

  it("an environment with no root has no group; no root in any environment, no groups", () => {
    const g = applyGroups({ environments: { ...ENVS.environments, stage: { roots: ["envs/stage/**"] } } }, layers.flat())!;
    expect(g.map((x) => x.name)).toEqual(["prod", "dev", "default"]);
    expect(applyGroups({ environments: { stage: { roots: ["envs/stage/**"] } } }, layers.flat())).toBeUndefined();
  });

  it("without environments: roots that take the same identities by glob are a group, and one set alone splits nothing", () => {
    const oidc = { ...TOP, roles: { "envs/prod/*": { plan: PROD.plan_role, apply: PROD.apply_role }, "envs/dev/*": { plan: DEV.plan_role, apply: DEV.apply_role } } };
    const g = applyGroups({ oidc }, layers.flat())!;
    expect(g.map((x) => [x.name, x.selectors])).toEqual([
      ["envs-dev", ["envs/dev/app", "envs/dev/network"]],
      ["envs-prod", ["envs/prod/app", "envs/prod/network"]],
      ["default", []],
    ]);
    // No forge environment: an identity group is no environment, and a GitHub environment would change the token's subject.
    expect(g.every((x) => x.forgeEnvironment === undefined)).toBe(true);
    expect(applyGroups({ oidc: { ...TOP, roles: { "**": { plan: PROD.plan_role, apply: PROD.apply_role } } } }, layers.flat())).toBeUndefined();
    expect(applyGroups({ oidc: TOP }, layers.flat())).toBeUndefined();
    expect(applyGroups({}, layers.flat())).toBeUndefined();
  });

  it("GCP and Azure: a group whose every root has its own identity takes the first as the job's", () => {
    const gcp = { workload_identity_provider: "projects/1/locations/global/workloadIdentityPools/p/providers/q", plan_service_account: "plan@p.iam.gserviceaccount.com", apply_service_account: "apply@p.iam.gserviceaccount.com", roles: { "envs/prod/*": { plan: "prod-plan@p.iam.gserviceaccount.com", apply: "prod-apply@p.iam.gserviceaccount.com" } } };
    const o = groupOidc({ gcp }, ["envs/prod/app"])!;
    expect(o.gcp).toMatchObject({ plan_service_account: "prod-plan@p.iam.gserviceaccount.com", apply_service_account: "prod-apply@p.iam.gserviceaccount.com", roles: gcp.roles });
    expect(groupOidc({ gcp }, ["shared/dns"])!.gcp).toEqual({ workload_identity_provider: gcp.workload_identity_provider, plan_service_account: gcp.plan_service_account, apply_service_account: gcp.apply_service_account });
  });

  it("the stage finds each root's group by the selectors --groups carries", () => {
    const sel = parseGroups("prod=envs/prod/**;dev=envs/dev/**");
    expect(rootsByGroup(layers[1], sel)).toEqual([{ name: "prod", roots: ["envs/prod/app"] }, { name: "dev", roots: ["envs/dev/app"] }]);
    expect(rootsByGroup(layers[0], sel).map((g) => g.name)).toEqual(["prod", "dev", "default"]);
    expect(() => parseGroups("prod")).toThrow(/--groups takes/);
  });

  it("the spec splits the wave into job groups, each with its roots and shares", () => {
    const spec = wavesSpec({ waves: layers, gate: "on-destructive", approval: "ledger", call: waveCallArgv, migrations: false, jobs: { wave: 2, groups: [{ name: "prod", runs: ["envs/prod/app"], shares: 1 }, { name: "dev", runs: ["envs/dev/app"], shares: 2 }] } });
    expect(spec.waves[0]!.jobs).toBeUndefined();
    expect(spec.waves[1]!.jobs).toEqual([{ name: "prod", runs: ["envs/prod/app"] }, { name: "dev", runs: ["envs/dev/app"], shares: 2 }]);
    expect(spec.waves[1]!.shares).toBeUndefined();
  });
});

describe("apply groups: the pipeline", () => {
  it("with neither environments nor roles that tell roots apart, nothing changes", () => {
    for (const forge of ["github", "gitlab", "forgejo"] as const) {
      const plain = { forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, oidc: TOP } as PipelineInput;
      expect(renderPipeline(input(forge, { oidc: TOP })).content).toBe(renderPipeline(plain).content);
    }
  });

  it("github: a deciding job with the plan identities, then a job per group with its own roles, runner and environment", () => {
    const jobs = jobsOf(renderPipeline(input("github")).content);
    expect(Object.keys(jobs).filter((n) => n.startsWith("apply-")).sort()).toEqual(["apply-comment", "apply-done", "apply-wave-1", "apply-wave-1-default", "apply-wave-1-dev", "apply-wave-1-prod", "apply-wave-2", "apply-wave-2-dev", "apply-wave-2-prod"]);
    const decide = script(jobs["apply-wave-1"]);
    expect(decide).toContain("--groups 'prod=envs/prod/**;dev=envs/dev/**'");
    expect(decide).not.toContain("--group ");
    // The deciding job plans every root: every group's plan role, and no apply role at all.
    for (const r of [PROD.plan_role, DEV.plan_role, TOP.plan_role]) expect(decide).toContain(r);
    for (const r of [PROD.apply_role, DEV.apply_role, TOP.apply_role]) expect(decide).not.toContain(r);
    expect(jobs["apply-wave-1"].environment).toBeUndefined();
    const prod = jobs["apply-wave-1-prod"];
    expect(prod.environment).toBe("prod");
    expect(prod["runs-on"]).toEqual(["self-hosted", "prod"]);
    expect(prod.needs).toBe("apply-wave-1");
    const p = script(prod);
    expect(p).toContain("--group prod");
    expect(p).toContain(PROD.apply_role);
    for (const r of [DEV.apply_role, DEV.plan_role, TOP.apply_role, PROD.plan_role]) expect(p).not.toContain(r);
    // An environment's audience: the job asks for its tokens first, for its audience, and drops the token-request variables.
    expect(p).toContain("'sts.amazonaws.com/prod'");
    expect(p).toContain("unset ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(jobs["apply-wave-1-dev"].environment).toBe("development");
    expect(jobs["apply-wave-1-default"].environment).toBeUndefined();
    expect(script(jobs["apply-wave-1-default"])).toContain(TOP.apply_role);
    // The next wave needs every group's job of this one; the last success comes after the last wave's groups.
    expect(jobs["apply-wave-2"].needs).toEqual(["apply-wave-1-prod", "apply-wave-1-dev", "apply-wave-1-default"]);
    expect(jobs["apply-done"].needs).toEqual(["apply-wave-2-prod", "apply-wave-2-dev"]);
    // A comment applies nothing: one job cannot hold each environment's identities apart.
    expect(jobs["apply-comment"].permissions["id-token"]).toBeUndefined();
    expect(script(jobs["apply-comment"])).toContain("a comment applies nothing in this repo");
  });

  it("gitlab: each group's job declares its own audience and runs in its environment", () => {
    const jobs = jobsOf(renderPipeline(input("gitlab")).content);
    expect(jobs["apply-wave-1"].id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" } });
    expect(jobs["apply-wave-1"].environment).toBeUndefined();
    expect(jobs["apply-wave-1-prod"].id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com/prod" } });
    expect(jobs["apply-wave-1-prod"].environment).toEqual({ name: "prod" });
    expect(jobs["apply-wave-1-prod"].tags).toEqual(["self-hosted", "prod"]);
    expect(jobs["apply-wave-1-dev"].environment).toEqual({ name: "development" });
    expect(jobs["apply-wave-1-dev"].id_tokens).toEqual({ TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" } });
    expect(jobs["apply-wave-1-prod"].needs).toEqual(["apply-wave-1"]);
  });

  it("forgejo: no environment on any job", () => {
    const jobs = jobsOf(renderPipeline(input("forgejo", { ...ENVS, environments: { prod: ENVS.environments!.prod, dev: { roots: ["envs/dev/**"], oidc: DEV } } })).content);
    expect(jobs["apply-wave-1-prod"]).toBeDefined();
    expect(Object.values(jobs).some((j: any) => j.environment !== undefined)).toBe(false);
  });

  it("waves.jobs spreads each group's roots across share jobs of its own", () => {
    const jobs = jobsOf(renderPipeline(input("github", ENVS, { waveJobs: 2 })).content);
    expect(Object.keys(jobs).filter((n) => n.startsWith("apply-wave-1"))).toEqual(["apply-wave-1", "apply-wave-1-prod", "apply-wave-1-dev", "apply-wave-1-default"]);
    const wide = { ...ENVS, environments: { prod: { roots: ["envs/prod/**", "shared/**"] } } };
    const w = jobsOf(renderPipeline(input("github", wide, { waveJobs: 2 })).content);
    expect(Object.keys(w).filter((n) => n.startsWith("apply-wave-1"))).toEqual(["apply-wave-1", "apply-wave-1-prod-share-1", "apply-wave-1-prod-share-2", "apply-wave-1-default"]);
    expect(script(w["apply-wave-1-prod-share-2"])).toContain("--shares 2 --share 2");
  });

  it("refuses what applies every wave in one job", () => {
    expect(() => renderPipeline(input("github", ENVS, { applyWhen: "pull-request" }))).toThrow(RenderError);
    expect(() => renderPipeline(input("github", ENVS, { resume: 10 }))).toThrow(/apply.resume/);
    expect(() => renderPipeline(input("gitlab", ENVS, { resume: 10 }))).not.toThrow();
    expect(() => renderPipeline(input("github", ENVS, { ephemeral: { sweep: 30 } }))).toThrow(/ephemeral/);
  });

  for (const forge of ["github", "gitlab", "forgejo"] as const) {
    it(`${forge}: an environments repo with prod and dev (golden)`, () => {
      golden(`environments-${forge}.yml`, renderPipeline(input(forge)).content);
    });
  }
});

describe("apply groups: config", () => {
  it("takes an environment's apply runner, forge environment and audience, and the schema agrees", () => {
    const raw = { environments: { prod: { roots: ["envs/prod/**"], runner: { apply: ["self-hosted", "prod"] }, forge_environment: "production", oidc: { ...PROD, audience: "sts.amazonaws.com/prod" } }, dev: { roots: ["envs/dev/**"], runner: "dev-runner" } } };
    expect(problems(raw)).toEqual([]);
    expect(configSchemaProblems(raw as never)).toEqual([]);
  });

  it("refuses a plan runner, a bad forge environment, an empty audience and a reserved name", () => {
    const p = problems({ environments: { prod: { roots: ["envs/prod/**"], runner: { plan: "x", apply: "y" }, forge_environment: "has space", oidc: { ...PROD, audience: " " } }, default: { roots: ["other/**"] } } });
    expect(p).toContain("config.environments.prod.runner.plan: a plan job plans the roots of every environment, so an environment's runner is its apply jobs' alone; set runner: { apply: <runner> }, and runner.plan at the top level");
    expect(p.some((x) => x.startsWith("config.environments.prod.forge_environment must be"))).toBe(true);
    expect(p.some((x) => x.startsWith("config.environments.prod.oidc.audience must be"))).toBe(true);
    expect(p.some((x) => x.startsWith("config.environments: default is one of the names"))).toBe(true);
    expect(configSchemaProblems({ environments: { prod: { roots: ["a/**"], runner: { plan: "x" } } } } as never)).not.toEqual([]);
    expect(configSchemaProblems({ environments: { decide: { roots: ["a/**"] } } } as never)).not.toEqual([]);
  });

  it("refuses apply.when: pull-request, ephemeral, apply.resume off GitLab, and forge_environment on Forgejo beside environments", () => {
    const env = { prod: { roots: ["envs/prod/**"] } };
    expect(problems({ environments: env, apply: { when: "pull-request" } })).toEqual([expect.stringContaining("config.apply.when: with environments")]);
    expect(problems({ environments: env, ephemeral: { roots: ["envs/prod/app"] } })).toEqual([expect.stringContaining("config.ephemeral: with environments")]);
    expect(problems({ environments: env, forge: "github", apply: { resume: 10 } })).toEqual([expect.stringContaining("config.apply.resume: with environments")]);
    expect(problems({ environments: env, forge: "gitlab", apply: { resume: 10 } })).toEqual([]);
    expect(problems({ forge: "forgejo", environments: { prod: { roots: ["envs/prod/**"], forge_environment: "prod" } } })).toEqual([expect.stringContaining("config.environments.prod.forge_environment: Forgejo Actions has no deployment environments")]);
  });

  it("a Terragrunt repo refuses an environment's runner and forge_environment", () => {
    const p = shapeProblems("terragrunt", { environments: { prod: { roots: ["live/prod/**"], forge_environment: "prod" } } }, "config");
    expect(p).toEqual([expect.stringContaining("config.environments: Terragrunt applies a wave's units in one job")]);
  });
});

describe("apply groups: state migrations", () => {
  const MIGRATION = "moves:\n  - from: envs/dev/network\n    to: envs/dev/app\n    addresses: [aws_s3_bucket.logs]\n";

  it("a pull request's plan refuses a migration in a repo whose pipeline applies a job per identity, naming the file", async () => {
    for (const forge of ["github", "gitlab", "forgejo"] as const) {
      const dir = write(tmp(), { [PIPELINE_PATHS[forge]]: renderPipeline(input(forge)).content, "migrations/move-logs.yml": MIGRATION });
      expect(groupedPipeline(dir)).toBe(PIPELINE_PATHS[forge]);
      const lines: string[] = [];
      const r = await runMigrations(dir, { binary: "tofu", planOnly: true, log: (l) => void lines.push(l), exec: async () => ({ code: 1, stdout: "", out: "no binary should run" }) });
      expect(r).toEqual({ code: 1, records: [] });
      expect(lines.join("\n")).toContain(`migrations: migrations/move-logs.yml is a state migration, and ${PIPELINE_PATHS[forge]} applies each wave in a job per identity: wave 1's deciding job runs a migration, and it holds the plan roles alone`);
    }
  });

  it("a pipeline with one apply job per wave is not grouped", () => {
    const dir = write(tmp(), { [PIPELINE_PATHS.gitlab]: renderPipeline(input("gitlab", { oidc: TOP })).content });
    expect(groupedPipeline(dir)).toBeUndefined();
  });
});

describe("apply groups: the shared-subject tip", () => {
  const ROLES = { ...TOP, roles: { "envs/prod/**": { plan: PROD.plan_role, apply: PROD.apply_role }, "envs/dev/**": { plan: DEV.plan_role, apply: DEV.apply_role } } };

  it("identity groups share the job's subject on every forge; environments only on Forgejo", () => {
    const identity = applyGroups({ oidc: ROLES }, layers.flat());
    expect(sharedSubjectTip(identity, "github")).toBe("the apply jobs of the groups envs-dev, envs-prod and default carry the same OIDC token subject, so a role's trust cannot tell one group's jobs from another's; on GitHub or GitLab, name each group's roots in environments, each with a forge_environment, and have each apply role trust its environment alone");
    expect(sharedSubjectTip(identity, undefined)).toContain("name each group's roots in environments");
    expect(sharedSubjectTip(identity, "forgejo")).toContain("Forgejo has no deployment environments");
    const envs = applyGroups(ENVS, layers.flat());
    expect(sharedSubjectTip(envs, "github")).toBeUndefined();
    expect(sharedSubjectTip(envs, "gitlab")).toBeUndefined();
    expect(sharedSubjectTip(envs, "forgejo")).toMatch(/^the apply jobs of the groups prod, dev and default carry the same OIDC token subject/);
    expect(sharedSubjectTip(applyGroups({ oidc: TOP }, layers.flat()), "github")).toBeUndefined();
  });

  async function check(dir: string): Promise<{ code: number; out: string; err: string }> {
    const cwd = process.cwd();
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    process.chdir(dir);
    try {
      return { code: await main(["config", "check", "--json"]), out: out.join("\n"), err: err.join("\n") };
    } finally {
      process.chdir(cwd);
      log.mockRestore();
      error.mockRestore();
    }
  }
  const roots = Object.fromEntries(layers.flat().map((r) => [`${r}/main.tf`, backend(`${r}.tfstate`)]));

  it("config check gives it as a tip, never a warning, and exits 0", async () => {
    const yml = `oidc:\n  roles:\n    "envs/prod/**": { plan: ${PROD.plan_role}, apply: ${PROD.apply_role} }\n    "envs/dev/**": { plan: ${DEV.plan_role}, apply: ${DEV.apply_role} }\n  plan_role: ${TOP.plan_role}\n  apply_role: ${TOP.apply_role}\n`;
    const r = await check(write(tmp(), { ...roots, "terragucci.yml": `forge: github\n${yml}` }));
    expect(r.code).toBe(0);
    const results = JSON.parse(r.out).results;
    expect(results.tips).toEqual([{ rule: SHARED_SUBJECT_TIP, message: expect.stringContaining("the groups envs-dev, envs-prod and default") }]);
    expect(JSON.stringify(results.warnings ?? [])).not.toContain("subject");
    const forgejo = await check(write(tmp(), { ...roots, "terragucci.yml": "forge: forgejo\nenvironments:\n  prod: { roots: [\"envs/prod/**\"] }\n  dev: { roots: [\"envs/dev/**\"] }\n" }));
    expect(forgejo.code).toBe(0);
    expect(JSON.parse(forgejo.out).results.tips).toEqual([{ rule: SHARED_SUBJECT_TIP, message: expect.stringContaining("Forgejo has no deployment environments") }]);
    expect(JSON.parse(forgejo.out).results.warnings).toBeUndefined();
    const github = await check(write(tmp(), { ...roots, "terragucci.yml": "forge: github\nenvironments:\n  prod: { roots: [\"envs/prod/**\"] }\n" }));
    expect(JSON.parse(github.out).results.tips).toBeUndefined();
  });
});
