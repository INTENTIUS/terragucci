// Renders the dashboards and rules from their declarations
// (packages/terragucci/src/dashboards/index.ts):
//   packages/terragucci/src/dashboards/rendered.json   the template the bundle carries and
//                                          init fills from terragucci.yml (template.ts)
//   stack/observability/terragucci/        the files `dashboards: true` puts in a repo,
//                                          filled from that template as init fills it
//   stack/observability/grafana-datasources.yaml   the stack's Prometheus and Tempo, under the
//                                          uids the dashboards read by default
//
// Either way it first proves the template: for several settings, the filled
// template is byte for byte what the declarations render, and yamlScalar
// writes a value as js-yaml does.
//
//   npx tsx scripts/render-dashboards.ts           write them
//   npx tsx scripts/render-dashboards.ts --check   fail when a committed file differs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Datasource } from "@intentius/chant-lexicon-grafana";
import { buildGrafana } from "@intentius/chant-lexicon-grafana/build";
import { emitYaml } from "@intentius/chant-lexicon-prometheus/build";
import { dashboardSettings, renderDashboards, type DashboardLinks, type DashboardSettings } from "../packages/terragucci/src/dashboards";
import { buildTemplate, fillTemplate, yamlScalar } from "../packages/terragucci/src/dashboards/template";

// The stack's datasources, declared with the grafana lexicon. The uids are the
// ones `dashboards:` defaults to.
const datasources = [
  new Datasource({ name: "Prometheus", type: "prometheus", uid: "prometheus", url: "http://prometheus:9090", isDefault: true }),
  new Datasource({ name: "Tempo", type: "tempo", uid: "tempo", url: "http://tempo:3200" }),
];

// Where the stack serves the reports bucket to a browser on the host: floci's
// published port, the bucket and the prefix the drill-down smoke claim writes
// under. The port is TERRAGUCCI_FLOCI_PORT, which a file cannot hold, so the
// links carry FLOCI_PORT_PLACEHOLDER and the stack's Grafana swaps it for the
// port when it starts (stack/docker-compose.yml). A repo sets these as
// reports.url and reports.prefix in terragucci.yml; init renders the same links from them.
export const FLOCI_PORT_PLACEHOLDER = "TGPH0FLOCIPORT";
const STACK_REPORTS = { url: `http://localhost:${FLOCI_PORT_PLACEHOLDER}/terragucci-reports`, prefix: "reports" };

const TEMPLATE = "packages/terragucci/src/dashboards/rendered.json";
const template = buildTemplate(renderDashboards, "Rendered by scripts/render-dashboards.ts from src/dashboards/index.ts. Do not edit; run 'just ci'.");

// The proof. Each setting takes a value unlike its placeholder, and the odd
// ones are values js-yaml quotes.
const PROOF: [string, DashboardSettings, DashboardLinks][] = [
  ["the defaults", {}, {}],
  ["the stack", { dir: "stack/observability/terragucci" }, { reports: `${STACK_REPORTS.url}/${STACK_REPORTS.prefix}` }],
  ["every setting", { dir: "ops/dash/", prometheus: "prom-main", tempo: "tempo-eu", folder: "Platform team", path: "/etc/grafana/dash", drift_age: "1d12h", wave_wait: "90m", schedule: "3d" }, { reports: "https://reports.example.com/a/b" }],
  ["odd values", { prometheus: 'a:b "q" #c', tempo: "true", folder: "123", path: "-x: {y}", drift_age: "30m1h" }, { reports: 'https://r.example.com/a\\c"d{x}' }],
];
let proof = 0;
for (const [name, given, links] of PROOF) {
  const settings = dashboardSettings(given)!;
  const want = renderDashboards(settings, links);
  const got = fillTemplate(template, settings, links);
  for (let i = 0; i < Math.max(want.length, got.length); i++) {
    if (want[i]?.path !== got[i]?.path || want[i]?.content !== got[i]?.content) {
      console.log(`  with ${name}, the template fills ${got[i]?.path ?? "nothing"} unlike the declarations render ${want[i]?.path ?? "nothing"}`);
      proof = 1;
      break;
    }
  }
}
const SCALARS = ["prometheus", "Platform team", "/var/lib/grafana/dashboards/terragucci", "", "123", "0x1F", "0o17", "0b101", "1.5", "1e3", ".inf", ".NaN", "-.5", "+12", "007", "true", "False", "NULL", "~", "<<", "yes", "Off", "y", "1:20", "2024-01-31", "2024-1-3 10:00:00", "2024-01-31x", "2024 team", "a: b", "a:b", "a #b", "a#b", "#a", "-a", "- a", "a-", "a:", "a ", " a", "{a}", "a{b}", "a,b", "[a]", "?a", "@a", "`a", "%a", "!a", "&a", "*a", "|a", ">a", "=a", "'a'", '"a"', 'a"b', "a\\b", "a\tb", "café", "a b", "a b", "\u0007", "😀"];
for (const s of SCALARS) {
  const want = emitYaml({ k: s });
  const got = `k: ${yamlScalar(s)}\n`;
  if (want !== got) {
    console.log(`  yamlScalar(${JSON.stringify(s)}) writes ${JSON.stringify(got)}; js-yaml writes ${JSON.stringify(want)}`);
    proof = 1;
  }
}
if (proof) {
  console.log("  The dashboards template does not reproduce the declarations; see packages/terragucci/src/dashboards/template.ts.");
  process.exit(1);
}

const root = join(import.meta.dirname, "..");
const files: Record<string, string> = {};
files[TEMPLATE] = `${JSON.stringify(template, null, 2)}\n`;
for (const f of fillTemplate(template, { ...dashboardSettings(true)!, dir: "stack/observability/terragucci" }, { reports: `${STACK_REPORTS.url}/${STACK_REPORTS.prefix}` })) files[f.path] = f.content;
files["stack/observability/grafana-datasources.yaml"] = buildGrafana(datasources).files["provisioning/datasources/chant.yaml"];

const check = process.argv.includes("--check");
let rc = 0;
for (const [path, content] of Object.entries(files)) {
  const abs = join(root, path);
  if (check) {
    if (!existsSync(abs) || readFileSync(abs, "utf-8") !== content) {
      console.log(`  ${path} is not what scripts/render-dashboards.ts renders from the declarations. Run 'just ci' and commit the result.`);
      rc = 1;
    }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
if (check && rc === 0) console.log(`  ✓ the dashboards template fills as the declarations render ${PROOF.length} settings; it and ${Object.keys(files).length - 1} dashboard, rule and datasource files under stack/observability match their declarations`);
if (!check) console.log(`  ✓ ${TEMPLATE} and ${Object.keys(files).length - 1} dashboard, rule and datasource files under stack/observability rendered`);
process.exit(rc);
