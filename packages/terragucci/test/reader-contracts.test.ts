/**
 * The reader contracts: the JSON Schemas the package ships for index.json,
 * estate.json and audit.jsonl, held to what the writers put in a bucket.
 * The objects are the ones uploadReport, terragucci estate and the audit
 * record write, never hand-made rows, and between them they carry every
 * field each schema names, so a field added to a writer and not to its
 * schema fails here, and so does a schema field no writer writes.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estate } from "../src/estate";
import { appendEntries, APPLY_LEDGER, AUDIT_SCHEMA, ledgerEntries, OVERRIDE_LEDGER_FILE, readRecord, reportEntry, type LedgerChange } from "../src/report/audit";
import { buildReport } from "../src/report/build";
import { ESTATE_SCHEMA } from "../src/report/estate";
import { S3Client, type S3Fetch } from "../src/report/s3";
import type { Report } from "../src/report/schema";
import { copyToRun, INDEX_DESTROYS, INDEX_SCHEMA, uploadReport, VIEWS_DIR, writeReportDir } from "../src/report/store";
import { unknownKeywords, validate, type Json } from "../../../scripts/schema-check";
import { plan, rc, RUN, smallFixture } from "./report-fixtures";
import { tmp } from "./helpers";

const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));
const INDEX = schema("report-index.schema.json");
const ESTATE = schema("estate.schema.json");
const AUDIT = schema("audit.schema.json");

const NOW = new Date("2026-10-07T12:00:00.000Z");
const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const WEB = "github.com/acme/web";
const NET = "gitlab.example.com/platform/network";
const LINKS = { commit_url: "https://forge/c", pull_request: "7", pull_request_url: "https://forge/pr/7", trace_id: "abc123", trace_url: "https://traces/abc123" };

/** A bucket in memory, keyed `<bucket>:<key>`, that refuses every request to `locked`. */
function bucket() {
  const objects = new Map<string, string>();
  const fetch: S3Fetch = async (url, init) => {
    const [, name, ...rest] = new URL(url).pathname.split("/");
    const key = `${name}:${decodeURIComponent(rest.join("/"))}`;
    if (name === "locked") return { ok: false, status: 403, text: async () => "<Error><Code>AccessDenied</Code></Error>" };
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

const at = (h: number, m = 0): string => `2026-10-07T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

/** Runs of two projects: plans with every link and more destroys than a row lists, a drift, apply waves approved, waiting and under an override. */
function runs(): Report[] {
  const many = plan(Array.from({ length: INDEX_DESTROYS + 3 }, (_, i) => rc(`aws_s3_object.o${i}`, ["delete"], { key: `o${i}` }, null)));
  const override = { by: "alice", at: at(9), rules: ["main.deny"], reason: "why", plan_digest: "jcs1-sha256:aa", digest: "sha256:bb", sealed: false };
  const created = plan([rc("aws_s3_bucket.logs", ["create"], null, { bucket: "logs" })]);
  const b = "b".repeat(40);
  return [
    buildReport({ run: { ...RUN, project: WEB, ...LINKS, finished: at(11) }, roots: [...smallFixture(), { path: "envs/big", planner: "tofu", plan: many }] }),
    buildReport({ run: { ...RUN, project: WEB, stage: "tf-drift", finished: at(4, 17) }, roots: smallFixture().slice(0, 2) }),
    buildReport({ run: { ...RUN, project: NET, commit: b, stage: "tf-apply", wave: 1, finished: at(8, 55) }, roots: [{ path: "a", plan: created, policy: { result: "denied", denials: ["no"], rules: ["main.deny"], warnings: [], override } }], waves: [{ number: 1, roots: ["a"], approval: "not-required" }] }),
    buildReport({ run: { ...RUN, project: NET, commit: b, stage: "tf-apply", wave: 2, finished: at(10) }, roots: smallFixture().slice(0, 2), waves: [{ number: 2, roots: ["envs/dev/orders", "envs/dev/search"], approval: "waiting", waitingSince: at(9) }] }),
    buildReport({ run: { ...RUN, project: NET, commit: b, stage: "tf-apply", wave: 3, finished: at(10, 30) }, roots: smallFixture().slice(0, 1), waves: [{ number: 3, roots: ["envs/dev/orders"], approval: "approved" }] }),
  ];
}

/** Each run written as a job writes it, then copied to the bucket under `reports`. */
async function upload(s3: S3Client, reports: Report[]): Promise<void> {
  for (const r of reports) {
    const dir = tmp();
    writeReportDir(dir, r, new Map());
    await uploadReport(s3, dir, r, "reports", async () => {});
  }
}

/** Every property name an object (and the objects under it, at `path`) carries. */
const keys = (objects: Json[]): Set<string> => new Set(objects.flatMap((o) => Object.keys(o)));
const named = (s: Json): string[] => Object.keys(s.properties ?? {});

describe("the reader contracts' schemas", () => {
  it("use only the keywords the check reads, and name the schema id the writer puts in `schema`", () => {
    for (const [s, id] of [[INDEX, INDEX_SCHEMA], [ESTATE, ESTATE_SCHEMA], [AUDIT, AUDIT_SCHEMA]] as const) {
      expect(unknownKeywords(s)).toEqual([]);
      expect(s.title).toBe(id);
      expect(s.properties.schema.const).toBe(id);
    }
    expect(unknownKeywords(schema("report.schema.json"))).toEqual([]);
  });

  it("ship beside report.schema.json: the build copies each one into dist, which the package publishes", () => {
    const shipped = readdirSync(SRC).filter((f) => f.endsWith(".schema.json")).sort();
    expect(shipped).toEqual(["audit.schema.json", "estate.schema.json", "report-index.schema.json", "report.schema.json"]);
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf-8"));
    expect(pkg.files).toContain("dist");
    const build = readFileSync(join(import.meta.dirname, "../../../scripts/build-cli.mjs"), "utf-8");
    for (const f of shipped) expect(build).toContain(`"${f}"`);
  });
});

describe("the bucket layout", () => {
  it("keeps <prefix>/views/ for viewers: a project named views is refused before anything is written", async () => {
    const { objects, s3 } = bucket();
    const r = buildReport({ run: { ...RUN, project: `${VIEWS_DIR}/x` }, roots: smallFixture().slice(0, 1) });
    const dir = tmp();
    writeReportDir(dir, r, new Map());
    await expect(uploadReport(s3, dir, r, "reports")).rejects.toThrow("project views/x would write under reports/views/, which is kept for viewers");
    await expect(copyToRun(s3, dir, r, ["report.json"], "reports")).rejects.toThrow(/kept for viewers/);
    expect([...objects.keys()]).toEqual([]);
    // A project whose path only contains the word is not refused.
    await upload(s3, [buildReport({ run: { ...RUN, project: "github.com/acme/views" }, roots: smallFixture().slice(0, 1) })]);
    expect([...objects.keys()].some((k) => k.startsWith("acme-reports:reports/github.com/acme/views/2026/"))).toBe(true);
    expect([...objects.keys()].some((k) => k.startsWith("acme-reports:reports/views/"))).toBe(false);
  });
});

describe("terragucci.report-index/v1", () => {
  it("holds both index.json files uploads write, and every row field is one some upload writes", async () => {
    const { objects, s3 } = bucket();
    await upload(s3, runs());
    const files = ["acme-reports:reports/index.json", `acme-reports:reports/${WEB}/index.json`, `acme-reports:reports/${NET}/index.json`];
    const rows: Json[] = [];
    for (const f of files) {
      const index = JSON.parse(objects.get(f)!);
      expect(validate(INDEX, index), f).toEqual([]);
      rows.push(...index.reports);
    }
    expect([...keys(rows)].sort()).toEqual(named(INDEX.$defs.row).sort());
  });

  it("refuses a row with a field it does not name, without a field it needs, or with a stage it does not know", async () => {
    const { objects, s3 } = bucket();
    await upload(s3, runs().slice(0, 1));
    const index = JSON.parse(objects.get("acme-reports:reports/index.json")!);
    const row = index.reports[0];
    expect(validate(INDEX, { ...index, reports: [{ ...row, surprise: 1 }] })).toEqual(["$.reports[0]: surprise is not in the schema"]);
    const { path: _path, ...noPath } = row;
    expect(validate(INDEX, { ...index, reports: [noPath] })).toEqual(["$.reports[0]: missing path"]);
    expect(validate(INDEX, { ...index, reports: [{ ...row, stage: "tf-destroy" }] })).toEqual(['$.reports[0].stage: "tf-destroy" not in enum']);
    expect(validate(INDEX, { ...index, schema: "terragucci.report-index/v2" })).toEqual(['$.schema: not "terragucci.report-index/v1"']);
  });
});

describe("terragucci.estate/v1", () => {
  it("holds the estate.json terragucci estate writes, with projects ok, unreadable and with no index, and the audit link", async () => {
    const { objects, fetch, s3 } = bucket();
    await upload(s3, runs());
    objects.set("acme-reports:reports/audit.json", JSON.stringify({ schema: "terragucci.audit-summary/v1", generated: at(11, 30), entries: 3 }));
    const config = {
      defaults: { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } },
      projects: { [WEB]: {}, [NET]: {}, "github.com/acme/locked": { reports: { bucket: "s3://locked", endpoint: "http://minio:9000" } }, "github.com/acme/fresh": {} },
    };
    await estate(tmp(), config, { fetch, env: ENV, now: NOW });
    const page = JSON.parse(objects.get("acme-reports:reports/estate.json")!);
    expect(validate(ESTATE, page)).toEqual([]);
    expect(page.projects.map((p: Json) => p.status)).toEqual(["ok", "ok", "error", "no-index"]);

    // Between them the written objects carry every field the schema names.
    const projects: Json[] = page.projects;
    const runRows: Json[] = [...page.recent, ...projects.flatMap((p) => [p.plan, p.drift, ...(p.apply?.waves ?? [])].filter(Boolean))];
    expect([...keys([page])].sort()).toEqual(named(ESTATE).sort());
    expect([...keys([page.totals])].sort()).toEqual(named(ESTATE.properties.totals).sort());
    expect([...keys(projects)].sort()).toEqual(named(ESTATE.$defs.project).sort());
    expect([...keys(runRows)].sort()).toEqual(named(ESTATE.$defs.run).sort());
    expect([...keys(projects.flatMap((p) => p.waiting))].sort()).toEqual(named(ESTATE.$defs.waiting).sort());
  });

  it("refuses a project with a status it does not know, and a run with a field it does not name", async () => {
    const { objects, fetch, s3 } = bucket();
    await upload(s3, runs().slice(0, 1));
    await estate(tmp(), { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } }, { fetch, env: ENV, now: NOW });
    const page = JSON.parse(objects.get("acme-reports:reports/estate.json")!);
    expect(validate(ESTATE, { ...page, projects: [{ ...page.projects[0], status: "stale" }] })).toEqual(['$.projects[0].status: "stale" not in enum']);
    expect(validate(ESTATE, { ...page, recent: [{ ...page.recent[0], live: true }] })).toEqual(["$.recent[0]: live is not in the schema"]);
  });
});

describe("terragucci.audit/v1", () => {
  const D = `sha256:${"a".repeat(64)}`;
  const line = (o: Json, commit: string, added = true): LedgerChange => ({ line: JSON.stringify(o), added, commit, author: "x", date: o.timestamp });
  const pending = { version: 1, kind: "pending", op: "tf-apply", gate: "wave-1", timestamp: at(10), expiresAt: "2026-10-09T10:00:00.000Z", planDigest: D, members: [{ member: "envs/dev/orders", planDigest: "sha256:1" }] };
  const bob = { version: 1, kind: "resolution", op: "tf-apply", gate: "wave-1", resolvedBy: "bob", timestamp: at(10, 5), planDigest: D };
  const carol = { ...bob, resolvedBy: "carol", timestamp: at(10, 10), seal: { signer: "carol", key: "k", signature: "s" } };
  const denial = { version: 1, kind: "pending", op: "policy-override", gate: "envs/dev/orders", timestamp: at(9), expiresAt: "2026-10-09T09:00:00.000Z", planDigest: D, members: [{ member: "envs/dev/orders", planDigest: "sha256:p1" }], rules: ["main.deny"] };
  const allowed = { version: 1, kind: "resolution", op: "policy-override", gate: "envs/dev/orders", resolvedBy: "alice", timestamp: at(9, 5), planDigest: D, note: "why" };

  it("holds every line the record appends, from the ledger and from wave reports", () => {
    const approvals = ledgerEntries(RUN.project, APPLY_LEDGER, [line(pending, "c1"), line(bob, "c2"), line(carol, "c3"), line(bob, "c4", false)], (c) => `https://forge/commit/${c}`);
    const overrides = ledgerEntries(RUN.project, OVERRIDE_LEDGER_FILE, [line(denial, "c5"), line(allowed, "c6"), line(allowed, "c7", false)]);
    const wave = (approval: "approved" | "waiting", finished: string, refused?: { reason: "approval"; approved: string; by: string; roots: string[] }) =>
      buildReport({ run: { ...RUN, stage: "tf-apply", wave: 1, finished }, roots: smallFixture().slice(0, 1), waves: [{ number: 1, roots: ["envs/dev/orders"], approval, setDigest: D, ...(refused ? { refused } : {}) }] });
    const evidence = { source: "report" as const, bucket: "s3://acme-reports", key: "reports/x/report.json", url: "https://reports/x/report.html", job_url: RUN.job_url };
    const fromReports = [
      reportEntry(wave("approved", at(10, 20)), "x", evidence, approvals)!,
      reportEntry(wave("waiting", at(11), { reason: "approval", approved: `sha256:${"c".repeat(64)}`, by: "carol", roots: ["envs/dev/orders"] }), "y", evidence, approvals)!,
    ];
    const text = appendEntries(readRecord(undefined), [...approvals, ...overrides, ...fromReports]);
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Json);
    expect(new Set(lines.map((l) => l.kind))).toEqual(new Set(["approval-requested", "approval", "approval-revoked", "override-requested", "override", "override-revoked", "apply", "refused"]));
    for (const [i, l] of lines.entries()) expect(validate(AUDIT, l), `line ${i + 1}`).toEqual([]);
    expect([...keys(lines)].sort()).toEqual(named(AUDIT).sort());
    expect([...keys(lines.map((l) => l.evidence))].sort()).toEqual(named(AUDIT.properties.evidence).sort());
    expect(validate(AUDIT, { ...lines[0], kind: "deploy" })).toEqual(['$.kind: "deploy" not in enum']);
  });
});
