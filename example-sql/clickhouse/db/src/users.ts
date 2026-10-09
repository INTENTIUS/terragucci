import { table } from "@intentius/chant-lexicon-sql/clickhouse";
import { analytics } from "./analytics";

// The latest row per id wins at merge time.
export const users = table`
  CREATE TABLE ${analytics}.users (
    id          UUID,
    email       String,
    plan        LowCardinality(String) DEFAULT 'free',
    updated_at  DateTime
  )
  ENGINE = ReplacingMergeTree(updated_at)
  ORDER BY id`;
