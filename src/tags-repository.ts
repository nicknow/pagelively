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
  };
}
