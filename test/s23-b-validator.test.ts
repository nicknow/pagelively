import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { createPagesRepository } from "../src/pages-repository";
import { hashToken } from "../src/password-token";

// S23-B validator adversarial probes — added independently of the
// implementer's own tests (test/unlocks-repository.test.ts,
// test/pages-repository.test.ts). Each probe targets an acceptance criterion
// or a resolution from ADR 0043 with a shape the implementer may not have
// covered: overwrite round-trips, combined patches, upsert timestamp
// replacement, concurrent double-create, raw-SQL seeding compatibility with
// and without the new column, sqlite_master evidence that readD1Migrations
// picks up 0002, and an FK-enforcement honesty check.

const isoNow = () => new Date().toISOString();

/** Raw-SQL seed with an explicit column list, legacy shape (no password_hash). */
async function insertPageLegacy(db: D1Database, p: { id: string; slug?: string | null }) {
  await db
    .prepare(
      `INSERT INTO pages (id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.slug === undefined ? null : p.slug,
      "",
      "html",
      1,
      "index.html",
      null,
      0,
      "public",
      isoNow(),
      isoNow(),
    )
    .run();
}

/** Raw-SQL seed that DOES include the new password_hash column. */
async function insertPageWithHash(
  db: D1Database,
  p: { id: string; slug?: string | null; password_hash: string | null },
) {
  await db
    .prepare(
      `INSERT INTO pages (id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      p.id,
      p.slug === undefined ? null : p.slug,
      "",
      "html",
      1,
      "index.html",
      null,
      0,
      "public",
      p.password_hash,
      isoNow(),
      isoNow(),
    )
    .run();
}

async function clearAll(db: D1Database) {
  await db.prepare("DELETE FROM page_unlocks").run();
  await db.prepare("DELETE FROM pages").run();
}

describe("S23-B validator probes — PagesRepository", () => {
  const db = env.DB;
  const repo = createPagesRepository(db);

  beforeEach(async () => {
    await clearAll(db);
  });

  it("setPasswordHash overwrites an existing hash, then clears to NULL; pbkdf2$ strings round-trip", async () => {
    const id = "ovrwrite01";
    const hashA = "pbkdf2$10000$c2FsdA$Zmlyc3Q";
    const hashB = "pbkdf2$10000$c2FsdA$c2Vjb25k";
    await insertPageLegacy(db, { id, slug: "ovw" });

    await repo.setPasswordHash(id, hashA);
    expect((await repo.getById(id))!.password_hash).toBe(hashA);

    // Overwrite — the new hash wins, no residue of the old one.
    const overwritten = await repo.setPasswordHash(id, hashB);
    expect(overwritten!.password_hash).toBe(hashB);
    expect(overwritten!.rev).toBe(1); // no rev bump on overwrite either
    const row = await db
      .prepare("SELECT password_hash, rev FROM pages WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toMatchObject({ password_hash: hashB, rev: 1 });

    // Clear — back to NULL.
    const cleared = await repo.setPasswordHash(id, null);
    expect(cleared!.password_hash).toBeNull();
    expect((await repo.getById(id))!.password_hash).toBeNull();
  });

  it("updateMeta applies title AND passwordHash in one call; rev untouched", async () => {
    const id = "comboed001";
    await insertPageLegacy(db, { id, slug: "combo" });
    const updated = await repo.updateMeta(id, {
      title: "Renamed",
      passwordHash: "pbkdf2$10000$c2FsdA$Y29tYm8",
    });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Renamed");
    expect(updated!.password_hash).toBe("pbkdf2$10000$c2FsdA$Y29tYm8");
    expect(updated!.rev).toBe(1);

    const row = await db
      .prepare("SELECT title, password_hash, rev FROM pages WHERE id = ?")
      .bind(id)
      .first();
    expect(row).toMatchObject({
      title: "Renamed",
      password_hash: "pbkdf2$10000$c2FsdA$Y29tYm8",
      rev: 1,
    });
  });

  it("create returns a PageRecord (password_hash key), never a raw passwordHash key", async () => {
    const now = isoNow();
    const created = await repo.create({
      id: "createmap01",
      slug: null,
      title: "X",
      kind: "html",
      rev: 1,
      entry_path: "index.html",
      raw_md_path: null,
      show_source: 0,
      visibility: "public",
      passwordHash: "pbkdf2$10000$c2FsdA$Y3JlYXRl",
      created_at: now,
      updated_at: now,
    });
    expect(created.password_hash).toBe("pbkdf2$10000$c2FsdA$Y3JlYXRl");
    expect("passwordHash" in created).toBe(false);
    expect("password_hash" in created).toBe(true);
  });

  it("raw-SQL seeding works with the column absent (legacy) AND present (compat)", async () => {
    await insertPageLegacy(db, { id: "legacyrow01", slug: "legacy" });
    await insertPageWithHash(db, {
      id: "hashedrow01",
      slug: "hashed",
      password_hash: "pbkdf2$10000$c2FsdA$cmF3",
    });

    const legacy = await repo.getById("legacyrow01");
    expect(legacy!.password_hash).toBeNull();

    const hashed = await repo.getById("hashedrow01");
    expect(hashed!.password_hash).toBe("pbkdf2$10000$c2FsdA$cmF3");

    // And list() maps both shapes.
    const listed = await repo.list();
    const byId = Object.fromEntries(listed.map((p) => [p.id, p.password_hash]));
    expect(byId).toMatchObject({ legacyrow01: null, hashedrow01: "pbkdf2$10000$c2FsdA$cmF3" });
  });
});

describe("S23-B validator probes — UnlocksRepository", () => {
  const db = env.DB;
  const repo = createUnlocksRepository(db);

  beforeEach(async () => {
    await clearAll(db);
  });

  it("upsert: a second create replaces the row — token_hash AND created_at reflect the latest write", async () => {
    await insertPageLegacy(db, { id: "upsrt00001", slug: "u1" });
    await repo.create("upsrt00001", "a".repeat(64));
    const first = await repo.getByPageId("upsrt00001");
    expect(first!.tokenHash).toBe("a".repeat(64));

    // Give the wall clock a chance to advance so created_at provably moves.
    await new Promise((r) => setTimeout(r, 10));
    await repo.create("upsrt00001", "b".repeat(64));

    const second = await repo.getByPageId("upsrt00001");
    expect(second!.tokenHash).toBe("b".repeat(64));
    expect(second!.createdAt >= first!.createdAt).toBe(true);

    const rows = await db
      .prepare("SELECT * FROM page_unlocks WHERE page_id = ?")
      .bind("upsrt00001")
      .all();
    expect(rows.results).toHaveLength(1); // still exactly one row
    const stale = await db
      .prepare("SELECT * FROM page_unlocks WHERE token_hash = ?")
      .bind("a".repeat(64))
      .all();
    expect(stale.results).toHaveLength(0);
  });

  it("concurrent-ish double create leaves exactly one row with a winner token", async () => {
    await insertPageLegacy(db, { id: "race000001", slug: "race" });
    await Promise.all([
      repo.create("race000001", "c".repeat(64)),
      repo.create("race000001", "d".repeat(64)),
    ]);

    const rows = await db
      .prepare("SELECT * FROM page_unlocks WHERE page_id = ?")
      .bind("race000001")
      .all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(["c".repeat(64), "d".repeat(64)]).toContain(rows.results[0].token_hash);
  });

  it("getByPageId unknown id → null; deleteByPageId unknown id → no throw", async () => {
    expect(await repo.getByPageId("Unknown000")).toBeNull();
    await expect(repo.deleteByPageId("Unknown000")).resolves.toBeUndefined();
  });

  it("FK enforcement is real in the emulated D1: orphan page_unlocks insert fails (honesty check)", async () => {
    await expect(
      db
        .prepare("INSERT INTO page_unlocks (page_id, token_hash, created_at) VALUES (?, ?, ?)")
        .bind("orphan0001", "e".repeat(64), isoNow())
        .run(),
    ).rejects.toThrow();
  });

  it("cascade: page delete removes its unlock row; no rows left for the id", async () => {
    const id = "cascade002";
    await insertPageLegacy(db, { id, slug: "cas2" });
    await repo.create(id, "f".repeat(64));
    await repo.create(id, "g".repeat(64)); // upsert → still one row
    const before = await db.prepare("SELECT * FROM page_unlocks").all();
    expect(before.results).toHaveLength(1);

    const pages = createPagesRepository(db);
    expect(await pages.delete(id)).toBe(true);

    expect(await repo.getByPageId(id)).toBeNull();
    const leftover = await db
      .prepare("SELECT * FROM page_unlocks WHERE page_id = ?")
      .bind(id)
      .all();
    expect(leftover.results).toHaveLength(0);
    const all = await db.prepare("SELECT * FROM page_unlocks").all();
    expect(all.results).toHaveLength(0);
  });
});

describe("S23-B validator probes — migration 0002 evidence", () => {
  const db = env.DB;

  it("readD1Migrations applied 0002: page_unlocks exists in sqlite_master and pages has password_hash", async () => {
    const tables = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'page_unlocks'")
      .all<{ name: string }>();
    expect(tables.results).toHaveLength(1);
    expect(tables.results[0].name).toBe("page_unlocks");

    const cols = await db.prepare("PRAGMA table_info(pages)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("password_hash");
  });

  it("existing rows created by the 0001-shaped INSERT read back with password_hash = NULL", async () => {
    await insertPageLegacy(db, { id: "preexist01", slug: "old" });
    const pages = createPagesRepository(db);
    expect((await pages.getById("preexist01"))!.password_hash).toBeNull();
  });

  it("raw token never stored anywhere: no test-DB row contains the raw token; all token_hashes are 64-char lowercase hex", async () => {
    const rawToken = "S1cr3t.Tok3nValue!@#";
    const hash = await hashToken(rawToken);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const pageId = "norawtoken1";
    await insertPageLegacy(db, { id: pageId, slug: "nr" });
    await db
      .prepare("UPDATE pages SET password_hash = ? WHERE id = ?")
      .bind("pbkdf2$10000$c2FsdA$bm90LWEtdG9rZW4", pageId)
      .run();
    await repoCreateHash(db, pageId, hash);

    const pageRows = await db.prepare("SELECT * FROM pages").all<Record<string, unknown>>();
    const unlockRows = await db
      .prepare("SELECT * FROM page_unlocks")
      .all<Record<string, unknown>>();

    for (const row of [...pageRows.results, ...unlockRows.results]) {
      for (const value of Object.values(row)) {
        expect(String(value).includes(rawToken)).toBe(false);
      }
    }
    for (const row of unlockRows.results) {
      expect(String(row.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

async function repoCreateHash(db: D1Database, pageId: string, tokenHash: string) {
  const repo = createUnlocksRepository(db);
  await repo.create(pageId, tokenHash);
}
