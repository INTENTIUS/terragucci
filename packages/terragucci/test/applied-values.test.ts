import { describe, expect, it } from "vitest";
import { stateSecrets } from "../src/report/applied-values";
import { buildReport } from "../src/report/build";
import { REDACTED } from "../src/report/schema";
import { plan, rc, RUN } from "./report-fixtures";

// A plan that creates a subnet (its id unknown) and a database whose password and endpoint are unknown.
const planned = plan([
  rc("terraform_data.subnet", ["create"], null, { input: "10.0.1.0/24" }, { after_unknown: { id: true, output: true } }),
  rc("aws_db_instance.main", ["create"], null, { name: "main" }, { after_unknown: { endpoint: true, password: true }, after_sensitive: { password: true } }),
  rc("terraform_data.fixed", ["create"], null, { input: "x" }),
]);

// `show -json` of the state after the apply.
const state = {
  format_version: "1.0",
  values: {
    root_module: {
      resources: [
        { address: "terraform_data.subnet", values: { id: "subnet-0abc", input: "10.0.1.0/24", output: "10.0.1.0/24" }, sensitive_values: {} },
        { address: "aws_db_instance.main", values: { name: "main", endpoint: "db.internal:5432", password: "hunter2-hunter2" }, sensitive_values: { password: true } },
        { address: "terraform_data.fixed", values: { id: "f1", input: "x" }, sensitive_values: {} },
      ],
    },
  },
};

const build = (appliedState?: unknown) =>
  buildReport({ run: { ...RUN, stage: "tf-apply" }, roots: [{ path: "network", plan: planned, planner: "tofu", applied: true, ...(appliedState ? { appliedState } : {}) }] });
const attrs = (r: ReturnType<typeof build>, address: string) => r.roots[0]!.changes.find((c) => c.address === address)!.attributes;

describe("an apply report records the values unknown at plan", () => {
  it("states each applied value once, in place of the unknown", () => {
    const a = attrs(build(state), "terraform_data.subnet");
    expect(a.find((x) => x.path === "id")).toEqual({ path: "id", after: "subnet-0abc" });
    expect(a.find((x) => x.path === "output")).toEqual({ path: "output", after: "10.0.1.0/24" });
    expect(a.filter((x) => x.path === "id")).toHaveLength(1);
    expect(a.some((x) => x.unknown)).toBe(false);
    // A known value stays as the plan stated it.
    expect(a.find((x) => x.path === "input")).toEqual({ path: "input", after: "10.0.1.0/24" });
  });

  it("leaves a sensitive value out and records it as sensitive", () => {
    const a = attrs(build(state), "aws_db_instance.main");
    expect(a.find((x) => x.path === "endpoint")).toEqual({ path: "endpoint", after: "db.internal:5432" });
    expect(a.find((x) => x.path === "password")).toEqual({ path: "password", sensitive: true });
    expect(JSON.stringify(build(state))).not.toContain("hunter2");
  });

  it("scrubs a sensitive state value wherever another attribute repeats it", () => {
    const leaky = structuredClone(state);
    (leaky.values.root_module.resources[0]!.values as Record<string, unknown>).output = "hunter2-hunter2";
    expect(stateSecrets(leaky)).toContain("hunter2-hunter2");
    const json = JSON.stringify(build(leaky));
    expect(json).not.toContain("hunter2");
    expect(json).toContain(REDACTED);
  });

  it("keeps a value unknown when the state does not hold it, and without a state changes nothing", () => {
    expect(attrs(build(), "terraform_data.subnet").find((x) => x.path === "id")).toEqual({ path: "id", unknown: true });
    const missing = build({ values: { root_module: { resources: [] } } });
    expect(attrs(missing, "terraform_data.subnet").find((x) => x.path === "id")?.unknown).toBe(true);
  });
});
