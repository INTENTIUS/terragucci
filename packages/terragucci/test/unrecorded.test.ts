import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audit, describeAudit } from "../src/audit";
import { listStateVersions, type StateVersionList } from "../src/backend";
import { ConfigError, validateConfig } from "../src/config";
import { notifyUnrecorded, slackUnrecorded, unrecordedNotice } from "../src/notify";
import { AUDIT_SCHEMA, ledgerEntries, MIGRATE_DONE_FILE, type AuditEntry } from "../src/report/audit";
import { AzureBlobClient } from "../src/report/azure-blob";
import { buildEstate, linkUnrecorded, renderEstateHtml } from "../src/report/estate";
import { GcsClient } from "../src/report/gcs";
import type { ObjectVersion, StoreFetch } from "../src/report/object-store";
import { S3Client } from "../src/report/s3";
import type { ReportStateVersion } from "../src/report/schema";
import { addToStateVersions, type StateRecord, type StateVersions } from "../src/report/state-versions";
import { SETTLE_SECONDS, unrecordedId, unrecordedWrites } from "../src/report/unrecorded";
import { awsStateWriters, type StateWriters } from "../src/state-writers";
import { validate, type Json } from "../../../scripts/schema-check";
import { tmp, write } from "./helpers";

const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));
const P = "github.com/acme/infra";
const LOCATION = "s3://acme-state/app.tfstate";
/** 7 October at `h`:`m`. */
const at = (h: number, m = 0): string => `2026-10-07T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
/** The next day at noon: everything on the 7th is older than the settle time. */
const NOW = new Date("2026-10-08T12:00:00.000Z");
const ON = (id: string): ReportStateVersion => ({ backend: "s3", location: LOCATION, version_id: id, versioning: "on" });

/** A wave that recorded `id`, running from `started` to `finished`. */
const rec = (id: string, started: string, finished: string, root = "app"): StateRecord => ({ root, state: ON(id), commit: "c".repeat(40), started, finished, wave: 1, path: `p-${id}` });

/** The states.json two waves left: v1 (09:00 to 09:05) and v2 (10:00 to 10:05). */
const twoWaves = (): StateVersions => addToStateVersions(undefined, [rec("v1", at(9), at(9, 5)), rec("v2", at(10), at(10, 5))]);

const v = (version_id: string, written_at: string, latest = false, deleted = false): ObjectVersion => ({ version_id, written_at, latest, ...(deleted ? { deleted: true } : {}) });

/** A store that lists `versions` for every location, and records which it was asked for. */
function lists(versions: ObjectVersion[] | StateVersionList) {
  const asked: string[] = [];
  const list = async (location: string): Promise<StateVersionList> => {
    asked.push(location);
    return Array.isArray(versions) ? { versions } : versions;
  };
  return { list, asked };
}

/** A migration's `migration` entry, as the audit reads it from `_gates/tf-migrate/done.jsonl`. */
function migration(timestamp: string, roots: { root: string; location: string; before: string | null; after: string | null }[], result = "applied"): AuditEntry {
  const line = { version: 1, kind: "migration", op: "tf-migrate", gate: "m1", timestamp, planDigest: "sha256:m", result, approvedBy: "dana", change: "moves", roots: roots.map((r) => ({ ...r, before_digest: "sha256:b", after_digest: "sha256:a" })) };
  return ledgerEntries(P, MIGRATE_DONE_FILE, [{ text: JSON.stringify(line), commit: "m1c" }])[0]!;
}

describe("an unrecorded write", () => {
  it("a state written outside the pipeline after the last wave is one entry naming the root, both versions and the write time", async () => {
    const { list, asked } = lists([v("v3", at(14), true), v("v2", at(10, 3)), v("v1", at(9, 3))]);
    const { entries, check } = await unrecordedWrites({ project: P, states: twoWaves(), migrations: [], list, now: NOW });
    expect(asked).toEqual([LOCATION]);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e).toMatchObject({ schema: AUDIT_SCHEMA, id: unrecordedId(P, LOCATION, "v3"), kind: "unrecorded-write", project: P, at: at(14), who: null, what: "app", digest: null, result: "unrecorded", evidence: { source: "state", location: LOCATION, version_id: "v3" } });
    expect(e.detail).toMatchObject({ location: LOCATION, recorded_version: "v2", current_version: "v3", current_written_at: at(14), latest: true });
    expect(e.detail?.who_source).toBe("no log of the state's writes is read");
    expect(check).toEqual({ checked: 1, skipped: [], unreadable: [], pending: 0 });
    expect(validate(schema("audit.schema.json"), e)).toEqual([]);
  });

  it("is not made for the versions waves and migrations wrote, nor for one written while a wave that recorded the root ran", async () => {
    const m = migration(at(15), [{ root: "app", location: LOCATION, before: "v2", after: "v3" }]);
    // v1b: the binary's own write in the middle of the first wave's apply; v0: before terragucci recorded the root.
    const { list } = lists([v("v3", at(14, 59), true), v("v2", at(10, 3)), v("v1", at(9, 3)), v("v1b", at(9, 1)), v("v0", at(8))]);
    const { entries, check } = await unrecordedWrites({ project: P, states: twoWaves(), migrations: [m], list, now: NOW });
    expect(entries).toEqual([]);
    expect(check.checked).toBe(1);
  });

  it("is one entry per version, so a later wave that records a newer one keeps the earlier write", async () => {
    const states = addToStateVersions(JSON.stringify(twoWaves()), [rec("v4", at(16), at(16, 5))]);
    const { list } = lists([v("v4", at(16, 3), true), v("v3b", at(13)), v("v3", at(12)), v("v2", at(10, 3)), v("v1", at(9, 3))]);
    const { entries } = await unrecordedWrites({ project: P, states, migrations: [], list, now: NOW });
    expect(entries.map((e) => [e.detail?.current_version, e.detail?.recorded_version, e.detail?.latest])).toEqual([
      ["v3b", "v2", false],
      ["v3", "v2", false],
    ]);
  });

  it("leaves a version younger than the settle time for a later run, and counts it", async () => {
    const young = new Date(NOW.getTime() - 60_000).toISOString();
    const { list } = lists([v("v3", young, true), v("v2", at(10, 3)), v("v1", at(9, 3))]);
    const { entries, check } = await unrecordedWrites({ project: P, states: twoWaves(), migrations: [], list, now: NOW });
    expect(entries).toEqual([]);
    expect(check.pending).toBe(1);
    expect(SETTLE_SECONDS).toBe(6 * 3600);
  });

  it("skips and counts roots whose versioning is off or unknown, and those the store lists nothing for or cannot be listed", async () => {
    const off: ReportStateVersion = { backend: "s3", location: "s3://acme-state/off.tfstate", versioning: "off", note: "bucket versioning is off for acme-state" };
    const pg: ReportStateVersion = { backend: "pg", versioning: "unknown", note: "terragucci reads no versions of this state" };
    const states = addToStateVersions(undefined, [
      { root: "off", state: off, commit: "c", finished: at(9), path: "x" },
      { root: "pg", state: pg, commit: "c", finished: at(9), path: "x" },
      rec("v1", at(9), at(9, 5), "empty"),
    ]);
    const skipped = await unrecordedWrites({ project: P, states, migrations: [], list: lists({ skipped: "the store lists no versions of the state" }).list, now: NOW });
    expect(skipped.check.skipped).toEqual([
      { root: "empty", reason: "the store lists no versions of the state" },
      { root: "off", reason: "bucket versioning is off for acme-state" },
      { root: "pg", reason: "terragucci reads no versions of this state" },
    ]);
    expect(skipped.check.checked).toBe(0);
    const denied = await unrecordedWrites({ project: P, states: twoWaves(), migrations: [], list: lists({ error: "list the versions of s3://acme-state/app.tfstate: 403 AccessDenied" }).list, now: NOW });
    expect(denied.check.unreadable).toEqual([{ root: "app", error: "list the versions of s3://acme-state/app.tfstate: 403 AccessDenied" }]);
    expect(denied.entries).toEqual([]);
  });

  it("follows a state a migration moved, and counts the migration's write as recorded", async () => {
    const moved = "s3://acme-state-eu/app.tfstate";
    const m = migration(at(11), [{ root: "app", location: moved, before: "v2", after: "e1" }]);
    const { list, asked } = lists([v("e2", at(13), true), v("e1", at(11))]);
    const { entries } = await unrecordedWrites({ project: P, states: twoWaves(), migrations: [m], list, now: NOW });
    expect(asked).toEqual([moved]);
    expect(entries.map((e) => [e.detail?.location, e.detail?.recorded_version, e.detail?.current_version])).toEqual([[moved, "e1", "e2"]]);
  });

  it("names the writer when the log does, and says why when it does not; an entry the record holds is not built again", async () => {
    const asked: string[] = [];
    const writers: StateWriters = {
      writer: async (q) => {
        asked.push(q.version_id);
        return q.version_id === "v3" ? { status: "found", who: "dana", how: "PutObject in trail-logs at 2026-10-07T14:00:01Z, with this version id" } : { status: "none", why: "no write in trail-logs names this version id" };
      },
    };
    const { list } = lists([v("v4", at(15), true), v("v3", at(14)), v("v2", at(10, 3)), v("v1", at(9, 3))]);
    const { entries } = await unrecordedWrites({ project: P, states: twoWaves(), migrations: [], list, writers, now: NOW });
    expect(entries.map((e) => [e.detail?.current_version, e.who, e.detail?.who_source])).toEqual([
      ["v4", null, "no write in trail-logs names this version id"],
      ["v3", "dana", "PutObject in trail-logs at 2026-10-07T14:00:01Z, with this version id"],
    ]);
    asked.length = 0;
    const again = await unrecordedWrites({ project: P, states: twoWaves(), migrations: [], list, writers, known: new Set(entries.map((e) => e.id)), now: NOW });
    expect(again.entries).toEqual([]);
    expect(asked).toEqual([]);
  });
});

const XML = (body: string, more = ""): string => `<?xml version="1.0" encoding="UTF-8"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>acme-state</Name>${more}${body}</ListVersionsResult>`;
const s3v = (key: string, id: string, when: string, latest = false, tag = "Version"): string => `<${tag}><Key>${key}</Key><VersionId>${id}</VersionId><IsLatest>${latest}</IsLatest><LastModified>${when}</LastModified></${tag}>`;
const res = (status: number, body: string, headers: Record<string, string> = {}) => ({ ok: status < 300, status, text: async () => body, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } });

describe("a state store's list of versions", () => {
  it("S3: lists the object's versions and delete markers across pages from ListObjectVersions, and never the lock file or the state", async () => {
    const seen: { method: string; url: string }[] = [];
    const fetch: StoreFetch = async (url, init) => {
      seen.push({ method: init.method, url });
      const page2 = url.includes("key-marker=");
      return res(200, page2 ? XML(s3v("app.tfstate", "v1", at(9, 3)), "<IsTruncated>false</IsTruncated>") : XML(s3v("app.tfstate", "d1", at(15), true, "DeleteMarker") + s3v("app.tfstate", "v2", at(10, 3)) + s3v("app.tfstate.tflock", "l1", at(10, 1)) + s3v("app.tfstate", "null", at(8)), "<IsTruncated>true</IsTruncated><NextKeyMarker>app.tfstate</NextKeyMarker><NextVersionIdMarker>v2</NextVersionIdMarker>"));
    };
    const s3 = new S3Client({ bucket: "acme-state", endpoint: "http://minio:9000", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fetch);
    expect(await s3.listVersions("app.tfstate")).toEqual([v("d1", at(15), true, true), v("v2", at(10, 3)), v("v1", at(9, 3))]);
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(seen[0]!.url).toBe("http://minio:9000/acme-state/?prefix=app.tfstate&versions=");
    expect(seen[1]!.url).toContain("key-marker=app.tfstate&version-id-marker=v2");
  });

  it("S3: asks again in the bucket's own region when AWS answers that it is elsewhere", async () => {
    const urls: string[] = [];
    const fetch: StoreFetch = async (url) => {
      urls.push(url);
      return url.includes(".s3.us-east-1.") ? res(301, "<Error><Code>PermanentRedirect</Code></Error>", { "x-amz-bucket-region": "eu-west-1" }) : res(200, XML(s3v("app.tfstate", "v1", at(9)), "<IsTruncated>false</IsTruncated>"));
    };
    const s3 = new S3Client({ bucket: "acme-state", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "SK" }, fetch);
    expect(await s3.listVersions("app.tfstate")).toEqual([v("v1", at(9))]);
    expect(urls).toEqual(["https://acme-state.s3.us-east-1.amazonaws.com/?prefix=app.tfstate&versions=", "https://acme-state.s3.eu-west-1.amazonaws.com/?prefix=app.tfstate&versions="]);
  });

  it("GCS: lists each generation, live or not, from an object listing with versions=true", async () => {
    const urls: string[] = [];
    const fetch: StoreFetch = async (url) => {
      urls.push(url);
      const first = !url.includes("pageToken=");
      const items = first
        ? [{ name: "app/default.tfstate", generation: "200", timeCreated: at(14), }, { name: "app/default.tflock", generation: "150", timeCreated: at(10) }]
        : [{ name: "app/default.tfstate", generation: "100", timeCreated: at(9, 3), timeDeleted: at(14) }];
      return res(200, JSON.stringify({ items, ...(first ? { nextPageToken: "t2" } : {}) }));
    };
    const gcs = new GcsClient({ bucket: "acme-state", endpoint: "http://gcs", accessToken: "tok" }, fetch);
    expect(await gcs.listVersions("app/default.tfstate")).toEqual([v("200", at(14), true), v("100", at(9, 3))]);
    expect(urls[0]).toContain("http://gcs/storage/v1/b/acme-state/o?prefix=app%2Fdefault.tfstate&versions=true");
    expect(urls[1]).toContain("&pageToken=t2");
  });

  it("Azure: lists each blob version from List Blobs with include=versions, and nothing for a blob without versions", async () => {
    const urls: string[] = [];
    const blob = (name: string, id: string | undefined, when: string, current: boolean): string => `<Blob><Name>${name}</Name>${id ? `<VersionId>${id}</VersionId>` : ""}${current ? "<IsCurrentVersion>true</IsCurrentVersion>" : ""}<Properties><Last-Modified>${when}</Last-Modified></Properties></Blob>`;
    const fetch: StoreFetch = async (url) => {
      urls.push(url);
      return res(200, `<?xml version="1.0" encoding="utf-8"?><EnumerationResults><Blobs>${blob("app.tfstate", "2026-10-07T14:00:00.0000000Z", "Wed, 07 Oct 2026 14:00:00 GMT", true)}${blob("app.tfstate", "2026-10-07T09:03:00.0000000Z", "Wed, 07 Oct 2026 09:03:00 GMT", false)}${blob("app.tfstate.bak", undefined, "Wed, 07 Oct 2026 09:00:00 GMT", false)}</Blobs><NextMarker /></EnumerationResults>`);
    };
    const az = new AzureBlobClient({ account: "acme", container: "state", endpoint: "http://azure", sas: "sv=1&sig=s" }, fetch);
    expect(await az.listVersions("app.tfstate")).toEqual([v("2026-10-07T14:00:00.0000000Z", at(14), true), v("2026-10-07T09:03:00.0000000Z", at(9, 3))]);
    expect(urls).toEqual(["http://azure/state?restype=container&comp=list&include=versions&prefix=app.tfstate&sv=1&sig=s"]);
  });

  it("skips a location terragucci does not list, and gives the error of one it cannot", async () => {
    expect(await listStateVersions("https://gitlab.com/api/v4/projects/42/terraform/state/net", {})).toEqual({ skipped: "terragucci lists the versions of s3, gcs and azurerm states only" });
    expect(await listStateVersions("terraform.tfstate", {})).toEqual({ skipped: "terragucci lists the versions of s3, gcs and azurerm states only" });
    const denied = await listStateVersions(LOCATION, { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_ENDPOINT_URL: "http://minio:9000" }, async () => res(403, "<Error><Code>AccessDenied</Code><Message>no</Message></Error>"));
    expect(denied).toEqual({ error: "list the versions of s3://acme-state/app.tfstate: 403 AccessDenied: no" });
    const none = await listStateVersions(LOCATION, { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_ENDPOINT_URL: "http://minio:9000" }, async () => res(200, XML("", "<IsTruncated>false</IsTruncated>")));
    expect(none).toEqual({ skipped: "the store lists no versions of the state" });
  });
});

describe("who wrote it, from CloudTrail's data events in CloudWatch Logs", () => {
  const event = (id: string, who: Record<string, unknown>) => ({ message: JSON.stringify({ eventSource: "s3.amazonaws.com", eventName: "PutObject", eventTime: "2026-10-07T14:00:01Z", userIdentity: who, requestParameters: { bucketName: "acme-state", key: "app.tfstate" }, responseElements: { "x-amz-version-id": id } }) });
  const q = { location: LOCATION, version_id: "v3", written_at: at(14) };

  it("names the principal of the write whose version id is the version's", async () => {
    const calls: string[][] = [];
    const writers = awsStateWriters({
      logGroup: "trail-logs",
      region: "eu-west-1",
      run: (args) => {
        calls.push(args);
        return { status: 0, stdout: JSON.stringify({ events: [event("v9", { type: "IAMUser", userName: "lee" }), event("v3", { type: "IAMUser", userName: "dana", arn: "arn:aws:iam::1:user/dana" })] }), stderr: "" };
      },
    });
    expect(await writers.writer(q)).toEqual({ status: "found", who: "dana", how: "PutObject in trail-logs at 2026-10-07T14:00:01Z, with this version id" });
    const args = calls[0]!;
    expect(args.slice(0, 2)).toEqual(["logs", "filter-log-events"]);
    expect(args).toContain("trail-logs");
    expect(args.slice(-2)).toEqual(["--region", "eu-west-1"]);
    expect(args[args.indexOf("--filter-pattern") + 1]).toBe('{ ($.eventSource = "s3.amazonaws.com") && ($.requestParameters.bucketName = "acme-state") && ($.requestParameters.key = "app.tfstate") }');
    expect(Number(args[args.indexOf("--end-time") + 1]) - Number(args[args.indexOf("--start-time") + 1])).toBe(20 * 60_000);
  });

  it("falls back to the role's ARN for a machine session, and names nobody, with why, otherwise", async () => {
    const role = { type: "AssumedRole", arn: "arn:aws:sts::1:assumed-role/ci/runner-7" };
    const found = awsStateWriters({ logGroup: "trail-logs", run: () => ({ status: 0, stdout: JSON.stringify({ events: [event("v3", role)] }), stderr: "" }) });
    expect(await found.writer(q)).toMatchObject({ status: "found", who: "arn:aws:sts::1:assumed-role/ci/runner-7" });
    const other = awsStateWriters({ logGroup: "trail-logs", run: () => ({ status: 0, stdout: JSON.stringify({ events: [event("v9", role)] }), stderr: "" }) });
    expect(await other.writer(q)).toEqual({ status: "none", why: "no write in trail-logs names this version id" });
    const empty = awsStateWriters({ logGroup: "trail-logs", run: () => ({ status: 0, stdout: "{}", stderr: "" }) });
    expect(await empty.writer(q)).toEqual({ status: "none", why: "trail-logs holds no write of the object within 10 minutes of the version" });
    const missing = Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" });
    expect(await awsStateWriters({ logGroup: "trail-logs", run: () => ({ status: null, stdout: "", stderr: "", error: missing }) }).writer(q)).toEqual({ status: "none", why: "the aws CLI is not installed" });
    expect(await awsStateWriters({ logGroup: "trail-logs", run: () => ({ status: 254, stdout: "", stderr: "An error occurred (AccessDeniedException)\nmore" }) }).writer(q)).toEqual({ status: "none", why: "trail-logs could not be read: An error occurred (AccessDeniedException)" });
    expect(await awsStateWriters().writer(q)).toEqual({ status: "none", why: "audit_log_group is not set, and CloudTrail's event history keeps no S3 object writes" });
    expect(await awsStateWriters({ logGroup: "g" }).writer({ ...q, location: "gs://b/app/default.tfstate" })).toEqual({ status: "none", why: "terragucci reads no log of a gcs bucket's object writes" });
  });

  it("audit_log_group is validated as a log group name", () => {
    expect(() => validateConfig({ audit_log_group: "aws-cloudtrail-logs/state#1" }, "terragucci.yml")).not.toThrow();
    let problems: string[] = [];
    try {
      validateConfig({ audit_log_group: "no spaces" }, "terragucci.yml");
    } catch (e) {
      problems = (e as ConfigError).problems ?? [];
    }
    expect(problems).toContain("config.audit_log_group must be a CloudWatch Logs group name, such as aws-cloudtrail-logs-state");
  });
});

/** The reports bucket and the state bucket in memory, path-style, keyed `<bucket>:<key>`; a list of versions answers from `versions`. */
function buckets(versions: Record<string, string>) {
  const objects = new Map<string, string>();
  const seen: { method: string; url: string }[] = [];
  const fetch: StoreFetch = async (url, init) => {
    seen.push({ method: init.method, url });
    const u = new URL(url);
    const [, name, ...rest] = u.pathname.split("/");
    if (u.searchParams.has("versions")) return res(200, versions[`${name}:${u.searchParams.get("prefix")}`] ?? XML("", "<IsTruncated>false</IsTruncated>"));
    const key = `${name}:${decodeURIComponent(rest.join("/"))}`;
    if (init.method === "PUT") {
      objects.set(key, String(init.body));
      return res(200, "");
    }
    const body = objects.get(key);
    return res(body === undefined ? 404 : 200, body ?? "");
  };
  return { objects, seen, fetch };
}

describe("terragucci audit", () => {
  const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1", AWS_ENDPOINT_URL: "http://minio:9000", GITHUB_REPOSITORY: "acme/infra" };
  const REPORTS = { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" };

  it("--check reports a missing unrecorded-write entry like any other, and reads only the state's list of versions", async () => {
    const { objects, seen, fetch } = buckets({ "acme-state:app.tfstate": XML(s3v("app.tfstate", "v3", at(14), true) + s3v("app.tfstate", "v2", at(10, 3)) + s3v("app.tfstate", "v1", at(9, 3)), "<IsTruncated>false</IsTruncated>") });
    objects.set(`acme-reports:reports/${P}/states.json`, JSON.stringify(twoWaves()));
    const dir = write(tmp(), { "terragucci.yml": "" });
    const r = await audit(dir, {}, { check: true, reports: REPORTS, fetch, env: ENV, now: NOW });
    expect(r.added.map((e) => [e.kind, e.what, e.detail?.current_version])).toEqual([["unrecorded-write", "app", "v3"]]);
    expect(r.summary.projects[0]!.states).toEqual({ checked: 1, skipped: [], unreadable: [], pending: 0 });
    expect(describeAudit(r, dir, true)).toContain(`${at(14)} ${P} unrecorded-write app: unrecorded`);
    // The state bucket is asked only for its list of versions: never the state itself.
    const state = seen.filter((s) => s.url.includes("/acme-state/"));
    expect(state.length).toBeGreaterThan(0);
    expect(state.every((s) => s.method === "GET" && new URL(s.url).searchParams.has("versions"))).toBe(true);
    expect([...objects.keys()].filter((k) => k.startsWith("acme-reports:reports/audit"))).toEqual([]);
  });
});

describe("unrecorded writes on the estate page and in notify", () => {
  const entry = async (): Promise<AuditEntry> => {
    const { entries } = await unrecordedWrites({ project: P, states: twoWaves(), migrations: [], list: lists([v("v3", at(14), true), v("v2", at(10, 3)), v("v1", at(9, 3))]).list, writers: { writer: async () => ({ status: "found", who: "dana", how: "h" }) }, now: NOW });
    return entries[0]!;
  };

  it("lists each root's unrecorded writes among its state versions", async () => {
    const page = buildEstate([{ project: P, reports: [], states: twoWaves() }], NOW);
    linkUnrecorded(page, [await entry()]);
    expect(page.projects[0]!.states![0]!.unrecorded).toEqual([{ version_id: "v3", written_at: at(14), who: "dana" }]);
    expect(validate(schema("estate.schema.json"), page)).toEqual([]);
    const html = renderEstateHtml(page);
    expect(html).toContain('<span class="warn">1 unrecorded write</span>');
    expect(html).toContain('<tr class="unrecorded"><td><code>v3</code></td><td><span class="warn">written outside a wave or migration</span> by dana</td>');
    // Newest first, among the versions the waves recorded.
    expect(html.indexOf("<code>v3</code>")).toBeLessThan(html.indexOf("<code>v2</code>"));
  });

  it("notify unrecorded posts the writes the audit run added, read from the files it wrote", async () => {
    const e = await entry();
    const older = { ...e, id: "sha256:old", what: "older" };
    const dir = write(tmp(), { "audit.json": JSON.stringify({ added: 1 }), "audit.jsonl": `${JSON.stringify(older)}\n${JSON.stringify(e)}\n` });
    const n = unrecordedNotice(dir, {});
    expect(n?.writes).toEqual([{ project: P, root: "app", location: LOCATION, version_id: "v3", written_at: at(14), who: "dana" }]);
    expect(slackUnrecorded(n!).text).toContain(`${P} app: v3 at ${at(14)} by dana (\`${LOCATION}\`)`);
    expect(await notifyUnrecorded(n, {})).toEqual(["no chat webhook: TERRAGUCCI_SLACK_WEBHOOK and TERRAGUCCI_TEAMS_WEBHOOK are empty"]);
    expect(unrecordedNotice(write(tmp(), { "audit.json": JSON.stringify({ added: 0 }), "audit.jsonl": "" }), {})).toBeUndefined();
    expect(await notifyUnrecorded(undefined, {})).toEqual(["the audit run added no unrecorded write; nothing posted"]);
  });
});

describe("states.json", () => {
  it("keeps when each wave that recorded a version started", () => {
    const s = twoWaves();
    expect(s.roots[0]!.versions.map((x) => [x.version_id, x.started, x.finished])).toEqual([
      ["v2", at(10), at(10, 5)],
      ["v1", at(9), at(9, 5)],
    ]);
    expect(validate(schema("state-versions.schema.json"), s)).toEqual([]);
  });
});
