import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli";
import { validateConfig } from "../src/config";
import { cloudScripts, renderPipeline } from "../src/render";
import { credentialWarnings, gcpCredentials, ROOT_AZURE_ENV, ROOT_GCP_ENV, ROOT_ROLES_ENV, rolesFromEnv, rootRoleEnv, rootRoles, stateAccess } from "../src/roles";
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

const SA = (n: string) => `${n}@acme.iam.gserviceaccount.com`;
const GCP = { workload_identity_provider: "projects/1/locations/global/workloadIdentityPools/p/providers/f", plan_service_account: SA("plan"), apply_service_account: SA("apply") };
const GCP_ROLES = { "envs/prod/**": { plan: SA("prod-plan"), apply: SA("prod-apply") } };
const AZURE = { tenant_id: "tenant", subscription_id: "sub", plan_client_id: "client-plan", apply_client_id: "client-apply" };
const AZURE_ROLES = { "envs/prod/**": { plan: "prod-plan-client", apply: "prod-apply-client" } };

describe("GCP service accounts and Azure clients by root glob", () => {
  it("takes oidc.gcp.roles and oidc.azure.roles, and refuses one identity for both stages, a non-email service account, and a Terragrunt repo", () => {
    expect(validateConfig({ oidc: { gcp: { ...GCP, roles: GCP_ROLES }, azure: { ...AZURE, roles: AZURE_ROLES } } }, "t").oidc).toMatchObject({ gcp: { roles: GCP_ROLES }, azure: { roles: AZURE_ROLES } });
    expect(() => validateConfig({ oidc: { gcp: { ...GCP, roles: { "envs/**": { plan: SA("x"), apply: SA("x") } } } } }, "t")).toThrow(/plan and apply are the same service account/);
    expect(() => validateConfig({ oidc: { gcp: { ...GCP, roles: { "envs/**": { plan: "x", apply: SA("y") } } } } }, "t")).toThrow(/gcp.roles\["envs\/\*\*"\].plan must be a service account's email/);
    expect(() => validateConfig({ oidc: { azure: { ...AZURE, roles: { "envs/**": { plan: "c" } } } } }, "t")).toThrow(/\.apply must name a client/);
    expect(() => validateConfig({ oidc: { azure: { ...AZURE, roles: {} } } }, "t")).toThrow(/must map root globs to a plan and an apply client/);
    expect(() => validateConfig({ terragrunt: {}, oidc: { gcp: { ...GCP, roles: GCP_ROLES } } }, "t")).toThrow(/oidc.gcp.roles: identities by root glob are for plain roots/);
  });

  it("the pipeline carries each stage's service accounts and clients", () => {
    const plan = cloudScripts("github", { gcp: { ...GCP, roles: GCP_ROLES }, azure: { ...AZURE, roles: AZURE_ROLES } }, "plan", "terragucci-plan").join("\n");
    expect(plan).toContain(`export ${ROOT_GCP_ENV}='${JSON.stringify([["envs/prod/**", SA("prod-plan")]])}'`);
    expect(plan).toContain(`export ${ROOT_AZURE_ENV}='${JSON.stringify([["envs/prod/**", "prod-plan-client"]])}'`);
    expect(plan).not.toContain("prod-apply");
    expect(cloudScripts("github", { gcp: GCP }, "apply", "s").join("\n")).not.toContain(ROOT_GCP_ENV);
  });

  it("a root's binary impersonates its service account through a copy of the job's credentials file, and takes its Azure client", () => {
    const dir = tmp();
    const job = {
      type: "external_account",
      audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/f",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA("apply")}:generateAccessToken`,
      credential_source: { file: "/tok" },
    };
    write(dir, { "creds.json": JSON.stringify(job) });
    const env = { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "creds.json"), [ROOT_GCP_ENV]: JSON.stringify([["envs/prod/**", SA("prod-apply")]]), ARM_CLIENT_ID: "client-apply", [ROOT_AZURE_ENV]: JSON.stringify([["envs/prod/**", "prod-apply-client"]]) };
    const prod = rootRoleEnv(env, "envs/prod/app");
    expect(prod.ARM_CLIENT_ID).toBe("prod-apply-client");
    expect(prod.GOOGLE_APPLICATION_CREDENTIALS).not.toBe(env.GOOGLE_APPLICATION_CREDENTIALS);
    const copy = JSON.parse(readFileSync(prod.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8"));
    expect(copy).toEqual({ ...job, service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA("prod-apply")}:generateAccessToken` });
    expect(statSync(prod.GOOGLE_APPLICATION_CREDENTIALS!).mode & 0o777).toBe(0o600);
    expect(rootRoleEnv(env, "envs/prod/app").GOOGLE_APPLICATION_CREDENTIALS).toBe(prod.GOOGLE_APPLICATION_CREDENTIALS);
    expect(rootRoleEnv(env, "envs/dev/app")).toBe(env);
    expect(gcpCredentials(env, SA("apply"))).toBe(env.GOOGLE_APPLICATION_CREDENTIALS);
    write(dir, { "key.json": JSON.stringify({ type: "service_account", client_email: SA("k"), private_key: "x" }) });
    expect(() => rootRoleEnv({ ...env, GOOGLE_APPLICATION_CREDENTIALS: join(dir, "key.json") }, "envs/prod/app")).toThrow(/not an external_account file that impersonates a service account/);
    expect(() => rootRoleEnv({ [ROOT_GCP_ENV]: env[ROOT_GCP_ENV] }, "envs/prod/app")).toThrow(/GOOGLE_APPLICATION_CREDENTIALS is not set/);
  });

  it("config check lists the state each service account and client reaches, and warns when one reads another environment's state", () => {
    const repo = envRepo(true);
    const gcp = stateAccess(repo, ["envs/dev/app", "envs/prod/app"], { gcp: { ...GCP, roles: GCP_ROLES } }, undefined, "gcp");
    expect(gcp.roles.find((r) => r.role === SA("prod-apply"))).toEqual({ role: SA("prod-apply"), stage: "apply", environment: "envs/prod/**", cloud: "gcp", roots: ["envs/prod/app"], states: ["gs://state/prod/app.tfstate"], reads: ["gs://state/dev/app.tfstate"] });
    expect(gcp.roles.find((r) => r.role === SA("apply"))?.environment).toBe("plan_service_account/apply_service_account");
    expect(gcp.warnings).toEqual([`oidc.gcp: envs/prod/app (envs/prod/**) reads the state of envs/dev/app (plan_service_account/apply_service_account) through terraform_remote_state, so ${SA("prod-plan")} and ${SA("prod-apply")} reach gs://state/dev/app.tfstate, another environment's state`]);
    const shared = stateAccess(envRepo(), ["envs/dev/app", "envs/prod/app"], { azure: { ...AZURE, roles: { "envs/prod/**": { plan: "p", apply: "client-apply" } } } }, undefined, "azure");
    expect(shared.warnings).toEqual(["oidc.azure: client-apply is the client of plan_client_id/apply_client_id and envs/prod/**, so it reaches the state of each: dev/app.tfstate, prod/app.tfstate; give each environment clients of its own"]);
    expect(stateAccess(repo, ["envs/dev/app"], { gcp: GCP }, undefined, "gcp")).toEqual({ roles: [], warnings: [] });
  });
});
