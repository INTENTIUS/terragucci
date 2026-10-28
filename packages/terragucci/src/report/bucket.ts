/**
 * The client for a `reports` block: `reports.bucket`'s scheme picks the
 * store, and the job's environment gives the identity (s3.ts, gcs.ts,
 * azure-blob.ts say which variables each reads).
 *
 * Where the installed chant carries chant core's object store clients
 * (`@intentius/chant/object-store`, chant#4554), the store's reads, writes
 * and links go through chant's client, made by chant's `storeFromEnv` with
 * terragucci's setting names. The copies here stay as the fallback for a
 * chant without them (the 0.124.54 pin), and they still make the store
 * first, so a config or credential error is thrown when it is today, with
 * the same words.
 */
import { chantObjectStore } from "../chant-next";
import { AzureBlobClient, azureFromEnv } from "./azure-blob";
import { GcsClient, gcsFromEnv } from "./gcs";
import { parseReportsBucket, StoreError, type ObjectStore, type StoreFetch } from "./object-store";
import { S3Client, s3FromEnv } from "./s3";

/** The STS session name a report's role is assumed under when AWS_ROLE_SESSION_NAME is unset. */
const SESSION_NAME = "terragucci-report";

/** terragucci's own client for `reports`: the fallback, and the check that runs first. Exported for its tests. */
export function ownStore(reports: { bucket: string; endpoint?: string; role?: string }, env: NodeJS.ProcessEnv, fetchFn?: StoreFetch): ObjectStore {
  const b = parseReportsBucket(reports.bucket);
  if (b.kind !== "s3" && reports.role) throw new StoreError(`reports.role is an AWS role, and ${reports.bucket} is not an S3 bucket: the job writes it with its own oidc identity`);
  const endpoint = reports.endpoint?.replace(/\/+$/, "");
  if (b.kind === "gcs") return new GcsClient(gcsFromEnv({ bucket: b.bucket, ...(endpoint ? { endpoint } : {}) }, env), fetchFn);
  if (b.kind === "azure") return new AzureBlobClient(azureFromEnv({ account: b.account, container: b.container, ...(endpoint ? { endpoint } : {}) }, env), fetchFn);
  return new S3Client(s3FromEnv(reports, env), fetchFn);
}

export function storeFromEnv(reports: { bucket: string; endpoint?: string; role?: string }, env: NodeJS.ProcessEnv = process.env, fetchFn?: StoreFetch): ObjectStore {
  const own = ownStore(reports, env, fetchFn);
  let picked: Promise<ObjectStore> | undefined;
  const store = (): Promise<ObjectStore> =>
    (picked ??= chantObjectStore().then((chant) =>
      chant
        ? chant.storeFromEnv(
            {
              bucket: reports.bucket,
              ...(reports.endpoint ? { endpoint: reports.endpoint } : {}),
              ...(reports.role ? { role: reports.role } : {}),
              sessionName: SESSION_NAME,
              setting: "reports.bucket",
              roleSetting: "reports.role",
              // chant#4584: the setup errors name terragucci's keys, as terragucci's own messages do.
              hints: { oidc: "oidc", gcp: "oidc.gcp", azure: "oidc.azure" },
            },
            env,
            fetchFn,
          )
        : own,
    ));
  return {
    location: own.location,
    put: async (key, body, contentType, when) => (await store()).put(key, body, contentType, when),
    read: async (key) => (await store()).read(key),
    get: async (key) => (await store()).get(key),
    presign: async (key, seconds, now) => (await store()).presign(key, seconds, now),
  };
}
