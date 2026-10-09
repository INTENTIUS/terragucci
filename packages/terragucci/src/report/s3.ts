/**
 * The little of S3 the report needs: put an object, get one, and presign a
 * link to one, signed with AWS Signature Version 4 from `node:crypto`. Any S3-compatible store
 * answers it: S3, R2, MinIO, Google Cloud Storage's interoperability API.
 * A PUT can be conditional (If-Match, If-None-Match), so the index is
 * rewritten only over the copy it read. With no static keys, a role is
 * assumed with the job's OIDC token through STS AssumeRoleWithWebIdentity.
 * `fetch` is injectable so the signing is tested against recorded requests.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { encodePath, encodeStrict, PRESIGN_MAX_SECONDS, StoreConflict, StoreError, xmlText, type ObjectStore, type StoreCondition, type StoreFetch } from "./object-store";

export type S3Fetch = StoreFetch;
export { PRESIGN_MAX_SECONDS, StoreConflict as S3Conflict, StoreError as S3Error };

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * A role to assume with the job's OIDC token (AssumeRoleWithWebIdentity),
 * the way the AWS SDKs read `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE`.
 * The token file is read when the first request is signed, so a step that
 * writes it after the target is made is in time.
 */
export interface S3WebIdentity {
  roleArn: string;
  tokenFile: string;
  sessionName: string;
  /** STS's address, https://host[:port], no path. */
  endpoint: string;
}

export interface S3Location {
  bucket: string;
  /** https://host[:port], no path. Default: AWS's regional endpoint. */
  endpoint?: string;
  region: string;
}

export type S3Target = S3Location & (S3Credentials | { webIdentity: S3WebIdentity });

/** `s3://bucket` or a bare bucket name. */
export function parseBucket(url: string): string {
  const m = /^(?:s3:\/\/)?([^/]+)\/?$/.exec(url.trim());
  if (!m) throw new StoreError(`reports.bucket must be s3://<bucket>, not ${url}`);
  return m[1];
}

/**
 * The target from a config's `reports` and the AWS environment variables.
 * Credentials, first match wins: `reports.role` assumed with the job's OIDC
 * token; static keys in `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`;
 * `AWS_ROLE_ARN` assumed with the token in `AWS_WEB_IDENTITY_TOKEN_FILE`,
 * which is what a job with `oidc` sets.
 */
export function s3FromEnv(reports: { bucket: string; endpoint?: string; role?: string }, env: NodeJS.ProcessEnv = process.env): S3Target {
  const endpoint = reports.endpoint ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION || "us-east-1";
  const where = {
    bucket: parseBucket(reports.bucket),
    ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}),
    region,
  };
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
  const assume = (roleArn: string): S3Target => ({
    ...where,
    webIdentity: {
      roleArn,
      tokenFile: tokenFile!,
      sessionName: env.AWS_ROLE_SESSION_NAME || "terragucci-report",
      endpoint: (env.AWS_ENDPOINT_URL_STS || env.AWS_ENDPOINT_URL || `https://sts.${region}.amazonaws.com`).replace(/\/+$/, ""),
    },
  });
  if (reports.role) {
    if (!tokenFile) throw new StoreError(`reports.role is set, but AWS_WEB_IDENTITY_TOKEN_FILE is not: the job needs an OIDC token to assume ${reports.role}, which a job with oidc gets`);
    return assume(reports.role);
  }
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId && secretAccessKey) return { ...where, accessKeyId, secretAccessKey, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) };
  if (env.AWS_ROLE_ARN && tokenFile) return assume(env.AWS_ROLE_ARN);
  throw new StoreError("reports.bucket is set, but the job has no credentials for it: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE (a job with oidc sets both), or reports.role");
}

/** STS AssumeRoleWithWebIdentity. The request carries the token and is not signed. */
export async function assumeRoleWithWebIdentity(w: S3WebIdentity, fetchFn: S3Fetch, readToken: (file: string) => string = (f) => readFileSync(f, "utf-8")): Promise<S3Credentials & { expiration?: Date }> {
  let token: string;
  try {
    token = readToken(w.tokenFile).trim();
  } catch (e) {
    throw new StoreError(`cannot read the OIDC token in ${w.tokenFile}: ${(e as Error).message}`);
  }
  if (!token) throw new StoreError(`the OIDC token file ${w.tokenFile} is empty`);
  const body = new URLSearchParams({
    Action: "AssumeRoleWithWebIdentity",
    Version: "2011-06-15",
    RoleArn: w.roleArn,
    RoleSessionName: w.sessionName,
    WebIdentityToken: token,
  }).toString();
  const res = await fetchFn(`${w.endpoint}/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8", accept: "application/xml" }, body });
  const xml = await res.text();
  if (!res.ok) {
    const why = [xmlText(xml, "Code"), xmlText(xml, "Message")].filter(Boolean).join(": ") || xml.slice(0, 300);
    throw new StoreError(`AssumeRoleWithWebIdentity for ${w.roleArn}: ${res.status} ${why}`);
  }
  const accessKeyId = xmlText(xml, "AccessKeyId");
  const secretAccessKey = xmlText(xml, "SecretAccessKey");
  const sessionToken = xmlText(xml, "SessionToken");
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new StoreError(`AssumeRoleWithWebIdentity for ${w.roleArn} answered without credentials`);
  const expires = xmlText(xml, "Expiration");
  return { accessKeyId, secretAccessKey, sessionToken, ...(expires && !Number.isNaN(Date.parse(expires)) ? { expiration: new Date(expires) } : {}) };
}

const sha256 = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");
const hmac = (key: string | Buffer, s: string): Buffer => createHmac("sha256", key).update(s).digest();

/** The URL and signed headers for one request. A custom endpoint is addressed path-style, AWS virtual-hosted. */
export function signRequest(t: S3Location & S3Credentials, method: string, key: string, body: string | Uint8Array, now = new Date(), contentType?: string, extra: Record<string, string> = {}): { url: string; headers: Record<string, string> } {
  const url = objectUrl(t, key);
  return { url, headers: sign(t, method, url, { ...(contentType ? { "content-type": contentType } : {}), ...extra }, sha256(body), now) };
}

/** Signature Version 4 headers for a request with no query string. `headers` are signed too. */
export function sign(t: Pick<S3Location, "region"> & S3Credentials, method: string, rawUrl: string, extra: Record<string, string>, payload: string, now: Date): Record<string, string> {
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

/** The address of `key` in the bucket: path-style on a custom endpoint, virtual-hosted on AWS. */
const objectUrl = (t: S3Location, key: string): string => `${t.endpoint ? `${t.endpoint}/${t.bucket}` : `https://${t.bucket}.s3.${t.region}.amazonaws.com`}/${encodePath(key)}`;

/**
 * A presigned GET (Signature Version 4 in the query string): whoever holds
 * the URL reads that one object, and nothing else, for `seconds`.
 */
export function presign(t: Pick<S3Location, "region"> & S3Credentials, rawUrl: string, seconds: number, now: Date): string {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > PRESIGN_MAX_SECONDS) throw new StoreError(`a presigned link lives 1 to ${PRESIGN_MAX_SECONDS} seconds, not ${seconds}`);
  const url = new URL(rawUrl);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const scope = `${amzDate.slice(0, 8)}/${t.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${t.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(seconds),
    ...(t.sessionToken ? { "X-Amz-Security-Token": t.sessionToken } : {}),
    "X-Amz-SignedHeaders": "host",
  };
  const query = Object.keys(params).sort().map((k) => `${encodeStrict(k)}=${encodeStrict(params[k])}`).join("&");
  const canonical = ["GET", url.pathname, query, `host:${url.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key4 = hmac(hmac(hmac(hmac(`AWS4${t.secretAccessKey}`, amzDate.slice(0, 8)), t.region), "s3"), "aws4_request");
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${createHmac("sha256", key4).update(toSign).digest("hex")}`;
}

/** A condition on a PUT: the ETag the object must still have, or `*` for "there is no object yet". */
export type S3Condition = StoreCondition;

export class S3Client implements ObjectStore {
  private creds?: Promise<S3Credentials & { expiration?: Date }>;
  /** False once the store refused a conditional header (501), so writes go unconditional, as they did before it. */
  private conditional = true;

  constructor(readonly target: S3Target, private readonly fetchFn: S3Fetch = fetch as unknown as S3Fetch) {}

  get location(): string {
    return `s3://${this.target.bucket}`;
  }

  /** Static keys as given; a web identity's keys once per client, again a minute before they expire. */
  private async signer(): Promise<S3Location & S3Credentials> {
    const t = this.target;
    if (!("webIdentity" in t)) return t;
    const assume = (): Promise<S3Credentials & { expiration?: Date }> =>
      (this.creds = assumeRoleWithWebIdentity(t.webIdentity, this.fetchFn).catch((e: unknown) => {
        this.creds = undefined;
        throw e;
      }));
    let held = await (this.creds ?? assume());
    if (held.expiration && held.expiration.getTime() - Date.now() < 60_000) held = await assume();
    const { accessKeyId, secretAccessKey, sessionToken } = held;
    return { bucket: t.bucket, ...(t.endpoint ? { endpoint: t.endpoint } : {}), region: t.region, accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  }

  /**
   * Write an object; with `when`, only if it still holds. A write that lost
   * throws S3Conflict. The answer carries the new ETag when the store sends one.
   */
  async put(key: string, body: string | Uint8Array, contentType: string, when?: S3Condition): Promise<{ etag?: string }> {
    const cond: Record<string, string> = !when || !this.conditional ? {} : "ifMatch" in when ? { "if-match": when.ifMatch } : { "if-none-match": "*" };
    const { url, headers } = signRequest(await this.signer(), "PUT", key, body, new Date(), contentType, cond);
    const res = await this.fetchFn(url, { method: "PUT", headers, body });
    if (res.status === 501 && Object.keys(cond).length) {
      this.conditional = false;
      return this.put(key, body, contentType);
    }
    if (res.status === 412 || (res.status === 409 && Object.keys(cond).length)) throw new StoreConflict(`PUT s3://${this.target.bucket}/${key}: ${res.status}, it changed since it was read`);
    if (!res.ok) throw new StoreError(`PUT s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const etag = res.headers?.get("etag") ?? undefined;
    return etag ? { etag } : {};
  }

  /** The object's text and ETag, or no text when there is none. */
  async read(key: string): Promise<{ body?: string; etag?: string }> {
    const { url, headers } = signRequest(await this.signer(), "GET", key, "");
    const res = await this.fetchFn(url, { method: "GET", headers });
    if (res.status === 404) return {};
    if (!res.ok) throw new StoreError(`GET s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    const etag = res.headers?.get("etag") ?? undefined;
    return { body: await res.text(), ...(etag ? { etag } : {}) };
  }

  /**
   * A presigned GET of `key` for `seconds`. `expires` is when it stops
   * working: then, or sooner when the keys that signed it expire first (an
   * assumed role's session).
   */
  async presign(key: string, seconds: number, now = new Date()): Promise<{ url: string; expires: Date }> {
    const t = await this.signer();
    const url = presign(t, objectUrl(t, key), seconds, now);
    let expires = new Date(now.getTime() + seconds * 1000);
    const held = this.creds ? await this.creds : undefined;
    if (held?.expiration && held.expiration < expires) expires = held.expiration;
    return { url, expires };
  }

  /** The object's text, or undefined when there is none. */
  async get(key: string): Promise<string | undefined> {
    return (await this.read(key)).body;
  }

  /**
   * The object's metadata and never its body: whether it exists, its ETag,
   * and its version id when the bucket keeps versions. S3 sends no version id
   * for a bucket whose versioning was never on, and `null` for an object
   * written while it was suspended; both read as no version.
   */
  async head(key: string): Promise<{ exists: boolean; etag?: string; versionId?: string }> {
    const { url, headers } = signRequest(await this.signer(), "HEAD", key, "");
    const res = await this.fetchFn(url, { method: "HEAD", headers });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new StoreError(`HEAD s3://${this.target.bucket}/${key}: ${res.status}`);
    const etag = res.headers?.get("etag") ?? undefined;
    const version = res.headers?.get("x-amz-version-id") ?? undefined;
    return { exists: true, ...(etag ? { etag } : {}), ...(version && version !== "null" ? { versionId: version } : {}) };
  }

  /**
   * Write an object only when there is none (If-None-Match: *): true when
   * this write made it, false when one was there. Unlike put, a store that
   * refuses the condition fails the write: a lock must never be taken
   * unconditionally.
   */
  async putIfAbsent(key: string, body: string, contentType: string): Promise<boolean> {
    const { url, headers } = signRequest(await this.signer(), "PUT", key, body, new Date(), contentType, { "if-none-match": "*" });
    const res = await this.fetchFn(url, { method: "PUT", headers, body });
    if (res.status === 412 || res.status === 409) return false;
    if (res.status === 501) throw new StoreError(`PUT s3://${this.target.bucket}/${key}: the store does not take a conditional write (501)`);
    if (!res.ok) throw new StoreError(`PUT s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return true;
  }

  /** Delete an object. One that is not there is deleted already. */
  async remove(key: string): Promise<void> {
    const { url, headers } = signRequest(await this.signer(), "DELETE", key, "");
    const res = await this.fetchFn(url, { method: "DELETE", headers });
    if (!res.ok && res.status !== 404) throw new StoreError(`DELETE s3://${this.target.bucket}/${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}
