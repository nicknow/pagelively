-- 0004: page_tags — many-to-many tags per page (spec §17, future enhancements)
--
-- Tags are simple text labels. Each page can have zero or more tags.
-- Tags are normalized to lowercase and trimmed before storage.
--
-- Applied to the local D1 emulation by `npm run db:local:migrate` and to every
-- test file's isolated database by the Vitest setup (test/apply-migrations.ts).

CREATE TABLE page_tags (
  page_id   TEXT NOT NULL,
  tag       TEXT NOT NULL,
  PRIMARY KEY (page_id, tag),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

-- Index for querying pages by tag
CREATE INDEX idx_page_tags_tag ON page_tags(tag);
