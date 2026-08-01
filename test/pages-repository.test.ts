import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createPagesRepository, type PageRecord } from "../src/pages-repository";

// S10 — D1 pages repository (reads) (spec §8, architecture 02/03, ADR 0012).
// Tests assert against the real migrated schema via the local D1 emulation.

const isoNow = () => new Date().toISOString();

function pageRecord(
  overrides: Omit<Partial<PageRecord>, "id" | "slug"> & { id: string; slug: string | null },
): PageRecord {
  return {
    title: "",
    kind: "html",
    rev: 1,
    entry_path: "index.html",
    raw_md_path: null,
    show_source: 0,
    visibility: "public",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as PageRecord;
}

async function insertPage(
  db: D1Database,
  p: {
    id: string;
    slug?: string | null;
    title?: string | null;
    kind?: string;
    rev?: number;
    entry_path?: string;
    raw_md_path?: string | null;
    show_source?: number;
    visibility?: string | null;
    created_at?: string;
    updated_at?: string;
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
      p.title === undefined ? "" : p.title,
      p.kind === undefined ? "html" : p.kind,
      p.rev === undefined ? 1 : p.rev,
      p.entry_path === undefined ? "index.html" : p.entry_path,
      p.raw_md_path === undefined ? null : p.raw_md_path,
      p.show_source === undefined ? 0 : p.show_source,
      p.visibility === undefined ? "public" : p.visibility,
      p.created_at === undefined ? isoNow() : p.created_at,
      p.updated_at === undefined ? isoNow() : p.updated_at,
    )
    .run();
}

async function clearPages(db: D1Database) {
  // D1/MiniFlare: DELETE FROM pages is acceptable in isolated test databases.
  await db.prepare("DELETE FROM pages").run();
}

describe("createPagesRepository", () => {
  const db = env.DB;
  const repo = createPagesRepository(db);

  beforeEach(async () => {
    await clearPages(db);
  });

  // --- getById ---

  describe("getById", () => {
    it("returns the page record for a known id", async () => {
      const id = "A1b2C3d4E5";
      const now = isoNow();
      await insertPage(db, {
        id,
        slug: "hello-world",
        title: "Hello World",
        kind: "html",
        rev: 3,
        entry_path: "index.html",
        raw_md_path: null,
        show_source: 1,
        visibility: "public",
        created_at: now,
        updated_at: now,
      });

      const page = await repo.getById(id);
      expect(page).toEqual(
        pageRecord({
          id,
          slug: "hello-world",
          title: "Hello World",
          kind: "html",
          rev: 3,
          entry_path: "index.html",
          raw_md_path: null,
          show_source: 1,
          visibility: "public",
          created_at: now,
          updated_at: now,
        }),
      );
    });

    it("returns null for an unknown id", async () => {
      const page = await repo.getById("Unknown000");
      expect(page).toBeNull();
    });

    it("throws invalid_id (400) for an empty id before SQL", async () => {
      await expect(repo.getById("")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("throws invalid_id (400) for ids with non-URL-safe characters", async () => {
      for (const bad of ["a/b", "a.b", "a b", "a%2F", "admin!", "x".repeat(65)]) {
        await expect(repo.getById(bad)).rejects.toMatchObject({
          code: "invalid_id",
          status: 400,
        });
      }
    });

    it("throws invalid_id (400) for SQL-injection-like id patterns", async () => {
      await expect(repo.getById("' OR '1'='1")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
      await expect(repo.getById("x' UNION SELECT * FROM pages --")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });
  });

  // --- getBySlug ---

  describe("getBySlug", () => {
    it("returns the page record for a known slug", async () => {
      const id = "B2c3D4e5F6";
      const now = isoNow();
      await insertPage(db, {
        id,
        slug: "my-post",
        title: "My Post",
        kind: "markdown",
        rev: 1,
        entry_path: "index.html",
        raw_md_path: "source.md",
        show_source: 1,
        visibility: "unlisted",
        created_at: now,
        updated_at: now,
      });

      const page = await repo.getBySlug("my-post");
      expect(page).toEqual(
        pageRecord({
          id,
          slug: "my-post",
          title: "My Post",
          kind: "markdown",
          rev: 1,
          entry_path: "index.html",
          raw_md_path: "source.md",
          show_source: 1,
          visibility: "unlisted",
          created_at: now,
          updated_at: now,
        }),
      );
    });

    it("returns null for an unknown slug", async () => {
      const page = await repo.getBySlug("no-such-slug");
      expect(page).toBeNull();
    });

    it("throws invalid_slug (400) for an empty slug", async () => {
      await expect(repo.getBySlug("")).rejects.toMatchObject({
        code: "invalid_slug",
        status: 400,
      });
    });

    it("throws invalid_slug (400) for reserved names", async () => {
      for (const reserved of [
        "admin",
        "api",
        "p",
        "assets",
        "favicon.ico",
        "robots.txt",
        "health",
        "sitemap.xml",
        "_hidden",
      ]) {
        await expect(repo.getBySlug(reserved)).rejects.toMatchObject({
          code: "invalid_slug",
          status: 400,
        });
      }
    });

    it("throws invalid_slug (400) for invalid charset or uppercase", async () => {
      await expect(repo.getBySlug("Bad Slug")).rejects.toMatchObject({
        code: "invalid_slug",
        status: 400,
      });
      await expect(repo.getBySlug("UpperCase")).rejects.toMatchObject({
        code: "invalid_slug",
        status: 400,
      });
    });
  });

  // --- list ---

  describe("list", () => {
    it("returns all rows ordered by created_at DESC, tie-breaking by id DESC", async () => {
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-01-02T00:00:00.000Z";
      const t3 = "2026-01-02T00:00:00.000Z"; // same as t2
      await insertPage(db, { id: "page000001", slug: "oldest", created_at: t1, updated_at: t1 });
      await insertPage(db, { id: "page000002", slug: "newer-a", created_at: t2, updated_at: t2 });
      await insertPage(db, { id: "page000003", slug: "newer-b", created_at: t3, updated_at: t3 });

      const pages = await repo.list();
      expect(pages.map((p) => p.id)).toEqual(["page000003", "page000002", "page000001"]);
    });

    it("includes both public and unlisted pages", async () => {
      await insertPage(db, {
        id: "publicpage",
        slug: "public-page",
        visibility: "public",
      });
      await insertPage(db, {
        id: "unlisted00",
        slug: "unlisted-page",
        visibility: "unlisted",
      });

      const pages = await repo.list();
      expect(pages.map((p) => p.id).sort()).toEqual(["publicpage", "unlisted00"].sort());
    });

    it("returns an empty array when the table is empty", async () => {
      const pages = await repo.list();
      expect(pages).toEqual([]);
    });
  });

  // --- slugTaken ---

  describe("slugTaken", () => {
    it("returns true when another page has the slug", async () => {
      await insertPage(db, { id: "page000001", slug: "taken" });
      await expect(repo.slugTaken("taken")).resolves.toBe(true);
    });

    it("returns false when the slug is unused", async () => {
      await expect(repo.slugTaken("available-slug")).resolves.toBe(false);
    });

    it("returns false when the only page with the slug is the excepted id", async () => {
      await insertPage(db, { id: "page000001", slug: "taken" });
      await expect(repo.slugTaken("taken", "page000001")).resolves.toBe(false);
    });

    it("returns true when a different page has the slug even with exceptId", async () => {
      await insertPage(db, { id: "page000001", slug: "taken" });
      await expect(repo.slugTaken("taken", "page000002")).resolves.toBe(true);
    });

    it("throws invalid_slug (400) for an invalid slug", async () => {
      await expect(repo.slugTaken("")).rejects.toMatchObject({
        code: "invalid_slug",
        status: 400,
      });
      await expect(repo.slugTaken("ADMIN")).rejects.toMatchObject({
        code: "invalid_slug",
        status: 400,
      });
    });

    it("throws invalid_id (400) for an invalid exceptId", async () => {
      await expect(repo.slugTaken("valid-slug", "")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
      await expect(repo.slugTaken("valid-slug", "bad/id!")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
      await expect(repo.slugTaken("valid-slug", "x".repeat(65))).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });
  });

  // --- filterVisible ---

  describe("filterVisible", () => {
    it("returns only public pages", () => {
      const pages: PageRecord[] = [
        pageRecord({ id: "a", slug: "a", visibility: "public" }),
        pageRecord({ id: "b", slug: "b", visibility: "unlisted" }),
        pageRecord({ id: "c", slug: "c", visibility: "public" }),
      ];
      expect(repo.filterVisible(pages).map((p) => p.id)).toEqual(["a", "c"]);
    });

    it("treats null or undefined visibility as public", () => {
      const pages: PageRecord[] = [
        pageRecord({ id: "a", slug: "a", visibility: "public" }),
        pageRecord({ id: "b", slug: "b", visibility: undefined as unknown as Visibility }),
        pageRecord({ id: "c", slug: "c", visibility: null as unknown as Visibility }),
      ];
      expect(repo.filterVisible(pages).map((p) => p.id)).toEqual(["a", "b", "c"]);
    });

    it("returns an empty array when given an empty array", () => {
      expect(repo.filterVisible([])).toEqual([]);
    });
  });

  // --- field mapping ---

  describe("field mapping", () => {
    it("maps show_source as 0 | 1 and rev as a number", async () => {
      await insertPage(db, {
        id: "numeric001",
        slug: "numeric",
        show_source: 0,
        rev: 42,
        kind: "image",
        entry_path: "photo.jpg",
      });

      const page = await repo.getById("numeric001");
      expect(page).not.toBeNull();
      expect(page!.show_source).toBe(0);
      expect(page!.rev).toBe(42);
      expect(page!.entry_path).toBe("photo.jpg");
    });

    it("maps null slug, null raw_md_path, null visibility, and null title correctly", async () => {
      const now = isoNow();
      await insertPage(db, {
        id: "nullable00",
        slug: null,
        title: null,
        kind: "html",
        rev: 1,
        entry_path: "index.html",
        raw_md_path: null,
        show_source: 0,
        visibility: null,
        created_at: now,
        updated_at: now,
      });

      const page = await repo.getById("nullable00");
      expect(page).toEqual(
        pageRecord({
          id: "nullable00",
          slug: null,
          title: "",
          kind: "html",
          rev: 1,
          entry_path: "index.html",
          raw_md_path: null,
          show_source: 0,
          visibility: "public",
          created_at: now,
          updated_at: now,
        }),
      );
    });
  });

  // --- create ---

  describe("create", () => {
    it("inserts a new page and returns the record", async () => {
      const now = isoNow();
      const page = {
        id: "newpage000",
        slug: "new-page",
        title: "New Page",
        kind: "html" as const,
        rev: 1,
        entry_path: "index.html",
        raw_md_path: null,
        show_source: 0 as const,
        visibility: "public" as const,
        created_at: now,
        updated_at: now,
      };
      const created = await repo.create(page);
      expect(created).toEqual(page);

      const row = await db.prepare("SELECT * FROM pages WHERE id = ?").bind(page.id).first();
      expect(row).toMatchObject({ id: page.id, slug: page.slug, title: page.title });
    });

    it("throws db_write_failed (500) when the insert fails", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated write failure");
        },
      } as unknown as D1Database);
      const now = isoNow();
      await expect(
        badRepo.create({
          id: "newpage001",
          slug: null,
          title: "X",
          kind: "html",
          rev: 1,
          entry_path: "index.html",
          raw_md_path: null,
          show_source: 0,
          visibility: "public",
          created_at: now,
          updated_at: now,
        }),
      ).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });
  });

  // --- updateMeta (stub) ---

  describe("updateMeta", () => {
    it("throws 'not implemented' (it is a stub for S18)", async () => {
      await expect(repo.updateMeta("page000001", { title: "New" })).rejects.toThrow(
        "not implemented",
      );
    });
  });

  // --- applyRevBump ---

  describe("applyRevBump", () => {
    it("updates rev, entry_path, raw_md_path, and updated_at", async () => {
      const pageId = "revpage000";
      const t1 = "2026-01-01T00:00:00.000Z";
      await insertPage(db, {
        id: pageId,
        slug: "rev-page",
        rev: 1,
        entry_path: "index.html",
        raw_md_path: "source.md",
        created_at: t1,
        updated_at: t1,
      });

      const updated = await repo.applyRevBump(pageId, 2, "new/index.html", null);
      expect(updated).not.toBeNull();
      expect(updated!.rev).toBe(2);
      expect(updated!.entry_path).toBe("new/index.html");
      expect(updated!.raw_md_path).toBeNull();
      expect(updated!.updated_at).not.toBe(t1);
      expect(updated!.created_at).toBe(t1);

      const row = await db.prepare("SELECT * FROM pages WHERE id = ?").bind(pageId).first();
      expect(row).toMatchObject({ rev: 2, entry_path: "new/index.html", raw_md_path: null });
    });

    it("returns null for an unknown id", async () => {
      const updated = await repo.applyRevBump("Unknown000", 2, "index.html", null);
      expect(updated).toBeNull();
    });

    it("throws invalid_id (400) for an invalid id", async () => {
      await expect(repo.applyRevBump("bad/id", 2, "index.html", null)).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("throws db_write_failed (500) when the update fails", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated write failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.applyRevBump("validId000", 2, "index.html", null)).rejects.toMatchObject(
        {
          code: "db_write_failed",
          status: 500,
        },
      );
    });
  });

  // --- delete ---

  describe("delete", () => {
    it("deletes a page and returns true", async () => {
      const pageId = "delpage000";
      await insertPage(db, { id: pageId, slug: "del-page" });
      expect(await repo.delete(pageId)).toBe(true);
      const row = await db.prepare("SELECT * FROM pages WHERE id = ?").bind(pageId).first();
      expect(row).toBeNull();
    });

    it("returns false for an unknown id", async () => {
      expect(await repo.delete("Unknown000")).toBe(false);
    });

    it("throws invalid_id (400) for an invalid id", async () => {
      await expect(repo.delete("bad/id")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("cascades file rows when a page is deleted", async () => {
      const pageId = "delpage001";
      await insertPage(db, { id: pageId, slug: "del-page" });
      await db
        .prepare(
          "INSERT INTO files (page_id, path, r2_key, content_type, size) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(pageId, "style.css", "pages/delpage001/1/style.css", "text/css", 100)
        .run();
      await repo.delete(pageId);
      const files = await db
        .prepare("SELECT * FROM files WHERE page_id = ?")
        .bind(pageId)
        .all<Record<string, unknown>>();
      expect(files.results).toHaveLength(0);
    });

    it("throws db_write_failed (500) when the delete fails", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated write failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.delete("validId000")).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });

    it("throws db_write_failed (500) when D1 throws a non-Error value", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw "simulated string failure";
        },
      } as unknown as D1Database);
      await expect(badRepo.delete("validId000")).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });
  });

  // --- failure modes ---

  describe("failure modes", () => {
    it("throws db_read_failed (500) for unexpected D1 errors in getById", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated db failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.getById("validId000")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) for unexpected D1 errors in getBySlug", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated db failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.getBySlug("valid-slug")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) for unexpected D1 errors in list", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated db failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.list()).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) for unexpected D1 errors in slugTaken", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated db failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.slugTaken("valid-slug")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) when D1 throws a non-Error value", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw "simulated string failure";
        },
      } as unknown as D1Database);
      await expect(badRepo.getById("validId000")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) for invalid rev values in the database row", async () => {
      const badRow = makeMockRow({ rev: 0 });
      const badRepo = createPagesRepository(makeMockDb(badRow));
      await expect(badRepo.getById("validId000")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) for invalid show_source values", async () => {
      const badRow = makeMockRow({ show_source: 2 });
      const badRepo = createPagesRepository(makeMockDb(badRow));
      await expect(badRepo.getById("validId000")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) for invalid visibility values", async () => {
      const badRow = makeMockRow({ visibility: "private" });
      const badRepo = createPagesRepository(makeMockDb(badRow));
      await expect(badRepo.getById("validId000")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });
  });
});

// Need to satisfy the PageRecord type for the synthetic null/undefined visibility cases.
type Visibility = "public" | "unlisted";

function makeMockRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "validId000",
    slug: "mock-slug",
    title: "Mock",
    kind: "html",
    rev: 1,
    entry_path: "index.html",
    raw_md_path: null,
    show_source: 0,
    visibility: "public",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeMockDb(row: Record<string, unknown>): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => row,
        all: async () => ({ results: [row], success: true, meta: {} as D1Meta }),
        run: async () => ({ success: true, meta: {} as D1Meta }),
      }),
      first: async () => row,
      all: async () => ({ results: [row], success: true, meta: {} as D1Meta }),
      run: async () => ({ success: true, meta: {} as D1Meta }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;
}

// D1Meta is internal to the D1 result shape; provide a minimal stub for the mock.
interface D1Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
}
