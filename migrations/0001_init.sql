-- 0001: initial schema — pages + files (spec §8)
--
-- Applied to the local D1 emulation by `npm run db:local:migrate` and to every
-- test file's isolated database by the Vitest setup (test/apply-migrations.ts).

CREATE TABLE pages (
  id            TEXT PRIMARY KEY,      -- nanoid
  slug          TEXT UNIQUE,           -- nullable, friendly alias
  title         TEXT,
  kind          TEXT NOT NULL,         -- image|html|markdown|bundle
  rev           INTEGER NOT NULL DEFAULT 1,  -- publish revision (cache-busting)
  entry_path    TEXT NOT NULL,         -- e.g. index.html
  raw_md_path   TEXT,                  -- e.g. source.md (nullable)
  show_source   INTEGER DEFAULT 0,     -- expose raw markdown (0/1)
  visibility    TEXT DEFAULT 'public', -- public|unlisted
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE files (
  page_id       TEXT NOT NULL,
  path          TEXT NOT NULL,         -- relative path within the bundle
  r2_key        TEXT NOT NULL,         -- pages/{id}/{rev}/{path}
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  PRIMARY KEY (page_id, path),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX idx_pages_slug ON pages(slug);
