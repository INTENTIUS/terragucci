import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialisedBackend, s3StateKey, stateObject, stateVersion, workspaceOf } from "../src/backend";
import { estate } from "../src/estate";
import { reportEntry } from "../src/report/audit";
import { buildReport } from "../src/report/build";
import { buildEstate, readInlineEstate, renderEstateHtml } from "../src/report/estate";
import { S3Client, type S3Fetch } from "../src/report/s3";
import type { Report, ReportStateVersion } from "../src/report/schema";
import { addToStateVersions, readStateVersions, STATE_VERSIONS_KEPT, STATES_SCHEMA, stateRecords, type StateRecord } from "../src/report/state-versions";
import { uploadReport, writeReportDir } from "../src/report/store";
import { validate, type Json } from "../../../scripts/schema-check";
import { plan, rc, RUN } from "./report-fixtures";
import { tmp, write } from "./helpers";

const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));
const at = (h: number): string => `2026-10-07T${String(h).padStart(2, "0")}:00:00.000Z`;
const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };

/** A root initialised with `type` and `config`, as `init` leaves `.terraform/terraform.tfstate`. */
function initialised(type: string, config: Json, files: Record<string, string> = {}): string {
  return write(tmp(), { ".terraform/terraform.tfstate": JSON.stringify({ version: 3, backend: { type, config, hash: 1 } }), ...files });
}

const S3_CONFIG = { bucket: "acme-state", key: "envs/dev/platform.tfstate", region: "eu-west-1", use_lockfile: true, endpoints: { s3: "http://floci:4566", dynamodb: null }, access_key: null, workspace_key_prefix: null };

/** A fake S3 that answers HEAD of one key with `headers`, and records each request. */
function headOnly(status: number, headers: Record<string, string> = {}) {
  const seen: { method: string; url: string }[] = [];
  const fetch: S3Fetch = async (url, init) => {
    seen.push({ method: init.method, url });
    return { ok: status < 300, status, text: async () => "", headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
  };
  return { fetch, seen };
}

describe("where a root's state is", () => {
  it("reads the backend init recorded, s3 with its bucket, key, region and endpoint", () => {
    const dir = initialised("s3", S3_CONFIG);
    expect(initialisedBackend(dir)?.type).toBe("s3");
    const o = stateObject(dir, ENV);
    expect(o).toMatchObject({ backend: "s3", bucket: "acme-state", key: "envs/dev/platform.tfstate", region: "eu-west-1", endpoint: "http://floci:4566", lockfile: true, dynamodb: false });
  });

  it("takes the endpoint from AWS_ENDPOINT_URL when the backend names none, and the key of another workspace", () => {
    const dir = initialised("s3", { ...S3_CONFIG, endpoints: null, workspace_key_prefix: "ws" });
    const o = stateObject(dir, { ...ENV, AWS_ENDPOINT_URL: "http://floci:4566/", TF_WORKSPACE: "blue" });
    expect(o).toMatchObject({ endpoint: "http://floci:4566", key: "ws/blue/envs/dev/platform.tfstate" });
    expect(s3StateKey("k", "default")).toBe("k");
    expect(s3StateKey("k", "green")).toBe("env:/green/k");
  });

  it("reads the workspace select recorded, and TF_DATA_DIR in place of .terraform", () => {
    const dir = write(tmp(), { "data/terraform.tfstate": JSON.stringify({ backend: { type: "s3", config: S3_CONFIG } }), "data/environment": "green\n" });
    expect(workspaceOf(dir, { TF_DATA_DIR: "data" })).toBe("green");
    expect(stateObject(dir, { ...ENV, TF_DATA_DIR: "data" })).toMatchObject({ key: "env:/green/envs/dev/platform.tfstate" });
  });

  it("is a local file when init recorded no backend or a local one", () => {
    expect(stateObject(tmp(), ENV)).toEqual({ backend: "local", path: "terraform.tfstate" });
    expect(stateObject(initialised("local", { path: "state/x.tfstate" }), ENV)).toEqual({ backend: "local", path: "state/x.tfstate" });
  });

  it("names any other backend as one it does not read versions from", () => {
    expect(stateObject(initialised("gcs", { bucket: "b", prefix: "p" }), ENV)).toMatchObject({ backend: "gcs", unsupported: expect.stringContaining("s3, local and GitLab-managed http backends") });
  });
});

describe("the version an apply leaves", () => {
  it("is the object's version id when the bucket keeps versions, read by HEAD and never by GET", async () => {
    const dir = initialised("s3", S3_CONFIG);
    const { fetch, seen } = headOnly(200, { "x-amz-version-id": "v-3", etag: '"e"' });
    expect(await stateVersion(dir, ENV, fetch)).toEqual({ backend: "s3", location: "s3://acme-state/envs/dev/platform.tfstate", version_id: "v-3", versioning: "on" });
    expect(seen).toEqual([{ method: "HEAD", url: "http://floci:4566/acme-state/envs/dev/platform.tfstate" }]);
  });

  it("says versions are off when the bucket sends no version id, or null for a suspended bucket", async () => {
    const dir = initialised("s3", S3_CONFIG);
    for (const headers of [{}, { "x-amz-version-id": "null" }] as Record<string, string>[]) {
      const v = await stateVersion(dir, ENV, headOnly(200, headers).fetch);
      expect(v).toMatchObject({ backend: "s3", versioning: "off" });
      expect(v.version_id).toBeUndefined();
      expect(v.note).toContain("bucket versioning is off for acme-state");
    }
  });

  it("is unknown, with why, when the object is missing or the job may not read it, and never throws", async () => {
    const dir = initialised("s3", S3_CONFIG);
    expect(await stateVersion(dir, ENV, headOnly(404).fetch)).toMatchObject({ versioning: "unknown", note: "the state object is not in the bucket" });
    expect(await stateVersion(dir, ENV, headOnly(403).fetch)).toMatchObject({ versioning: "unknown", note: expect.stringContaining("403") });
    expect(await stateVersion(dir, {}, headOnly(200).fetch)).toMatchObject({ versioning: "unknown", note: expect.stringContaining("no credentials") });
  });

  it("signs with the backend's own static keys when its configuration names them", async () => {
    const dir = initialised("s3", { ...S3_CONFIG, access_key: "BACKENDKEY", secret_key: "s" });
    let auth = "";
    await stateVersion(dir, ENV, async (_u, init) => {
      auth = init.headers.authorization;
      return { ok: true, status: 200, text: async () => "", headers: { get: () => null } };
    });
    expect(auth).toContain("Credential=BACKENDKEY/");
  });

  it("is off for a local backend, and unknown for one it does not read", async () => {
    expect(await stateVersion(tmp(), ENV)).toMatchObject({ backend: "local", versioning: "off", location: "terraform.tfstate" });
    expect(await stateVersion(initialised("azurerm", {}), ENV)).toMatchObject({ backend: "azurerm", versioning: "unknown" });
  });

  it("is off for a backend that keeps no history, and unknown for one that keeps versions it does not read", async () => {
    const pg = await stateVersion(initialised("pg", { conn_str: "postgres://tf:secret@db.internal:5432/states", schema_name: "net" }), ENV);
    expect(pg).toMatchObject({ backend: "pg", versioning: "off", location: "pg:db.internal:5432/states/net.states", note: expect.stringContaining("which each write replaces") });
    expect(JSON.stringify(pg)).not.toContain("secret");
    expect(await stateVersion(initialised("kubernetes", { secret_suffix: "net", namespace: "infra" }), ENV)).toMatchObject({ backend: "kubernetes", versioning: "off", location: "kubernetes:infra/net" });
    expect(await stateVersion(initialised("consul", { address: "consul:8500", path: "tf/net" }), ENV)).toMatchObject({ backend: "consul", versioning: "off", location: "consul:consul:8500/tf/net" });
    expect(await stateVersion(initialised("http", { address: "https://state.example.com/net" }), ENV)).toMatchObject({ backend: "http", versioning: "off", note: expect.stringContaining("names no versions") });
    // GitLab's state API keeps each version by serial, which is read (gitlab-state.test.ts); a GitLab that cannot be read is unknown.
    const gitlab = await stateVersion(initialised("http", { address: "https://gitlab.com/api/v4/projects/42/terraform/state/net" }), ENV, headOnly(401).fetch);
    expect(gitlab).toMatchObject({ backend: "http", location: "https://gitlab.com/api/v4/projects/42/terraform/state/net", versioning: "unknown", note: expect.stringContaining("GitLab answered 401") });
    expect(await stateVersion(initialised("gcs", { bucket: "b", prefix: "net" }), ENV)).toMatchObject({ backend: "gcs", versioning: "unknown", note: "a gcs backend can keep versions of the state, which terragucci does not read" });
    expect(await stateVersion(initialised("remote", { organization: "acme", workspaces: [{ name: "net" }] }), ENV)).toMatchObject({ backend: "remote", versioning: "unknown", location: "remote:app.terraform.io/acme/net" });
    // A refusal elsewhere (export, migrations) still names the backend it does not read.
    expect(stateObject(initialised("pg", { conn_str: "postgres://db/states" }))).toMatchObject({ unsupported: expect.stringContaining("this root's backend is pg") });
  });

  it("an S3 HEAD answers whether the object exists, its ETag and its version id", async () => {
    const s3 = new S3Client({ bucket: "b", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, headOnly(200, { "x-amz-version-id": "v1", etag: '"abc"' }).fetch);
    expect(await s3.head("k")).toEqual({ exists: true, etag: '"abc"', versionId: "v1" });
  });
});

const ON = (id: string): ReportStateVersion => ({ backend: "s3", location: "s3://acme-state/app.tfstate", version_id: id, versioning: "on" });
const OFF: ReportStateVersion = { backend: "s3", location: "s3://acme-state/app.tfstate", versioning: "off", note: "bucket versioning is off for acme-state, so it keeps only the latest state" };

/** A tf-apply wave of `roots`, each applied with the state version given. */
function wave(n: number, finished: string, states: Record<string, ReportStateVersion | undefined>, commit = RUN.commit): Report {
  const roots = Object.keys(states);
  return buildReport({
    run: { ...RUN, commit, stage: "tf-apply", wave: n, finished },
    roots: roots.map((path) => ({ path, plan: plan([rc("terraform_data.app", ["update"], { input: "a" }, { input: "b" })]), planner: "tofu" as const, applied: true, ...(states[path] ? { state: states[path] } : {}) })),
    waves: [{ number: n, roots, approval: "not-required" }],
  });
}

describe("the state versions in a report and in states.json", () => {
  it("are in a tf-apply wave's report for each root that applied, and in no plan's", () => {
    const r = wave(1, at(9), { app: ON("v1"), other: undefined });
    expect(r.roots.find((x) => x.path === "app")?.state).toEqual(ON("v1"));
    expect(r.roots.find((x) => x.path === "other")?.state).toBeUndefined();
    expect(stateRecords(r, "p").map((x) => x.root)).toEqual(["app"]);
    expect(validate(schema("report.schema.json"), r)).toEqual([]);
    const planned = buildReport({ run: RUN, roots: [{ path: "app", plan: plan([]), planner: "tofu", state: ON("v1") }] });
    expect(planned.roots[0].state).toBeUndefined();
  });

  it("lists each root's versions newest first, once each, and keeps the newest location and versioning", () => {
    const rec = (finished: string, state: ReportStateVersion, wave = 1): StateRecord => ({ root: "app", state, commit: "c", finished, wave, path: `p-${finished}` });
    let s = addToStateVersions(undefined, [rec(at(9), ON("v1"))]);
    s = addToStateVersions(JSON.stringify(s), [rec(at(10), ON("v2"))]);
    // A wave with nothing to apply finds the version the last apply left: listed once.
    s = addToStateVersions(JSON.stringify(s), [rec(at(11), ON("v2"))]);
    expect(s.roots[0].versions.map((v) => v.version_id)).toEqual(["v2", "v1"]);
    expect(s.roots[0].checked).toBe(at(11));
    // An older wave's record adds its version but does not replace what the newest apply found.
    s = addToStateVersions(JSON.stringify(s), [rec(at(8), OFF)]);
    expect(s.roots[0].versioning).toBe("on");
    s = addToStateVersions(JSON.stringify(s), [rec(at(12), OFF)]);
    expect(s.roots[0]).toMatchObject({ versioning: "off", note: OFF.note });
    expect(s.roots[0].versions).toHaveLength(2);
    expect(validate(schema("state-versions.schema.json"), s)).toEqual([]);
    expect(readStateVersions("{not json").roots).toEqual([]);
  });

  it(`keeps at most ${STATE_VERSIONS_KEPT} versions of a root`, () => {
    const recs = Array.from({ length: STATE_VERSIONS_KEPT + 5 }, (_, i): StateRecord => ({ root: "app", state: ON(`v${i}`), commit: "c", finished: new Date(Date.UTC(2026, 9, 7, 0, i)).toISOString(), path: "p" }));
    const s = addToStateVersions(undefined, recs);
    expect(s.roots[0].versions).toHaveLength(STATE_VERSIONS_KEPT);
    expect(s.roots[0].versions[0].version_id).toBe(`v${STATE_VERSIONS_KEPT + 4}`);
  });

  it("names each root's version in the audit trail's apply entry", () => {
    const e = reportEntry(wave(1, at(9), { app: ON("v7") }), "p", { source: "report" }, []);
    expect(e?.detail?.state_versions).toEqual([{ root: "app", location: "s3://acme-state/app.tfstate", version_id: "v7", versioning: "on" }]);
  });
});

/** A bucket in memory, keyed `<bucket>:<key>`. */
function bucket() {
  const objects = new Map<string, string>();
  const fetch: S3Fetch = async (url, init) => {
    const [, name, ...rest] = new URL(url).pathname.split("/");
    const key = `${name}:${decodeURIComponent(rest.join("/"))}`;
    if (init.method === "PUT") {
      objects.set(key, typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf-8"));
      return { ok: true, status: 200, text: async () => "" };
    }
    const body = objects.get(key);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
  };
  const s3 = new S3Client({ bucket: "acme-reports", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fetch);
  return { objects, fetch, s3 };
}

async function upload(s3: S3Client, reports: Report[]) {
  const out = [];
  for (const r of reports) {
    const dir = tmp();
    writeReportDir(dir, r, new Map());
    out.push(await uploadReport(s3, dir, r, "reports", async () => {}));
  }
  return out;
}

describe("the state versions on the estate page", () => {
  it("two applies of a root list both versions, newest first, each linked to its wave's report", async () => {
    const { objects, fetch, s3 } = bucket();
    const [first] = await upload(s3, [wave(1, at(9), { app: ON("v1") }, "a".repeat(40)), wave(1, at(10), { app: ON("v2") }, "b".repeat(40))]);
    expect(first.states).toBe(`reports/${RUN.project}/states.json`);
    const file = JSON.parse(objects.get(`acme-reports:reports/${RUN.project}/states.json`)!);
    expect(file.schema).toBe(STATES_SCHEMA);
    expect(validate(schema("state-versions.schema.json"), file)).toEqual([]);
    const r = await estate(tmp(), { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } }, { fetch, env: ENV, now: NOW });
    const states = r.estate.projects[0].states!;
    expect(states.map((s) => [s.root, s.versioning, s.versions.map((v) => v.version_id)])).toEqual([["app", "on", ["v2", "v1"]]]);
    expect(states[0].versions[0].report).toBe(`${RUN.project}/2026/10/${"b".repeat(40)}/tf-apply-wave-1/report.html`);
    expect(validate(schema("estate.schema.json"), r.estate)).toEqual([]);
    const html = objects.get("acme-reports:reports/estate.html")!;
    expect(html).toContain('<h2 id="state-versions">State versions</h2>');
    expect(html).toContain('<tbody class="states" data-root="app">');
    expect(html.indexOf("<code>v2</code>")).toBeLessThan(html.indexOf("<code>v1</code>"));
    expect(readInlineEstate(html)).toEqual(r.estate);
  });

  it("says versions are off for a root whose bucket keeps none", () => {
    const e = buildEstate([{ project: "p", reports: [], states: addToStateVersions(undefined, [{ root: "app", state: OFF, commit: "c", finished: at(9), path: "x" }]) }], NOW);
    const html = renderEstateHtml(e);
    expect(html).toContain('<span class="warn">versions are off</span>: bucket versioning is off for acme-state');
    expect(e.projects[0].states?.[0].versions).toEqual([]);
  });

  it("tells a backend that keeps no history from one whose versions it does not read", () => {
    const pg: ReportStateVersion = { backend: "pg", location: "pg:db/states/net.states", versioning: "off", note: "a pg backend keeps one row per workspace, which each write replaces" };
    const gcs: ReportStateVersion = { backend: "gcs", versioning: "unknown", note: "a gcs backend can keep versions of the state, which terragucci does not read" };
    const st = addToStateVersions(undefined, [{ root: "net", state: pg, commit: "c", finished: at(9), path: "x" }, { root: "app", state: gcs, commit: "c", finished: at(9), path: "x" }]);
    const html = renderEstateHtml(buildEstate([{ project: "p", reports: [], states: st }], NOW));
    expect(html).toContain('<code>net</code>: pg <code>pg:db/states/net.states</code>, <span class="warn">versions are off</span>: a pg backend keeps one row per workspace');
    expect(html).toContain('<code>app</code>: gcs, <span class="warn">versions not read</span>: a gcs backend can keep versions');
  });

  it("says no apply recorded a version when no project has states.json, and escapes what one holds", () => {
    expect(renderEstateHtml(buildEstate([{ project: "p", reports: [] }], NOW))).toContain("No apply has recorded a state version yet.");
    const bad = addToStateVersions(undefined, [{ root: "</script><b>", state: { ...ON("<i>"), location: "s3://b/<x>" }, commit: "c", finished: at(9), path: "x" }]);
    const html = renderEstateHtml(buildEstate([{ project: "p", reports: [], states: bad }], NOW));
    expect(html).not.toContain("</script><b>");
    expect(html).not.toContain("<i>");
  });
});
