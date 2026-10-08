/**
 * What the reports need from a bucket, on any of the three stores: S3 (and
 * S3-compatible ones, s3.ts), Google Cloud Storage's JSON API (gcs.ts) and
 * Azure Blob Storage (azure-blob.ts). `reports.bucket` names the store by its
 * scheme. bucket.ts makes the client from the config and the job's
 * environment.
 */

export type StoreFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** A store that sends no headers (or a test's fake) gets no conditional writes. */
  headers?: { get(name: string): string | null };
}>;

export class StoreError extends Error {}

/** A conditional write that lost: the object changed (412) or another write to it was in flight (409). */
export class StoreConflict extends StoreError {}

/** A condition on a write: the version the object must still have (an ETag, a generation), or `*` for "there is no object yet". */
export type StoreCondition = { ifMatch: string } | { ifNoneMatch: "*" };

export interface ObjectStore {
  /** `s3://<bucket>`, `gs://<bucket>` or `az://<account>/<container>`, for messages. */
  readonly location: string;
  /** Write an object; with `when`, only if it still holds, else StoreConflict. The answer carries the new version when the store sends one. */
  put(key: string, body: string | Uint8Array, contentType: string, when?: StoreCondition): Promise<{ etag?: string }>;
  /** The object's text and version, or no text when there is none. */
  read(key: string): Promise<{ body?: string; etag?: string }>;
  get(key: string): Promise<string | undefined>;
  /** A link that reads `key` for `seconds` (a presigned URL, a signed URL, a SAS), and when it stops working. */
  presign(key: string, seconds: number, now?: Date): Promise<{ url: string; expires: Date }>;
}

/** The longest a link lives: seven days, the limit of S3, GCS and a user delegation SAS alike. */
export const PRESIGN_MAX_SECONDS = 7 * 24 * 3600;

export type BucketRef = { kind: "s3"; bucket: string } | { kind: "gcs"; bucket: string } | { kind: "azure"; account: string; container: string };

/** `s3://<bucket>` or a bare bucket name, `gs://<bucket>`, or `az://<account>/<container>`. */
export function parseReportsBucket(url: string): BucketRef {
  const u = url.trim().replace(/\/+$/, "");
  let m = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,221}[a-z0-9])$/.exec(u);
  if (m) return { kind: "gcs", bucket: m[1] };
  m = /^az:\/\/([a-z0-9]{3,24})\/([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62})$/.exec(u);
  if (m) return { kind: "azure", account: m[1], container: m[2] };
  m = /^(?:s3:\/\/)?([^/:\s]+)$/.exec(u);
  if (m) return { kind: "s3", bucket: m[1] };
  throw new StoreError(`reports.bucket must be s3://<bucket>, gs://<bucket> or az://<account>/<container>, not ${url}`);
}

export const bucketUrl = (b: BucketRef): string => (b.kind === "azure" ? `az://${b.account}/${b.container}` : `${b.kind === "gcs" ? "gs" : "s3"}://${b.bucket}`);

/** A key as a URL path: each segment percent-encoded the strict way (RFC 3986), the slashes kept. */
export const encodePath = (key: string): string => key.split("/").map(encodeStrict).join("/");

export const encodeStrict = (v: string): string => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The first value of an XML element, unescaped. Enough for the small answers these stores send. */
export const xmlText = (xml: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
};

/** A time as the stores write it in a query: `2026-10-07T12:00:00Z`, no milliseconds. */
export const isoSeconds = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");
