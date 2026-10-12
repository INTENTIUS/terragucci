// The re-plan runs a pull request's code from the default branch's workflow, so its OIDC token carries the
// subject the apply identities trust. These tests hold that the token never reaches the step that runs that code:
// a trade step turns it into the plan identities' credentials first, and the plan step starts without the
// variables that ask for another.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { REPLAN_AZURE_WARNING, dropForgeTokens, LEFTOVER_SWEEP, OIDC_REQUEST_VARS, renderPipeline, replanTradeScript, TRADED_FILE, type PipelineInput } from "../src/render";
import { awsRoles, stsEndpoint, trade, tradeCommand } from "../src/oidc-trade";
import { TRADED_ENV } from "../src/traded";
import { rootRoleEnv, ROOT_GCP_ENV, ROOT_ROLES_ENV } from "../src/roles";
import { s3FromEnv } from "../src/report/s3";
import { gcsFromEnv } from "../src/report/gcs";
import { authProviderOutput, ROLES_ENV } from "../src/terragrunt";
import type { StoreFetch } from "../src/report/object-store";

const PLAN = "arn:aws:iam::111111111111:role/plan-ro";
const APPLY = "arn:aws:iam::111111111111:role/apply-rw";
const OIDC = { plan_role: PLAN, apply_role: APPLY };
const layers = [["network"], ["app", "cache"]];

const body = (text: string): Record<string, any> => parseYAML(text.split("\n").filter((l) => !l.startsWith("#")).join("\n")) as Record<string, any>;
const render = (forge: "github" | "forgejo", extra: Partial<PipelineInput> = {}): Record<string, any> =>
  body(renderPipeline({ forge, binary: "tofu", version: "1.13.1", image: "img:1", layers, env: {}, ...extra } as PipelineInput).content);

type Step = { name?: string; uses?: string; run?: string; id?: string; if?: string };
const steps = (doc: Record<string, any>, job: string): Step[] => doc.jobs[job].steps as Step[];
const planStep = (s: Step[]): Step => s.find((x) => typeof x.run === "string" && x.run.includes("terragucci stage tf-plan"))!;
const tradeStep = (s: Step[]): Step | undefined => s.find((x) => x.name === "Trade the job's OIDC token for the plan identities");

/** What the plan step's lines say past its first, the restart without the token variables. */
const after = (run: string): string => run.split("\n").slice(1).join("\n");

describe("the re-plan's rendered steps", () => {
  it.each(["github", "forgejo"] as const)("%s: the token is traded after the head's checkout, before the plan, and the plan step holds none", (forge) => {
    const doc = render(forge, { oidc: OIDC });
    const s = steps(doc, "replan");
    const t = tradeStep(s)!;
    expect(t, "the re-plan has a trade step").toBeDefined();
    const names = s.map((x) => x.id ?? x.uses ?? x.name);
    const checkout = names.lastIndexOf("actions/checkout@v4");
    expect(checkout).toBeLessThan(s.indexOf(t));
    expect(s.indexOf(t)).toBeLessThan(s.indexOf(planStep(s)));
    expect(t.if).toBe("steps.decide.outputs.go == '1'");
    // The trade step runs terragucci alone: the token request, the trade, and none of the change's code.
    expect(t.run).toContain("tg oidc \"$AWS_WEB_IDENTITY_TOKEN_FILE\" 'sts.amazonaws.com'");
    expect(t.run).toContain(`export AWS_ROLE_ARN='${PLAN}'`);
    expect(t.run).toContain(`terragucci oidc-trade --out ${TRADED_FILE}`);
    expect(t.run).not.toContain(APPLY);
    expect(t.run).not.toMatch(/terragucci stage|synth|tofu |terragrunt /);
    // The plan step restarts without the forge tokens and the token-request variables, and asks for no token.
    const run = planStep(s).run!;
    expect(run.split("\n")[0]).toBe(dropForgeTokens("bash", true));
    for (const v of OIDC_REQUEST_VARS) expect(run.split("\n")[0]).toContain(`-u ${v}`);
    expect(after(run)).not.toMatch(/ACTIONS_ID_TOKEN_REQUEST|AWS_WEB_IDENTITY_TOKEN_FILE|tg oidc|AWS_ROLE_ARN/);
    expect(after(run)).toContain(`. ${TRADED_FILE}`);
    expect(after(run)).toContain(LEFTOVER_SWEEP);
    // The traded file is read before the change's own code (synth, the stage) runs.
    expect(after(run).indexOf(`. ${TRADED_FILE}`)).toBeLessThan(after(run).indexOf("terragucci stage tf-plan"));
  });

  it.each(["github", "forgejo"] as const)("%s: the plan job, drift, confirm and the apply jobs keep their tokens as before", (forge) => {
    const doc = render(forge, { oidc: OIDC });
    // The pull request's own plan job carries the pull request's subject, which the apply role does not trust.
    const plan = planStep(steps(doc, "plan")).run!;
    expect(plan).toContain("tg oidc");
    expect(plan.split("\n")[0]).toBe(dropForgeTokens());
    expect(tradeStep(steps(doc, "plan"))).toBeUndefined();
    for (const [name, job] of Object.entries(doc.jobs) as [string, { steps?: Step[] }][]) {
      if (name === "replan") continue;
      expect(tradeStep(job.steps ?? []), name).toBeUndefined();
    }
  });

  it.each(["github", "forgejo"] as const)("%s: without oidc there is no trade step, and the plan step still drops the request variables", (forge) => {
    const s = steps(render(forge), "replan");
    expect(tradeStep(s)).toBeUndefined();
    expect(planStep(s).run!.split("\n")[0]).toBe(dropForgeTokens("bash", true));
    expect(planStep(s).run).not.toContain(TRADED_FILE);
  });

  it("roles by root glob: the trade step exports them to trade, and the plan step exports them with no token", () => {
    const roles = { "envs/dev/*": { plan: "arn:aws:iam::111111111111:role/dev-plan", apply: "arn:aws:iam::111111111111:role/dev-apply" } };
    const s = steps(render("github", { oidc: { ...OIDC, roles } }), "replan");
    expect(tradeStep(s)!.run).toContain(`export ${ROOT_ROLES_ENV}='[["envs/dev/*","arn:aws:iam::111111111111:role/dev-plan"]]'`);
    const run = after(planStep(s).run!);
    expect(run).toContain(`export ${ROOT_ROLES_ENV}='[["envs/dev/*","arn:aws:iam::111111111111:role/dev-plan"]]'`);
    expect(run).not.toMatch(/dev-apply|tg oidc|AWS_WEB_IDENTITY_TOKEN_FILE/);
  });

  it("gcp: the trade step writes the external_account file; the plan step names neither it nor the token", () => {
    const gcp = { workload_identity_provider: "projects/1/locations/global/workloadIdentityPools/p/providers/f", plan_service_account: "plan@p.iam.gserviceaccount.com", apply_service_account: "apply@p.iam.gserviceaccount.com" };
    const s = steps(render("forgejo", { oidc: { gcp } }), "replan");
    expect(tradeStep(s)!.run).toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(tradeStep(s)!.run).toContain("plan@p.iam.gserviceaccount.com");
    const run = after(planStep(s).run!);
    expect(run).not.toMatch(/GOOGLE_APPLICATION_CREDENTIALS|TERRAGUCCI_GCP_TOKEN_FILE|tg oidc|apply@/);
  });

  it.each(["github", "forgejo"] as const)("%s azure: the re-plan plans with the job's token as before, and its log warns and names the workaround", (forge) => {
    const azure = { tenant_id: "t", subscription_id: "s", plan_client_id: "p", apply_client_id: "a" };
    const doc = render(forge, { oidc: { ...OIDC, azure } as never });
    const s = steps(doc, "replan");
    expect(tradeStep(s), "no trade step: azurerm takes only the token").toBeUndefined();
    const run = planStep(s).run!;
    // The step as it was before the trade: the forge tokens dropped, the token fetched in the step, no traded file.
    expect(run.split("\n")[0]).toBe(dropForgeTokens());
    expect(run.split("\n")[1]).toBe(REPLAN_AZURE_WARNING);
    expect(after(run)).toContain("tg oidc");
    expect(after(run)).toContain("ARM_OIDC_TOKEN_FILE_PATH");
    expect(after(run)).not.toContain(TRADED_FILE);
    expect(after(run)).not.toContain(LEFTOVER_SWEEP);
    expect(REPLAN_AZURE_WARNING).toMatch(/^echo '::warning::.*oidc\.azure.*default branch subject.*push to the pull request instead of commenting.*' >&2$/);
    // The job keeps its id-token permission (Forgejo: enable-openid-connect), as before.
    if (forge === "github") expect(doc.jobs.replan.permissions["id-token"]).toBe("write");
    else expect(doc.jobs.replan["enable-openid-connect"]).toBe(true);
    // The plan job is as it was, without the warning.
    expect(planStep(steps(doc, "plan")).run).not.toContain("::warning::");
  });

  it.each(["github", "forgejo"] as const)("%s: without oidc.azure the plan step carries no Azure warning", (forge) => {
    expect(planStep(steps(render(forge, { oidc: OIDC }), "replan")).run).not.toContain(REPLAN_AZURE_WARNING);
  });

  it("Terragrunt credentials: the trade step fetches the token for the units' roles; the plan step's prelude names no token", () => {
    const credentials = { "live/prod/*": { plan: "arn:aws:iam::111111111111:role/prod-plan", apply: "arn:aws:iam::111111111111:role/prod-apply" } };
    const terragrunt = { version: "0.99.0", parallelism: 4, exclude: [], installs: [{ tool: "terragrunt", version: "0.99.0" }], credentials };
    const s = steps(render("github", { layers: [["live/prod/app"]], terragrunt } as never), "replan");
    const t = tradeStep(s)!.run!;
    expect(t).toContain("tg oidc");
    expect(t).toContain(`${ROLES_ENV}='[["live/prod/*","arn:aws:iam::111111111111:role/prod-plan"]]'`);
    const run = after(planStep(s).run!);
    expect(run).toContain('export TG_AUTH_PROVIDER_CMD="terragucci auth-provider"');
    expect(run).not.toMatch(/TG_IAM_ASSUME_ROLE_WEB_IDENTITY_TOKEN|AWS_WEB_IDENTITY_TOKEN_FILE|tg oidc|prod-apply/);
  });

  it("reports.role is traded in the trade step, not assumed in the plan step", () => {
    const t = replanTradeScript("github", OIDC, undefined, "arn:aws:iam::111111111111:role/reports");
    expect(t).toContain(`terragucci oidc-trade --out ${TRADED_FILE} --reports-role 'arn:aws:iam::111111111111:role/reports'`);
    const s = steps(render("github", { oidc: OIDC, reports: { bucket: "s3://r", role: "arn:aws:iam::111111111111:role/reports" } }), "replan");
    expect(tradeStep(s)!.run).toContain("--reports-role 'arn:aws:iam::111111111111:role/reports'");
  });
});

describe("the re-plan's plan step at run time", () => {
  // The step's script, as the runner runs it (bash <file>), with a stand-in for terragucci that is the change's
  // code: it writes its environment, its parents' environments and what the token file holds.
  const runPlanStep = (env: Record<string, string>, traded: string | undefined): { seen: string; status: number | null; stderr: string } => {
    const dir = mkdtempSync(join(tmpdir(), "replan-step-"));
    const repo = join(dir, "repo");
    const bin = join(dir, "bin");
    const temp = join(dir, "temp");
    mkdirSync(repo);
    mkdirSync(bin);
    mkdirSync(temp);
    const g = (...a: string[]): string => spawnSync("git", ["-C", repo, ...a], { encoding: "utf-8" }).stdout.trim();
    g("init", "-q", "-b", "main");
    g("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "head");
    const sha = g("rev-parse", "HEAD");
    if (traded !== undefined) writeFileSync(join(temp, "terragucci-traded.env"), traded);
    writeFileSync(
      join(bin, "terragucci"),
      [
        "#!/bin/bash",
        `out="${dir}/seen"`,
        'env | sort > "$out"',
        'p=$PPID; while [ -n "$p" ] && [ "$p" -gt 1 ] && [ -r "/proc/$p/environ" ]; do tr "\\0" "\\n" < "/proc/$p/environ" | sed "s/^/parent:/" >> "$out"; p="$(awk \'/^PPid:/ { print $2 }\' "/proc/$p/status")"; done',
        '[ -n "${AWS_WEB_IDENTITY_TOKEN_FILE:-}" ] && [ -r "$AWS_WEB_IDENTITY_TOKEN_FILE" ] && echo "token-file:$(cat "$AWS_WEB_IDENTITY_TOKEN_FILE")" >> "$out"',
        'mkdir -p terragucci-report && echo "{\\"roots\\":[]}" > terragucci-report/report.json',
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(bin, "terragucci"), 0o755);
    const doc = render("github", { oidc: OIDC });
    const script = join(dir, "step.sh");
    // Without the sweep: in a container it would kill what other tests started while this step ran.
    writeFileSync(script, planStep(steps(doc, "replan")).run!.replace(LEFTOVER_SWEEP, ""));
    const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
      cwd: repo,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, RUNNER_TEMP: temp, TG_SHA: sha, GITHUB_SERVER_URL: "https://x", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "1", ...env },
      encoding: "utf-8",
    });
    return { seen: existsSync(join(dir, "seen")) ? readFileSync(join(dir, "seen"), "utf-8") : "", status: r.status, stderr: r.stderr };
  };

  it("the change's code finds no token-request variable, here or in a parent, and holds the traded plan keys", () => {
    const r = runPlanStep(
      { ACTIONS_ID_TOKEN_REQUEST_URL: "https://forge/token?x=req-url", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "req-secret", ACTIONS_RUNTIME_TOKEN: "rt-secret", GITHUB_TOKEN: "gh-secret" },
      `export ${TRADED_ENV}='/nowhere.json'\nexport AWS_ACCESS_KEY_ID='ASIAPLAN' AWS_SECRET_ACCESS_KEY='plan-secret' AWS_SESSION_TOKEN='plan-session'\n`,
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.seen).toContain("AWS_ACCESS_KEY_ID=ASIAPLAN");
    expect(r.seen).not.toMatch(/req-url|req-secret|rt-secret|gh-secret/);
    // By name in its own environment; in a parent by value, since the walk climbs past the test into its runner.
    expect(r.seen).not.toMatch(/^ACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN)=/m);
    expect(r.seen).not.toMatch(/AWS_WEB_IDENTITY_TOKEN_FILE|AWS_ROLE_ARN|token-file:/);
  });
});

describe("terragucci oidc-trade", () => {
  /** A fetch that answers STS, Google's STS and IAM Credentials, and records what it was asked. */
  const recorder = (): { fetchFn: StoreFetch; asked: { url: string; body: string; auth?: string }[] } => {
    const asked: { url: string; body: string; auth?: string }[] = [];
    const fetchFn = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      const body = String(init?.body ?? "");
      asked.push({ url, body, ...(init?.headers?.authorization ? { auth: init.headers.authorization } : {}) });
      const text = (t: string, status = 200) => ({ ok: status < 300, status, text: async () => t, json: async () => JSON.parse(t), headers: new Map() });
      if (url.includes("sts.googleapis.com")) return text(JSON.stringify({ access_token: "federated", expires_in: 3600 }));
      const sa = /serviceAccounts\/([^:]+):generateAccessToken/.exec(url)?.[1];
      if (sa) return text(JSON.stringify({ accessToken: `tok-${decodeURIComponent(sa)}`, expireTime: "2099-01-01T00:00:00Z" }));
      const role = new URLSearchParams(body).get("RoleArn")!;
      const name = role.split("/").pop();
      return text(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>AK-${name}</AccessKeyId><SecretAccessKey>SK-${name}</SecretAccessKey><SessionToken>ST-${name}</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
    }) as unknown as StoreFetch;
    return { fetchFn, asked };
  };

  const jobWithToken = (): { dir: string; env: NodeJS.ProcessEnv } => {
    const dir = mkdtempSync(join(tmpdir(), "trade-"));
    writeFileSync(join(dir, "token"), "the-jwt\n");
    return { dir, env: { AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "token"), AWS_ROLE_ARN: PLAN, AWS_ROLE_SESSION_NAME: "terragucci-plan", AWS_ENDPOINT_URL_STS: "http://sts.local/" } };
  };

  it("trades the job's token for each plan role once, writes the job's keys and the file, and deletes the token", async () => {
    const { dir, env } = jobWithToken();
    env[ROOT_ROLES_ENV] = JSON.stringify([["envs/dev/*", "arn:aws:iam::111111111111:role/dev-plan"], ["envs/prd/*", PLAN]]);
    env[ROLES_ENV] = JSON.stringify([["live/*", "arn:aws:iam::111111111111:role/unit-plan"]]);
    const { fetchFn, asked } = recorder();
    const out = join(dir, "traded.env");
    const lines = await tradeCommand(out, env, { reportsRole: "arn:aws:iam::111111111111:role/reports", fetchFn });
    expect(asked.map((a) => new URLSearchParams(a.body).get("RoleArn"))).toEqual([PLAN, "arn:aws:iam::111111111111:role/dev-plan", "arn:aws:iam::111111111111:role/unit-plan", "arn:aws:iam::111111111111:role/reports"]);
    expect(asked.every((a) => a.url === "http://sts.local/" && new URLSearchParams(a.body).get("WebIdentityToken") === "the-jwt")).toBe(true);
    expect(lines).toHaveLength(4);
    expect(existsSync(env.AWS_WEB_IDENTITY_TOKEN_FILE!)).toBe(false);
    const shell = readFileSync(out, "utf-8");
    expect(shell).toContain(`export ${TRADED_ENV}='${out}.json'`);
    expect(shell).toContain("export AWS_ACCESS_KEY_ID='AK-plan-ro' AWS_SECRET_ACCESS_KEY='SK-plan-ro' AWS_SESSION_TOKEN='ST-plan-ro'");
    expect(shell).not.toContain("the-jwt");
    const json = JSON.parse(readFileSync(`${out}.json`, "utf-8"));
    expect(Object.keys(json.aws)).toHaveLength(4);
    expect(JSON.stringify(json)).not.toContain("the-jwt");
  });

  it("leaves the job's static keys first when it holds them (the reports' keys), as the SDKs read them", async () => {
    const { dir, env } = jobWithToken();
    env.AWS_ACCESS_KEY_ID = "AKREPORTS";
    const out = join(dir, "traded.env");
    await tradeCommand(out, env, { fetchFn: recorder().fetchFn });
    expect(readFileSync(out, "utf-8")).not.toContain("AWS_ACCESS_KEY_ID");
  });

  it("refuses a job with oidc.azure, which a re-plan never trades for, and deletes the tokens anyway", async () => {
    const { dir, env } = jobWithToken();
    writeFileSync(join(dir, "azure"), "az-jwt");
    env.ARM_OIDC_TOKEN_FILE_PATH = join(dir, "azure");
    await expect(tradeCommand(join(dir, "traded.env"), env, { fetchFn: recorder().fetchFn })).rejects.toThrow(/does not trade for oidc\.azure/);
    expect(existsSync(env.AWS_WEB_IDENTITY_TOKEN_FILE!)).toBe(false);
    expect(existsSync(join(dir, "traded.env"))).toBe(false);
  });

  it("refuses a role it has no token to trade for", async () => {
    await expect(trade({ AWS_ROLE_ARN: PLAN }, { fetchFn: recorder().fetchFn })).rejects.toThrow(/AWS_WEB_IDENTITY_TOKEN_FILE is not set/);
  });

  it("gcp: trades for the job's service account and each root's, and deletes the token and the credential files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trade-gcp-"));
    const token = join(dir, "gcp-token");
    writeFileSync(token, "gcp-jwt");
    const gac = join(dir, "gac.json");
    writeFileSync(gac, JSON.stringify({ type: "external_account", audience: "//iam.googleapis.com/projects/1/x", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/plan@p.iam.gserviceaccount.com:generateAccessToken", credential_source: { file: token } }));
    const env: NodeJS.ProcessEnv = { GOOGLE_APPLICATION_CREDENTIALS: gac, TERRAGUCCI_GCP_TOKEN_FILE: token, [ROOT_GCP_ENV]: JSON.stringify([["envs/dev/*", "dev@p.iam.gserviceaccount.com"]]) };
    const { fetchFn, asked } = recorder();
    const out = join(dir, "traded.env");
    await tradeCommand(out, env, { fetchFn });
    expect(asked.filter((a) => a.url.includes("generateAccessToken")).map((a) => a.url)).toEqual([
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/plan@p.iam.gserviceaccount.com:generateAccessToken",
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/dev@p.iam.gserviceaccount.com:generateAccessToken",
    ]);
    expect(readFileSync(out, "utf-8")).toContain("export GOOGLE_OAUTH_ACCESS_TOKEN='tok-plan@p.iam.gserviceaccount.com'");
    expect(existsSync(token)).toBe(false);
    expect(existsSync(gac)).toBe(false);
    const json = JSON.parse(readFileSync(`${out}.json`, "utf-8"));
    expect(Object.keys(json.gcp)).toEqual(["plan@p.iam.gserviceaccount.com", "dev@p.iam.gserviceaccount.com"]);
  });

  it("names STS by region, a China region in its own domain, or by the endpoint the job sets", () => {
    expect(stsEndpoint({})).toBe("https://sts.us-east-1.amazonaws.com");
    expect(stsEndpoint({ AWS_REGION: "cn-north-1" })).toBe("https://sts.cn-north-1.amazonaws.com.cn");
    expect(stsEndpoint({ AWS_REGION: "eu-west-1", AWS_ENDPOINT_URL_STS: "http://floci:4566/" })).toBe("http://floci:4566");
    expect(awsRoles({ AWS_ROLE_ARN: PLAN }, PLAN)).toEqual([PLAN]);
  });
});

describe("what reads the traded credentials", () => {
  const tradedEnv = (): NodeJS.ProcessEnv => {
    const dir = mkdtempSync(join(tmpdir(), "traded-"));
    const file = join(dir, "t.json");
    writeFileSync(
      file,
      JSON.stringify({
        aws: {
          "arn:aws:iam::111111111111:role/dev-plan": { accessKeyId: "AK-dev", secretAccessKey: "SK-dev", sessionToken: "ST-dev" },
          "arn:aws:iam::111111111111:role/reports": { accessKeyId: "AK-rep", secretAccessKey: "SK-rep", sessionToken: "ST-rep" },
          "arn:aws:iam::111111111111:role/unit-plan": { accessKeyId: "AK-unit", secretAccessKey: "SK-unit", sessionToken: "ST-unit" },
        },
        gcp: { "dev@p.iam.gserviceaccount.com": { token: "tok-dev", expires: 0 }, "plan@p.iam.gserviceaccount.com": { token: "tok-plan", expires: 0 } },
      }),
    );
    return { [TRADED_ENV]: file, AWS_ACCESS_KEY_ID: "AK-job", AWS_SECRET_ACCESS_KEY: "SK-job" };
  };

  it("a root with its own role and service account gets their traded keys and token, and no role to assume", () => {
    const env = { ...tradedEnv(), [ROOT_ROLES_ENV]: JSON.stringify([["envs/dev/*", "arn:aws:iam::111111111111:role/dev-plan"]]), [ROOT_GCP_ENV]: JSON.stringify([["envs/dev/*", "dev@p.iam.gserviceaccount.com"]]), GOOGLE_APPLICATION_CREDENTIALS: "/should-go" };
    const out = rootRoleEnv(env, "envs/dev/app");
    expect(out).toMatchObject({ AWS_ACCESS_KEY_ID: "AK-dev", AWS_SECRET_ACCESS_KEY: "SK-dev", AWS_SESSION_TOKEN: "ST-dev", GOOGLE_OAUTH_ACCESS_TOKEN: "tok-dev" });
    expect(out.AWS_ROLE_ARN).toBeUndefined();
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    // A root no glob matches keeps the job's own identity.
    expect(rootRoleEnv(env, "envs/prd/app").AWS_ACCESS_KEY_ID).toBe("AK-job");
    // A role the trade step did not trade is refused, never assumed.
    expect(() => rootRoleEnv({ ...env, [ROOT_ROLES_ENV]: JSON.stringify([["envs/dev/*", "arn:aws:iam::111111111111:role/apply-rw"]]) }, "envs/dev/app")).toThrow(/traded no credentials/);
  });

  it("reports.role writes with its traded keys", () => {
    const t = s3FromEnv({ bucket: "s3://r", role: "arn:aws:iam::111111111111:role/reports" }, tradedEnv());
    expect(t).toMatchObject({ accessKeyId: "AK-rep", secretAccessKey: "SK-rep", sessionToken: "ST-rep" });
  });

  it("a gs:// bucket takes the job's traded token and signs as its service account", () => {
    const t = gcsFromEnv({ bucket: "b" }, { ...tradedEnv(), GOOGLE_OAUTH_ACCESS_TOKEN: "tok-plan" });
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
  const SAVE = "actions/cache@v4";
  const RESTORE = "actions/cache/restore@v4";
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
    const saved = cacheSteps(steps(doc, "plan"))[0]!;
    expect(action(saved.uses)).toBe(SAVE);
    expect(caches[0]!.with).toEqual(saved.with);
    expect(caches[0]!.with).toEqual({ path: ".terragrunt-cache", key: "terragucci-tg-${{ hashFiles('**/*.hcl') }}", "restore-keys": "terragucci-tg-" });
    expect(caches[0]!.if).toBe("steps.decide.outputs.go == '1'");
    // Restored after the head's checkout and before the trade and the plan, as the cache was.
    const names = s.map((x) => action(x.uses) || x.name);
    expect(names.lastIndexOf("actions/checkout@v4")).toBeLessThan(s.indexOf(caches[0]!));
    expect(s.indexOf(caches[0]!)).toBeLessThan(s.indexOf(tradeStep(s)!));
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
    const saving = Object.entries(doc.jobs as Record<string, { steps?: Step[] }>)
      .filter(([name]) => name !== "replan")
      .flatMap(([name, job]) => cacheSteps(job.steps ?? []).map((c) => [name, c] as const));
    expect(saving.map(([name]) => name)).toEqual(["plan", "apply-comment", "apply-wave-1", "apply-wave-2", "drift"]);
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
    golden(`replan-${forge}.yml`, replanBlock(out));
  });
});
