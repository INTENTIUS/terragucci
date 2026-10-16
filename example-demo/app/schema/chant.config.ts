import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-sql";
import { credentials } from "@intentius/sql-yodeler";

// app's database: schema app in the demo's Postgres (demo-postgres in
// stack/docker-compose.yml). credentials() reads DEV_POSTGRES_READER_USER,
// DEV_POSTGRES_WRITER_USER and their passwords, which app's main.tf passes.
export default {
  lexicons: ["sql"],
  sourceDir: "src",
  sql: {
    dialect: "postgres",
    profiles: {
      dev: {
        url: process.env.DEV_POSTGRES_URL ?? "postgres://demo-postgres:5432/demo",
        ...credentials("dev", "postgres"),
        schemas: ["app"],
      },
    },
  },
} satisfies ChantConfig;
