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

  // ── ALL-tags matching: findPagesByTags must require ALL specified tags ──

  it("findPagesByTags returns pages that have ALL specified tags", async () => {
    const repo = createTagsRepository(db());
    // Page A: blog + tech
    await insertPage(db(), "pageA");
    await repo.setForPage("pageA", ["blog", "tech"]);
    // Page B: blog + tech + news (has ALL required tags + extra)
    await insertPage(db(), "pageB");
    await repo.setForPage("pageB", ["blog", "tech", "news"]);
    // Page C: blog only (missing tech)
    await insertPage(db(), "pageC");
    await repo.setForPage("pageC", ["blog"]);

    const result = await repo.findPagesByTags(["blog", "tech"]);
    expect(result).toContain("pageA");
    expect(result).toContain("pageB");
    expect(result).not.toContain("pageC");
  });

  it("findPagesByTags returns pages that have ALL tags (more tags is OK)", async () => {
    const repo = createTagsRepository(db());
    await insertPage(db(), "pageX");
    await repo.setForPage("pageX", ["a", "b", "c", "d", "e"]);

    const result = await repo.findPagesByTags(["a", "c", "e"]);
    expect(result).toContain("pageX");
  });

  it("findPagesByTags returns empty when no pages have ALL specified tags", async () => {
    const repo = createTagsRepository(db());
    await insertPage(db(), "pageA");
    await repo.setForPage("pageA", ["blog"]);
    await insertPage(db(), "pageB");
    await repo.setForPage("pageB", ["tech"]);

    const result = await repo.findPagesByTags(["blog", "tech"]);
    expect(result).toEqual([]);
  });

  it("findPagesByTags returns empty when no pages have any matching tags", async () => {
    const repo = createTagsRepository(db());
    await insertPage(db(), "pageA");
    await repo.setForPage("pageA", ["blog"]);

    const result = await repo.findPagesByTags(["nonexistent"]);
    expect(result).toEqual([]);
  });

  it("findPagesByTags returns empty for empty input tags list", async () => {
    const repo = createTagsRepository(db());
    await insertPage(db(), "pageA");
    await repo.setForPage("pageA", ["blog"]);

    const result = await repo.findPagesByTags([]);
    expect(result).toEqual([]);
  });

  it("findPagesByTags with a single tag returns pages that have that tag", async () => {
    const repo = createTagsRepository(db());
    await insertPage(db(), "pageA");
    await repo.setForPage("pageA", ["blog"]);
    await insertPage(db(), "pageB");
    await repo.setForPage("pageB", ["tech"]);

    const result = await repo.findPagesByTags(["blog"]);
    expect(result).toEqual(["pageA"]);
  });

  it("findPagesByTags multiple pages with different tag sets — only ALL-tags pages match", async () => {
    const repo = createTagsRepository(db());
    await insertPage(db(), "p1"); // blog, tech, news
    await repo.setForPage("p1", ["blog", "tech", "news"]);
    await insertPage(db(), "p2"); // blog, tech
    await repo.setForPage("p2", ["blog", "tech"]);
    await insertPage(db(), "p3"); // tech, news
    await repo.setForPage("p3", ["tech", "news"]);
    await insertPage(db(), "p4"); // blog only
    await repo.setForPage("p4", ["blog"]);

    // Looking for pages with ALL of [blog, tech]
    const result = await repo.findPagesByTags(["blog", "tech"]);
    expect(result).toContain("p1");
    expect(result).toContain("p2");
    expect(result).not.toContain("p3");
    expect(result).not.toContain("p4");
    expect(result.length).toBe(2);
  });
});
