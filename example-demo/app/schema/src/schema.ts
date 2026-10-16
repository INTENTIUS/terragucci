import { schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const app = schema`CREATE SCHEMA app`;

export const users = table`
  CREATE TABLE ${app}.users (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    name  text NOT NULL
  );
  COMMENT ON COLUMN ${app}.users.email IS 'The address a user signs in with; demo rows only'`;
