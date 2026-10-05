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
| `terragucci_last_run_seconds` | | when each stage last ran, in Unix seconds |
| `terragucci_roots_changed` | `pull_request` on a plan | how many roots a pull request changes |
| `terragucci_tips` | `rule` | tips by rule |
| `terragucci_module_pin` | `root`, `module`, `version` | which version of each module each root pins |
| `terragucci_provider_init_seconds` | `root`, `provider` | provider start-up |
| `terragucci_lock_wait_seconds` | `root` | time spent waiting for a state lock |
| `terragucci_resource_seconds` | `root`, `address` | the run's slowest resources |
| `terragucci_drift_roots` | | roots a drift run found drifted |
| `terragucci_drift_since_seconds`, `terragucci_drift_clear_seconds` | | when the open drift was first found (its drift issue opened), and when a drift run last found none |
| `terragucci_wave_roots` | `wave` | roots in a `tf-apply` wave |
| `terragucci_wave_waiting_since_seconds`, `terragucci_wave_settled_seconds` | `wave` | when a wave started waiting for its approval, and when it last stopped waiting |

A plan run for a pull request labels its metrics with `pull_request`. The stage span's `terragucci.result` attribute says how the run ended. A plan or drift run ends in `success` or `failure`, and a wave in one of `applied`, `nothing`, `waiting`, `refused` and `failed`.

The resource carries `terragucci.project`, `vcs.ref.head.revision` (the commit) and `cicd.pipeline.run.url.full` (the CI job). A collector set to copy resource attributes onto series can then find one run's numbers by its commit.

## Dashboards and alerts

Set `dashboards: true` in `terragucci.yml` and `init` writes Grafana dashboards and alert rules into the repo, next to the pipeline. `reconcile` writes them into each project the same way. They change only when the config does, and `init` leaves a file there that it did not write alone.

```
observability/terragucci/
  grafana/dashboards/<uid>.json                    one per dashboard
  grafana/provisioning/dashboards/terragucci.yaml  the provider that loads them
  grafana/provisioning/alerting/terragucci.yaml    the SLO burn-rate alerts, as Grafana-managed rules
  prometheus/terragucci.rules.yml                  the SLO recording rules and alerts, and the pipeline alerts
```

| Dashboard | Shows |
|---|---|
| Pipeline health | runs per hour, errors and duration for each stage and project, and runs by result |
| Change review | roots changed and groups for each pull request, and creates, updates, replaces and destroys over time |
| Rollouts and waves | waves waiting for an approval and for how long, wave runs by result, and how many roots pin each module version |
| Drift | drifted roots by project, how old the open drift is, and roots corrected |
| Estate | roots per project, the binary and terragucci versions each runs, module pins and tips by rule |
| Runs | the slowest roots and resources, provider start-up, lock waits, stage durations, and the trace of each run from Tempo |
| One per SLO | the SLI against its objective, the error budget left and the burn rates |

There are three SLOs, each over 28 days. Plans finish within ten minutes 95% of the time. Wave applies succeed 99% of the time. Drift is corrected within a day 90% of the time.

| Alert | Fires when |
|---|---|
| `TerragucciDriftOld` | a project's open drift is older than `drift_age` |
| `TerragucciWaveWaiting` | a wave has waited for its approval longer than `wave_wait` |
| `TerragucciApplyFailed` | an apply failed in the last hour |
| `TerragucciWaveRefused` | a wave was refused in the last hour because its plans moved |
| `TerragucciDriftStopped` | a project's drift run has not run for `schedule` |

| Key under `dashboards` | Default | Meaning |
|---|---|---|
| `dir` | `observability/terragucci` | where the files go |
| `prometheus` | `prometheus` | the uid of the Grafana datasource reading the Prometheus that holds the metrics |
| `tempo` | `tempo` | the uid of the Grafana datasource reading Tempo |
| `folder` | `terragucci` | the Grafana folder for the dashboards and the Grafana-managed rules |
| `path` | `/var/lib/grafana/dashboards/terragucci` | where Grafana finds the dashboard files |
| `drift_age`, `wave_wait`, `schedule` | `1d`, `4h`, `2d` | the alert thresholds |

Mount `grafana/provisioning/` under Grafana's `/etc/grafana/provisioning/` and `grafana/dashboards/` at `path`, and add `prometheus/terragucci.rules.yml` to Prometheus's `rule_files`. Load the alerting file or the Prometheus file's `ErrorBudgetBurn` alerts, whichever you page from; both alert on the same burn rates.

Pipeline health, the SLOs and the wave results read span metrics, which your collector makes from the stage spans with a `spanmetrics` connector. Turn the stage spans into the metrics the dashboards read with these settings, and send its output to the metrics pipeline your Prometheus reads:

```yaml
connectors:
  spanmetrics:
    namespace: terragucci.spans
    dimensions:
      - name: terragucci.stage
      - name: terragucci.project
      - name: terragucci.result
    resource_metrics_key_attributes: [service.name, terragucci.project]
    histogram:
      unit: s
      explicit:
        buckets: [5s, 15s, 30s, 60s, 120s, 300s, 600s, 1200s, 1800s, 3600s]
```

The Runs dashboard lists traces from Tempo. A collector that exports traces elsewhere still fills every other panel.
