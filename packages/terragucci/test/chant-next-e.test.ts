// terragucci#1282 part e: chant's exit-code table (chant#4553), and the switches onto the terraform lexicon's drift rows
// (chant#4580), the op-wave step contract (chant#4545) and chant's OTLP exporter (chant#4555), on the chant the tree pins.
import { describe, expect, it } from "vitest";
import { CHANT_EXIT } from "@intentius/chant/exit-codes";
import { chantOpWaveStep } from "../src/chant-next";
import { waveCallArgv, waveExit, waveStepProblems, wavesStepSpec } from "../src/chant-waves";
import { driftCount, driftNames } from "../src/report/drift";
import { send } from "../src/telemetry";

const step = await chantOpWaveStep();


describe("exit codes", () => {
  it("pass chant's code through, and a code terragucci's own calls came to takes a non-zero exit", () => {
    expect(waveExit(0, 1)).toBe(0);
    expect(waveExit(7)).toBe(7);
    expect(waveExit(8)).toBe(8);
    expect(waveExit(4, 1)).toBe(1);
  });

  it("are chant's table: 0 done, 1 failed, 2 drift, 3 waiting, 4 moved, 5 held, 6 superseded, 7 denied, 8 declined", () => {
    expect(CHANT_EXIT).toEqual({ done: 0, failed: 1, drift: 2, waiting: 3, moved: 4, held: 5, superseded: 6, denied: 7, declined: 8 });
  });
});

const PLAN = {
  resource_drift: [
    { address: "aws_s3_bucket.a", mode: "managed", change: { actions: ["update"], before: { bucket: "a-1" }, after: { bucket: "a-1", tags: {} } } },
    { address: "aws_s3_bucket.b", mode: "managed", change: { actions: ["delete"], before: { id: "b-1" }, after: null } },
    { address: "data.aws_caller_identity.me", mode: "data", change: { actions: ["read"], before: null, after: {} } },
  ],
};

describe("drift rows", () => {
  it("count and name the drift by the terraform lexicon's rows: every resource_drift entry, named by name, id, bucket, function_name or arn", () => {
    expect(driftCount(PLAN)).toBe(3);
    expect([...driftNames(PLAN)]).toEqual([["aws_s3_bucket.a", "a-1"], ["aws_s3_bucket.b", "b-1"]]);
  });
});

describe("the op-wave step contract", () => {
  const input = { waves: [["network"], ["app", "edge"]], gate: "always" as const, approval: "ledger" as const, call: waveCallArgv, migrations: true, reads: { app: [{ var: "vpc_id", root: "network", output: ["vpc_id"] }] }, approveAbove: 100, policy: true };

  it("plans and applies through terraform-apply, with migrate and the gate's report kept as hooks", () => {
    const spec = wavesStepSpec(input) as unknown as Record<string, any>;
    expect(spec.name).toBe("tf-apply");
    expect(spec.gateName).toBe("wave-{k}");
    expect(spec.step).toEqual({ kind: "terraform-apply", root: "{target}" });
    expect(spec.planWave).toBeUndefined();
    expect(spec.applyWave).toBeUndefined();
    expect(spec.holds.policy).toBe(true);
    expect(spec.holds.cost.approveAbove).toBe(100);
    expect(spec.hooks.after.plan).toBeUndefined();
    expect(spec.hooks.after.gate[0].command).toEqual(waveCallArgv("gate", "{runs}"));
    expect(spec.waves[0].hooks.before.plan.map((h: { name: string }) => h.name)).toEqual(["migrations", "migration gate"]);
    expect(spec.waves[1].runs).toEqual([{ target: "app", input: { reads: [{ var: "vpc_id", root: "network", output: ["vpc_id"] }] } }, { target: "edge" }]);
  });

  it.runIf(step)("is a spec chant's step check accepts", () => {
    const spec = wavesStepSpec(input) as unknown as Record<string, any>;
    expect(step!.opWaveStepProblems(spec)).toEqual([]);
    expect(step!.opWaveHoldsProblems(spec.holds)).toEqual([]);
  });

  it("says why a repo keeps the call back", () => {
    expect(waveStepProblems({ roots: ["a"], declaredRoots: new Set(["a"]) })).toEqual([]);
    expect(waveStepProblems({ roots: ["a", "b"], declaredRoots: new Set(["a"]), terragrunt: true })).toHaveLength(2);
  });
});

describe("OTLP", () => {
  it("answers a refused POST with the collector's status, through chant's exporter", async () => {
    const fetchFn = async () => ({ ok: false, status: 503, text: async () => "busy" });
    expect(await send({ url: "http://127.0.0.1:1/v1/traces", headers: {} }, {}, fetchFn)).toContain("503");
  });
});
