import type { YodelConfig } from "@intentius/sql-yodeler";

// The history lives in schema yodeler. dev's wave needs no SQL Yodeler
// approval: terragucci's gate on app's wave holds a retry for one instead.
// `yodel ci` renders yodel-waves.json, which app's main.tf runs. Its Forgejo
// pipelines are not committed: terragucci's pipeline runs the wave.
export default {
  environments: {
    dev: { history: { database: "yodeler" } },
  },
  waves: [{ env: "dev", gate: "never" }],
  ci: { forges: ["forgejo"] },
} satisfies YodelConfig;
