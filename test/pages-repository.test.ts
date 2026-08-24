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
    password_hash: null,
    match_tags: null,
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
      expect(created).toEqual({ ...page, password_hash: null, match_tags: null });

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

    it("throws db_write_failed (500) when the slug already exists (UNIQUE constraint)", async () => {
      await insertPage(db, { id: "slugdup001", slug: "dup-slug" });
      const now = isoNow();
      await expect(
        repo.create({
          id: "slugdup002",
          slug: "dup-slug",
          title: "Duplicate Slug",
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

    it("throws db_write_failed (500) when the id already exists (PRIMARY KEY violation)", async () => {
      const now = isoNow();
      await repo.create({
        id: "iddup00001",
        slug: "first",
        title: "First",
        kind: "html",
        rev: 1,
        entry_path: "index.html",
        raw_md_path: null,
        show_source: 0,
        visibility: "public",
        created_at: now,
        updated_at: now,
      });
      await expect(
        repo.create({
          id: "iddup00001",
          slug: "second",
          title: "Second",
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

  // --- updateMeta ---

  describe("updateMeta", () => {
    it("updates title and updated_at", async () => {
      const pageId = "updatemeta01";
      const created = "2026-01-01T00:00:00.000Z";
      await insertPage(db, {
        id: pageId,
        slug: "x",
        title: "Old",
        created_at: created,
        updated_at: created,
      });
      const updated = await repo.updateMeta(pageId, { title: "New" });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe("New");
      expect(updated!.updated_at).not.toBe(updated!.created_at);

      const row = await db.prepare("SELECT * FROM pages WHERE id = ?").bind(pageId).first();
      expect(row).toMatchObject({ title: "New" });
    });

    it("updates slug and validates uniqueness is not checked", async () => {
      const pageId = "updatemeta02";
      await insertPage(db, { id: pageId, slug: "x" });
      const updated = await repo.updateMeta(pageId, { slug: "renamed" });
      expect(updated!.slug).toBe("renamed");
    });

    it("stores an empty string when title is set to null", async () => {
      const pageId = "updatemeta-null-title";
      await insertPage(db, { id: pageId, slug: "x", title: "Old" });
      const updated = await repo.updateMeta(pageId, { title: null as unknown as string });
      expect(updated!.title).toBe("");
      const row = await db.prepare("SELECT title FROM pages WHERE id = ?").bind(pageId).first();
      expect(row).toMatchObject({ title: "" });
    });

    it("removes the slug when set to null", async () => {
      const pageId = "updatemeta03";
      await insertPage(db, { id: pageId, slug: "x" });
      const updated = await repo.updateMeta(pageId, { slug: null });
      expect(updated!.slug).toBeNull();
    });

    it("updates visibility and show_source", async () => {
      const pageId = "updatemeta04";
      await insertPage(db, { id: pageId, slug: "x" });
      const updated = await repo.updateMeta(pageId, { visibility: "unlisted", show_source: 1 });
      expect(updated!.visibility).toBe("unlisted");
      expect(updated!.show_source).toBe(1);
    });

    it("returns null for an unknown id", async () => {
      const updated = await repo.updateMeta("Unknown000", { title: "New" });
      expect(updated).toBeNull();
    });

    it("throws invalid_id for an invalid id", async () => {
      await expect(repo.updateMeta("bad/id", { title: "New" })).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("throws invalid_slug for an invalid slug", async () => {
      const pageId = "updatemeta05";
      await insertPage(db, { id: pageId, slug: "x" });
      await expect(repo.updateMeta(pageId, { slug: "ADMIN" })).rejects.toMatchObject({
        code: "invalid_slug",
        status: 400,
      });
    });

    it("throws invalid_visibility for an invalid visibility", async () => {
      const pageId = "updatemeta06";
      await insertPage(db, { id: pageId, slug: "x" });
      await expect(
        repo.updateMeta(pageId, { visibility: "secret" as "public" | "unlisted" }),
      ).rejects.toMatchObject({
        code: "invalid_visibility",
        status: 400,
      });
    });

    it("throws invalid_show_source for an invalid show_source", async () => {
      const pageId = "updatemeta07";
      await insertPage(db, { id: pageId, slug: "x" });
      await expect(repo.updateMeta(pageId, { show_source: 2 as 0 | 1 })).rejects.toMatchObject({
        code: "invalid_show_source",
        status: 400,
      });
    });

    it("returns the current page when the patch is empty", async () => {
      const pageId = "updatemeta08";
      await insertPage(db, { id: pageId, slug: "x" });
      const updated = await repo.updateMeta(pageId, {});
      expect(updated!.slug).toBe("x");
    });

    it("throws db_write_failed when the update fails", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated write failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.updateMeta("validId000", { title: "New" })).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
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

  // --- password_hash mapping (S23, migration 0002) ---

  describe("password_hash mapping", () => {
    it("maps a stored password_hash to PageRecord on getById", async () => {
      const id = "hashedpage01";
      const hash = "pbkdf2$10000$c2FsdA$aGFzaA";
      await insertPage(db, { id, slug: "h" });
      await db.prepare("UPDATE pages SET password_hash = ? WHERE id = ?").bind(hash, id).run();

      const page = await repo.getById(id);
      expect(page).not.toBeNull();
      expect(page!.password_hash).toBe(hash);
    });

    it("maps null password_hash across getBySlug, list, updateMeta, and applyRevBump", async () => {
      const id = "plainpage01";
      await insertPage(db, { id, slug: "plain" });

      const bySlug = await repo.getBySlug("plain");
      expect(bySlug!.password_hash).toBeNull();

      const listed = await repo.list();
      expect(listed[0].password_hash).toBeNull();

      const meta = await repo.updateMeta(id, { title: "T" });
      expect(meta!.password_hash).toBeNull();

      const bumped = await repo.applyRevBump(id, 2, "index.html", null);
      expect(bumped!.password_hash).toBeNull();
    });

    it("treats a missing password_hash column value as null", async () => {
      const badRow = makeMockRow({ password_hash: undefined });
      const badRepo = createPagesRepository(makeMockDb(badRow));
      const page = await badRepo.getById("validId000");
      expect(page).not.toBeNull();
      expect(page!.password_hash).toBeNull();
    });
  });

  // --- setPasswordHash (S23, ADR 0041 decision 10) ---

  describe("setPasswordHash", () => {
    it("sets password_hash and returns the updated record without bumping rev", async () => {
      const pageId = "setpwhash01";
      const hash = "pbkdf2$10000$c2FsdA$aGFzaA";
      await insertPage(db, { id: pageId, slug: "pw", rev: 3 });

      const updated = await repo.setPasswordHash(pageId, hash);
      expect(updated).not.toBeNull();
      expect(updated!.password_hash).toBe(hash);
      expect(updated!.rev).toBe(3); // no rev bump

      const row = await db
        .prepare("SELECT password_hash, rev FROM pages WHERE id = ?")
        .bind(pageId)
        .first();
      expect(row).toMatchObject({ password_hash: hash, rev: 3 });
    });

    it("clears password_hash when hash is null", async () => {
      const pageId = "clearpwhash01";
      await insertPage(db, { id: pageId, slug: "pw2" });
      await repo.setPasswordHash(pageId, "pbkdf2$10000$c2FsdA$aGFzaA");

      const cleared = await repo.setPasswordHash(pageId, null);
      expect(cleared).not.toBeNull();
      expect(cleared!.password_hash).toBeNull();

      const row = await db
        .prepare("SELECT password_hash FROM pages WHERE id = ?")
        .bind(pageId)
        .first();
      expect(row).toMatchObject({ password_hash: null });
    });

    it("shares one implementation with updateMeta: both write the same column", async () => {
      const pageId = "sharedimpl01";
      await insertPage(db, { id: pageId, slug: "s" });

      await repo.updateMeta(pageId, { passwordHash: "pbkdf2$10000$c2FsdA$YQ" });
      expect((await repo.getById(pageId))!.password_hash).toBe("pbkdf2$10000$c2FsdA$YQ");

      await repo.setPasswordHash(pageId, "pbkdf2$10000$c2FsdA$Yg");
      expect((await repo.getById(pageId))!.password_hash).toBe("pbkdf2$10000$c2FsdA$Yg");

      await repo.updateMeta(pageId, { passwordHash: null });
      expect((await repo.getById(pageId))!.password_hash).toBeNull();

      await repo.setPasswordHash(pageId, "pbkdf2$10000$c2FsdA$Yw");
      const empty = await repo.updateMeta(pageId, {});
      expect(empty!.password_hash).toBe("pbkdf2$10000$c2FsdA$Yw"); // unchanged
    });

    it("returns null for an unknown id without throwing", async () => {
      const updated = await repo.setPasswordHash("Unknown000", "pbkdf2$10000$c2FsdA$aGFzaA");
      expect(updated).toBeNull();
    });

    it("throws invalid_id (400) for an invalid id before SQL", async () => {
      for (const bad of ["", "bad/id", "a.b", "a b", "x".repeat(65)]) {
        await expect(repo.setPasswordHash(bad, "pbkdf2$10000$c2FsdA$aGFzaA")).rejects.toMatchObject(
          {
            code: "invalid_id",
            status: 400,
          },
        );
      }
    });

    it("throws db_write_failed (500) when the database write fails", async () => {
      const badRepo = createPagesRepository({
        prepare: () => {
          throw new Error("simulated write failure");
        },
      } as unknown as D1Database);
      await expect(
        badRepo.setPasswordHash("validId000", "pbkdf2$10000$c2FsdA$aGFzaA"),
      ).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });
  });

  // --- updateMeta passwordHash tri-state (undefined = unchanged, null = clear) ---

  describe("updateMeta passwordHash", () => {
    it("sets on string, clears on null, leaves unchanged when absent or undefined", async () => {
      const pageId = "metapwhash01";
      await insertPage(db, { id: pageId, slug: "m" });

      const set = await repo.updateMeta(pageId, { passwordHash: "pbkdf2$10000$c2FsdA$MQ" });
      expect(set!.password_hash).toBe("pbkdf2$10000$c2FsdA$MQ");

      const clear = await repo.updateMeta(pageId, { passwordHash: null });
      expect(clear!.password_hash).toBeNull();

      await repo.updateMeta(pageId, { passwordHash: "pbkdf2$10000$c2FsdA$Mg" });
      const absent = await repo.updateMeta(pageId, { title: "no-pw-change" });
      expect(absent!.password_hash).toBe("pbkdf2$10000$c2FsdA$Mg");

      const explicitUndefined = await repo.updateMeta(pageId, { passwordHash: undefined });
      expect(explicitUndefined!.password_hash).toBe("pbkdf2$10000$c2FsdA$Mg");
    });

    it("does not bump rev when only the password changes", async () => {
      const pageId = "metapwrev01";
      await insertPage(db, { id: pageId, slug: "r", rev: 7 });
      const updated = await repo.updateMeta(pageId, { passwordHash: "pbkdf2$10000$c2FsdA$Mw" });
      expect(updated!.rev).toBe(7);
    });
  });

  // --- S24-A: PageKind gains "raw-markdown" ---

  describe('kind "raw-markdown" (S24-A)', () => {
    const at = "2026-01-01T00:00:00.000Z";

    const rawRecord = (id: string, slug: string | null) =>
      pageRecord({
        id,
        slug,
        title: "Raw Notes",
        kind: "raw-markdown",
        rev: 1,
        // OQ-27/29 (approved): entry_path is normalized to "source.md"; the
        // source lives in entry_path itself, so raw_md_path stays null and
        // show_source is forced 0 (nothing to toggle — no rendered output).
        entry_path: "source.md",
        raw_md_path: null,
        show_source: 0,
        visibility: "public",
        created_at: at,
        updated_at: at,
      });

    it("create() inserts a raw-markdown page and getById reads it back intact via toPageRecord", async () => {
      const page = {
        id: "rawmd00001",
        slug: "my-notes",
        title: "Raw Notes",
        kind: "raw-markdown" as const,
        rev: 1,
        entry_path: "source.md",
        raw_md_path: null,
        show_source: 0 as const,
        visibility: "public" as const,
        created_at: at,
        updated_at: at,
      };
      const created = await repo.create(page);
      expect(created).toEqual({ ...page, password_hash: null, match_tags: null });

      const fetched = await repo.getById(page.id);
      expect(fetched).toEqual(rawRecord(page.id, page.slug));
    });

    it("getBySlug returns the raw-markdown record intact", async () => {
      await insertPage(db, {
        id: "rawmd00002",
        slug: "slug-raw",
        title: "Raw Notes",
        kind: "raw-markdown",
        rev: 1,
        entry_path: "source.md",
        raw_md_path: null,
        show_source: 0,
        visibility: "public",
        created_at: at,
        updated_at: at,
      });

      const fetched = await repo.getBySlug("slug-raw");
      expect(fetched).toEqual(rawRecord("rawmd00002", "slug-raw"));
    });

    it("list includes the raw-markdown record intact", async () => {
      await insertPage(db, {
        id: "rawmd00003",
        slug: "listed-raw",
        title: "Raw Notes",
        kind: "raw-markdown",
        rev: 1,
        entry_path: "source.md",
        raw_md_path: null,
        show_source: 0,
        visibility: "public",
        created_at: at,
        updated_at: at,
      });

      const listed = await repo.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(rawRecord("rawmd00003", "listed-raw"));
    });

    it(
      "still round-trips an unknown/garbage kind string — PINNED lenient behavior: " +
        "toPageRecord casts kind without validating (kind is free TEXT in D1); " +
        "do NOT add validation in this slice",
      async () => {
        const id = "garbagek001";
        await insertPage(db, {
          id,
          slug: "garbage-kind",
          title: "Weird",
          // Intentional garbage value: exercises the deliberate pass-through.
          kind: "weird" as unknown as PageRecord["kind"],
          rev: 1,
          entry_path: "index.html",
          raw_md_path: null,
          show_source: 0,
          visibility: "public",
          created_at: at,
          updated_at: at,
        });

        const fetched = await repo.getById(id);
        expect(fetched).toEqual(
          pageRecord({
            id,
            slug: "garbage-kind",
            title: "Weird",
            kind: "weird" as unknown as PageRecord["kind"],
            rev: 1,
            entry_path: "index.html",
            raw_md_path: null,
            show_source: 0,
            visibility: "public",
            created_at: at,
            updated_at: at,
          }),
        );
      },
    );

    it("reads every pre-existing kind back identically (regression pin)", async () => {
      const kinds = ["image", "html", "markdown", "bundle", "listing"] as const;
      let i = 0;
      for (const kind of kinds) {
        i += 1;
        const id = `regress${String(i).padStart(5, "0")}`;
        const slug = `regress-${kind}`;
        const entryPath = kind === "image" ? "photo.jpg" : "index.html";
        const rawMdPath = kind === "markdown" ? "source.md" : null;
        await insertPage(db, {
          id,
          slug,
          title: `Regress ${kind}`,
          kind,
          rev: 2,
          entry_path: entryPath,
          raw_md_path: rawMdPath,
          show_source: kind === "markdown" ? 1 : 0,
          visibility: "public",
          created_at: at,
          updated_at: at,
        });

        const fetched = await repo.getById(id);
        expect(fetched!.kind).toBe(kind);
        expect(fetched).toEqual(
          pageRecord({
            id,
            slug,
            title: `Regress ${kind}`,
            kind,
            rev: 2,
            entry_path: entryPath,
            raw_md_path: rawMdPath,
            show_source: kind === "markdown" ? 1 : 0,
            visibility: "public",
            created_at: at,
            updated_at: at,
          }),
        );
      }
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
      const id = "corruptrev01";
      await insertPage(db, { id, slug: "corrupt-rev", rev: 1 });
      await db.prepare("UPDATE pages SET rev = 0 WHERE id = ?").bind(id).run();
      await expect(repo.getById(id)).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) for invalid show_source values", async () => {
      const id = "corruptsrc01";
      await insertPage(db, { id, slug: "corrupt-src", show_source: 0 });
      await db.prepare("UPDATE pages SET show_source = 2 WHERE id = ?").bind(id).run();
      await expect(repo.getById(id)).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) for invalid visibility values", async () => {
      const id = "corruptvis01";
      await insertPage(db, { id, slug: "corrupt-vis", visibility: "public" });
      await db.prepare("UPDATE pages SET visibility = 'private' WHERE id = ?").bind(id).run();
      await expect(repo.getById(id)).rejects.toMatchObject({
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
    password_hash: null,
    match_tags: null,
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
