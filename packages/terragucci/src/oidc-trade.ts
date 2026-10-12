/**
 * The re-plan's credentials, traded before the change's code runs.
 *
 * On GitHub and Forgejo a re-plan (`/terragucci plan`) runs the pull
 * request's head from the default branch's workflow, so the job's OIDC token
 * carries the default branch's subject: the subject the apply identities
 * trust. A token in reach of the change's code (a provider, an `external`
 * data source, the synth command) would let that code take an apply
 * identity. So the re-plan's trade step, which runs terragucci alone and
 * before the head is checked out, trades the token for the plan identities'
 * own credentials and deletes it:
 *
 *   AWS    each plan role (`plan_role`, `oidc.roles`, Terragrunt's
 *          `credentials`, and `reports.role`), through STS
 *          AssumeRoleWithWebIdentity, as session keys
 *   GCP    each plan service account (`oidc.gcp` and its `roles`), through
 *          Google's STS and IAM, as an access token
 *   Azure  refused: the azurerm provider and backend take no access token,
 *          only the OIDC token itself, so a re-plan cannot hold an Azure
 *          identity without the token
 *
 * The plan step then starts without the token-request variables and reads
 * what `writeTraded` wrote: the job's own identity as the variables the
 * providers read, and every identity in the file TRADED_ENV names, which
 * rootRoleEnv, the report's stores and the Terragrunt auth provider read.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { TRADED_ENV, type Traded } from "./traded";
import { assumeRoleWithWebIdentity, type S3Credentials } from "./report/s3";
import { GcsClient } from "./report/gcs";
import { StoreError, type StoreFetch } from "./report/object-store";
import { gcpCredentials, rolesFromEnv, ROOT_GCP_ENV } from "./roles";
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

/** The service account an external_account file impersonates. */
function impersonatedBy(file: string): string | undefined {
  try {
    const c = JSON.parse(readFileSync(file, "utf-8")) as { service_account_impersonation_url?: string };
    const m = /\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(c.service_account_impersonation_url ?? "");
    return m ? decodeURIComponent(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** The OIDC token file an external_account file reads. */
function tokenFileOf(file: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(file, "utf-8")) as { credential_source?: { file?: string } }).credential_source?.file;
  } catch {
    return undefined;
  }
}

/**
 * Trade the job's tokens for every plan identity the environment names.
 * Throws for Azure, and when a role or service account is named with no
 * token to trade.
 */
export async function trade(env: NodeJS.ProcessEnv, options: { reportsRole?: string; fetchFn?: StoreFetch; written?: string[] } = {}): Promise<Traded> {
  const fetchFn = options.fetchFn ?? (fetch as unknown as StoreFetch);
  if (env.ARM_OIDC_TOKEN_FILE_PATH) {
    throw new StoreError(
      "a re-plan does not run with oidc.azure: it runs the pull request's code, and the azurerm provider and backend take only the OIDC token, which carries the default branch's subject that the apply client trusts. The plan on the pull request's own push plans it",
    );
  }
  const out: Traded = { aws: {}, gcp: {} };
  const roles = awsRoles(env, options.reportsRole);
  if (roles.length > 0) {
    const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
    if (!tokenFile) throw new StoreError(`the re-plan takes ${roles.join(", ")}, and AWS_WEB_IDENTITY_TOKEN_FILE is not set: the job has no OIDC token to trade`);
    const endpoint = stsEndpoint(env);
    const sessionName = env.AWS_ROLE_SESSION_NAME || "terragucci-plan";
    for (const roleArn of roles) {
      const c: S3Credentials & { expiration?: Date } = await assumeRoleWithWebIdentity({ roleArn, tokenFile, sessionName, endpoint }, fetchFn);
      out.aws[roleArn] = {
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
        ...(c.expiration ? { expiration: c.expiration.toISOString() } : {}),
      };
    }
  }
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  const own = gac ? impersonatedBy(gac) : undefined;
  const sas = [...new Set([own, ...rolesFromEnv(env, ROOT_GCP_ENV).map(([, sa]) => sa)].filter((s): s is string => Boolean(s)))];
  for (const sa of sas) {
    const file = gcpCredentials(env, sa);
    if (file !== gac) options.written?.push(file);
    out.gcp[sa] = await new GcsClient({ bucket: "", endpoint: "", credentialsFile: file }, fetchFn).identityToken();
  }
  return out;
}

/** The token files and credential files the trade read: deleted once it is done, so no later process finds them. */
export function tradedFiles(env: NodeJS.ProcessEnv): string[] {
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  return [env.AWS_WEB_IDENTITY_TOKEN_FILE, env.TERRAGUCCI_GCP_TOKEN_FILE, gac, gac ? tokenFileOf(gac) : undefined].filter((f): f is string => Boolean(f));
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
  const sa = env.GOOGLE_APPLICATION_CREDENTIALS ? impersonatedBy(env.GOOGLE_APPLICATION_CREDENTIALS) : undefined;
  if (sa && traded.gcp[sa]) lines.push(`export GOOGLE_OAUTH_ACCESS_TOKEN=${sh(traded.gcp[sa].token)}`);
  writeFileSync(out, lines.join("\n") + "\n", { mode: 0o600 });
}

/** `terragucci oidc-trade`: trade, write, and delete the tokens. A failed trade deletes them too. */
export async function tradeCommand(out: string, env: NodeJS.ProcessEnv, options: { reportsRole?: string; fetchFn?: StoreFetch } = {}): Promise<string[]> {
  const files = tradedFiles(env);
  try {
    const traded = await trade(env, { ...options, written: files });
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
