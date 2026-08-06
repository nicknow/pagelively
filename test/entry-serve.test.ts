import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createPagesRepository } from "../src/pages-repository";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { createObjectStore } from "../src/object-store";
import { createCacheService } from "../src/cache-service";
import { createConfig, type AppConfig } from "../src/config";
import { serveEntry, type EntryServeDependencies } from "../src/entry-serve";
import { AppError } from "../src/errors";
import { hashPassword } from "../src/password";
import { generateToken, hashToken, formatUnlockCookie } from "../src/password-token";

// S12 — Entry request pipeline (public serving). These tests exercise the
// real D1 + R2 emulation through serveEntry before it is wired into index.ts.

const TEST_CONFIG: AppConfig = {
  siteName: "Pagelively",
  assetBaseUrl: "https://cdn.example.com",
  homeMode: "404",
  homePageSlug: null,
  allowRawHtmlInMd: true,
  access: {
    teamDomainUrl: "https://yourteam.cloudflareaccess.com",
    aud: null,
  },
};

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
    match_tags?: string | null;
    created_at?: string;
    updated_at?: string;
  },
) {
  await db
    .prepare(
      `INSERT INTO pages (id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, match_tags, created_at, updated_at)
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
      p.match_tags === undefined ? null : p.match_tags,
      p.created_at ?? isoNow(),
      p.updated_at ?? isoNow(),
    )
    .run();
}

async function clearPages(db: D1Database) {
  await db.prepare("DELETE FROM page_tags").run();
  await db.prepare("DELETE FROM pages").run();
  await db.prepare("DELETE FROM files").run();
  await db.prepare("DELETE FROM page_unlocks").run();
}

async function clearBucket(bucket: R2Bucket) {
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ cursor, limit: 1000 });
    const keys = list.objects.map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

function makeDeps(): EntryServeDependencies {
  const config = createConfig(env);
  return {
    config: { ...config, ...TEST_CONFIG },
    pages: createPagesRepository(env.DB),
    unlocks: createUnlocksRepository(env.DB),
    objects: createObjectStore(env.BUCKET),
    cache: createCacheService(env),
  };
}

describe("serveEntry", () => {
  const db = env.DB;
  const bucket = env.BUCKET;
  const objects = createObjectStore(bucket);

  beforeEach(async () => {
    await clearPages(db);
    await clearBucket(bucket);
  });

  it("serves an html page with injected base tag and entry cache headers", async () => {
    await insertPage(db, { id: "page000001", slug: "hello", kind: "html" });
    await objects.put(
      "page000001",
      1,
      "index.html",
      "<!doctype html><html><head><title>Hello</title></head><body><h1>Hello</h1></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await serveEntry(new Request("https://pages.example.com/hello/"), makeDeps());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(res.headers.get("Cache-Tag")).toBe("page-page000001");

    const text = await res.text();
    expect(text).toContain("<h1>Hello</h1>");
    expect(text).toContain('<base href="https://cdn.example.com/pages/page000001/1/index.html">');
  });

  it("serves a page by id under /p/{id}/", async () => {
    await insertPage(db, { id: "page000002", slug: null, kind: "html" });
    await objects.put(
      "page000002",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><p>By id</p></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await serveEntry(
      new Request("https://pages.example.com/p/page000002/"),
      makeDeps(),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<p>By id</p>");
    expect(text).toContain('<base href="https://cdn.example.com/pages/page000002/1/index.html">');
    expect(res.headers.get("Cache-Tag")).toBe("page-page000002");
  });

  it("301-redirects an image page to the CDN object", async () => {
    await insertPage(db, {
      id: "page000003",
      slug: "pic",
      kind: "image",
      entry_path: "photo.jpg",
      rev: 2,
    });

    const res = await serveEntry(new Request("https://pages.example.com/pic/"), makeDeps());

    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(
      "https://cdn.example.com/pages/page000003/2/photo.jpg",
    );
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(res.headers.get("Cache-Tag")).toBe("page-page000003");
  });

  it("serves a markdown page (stored as rendered html) with injected base", async () => {
    await insertPage(db, {
      id: "page000004",
      slug: "notes",
      kind: "markdown",
      entry_path: "index.html",
      raw_md_path: "source.md",
    });
    await objects.put(
      "page000004",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><main><h1>Notes</h1></main></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await serveEntry(new Request("https://pages.example.com/notes/"), makeDeps());

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<h1>Notes</h1>");
    expect(text).toContain('<base href="https://cdn.example.com/pages/page000004/1/index.html">');
  });

  it("serves a bundle page the same way as html", async () => {
    await insertPage(db, { id: "page000005", slug: "bundle", kind: "bundle" });
    await objects.put(
      "page000005",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><p>Bundle</p></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await serveEntry(new Request("https://pages.example.com/bundle/"), makeDeps());

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<p>Bundle</p>");
    expect(text).toContain('<base href="https://cdn.example.com/pages/page000005/1/index.html">');
  });

  it("returns a clean 404 for an unknown slug", async () => {
    const res = await serveEntry(new Request("https://pages.example.com/unknown/"), makeDeps());

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("Not Found");
    expect(text).toContain("<code>/unknown/</code>");
  });

  it("returns a clean 404 for an unknown id", async () => {
    const res = await serveEntry(new Request("https://pages.example.com/p/NoSuchId0/"), makeDeps());

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns a clean 404 when the entry object is missing", async () => {
    await insertPage(db, { id: "page000006", slug: "missing", kind: "markdown" });

    const res = await serveEntry(new Request("https://pages.example.com/missing/"), makeDeps());

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns a clean 404 for non-slug/id routes passed directly to serveEntry", async () => {
    const res = await serveEntry(new Request("https://pages.example.com/admin/pages"), makeDeps());

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns a generic 500 on unexpected errors without leaking stack", async () => {
    const deps = makeDeps();
    const brokenDeps = {
      ...deps,
      pages: {
        getBySlug: () => Promise.reject("simulated unexpected failure"),
        getById: () => Promise.reject("simulated unexpected failure"),
        list: () => Promise.resolve([]),
      },
    };

    const res = await serveEntry(new Request("https://pages.example.com/hello/"), brokenDeps);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("internal_error");
    expect(text.toLowerCase()).not.toContain("stack");
    expect(text.toLowerCase()).not.toContain("trace");
  });

  it("re-throws AppError from the repository", async () => {
    const deps = makeDeps();
    const appError = new AppError("invalid_slug", 400, "Bad slug");
    const brokenDeps = {
      ...deps,
      pages: {
        getBySlug: () => Promise.reject(appError),
        getById: () => Promise.reject(appError),
        list: () => Promise.resolve([]),
      },
    };

    await expect(
      serveEntry(new Request("https://pages.example.com/hello/"), brokenDeps),
    ).rejects.toBe(appError);
  });

  it("invalid id format propagates the AppError from the repository", async () => {
    await insertPage(db, { id: "page000007", slug: "safe", kind: "html" });
    const deps = makeDeps();

    await expect(
      serveEntry(new Request("https://pages.example.com/p/bad.id/"), deps),
    ).rejects.toMatchObject({ code: "invalid_id", status: 400 });
  });

  // --- S23 public gate (ADR 0041 decisions 3 & 7) ---

  async function seedProtected(id: string, slug: string, password: string): Promise<void> {
    await insertPage(db, { id, slug, kind: "html" });
    await createPagesRepository(db).setPasswordHash(id, await hashPassword(password));
  }

  it("returns the password prompt (200) for a protected page without touching R2", async () => {
    await seedProtected("page000008", "locked", "secret1");

    const res = await serveEntry(new Request("https://pages.example.com/locked/"), makeDeps());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    const text = await res.text();
    expect(text).toContain("This page is password protected.");
    expect(text).toContain('action="/p/page000008/unlock"');
    // No entry content, no title, no CDN base href ever leaks.
    expect(text).not.toContain("cdn.example.com");
  });

  it("returns the prompt for a protected image page instead of the CDN 301", async () => {
    await insertPage(db, {
      id: "page000009",
      slug: "pict",
      kind: "image",
      entry_path: "photo.jpg",
    });
    await createPagesRepository(db).setPasswordHash("page000009", await hashPassword("secret1"));

    const res = await serveEntry(new Request("https://pages.example.com/pict/"), makeDeps());

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toContain("This page is password protected.");
  });

  it("serves the unlocked entry (no-store, Worker-origin base href) for a valid cookie", async () => {
    await seedProtected("page000008", "locked", "secret1");
    await objects.put(
      "page000008",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><p>Unlocked</p></body></html>",
      "text/html; charset=utf-8",
    );
    const token = generateToken();
    await createUnlocksRepository(db).create("page000008", await hashToken(token));

    const res = await serveEntry(
      new Request("https://pages.example.com/locked/", {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("page000008", token)}` },
      }),
      makeDeps(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    const text = await res.text();
    expect(text).toContain("<p>Unlocked</p>");
    expect(text).toContain(
      '<base href="https://pages.example.com/assets/pages/page000008/1/index.html">',
    );
    expect(text).not.toContain("cdn.example.com");
    expect(text).not.toContain("password protected");
  });

  it("shows the prompt for a wrong or stale cookie", async () => {
    await seedProtected("page000008", "locked", "secret1");
    await objects.put(
      "page000008",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><p>Unlocked</p></body></html>",
      "text/html; charset=utf-8",
    );
    const staleToken = generateToken(); // no unlock row exists

    const res = await serveEntry(
      new Request("https://pages.example.com/locked/", {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("page000008", staleToken)}` },
      }),
      makeDeps(),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("This page is password protected.");
  });

  it("serves an unlocked page by id with the Worker-origin base href", async () => {
    await insertPage(db, { id: "page000010", slug: null, kind: "html", rev: 2 });
    await createPagesRepository(db).setPasswordHash("page000010", await hashPassword("secret1"));
    await objects.put(
      "page000010",
      2,
      "index.html",
      "<!doctype html><html><head></head><body><p>By id unlocked</p></body></html>",
      "text/html; charset=utf-8",
    );
    const token = generateToken();
    await createUnlocksRepository(db).create("page000010", await hashToken(token));

    const res = await serveEntry(
      new Request("https://pages.example.com/p/page000010/", {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("page000010", token)}` },
      }),
      makeDeps(),
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<p>By id unlocked</p>");
    expect(text).toContain(
      '<base href="https://pages.example.com/assets/pages/page000010/2/index.html">',
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // ── Listing page serving ───────────────────────────────────────────────

  it("serves a listing page with matching public pages when no R2 objects exist", async () => {
    const { createTagsRepository } = await import("../src/tags-repository");
    const tagsRepo = createTagsRepository(env.DB);

    // Create the listing page with match_tags
    await insertPage(db, {
      id: "page00list",
      slug: "my-list",
      title: "My Listing",
      kind: "listing",
      visibility: "public",
      match_tags: "blog,tech",
    });

    // Create pages with matching tags
    await insertPage(db, {
      id: "page00post1",
      slug: "post-one",
      title: "Post One",
      kind: "html",
      visibility: "public",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    });
    await insertPage(db, {
      id: "page00post2",
      slug: "post-two",
      title: "Post Two",
      kind: "html",
      visibility: "public",
      created_at: "2026-06-02T00:00:00.000Z",
      updated_at: "2026-06-02T00:00:00.000Z",
    });
    // An unlisted page with matching tag — should NOT appear
    await insertPage(db, {
      id: "page00post3",
      slug: "post-three",
      title: "Post Three",
      kind: "html",
      visibility: "unlisted",
      created_at: "2026-06-03T00:00:00.000Z",
      updated_at: "2026-06-03T00:00:00.000Z",
    });

    // Assign tags — Post One and Post Two have ALL required tags (blog + tech)
    // Post Three missing tech — should NOT match
    await tagsRepo.setForPage("page00post1", ["blog", "tech"]);
    await tagsRepo.setForPage("page00post2", ["blog", "tech"]);
    await tagsRepo.setForPage("page00post3", ["blog"]);

    // Verify data is correctly set up
    const listingPage = await createPagesRepository(env.DB).getBySlug("my-list");
    expect(listingPage).not.toBeNull();
    expect(listingPage!.kind).toBe("listing");
    expect(listingPage!.match_tags).toBe("blog,tech");

    const matchingIds = await tagsRepo.findPagesByTags(["blog", "tech"]);
    expect(matchingIds).toContain("page00post1");
    expect(matchingIds).toContain("page00post2");

    const allPgs = await createPagesRepository(env.DB).list();
    expect(allPgs.length).toBeGreaterThanOrEqual(4);

    const deps = {
      ...makeDeps(),
      tagsRepository: tagsRepo,
    };

    const res = await serveEntry(new Request("https://pages.example.com/my-list/"), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    // Should contain matching public pages
    expect(text).toContain("Post One");
    expect(text).toContain("Post Two");
    expect(text).toContain("/post-one/");
    expect(text).toContain("/post-two/");
    // Should NOT contain unlisted page
    expect(text).not.toContain("Post Three");
    // Should NOT contain the listing page's slug (it's filtered out from the list)
    expect(text).not.toContain("/my-list/");
    // Should show title
    expect(text).toContain("My Listing");
    // Tag badges should appear
    expect(text).toContain("blog");
    expect(text).toContain("tech");
  });

  it("serves an empty listing page (no matching posts) when no tagged pages exist", async () => {
    const { createTagsRepository } = await import("../src/tags-repository");
    const tagsRepo = createTagsRepository(env.DB);

    await insertPage(db, {
      id: "page00emptylist",
      slug: "empty-list",
      title: "Empty List",
      kind: "listing",
      visibility: "public",
      match_tags: "nonexistent-tag",
    });

    const deps = {
      ...makeDeps(),
      tagsRepository: tagsRepo,
    };

    const res = await serveEntry(new Request("https://pages.example.com/empty-list/"), deps);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("No matching pages yet");
    expect(text).toContain("Empty List");
  });
});
