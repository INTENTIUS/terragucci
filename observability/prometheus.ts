/**
 * The Prometheus config the stack's observability profile runs
 * (stack/observability/prometheus.yml). It scrapes the collector, which holds
 * the metrics each stage pushed.
 *
 * It is declared with the prometheus lexicon's `PrometheusConfig` and
 * `ScrapeConfig` entities. `scripts/render-prometheus.ts` writes it; `just ci`
 * runs that and `just ci-check` fails when the committed file differs.
 */
import { PrometheusConfig, ScrapeConfig, prometheusConfigYaml } from "@intentius/chant-lexicon-prometheus";

export const config = new PrometheusConfig({ global: { scrape_interval: "5s" } });

export const collector = new ScrapeConfig({
  job_name: "otel-collector",
  static_configs: [{ targets: ["otel-collector:8889"] }],
});

export const prometheusYaml = (): string => prometheusConfigYaml([config, collector]);
