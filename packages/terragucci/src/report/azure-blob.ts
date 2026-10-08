/**
 * Azure Blob Storage for the reports, over its REST API with `fetch` and
 * `node:crypto`: put a block blob, get one, and a SAS link to one.
 *
 * With the job's Azure OIDC identity (the ARM_* variables a job with
 * `oidc.azure` sets), the token in ARM_OIDC_TOKEN_FILE_PATH is traded at
 * Entra ID for a storage token (a client assertion, the way the azurerm
 * backend does it), and a link is a user delegation SAS signed with a key
 * the identity asks the account for. With an account key
 * (AZURE_STORAGE_KEY), requests are signed with Shared Key and a link is a
 * service SAS. Both SAS kinds read one blob and nothing else.
 *
 * Writes are conditional the way S3's are: If-Match the ETag read, or
 * If-None-Match `*` when there was none. Azure answers a lost write with 412
 * (the ETag moved) or 409 (the blob appeared).
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { encodePath, isoSeconds, PRESIGN_MAX_SECONDS, StoreConflict, StoreError, xmlText, type ObjectStore, type StoreCondition, type StoreFetch } from "./object-store";

/** The REST version every request names, and the SAS version: the 2020-12-06 string-to-sign layouts. */
export const AZURE_VERSION = "2021-08-06";

/** Entra ID's public cloud; AZURE_AUTHORITY_HOST names a sovereign cloud's. */
export const AZURE_AUTHORITY = "https://login.microsoftonline.com";

const STORAGE_SCOPE = "https://storage.azure.com/.default";

export interface AzureLocation {
  account: string;
  container: string;
  /** The account's blob endpoint, no trailing slash: https://<account>.blob.core.windows.net, or an emulator's http://host:10000/<account>. */
  endpoint: string;
}

/** The job's federated identity: an Entra app or managed identity that trusts the forge's token. */
export interface AzureOidc {
  tenantId: string;
  clientId: string;
  tokenFile: string;
  /** Entra ID's address, https://host, no path. */
  authority: string;
}

export type AzureTarget = AzureLocation & ({ accountKey: string } | { oidc: AzureOidc });

/** The target from `reports` and the job's environment. An account key wins over the job's OIDC identity. */
export function azureFromEnv(where: { account: string; container: string; endpoint?: string }, env: NodeJS.ProcessEnv = process.env): AzureTarget {
  const at: AzureLocation = { account: where.account, container: where.container, endpoint: (where.endpoint ?? `https://${where.account}.blob.core.windows.net`).replace(/\/+$/, "") };
  if (env.AZURE_STORAGE_KEY) return { ...at, accountKey: env.AZURE_STORAGE_KEY };
  const tenantId = env.ARM_TENANT_ID;
  const clientId = env.ARM_CLIENT_ID;
  const tokenFile = env.ARM_OIDC_TOKEN_FILE_PATH;
  if (tenantId && clientId && tokenFile) return { ...at, oidc: { tenantId, clientId, tokenFile, authority: (env.AZURE_AUTHORITY_HOST || AZURE_AUTHORITY).replace(/\/+$/, "") } };
  throw new StoreError(`reports.bucket is az://${where.account}/${where.container}, but the job has no credentials for it: give the job oidc.azure (it sets ARM_TENANT_ID, ARM_CLIENT_ID and ARM_OIDC_TOKEN_FILE_PATH), or set AZURE_STORAGE_KEY`);
}

const hmac64 = (key: string, s: string): string => createHmac("sha256", Buffer.from(key, "base64")).update(s, "utf8").digest("base64");

/** The headers whose values Shared Key signs by position, in order. */
const SIGNED = ["content-encoding", "content-language", "content-length", "content-md5", "content-type", "date", "if-modified-since", "if-match", "if-none-match", "if-unmodified-since", "range"];

/**
 * The Shared Key Authorization header for a request. The resource is the
 * account and the URL's path (an emulator's path, which starts with the
 * account, too), then each query parameter on its own line.
 */
export function sharedKey(account: string, accountKey: string, method: string, rawUrl: string, headers: Record<string, string>): string {
  const url = new URL(rawUrl);
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const fixed = SIGNED.map((n) => (n === "content-length" && h[n] === "0" ? "" : (h[n] ?? "")));
  const ms = Object.keys(h).filter((n) => n.startsWith("x-ms-")).sort().map((n) => `${n}:${h[n].trim()}\n`).join("");
  const params = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) params.set(k.toLowerCase(), [...(params.get(k.toLowerCase()) ?? []), v]);
  const query = [...params.keys()].sort().map((k) => `\n${k}:${params.get(k)!.sort().join(",")}`).join("");
  const toSign = [method, ...fixed].join("\n") + "\n" + ms + `/${account}${url.pathname}` + query;
  return `SharedKey ${account}:${hmac64(accountKey, toSign)}`;
}

/** A user delegation key, as Get User Delegation Key answers it. */
export interface DelegationKey {
  oid: string;
  tid: string;
  start: string;
  expiry: string;
  service: string;
  version: string;
  value: string;
}

/** The query of a read-only SAS for one blob: a user delegation SAS with `key`, else a service SAS signed with the account key. */
export function blobSas(t: AzureLocation, blob: string, expiry: Date, sign: { accountKey: string } | { key: DelegationKey }): string {
  const se = isoSeconds(expiry);
  const spr = t.endpoint.startsWith("https:") ? "https" : "";
  const resource = `/blob/${t.account}/${t.container}/${blob}`;
  const tail = [spr, AZURE_VERSION, "b", "", "", "", "", "", "", ""];
  let toSign: string;
  let params: [string, string][];
  if ("key" in sign) {
    const k = sign.key;
    toSign = ["r", "", se, resource, k.oid, k.tid, k.start, k.expiry, k.service, k.version, "", "", "", "", ...tail].join("\n");
    params = [["skoid", k.oid], ["sktid", k.tid], ["skt", k.start], ["ske", k.expiry], ["sks", k.service], ["skv", k.version]];
  } else {
    toSign = ["r", "", se, resource, "", "", ...tail].join("\n");
    params = [];
  }
  const sig = hmac64("key" in sign ? sign.key.value : sign.accountKey, toSign);
  const q = new URLSearchParams([["sv", AZURE_VERSION], ["sr", "b"], ["sp", "r"], ["se", se], ...(spr ? [["spr", spr] as [string, string]] : []), ...params, ["sig", sig]]);
  return q.toString();
}

/** Entra ID's error, or the start of the body. */
const why = (text: string): string => {
  try {
    const j = JSON.parse(text) as { error?: string; error_description?: string };
    if (j.error) return [j.error, j.error_description?.split("\r\n")[0]].filter(Boolean).join(": ");
  } catch {
    // Not JSON: Blob Storage answers in XML.
  }
  return [xmlText(text, "Code"), xmlText(text, "Message")?.split("\n")[0]].filter(Boolean).join(": ") || text.slice(0, 300);
};

export class AzureBlobClient implements ObjectStore {
  private token?: Promise<{ token: string; expires: number }>;
  private keys = new Map<string, Promise<DelegationKey>>();

  constructor(readonly target: AzureTarget, private readonly fetchFn: StoreFetch = fetch as unknown as StoreFetch, private readonly readToken: (file: string) => string = (f) => readFileSync(f, "utf-8")) {}

  get location(): string {
    return `az://${this.target.account}/${this.target.container}`;
  }

  private blobUrl(key: string): string {
    return `${this.target.endpoint}/${this.target.container}/${encodePath(key)}`;
  }

  /** The storage token for the OIDC identity: once per client, again a minute before it expires. */
  private async bearer(o: AzureOidc): Promise<string> {
    const fetchToken = async (): Promise<{ token: string; expires: number }> => {
      let assertion: string;
      try {
        assertion = this.readToken(o.tokenFile).trim();
      } catch (e) {
        throw new StoreError(`cannot read the OIDC token in ${o.tokenFile}: ${(e as Error).message}`);
      }
      if (!assertion) throw new StoreError(`the OIDC token file ${o.tokenFile} is empty`);
      const body = new URLSearchParams({
        client_id: o.clientId,
        scope: STORAGE_SCOPE,
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }).toString();
      const res = await this.fetchFn(`${o.authority}/${o.tenantId}/oauth2/v2.0/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      const text = await res.text();
      if (!res.ok) throw new StoreError(`Entra ID refused the OIDC token for client ${o.clientId}: ${res.status} ${why(text)}`);
      let j: { access_token?: string; expires_in?: number | string } = {};
      try {
        j = JSON.parse(text) as typeof j;
      } catch {
        // Reported below as no token.
      }
      if (!j.access_token) throw new StoreError(`Entra ID answered client ${o.clientId} without a token`);
      return { token: j.access_token, expires: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    };
    const again = (): Promise<{ token: string; expires: number }> =>
      (this.token = fetchToken().catch((e: unknown) => {
        this.token = undefined;
        throw e;
      }));
    let held = await (this.token ?? again());
    if (held.expires - Date.now() < 60_000) held = await again();
    return held.token;
  }

  /** The headers for one request, signed or with the bearer token. */
  private async headers(method: string, url: string, extra: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { "x-ms-date": new Date().toUTCString(), "x-ms-version": AZURE_VERSION, ...extra };
    const t = this.target;
    if ("accountKey" in t) return { ...h, authorization: sharedKey(t.account, t.accountKey, method, url, h) };
    return { ...h, authorization: `Bearer ${await this.bearer(t.oidc)}` };
  }

  async put(key: string, body: string | Uint8Array, contentType: string, when?: StoreCondition): Promise<{ etag?: string }> {
    const url = this.blobUrl(key);
    const cond: Record<string, string> = !when ? {} : "ifMatch" in when ? { "if-match": when.ifMatch } : { "if-none-match": "*" };
    const length = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
    const headers = await this.headers("PUT", url, { "x-ms-blob-type": "BlockBlob", "content-type": contentType, "content-length": String(length), ...cond });
    const res = await this.fetchFn(url, { method: "PUT", headers, body });
    if (res.status === 412 || (res.status === 409 && when)) throw new StoreConflict(`PUT ${this.location}/${key}: ${res.status}, it changed since it was read`);
    if (!res.ok) throw new StoreError(`PUT ${this.location}/${key}: ${res.status} ${why(await res.text())}`);
    const etag = res.headers?.get("etag") ?? undefined;
    return etag ? { etag } : {};
  }

  async read(key: string): Promise<{ body?: string; etag?: string }> {
    const url = this.blobUrl(key);
    const res = await this.fetchFn(url, { method: "GET", headers: await this.headers("GET", url, {}) });
    if (res.status === 404) return {};
    if (!res.ok) throw new StoreError(`GET ${this.location}/${key}: ${res.status} ${why(await res.text())}`);
    const etag = res.headers?.get("etag") ?? undefined;
    return { body: await res.text(), ...(etag ? { etag } : {}) };
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.read(key)).body;
  }

  /** Get User Delegation Key, valid from now until `expiry`: one per expiry, so the estate's one link asks once. */
  private delegationKey(now: Date, expiry: Date): Promise<DelegationKey> {
    const id = isoSeconds(expiry);
    let k = this.keys.get(id);
    if (!k) {
      k = (async () => {
        const url = `${this.target.endpoint}/?restype=service&comp=userdelegationkey`;
        const body = `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${isoSeconds(now)}</Start><Expiry>${id}</Expiry></KeyInfo>`;
        const res = await this.fetchFn(url, { method: "POST", headers: await this.headers("POST", url, { "content-type": "application/xml" }), body });
        const xml = await res.text();
        if (!res.ok) throw new StoreError(`Get User Delegation Key on ${this.target.account}: ${res.status} ${why(xml)}`);
        const f = (tag: string): string => {
          const v = xmlText(xml, tag);
          if (!v) throw new StoreError(`Get User Delegation Key on ${this.target.account} answered without ${tag}`);
          return v;
        };
        return { oid: f("SignedOid"), tid: f("SignedTid"), start: f("SignedStart"), expiry: f("SignedExpiry"), service: f("SignedService"), version: f("SignedVersion"), value: f("Value") };
      })();
      k.catch(() => this.keys.delete(id));
      this.keys.set(id, k);
    }
    return k;
  }

  /** A read-only SAS link to `key` for `seconds`. */
  async presign(key: string, seconds: number, now = new Date()): Promise<{ url: string; expires: Date }> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > PRESIGN_MAX_SECONDS) throw new StoreError(`a SAS link lives 1 to ${PRESIGN_MAX_SECONDS} seconds, not ${seconds}`);
    const expires = new Date(Math.floor(now.getTime() / 1000) * 1000 + seconds * 1000);
    const t = this.target;
    const sas = blobSas(t, key, expires, "accountKey" in t ? { accountKey: t.accountKey } : { key: await this.delegationKey(now, expires) });
    return { url: `${this.blobUrl(key)}?${sas}`, expires };
  }
}
