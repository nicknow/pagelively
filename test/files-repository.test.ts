import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createFilesRepository, type FileRecord } from "../src/files-repository";

// S15 — D1 files repository (read-only surface, spec §8, architecture 02/03).

const isoNow = () => new Date().toISOString();

function fileRecord(
  overrides: Partial<FileRecord> & { page_id: string; path: string },
): FileRecord {
  return {
    r2_key: `pages/${overrides.page_id}/1/${overrides.path}`,
    content_type: "application/octet-stream",
    size: 0,
    ...overrides,
  } as FileRecord;
}

async function insertPage(
  db: D1Database,
  p: {
    id: string;
    slug?: string | null;
    title?: string;
    kind?: string;
    rev?: number;
    entry_path?: string;
    raw_md_path?: string | null;
    show_source?: number;
    visibility?: string;
  },
) {
  await db
    .prepare(
      `INSERT INTO pages (id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.slug === undefined ? null : p.slug,
      p.title ?? "",
      p.kind ?? "html",
      p.rev ?? 1,
      p.entry_path ?? "index.html",
      p.raw_md_path === undefined ? null : p.raw_md_path,
      p.show_source ?? 0,
      p.visibility ?? "public",
      isoNow(),
      isoNow(),
    )
    .run();
}

async function insertFile(
  db: D1Database,
  f: { page_id: string; path: string; r2_key: string; content_type: string; size: number },
) {
  await db
    .prepare("INSERT INTO files (page_id, path, r2_key, content_type, size) VALUES (?, ?, ?, ?, ?)")
    .bind(f.page_id, f.path, f.r2_key, f.content_type, f.size)
    .run();
}

async function clearFilesAndPages(db: D1Database) {
  await db.prepare("DELETE FROM files").run();
  await db.prepare("DELETE FROM pages").run();
}

describe("createFilesRepository", () => {
  const db = env.DB;
  const repo = createFilesRepository(db);

  beforeEach(async () => {
    await clearFilesAndPages(db);
  });

  describe("listForPage", () => {
    it("returns all files for a page ordered by path", async () => {
      const pageId = "page000001";
      await insertPage(db, { id: pageId, slug: "hello" });
      await insertFile(db, {
        page_id: pageId,
        path: "style.css",
        r2_key: "pages/page000001/1/style.css",
        content_type: "text/css",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "images/pic.png",
        r2_key: "pages/page000001/1/images/pic.png",
        content_type: "image/png",
        size: 2048,
      });

      const files = await repo.listForPage(pageId);
      expect(files).toEqual([
        fileRecord({
          page_id: pageId,
          path: "images/pic.png",
          r2_key: "pages/page000001/1/images/pic.png",
          content_type: "image/png",
          size: 2048,
        }),
        fileRecord({
          page_id: pageId,
          path: "style.css",
          r2_key: "pages/page000001/1/style.css",
          content_type: "text/css",
          size: 100,
        }),
      ]);
    });

    it("returns an empty array when the page has no files", async () => {
      const pageId = "page000002";
      await insertPage(db, { id: pageId, slug: "empty" });
      const files = await repo.listForPage(pageId);
      expect(files).toEqual([]);
    });

    it("returns an empty array for an unknown page id", async () => {
      const files = await repo.listForPage("Unknown000");
      expect(files).toEqual([]);
    });

    it("throws invalid_id (400) for an empty id before SQL", async () => {
      await expect(repo.listForPage("")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("throws invalid_id (400) for ids with non-URL-safe characters", async () => {
      for (const bad of ["a/b", "a.b", "a b", "a%2F", "admin!", "x".repeat(65)]) {
        await expect(repo.listForPage(bad)).rejects.toMatchObject({
          code: "invalid_id",
          status: 400,
        });
      }
    });

    it("throws invalid_id (400) for SQL-injection-like id patterns", async () => {
      await expect(repo.listForPage("' OR '1'='1")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("does not include files belonging to other pages", async () => {
      const a = "page000003";
      const b = "page000004";
      await insertPage(db, { id: a, slug: "alpha" });
      await insertPage(db, { id: b, slug: "beta" });
      await insertFile(db, {
        page_id: a,
        path: "a.txt",
        r2_key: "pages/page000003/1/a.txt",
        content_type: "text/plain",
        size: 1,
      });
      await insertFile(db, {
        page_id: b,
        path: "b.txt",
        r2_key: "pages/page000004/1/b.txt",
        content_type: "text/plain",
        size: 2,
      });

      const files = await repo.listForPage(a);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ page_id: a, path: "a.txt" });
    });

    it("throws db_read_failed (500) for an invalid size value in the database", async () => {
      const pageId = "page000005";
      await insertPage(db, { id: pageId, slug: "bad-size" });
      await db
        .prepare(
          "INSERT INTO files (page_id, path, r2_key, content_type, size) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(pageId, "x.txt", "pages/page000005/1/x.txt", "text/plain", "not-a-number")
        .run();
      await expect(repo.listForPage(pageId)).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) when the database fails", async () => {
      const brokenDb = {
        prepare: () => {
          throw new Error("simulated db failure");
        },
      } as unknown as D1Database;
      const brokenRepo = createFilesRepository(brokenDb);
      await expect(brokenRepo.listForPage("page000006")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) when the database throws a non-Error value", async () => {
      const brokenDb = {
        prepare: () => {
          throw "simulated db failure";
        },
      } as unknown as D1Database;
      const brokenRepo = createFilesRepository(brokenDb);
      await expect(brokenRepo.listForPage("page000006")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });
  });
});
