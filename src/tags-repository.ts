/**
 * 0004 — D1 page_tags repository.
 *
 * Tags are simple text labels normalized to lowercase, trimmed, and stored in a
 * junction table. Each page can have zero or more unique tags.
 */
export interface TagsRepository {
  /** Get all tags for a page. */
  getByPageId(pageId: string): Promise<string[]>;
  /** Replace all tags for a page with a new set (reconcile). */
  setForPage(pageId: string, tags: string[]): Promise<void>;
  /** Find page IDs that have ALL of the given tags. */
  findPagesByTags(tags: string[]): Promise<string[]>;
}

export function createTagsRepository(db: D1Database): TagsRepository {
  return {
    async getByPageId(pageId: string): Promise<string[]> {
      const result = await db
        .prepare("SELECT tag FROM page_tags WHERE page_id = ? ORDER BY tag")
        .bind(pageId)
        .all<{ tag: string }>();
      return result.results.map((r) => r.tag);
    },

    async setForPage(pageId: string, tags: string[]): Promise<void> {
      // Normalize tags: lowercase, trim, remove empty
      const normalized = [
        ...new Set(tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)),
      ];

      await db.batch([
        db.prepare("DELETE FROM page_tags WHERE page_id = ?").bind(pageId),
        ...normalized.map((tag) =>
          db.prepare("INSERT INTO page_tags (page_id, tag) VALUES (?, ?)").bind(pageId, tag),
        ),
      ]);
    },

    async findPagesByTags(tags: string[]): Promise<string[]> {
      if (tags.length === 0) return [];
      const placeholders = tags.map(() => "?").join(", ");
      // Require ALL specified tags: GROUP BY page_id and HAVING COUNT = n
      const result = await db
        .prepare(
          `SELECT page_id FROM page_tags WHERE tag IN (${placeholders}) GROUP BY page_id HAVING COUNT(DISTINCT tag) = ?`,
        )
        .bind(...tags, tags.length)
        .all<{ page_id: string }>();
      return result.results.map((r) => r.page_id);
    },
  };
}
