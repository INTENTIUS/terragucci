// Renders what the stack's Grafana, Tempo and Prometheus read for the dashboards:
//   stack/observability/terragucci/        the files `dashboards: true` puts in a repo,
//                                          rendered by the same code init runs
//   stack/observability/grafana-datasources.yaml   the stack's Prometheus and Tempo, under the
//                                          uids the dashboards read by default
//
//   npx tsx scripts/render-dashboards.ts           write them
//   npx tsx scripts/render-dashboards.ts --check   fail when a committed file differs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Datasource } from "@intentius/chant-lexicon-grafana";
import { buildGrafana } from "@intentius/chant-lexicon-grafana/build";
import { dashboardSettings, renderDashboards } from "../packages/terragucci/src/dashboards";

// The stack's datasources, declared with the grafana lexicon. The uids are the
// ones `dashboards:` defaults to.
const datasources = [
  new Datasource({ name: "Prometheus", type: "prometheus", uid: "prometheus", url: "http://prometheus:9090", isDefault: true }),
  new Datasource({ name: "Tempo", type: "tempo", uid: "tempo", url: "http://tempo:3200" }),
];

const root = join(import.meta.dirname, "..");
const files: Record<string, string> = {};
for (const f of renderDashboards({ ...dashboardSettings(true)!, dir: "stack/observability/terragucci" })) files[f.path] = f.content;
files["stack/observability/grafana-datasources.yaml"] = buildGrafana(datasources).files["provisioning/datasources/chant.yaml"];

const check = process.argv.includes("--check");
let rc = 0;
for (const [path, content] of Object.entries(files)) {
  const abs = join(root, path);
  if (check) {
    if (!existsSync(abs) || readFileSync(abs, "utf-8") !== content) {
      console.log(`  ${path} is not what scripts/render-dashboards.ts renders. Run 'just ci' and commit the result.`);
      rc = 1;
    }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
if (check && rc === 0) console.log(`  ✓ ${Object.keys(files).length} dashboard, rule and datasource files under stack/observability match their declarations`);
if (!check) console.log(`  ✓ ${Object.keys(files).length} dashboard, rule and datasource files rendered under stack/observability`);
process.exit(rc);
