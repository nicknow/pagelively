import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { AppError } from "../src/errors";
import { handlePatchPage, handleAddFiles, handleDeleteFile } from "../src/admin-api";
import { createTestCacheService } from "../src/cache-service";
import { createConfig } from "../src/config";
import { createPagesRepository } from "../src/pages-repository";
import { createFilesRepository } from "../src/files-repository";
import { createObjectStore } from "../src/object-store";
import {
  ACCESS_AUD,
  createMockFetch,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

// S18 — Edit & delete API: PATCH, file add/replace/delete, page delete, rev bump.

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
  body: BodyInit | null = null,
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

function appendFile(form: FormData, path: string, file: File): void {
  form.append(`file:${path}`, file);
}

function makeAdminDeps(objectStore = createObjectStore(env.BUCKET)) {
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
  };
}

function createWriteFailingDb(db: D1Database): D1Database {
  const fail = async () => {
    throw new Error("simulated db write failure");
  };
  return {
    prepare: (sql: string) => {
      const stmt = db.prepare(sql);
      const isWrite = /^(UPDATE|INSERT|DELETE)/i.test(sql.trim());
      if (isWrite) {
        return {
          bind: () =>
            ({ first: fail, all: fail, run: fail, raw: fail }) as unknown as D1PreparedStatement,
          first: fail,
          all: fail,
          run: fail,
          raw: fail,
        } as unknown as D1PreparedStatement;
      }
      return {
        bind: (...args: unknown[]) => {
          const bound = stmt.bind(...args);
          return {
            first: bound.first.bind(bound),
            all: bound.all.bind(bound),
            run: fail,
            raw: fail,
          } as unknown as D1PreparedStatement;
        },
        first: stmt.first.bind(stmt),
        all: stmt.all.bind(stmt),
        run: stmt.run.bind(stmt),
        raw: stmt.raw?.bind(stmt) ?? fail,
      } as unknown as D1PreparedStatement;
    },
    batch: fail,
    exec: fail,
  } as unknown as D1Database;
}

describe("S18 — edit & delete API", () => {
  const db = env.DB;
  const bucket = env.BUCKET;
  const ctx = createExecutionContext();

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

  describe("PATCH /api/pages/:id", () => {
    it("patches slug, title, visibility, and show_source", async () => {
      const pageId = "page000001";
      await insertPage(db, { id: pageId, slug: "old", title: "Old", kind: "html" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ slug: "new", title: "New", visibility: "unlisted", showSource: true }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.slug).toBe("new");
      expect(body.title).toBe("New");
      expect(body.visibility).toBe("unlisted");
      expect(body.show_source).toBe(1);
      expect(body.rev).toBe(1);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("returns 404 for a missing page", async () => {
      const token = await validToken();
      const res = await fetchApi(
        "/api/pages/Missing000",
        "PATCH",
        JSON.stringify({ title: "x" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });

    it("returns 400 for an invalid id", async () => {
      const token = await validToken();
      const res = await fetchApi(
        "/api/pages/bad.id",
        "PATCH",
        JSON.stringify({ title: "x" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_id" });
    });

    it("returns 409 when the slug is already taken by another page", async () => {
      const pageId = "page000002";
      await insertPage(db, { id: "other00001", slug: "taken" });
      await insertPage(db, { id: pageId, slug: "old" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ slug: "taken" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "slug_conflict" });
    });

    it("returns 400 for a reserved slug", async () => {
      const pageId = "page000003";
      await insertPage(db, { id: pageId, slug: "old" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ slug: "admin" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_slug" });
    });

    it("allows reusing the same slug for the same page", async () => {
      const pageId = "page000004";
      await insertPage(db, { id: pageId, slug: "same" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ slug: "same" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.slug).toBe("same");
    });

    it("re-renders markdown entry when showSource toggles without rev bump", async () => {
      const pageId = "page000005";
      await insertPage(db, {
        id: pageId,
        slug: "notes",
        kind: "markdown",
        entry_path: "index.html",
        raw_md_path: "source.md",
        show_source: 0,
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "source.md", "# Hello", "text/markdown");
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body><main><h1>Hello</h1></main></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000005/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "source.md",
        r2_key: "pages/page000005/1/source.md",
        content_type: "text/markdown",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ showSource: true }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(1);
      expect(body.show_source).toBe(1);

      const htmlObj = await bucket.get("pages/page000005/1/index.html");
      const html = await new Response(htmlObj!.body).text();
      expect(html).toContain("View source");

      const cacheService = createTestCacheService();
      const deps = makeAdminDeps(objectStore);
      const patchReq = new Request(`https://pages.example.com/api/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({ showSource: true }),
        headers: { "Content-Type": "application/json" },
      });
      await handlePatchPage(patchReq, ctx, { ...deps, cacheService });
      expect(cacheService.getPurgeTags()).toContain("page-page000005");
    });

    it("returns 400 for invalid visibility", async () => {
      const pageId = "page000006";
      await insertPage(db, { id: pageId, slug: "x" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ visibility: "secret" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_visibility" });
    });

    it("returns 400 for invalid JSON body", async () => {
      const pageId = "page000007";
      await insertPage(db, { id: pageId, slug: "x" });
      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}`, "PATCH", "not-json", token, {
        "Content-Type": "application/json",
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    });

    it("returns 400 when title is not a string", async () => {
      const pageId = "page000009";
      await insertPage(db, { id: pageId, slug: "x" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ title: 123 }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_title" });
    });

    it("returns 400 when title exceeds 256 characters", async () => {
      const pageId = "page0000tl";
      await insertPage(db, { id: pageId, slug: "x" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ title: "a".repeat(257) }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "title_too_long" });
    });

    it("returns 400 when showSource is not a boolean", async () => {
      const pageId = "page00000a";
      await insertPage(db, { id: pageId, slug: "x" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ showSource: "yes" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_show_source" });
    });

    it("returns 400 when slug is not a string or null", async () => {
      const pageId = "page0000sl";
      await insertPage(db, { id: pageId, slug: "x" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ slug: 123 }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_slug" });
    });

    it("returns 404 when source.md is missing for a showSource toggle", async () => {
      const pageId = "page00000b";
      await insertPage(db, {
        id: pageId,
        slug: "md",
        kind: "markdown",
        entry_path: "index.html",
        raw_md_path: "source.md",
      });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ showSource: true }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "entry_not_found" });
    });

    it("returns 403 when unauthenticated", async () => {
      const pageId = "page000008";
      await insertPage(db, { id: pageId, slug: "x" });
      const res = await fetchApi(`/api/pages/${pageId}`, "PATCH", JSON.stringify({ title: "x" }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });

    it("returns 400 for an empty slug", async () => {
      const pageId = "page00000c";
      await insertPage(db, { id: pageId, slug: "x" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ slug: "" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_slug" });
    });

    it("returns 200 with an empty patch", async () => {
      const pageId = "page00000d";
      await insertPage(db, { id: pageId, slug: "x", title: "X" });
      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}`, "PATCH", JSON.stringify({}), token, {
        "Content-Type": "application/json",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.slug).toBe("x");
      expect(body.title).toBe("X");
    });

    it("re-renders markdown when showSource toggles from true to false", async () => {
      const pageId = "page00000e";
      await insertPage(db, {
        id: pageId,
        slug: "notes",
        kind: "markdown",
        entry_path: "index.html",
        raw_md_path: "source.md",
        show_source: 1,
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "source.md", "# Hello", "text/markdown");
      await objectStore.put(
        pageId,
        1,
        "index.html",
        '<html><a href="source.md">View source</a></html>',
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: `pages/${pageId}/1/index.html`,
        content_type: "text/html; charset=utf-8",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "source.md",
        r2_key: `pages/${pageId}/1/source.md`,
        content_type: "text/markdown",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ showSource: false }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(1);
      expect(body.show_source).toBe(0);

      const htmlObj = await bucket.get(`pages/${pageId}/1/index.html`);
      const html = await new Response(htmlObj!.body).text();
      expect(html).not.toContain("View source");
    });

    it("does not re-render when showSource is unchanged", async () => {
      const pageId = "page00000f";
      await insertPage(db, {
        id: pageId,
        slug: "notes",
        kind: "markdown",
        entry_path: "index.html",
        raw_md_path: "source.md",
        show_source: 1,
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "source.md", "# Hello", "text/markdown");
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<html><body>Old</body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: `pages/${pageId}/1/index.html`,
        content_type: "text/html; charset=utf-8",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "source.md",
        r2_key: `pages/${pageId}/1/source.md`,
        content_type: "text/markdown",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}`,
        "PATCH",
        JSON.stringify({ title: "New" }),
        token,
        { "Content-Type": "application/json" },
      );
      expect(res.status).toBe(200);
      const htmlObj = await bucket.get(`pages/${pageId}/1/index.html`);
      const html = await new Response(htmlObj!.body).text();
      expect(html).toContain("Old");
    });

    it("throws not_found when the page disappears during update", async () => {
      const pageId = "page0000dis";
      await insertPage(db, { id: pageId, slug: "x" });
      const objectStore = createObjectStore(bucket);
      const pagesRepository = createPagesRepository(db);
      const deps = {
        ...makeAdminDeps(objectStore),
        pagesRepository: {
          ...pagesRepository,
          async updateMeta() {
            return null;
          },
        },
      };
      const req = new Request(`https://pages.example.com/api/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: "New" }),
        headers: { "Content-Type": "application/json" },
      });
      await expect(handlePatchPage(req, ctx, deps)).rejects.toMatchObject({
        code: "not_found",
        status: 404,
      });
    });
  });

  describe("POST /api/pages/:id/files", () => {
    it("adds a new file and bumps rev", async () => {
      const pageId = "page000010";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000010/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });

      const form = new FormData();
      appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", form, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(2);
      expect(body.files).toHaveLength(2);

      const keys = await listKeys(bucket, `pages/${pageId}/2/`);
      expect(keys).toEqual(
        expect.arrayContaining([`pages/${pageId}/2/index.html`, `pages/${pageId}/2/style.css`]),
      );
    });

    it("replaces an HTML entry file", async () => {
      const pageId = "page000011";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body><h1>Old</h1></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000011/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });

      const form = new FormData();
      appendFile(
        form,
        "index.html",
        makeFile(
          "index.html",
          "<!doctype html><html><head></head><body><h1>New</h1></body></html>",
          "text/html",
        ),
      );

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", form, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(2);
      const htmlObj = await bucket.get("pages/page000011/2/index.html");
      const html = await new Response(htmlObj!.body).text();
      expect(html).toContain("<h1>New</h1>");
    });

    it("replaces a markdown entry file and re-renders", async () => {
      const pageId = "page000012";
      await insertPage(db, {
        id: pageId,
        slug: "md",
        kind: "markdown",
        entry_path: "index.html",
        raw_md_path: "source.md",
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "source.md", "# Old", "text/markdown");
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body><main><h1>Old</h1></main></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000012/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "source.md",
        r2_key: "pages/page000012/1/source.md",
        content_type: "text/markdown",
        size: 10,
      });

      const form = new FormData();
      appendFile(form, "notes.md", makeFile("notes.md", "# New", "text/markdown"));

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", form, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(2);
      const htmlObj = await bucket.get("pages/page000012/2/index.html");
      const html = await new Response(htmlObj!.body).text();
      expect(html).toContain("<h1>New</h1>");
      const mdObj = await bucket.get("pages/page000012/2/source.md");
      expect(mdObj).not.toBeNull();
      expect(await new Response(mdObj!.body).text()).toBe("# New");
    });

    it("rejects invalid file paths", async () => {
      const pageId = "page000013";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: `pages/${pageId}/1/index.html`,
        content_type: "text/html; charset=utf-8",
        size: 10,
      });

      const form = new FormData();
      appendFile(form, "../etc/passwd", makeFile("passwd", "x", "text/plain"));

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", form, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "path_traversal" });
    });

    it("returns 403 when unauthenticated", async () => {
      const pageId = "page000014";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const form = new FormData();
      appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", form);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });

    it("returns 404 for a missing page", async () => {
      const token = await validToken();
      const form = new FormData();
      appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));
      const res = await fetchApi("/api/pages/Missing000/files", "POST", form, token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });

    it("returns 400 for an invalid id", async () => {
      const token = await validToken();
      const form = new FormData();
      appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));
      const res = await fetchApi("/api/pages/bad.id/files", "POST", form, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_id" });
    });

    it("returns 400 when no files are uploaded", async () => {
      const pageId = "page0000nf";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", new FormData(), token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "no_files" });
    });

    it("returns 400 for malformed multipart form data", async () => {
      const pageId = "page0000mf";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}/files`,
        "POST",
        "--boundary\ninvalid",
        token,
        { "Content-Type": "multipart/form-data; boundary=boundary" },
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_form_data" });
    });

    it("returns 413 for an oversized request", async () => {
      const pageId = "page0000ol";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", "x", token, {
        "Content-Type": "text/plain",
        "Content-Length": "99614721",
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "request_too_large" });
    });

    it("skips files whose R2 object is missing when copying to a new rev", async () => {
      const pageId = "page0000sk";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "index.html", "<h1>Hi</h1>", "text/html; charset=utf-8");
      // Insert a file row without a backing object.
      await insertFile(db, {
        page_id: pageId,
        path: "style.css",
        r2_key: `pages/${pageId}/1/style.css`,
        content_type: "text/css",
        size: 10,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: `pages/${pageId}/1/index.html`,
        content_type: "text/html; charset=utf-8",
        size: 10,
      });

      const form = new FormData();
      appendFile(
        form,
        "script.js",
        makeFile("script.js", "console.log(1)", "application/javascript"),
      );
      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", form, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(2);
      const paths = (body.files as Array<{ path: string }>).map((f) => f.path);
      expect(paths).toContain("index.html");
      expect(paths).toContain("script.js");
      expect(paths).not.toContain("style.css");
    });

    it("replaces a bundle HTML entry file", async () => {
      const pageId = "page000015";
      await insertPage(db, {
        id: pageId,
        slug: "bundle",
        kind: "bundle",
        entry_path: "site/index.html",
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "site/index.html",
        "<!doctype html><html><head></head><body><h1>Old</h1></body></html>",
        "text/html; charset=utf-8",
      );
      await objectStore.put(pageId, 1, "site/style.css", "body{}", "text/css");
      await insertFile(db, {
        page_id: pageId,
        path: "site/index.html",
        r2_key: "pages/page000015/1/site/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "site/style.css",
        r2_key: "pages/page000015/1/site/style.css",
        content_type: "text/css",
        size: 10,
      });

      const form = new FormData();
      appendFile(
        form,
        "site/index.html",
        makeFile(
          "site/index.html",
          "<!doctype html><html><head></head><body><h1>New</h1></body></html>",
          "text/html",
        ),
      );

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", form, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(2);
      const htmlObj = await bucket.get("pages/page000015/2/site/index.html");
      const html = await new Response(htmlObj!.body).text();
      expect(html).toContain("<h1>New</h1>");
    });

    it("replaces an image entry file", async () => {
      const pageId = "page0000img";
      await insertPage(db, {
        id: pageId,
        slug: "pic",
        kind: "image",
        entry_path: "photo.jpg",
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "photo.jpg", "OLD-JPEG", "image/jpeg");
      await insertFile(db, {
        page_id: pageId,
        path: "photo.jpg",
        r2_key: `pages/${pageId}/1/photo.jpg`,
        content_type: "image/jpeg",
        size: 10,
      });

      const form = new FormData();
      appendFile(form, "photo.jpg", makeFile("photo.jpg", "NEW-JPEG", "image/jpeg"));
      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files`, "POST", form, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(2);

      const imgObj = await bucket.get(`pages/${pageId}/2/photo.jpg`);
      expect(imgObj).not.toBeNull();
      expect(await new Response(imgObj!.body).text()).toBe("NEW-JPEG");
    });
  });

  describe("DELETE /api/pages/:id/files/:path", () => {
    it("deletes a file and bumps rev", async () => {
      const pageId = "page000020";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>",
        "text/html; charset=utf-8",
      );
      await objectStore.put(pageId, 1, "style.css", "body{}", "text/css");
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000020/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "style.css",
        r2_key: "pages/page000020/1/style.css",
        content_type: "text/css",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files/style.css`, "DELETE", null, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.rev).toBe(2);
      expect(body.files).toHaveLength(1);

      const keys = await listKeys(bucket, `pages/${pageId}/`);
      expect(keys).toContain("pages/page000020/2/index.html");
      expect(keys).not.toContain("pages/page000020/2/style.css");
    });

    it("rejects deletion of the entry file", async () => {
      const pageId = "page000021";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000021/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files/index.html`, "DELETE", null, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "entry_not_deletable" });
    });

    it("rejects deletion of the image entry file", async () => {
      const pageId = "page000022";
      await insertPage(db, {
        id: pageId,
        slug: "pic",
        kind: "image",
        entry_path: "photo.jpg",
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "photo.jpg", "JPEG", "image/jpeg");
      await insertFile(db, {
        page_id: pageId,
        path: "photo.jpg",
        r2_key: "pages/page000022/1/photo.jpg",
        content_type: "image/jpeg",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files/photo.jpg`, "DELETE", null, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "entry_not_deletable" });
    });

    it("returns 404 for a missing page", async () => {
      const token = await validToken();
      const res = await fetchApi("/api/pages/Missing000/files/style.css", "DELETE", null, token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });

    it("returns 400 for an invalid id", async () => {
      const token = await validToken();
      const res = await fetchApi("/api/pages/bad.id/files/style.css", "DELETE", null, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_id" });
    });

    it("returns 404 when the file does not exist", async () => {
      const pageId = "page000024";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000024/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files/missing.css`, "DELETE", null, token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });

    it("returns 403 when unauthenticated", async () => {
      const pageId = "page000023";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const res = await fetchApi(`/api/pages/${pageId}/files/style.css`, "DELETE", null);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });

    it("rejects deletion of a nested bundle HTML entry", async () => {
      const pageId = "page000026";
      await insertPage(db, {
        id: pageId,
        slug: "bundle",
        kind: "bundle",
        entry_path: "site/index.html",
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "site/index.html",
        "<!doctype html><html><head></head><body><h1>Hi</h1></body></html>",
        "text/html; charset=utf-8",
      );
      await objectStore.put(pageId, 1, "site/style.css", "body{}", "text/css");
      await insertFile(db, {
        page_id: pageId,
        path: "site/index.html",
        r2_key: "pages/page000026/1/site/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "site/style.css",
        r2_key: "pages/page000026/1/site/style.css",
        content_type: "text/css",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(
        `/api/pages/${pageId}/files/site/index.html`,
        "DELETE",
        null,
        token,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "entry_not_deletable" });
    });

    it("rejects deletion of the raw markdown source for a markdown page", async () => {
      const pageId = "page000027";
      await insertPage(db, {
        id: pageId,
        slug: "md",
        kind: "markdown",
        entry_path: "index.html",
        raw_md_path: "source.md",
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "source.md", "# Hi", "text/markdown");
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body><main><h1>Hi</h1></main></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "source.md",
        r2_key: "pages/page000027/1/source.md",
        content_type: "text/markdown",
        size: 10,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000027/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files/source.md`, "DELETE", null, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "entry_not_deletable" });
    });

    it("rejects deletion of a bundle markdown entry source", async () => {
      const pageId = "page000028";
      await insertPage(db, {
        id: pageId,
        slug: "bundle-md",
        kind: "bundle",
        entry_path: "notes.md",
        raw_md_path: "source.md",
      });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "source.md", "# Hi", "text/markdown");
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body><main><h1>Hi</h1></main></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "source.md",
        r2_key: "pages/page000028/1/source.md",
        content_type: "text/markdown",
        size: 10,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000028/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files/source.md`, "DELETE", null, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "entry_not_deletable" });
    });

    it("deletes a file by URL-encoded path", async () => {
      const pageId = "page000025";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(pageId, 1, "index.html", "<h1>Hi</h1>", "text/html; charset=utf-8");
      await objectStore.put(pageId, 1, "my file.png", "PNG", "image/png");
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: `pages/${pageId}/1/index.html`,
        content_type: "text/html; charset=utf-8",
        size: 10,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "my file.png",
        r2_key: `pages/${pageId}/1/my file.png`,
        content_type: "image/png",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}/files/my%20file.png`, "DELETE", null, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.files).toHaveLength(1);
      expect((body.files as Array<{ path: string }>)[0].path).toBe("index.html");
    });
  });

  describe("DELETE /api/pages/:id", () => {
    it("deletes the page, its file rows, and its R2 objects", async () => {
      const pageId = "page000030";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000030/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 10,
      });

      const token = await validToken();
      const res = await fetchApi(`/api/pages/${pageId}`, "DELETE", null, token);
      expect(res.status).toBe(204);
      expect(res.body).toBeNull();

      const row = await db.prepare("SELECT * FROM pages WHERE id = ?").bind(pageId).first();
      expect(row).toBeNull();
      const files = await db.prepare("SELECT * FROM files WHERE page_id = ?").bind(pageId).all();
      expect(files.results).toHaveLength(0);
      const keys = await listKeys(bucket, `pages/${pageId}/`);
      expect(keys).toHaveLength(0);
    });

    it("returns 404 for a missing page", async () => {
      const token = await validToken();
      const res = await fetchApi("/api/pages/Missing000", "DELETE", null, token);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    });

    it("returns 400 for an invalid id", async () => {
      const token = await validToken();
      const res = await fetchApi("/api/pages/bad.id", "DELETE", null, token);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_id" });
    });

    it("returns 403 when unauthenticated", async () => {
      const pageId = "page000031";
      await insertPage(db, { id: pageId, slug: "x" });
      const res = await fetchApi(`/api/pages/${pageId}`, "DELETE", null);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden" });
    });
  });

  describe("handler failure modes", () => {
    it("PATCH rolls back re-rendered HTML when D1 update fails", async () => {
      const pageId = "page000040";
      await insertPage(db, {
        id: pageId,
        slug: "md",
        kind: "markdown",
        entry_path: "index.html",
        raw_md_path: "source.md",
        show_source: 0,
      });
      const objectStore = createObjectStore(bucket);
      const oldHtml =
        "<!doctype html><html><head></head><body><main><h1>Old</h1></main></body></html>";
      await objectStore.put(pageId, 1, "source.md", "# Old", "text/markdown");
      await objectStore.put(pageId, 1, "index.html", oldHtml, "text/html; charset=utf-8");
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000040/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 100,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "source.md",
        r2_key: "pages/page000040/1/source.md",
        content_type: "text/markdown",
        size: 10,
      });

      const deps = {
        ...makeAdminDeps(objectStore),
        pagesRepository: createPagesRepository(createWriteFailingDb(db)),
      };
      const req = new Request(`https://pages.example.com/api/pages/${pageId}`, {
        method: "PATCH",
        body: JSON.stringify({ showSource: true }),
        headers: { "Content-Type": "application/json" },
      });
      await expect(handlePatchPage(req, ctx, deps)).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });

      const htmlObj = await bucket.get("pages/page000040/1/index.html");
      const html = await new Response(htmlObj!.body).text();
      expect(html).toBe(oldHtml);
    });

    it("POST files rolls back new rev objects when D1 write fails", async () => {
      const pageId = "page000041";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000041/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 10,
      });

      const deps = {
        ...makeAdminDeps(objectStore),
        pagesRepository: createPagesRepository(createWriteFailingDb(db)),
      };
      const form = new FormData();
      appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));
      const req = new Request(`https://pages.example.com/api/pages/${pageId}/files`, {
        method: "POST",
        body: form,
      });
      await expect(handleAddFiles(req, ctx, deps)).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });

      const keys = await listKeys(bucket, `pages/${pageId}/2/`);
      expect(keys).toEqual([]);
    });

    it("POST files restores the previous D1 state when file replacement fails after rev bump", async () => {
      const pageId = "page0000restore";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: `pages/${pageId}/1/index.html`,
        content_type: "text/html; charset=utf-8",
        size: 10,
      });

      const realFilesRepository = createFilesRepository(db);
      const deps = {
        ...makeAdminDeps(objectStore),
        pagesRepository: createPagesRepository(db),
        filesRepository: {
          ...realFilesRepository,
          async replaceAll(pageIdArg: string, rev: number, files: unknown[]) {
            if (rev > 1) {
              throw new AppError("db_write_failed", 500, "simulated file replacement failure");
            }
            return realFilesRepository.replaceAll(pageIdArg, rev, files as never);
          },
        },
      };
      const form = new FormData();
      appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));
      const req = new Request(`https://pages.example.com/api/pages/${pageId}/files`, {
        method: "POST",
        body: form,
      });
      await expect(handleAddFiles(req, ctx, deps)).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });

      const page = await db.prepare("SELECT * FROM pages WHERE id = ?").bind(pageId).first();
      expect(page).toMatchObject({ rev: 1 });
      const files = await db.prepare("SELECT * FROM files WHERE page_id = ?").bind(pageId).all();
      expect((files.results as Array<{ path: string }>).map((f) => f.path)).toEqual(["index.html"]);
      const keys = await listKeys(bucket, `pages/${pageId}/2/`);
      expect(keys).toEqual([]);
    });

    it("DELETE file rolls back new rev objects when D1 write fails", async () => {
      const pageId = "page000042";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body></body></html>",
        "text/html; charset=utf-8",
      );
      await objectStore.put(pageId, 1, "style.css", "body{}", "text/css");
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: "pages/page000042/1/index.html",
        content_type: "text/html; charset=utf-8",
        size: 10,
      });
      await insertFile(db, {
        page_id: pageId,
        path: "style.css",
        r2_key: "pages/page000042/1/style.css",
        content_type: "text/css",
        size: 10,
      });

      const deps = {
        ...makeAdminDeps(objectStore),
        pagesRepository: createPagesRepository(createWriteFailingDb(db)),
      };
      const req = new Request(`https://pages.example.com/api/pages/${pageId}/files/style.css`, {
        method: "DELETE",
      });
      await expect(handleDeleteFile(req, ctx, deps)).rejects.toMatchObject({
        code: "db_write_failed",
        status: 500,
      });

      const keys = await listKeys(bucket, `pages/${pageId}/2/`);
      expect(keys).toEqual([]);
    });

    it("POST files throws not_found when the page disappears before the rev bump", async () => {
      const pageId = "page0000van";
      await insertPage(db, { id: pageId, slug: "x", kind: "html" });
      const objectStore = createObjectStore(bucket);
      await objectStore.put(
        pageId,
        1,
        "index.html",
        "<!doctype html><html><head></head><body></body></html>",
        "text/html; charset=utf-8",
      );
      await insertFile(db, {
        page_id: pageId,
        path: "index.html",
        r2_key: `pages/${pageId}/1/index.html`,
        content_type: "text/html; charset=utf-8",
        size: 10,
      });

      const pagesRepository = createPagesRepository(db);
      const deps = {
        ...makeAdminDeps(objectStore),
        pagesRepository: {
          ...pagesRepository,
          async applyRevBump() {
            return null;
          },
        },
      };
      const form = new FormData();
      appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));
      const req = new Request(`https://pages.example.com/api/pages/${pageId}/files`, {
        method: "POST",
        body: form,
      });
      await expect(handleAddFiles(req, ctx, deps)).rejects.toMatchObject({
        code: "not_found",
        status: 404,
      });

      const keys = await listKeys(bucket, `pages/${pageId}/2/`);
      expect(keys).toEqual([]);
    });
  });
});
