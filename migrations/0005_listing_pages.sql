-- 0005: listing pages — match_tags column for tag-based page listing
--
-- "listing" pages dynamically render a list of all pages with matching tags.
-- match_tags stores a comma-separated list of tags (e.g. "blog,tech").
-- A listing page matches pages that have ANY of the specified tags.
-- NULL or empty = no listing behavior.
--
-- Applied to the local D1 emulation by `npm run db:local:migrate` and to every
-- test file's isolated database by the Vitest setup (test/apply-migrations.ts).

ALTER TABLE pages ADD COLUMN match_tags TEXT;
