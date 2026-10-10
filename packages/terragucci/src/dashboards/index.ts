/**
 * The dashboards and alert rules `init` and `reconcile` write into a repo
 * when terragucci.yml turns `dashboards:` on, next to the pipeline.
 *
 * Declared here with chant's grafana and prometheus lexicons, through each
 * lexicon's entities and build functions, never its entry point. They are
 * rendered when the bundle is built, not when init runs: `just ci` renders
 * them into rendered.json with a placeholder for each terragucci.yml value
 * (template.ts), and init fills it (files.ts), so the bundle carries the
 * files and not the lexicons, js-yaml or the PromQL parser (terragucci#163).
 * Nothing the bundle reaches imports this file; `just bundle-check` fails if
 * something does, and `just ci-check` fails when rendered.json is stale.
 *
 * Seven dashboards (Pipeline health, Change review, Rollouts and waves,
 * Drift, Estate, Runs, and one per SLO), the Prometheus rules (the SLOs'
 * recording rules and burn-rate alerts, and the pipeline alerts), and the
 * SLOs' burn-rate alerts again as Grafana-managed rules, for a team that
 * pages from Grafana rather than Alertmanager. The dashboards read the
 * metrics a stage sends (names.ts) and the span metrics a collector's
 * `spanmetrics` connector makes from the stage spans, and the Runs
 * dashboard lists the runs' traces from Tempo. When terragucci.yml says
 * where the reports bucket is served (`reports.url`), the Runs dashboard's
 * trace rows link each run's report, and the Estate dashboard links the
 * report index.
 */
import type { Declarable } from "@intentius/chant/declarable";
import { spanMetricsNames } from "@intentius/chant-lexicon-otel/metric-names";
import { Dashboard, DashboardProvider, type DashboardEntity } from "@intentius/chant-lexicon-grafana/dashboard";
import { Row, StatPanel, TablePanel, TimeSeriesPanel, type DashboardItem } from "@intentius/chant-lexicon-grafana/panels";
import { PromQuery, TempoQuery } from "@intentius/chant-lexicon-grafana/query";
import { QueryVariable } from "@intentius/chant-lexicon-grafana/variables";
import { buildGrafana } from "@intentius/chant-lexicon-grafana/build";
import { selector, type Matcher } from "@intentius/chant-lexicon-grafana/composites/shared";
import { SloDashboard } from "@intentius/chant-lexicon-grafana/composites/slo-dashboard";
import { SloAlertRules } from "@intentius/chant-lexicon-grafana/composites/slo-alert-rules";
import { Slo, sloMetrics, type SloInstance } from "@intentius/chant-lexicon-prometheus/composites/slo";
import { RuleGroup, type RuleGroupEntity } from "@intentius/chant-lexicon-prometheus/rules";
import { buildRuleFile, emitYaml } from "@intentius/chant-lexicon-prometheus/build";
import { durationMs } from "@intentius/chant-lexicon-prometheus/duration";
import type { DashboardSettings } from "../config";
import { METRIC, PLAN_SLO_SECONDS, SPANMETRICS } from "./names";
import { DASHBOARD_TAG, DASHBOARD_UIDS, SLO_NAMES, YAML_MARKER, type DashboardLinks, type RenderedFile } from "./settings";

export * from "./settings";

const seconds = (d: string): number => Math.round((durationMs(d) ?? 0) / 1000);

const spans = spanMetricsNames(SPANMETRICS);
const CALLS = spans.calls.prometheus;
const DURATION_BUCKETS = `${spans.duration!.prometheus}_bucket`;
const STATUS = spans.labels.statusCode!;
const STAGE_L = "terragucci_stage";
const PROJECT_L = "terragucci_project";
const RESULT_L = "terragucci_result";

/**
 * How many events a span-metrics counter counted over `window`, summed by
 * `by`. A project's counter can start at its first run, so that run is the
 * series' first sample, which `rate()` and `increase()` never count: a
 * series the window does not see at its start is counted from zero. A
 * counter that went down (the collector restarted) counts none. Unlike a
 * rate over `$__rate_interval`, a run stays counted for the whole window, so
 * a graph of a week, whose points are a quarter of an hour apart, still
 * shows a run made between two of them.
 */
const countedOver = (sel: string, window: string, by: string[]): string =>
  `sum by (${by.join(", ")}) (clamp_min(${sel} - ${sel} offset ${window}, 0) or (${sel} unless ${sel} offset ${window}))`;

/** The window the Pipeline health graphs and the apply alerts count runs over. */
const RUN_WINDOW = "1h";

const prom = (uid: string) => ({ type: "prometheus" as const, uid });
const tempo = (uid: string) => ({ type: "tempo" as const, uid });

/** `max by (labels) (last_over_time(metric{matchers}[range]))`: each group's latest value over the range. */
const latest = (metric: string, matchers: Matcher[], by: string[], range = "$__range"): string =>
  `max by (${by.join(", ")}) (last_over_time(${selector(metric, matchers)}[${range}]))`;

/**
 * A run's gauge at each point of a graph: the largest value sent since the
 * point before. A stage sends its gauges once, and the collector drops a
 * gauge five minutes after it last changed, so a graph of a week, whose
 * points are a quarter of an hour apart, would mostly fall between them.
 */
const perPoint = (sel: string): string => `max_over_time(${sel}[$__interval])`;

/**
 * Things still open: what has a `since` time later than its last `settled`
 * time, or no settled time at all, per group. The value is the since time.
 */
const stillOpen = (since: string, settled: string, by: string[]): string =>
  `(\n(${since}) unless on (${by.join(", ")}) (${settled})\n)\nor\n(\n(${since}) > on (${by.join(", ")}) (${settled})\n)`;

const projectVar = (ds: ReturnType<typeof prom>, metric: string, label: string) =>
  new QueryVariable({
    name: "project",
    label: "Project",
    datasource: ds,
    query: `label_values(${metric}, ${label})`,
    multi: true,
    includeAll: true,
    allValue: ".+",
    refresh: "onTimeRangeChange",
    sort: 1,
  });

const P: Matcher = ["project", "=~", "$project"];
const SP: Matcher = [PROJECT_L, "=~", "$project"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const table = (title: string, description: string, ds: ReturnType<typeof prom>, expr: string, w = 12, h = 8, overrides: any[] = []) =>
  new TablePanel({
    title,
    description,
    datasource: ds,
    gridPos: { w, h },
    targets: [new PromQuery({ expr, instant: true, range: false, format: "table" })],
    ...(overrides.length ? { fieldConfig: { overrides } } : {}),
  });

const series = (title: string, description: string, ds: ReturnType<typeof prom>, expr: string, legend: string, unit = "short", w = 12) =>
  new TimeSeriesPanel({
    title,
    description,
    datasource: ds,
    gridPos: { w, h: 8 },
    targets: [new PromQuery({ expr, legendFormat: legend })],
    fieldConfig: { defaults: { unit } },
  });

const stat = (title: string, description: string, ds: ReturnType<typeof prom>, expr: string, unit = "short", w = 6) =>
  new StatPanel({
    title,
    description,
    datasource: ds,
    gridPos: { w, h: 5 },
    targets: [new PromQuery({ expr, instant: true, range: false })],
    options: { colorMode: "none", graphMode: "none", reduceOptions: { calcs: ["lastNotNull"] } },
    fieldConfig: { defaults: { unit } },
  });

function dashboard(s: Required<DashboardSettings>, uid: string, title: string, description: string, panels: DashboardItem[], variables: unknown[], time = "now-7d", links: { title: string; url: string }[] = []): DashboardEntity {
  return new Dashboard({
    title,
    uid,
    description,
    tags: [DASHBOARD_TAG],
    ...(links.length ? { links: links.map((l) => ({ ...l, type: "link" as const, targetBlank: true, icon: "doc" as const })) } : {}),
    time: { from: time, to: "now" },
    refresh: "1m",
    graphTooltip: "sharedCrosshair",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    variables: variables as any,
    panels,
  });
}

/** Rate, errors and duration of the stages, from the span metrics of the stage spans (the RED queries of grafana's RedDashboard, by stage and project). */
function pipelineHealth(s: Required<DashboardSettings>): DashboardEntity {
  const ds = prom(s.prometheus);
  const stage = new QueryVariable({
    name: "stage",
    label: "Stage",
    datasource: ds,
    query: `label_values(${CALLS}, ${STAGE_L})`,
    multi: true,
    includeAll: true,
    allValue: ".+",
    refresh: "onTimeRangeChange",
    sort: 1,
  });
  // A stage span carries the stage and the project; root and binary spans carry neither, so `.+` leaves them out.
  const scope: Matcher[] = [[STAGE_L, "=~", "$stage"], SP];
  const by = [STAGE_L, PROJECT_L];
  const calls = selector(CALLS, scope);
  const errors = selector(CALLS, [...scope, [STATUS, "=", spans.errorStatus]]);
  const buckets = selector(DURATION_BUCKETS, scope);
  const legend = `{{${STAGE_L}}} {{${PROJECT_L}}}`;
  const runs = countedOver(calls, RUN_WINDOW, by);
  // A group with runs but no failed series fails 0%, not "No data"; an hour without runs has no ratio.
  const errorShare = `(\n${countedOver(errors, RUN_WINDOW, by)}\nor\n0 * ${runs}\n)\n/\n(${runs} > 0)`;
  return dashboard(s, DASHBOARD_UIDS.pipeline, "terragucci: Pipeline health", "Runs, errors and duration per stage and project, from the stage spans.", [
    new Row({
      title: "Rate and errors",
      panels: [
        series("Runs per hour", "Stage runs in the hour before each point, by stage and project.", ds, runs, legend),
        new TimeSeriesPanel({
          title: "Errors",
          description: "Share of the stage runs in the hour before each point that failed, by stage and project.",
          datasource: ds,
          gridPos: { w: 12, h: 8 },
          targets: [new PromQuery({ expr: errorShare, legendFormat: legend })],
          fieldConfig: { defaults: { unit: "percentunit", min: 0, max: 1 } },
        }),
      ],
    }),
    new Row({
      title: "Duration",
      panels: [0.5, 0.95].map((q) =>
        series(`Duration p${q * 100}`, `p${q * 100} duration of the stage runs in the hour before each point, by stage and project.`, ds, `histogram_quantile(${q}, ${countedOver(buckets, RUN_WINDOW, ["le", ...by])})`, legend, "s"),
      ),
    }),
    new Row({
      title: "Results",
      panels: [table("Runs by result", "Stage runs over the dashboard's range, by stage and how they ended.", ds, countedOver(calls, "$__range", [STAGE_L, RESULT_L]), 24)],
    }),
  ], [projectVar(ds, CALLS, PROJECT_L), stage], "now-24h");
}

/** Roots and groups per pull request, and what the plans propose over time. */
function changeReview(s: Required<DashboardSettings>): DashboardEntity {
  const ds = prom(s.prometheus);
  const plan: Matcher[] = [["stage", "=", "tf-plan"], P];
  return dashboard(s, DASHBOARD_UIDS.changes, "terragucci: Change review", "What each pull request's plan reaches, and the creates, replaces and destroys proposed over time.", [
    new Row({
      title: "Pull requests",
      panels: [
        table("Roots changed per pull request", "Roots whose plan changes something, by project and pull request, from the latest plan of each.", ds, latest(METRIC.rootsChanged, plan, ["project", "pull_request"])),
        table("Groups per pull request", "Groups the plans fold into, by project and pull request.", ds, latest(METRIC.planGroups, plan, ["project", "pull_request"])),
      ],
    }),
    new Row({
      title: "Changes",
      panels: [
        series("Changes by action", "Proposed changes in each plan run, by action.", ds, `sum by (action) (${perPoint(selector(METRIC.planChanges, plan))})`, "{{action}}", "short", 24),
        stat("Creates", "Creates proposed over the range, the largest plan of each project and pull request.", ds, `sum(max by (project, pull_request) (max_over_time(${selector(METRIC.planChanges, [...plan, ["action", "=", "create"]])}[$__range])))`),
        stat("Updates", "Updates proposed over the range.", ds, `sum(max by (project, pull_request) (max_over_time(${selector(METRIC.planChanges, [...plan, ["action", "=", "update"]])}[$__range])))`),
        stat("Replaces", "Replacements proposed over the range.", ds, `sum(max by (project, pull_request) (max_over_time(${selector(METRIC.planChanges, [...plan, ["action", "=", "replace"]])}[$__range])))`),
        stat("Destroys", "Destroys proposed over the range.", ds, `sum(max by (project, pull_request) (max_over_time(${selector(METRIC.planChanges, [...plan, ["action", "=", "delete"]])}[$__range])))`),
      ],
    }),
  ], [projectVar(ds, METRIC.lastRun, "project")]);
}

/** The waves still waiting for an approval, per project and wave: the time each started waiting. */
export function wavesWaiting(matchers: Matcher[] = [P], range = "7d"): string {
  return stillOpen(latest(METRIC.waveWaitingSince, matchers, ["project", "wave"], range), latest(METRIC.waveSettled, matchers, ["project", "wave"], range), ["project", "wave"]);
}

/** The projects whose drift is still open: the time it was first seen. */
export function driftOpen(matchers: Matcher[] = [P], range = "7d"): string {
  return stillOpen(latest(METRIC.driftSince, matchers, ["project"], range), latest(METRIC.driftClear, matchers, ["project"], range), ["project"]);
}

function rolloutsAndWaves(s: Required<DashboardSettings>): DashboardEntity {
  const ds = prom(s.prometheus);
  const apply = selector(CALLS, [[STAGE_L, "=", "tf-apply"], SP]);
  // Refused and failed waves are rare, so each result has a line at 0 wherever the projects have wave runs at all.
  const zero = (result: string) => `label_replace(0 * sum(${apply}), "${RESULT_L}", "${result}", "", "")`;
  const refusedOrFailed = `${countedOver(selector(CALLS, [[STAGE_L, "=", "tf-apply"], [RESULT_L, "=~", "refused|failed"], SP]), RUN_WINDOW, [RESULT_L])}\nor\n${zero("refused")}\nor\n${zero("failed")}`;
  return dashboard(s, DASHBOARD_UIDS.waves, "terragucci: Rollouts and waves", "Waves waiting for an approval and for how long, how wave runs ended, and how far each module version has rolled out.", [
    new Row({
      title: "Waiting",
      panels: [
        stat("Waves waiting", "Waves whose latest run waits for an approval of its digest.", ds, `count(${wavesWaiting()})`),
        table("Waiting for", "Each waiting wave, and how long since it first asked for an approval.", ds, `time() - (${wavesWaiting()})`, 18),
      ],
    }),
    new Row({
      title: "Wave runs",
      panels: [
        table("Wave runs by result", "tf-apply runs over the range: applied, nothing to apply, waiting for an approval, refused because the plans moved after approval, or failed.", ds, countedOver(apply, "$__range", [PROJECT_L, RESULT_L])),
        series("Refused and failed waves", "Wave runs refused or failed in the hour before each point.", ds, refusedOrFailed, `{{${RESULT_L}}}`),
        table("Roots per wave", "Roots in each wave of the latest apply run, by project.", ds, latest(METRIC.waveRoots, [P], ["project", "wave"])),
      ],
    }),
    new Row({
      title: "Rollouts",
      panels: [
        table("Roots per module version", "How many roots pin each module version, across the projects: a rollout's progress.", ds, `count by (module, version) (${latest(METRIC.modulePin, [P], ["project", "root", "module", "version"], "7d")})`, 24),
      ],
    }),
  ], [projectVar(ds, METRIC.lastRun, "project")]);
}

function drift(s: Required<DashboardSettings>): DashboardEntity {
  const ds = prom(s.prometheus);
  const roots = selector(METRIC.driftRoots, [P]);
  // Each drift run's count holds until the next run, or until the runs have stopped for longer than `schedule`.
  const latestRoots = `max by (project) (last_over_time(${roots}[${s.schedule}]))`;
  return dashboard(s, DASHBOARD_UIDS.drift, "terragucci: Drift", "Drifted roots by project, how long the drift has stood, and the roots corrected.", [
    new Row({
      title: "Drift",
      panels: [
        series("Drifted roots", "Roots the latest drift run found drifted, by project.", ds, latestRoots, "{{project}}", "short", 24),
        table("Drift age", "How long since each project's open drift was first found (its drift issue opened).", ds, `time() - (${driftOpen()})`),
        table("Roots corrected", "Drifted roots fewer than the day before, by project.", ds, `clamp_min(max by (project) (max_over_time(${roots}[1d] offset 1d)) - max by (project) (max_over_time(${roots}[1d])), 0)`),
      ],
    }),
  ], [projectVar(ds, METRIC.lastRun, "project")]);
}

/** A table field override: each cell of `field` links to `url`, where `${__value.raw}` and `${__data.fields.<name>}` are the row's values. */
const fieldLink = (field: string, title: string, url: string) => ({
  matcher: { id: "byName", options: field },
  properties: [{ id: "links", value: [{ title, url, targetBlank: true }] }],
});

/** The URL of the report index of the project a cell names. */
export const projectIndexUrl = (reports: string): string => `${reports}/\${__value.raw}/index.html`;
/** The URL of the page that sends a trace's reader to its run's report. */
export const traceReportUrl = (reports: string): string => `${reports}/traces/\${__data.fields.traceID}.html`;

/** A DORA gauge at each point, by project: terragucci estate sends it on its schedule, so its latest value holds for a day. */
const dora = (metric: string, matchers: Matcher[]): string => `max by (project) (last_over_time(${selector(metric, matchers)}[1d]))`;

function estate(s: Required<DashboardSettings>, links: DashboardLinks): DashboardEntity {
  const ds = prom(s.prometheus);
  // Each project links to its report index in the bucket.
  const perProject = table(
    "Roots per project",
    `Roots in each project's latest plan or drift run.${links.reports ? " Each project links to its report index." : ""}`,
    ds,
    latest(METRIC.rootsPlanned, [["stage", "=~", "tf-plan|tf-drift"], P], ["project"], "7d"),
    12,
    8,
    links.reports ? [fieldLink("project", "Report index", projectIndexUrl(links.reports))] : [],
  );
  return dashboard(s, DASHBOARD_UIDS.estate, "terragucci: Estate", "Roots per project, the binary and terragucci versions they run, the DORA metrics terragucci estate computes, module pins across repos and tips by rule.", [
    new Row({
      title: "Projects",
      panels: [
        perProject,
        table("Versions", "The binary, its version and the terragucci release each project's latest run used.", ds, `count by (project, binary, version, service_version) (last_over_time(${selector(METRIC.binaryVersion, [P])}[7d]))`),
      ],
    }),
    new Row({
      title: "Delivery",
      panels: [
        series("Deployments per week", "Applied waves per week over the newest eight weeks, as terragucci estate last computed them, by project; * is the estate.", ds, dora(METRIC.doraDeployments, [P]), "{{project}}"),
        series("Lead time", "Median time from a change's first plan to its wave applied, by project.", ds, dora(METRIC.doraLeadTime, [P, ["segment", "=", "total"]]), "{{project}}", "s"),
        series("Change failure rate", "Failed applies and applied waves followed by drift, over all applies, by project.", ds, dora(METRIC.doraFailureRate, [P]), "{{project}}", "percentunit"),
        series("Time to restore", "Median time from a failed apply or drift found to restored, by project.", ds, dora(METRIC.doraRestore, [P]), "{{project}}", "s"),
      ],
    }),
    new Row({
      title: "Modules and tips",
      panels: [
        table("Module pins", "Each module call's pin, by project and root.", ds, latest(METRIC.modulePin, [P], ["project", "root", "module", "version"], "7d")),
        table("Tips by rule", "Tips the latest run of each project gave, by rule.", ds, `sum by (rule) (${latest(METRIC.tips, [P], ["project", "rule"], "7d")})`),
      ],
    }),
  ], [projectVar(ds, METRIC.lastRun, "project")], undefined, links.reports ? [{ title: "Report index", url: `${links.reports}/index.html` }] : []);
}

function runs(s: Required<DashboardSettings>, links: DashboardLinks): DashboardEntity {
  const ds = prom(s.prometheus);
  const t = tempo(s.tempo);
  const top = (metric: string, by: string[]) => `topk(10, max by (${by.join(", ")}) (max_over_time(${selector(metric, [P])}[$__range])))`;
  return dashboard(s, DASHBOARD_UIDS.runs, "terragucci: Runs", "Where the runs spend their time: the slowest roots and resources, provider init, lock waits, and the trace of any run.", [
    new Row({
      title: "Slowest",
      panels: [
        table("Slowest roots", "The ten slowest root plans over the range, in seconds.", ds, top(METRIC.rootPlan, ["project", "root"])),
        table("Slowest root applies", "The ten slowest root applies over the range, in seconds.", ds, top(METRIC.rootApply, ["project", "root"])),
        table("Slowest resources", "The ten slowest resources over the range, from the binary's spans, in seconds.", ds, top(METRIC.resource, ["project", "root", "address"])),
        table("Provider init", "Time spent starting each provider, in seconds.", ds, top(METRIC.providerInit, ["project", "provider"])),
        table("Lock waits", "Time spent waiting for a state lock, by root, in seconds.", ds, top(METRIC.lockWait, ["project", "root"])),
      ],
    }),
    new Row({
      title: "Stages",
      panels: [series("Stage duration", "How long each stage run took.", ds, `max by (project, stage) (${perPoint(selector(METRIC.stageDuration, [P]))})`, "{{project}} {{stage}}", "s", 24)],
    }),
    new Row({
      title: "Traces",
      panels: [
        new TablePanel({
          title: "Runs",
          description: links.reports
            ? "The trace of each stage run. Open one to see its waves, roots and the binary's own spans; a run's name links to its report."
            : "The trace of each stage run. Open one to see its waves, roots and the binary's own spans.",
          datasource: t,
          gridPos: { w: 24, h: 10 },
          targets: [new TempoQuery({ queryType: "traceql", query: `{ resource.service.name = "terragucci" && name =~ "terragucci .*" && span.terragucci.project =~ "$project" }`, limit: 50, tableType: "traces" })],
          // The trace id keeps Grafana's own link to the trace; the name links the run's report.
          ...(links.reports ? { fieldConfig: { overrides: [fieldLink("traceName", "Report", traceReportUrl(links.reports))] }, links: [{ title: "Report index", url: `${links.reports}/index.html`, targetBlank: true }] } : {}),
        }),
      ],
    }),
  ], [projectVar(ds, METRIC.lastRun, "project")], undefined, links.reports ? [{ title: "Report index", url: `${links.reports}/index.html` }] : []);
}

/** An SLI's events over its window, per project. */
const counted = (sel: string): string => countedOver(sel, "{{window}}", [PROJECT_L]);

/**
 * An SLI's total events, only where there were some: a window with no runs
 * records no ratio, where 0/0 would record NaN, and the SLO window's
 * average over the shorter ratios would then be NaN from then on.
 */
const someEvents = (sel: string): string => `${counted(sel)} > 0`;

/** The three SLOs: plans finish within ten minutes, applies succeed, drift is corrected within a day. */
export function slos(s: Required<DashboardSettings>): Record<keyof typeof SLO_NAMES, SloInstance> {
  const plan = [[STAGE_L, "=", "tf-plan"]] as Matcher[];
  const apply = [[STAGE_L, "=", "tf-apply"]] as Matcher[];
  const applied = selector(CALLS, [...apply, [RESULT_L, "=~", "applied|failed"]]);
  // The collector drops a gauge five minutes after it last changed, so each drift run's gauges hold until the next run, or until the runs have stopped for longer than `schedule`.
  const roots = `max by (project) (last_over_time(${METRIC.driftRoots}[${s.schedule}]))`;
  const since = `max by (project) (last_over_time(${METRIC.driftSince}[${s.schedule}]))`;
  return {
    plans: Slo({
      name: SLO_NAMES.plans,
      objective: 0.95,
      window: "28d",
      description: `Plans finish within ${PLAN_SLO_SECONDS / 60} minutes.`,
      sli: {
        good: counted(selector(DURATION_BUCKETS, [...plan, ["le", "=~", `${PLAN_SLO_SECONDS}(\\.0)?`]])),
        total: someEvents(selector(`${spans.duration!.prometheus}_count`, plan)),
      },
    }),
    applies: Slo({
      name: SLO_NAMES.applies,
      objective: 0.99,
      window: "28d",
      description: "Wave applies succeed.",
      sli: {
        // A project that never failed has no failed series: its errors are 0, not missing.
        errors: `${counted(selector(CALLS, [...apply, [RESULT_L, "=", "failed"]]))} or 0 * ${counted(applied)}`,
        total: someEvents(applied),
      },
    }),
    drift: Slo({
      name: SLO_NAMES.drift,
      objective: 0.9,
      window: "28d",
      description: "Drift is corrected within a day.",
      // A 10% budget cannot burn at a paging rate; slow burns open a ticket.
      alerting: { page: false },
      sli: {
        good: `sum by (project) (count_over_time((${roots} == 0 or (time() - ${since}) <= 86400)[{{window}}:5m]))`,
        total: `sum by (project) (count_over_time(${roots}[{{window}}:5m]))`,
      },
    }),
  };
}

/** The pipeline alerts: drift too old, a wave waiting too long, a failed apply, a refused wave, a drift run that stopped. */
export function pipelineAlerts(s: Required<DashboardSettings>): RuleGroupEntity {
  const any: Matcher[] = [];
  return new RuleGroup({
    name: "terragucci",
    rules: [
      {
        alert: "TerragucciDriftOld",
        expr: `time() - (${driftOpen(any)}) > ${seconds(s.drift_age)}`,
        labels: { severity: "ticket" },
        annotations: { summary: `{{ $labels.project }} has drift older than ${s.drift_age}`, description: "Its drift issue names the roots. Correct the drift with a pull request, or apply the code as it is." },
      },
      {
        alert: "TerragucciWaveWaiting",
        expr: `time() - (${wavesWaiting(any)}) > ${seconds(s.wave_wait)}`,
        labels: { severity: "ticket" },
        annotations: { summary: `wave {{ $labels.wave }} of {{ $labels.project }} has waited for an approval longer than ${s.wave_wait}`, description: "Its apply job printed the terragucci approve command for its digest." },
      },
      {
        alert: "TerragucciApplyFailed",
        expr: `${countedOver(selector(CALLS, [[STAGE_L, "=", "tf-apply"], [RESULT_L, "=", "failed"]]), RUN_WINDOW, [PROJECT_L])} > 0`,
        labels: { severity: "page" },
        annotations: { summary: `an apply of {{ $labels.${PROJECT_L} }} failed in the last hour`, description: "The apply job's log and the triage response name the error." },
      },
      {
        alert: "TerragucciWaveRefused",
        expr: `${countedOver(selector(CALLS, [[STAGE_L, "=", "tf-apply"], [RESULT_L, "=", "refused"]]), RUN_WINDOW, [PROJECT_L])} > 0`,
        labels: { severity: "ticket" },
        annotations: { summary: `a wave of {{ $labels.${PROJECT_L} }} was refused: its plans moved after approval`, description: "The wave applied nothing. Read what moved, then approve the new digest." },
      },
      {
        alert: "TerragucciDriftStopped",
        expr: `time() - max by (project) (last_over_time(${selector(METRIC.lastRun, [["stage", "=", "tf-drift"]])}[30d])) > ${seconds(s.schedule)}`,
        labels: { severity: "ticket" },
        annotations: { summary: `{{ $labels.project }}'s drift run has not run for ${s.schedule}`, description: "Its schedule stopped, or every run failed before it could report." },
      },
    ],
  });
}

/**
 * An SLO's dashboard, filtered by project. The SLO's recorded series carry the
 * project label of its SLI (`terragucci_project` or `project`), so the
 * dashboard's own queries take its selector, except the objective, which is one
 * series for every project.
 */
function sloDashboard(slo: SloInstance, ds: ReturnType<typeof prom>): DashboardEntity {
  const m = sloMetrics(slo);
  const label = m.name === SLO_NAMES.drift ? "project" : PROJECT_L;
  const dash = SloDashboard({ slo, datasource: ds, tags: [DASHBOARD_TAG, "slo"] }).dashboard;
  const filtered = m.selector.replace("}", `, ${label}=~"$project"}`);
  const scoped = (expr: string): string =>
    expr.startsWith(m.objectiveRatio) || expr.startsWith("sum(ALERTS") ? expr : expr.split(m.selector).join(filtered);
  const visit = (item: unknown): void => {
    const props = (item as { props?: Record<string, unknown> }).props;
    if (!props) return;
    for (const child of [...((props.panels as unknown[]) ?? []), ...((props.targets as unknown[]) ?? [])]) visit(child);
    if (typeof props.expr === "string") props.expr = scoped(props.expr);
  };
  for (const row of dash.props.panels ?? []) visit(row);
  const variable = new QueryVariable({
    name: "project",
    label: "Project",
    datasource: ds,
    query: `label_values(${m.windowErrorRatio}${m.selector}, ${label})`,
    multi: true,
    includeAll: true,
    allValue: ".+",
    refresh: "onTimeRangeChange",
    sort: 1,
  });
  return new Dashboard({ ...dash.props, variables: [variable] });
}

/** Every entity the dashboards and rules are built from. */
export function dashboardEntities(settings: Required<DashboardSettings>, links: DashboardLinks = {}): { grafana: Declarable[]; prometheus: Declarable[] } {
  const s = settings;
  const ds = prom(s.prometheus);
  const sl = slos(s);
  const grafana: Declarable[] = [
    new DashboardProvider({ name: "terragucci", folder: s.folder, path: s.path, foldersFromFilesStructure: false }),
    pipelineHealth(s),
    changeReview(s),
    rolloutsAndWaves(s),
    drift(s),
    estate(s, links),
    runs(s, links),
  ];
  for (const slo of Object.values(sl)) {
    grafana.push(sloDashboard(slo, ds));
    grafana.push(SloAlertRules({ slo, datasource: ds, folder: s.folder, group: `${slo.rules.groupName}-grafana` }).rules);
  }
  return { grafana, prometheus: [...Object.values(sl).map((x) => x.rules), pipelineAlerts(s)] };
}

/**
 * The files `dashboards:` puts in the repo, under its `dir`:
 *
 *   grafana/dashboards/<uid>.json                 one per dashboard
 *   grafana/provisioning/dashboards/terragucci.yaml   the provider that loads them
 *   grafana/provisioning/alerting/terragucci.yaml     the SLO burn-rate alerts, Grafana-managed
 *   prometheus/terragucci.rules.yml               the SLO recording rules and alerts, and the pipeline alerts
 */
export function renderDashboards(settings: Required<DashboardSettings>, links: DashboardLinks = {}): RenderedFile[] {
  const dir = settings.dir.replace(/\/+$/, "");
  const { grafana, prometheus } = dashboardEntities(settings, links);
  const built = buildGrafana(grafana);
  const out: RenderedFile[] = [];
  for (const d of built.dashboards) out.push({ path: `${dir}/grafana/dashboards/${d.uid}.json`, content: built.files[d.file] });
  const provider = built.files["provisioning/dashboards/chant.yaml"];
  if (provider) out.push({ path: `${dir}/grafana/provisioning/dashboards/terragucci.yaml`, content: `${YAML_MARKER}\n${provider}` });
  const alerting = built.files["provisioning/alerting/chant.yaml"];
  if (alerting) out.push({ path: `${dir}/grafana/provisioning/alerting/terragucci.yaml`, content: `${YAML_MARKER}\n${alerting}` });
  out.push({ path: `${dir}/prometheus/terragucci.rules.yml`, content: `${YAML_MARKER}\n${emitYaml(buildRuleFile(prometheus).config)}` });
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}
