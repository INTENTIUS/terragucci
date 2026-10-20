/**
 * The OpenTelemetry collector the stack's observability profile runs
 * (stack/observability/collector.yaml), declared with chant's otel lexicon.
 * `just ci` renders it; `just ci-check` fails when the committed file differs.
 *
 * Stages send OTLP over HTTP to otel-collector:4318. Traces are written as
 * OTLP/JSON lines to /out/traces.jsonl, which the smoke claims read with
 * `docker cp`, and sent on to Tempo, which Grafana's Runs dashboard reads.
 * Metrics are served to Prometheus on :8889, with resource attributes (the
 * commit among them) copied onto every series so a claim can find its own
 * run. A `spanmetrics` connector turns the stage spans into the run counts and
 * durations the dashboards read, with the settings the dashboards are built
 * from (packages/terragucci/src/dashboards/names.ts).
 */
import {
  defineComponent,
  HealthCheckExtension,
  OtlpExporter,
  OtlpReceiver,
  Pipeline,
  PrometheusExporter,
  SpanMetricsConnector,
} from "@intentius/chant-lexicon-otel";
import { SPANMETRICS } from "../packages/terragucci/src/dashboards/names";

interface FileExporterConfig {
  path: string;
}

/** The contrib `file` exporter, which the lexicon does not ship. */
const FileExporter = defineComponent<FileExporterConfig>()({
  kind: "exporter",
  type: "file",
  pin: {
    source: "github.com/open-telemetry/opentelemetry-collector-contrib/exporter/fileexporter",
    version: "v0.130.0",
  },
  validate: (c) => (c.path ? [] : ["path is empty, so the traces have nowhere to go"]),
});

export const otlp = new OtlpReceiver({
  protocols: {
    http: { endpoint: "0.0.0.0:4318" },
    grpc: { endpoint: "0.0.0.0:4317" },
  },
});

export const traceFile = new FileExporter({ name: "traces", path: "/out/traces.jsonl" });

export const prometheus = new PrometheusExporter({
  endpoint: "0.0.0.0:8889",
  resource_to_telemetry_conversion: { enabled: true },
});

// Batching on the exporter's queue stands in for a batch processor (OTEL125).
export const tempo = new OtlpExporter({
  name: "tempo",
  endpoint: "tempo:4317",
  tls: { insecure: true },
  sending_queue: { batch: { flush_timeout: "1s", min_size: 512, max_size: 2048 } },
});

// Flushed every 5s so a smoke claim sees a run's counts soon after it ends.
export const stageSpans = new SpanMetricsConnector({
  namespace: SPANMETRICS.namespace,
  dimensions: SPANMETRICS.dimensions,
  resource_metrics_key_attributes: SPANMETRICS.resource_metrics_key_attributes,
  histogram: SPANMETRICS.histogram,
  metrics_flush_interval: "5s",
});

export const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

export const traces = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [traceFile, tempo, stageSpans] });
export const metrics = new Pipeline({ signal: "metrics", receivers: [otlp, stageSpans], exporters: [prometheus] });
