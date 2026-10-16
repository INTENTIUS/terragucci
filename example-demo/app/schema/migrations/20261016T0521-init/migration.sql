-- yodel migration 20261016T0521-init
-- parent: none (the first migration)

-- app (app): SQLPG200 create
CREATE SCHEMA app;

-- app (app): SQLPG200 create
COMMENT ON SCHEMA app IS '[chant managed-by=chant]';

-- users (app.users): SQLPG200 create
CREATE TABLE app.users (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    name  text NOT NULL
  );

-- users (app.users): SQLPG200 create
COMMENT ON COLUMN app.users.email IS 'The address a user signs in with; demo rows only';

-- users (app.users): SQLPG200 create
COMMENT ON TABLE app.users IS '[chant managed-by=chant]';
