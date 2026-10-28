// terragucci#1282 part e: the switches onto chant's exit-code table (chant#4553), the terraform lexicon's drift rows
// (chant#4580), the op-wave step contract (chant#4545) and chant's OTLP exporter (chant#4555). Each case stands a
// module in for chant's, makes it missing, or runs only when the installed chant has it.
import { afterEach, describe, expect, it } from "vitest";
import { chantDriftRows, chantExitCodes, chantOpWaveStep, chantOtlp, overrideChantNext } from "../src/chant-next";
import { stateCode, waveCallArgv, waveExit, waveStepProblems, wavesStepSpec } from "../src/chant-waves";
import { driftCount, driftNames } from "../src/report/drift";
import { send } from "../src/telemetry";

const exitCodes = await chantExitCodes();
const driftRows = await chantDriftRows();
const step = await chantOpWaveStep();
const otlp = await chantOtlp();

let restore: (() => void)[] = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

const TABLE = { CHANT_EXIT: { done: 0, failed: 1, drift: 2, waiting: 3, moved: 4, held: 5, superseded: 6, denied: 7, declined: 8 }, chantExitName: () => "" };

describe("exit codes", () => {
  it("map chant's denial and declined point onto terragucci's without chant's table", () => {
    restore.push(overrideChantNext("exitCodes", null));
    expect(waveExit(7)).toBe(1);
    expect(waveExit(8)).toBe(4);
    expect(waveExit(3)).toBe(3);
  });

  it("pass chant's code through with chant's table", async () => {
    restore.push(overrideChantNext("exitCodes", TABLE));
    await chantExitCodes();
    expect(waveExit(7)).toBe(7);
    expect(waveExit(8)).toBe(8);
    expect(waveExit(4, 1)).toBe(1);
  });

  it("read a wave's state from either", () => {
    expect([stateCode(7), stateCode(8), stateCode(3)]).toEqual([1, 4, 3]);
  });

  it.runIf(exitCodes)("match the installed chant's table", () => {
    expect(exitCodes!.CHANT_EXIT).toMatchObject(TABLE.CHANT_EXIT);
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
  it.runIf(driftRows)("count and name the drift as terragucci's own rules do", () => {
    const viaChant = { count: driftCount(PLAN), names: [...driftNames(PLAN)] };
    restore.push(overrideChantNext("driftRows", null));
    expect(viaChant).toEqual({ count: driftCount(PLAN), names: [...driftNames(PLAN)] });
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
  it("sends through chant's exporter when it is there", async () => {
    const sent: string[] = [];
    restore.push(overrideChantNext("otlp", { otlpFromEnv: () => undefined, OTLP_EXPORTER_FLOOR: "x", sendOtlp: async (t: { url: string }) => (sent.push(t.url), undefined) }));
    expect(await send({ url: "http://127.0.0.1:1/v1/traces", headers: {} }, {})).toBeUndefined();
    expect(sent).toEqual(["http://127.0.0.1:1/v1/traces"]);
  });

  it.runIf(otlp)("answers a refused POST as terragucci's sender did", async () => {
    const fetchFn = async () => ({ ok: false, status: 503, text: async () => "busy" });
    const viaChant = await send({ url: "http://127.0.0.1:1/v1/traces", headers: {} }, {}, fetchFn);
    restore.push(overrideChantNext("otlp", null));
    expect(viaChant).toBe(await send({ url: "http://127.0.0.1:1/v1/traces", headers: {} }, {}, fetchFn));
  });
});
