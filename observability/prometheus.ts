/**
 * The Prometheus config the stack's observability profile runs
 * (stack/observability/prometheus.yml). It scrapes the collector, which holds
 * the metrics each stage pushed.
 *
 * The prometheus lexicon types rule files and Alertmanager, not the scrape
 * config, so this is a plain object emitted with the lexicon's own YAML
 * emitter. `scripts/render-prometheus.ts` writes it; `just ci` runs that and
 * `just ci-check` fails when the committed file differs.
 */
import { emitYaml } from "@intentius/chant-lexicon-prometheus";

export const prometheusConfig = {
  global: { scrape_interval: "5s" },
  scrape_configs: [
    {
      job_name: "otel-collector",
      static_configs: [{ targets: ["otel-collector:8889"] }],
    },
  ],
};

export const prometheusYaml = (): string => emitYaml(prometheusConfig);
