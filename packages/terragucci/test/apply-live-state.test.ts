import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { reportEntry } from "../src/report/audit";
import type { Report } from "../src/report/schema";
import { validate, type Json } from "../../../scripts/schema-check";
import { setup } from "./apply-helpers";

const PLAN = JSON.stringify({ resource_changes: [{ address: "terraform_data.x", mode: "managed", type: "terraform_data", name: "x", change: { actions: ["create"], before: null, after: { input: "1" }, after_unknown: {} } }] });

/**
 * A wave of three roots with no backend block: `a`, a choudoufu live root
 * whose live block declares an S3 record store; `b`, a live root whose
 * `estate.chdf.hcl` declares none, so its records go to the implied local
 * store; and `c`, a plain root, whose state is the local terraform.tfstate.
 */
async function applied(): Promise<{ report: Report; lines: string[] }> {
  const { work, bin } = setup({
    "a/main.tf": 'terraform {\n  live {\n    estate = "shop"\n    record_store "s3" {\n      bucket = "acme-records"\n    }\n  }\n}\n\nresource "terraform_data" "x" {}\n',
    "b/main.tf": 'resource "terraform_data" "x" {}\n',
    "b/estate.chdf.hcl": 'estate = "net"\n',
    "c/main.tf": 'resource "terraform_data" "x" {}\n',
  });
  for (const r of ["b", "c"]) writeFileSync(join(work, "..", "plans", `${r}.json`), PLAN);
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
  expect(await applyWave(work, { wave: 1, layers: [["a", "b", "c"]], binary: bin, gate: "never", env: {} })).toBe(0);
  return { report: JSON.parse(readFileSync(join(work, "terragucci-report", "report.json"), "utf-8")) as Report, lines };
}

describe("a choudoufu live root's state versions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("name each live root's record store, never terraform.tfstate, and a plain root's state as before", async () => {
    const { report } = await applied();
    const e = reportEntry(report, "p", { source: "report" }, []);
    expect(e?.detail?.state_versions).toEqual([
      { root: "a", record_store: "s3://acme-records/tofu-records/shop/" },
      { root: "b", record_store: "local" },
      { root: "c", location: "terraform.tfstate", versioning: "off" },
    ]);
    expect(JSON.stringify(e?.detail?.state_versions)).not.toMatch(/"root":"[ab]","location"/);
  });

  it("keep no state on a live root in the wave's report, and its live block's store in its place", async () => {
    const { report, lines } = await applied();
    const root = (p: string) => report.roots.find((r) => r.path === p)!;
    expect(root("a").state).toBeUndefined();
    expect(root("a").live).toEqual({ estate: "shop", record_store: "s3://acme-records/tofu-records/shop/", secrets: "store" });
    expect(root("b").state).toBeUndefined();
    expect(root("b").live).toEqual({ estate: "net", record_store: "local", secrets: "store" });
    expect(root("c").state).toEqual({ backend: "local", location: "terraform.tfstate", versioning: "off", note: "a local backend keeps only the latest state" });
    expect(root("c").live).toBeUndefined();
    expect(lines).toContain("a: no state file; its records are in s3://acme-records/tofu-records/shop/");
    expect(lines).toContain("b: no state file; its records are in local");
    expect(lines).toContain("c: state terraform.tfstate, versions off (a local backend keeps only the latest state)");
    expect(lines.some((l) => /^[ab]: state /.test(l))).toBe(false);
    expect(validate(JSON.parse(readFileSync(join(import.meta.dirname, "../src/report/report.schema.json"), "utf-8")) as Json, report as unknown as Json)).toEqual([]);
  });
});
