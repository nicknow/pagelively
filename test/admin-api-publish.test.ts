import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { handleCreatePage } from "../src/admin-api";
import { createTestCacheService } from "../src/cache-service";
import { createConfig } from "../src/config";
import { createPagesRepository, type PagesRepository } from "../src/pages-repository";
import { createFilesRepository } from "../src/files-repository";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { verifyPassword } from "../src/password";
import { createObjectStore } from "../src/object-store";
import { createSettingsRepository } from "../src/settings-repository";
import type { ObjectStore } from "../src/object-store";
import { AppError } from "../src/errors";
import {
  ACCESS_AUD,
  createMockFetch,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

// S17 — Upload & publish API (multipart + manifest + kinds).

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

async function clearFilesAndPages(db: D1Database) {
  await db.prepare("DELETE FROM files").run();
  await db.prepare("DELETE FROM pages").run();
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

async function listKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...env, ...overrides } as Env;
}

function buildAccessPayload(): object {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: TEAM_DOMAIN_URL,
    aud: [ACCESS_AUD],
    iat: now,
    exp: now + 3600,
    email: "admin@example.com",
  };
}

let privateKey: CryptoKey;

async function validToken(): Promise<string> {
  return signJwt(privateKey, "access-key-1", buildAccessPayload());
}

async function fetchApi(
  path: string,
  method: string,
  body: BodyInit | null,
  token?: string,
  customHeaders?: Record<string, string>,
): Promise<Response> {
  const headers = new Headers();
  if (token) {
    headers.set("Cf-Access-Jwt-Assertion", token);
  }
  for (const [k, v] of Object.entries(customHeaders ?? {})) {
    headers.set(k, v);
  }
  const customEnv = makeEnv({
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: ACCESS_AUD,
  });
  return worker.fetch(
    new Request(`https://pages.example.com${path}`, { method, body, headers }),
    customEnv,
    createExecutionContext(),
  );
}

function makeFile(name: string, content: string, type?: string): File {
  return new File([new TextEncoder().encode(content)], name, {
    type: type ?? "application/octet-stream",
  });
}

function createWriteFailingDb(db: D1Database): D1Database {
  const fail = async () => {
    throw new Error("simulated db write failure");
  };
  return {
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      const boundFailing = (...args: unknown[]) => {
        const bound = stmt.bind(...args);
        return {
          first: bound.first.bind(bound),
          all: bound.all.bind(bound),
          run: fail,
          raw: fail,
        } as unknown as D1PreparedStatement;
      };
      return {
        bind: boundFailing,
        first: stmt.first.bind(stmt),
        all: stmt.all.bind(stmt),
        run: fail,
        raw: fail,
      } as unknown as D1PreparedStatement;
    },
    batch: fail,
    exec: fail,
  } as unknown as D1Database;
}

function appendManifest(form: FormData, manifest: Record<string, unknown>): void {
  form.append("manifest", JSON.stringify(manifest));
}

function appendFile(form: FormData, path: string, file: File): void {
  form.append(`file:${path}`, file);
}

describe("S17 — POST /api/pages (publish)", () => {
  const db = env.DB;
  const bucket = env.BUCKET;

  beforeEach(async () => {
    await clearFilesAndPages(db);
    await clearBucket(bucket);
    const keys = await generateKeyPair("access-key-1");
    privateKey = keys.privateKey;
    const mock = createMockFetch({ keys: [keys.jwk] });
    vi.stubGlobal("fetch", mock.fetchFn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("single HTML upload creates an html page, 201, correct R2 keys and D1 rows", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { title: "Hello Page", slug: "hello-page" });
    appendFile(
      form,
      "index.html",
      makeFile(
        "index.html",
        "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>",
        "text/html",
      ),
    );

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("html");
    expect(body.slug).toBe("hello-page");
    expect(body.title).toBe("Hello Page");
    expect(body.entry_path).toBe("index.html");
    expect(body.raw_md_path).toBeNull();
    expect(body.rev).toBe(1);
    expect(body.files).toHaveLength(1);
    expect((body.files as Record<string, unknown>[])[0]).toMatchObject({
      path: "index.html",
      content_type: "text/html; charset=utf-8",
    });

    const pageId = body.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual([`pages/${pageId}/1/index.html`]);
    const obj = await bucket.get(`pages/${pageId}/1/index.html`);
    expect(obj).not.toBeNull();
    expect(await new Response(obj!.body).text()).toContain("<h1>Hi</h1>");
    expect(obj!.httpMetadata).toMatchObject({
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    });

    const row = await db
      .prepare("SELECT * FROM pages WHERE id = ?")
      .bind(pageId)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      id: pageId,
      slug: "hello-page",
      title: "Hello Page",
      kind: "html",
      rev: 1,
      entry_path: "index.html",
      raw_md_path: null,
      show_source: 0,
      visibility: "public",
    });
  });

  it("single Markdown upload creates a markdown page with raw and rendered files and showSource", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { showSource: true });
    appendFile(form, "notes.md", makeFile("notes.md", "# Hello\n\nWorld.", "text/markdown"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("markdown");
    expect(body.slug).toBe("notes");
    expect(body.title).toBe("notes");
    expect(body.entry_path).toBe("index.html");
    expect(body.raw_md_path).toBe("source.md");
    expect(body.show_source).toBe(1);

    const pageId = body.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual(
      expect.arrayContaining([`pages/${pageId}/1/index.html`, `pages/${pageId}/1/source.md`]),
    );
    const htmlObj = await bucket.get(`pages/${pageId}/1/index.html`);
    const html = await new Response(htmlObj!.body).text();
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("View source");
    const mdObj = await bucket.get(`pages/${pageId}/1/source.md`);
    expect(mdObj).not.toBeNull();
    expect(await new Response(mdObj!.body).text()).toBe("# Hello\n\nWorld.");

    const files = (
      await db
        .prepare("SELECT * FROM files WHERE page_id = ?")
        .bind(pageId)
        .all<Record<string, unknown>>()
    ).results;
    expect(files).toHaveLength(2);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "index.html", content_type: "text/html; charset=utf-8" }),
        expect.objectContaining({ path: "source.md", content_type: "text/markdown" }),
      ]),
    );
  });

  it("single image upload creates an image page with the original filename as entry", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { title: "My Photo" });
    appendFile(form, "photo.jpg", makeFile("photo.jpg", "JPEG", "image/jpeg"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("image");
    expect(body.entry_path).toBe("photo.jpg");
    expect(body.raw_md_path).toBeNull();

    const pageId = body.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual([`pages/${pageId}/1/photo.jpg`]);
    const obj = await bucket.get(`pages/${pageId}/1/photo.jpg`);
    expect(obj).not.toBeNull();
    expect(obj!.httpMetadata).toMatchObject({ contentType: "image/jpeg" });
  });

  it("bundle upload with multiple files and manifest entry creates a bundle page", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { entry: "site/index.html", slug: "bundle-site", title: "Bundle Site" });
    appendFile(
      form,
      "site/index.html",
      makeFile(
        "index.html",
        '<!doctype html><html><body><img src="images/pic.png"></body></html>',
        "text/html",
      ),
    );
    appendFile(form, "site/about.html", makeFile("about.html", "<h1>About</h1>", "text/html"));
    appendFile(form, "site/images/pic.png", makeFile("pic.png", "PNG", "image/png"));
    appendFile(form, "site/style.css", makeFile("style.css", "body{}", "text/css"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("bundle");
    expect(body.entry_path).toBe("site/index.html");
    expect(body.slug).toBe("bundle-site");

    const pageId = body.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual(
      expect.arrayContaining([
        `pages/${pageId}/1/site/about.html`,
        `pages/${pageId}/1/site/images/pic.png`,
        `pages/${pageId}/1/site/index.html`,
        `pages/${pageId}/1/site/style.css`,
      ]),
    );
    const files = (
      await db
        .prepare("SELECT * FROM files WHERE page_id = ? ORDER BY path")
        .bind(pageId)
        .all<Record<string, unknown>>()
    ).results;
    expect(files).toHaveLength(4);
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "site/about.html",
        "site/images/pic.png",
        "site/index.html",
        "site/style.css",
      ]),
    );
  });

  it("auto-generates slug from filename when slug is not provided", async () => {
    const token = await validToken();
    const form = new FormData();
    appendFile(
      form,
      "My Great Post.html",
      makeFile("My Great Post.html", "<h1>Great</h1>", "text/html"),
    );

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe("my-great-post");
  });

  it("uses deterministic -2 suffix when auto-generated slug is already taken", async () => {
    const token = await validToken();
    await insertPage(db, { id: "existing00", slug: "my-post", title: "Existing" });

    const form = new FormData();
    appendFile(form, "My Post.html", makeFile("My Post.html", "<h1>Post</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe("my-post-2");
  });

  it("rejects reserved slugs with 400", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "admin" });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_slug",
      message: '"admin" is a reserved name and cannot be used as a slug.',
    });
  });

  it("cleans a user-entered slug, stores it, and serves the page at the cleaned slug (AC 12)", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { title: "My Post", slug: "  My Post " });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe("my-post");

    const row = await db
      .prepare("SELECT slug FROM pages WHERE id = ?")
      .bind(body.id as string)
      .first<{ slug: string }>();
    expect(row?.slug).toBe("my-post");

    // the page is served at the cleaned slug
    const pageRes = await worker.fetch(
      new Request("https://pages.example.com/my-post/"),
      env,
      createExecutionContext(),
    );
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain("<h1>X</h1>");
  });

  it("rejects a raw reserved slug intact with an actionable message and stores nothing (AC 13)", async () => {
    const token = await validToken();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    const form = new FormData();
    appendManifest(form, { slug: "favicon.ico" });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_slug",
      message: '"favicon.ico" is a reserved name and cannot be used as a slug.',
    });
    const after = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(await listKeys(bucket, "pages/")).toEqual([]);
  });

  it("rejects a case-variant of a reserved name (AC 13: ' ADMIN ')", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: " ADMIN " });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_slug",
      message: '"admin" is a reserved name and cannot be used as a slug.',
    });
  });

  it("truncates an over-long user slug to 64 characters at the API", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "a".repeat(65) });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe("a".repeat(64));
  });

  it("treats a whitespace-only slug as not provided and auto-generates from the title", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { title: "Whitespace Slug", slug: "   " });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe("whitespace-slug");
  });

  it("rejects invalid file paths like ../", async () => {
    const token = await validToken();
    const form = new FormData();
    appendFile(form, "../etc/passwd", makeFile("passwd", "secret", "text/plain"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "path_traversal",
      message: 'Path traversal is not allowed: "../etc/passwd".',
    });
  });

  it("rejects paths containing absolute leading slash", async () => {
    const token = await validToken();
    const form = new FormData();
    appendFile(form, "/etc/passwd", makeFile("passwd", "secret", "text/plain"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "path_traversal",
      message: 'Absolute file paths are not allowed: "/etc/passwd".',
    });
  });

  it("rejects percent sign in filenames", async () => {
    const token = await validToken();
    const form = new FormData();
    appendFile(form, "bad%file.html", makeFile("bad%file.html", "<h1>Bad</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_filename",
      message: 'Percent signs are not allowed in filenames: "bad%file.html".',
    });
  });

  it("strips leading UTF-8 BOM from markdown source before rendering", async () => {
    const token = await validToken();
    const form = new FormData();
    const md = "\uFEFF# Bommed\n\nText.";
    appendFile(form, "bommed.md", makeFile("bommed.md", md, "text/markdown"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    const pageId = body.id as string;
    const htmlObj = await bucket.get(`pages/${pageId}/1/index.html`);
    const html = await new Response(htmlObj!.body).text();
    expect(html).toContain("<h1>Bommed</h1>");
    expect(html).not.toContain("\uFEFF");
  });

  it("returns 400 when no files are uploaded", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "empty" });

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_files", message: "No files were uploaded." });
  });

  it("returns 400 when entry is ambiguous and manifest.entry is missing", async () => {
    const token = await validToken();
    const form = new FormData();
    appendFile(form, "index.html", makeFile("index.html", "<h1>One</h1>", "text/html"));
    appendFile(form, "about.html", makeFile("about.html", "<h1>Two</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "ambiguous_entry",
      message: "Entry is ambiguous. Provide manifest.entry.",
    });
  });

  it("returns 413 when the Content-Length header exceeds ~95 MB", async () => {
    const token = await validToken();
    const form = new FormData();
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi(
      "/api/pages",
      "POST",
      form,
      token,
      { "Content-Length": "99614721" }, // 95 MB + 1 byte
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "request_too_large",
      message: "Request body exceeds the ~95 MB upload limit.",
    });
  });

  it("returns 403 when unauthenticated", async () => {
    const form = new FormData();
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, undefined);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("rolls back R2 objects when D1 fails after writes", async () => {
    const token = await validToken();
    const brokenDb = createWriteFailingDb(db);
    const brokenEnv = makeEnv({
      DB: brokenDb,
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD: ACCESS_AUD,
    });

    const form = new FormData();
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await worker.fetch(
      new Request("https://pages.example.com/api/pages", {
        method: "POST",
        body: form,
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      brokenEnv,
      createExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "db_write_failed",
      message: "Database write failed.",
    });
    const keys = await listKeys(bucket, "pages/");
    expect(keys).toEqual([]);
  });

  it("returns 409 when a user-provided slug is already taken", async () => {
    const token = await validToken();
    await insertPage(db, { id: "existing01", slug: "custom", title: "Existing" });

    const form = new FormData();
    appendManifest(form, { slug: "custom" });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "slug_conflict",
      message: 'Slug "custom" is already taken.',
    });
  });

  it("returns 201 with a generated slug when user-provided slug is empty", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "" });
    appendFile(form, "auto.html", makeFile("auto.html", "<h1>Auto</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe("auto");
  });

  it("returns 400 for invalid visibility values", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { visibility: "super-public" });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_visibility",
      message: "Visibility must be 'public' or 'unlisted'.",
    });
  });

  it("returns 400 for a title that is too long", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { title: "x".repeat(300) });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "title_too_long",
      message: "Title must be at most 256 characters.",
    });
  });

  it("returns 400 when the manifest entry does not match an uploaded file", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { entry: "missing.html" });
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_entry",
      message: 'Manifest entry "missing.html" does not match any uploaded file.',
    });
  });

  it("returns 400 when the auto-derived title from the filename exceeds 256 characters", async () => {
    const token = await validToken();
    const form = new FormData();
    const longName = "a".repeat(257) + ".html";
    appendFile(form, longName, makeFile(longName, "<h1>X</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "title_too_long",
      message: "Title must be at most 256 characters.",
    });
  });

  it("renders a bundle whose manifest entry is a markdown file", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, {
      entry: "site/index.md",
      slug: "bundle-md",
      title: "Bundle MD",
    });
    appendFile(form, "site/index.md", makeFile("index.md", "# Hello Bundle", "text/markdown"));
    appendFile(form, "site/about.md", makeFile("about.md", "## About", "text/markdown"));
    appendFile(form, "site/style.css", makeFile("style.css", "body{}", "text/css"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("bundle");
    // The rendered entry is stored as index.html (see buildR2Files), so
    // entry_path must point there too — not at the original upload path,
    // which is never written to R2 under that name (regression: publishing
    // a multi-file upload with a Markdown entry served a 404 on the link).
    expect(body.entry_path).toBe("index.html");
    expect(body.raw_md_path).toBe("source.md");
    expect(body.slug).toBe("bundle-md");

    const pageId = body.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual(
      expect.arrayContaining([
        `pages/${pageId}/1/source.md`,
        `pages/${pageId}/1/index.html`,
        `pages/${pageId}/1/site/about.md`,
        `pages/${pageId}/1/site/style.css`,
      ]),
    );
    // The entry markdown is stored as the canonical source.md, not at its
    // original relative path.
    expect(keys).not.toContain(`pages/${pageId}/1/site/index.md`);

    const htmlObj = await bucket.get(`pages/${pageId}/1/index.html`);
    const html = await new Response(htmlObj!.body).text();
    expect(html).toContain("<h1>Hello Bundle</h1>");

    const mdObj = await bucket.get(`pages/${pageId}/1/source.md`);
    expect(await new Response(mdObj!.body).text()).toBe("# Hello Bundle");

    // Regression: browsing to the published link must serve the page, not 404.
    const publicRes = await worker.fetch(
      new Request("https://pages.example.com/bundle-md/"),
      makeEnv(),
      createExecutionContext(),
    );
    expect(publicRes.status).toBe(200);
    const publicHtml = await publicRes.text();
    expect(publicHtml).toContain("<h1>Hello Bundle</h1>");
    expect(publicHtml).toContain(
      `<base href="https://cdn.example.com/pages/${pageId}/1/index.html">`,
    );
  });

  // Independent validator regression test (not from the implementer): a bundle
  // whose entry is one of SEVERAL markdown documents. Guards against a narrower
  // fix that only handles the single-md-file case — the non-entry .md file must
  // stay a plain asset at its original path (not rendered, not moved to
  // index.html/source.md), while only the manifest-selected entry gets the
  // index.html/source.md treatment and the corrected entry_path.
  it("renders only the manifest entry when a bundle has multiple markdown documents", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, {
      entry: "docs/intro.md",
      slug: "bundle-multi-md",
      title: "Bundle Multi MD",
    });
    appendFile(form, "docs/intro.md", makeFile("intro.md", "# Intro", "text/markdown"));
    appendFile(form, "docs/appendix.md", makeFile("appendix.md", "# Appendix", "text/markdown"));
    appendFile(form, "docs/style.css", makeFile("style.css", "body{}", "text/css"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("bundle");
    expect(body.entry_path).toBe("index.html");
    expect(body.raw_md_path).toBe("source.md");

    const pageId = body.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual(
      expect.arrayContaining([
        `pages/${pageId}/1/source.md`,
        `pages/${pageId}/1/index.html`,
        `pages/${pageId}/1/docs/appendix.md`,
        `pages/${pageId}/1/docs/style.css`,
      ]),
    );
    // The entry's original path is not written; the non-entry markdown file
    // IS written at its original path, unrendered.
    expect(keys).not.toContain(`pages/${pageId}/1/docs/intro.md`);

    const htmlObj = await bucket.get(`pages/${pageId}/1/index.html`);
    expect(await new Response(htmlObj!.body).text()).toContain("<h1>Intro</h1>");

    const mdObj = await bucket.get(`pages/${pageId}/1/source.md`);
    expect(await new Response(mdObj!.body).text()).toBe("# Intro");

    // The other markdown document is stored verbatim, not rendered.
    const appendixObj = await bucket.get(`pages/${pageId}/1/docs/appendix.md`);
    expect(await new Response(appendixObj!.body).text()).toBe("# Appendix");

    const publicRes = await worker.fetch(
      new Request("https://pages.example.com/bundle-multi-md/"),
      makeEnv(),
      createExecutionContext(),
    );
    expect(publicRes.status).toBe(200);
    const publicHtml = await publicRes.text();
    expect(publicHtml).toContain("<h1>Intro</h1>");
  });

  it("falls back to the generated id when the filename slugifies to a reserved name", async () => {
    const token = await validToken();
    const form = new FormData();
    appendFile(form, "admin.html", makeFile("admin.html", "<h1>Admin</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe(body.id);
    expect(body.title).toBe("admin");
  });

  it("falls back to the generated id when the filename slugifies to empty", async () => {
    const token = await validToken();
    const form = new FormData();
    appendFile(form, "中文.html", makeFile("中文.html", "<h1>中文</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe(body.id);
    expect(body.title).toBe("中文");
  });

  it("creates a bundle when an image is uploaded with other assets", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { entry: "photo.jpg" });
    appendFile(form, "photo.jpg", makeFile("photo.jpg", "JPEG", "image/jpeg"));
    appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("bundle");
    expect(body.entry_path).toBe("photo.jpg");
    expect(body.raw_md_path).toBeNull();

    const pageId = body.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual(
      expect.arrayContaining([`pages/${pageId}/1/photo.jpg`, `pages/${pageId}/1/style.css`]),
    );
  });

  it("S23: multipart manifest.password creates a protected page — has_password true, hash stored, never leaked", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "protected-upload", password: "s3cret-word" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>Secret</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(true);
    // R19: the hash and the raw password never appear in any response surface.
    expect(body).not.toHaveProperty("password_hash");
    expect(body).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain("pbkdf2");
    expect(JSON.stringify(body)).not.toContain("s3cret-word");

    const pageId = body.id as string;
    const row = await db
      .prepare("SELECT password_hash FROM pages WHERE id = ?")
      .bind(pageId)
      .first<{ password_hash: string | null }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$10000\$/);
    expect(row?.password_hash).not.toBe("s3cret-word");
    expect(await verifyPassword("s3cret-word", row!.password_hash!)).toBe(true);
    expect(await verifyPassword("wrong-password", row!.password_hash!)).toBe(false);
  });

  it("S23: create without a password stores password_hash NULL and reports has_password false", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "open-upload" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>Open</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(false);
    expect(body).not.toHaveProperty("password_hash");
    expect(JSON.stringify(body)).not.toContain("pbkdf2");

    const row = await db
      .prepare("SELECT password_hash FROM pages WHERE id = ?")
      .bind(body.id as string)
      .first<{ password_hash: string | null }>();
    expect(row?.password_hash).toBeNull();
  });

  it("S23: a whitespace-only password is treated as unprotected on create", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "blank-upload", password: "   " });
    appendFile(form, "index.html", makeFile("index.html", "<h1>Open</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(false);

    const row = await db
      .prepare("SELECT password_hash FROM pages WHERE id = ?")
      .bind(body.id as string)
      .first<{ password_hash: string | null }>();
    expect(row?.password_hash).toBeNull();
  });

  it("S23: a too-short password returns 400 invalid_password and stores nothing", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "short-pw", password: "1234" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>Secret</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_password",
      message: "Password must be at least 5 characters.",
    });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(await listKeys(bucket, "pages/")).toEqual([]);
  });

  it("S23: a too-long password returns 400 invalid_password and stores nothing", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "long-pw", password: "x".repeat(257) });
    appendFile(form, "index.html", makeFile("index.html", "<h1>Secret</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_password",
      message: "Password must be at most 256 characters.",
    });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(await listKeys(bucket, "pages/")).toEqual([]);
  });

  describe("handleCreatePage direct handler tests", () => {
    const ctx = createExecutionContext();

    function makeAdminDeps(objectStore: ObjectStore) {
      const pagesRepository = createPagesRepository(env.DB);
      const filesRepository = createFilesRepository(env.DB);
      const cacheService = createTestCacheService();
      const config = createConfig({
        ...env,
        SITE_NAME: "Test",
        ASSET_BASE_URL: "https://cdn.example.com",
        HOME_MODE: "404",
        HOME_PAGE_SLUG: "",
        ALLOW_RAW_HTML_IN_MD: "true",
        ACCESS_TEAM_DOMAIN: "",
        ACCESS_AUD: "",
      } as unknown as Env);
      return {
        pagesRepository,
        filesRepository,
        objectStore,
        cacheService,
        config,
        verifiedIdentity: { email: "admin@example.com" },
        unlocks: createUnlocksRepository(env.DB),
        settingsRepository: createSettingsRepository(env.DB),
      };
    }

    it("re-throws the object_write_failed error after rolling back R2 objects", async () => {
      const objectStore = createObjectStore(env.BUCKET);
      const failingObjectStore: ObjectStore = {
        ...objectStore,
        async put(pageId, rev, path, body, contentType) {
          void pageId;
          void rev;
          void path;
          void body;
          void contentType;
          throw new AppError("object_write_failed", 500, "Object write failed.");
        },
      };
      const form = new FormData();
      appendManifest(form, { slug: "r2-throw", entry: "a.html" });
      appendFile(form, "a.html", makeFile("a.html", "<h1>A</h1>", "text/html"));
      const request = new Request("https://pages.example.com/api/pages", {
        method: "POST",
        body: form,
      });
      const deps = makeAdminDeps(failingObjectStore);

      await expect(handleCreatePage(request, ctx, deps)).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });

      const keys = await listKeys(env.BUCKET, "pages/");
      expect(keys).toEqual([]);
    });

    it("falls back to the id when every auto-slug suffix is taken", async () => {
      const pagesRepository = createPagesRepository(env.DB);
      const filesRepository = createFilesRepository(env.DB);
      const objectStore = createObjectStore(env.BUCKET);
      const cacheService = createTestCacheService();
      const config = createConfig({
        ...env,
        SITE_NAME: "Test",
        ASSET_BASE_URL: "https://cdn.example.com",
        HOME_MODE: "404",
        HOME_PAGE_SLUG: "",
        ALLOW_RAW_HTML_IN_MD: "true",
        ACCESS_TEAM_DOMAIN: "",
        ACCESS_AUD: "",
      } as unknown as Env);
      const deps = {
        pagesRepository: {
          ...pagesRepository,
          async slugTaken() {
            return true;
          },
        } as PagesRepository,
        filesRepository,
        objectStore,
        cacheService,
        config,
        verifiedIdentity: { email: "admin@example.com" },
        unlocks: createUnlocksRepository(env.DB),
      };
      const form = new FormData();
      appendFile(form, "test.html", makeFile("test.html", "<h1>Test</h1>", "text/html"));
      const request = new Request("https://pages.example.com/api/pages", {
        method: "POST",
        body: form,
      });

      const res = await handleCreatePage(request, ctx, deps);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.slug).toBe(body.id);
    });

    function createPutFailingBucket(bucket: R2Bucket, failAfter: number): R2Bucket {
      let calls = 0;
      const bucketRecord = bucket as unknown as Record<string, unknown>;
      const wrapper: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(bucketRecord) as string[]) {
        const value = bucketRecord[key];
        if (key === "put" && typeof value === "function") {
          wrapper[key] = async (...args: unknown[]) => {
            calls += 1;
            if (calls > failAfter) {
              throw new Error("simulated R2 write failure");
            }
            return value.apply(bucket, args);
          };
        } else {
          wrapper[key] = typeof value === "function" ? value.bind(bucket) : value;
        }
      }
      return wrapper as unknown as R2Bucket;
    }

    function makeAdminDepsWithFailingBucket(failingBucket: R2Bucket) {
      const objectStore = createObjectStore(failingBucket);
      return makeAdminDeps(objectStore);
    }

    it("rolls back R2 objects when the first R2 put fails", async () => {
      const form = new FormData();
      appendManifest(form, { slug: "r2-rollback", entry: "a.html" });
      appendFile(form, "a.html", makeFile("a.html", "<h1>A</h1>", "text/html"));
      appendFile(form, "b.html", makeFile("b.html", "<h1>B</h1>", "text/html"));
      const request = new Request("https://pages.example.com/api/pages", {
        method: "POST",
        body: form,
      });
      const failingBucket = createPutFailingBucket(env.BUCKET, 0);
      const deps = makeAdminDepsWithFailingBucket(failingBucket);

      await expect(handleCreatePage(request, ctx, deps)).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });

      // No objects should be left from the failed page.
      const keys = await listKeys(env.BUCKET, "pages/");
      expect(keys).toEqual([]);
    });

    it("rolls back R2 objects when a later R2 put fails", async () => {
      const form = new FormData();
      appendManifest(form, { slug: "r2-rollback-later", entry: "a.html" });
      appendFile(form, "a.html", makeFile("a.html", "<h1>A</h1>", "text/html"));
      appendFile(form, "b.html", makeFile("b.html", "<h1>B</h1>", "text/html"));
      const request = new Request("https://pages.example.com/api/pages", {
        method: "POST",
        body: form,
      });
      const failingBucket = createPutFailingBucket(env.BUCKET, 1);
      const deps = makeAdminDepsWithFailingBucket(failingBucket);

      await expect(handleCreatePage(request, ctx, deps)).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });

      const keys = await listKeys(env.BUCKET, "pages/");
      expect(keys).toEqual([]);
    });
  });
});
