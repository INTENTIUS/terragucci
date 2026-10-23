/**
 * `secrets:` in terragucci.yml: values a root's binary gets from a cloud's
 * secret store, fetched by the stage that runs the root (plan, apply,
 * drift) with the identity the root runs with there, after rootRoleEnv
 * (./cloud-identity.ts) has given it that identity:
 *
 *   aws    Secrets Manager GetSecretValue, signed with the root's role,
 *          assumed with the job's OIDC token (`AWS_ROLE_ARN`), or with the
 *          keys the root's environment holds (a re-plan's traded keys)
 *   gcp    Secret Manager's `versions/<v>:access`, with a token for the
 *          root's service account (its GOOGLE_APPLICATION_CREDENTIALS, or a
 *          re-plan's GOOGLE_OAUTH_ACCESS_TOKEN)
 *   azure  Key Vault's `secrets/<name>`, with a vault token for the root's
 *          client (`ARM_CLIENT_ID`), traded at Entra ID for the job's token
 *
 * Each value is set in that root's binary environment alone: the steps, the
 * other roots and the job's own environment never get it. Each one is held
 * (./secret-values.ts), so no plan, report, note or log line terragucci
 * writes carries it. A value that cannot be read fails the root, naming the
 * variable, the store, the path and the identity that asked, never a value.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { globMatch } from "./detect";
import type { SecretSource, SecretStore } from "./config";
import { assumeRoleWithWebIdentity, sign, type S3Credentials } from "./report/s3";
import { GcsClient } from "./report/gcs";
import { AZURE_AUTHORITY } from "./report/azure-blob";
import type { StoreFetch } from "./report/object-store";
import { stsEndpoint } from "./oidc-trade";
import { rootIdentities } from "./cloud-identity";
import { holdSecretValue } from "./secret-values";

/** Secret Manager's address. */
export const GCP_SECRET_MANAGER = "https://secretmanager.googleapis.com";
/** The Key Vault REST version every read names. */
export const KEY_VAULT_VERSION = "7.4";

/** A value that could not be read. Its message names the variable, the store, the path and the identity, never a value. */
export class SecretError extends Error {}

/** One value a root takes: the variable, the store and where the value is in it. */
export interface RootSecret {
  name: string;
  from: SecretStore;
  path: string;
}

/** The values `root` takes from `sources`: every entry whose globs match it, the first entry that names a variable winning. */
export function secretsOf(root: string, sources: readonly SecretSource[] | undefined): RootSecret[] {
  const out = new Map<string, RootSecret>();
  for (const s of sources ?? []) {
    if (!s.roots.some((g) => g === root || globMatch(g, root))) continue;
    for (const [name, path] of Object.entries(s.values)) if (!out.has(name)) out.set(name, { name, from: s.from, path });
  }
  return [...out.values()];
}

/**
 * config check: each root that two entries give the same variable, naming
 * the root, the variable and both entries, since a root's binary gets one
 * value of each name.
 */
export function secretRootProblems(roots: readonly string[], sources: readonly SecretSource[] | undefined, where = "config.secrets"): string[] {
  if (!sources?.length) return [];
  const out: string[] = [];
  for (const root of roots) {
    const by = new Map<string, number>();
    sources.forEach((s, i) => {
      if (!s.roots.some((g) => g === root || globMatch(g, root))) return;
      for (const name of Object.keys(s.values)) {
        const first = by.get(name);
        if (first === undefined) by.set(name, i);
        else out.push(`${where}: ${root} takes ${name} from both ${where}[${first}] and ${where}[${i}]; a root's binary gets one value of each name, so narrow their roots globs`);
      }
    });
  }
  return out;
}

/** Where the value is: the store's own id, and the key of a JSON secret after `#`. */
function splitPath(path: string): { id: string; key?: string } {
  const at = path.lastIndexOf("#");
  return at < 0 ? { id: path } : { id: path.slice(0, at), key: path.slice(at + 1) };
}

/** The value of `key` in a JSON secret, as text. The message never quotes the secret. */
function keyOf(text: string, key: string): string {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`it is not JSON, so it has no key ${key}`);
  }
  if (j === null || typeof j !== "object" || Array.isArray(j) || !(key in j)) throw new Error(`it has no key ${key}`);
  const v = (j as Record<string, unknown>)[key];
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`its key ${key} is not a string, a number or a boolean`);
}

/** An error answer's reason, cut short: the stores never echo a secret's value in one. */
async function why(res: { status: number; text(): Promise<string> }): Promise<string> {
  const text = (await res.text()).trim();
  let reason = text;
  try {
    const j = JSON.parse(text) as { __type?: string; message?: string; Message?: string; error?: { message?: string; code?: string } | string };
    const err = typeof j.error === "object" ? j.error?.message ?? j.error?.code : j.error;
    reason = [j.__type?.split("#").pop(), j.message ?? j.Message ?? err].filter(Boolean).join(": ") || text;
  } catch {
    // Not JSON: the text as it is.
  }
  return `${res.status}${reason ? ` ${reason.slice(0, 300)}` : ""}`;
}

/** An answer's JSON. A parse error is not passed on: Node quotes the text it could not parse, and the text holds the value. */
async function answer<T>(res: { text(): Promise<string> }, what: string): Promise<T> {
  try {
    return JSON.parse(await res.text()) as T;
  } catch {
    throw new Error(`${what} answered with no JSON`);
  }
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The AWS identity a root runs with, and how to sign as it. */
function awsIdentity(root: string, env: NodeJS.ProcessEnv): { name: string; credentials: (fetchFn: StoreFetch) => Promise<S3Credentials> } {
  const keys = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) } : undefined;
  const role = rootIdentities(env, root).aws;
  if (keys) return { name: role ?? env.AWS_ROLE_ARN ?? "the job's AWS keys", credentials: async () => keys };
  const arn = env.AWS_ROLE_ARN;
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
  if (!arn || !tokenFile) return { name: "no AWS identity", credentials: async () => { throw new Error("the job has no AWS identity: it needs oidc with an AWS role"); } };
  return { name: arn, credentials: (fetchFn) => assumeRoleWithWebIdentity({ roleArn: arn, tokenFile, sessionName: env.AWS_ROLE_SESSION_NAME || "terragucci-secrets", endpoint: stsEndpoint(env) }, fetchFn) };
}

/** Secrets Manager's address: AWS_ENDPOINT_URL_SECRETS_MANAGER or AWS_ENDPOINT_URL when set, else the region's. */
export function secretsManagerEndpoint(env: NodeJS.ProcessEnv): string {
  const set = env.AWS_ENDPOINT_URL_SECRETS_MANAGER || env.AWS_ENDPOINT_URL;
  if (set) return set.replace(/\/+$/, "");
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  return `https://secretsmanager.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
}

async function readAws(id: string, env: NodeJS.ProcessEnv, credentials: S3Credentials, fetchFn: StoreFetch, now: Date): Promise<string> {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const url = `${secretsManagerEndpoint(env)}/`;
  const body = JSON.stringify({ SecretId: id });
  const extra = { "content-type": "application/x-amz-json-1.1", "x-amz-target": "secretsmanager.GetSecretValue" };
  const headers = sign({ region, ...credentials }, "POST", url, extra, sha256(body), now, "secretsmanager");
  const res = await fetchFn(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`GetSecretValue answered ${await why(res)}`);
  const j = await answer<{ SecretString?: string; SecretBinary?: string }>(res, "GetSecretValue");
  if (typeof j.SecretString === "string") return j.SecretString;
  if (typeof j.SecretBinary === "string") return Buffer.from(j.SecretBinary, "base64").toString("utf8");
  throw new Error("GetSecretValue answered without a value");
}

/** The service account an external_account file impersonates. */
function impersonatedBy(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    const c = JSON.parse(readFileSync(file, "utf-8")) as { service_account_impersonation_url?: string };
    const m = /\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(c.service_account_impersonation_url ?? "");
    return m ? decodeURIComponent(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** The GCP identity a root runs with, and its access token: a re-plan's traded one first, as the google provider reads it, else its credentials file's. */
function gcpIdentity(root: string, env: NodeJS.ProcessEnv): { name: string; token: (fetchFn: StoreFetch) => Promise<string> } {
  const name = rootIdentities(env, root).gcp ?? impersonatedBy(env.GOOGLE_APPLICATION_CREDENTIALS) ?? "the job's GCP credentials";
  const traded = env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (traded) return { name, token: async () => traded };
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!file) return { name: "no GCP identity", token: async () => { throw new Error("the job has no GCP identity: it needs oidc.gcp"); } };
  return { name, token: async (fetchFn) => (await new GcsClient({ bucket: "", endpoint: "", credentialsFile: file }, fetchFn).identityToken()).token };
}

async function readGcp(id: string, token: string, fetchFn: StoreFetch): Promise<string> {
  const name = /\/versions\/[^/]+$/.test(id) ? id : `${id}/versions/latest`;
  const res = await fetchFn(`${GCP_SECRET_MANAGER}/v1/${name}:access`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Secret Manager answered ${await why(res)}`);
  const j = await answer<{ payload?: { data?: string } }>(res, "Secret Manager");
  if (typeof j.payload?.data !== "string") throw new Error("Secret Manager answered without a value");
  return Buffer.from(j.payload.data, "base64").toString("utf8");
}

/** A Key Vault path's vault host and the token scope for it: a bare vault name is in Azure's public cloud. */
export function vaultOf(id: string): { host: string; scope: string; rest: string } {
  const [vault, ...rest] = id.split("/");
  const host = vault!.includes(".") ? vault! : `${vault}.vault.azure.net`;
  return { host, scope: `https://${host.split(".").slice(1).join(".")}/.default`, rest: rest.join("/") };
}

/** The Azure identity a root runs with, and a token for a vault's scope traded for the job's OIDC token. */
function azureIdentity(env: NodeJS.ProcessEnv): { name: string; token: (scope: string, fetchFn: StoreFetch) => Promise<string> } {
  const clientId = env.ARM_CLIENT_ID;
  const tenantId = env.ARM_TENANT_ID;
  const tokenFile = env.ARM_OIDC_TOKEN_FILE_PATH;
  if (!clientId || !tenantId || !tokenFile) return { name: "no Azure identity", token: async () => { throw new Error("the job has no Azure identity: it needs oidc.azure"); } };
  const authority = (env.AZURE_AUTHORITY_HOST || AZURE_AUTHORITY).replace(/\/+$/, "");
  return {
    name: clientId,
    token: async (scope, fetchFn) => {
      const assertion = readFileSync(tokenFile, "utf-8").trim();
      if (!assertion) throw new Error(`the OIDC token file ${tokenFile} is empty`);
      const body = new URLSearchParams({ client_id: clientId, scope, grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: assertion }).toString();
      const res = await fetchFn(`${authority}/${tenantId}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      if (!res.ok) throw new Error(`Entra ID refused the OIDC token: ${await why(res)}`);
      const j = await answer<{ access_token?: string }>(res, "Entra ID");
      if (!j.access_token) throw new Error("Entra ID answered without a token");
      return j.access_token;
    },
  };
}

async function readAzure(host: string, rest: string, token: string, fetchFn: StoreFetch): Promise<string> {
  const res = await fetchFn(`https://${host}/secrets/${rest.split("/").map(encodeURIComponent).join("/")}?api-version=${KEY_VAULT_VERSION}`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Key Vault answered ${await why(res)}`);
  const j = await answer<{ value?: string }>(res, "Key Vault");
  if (typeof j.value !== "string") throw new Error("Key Vault answered without a value");
  return j.value;
}

export interface RootSecretOptions {
  fetchFn?: StoreFetch;
  now?: () => Date;
  /** What holds each value read; holdSecretValue, which masks it in the job's log, by default. */
  hold?: (value: string) => void;
}

/**
 * `env`, a root's binary environment with its identity already set, with
 * each value `sources` gives `root` read from its store as that identity.
 * `env` itself when the root takes none. Throws a SecretError for the first
 * value that cannot be read.
 */
export async function rootSecretEnv(env: NodeJS.ProcessEnv, root: string, sources: readonly SecretSource[] | undefined, options: RootSecretOptions = {}): Promise<NodeJS.ProcessEnv> {
  const wanted = secretsOf(root, sources);
  if (wanted.length === 0) return env;
  const fetchFn = options.fetchFn ?? (fetch as unknown as StoreFetch);
  const now = options.now ?? (() => new Date());
  const hold = options.hold ?? ((v: string) => holdSecretValue(v, env));
  const out: NodeJS.ProcessEnv = { ...env };
  let aws: Promise<S3Credentials> | undefined;
  let gcp: Promise<string> | undefined;
  const azure = new Map<string, Promise<string>>();
  for (const s of wanted) {
    const { id, key } = splitPath(s.path);
    const identity = s.from === "aws" ? awsIdentity(root, env) : s.from === "gcp" ? gcpIdentity(root, env) : azureIdentity(env);
    let text: string;
    try {
      if (s.from === "aws") {
        const a = identity as ReturnType<typeof awsIdentity>;
        text = await readAws(id, env, await (aws ??= a.credentials(fetchFn)), fetchFn, now());
      } else if (s.from === "gcp") {
        const g = identity as ReturnType<typeof gcpIdentity>;
        text = await readGcp(id, await (gcp ??= g.token(fetchFn)), fetchFn);
      } else {
        const z = identity as ReturnType<typeof azureIdentity>;
        const v = vaultOf(id);
        if (!azure.has(v.scope)) azure.set(v.scope, z.token(v.scope, fetchFn));
        text = await readAzure(v.host, v.rest, await azure.get(v.scope)!, fetchFn);
      }
      const value = key === undefined ? text : keyOf(text, key);
      hold(value);
      if (key !== undefined) hold(text);
      out[s.name] = value;
    } catch (e) {
      throw new SecretError(`${s.name}: cannot read ${s.path} from ${s.from} as ${identity.name}: ${(e as Error).message}`);
    }
  }
  return out;
}
