import { table } from "@intentius/chant-lexicon-sql/postgres";
import { app } from "./app";

export const users = table`
  CREATE TABLE ${app}.users (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email      text NOT NULL UNIQUE,   -- login name, compared case-insensitively by the app
    created_at timestamptz NOT NULL DEFAULT now()
  );
  COMMENT ON TABLE ${app}.users IS 'One row per account';
  COMMENT ON COLUMN ${app}.users.email IS 'Unique; lower-cased by the app'`;
