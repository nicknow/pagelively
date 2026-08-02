import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { createObjectStore } from "../src/object-store";
import {
  ACCESS_AUD,
  createMockFetch,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

// S12 — Entry request pipeline wired in src/index.ts. These tests run the real
// Worker handler end-to-end against the local D1 + R2 emulation.

const isoNow = () => new Date().toISOString();
const objects = createObjectStore(env.BUCKET);

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

async function clearPages(db: D1Database) {
  await db.prepare("DELETE FROM pages").run();
  await db.prepare("DELETE FROM files").run();
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

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...env, ...overrides } as Env;
}

async function fetchIndex(path: string, customEnv?: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const e = customEnv ?? env;
  return worker.fetch(new Request(`https://pages.example.com${path}`), e, ctx);
}

let privateKey: CryptoKey;

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

async function validToken(): Promise<string> {
  return signJwt(privateKey, "access-key-1", buildAccessPayload());
}

async function fetchApi(path: string, token?: string): Promise<Response> {
  const headers = token ? new Headers({ "Cf-Access-Jwt-Assertion": token }) : new Headers();
  const customEnv = makeEnv({
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: ACCESS_AUD,
  });
  return worker.fetch(
    new Request(`https://pages.example.com${path}`, { headers }),
    customEnv,
    createExecutionContext(),
  );
}

describe("index.ts — public entry pipeline", () => {
  const db = env.DB;
  const bucket = env.BUCKET;
  let fetchMock: ReturnType<typeof createMockFetch>;

  beforeEach(async () => {
    await clearPages(db);
    await clearBucket(bucket);
    const keys = await generateKeyPair("access-key-1");
    privateKey = keys.privateKey;
    fetchMock = createMockFetch({ keys: [keys.jwk] });
    vi.stubGlobal("fetch", fetchMock.fetchFn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET /health returns public 200 JSON with no binding details", async () => {
    const res = await fetchIndex("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: "pagelively" });
    expect(body).not.toHaveProperty("bindings");
  });

  it("GET / with HOME_MODE=404 returns a clean 404", async () => {
    const env404 = makeEnv({ HOME_MODE: "404", HOME_PAGE_SLUG: "" });
    const res = await fetchIndex("/", env404);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("Not Found");
    expect(text).toContain("<code>/</code>");
  });

  it("GET / with HOME_MODE=page and HOME_PAGE_SLUG=hello serves the page entry", async () => {
    await insertPage(db, { id: "home000001", slug: "hello", kind: "html" });
    await objects.put(
      "home000001",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><h1>Home</h1></body></html>",
      "text/html; charset=utf-8",
    );

    const envHome = makeEnv({ HOME_MODE: "page", HOME_PAGE_SLUG: "hello" });
    const res = await fetchIndex("/", envHome);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("<h1>Home</h1>");
    expect(text).toContain('<base href="https://cdn.example.com/pages/home000001/1/index.html">');
  });

  it("GET /hello redirects to /hello/", async () => {
    const res = await fetchIndex("/hello");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://pages.example.com/hello/");
  });

  it("GET /hello/ serves the html page with injected base", async () => {
    await insertPage(db, { id: "page000001", slug: "hello", kind: "html" });
    await objects.put(
      "page000001",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><h1>Hello</h1></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await fetchIndex("/hello/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<h1>Hello</h1>");
    expect(text).toContain('<base href="https://cdn.example.com/pages/page000001/1/index.html">');
  });

  it("GET /p/{id}/ serves the same page by id", async () => {
    await insertPage(db, { id: "page000001", slug: "hello", kind: "html" });
    await objects.put(
      "page000001",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><h1>Hello</h1></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await fetchIndex("/p/page000001/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<h1>Hello</h1>");
    expect(text).toContain('<base href="https://cdn.example.com/pages/page000001/1/index.html">');
  });

  it("GET /p/{id} redirects to /p/{id}/", async () => {
    const res = await fetchIndex("/p/page000001");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://pages.example.com/p/page000001/");
  });

  it("image page returns a 301 to the CDN URL", async () => {
    await insertPage(db, {
      id: "page000002",
      slug: "pic",
      kind: "image",
      entry_path: "photo.jpg",
      rev: 2,
    });

    const res = await fetchIndex("/pic/");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(
      "https://cdn.example.com/pages/page000002/2/photo.jpg",
    );
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(res.headers.get("Cache-Tag")).toBe("page-page000002");
  });

  it("markdown page serves rendered HTML with base tag", async () => {
    await insertPage(db, {
      id: "page000003",
      slug: "notes",
      kind: "markdown",
      entry_path: "index.html",
      raw_md_path: "source.md",
    });
    await objects.put(
      "page000003",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><main><h1>Notes</h1></main></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await fetchIndex("/notes/");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<h1>Notes</h1>");
    expect(text).toContain('<base href="https://cdn.example.com/pages/page000003/1/index.html">');
  });

  it("unknown slug returns a clean 404", async () => {
    const res = await fetchIndex("/unknown/");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("Not Found");
    expect(text).toContain("<code>/unknown/</code>");
  });

  it("unknown path returns a clean 404", async () => {
    const res = await fetchIndex("/robots.txt");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("Not Found");
  });

  it("admin and api routes without a valid token return 403 Forbidden with no-store", async () => {
    for (const path of ["/admin", "/admin/dashboard", "/api/pages", "/api/pages/123"]) {
      const res = await fetchIndex(path);
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
    }
  });

  it("GET /api/pages with a valid token returns the page list JSON", async () => {
    const token = await validToken();
    await insertPage(db, { id: "page000010", slug: "api-list", title: "API List" });
    const res = await fetchApi("/api/pages", token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: "page000010", slug: "api-list", title: "API List" });
    expect(body[0]).not.toHaveProperty("files");
  });

  it("GET /api/pages/:id with a valid token returns page detail including files", async () => {
    const token = await validToken();
    const pageId = "page000011";
    await insertPage(db, { id: pageId, slug: "api-detail", title: "API Detail" });
    await db
      .prepare(
        "INSERT INTO files (page_id, path, r2_key, content_type, size) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(pageId, "style.css", "pages/page000011/1/style.css", "text/css", 100)
      .run();
    const res = await fetchApi(`/api/pages/${pageId}`, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: pageId, slug: "api-detail", title: "API Detail" });
    expect(body.files).toHaveLength(1);
    expect((body.files as Record<string, unknown>[])[0]).toMatchObject({
      path: "style.css",
      content_type: "text/css",
      size: 100,
    });
  });

  it("GET /api/pages/:id with an invalid id returns 400 JSON", async () => {
    const token = await validToken();
    const res = await fetchApi("/api/pages/bad.id", token);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid_id", message: "Invalid page id." });
  });

  it("GET /api/pages/:id with an unknown id returns 404 JSON", async () => {
    const token = await validToken();
    const res = await fetchApi("/api/pages/Unknown000", token);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "not_found", message: "Page not found." });
  });

  it("maps AppError from the repository to a generic JSON 500 with no-store", async () => {
    const brokenDb = {
      prepare: () => {
        throw new Error("simulated db failure");
      },
    } as unknown as D1Database;
    const brokenEnv = makeEnv({ DB: brokenDb });
    const res = await fetchIndex("/hello/", brokenEnv);

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ error: "db_read_failed", message: "Database read failed." });
    expect(body).not.toHaveProperty("stack");
  });

  it("non-AppError failure in dispatch returns generic 500 with no-store and no stack", async () => {
    const fakeRequest = { url: "not a valid url", method: "GET" } as unknown as Request;
    const res = await worker.fetch(fakeRequest, env, createExecutionContext());

    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const body = await res.json();
    expect(body).toEqual({ error: "internal_error", message: "Internal error." });
    expect(body).not.toHaveProperty("stack");
  });

  it("invalid id format returns a typed 400 error with no-store", async () => {
    const res = await fetchIndex("/p/bad.id/");
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid_id", message: "Invalid page id." });
  });

  it("invalid slug format returns a typed 400 error with no-store", async () => {
    const res = await fetchIndex("/hello world/");
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "invalid_slug",
      message: "Slug may only contain lowercase letters, digits, `-`, and `_`.",
    });
  });

  it("trailing slash redirect preserves query string and hash", async () => {
    const res = await fetchIndex("/hello?foo=bar#baz");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://pages.example.com/hello/?foo=bar#baz");
  });

  it("HEAD /{slug} returns a 301 redirect with an empty body", async () => {
    const res = await worker.fetch(
      new Request("https://pages.example.com/hello", { method: "HEAD" }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://pages.example.com/hello/");
    expect(res.body).toBeNull();
  });

  it("home mode with an invalid slug returns a clean 404", async () => {
    const envHome = makeEnv({ HOME_MODE: "page", HOME_PAGE_SLUG: "admin" });
    const res = await fetchIndex("/", envHome);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("admin/api routes without a valid token return 403 for any HTTP method", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const res = await worker.fetch(
        new Request("https://pages.example.com/api/pages", { method }),
        env,
        createExecutionContext(),
      );
      expect(res.status).toBe(403);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
    }
  });

  it("GET /api/unknown with a valid token returns 404 JSON with no-store", async () => {
    const token = await validToken();
    const res = await fetchApi("/api/unknown", token);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ error: "not_found", message: "Not Found" });
  });

  it("error responses include charset=utf-8 on the JSON content type", async () => {
    const token = await validToken();
    const invalid = await fetchApi("/api/pages/bad.id", token);
    expect(invalid.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

    const missing = await fetchApi("/api/pages/Unknown000", token);
    expect(missing.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

    const method = await worker.fetch(
      new Request("https://pages.example.com/api/pages", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(method.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });
});
