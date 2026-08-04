import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { handleListPages, handleGetPage } from "../src/admin-api";
import { createPagesRepository } from "../src/pages-repository";
import { createFilesRepository } from "../src/files-repository";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { createObjectStore } from "../src/object-store";
import { createTestCacheService } from "../src/cache-service";
import { createConfig } from "../src/config";

// S15 — Admin API list & detail handlers.

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
    password_hash?: string | null;
    created_at?: string;
    updated_at?: string;
  },
) {
  await db
    .prepare(
      `INSERT INTO pages (id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      p.password_hash === undefined ? null : p.password_hash,
      p.created_at ?? isoNow(),
      p.updated_at ?? isoNow(),
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

function makeConfig(): ReturnType<typeof createConfig> {
  return createConfig({
    SITE_NAME: "Test",
    ASSET_BASE_URL: "https://cdn.example.com",
    HOME_MODE: "404",
    HOME_PAGE_SLUG: "",
    ALLOW_RAW_HTML_IN_MD: "true",
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
  } as unknown as Env);
}

function makeDeps() {
  const db = env.DB;
  const pagesRepository = createPagesRepository(db);
  const filesRepository = createFilesRepository(db);
  const objectStore = createObjectStore(env.BUCKET);
  const cacheService = createTestCacheService();
  const config = makeConfig();
  const verifiedIdentity = { email: "admin@example.com" };
  return {
    pagesRepository,
    filesRepository,
    objectStore,
    cacheService,
    config,
    verifiedIdentity,
    unlocks: createUnlocksRepository(db),
  };
}

describe("admin-api handlers", () => {
  const db = env.DB;
  const ctx = createExecutionContext();

  beforeEach(async () => {
    await clearFilesAndPages(db);
  });

  describe("handleListPages", () => {
    it("returns an empty array when there are no pages", async () => {
      const deps = makeDeps();
      const request = new Request("https://pages.example.com/api/pages");
      const res = await handleListPages(request, ctx, deps);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual([]);
    });

    it("returns multiple pages ordered by created_at DESC", async () => {
      const deps = makeDeps();
      const t1 = "2026-01-01T00:00:00.000Z";
      const t2 = "2026-01-02T00:00:00.000Z";
      await insertPage(db, {
        id: "page000001",
        slug: "alpha",
        title: "Alpha",
        created_at: t1,
        updated_at: t1,
      });
      await insertPage(db, {
        id: "page000002",
        slug: "beta",
        title: "Beta",
        kind: "markdown",
        created_at: t2,
        updated_at: t2,
      });

      const res = await handleListPages(
        new Request("https://pages.example.com/api/pages"),
        ctx,
        deps,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>[];
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe("page000002");
      expect(body[1].id).toBe("page000001");
      expect(body[0]).toMatchObject({
        id: "page000002",
        slug: "beta",
        title: "Beta",
        kind: "markdown",
        rev: 1,
        entry_path: "index.html",
        raw_md_path: null,
        show_source: 0,
        visibility: "public",
      });
      expect(body[0]).toHaveProperty("created_at");
      expect(body[0]).toHaveProperty("updated_at");
      expect(body[0]).not.toHaveProperty("files");
    });

    it("S23: reports has_password for protected and unprotected pages without leaking the hash", async () => {
      const deps = makeDeps();
      await insertPage(db, { id: "page000011", slug: "open", title: "Open" });
      await insertPage(db, {
        id: "page000012",
        slug: "locked",
        title: "Locked",
        password_hash: "pbkdf2$10000$salt$hash",
      });

      const res = await handleListPages(
        new Request("https://pages.example.com/api/pages"),
        ctx,
        deps,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>[];
      const open = body.find((p) => p.id === "page000011");
      const locked = body.find((p) => p.id === "page000012");
      expect(open?.has_password).toBe(false);
      expect(locked?.has_password).toBe(true);
      // R19: no password material in any response body.
      expect(JSON.stringify(body)).not.toContain("pbkdf2");
      expect(JSON.stringify(body)).not.toContain("password_hash");
      expect(JSON.stringify(body)).not.toContain("$salt$hash");
      for (const page of body) {
        expect(page).not.toHaveProperty("password_hash");
        expect(page).not.toHaveProperty("password");
      }
    });
  });

  describe("handleGetPage", () => {
    it("returns a page detail with its files list", async () => {
      const deps = makeDeps();
      const pageId = "page000003";
      await insertPage(db, { id: pageId, slug: "gamma", title: "Gamma", kind: "html" });
      await insertFile(db, {
        page_id: pageId,
        path: "style.css",
        r2_key: "pages/page000003/1/style.css",
        content_type: "text/css",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000003/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 500,
      });

      const res = await handleGetPage(
        new Request(`https://pages.example.com/api/pages/${pageId}`),
        ctx,
        deps,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        id: pageId,
        slug: "gamma",
        title: "Gamma",
        kind: "html",
      });
      expect(body.files).toHaveLength(2);
      expect(body.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "index.html",
            content_type: "text/html; charset=utf-8",
            size: 500,
          }),
          expect.objectContaining({ path: "style.css", content_type: "text/css", size: 100 }),
        ]),
      );
    });

    it("returns a page detail with an empty files list when no files exist", async () => {
      const deps = makeDeps();
      const pageId = "page000004";
      await insertPage(db, { id: pageId, slug: "delta", title: "Delta" });
      const res = await handleGetPage(
        new Request(`https://pages.example.com/api/pages/${pageId}`),
        ctx,
        deps,
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.files).toEqual([]);
    });

    it("throws not_found (404) for an unknown page id", async () => {
      const deps = makeDeps();
      await expect(
        handleGetPage(new Request("https://pages.example.com/api/pages/Unknown000"), ctx, deps),
      ).rejects.toMatchObject({
        code: "not_found",
        status: 404,
      });
    });

    it("throws invalid_id (400) for an invalid page id", async () => {
      const deps = makeDeps();
      await expect(
        handleGetPage(new Request("https://pages.example.com/api/pages/bad.id"), ctx, deps),
      ).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("throws invalid_id (400) for an empty page id", async () => {
      const deps = makeDeps();
      await expect(
        handleGetPage(new Request("https://pages.example.com/api/pages/"), ctx, deps),
      ).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("S23: page detail reports has_password without leaking the hash", async () => {
      const deps = makeDeps();
      const pageId = "page000013";
      await insertPage(db, {
        id: pageId,
        slug: "locked",
        title: "Locked",
        password_hash: "pbkdf2$10000$salt$hash",
      });

      const res = await handleGetPage(
        new Request(`https://pages.example.com/api/pages/${pageId}`),
        ctx,
        deps,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.has_password).toBe(true);
      expect(body).not.toHaveProperty("password_hash");
      expect(body).not.toHaveProperty("password");
      expect(JSON.stringify(body)).not.toContain("pbkdf2");
      expect(JSON.stringify(body)).not.toContain("$salt$hash");
    });

    it("S23: page detail for an unprotected page reports has_password false", async () => {
      const deps = makeDeps();
      const pageId = "page000014";
      await insertPage(db, { id: pageId, slug: "open", title: "Open" });

      const res = await handleGetPage(
        new Request(`https://pages.example.com/api/pages/${pageId}`),
        ctx,
        deps,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.has_password).toBe(false);
      expect(body).not.toHaveProperty("password_hash");
    });
  });
});
