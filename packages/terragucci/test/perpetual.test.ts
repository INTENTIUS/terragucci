// Changes on every run: a planned change the root's last applied waves each
// made too is marked from changes.json and folded into its own note section.
// The marking changes no digest and no gate decision.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReport, planFiles, type RootInput } from "../src/report/build";
import { addToChanges, changeRows, type ChangeRow } from "../src/report/history";
import { markPerpetual, PERPETUAL_WAVES } from "../src/report/perpetual";
import type { S3Fetch } from "../src/report/s3";
import type { Report } from "../src/report/schema";
import { markRecurring } from "../src/report/stage";
import { changesKey } from "../src/report/store";
import { recurringBlock, renderNote } from "../src/report/views";
import { validate } from "../../../scripts/schema-check";
import { plan, rc, RUN } from "./report-fixtures";

const SCHEMA = JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8"));
const GOLDEN = join(import.meta.dirname, "__golden__/note.recurring.md");

const fn = (hash: string, memory = 128) => ({ function_name: "api", source_code_hash: hash, memory_size: memory });
/** The archive hash a build rebuilds each time. */
const lambda = (from: string, to: string, memory?: [number, number]) => rc("module.api.aws_lambda_function.this", ["update"], fn(from, memory?.[0]), fn(to, memory?.[1]));
/** A bucket whose ACL the provider normalises: it replaces it on every apply. */
const bucket = () => rc("aws_s3_bucket_acl.logs", ["delete", "create"], { acl: "log-delivery-write", bucket: "logs" }, { acl: "log-delivery-write", bucket: "logs" }, { replace_paths: [["acl"]], after_unknown: { acl: true } });
const queue = (from: number, to: number) => rc("aws_sqs_queue.jobs", ["update"], { name: "jobs", visibility_timeout_seconds: from }, { name: "jobs", visibility_timeout_seconds: to });

const root = (path: string, changes: Record<string, unknown>[]): RootInput => ({ path, plan: plan(changes), planner: "tofu", files: planFiles(path) });

/** Wave 1 of apply `n`: root `app` applies `changes`, as changes.json gets its rows. */
function applied(n: number, changes: Record<string, unknown>[], path = "app"): ChangeRow[] {
  const report = buildReport({
    run: { ...RUN, stage: "tf-apply", wave: 1, commit: String(n % 10).repeat(40), finished: `2026-10-0${n}T10:00:00.000Z` },
    roots: [{ ...root(path, changes), applied: true }],
    waves: [{ number: 1, roots: [path], approval: "approved" }],
  });
  return changeRows(report, `runs/${n}`);
}

/** changes.json after the applies, newest first, as the bucket holds it. */
function history(...applies: ChangeRow[][]): ChangeRow[] {
  let text: string | undefined;
  for (const rows of applies) text = JSON.stringify(addToChanges(text, rows));
  return text === undefined ? [] : (JSON.parse(text) as { changes: ChangeRow[] }).changes;
}

const planned = (changes: Record<string, unknown>[]): Report => buildReport({ run: RUN, roots: [root("app", changes)], waves: [{ number: 1, roots: ["app"] }], gate: "on-destructive" });

/** Three applies, each rebuilding the archive and replacing the ACL, and one that also changed the queue. */
const THREE = (): ChangeRow[] => history(
  applied(1, [lambda("a", "b"), bucket(), queue(30, 60)]),
  applied(2, [lambda("b", "c"), bucket()]),
  applied(3, [lambda("c", "d"), bucket()]),
);

describe("marking a change on every run", () => {
  it("marks a change the root's last applied waves each made, with its streak", () => {
    const report = planned([lambda("d", "e"), bucket()]);
    expect(markPerpetual(report, THREE())).toBe(2);
    const [acl, fn] = report.roots[0].changes;
    expect(fn).toMatchObject({ address: "module.api.aws_lambda_function.this", perpetual: true, streak: 3 });
    expect(acl).toMatchObject({ address: "aws_s3_bucket_acl.logs", action: "replace", perpetual: true, streak: 3 });
    expect(validate(SCHEMA, JSON.parse(JSON.stringify(report)))).toEqual([]);
  });

  it(`takes ${PERPETUAL_WAVES} waves in a row: fewer, or a newest wave without it, marks nothing`, () => {
    const two = history(applied(1, [lambda("a", "b")]), applied(2, [lambda("b", "c")]));
    const fewer = planned([lambda("c", "d")]);
    expect(markPerpetual(fewer, two)).toBe(0);
    // Four waves made it, then the newest wave changed only the queue.
    const broken = history(applied(1, [lambda("a", "b")]), applied(2, [lambda("b", "c")]), applied(3, [lambda("c", "d")]), applied(4, [lambda("d", "e")]), applied(5, [queue(30, 60)]));
    const report = planned([lambda("e", "f")]);
    expect(markPerpetual(report, broken)).toBe(0);
    expect(report.roots[0].changes[0].perpetual).toBeUndefined();
  });

  it("counts the waves in a row past the threshold", () => {
    const rows = history(...[1, 2, 3, 4, 5].map((n) => applied(n, [lambda(String(n), String(n + 1))])));
    const report = planned([lambda("6", "7")]);
    markPerpetual(report, rows);
    expect(report.roots[0].changes[0].streak).toBe(5);
  });

  it("never marks a change this pull request makes first, even on a resource with a change on every run", () => {
    // The pull request raises the function's memory: the same resource, another attribute too.
    const report = planned([lambda("d", "e", [128, 256]), queue(60, 90)]);
    expect(markPerpetual(report, THREE())).toBe(0);
    expect(report.roots[0].changes.every((c) => c.perpetual === undefined && c.streak === undefined)).toBe(true);
  });

  it("reads only the root's own waves", () => {
    const other = history(applied(1, [lambda("a", "b")], "other"), applied(2, [lambda("b", "c")], "other"), applied(3, [lambda("c", "d")], "other"));
    const report = planned([lambda("d", "e")]);
    expect(markPerpetual(report, other)).toBe(0);
  });

  it("changes no digest, no wave's gate and no named destroy", () => {
    const plain = planned([lambda("d", "e"), bucket()]);
    const marked = planned([lambda("d", "e"), bucket()]);
    markPerpetual(marked, THREE());
    expect(marked.waves).toEqual(plain.waves);
    expect(marked.waves[0].waits).toBe(true);
    expect(marked.named).toEqual(plain.named);
    expect(marked.roots.map((r) => r.plan_digest)).toEqual(plain.roots.map((r) => r.plan_digest));
    expect(marked.groups).toEqual(plain.groups);
  });
});

describe("the note's section", () => {
  it("folds the changes after the groups, each with its attributes, streak and the usual fixes", () => {
    const report = planned([lambda("d", "e"), bucket(), queue(60, 90)]);
    markPerpetual(report, THREE());
    const note = renderNote(report);
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, note);
    }
    expect(note).toBe(readFileSync(GOLDEN, "utf-8"));
    expect(note).toContain("<details><summary>Changes on every run (2)</summary>");
    expect(note).toContain("| [`app`](report.html#root-app): `module.api.aws_lambda_function.this` | `source_code_hash` | 3 |");
    expect(note).toContain("`lifecycle { ignore_changes }`");
    expect(note.indexOf("Changes on every run")).toBeGreaterThan(note.indexOf("#### "));
    // The replacement is still named first, as every replacement is.
    expect(note.indexOf("aws_s3_bucket_acl.logs")).toBeLessThan(note.indexOf("#### "));
  });

  it("shows a group of only such changes by name, without its diff", () => {
    const report = planned([lambda("d", "e")]);
    markPerpetual(report, THREE());
    const note = renderNote(report, { plans: new Map([["app", '  # module.api.aws_lambda_function.this will be updated in-place\n  ~ resource "aws_lambda_function" "this" {\n      ~ source_code_hash = "d" -> "e"\n    }\n\nPlan: 0 to add, 1 to change, 0 to destroy.\n']]) });
    expect(note).toMatch(/#### .*, change, on every run/);
    expect(note).not.toContain("As `app` plans it");
  });

  it("is absent with nothing marked, and the note is as it was", () => {
    const report = planned([lambda("d", "e")]);
    const before = renderNote(report);
    markPerpetual(report, []);
    expect(recurringBlock(report)).toBeUndefined();
    expect(renderNote(report)).toBe(before);
    expect(before).not.toContain("Changes on every run");
  });
});

describe("the plan job's marking", () => {
  const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
  const reports = { bucket: "acme-reports", endpoint: "http://minio:9000", prefix: "tg" };
  const store = (objects: Map<string, string>): S3Fetch => async (url) => {
    const key = decodeURIComponent(new URL(url).pathname.split("/").slice(2).join("/"));
    const body = objects.get(key);
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: async () => body ?? "" };
  };

  it("without reports marks nothing, and the log says why", async () => {
    const report = planned([lambda("d", "e")]);
    const said: string[] = [];
    expect(await markRecurring(report, undefined, ENV, undefined, (l) => said.push(l))).toBe(0);
    expect(said).toEqual(["changes on every run: no change is marked, since reports is not set and the applied waves are read from the bucket's changes.json"]);
    expect(report.roots[0].changes[0].perpetual).toBeUndefined();
  });

  it("reads the project's changes.json under the prefix", async () => {
    const key = changesKey(RUN.project, "tg");
    const report = planned([lambda("d", "e")]);
    const said: string[] = [];
    expect(await markRecurring(report, reports, ENV, store(new Map([[key, JSON.stringify({ schema: "terragucci.changes/v1", changes: THREE() })]])), (l) => said.push(l))).toBe(1);
    expect(said[0]).toContain(`1 marked`);
    expect(report.roots[0].changes[0]).toMatchObject({ perpetual: true, streak: 3 });
  });

  it("with no changes.json yet marks nothing and says so", async () => {
    const report = planned([lambda("d", "e")]);
    const said: string[] = [];
    expect(await markRecurring(report, reports, ENV, store(new Map()), (l) => said.push(l))).toBe(0);
    expect(said[0]).toContain("holds no applied wave yet");
  });
});
