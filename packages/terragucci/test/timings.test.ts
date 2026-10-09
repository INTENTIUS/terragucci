// The report names where a run spent its time, from the binary's own spans:
// collected for the run on a loopback receiver, read as OTLP protobuf or
// JSON, and summed into each root's slowest resources and provider calls.
// The stage test runs a stand-in binary that posts spans as choudoufu would.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { applyWave } from "../src/apply";
import { runStage } from "../src/report/stage";
import { decodeTracesJson, decodeTracesProto, duration, rootTimings, SpanReceiver, type CollectedSpan } from "../src/report/spans";
import { tmp, write } from "./helpers";
import { plan as planJson, rc } from "./report-fixtures";

// ── OTLP, by hand ────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000_000_000n;
const MS = 1_000_000n;

interface SpanSpec {
  id: string;
  parent?: string;
  name: string;
  /** Start and end in ms after T0. */
  from: number;
  to: number;
  attrs?: Record<string, string | number>;
}

/** OTLP/JSON for spans, one resource and scope. */
function otlpJson(spans: SpanSpec[]): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: "service.name", value: { stringValue: "choudoufu" } }] },
      scopeSpans: [{
        scope: { name: "opentofu" },
        spans: spans.map((s) => ({
          traceId: "0af7651916cd43dd8448eb211c80319c",
          spanId: s.id,
          ...(s.parent ? { parentSpanId: s.parent } : {}),
          name: s.name,
          kind: 1,
          startTimeUnixNano: String(T0 + BigInt(s.from) * MS),
          endTimeUnixNano: String(T0 + BigInt(s.to) * MS),
          attributes: Object.entries(s.attrs ?? {}).map(([key, v]) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } })),
        })),
      }],
    }],
  };
}

const varint = (n: bigint | number): Buffer => {
  let v = BigInt(n);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
};
const tag = (no: number, wire: number): Buffer => varint((no << 3) | wire);
const len = (no: number, b: Buffer): Buffer => Buffer.concat([tag(no, 2), varint(b.length), b]);
const str = (no: number, s: string): Buffer => len(no, Buffer.from(s));
const fixed64 = (no: number, n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return Buffer.concat([tag(no, 1), b]);
};
const anyValue = (v: string | number | boolean): Buffer =>
  typeof v === "string" ? str(1, v) : typeof v === "boolean" ? Buffer.concat([tag(2, 0), varint(v ? 1 : 0)]) : Buffer.concat([tag(3, 0), varint(BigInt.asUintN(64, BigInt(v)))]);
const keyValue = (no: number, k: string, v: string | number | boolean): Buffer => len(no, Buffer.concat([str(1, k), len(2, anyValue(v))]));

/** An `ExportTraceServiceRequest` in protobuf. */
function otlpProto(spans: (SpanSpec & { error?: boolean })[]): Buffer {
  const encoded = spans.map((s) => len(2, Buffer.concat([
    len(1, Buffer.from("0af7651916cd43dd8448eb211c80319c", "hex")),
    len(2, Buffer.from(s.id, "hex")),
    ...(s.parent ? [len(4, Buffer.from(s.parent, "hex"))] : []),
    str(5, s.name),
    Buffer.concat([tag(6, 0), varint(1)]),
    fixed64(7, T0 + BigInt(s.from) * MS),
    fixed64(8, T0 + BigInt(s.to) * MS),
    ...Object.entries(s.attrs ?? {}).map(([k, v]) => keyValue(9, k, v)),
    ...(s.error ? [len(15, Buffer.concat([str(2, "boom"), tag(3, 0), varint(2)]))] : []),
  ])));
  const scopeSpans = len(2, Buffer.concat([len(1, str(1, "opentofu")), ...encoded]));
  const resource = len(1, keyValue(1, "service.name", "choudoufu"));
  return len(1, Buffer.concat([resource, scopeSpans]));
}

// A plan as choudoufu traces it: a graph walk, two resources (one refreshed),
// provider calls under them, a provider start and a lock wait.
const DETAILED: SpanSpec[] = [
  { id: "0000000000000001", name: "Graph walk", from: 0, to: 5000, attrs: { "opentofu.walk.operation": "plan" } },
  { id: "0000000000000002", parent: "0000000000000001", name: "Plan resource instance changes", from: 100, to: 3100, attrs: { "opentofu.resource_instance.address": "aws_instance.web", "opentofu.resource.type": "aws_instance", "opentofu.resource_instance.action": "create", "opentofu.provider_instance.address": "provider[\"registry.opentofu.org/hashicorp/aws\"]" } },
  { id: "0000000000000003", parent: "0000000000000002", name: "Refresh resource instance", from: 100, to: 900 },
  { id: "0000000000000004", parent: "0000000000000002", name: "tfplugin5.Provider/PlanResourceChange", from: 1000, to: 3000, attrs: { "rpc.method": "PlanResourceChange", "opentofu.provider.address": "registry.opentofu.org/hashicorp/aws", "opentofu.resource.type": "aws_instance" } },
  { id: "0000000000000005", parent: "0000000000000001", name: "Plan resource instance changes", from: 200, to: 1400, attrs: { "opentofu.resource_instance.address": "aws_s3_bucket.logs", "opentofu.resource.type": "aws_s3_bucket", "opentofu.resource_instance.action": "update" } },
  { id: "0000000000000006", parent: "0000000000000001", name: "tfplugin5.Provider/GetProviderSchema", from: 0, to: 250, attrs: { "opentofu.provider.address": "registry.opentofu.org/hashicorp/aws" } },
  { id: "0000000000000007", name: "Start provider", from: 0, to: 400, attrs: { "opentofu.provider.address": "registry.opentofu.org/hashicorp/aws" } },
  { id: "0000000000000008", name: "Start provider", from: 3000, to: 3100, attrs: { "opentofu.provider.address": "registry.opentofu.org/hashicorp/aws" } },
  { id: "0000000000000009", name: "State lock wait", from: 0, to: 2500, attrs: { "opentofu.state.backend": "s3", "opentofu.state.lock.operation": "OperationTypePlan", "opentofu.state.lock.attempts": 3 } },
];

// The same estate in aggregate mode: summary spans only.
const AGGREGATED: SpanSpec[] = [
  { id: "0000000000000011", name: "Graph walk", from: 0, to: 9000 },
  { id: "0000000000000012", parent: "0000000000000011", name: "Aggregate: Plan resource instance changes", from: 0, to: 9000, attrs: { "choudoufu.aggregate.kind": "resource_instance", "choudoufu.aggregate.count": 1200, "choudoufu.aggregate.detailed_count": 0, "choudoufu.aggregate.duration_total_ms": 64000, "choudoufu.aggregate.duration_max_ms": 2100, "choudoufu.aggregate.slowest": "aws_instance.fleet[17]", "opentofu.resource.type": "aws_instance" } },
  { id: "0000000000000013", parent: "0000000000000011", name: "Aggregate: tfplugin5.Provider/ReadResource", from: 0, to: 9000, attrs: { "choudoufu.aggregate.kind": "provider_call", "choudoufu.aggregate.count": 1200, "choudoufu.aggregate.detailed_count": 0, "choudoufu.aggregate.duration_total_ms": 30000, "choudoufu.aggregate.duration_max_ms": 900, "choudoufu.aggregate.slowest": "aws_instance", "opentofu.provider.address": "registry.opentofu.org/hashicorp/aws", "rpc.method": "ReadResource" } },
  { id: "0000000000000014", parent: "0000000000000011", name: "Aggregate: other", from: 0, to: 9000, attrs: { "choudoufu.aggregate.kind": "resource_instance", "choudoufu.aggregate.count": 40, "choudoufu.aggregate.detailed_count": 0, "choudoufu.aggregate.duration_total_ms": 800, "choudoufu.aggregate.duration_max_ms": 60, "choudoufu.aggregate.groups": 12 } },
];

const facts = { binary: "choudoufu", seconds: 6.5, planSeconds: 5.2 };

describe("reading OTLP traces", () => {
  it("decodes protobuf and JSON to the same spans", () => {
    const fromProto = decodeTracesProto(otlpProto(DETAILED));
    const fromJson = decodeTracesJson(otlpJson(DETAILED));
    expect(fromProto).toHaveLength(DETAILED.length);
    expect(fromProto).toEqual(fromJson);
    expect(fromProto[1]).toMatchObject({ spanId: "0000000000000002", parentSpanId: "0000000000000001", name: "Plan resource instance changes", start: T0 + 100n * MS, end: T0 + 3100n * MS });
    expect(fromProto[1].attributes["opentofu.resource_instance.address"]).toBe("aws_instance.web");
    expect(fromProto[8].attributes["opentofu.state.lock.attempts"]).toBe(3);
  });

  it("reads an error status, booleans and negative integers, and refuses a truncated message", () => {
    const [s] = decodeTracesProto(otlpProto([{ id: "00000000000000aa", name: "x", from: 0, to: 1, attrs: { n: -5 }, error: true }]));
    expect(s).toMatchObject({ error: true, attributes: { n: -5 } });
    const whole = otlpProto(DETAILED);
    expect(() => decodeTracesProto(whole.subarray(0, whole.length - 3))).toThrow();
  });
});

describe("a root's timings", () => {
  it("lists the slowest resources, provider calls, provider starts and lock waits", () => {
    const t = rootTimings(decodeTracesJson(otlpJson(DETAILED)), facts);
    expect(t).toMatchObject({ seconds: 6.5, plan_seconds: 5.2, spans: DETAILED.length, detail: "resources" });
    expect(t.note).toBeUndefined();
    expect(t.resources).toEqual([
      { address: "aws_instance.web", type: "aws_instance", action: "create", provider: "provider[\"registry.opentofu.org/hashicorp/aws\"]", ms: 3000, refresh_ms: 800 },
      { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", action: "update", ms: 1200 },
    ]);
    expect(t.provider_calls).toEqual([
      { method: "PlanResourceChange", provider: "registry.opentofu.org/hashicorp/aws", type: "aws_instance", address: "aws_instance.web", ms: 2000 },
      { method: "GetProviderSchema", provider: "registry.opentofu.org/hashicorp/aws", ms: 250 },
    ]);
    expect(t.provider_init).toEqual([{ provider: "registry.opentofu.org/hashicorp/aws", count: 2, ms: 500, max_ms: 400 }]);
    expect(t.lock_waits).toEqual([{ backend: "s3", operation: "OperationTypePlan", attempts: 3, ms: 2500 }]);
    expect(t.aggregates).toEqual([]);
  });

  // What stock OpenTofu sends for a root with an AWS provider: no "Start
  // provider" span, a "Configure provider" span per configured provider
  // (the builtin one included), the provider named in provider.source.
  const TOFU: SpanSpec[] = [
    { id: "0000000000000041", name: "Plan phase", from: 0, to: 600 },
    { id: "0000000000000042", parent: "0000000000000041", name: "Configure provider", from: 10, to: 20, attrs: { "opentofu.provider.source": "terraform.io/builtin/terraform", "opentofu.provider_config.address": "provider[\"terraform.io/builtin/terraform\"]" } },
    { id: "0000000000000043", parent: "0000000000000041", name: "Configure provider", from: 100, to: 220, attrs: { "opentofu.provider.source": "registry.opentofu.org/hashicorp/aws", "opentofu.provider_config.address": "provider[\"registry.opentofu.org/hashicorp/aws\"]" } },
    { id: "0000000000000044", parent: "0000000000000041", name: "Configure provider", from: 300, to: 450, attrs: { "opentofu.provider.source": "registry.opentofu.org/hashicorp/aws" } },
    { id: "0000000000000045", parent: "0000000000000041", name: "Validate provider configuration", from: 0, to: 90, attrs: { "opentofu.provider.source": "registry.opentofu.org/hashicorp/aws" } },
  ];

  it("reads OpenTofu's Configure provider spans as the provider start-up when no Start provider span came", () => {
    const t = rootTimings(decodeTracesJson(otlpJson(TOFU)), facts);
    expect(t.provider_init).toEqual([{ provider: "registry.opentofu.org/hashicorp/aws", count: 2, ms: 270, max_ms: 150 }]);
    expect(t.lock_waits).toEqual([]);
  });

  it("does not count choudoufu's Configure provider spans a second time beside its Start provider spans", () => {
    const both = [...DETAILED, ...TOFU];
    const t = rootTimings(decodeTracesJson(otlpJson(both)), facts);
    expect(t.provider_init).toEqual([{ provider: "registry.opentofu.org/hashicorp/aws", count: 2, ms: 500, max_ms: 400 }]);
  });

  it("lists aggregate-mode summaries by type, and says the resources are summed", () => {
    const t = rootTimings(decodeTracesJson(otlpJson(AGGREGATED)), facts);
    expect(t.detail).toBe("aggregate");
    expect(t.resources).toEqual([]);
    expect(t.note).toMatch(/summed its resources by type/);
    expect(t.aggregates[0]).toEqual({ of: "Plan resource instance changes", kind: "resource_instance", type: "aws_instance", count: 1200, detailed: 0, ms: 64000, max_ms: 2100, slowest: "aws_instance.fleet[17]" });
    expect(t.aggregates[1]).toMatchObject({ of: "tfplugin5.Provider/ReadResource", kind: "provider_call", method: "ReadResource", provider: "registry.opentofu.org/hashicorp/aws" });
    expect(t.aggregates[2]).toMatchObject({ of: "other", groups: 12, count: 40 });
  });

  it("says how many instances went past the budget when detail and summaries mix", () => {
    const mixed = [...DETAILED, { ...AGGREGATED[1], attrs: { ...AGGREGATED[1].attrs, "choudoufu.aggregate.count": 2002, "choudoufu.aggregate.detailed_count": 2 } }];
    const t = rootTimings(decodeTracesJson(otlpJson(mixed)), facts);
    expect(t.detail).toBe("resources");
    expect(t.note).toBe("past the span budget, 2000 resource instances are summed by type instead of listed");
  });

  it("says so when the binary sent no spans, or none per resource, or never planned", () => {
    expect(rootTimings([], { ...facts, binary: "terraform" })).toMatchObject({ detail: "none", spans: 0, note: expect.stringMatching(/^terraform sent no spans for the plan/) });
    const coarse: CollectedSpan[] = decodeTracesJson(otlpJson([{ id: "0000000000000021", name: "Plan phase", from: 0, to: 10 }]));
    expect(rootTimings(coarse, { ...facts, binary: "tofu" }).note).toBe("tofu sent 1 span for the plan, none of them per resource, so this root has no per-resource timings");
    expect(rootTimings([], { binary: "tofu", seconds: 1 }).note).toMatch(/did not reach a plan/);
  });

  it("writes durations a reader scans", () => {
    expect([duration(12.4), duration(3000), duration(59_990), duration(125_000)]).toEqual(["12ms", "3.0s", "1m00s", "2m05s"]);
  });
});

describe("the span receiver", () => {
  it("takes protobuf, gzipped or not, and JSON, by the token of the run that sent it, and refuses an unknown token", async () => {
    const rx = new SpanReceiver();
    expect(await rx.listen()).toBeUndefined();
    try {
      const env = rx.env({ OTEL_TRACES_EXPORTER: "none", KEEP: "1" }, "envs/a", "plan");
      expect(env).toMatchObject({ KEEP: "1", OTEL_TRACES_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf" });
      const [hk, hv] = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS!.split("=");
      const url = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!;
      const post = (body: Buffer | string, headers: Record<string, string>) => fetch(url, { method: "POST", headers, body: typeof body === "string" ? body : new Uint8Array(body) });
      expect((await post(otlpProto(DETAILED.slice(0, 3)), { "content-type": "application/x-protobuf", [hk]: hv })).status).toBe(200);
      expect((await post(gzipSync(otlpProto(DETAILED.slice(3, 6))), { "content-type": "application/x-protobuf", "content-encoding": "gzip", [hk]: hv })).status).toBe(200);
      expect((await post(JSON.stringify(otlpJson(DETAILED.slice(6))), { "content-type": "application/json", [hk]: hv })).status).toBe(200);
      expect((await post(otlpProto(DETAILED), { "content-type": "application/x-protobuf", [hk]: "not-a-run" })).status).toBe(401);
      expect(rx.spansOf("envs/a", "plan").map((s) => s.spanId)).toEqual(DETAILED.map((s) => s.id));
      expect(rx.spansOf("envs/a", "show")).toEqual([]);
    } finally {
      expect(await rx.close()).toEqual([]);
    }
  });

  it("forwards each batch unchanged to the stage's collector", async () => {
    const got: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const fake = (async (url: string, init: { headers: Record<string, string>; body: Uint8Array }) => {
      got.push({ url, headers: init.headers, body: Buffer.from(init.body) });
      return { ok: true, status: 200 };
    }) as unknown as typeof fetch;
    const rx = new SpanReceiver({ url: "http://collector:4318/v1/traces", headers: { "x-key": "k" } }, fake);
    await rx.listen();
    const env = rx.env({}, "a", "plan");
    const [hk, hv] = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS!.split("=");
    const body = otlpProto(DETAILED);
    await fetch(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!, { method: "POST", headers: { "content-type": "application/x-protobuf", [hk]: hv }, body: new Uint8Array(body) });
    expect(await rx.close()).toEqual([]);
    expect(got).toHaveLength(1);
    expect(got[0].url).toBe("http://collector:4318/v1/traces");
    expect(got[0].headers).toMatchObject({ "x-key": "k", "content-type": "application/x-protobuf" });
    expect(got[0].headers[hk]).toBeUndefined();
    expect(got[0].body.equals(body)).toBe(true);
  });
});

/**
 * A stand-in binary that plans from the root's plan.json and, on plan, posts
 * the root's spans.json to the trace endpoint it is given, as choudoufu's
 * exporter would; on apply it posts apply-spans.json. A root with no such
 * file sends nothing, as Terraform.
 */
function spanningBinary(dir: string): string {
  const path = join(dir, "choudoufu");
  writeFileSync(path, `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const [chdir, cmd, ...rest] = process.argv.slice(2);
const dir = chdir.replace(/^-chdir=/, "");
async function post(file = "spans.json") {
  const url = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!url || process.env.OTEL_TRACES_EXPORTER !== "otlp" || !existsSync(dir + "/" + file)) return;
  const headers = { "content-type": "application/json" };
  for (const p of (process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || "").split(",")) {
    const i = p.indexOf("=");
    if (i > 0) headers[p.slice(0, i)] = p.slice(i + 1);
  }
  const res = await fetch(url, { method: "POST", headers, body: readFileSync(dir + "/" + file) });
  if (!res.ok) { process.stderr.write("spans refused: " + res.status + "\\n"); process.exit(3); }
}
(async () => {
  if (cmd === "init") return;
  if (cmd === "plan") {
    for (const a of rest) if (a.startsWith("-out=")) writeFileSync(a.slice(5), "");
    await post();
    console.log("Plan: 1 to add, 0 to change, 0 to destroy.");
    return;
  }
  if (cmd === "show") process.stdout.write(rest[0] === "-json" ? readFileSync(dir + "/plan.json", "utf-8") : "plan text\\n");
  if (cmd === "apply") {
    await post("apply-spans.json");
    console.log("Apply complete! Resources: 1 added, 0 changed, 0 destroyed.");
  }
})();
`);
  chmodSync(path, 0o755);
  return path;
}

describe("terragucci stage tf-plan names where the time went", () => {
  it("lists a root's slowest resources from its spans, and says so for a root whose binary sent none", { timeout: 60_000 }, async () => {
    const one = JSON.stringify(planJson([rc("aws_instance.web", ["create"], null, { ami: "ami-1" })]));
    const repo = write(tmp(), {
      "terragucci.yml": 'roots: ["envs/*"]\n',
      "envs/a/main.tf": "", "envs/a/plan.json": one, "envs/a/spans.json": JSON.stringify(otlpJson(DETAILED)),
      "envs/b/main.tf": "", "envs/b/plan.json": one,
      "envs/c/main.tf": "", "envs/c/plan.json": one, "envs/c/spans.json": JSON.stringify(otlpJson(AGGREGATED)),
    });
    const out = join(tmp(), "report");
    const env = { PATH: process.env.PATH };
    const logs: string[] = [];
    const { report } = await runStage("tf-plan", repo, { binary: spanningBinary(tmp()), layers: [["envs/a", "envs/b", "envs/c"]], out, env }, (l) => logs.push(l));
    expect(logs.filter((l) => l.startsWith("timings:"))).toEqual([]);
    expect(report.minor).toBe(20);

    const root = (p: string) => report.roots.find((r) => r.path === p)!.timings!;
    expect(root("envs/a").detail).toBe("resources");
    expect(root("envs/a").resources.map((r) => [r.address, r.ms])).toEqual([["aws_instance.web", 3000], ["aws_s3_bucket.logs", 1200]]);
    expect(root("envs/a").plan_seconds).toBeGreaterThan(0);
    expect(root("envs/b")).toMatchObject({ detail: "none", spans: 0, resources: [], note: expect.stringMatching(/^choudoufu sent no spans for the plan/) });
    expect(root("envs/c")).toMatchObject({ detail: "aggregate", aggregates: [expect.objectContaining({ type: "aws_instance", count: 1200 }), expect.anything(), expect.anything()] });

    expect(report.timings!.roots.map((r) => r.root).sort()).toEqual(["envs/a", "envs/b", "envs/c"]);
    expect(report.timings!.resources[0]).toEqual({ root: "envs/a", address: "aws_instance.web", type: "aws_instance", ms: 3000 });

    const note = readFileSync(join(out, "note.md"), "utf-8");
    expect(note).toContain("Slowest: `envs/a: aws_instance.web` 3.0s, `envs/a: aws_s3_bucket.logs` 1.2s. [Where the time went](report.html#timings)");
    const html = readFileSync(join(out, "report.html"), "utf-8");
    expect(html).toContain('<section id="timings"><h2>Where the time went</h2>');
    expect(html).toContain("1 of 3 roots have no per-resource timings");
    expect(html).toContain("choudoufu sent no spans for the plan");
    expect(html).toContain("Summed by type");
    expect(JSON.parse(readFileSync(join(out, "report.json"), "utf-8")).timings).toEqual(report.timings);
  });

  it("keeps the note as it was when no root's binary sends spans", { timeout: 60_000 }, async () => {
    const repo = write(tmp(), {
      "terragucci.yml": 'roots: ["a"]\n',
      "a/main.tf": "", "a/plan.json": JSON.stringify(planJson([rc("aws_instance.web", ["create"], null, { ami: "ami-1" })])),
    });
    const out = join(tmp(), "report");
    const { report } = await runStage("tf-plan", repo, { binary: spanningBinary(tmp()), layers: [["a"]], out, env: { PATH: process.env.PATH } }, () => {});
    expect(report.timings).toMatchObject({ roots: [{ root: "a", detail: "none" }], resources: [] });
    expect(readFileSync(join(out, "note.md"), "utf-8")).not.toMatch(/Slowest/);
    expect(readFileSync(join(out, "report.html"), "utf-8")).toContain("No root has per-resource timings. choudoufu sent no spans for the plan");
  });
});

describe("terragucci stage tf-apply names where each root's time went", () => {
  // The plan waited for a state lock another run held: choudoufu's one span
  // over every attempt, with the attempt count.
  const LOCKED: SpanSpec[] = [
    { id: "0000000000000021", name: "State lock wait", from: 0, to: 7000, attrs: { "opentofu.state.backend": "*remote.State", "opentofu.state.lock.operation": "OperationTypePlan", "opentofu.state.lock.attempts": 4 } },
    { id: "0000000000000022", name: "Plan resource instance changes", from: 7000, to: 7400, attrs: { "opentofu.resource_instance.address": "terraform_data.x", "opentofu.resource.type": "terraform_data", "opentofu.resource_instance.action": "create" } },
  ];
  const APPLIED: SpanSpec[] = [
    { id: "0000000000000031", name: "State lock wait", from: 0, to: 20, attrs: { "opentofu.state.backend": "*remote.State", "opentofu.state.lock.operation": "OperationTypeApply", "opentofu.state.lock.attempts": 1 } },
    { id: "0000000000000032", name: "Apply resource instance changes", from: 20, to: 2020, attrs: { "opentofu.resource_instance.address": "terraform_data.x", "opentofu.resource.type": "terraform_data", "opentofu.resource_instance.action": "create" } },
  ];

  it("writes the wave's report with each root's plan and apply times and the plan's lock wait", { timeout: 60_000 }, async () => {
    const one = JSON.stringify(planJson([rc("terraform_data.x", ["create"], null, { input: "1" })]));
    const repo = write(tmp(), {
      "a/main.tf": "", "a/plan.json": one, "a/spans.json": JSON.stringify(otlpJson(LOCKED)), "a/apply-spans.json": JSON.stringify(otlpJson(APPLIED)),
      "b/main.tf": "", "b/plan.json": one,
    });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    try {
      expect(await applyWave(repo, { wave: 1, layers: [["a", "b"]], binary: spanningBinary(tmp()), gate: "never", env: { PATH: process.env.PATH } })).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.filter((l) => l.startsWith("timings:") || l.includes("report was not"))).toEqual([]);
    const report = JSON.parse(readFileSync(join(repo, "terragucci-report", "report.json"), "utf-8"));
    expect(report.run).toMatchObject({ stage: "tf-apply", wave: 1 });
    expect(report.waves).toEqual([expect.objectContaining({ number: 1, roots: ["a", "b"] })]);

    const a = report.roots.find((r: { path: string }) => r.path === "a").timings;
    expect(a.plan_seconds).toBeGreaterThan(0);
    expect(a.apply_seconds).toBeGreaterThan(0);
    expect(a.seconds).toBeGreaterThanOrEqual(a.plan_seconds);
    expect(a.source).toBeUndefined();
    expect(a.spans).toBe(4);
    expect(a.lock_waits).toEqual([
      { backend: "*remote.State", operation: "OperationTypePlan", attempts: 4, ms: 7000 },
      { backend: "*remote.State", operation: "OperationTypeApply", attempts: 1, ms: 20 },
    ]);
    expect(a.resources.map((r: { action: string; ms: number }) => [r.action, r.ms])).toEqual([["create", 2000], ["create", 400]]);

    const b = report.roots.find((r: { path: string }) => r.path === "b").timings;
    expect(b).toMatchObject({ detail: "none", spans: 0, note: expect.stringMatching(/^choudoufu sent no spans for the plan and apply/) });
    expect(b.apply_seconds).toBeGreaterThan(0);

    expect(report.timings.roots.map((r: { root: string }) => r.root).sort()).toEqual(["a", "b"]);
    expect(report.timings.roots.every((r: { apply_seconds?: number }) => r.apply_seconds !== undefined)).toBe(true);
    expect(readFileSync(join(repo, "terragucci-report", "roots", "a", "plan.json"), "utf-8")).toContain("terraform_data.x");
  });
});
