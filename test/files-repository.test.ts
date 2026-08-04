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

  // --- replaceAll ---

  describe("replaceAll", () => {
    it("deletes existing files and inserts the new batch", async () => {
      const pageId = "page000100";
      await insertPage(db, { id: pageId, slug: "replace" });
      await insertFile(db, {
        page_id: pageId,
        path: "old.txt",
        r2_key: "pages/page000100/1/old.txt",
        content_type: "text/plain",
        size: 1,
      });

      await repo.replaceAll(pageId, 1, [
        {
          path: "new.txt",
          r2_key: "pages/page000100/1/new.txt",
          content_type: "text/plain",
          size: 2,
        },
      ]);

      const files = (
        await db
          .prepare("SELECT * FROM files WHERE page_id = ?")
          .bind(pageId)
          .all<Record<string, unknown>>()
      ).results;
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ path: "new.txt", size: 2 });
    });

    it("inserts files when none existed", async () => {
      const pageId = "page000101";
      await insertPage(db, { id: pageId, slug: "fresh" });
      await repo.replaceAll(pageId, 1, [
        { path: "a.txt", r2_key: "pages/page000101/1/a.txt", content_type: "text/plain", size: 1 },
      ]);
      const files = (
        await db
          .prepare("SELECT * FROM files WHERE page_id = ?")
          .bind(pageId)
          .all<Record<string, unknown>>()
      ).results;
      expect(files).toHaveLength(1);
    });

    it("partitions large batches into multiple D1 batches", async () => {
      const pageId = "page000102";
      await insertPage(db, { id: pageId, slug: "bulk" });
      const files = Array.from({ length: 100 }, (_, i) => ({
        path: `file${i}.txt`,
        r2_key: `pages/page000102/1/file${i}.txt`,
        content_type: "text/plain",
        size: i,
      }));
      await repo.replaceAll(pageId, 1, files);
      const rows = (
        await db
          .prepare("SELECT * FROM files WHERE page_id = ?")
          .bind(pageId)
          .all<Record<string, unknown>>()
      ).results;
      expect(rows).toHaveLength(100);
    });

    it("throws db_write_failed (500) when the database batch fails", async () => {
      const badRepo = createFilesRepository({
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [], success: true, meta: {} as D1Meta }),
            run: async () => ({ success: true, meta: {} as D1Meta }),
          }),
        }),
        batch: () => {
          throw new Error("simulated batch failure");
        },
      } as unknown as D1Database);
      await expect(
        badRepo.replaceAll("validId000", 1, [
          {
            path: "x.txt",
            r2_key: "pages/validId000/1/x.txt",
            content_type: "text/plain",
            size: 1,
          },
        ]),
      ).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });

    it("throws db_write_failed (500) when the database batch throws a non-Error value", async () => {
      const badRepo = createFilesRepository({
        prepare: () => ({
          bind: () => ({
            first: async () => null,
            all: async () => ({ results: [], success: true, meta: {} as D1Meta }),
            run: async () => ({ success: true, meta: {} as D1Meta }),
          }),
        }),
        batch: () => {
          throw "simulated string failure";
        },
      } as unknown as D1Database);
      await expect(
        badRepo.replaceAll("validId000", 1, [
          {
            path: "x.txt",
            r2_key: "pages/validId000/1/x.txt",
            content_type: "text/plain",
            size: 1,
          },
        ]),
      ).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });

    it("throws db_write_failed (500) when prepare fails (statement construction outside batch)", async () => {
      const badRepo = createFilesRepository({
        prepare: () => {
          throw new Error("simulated prepare failure");
        },
      } as unknown as D1Database);
      await expect(
        badRepo.replaceAll("validId000", 1, [
          {
            path: "x.txt",
            r2_key: "pages/validId000/1/x.txt",
            content_type: "text/plain",
            size: 1,
          },
        ]),
      ).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });

    it("throws invalid_id (400) for an invalid page id", async () => {
      await expect(
        repo.replaceAll("bad/id", 1, [
          { path: "x.txt", r2_key: "pages/bad/id/1/x.txt", content_type: "text/plain", size: 1 },
        ]),
      ).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("throws db_write_failed (500) when the page does not exist (FK violation)", async () => {
      await expect(
        repo.replaceAll("nosuchpage", 1, [
          { path: "x.txt", r2_key: "pages/nosuchpage/1/x.txt", content_type: "text/plain", size: 1 },
        ]),
      ).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });

    it("throws db_write_failed (500) when two files share the same path in a single batch (composite PK conflict)", async () => {
      const pageId = "page000103";
      await insertPage(db, { id: pageId, slug: "dup-path" });
      await expect(
        repo.replaceAll(pageId, 1, [
          { path: "dup.txt", r2_key: "pages/page000103/1/dup.txt", content_type: "text/plain", size: 1 },
          { path: "dup.txt", r2_key: "pages/page000103/1/dup.txt", content_type: "text/plain", size: 2 },
        ]),
      ).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });
  });

  // --- deleteFile ---

  describe("deleteFile", () => {
    it("deletes a file and returns true", async () => {
      const pageId = "page000200";
      await insertPage(db, { id: pageId, slug: "del-file" });
      await insertFile(db, {
        page_id: pageId,
        path: "style.css",
        r2_key: "pages/page000200/1/style.css",
        content_type: "text/css",
        size: 100,
      });
      expect(await repo.deleteFile(pageId, "style.css")).toBe(true);
      const files = await db
        .prepare("SELECT * FROM files WHERE page_id = ?")
        .bind(pageId)
        .all<Record<string, unknown>>();
      expect(files.results).toHaveLength(0);
    });

    it("returns false for a non-existent file", async () => {
      const pageId = "page000201";
      await insertPage(db, { id: pageId, slug: "del-file" });
      expect(await repo.deleteFile(pageId, "missing.txt")).toBe(false);
    });

    it("throws invalid_id (400) for an invalid page id", async () => {
      await expect(repo.deleteFile("bad/id", "x.txt")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("throws db_write_failed (500) when the database fails", async () => {
      const badRepo = createFilesRepository({
        prepare: () => {
          throw new Error("simulated write failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.deleteFile("validId000", "x.txt")).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });

    it("throws db_write_failed (500) when the database throws a non-Error value", async () => {
      const badRepo = createFilesRepository({
        prepare: () => {
          throw "simulated string failure";
        },
      } as unknown as D1Database);
      await expect(badRepo.deleteFile("validId000", "x.txt")).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });
  });
});
