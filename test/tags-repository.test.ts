import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createTagsRepository } from "../src/tags-repository";

async function insertPage(db: D1Database, id: string) {
  const now = new Date().toISOString();
  await db
    .prepare(
      "INSERT INTO pages (id, slug, title, kind, rev, entry_path, show_source, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id, null, "Test Page", "html", 1, "index.html", 0, "public", now, now)
    .run();
}

describe("TagsRepository", () => {
  const db = () => env.DB;

  beforeEach(async () => {
    await db().prepare("DELETE FROM page_tags").run();
    await db().prepare("DELETE FROM pages").run();
  });

  it("getByPageId returns empty array for a page with no tags", async () => {
    await insertPage(db(), "page000001");
    const repo = createTagsRepository(db());
    const tags = await repo.getByPageId("page000001");
    expect(tags).toEqual([]);
  });

  it("setForPage adds tags and getByPageId returns them sorted", async () => {
    await insertPage(db(), "page000001");
    const repo = createTagsRepository(db());
    await repo.setForPage("page000001", ["blog", "tech", "announcement"]);
    const tags = await repo.getByPageId("page000001");
    expect(tags).toEqual(["announcement", "blog", "tech"]);
  });

  it("setForPage normalizes tags to lowercase and trims whitespace", async () => {
    await insertPage(db(), "page000001");
    const repo = createTagsRepository(db());
    await repo.setForPage("page000001", ["  Blog ", "TECH  ", "  Announcement "]);
    const tags = await repo.getByPageId("page000001");
    expect(tags).toEqual(["announcement", "blog", "tech"]);
  });

  it("setForPage deduplicates tags", async () => {
    await insertPage(db(), "page000001");
    const repo = createTagsRepository(db());
    await repo.setForPage("page000001", ["blog", "blog", "BLOG"]);
    const tags = await repo.getByPageId("page000001");
    expect(tags).toEqual(["blog"]);
  });

  it("setForPage replaces existing tags", async () => {
    await insertPage(db(), "page000001");
    const repo = createTagsRepository(db());
    await repo.setForPage("page000001", ["blog", "tech"]);
    await repo.setForPage("page000001", ["news"]);
    const tags = await repo.getByPageId("page000001");
    expect(tags).toEqual(["news"]);
  });

  it("setForPage with empty array removes all tags", async () => {
    await insertPage(db(), "page000001");
    const repo = createTagsRepository(db());
    await repo.setForPage("page000001", ["blog"]);
    await repo.setForPage("page000001", []);
    const tags = await repo.getByPageId("page000001");
    expect(tags).toEqual([]);
  });

  it("tags are deleted when the page is deleted (cascade)", async () => {
    await insertPage(db(), "page000001");
    const repo = createTagsRepository(db());
    await repo.setForPage("page000001", ["blog"]);
    await db().prepare("DELETE FROM pages WHERE id = ?").bind("page000001").run();
    const tags = await repo.getByPageId("page000001");
    expect(tags).toEqual([]);
  });
});
