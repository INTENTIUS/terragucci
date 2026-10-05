/**
 * The names the dashboards and alert rules read: the gauges a stage sends
 * (report/observe.ts, report/wave-telemetry.ts) and the span metrics a
 * collector's `spanmetrics` connector makes from the stage spans.
 *
 * Plain data with no imports, so the stack's collector declaration
 * (observability/collector.ts) uses the same connector settings the
 * dashboards are built from, and a rename moves both.
 */

/** The `spanmetrics` connector the Pipeline health, Runs and SLO dashboards read. */
export const SPANMETRICS = {
  namespace: "terragucci.spans",
  /** On the stage spans; a binary's spans and the root spans carry none of them. */
  dimensions: [{ name: "terragucci.stage" }, { name: "terragucci.project" }, { name: "terragucci.result" }],
  // Each run's resource attributes differ (the commit, the job URL); keyed by
  // these alone, a project's counters carry on from run to run.
  resource_metrics_key_attributes: ["service.name", "terragucci.project"],
  histogram: {
    unit: "s" as const,
    // 600 is the plan SLO's bound; the rest spread a stage's usual range.
    explicit: { buckets: ["5s", "15s", "30s", "60s", "120s", "300s", "600s", "1200s", "1800s", "3600s"] },
  },
};

/** The plan SLO's bound, in seconds: a plan finishes within ten minutes. */
export const PLAN_SLO_SECONDS = 600;

/** Gauge names as Prometheus shows them (the collector's prometheus exporter keeps a name that already ends in its unit). */
export const METRIC = {
  stageDuration: "terragucci_stage_duration_seconds",
  lastRun: "terragucci_last_run_seconds",
  rootsPlanned: "terragucci_roots_planned",
  rootsChanged: "terragucci_roots_changed",
  planGroups: "terragucci_plan_groups",
  planChanges: "terragucci_plan_changes",
  rootPlan: "terragucci_root_plan_seconds",
  rootApply: "terragucci_root_apply_seconds",
  binaryVersion: "terragucci_binary_version",
  tips: "terragucci_tips",
  modulePin: "terragucci_module_pin",
  providerInit: "terragucci_provider_init_seconds",
  lockWait: "terragucci_lock_wait_seconds",
  resource: "terragucci_resource_seconds",
  driftRoots: "terragucci_drift_roots",
  driftSince: "terragucci_drift_since_seconds",
  driftClear: "terragucci_drift_clear_seconds",
  waveWaitingSince: "terragucci_wave_waiting_since_seconds",
  waveSettled: "terragucci_wave_settled_seconds",
  waveRoots: "terragucci_wave_roots",
} as const;

/** The `terragucci.result` a stage span carries: how the stage or the wave ended. */
export const RESULTS = ["success", "failure", "applied", "nothing", "waiting", "refused", "failed"] as const;
export type StageResult = (typeof RESULTS)[number];
