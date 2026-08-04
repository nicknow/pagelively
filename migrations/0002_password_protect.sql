-- 0002: per-page password protection — pages.password_hash + page_unlocks (S23, ADR 0041)
--
-- Applied to the local D1 emulation by `npm run db:local:migrate` and to every
-- test file's isolated database by the Vitest setup (test/apply-migrations.ts).
-- Appends to 0001 (which is immutable); existing page rows get
-- password_hash = NULL (unprotected).

-- NULL = unprotected; otherwise a self-describing PBKDF2-HMAC-SHA256 string
-- "pbkdf2$<iter>$<salt-b64url>$<hash-b64url>" (src/password.ts).
ALTER TABLE pages ADD COLUMN password_hash TEXT;

-- One row per protected page (upsert — the latest unlock wins). Only the hex
-- SHA-256 of the opaque cookie token is stored; the raw token is never stored
-- or logged (ADR 0041 decision 1).
CREATE TABLE page_unlocks (
  page_id     TEXT PRIMARY KEY,   -- one row per protected page (upsert — latest unlock wins)
  token_hash  TEXT NOT NULL,      -- hex SHA-256 of the opaque cookie token; raw token never stored
  created_at  TEXT NOT NULL,      -- ISO-8601 UTC, set by the Worker
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);
