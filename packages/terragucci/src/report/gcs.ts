/**
 * Google Cloud Storage for the reports and for a gcs backend's state, over
 * its JSON API with `fetch` and `node:crypto`: upload an object, download
 * one, and a V4 signed URL to one; for a state, an object's generation, one
 * generation's text, and a lock object written only when there is none.
 *
 * The identity is the file GOOGLE_APPLICATION_CREDENTIALS names, as Google's
 * own libraries read it:
 *
 *   external_account  the job's OIDC token (what a job with `oidc.gcp` writes,
 *                     or google-github-actions/auth), traded at Google's STS,
 *                     then the service account it impersonates. A link is
 *                     signed by that service account through IAM's signBlob.
 *   service_account   a key: requests carry a self-signed JWT and a link is
 *                     signed with the key itself.
 *
 * A gcs backend's own credentials stand in for that file when its
 * configuration names them: `access_token` (or GOOGLE_OAUTH_ACCESS_TOKEN), a
 * bearer token used as it is, or `credentials`, a file or its JSON. With
 * `impersonate_service_account`, every request carries that service
 * account's token, which the identity asks IAM for.
 *
 * Writes are conditional on the generation read (`ifGenerationMatch`, `0` when
 * there was no object), and a lost write is a 412.
 */
import { createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { encodePath, encodeStrict, PRESIGN_MAX_SECONDS, StoreConflict, StoreError, type ObjectStore, type StoreCondition, type StoreFetch } from "./object-store";

export const GCS_ENDPOINT = "https://storage.googleapis.com";
/** IAM Credentials, where a token for an impersonated service account comes from. */
export const IAM_CREDENTIALS = "https://iamcredentials.googleapis.com";
const CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
const READ_WRITE = "https://www.googleapis.com/auth/devstorage.read_write";

export interface GcsTarget {
  bucket: string;
  /** The JSON API's and the links' address, no trailing slash. Default https://storage.googleapis.com. */
  endpoint: string;
  /** The credentials file, read at the first request. */
  credentialsFile?: string;
  /** The credentials as JSON: a gcs backend's `credentials` given inline. */
  credentialsJson?: string;
  /** A bearer token used as it is: a gcs backend's `access_token`, or GOOGLE_OAUTH_ACCESS_TOKEN. */
  accessToken?: string;
  /** The service account every request acts as, through IAM's generateAccessToken: a gcs backend's `impersonate_service_account`. */
  impersonate?: string;
  /** IAM Credentials' address, no trailing slash. Default https://iamcredentials.googleapis.com. */
  iamEndpoint?: string;
}

/** The target from `reports` and the job's environment. */
export function gcsFromEnv(where: { bucket: string; endpoint?: string }, env: NodeJS.ProcessEnv = process.env): GcsTarget {
  const file = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!file) throw new StoreError(`reports.bucket is gs://${where.bucket}, but the job has no credentials for it: give the job oidc.gcp (it sets GOOGLE_APPLICATION_CREDENTIALS), or set GOOGLE_APPLICATION_CREDENTIALS to a credentials file`);
  return { bucket: where.bucket, endpoint: (where.endpoint ?? GCS_ENDPOINT).replace(/\/+$/, ""), credentialsFile: file };
}

interface ExternalAccount {
  type: "external_account";
  audience: string;
  subject_token_type: string;
  token_url: string;
  service_account_impersonation_url?: string;
  credential_source: { file?: string; url?: string; headers?: Record<string, string>; format?: { type?: string; subject_token_field_name?: string } };
}

interface ServiceAccountKey {
  type: "service_account";
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

type Credentials = ExternalAccount | ServiceAccountKey;

const b64url = (b: string | Buffer): string => Buffer.from(b).toString("base64url");

/** A JWT the key signs for itself, which Google's APIs take as an access token for the scope it names. */
export function selfSignedJwt(key: ServiceAccountKey, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const body = b64url(JSON.stringify({ iss: key.client_email, sub: key.client_email, scope: READ_WRITE, iat, exp: iat + 3600 }));
  return `${head}.${body}.${createSign("RSA-SHA256").update(`${head}.${body}`).sign(key.private_key).toString("base64url")}`;
}

/** The service account an impersonation URL names: `.../serviceAccounts/<email>:generateAccessToken`. */
const impersonated = (url: string): string | undefined => {
  const m = /\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(url);
  return m ? decodeURIComponent(m[1]) : undefined;
};

/**
 * A V4 signed URL (GOOG4-RSA-SHA256): whoever holds it reads that one object,
 * and nothing else, for `seconds`. `sign` signs the string-to-sign with the
 * service account's key and answers the signature.
 */
export async function signedUrl(endpoint: string, bucket: string, key: string, email: string, seconds: number, now: Date, sign: (toSign: string) => Promise<Buffer>): Promise<string> {
  const url = new URL(`${endpoint}/${bucket}/${encodePath(key)}`);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const scope = `${stamp.slice(0, 8)}/auto/storage/goog4_request`;
  const params: Record<string, string> = {
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${email}/${scope}`,
    "X-Goog-Date": stamp,
    "X-Goog-Expires": String(seconds),
    "X-Goog-SignedHeaders": "host",
  };
  const query = Object.keys(params).sort().map((k) => `${encodeStrict(k)}=${encodeStrict(params[k])}`).join("&");
  const canonical = ["GET", url.pathname, query, `host:${url.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["GOOG4-RSA-SHA256", stamp, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  return `${url.origin}${url.pathname}?${query}&X-Goog-Signature=${(await sign(toSign)).toString("hex")}`;
}

/** Google's error message, or the start of the body. */
const why = (text: string): string => {
  try {
    const j = JSON.parse(text) as { error?: string | { message?: string }; error_description?: string };
    if (typeof j.error === "object" && j.error?.message) return j.error.message;
    if (typeof j.error === "string") return [j.error, j.error_description].filter(Boolean).join(": ");
  } catch {
    // Not JSON.
  }
  return text.slice(0, 300);
};

export class GcsClient implements ObjectStore {
  private creds?: Credentials;
  private token?: Promise<{ token: string; expires: number }>;

  constructor(readonly target: GcsTarget, private readonly fetchFn: StoreFetch = fetch as unknown as StoreFetch, private readonly readFile: (file: string) => string = (f) => readFileSync(f, "utf-8")) {}

  get location(): string {
    return `gs://${this.target.bucket}`;
  }

  /** Where the credentials come from, for messages. */
  private get source(): string {
    return this.target.credentialsFile ?? "the backend's credentials";
  }

  private credentials(): Credentials {
    if (this.creds) return this.creds;
    const file = this.source;
    let c: Partial<Credentials>;
    try {
      c = JSON.parse(this.target.credentialsJson ?? this.readFile(this.target.credentialsFile ?? "")) as Partial<Credentials>;
    } catch (e) {
      throw new StoreError(`cannot read the credentials in ${file}: ${(e as Error).message}`);
    }
    if (c.type === "external_account" && c.token_url && c.audience && c.credential_source && (c.credential_source.file || c.credential_source.url)) return (this.creds = c as ExternalAccount);
    if (c.type === "service_account" && c.client_email && c.private_key) return (this.creds = c as ServiceAccountKey);
    throw new StoreError(`${file} is not an external_account file with a credential_source file or url, nor a service_account key`);
  }

  private async post(url: string, headers: Record<string, string>, body: string, what: string): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(url, { method: "POST", headers, body });
    const text = await res.text();
    if (!res.ok) throw new StoreError(`${what}: ${res.status} ${why(text)}`);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new StoreError(`${what}: the answer is not JSON`);
    }
  }

  /** The job's OIDC token, from the file or URL the credentials name. */
  private async subjectToken(c: ExternalAccount): Promise<string> {
    const src = c.credential_source;
    let text: string;
    if (src.file) {
      try {
        text = this.readFile(src.file);
      } catch (e) {
        throw new StoreError(`cannot read the OIDC token in ${src.file}: ${(e as Error).message}`);
      }
    } else {
      const res = await this.fetchFn(src.url!, { method: "GET", headers: src.headers ?? {} });
      text = await res.text();
      if (!res.ok) throw new StoreError(`the OIDC token at ${src.url!.split("?")[0]}: ${res.status} ${why(text)}`);
    }
    const field = src.format?.type === "json" ? src.format.subject_token_field_name : undefined;
    let token = text.trim();
    if (field) {
      try {
        token = String((JSON.parse(text) as Record<string, unknown>)[field] ?? "");
      } catch {
        throw new StoreError(`the job's OIDC token is not JSON with ${field}`);
      }
    }
    if (!token) throw new StoreError(`the job's OIDC token is empty`);
    return token;
  }

  /** STS's federated token, then the impersonated service account's, when the credentials name one. */
  private async exchange(c: ExternalAccount): Promise<{ token: string; expires: number }> {
    const sts = await this.post(
      c.token_url,
      { "content-type": "application/x-www-form-urlencoded" },
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: c.audience,
        scope: CLOUD_PLATFORM,
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token: await this.subjectToken(c),
        subject_token_type: c.subject_token_type,
      }).toString(),
      `Google STS refused the OIDC token for ${c.audience}`,
    );
    if (typeof sts.access_token !== "string") throw new StoreError(`Google STS answered without a token`);
    const fed = { token: sts.access_token, expires: Date.now() + Number(sts.expires_in ?? 3600) * 1000 };
    if (!c.service_account_impersonation_url) return fed;
    const sa = await this.post(
      c.service_account_impersonation_url,
      { "content-type": "application/json", authorization: `Bearer ${fed.token}` },
      JSON.stringify({ scope: [CLOUD_PLATFORM], lifetime: "3600s" }),
      `impersonating ${impersonated(c.service_account_impersonation_url) ?? "the service account"}`,
    );
    if (typeof sa.accessToken !== "string") throw new StoreError(`IAM answered the impersonation without a token`);
    const at = typeof sa.expireTime === "string" ? Date.parse(sa.expireTime) : NaN;
    return { token: sa.accessToken, expires: Number.isNaN(at) ? Date.now() + 3600_000 : at };
  }

  /** The identity's own token: the one the target gives, a key's self-signed JWT, or STS's for the OIDC token. */
  private async own(): Promise<{ token: string; expires: number }> {
    if (this.target.accessToken) return { token: this.target.accessToken, expires: Date.now() + 3600_000 };
    const c = this.credentials();
    return c.type === "service_account" ? { token: selfSignedJwt(c, new Date()), expires: Date.now() + 3600_000 } : this.exchange(c);
  }

  /** The token of the service account the target impersonates, asked for with the identity's own. */
  private async impersonating(sa: string): Promise<{ token: string; expires: number }> {
    const base = await this.own();
    const r = await this.post(
      `${(this.target.iamEndpoint ?? IAM_CREDENTIALS).replace(/\/+$/, "")}/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateAccessToken`,
      { "content-type": "application/json", authorization: `Bearer ${base.token}` },
      JSON.stringify({ scope: [CLOUD_PLATFORM], lifetime: "3600s" }),
      `impersonating ${sa}, which needs Service Account Token Creator for the identity`,
    );
    if (typeof r.accessToken !== "string") throw new StoreError(`IAM answered the impersonation of ${sa} without a token`);
    const at = typeof r.expireTime === "string" ? Date.parse(r.expireTime) : NaN;
    return { token: r.accessToken, expires: Number.isNaN(at) ? Date.now() + 3600_000 : at };
  }

  /** An access token: once per client, again a minute before it expires. */
  private async bearer(): Promise<string> {
    const sa = this.target.impersonate;
    const fresh = (): Promise<{ token: string; expires: number }> => (sa ? this.impersonating(sa) : this.own());
    const again = (): Promise<{ token: string; expires: number }> =>
      (this.token = fresh().catch((e: unknown) => {
        this.token = undefined;
        throw e;
      }));
    let held = await (this.token ?? again());
    if (held.expires - Date.now() < 60_000) held = await again();
    return held.token;
  }

  async put(key: string, body: string | Uint8Array, contentType: string, when?: StoreCondition): Promise<{ etag?: string }> {
    const t = this.target;
    const gen = !when ? "" : "ifMatch" in when ? when.ifMatch : "0";
    const url = `${t.endpoint}/upload/storage/v1/b/${encodeURIComponent(t.bucket)}/o?uploadType=media&name=${encodeStrict(key)}${gen ? `&ifGenerationMatch=${encodeStrict(gen)}` : ""}`;
    const res = await this.fetchFn(url, { method: "POST", headers: { "content-type": contentType, authorization: `Bearer ${await this.bearer()}` }, body });
    if (res.status === 412) throw new StoreConflict(`PUT ${this.location}/${key}: 412, it changed since it was read`);
    const text = await res.text();
    if (!res.ok) throw new StoreError(`PUT ${this.location}/${key}: ${res.status} ${why(text)}`);
    let generation: unknown;
    try {
      generation = (JSON.parse(text) as { generation?: unknown }).generation;
    } catch {
      // An answer without the object's metadata: no version to write on.
    }
    return generation !== undefined ? { etag: String(generation) } : {};
  }

  async read(key: string): Promise<{ body?: string; etag?: string }> {
    const t = this.target;
    const url = `${t.endpoint}/storage/v1/b/${encodeURIComponent(t.bucket)}/o/${encodeStrict(key)}?alt=media`;
    const res = await this.fetchFn(url, { method: "GET", headers: { authorization: `Bearer ${await this.bearer()}` } });
    if (res.status === 404) return {};
    if (!res.ok) throw new StoreError(`GET ${this.location}/${key}: ${res.status} ${why(await res.text())}`);
    const generation = res.headers?.get("x-goog-generation") ?? undefined;
    return { body: await res.text(), ...(generation ? { etag: generation } : {}) };
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.read(key)).body;
  }

  private objectUrl(key: string): string {
    return `${this.target.endpoint}/storage/v1/b/${encodeURIComponent(this.target.bucket)}/o/${encodeStrict(key)}`;
  }

  /** An object's metadata and never its body: whether it is there, and its generation. */
  async head(key: string, generation?: string): Promise<{ exists: boolean; generation?: string }> {
    const url = `${this.objectUrl(key)}${generation ? `?generation=${encodeStrict(generation)}` : ""}`;
    const res = await this.fetchFn(url, { method: "GET", headers: { authorization: `Bearer ${await this.bearer()}` } });
    const text = await res.text();
    // GCS answers 400 for a generation that is not a number.
    if (res.status === 404 || (generation && res.status === 400)) return { exists: false };
    if (!res.ok) throw new StoreError(`GET ${this.location}/${key} metadata: ${res.status} ${why(text)}`);
    let g: unknown;
    try {
      g = (JSON.parse(text) as { generation?: unknown }).generation;
    } catch {
      // Metadata that is not JSON: no generation.
    }
    return { exists: true, ...(g !== undefined && g !== null && g !== "" ? { generation: String(g) } : {}) };
  }

  /** One generation of an object's text; undefined when the bucket holds no such generation. */
  async readGeneration(key: string, generation: string): Promise<string | undefined> {
    const url = `${this.objectUrl(key)}?alt=media&generation=${encodeStrict(generation)}`;
    const res = await this.fetchFn(url, { method: "GET", headers: { authorization: `Bearer ${await this.bearer()}` } });
    if (res.status === 404 || res.status === 400) return undefined;
    if (!res.ok) throw new StoreError(`GET ${this.location}/${key}#${generation}: ${res.status} ${why(await res.text())}`);
    return res.text();
  }

  /** Whether the bucket keeps each generation of an object (object versioning); undefined when the identity may not read the bucket's settings. */
  async versioning(): Promise<boolean | undefined> {
    const url = `${this.target.endpoint}/storage/v1/b/${encodeURIComponent(this.target.bucket)}?fields=versioning`;
    const res = await this.fetchFn(url, { method: "GET", headers: { authorization: `Bearer ${await this.bearer()}` } });
    const text = await res.text();
    if (res.status === 403 || res.status === 401) return undefined;
    if (!res.ok) throw new StoreError(`GET ${this.location} settings: ${res.status} ${why(text)}`);
    try {
      return (JSON.parse(text) as { versioning?: { enabled?: boolean } }).versioning?.enabled === true;
    } catch {
      return undefined;
    }
  }

  /** Write an object only when there is none (ifGenerationMatch=0): true when this write made it, false when one was there. */
  async putIfAbsent(key: string, body: string, contentType: string): Promise<boolean> {
    try {
      await this.put(key, body, contentType, { ifNoneMatch: "*" });
      return true;
    } catch (e) {
      if (e instanceof StoreConflict) return false;
      throw e;
    }
  }

  /** Delete an object's live generation. One that is not there is deleted already. */
  async remove(key: string): Promise<void> {
    const res = await this.fetchFn(this.objectUrl(key), { method: "DELETE", headers: { authorization: `Bearer ${await this.bearer()}` } });
    if (!res.ok && res.status !== 404) throw new StoreError(`DELETE ${this.location}/${key}: ${res.status} ${why(await res.text())}`);
  }

  /** A signed URL to `key` for `seconds`, signed by the key or by the impersonated service account through IAM. */
  async presign(key: string, seconds: number, now = new Date()): Promise<{ url: string; expires: Date }> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > PRESIGN_MAX_SECONDS) throw new StoreError(`a signed URL lives 1 to ${PRESIGN_MAX_SECONDS} seconds, not ${seconds}`);
    const c = this.credentials();
    let email: string;
    let sign: (s: string) => Promise<Buffer>;
    if (c.type === "service_account") {
      email = c.client_email;
      sign = async (s) => createSign("RSA-SHA256").update(s).sign(c.private_key);
    } else {
      const sa = c.service_account_impersonation_url ? impersonated(c.service_account_impersonation_url) : undefined;
      if (!sa) throw new StoreError(`a signed URL needs a service account to sign it, and ${this.source} impersonates none: set oidc.gcp's service accounts`);
      email = sa;
      const iam = new URL(c.service_account_impersonation_url!).origin;
      sign = async (s) => {
        const r = await this.post(
          `${iam}/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:signBlob`,
          { "content-type": "application/json", authorization: `Bearer ${await this.bearer()}` },
          JSON.stringify({ payload: Buffer.from(s).toString("base64") }),
          `signBlob as ${sa}, which needs Service Account Token Creator on itself`,
        );
        if (typeof r.signedBlob !== "string") throw new StoreError(`signBlob as ${sa} answered without a signature`);
        return Buffer.from(r.signedBlob, "base64");
      };
    }
    const url = await signedUrl(this.target.endpoint, this.target.bucket, key, email, seconds, now, sign);
    return { url, expires: new Date(now.getTime() + seconds * 1000) };
  }
}
