// Prints the stack's prometheus.yml, rendered from observability/prometheus.ts.
//   npx tsx scripts/render-prometheus.ts > stack/observability/prometheus.yml
import { prometheusYaml } from "../observability/prometheus";

process.stdout.write(prometheusYaml());
