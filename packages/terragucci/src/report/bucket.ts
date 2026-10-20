/**
 * The client for a `reports` block: `reports.bucket`'s scheme picks the
 * store, and the job's environment gives the identity (s3.ts, gcs.ts,
 * azure-blob.ts say which variables each reads).
 */
import { AzureBlobClient, azureFromEnv } from "./azure-blob";
import { GcsClient, gcsFromEnv } from "./gcs";
import { parseReportsBucket, StoreError, type ObjectStore, type StoreFetch } from "./object-store";
import { S3Client, s3FromEnv } from "./s3";

export function storeFromEnv(reports: { bucket: string; endpoint?: string; role?: string }, env: NodeJS.ProcessEnv = process.env, fetchFn?: StoreFetch): ObjectStore {
  const b = parseReportsBucket(reports.bucket);
  if (b.kind !== "s3" && reports.role) throw new StoreError(`reports.role is an AWS role, and ${reports.bucket} is not an S3 bucket: the job writes it with its own oidc identity`);
  const endpoint = reports.endpoint?.replace(/\/+$/, "");
  if (b.kind === "gcs") return new GcsClient(gcsFromEnv({ bucket: b.bucket, ...(endpoint ? { endpoint } : {}) }, env), fetchFn);
  if (b.kind === "azure") return new AzureBlobClient(azureFromEnv({ account: b.account, container: b.container, ...(endpoint ? { endpoint } : {}) }, env), fetchFn);
  return new S3Client(s3FromEnv(reports, env), fetchFn);
}
