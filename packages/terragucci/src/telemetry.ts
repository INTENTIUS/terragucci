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
 *   TERRAGUCCI_METRICS_PER_RUN=true        each gauge also carries the run's commit and run id (report/observe.ts)
 *
 * The binary's own spans join the stage's trace through `TRACEPARENT` in its
 * environment (OpenTofu and choudoufu read it). A binary that ignores it,
 * such as Terraform, still carries `terragucci.trace_id` and
 * `terragucci.span_id` as resource attributes, so its trace names the span
 * that ran it.
 */
import { OtlpTrace, otlpFromEnv, otlpTracesBody, type OtlpAttrs, type OtlpAttrValue, type OtlpSpan, type OtlpSpanEvent, type OtlpTarget } from "@intentius/chant/otlp";
import { otlpMetricsBody, otlpMetricsFromEnv } from "@intentius/chant/otlp-metrics";

export { sendOtlp as send, type OtlpFetch } from "@intentius/chant/otlp";

export type AttrValue = OtlpAttrValue;
export type Attrs = OtlpAttrs;
export type Target = OtlpTarget;
export type Span = OtlpSpan;
export type SpanEvent = OtlpSpanEvent;
/** One stage run's trace: chant's (`@intentius/chant/otlp`, chant#4555). */
export const Trace = OtlpTrace;
export type Trace = OtlpTrace;

export interface Telemetry {
  traces?: Target;
  metrics?: Target;
  /** Resource attributes from the environment: service name and OTEL_RESOURCE_ATTRIBUTES. */
  resource: Attrs;
  /** Why a signal is off although an endpoint is set. */
  skipped: string[];
}

/** The product the exporter's attributes and default service name are under. */
const PRODUCT = "terragucci";

/** The stage's telemetry from the environment, through chant's readers (chant#4555), or undefined when no endpoint is set. */
export function telemetryFromEnv(env: NodeJS.ProcessEnv): Telemetry | undefined {
  const t = otlpFromEnv(env, { prefix: PRODUCT });
  const m = otlpMetricsFromEnv(env, { product: PRODUCT });
  if (!t && !m) return undefined;
  return {
    ...(t?.traces ? { traces: t.traces } : {}),
    ...(m?.metrics ? { metrics: m.metrics } : {}),
    resource: t?.resource ?? m!.resource,
    skipped: [...(t?.skipped ?? []), ...(m?.skipped ?? [])],
  };
}

/** Now, in Unix nanoseconds. */
export const nowNanos = (): bigint => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;

/** The OTLP/JSON body for a trace's spans: chant's. */
export function tracesBody(spans: readonly Span[], resource: Attrs): unknown {
  return otlpTracesBody(spans, resource);
}

export interface Gauge {
  name: string;
  unit: string;
  description: string;
  value: number;
  attributes: Attrs;
}

/** The OTLP/JSON body for gauges, one data point each, grouped by name: chant's. */
export function metricsBody(gauges: readonly Gauge[], resource: Attrs, at: bigint = nowNanos()): unknown {
  // chant's attribute writer takes numbers and booleans as they are.
  return otlpMetricsBody(gauges as never, resource, at);
}
