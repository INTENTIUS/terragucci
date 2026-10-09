import { database } from "@intentius/chant-lexicon-sql/clickhouse";

export const analytics = database`
  CREATE DATABASE analytics
  ENGINE = Atomic
  COMMENT 'Product analytics'`;
