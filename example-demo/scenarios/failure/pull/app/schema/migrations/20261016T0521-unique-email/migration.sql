-- yodel migration 20261016T0521-unique-email
-- parent: 20261016T0521-init

-- usersEmail (app.users_email_key): SQLPG240 concurrently, outside a transaction
-- pre-check, must return 0 (values of (email) held by more than one row, which a unique index fails on): SELECT (SELECT count(*) FROM (SELECT 1 FROM app.users WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1) AS duplicates) AS n
CREATE UNIQUE INDEX CONCURRENTLY users_email_key ON app.users (email);

-- usersEmail (app.users_email_key): SQLPG240 concurrently
COMMENT ON INDEX app.users_email_key IS '[chant managed-by=chant]';
