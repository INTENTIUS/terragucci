import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { ConfigError, validateConfig } from "../src/config";
import {
  DASHBOARD_DEFAULTS,
  DASHBOARD_TAG,
  DASHBOARD_UIDS,
  dashboardSettings,
  renderDashboards,
  SLO_NAMES,
  writtenByTerragucci,
  YAML_MARKER,
} from "../src/dashboards";
import { METRIC } from "../src/dashboards/names";
import { init } from "../src/init";
import { buildReport } from "../src/report/build";
import { modulePins, StageObserver } from "../src/report/observe";
import { waveGauges, waveResult } from "../src/report/wave-telemetry";
import { git, twoRootRepo, write } from "./helpers";
import { RUN, smallFixture } from "./report-fixtures";

const DIR = "observability/terragucci";

function repo(config: string): string {
  const dir = write(twoRootRepo(), { "terragucci.yml": config });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", "https://github.com/acme/infra.git");
  return dir;
}

type Panel = { title?: string; type?: string; datasource?: { uid?: string; type?: string }; targets?: { expr?: string; query?: string; datasource?: { uid?: string } }[]; panels?: Panel[] };
const panelsOf = (json: { panels?: Panel[] }): Panel[] => (json.panels ?? []).flatMap((p) => [p, ...(p.panels ?? [])]);

describe("dashboards: rendering", () => {
  const files = renderDashboards(dashboardSettings(true)!);
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it("writes one JSON file per dashboard, the provisioning files and the rules file, under the dir", () => {
    const uids = [...Object.values(DASHBOARD_UIDS), ...Object.values(SLO_NAMES).map((n) => `slo-${n}`)].sort();
    expect(files.map((f) => f.path).sort()).toEqual([
      ...uids.map((u) => `${DIR}/grafana/dashboards/${u}.json`),
      `${DIR}/grafana/provisioning/alerting/terragucci.yaml`,
      `${DIR}/grafana/provisioning/dashboards/terragucci.yaml`,
      `${DIR}/prometheus/terragucci.rules.yml`,
    ].sort());
  });

  it("every dashboard is tagged terragucci and has its uid", () => {
    for (const uid of Object.values(DASHBOARD_UIDS)) {
      const json = JSON.parse(byPath.get(`${DIR}/grafana/dashboards/${uid}.json`)!);
      expect(json.uid).toBe(uid);
      expect(json.tags).toContain(DASHBOARD_TAG);
      expect(panelsOf(json).length).toBeGreaterThan(2);
    }
  });

  it("each dashboard reads the metrics it is built from", () => {
    const text = (uid: string) => byPath.get(`${DIR}/grafana/dashboards/${uid}.json`)!;
    expect(text(DASHBOARD_UIDS.pipeline)).toContain("terragucci_spans_calls_total");
    expect(text(DASHBOARD_UIDS.pipeline)).toContain("terragucci_spans_duration_seconds_bucket");
    expect(text(DASHBOARD_UIDS.changes)).toContain(METRIC.planChanges);
    expect(text(DASHBOARD_UIDS.changes)).toContain("pull_request");
    expect(text(DASHBOARD_UIDS.waves)).toContain(METRIC.waveWaitingSince);
    expect(text(DASHBOARD_UIDS.waves)).toContain(METRIC.modulePin);
    expect(text(DASHBOARD_UIDS.drift)).toContain(METRIC.driftRoots);
    expect(text(DASHBOARD_UIDS.estate)).toContain(METRIC.binaryVersion);
    expect(text(DASHBOARD_UIDS.estate)).toContain(METRIC.tips);
    expect(text(DASHBOARD_UIDS.runs)).toContain(METRIC.rootPlan);
    expect(text(DASHBOARD_UIDS.runs)).toContain(METRIC.lockWait);
    expect(text(DASHBOARD_UIDS.runs)).toContain(METRIC.providerInit);
  });

  it("counts a project's first runs, and graphs a run's gauges between a week's points", () => {
    const panel = (uid: string, title: string) => panelsOf(JSON.parse(byPath.get(`${DIR}/grafana/dashboards/${uid}.json`)!)).find((p) => p.title === title)!;
    const expr = (uid: string, title: string) => panel(uid, title).targets!.map((t) => t.expr).join("\n");
    // A counter's first sample is a run that rate() and increase() never count.
    for (const [uid, title] of [
      [DASHBOARD_UIDS.pipeline, "Runs per hour"],
      [DASHBOARD_UIDS.pipeline, "Errors"],
      [DASHBOARD_UIDS.pipeline, "Duration p95"],
      [DASHBOARD_UIDS.pipeline, "Runs by result"],
      [DASHBOARD_UIDS.waves, "Wave runs by result"],
      [DASHBOARD_UIDS.waves, "Refused and failed waves"],
    ] as const) {
      expect(expr(uid, title)).not.toMatch(/\b(rate|increase)\(/);
      expect(expr(uid, title)).toContain("unless");
    }
    // A project with wave runs and none refused or failed shows both results at 0.
    expect(expr(DASHBOARD_UIDS.waves, "Refused and failed waves")).toContain('label_replace(0 * sum(');
    // A gauge is sent once and dropped five minutes later: each point reads the largest since the one before.
    expect(expr(DASHBOARD_UIDS.changes, "Changes by action")).toContain("max_over_time(");
    expect(expr(DASHBOARD_UIDS.runs, "Stage duration")).toContain("[$__interval]");
    // A drift run's count holds until the next run, for as long as the drift schedule allows.
    expect(expr(DASHBOARD_UIDS.drift, "Drifted roots")).toContain(`[${DASHBOARD_DEFAULTS.schedule}]`);
  });

  it("the Runs dashboard lists the traces from Tempo", () => {
    const runs = JSON.parse(byPath.get(`${DIR}/grafana/dashboards/${DASHBOARD_UIDS.runs}.json`)!);
    const traces = panelsOf(runs).find((p) => p.title === "Runs")!;
    expect(traces.datasource).toEqual({ type: "tempo", uid: "tempo" });
    expect(traces.targets![0].query).toContain('name =~ "terragucci .*"');
  });

  it("the datasource uids and the folder come from the settings", () => {
    const custom = renderDashboards(dashboardSettings({ prometheus: "prom-main", tempo: "traces", folder: "Platform", dir: "ops/dash/" })!);
    expect(custom.every((f) => f.path.startsWith("ops/dash/"))).toBe(true);
    const pipeline = custom.find((f) => f.path.endsWith(`${DASHBOARD_UIDS.pipeline}.json`))!.content;
    expect(pipeline).toContain('"uid": "prom-main"');
    expect(pipeline).not.toContain('"uid": "prometheus"');
    expect(custom.find((f) => f.path.endsWith(`${DASHBOARD_UIDS.runs}.json`))!.content).toContain('"uid": "traces"');
    const provider = parseYAML(custom.find((f) => f.path.endsWith("provisioning/dashboards/terragucci.yaml"))!.content) as { providers: { folder: string; options: { path: string } }[] };
    expect(provider.providers[0].folder).toBe("Platform");
    expect(provider.providers[0].options.path).toBe(DASHBOARD_DEFAULTS.path);
  });

  it("the rules file holds the three SLOs and the five pipeline alerts, with the thresholds in seconds", () => {
    const rules = byPath.get(`${DIR}/prometheus/terragucci.rules.yml`)!;
    expect(rules.startsWith(YAML_MARKER)).toBe(true);
    const parsed = parseYAML(rules) as { groups: { name: string; rules: { alert?: string; record?: string; expr: string }[] }[] };
    expect(parsed.groups.map((g) => g.name).sort()).toEqual(["slo-terragucci-apply-success", "slo-terragucci-drift-corrected", "slo-terragucci-plan-time", "terragucci"]);
    const alerts = parsed.groups.find((g) => g.name === "terragucci")!.rules;
    expect(alerts.map((r) => r.alert)).toEqual(["TerragucciDriftOld", "TerragucciWaveWaiting", "TerragucciApplyFailed", "TerragucciWaveRefused", "TerragucciDriftStopped"]);
    expect(alerts[0].expr).toMatch(/> 86400$/);
    expect(alerts[1].expr).toMatch(/> 14400$/);
    expect(alerts[4].expr).toMatch(/> 172800$/);
    // A failed or refused wave alerts even when it is the project's first.
    for (const a of [alerts[2], alerts[3]]) {
      expect(a.expr).not.toContain("increase(");
      expect(a.expr).toContain("offset 1h");
    }
    // The plan SLO counts plans within the 600s bucket, as Prometheus 3 writes le.
    expect(rules).toContain('le=~"600(\\\\.0)?"');
    // The plan and apply SLIs count a series that appeared in the window from
    // zero (rate() misses a project's first run), and record nothing for a
    // window without runs (0/0 would record NaN).
    for (const name of ["slo-terragucci-plan-time", "slo-terragucci-apply-success"]) {
      const ratio = parsed.groups.find((g) => g.name === name)!.rules.find((r) => r.record === "slo:sli_error:ratio_rate5m")!.expr;
      expect(ratio).not.toContain("rate(");
      expect(ratio).toContain("unless");
      expect(ratio).toContain("offset 5m");
      expect(ratio).toMatch(/> 0\)\s*\)?$/);
    }
  });

  it("thresholds follow the settings", () => {
    const rules = renderDashboards(dashboardSettings({ drift_age: "12h", wave_wait: "30m", schedule: "3d" })!).find((f) => f.path.endsWith(".rules.yml"))!.content;
    expect(rules).toContain("> 43200");
    expect(rules).toContain("> 1800");
    expect(rules).toContain("> 259200");
  });

  it("the Grafana alerting file holds the SLO burn-rate rules in the folder", () => {
    const alerting = parseYAML(byPath.get(`${DIR}/grafana/provisioning/alerting/terragucci.yaml`)!) as { groups: { name: string; folder: string }[] };
    expect(alerting.groups.map((g) => g.folder)).toEqual(alerting.groups.map(() => "terragucci"));
    expect(alerting.groups.length).toBe(3);
  });

  it("rendering twice gives the same files", () => {
    expect(renderDashboards(dashboardSettings(true)!)).toEqual(files);
  });

  it("knows its own files", () => {
    expect(writtenByTerragucci("x.yaml", `${YAML_MARKER}\nfoo: 1\n`)).toBe(true);
    expect(writtenByTerragucci("x.yaml", "foo: 1\n")).toBe(false);
    expect(writtenByTerragucci("x.json", JSON.stringify({ tags: ["terragucci"] }))).toBe(true);
    expect(writtenByTerragucci("x.json", JSON.stringify({ tags: ["mine"] }))).toBe(false);
    expect(writtenByTerragucci("x.json", "not json")).toBe(false);
  });

  it("is off unless set", () => {
    expect(dashboardSettings(undefined)).toBeUndefined();
    expect(dashboardSettings(false)).toBeUndefined();
    expect(dashboardSettings(true)).toEqual(DASHBOARD_DEFAULTS);
  });
});

describe("dashboards: config", () => {
  it("takes true, false or a map of known keys", () => {
    expect(validateConfig({ dashboards: true }, "t")).toEqual({ dashboards: true });
    expect(validateConfig({ dashboards: { dir: "ops", wave_wait: "2h" } }, "t")).toEqual({ dashboards: { dir: "ops", wave_wait: "2h" } });
  });

  it.each([
    [{ dashboards: "yes" }, /dashboards must be true, false or a map/],
    [{ dashboards: { grafana: "x" } }, /dashboards.grafana is not a setting/],
    [{ dashboards: { wave_wait: "soon" } }, /dashboards.wave_wait is "soon"; use a duration/],
    [{ dashboards: { dir: "../elsewhere" } }, /dashboards.dir must be a path inside the repo/],
    [{ dashboards: { prometheus: 3 } }, /dashboards.prometheus must be a string/],
  ])("refuses %j", (raw, message) => {
    expect(() => validateConfig(raw, "t")).toThrow(ConfigError);
    expect(() => validateConfig(raw, "t")).toThrow(message);
  });
});

describe("dashboards: init", () => {
  it("writes nothing for dashboards without the key", async () => {
    const r = await init(repo("binary: tofu\n"), {});
    expect(r.files.some((f) => f.path.includes("observability"))).toBe(false);
  });

  it("writes the dashboards next to the pipeline, and a second run changes nothing", async () => {
    const dir = repo("binary: tofu\ndashboards: true\n");
    const r = await init(dir, {});
    const ours = r.files.filter((f) => f.path.includes(`/${DIR}/`));
    expect(ours.map((f) => f.status)).toEqual(ours.map(() => "created"));
    expect(ours.length).toBe(renderDashboards(dashboardSettings(true)!).length);
    expect(JSON.parse(readFileSync(join(dir, DIR, "grafana/dashboards", `${DASHBOARD_UIDS.waves}.json`), "utf-8")).uid).toBe(DASHBOARD_UIDS.waves);
    const again = await init(dir, {});
    expect(again.files.map((f) => f.status)).toEqual(again.files.map(() => "unchanged"));
  });

  it("refuses to overwrite a file there it did not write, unless forced", async () => {
    const dir = write(repo("binary: tofu\ndashboards: true\n"), { [`${DIR}/prometheus/terragucci.rules.yml`]: "groups: []\n" });
    await expect(init(dir, {})).rejects.toThrow(/terragucci did not write it/);
    const forced = await init(dir, { force: true });
    expect(forced.files.find((f) => f.path.endsWith("terragucci.rules.yml"))!.status).toBe("updated");
  });
});

describe("dashboards: what a stage sends", () => {
  const gaugesOf = (stage: string, env: NodeJS.ProcessEnv, setup: (o: StageObserver) => void = () => {}) => {
    const observer = new StageObserver(undefined, stage, env);
    setup(observer);
    const report = buildReport({ run: { ...RUN, stage: stage as never }, roots: smallFixture(), tips: [{ rule: "TF040", message: "m", url: "u" }, { rule: "TF040", message: "n", url: "u" }] });
    return observer.gauges(report, "1.13.1", 1_759_572_000_000_000_000n);
  };

  it("a plan names its pull request, counts the roots it changes and the tips by rule, and says when it ran", () => {
    const g = gaugesOf("tf-plan", { TG_PR: "12" });
    expect(g.every((x) => x.attributes.pull_request === "12")).toBe(true);
    expect(g.find((x) => x.name === METRIC.rootsChanged)!.value).toBe(3);
    expect(g.find((x) => x.name === METRIC.tips)).toMatchObject({ value: 2, attributes: { rule: "TF040" } });
    expect(g.find((x) => x.name === METRIC.lastRun)!.value).toBe(1_759_572_000);
  });

  it("a drift run says how many roots drifted, and since when", () => {
    const g = gaugesOf("tf-drift", {}, (o) => { o.drift = { since: "2026-10-01T00:00:00Z" }; });
    expect(g.find((x) => x.name === METRIC.driftRoots)!.value).toBe(3);
    expect(g.find((x) => x.name === METRIC.driftSince)!.value).toBe(Date.parse("2026-10-01T00:00:00Z") / 1000);
    expect(g.some((x) => x.name === METRIC.driftClear)).toBe(false);
    expect(g.some((x) => "pull_request" in x.attributes)).toBe(false);
  });

  it("a wave's result and gauges follow its exit code", () => {
    expect(waveResult(0, {})).toBe("applied");
    expect(waveResult(0, { nothing: true })).toBe("nothing");
    expect(waveResult(1, {})).toBe("failed");
    expect(waveResult(3, {})).toBe("waiting");
    expect(waveResult(4, {})).toBe("refused");
    const g = (name: string, unit: string, description: string, value: number, attributes: Record<string, string>) => ({ name, unit, description, value, attributes });
    const waiting = waveGauges(2, 3, { roots: ["a", "b"], waitingSince: "2026-10-04T00:00:00Z" }, 2_000_000_000, g);
    expect(waiting.map((x) => [x.name, x.value])).toEqual([[METRIC.waveRoots, 2], [METRIC.waveWaitingSince, Date.parse("2026-10-04T00:00:00Z") / 1000]]);
    expect(waiting.every((x) => x.attributes.wave === "2")).toBe(true);
    const applied = waveGauges(2, 0, { roots: ["a"] }, 2_000_000_000, g);
    expect(applied.map((x) => [x.name, x.value])).toEqual([[METRIC.waveRoots, 1], [METRIC.waveSettled, 2_000_000_000]]);
  });

  it("a tf-apply wave sends its wave gauges with its project and stage", () => {
    const observer = new StageObserver(undefined, "tf-apply", {});
    observer.wave = { number: 1, facts: { roots: ["gate"], waitingSince: "2026-10-04T00:00:00Z" }, code: 3 };
    const report = buildReport({ run: { ...RUN, stage: "tf-apply" as never }, roots: smallFixture() });
    const g = observer.applyGauges(report, 1_759_572_000_000_000_000n);
    expect(g.find((x) => x.name === METRIC.waveRoots)).toMatchObject({ value: 1, attributes: { project: RUN.project, stage: "tf-apply", wave: "1" } });
    expect(g.find((x) => x.name === METRIC.waveWaitingSince)).toMatchObject({ value: Date.parse("2026-10-04T00:00:00Z") / 1000, attributes: { project: RUN.project, wave: "1" } });
    expect(g.some((x) => x.name === METRIC.waveSettled)).toBe(false);
  });

  it("reads each root's module pins from its plan's configuration", () => {
    const calls = (c: Record<string, unknown>) => ({ configuration: { root_module: { module_calls: c } } });
    expect(modulePins([
      { path: "envs/dev", plan: calls({ net: { source: "git::https://example.com/acme/infra.git//modules/network?ref=modules/network/v1.3.0" } }) },
      { path: "envs/prod", plan: calls({ vpc: { source: "terraform-aws-modules/vpc/aws", version_constraint: "5.1.0" }, local: { source: "./modules/x" } }) },
    ])).toEqual([
      { root: "envs/dev", module: "https://example.com/acme/infra//modules/network", version: "1.3.0" },
      { root: "envs/prod", module: "terraform-aws-modules/vpc/aws", version: "5.1.0" },
    ]);
  });
});

describe("dashboards: links down to the reports (#131)", () => {
  type Link = { title: string; url: string };
  type Override = { matcher: { id: string; options: string }; properties: { id: string; value: Link[] }[] };
  type LinkedPanel = Panel & { links?: Link[]; fieldConfig?: { overrides?: Override[] } };
  const BASE = "https://reports.acme.example/reports";
  const dash = (files: { path: string; content: string }[], uid: string) =>
    JSON.parse(files.find((f) => f.path.endsWith(`/${uid}.json`))!.content) as { links: Link[]; panels: LinkedPanel[] };
  const panel = (d: { panels: LinkedPanel[] }, title: string) => panelsOf(d).find((p) => p.title === title) as LinkedPanel;
  const linkOn = (p: LinkedPanel, field: string): string | undefined =>
    p.fieldConfig?.overrides?.find((o) => o.matcher.id === "byName" && o.matcher.options === field)?.properties.find((x) => x.id === "links")?.value[0]?.url;

  it("with no reports address, links nothing outside Grafana", () => {
    const files = renderDashboards(dashboardSettings(true)!);
    for (const uid of [DASHBOARD_UIDS.runs, DASHBOARD_UIDS.estate]) {
      const d = dash(files, uid);
      expect(d.links).toEqual([]);
      expect(JSON.stringify(d)).not.toContain("index.html");
    }
  });

  it("the Runs dashboard's trace rows link each run's report through its trace page, and the index", () => {
    const d = dash(renderDashboards(dashboardSettings(true)!, { reports: BASE }), DASHBOARD_UIDS.runs);
    const runs = panel(d, "Runs");
    expect(linkOn(runs, "traceName")).toBe(`${BASE}/traces/\${__data.fields.traceID}.html`);
    // Grafana's own link from the trace id to the trace stays.
    expect(linkOn(runs, "traceID")).toBeUndefined();
    expect(runs.links?.[0].url).toBe(`${BASE}/index.html`);
    expect(d.links.map((l) => l.url)).toEqual([`${BASE}/index.html`]);
  });

  it("the Estate dashboard links each project to its index, and the index of every project", () => {
    const d = dash(renderDashboards(dashboardSettings(true)!, { reports: BASE }), DASHBOARD_UIDS.estate);
    expect(linkOn(panel(d, "Roots per project"), "project")).toBe(`${BASE}/\${__value.raw}/index.html`);
    expect(d.links.map((l) => l.url)).toEqual([`${BASE}/index.html`]);
  });

  it("init takes the address from reports.url and reports.prefix, and never from the bucket's name", async () => {
    const served = await init(repo("binary: tofu\ndashboards: true\nreports:\n  bucket: s3://acme-reports\n  prefix: reports\n  url: https://reports.acme.example/\n"), { dryRun: true });
    const runs = served.files.find((f) => f.path.endsWith(`/${DASHBOARD_UIDS.runs}.json`))!;
    expect(runs.content).toContain(`${BASE}/traces/`);
    const unserved = await init(repo("binary: tofu\ndashboards: true\nreports:\n  bucket: s3://acme-reports\n"), { dryRun: true });
    const plain = unserved.files.find((f) => f.path.endsWith(`/${DASHBOARD_UIDS.runs}.json`))!;
    expect(plain.content).not.toContain("acme-reports");
    expect(plain.content).not.toContain("/traces/");
  });
});
