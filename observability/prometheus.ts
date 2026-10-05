/**
 * The Prometheus config the stack's observability profile runs
 * (stack/observability/prometheus.yml). It scrapes the collector, which holds
 * the metrics each stage pushed, and loads the rules terragucci's dashboards
 * come with (the SLOs' recording rules and the pipeline alerts), which
 * scripts/render-dashboards.ts writes under stack/observability/terragucci/.
 *
 * It is declared with the prometheus lexicon's `PrometheusConfig` and
 * `ScrapeConfig` entities. `scripts/render-prometheus.ts` writes it; `just ci`
 * runs that and `just ci-check` fails when the committed file differs.
 */
import { PrometheusConfig, ScrapeConfig, prometheusConfigYaml } from "@intentius/chant-lexicon-prometheus";

// Rules evaluate as often as the collector is scraped, so a smoke claim sees an SLO's series soon after a run.
export const config = new PrometheusConfig({
  global: { scrape_interval: "5s", evaluation_interval: "5s" },
  rule_files: ["/etc/prometheus/rules/*.yml"],
});

export const collector = new ScrapeConfig({
  job_name: "otel-collector",
  static_configs: [{ targets: ["otel-collector:8889"] }],
});

export const prometheusYaml = (): string => prometheusConfigYaml([config, collector]);
