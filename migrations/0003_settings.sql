-- 0003: settings table — key-value store for user-configurable settings
--
-- Keys: "default_page" → slug of the page to serve at `/` (empty = use env var)
--
-- Applied to the local D1 emulation by `npm run db:local:migrate` and to every
-- test file's isolated database by the Vitest setup (test/apply-migrations.ts).

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
