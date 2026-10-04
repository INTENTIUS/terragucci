/**
 * A stage's traces and metrics, sent as OTLP/JSON over HTTP with Node's
 * `fetch`. No OpenTelemetry SDK: the bundle has no dependencies, and a stage
 * only ever sends one batch of each, at its end.
 *
 * Off unless an endpoint is set. It reads the standard variables:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT            base URL; /v1/traces and /v1/metrics are added
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT     the traces URL, used as given
 *   OTEL_EXPORTER_OTLP_METRICS_ENDPOINT    the metrics URL, used as given
 *   OTEL_EXPORTER_OTLP_HEADERS             k=v,k2=v2 on every request (and the per-signal ones)
 *   OTEL_TRACES_EXPORTER, OTEL_METRICS_EXPORTER   `none` turns one signal off
 *   OTEL_SDK_DISABLED=true                 turns both off
 *   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
 *   TRACEPARENT                            the stage's trace joins it
 *
 * The binary's own spans join the stage's trace through `TRACEPARENT` in its
 * environment (OpenTofu and choudoufu read it). A binary that ignores it,
 * such as Terraform, still carries `terragucci.trace_id` and
 * `terragucci.span_id` as resource attributes, so its trace names the span
 * that ran it.
 */
import { randomBytes } from "node:crypto";

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue | undefined>;

export interface Target {
  url: string;
  headers: Record<string, string>;
}

export interface Telemetry {
  traces?: Target;
  metrics?: Target;
  /** Resource attributes from the environment: service name and OTEL_RESOURCE_ATTRIBUTES. */
  resource: Attrs;
  /** Why a signal is off although an endpoint is set. */
  skipped: string[];
}

export type OtlpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** `k=v,k2=v2`, values percent-decoded, as OTEL_*_HEADERS and OTEL_RESOURCE_ATTRIBUTES write them. */
export function parsePairs(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep it as written
    }
    if (k) out[k] = v;
  }
  return out;
}

const formatPairs = (pairs: Record<string, string>): string =>
  Object.entries(pairs).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(",");

function target(env: NodeJS.ProcessEnv, signal: "traces" | "metrics", skipped: string[]): Target | undefined {
  const S = signal.toUpperCase();
  const exporter = env[`OTEL_${S}_EXPORTER`];
  if (exporter !== undefined && exporter.trim() !== "" && !exporter.split(",").map((s) => s.trim()).includes("otlp")) return undefined;
  const own = env[`OTEL_EXPORTER_OTLP_${S}_ENDPOINT`]?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = own || (base ? `${base.replace(/\/+$/, "")}/v1/${signal}` : undefined);
  if (!url) return undefined;
  const protocol = env[`OTEL_EXPORTER_OTLP_${S}_PROTOCOL`] ?? env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === "grpc") {
    skipped.push(`${signal}: terragucci sends OTLP over HTTP and the protocol is grpc; point it at the collector's HTTP port`);
    return undefined;
  }
  if (!/^https?:\/\//.test(url)) {
    skipped.push(`${signal}: ${url} is not an http or https URL`);
    return undefined;
  }
  return { url, headers: { ...parsePairs(env.OTEL_EXPORTER_OTLP_HEADERS), ...parsePairs(env[`OTEL_EXPORTER_OTLP_${S}_HEADERS`]) } };
}

/** The stage's telemetry from the environment, or undefined when no endpoint is set. */
export function telemetryFromEnv(env: NodeJS.ProcessEnv): Telemetry | undefined {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return undefined;
  const skipped: string[] = [];
  const traces = target(env, "traces", skipped);
  const metrics = target(env, "metrics", skipped);
  if (!traces && !metrics && skipped.length === 0) return undefined;
  const resource: Attrs = { ...parsePairs(env.OTEL_RESOURCE_ATTRIBUTES) };
  resource["service.name"] = env.OTEL_SERVICE_NAME?.trim() || resource["service.name"] || "terragucci";
  return { ...(traces ? { traces } : {}), ...(metrics ? { metrics } : {}), resource, skipped };
}

// ── traces ───────────────────────────────────────────────────────────────────

/** Now, in Unix nanoseconds. */
export const nowNanos = (): bigint => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 1 internal, 3 client (a process terragucci ran). */
  kind: 1 | 3;
  start: bigint;
  end?: bigint;
  attributes: Attrs;
  error?: string;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** `00-<trace>-<span>-<flags>`, or undefined when it is not one. */
export function parseTraceparent(text: string | undefined): { traceId: string; spanId: string } | undefined {
  const m = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec((text ?? "").trim().toLowerCase());
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return undefined;
  return { traceId: m[1], spanId: m[2] };
}

/** One stage run's trace. Spans are kept in memory and sent once. */
export class Trace {
  readonly traceId: string;
  readonly parent?: string;
  readonly spans: Span[] = [];

  constructor(traceparent?: string) {
    const p = parseTraceparent(traceparent);
    this.traceId = p?.traceId ?? hex(16);
    this.parent = p?.spanId;
  }

  start(name: string, parent?: Span, attributes: Attrs = {}, kind: 1 | 3 = 1): Span {
    const span: Span = { traceId: this.traceId, spanId: hex(8), name, kind, start: nowNanos(), attributes: { ...attributes } };
    const parentId = parent?.spanId ?? this.parent;
    if (parentId) span.parentSpanId = parentId;
    this.spans.push(span);
    return span;
  }

  end(span: Span, attributes: Attrs = {}, error?: string): void {
    span.end = nowNanos();
    Object.assign(span.attributes, attributes);
    if (error) span.error = error;
  }

  /** The W3C header that makes `span` the parent of what a process sends. */
  traceparent(span: Span): string {
    return `00-${this.traceId}-${span.spanId}-01`;
  }
}

function attrList(attrs: Attrs): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(attrs)
    .filter((e): e is [string, AttrValue] => e[1] !== undefined)
    .map(([key, v]) => ({
      key,
      value: typeof v === "boolean" ? { boolValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v },
    }));
}

const SCOPE = (version: string) => ({ name: "terragucci", version });

/** The OTLP/JSON body for a trace's spans. */
export function tracesBody(spans: Span[], resource: Attrs, version: string): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: attrList(resource) },
      scopeSpans: [{
        scope: SCOPE(version),
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: s.kind,
          startTimeUnixNano: String(s.start),
          endTimeUnixNano: String(s.end ?? s.start),
          attributes: attrList(s.attributes),
          status: s.error ? { code: 2, message: s.error } : { code: 1 },
        })),
      }],
    }],
  };
}

// ── metrics ──────────────────────────────────────────────────────────────────

export interface Gauge {
  name: string;
  unit: string;
  description: string;
  value: number;
  attributes: Attrs;
}

/** The OTLP/JSON body for gauges, one data point each, grouped by name. */
export function metricsBody(gauges: Gauge[], resource: Attrs, version: string, at: bigint = nowNanos()): unknown {
  const byName = new Map<string, Gauge[]>();
  for (const g of gauges) byName.set(g.name, [...(byName.get(g.name) ?? []), g]);
  return {
    resourceMetrics: [{
      resource: { attributes: attrList(resource) },
      scopeMetrics: [{
        scope: SCOPE(version),
        metrics: [...byName.values()].map((gs) => ({
          name: gs[0].name,
          unit: gs[0].unit,
          description: gs[0].description,
          gauge: { dataPoints: gs.map((g) => ({ attributes: attrList(g.attributes), timeUnixNano: String(at), asDouble: g.value })) },
        })),
      }],
    }],
  };
}

// ── sending ──────────────────────────────────────────────────────────────────

/** POST one OTLP/JSON body. Returns the problem, or undefined when it was taken. Never throws. */
export async function send(t: Target, body: unknown, fetchFn: OtlpFetch = fetch as unknown as OtlpFetch): Promise<string | undefined> {
  try {
    const res = await fetchFn(t.url, {
      method: "POST",
      headers: { ...t.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `${t.url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (e) {
    return `${t.url}: ${(e as Error).message}`;
  }
}

/**
 * The environment a binary runs with inside `span`: its spans join the trace
 * where it reads TRACEPARENT, and name the span as resource attributes where
 * it does not. Its OTLP exporter is turned on unless the environment chose
 * one already (`none` keeps it off).
 */
export function binaryEnv(env: NodeJS.ProcessEnv, trace: Trace, span: Span, root: string): NodeJS.ProcessEnv {
  const resource = { ...parsePairs(env.OTEL_RESOURCE_ATTRIBUTES), "terragucci.trace_id": trace.traceId, "terragucci.span_id": span.spanId, "terragucci.root": root };
  return {
    ...env,
    TRACEPARENT: trace.traceparent(span),
    OTEL_TRACES_EXPORTER: env.OTEL_TRACES_EXPORTER || "otlp",
    OTEL_RESOURCE_ATTRIBUTES: formatPairs(resource),
  };
}
