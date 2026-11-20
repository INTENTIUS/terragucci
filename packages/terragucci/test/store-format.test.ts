/**
 * The report store's files in chant's format, against what the release
 * before it wrote for the same inputs (fixtures/store-format/old, written by
 * that release's code from fixtures/store-format/inputs.ts): the same body
 * under chant's neutral id with `product: "terragucci"`, read by chant's
 * readers and its published schemas, and still read by terragucci in either
 * form.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { neutralReport, readAuditRecord, readReportSchema, reportProduct, toProductAuditLine } from "@intentius/chant/report-store";
import { appendEntries, readRecord } from "../src/report/audit";
import { buildReport } from "../src/report/build";
import { buildDora } from "../src/report/dora";
import { isRunView, runSkeleton, withWave } from "../src/report/run-view";
import { isOwn, storedDoc } from "../src/report/store-format";
import { validate, type Json } from "../../../scripts/schema-check";
import { AUDIT_ENTRIES, COMMIT, NOW, PROJECT, RUN_READS, RUN_WAVES } from "./fixtures/store-format/inputs";
import { RUN, smallFixture } from "./report-fixtures";

const OLD = join(import.meta.dirname, "fixtures/store-format/old");
const old = (f: string): string => readFileSync(join(OLD, f), "utf-8");
const CHANT = join(import.meta.dirname, "../../../node_modules/@intentius/chant/dist/report-store");
const chantSchema = (kind: string): Json => JSON.parse(readFileSync(join(CHANT, `${kind}.schema.json`), "utf-8")) as Json;

describe("the report store in chant's format, against the release before", () => {
  it("report.json: chant.run/v1 with product terragucci, the body the same", () => {
    const report = buildReport({ run: RUN, roots: smallFixture(), waves: [{ number: 1, roots: ["envs/dev/orders", "envs/dev/search"] }, { number: 2, roots: ["envs/prod/orders", "envs/prod/search"] }] });
    const was = JSON.parse(old("report.json")) as Json & { schema: string };
    expect(was.schema).toBe("terragucci.report/v1");
    expect(JSON.stringify(report, null, 2)).toBe(JSON.stringify(neutralReport(was, "run", "terragucci"), null, 2));
    expect(readReportSchema(report.schema)).toEqual({ kind: "run", neutral: true });
    expect(reportProduct(report)).toBe("terragucci");
    expect(validate(chantSchema("run"), { schema: report.schema, product: report.product })).toEqual([]);
  });

  it("run.json: chant.run/v1 with product terragucci, the body the same; both forms read as a run view", () => {
    const view = withWave(undefined, runSkeleton(PROJECT, COMMIT, RUN_WAVES, RUN_READS), { number: 1, state: "applied" }, NOW.toISOString());
    const was = JSON.parse(old("run.json")) as Json & { schema: string };
    expect(was.schema).toBe("terragucci.run/v1");
    expect(JSON.stringify(view, null, 2) + "\n").toBe(JSON.stringify(neutralReport(was, "run", "terragucci"), null, 2) + "\n");
    expect(isRunView(view)).toBe(true);
    expect(isRunView(was)).toBe(true);
    // A neutral run view of another product, or one naming no product, is not terragucci's.
    expect(isRunView({ ...view, product: "plywood" })).toBe(false);
    expect(isRunView({ ...view, product: undefined })).toBe(false);
    // A job that finds the older form keeps the rows it holds.
    const next = withWave(JSON.stringify(was), runSkeleton(PROJECT, COMMIT, RUN_WAVES, RUN_READS), { number: 2, state: "applied" }, NOW.toISOString());
    expect(next.waves.map((w) => w.state)).toEqual(["applied", "applied"]);
  });

  it("dora.json: chant.dora/v1 with product terragucci, the body the same, and valid under chant's schema", () => {
    const dora = storedDoc(buildDora([{ project: PROJECT, rows: [] }], AUDIT_ENTRIES, NOW), "dora");
    const was = JSON.parse(old("dora.json")) as Json & { schema: string };
    expect(was.schema).toBe("terragucci.dora/v1");
    expect(JSON.stringify(dora, null, 2) + "\n").toBe(JSON.stringify(neutralReport(was, "dora", "terragucci"), null, 2) + "\n");
    expect(isOwn(dora, "dora", "terragucci.dora/v1") && isOwn(was, "dora", "terragucci.dora/v1")).toBe(true);
    expect(isOwn({ ...dora, product: "sql-yodeler" }, "dora", "terragucci.dora/v1")).toBe(false);
  });

  it("audit.jsonl: chant.audit/v1 lines with product terragucci; terragucci's word in product_kind and the root in what", () => {
    const text = appendEntries(readRecord(undefined), AUDIT_ENTRIES);
    const was = old("audit.jsonl");
    const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Json);
    const wasLines = was.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Json);
    expect(lines.length).toBe(wasLines.length);
    const schema = chantSchema("audit");
    for (const [i, l] of lines.entries()) {
      expect(l).toMatchObject({ schema: "chant.audit/v1", product: "terragucci" });
      expect(validate(schema, l), `line ${i + 1}`).toEqual([]);
      // chant maps each line back onto the one the release before wrote.
      expect(toProductAuditLine(l as never, "terragucci"), `line ${i + 1}`).toEqual(wasLines[i]);
    }
    expect(lines.map((l) => [l.kind, l.product_kind])).toEqual([["approval-requested", undefined], ["approved", "approval"], ["applied", "apply"], ["recorded", "unrecorded-write"]]);
    expect(lines[3]!.what).toBe("envs/dev/net");
    // chant's reader reads both forms as the same lines.
    expect(readAuditRecord(text).lines).toEqual(readAuditRecord(was).lines);
    // terragucci reads both forms as the same entries, and a record holding the older lines appends only what it lacks.
    expect(readRecord(text).entries).toEqual(readRecord(was).entries);
    expect(appendEntries(readRecord(was), [])).toBe(was);
  });

  it("refuses a neutral line or document that names another product", () => {
    const line = JSON.parse(appendEntries(readRecord(undefined), AUDIT_ENTRIES.slice(0, 1)));
    expect(readRecord(JSON.stringify({ ...line, product: "plywood" })).entries).toEqual([]);
    expect(isOwn({ schema: "chant.estate/v1" }, "estate", "terragucci.estate/v1")).toBe(false);
  });
});
