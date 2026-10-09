import { table, view } from "@intentius/chant-lexicon-sql/clickhouse";
import { analytics } from "./analytics";
import { events } from "./events";

// Daily distinct users per event kind, kept current as events are inserted.
export const dailyActive = table`
  CREATE TABLE ${analytics}.daily_active (
    day    Date,
    kind   LowCardinality(String),
    users  AggregateFunction(uniq, UUID)
  )
  ENGINE = AggregatingMergeTree
  ORDER BY (day, kind)`;

export const dailyActiveMv = view`
  CREATE MATERIALIZED VIEW ${analytics}.daily_active_mv TO ${dailyActive} AS
  SELECT
    toDate(${events.columns.ts}) AS day,
    ${events.columns.kind} AS kind,
    uniqState(${events.columns.user_id}) AS users
  FROM ${events}
  GROUP BY day, kind`;
