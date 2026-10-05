/**
 * The files `dashboards:` puts in the repo, under its `dir`, filled from the
 * template the build rendered (template.ts, rendered.json):
 *
 *   grafana/dashboards/<uid>.json                     one per dashboard
 *   grafana/provisioning/dashboards/terragucci.yaml   the provider that loads them
 *   grafana/provisioning/alerting/terragucci.yaml     the SLO burn-rate alerts, Grafana-managed
 *   prometheus/terragucci.rules.yml                   the SLO recording rules and alerts, and the pipeline alerts
 *
 * The same files index.ts's renderDashboards renders from the declarations;
 * `just ci-check` fails when rendered.json is not what they render.
 */
import type { DashboardSettings } from "../config";
import rendered from "./rendered.json";
import type { DashboardLinks, RenderedFile } from "./settings";
import { fillTemplate, type DashboardTemplate } from "./template";

export function dashboardFiles(settings: Required<DashboardSettings>, links: DashboardLinks = {}): RenderedFile[] {
  return fillTemplate(rendered as DashboardTemplate, settings, links);
}
