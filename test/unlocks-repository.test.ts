import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { createPagesRepository } from "../src/pages-repository";
import { hashToken } from "../src/password-token";

// S23-B — D1 page_unlocks repository + migration 0002 (ADR 0041 decisions 1,
// 10; architecture 02/03). Tests assert against the real migrated schema via
// the local D1 emulation.

const isoNow = () => new Date().toISOString();

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

async function insertUnlock(
  db: D1Database,
  u: { page_id: string; token_hash: string; created_at?: string },
) {
  await db
    .prepare("INSERT INTO page_unlocks (page_id, token_hash, created_at) VALUES (?, ?, ?)")
    .bind(u.page_id, u.token_hash, u.created_at ?? isoNow())
    .run();
}

async function clearAll(db: D1Database) {
  await db.prepare("DELETE FROM page_unlocks").run();
  await db.prepare("DELETE FROM pages").run();
}

describe("migration 0002 (schema)", () => {
  const db = env.DB;

  it("page_unlocks exists with exactly page_id/token_hash/created_at, PK on page_id", async () => {
    const res = await db
      .prepare("PRAGMA table_info(page_unlocks)")
      .all<{ name: string; type: string; notnull: number; pk: number }>();
    const cols = res.results.map((c) => c.name);
    expect(cols).toEqual(["page_id", "token_hash", "created_at"]);
    expect(res.results.filter((c) => c.pk === 1).map((c) => c.name)).toEqual(["page_id"]);
    expect(
      res.results
        .filter((c) => c.notnull === 1)
        .map((c) => c.name)
        .sort(),
    ).toEqual(["created_at", "token_hash"]);
  });

  it("page_unlocks declares FK → pages(id) ON DELETE CASCADE", async () => {
    const res = await db
      .prepare("PRAGMA foreign_key_list(page_unlocks)")
      .all<{ table: string; from: string; to: string; on_delete: string }>();
    expect(res.results).toContainEqual(
      expect.objectContaining({
        table: "pages",
        from: "page_id",
        to: "id",
        on_delete: "CASCADE",
      }),
    );
  });

  it("pages gains a nullable password_hash column", async () => {
    const res = await db
      .prepare("PRAGMA table_info(pages)")
      .all<{ name: string; type: string; notnull: number }>();
    const col = res.results.find((c) => c.name === "password_hash");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    expect(col!.notnull).toBe(0);
  });

  it("rows created without password_hash read back as null (existing rows → NULL)", async () => {
    await insertPage(db, { id: "existing001", slug: "legacy" });
    const pages = createPagesRepository(db);
    const page = await pages.getById("existing001");
    expect(page).not.toBeNull();
    expect(page!.password_hash).toBeNull();
  });
});

describe("createUnlocksRepository", () => {
  const db = env.DB;
  const repo = createUnlocksRepository(db);

  beforeEach(async () => {
    await clearAll(db);
  });

  // --- create (upsert) ---

  describe("create", () => {
    it("inserts an unlock row; getByPageId returns tokenHash and createdAt", async () => {
      await insertPage(db, { id: "page000001", slug: "protected" });
      await repo.create("page000001", "a".repeat(64));

      const row = await repo.getByPageId("page000001");
      expect(row).not.toBeNull();
      expect(row!.tokenHash).toBe("a".repeat(64));
      expect(typeof row!.createdAt).toBe("string");
      expect(new Date(row!.createdAt).toISOString()).toBe(row!.createdAt);

      const all = await db.prepare("SELECT * FROM page_unlocks").all();
      expect(all.results).toHaveLength(1);
    });

    it("upserts: a second create replaces the row (latest wins, one row per page)", async () => {
      await insertPage(db, { id: "page000001", slug: "protected" });
      await repo.create("page000001", "a".repeat(64));
      await repo.create("page000001", "b".repeat(64));

      const row = await repo.getByPageId("page000001");
      expect(row!.tokenHash).toBe("b".repeat(64));

      const rows = await db
        .prepare("SELECT * FROM page_unlocks WHERE page_id = ?")
        .bind("page000001")
        .all();
      expect(rows.results).toHaveLength(1);
      const stale = await db
        .prepare("SELECT * FROM page_unlocks WHERE token_hash = ?")
        .bind("a".repeat(64))
        .all();
      expect(stale.results).toHaveLength(0);
    });

    it("throws db_write_failed (500) when the page does not exist (FK violation)", async () => {
      await expect(repo.create("nosuchpage", "a".repeat(64))).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });

    it("throws invalid_id (400) for an invalid page id before SQL", async () => {
      for (const bad of ["", "bad/id", "a.b", "a b", "x".repeat(65)]) {
        await expect(repo.create(bad, "a".repeat(64))).rejects.toMatchObject({
          code: "invalid_id",
          status: 400,
        });
      }
    });

    it("throws db_write_failed (500) when the database write fails", async () => {
      const badRepo = createUnlocksRepository({
        prepare: () => {
          throw new Error("simulated write failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.create("validId000", "a".repeat(64))).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });
  });

  // --- getByPageId ---

  describe("getByPageId", () => {
    it("returns null for a page with no unlock row", async () => {
      await insertPage(db, { id: "page000002", slug: "open" });
      expect(await repo.getByPageId("page000002")).toBeNull();
    });

    it("returns null for an unknown page id", async () => {
      expect(await repo.getByPageId("Unknown000")).toBeNull();
    });

    it("throws invalid_id (400) for an invalid id before SQL", async () => {
      for (const bad of ["", "bad/id", "a.b", "a b", "x".repeat(65)]) {
        await expect(repo.getByPageId(bad)).rejects.toMatchObject({
          code: "invalid_id",
          status: 400,
        });
      }
    });

    it("throws db_read_failed (500) when the database read fails", async () => {
      const badRepo = createUnlocksRepository({
        prepare: () => {
          throw new Error("simulated db failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.getByPageId("validId000")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("throws db_read_failed (500) when D1 throws a non-Error value", async () => {
      const badRepo = createUnlocksRepository({
        prepare: () => {
          throw "simulated string failure";
        },
      } as unknown as D1Database);
      await expect(badRepo.getByPageId("validId000")).rejects.toMatchObject({
        code: "db_read_failed",
        status: 500,
      });
    });

    it("returns a row seeded via direct SQL (reads the real schema)", async () => {
      await insertPage(db, { id: "page000007", slug: "seeded" });
      await insertUnlock(db, { page_id: "page000007", token_hash: "d".repeat(64) });
      const row = await repo.getByPageId("page000007");
      expect(row).toEqual({ tokenHash: "d".repeat(64), createdAt: expect.any(String) });
    });

    it("is a PK lookup: another page's unlock row never matches", async () => {
      await insertPage(db, { id: "page000003", slug: "a" });
      await insertPage(db, { id: "page000004", slug: "b" });
      await repo.create("page000003", "c".repeat(64));
      expect(await repo.getByPageId("page000004")).toBeNull();
    });
  });

  // --- deleteByPageId ---

  describe("deleteByPageId", () => {
    it("deletes the unlock row", async () => {
      await insertPage(db, { id: "page000005", slug: "del" });
      await repo.create("page000005", "a".repeat(64));
      await repo.deleteByPageId("page000005");
      expect(await repo.getByPageId("page000005")).toBeNull();
    });

    it("is a no-op (no throw) when no row exists", async () => {
      await insertPage(db, { id: "page000006", slug: "none" });
      await expect(repo.deleteByPageId("page000006")).resolves.toBeUndefined();
    });

    it("throws invalid_id (400) for an invalid id", async () => {
      await expect(repo.deleteByPageId("bad/id")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("throws db_write_failed (500) when the database write fails", async () => {
      const badRepo = createUnlocksRepository({
        prepare: () => {
          throw new Error("simulated write failure");
        },
      } as unknown as D1Database);
      await expect(badRepo.deleteByPageId("validId000")).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });
    });
  });

  // --- FK cascade ---

  describe("FK cascade (page delete)", () => {
    it("deleting a page removes its page_unlocks row", async () => {
      const pageId = "cascade001";
      await insertPage(db, { id: pageId, slug: "cascade" });
      await repo.create(pageId, "a".repeat(64));
      expect(await repo.getByPageId(pageId)).not.toBeNull();

      const pages = createPagesRepository(db);
      expect(await pages.delete(pageId)).toBe(true);

      expect(await repo.getByPageId(pageId)).toBeNull();
      const leftover = await db
        .prepare("SELECT * FROM page_unlocks WHERE page_id = ?")
        .bind(pageId)
        .all();
      expect(leftover.results).toHaveLength(0);
    });
  });

  // --- raw tokens are never stored (ADR 0041 decision 1) ---

  describe("raw tokens are never stored", () => {
    it("stores only the 64-char lowercase hex token_hash, never the raw token", async () => {
      const rawToken = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdEfGhIjKlMnOp";
      const hash = await hashToken(rawToken);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      await insertPage(db, { id: "rawtoken01", slug: "raw" });
      await repo.create("rawtoken01", hash);

      const rows = await db.prepare("SELECT * FROM page_unlocks").all<Record<string, unknown>>();
      expect(rows.results).toHaveLength(1);
      const row = rows.results[0];

      // The only token-related column is token_hash.
      expect(Object.keys(row).sort()).toEqual(["created_at", "page_id", "token_hash"]);
      // The value is exactly the lowercase hex digest of the raw token.
      expect(row.token_hash).toBe(hash);
      // The raw token string does not appear anywhere in the table.
      expect(Object.values(row).some((v) => String(v).includes(rawToken))).toBe(false);
      // Every token_hash in the table matches the SHA-256 hex shape.
      for (const r of rows.results) {
        expect(String(r.token_hash)).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });
});
