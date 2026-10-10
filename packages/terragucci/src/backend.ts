/**
 * Where a root's state is, read from the backend the binary initialised:
 * `<root>/.terraform/terraform.tfstate` (or `$TF_DATA_DIR/terraform.tfstate`),
 * which `init` writes with the backend's type and its whole configuration,
 * whether the root's code, a `-backend-config` file or the job's flags
 * supplied it. Nothing here reads a state's contents.
 *
 * stateVersion answers what an apply left: the backend's id of that version
 * of the state, read from the object's metadata, never its body.
 *
 *   s3       the bucket's `x-amz-version-id`, from a HEAD
 *   gcs      the object's generation, kept when the bucket's object
 *            versioning is on
 *   azurerm  the blob's `x-ms-version-id` when the account keeps blob
 *            versions; else, when the backend takes snapshots
 *            (`snapshot = true`), a snapshot of the blob terragucci takes,
 *            whose time is its id
 *   local    keeps no versions
 *
 * A backend that keeps no history either (pg, kubernetes, consul, and an
 * http backend other than GitLab's) is recorded `off`, with why. Any other
 * backend keeps versions terragucci does not read (remote, GitLab's http),
 * and is recorded by type with versioning `unknown`.
 *
 * stateStore opens the state where it is, for what reads or writes it there
 * (./export.ts, ./unlock.ts, ./migrate.ts): its versions, and its lock. Each
 * backend locks its own way: s3's `use_lockfile` and gcs write a lock object
 * beside the state (`<key>.tflock`, `<prefix>/<workspace>.tflock`), and
 * azurerm takes a lease on the state blob, with the lock info in its
 * metadata.
 *
 * Requests are signed with the credentials the backend would use: those its
 * configuration names, else the job's own (the variables report/s3.ts,
 * report/gcs.ts and report/azure-blob.ts read). A backend that assumes an
 * identity of its own may answer 403 to the job's: the version is then
 * recorded as unknown, with the reason, and the apply is never failed for it.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { AZURE_AUTHORITY, AzureBlobClient, type AzureOidc, type AzureTarget, type BlobAt } from "./report/azure-blob";
import { GCS_ENDPOINT, GcsClient, type GcsTarget } from "./report/gcs";
import { StoreError, type StoreFetch } from "./report/object-store";
import { S3Client, s3FromEnv, type S3Fetch, type S3Target } from "./report/s3";
import type { ReportStateVersion } from "./report/schema";
import { literal, stateAddress } from "./state-address";

/** The backend `init` recorded: its type and configuration. */
export interface InitialisedBackend {
  type: string;
  config: Record<string, unknown>;
}

/** A state in an S3 bucket. */
export interface S3State {
  backend: "s3";
  bucket: string;
  key: string;
  region: string;
  endpoint?: string;
  lockfile: boolean;
  dynamodb: boolean;
  target: S3Target;
}

/** A state in a GCS bucket: `<prefix>/<workspace>.tfstate`, locked by `<prefix>/<workspace>.tflock`. */
export interface GcsState {
  backend: "gcs";
  bucket: string;
  key: string;
  lock: string;
  target: GcsTarget;
}

/** How a request to Azure Blob Storage is authorized: an account key, a SAS, or the job's OIDC identity. */
export type AzureAuth = { accountKey: string } | { sas: string } | { oidc: AzureOidc };

/** A state blob in an Azure storage container, locked by a lease on it. */
export interface AzureState {
  backend: "azurerm";
  account: string;
  container: string;
  key: string;
  /** The backend snapshots the blob before each write (`snapshot = true`). */
  snapshot: boolean;
  /** The account's blob endpoint, when the configuration gives it without a metadata lookup. */
  endpoint?: string;
  /** The host of the cloud's metadata (`metadata_host`), which names the storage suffix. */
  metadataHost?: string;
  auth: AzureAuth;
}

/** Where a root's state lives. */
export type StateObject =
  | S3State
  | GcsState
  | AzureState
  | { backend: "local"; path: string }
  | { backend: string; unsupported: string; location?: string; versions?: { versioning: "off" | "unknown"; note: string } };

/** A state in a bucket or a container: one terragucci reads and locks itself. */
export type StoredState = S3State | GcsState | AzureState;

/** Whether the state is one terragucci reads where it is: s3, gcs or azurerm. */
export const isStored = (o: StateObject): o is StoredState => !("unsupported" in o) && (o.backend === "s3" || o.backend === "gcs" || o.backend === "azurerm");

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * Why a backend keeps no history, for the types that keep none: each write
 * replaces the state in place. GitLab's http backend keeps each version by
 * serial, so an http backend is in this list only when its address is not
 * GitLab's state API.
 */
const NO_HISTORY: Record<string, string> = {
  pg: "a pg backend keeps one row per workspace, which each write replaces",
  kubernetes: "a kubernetes backend keeps one Secret per workspace, which each write replaces",
  consul: "a consul backend keeps one key per workspace, which each write replaces",
  http: "an http backend keeps what its server holds at the address and names no versions",
};

/** GitLab's state API: `/api/v4/projects/<id>/terraform/state/<name>`. */
const GITLAB_STATE = /\/api\/v4\/projects\/[^/]+\/terraform\/state\//;

/** Whether the backend keeps no history of the state: false for one that keeps none, undefined when it may keep some. */
export function keepsHistory(b: InitialisedBackend): false | undefined {
  if (!(b.type in NO_HISTORY)) return undefined;
  if (b.type === "http" && GITLAB_STATE.test(str(b.config.address) ?? "")) return undefined;
  return false;
}

/** The state's address (./state-address.ts) from the configuration init recorded, credentials left out. */
function initAddress(b: InitialisedBackend): string | undefined {
  const workspaces = Array.isArray(b.config.workspaces) ? b.config.workspaces[0] : b.config.workspaces;
  const get = (n: string): string | null | undefined => literal(b.config[n] ?? (workspaces && typeof workspaces === "object" ? (workspaces as Record<string, unknown>)[n] : undefined));
  const a = stateAddress(b.type, get, "");
  return "key" in a ? a.key : undefined;
}

/** The root's data dir: `TF_DATA_DIR` (relative to the root, as the binary run with `-chdir` reads it), else `.terraform`. */
export function dataDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const d = env.TF_DATA_DIR;
  if (!d) return join(dir, ".terraform");
  return isAbsolute(d) ? d : join(dir, d);
}

/** The backend `init` recorded for the root, or undefined when it has not been initialised with one. */
export function initialisedBackend(dir: string, env: NodeJS.ProcessEnv = process.env): InitialisedBackend | undefined {
  const file = join(dataDir(dir, env), "terraform.tfstate");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { backend?: { type?: unknown; config?: unknown } };
    const type = str(parsed.backend?.type);
    if (!type) return undefined;
    const config = parsed.backend?.config && typeof parsed.backend.config === "object" ? (parsed.backend.config as Record<string, unknown>) : {};
    return { type, config };
  } catch {
    return undefined;
  }
}

/**
 * The file a root names its Terraform workspace in. terragucci writes it in
 * each Atmos instance's directory (./atmos.ts), and the stages run the binary
 * there with `TF_WORKSPACE` set to it.
 */
export const WORKSPACE_FILE = ".terragucci-workspace";

/** The workspace the root at `dir` names in its WORKSPACE_FILE, or undefined. */
export function rootWorkspace(dir: string): string | undefined {
  const file = join(dir, WORKSPACE_FILE);
  if (!existsSync(file)) return undefined;
  const ws = readFileSync(file, "utf-8").trim();
  return ws || undefined;
}

/** `env` with `TF_WORKSPACE` set to the workspace the root at `dir` names; `env` as it is when it names none. */
export function workspaceEnv(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const ws = rootWorkspace(dir);
  return ws ? { ...env, TF_WORKSPACE: ws } : env;
}

/**
 * How a root that names its workspace is initialised: `init` in `default`,
 * which every backend has, then `workspace select -or-create` of its own,
 * since `init` refuses a selected workspace the backend does not list yet.
 * The binary runs the select with `TF_WORKSPACE` unset, which would override
 * it. Undefined for a root that names none.
 */
export function workspaceInit(env: NodeJS.ProcessEnv, dir: string): { init: NodeJS.ProcessEnv; select: string[]; selectEnv: NodeJS.ProcessEnv } | undefined {
  const ws = rootWorkspace(dir);
  if (!ws) return undefined;
  const { TF_WORKSPACE: _w, ...selectEnv } = env;
  return { init: { ...env, TF_WORKSPACE: "default" }, select: ["workspace", "select", "-or-create=true", ws], selectEnv };
}

/** The workspace the binary runs in: `TF_WORKSPACE`, else the one `workspace select` recorded, else `default`. */
export function workspaceOf(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TF_WORKSPACE) return env.TF_WORKSPACE;
  const file = join(dataDir(dir, env), "environment");
  if (existsSync(file)) {
    const ws = readFileSync(file, "utf-8").trim();
    if (ws) return ws;
  }
  return "default";
}

/** The S3 key of a workspace's state, as the S3 backend names it: the key in `default`, else `<workspace_key_prefix>/<workspace>/<key>`. */
export function s3StateKey(key: string, workspace: string, prefix = "env:"): string {
  return workspace === "default" ? key : `${prefix}/${workspace}/${key}`;
}

/** Where the root's state is, from the backend `init` recorded. No backend recorded reads as a local one. */
export function stateObject(dir: string, env: NodeJS.ProcessEnv = process.env, backend: InitialisedBackend | undefined = initialisedBackend(dir, env)): StateObject {
  const ws = workspaceOf(dir, env);
  if (!backend || backend.type === "local") {
    const c = backend?.config ?? {};
    const path = ws === "default" ? (str(c.path) ?? "terraform.tfstate") : join(str(c.workspace_dir) ?? "terraform.tfstate.d", ws, "terraform.tfstate");
    return { backend: "local", path };
  }
  if (backend.type === "gcs") return gcsObject(backend.config, ws, env);
  if (backend.type === "azurerm") return azureObject(backend.config, ws, env);
  if (backend.type !== "s3") {
    const location = initAddress(backend);
    const at = location ? { location } : {};
    const unsupported = `terragucci reads state versions from s3, gcs, azurerm and local backends, and this root's backend is ${backend.type}`;
    if (keepsHistory(backend) === false) return { backend: backend.type, unsupported, ...at, versions: { versioning: "off", note: NO_HISTORY[backend.type] } };
    const kept = backend.type === "http" ? "GitLab keeps each version of the state by serial" : `a ${backend.type} backend can keep versions of the state`;
    return { backend: backend.type, unsupported, ...at, versions: { versioning: "unknown", note: `${kept}, which terragucci does not read` } };
  }
  const c = backend.config;
  const bucket = str(c.bucket);
  const key = str(c.key);
  if (!bucket || !key) return { backend: "s3", unsupported: "the s3 backend's bucket or key is not in the configuration init recorded" };
  const endpoints = c.endpoints && typeof c.endpoints === "object" ? (c.endpoints as Record<string, unknown>) : {};
  const endpoint = str(endpoints.s3) ?? str(c.endpoint) ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
  const region = str(c.region) ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
  const access = str(c.access_key);
  const secret = str(c.secret_key);
  const jobEnv = { ...env, AWS_REGION: region, ...(access && secret ? { AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: str(c.token) ?? "" } : {}) };
  let target: S3Target;
  try {
    target = s3FromEnv({ bucket, ...(endpoint ? { endpoint } : {}) }, jobEnv);
  } catch (e) {
    return { backend: "s3", unsupported: `the job has no credentials to read s3://${bucket}: ${(e as Error).message}` };
  }
  return {
    backend: "s3",
    bucket,
    key: s3StateKey(key, ws, str(c.workspace_key_prefix)),
    region,
    ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}),
    lockfile: c.use_lockfile === true,
    dynamodb: str(c.dynamodb_table) !== undefined,
    target,
  };
}

/** A gcs backend's custom endpoint (`storage_custom_endpoint`, `https://host/storage/v1/`) as the JSON API's address: no path, no trailing slash. */
const gcsEndpoint = (e: string): string => e.replace(/\/+$/, "").replace(/\/storage\/v1$/, "");

/**
 * A gcs backend's state: `<prefix>/<workspace>.tfstate` and its lock beside
 * it, with the credentials the backend would use, first match wins:
 * `access_token` (or GOOGLE_OAUTH_ACCESS_TOKEN), `credentials` (a file or its
 * JSON), GOOGLE_BACKEND_CREDENTIALS, GOOGLE_CREDENTIALS, and
 * GOOGLE_APPLICATION_CREDENTIALS, which a job with `oidc.gcp` sets.
 */
function gcsObject(c: Record<string, unknown>, ws: string, env: NodeJS.ProcessEnv): StateObject {
  const bucket = str(c.bucket);
  if (!bucket) return { backend: "gcs", unsupported: "the gcs backend's bucket is not in the configuration init recorded" };
  const raw = str(c.prefix) ?? "";
  const prefix = raw === "" || raw.endsWith("/") ? raw : `${raw}/`;
  const key = `${prefix}${ws}.tfstate`;
  const endpoint = gcsEndpoint(str(c.storage_custom_endpoint) ?? env.GOOGLE_BACKEND_STORAGE_CUSTOM_ENDPOINT ?? env.GOOGLE_STORAGE_CUSTOM_ENDPOINT ?? GCS_ENDPOINT);
  const impersonate = str(c.impersonate_service_account) ?? env.GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT ?? env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
  const where = { bucket, endpoint, ...(impersonate ? { impersonate } : {}) };
  const token = str(c.access_token) ?? env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const creds = str(c.credentials) ?? env.GOOGLE_BACKEND_CREDENTIALS ?? env.GOOGLE_CREDENTIALS;
  let target: GcsTarget;
  if (token) target = { ...where, accessToken: token };
  else if (creds) target = creds.trim().startsWith("{") ? { ...where, credentialsJson: creds } : { ...where, credentialsFile: creds };
  else if (env.GOOGLE_APPLICATION_CREDENTIALS) target = { ...where, credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS };
  else return { backend: "gcs", unsupported: `the job has no credentials to read gs://${bucket}: give the job oidc.gcp (it sets GOOGLE_APPLICATION_CREDENTIALS), or set GOOGLE_CREDENTIALS or GOOGLE_OAUTH_ACCESS_TOKEN` };
  return { backend: "gcs", bucket, key, lock: `${prefix}${ws}.tflock`, target };
}

/** Each Azure cloud's storage suffix and Entra ID, by the azurerm backend's `environment`. */
const CLOUD_ENDPOINTS: Record<string, { storage: string; authority: string }> = {
  public: { storage: "core.windows.net", authority: AZURE_AUTHORITY },
  china: { storage: "core.chinacloudapi.cn", authority: "https://login.chinacloudapi.cn" },
  usgovernment: { storage: "core.usgovcloudapi.net", authority: "https://login.microsoftonline.us" },
};

/**
 * An azurerm backend's state: the blob `key` in `container_name` of
 * `storage_account_name`, `<key>env:<workspace>` in another workspace, with
 * the credentials the backend would use: `access_key` (ARM_ACCESS_KEY),
 * `sas_token` (ARM_SAS_TOKEN), else the job's OIDC identity (the ARM_*
 * variables a job with `oidc.azure` sets), which reads blobs with Entra ID.
 */
function azureObject(c: Record<string, unknown>, ws: string, env: NodeJS.ProcessEnv): StateObject {
  const account = str(c.storage_account_name);
  const container = str(c.container_name);
  const base = str(c.key);
  if (!account || !container || !base) return { backend: "azurerm", unsupported: "the azurerm backend's storage_account_name, container_name or key is not in the configuration init recorded" };
  const key = ws === "default" ? base : `${base}env:${ws}`;
  const cloud = CLOUD_ENDPOINTS[str(c.environment) ?? env.ARM_ENVIRONMENT ?? "public"];
  const metadataHost = str(c.metadata_host) ?? env.ARM_METADATA_HOSTNAME ?? env.ARM_METADATA_HOST;
  if (!cloud && !metadataHost) return { backend: "azurerm", unsupported: `the azurerm backend's environment ${str(c.environment) ?? env.ARM_ENVIRONMENT} is not public, china or usgovernment, and it names no metadata_host` };
  const accessKey = str(c.access_key) ?? env.ARM_ACCESS_KEY;
  const sas = str(c.sas_token) ?? env.ARM_SAS_TOKEN;
  const tenantId = str(c.tenant_id) ?? env.ARM_TENANT_ID;
  const clientId = str(c.client_id) ?? env.ARM_CLIENT_ID;
  const tokenFile = str(c.oidc_token_file_path) ?? env.ARM_OIDC_TOKEN_FILE_PATH;
  let auth: AzureAuth;
  if (accessKey) auth = { accountKey: accessKey };
  else if (sas) auth = { sas };
  else if (tenantId && clientId && tokenFile) auth = { oidc: { tenantId, clientId, tokenFile, authority: (env.AZURE_AUTHORITY_HOST || cloud?.authority || AZURE_AUTHORITY).replace(/\/+$/, "") } };
  else return { backend: "azurerm", unsupported: `the job has no credentials to read the container ${container} of ${account}: give the job oidc.azure (it sets ARM_TENANT_ID, ARM_CLIENT_ID and ARM_OIDC_TOKEN_FILE_PATH), or set ARM_ACCESS_KEY` };
  return {
    backend: "azurerm",
    account,
    container,
    key,
    snapshot: c.snapshot === true || env.ARM_SNAPSHOT === "true",
    ...(metadataHost ? { metadataHost } : { endpoint: `https://${account}.blob.${cloud!.storage}` }),
    auth,
  };
}

/** `s3://<bucket>/<key>`, `gs://<bucket>/<key>`, `az://<account>/<container>/<key>`, or the local file's path. */
export function stateLocation(o: StateObject): string | undefined {
  if ("unsupported" in o) return undefined;
  if (o.backend === "local") return (o as { path: string }).path;
  const s = o as StoredState;
  if (s.backend === "gcs") return `gs://${s.bucket}/${s.key}`;
  if (s.backend === "azurerm") return `az://${s.account}/${s.container}/${s.key}`;
  return `s3://${s.bucket}/${s.key}`;
}

/** The S3 client for a state object. */
export function stateClient(o: S3State, fetchFn?: S3Fetch): S3Client {
  return new S3Client(o.target, fetchFn);
}

/** The lock a state's backend holds: the ID `force-unlock` takes, and the lock info the binary wrote. */
export interface HeldLock {
  id: string;
  /** The lock info as the binary wrote it, JSON. */
  info: string;
}

/** A version of the state the store holds now. */
export interface StoreVersion {
  /** Whether there is a state at all. */
  exists: boolean;
  /** Its id, when the store keeps it and can give it back later. */
  versionId?: string;
  /** Why the store keeps no version of it, when it keeps none. */
  off?: string;
}

/** A state where it is, for what reads or writes it there. */
export interface StateStore {
  readonly backend: StoredState["backend"];
  /** Where the state is. */
  readonly location: string;
  /** Where its lock is: the lock object, or the blob whose lease is the lock. */
  readonly lockLocation: string;
  /**
   * The version the store holds now. With `pin`, an azurerm backend that
   * keeps snapshots and no versions gets a snapshot, whose id names it; the
   * others read the version they keep anyway.
   */
  version(pin?: boolean): Promise<StoreVersion>;
  /** Whether the store holds that version. */
  hasVersion(id: string): Promise<boolean>;
  /** That version's text, or undefined when the store holds no such version. */
  readVersion(id: string): Promise<string | undefined>;
  /** Whether the state is still the version `id` names. */
  isAt(id: string): Promise<boolean>;
  /** The lock the backend holds now, or undefined. */
  heldLock(): Promise<HeldLock | undefined>;
  /** Take the state's lock with `info`, the way the backend takes it: false when it is held. */
  lock(info: string): Promise<boolean>;
  /** Release the lock `lock` took. */
  unlock(): Promise<void>;
  /**
   * Write a new state under the lock `lock` took, for a backend whose lock
   * keeps the binary from writing (azurerm's lease); undefined for a backend
   * the binary writes with `-lock=false` while terragucci holds the lock.
   */
  write?: (body: string) => Promise<void>;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The S3 state, locked by the lock file `use_lockfile` takes. */
function s3Store(o: S3State, fetchFn?: S3Fetch): StateStore {
  const client = stateClient(o, fetchFn);
  const lockKey = `${o.key}.tflock`;
  const version = async (): Promise<StoreVersion> => {
    const head = await client.head(o.key);
    if (!head.exists) return { exists: false };
    return head.versionId ? { exists: true, versionId: head.versionId } : { exists: true, off: `bucket versioning is off for ${o.bucket}, so it keeps only the latest state` };
  };
  return {
    backend: "s3",
    location: `s3://${o.bucket}/${o.key}`,
    lockLocation: `s3://${o.bucket}/${lockKey}`,
    version,
    hasVersion: (id) => client.hasVersion(o.key, id),
    readVersion: (id) => client.readVersion(o.key, id),
    isAt: async (id) => (await version()).versionId === id,
    heldLock: async () => {
      const text = await client.get(lockKey);
      if (text === undefined) return undefined;
      return { id: lockId(text), info: text };
    },
    lock: (info) => client.putIfAbsent(lockKey, info, "application/json"),
    unlock: () => client.remove(lockKey),
  };
}

/** The ID in a lock info's JSON, or "" when it names none. */
function lockId(text: string): string {
  try {
    const v = JSON.parse(text) as { ID?: unknown };
    return typeof v.ID === "string" ? v.ID : "";
  } catch {
    return "";
  }
}

/**
 * The GCS state. Its lock is `<prefix>/<workspace>.tflock`, and the ID the
 * binary gives a lock, the one `force-unlock` takes, is that object's
 * generation, not the ID in its text.
 */
function gcsStore(o: GcsState, fetchFn?: StoreFetch): StateStore {
  const client = new GcsClient(o.target, fetchFn);
  let versioning: Promise<boolean | undefined> | undefined;
  const version = async (): Promise<StoreVersion> => {
    const head = await client.head(o.key);
    if (!head.exists) return { exists: false };
    versioning ??= client.versioning();
    if ((await versioning) === false) return { exists: true, off: `object versioning is off for ${o.bucket}, so it keeps only the latest state` };
    return { exists: true, ...(head.generation ? { versionId: head.generation } : {}) };
  };
  return {
    backend: "gcs",
    location: `gs://${o.bucket}/${o.key}`,
    lockLocation: `gs://${o.bucket}/${o.lock}`,
    version,
    hasVersion: async (id) => (await client.head(o.key, id)).exists,
    readVersion: (id) => client.readGeneration(o.key, id),
    isAt: async (id) => (await client.head(o.key)).generation === id,
    heldLock: async () => {
      const head = await client.head(o.lock);
      const info = head.exists ? await client.get(o.lock) : undefined;
      if (!head.exists || info === undefined) return undefined;
      return { id: head.generation ?? lockId(info), info };
    },
    lock: (info) => client.putIfAbsent(o.lock, info, "application/json"),
    unlock: () => client.remove(o.lock),
  };
}

/** The metadata an azurerm backend keeps a lock's info in, base64 JSON, on the leased blob. */
export const LOCK_METADATA = "terraformlockid";

/**
 * The account's blob endpoint: the configuration's, or `https://<account>.blob.<suffix>`
 * with the storage suffix the cloud's metadata at `metadata_host` names.
 */
async function azureEndpoint(o: AzureState, fetchFn: StoreFetch): Promise<string> {
  if (o.endpoint) return o.endpoint;
  const url = `https://${o.metadataHost}/metadata/endpoints?api-version=2023-11-01`;
  const res = await fetchFn(url, { method: "GET", headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) throw new StoreError(`the Azure metadata at ${o.metadataHost}: ${res.status}`);
  let suffix: unknown;
  try {
    const j = JSON.parse(text) as { suffixes?: { storage?: unknown } } | { suffixes?: { storage?: unknown } }[];
    suffix = (Array.isArray(j) ? j[0] : j)?.suffixes?.storage;
  } catch {
    // Reported below.
  }
  if (typeof suffix !== "string" || suffix === "") throw new StoreError(`the Azure metadata at ${o.metadataHost} names no storage suffix`);
  return `https://${o.account}.blob.${suffix.replace(/^\.+/, "")}`;
}

/**
 * The azurerm state blob. Its lock is a lease on the blob, with the lock
 * info base64 in its `terraformlockid` metadata, and the lock's ID is the
 * lease's. A version is the blob's version id when the account keeps blob
 * versions, else a snapshot, when the backend takes them.
 */
async function azureStore(o: AzureState, fetchFn: StoreFetch = fetch as unknown as StoreFetch): Promise<StateStore> {
  const endpoint = await azureEndpoint(o, fetchFn);
  const client = new AzureBlobClient({ account: o.account, container: o.container, endpoint, ...o.auth } as AzureTarget, fetchFn);
  let leaseId: string | undefined;
  /** Whether the blob's versions are named by version ids (else by snapshots), from the blob now. */
  const atOf = async (id: string): Promise<BlobAt> => ((await client.head(o.key)).versionId ? { versionid: id } : { snapshot: id });
  const version = async (pin = false): Promise<StoreVersion> => {
    const head = await client.head(o.key);
    if (!head.exists) return { exists: false };
    if (head.versionId) return { exists: true, versionId: head.versionId };
    if (!o.snapshot) return { exists: true, off: `blob versioning is off for ${o.account}, and the backend takes no snapshots (snapshot = true), so it keeps only the latest state` };
    return pin ? { exists: true, versionId: await client.snapshot(o.key) } : { exists: true };
  };
  return {
    backend: "azurerm",
    location: `az://${o.account}/${o.container}/${o.key}`,
    lockLocation: `az://${o.account}/${o.container}/${o.key}`,
    version,
    hasVersion: async (id) => (await client.head(o.key, await atOf(id))).exists,
    readVersion: async (id) => client.readAt(o.key, await atOf(id)),
    isAt: async (id) => {
      const head = await client.head(o.key);
      if (head.versionId) return head.versionId === id;
      const [then, now] = await Promise.all([client.readAt(o.key, { snapshot: id }), client.get(o.key)]);
      return then !== undefined && now !== undefined && sha(then) === sha(now);
    },
    heldLock: async () => {
      const head = await client.head(o.key);
      if (!head.exists || head.leaseState !== "leased") return undefined;
      const meta = head.metadata[LOCK_METADATA];
      const info = meta ? Buffer.from(meta, "base64").toString("utf-8") : "";
      return { id: lockId(info), info };
    },
    lock: async (info) => {
      const id = lockId(info);
      // The backend leases a blob that is there: a state with none yet gets an empty one first, as the backend makes it.
      if (!(await client.head(o.key)).exists) await client.putBlob(o.key, "", "application/json", { ifNoneMatch: true });
      if (!(await client.lease(o.key, "acquire", id))) return false;
      leaseId = id;
      await client.setMetadata(o.key, { [LOCK_METADATA]: Buffer.from(info).toString("base64") }, id);
      return true;
    },
    unlock: async () => {
      if (!leaseId) return;
      const id = leaseId;
      await client.setMetadata(o.key, {}, id);
      await client.lease(o.key, "release", id);
      leaseId = undefined;
    },
    write: async (body) => {
      if (!leaseId) throw new StoreError(`${o.key} is written under its lease, and none is held`);
      // As the backend writes it: a snapshot first when it takes snapshots, and the lock info kept on the blob.
      if (o.snapshot && (await client.head(o.key)).exists) await client.snapshot(o.key);
      const meta = (await client.head(o.key)).metadata;
      await client.putBlob(o.key, body, "application/json", { leaseId, metadata: meta });
    },
  };
}

/** The store a state is in, opened with the credentials stateObject chose. */
export async function stateStore(o: StoredState, fetchFn?: StoreFetch): Promise<StateStore> {
  if (o.backend === "s3") return s3Store(o, fetchFn);
  if (o.backend === "gcs") return gcsStore(o, fetchFn);
  return azureStore(o, fetchFn);
}

/**
 * The state version a root's backend holds now, from the object's metadata.
 * `backend` stands in for the one `init` recorded: a Terragrunt unit's, from
 * its evaluated `remote_state` block. An azurerm backend that keeps snapshots
 * and no versions gets a snapshot of the blob, whose time names the version.
 * Never throws: a version that cannot be read is `unknown`, with why.
 */
export async function stateVersion(dir: string, env: NodeJS.ProcessEnv = process.env, fetchFn?: StoreFetch, backend?: InitialisedBackend): Promise<ReportStateVersion> {
  const o = backend ? stateObject(dir, env, backend) : stateObject(dir, env);
  if ("unsupported" in o) return { backend: o.backend, ...(o.location ? { location: o.location } : {}), versioning: o.versions?.versioning ?? "unknown", note: o.versions?.note ?? o.unsupported };
  if (!isStored(o)) return { backend: "local", location: (o as { path: string }).path, versioning: "off", note: "a local backend keeps only the latest state" };
  const location = stateLocation(o)!;
  try {
    const v = await (await stateStore(o, fetchFn)).version(true);
    if (!v.exists) return { backend: o.backend, location, versioning: "unknown", note: `the state object is not in the ${o.backend === "azurerm" ? "container" : "bucket"}` };
    if (v.versionId) return { backend: o.backend, location, version_id: v.versionId, versioning: "on" };
    if (v.off) return { backend: o.backend, location, versioning: "off", note: v.off };
    return { backend: o.backend, location, versioning: "unknown", note: "the store gave no version id" };
  } catch (e) {
    return { backend: o.backend, location, versioning: "unknown", note: (e as Error).message };
  }
}
