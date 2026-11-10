import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audit, describeAudit } from "../src/audit";
import type { StateVersionList } from "@intentius/chant-lexicon-terraform/state";
import { ConfigError, validateConfig } from "../src/config";
import { notifyUnrecorded, slackUnrecorded, unrecordedNotice } from "../src/notify";
import { AUDIT_SCHEMA, ledgerEntries, MIGRATE_DONE_FILE, type AuditEntry } from "../src/report/audit";
import { AzureBlobClient, GcsClient, type ObjectVersion, type StoreFetch, S3Client } from "@intentius/chant/object-store";
import { buildEstate, linkUnrecorded, renderEstateHtml } from "../src/report/estate";
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

});

