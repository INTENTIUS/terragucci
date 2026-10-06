// Prints the stack's prometheus.yml, rendered from observability/prometheus.ts.
// `just render-observability` builds it with `chant build --lexicon-output`; this prints the same text.
//   npx tsx scripts/render-prometheus.ts > stack/observability/prometheus.yml
import { prometheusYaml } from "../observability/prometheus";

process.stdout.write(prometheusYaml());
