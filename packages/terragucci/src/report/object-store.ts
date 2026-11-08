/**
 * `reports.bucket`, as terragucci's config names it. The stores' clients are
 * chant's (`@intentius/chant/object-store`, chant#4554): S3 and S3-compatible
 * stores, Google Cloud Storage and Azure Blob Storage.
 */
import { parseBucketUrl, type BucketRef } from "@intentius/chant/object-store";

/** `s3://<bucket>` or a bare bucket name, `gs://<bucket>`, or `az://<account>/<container>`. */
export function parseReportsBucket(url: string): BucketRef {
  return parseBucketUrl(url, "reports.bucket");
}

/**
 * terragucci's words in chant's store messages and its STS session name,
 * for each `s3FromEnv`, `gcsFromEnv` and `azureFromEnv` call.
 */
export const STORE_WORDS = {
  setting: "reports.bucket",
  roleSetting: "reports.role",
  sessionName: "terragucci-report",
  // chant#4584: the setup errors name terragucci's keys.
  hints: { oidc: "oidc", gcp: "oidc.gcp", azure: "oidc.azure" },
} as const;
