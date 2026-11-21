/**
 * The report store's files, against what the release before wrote for the
 * same inputs (fixtures/store-format/old, written by that release's code from
 * fixtures/store-format/inputs.ts): terragucci writes them as it did, and
 * reads each one in chant's format as well, the same body under chant's
 * neutral id with `product: "terragucci"`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { neutralReport, readAuditLine, readReportSchema, reportProduct } from "@intentius/chant/report-store";
import { appendEntries, missingEntries, readRecord } from "../src/report/audit";
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

describe("the report store, against the release before", () => {
  it("report.json: written as before; chant's form of it names terragucci and passes chant's schema", () => {
    const report = buildReport({ run: RUN, roots: smallFixture(), waves: [{ number: 1, roots: ["envs/dev/orders", "envs/dev/search"] }, { number: 2, roots: ["envs/prod/orders", "envs/prod/search"] }] });
    expect(JSON.stringify(report, null, 2)).toBe(old("report.json").trimEnd());
    const neutral = storedDoc(report, "run");
    expect(readReportSchema(neutral.schema)).toEqual({ kind: "run", neutral: true });
    expect(reportProduct(neutral)).toBe("terragucci");
    expect(validate(chantSchema("run"), { schema: neutral.schema, product: neutral.product })).toEqual([]);
  });

  it("run.json: written as before; both forms read as a run view", () => {
    const view = withWave(undefined, runSkeleton(PROJECT, COMMIT, RUN_WAVES, RUN_READS), { number: 1, state: "applied" }, NOW.toISOString());
    const was = JSON.parse(old("run.json")) as Json & { schema: string };
    expect(JSON.stringify(view, null, 2) + "\n").toBe(old("run.json"));
    const neutral = neutralReport(was, "run", "terragucci");
    expect(isRunView(view)).toBe(true);
    expect(isRunView(neutral)).toBe(true);
    // A neutral run view of another product, or one naming no product, is not terragucci's.
    expect(isRunView({ ...neutral, product: "plywood" })).toBe(false);
    expect(isRunView({ ...neutral, product: undefined })).toBe(false);
    // A job that finds chant's form keeps the rows it holds, and writes terragucci's.
    const next = withWave(JSON.stringify(neutral), runSkeleton(PROJECT, COMMIT, RUN_WAVES, RUN_READS), { number: 2, state: "applied" }, NOW.toISOString());
    expect(next.waves.map((w) => w.state)).toEqual(["applied", "applied"]);
    expect(next.schema).toBe("terragucci.run/v1");
  });

  it("dora.json: written as before; both forms are terragucci's", () => {
    const dora = buildDora([{ project: PROJECT, rows: [] }], AUDIT_ENTRIES, NOW);
    expect(JSON.stringify(dora, null, 2) + "\n").toBe(old("dora.json"));
    const neutral = storedDoc(dora, "dora");
    expect(isOwn(dora, "dora", "terragucci.dora/v1") && isOwn(neutral, "dora", "terragucci.dora/v1")).toBe(true);
    expect(isOwn({ ...neutral, product: "sql-yodeler" }, "dora", "terragucci.dora/v1")).toBe(false);
  });

  it("audit.jsonl: written as before; chant.audit/v1 lines naming terragucci read as the same entries", () => {
    const text = appendEntries(readRecord(undefined), AUDIT_ENTRIES);
    const was = old("audit.jsonl");
    expect(text).toBe(was);
    const schema = chantSchema("audit");
    const neutral = was.split("\n").filter(Boolean).map((l) => readAuditLine(JSON.parse(l))!);
    for (const [i, l] of neutral.entries()) {
      expect(l, `line ${i + 1}`).toMatchObject({ schema: "chant.audit/v1", product: "terragucci" });
      expect(validate(schema, l as unknown as Json), `line ${i + 1}`).toEqual([]);
    }
    expect(neutral.map((l) => [l.kind, l.product_kind])).toEqual([["approval-requested", undefined], ["approved", "approval"], ["applied", "apply"], ["recorded", "unrecorded-write"]]);
    const neutralText = neutral.map((l) => JSON.stringify(l)).join("\n") + "\n";
    expect(readRecord(neutralText).entries).toEqual(readRecord(was).entries);
    // A record holding chant's lines lacks none of the entries, and keeps its lines as they are.
    expect(missingEntries(readRecord(neutralText), AUDIT_ENTRIES)).toEqual([]);
    expect(appendEntries(readRecord(neutralText), [])).toBe(neutralText);
  });

  it("refuses a neutral line or document that names another product", () => {
    const line = readAuditLine(JSON.parse(appendEntries(readRecord(undefined), AUDIT_ENTRIES.slice(0, 1))));
    expect(readRecord(JSON.stringify({ ...line, product: "plywood" })).entries).toEqual([]);
    expect(isOwn({ schema: "chant.estate/v1" }, "estate", "terragucci.estate/v1")).toBe(false);
  });
});
