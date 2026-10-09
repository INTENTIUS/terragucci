import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeEstate, estate } from "../src/estate";
import { appendEntries, AUDIT_SCHEMA, readRecord, reportEntry, type AuditEntry } from "../src/report/audit";
import { buildReport } from "../src/report/build";
import { addToChanges, buildHistory, changeRows, CHANGES_SCHEMA, historyId, planAppliedChanges, readInlineHistory, renderHistoryHtml, type ChangeRow } from "../src/report/history";
import { S3Client, type S3Fetch } from "../src/report/s3";
import type { Report } from "../src/report/schema";
import { runPath, uploadReport, writeReportDir } from "../src/report/store";
import { validate, type Json } from "../../../scripts/schema-check";
import { plan, rc, RUN } from "./report-fixtures";
import { tmp } from "./helpers";

const SECRET = "hunter2-do-not-store";
const PLAIN = "a-plain-value-not-stored";
const SRC = join(import.meta.dirname, "../src/report");
const schema = (name: string): Json => JSON.parse(readFileSync(join(SRC, name), "utf-8"));
const at = (h: number): string => `2026-10-07T${String(h).padStart(2, "0")}:00:00.000Z`;

describe("what an apply did to each resource", () => {
  it("names each action, and the attributes an update or a replacement changed, by name only", () => {
    const changes = planAppliedChanges(plan([
      rc("aws_s3_bucket.new", ["create"], null, { bucket: PLAIN }),
      rc("aws_db_instance.main", ["update"], { identifier: "db", password: "old", port: 5432 }, { identifier: "db", password: SECRET, port: 5432 }, { before_sensitive: { password: true }, after_sensitive: { password: true } }),
      rc("aws_sqs_queue.jobs", ["delete", "create"], { name: "a", fifo_queue: false }, { name: "a", fifo_queue: true, arn: null }, { after_unknown: { arn: true, tags: {} } }),
      rc("aws_iam_role.old", ["delete"], { name: PLAIN }, null),
      rc("aws_s3_bucket.found", ["no-op"], { bucket: "f" }, { bucket: "f" }, { importing: { id: "f" } }),
      { ...rc("aws_s3_bucket.renamed", ["no-op"], { bucket: "r" }, { bucket: "r" }), previous_address: "aws_s3_bucket.before" },
      rc("aws_s3_bucket.left", ["forget"], { bucket: "l" }, null),
      rc("aws_s3_bucket.same", ["no-op"], { bucket: "s" }, { bucket: "s" }),
      rc("data.aws_caller_identity.me", ["read"], null, { account_id: "1" }, { mode: "data" }),
      { ...rc("aws_instance.web", ["delete"], { ami: "x" }, null), deposed: "00000001" },
    ]));
    expect(changes).toEqual([
      { address: "aws_db_instance.main", type: "aws_db_instance", actions: ["update"], attributes: ["password"] },
      { address: "aws_iam_role.old", type: "aws_iam_role", actions: ["delete"], attributes: [] },
      { address: "aws_s3_bucket.found", type: "aws_s3_bucket", actions: ["import"], attributes: [] },
      { address: "aws_s3_bucket.left", type: "aws_s3_bucket", actions: ["forget"], attributes: [] },
      { address: "aws_s3_bucket.new", type: "aws_s3_bucket", actions: ["create"], attributes: [] },
      { address: "aws_s3_bucket.renamed", type: "aws_s3_bucket", actions: ["move"], attributes: [], previous_address: "aws_s3_bucket.before" },
      { address: "aws_sqs_queue.jobs", type: "aws_sqs_queue", actions: ["replace"], attributes: ["arn", "fifo_queue"] },
    ]);
    const text = JSON.stringify(changes);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(PLAIN);
    expect(planAppliedChanges({})).toEqual([]);
  });

  it("is in the report only for a tf-apply wave's roots that applied", () => {
    const p = plan([rc("aws_s3_bucket.a", ["create"], null, { bucket: "a" })]);
    const applied = buildReport({ run: { ...RUN, stage: "tf-apply", wave: 1 }, roots: [{ path: "r", plan: p, planner: "tofu", applied: true }, { path: "held", plan: p, planner: "tofu" }], waves: [{ number: 1, roots: ["r", "held"], approval: "approved" }] });
    const root = (path: string) => applied.roots.find((x) => x.path === path)!;
    expect(root("r").applied_changes).toEqual([{ address: "aws_s3_bucket.a", type: "aws_s3_bucket", actions: ["create"], attributes: [] }]);
    expect(root("held").applied_changes).toBeUndefined();
    expect(changeRows(applied, "x").map((c) => c.root)).toEqual(["r"]);
    expect(changeRows(buildReport({ run: RUN, roots: [{ path: "r", plan: p, planner: "tofu" }] }), "x")).toEqual([]);
  });

  it("keeps a run's rows once: a rerun of the same run and root replaces them, newest first, capped", () => {
    const row = (path: string, finished: string, address = "a.b"): ChangeRow => ({ address, type: "a", actions: ["update"], attributes: ["x"], root: "r", commit: "c", finished, path, plan_digest: "p", set_digest: "s" });
    let c = addToChanges(undefined, [row("one", at(9))]);
    c = addToChanges(JSON.stringify(c), [row("two", at(10))]);
    c = addToChanges(JSON.stringify(c), [row("two", at(10), "a.c")]);
    expect(c.changes.map((x) => `${x.path} ${x.address}`)).toEqual(["two a.c", "one a.b"]);
    expect(c.schema).toBe(CHANGES_SCHEMA);
    expect(addToChanges(JSON.stringify(c), [row("three", at(11))], 2).changes.map((x) => x.path)).toEqual(["three", "two"]);
    expect(addToChanges("{not json", []).changes).toEqual([]);
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

const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const NOW = new Date("2026-10-07T23:00:00.000Z");
const D = (n: number): string => `sha256:${String(n).repeat(64)}`;

/** Wave 1 of commit `n` applies root app, whose terraform_data.app goes from `before` to `after`, under an approval of D(n). */
function applyOf(n: number, before: string | null, after: string): Report {
  const p = plan([rc("terraform_data.app", before === null ? ["create"] : ["update"], before === null ? null : { input: before, output: before }, { input: after }, { after_unknown: { output: true } })], {
    planned_values: { root_module: { resources: [{ address: "terraform_data.app", mode: "managed", type: "terraform_data", name: "app", provider_name: "terraform.io/builtin/terraform", values: { input: after } }] } },
  });
  return buildReport({
    run: { ...RUN, commit: String(n).repeat(40), stage: "tf-apply", wave: 1, finished: at(8 + n), pull_request: String(10 + n) },
    roots: [{ path: "app", plan: p, planner: "tofu", applied: true }],
    waves: [{ number: 1, roots: ["app"], approval: "approved", setDigest: D(n) }],
  });
}

const approval = (n: number, who: string): AuditEntry => ({
  schema: AUDIT_SCHEMA, id: `sha256:approval-${n}`, kind: "approval", project: RUN.project, at: `2026-10-07T${String(7 + n).padStart(2, "0")}:30:00.000Z`,
  who, what: "wave-1", digest: D(n), result: "unsigned", evidence: { source: "ledger" },
});

/** The audit record `terragucci audit` would write: the approvals, and each wave report's apply entry. */
function auditRecord(reports: Report[], approvals: AuditEntry[]): string {
  const applies = reports.map((r) => reportEntry(r, runPath(r), { source: "report", bucket: "s3://acme-reports", key: `reports/${r.run.project}/${runPath(r)}/report.json` }, approvals)!);
  return appendEntries(readRecord(undefined), [...approvals, ...applies]);
}

async function upload(s3: S3Client, reports: Report[]): Promise<void> {
  for (const r of reports) {
    const dir = tmp();
    writeReportDir(dir, r, new Map());
    await uploadReport(s3, dir, r, "reports", async () => {});
  }
}

const config = { reports: { bucket: "s3://acme-reports", endpoint: "http://minio:9000", prefix: "reports" } };

describe("the history in the bucket and beside the estate page", () => {
  const applies = (): Report[] => [applyOf(1, null, `${PLAIN}-1`), applyOf(2, `${PLAIN}-1`, `${PLAIN}-2`), applyOf(3, `${PLAIN}-2`, SECRET)];
  const approvals = [approval(1, "approver-one"), approval(2, "approver-two"), approval(3, "approver-three")];

  it("an applied wave's upload adds its rows to the project's changes.json, which holds to its schema", async () => {
    const { objects, s3 } = bucket();
    await upload(s3, applies());
    const changes = JSON.parse(objects.get(`acme-reports:reports/${RUN.project}/changes.json`)!);
    expect(validate(schema("changes.schema.json"), changes)).toEqual([]);
    expect(changes.changes.map((c: Json) => [c.address, c.actions, c.attributes, c.set_digest, c.pull_request])).toEqual([
      ["terraform_data.app", ["update"], ["input", "output"], D(3), "13"],
      ["terraform_data.app", ["update"], ["input", "output"], D(2), "12"],
      ["terraform_data.app", ["create"], [], D(1), "11"],
    ]);
    expect(changes.changes[0].plan_digest).toMatch(/\S/);
  });

  it("lists the three applies of one resource in order, each with the approver the audit trail names, and the estate page links it", async () => {
    const { objects, fetch, s3 } = bucket();
    const reports = applies();
    await upload(s3, reports);
    objects.set("acme-reports:reports/audit.jsonl", auditRecord(reports, approvals));
    const cwd = tmp();
    const r = await estate(cwd, config, { fetch, env: ENV, now: NOW });
    const history = JSON.parse(objects.get("acme-reports:reports/history.json")!);
    expect(validate(schema("history.schema.json"), history)).toEqual([]);
    expect(validate(schema("estate.schema.json"), r.estate)).toEqual([]);
    expect(history.audit).toBe(true);
    const app = history.resources.find((x: Json) => x.address === "terraform_data.app");
    expect(app.id).toBe(historyId(RUN.project, "app", "terraform_data.app"));
    expect(app.applies.map((a: Json) => [a.actions[0], a.approver, a.set_digest, a.finished])).toEqual([
      ["create", "approver-one", D(1), at(9)],
      ["update", "approver-two", D(2), at(10)],
      ["update", "approver-three", D(3), at(11)],
    ]);
    expect(app.applies[2].approval).toBe("sha256:approval-3");
    expect(app.applies[2].report).toBe(`${RUN.project}/2026/10/${"3".repeat(40)}/tf-apply-wave-1/report.html`);
    expect(r.estate.history).toEqual({ page: "history.html", resources: 1, generated: NOW.toISOString() });
    expect(r.estate.projects[0].inventory?.roots[0].resources[0].history).toBe(`history.html#${app.id}`);
    const page = objects.get("acme-reports:reports/history.html")!;
    expect(page).toContain(`<section id="${app.id}">`);
    expect(page).toContain("<td>approver-two</td>");
    expect(readInlineHistory(page)).toEqual(history);
    const estateHtml = objects.get("acme-reports:reports/estate.html")!;
    expect(estateHtml).toContain(`<a href="history.html#${app.id}"><code>terraform_data.app</code></a>`);
    expect(estateHtml).toContain('href="history.html" id="resource-history"');
    expect(describeEstate(r, cwd)).toContain("wrote terragucci-estate/estate.json, terragucci-estate/estate.html, terragucci-estate/history.json and terragucci-estate/history.html");
    // No value of the plans, sensitive or plain, reaches a stored object outside the run directories.
    for (const [k, v] of objects) {
      if (/\/20\d\d\/\d\d\//.test(k)) continue;
      expect(v, k).not.toContain(SECRET);
      expect(v, k).not.toContain(PLAIN);
    }
  });

  it("with one apply's report left out, its history lists two applies", async () => {
    const { objects, fetch, s3 } = bucket();
    const reports = applies();
    await upload(s3, [reports[0], reports[2]]);
    objects.set("acme-reports:reports/audit.jsonl", auditRecord([reports[0], reports[2]], approvals));
    const r = await estate(tmp(), config, { fetch, env: ENV, now: NOW });
    const history = JSON.parse(objects.get("acme-reports:reports/history.json")!);
    expect(history.resources[0].applies.map((a: Json) => a.approver)).toEqual(["approver-one", "approver-three"]);
    expect(r.estate.history?.resources).toBe(1);
  });

  it("without an audit trail names no approver and says so; a wave no gate held has none", () => {
    const rows = changeRows(applyOf(1, null, "x"), "p");
    const bare = buildHistory([{ project: RUN.project, changes: rows }], undefined, NOW);
    expect(bare.audit).toBe(false);
    expect(bare.resources[0].applies[0].approver).toBeUndefined();
    expect(renderHistoryHtml(bare)).toContain("no audit trail read");
    const open = applyOf(1, null, "x");
    open.waves[0].approval = "not-required";
    const record = readRecord(auditRecord([open], [])).entries;
    const ungated = buildHistory([{ project: RUN.project, changes: changeRows(open, runPath(open)) }], record, NOW);
    expect(ungated.resources[0].applies[0].approver).toBeNull();
    expect(renderHistoryHtml(ungated)).toContain("no gate held it");
    const missing = buildHistory([{ project: RUN.project, changes: rows }], [], NOW);
    expect(missing.resources[0].applies[0].approver).toBeUndefined();
    expect(renderHistoryHtml(missing)).toContain("not in the audit trail");
  });

  it("writes no history and reads no audit record when no apply changed a resource", async () => {
    const { objects, fetch, s3 } = bucket();
    await upload(s3, [buildReport({ run: RUN, roots: [{ path: "r", plan: plan([]), planner: "tofu" }] })]);
    const r = await estate(tmp(), config, { fetch, env: ENV, now: NOW });
    expect(r.estate.history).toBeUndefined();
    expect(objects.has("acme-reports:reports/history.json")).toBe(false);
  });

  it("escapes what the history holds", () => {
    const rows = changeRows(applyOf(1, null, "x"), "p").map((c) => ({ ...c, address: 'a["</script><b>"]' }));
    const html = renderHistoryHtml(buildHistory([{ project: RUN.project, changes: rows }], undefined, NOW));
    expect(html).not.toContain("</script><b>");
  });
});
