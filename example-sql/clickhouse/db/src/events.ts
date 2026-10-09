import { table } from "@intentius/chant-lexicon-sql/clickhouse";
import { analytics } from "./analytics";

export const events = table`
  CREATE TABLE ${analytics}.events (
    user_id  UUID,
    kind     LowCardinality(String),
    ts       DateTime CODEC(Delta, ZSTD(3)),
    props    Map(String, String)
  )
  ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (user_id, kind, ts)
  TTL ts + INTERVAL 180 DAY`;
