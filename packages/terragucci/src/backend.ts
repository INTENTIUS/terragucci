/**
 * Where a root's state is, read from the backend the binary initialised:
 * `<root>/.terraform/terraform.tfstate` (or `$TF_DATA_DIR/terraform.tfstate`),
 * which `init` writes with the backend's type and its whole configuration,
 * whether the root's code, a `-backend-config` file or the job's flags
 * supplied it. Nothing here reads a state's contents.
 *
 * stateVersion answers what an apply left: the backend's version id of the
 * state object, read from the object's metadata (an S3 HEAD). It reads S3
 * and S3-compatible stores, where the version id is the bucket's
 * `x-amz-version-id`, and a local backend, which keeps no versions. Any
 * other backend is recorded by type with versioning `unknown`.
 *
 * The S3 request is signed with the job's own credentials (the variables
 * report/s3.ts reads) unless the backend's configuration names static keys.
 * A backend that assumes a role of its own may answer 403 to the job's
 * identity: the version is then recorded as unknown, with the reason, and
 * the apply is never failed for it.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { S3Client, s3FromEnv, type S3Fetch, type S3Target } from "./report/s3";
import type { ReportStateVersion } from "./report/schema";

/** The backend `init` recorded: its type and configuration. */
export interface InitialisedBackend {
  type: string;
  config: Record<string, unknown>;
}

/** Where a root's state lives. */
export type StateObject =
  | { backend: "s3"; bucket: string; key: string; region: string; endpoint?: string; lockfile: boolean; dynamodb: boolean; target: S3Target }
  | { backend: "local"; path: string }
  | { backend: string; unsupported: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

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

/** `env` with `TF_WORKSPACE` set to the workspace the root at `dir` names in its WORKSPACE_FILE; `env` as it is when it names none. */
export function workspaceEnv(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const file = join(dir, WORKSPACE_FILE);
  if (!existsSync(file)) return env;
  const ws = readFileSync(file, "utf-8").trim();
  return ws ? { ...env, TF_WORKSPACE: ws } : env;
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
  if (backend.type !== "s3") return { backend: backend.type, unsupported: `terragucci reads state versions from s3 and local backends, and this root's backend is ${backend.type}` };
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

/** `s3://<bucket>/<key>`, or the local file's path. */
export function stateLocation(o: StateObject): string | undefined {
  if ("unsupported" in o) return undefined;
  return o.backend === "s3" && "bucket" in o ? `s3://${o.bucket}/${o.key}` : "path" in o ? o.path : undefined;
}

/** The S3 client for a state object. */
export function stateClient(o: Extract<StateObject, { target: S3Target }>, fetchFn?: S3Fetch): S3Client {
  return new S3Client(o.target, fetchFn);
}

/**
 * The state version a root's backend holds now, from the object's metadata.
 * `backend` stands in for the one `init` recorded: a Terragrunt unit's, from
 * its evaluated `remote_state` block. Never throws: a version that cannot be read is `unknown`, with why.
 */
export async function stateVersion(dir: string, env: NodeJS.ProcessEnv = process.env, fetchFn?: S3Fetch, backend?: InitialisedBackend): Promise<ReportStateVersion> {
  const o = backend ? stateObject(dir, env, backend) : stateObject(dir, env);
  if ("unsupported" in o) return { backend: o.backend, versioning: "unknown", note: o.unsupported };
  if (o.backend === "local") return { backend: "local", location: (o as { path: string }).path, versioning: "off", note: "a local backend keeps only the latest state" };
  const s3 = o as Extract<StateObject, { target: S3Target }>;
  const location = `s3://${s3.bucket}/${s3.key}`;
  try {
    const head = await stateClient(s3, fetchFn).head(s3.key);
    if (!head.exists) return { backend: "s3", location, versioning: "unknown", note: "the state object is not in the bucket" };
    if (head.versionId) return { backend: "s3", location, version_id: head.versionId, versioning: "on" };
    return { backend: "s3", location, versioning: "off", note: `bucket versioning is off for ${s3.bucket}, so it keeps only the latest state` };
  } catch (e) {
    return { backend: "s3", location, versioning: "unknown", note: (e as Error).message };
  }
}
