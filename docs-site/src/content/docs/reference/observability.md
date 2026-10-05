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

terragucci sends OTLP/JSON over HTTP, so point it at the collector's HTTP port (4318), not gRPC. Keep header values that hold a key in a CI secret rather than in `env`. Name the secret in `terragucci.yml` with `telemetry: { headers_secret: OTLP_HEADERS }` and the generated GitHub and Forgejo workflows set `OTEL_EXPORTER_OTLP_HEADERS` from `${{ secrets.OTLP_HEADERS }}` on the plan, apply and drift jobs, the ones that run a stage and send telemetry. The check and publish jobs do not get it. The plan job reads it too, so it runs only for pull requests from the same repo; a fork's pull request gets no secrets. On GitLab the generated plan, apply and drift jobs set it from the CI/CD variable of that name, and GitLab itself hands project variables to every job, so mark the variable masked. A collector that cannot be reached never fails a stage. The job log says what was sent and what was not.

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

terragucci also turns the binary's OTLP trace exporter on and points it at a receiver of its own, on a loopback port, for as long as the run lasts. With an endpoint set, each batch the binary sends is passed on to your collector unchanged. The receiver takes OTLP over HTTP only. A collector reached only over gRPC gets nothing from terragucci or the binary.

## Where the time went

Every `tf-plan` and `tf-drift` report names where the run spent its time, endpoint or not, and so does each `tf-apply` wave's. It reads what each root's plan (and a wave's apply) sent to the receiver:

- the slowest roots, with each root's wall time, its plan's and, in a wave, its apply's;
- in each root, the slowest resource instances and their refresh time;
- the slowest provider calls, and the resource each was for;
- provider start-up and state lock waits.

choudoufu times each resource instance and each provider call. On a large estate it sums them by resource type or provider method instead, once a graph walk passes its budget (`CHOUDOUFU_TRACE_DETAIL` and `CHOUDOUFU_TRACE_SPAN_BUDGET`). The report then lists those sums with a count and the slowest member per type. It also says how many instances it summed.

A root whose binary reports nothing per resource says so where the lists would be. Terraform exports no traces, and OpenTofu's stop above the resource. In a Terragrunt run, Terragrunt runs the binary, so each unit's time comes from Terragrunt's run report (when the unit started and ended) and the report lists the units slowest first, with no per-resource timings.

A `tf-plan` never takes the state lock, so it never waits for one. A `tf-apply` wave's plan and apply do. With choudoufu, a wait shows as a `State lock wait` span, with the number of attempts it took, and the wave's report lists it under the root's lock waits. A wave writes its report to `terragucci-report/`, and copies it to the `reports` bucket when one is set.

The HTML report shows the run's timings under "Where the time went", and folds each root's own under its changes. When a binary did time its resources, the plan note gets one line naming the three slowest. `report.json` carries them as `timings` and `roots[].timings`; see [Report JSON schema](/terragucci/reference/report-schema/).

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
