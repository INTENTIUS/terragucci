// The re-plan runs a pull request's code from the default branch's workflow, so its OIDC token carries the
// subject the apply identities trust. These tests hold that the token never reaches the step that runs that code:
// chant's product plan (terragucci issue 1411) trades it for the plan identities' credentials before the head is
// checked out, and the plan step starts without the variables that ask for another.
import { CACHE, CACHE_RESTORE } from "../src/action-pins";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { OIDC_REQUEST_VARS, renderPipeline, type PipelineInput } from "../src/render";
import { CLOUD_TARGETS_ENV, TRADE_SPEC_ENV, type CloudTargetsFile, type CloudTradeSpec } from "@intentius/chant/ci-identity";
import { rootRoleEnv, ROOT_GCP_ENV, ROOT_ROLES_ENV, tradedVars } from "../src/cloud-identity";
import { s3FromEnv, gcsFromEnv } from "@intentius/chant/object-store";
import { STORE_WORDS } from "../src/report/object-store";
import { authProviderOutput, ROLES_ENV } from "../src/terragrunt";
import { stsEndpoint } from "../src/root-secrets";

const PLAN = "arn:aws:iam::111111111111:role/plan-ro";
const APPLY = "arn:aws:iam::111111111111:role/apply-rw";
const OIDC = { plan_role: PLAN, apply_role: APPLY };
const layers = [["network"], ["app", "cache"]];

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
const render = (forge: "github" | "forgejo", extra: Partial<PipelineInput> = {}): Record<string, any> =>
  body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, ...extra } as PipelineInput).content);

type Step = { name?: string; uses?: string; run?: string; id?: string; if?: string; env?: Record<string, string> };
const steps = (doc: Record<string, any>, job: string): Step[] => doc.jobs[job].steps as Step[];
const planStep = (s: Step[]): Step => s.find((x) => typeof x.run === "string" && x.run.includes("terragucci stage tf-plan"))!;
const tradeStep = (s: Step[]): Step | undefined => s.find((x) => x.name === "Trade the job's OIDC token for the plan identities");
const traded = (s: Step[]): CloudTradeSpec => JSON.parse(tradeStep(s)!.env![TRADE_SPEC_ENV]!) as CloudTradeSpec;
/** The last checkout of a job: the checkout script's step. */
const lastCheckout = (s: Step[]): number => s.map((x) => (x.name ?? "").startsWith("Check out")).lastIndexOf(true);

/** What the plan step's lines say past its first, the restart without the token variables. */
const after = (run: string): string => run.split("\n").slice(1).join("\n");

describe("the re-plan's rendered steps", () => {
  it.each(["github", "forgejo"] as const)("%s: the token is traded before the head's checkout, and the plan step holds none", (forge) => {
    const doc = render(forge, { oidc: OIDC });
    const s = steps(doc, "replan");
    const t = tradeStep(s)!;
    expect(t, "the re-plan has a trade step").toBeDefined();
    const head = s.findIndex((x) => x.name === "Check out the pull request's head");
    expect(head).toBeGreaterThanOrEqual(0);
    expect(s.indexOf(t)).toBeLessThan(head);
    expect(s.indexOf(t)).toBeLessThan(s.indexOf(planStep(s)));
    expect(t.if).toBe("steps.decide.outputs.go == '1'");
    // chant's trade, for the plan identities alone.
    expect(traded(s)).toEqual({ aws: { role: PLAN, region: "us-east-1", audience: "sts.amazonaws.com", targets: [{ targets: [], role: PLAN }] } });
    expect(JSON.stringify(t)).not.toContain(APPLY);
    expect(t.run).not.toMatch(/terragucci stage|synth|tofu |terragrunt /);
    // The plan step restarts without the forge tokens and the token-request variables, and asks for no token.
    const run = planStep(s).run!;
    for (const v of OIDC_REQUEST_VARS) expect(run.split("\n")[0]).toContain(`-u ${v}`);
    // Past the restart, nothing names them.
    expect(after(run)).not.toMatch(/ACTIONS_ID_TOKEN_REQUEST|AWS_WEB_IDENTITY_TOKEN_FILE|CHANT_CLOUD_LOGIN|AWS_ROLE_ARN/);
  });

  it.each(["github", "forgejo"] as const)("%s: the pull request's own plan job trades too, and no other job does", (forge) => {
    const doc = render(forge, { oidc: OIDC });
    const s = steps(doc, "plan");
    expect(traded(s)).toEqual(traded(steps(doc, "replan")));
    expect(s.indexOf(tradeStep(s)!)).toBeLessThan(s.findIndex((x) => x.name === "Check out the change"));
    for (const [name, job] of Object.entries(doc.jobs) as [string, { steps?: Step[] }][]) {
      if (name === "replan" || name === "plan") continue;
      expect(tradeStep(job.steps ?? []), name).toBeUndefined();
    }
  });

  it.each(["github", "forgejo"] as const)("%s: without oidc there is no trade step, and the plan step still drops the forge tokens", (forge) => {
    const s = steps(render(forge), "replan");
    expect(tradeStep(s)).toBeUndefined();
    expect(planStep(s).run!.split("\n")[0]).toContain("-u GITHUB_TOKEN");
  });

  it("roles by root glob: the trade takes each glob's plan role, and the plan step reads it from the trade's targets file", () => {
    const roles = { "envs/dev/*": { plan: "arn:aws:iam::111111111111:role/dev-plan", apply: "arn:aws:iam::111111111111:role/dev-apply" } };
    const s = steps(render("github", { oidc: { ...OIDC, roles } }), "replan");
    expect(traded(s).aws!.targets).toEqual([{ targets: ["envs/dev/*"], role: "arn:aws:iam::111111111111:role/dev-plan" }, { targets: [], role: PLAN }]);
    expect(JSON.stringify(s)).not.toContain("dev-apply");
    expect(after(planStep(s).run!)).not.toMatch(/CHANT_CLOUD_LOGIN|AWS_WEB_IDENTITY_TOKEN_FILE/);
  });

  it("gcp: the trade takes the plan service account at the provider", () => {
    const gcp = { workload_identity_provider: "projects/1/locations/global/workloadIdentityPools/p/providers/f", plan_service_account: "plan@p.iam.gserviceaccount.com", apply_service_account: "apply@p.iam.gserviceaccount.com" };
    const s = steps(render("forgejo", { oidc: { gcp } }), "replan");
    expect(traded(s).gcp).toMatchObject({ provider: "projects/1/locations/global/workloadIdentityPools/p/providers/f", serviceAccount: "plan@p.iam.gserviceaccount.com" });
    expect(JSON.stringify(s)).not.toContain("apply@");
  });

  it.each(["github", "forgejo"] as const)("%s azure: no trade, since azurerm takes only the token; the jobs log in with chant's login", (forge) => {
    const azure = { tenant_id: "t", subscription_id: "s", plan_client_id: "p", apply_client_id: "a" };
    const doc = render(forge, { oidc: { ...OIDC, azure } as never });
    const s = steps(doc, "replan");
    expect(tradeStep(s)).toBeUndefined();
    expect(JSON.stringify(s)).toContain('\\"azure\\":{\\"tenantId\\":\\"t\\",\\"clientId\\":\\"p\\",\\"subscriptionId\\":\\"s\\"');
    if (forge === "github") expect(doc.jobs.replan.permissions["id-token"]).toBe("write");
    else expect(doc.jobs.replan["enable-openid-connect"]).toBe(true);
  });

  it("Terragrunt credentials: the trade takes the units' plan roles; the plan step's prelude names no token", () => {
    const credentials = { "live/prod/*": { plan: "arn:aws:iam::111111111111:role/prod-plan", apply: "arn:aws:iam::111111111111:role/prod-apply" } };
    const terragrunt = { version: "0.99.0", parallelism: 4, exclude: [], installs: [{ tool: "terragrunt", version: "0.99.0" }], credentials };
    const s = steps(render("github", { layers: [["live/prod/app"]], terragrunt } as never), "replan");
    expect(traded(s).aws!.targets).toEqual([{ targets: [], role: "arn:aws:iam::111111111111:role/prod-plan" }]);
    const run = after(planStep(s).run!);
    expect(run).toContain('export TG_AUTH_PROVIDER_CMD="terragucci auth-provider"');
    expect(run).not.toMatch(/TG_IAM_ASSUME_ROLE_WEB_IDENTITY_TOKEN|AWS_WEB_IDENTITY_TOKEN_FILE|CHANT_CLOUD_LOGIN|prod-apply/);
  });

  it("reports.role is traded, not assumed in the plan step", () => {
    const s = steps(render("github", { oidc: OIDC, reports: { bucket: "s3://r", role: "arn:aws:iam::111111111111:role/reports" } }), "replan");
    expect(traded(s).aws!.targets).toContainEqual({ targets: [], role: "arn:aws:iam::111111111111:role/reports" });
  });

  it("an STS endpoint in the pipeline's env is the trade's", () => {
    const s = steps(render("github", { oidc: OIDC, env: { AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_STS: "http://floci:4566/" } }), "replan");
    expect(traded(s).aws).toMatchObject({ region: "eu-west-1", endpoint: "http://floci:4566" });
  });

  it("names STS by region, a China region in its own domain, or by the endpoint the job sets", () => {
    expect(stsEndpoint({})).toBe("https://sts.us-east-1.amazonaws.com");
    expect(stsEndpoint({ AWS_REGION: "cn-north-1" })).toBe("https://sts.cn-north-1.amazonaws.com.cn");
    expect(stsEndpoint({ AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_STS: "http://floci:4566/" })).toBe("http://floci:4566");
  });
});

describe("what reads the traded credentials", () => {
  const tradedEnv = (): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), "traded-"));
    const file = join(dir, "t.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        clouds: {
          aws: {
            targets: [
              { targets: ["envs/dev/*"], identity: "arn:aws:iam::111111111111:role/dev-plan" },
              { targets: [], identity: "arn:aws:iam::111111111111:role/reports" },
              { targets: [], identity: "arn:aws:iam::111111111111:role/unit-plan" },
            ],
            vars: {
              "arn:aws:iam::111111111111:role/dev-plan": { AWS_ACCESS_KEY_ID: "AK-dev", AWS_SECRET_ACCESS_KEY: "SK-dev", AWS_SESSION_TOKEN: "ST-dev" },
              "arn:aws:iam::111111111111:role/reports": { AWS_ACCESS_KEY_ID: "AK-rep", AWS_SECRET_ACCESS_KEY: "SK-rep", AWS_SESSION_TOKEN: "ST-rep" },
              "arn:aws:iam::111111111111:role/unit-plan": { AWS_ACCESS_KEY_ID: "AK-unit", AWS_SECRET_ACCESS_KEY: "SK-unit", AWS_SESSION_TOKEN: "ST-unit" },
            },
          },
          gcp: {
            default: "plan@p.iam.gserviceaccount.com",
            targets: [{ targets: ["envs/dev/*"], identity: "dev@p.iam.gserviceaccount.com" }],
            vars: {
              "dev@p.iam.gserviceaccount.com": { GOOGLE_OAUTH_ACCESS_TOKEN: "tok-dev", CLOUDSDK_AUTH_ACCESS_TOKEN: "tok-dev" },
              "plan@p.iam.gserviceaccount.com": { GOOGLE_OAUTH_ACCESS_TOKEN: "tok-plan", CLOUDSDK_AUTH_ACCESS_TOKEN: "tok-plan" },
            },
          },
        },
      } satisfies CloudTargetsFile),
    );
    return { [CLOUD_TARGETS_ENV]: file, AWS_ACCESS_KEY_ID: "AK-job", AWS_SECRET_ACCESS_KEY: "SK-job" };
  };

  it("a root with its own role and service account gets their traded keys and token, and no role to assume", () => {
    const env = { ...tradedEnv(), [ROOT_ROLES_ENV]: JSON.stringify([["envs/dev/*", "arn:aws:iam::111111111111:role/dev-plan"]]), [ROOT_GCP_ENV]: JSON.stringify([["envs/dev/*", "dev@p.iam.gserviceaccount.com"]]), GOOGLE_APPLICATION_CREDENTIALS: "/should-go" };
    const out = rootRoleEnv(env, "envs/dev/app");
    expect(out).toMatchObject({ AWS_ACCESS_KEY_ID: "AK-dev", AWS_SECRET_ACCESS_KEY: "SK-dev", AWS_SESSION_TOKEN: "ST-dev", GOOGLE_OAUTH_ACCESS_TOKEN: "tok-dev" });
    expect(out.AWS_ROLE_ARN).toBeUndefined();
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    // A root no glob matches keeps the job's own identity.
    expect(rootRoleEnv(env, "envs/prd/app").AWS_ACCESS_KEY_ID).toBe("AK-job");
    // A role the trade did not trade is refused, never assumed.
    expect(() => tradedVars(env, "aws", "arn:aws:iam::111111111111:role/apply-rw")).toThrow(/traded no credentials/);
  });

  it("reports.role writes with its traded keys", () => {
    const t = s3FromEnv({ bucket: "s3://r", role: "arn:aws:iam::111111111111:role/reports", ...STORE_WORDS }, tradedEnv());
    expect(t).toMatchObject({ accessKeyId: "AK-rep", secretAccessKey: "SK-rep", sessionToken: "ST-rep" });
  });

  it("a gs:// bucket takes the job's traded token and signs as its service account", () => {
    const t = gcsFromEnv({ bucket: "b", ...STORE_WORDS }, { ...tradedEnv(), GOOGLE_OAUTH_ACCESS_TOKEN: "tok-plan" });
    expect(t).toMatchObject({ accessToken: "tok-plan", signAs: "plan@p.iam.gserviceaccount.com" });
  });

  it("Terragrunt's auth provider hands a unit its role's traded keys, not a token", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-unit-"));
    mkdirSync(join(dir, "live", "a"), { recursive: true });
    writeFileSync(join(dir, "live", "a", "terragrunt.hcl"), "");
    const out = authProviderOutput(join(dir, "live", "a"), { ...tradedEnv(), TERRAGUCCI_REPO: dir, [ROLES_ENV]: JSON.stringify([["live/*", "arn:aws:iam::111111111111:role/unit-plan"]]) });
    expect(out).toEqual({ awsCredentials: { ACCESS_KEY_ID: "AK-unit", SECRET_ACCESS_KEY: "SK-unit", SESSION_TOKEN: "ST-unit" } });
  });
});

// A re-plan runs from the default branch's workflow, so a cache it saves lands in the default branch's scope, the one
// the apply jobs restore. What the change's code leaves in .terragrunt-cache (a module source with a matching
// .terragrunt-source-version) would then run in an apply wave. The re-plan restores the cache and never saves it.
describe("the re-plan's Terragrunt cache", () => {
  const TG = { version: "0.99.0", parallelism: 4, exclude: [], installs: [{ tool: "terragrunt", version: "0.99.0" }] };
  const tgInput = (extra: Partial<PipelineInput> = {}): Partial<PipelineInput> => ({ layers: [["live/dev/app"], ["live/prod/app"]], terragrunt: TG, oidc: OIDC, ...extra } as never);
  const SAVE = CACHE;
  const RESTORE = CACHE_RESTORE;
  // Forgejo's workflow names an action by its full URL on code.forgejo.org.
  const action = (uses: string | undefined): string => (uses ?? "").replace(/^https:\/\/code\.forgejo\.org\//, "");
  const cacheSteps = (s: Step[]): (Step & { with?: Record<string, string> })[] => s.filter((x) => action(x.uses).startsWith("actions/cache"));
  /** The replan job's block of the rendered workflow, as written. */
  const replanBlock = (text: string): string => {
    const lines = text.split("\n");
    const start = lines.indexOf("  replan:");
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    return `${lines.slice(start, end < 0 ? undefined : end).join("\n")}\n`;
  };
  /** Compare to test/golden/<name>; UPDATE_GOLDEN=1 rewrites it. */
  const golden = (name: string, text: string): void => {
    const path = join(__dirname, "golden", name);
    if (process.env.UPDATE_GOLDEN || !existsSync(path)) writeFileSync(path, text);
    expect(text).toBe(readFileSync(path, "utf-8"));
  };

  it.each(["github", "forgejo"] as const)("%s: the re-plan restores the cache, with the save's key, and saves none", (forge) => {
    const doc = render(forge, tgInput());
    const s = steps(doc, "replan");
    const caches = cacheSteps(s);
    expect(caches.map((x) => action(x.uses))).toEqual([RESTORE]);
    // The same path, key and fallback the saving jobs use, so a re-plan starts as warm as before.
    const saved = cacheSteps(steps(doc, "apply-wave-1"))[0]!;
    expect(action(saved.uses)).toBe(SAVE);
    expect(caches[0]!.with).toEqual(saved.with);
    expect(caches[0]!.with).toEqual({ path: ".terragrunt-cache", key: "terragucci-tg-${{ hashFiles('**/*.hcl') }}", "restore-keys": "terragucci-tg-" });
    expect(caches[0]!.if).toBe("steps.decide.outputs.go == '1'");
    // Restored after the trade and the head's checkout, and before the plan.
    expect(lastCheckout(s)).toBeGreaterThanOrEqual(0);
    expect(lastCheckout(s)).toBeLessThan(s.indexOf(caches[0]!));
    expect(s.indexOf(tradeStep(s)!)).toBeLessThan(s.indexOf(caches[0]!));
    expect(s.indexOf(caches[0]!)).toBeLessThan(s.indexOf(planStep(s)));
    // Nothing else in the job writes to a cache.
    expect(JSON.stringify(s)).not.toMatch(/actions\/cache@|actions\/cache\/save/);
  });

  it.each(["github", "forgejo"] as const)("%s: without oidc the re-plan restores the cache read-only too", (forge) => {
    const caches = cacheSteps(steps(render(forge, tgInput({ oidc: undefined })), "replan"));
    expect(caches.map((x) => action(x.uses))).toEqual([RESTORE]);
  });

  it.each(["github", "forgejo"] as const)("%s: every other job that cached keeps saving as before", (forge) => {
    const doc = render(forge, tgInput({ drift: "0 6 * * *" }));
    // The plan job restores and saves none: a save is a step after the plan's, which would hold a token.
    const restoring = ["replan", "plan"];
    const saving = Object.entries(doc.jobs as Record<string, { steps?: Step[] }>)
      .filter(([name]) => !restoring.includes(name))
      .flatMap(([name, job]) => cacheSteps(job.steps ?? []).map((c) => [name, c] as const));
    // The drift job is chant's Op in a workflow of its own, which caches with its setup step (chant-drift-op.test.ts).
    expect(saving.map(([name]) => name)).toEqual(["apply-comment", "apply-wave-1", "apply-wave-2"]);
    expect(cacheSteps(steps(doc, "plan")).map((x) => action(x.uses))).toEqual([RESTORE]);
    for (const [name, c] of saving) {
      expect(action(c.uses), name).toBe(SAVE);
      expect(c.with, name).toEqual({ path: ".terragrunt-cache", key: "terragucci-tg-${{ hashFiles('**/*.hcl') }}", "restore-keys": "terragucci-tg-" });
    }
  });

  it("gitlab has no re-plan job, and its jobs keep their cache", () => {
    const out = renderPipeline({ forge: "gitlab", binary: "tofu", version: "1.13.1", image: "img:1", env: {}, ...tgInput() } as PipelineInput).content;
    expect(out).not.toMatch(/^replan:/m);
    expect(out).not.toContain("actions/cache");
    expect(out).toContain("key: terragucci-terragrunt");
  });

  it.each(["github", "forgejo"] as const)("%s: the re-plan job (golden)", (forge) => {
    const out = renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", env: {}, ...tgInput() } as PipelineInput).content;
    // The re-plan job is chant's product plan's (terragucci issue 1411), under terragucci's names.
    golden(`replan-${forge}.yml`, replanBlock(out));
  });
});
