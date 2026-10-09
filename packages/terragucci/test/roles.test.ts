import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { validateConfig } from "../src/config";
import { cloudScripts, renderPipeline } from "../src/render";
import { credentialWarnings, ROOT_ROLES_ENV, rolesFromEnv, rootRoleEnv, rootRoles, stateAccess } from "../src/roles";
import { backend, remoteState, tmp, write } from "./helpers";

const DEV = { plan: "arn:aws:iam::111111111111:role/dev-plan", apply: "arn:aws:iam::111111111111:role/dev-apply" };
const PROD = { plan: "arn:aws:iam::222222222222:role/prod-plan", apply: "arn:aws:iam::222222222222:role/prod-apply" };
const ROLES = { "envs/dev/**": DEV, "envs/prod/**": PROD };

/** envs/dev/app and envs/prod/app, each with its own state key; with `reads`, prod's app reads dev's state. */
function envRepo(reads = false): string {
  return write(tmp(), {
    "envs/dev/app/main.tf": backend("dev/app.tfstate"),
    "envs/prod/app/main.tf": backend("prod/app.tfstate") + (reads ? remoteState("dev/app.tfstate") : ""),
  });
}

async function check(dir: string, ...flags: string[]): Promise<{ code: number; out: string; err: string }> {
  const cwd = process.cwd();
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  const error = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  process.chdir(dir);
  try {
    return { code: await main(["config", "check", ...flags]), out: out.join("\n"), err: err.join("\n") };
  } finally {
    process.chdir(cwd);
    log.mockRestore();
    error.mockRestore();
  }
}

describe("oidc.roles in the config", () => {
  it("takes roles by root glob, with or without a pair for the other roots", () => {
    expect(validateConfig({ oidc: { roles: ROLES } }, "t").oidc).toEqual({ roles: ROLES });
    expect(validateConfig({ oidc: { plan_role: "p", apply_role: "a", roles: ROLES } }, "t").oidc?.roles).toEqual(ROLES);
  });

  it("refuses a glob with one role for both stages, a missing stage, a stray key and an empty map", () => {
    expect(() => validateConfig({ oidc: { roles: { "envs/dev/**": { plan: "x", apply: "x" } } } }, "t")).toThrow(/plan and apply are the same role/);
    expect(() => validateConfig({ oidc: { roles: { "envs/dev/**": { plan: "x" } } } }, "t")).toThrow(/\.apply must name a role/);
    expect(() => validateConfig({ oidc: { roles: { "envs/dev/**": { ...DEV, role: "y" } } } }, "t")).toThrow(/role is not a setting/);
    expect(() => validateConfig({ oidc: { roles: {} } }, "t")).toThrow(/must map root globs/);
    expect(() => validateConfig({ oidc: { plan_role: "p", roles: ROLES } }, "t")).toThrow(/apply_role must name a role/);
  });

  it("sends a Terragrunt repo to terragrunt.credentials, and refuses a reports role that is one of the roles", () => {
    expect(() => validateConfig({ terragrunt: {}, oidc: { roles: ROLES } }, "t")).toThrow(/in a Terragrunt repo, set terragrunt.credentials/);
    expect(() => validateConfig({ oidc: { roles: ROLES }, reports: { bucket: "s3://r", role: "arn:aws:iam::111111111111:role/dev-apply" } }, "t")).toThrow(/reports.role is a job's own role/);
  });
});

describe("the pipeline carries each stage's roles", () => {
  it("plan gets the plan roles and apply the apply roles, with the token file and no job role when no pair is set", () => {
    const plan = cloudScripts("github", { roles: ROLES }, "plan", "terragucci-plan").join("\n");
    expect(plan).toContain(`export ${ROOT_ROLES_ENV}='${JSON.stringify(rootRoles(ROLES, "plan"))}'`);
    expect(plan).toContain('export AWS_WEB_IDENTITY_TOKEN_FILE="$(mktemp)"');
    expect(plan).toContain('tg oidc "$AWS_WEB_IDENTITY_TOKEN_FILE"');
    expect(plan).not.toContain("AWS_ROLE_ARN");
    expect(plan).not.toContain("apply");
    const apply = cloudScripts("forgejo", { plan_role: "p", apply_role: "a", roles: ROLES }, "apply", "terragucci-apply").join("\n");
    expect(apply).toContain("export AWS_ROLE_ARN='a'");
    expect(apply).toContain(PROD.apply);
    expect(apply).not.toContain(PROD.plan);
  });

  it("gitlab asks for the AWS token when only roles are set", () => {
    const text = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", layers: [["envs/dev/app", "envs/prod/app"]], env: {}, oidc: { roles: ROLES } }).content;
    expect(text).toContain("TERRAGUCCI_OIDC:");
    expect(text).toContain(DEV.apply);
  });
});

describe("each root's binary takes its own role", () => {
  const env = { [ROOT_ROLES_ENV]: JSON.stringify(rootRoles(ROLES, "apply")), AWS_ROLE_ARN: "job-role", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", AWS_WEB_IDENTITY_TOKEN_FILE: "/t" };

  it("the first glob a root matches, its static keys dropped; a root no glob matches keeps the job's", () => {
    expect(rootRoleEnv(env, "envs/prod/app")).toMatchObject({ AWS_ROLE_ARN: PROD.apply, AWS_WEB_IDENTITY_TOKEN_FILE: "/t" });
    expect(rootRoleEnv(env, "envs/prod/app").AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(rootRoleEnv(env, "envs/dev/app").AWS_ROLE_ARN).toBe(DEV.apply);
    expect(rootRoleEnv(env, "shared/dns")).toBe(env);
    expect(rootRoleEnv({ A: "1" }, "envs/prod/app")).toEqual({ A: "1" });
  });

  it("refuses roles that are not [glob, role] pairs", () => {
    expect(() => rolesFromEnv({ [ROOT_ROLES_ENV]: '{"a":"b"}' })).toThrow(/not a list/);
  });

  it("a step of the root sees the role", () => {
    const r = spawnSync("bash", ["-c", 'echo "$AWS_ROLE_ARN"'], { env: { PATH: process.env.PATH, ...rootRoleEnv(env, "envs/dev/app") }, encoding: "utf-8" });
    expect(r.stdout.trim()).toBe(DEV.apply);
  });
});

describe("config check: the state each role reaches", () => {
  it("lists each role's roots and state keys, and warns about nothing when each environment keeps to its own", () => {
    const a = stateAccess(envRepo(), ["envs/dev/app", "envs/prod/app"], { roles: ROLES });
    expect(a.warnings).toEqual([]);
    expect(a.roles.find((r) => r.role === PROD.apply)).toEqual({ role: PROD.apply, stage: "apply", environment: "envs/prod/**", roots: ["envs/prod/app"], states: ["s3://state/prod/app.tfstate"], reads: [] });
  });

  it("warns when a root reads another environment's state", () => {
    const a = stateAccess(envRepo(true), ["envs/dev/app", "envs/prod/app"], { roles: ROLES });
    expect(a.warnings).toEqual([`oidc: envs/prod/app (envs/prod/**) reads the state of envs/dev/app (envs/dev/**) through terraform_remote_state, so ${PROD.plan} and ${PROD.apply} reach s3://state/dev/app.tfstate, another environment's state`]);
    expect(a.roles.find((r) => r.role === PROD.plan)?.reads).toEqual(["s3://state/dev/app.tfstate"]);
  });

  it("warns when two environments share a role, and when a root is left with no role", () => {
    const shared = stateAccess(envRepo(), ["envs/dev/app", "envs/prod/app"], { roles: { "envs/dev/**": DEV, "envs/prod/**": { plan: PROD.plan, apply: DEV.apply } } });
    expect(shared.warnings).toEqual([`oidc: ${DEV.apply} is the role of envs/dev/** and envs/prod/**, so it reaches the state of each: s3://state/dev/app.tfstate, s3://state/prod/app.tfstate; give each environment roles of its own`]);
    const left = stateAccess(envRepo(), ["envs/dev/app", "envs/prod/app"], { roles: { "envs/dev/**": DEV } });
    expect(left.warnings).toEqual(["oidc: envs/prod/app matches no oidc.roles glob, and oidc names no plan_role and apply_role, so it plans and applies with no AWS role"]);
    // With a pair, the other roots are an environment of their own.
    const paired = stateAccess(envRepo(), ["envs/dev/app", "envs/prod/app"], { plan_role: PROD.plan, apply_role: PROD.apply, roles: { "envs/dev/**": DEV } });
    expect(paired.warnings).toEqual([]);
    expect(paired.roles.find((r) => r.role === PROD.apply)?.environment).toBe("plan_role/apply_role");
  });

  it("warns about a Terragrunt role two unit globs share", () => {
    expect(credentialWarnings({ "live/dev/**": DEV, "live/prod/**": { plan: DEV.plan, apply: PROD.apply } })).toEqual([`terragrunt.credentials: ${DEV.plan} is the plan role of live/dev/** and live/prod/**, so it reaches the state of each; give each environment roles of its own`]);
  });

  it("the command prints the warning and still exits 0; --json carries warnings and state_access", async () => {
    const dir = envRepo(true);
    write(dir, { "terragucci.yml": `oidc:\n  roles:\n    "envs/dev/**": { plan: ${DEV.plan}, apply: ${DEV.apply} }\n    "envs/prod/**": { plan: ${PROD.plan}, apply: ${PROD.apply} }\n` });
    const text = await check(dir);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`  ${PROD.apply} (apply, envs/prod/**): s3://state/prod/app.tfstate; reads s3://state/dev/app.tfstate`);
    expect(text.err).toContain("1 warning(s)");
    expect(text.err).toContain("another environment's state");
    const json = await check(dir, "--json");
    const env = JSON.parse(json.out);
    expect(json.code).toBe(0);
    expect(env.results.warnings).toHaveLength(1);
    expect(env.results.state_access).toHaveLength(4);
  });
});
