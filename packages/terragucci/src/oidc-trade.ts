/**
 * The re-plan's credentials, traded before the change's code is checked out.
 *
 * On GitHub and Forgejo a re-plan (`/terragucci plan`) runs the pull
 * request's head from the default branch's workflow, so the job's OIDC token
 * carries the default branch's subject: the subject the apply identities
 * trust. A token in reach of the change's code (a provider, an `external`
 * data source, the synth command) would let that code take an apply
 * identity. So the re-plan's trade step, which runs before the head is
 * checked out, trades the token for the plan identities' own credentials and
 * deletes it.
 *
 * The trade itself is chant's (`TRADE_JS` in @intentius/chant/ci-identity,
 * the script chant's generated plan job runs with `node -e` from `/`). It
 * trades for one identity per cloud. terragucci's part is the Terraform
 * adapter around it: a re-plan takes several plan identities, so chant's
 * trade runs once per identity, with the token the job already fetched for
 * that cloud, and the results are kept by identity in the file TRADED_ENV
 * names, which rootRoleEnv, the report's stores and the Terragrunt auth
 * provider read:
 *
 *   AWS    each plan role (`plan_role`, `oidc.roles`, Terragrunt's
 *          `credentials`, and `reports.role`), as session keys
 *   GCP    each plan service account (`oidc.gcp` and its `roles`), as an
 *          access token
 *   Azure  not traded: the azurerm provider and backend take no access
 *          token, only the OIDC token itself, so a re-plan with oidc.azure
 *          has no trade step and plans with the token, and says so in its
 *          log (render.ts, the re-plan's Azure warning)
 *
 * The plan step then starts without the token-request variables and reads
 * what `writeTraded` wrote: the job's own identity as the variables the
 * providers read, and every identity in the TRADED_ENV file.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRADE_JS, TRADE_SPEC_ENV, idTokenVar, type CloudTradeSpec } from "@intentius/chant/ci-identity";
import { TRADED_ENV, type Traded } from "./traded";
import { StoreError } from "./report/object-store";
import { rolesFromEnv, ROOT_GCP_ENV } from "./roles";
import { ROLES_ENV } from "./terragrunt";

export { TRADED_ENV, tradedFromEnv, tradedRole, type Traded, type TradedAws } from "./traded";

const sh = (v: string): string => `'${v.replace(/'/g, `'\\''`)}'`;

/** STS's address for a role: AWS_ENDPOINT_URL_STS or AWS_ENDPOINT_URL when set, else the region's (a China region's in its own domain). */
export function stsEndpoint(env: NodeJS.ProcessEnv): string {
  const set = env.AWS_ENDPOINT_URL_STS || env.AWS_ENDPOINT_URL;
  if (set) return set.replace(/\/+$/, "");
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  return `https://sts.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
}

/** The AWS roles a re-plan takes: the job's, each root glob's, each Terragrunt unit glob's, and `reports.role`. */
export function awsRoles(env: NodeJS.ProcessEnv, reportsRole?: string): string[] {
  let unitRoles: [string, string][] = [];
  try {
    unitRoles = JSON.parse(env[ROLES_ENV] || "[]") as [string, string][];
  } catch {
    throw new StoreError(`${ROLES_ENV} is not JSON`);
  }
  const all = [env.AWS_ROLE_ARN, ...rolesFromEnv(env).map(([, r]) => r), ...unitRoles.map(([, r]) => r), reportsRole];
  return [...new Set(all.filter((r): r is string => Boolean(r)))];
}

/** What oidc.gcp's external_account file (gcpScript in ./render.ts) says: the service account, the provider, the token file and the endpoints. */
interface ExternalAccount {
  serviceAccount?: string;
  provider?: string;
  tokenFile?: string;
  stsEndpoint?: string;
  iamEndpoint?: string;
}

function externalAccount(file: string): ExternalAccount {
  try {
    const c = JSON.parse(readFileSync(file, "utf-8")) as { audience?: string; token_url?: string; service_account_impersonation_url?: string; credential_source?: { file?: string } };
    const imp = /^(https?:\/\/[^/]+)\/.*\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(c.service_account_impersonation_url ?? "");
    return {
      ...(imp ? { serviceAccount: decodeURIComponent(imp[2]!), iamEndpoint: imp[1] } : {}),
      ...(c.audience ? { provider: c.audience.replace(/^(https:)?\/\/iam\.googleapis\.com\//, "") } : {}),
      ...(c.credential_source?.file ? { tokenFile: c.credential_source.file } : {}),
      ...(c.token_url ? { stsEndpoint: c.token_url.replace(/\/v1\/token\/?$/, "") } : {}),
    };
  } catch {
    return {};
  }
}

/** What the trade's process keeps of the job's environment: the PATH, the run's id for the session name, and a CA bundle. */
const passed = (env: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(["PATH", "GITHUB_RUN_ID", "NODE_EXTRA_CA_CERTS"].flatMap((k) => (env[k] ? [[k, env[k]!]] : [])));

/** Runs chant's trade for one identity: `node -e TRADE_JS` from `/`, with the token the job fetched, and reads back the variables it wrote. */
export type ChantTrade = (spec: CloudTradeSpec, token: string) => Promise<Record<string, string>>;

/** chant's trade script, run as chant's plan job runs it, writing the `sh` format to a private file this reads and deletes. */
export const chantTrade: ChantTrade = async (spec, token) => {
  const cloud = spec.aws ? "aws" : spec.gcp ? "gcp" : "azure";
  const dir = mkdtempSync(join(tmpdir(), "terragucci-trade-"));
  const out = join(dir, "traded.sh");
  const failed = await new Promise<string | undefined>((done) => {
    execFile(process.execPath, ["-e", TRADE_JS, out, "sh"], { cwd: "/", env: { ...passed(process.env), [TRADE_SPEC_ENV]: JSON.stringify(spec), [idTokenVar(cloud)]: token }, encoding: "utf-8" }, (err, _stdout, stderr) =>
      done(err ? String(stderr ?? "").trim().split("\n").pop() || err.message : undefined),
    );
  });
  if (failed !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    throw new StoreError(failed.replace(/^chant: /, ""));
  }
  try {
    const vars: Record<string, string> = {};
    for (const line of readFileSync(out, "utf-8").split("\n")) {
      const m = /^export ([A-Z_]+)='([^']*)'$/.exec(line);
      if (m) vars[m[1]!] = m[2]!;
    }
    return vars;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const readToken = (file: string, what: string): string => {
  try {
    return readFileSync(file, "utf-8").trim();
  } catch (e) {
    throw new StoreError(`the re-plan takes ${what}, and its token file ${file} cannot be read: ${(e as Error).message}`);
  }
};

/**
 * Trade the job's tokens for every plan identity the environment names, with
 * chant's trade once per identity. Throws for Azure, which a re-plan does not
 * trade for, and when a role or service account is named with no token to
 * trade.
 */
export async function trade(env: NodeJS.ProcessEnv, options: { reportsRole?: string; run?: ChantTrade } = {}): Promise<Traded> {
  const run = options.run ?? chantTrade;
  if (env.ARM_OIDC_TOKEN_FILE_PATH) {
    throw new StoreError(
      "oidc-trade does not trade for oidc.azure: the azurerm provider and backend take only the OIDC token itself. A re-plan with oidc.azure plans with the job's token and has no trade step",
    );
  }
  const out: Traded = { aws: {}, gcp: {} };
  const roles = awsRoles(env, options.reportsRole);
  if (roles.length > 0) {
    const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
    if (!tokenFile) throw new StoreError(`the re-plan takes ${roles.join(", ")}, and AWS_WEB_IDENTITY_TOKEN_FILE is not set: the job has no OIDC token to trade`);
    const token = readToken(tokenFile, roles.join(", "));
    const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
    for (const role of roles) {
      const v = await run({ aws: { role, region, audience: "sts.amazonaws.com", endpoint: stsEndpoint(env) } }, token);
      if (!v.AWS_ACCESS_KEY_ID || !v.AWS_SECRET_ACCESS_KEY) throw new StoreError(`the trade gave no credentials for ${role}`);
      out.aws[role] = { accessKeyId: v.AWS_ACCESS_KEY_ID, secretAccessKey: v.AWS_SECRET_ACCESS_KEY, ...(v.AWS_SESSION_TOKEN ? { sessionToken: v.AWS_SESSION_TOKEN } : {}) };
    }
  }
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  const own = gac ? externalAccount(gac) : {};
  const sas = [...new Set([own.serviceAccount, ...rolesFromEnv(env, ROOT_GCP_ENV).map(([, sa]) => sa)].filter((s): s is string => Boolean(s)))];
  if (sas.length > 0) {
    if (!gac || !own.provider) throw new StoreError(`${ROOT_GCP_ENV} gives roots ${sas.join(", ")}, and GOOGLE_APPLICATION_CREDENTIALS names no external_account file: the job needs oidc.gcp`);
    const tokenFile = own.tokenFile ?? env.TERRAGUCCI_GCP_TOKEN_FILE;
    if (!tokenFile) throw new StoreError(`the re-plan takes ${sas.join(", ")}, and the job has no OIDC token to trade`);
    const token = readToken(tokenFile, sas.join(", "));
    for (const serviceAccount of sas) {
      const v = await run(
        { gcp: { serviceAccount, provider: own.provider, audience: `//iam.googleapis.com/${own.provider}`, ...(own.stsEndpoint ? { stsEndpoint: own.stsEndpoint } : {}), ...(own.iamEndpoint ? { iamEndpoint: own.iamEndpoint } : {}) } },
        token,
      );
      if (!v.GOOGLE_OAUTH_ACCESS_TOKEN) throw new StoreError(`the trade gave no token for ${serviceAccount}`);
      out.gcp[serviceAccount] = { token: v.GOOGLE_OAUTH_ACCESS_TOKEN, expires: Date.now() + 3600_000 };
    }
  }
  return out;
}

/** The token files and credential files the trade read: deleted once it is done, so no later process finds them. */
export function tradedFiles(env: NodeJS.ProcessEnv): string[] {
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  return [env.AWS_WEB_IDENTITY_TOKEN_FILE, env.TERRAGUCCI_GCP_TOKEN_FILE, gac, gac ? externalAccount(gac).tokenFile : undefined].filter((f): f is string => Boolean(f));
}

/**
 * Write the shell the plan step sources (`out`) and the credentials' file
 * beside it (`out.json`), both mode 0600. The shell exports the job's own
 * identity as the AWS SDKs and the google provider read it, unless the job
 * already holds static AWS keys (reports' keys), which the SDKs read first
 * and which stay first, and names the file in TRADED_ENV.
 */
export function writeTraded(out: string, traded: Traded, env: NodeJS.ProcessEnv): void {
  const json = `${out}.json`;
  writeFileSync(json, JSON.stringify(traded) + "\n", { mode: 0o600 });
  const lines = [`export ${TRADED_ENV}=${sh(json)}`];
  const role = env.AWS_ROLE_ARN ? traded.aws[env.AWS_ROLE_ARN] : undefined;
  if (role && !env.AWS_ACCESS_KEY_ID) {
    lines.push(`export AWS_ACCESS_KEY_ID=${sh(role.accessKeyId)} AWS_SECRET_ACCESS_KEY=${sh(role.secretAccessKey)}${role.sessionToken ? ` AWS_SESSION_TOKEN=${sh(role.sessionToken)}` : ""}`);
  }
  const sa = env.GOOGLE_APPLICATION_CREDENTIALS ? externalAccount(env.GOOGLE_APPLICATION_CREDENTIALS).serviceAccount : undefined;
  if (sa && traded.gcp[sa]) lines.push(`export GOOGLE_OAUTH_ACCESS_TOKEN=${sh(traded.gcp[sa].token)}`);
  writeFileSync(out, lines.join("\n") + "\n", { mode: 0o600 });
}

/** `terragucci oidc-trade`: trade, write, and delete the tokens. A failed trade deletes them too. */
export async function tradeCommand(out: string, env: NodeJS.ProcessEnv, options: { reportsRole?: string; run?: ChantTrade } = {}): Promise<string[]> {
  const files = tradedFiles(env);
  try {
    const traded = await trade(env, options);
    writeTraded(out, traded, env);
    return [
      ...Object.keys(traded.aws).map((r) => `traded the job's OIDC token for ${r}`),
      ...Object.keys(traded.gcp).map((s) => `traded the job's OIDC token for ${s}`),
    ];
  } finally {
    for (const f of files) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // Gone already.
      }
    }
  }
}
