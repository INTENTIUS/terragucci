import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendLifecycle } from "../src/apply";
import { stateObject, stateStore, stateVersion, type StoredState } from "../src/backend";
import { EXPORT_DONE, EXPORT_LEDGER, exportState } from "../src/export";
import type { Fetch } from "../src/forge";
import { MIGRATE_DONE, MIGRATE_LEDGER, OVERRIDE_FILE, revertMigration, runMigrations, type BinaryExec, type StateFile, type StateResource } from "../src/migrate";
import type { StoreFetch } from "../src/report/object-store";
import { lockDigest, UNLOCK_DONE, UNLOCK_LEDGER, unlockState, type UnlockOptions } from "../src/unlock";
import { tmp, write } from "./helpers";

const T = (m: number): string => new Date(Date.UTC(2026, 9, 9, 12, m)).toISOString();
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const res = (name: string): StateResource => ({ mode: "managed", type: "terraform_data", name, provider: 'provider["terraform.io/builtin/terraform"]', instances: [{ attributes: { id: name, input: `secret-${name}` } }] });
const state = (lineage: string, serial: number, names: string[]): StateFile => ({ version: 4, terraform_version: "1.13.1", serial, lineage, outputs: {}, resources: names.map(res), check_results: null });
const lockText = (id: string, created: string, path: string) => JSON.stringify({ ID: id, Operation: "OperationTypeApply", Info: "", Who: "runner@job-1", Version: "1.13.1", Created: created, Path: path });

type Answer = Awaited<ReturnType<StoreFetch>>;
const answer = (status = 200, body = "", headers: Record<string, string> = {}): Answer => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ok: status < 300, status, text: async () => body, headers: { get: (n: string) => h[n.toLowerCase()] ?? null, forEach: (fn: (v: string, k: string) => void) => Object.entries(h).forEach(([k, v]) => fn(v, k)) } as Answer["headers"] };
};

/**
 * GCS's JSON API in memory, at http://gcs.test: objects by generation, with
 * object versioning on unless `versioning` is false, a write conditional on
 * ifGenerationMatch, and the requests each call made.
 */
function fakeGcs(versioning = true) {
  const objects = new Map<string, { generation: string; body: string }[]>();
  let n = 1000;
  const seen: { method: string; url: string; auth?: string }[] = [];
  const put = (key: string, body: string): string => {
    const generation = String(++n);
    const kept = versioning ? (objects.get(key) ?? []) : [];
    objects.set(key, [...kept, { generation, body }]);
    return generation;
  };
  const latest = (key: string) => objects.get(key)?.at(-1);
  const fetch: StoreFetch = async (url, init) => {
    seen.push({ method: init.method, url, auth: init.headers.authorization });
    const u = new URL(url);
    const gen = u.searchParams.get("generation");
    let m = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(u.pathname);
    if (m && init.method === "POST") {
      const key = `${m[1]}/${u.searchParams.get("name")}`;
      const cond = u.searchParams.get("ifGenerationMatch");
      if (cond !== null && (latest(key)?.generation ?? "0") !== cond) return answer(412);
      return answer(200, JSON.stringify({ generation: put(key, String(init.body)) }));
    }
    m = /^\/storage\/v1\/b\/([^/]+)$/.exec(u.pathname);
    if (m) return answer(200, JSON.stringify({ versioning: { enabled: versioning } }));
    m = /^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(u.pathname);
    if (!m) return answer(404);
    const key = `${m[1]}/${decodeURIComponent(m[2]!)}`;
    if (init.method === "DELETE") {
      if (!objects.has(key)) return answer(404);
      objects.delete(key);
      return answer(204);
    }
    const found = gen ? objects.get(key)?.find((o) => o.generation === gen) : latest(key);
    if (!found) return answer(404);
    if (u.searchParams.get("alt") === "media") return answer(200, found.body, { "x-goog-generation": found.generation });
    return answer(200, JSON.stringify({ name: m[2], generation: found.generation }));
  };
  return { objects, put, latest, fetch, seen };
}

/**
 * Azure Blob Storage in memory, at https://acme.blob.core.windows.net: blobs
 * with snapshots (and version ids when `versions`), leases and metadata, a
 * write refused without the lease that holds the blob.
 */
function fakeAzure(versions = false) {
  type Blob = { body: string; meta: Record<string, string>; lease?: string; snapshots: { id: string; body: string }[]; versions: { id: string; body: string }[] };
  const blobs = new Map<string, Blob>();
  let n = 0;
  const stamp = (): string => `2026-10-09T12:00:${String(++n).padStart(2, "0")}.0000000Z`;
  const seen: { method: string; url: string }[] = [];
  const write = (key: string, body: string, meta: Record<string, string> = {}): string => {
    const b = blobs.get(key);
    const id = stamp();
    blobs.set(key, { body, meta, ...(b?.lease ? { lease: b.lease } : {}), snapshots: b?.snapshots ?? [], versions: [...(b?.versions ?? []), { id, body }] });
    return id;
  };
  const fetch: StoreFetch = async (url, init) => {
    seen.push({ method: init.method, url });
    const u = new URL(url);
    if (u.host !== "acme.blob.core.windows.net") return answer(404);
    const key = decodeURIComponent(u.pathname.slice(1));
    const h = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const comp = u.searchParams.get("comp");
    const b = blobs.get(key);
    const meta = (): Record<string, string> => Object.fromEntries(Object.entries(h).filter(([k]) => k.startsWith("x-ms-meta-")).map(([k, v]) => [k.slice(10), v]));
    if (init.method === "PUT" && comp === "lease") {
      if (!b) return answer(404);
      if (h["x-ms-lease-action"] === "acquire") {
        if (b.lease) return answer(409);
        b.lease = h["x-ms-proposed-lease-id"];
        return answer(201);
      }
      if (b.lease !== h["x-ms-lease-id"]) return answer(409);
      delete b.lease;
      return answer(200);
    }
    if (init.method === "PUT" && comp === "snapshot") {
      if (!b) return answer(404);
      const id = stamp();
      b.snapshots.push({ id, body: b.body });
      return answer(201, "", { "x-ms-snapshot": id });
    }
    if (init.method === "PUT" && comp === "metadata") {
      if (!b) return answer(404);
      if (b.lease && b.lease !== h["x-ms-lease-id"]) return answer(412);
      b.meta = meta();
      return answer(200);
    }
    if (init.method === "PUT") {
      if (h["if-none-match"] === "*" && b) return answer(409);
      if (b?.lease && b.lease !== h["x-ms-lease-id"]) return answer(412);
      const id = write(key, String(init.body), meta());
      return answer(201, "", versions ? { "x-ms-version-id": id } : {});
    }
    const snap = u.searchParams.get("snapshot");
    const ver = u.searchParams.get("versionid");
    if (!b) return answer(404);
    const at = snap ? b.snapshots.find((s) => s.id === snap) : ver ? b.versions.find((v) => v.id === ver) : { body: b.body };
    if (!at) return answer(404);
    const headers: Record<string, string> = {
      etag: `"${b.body.length}"`,
      "x-ms-lease-state": b.lease ? "leased" : "available",
      ...(versions && !snap ? { "x-ms-version-id": ver ?? b.versions.at(-1)!.id } : {}),
      ...Object.fromEntries(Object.entries(b.meta).map(([k, v]) => [`x-ms-meta-${k}`, v])),
    };
    return answer(200, init.method === "HEAD" ? "" : at.body, headers);
  };
  return { blobs, write, fetch, seen };
}

/** A root whose `.terraform` records `type` and `config`, as init leaves it. */
const initialised = (type: string, config: Record<string, unknown>): string => write(tmp(), { ".terraform/terraform.tfstate": JSON.stringify({ version: 3, backend: { type, config } }) });

const GCS = { bucket: "acme-state", prefix: "envs/dev/app", storage_custom_endpoint: "http://gcs.test/storage/v1/", access_token: "backend-token" };
const AZ = { storage_account_name: "acme", container_name: "tfstate", key: "app.tfstate", access_key: Buffer.from("key").toString("base64") };

describe("where a gcs or azurerm root's state is", () => {
  it("names a gcs state <prefix>/<workspace>.tfstate, its lock beside it, with the backend's own credentials first", () => {
    const o = stateObject(initialised("gcs", GCS), { GOOGLE_APPLICATION_CREDENTIALS: "/job/creds.json" });
    expect(o).toMatchObject({ backend: "gcs", bucket: "acme-state", key: "envs/dev/app/default.tfstate", lock: "envs/dev/app/default.tflock", target: { endpoint: "http://gcs.test", accessToken: "backend-token" } });
    const blue = stateObject(initialised("gcs", { bucket: "b", prefix: "p/" }), { TF_WORKSPACE: "blue", GOOGLE_APPLICATION_CREDENTIALS: "/job/creds.json" });
    expect(blue).toMatchObject({ key: "p/blue.tfstate", lock: "p/blue.tflock", target: { endpoint: "https://storage.googleapis.com", credentialsFile: "/job/creds.json" } });
    expect(stateObject(initialised("gcs", { bucket: "b" }), { GOOGLE_CREDENTIALS: '{"type":"service_account"}' })).toMatchObject({ key: "default.tfstate", target: { credentialsJson: '{"type":"service_account"}' } });
    expect(stateObject(initialised("gcs", { bucket: "b", impersonate_service_account: "sa@p.iam.gserviceaccount.com" }), { GOOGLE_OAUTH_ACCESS_TOKEN: "t" })).toMatchObject({ target: { accessToken: "t", impersonate: "sa@p.iam.gserviceaccount.com" } });
    expect(stateObject(initialised("gcs", { bucket: "b" }), {})).toMatchObject({ backend: "gcs", unsupported: expect.stringContaining("give the job oidc.gcp") });
  });

  it("names an azurerm blob by its key, <key>env:<workspace> in another workspace, at the cloud's endpoint, with the key, a SAS or the job's OIDC identity", () => {
    expect(stateObject(initialised("azurerm", AZ), {})).toMatchObject({ backend: "azurerm", account: "acme", container: "tfstate", key: "app.tfstate", endpoint: "https://acme.blob.core.windows.net", auth: { accountKey: AZ.access_key } });
    expect(stateObject(initialised("azurerm", { ...AZ, access_key: null, environment: "usgovernment" }), { TF_WORKSPACE: "blue", ARM_SAS_TOKEN: "sv=x&sig=y" })).toMatchObject({ key: "app.tfstateenv:blue", endpoint: "https://acme.blob.core.usgovcloudapi.net", auth: { sas: "sv=x&sig=y" } });
    const oidc = { ARM_TENANT_ID: "tenant", ARM_CLIENT_ID: "client", ARM_OIDC_TOKEN_FILE_PATH: "/t" };
    expect(stateObject(initialised("azurerm", { ...AZ, access_key: null, metadata_host: "meta.test", snapshot: true }), oidc)).toMatchObject({ metadataHost: "meta.test", snapshot: true, auth: { oidc: { tenantId: "tenant", clientId: "client", tokenFile: "/t", authority: "https://login.microsoftonline.com" } } });
    expect(stateObject(initialised("azurerm", { ...AZ, access_key: null }), {})).toMatchObject({ unsupported: expect.stringContaining("give the job oidc.azure") });
    expect(stateObject(initialised("azurerm", { key: "k" }), {})).toMatchObject({ unsupported: expect.stringContaining("storage_account_name, container_name or key") });
  });
});

describe("the version a gcs or azurerm apply leaves", () => {
  it("is the gcs object's generation when the bucket keeps them, read from its metadata with the backend's token", async () => {
    const g = fakeGcs();
    const gen = g.put("acme-state/envs/dev/app/default.tfstate", "{}");
    expect(await stateVersion(initialised("gcs", GCS), {}, g.fetch)).toEqual({ backend: "gcs", location: "gs://acme-state/envs/dev/app/default.tfstate", version_id: gen, versioning: "on" });
    expect(g.seen.every((s) => s.method === "GET" && !s.url.includes("alt=media") && s.auth === "Bearer backend-token")).toBe(true);
  });

  it("says versions are off for a bucket without object versioning, and unknown when there is no state", async () => {
    const g = fakeGcs(false);
    g.put("acme-state/envs/dev/app/default.tfstate", "{}");
    expect(await stateVersion(initialised("gcs", GCS), {}, g.fetch)).toMatchObject({ versioning: "off", note: "object versioning is off for acme-state, so it keeps only the latest state" });
    expect(await stateVersion(initialised("gcs", { ...GCS, prefix: "none" }), {}, g.fetch)).toMatchObject({ versioning: "unknown", note: "the state object is not in the bucket" });
  });

  it("is the blob's version id when the account keeps versions, else a snapshot when the backend takes them, else off", async () => {
    const v = fakeAzure(true);
    const id = v.write("tfstate/app.tfstate", "{}");
    expect(await stateVersion(initialised("azurerm", AZ), {}, v.fetch)).toEqual({ backend: "azurerm", location: "az://acme/tfstate/app.tfstate", version_id: id, versioning: "on" });
    const s = fakeAzure();
    s.write("tfstate/app.tfstate", '{"serial":1}');
    const snap = await stateVersion(initialised("azurerm", { ...AZ, snapshot: true }), {}, s.fetch);
    expect(snap).toMatchObject({ versioning: "on", version_id: s.blobs.get("tfstate/app.tfstate")!.snapshots[0]!.id });
    expect(await stateVersion(initialised("azurerm", AZ), {}, s.fetch)).toMatchObject({ versioning: "off", note: expect.stringContaining("takes no snapshots (snapshot = true)") });
  });

  it("finds the account's endpoint through the cloud's metadata when the backend names a metadata_host", async () => {
    const s = fakeAzure(true);
    s.write("tfstate/app.tfstate", "{}");
    const fetch: StoreFetch = async (url, init) => (url.startsWith("https://meta.test/metadata/endpoints?") ? answer(200, JSON.stringify({ suffixes: { storage: "blob.core.windows.net".slice(5) } })) : s.fetch(url, init));
    expect(await stateVersion(initialised("azurerm", { ...AZ, metadata_host: "meta.test" }), {}, fetch)).toMatchObject({ versioning: "on" });
  });
});

describe("a gcs or azurerm state's lock", () => {
  it("is the gcs lock object, whose generation is the ID force-unlock takes; a migration takes it only when there is none", async () => {
    const g = fakeGcs();
    const store = await stateStore(stateObject(initialised("gcs", GCS), {}) as StoredState, g.fetch);
    expect(store.lockLocation).toBe("gs://acme-state/envs/dev/app/default.tflock");
    expect(await store.heldLock()).toBeUndefined();
    const gen = g.put("acme-state/envs/dev/app/default.tflock", lockText("uuid-1", T(1), "gs://acme-state/envs/dev/app/default.tflock"));
    expect(await store.heldLock()).toMatchObject({ id: gen });
    expect(await store.lock(lockText("mine", T(2), "x"))).toBe(false);
    g.objects.delete("acme-state/envs/dev/app/default.tflock");
    expect(await store.lock(lockText("mine", T(2), "x"))).toBe(true);
    expect(g.seen.some((s) => s.url.includes("ifGenerationMatch=0"))).toBe(true);
    await store.unlock();
    expect(g.objects.has("acme-state/envs/dev/app/default.tflock")).toBe(false);
  });

  it("is the azurerm blob's lease, with the lock info in its metadata, and a write under the lease snapshots first when the backend takes snapshots", async () => {
    const s = fakeAzure();
    const store = await stateStore(stateObject(initialised("azurerm", { ...AZ, snapshot: true }), {}) as StoredState, s.fetch);
    // No blob yet: an empty one is made to lease, as the backend makes it.
    expect(await store.lock(lockText("lease-1", T(1), "az"))).toBe(true);
    const blob = s.blobs.get("tfstate/app.tfstate")!;
    expect(blob.lease).toBe("lease-1");
    expect(JSON.parse(Buffer.from(blob.meta.terraformlockid!, "base64").toString())).toMatchObject({ ID: "lease-1" });
    expect(await store.heldLock()).toMatchObject({ id: "lease-1" });
    await store.write!('{"serial":2}');
    expect(blob.snapshots).toHaveLength(1);
    expect(s.blobs.get("tfstate/app.tfstate")!.body).toBe('{"serial":2}');
    await store.unlock();
    expect(s.blobs.get("tfstate/app.tfstate")!.lease).toBeUndefined();
    expect(await store.heldLock()).toBeUndefined();
  });
});

/** A clone with one root, app, initialised with `backend`, and a bare origin for chant/lifecycle. */
function repo(backend: { type: string; config: Record<string, unknown> }, files: Record<string, string> = {}) {
  const dir = tmp("tg-stores-");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", origin);
  const work = join(dir, "work");
  mkdirSync(work);
  write(work, { "app/main.tf": 'resource "terraform_data" "x" {}\n', "terragucci.yml": "binary: tofu\nforge: forgejo\nurl: http://forge.test/o/r\n", ...files });
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  const init = (d: string, env: NodeJS.ProcessEnv): void => {
    const data = env.TF_DATA_DIR ? (isAbsolute(env.TF_DATA_DIR) ? env.TF_DATA_DIR : join(d, env.TF_DATA_DIR)) : join(d, ".terraform");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "terraform.tfstate"), JSON.stringify({ version: 3, backend }));
  };
  return { work, origin, init, out: join(dir, "exports") };
}

const show = (origin: string, path: string): string => execFileSync("git", ["--git-dir", origin, "show", `chant/lifecycle:${path}`], { encoding: "utf-8" });

describe("terragucci state export of a gcs or azurerm state", () => {
  it("asks for a gcs generation and, once someone else approved it, writes that generation", async () => {
    const g = fakeGcs();
    const v1 = g.put("acme-state/envs/dev/app/default.tfstate", JSON.stringify(state("L", 1, ["a"])));
    g.put("acme-state/envs/dev/app/default.tfstate", JSON.stringify(state("L", 2, ["a", "b"])));
    const r = repo({ type: "gcs", config: GCS });
    const exec: BinaryExec = async (_b, args, d, env) => (args[0] === "init" ? (r.init(d, env), { code: 0, stdout: "", out: "" }) : { code: 1, stdout: "", out: "" });
    const opts = { root: "app", version: v1, actor: "alice", env: {}, exec, fetch: g.fetch, log: () => {} };
    const ask = await exportState(r.work, { ...opts, now: T(0) });
    expect(ask.code).toBe(3);
    appendLifecycle(r.work, EXPORT_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-state-export", gate: "app", resolvedBy: "bob", timestamp: T(1), planDigest: ask.digest })], {}, "approve");
    mkdirSync(r.out);
    const got = await exportState(r.work, { ...opts, now: T(2), out: join(r.out, "app.tfstate") });
    expect(got.code).toBe(0);
    expect(JSON.parse(readFileSync(join(r.out, "app.tfstate"), "utf-8")).serial).toBe(1);
    expect(JSON.parse(show(r.origin, EXPORT_DONE))).toMatchObject({ location: "gs://acme-state/envs/dev/app/default.tfstate", version_id: v1, exportedBy: "alice", approvedBy: "bob" });
  });

  it("names an azurerm state with no blob versions by a snapshot it takes, and refuses one that keeps neither", async () => {
    const s = fakeAzure();
    s.write("tfstate/app.tfstate", JSON.stringify(state("L", 3, ["a"])));
    const r = repo({ type: "azurerm", config: { ...AZ, snapshot: true } });
    const exec: BinaryExec = async (_b, args, d, env) => (args[0] === "init" ? (r.init(d, env), { code: 0, stdout: "", out: "" }) : { code: 1, stdout: "", out: "" });
    const ask = await exportState(r.work, { root: "app", actor: "alice", env: {}, exec, fetch: s.fetch, log: () => {}, now: T(0) });
    expect(ask.code).toBe(3);
    const snap = s.blobs.get("tfstate/app.tfstate")!.snapshots[0]!.id;
    expect(JSON.parse(show(r.origin, EXPORT_LEDGER).trim())).toMatchObject({ request: { location: "az://acme/tfstate/app.tfstate", version_id: snap } });
    const plain = repo({ type: "azurerm", config: AZ });
    const exec2: BinaryExec = async (_b, args, d, env) => (args[0] === "init" ? (plain.init(d, env), { code: 0, stdout: "", out: "" }) : { code: 1, stdout: "", out: "" });
    await expect(exportState(plain.work, { root: "app", actor: "alice", env: {}, exec: exec2, fetch: s.fetch, log: () => {}, now: T(0) })).rejects.toThrow(/keeps no versions, so there is no version id to export: blob versioning is off for acme/);
  });
});

/** A forge with no live run. */
const quiet: Fetch = async () => ({ ok: true, status: 200, json: async () => ({ workflow_runs: [] }), text: async () => "{}" });

describe("unlock-state on a gcs or azurerm state", () => {
  it("binds the approval to a gcs lock's generation and force-unlocks that ID", async () => {
    const g = fakeGcs();
    const gen = g.put("acme-state/envs/dev/app/default.tflock", lockText("uuid-1", T(10), "gs://acme-state/envs/dev/app/default.tflock"));
    const r = repo({ type: "gcs", config: GCS });
    const unlocked: string[] = [];
    const exec: NonNullable<UnlockOptions["exec"]> = (_b, args, d) => {
      if (args[0] === "init") return r.init(d, {}), { status: 0, out: "" };
      if (args[0] === "force-unlock") {
        unlocked.push(args.at(-1)!);
        if (g.latest("acme-state/envs/dev/app/default.tflock")?.generation !== args.at(-1)) return { status: 1, out: "lock ID does not match" };
        g.objects.delete("acme-state/envs/dev/app/default.tflock");
        return { status: 0, out: "" };
      }
      return { status: 1, out: "" };
    };
    const opts = { env: { FORGEJO_TOKEN: "tok" }, exec, s3Fetch: g.fetch, fetch: quiet, log: () => {}, actor: "dana" };
    const wait = await unlockState(r.work, "app", { ...opts, now: T(20) });
    expect(wait).toMatchObject({ code: 3, location: "gs://acme-state/envs/dev/app/default.tflock", lock: { ID: gen, Who: "runner@job-1" } });
    expect(wait.digest).toBe(lockDigest("app", "gs://acme-state/envs/dev/app/default.tflock", gen));
    appendLifecycle(r.work, UNLOCK_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-unlock", gate: "app", resolvedBy: "lee", timestamp: T(21), planDigest: wait.digest })], {}, "approve");
    const done = await unlockState(r.work, "app", { ...opts, now: T(22) });
    expect(done.code).toBe(0);
    expect(unlocked).toEqual([gen]);
    expect(JSON.parse(show(r.origin, UNLOCK_DONE))).toMatchObject({ gate: "app", lock: { ID: gen }, approvedBy: "lee", releasedBy: "dana" });
  });

  it("reads an azurerm lock from the blob's lease and metadata, and checks the lease is gone after force-unlock", async () => {
    const s = fakeAzure();
    s.write("tfstate/app.tfstate", "{}", { terraformlockid: Buffer.from(lockText("lease-9", T(10), "az")).toString("base64") });
    s.blobs.get("tfstate/app.tfstate")!.lease = "lease-9";
    const r = repo({ type: "azurerm", config: AZ });
    let release = true;
    const exec: NonNullable<UnlockOptions["exec"]> = (_b, args, d) => {
      if (args[0] === "init") return r.init(d, {}), { status: 0, out: "" };
      if (args[0] === "force-unlock" && release) delete s.blobs.get("tfstate/app.tfstate")!.lease;
      return { status: 0, out: "" };
    };
    const opts = { env: { FORGEJO_TOKEN: "tok" }, exec, s3Fetch: s.fetch, fetch: quiet, log: () => {}, actor: "dana" };
    const wait = await unlockState(r.work, "app", { ...opts, now: T(20) });
    expect(wait).toMatchObject({ code: 3, location: "az://acme/tfstate/app.tfstate", lock: { ID: "lease-9" } });
    appendLifecycle(r.work, UNLOCK_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-unlock", gate: "app", resolvedBy: "lee", timestamp: T(21), planDigest: wait.digest })], {}, "approve");
    release = false;
    await expect(unlockState(r.work, "app", { ...opts, now: T(22) })).rejects.toThrow(/force-unlock ran, and az:\/\/acme\/tfstate\/app.tfstate is still locked/);
    release = true;
    expect((await unlockState(r.work, "app", { ...opts, now: T(23) })).code).toBe(0);
  });
});

describe("a migration between a gcs root and an azurerm root", () => {
  /** A binary whose roots keep their state in the fakes: one.json names gcs, two.json azurerm; an azurerm push under another's lease fails, as Azure refuses it. */
  function world(azureVersions = false) {
    const g = fakeGcs();
    const a = fakeAzure(azureVersions);
    const backends: Record<string, { type: string; config: Record<string, unknown> }> = {
      one: { type: "gcs", config: { ...GCS, prefix: "one" } },
      two: { type: "azurerm", config: { ...AZ, key: "two.tfstate", snapshot: true } },
    };
    const where = (dir: string) => (dir.endsWith("one") ? { gcs: "acme-state/one/default.tfstate" } : { az: "tfstate/two.tfstate" });
    const read = (dir: string): string | undefined => {
      const w = where(dir);
      return w.gcs ? g.latest(w.gcs)?.body : a.blobs.get(w.az!)?.body || undefined;
    };
    const exec: BinaryExec = async (_b, args, dir, env) => {
      const done = (stdout = "", out = stdout) => ({ code: 0, stdout, out });
      const override = join(dir, OVERRIDE_FILE);
      const local = env.TF_DATA_DIR && existsSync(override) ? /path = "(.*)"/.exec(readFileSync(override, "utf-8"))?.[1] : undefined;
      if (args[0] === "init") {
        const data = env.TF_DATA_DIR ? (isAbsolute(env.TF_DATA_DIR) ? env.TF_DATA_DIR : join(dir, env.TF_DATA_DIR)) : join(dir, ".terraform");
        mkdirSync(data, { recursive: true });
        writeFileSync(join(data, "terraform.tfstate"), JSON.stringify({ version: 3, backend: local ? { type: "local", config: { path: local } } : backends[dir.split("/").at(-1)!] }));
        return done();
      }
      if (args[0] === "state" && args[1] === "pull") return done(read(dir) ?? JSON.stringify(state("", 0, [])));
      if (args[0] === "state" && args[1] === "push") {
        const body = readFileSync(args.at(-1)!, "utf-8");
        const w = where(dir);
        if (w.gcs) g.put(w.gcs, body);
        else if (a.blobs.get(w.az!)?.lease) return { code: 1, stdout: "", out: "Error: lease is held" };
        else a.write(w.az!, body);
        return done();
      }
      if (args[0] === "plan") {
        const text = local ? (existsSync(local) ? readFileSync(local, "utf-8") : undefined) : read(dir);
        const held = text ? (JSON.parse(text) as StateFile).resources.map((r) => `${r.type}.${r.name}`) : [];
        const want = JSON.parse(readFileSync(join(dir, "want.json"), "utf-8")) as string[];
        const changes = [...want.filter((x) => !held.includes(x)).map((x) => ({ address: x, change: { actions: ["create"] } })), ...held.filter((x) => !want.includes(x)).map((x) => ({ address: x, change: { actions: ["delete"] } }))];
        writeFileSync(args.find((x) => x.startsWith("-out="))!.slice(5), JSON.stringify({ resource_changes: changes }));
        return done(changes.length ? `Plan: ${changes.length} to change.` : "No changes.");
      }
      if (args[0] === "show") return done(readFileSync(args[2]!, "utf-8"));
      return { code: 1, stdout: "", out: `unknown ${args.join(" ")}` };
    };
    const fetch: StoreFetch = async (url, init) => (url.startsWith("http://gcs.test") ? g.fetch(url, init) : a.fetch(url, init));
    return { g, a, exec, fetch };
  }

  function migrationRepo() {
    const dir = tmp("tg-stores-migrate-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    mkdirSync(work);
    write(work, { "one/main.tf": "", "one/want.json": JSON.stringify(["terraform_data.a", "terraform_data.b"]), "two/main.tf": "", "two/want.json": "[]" });
    git(work, "init", "-q", "-b", "main");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "base");
    write(work, { "one/want.json": JSON.stringify(["terraform_data.a"]), "two/want.json": JSON.stringify(["terraform_data.b"]), "migrations/split-b.yml": "moves:\n  - from: one\n    to: two\n    addresses: [terraform_data.b]\n" });
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "change");
    git(work, "remote", "add", "origin", origin);
    git(work, "push", "-q", "origin", "main");
    return { work, origin };
  }

  const approve = (work: string, digest: string, at: string) =>
    appendLifecycle(work, MIGRATE_LEDGER, [JSON.stringify({ version: 1, kind: "resolution", op: "tf-migrate", gate: "split-b", resolvedBy: "alice", timestamp: at, planDigest: digest })], {}, "approve");

  it("writes the gcs state with the binary under its lock object and the azurerm state under its lease, recording each version", async () => {
    const w = world();
    const before = w.g.put("acme-state/one/default.tfstate", JSON.stringify(state("L1", 4, ["a", "b"])));
    w.a.write("tfstate/two.tfstate", JSON.stringify(state("L2", 1, [])));
    const { work, origin } = migrationRepo();
    const opts = { binary: "tofu", exec: w.exec, fetch: w.fetch, env: {}, log: () => {} };
    const first = await runMigrations(work, { ...opts, now: T(1) });
    expect(first.code).toBe(3);
    expect(first.records[0]!.roots.map((r) => [r.root, r.location, r.before.version_id ?? null])).toEqual([
      ["one", "gs://acme-state/one/default.tfstate", before],
      ["two", "az://acme/tfstate/two.tfstate", null],
    ]);
    approve(work, first.records[0]!.digest, T(2));
    const second = await runMigrations(work, { ...opts, now: T(3) });
    expect(second.code).toBe(0);
    expect((JSON.parse(w.g.latest("acme-state/one/default.tfstate")!.body) as StateFile).resources.map((r) => r.name)).toEqual(["a"]);
    const two = w.a.blobs.get("tfstate/two.tfstate")!;
    expect((JSON.parse(two.body) as StateFile).resources.map((r) => r.name)).toEqual(["b"]);
    // Each lock let go: no lock object, no lease.
    expect(w.g.objects.has("acme-state/one/default.tflock")).toBe(false);
    expect(two.lease).toBeUndefined();
    expect(two.meta.terraformlockid).toBeUndefined();
    // The azurerm state's versions are its snapshots: the one before the write, and one of what it wrote.
    const line = JSON.parse(show(origin, MIGRATE_DONE));
    const rows = Object.fromEntries((line.roots as { root: string; before: string | null; after: string | null }[]).map((r) => [r.root, r]));
    expect(rows.one).toMatchObject({ before, after: w.g.latest("acme-state/one/default.tfstate")!.generation });
    expect(two.snapshots.map((s) => s.id)).toContain(rows.two!.before);
    expect(two.snapshots.find((s) => s.id === rows.two!.after)!.body).toBe(two.body);
    // And it can be put back, both states by the versions it recorded.
    expect(revertMigration("split-b", JSON.stringify(line)).text).toContain("location: az://acme/tfstate/two.tfstate");
  });

  it("refuses when the gcs state's lock is held, and writes nothing", async () => {
    const w = world();
    w.g.put("acme-state/one/default.tfstate", JSON.stringify(state("L1", 4, ["a", "b"])));
    const { work } = migrationRepo();
    const opts = { binary: "tofu", exec: w.exec, fetch: w.fetch, env: {}, log: () => {} };
    const first = await runMigrations(work, { ...opts, now: T(1) });
    approve(work, first.records[0]!.digest, T(2));
    w.g.put("acme-state/one/default.tflock", lockText("other", T(2), "x"));
    const second = await runMigrations(work, { ...opts, now: T(3) });
    expect(second.code).toBe(1);
    expect(second.records[0]?.error ?? "").toMatch(/its state is locked \(gs:\/\/acme-state\/one\/default.tflock/);
    expect(w.a.blobs.get("tfstate/two.tfstate")).toBeUndefined();
  });
});
