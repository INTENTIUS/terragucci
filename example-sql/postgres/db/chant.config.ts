import type { ChantConfig } from "@intentius/chant";
import "@intentius/chant-lexicon-sql";

export default {
  lexicons: ["sql"],
  sql: {
    dialect: "postgres",
    profiles: {
      prod: {
        url: "postgres://pgdb:5432/postgres",
        user: { env: "POSTGRES_USER" },
        password: { env: "POSTGRES_PASSWORD" },
        schemas: ["app"],
      },
    },
  },
} satisfies ChantConfig;
