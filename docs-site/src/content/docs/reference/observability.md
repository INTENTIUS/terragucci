---
title: Traces and metrics
description: Each stage run as one trace, and the pipeline's numbers as metrics, sent over OTLP to your collector.
---

Each stage run sends one trace and a set of metrics over OTLP to the collector you run. Tempo, Honeycomb, Datadog and any other backend with an OTLP endpoint work too. Nothing is sent unless an endpoint is set.

## Turning it on

terragucci reads the standard OpenTelemetry variables. Set the endpoint for every job in `terragucci.yml`:

```yaml
env:
  OTEL_EXPORTER_OTLP_ENDPOINT: https://otel-collector.example.com:4318
```

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | the collector's OTLP/HTTP base URL; traces go to `/v1/traces` and metrics to `/v1/metrics` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | one signal's full URL, used as given |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value` pairs sent with every request, such as an API key |
| `OTEL_TRACES_EXPORTER=none`, `OTEL_METRICS_EXPORTER=none` | turn one signal off |
| `OTEL_SDK_DISABLED=true` | turn both off |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | the service name (default `terragucci`) and extra resource attributes |
| `TRACEPARENT` | the stage's trace joins this one, when your CI starts a trace of its own |

terragucci sends OTLP/JSON over HTTP, so point it at the collector's HTTP port (4318), not gRPC. Keep header values that hold a key in a CI secret rather than in `env`. A collector that cannot be reached never fails a stage. The job log says what was sent and what was not.

## The trace

```
terragucci tf-plan          project, commit, binary, change set, totals
  wave 2                    set digest, approval
    root envs/prod/payments plan digest, changes by action, status
      tofu init
      tofu plan             the binary's own spans, under this one
      tofu show
```

Every run of the binary is a span, and the binary gets that span as `TRACEPARENT`. OpenTofu and choudoufu read it, so their own spans land inside the trace. Terraform ignores it and starts a trace of its own. Its spans carry the resource attributes `terragucci.trace_id`, `terragucci.span_id` and `terragucci.root`, so a query on them finds the span that ran it.

With an endpoint set, terragucci turns the binary's OTLP exporter on (`OTEL_TRACES_EXPORTER=otlp`). Set `OTEL_TRACES_EXPORTER` yourself to choose otherwise.

## The metrics

A stage pushes its metrics once, when it ends, so a short CI job needs no scrape. Point a Prometheus exporter or remote write on your collector at them. They are read from the run's report, so they match what reviewers saw. Every metric is a gauge with the labels `project` and `stage`, plus those below.

| Metric | Labels | Answers |
|---|---|---|
| `terragucci_stage_duration_seconds` | `result` | how long each stage takes, and whether it failed |
| `terragucci_roots_planned` | | how many roots a change touches |
| `terragucci_root_plan_seconds` | `root` | the slowest roots |
| `terragucci_plan_changes` | `action` | creates, updates, replaces and deletes, over time |
| `terragucci_plan_groups` | | how far a change folds |
| `terragucci_binary_version` | `binary`, `version` | the binary versions in use across repos |

The resource carries `terragucci.project`, `vcs.ref.head.revision` (the commit) and `cicd.pipeline.run.url.full` (the CI job). A collector set to copy resource attributes onto series can then find one run's numbers by its commit.
