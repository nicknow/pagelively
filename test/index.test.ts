import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { createObjectStore } from "../src/object-store";
import { createPagesRepository } from "../src/pages-repository";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { hashPassword } from "../src/password";
import { generateToken, hashToken, formatUnlockCookie } from "../src/password-token";
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

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...env, ...overrides } as Env;
}

async function fetchIndex(path: string, customEnv?: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const e = customEnv ?? env;
  return worker.fetch(new Request(`https://pages.example.com${path}`), e, ctx);
}

async function fetchIndexRequest(request: Request, customEnv?: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const e = customEnv ?? env;
  return worker.fetch(request, e, ctx);
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

  // --- S23 public gate wired in (ADR 0041; architecture 02 dispatch order) ---

  it("GET /p/{id}/unlock renders the prompt without any Access token (public route)", async () => {
    const db2 = env.DB;
    const id = "page200001";
    await insertPage(db2, { id, slug: "secret", kind: "html" });
    await createPagesRepository(db2).setPasswordHash(id, await hashPassword("secret1"));

    const res = await fetchIndex(`/p/${id}/unlock`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    const text = await res.text();
    expect(text).toContain("This page is password protected.");
    expect(text).toContain(`action="/p/${id}/unlock"`);
  });

  it("POST /p/{id}/unlock with the correct password returns 303 with the unlock cookie", async () => {
    const id = "page200001";
    await insertPage(db, { id, slug: "secret", kind: "html" });
    await createPagesRepository(db).setPasswordHash(id, await hashPassword("secret1"));

    const res = await fetchIndexRequest(
      new Request(`https://pages.example.com/p/${id}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=secret1",
      }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/p/${id}/`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toMatch(
      /^pl_unlock=page200001\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure$/,
    );
  });

  it("POST /p/{id}/unlock with the wrong password re-renders the prompt with an error", async () => {
    const id = "page200001";
    await insertPage(db, { id, slug: "secret", kind: "html" });
    await createPagesRepository(db).setPasswordHash(id, await hashPassword("secret1"));

    const res = await fetchIndexRequest(
      new Request(`https://pages.example.com/p/${id}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=wrongpw",
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain('role="alert"');
    expect(text).toContain("Incorrect password.");
  });

  it("POST /p/{id}/unlock with a non-form or unparseable body → 400 JSON invalid_form_data via the error boundary (never a 500)", async () => {
    const id = "page200001";
    await insertPage(db, { id, slug: "secret", kind: "html" });
    await createPagesRepository(db).setPasswordHash(id, await hashPassword("secret1"));

    const cases: Array<{ label: string; init: RequestInit }> = [
      {
        label: "text/plain",
        init: {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "password=secret1",
        },
      },
      {
        label: "application/json",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"password":"secret1"}',
        },
      },
      { label: "no content-type", init: { method: "POST", body: "password=secret1" } },
      { label: "empty body", init: { method: "POST", body: "" } },
      {
        label: "malformed multipart boundary",
        init: {
          method: "POST",
          headers: { "Content-Type": "multipart/form-data; boundary=does-not-exist" },
          body: "--not-the-boundary\r\n",
        },
      },
    ];

    for (const c of cases) {
      const res = await fetchIndexRequest(
        new Request(`https://pages.example.com/p/${id}/unlock`, c.init),
      );
      expect(res.status, `${c.label}: expected 400, got ${res.status}`).toBe(400);
      expect(res.headers.get("Content-Type"), c.label).toBe("application/json; charset=utf-8");
      expect(res.headers.get("Cache-Control"), c.label).toBe("no-store");
      expect(res.headers.get("Cache-Tag"), c.label).toBeNull();
      expect(await res.json(), c.label).toMatchObject({ error: "invalid_form_data" });
    }
  });

  it("protected page: prompt without a cookie, unlocked entry with a valid cookie", async () => {
    const id = "page200001";
    await insertPage(db, { id, slug: "secret", kind: "html" });
    await createPagesRepository(db).setPasswordHash(id, await hashPassword("secret1"));
    await objects.put(
      id,
      1,
      "index.html",
      "<!doctype html><html><head></head><body><p>Secret</p></body></html>",
      "text/html; charset=utf-8",
    );

    const locked = await fetchIndex("/secret/");
    expect(locked.status).toBe(200);
    expect(await locked.text()).toContain("This page is password protected.");

    const token = generateToken();
    await createUnlocksRepository(db).create(id, await hashToken(token));
    const unlocked = await fetchIndexRequest(
      new Request("https://pages.example.com/secret/", {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie(id, token)}` },
      }),
    );

    expect(unlocked.status).toBe(200);
    expect(unlocked.headers.get("Cache-Control")).toBe("no-store");
    expect(unlocked.headers.get("Cache-Tag")).toBeNull();
    const text = await unlocked.text();
    expect(text).toContain("<p>Secret</p>");
    expect(text).toContain(
      '<base href="https://pages.example.com/assets/pages/page200001/1/index.html">',
    );
    expect(text).not.toContain("cdn.example.com");
  });

  it("protected image page: prompt without a cookie, Worker image bytes with a cookie (no 301)", async () => {
    const id = "page200002";
    await insertPage(db, { id, slug: "pict", kind: "image", entry_path: "photo.jpg" });
    await createPagesRepository(db).setPasswordHash(id, await hashPassword("secret1"));
    await objects.put(id, 1, "photo.jpg", "fake-jpeg-bytes", "image/jpeg");

    const locked = await fetchIndex("/pict/");
    expect(locked.status).toBe(200);
    expect(locked.headers.get("Location")).toBeNull();
    expect(await locked.text()).toContain("This page is password protected.");

    const token = generateToken();
    await createUnlocksRepository(db).create(id, await hashToken(token));
    const unlocked = await fetchIndexRequest(
      new Request("https://pages.example.com/pict/", {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie(id, token)}` },
      }),
    );

    expect(unlocked.status).toBe(200);
    expect(unlocked.headers.get("Location")).toBeNull();
    expect(unlocked.headers.get("Content-Type")).toBe("image/jpeg");
    expect(unlocked.headers.get("Cache-Control")).toBe("no-store");
    expect(await unlocked.text()).toBe("fake-jpeg-bytes");
  });

  it("home-mode protected page forwards the cookie (prompt without, entry with)", async () => {
    const id = "page200003";
    await insertPage(db, { id, slug: "homesec", kind: "html" });
    await createPagesRepository(db).setPasswordHash(id, await hashPassword("secret1"));
    await objects.put(
      id,
      1,
      "index.html",
      "<!doctype html><html><head></head><body><h1>Home Secured</h1></body></html>",
      "text/html; charset=utf-8",
    );
    const envHome = makeEnv({ HOME_MODE: "page", HOME_PAGE_SLUG: "homesec" });

    const locked = await fetchIndex("/", envHome);
    expect(locked.status).toBe(200);
    expect(await locked.text()).toContain("This page is password protected.");

    const token = generateToken();
    await createUnlocksRepository(db).create(id, await hashToken(token));
    const unlocked = await fetchIndexRequest(
      new Request("https://pages.example.com/", {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie(id, token)}` },
      }),
      envHome,
    );

    expect(unlocked.status).toBe(200);
    const text = await unlocked.text();
    expect(text).toContain("<h1>Home Secured</h1>");
    expect(text).not.toContain("password protected");
  });

  it("GET /assets/pages/{id}/{rev}/{path} is public and serves no-store bytes", async () => {
    await objects.put("page200004", 1, "assets/css/style.css", "body {}", "text/css");

    const res = await fetchIndex("/assets/pages/page200004/1/assets/css/style.css");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/css");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(await res.text()).toBe("body {}");
  });

  it("traversal and malformed-encoding attacks on /assets never 500 and never leak", async () => {
    await objects.put("page200005", 1, "sibling.html", "sibling", "text/html");

    // Encoded ../ with an encoded slash → router rejects (unknown) → clean 404.
    const encSlash = await fetchIndex("/assets/pages/page200005/1/%2e%2e%2fsibling.html");
    expect(encSlash.status).toBe(404);
    expect(await encSlash.text()).toContain("Not Found");

    // Encoded dot-dot + literal slash is normalized at URL parse → clean 404.
    const normalized = await fetchIndex("/assets/pages/page200005/1/%2e%2e/sibling.html");
    expect(normalized.status).toBe(404);
    expect(await normalized.text()).toContain("Not Found");

    // The reachable decoded-traversal shape (..\ via %5C) → typed 400, never 500.
    const backslash = await fetchIndex("/assets/pages/page200005/1/%2e%2e%5csibling.html");
    expect(backslash.status).toBe(400);
    expect(((await backslash.json()) as { error: string }).error).toBe("path_traversal");

    // Encoded slash → classified unknown → clean 404.
    const encodedSlash = await fetchIndex("/assets/pages/page200005/1/a%2Fb");
    expect(encodedSlash.status).toBe(404);

    // Malformed percent-encoding → clean 404, never 500.
    const malformed = await fetchIndex("/assets/pages/page200005/1/bad%2.html");
    expect(malformed.status).toBe(404);
    expect(await malformed.text()).toContain("Not Found");

    // The sibling key was never served by any of the attacks above.
    const res = await fetchIndex("/assets/pages/page200005/1/sibling.html");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("sibling");
  });
});
