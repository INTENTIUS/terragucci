/**
 * The OpenTelemetry collector the stack's observability profile runs
 * (stack/observability/collector.yaml), declared with chant's otel lexicon.
 * `just ci` renders it; `just ci-check` fails when the committed file differs.
 *
 * Stages send OTLP over HTTP to otel-collector:4318. Traces are written as
 * OTLP/JSON lines to /out/traces.jsonl, which the smoke claims read with
 * `docker cp`. Metrics are served to Prometheus on :8889, with resource
 * attributes (the commit among them) copied onto every series so a claim can
 * find its own run.
 */
import { defineComponent, HealthCheckExtension, OtlpReceiver, Pipeline, PrometheusExporter } from "@intentius/chant-lexicon-otel";

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

export const health = new HealthCheckExtension({ endpoint: "0.0.0.0:13133" });

export const traces = new Pipeline({ signal: "traces", receivers: [otlp], exporters: [traceFile] });
export const metrics = new Pipeline({ signal: "metrics", receivers: [otlp], exporters: [prometheus] });
