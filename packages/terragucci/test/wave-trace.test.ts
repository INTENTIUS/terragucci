import { describe, expect, it } from "vitest";
import { buildReport } from "../src/report/build";
import { StageObserver } from "../src/report/observe";
import { telemetryFromEnv } from "../src/telemetry";
import { RUN, smallFixture } from "./report-fixtures";

type OtlpSpan = { spanId: string; parentSpanId?: string; name: string; attributes: { key: string; value: Record<string, unknown> }[] };
type Body = { resourceSpans: { resource: { attributes: { key: string; value: Record<string, unknown> }[] }; scopeSpans: { spans: OtlpSpan[] }[] }[] };

/** Run a tf-apply wave's observer through `drive` and return the trace body it sends. */
async function sent(env: NodeJS.ProcessEnv, drive: (o: StageObserver) => Promise<void>, wave: { applied?: string[]; state?: "applied" | "failed" } = {}): Promise<Body> {
  const observer = new StageObserver(telemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_METRICS_EXPORTER: "none", ...env }), "tf-apply", env);
  observer.wave = { number: 2, facts: { roots: ["envs/dev/orders"] }, code: 0 };
  await drive(observer);
  const roots = smallFixture().map((r) => (wave.applied?.includes(r.path) ? { ...r, applied: true } : r));
  const report = buildReport({ run: { ...RUN, stage: "tf-apply" as never, wave: 2 }, roots, waves: [{ number: 2, roots: roots.map((r) => r.path), ...(wave.state ? { state: wave.state } : {}) }] });
  let body: Body | undefined;
  await observer.finish(report, env, () => {}, async (url, init) => {
    if (url.endsWith("/v1/traces")) body = JSON.parse(init.body) as Body;
    return { ok: true, status: 200, text: async () => "" };
  });
  return body!;
}

const value = (attrs: { key: string; value: Record<string, unknown> }[], key: string) => Object.values(attrs.find((a) => a.key === key)?.value ?? {})[0];
const ok = { status: 0 };

describe("a tf-apply wave's trace (behold#571)", () => {
  it("names its project, commit, pipeline run and job on the resource", async () => {
    const body = await sent({ GITHUB_RUN_ID: "4182", GITHUB_JOB: "apply-wave-2" }, async () => {});
    const resource = body.resourceSpans[0]!.resource.attributes;
    expect(value(resource, "terragucci.project")).toBe(RUN.project);
    expect(value(resource, "vcs.ref.head.revision")).toBe(RUN.commit);
    expect(value(resource, "cicd.pipeline.run.id")).toBe("4182");
    expect(value(resource, "cicd.pipeline.task.name")).toBe("apply-wave-2");
    const stage = body.resourceSpans[0]!.scopeSpans[0]!.spans.find((s) => s.name === "terragucci tf-apply")!;
    expect(value(stage.attributes, "terragucci.wave")).toBe("2");
  });

  it("names GitLab's pipeline and job the same way", async () => {
    const body = await sent({ CI_PIPELINE_ID: "77", CI_JOB_NAME: "apply-wave-2" }, async () => {});
    const resource = body.resourceSpans[0]!.resource.attributes;
    expect(value(resource, "cicd.pipeline.run.id")).toBe("77");
    expect(value(resource, "cicd.pipeline.task.name")).toBe("apply-wave-2");
  });

  it("hangs each root under the phase it ran in: its plan under plan, its apply under apply", async () => {
    const body = await sent({}, async (o) => {
      const plan = o.phase("plan");
      const t = o.root("envs/dev/orders");
      await o.commandAsync(t, "tofu", ["plan"], {}, async () => ok);
      o.endRoot(t);
      o.endPhase(plan);
      const gate = o.phase("gate", { "terragucci.gate.status": "approved" });
      o.endPhase(gate);
      const apply = o.phase("apply");
      o.reopen(t);
      await o.commandAsync(t, "tofu", ["apply"], {}, async () => ok);
      o.endRoot(t);
      o.endPhase(apply);
      o.endPhase(o.phase("report"));
      o.endPhase(o.phase("upload"));
    });
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const byId = new Map(spans.map((s) => [s.spanId, s]));
    const parentName = (s: OtlpSpan) => (s.parentSpanId ? byId.get(s.parentSpanId)?.name : undefined);
    const stage = spans.find((s) => s.name === "terragucci tf-apply")!;
    const phases = spans.filter((s) => s.parentSpanId === stage.spanId).map((s) => s.name);
    expect(phases).toEqual(["plan", "gate", "apply", "report", "upload"]);
    const roots = spans.filter((s) => s.name === "root envs/dev/orders");
    expect(roots.map(parentName)).toEqual(["plan", "apply"]);
    expect(parentName(spans.find((s) => s.name === "tofu plan")!)).toBe("root envs/dev/orders");
    expect(byId.get(spans.find((s) => s.name === "tofu apply")!.parentSpanId!)!.parentSpanId).toBe(spans.find((s) => s.name === "apply")!.spanId);
    // A wave timed in phases has no separate wave span: its stage span is the wave.
    expect(spans.some((s) => s.name === "wave 2")).toBe(false);
    expect(value(spans.find((s) => s.name === "gate")!.attributes, "terragucci.gate.status")).toBe("approved");
    // Both of the root's spans carry what the report says of it.
    for (const r of roots) expect(value(r.attributes, "terragucci.status")).toBeDefined();
  });

  /** A wave whose envs/dev/orders and envs/dev/search planned, then applied under the apply phase. */
  const planThenApply = async (o: StageObserver) => {
    const plan = o.phase("plan");
    const roots = ["envs/dev/orders", "envs/dev/search"].map((p) => o.root(p));
    for (const t of roots) o.endRoot(t);
    o.endPhase(plan);
    const apply = o.phase("apply");
    for (const t of roots) {
      o.reopen(t);
      o.endRoot(t);
    }
    o.endPhase(apply);
  };
  const statuses = (body: Body) => {
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const byId = new Map(spans.map((s) => [s.spanId, s]));
    return spans.filter((s) => s.name.startsWith("root ")).map((s) => `${byId.get(s.parentSpanId!)!.name} ${s.name}: ${value(s.attributes, "terragucci.status")}`);
  };

  it("a root under the apply phase reads applied once it applied, its plan's status under the plan phase", async () => {
    expect(statuses(await sent({}, planThenApply, { applied: ["envs/dev/orders", "envs/dev/search"], state: "applied" }))).toEqual([
      "plan root envs/dev/orders: planned",
      "plan root envs/dev/search: planned",
      "apply root envs/dev/orders: applied",
      "apply root envs/dev/search: applied",
    ]);
  });

  it("a root under the apply phase of a failed wave reads failed, unless the report lists what it applied", async () => {
    expect(statuses(await sent({}, planThenApply, { applied: ["envs/dev/orders"], state: "failed" }))).toEqual([
      "plan root envs/dev/orders: planned",
      "plan root envs/dev/search: planned",
      "apply root envs/dev/orders: applied",
      "apply root envs/dev/search: failed",
    ]);
  });

  it("a gate an approval let through spans the hold: held from the pending record to the approval, then this job's check", async () => {
    const body = await sent({}, async (o) => {
      const gate = o.phase("gate");
      o.holdGate(gate, { since: "2026-10-16T10:00:00Z", approvedAt: "2026-10-16T10:00:41Z" }, gate!.start + 300_000_000n);
      o.endPhase(gate);
    });
    const spans = body.resourceSpans[0]!.scopeSpans[0]!.spans as (OtlpSpan & { startTimeUnixNano: string; endTimeUnixNano: string })[];
    const gate = spans.find((s) => s.name === "gate")!;
    const held = spans.find((s) => s.name === "held")!;
    const check = spans.find((s) => s.name === "check")!;
    expect(held.parentSpanId).toBe(gate.spanId);
    expect(check.parentSpanId).toBe(gate.spanId);
    const ms = (s: { startTimeUnixNano: string; endTimeUnixNano: string }) => Number(BigInt(s.endTimeUnixNano) - BigInt(s.startTimeUnixNano)) / 1e6;
    expect(BigInt(gate.startTimeUnixNano)).toBe(BigInt(Date.parse("2026-10-16T10:00:00Z")) * 1_000_000n);
    expect(ms(held)).toBe(41_000);
    expect(ms(check)).toBe(300);
    expect(value(held.attributes, "terragucci.wait")).toBe("approval");
    expect(value(held.attributes, "terragucci.gate.held_seconds")).toBe("41");
  });
});
