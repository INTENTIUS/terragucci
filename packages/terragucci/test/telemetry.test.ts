// A stage's traces and metrics: read from the standard OTEL_* variables, sent
// as OTLP/JSON, and off unless an endpoint is set. The stage test runs real
// tofu against a local receiver, so the binary's own spans are checked too.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runStage } from "../src/report/stage";
import { binaryEnv, metricsBody, parsePairs, parseTraceparent, send, telemetryFromEnv, Trace, tracesBody, type OtlpFetch } from "../src/telemetry";
import { tmp, write } from "./helpers";

const TOFU = spawnSync("tofu", ["version"]).status === 0;

describe("telemetry from the environment", () => {
  it("is off with no endpoint, and when the SDK is disabled", () => {
    expect(telemetryFromEnv({})).toBeUndefined();
    expect(telemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" })).toBeUndefined();
  });

  it("adds the signal path to the base endpoint and takes per-signal endpoints as given", () => {
    const t = telemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "https://m.example/otlp", OTEL_EXPORTER_OTLP_HEADERS: "x-key=a%20b,bad" })!;
    expect(t.traces).toEqual({ url: "http://c:4318/v1/traces", headers: { "x-key": "a b" } });
    expect(t.metrics?.url).toBe("https://m.example/otlp");
    expect(t.resource["service.name"]).toBe("terragucci");
  });

  it("turns one signal off with OTEL_*_EXPORTER=none, and refuses grpc with a reason", () => {
    const t = telemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_TRACES_EXPORTER: "none" })!;
    expect(t.traces).toBeUndefined();
    expect(t.metrics).toBeDefined();
    const g = telemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4317", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })!;
    expect(g.traces).toBeUndefined();
    expect(g.skipped[0]).toMatch(/grpc/);
  });

  it("parses traceparent and pairs", () => {
    expect(parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toEqual({ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331" });
    expect(parseTraceparent("00-00000000000000000000000000000000-b7ad6b7169203331-01")).toBeUndefined();
    expect(parsePairs("a=1, b = x%3Dy")).toEqual({ a: "1", b: "x=y" });
  });
});

describe("OTLP bodies", () => {
  it("joins a parent trace, and hands the binary its span as TRACEPARENT and as resource attributes", () => {
    const trace = new Trace("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    const top = trace.start("terragucci tf-plan");
    expect(top.parentSpanId).toBe("b7ad6b7169203331");
    const child = trace.start("tofu plan", top, { n: 2 }, 3);
    trace.end(child, {}, "exit 1");
    const env = binaryEnv({ OTEL_RESOURCE_ATTRIBUTES: "team=infra" }, trace, child, "envs/a");
    expect(env.TRACEPARENT).toBe(`00-0af7651916cd43dd8448eb211c80319c-${child.spanId}-01`);
    expect(env.OTEL_TRACES_EXPORTER).toBe("otlp");
    expect(parsePairs(env.OTEL_RESOURCE_ATTRIBUTES)).toEqual({ team: "infra", "terragucci.trace_id": trace.traceId, "terragucci.span_id": child.spanId, "terragucci.root": "envs/a" });
    expect(binaryEnv({ OTEL_TRACES_EXPORTER: "none" }, trace, child, "a").OTEL_TRACES_EXPORTER).toBe("none");

    const body = tracesBody(trace.spans, { "service.name": "terragucci" }, "0.2.0") as any;
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans[1]).toMatchObject({ name: "tofu plan", kind: 3, parentSpanId: top.spanId, status: { code: 2, message: "exit 1" }, attributes: [{ key: "n", value: { intValue: "2" } }] });
  });

  it("groups gauges by name", () => {
    const body = metricsBody([
      { name: "m", unit: "1", description: "d", value: 1, attributes: { a: "x" } },
      { name: "m", unit: "1", description: "d", value: 2.5, attributes: { a: "y" } },
    ], {}, "0.2.0", 5n) as any;
    const m = body.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(m).toHaveLength(1);
    expect(m[0].gauge.dataPoints.map((p: any) => [p.asDouble, p.timeUnixNano])).toEqual([[1, "5"], [2.5, "5"]]);
  });

  it("send reports a refusal or an unreachable endpoint and never throws", async () => {
    const refusing: OtlpFetch = async () => ({ ok: false, status: 401, text: async () => "no" });
    expect(await send({ url: "http://c/v1/traces", headers: {} }, {}, refusing)).toMatch(/401/);
    const down: OtlpFetch = async () => { throw new Error("ECONNREFUSED"); };
    expect(await send({ url: "http://c/v1/traces", headers: {} }, {}, down)).toMatch(/ECONNREFUSED/);
  });
});

/**
 * A local OTLP endpoint that keeps every request, in a process of its own:
 * the stage runs the binary with spawnSync, which would hold this process's
 * event loop while tofu sends its spans.
 */
const RECEIVER = `
const { createServer } = require("node:http");
const { appendFileSync } = require("node:fs");
const out = process.argv[1];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const type = String(req.headers["content-type"]);
    appendFileSync(out, JSON.stringify({ path: req.url, type, body: Buffer.concat(chunks).toString("base64") }) + "\\n");
    const proto = type.includes("protobuf");
    res.writeHead(200, { "content-type": proto ? "application/x-protobuf" : "application/json" });
    res.end(proto ? "" : "{}");
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
`;

async function receiver() {
  const file = join(tmp(), "got.jsonl");
  writeFileSync(file, "");
  const child = spawn(process.execPath, ["-e", RECEIVER, file], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve) => child.stdout.once("data", (d) => resolve(String(d).trim())));
  const got = () => readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => {
    const r = JSON.parse(l) as { path: string; type: string; body: string };
    return { ...r, body: Buffer.from(r.body, "base64") };
  });
  return { url: `http://127.0.0.1:${port}`, got, close: () => { child.kill(); } };
}

describe.skipIf(!TOFU)("terragucci stage tf-plan with telemetry", () => {
  it("sends one trace with a span per root, tofu's spans inside it, and metrics with the report's counts", { timeout: 120_000 }, async () => {
    const repo = write(tmp(), {
      "terragucci.yml": 'binary: tofu\nroots: ["envs/*"]\n',
      "envs/a/main.tf": 'resource "terraform_data" "x" {\n  input = 1\n}\n',
      "envs/b/main.tf": 'resource "terraform_data" "x" {\n  input = 2\n}\nresource "terraform_data" "y" {\n  input = 3\n}\n',
    });
    const rx = await receiver();
    try {
      const logs: string[] = [];
      const { report } = await runStage("tf-plan", repo, { env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: rx.url, OTEL_EXPORTER_OTLP_INSECURE: "true", TRACEPARENT: "" } }, (l) => logs.push(l));
      expect(logs.find((l) => l.startsWith("telemetry: sent"))).toMatch(/trace [\da-f]{32} \(\d+ spans\) and \d+ metric points/);

      const got = rx.got();
      const ours = got.filter((r) => r.type === "application/json");
      const traces = JSON.parse(ours.find((r) => r.path === "/v1/traces")!.body.toString());
      const spans = traces.resourceSpans[0].scopeSpans[0].spans as any[];
      const traceIds = new Set(spans.map((s) => s.traceId));
      expect(traceIds.size).toBe(1);
      const [traceId] = traceIds;
      const top = spans.filter((s) => !s.parentSpanId);
      expect(top.map((s) => s.name)).toEqual(["terragucci tf-plan"]);
      const roots = spans.filter((s) => s.name.startsWith("root "));
      expect(roots.map((s) => s.name).sort()).toEqual(["root envs/a", "root envs/b"]);
      const waves = spans.filter((s) => s.name.startsWith("wave "));
      for (const r of roots) expect(waves.map((w) => w.spanId)).toContain(r.parentSpanId);
      const runs = spans.filter((s) => s.name.startsWith("tofu "));
      expect(runs.map((s) => s.name)).toEqual(expect.arrayContaining(["tofu init", "tofu plan", "tofu show"]));

      // tofu reads TRACEPARENT: its own spans arrive as protobuf carrying the stage's trace id.
      const tofu = got.filter((r) => r.path === "/v1/traces" && r.type.includes("protobuf"));
      expect(tofu.length).toBeGreaterThan(0);
      expect(tofu.some((r) => r.body.includes(Buffer.from(traceId, "hex")))).toBe(true);

      const metrics = JSON.parse(ours.find((r) => r.path === "/v1/metrics")!.body.toString());
      const byName = Object.fromEntries((metrics.resourceMetrics[0].scopeMetrics[0].metrics as any[]).map((m) => [m.name, m.gauge.dataPoints]));
      const attr = (p: any, k: string) => p.attributes.find((a: any) => a.key === k)?.value.stringValue;
      const create = byName.terragucci_plan_changes.find((p: any) => attr(p, "action") === "create");
      expect(create.asDouble).toBe(report.totals.create);
      expect(report.totals.create).toBe(3);
      expect(byName.terragucci_roots_planned[0].asDouble).toBe(2);
      expect(byName.terragucci_root_plan_seconds.map((p: any) => attr(p, "root")).sort()).toEqual(["envs/a", "envs/b"]);
      expect(attr(byName.terragucci_stage_duration_seconds[0], "result")).toBe("success");
      expect(attr(byName.terragucci_binary_version[0], "binary")).toBe("tofu");
      const resource = metrics.resourceMetrics[0].resource.attributes as any[];
      // One series per project from run to run: the commit and the job are the trace's, not the metrics'.
      expect(resource.find((a) => a.key === "terragucci.project")).toBeDefined();
      expect(resource.find((a) => a.key === "vcs.ref.head.revision")).toBeUndefined();
      expect(resource.find((a) => a.key === "cicd.pipeline.run.url.full")).toBeUndefined();
    } finally {
      rx.close();
    }
  });

  it("sends nothing when no endpoint is set", { timeout: 60_000 }, async () => {
    const repo = write(tmp(), { "terragucci.yml": 'binary: tofu\nroots: ["a"]\n', "a/main.tf": 'resource "terraform_data" "x" {\n  input = 1\n}\n' });
    let calls = 0;
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OTEL_")));
    await runStage("tf-plan", repo, { env, otlpFetch: async () => { calls++; return { ok: true, status: 200, text: async () => "" }; } }, () => {});
    expect(calls).toBe(0);
  });
});
