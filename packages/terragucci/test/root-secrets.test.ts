// secrets: values a root's binary gets from a cloud's secret store, read at job time with the root's own identity
// (#955). These hold that each store is asked as the root's identity, that the value reaches that root's
// environment alone, that a failed read names the path and the identity and never a value, that the values
// are kept out of plans, reports and log text, and what config check refuses.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, validateConfig, type SecretSource } from "../src/config";
import { configSchemaProblems } from "../src/config-schema";
import { shapeProblems } from "../src/refusals";
import { rootRoleEnv, ROOT_GCP_ENV, ROOT_ROLES_ENV } from "../src/roles";
import { rootSecretEnv, SecretError, secretRootProblems, secretsOf, vaultOf } from "../src/root-secrets";
import { holdSecretValue, scrubText, secretValues } from "../src/secret-values";
import { redactPlan, sensitiveStrings } from "../src/report/redact";
import { scrubPlanText } from "../src/report/plan-text";
import { settingsChanged } from "../src/affected";
import { REDACTED } from "../src/report/schema";
import type { StoreFetch } from "../src/report/object-store";

const DEV_PLAN = "arn:aws:iam::111111111111:role/dev-plan";
const PROD_PLAN = "arn:aws:iam::222222222222:role/prod-plan";
const SOURCES: SecretSource[] = [
  { roots: ["envs/prod/**"], from: "aws", values: { TF_VAR_db_password: "prod/app/db#password" } },
  { roots: ["envs/dev/**"], from: "aws", values: { TF_VAR_db_password: "dev/app/db#password", TF_VAR_api_key: "dev/api-key" } },
];

type Asked = { url: string; method: string; body: string; headers: Record<string, string> };
const answer = (t: string, status = 200) => ({ ok: status < 300, status, text: async () => t });

/** A fetch that answers STS, Secrets Manager, Secret Manager, Entra ID and Key Vault from `secrets`, and records what it was asked. */
function stores(secrets: Record<string, string>, deny: string[] = []): { fetchFn: StoreFetch; asked: Asked[] } {
  const asked: Asked[] = [];
  const fetchFn = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const body = String(init.body ?? "");
    asked.push({ url, method: init.method, body, headers: init.headers });
    if (url.startsWith("http://sts.local")) {
      const name = new URLSearchParams(body).get("RoleArn")!.split("/").pop();
      return answer(`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>AK-${name}</AccessKeyId><SecretAccessKey>SK-${name}</SecretAccessKey><SessionToken>ST-${name}</SessionToken></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`);
    }
    if (url.startsWith("http://sm.local")) {
      const id = (JSON.parse(body) as { SecretId: string }).SecretId;
      if (deny.includes(id)) return answer(JSON.stringify({ __type: "AccessDeniedException", message: "not authorized to perform secretsmanager:GetSecretValue" }), 400);
      return id in secrets ? answer(JSON.stringify({ SecretString: secrets[id] })) : answer(JSON.stringify({ __type: "ResourceNotFoundException", message: "Secrets Manager can't find the specified secret." }), 400);
    }
    if (url.startsWith("https://secretmanager.googleapis.com/v1/")) {
      const name = url.slice("https://secretmanager.googleapis.com/v1/".length).replace(/:access$/, "");
      if (deny.includes(name)) return answer(JSON.stringify({ error: { code: 403, message: "Permission 'secretmanager.versions.access' denied" } }), 403);
      return answer(JSON.stringify({ payload: { data: Buffer.from(secrets[name] ?? "").toString("base64") } }));
    }
    if (url.startsWith("http://login.local/")) return answer(JSON.stringify({ access_token: `vault-token-${new URLSearchParams(body).get("client_id")}` }));
    const kv = /^https:\/\/([^/]+)\/secrets\/(.+)\?api-version=7\.4$/.exec(url);
    if (kv) return answer(JSON.stringify({ value: secrets[`${kv[1]}/${decodeURIComponent(kv[2])}`] }));
    return answer("no such endpoint", 404);
  }) as unknown as StoreFetch;
  return { fetchFn, asked };
}

/** A job with an OIDC token file and the dev and prod plan roles by glob, as the plan stage gets them. */
function awsJob(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "secrets-"));
  writeFileSync(join(dir, "token"), "the-jwt\n");
  return {
    AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "token"),
    AWS_ENDPOINT_URL_STS: "http://sts.local",
    AWS_ENDPOINT_URL_SECRETS_MANAGER: "http://sm.local",
    AWS_REGION: "eu-west-1",
    [ROOT_ROLES_ENV]: JSON.stringify([["envs/prod/**", PROD_PLAN], ["envs/dev/**", DEV_PLAN]]),
  };
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

describe("which values a root takes", () => {
  it("every entry whose globs match, the first that names a variable winning", () => {
    expect(secretsOf("envs/dev/app", SOURCES)).toEqual([
      { name: "TF_VAR_db_password", from: "aws", path: "dev/app/db#password" },
      { name: "TF_VAR_api_key", from: "aws", path: "dev/api-key" },
    ]);
    expect(secretsOf("shared/dns", SOURCES)).toEqual([]);
    expect(secretsOf("envs/dev/app", undefined)).toEqual([]);
  });

  it("config check names a root two entries give the same variable", () => {
    const both: SecretSource[] = [...SOURCES, { roots: ["envs/*/app"], from: "aws", values: { TF_VAR_db_password: "shared/db" } }];
    expect(secretRootProblems(["envs/dev/app", "envs/dev/network"], both)).toEqual([
      "config.secrets: envs/dev/app takes TF_VAR_db_password from both config.secrets[1] and config.secrets[2]; a root's binary gets one value of each name, so narrow their roots globs",
    ]);
    expect(secretRootProblems(["envs/dev/app", "envs/prod/app"], SOURCES)).toEqual([]);
  });
});

describe("reading a root's values", () => {
  it("aws: asks Secrets Manager as the root's own role, and sets the value in that root's environment alone", async () => {
    const { fetchFn, asked } = stores({ "dev/app/db": JSON.stringify({ password: "dev-db-password-1", user: "app" }), "dev/api-key": "dev-api-key-value" });
    const job = awsJob();
    const held: string[] = [];
    const dev = rootRoleEnv(job, "envs/dev/app");
    const out = await rootSecretEnv(dev, "envs/dev/app", SOURCES, { fetchFn, hold: (v) => held.push(v) });
    expect(out.TF_VAR_db_password).toBe("dev-db-password-1");
    expect(out.TF_VAR_api_key).toBe("dev-api-key-value");
    // The root's role is assumed with the job's token, once, and signs every read.
    const sts = asked.filter((a) => a.url.startsWith("http://sts.local"));
    expect(sts.map((a) => new URLSearchParams(a.body).get("RoleArn"))).toEqual([DEV_PLAN]);
    const reads = asked.filter((a) => a.url === "http://sm.local/");
    expect(reads.map((a) => JSON.parse(a.body).SecretId)).toEqual(["dev/app/db", "dev/api-key"]);
    for (const r of reads) {
      expect(r.headers["x-amz-target"]).toBe("secretsmanager.GetSecretValue");
      expect(r.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK-dev-plan\/\d{8}\/eu-west-1\/secretsmanager\/aws4_request, /);
      expect(r.headers["x-amz-security-token"]).toBe("ST-dev-plan");
    }
    // Each value is held, and the whole JSON a key came from.
    expect(held).toEqual(["dev-db-password-1", JSON.stringify({ password: "dev-db-password-1", user: "app" }), "dev-api-key-value"]);
    // Nothing else gets it: neither the environment it was given nor another root's.
    expect(dev.TF_VAR_db_password).toBeUndefined();
    expect(job.TF_VAR_db_password).toBeUndefined();
    const other = rootRoleEnv(job, "shared/dns");
    expect(await rootSecretEnv(other, "shared/dns", SOURCES, { fetchFn })).toBe(other);
  });

  it("aws: a re-plan's traded keys sign the read, with no token to assume", async () => {
    const { fetchFn, asked } = stores({ "prod/app/db": JSON.stringify({ password: "prod-db-password-1" }) });
    const env = { AWS_ACCESS_KEY_ID: "AK-traded", AWS_SECRET_ACCESS_KEY: "SK-traded", AWS_SESSION_TOKEN: "ST-traded", AWS_ENDPOINT_URL_SECRETS_MANAGER: "http://sm.local", [ROOT_ROLES_ENV]: JSON.stringify([["envs/prod/**", PROD_PLAN]]) };
    const out = await rootSecretEnv(env, "envs/prod/app", SOURCES, { fetchFn, hold: () => undefined });
    expect(out.TF_VAR_db_password).toBe("prod-db-password-1");
    expect(asked.some((a) => a.url.startsWith("http://sts.local"))).toBe(false);
    expect(asked[0]!.headers.authorization).toContain("Credential=AK-traded/");
  });

  it("aws: a denied read fails the root, naming the variable, the path and the role, and no value", async () => {
    const { fetchFn } = stores({ "dev/app/db": JSON.stringify({ password: "never-printed-1" }) }, ["dev/app/db"]);
    const env = rootRoleEnv(awsJob(), "envs/dev/app");
    const err = await rootSecretEnv(env, "envs/dev/app", SOURCES, { fetchFn, hold: () => undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretError);
    const msg = (err as Error).message;
    expect(msg).toBe(`TF_VAR_db_password: cannot read dev/app/db#password from aws as ${DEV_PLAN}: GetSecretValue answered 400 AccessDeniedException: not authorized to perform secretsmanager:GetSecretValue`);
    expect(msg).not.toContain("never-printed-1");
  });

  it("a key the JSON secret lacks, or a secret that is not JSON, fails without quoting the secret", async () => {
    const { fetchFn } = stores({ "dev/app/db": JSON.stringify({ pass: "never-printed-2" }), "dev/api-key": "not json never-printed-3" });
    const env = rootRoleEnv(awsJob(), "envs/dev/app");
    const missing = await rootSecretEnv(env, "envs/dev/app", SOURCES, { fetchFn, hold: () => undefined }).catch((e: Error) => e.message);
    expect(missing).toBe(`TF_VAR_db_password: cannot read dev/app/db#password from aws as ${DEV_PLAN}: it has no key password`);
    const sources: SecretSource[] = [{ roots: ["envs/dev/**"], from: "aws", values: { TF_VAR_api_key: "dev/api-key#key" } }];
    const notJson = await rootSecretEnv(env, "envs/dev/app", sources, { fetchFn, hold: () => undefined }).catch((e: Error) => e.message);
    expect(notJson).toBe(`TF_VAR_api_key: cannot read dev/api-key#key from aws as ${DEV_PLAN}: it is not JSON, so it has no key key`);
    expect(`${missing}${notJson}`).not.toMatch(/never-printed/);
  });

  it("gcp: asks Secret Manager for the latest version, or the one the path names, as the root's service account", async () => {
    const { fetchFn, asked } = stores({ "projects/acme-dev/secrets/db/versions/latest": "gcp-dev-password-1", "projects/acme-dev/secrets/key/versions/3": "gcp-dev-key-3" });
    const sources: SecretSource[] = [{ roots: ["envs/dev/**"], from: "gcp", values: { TF_VAR_db_password: "projects/acme-dev/secrets/db", TF_VAR_api_key: "projects/acme-dev/secrets/key/versions/3" } }];
    // A re-plan's traded token for the root's service account, as rootRoleEnv leaves it.
    const env = { GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.dev", [ROOT_GCP_ENV]: JSON.stringify([["envs/dev/**", "dev-plan@acme-dev.iam.gserviceaccount.com"]]) };
    const out = await rootSecretEnv(env, "envs/dev/app", sources, { fetchFn, hold: () => undefined });
    expect(out.TF_VAR_db_password).toBe("gcp-dev-password-1");
    expect(out.TF_VAR_api_key).toBe("gcp-dev-key-3");
    expect(asked.map((a) => [a.method, a.url, a.headers.authorization])).toEqual([
      ["GET", "https://secretmanager.googleapis.com/v1/projects/acme-dev/secrets/db/versions/latest:access", "Bearer ya29.dev"],
      ["GET", "https://secretmanager.googleapis.com/v1/projects/acme-dev/secrets/key/versions/3:access", "Bearer ya29.dev"],
    ]);
  });

  it("gcp: a denied read names the service account", async () => {
    const { fetchFn } = stores({}, ["projects/acme-prod/secrets/db/versions/latest"]);
    const sources: SecretSource[] = [{ roots: ["envs/prod/**"], from: "gcp", values: { TF_VAR_db_password: "projects/acme-prod/secrets/db" } }];
    const env = { GOOGLE_OAUTH_ACCESS_TOKEN: "ya29.prod", [ROOT_GCP_ENV]: JSON.stringify([["envs/prod/**", "prod-plan@acme-prod.iam.gserviceaccount.com"]]) };
    const msg = await rootSecretEnv(env, "envs/prod/app", sources, { fetchFn, hold: () => undefined }).catch((e: Error) => e.message);
    expect(msg).toBe("TF_VAR_db_password: cannot read projects/acme-prod/secrets/db from gcp as prod-plan@acme-prod.iam.gserviceaccount.com: Secret Manager answered 403 Permission 'secretmanager.versions.access' denied");
  });

  it("azure: trades the job's token for a vault token as the root's client, and reads Key Vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-az-"));
    writeFileSync(join(dir, "token"), "the-azure-jwt\n");
    const { fetchFn, asked } = stores({ "acme-dev-kv.vault.azure.net/db-password": "azure-dev-password-1" });
    const sources: SecretSource[] = [{ roots: ["envs/dev/**"], from: "azure", values: { TF_VAR_db_password: "acme-dev-kv/db-password" } }];
    const env = { ARM_CLIENT_ID: "client-dev-plan", ARM_TENANT_ID: "tenant-1", ARM_OIDC_TOKEN_FILE_PATH: join(dir, "token"), AZURE_AUTHORITY_HOST: "http://login.local" };
    const out = await rootSecretEnv(env, "envs/dev/app", sources, { fetchFn, hold: () => undefined });
    expect(out.TF_VAR_db_password).toBe("azure-dev-password-1");
    const token = new URLSearchParams(asked[0]!.body);
    expect(asked[0]!.url).toBe("http://login.local/tenant-1/oauth2/v2.0/token");
    expect(token.get("client_id")).toBe("client-dev-plan");
    expect(token.get("scope")).toBe("https://vault.azure.net/.default");
    expect(token.get("client_assertion")).toBe("the-azure-jwt");
    expect(asked[1]!.url).toBe("https://acme-dev-kv.vault.azure.net/secrets/db-password?api-version=7.4");
    expect(asked[1]!.headers.authorization).toBe("Bearer vault-token-client-dev-plan");
  });

  it("azure: a vault given by host takes that cloud's scope", () => {
    expect(vaultOf("acme-kv/db")).toEqual({ host: "acme-kv.vault.azure.net", scope: "https://vault.azure.net/.default", rest: "db" });
    expect(vaultOf("acme-kv.vault.azure.cn/db/0123abcd")).toEqual({ host: "acme-kv.vault.azure.cn", scope: "https://vault.azure.cn/.default", rest: "db/0123abcd" });
  });
});

describe("a held value is kept out of what terragucci writes", () => {
  it("is redacted from a plan where its variable is not marked sensitive, and from the plan text", () => {
    const value = "held-db-password-1";
    holdSecretValue(value, {}, { logs: false });
    expect(secretValues()).toContain(value);
    const plan = { variables: { db_password: { value } }, planned_values: { root_module: { resources: [{ address: "a.b", values: { conn: `postgres://app:${value}@db` }, sensitive_values: {} }] } } };
    const safe = JSON.stringify(redactPlan(plan).plan);
    expect(safe).not.toContain(value);
    expect(safe).toContain(REDACTED);
    expect(sensitiveStrings(plan)).toContain(value);
    expect(scrubPlanText(`  + db_password = "${value}"\n`, plan).text).not.toContain(value);
  });

  it("is replaced in text in each of its forms, when it is eight characters or more", () => {
    const value = 'held "quoted" <value>';
    holdSecretValue(value, {}, { logs: false });
    holdSecretValue("short", {}, { logs: false });
    const text = [value, JSON.stringify({ v: value }), value.replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"), "a short word"].join("\n");
    const out = scrubText(text);
    expect(out).not.toContain(value);
    expect(out).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(out).not.toContain("&quot;quoted&quot;");
    expect(out).toContain("a short word");
  });

  it("a text with no held value in it is unchanged", () => {
    expect(scrubText("nothing secret here", [])).toBe("nothing secret here");
  });
});

describe("config check", () => {
  const AWS = { plan_role: "arn:aws:iam::333333333333:role/plan", apply_role: "arn:aws:iam::333333333333:role/apply" };

  it("takes entries for each cloud it can read, and the schema agrees", () => {
    const raw = {
      oidc: { ...AWS, gcp: { workload_identity_provider: "projects/1/locations/global/workloadIdentityPools/p/providers/q", plan_service_account: "plan@p.iam.gserviceaccount.com", apply_service_account: "apply@p.iam.gserviceaccount.com" } },
      secrets: [
        { roots: ["envs/prod/**"], from: "aws", values: { TF_VAR_db_password: "prod/app/db#password", TF_VAR_arn: "arn:aws:secretsmanager:eu-west-1:333333333333:secret:prod/x-AbCdEf" } },
        { roots: ["envs/dev/**"], from: "gcp", values: { TF_VAR_db_password: "projects/acme-dev/secrets/db/versions/2#password" } },
      ],
    };
    expect(problems(raw)).toEqual([]);
    expect(configSchemaProblems(raw as never)).toEqual([]);
  });

  it("refuses a bad entry, a path that is not the store's, an identity variable and a name pass gives too", () => {
    const p = problems({
      oidc: AWS,
      pass: { secrets: ["TF_VAR_token"] },
      secrets: [
        { roots: ["envs/prod/**"], from: "vault", values: { TF_VAR_a: "x" } },
        { roots: [], from: "aws", values: { AWS_SECRET_ACCESS_KEY: "prod/keys", TF_VAR_token: "prod/token" }, extra: true },
        { roots: ["envs/dev/**"], from: "gcp", values: { TF_VAR_b: "acme-dev/db" } },
      ],
    });
    expect(p).toContain("config.secrets[0].from must be aws, gcp or azure: the cloud whose secret store holds the values");
    expect(p).toContain("config.secrets[1].extra is not a setting (settings: roots, from, values)");
    expect(p).toContain('config.secrets[1].roots must be a list of root globs, such as ["envs/prod/**"]');
    expect(p.some((x) => x.startsWith("config.secrets[1].values: AWS_SECRET_ACCESS_KEY would replace the cloud identity"))).toBe(true);
    expect(p).toContain("config.secrets[1].values: TF_VAR_token is set by pass.secrets too; a root's binary gets one variable of that name, so take it from the store or from the forge, not both");
    expect(p.some((x) => x.startsWith('config.secrets[2].values.TF_VAR_b: "acme-dev/db" is not where a gcp secret is'))).toBe(true);
    expect(p).toContain("config.secrets: from gcp needs oidc.gcp: each root reads the store with the identity it plans and applies with");
    expect(configSchemaProblems({ secrets: [{ roots: ["a/**"], from: "vault", values: { TF_VAR_a: "x" } }] } as never)).not.toEqual([]);
    expect(configSchemaProblems({ secrets: [{ roots: ["a/**"], from: "aws", values: { AWS_PROFILE: "x" } }] } as never)).not.toEqual([]);
  });

  it("refuses a store no oidc identity reaches, waves.compose and ephemeral", () => {
    const entry = { roots: ["envs/prod/**"], from: "aws", values: { TF_VAR_db_password: "prod/app/db" } };
    expect(problems({ secrets: [entry] })).toEqual([expect.stringContaining("config.secrets: from aws needs oidc with an AWS role")]);
    expect(problems({ environments: { prod: { roots: ["envs/prod/**"], oidc: AWS } }, secrets: [entry] })).toEqual([]);
    expect(problems({ oidc: AWS, waves: { compose: true }, secrets: [entry] })).toEqual([expect.stringContaining("config.secrets: a composed run plans and applies its roots in one run")]);
    expect(problems({ oidc: AWS, ephemeral: { roots: ["envs/dev/app"] }, secrets: [entry] })).toEqual([expect.stringContaining("config.secrets: an ephemeral copy plans and applies without the values secrets fetches")]);
  });

  it("a Terragrunt repo refuses secrets", () => {
    const p = shapeProblems("terragrunt", { secrets: SOURCES }, "config");
    expect(p).toEqual([expect.stringContaining("config.secrets: secrets sets each value in its own root's binary environment, and Terragrunt runs a wave's units in one run --all")]);
  });

  it("a change to a root's values affects that root alone", () => {
    const head = { secrets: [SOURCES[0]!, { ...SOURCES[1]!, values: { TF_VAR_db_password: "dev/app/db2#password" } }] };
    const changed = settingsChanged({ secrets: SOURCES }, head, ["envs/dev/app", "envs/prod/app", "shared/dns"]);
    expect([...changed]).toEqual([["envs/dev/app", ["secrets"]]]);
  });
});
