import { createHmac, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config";
import { estate } from "../src/estate";
import { AzureBlobClient, azureFromEnv, blobSas, sharedKey, AZURE_VERSION } from "../src/report/azure-blob";
import { storeFromEnv } from "../src/report/bucket";
import { buildReport } from "../src/report/build";
import { GcsClient, gcsFromEnv, signedUrl } from "../src/report/gcs";
import { parseReportsBucket, StoreConflict, StoreError, type StoreFetch } from "../src/report/object-store";
import { S3Client } from "../src/report/s3";
import { updateIndex, indexEntry, uploadReport, writeReportDir } from "../src/report/store";
import { RUN, smallFixture } from "./report-fixtures";
import { tmp, write } from "./helpers";

/** The account key of Azurite's devstoreaccount1, published by Microsoft for the emulator. */
const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
/** A service account key made for the run. */
const GCS_KEY = {
  type: "service_account",
  client_email: "test-iam-credentials@dummy-project-id.iam.gserviceaccount.com",
  private_key_id: "ffffffffffffffffffffffffffffffffffffffff",
  private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
};

type Req = { url: string; method: string; headers: Record<string, string>; body?: string };
type Answer = { status: number; body?: string; headers?: Record<string, string> };

/** A fetch that records each request and answers from `answer`. */
function recorder(answer: (r: Req) => Answer): { seen: Req[]; fetch: StoreFetch } {
  const seen: Req[] = [];
  const fetch: StoreFetch = async (url, init) => {
    const r: Req = { url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: Buffer.from(init.body as Uint8Array).toString("utf-8") } : {}) };
    seen.push(r);
    const a = answer(r);
    const h = new Map(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body ?? "", headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null } };
  };
  return { seen, fetch };
}

/** An object store in a map: versions count up, conditions hold, the way all three stores behave. */
function bucket(keyOf: (r: Req) => string | undefined, version: "etag" | "generation") {
  const objects = new Map<string, { body: string; v: number }>();
  let next = 1;
  const r = recorder((q): Answer => {
    const key = keyOf(q);
    if (key === undefined) return { status: 400 };
    const have = objects.get(key);
    const tag = (v: number): Record<string, string> => (version === "etag" ? { etag: `"0x${v}"` } : { "x-goog-generation": String(v) });
    if (q.method === "GET") return have ? { status: 200, body: have.body, headers: tag(have.v) } : { status: 404 };
    const u = new URL(q.url);
    const ifMatch = q.headers["if-match"] ?? (u.searchParams.get("ifGenerationMatch") ?? undefined);
    const none = q.headers["if-none-match"] === "*" || ifMatch === "0";
    if (none && have) return { status: version === "etag" ? 409 : 412 };
    if (ifMatch && ifMatch !== "0" && (!have || ifMatch !== (version === "etag" ? `"0x${have.v}"` : String(have.v)))) return { status: 412 };
    const v = next++;
    objects.set(key, { body: q.body ?? "", v });
    return { status: 201, headers: tag(v), body: version === "generation" ? JSON.stringify({ name: key, generation: String(v) }) : "" };
  });
  return { objects, ...r };
}

describe("reports.bucket", () => {
  it("names the store by its scheme", () => {
    expect(parseReportsBucket("s3://acme-reports")).toEqual({ kind: "s3", bucket: "acme-reports" });
    expect(parseReportsBucket("acme-reports")).toEqual({ kind: "s3", bucket: "acme-reports" });
    expect(parseReportsBucket("gs://acme-reports/")).toEqual({ kind: "gcs", bucket: "acme-reports" });
    expect(parseReportsBucket("az://acmereports/terragucci")).toEqual({ kind: "azure", account: "acmereports", container: "terragucci" });
    for (const bad of ["az://acmereports", "az://Acme/terragucci", "gs://", "https://acme.blob.core.windows.net/terragucci", "s3://a/b"]) expect(() => parseReportsBucket(bad), bad).toThrow(StoreError);
  });

  it("config check refuses a bucket it cannot write, and reports.role on a bucket that is not S3", () => {
    expect(validateConfig({ reports: { bucket: "az://acmereports/terragucci" } }, "t").reports?.bucket).toBe("az://acmereports/terragucci");
    expect(validateConfig({ reports: { bucket: "gs://acme-reports" } }, "t").reports?.bucket).toBe("gs://acme-reports");
    expect(() => validateConfig({ reports: { bucket: "az://acmereports" } }, "t")).toThrow("reports.bucket must be s3://<bucket>, gs://<bucket> or az://<account>/<container>, not az://acmereports");
    expect(() => validateConfig({ reports: { bucket: "gs://acme-reports", role: "arn:aws:iam::123456789012:role/reports" } }, "t")).toThrow(
      "reports.role is an AWS role, and gs://acme-reports is not an S3 bucket: the job writes it with its own oidc identity",
    );
  });

  it("picks the client from the scheme and the identity from the job's environment", () => {
    const dir = tmp();
    write(dir, { "token": "forge-token", "gcp.json": "{}" });
    expect(storeFromEnv({ bucket: "s3://b" }, { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" })).toBeInstanceOf(S3Client);
    const gcs = storeFromEnv({ bucket: "gs://acme-reports" }, { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "gcp.json") });
    expect(gcs).toBeInstanceOf(GcsClient);
    expect(gcs.location).toBe("gs://acme-reports");
    const az = storeFromEnv({ bucket: "az://acmereports/terragucci" }, { ARM_TENANT_ID: "t", ARM_CLIENT_ID: "c", ARM_OIDC_TOKEN_FILE_PATH: join(dir, "token") });
    expect(az).toBeInstanceOf(AzureBlobClient);
    expect(az.location).toBe("az://acmereports/terragucci");
    expect(() => storeFromEnv({ bucket: "az://acmereports/terragucci" }, {})).toThrow(/give the job oidc.azure \(it sets ARM_TENANT_ID, ARM_CLIENT_ID and ARM_OIDC_TOKEN_FILE_PATH\), or set AZURE_STORAGE_KEY/);
    expect(() => storeFromEnv({ bucket: "gs://acme-reports" }, {})).toThrow(/give the job oidc.gcp \(it sets GOOGLE_APPLICATION_CREDENTIALS\)/);
    expect(() => storeFromEnv({ bucket: "gs://acme-reports", role: "arn:aws:iam::123456789012:role/r" }, {})).toThrow(/reports.role is an AWS role/);
  });
});

describe("Azure Blob Storage", () => {
  it("defaults the endpoint to the account's, an account key wins over OIDC, and AZURE_AUTHORITY_HOST moves Entra ID", () => {
    const oidc = { ARM_TENANT_ID: "tenant", ARM_CLIENT_ID: "client", ARM_OIDC_TOKEN_FILE_PATH: "/tmp/t" };
    expect(azureFromEnv({ account: "acme", container: "c" }, oidc)).toEqual({ account: "acme", container: "c", endpoint: "https://acme.blob.core.windows.net", oidc: { tenantId: "tenant", clientId: "client", tokenFile: "/tmp/t", authority: "https://login.microsoftonline.com" } });
    expect(azureFromEnv({ account: "acme", container: "c" }, { ...oidc, AZURE_AUTHORITY_HOST: "https://login.microsoftonline.us/" })).toMatchObject({ oidc: { authority: "https://login.microsoftonline.us" } });
    expect(azureFromEnv({ account: "devstoreaccount1", container: "c", endpoint: "http://azurite:10000/devstoreaccount1/" }, { ...oidc, AZURE_STORAGE_KEY: "k" })).toEqual({ account: "devstoreaccount1", container: "c", endpoint: "http://azurite:10000/devstoreaccount1", accountKey: "k" });
  });

  it("signs Shared Key over the documented string-to-sign, with the emulator's path and the query on lines of their own", () => {
    const headers = { "x-ms-date": "Wed, 07 Oct 2026 12:00:00 GMT", "x-ms-version": AZURE_VERSION, "x-ms-blob-type": "BlockBlob", "content-type": "application/json", "content-length": "2", "if-none-match": "*" };
    const auth = sharedKey("devstoreaccount1", AZURITE_KEY, "PUT", "http://azurite:10000/devstoreaccount1/reports/a/index.json?comp=x&B=2", headers);
    const toSign = [
      "PUT", "", "", "2", "", "application/json", "", "", "", "*", "", "",
      "x-ms-blob-type:BlockBlob",
      "x-ms-date:Wed, 07 Oct 2026 12:00:00 GMT",
      `x-ms-version:${AZURE_VERSION}`,
      "/devstoreaccount1/devstoreaccount1/reports/a/index.json",
      "b:2",
      "comp:x",
    ].join("\n");
    expect(auth).toBe(`SharedKey devstoreaccount1:${createHmac("sha256", Buffer.from(AZURITE_KEY, "base64")).update(toSign).digest("base64")}`);
    // A zero length is signed as empty.
    expect(sharedKey("a", AZURITE_KEY, "PUT", "https://a.blob.core.windows.net/c/k", { "content-length": "0" })).toBe(sharedKey("a", AZURITE_KEY, "PUT", "https://a.blob.core.windows.net/c/k", {}));
  });

  it("a SAS is the 2020-12-06 layout: a service SAS with the account key, a user delegation SAS with the key's fields", () => {
    const at = { account: "acme", container: "terragucci", endpoint: "https://acme.blob.core.windows.net" };
    const se = new Date("2026-10-08T12:00:00Z");
    const service = new URLSearchParams(blobSas(at, "reports/estate.html", se, { accountKey: AZURITE_KEY }));
    expect(Object.fromEntries([...service].filter(([k]) => k !== "sig"))).toEqual({ sv: AZURE_VERSION, sr: "b", sp: "r", se: "2026-10-08T12:00:00Z", spr: "https" });
    const serviceSign = ["r", "", "2026-10-08T12:00:00Z", "/blob/acme/terragucci/reports/estate.html", "", "", "https", AZURE_VERSION, "b", "", "", "", "", "", "", ""].join("\n");
    expect(service.get("sig")).toBe(createHmac("sha256", Buffer.from(AZURITE_KEY, "base64")).update(serviceSign).digest("base64"));

    const key = { oid: "oid-1", tid: "tid-1", start: "2026-10-07T12:00:00Z", expiry: "2026-10-08T12:00:00Z", service: "b", version: AZURE_VERSION, value: Buffer.from("delegation").toString("base64") };
    const ud = new URLSearchParams(blobSas(at, "reports/estate.html", se, { key }));
    expect(Object.fromEntries([...ud].filter(([k]) => k !== "sig"))).toEqual({ sv: AZURE_VERSION, sr: "b", sp: "r", se: "2026-10-08T12:00:00Z", spr: "https", skoid: "oid-1", sktid: "tid-1", skt: key.start, ske: key.expiry, sks: "b", skv: AZURE_VERSION });
    const udSign = ["r", "", "2026-10-08T12:00:00Z", "/blob/acme/terragucci/reports/estate.html", "oid-1", "tid-1", key.start, key.expiry, "b", AZURE_VERSION, "", "", "", "", "https", AZURE_VERSION, "b", "", "", "", "", "", "", ""].join("\n");
    expect(udSign.split("\n")).toHaveLength(24);
    expect(ud.get("sig")).toBe(createHmac("sha256", Buffer.from("delegation")).update(udSign).digest("base64"));
    // Over plain http (an emulator) the link names no protocol.
    expect(new URLSearchParams(blobSas({ ...at, endpoint: "http://azurite:10000/acme" }, "k", se, { accountKey: AZURITE_KEY })).get("spr")).toBeNull();
  });

  it("with the job's OIDC identity: one client assertion at Entra ID, a bearer on every request, and a user delegation key for the link", async () => {
    const dir = tmp();
    write(dir, { token: "forge-oidc-token\n" });
    const store = bucket((q) => (q.url.startsWith("https://acme.blob.core.windows.net/terragucci/") ? decodeURIComponent(new URL(q.url).pathname.slice("/terragucci/".length)) : undefined), "etag");
    const fake: StoreFetch = async (url, init) => {
      if (url === "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token") {
        const form = new URLSearchParams(init.body as string);
        expect(Object.fromEntries(form)).toEqual({ client_id: "client-1", scope: "https://storage.azure.com/.default", grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", client_assertion: "forge-oidc-token" });
        return { ok: true, status: 200, text: async () => JSON.stringify({ token_type: "Bearer", access_token: "storage-token", expires_in: 3599 }) };
      }
      if (url === "https://acme.blob.core.windows.net/?restype=service&comp=userdelegationkey") {
        expect(init.headers.authorization).toBe("Bearer storage-token");
        expect(init.body).toBe('<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>2026-10-07T12:00:00Z</Start><Expiry>2026-10-07T13:00:00Z</Expiry></KeyInfo>');
        return { ok: true, status: 200, text: async () => `<?xml version="1.0" encoding="utf-8"?><UserDelegationKey><SignedOid>oid-1</SignedOid><SignedTid>tenant-1</SignedTid><SignedStart>2026-10-07T12:00:00Z</SignedStart><SignedExpiry>2026-10-07T13:00:00Z</SignedExpiry><SignedService>b</SignedService><SignedVersion>${AZURE_VERSION}</SignedVersion><Value>${Buffer.from("k").toString("base64")}</Value></UserDelegationKey>` };
      }
      expect(init.headers.authorization).toBe("Bearer storage-token");
      expect(init.headers["x-ms-version"]).toBe(AZURE_VERSION);
      return store.fetch(url, init);
    };
    const client = new AzureBlobClient(azureFromEnv({ account: "acme", container: "terragucci" }, { ARM_TENANT_ID: "tenant-1", ARM_CLIENT_ID: "client-1", ARM_OIDC_TOKEN_FILE_PATH: join(dir, "token") }), fake);
    const report = buildReport({ run: RUN, roots: smallFixture() });
    const out = tmp();
    writeReportDir(out, report, new Map());
    const up = await uploadReport(client, out, report, "reports", async () => {});
    expect(store.objects.get(`${up.prefix}/report.json`)?.body).toContain(RUN.commit);
    expect(JSON.parse(store.objects.get("reports/index.json")!.body).reports).toHaveLength(1);
    const put = store.seen.find((q) => q.url.endsWith("/report.html"))!;
    expect(put.headers["x-ms-blob-type"]).toBe("BlockBlob");
    expect(put.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(put.headers["content-length"]).toBe(String(Buffer.byteLength(put.body!)));
    // The index is written on the ETag it was read with, or only if it is still absent.
    const indexPuts = store.seen.filter((q) => q.method === "PUT" && q.url.endsWith("/reports/index.json"));
    expect(indexPuts[0].headers["if-none-match"]).toBe("*");

    const link = await client.presign("reports/estate.html", 3600, new Date("2026-10-07T12:00:00.250Z"));
    expect(link.expires.toISOString()).toBe("2026-10-07T13:00:00.000Z");
    const q = new URL(link.url);
    expect(`${q.origin}${q.pathname}`).toBe("https://acme.blob.core.windows.net/terragucci/reports/estate.html");
    expect(q.searchParams.get("skoid")).toBe("oid-1");
    expect(q.searchParams.get("sp")).toBe("r");
  });

  it("a write that lost is a conflict, so the index is read again; a refused token names Entra ID's error", async () => {
    const store = bucket((q) => decodeURIComponent(new URL(q.url).pathname.slice("/devstoreaccount1/reports/".length)), "etag");
    const client = new AzureBlobClient({ account: "devstoreaccount1", container: "reports", endpoint: "http://azurite:10000/devstoreaccount1", accountKey: AZURITE_KEY }, store.fetch);
    await client.put("index.json", "{}", "application/json");
    await expect(client.put("index.json", "{}", "application/json", { ifNoneMatch: "*" })).rejects.toThrow(StoreConflict);
    await expect(client.put("index.json", "{}", "application/json", { ifMatch: '"0x99"' })).rejects.toThrow(StoreConflict);
    const { etag } = await updateIndex(client, "index.json", indexEntry(buildReport({ run: RUN, roots: smallFixture() }), "x"), async () => {});
    expect(etag).toBe('"0x2"');
    expect(store.seen.every((q) => q.headers.authorization.startsWith("SharedKey devstoreaccount1:"))).toBe(true);

    const dir = tmp();
    write(dir, { token: "t" });
    const refused = new AzureBlobClient(azureFromEnv({ account: "acme", container: "c" }, { ARM_TENANT_ID: "t", ARM_CLIENT_ID: "c1", ARM_OIDC_TOKEN_FILE_PATH: join(dir, "token") }), recorder(() => ({ status: 400, body: JSON.stringify({ error: "invalid_client", error_description: "AADSTS700213: No matching federated identity record found.\r\nTrace ID: x" }) })).fetch);
    await expect(refused.get("index.json")).rejects.toThrow("Entra ID refused the OIDC token for client c1: 400 invalid_client: AADSTS700213: No matching federated identity record found.");
  });
});

describe("Google Cloud Storage", () => {
  it("builds the V4 canonical request and string-to-sign of Google's conformance tests (googleapis/conformance-tests, storage/v1, Emulator host)", async () => {
    let signed = "";
    const url = await signedUrl("https://xyz.googleapis.com", "test-bucket", "test-object", GCS_KEY.client_email, 10, new Date("2019-02-01T09:00:00Z"), async (s) => {
      signed = s;
      return Buffer.from("ab", "hex");
    });
    expect(signed).toBe("GOOG4-RSA-SHA256\n20190201T090000Z\n20190201/auto/storage/goog4_request\n4f6f519cc03e25d19fcd476d7a45bffcccdba33d10e00214a0f2debc204e2386");
    expect(url).toBe(
      "https://xyz.googleapis.com/test-bucket/test-object?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=test-iam-credentials%40dummy-project-id.iam.gserviceaccount.com%2F20190201%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20190201T090000Z&X-Goog-Expires=10&X-Goog-SignedHeaders=host&X-Goog-Signature=ab",
    );
  });

  it("with the job's OIDC identity: STS, then the service account, then the JSON API on generations; the link is signed through signBlob", async () => {
    const dir = tmp();
    write(dir, {
      token: "forge-oidc-token\n",
      "creds.json": JSON.stringify({
        type: "external_account",
        audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/f",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/plan@acme.iam.gserviceaccount.com:generateAccessToken",
        credential_source: { file: join(dir, "token") },
      }),
    });
    const store = bucket((q) => {
      const u = new URL(q.url);
      if (u.origin !== "https://storage.googleapis.com") return undefined;
      if (q.method === "POST") return u.pathname === "/upload/storage/v1/b/acme-reports/o" && u.searchParams.get("uploadType") === "media" ? u.searchParams.get("name")! : undefined;
      const m = /^\/storage\/v1\/b\/acme-reports\/o\/([^/]+)$/.exec(u.pathname);
      return m && u.searchParams.get("alt") === "media" ? decodeURIComponent(m[1]) : undefined;
    }, "generation");
    let sts = 0;
    const fake: StoreFetch = async (url, init) => {
      const ok = (body: object) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (url === "https://sts.googleapis.com/v1/token") {
        sts++;
        const form = Object.fromEntries(new URLSearchParams(init.body as string));
        expect(form).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/f", scope: "https://www.googleapis.com/auth/cloud-platform", requested_token_type: "urn:ietf:params:oauth:token-type:access_token", subject_token: "forge-oidc-token", subject_token_type: "urn:ietf:params:oauth:token-type:jwt" });
        return ok({ access_token: "federated", expires_in: 3600, token_type: "Bearer" });
      }
      if (url.endsWith(":generateAccessToken")) {
        expect(init.headers.authorization).toBe("Bearer federated");
        return ok({ accessToken: "sa-token", expireTime: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (url === "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/plan%40acme.iam.gserviceaccount.com:signBlob") {
        expect(init.headers.authorization).toBe("Bearer sa-token");
        const { createSign } = await import("node:crypto");
        const payload = Buffer.from(JSON.parse(init.body as string).payload, "base64").toString("utf-8");
        return ok({ keyId: "k", signedBlob: createSign("RSA-SHA256").update(payload).sign(GCS_KEY.private_key).toString("base64") });
      }
      expect(init.headers.authorization).toBe("Bearer sa-token");
      return store.fetch(url, init);
    };
    const client = new GcsClient(gcsFromEnv({ bucket: "acme-reports" }, { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "creds.json") }), fake);
    const report = buildReport({ run: RUN, roots: smallFixture() });
    const out = tmp();
    writeReportDir(out, report, new Map());
    const up = await uploadReport(client, out, report, "reports", async () => {});
    expect(store.objects.get(`${up.prefix}/report.html`)?.body).toContain("<!doctype html>");
    expect(JSON.parse(store.objects.get("reports/forgejo.example/acme/infra/index.json")!.body).reports).toHaveLength(1);
    expect(sts).toBe(1);
    // The first index write is only-if-absent; the page that follows checks the generation it wrote.
    const first = store.seen.find((q) => q.method === "POST" && new URL(q.url).searchParams.get("name") === "reports/index.json")!;
    expect(new URL(first.url).searchParams.get("ifGenerationMatch")).toBe("0");

    const link = await client.presign("reports/estate.html", 600, new Date("2026-10-07T12:00:00Z"));
    const u = new URL(link.url);
    expect(`${u.origin}${u.pathname}`).toBe("https://storage.googleapis.com/acme-reports/reports/estate.html");
    expect(u.searchParams.get("X-Goog-Credential")).toBe("plan@acme.iam.gserviceaccount.com/20261007/auto/storage/goog4_request");
    expect(link.expires.toISOString()).toBe("2026-10-07T12:10:00.000Z");
    // The signature verifies with the service account's public key.
    const query = u.search.slice(1).replace(/&X-Goog-Signature=.*$/, "");
    const canonical = ["GET", u.pathname, query, `host:${u.host}`, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
    const { createHash } = await import("node:crypto");
    const toSign = ["GOOG4-RSA-SHA256", "20261007T120000Z", "20261007/auto/storage/goog4_request", createHash("sha256").update(canonical).digest("hex")].join("\n");
    expect(createVerify("RSA-SHA256").update(toSign).verify(createPublicKey(GCS_KEY.private_key), Buffer.from(u.searchParams.get("X-Goog-Signature")!, "hex"))).toBe(true);
  });

  it("with a service account key, requests carry a self-signed JWT and the link is signed with the key; a lost write is a conflict", async () => {
    const dir = tmp();
    write(dir, { "key.json": JSON.stringify(GCS_KEY) });
    const store = bucket((q) => {
      const u = new URL(q.url);
      return q.method === "POST" ? (u.searchParams.get("name") ?? undefined) : decodeURIComponent(u.pathname.split("/o/")[1] ?? "");
    }, "generation");
    const client = new GcsClient(gcsFromEnv({ bucket: "b", endpoint: "http://gcs:4443/" }, { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "key.json") }), store.fetch);
    expect((await client.put("a/index.json", "{}", "application/json")).etag).toBe("1");
    await expect(client.put("a/index.json", "{}", "application/json", { ifNoneMatch: "*" })).rejects.toThrow(StoreConflict);
    await expect(client.put("a/index.json", "{}", "application/json", { ifMatch: "7" })).rejects.toThrow(StoreConflict);
    expect(await client.read("a/index.json")).toEqual({ body: "{}", etag: "1" });
    expect(store.seen[0].url).toBe("http://gcs:4443/upload/storage/v1/b/b/o?uploadType=media&name=a%2Findex.json");
    expect(store.seen.at(-1)!.url).toBe("http://gcs:4443/storage/v1/b/b/o/a%2Findex.json?alt=media");
    const jwt = store.seen[0].headers.authorization.replace(/^Bearer /, "").split(".");
    const claims = JSON.parse(Buffer.from(jwt[1], "base64url").toString("utf-8"));
    expect(claims).toMatchObject({ iss: GCS_KEY.client_email, sub: GCS_KEY.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_write" });
    expect(createVerify("RSA-SHA256").update(`${jwt[0]}.${jwt[1]}`).verify(createPublicKey(GCS_KEY.private_key), Buffer.from(jwt[2], "base64url"))).toBe(true);
    const link = await client.presign("a/estate.html", 60, new Date("2026-10-07T12:00:00Z"));
    expect(link.url).toMatch(/^http:\/\/gcs:4443\/b\/a\/estate\.html\?X-Goog-Algorithm=GOOG4-RSA-SHA256&.*&X-Goog-Signature=[0-9a-f]{512}$/);
  });

  it("a credentials file that impersonates no service account writes, but cannot sign a link", async () => {
    const dir = tmp();
    write(dir, { token: "t", "c.json": JSON.stringify({ type: "external_account", audience: "a", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", credential_source: { file: join(dir, "token") } }) });
    const client = new GcsClient(gcsFromEnv({ bucket: "b" }, { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "c.json") }), recorder(() => ({ status: 200 })).fetch);
    await expect(client.presign("k", 60)).rejects.toThrow(/impersonates none/);
  });
});

describe("estate on Azure and GCS", () => {
  it("writes the page to an Azure container and prints a SAS link", async () => {
    const store = bucket((q) => decodeURIComponent(new URL(q.url).pathname.slice("/devstoreaccount1/reports/".length)), "etag");
    const report = buildReport({ run: RUN, roots: smallFixture() });
    const out = tmp();
    writeReportDir(out, report, new Map());
    const env = { AZURE_STORAGE_KEY: AZURITE_KEY };
    const reports = { bucket: "az://devstoreaccount1/reports", endpoint: "http://azurite:10000/devstoreaccount1", prefix: "reports" };
    await uploadReport(storeFromEnv(reports, env, store.fetch), out, report, "reports", async () => {});
    const r = await estate(tmp(), { reports }, { env, fetch: store.fetch, now: new Date("2026-10-07T12:00:00Z") });
    expect(r.estate.projects.map((p) => p.project)).toEqual(["forgejo.example/acme/infra"]);
    expect(store.objects.has("reports/estate.html")).toBe(true);
    expect(r.link?.url).toMatch(/^http:\/\/azurite:10000\/devstoreaccount1\/reports\/reports\/estate\.html\?sv=2021-08-06&sr=b&sp=r&se=2026-10-08T12%3A00%3A00Z&sig=/);
  });
});
