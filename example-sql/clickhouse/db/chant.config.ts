import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    dialect: "clickhouse",
    profiles: {
      prod: {
        url: "http://clickhouse:8123",
        user: { env: "CLICKHOUSE_USER" },
        password: { env: "CLICKHOUSE_PASSWORD" },
        databases: ["analytics"],
      },
    },
  },
} satisfies ChantConfig;
