/**
 * The little of S3 the report needs: put an object and get one, signed with
 * AWS Signature Version 4 from `node:crypto`. Any S3-compatible store
 * answers it: S3, R2, Google Cloud Storage's interoperability API, MinIO.
 * `fetch` is injectable so the signing is tested against recorded requests.
 */
import { createHash, createHmac } from "node:crypto";

export type S3Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface S3Target {
  bucket: string;
  /** https://host[:port], no path. Default: AWS's regional endpoint. */
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export class S3Error extends Error {}

/** `s3://bucket` or a bare bucket name. */
export function parseBucket(url: string): string {
  const m = /^(?:s3:\/\/)?([^/]+)\/?$/.exec(url.trim());
  if (!m) throw new S3Error(`reports.bucket must be s3://<bucket>, not ${url}`);
  return m[1];
}

/** The target from a config's `reports` and the AWS environment variables. */
export function s3FromEnv(reports: { bucket: string; endpoint?: string }, env: NodeJS.ProcessEnv = process.env): S3Target {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new S3Error("reports.bucket is set, but AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not");
  const endpoint = reports.endpoint ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
  return {
    bucket: parseBucket(reports.bucket),
    ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}),
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  };
}

const sha256 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const hmac = (key: string | Buffer, s: string): Buffer => createHmac("sha256", key).update(s).digest();
const encodeKey = (key: string): string => key.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

/** The URL and signed headers for one request. A custom endpoint is addressed path-style, AWS virtual-hosted. */
export function signRequest(t: S3Target, method: string, key: string, body: string | Uint8Array, now = new Date(), contentType?: string): { url: string; headers: Record<string, string> } {
  const base = t.endpoint ? `${t.endpoint}/${t.bucket}` : `https://${t.bucket}.s3.${t.region}.amazonaws.com`;
  const url = `${base}/${encodeKey(key)}`;
  return { url, headers: sign(t, method, url, contentType ? { "content-type": contentType } : {}, sha256(body), now) };
}

/** Signature Version 4 headers for a request with no query string. `headers` are signed too. */
export function sign(t: Pick<S3Target, "region" | "accessKeyId" | "secretAccessKey" | "sessionToken">, method: string, rawUrl: string, extra: Record<string, string>, payload: string, now: Date): Record<string, string> {
  const url = new URL(rawUrl);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payload,
    "x-amz-date": amzDate,
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
    ...(t.sessionToken ? { "x-amz-security-token": t.sessionToken } : {}),
  };
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, "", ...names.map((n) => `${n}:${headers[n].trim()}`), "", names.join(";"), payload].join("\n");
  const scope = `${day}/${t.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key4 = hmac(hmac(hmac(hmac(`AWS4${t.secretAccessKey}`, day), t.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key4).update(toSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${t.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

export class S3Client {
  constructor(readonly target: S3Target, private readonly fetchFn: S3Fetch = fetch as unknown as S3Fetch) {}

  async put(key: string, body: string | Uint8Array, contentType: string): Promise<void> {
    const { url, headers } = signRequest(this.target, "PUT", key, body, new Date(), contentType);
    const res = await this.fetchFn(url, { method: "PUT", headers, body });
    if (!res.ok) throw new S3Error(`PUT s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  /** The object's text, or undefined when there is none. */
  async get(key: string): Promise<string | undefined> {
    const { url, headers } = signRequest(this.target, "GET", key, "");
    const res = await this.fetchFn(url, { method: "GET", headers });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new S3Error(`GET s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.text();
  }
}
