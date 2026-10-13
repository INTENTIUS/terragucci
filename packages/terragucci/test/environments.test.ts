import { describe, expect, it } from "vitest";
import { ConfigError, mergeEnvironments, resolveProject, resolveRepo, validateConfig, type ProjectSettings, type TerragucciConfig } from "../src/config";
import { configSchemaProblems } from "../src/config-schema";
import { anyRootGate, environmentGates, environmentOf, environmentRootProblems, settingsForRoot, strictestGate, waveGate, withEnvironmentRoles } from "../src/environments";
import { planSettings } from "../src/affected";
import { buildReport } from "../src/report/build";
import { buildEstate, renderEstateHtml } from "../src/report/estate";
import { inventoryRoots } from "../src/report/inventory";
import { renderNote } from "../src/report/views";
import { rootsParallelism } from "../src/report/stage";
import { wavesSpec } from "../src/chant-waves";
import { plan, rc, RUN } from "./report-fixtures";

/** config.ts's problems with a parsed config, or [] when it checks. */
function problems(raw: unknown): string[] {
  try {
    validateConfig(raw, "terragucci.yml");
    return [];
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return e.problems ?? [e.message];
  }
}

const PROD_ROLES = { plan_role: "arn:aws:iam::111111111111:role/prod-plan", apply_role: "arn:aws:iam::111111111111:role/prod-apply" };
const TWO: ProjectSettings = {
  gate: "on-destructive",
  parallelism: 4,
  environments: {
    prod: { roots: ["envs/prod/**"], gate: "always", oidc: PROD_ROLES, parallelism: 2 },
    dev: { roots: ["envs/dev/**"], gate: "never" },
  },
};

describe("environments in config check", () => {
  it("accepts environments with roots, gate, oidc and parallelism, and the schema agrees", () => {
    expect(problems(TWO)).toEqual([]);
    expect(configSchemaProblems(TWO)).toEqual([]);
  });

  it("names the environment and the key it does not take", () => {
    const p = problems({ environments: { prod: { roots: ["envs/prod/**"], drift: "0 * * * *" } } });
    expect(p).toEqual([expect.stringMatching(/^config\.environments\.prod\.drift is not a per-environment setting \(settings: roots, gate, oidc, parallelism\)$/)]);
    expect(configSchemaProblems({ environments: { prod: { roots: ["envs/prod/**"], drift: "0 * * * *" } } }).length).toBeGreaterThan(0);
  });

  it("refuses runner, forge_environment and oidc.audience per environment, saying why", () => {
    const p = problems({ environments: { prod: { roots: ["envs/prod/**"], runner: { apply: ["self-hosted", "prod"] }, forge_environment: "production", oidc: { ...PROD_ROLES, audience: "sts.amazonaws.com" } } } });
    expect(p).toContain("config.environments.prod.runner: one apply job applies the roots of every environment in its wave, so a runner cannot be chosen per environment; set runner at the top level");
    expect(p.some((x) => x.startsWith("config.environments.prod.forge_environment: "))).toBe(true);
    expect(p.some((x) => x.startsWith("config.environments.prod.oidc.audience: "))).toBe(true);
  });

  it("refuses an environment with no roots or empty roots, and a bad name", () => {
    expect(problems({ environments: { prod: { gate: "always" } } })).toEqual([expect.stringMatching(/^config\.environments\.prod\.roots is missing/)]);
    expect(problems({ environments: { prod: { roots: [] } } })).toEqual([expect.stringMatching(/^config\.environments\.prod\.roots must be a list of root globs/)]);
    expect(problems({ environments: { Prod: { roots: ["a/**"] } } })).toEqual([expect.stringMatching(/"Prod" is not an environment name/)]);
  });

  it("refuses one glob in two environments, naming both and the glob", () => {
    expect(problems({ environments: { prod: { roots: ["envs/**"] }, dev: { roots: ["envs/**"] } } })).toEqual([
      "config.environments: envs/** is a root glob of both prod and dev; a root belongs to one environment",
    ]);
  });

  it("refuses a glob both an environment's oidc and oidc.roles give identities", () => {
    const p = problems({ oidc: { roles: { "envs/prod/**": { plan: "p", apply: "a" } } }, environments: { prod: { roots: ["envs/prod/**"], oidc: PROD_ROLES } } });
    expect(p).toEqual(["config.environments.prod.oidc: envs/prod/** has identities in both config.environments.prod.oidc and oidc.roles; set them in one place"]);
  });

  it("needs oidc.gcp for an environment's GCP pair, and one plan and one apply identity", () => {
    const gcp = { roots: ["envs/prod/**"], oidc: { gcp: { plan_service_account: "p@x.iam", apply_service_account: "p@x.iam" } } };
    const p = problems({ environments: { prod: gcp } });
    expect(p).toContain("config.environments.prod.oidc.gcp.plan_service_account and apply_service_account are the same service account; plan runs pull-request code, so give it a read-only service account of its own");
    expect(p).toContain("config.environments.prod.oidc.gcp needs oidc.gcp: the workload identity provider and the token come from there");
    expect(problems({ environments: { prod: { roots: ["a/**"], oidc: { plan_role: "p" } } } })).toEqual(["config.environments.prod.oidc.apply_role must name a role, one for plan and one for apply"]);
  });

  it("refuses an environment's oidc and parallelism in a Terragrunt repo", () => {
    const p = problems({ terragrunt: {}, environments: { prod: { roots: ["live/prod/**"], oidc: PROD_ROLES, parallelism: 2 } } });
    expect(p.filter((x) => x.startsWith("config.environments: "))).toHaveLength(2);
  });

  it("reads an older gate name as the policy it names", () => {
    const c = validateConfig({ environments: { prod: { roots: ["a/**"], gate: "on-destroy" } } }, "terragucci.yml");
    expect(c.environments?.prod?.gate).toBe("on-destructive");
  });
});

describe("environments against the repo's roots", () => {
  it("names a root two environments match, with both environments", () => {
    const s: ProjectSettings = { environments: { prod: { roots: ["envs/prod/**"] }, eu: { roots: ["envs/*/eu"] } } };
    expect(environmentRootProblems(["envs/prod/eu", "envs/prod/us", "envs/dev/eu"], s)).toEqual([
      "config.environments: envs/prod/eu is a root of prod and eu; a root belongs to one environment, so narrow their roots globs",
    ]);
  });

  it("names a root whose environment and a glob-keyed setting both give it identities", () => {
    const s: ProjectSettings = { oidc: { roles: { "envs/*/db": { plan: "p", apply: "a" } } }, environments: { prod: { roots: ["envs/prod/**"], oidc: PROD_ROLES } } };
    expect(environmentRootProblems(["envs/prod/db", "envs/prod/app", "envs/dev/db"], s)).toEqual([
      "config.environments.prod.oidc: envs/prod/db takes identities from both environments.prod.oidc and oidc.roles (envs/*/db); set them in one place",
    ]);
  });

  it("finds nothing with no environments", () => {
    expect(environmentRootProblems(["a", "b"], {})).toEqual([]);
  });
});

describe("the resolver", () => {
  it("puts a root in the first environment it matches, or none", () => {
    expect(environmentOf("envs/prod/app", TWO)).toBe("prod");
    expect(environmentOf("envs/dev/app", TWO)).toBe("dev");
    expect(environmentOf("shared/dns", TWO)).toBeUndefined();
    expect(environmentOf("envs/prod/app", {})).toBeUndefined();
  });

  it("gives a root its environment's values over the top-level ones", () => {
    const prod = settingsForRoot("envs/prod/app", { ...TWO, oidc: { plan_role: "top-plan", apply_role: "top-apply" }, runner: "self-hosted" });
    expect(prod).toEqual({ environment: "prod", gate: "always", oidc: { plan_role: PROD_ROLES.plan_role, apply_role: PROD_ROLES.apply_role }, runner: "self-hosted", parallelism: 2, forge_environment: "prod" });
    const shared = settingsForRoot("shared/dns", { ...TWO, oidc: { plan_role: "top-plan", apply_role: "top-apply" } });
    expect(shared).toEqual({ gate: "on-destructive", oidc: { plan_role: "top-plan", apply_role: "top-apply" }, parallelism: 4 });
    expect(settingsForRoot("envs/dev/app", TWO)).toEqual({ environment: "dev", gate: "never", parallelism: 4, forge_environment: "dev" });
  });

  it("takes the strictest gate of a wave's roots: never < on-destructive < always", () => {
    expect(strictestGate(["never", "on-destructive"])).toBe("on-destructive");
    expect(strictestGate(["never", "always", "on-destructive"])).toBe("always");
    expect(strictestGate([], "never")).toBe("never");
    expect(waveGate(["envs/dev/a", "envs/dev/b"], TWO, "on-destructive")).toBe("never");
    expect(waveGate(["envs/dev/a", "shared/dns"], TWO, "on-destructive")).toBe("on-destructive");
    expect(waveGate(["envs/dev/a", "envs/prod/a"], TWO, "on-destructive")).toBe("always");
    expect(waveGate(["envs/dev/a"], {}, "on-destructive")).toBe("on-destructive");
    expect(anyRootGate(TWO, "never")).toBe("always");
    expect(environmentGates(TWO)).toEqual(["always", "never"]);
  });

  it("puts each environment's identities after the glob-keyed ones, and leaves oidc as it is with none", () => {
    const top = { plan_role: "top-plan", apply_role: "top-apply", roles: { "shared/**": { plan: "s-plan", apply: "s-apply" } } };
    const out = withEnvironmentRoles(top, TWO.environments);
    expect(Object.entries(out!.roles!)).toEqual([
      ["shared/**", { plan: "s-plan", apply: "s-apply" }],
      ["envs/prod/**", { plan: PROD_ROLES.plan_role, apply: PROD_ROLES.apply_role }],
    ]);
    expect(out!.plan_role).toBe("top-plan");
    // No environment names identities: the same object, so init renders the same pipeline.
    expect(withEnvironmentRoles(top, { dev: { roots: ["envs/dev/**"], gate: "never" } })).toBe(top);
    expect(withEnvironmentRoles(top, undefined)).toBe(top);
    expect(withEnvironmentRoles(undefined, undefined)).toBeUndefined();
    expect(withEnvironmentRoles(undefined, TWO.environments)).toEqual({ roles: { "envs/prod/**": { plan: PROD_ROLES.plan_role, apply: PROD_ROLES.apply_role } } });
  });

  it("gives GCP and Azure pairs under the project's own oidc.gcp and oidc.azure", () => {
    const top = {
      gcp: { workload_identity_provider: "projects/1/locations/global/workloadIdentityPools/p/providers/q", plan_service_account: "plan@x.iam", apply_service_account: "apply@x.iam" },
      azure: { tenant_id: "t", subscription_id: "s", plan_client_id: "pc", apply_client_id: "ac" },
    };
    const out = withEnvironmentRoles(top, { prod: { roots: ["envs/prod/**"], oidc: { gcp: { plan_service_account: "pp@x.iam", apply_service_account: "pa@x.iam" }, azure: { plan_client_id: "ppc", apply_client_id: "pac" } } } });
    expect(out!.gcp!.roles).toEqual({ "envs/prod/**": { plan: "pp@x.iam", apply: "pa@x.iam" } });
    expect(out!.azure!.roles).toEqual({ "envs/prod/**": { plan: "ppc", apply: "pac" } });
    expect(out!.roles).toBeUndefined();
  });

  it("marks a root affected when its environment's identities change", () => {
    const before = { environments: TWO.environments };
    const after = { environments: { ...TWO.environments, prod: { ...TWO.environments!.prod!, oidc: { plan_role: "new-plan", apply_role: "new-apply" } } } };
    expect(planSettings(before, "envs/prod/app").oidc).not.toEqual(planSettings(after, "envs/prod/app").oidc);
    // dev's roots keep their identities, so the change plans none of them.
    expect(planSettings(before, "envs/dev/app").oidc).toEqual(planSettings(after, "envs/dev/app").oidc);
  });

  it("plans as many roots at once as the fewest of their environments allows", () => {
    expect(rootsParallelism("/nowhere", ["envs/prod/a", "envs/dev/a"], TWO)).toEqual({ value: 2, reason: "environments.prod.parallelism" });
    expect(rootsParallelism("/nowhere", ["envs/dev/a"], TWO)).toEqual({ value: 4, reason: "terragucci.yml" });
    expect(rootsParallelism("/nowhere", ["envs/dev/a"], { environments: TWO.environments })).toEqual({ value: 4, reason: "the default" });
  });

  it("writes each wave's own gate into the op-waves spec", () => {
    const spec = wavesSpec({ waves: [["envs/dev/a"], ["envs/prod/a"]], gate: "on-destructive", gates: ["never", "always"], approval: "ledger", call: () => ["x"], migrations: false });
    expect(spec.waves.map((w) => w.gate)).toEqual(["never", "always"]);
    const same = wavesSpec({ waves: [["a"], ["b"]], gate: "on-destructive", approval: "ledger", call: () => ["x"], migrations: false });
    expect(same.waves.map((w) => w.gate)).toEqual(["on-destructive", "on-destructive"]);
  });
});

describe("environments in a control repo", () => {
  const control: TerragucciConfig = {
    defaults: { environments: { prod: { gate: "always" } as never } },
    projects: {
      "github.com/acme/infra": { environments: { prod: { roots: ["envs/prod/**"] }, dev: { roots: ["envs/dev/**"], gate: "never" } } },
      "github.com/acme/net": {},
    },
  };

  it("checks a defaults block that holds part of an environment", () => {
    expect(problems(control)).toEqual([]);
  });

  it("merges environments per name, the project's keys over the defaults'", () => {
    expect(resolveProject(control, "github.com/acme/infra").environments).toEqual({
      prod: { gate: "always", roots: ["envs/prod/**"] },
      dev: { roots: ["envs/dev/**"], gate: "never" },
    });
    expect(mergeEnvironments({ a: { roots: ["x"], gate: "always" } }, { a: { roots: ["y"] }, b: { roots: ["z"] } })).toEqual({ a: { roots: ["y"], gate: "always" }, b: { roots: ["z"] } });
    expect(mergeEnvironments(undefined, undefined)).toBeUndefined();
  });

  it("names an environment left with no roots once merged", () => {
    expect(() => resolveProject(control, "github.com/acme/net")).toThrow(/projects\["github\.com\/acme\/net"\]\.environments\.prod\.roots is missing/);
  });

  it("leaves a repo with no environments as it was", () => {
    expect(resolveRepo({ gate: "always" }).environments).toBeUndefined();
  });
});

describe("environments in the report, the note and the estate page", () => {
  const created = plan([rc("terraform_data.x", ["create"], null, { input: "a" })], {
    planned_values: { root_module: { resources: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", provider_name: "terraform.io/builtin/terraform", values: {} }] } },
  });

  it("names each root's environment and each wave's in report.json, and gates a plan's wave by its own policy", () => {
    const r = buildReport({
      run: { ...RUN, stage: "tf-plan" },
      roots: [{ path: "envs/prod/app", plan: created, planner: "tofu", environment: "prod" }, { path: "shared/dns", plan: created, planner: "tofu" }],
      waves: [{ number: 1, roots: ["envs/prod/app", "shared/dns"], environments: ["prod"], policy: "always" }],
      gate: "never",
    });
    expect(r.roots.find((x) => x.path === "envs/prod/app")?.environment).toBe("prod");
    expect(r.roots.find((x) => x.path === "shared/dns")).not.toHaveProperty("environment");
    expect(r.waves[0]?.environments).toEqual(["prod"]);
    expect(r.waves[0]?.waits).toBe(true);
    expect(renderNote(r)).toContain("| Wave | Roots | Environments | Digest of its changes | When it applies |");
    expect(renderNote(r)).toMatch(/\| 1 \| 2 \| prod \| /);
  });

  it("leaves the report and the note as they were with no environments", () => {
    const r = buildReport({ run: { ...RUN, stage: "tf-plan" }, roots: [{ path: "a", plan: created, planner: "tofu" }], waves: [{ number: 1, roots: ["a"] }], gate: "never" });
    expect(r.roots[0]).not.toHaveProperty("environment");
    expect(r.waves[0]).not.toHaveProperty("environments");
    expect(r.waves[0]?.waits).toBe(false);
    expect(renderNote(r)).toContain("| Wave | Roots | Digest of its changes | When it applies |");
    expect(renderNote(r)).not.toContain("Environments");
  });

  it("carries a root's environment into the inventory and onto the estate page", () => {
    const r = buildReport({
      run: { ...RUN, stage: "tf-apply", wave: 1 },
      roots: [{ path: "envs/prod/app", plan: created, planner: "tofu", applied: true, environment: "prod" }, { path: "shared/dns", plan: created, planner: "tofu", applied: true }],
      waves: [{ number: 1, roots: ["envs/prod/app", "shared/dns"], approval: "not-required", environments: ["prod"] }],
    });
    const inv = inventoryRoots(r, "runs/x");
    expect(inv.map((i) => i.environment)).toEqual(["prod", undefined]);
    const estate = buildEstate([{ project: "github.com/acme/infra", reports: [], inventory: { schema: "terragucci.inventory/v1", roots: inv } }], new Date("2026-10-12T00:00:00Z"));
    expect(estate.projects[0]?.inventory?.roots.map((x) => x.environment)).toEqual(["prod", undefined]);
    const html = renderEstateHtml(estate);
    expect(html).toContain('data-environment="prod"');
    expect(html.match(/data-environment=/g)).toHaveLength(1);
  });
});
