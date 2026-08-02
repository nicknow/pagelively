import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import {
  ACCESS_AUD,
  createMockFetch,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

// S19 — Admin UI handlers (dashboard, upload, edit) wired through index.ts.

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...env, ...overrides } as Env;
}

function buildAccessPayload(overrides: object = {}): object {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: TEAM_DOMAIN_URL,
    aud: [ACCESS_AUD],
    iat: now,
    exp: now + 3600,
    email: "admin@example.com",
    ...overrides,
  };
}

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
    created_at?: string;
    updated_at?: string;
  },
) {
  const now = new Date().toISOString();
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
      p.created_at ?? now,
      p.updated_at ?? now,
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

describe("index.ts — admin UI", () => {
  let privateKey: CryptoKey;
  let fetchMock: ReturnType<typeof createMockFetch>;

  beforeEach(async () => {
    const keys = await generateKeyPair("access-key-1");
    privateKey = keys.privateKey;
    fetchMock = createMockFetch({ keys: [keys.jwk] });
    vi.stubGlobal("fetch", fetchMock.fetchFn);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearFilesAndPages(env.DB);
  });

  async function validToken(): Promise<string> {
    return signJwt(privateKey, "access-key-1", buildAccessPayload());
  }

  async function fetchAdmin(path: string, token?: string): Promise<Response> {
    const headers = token ? new Headers({ "Cf-Access-Jwt-Assertion": token }) : new Headers();
    const request = new Request(`https://pages.example.com${path}`, { headers });
    const customEnv = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD });
    return worker.fetch(request, customEnv, createExecutionContext());
  }

  it("GET /admin without a token returns 403 Forbidden", async () => {
    const res = await fetchAdmin("/admin");
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("GET /admin with a valid token returns the dashboard HTML", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("Pagelively");
    expect(text).toContain("admin@example.com");
    expect(text).toContain("Upload");
    expect(text).toContain("Upload your first page");
    expect(text).toContain("/admin/upload");
  });

  it("GET /admin (no trailing slash) returns the dashboard", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("Pagelively");
  });

  it("GET /admin lists pages with view, edit, and delete links", async () => {
    const db = env.DB;
    await insertPage(db, {
      id: "page000001",
      slug: "hello",
      title: "Hello",
      kind: "html",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await insertPage(db, {
      id: "page000002",
      slug: "world",
      title: "World",
      kind: "markdown",
      visibility: "unlisted",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    });

    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).toContain("/hello/");
    expect(text).toContain("/world/");
    expect(text).toContain("/admin/edit/page000001");
    expect(text).toContain("/admin/edit/page000002");
    expect(text).toContain("/api/pages/page000001");
    expect(text).toContain("/api/pages/page000002");
  });

  it("GET /admin/upload returns the upload form HTML", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("Upload");
    expect(text).toContain("multipart/form-data");
    expect(text).toContain('action="/api/pages"');
    expect(text).toContain("file:<path>");
    // AC1: #files is the primary multiple-files picker — never webkitdirectory.
    const filesTag = text.match(/<input[^>]*\bid="files"[^>]*>/)?.[0] ?? "";
    expect(filesTag).toContain("multiple");
    expect(filesTag).not.toContain("webkitdirectory");
    // AC2: folder upload is a separate opt-in webkitdirectory picker.
    const folderTag = text.match(/<input[^>]*\bid="folder"[^>]*>/)?.[0] ?? "";
    expect(folderTag).toContain("multiple");
    expect(folderTag).toContain("webkitdirectory");
    expect(text).toContain("or upload a folder (preserves relative paths)");
    expect(text).toContain("slug");
    expect(text).toContain("title");
    expect(text).toContain("public");
    expect(text).toContain("unlisted");
    expect(text).toContain("show_source");
    expect(text).toContain("manifest");
    expect(text).toContain("entry");
  });

  it("GET /admin/edit/:id returns the edit form pre-filled with page details", async () => {
    const db = env.DB;
    const pageId = "page000003";
    await insertPage(db, {
      id: pageId,
      slug: "edit-me",
      title: "Edit Me",
      kind: "html",
      visibility: "public",
      show_source: 0,
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: "pages/page000003/1/index.html",
      content_type: "text/html; charset=utf-8",
      size: 500,
    });
    await insertFile(db, {
      page_id: pageId,
      path: "style.css",
      r2_key: "pages/page000003/1/style.css",
      content_type: "text/css",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("Edit Me");
    expect(text).toContain("edit-me");
    expect(text).toContain("page000003");
    expect(text).toContain("index.html");
    expect(text).toContain("style.css");
    expect(text).toContain("/api/pages/page000003");
    expect(text).toContain("/api/pages/page000003/files");
  });

  it("upload form displays the API message verbatim (body.message || body.error) — T1/OQ-15", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("body.message || body.error || 'Upload failed'");
  });

  it("edit form displays the API message verbatim (data.message || data.error) — T1/OQ-15", async () => {
    const db = env.DB;
    const pageId = "page000004";
    await insertPage(db, { id: pageId, slug: "msg", title: "Msg", kind: "html" });
    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data.message || data.error || 'Update failed'");
  });

  it("edit page delete handlers show the public message, not the code (data.message || data.error) — T1/OQ-15", async () => {
    const db = env.DB;
    const pageId = "page000005";
    await insertPage(db, { id: pageId, slug: "del", title: "Del", kind: "html" });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: "pages/page000005/1/index.html",
      content_type: "text/html; charset=utf-8",
      size: 100,
    });
    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Both alert handlers — delete-file and delete-page — must prefer the public
    // message over the raw error code (F1: delete-page showed data.error only).
    const deleteAlerts =
      text.split("alert(data.message || data.error || 'Delete failed')").length - 1;
    expect(deleteAlerts).toBe(2);
  });

  it("edit page splits add-files into a multiple-only picker and a separate folder picker", async () => {
    const db = env.DB;
    const pageId = "page000006";
    await insertPage(db, {
      id: pageId,
      slug: "split-picker",
      title: "Split Picker",
      kind: "html",
      visibility: "public",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html; charset=utf-8",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // AC3: #add-files picks loose files (multiple, no webkitdirectory)…
    const addFilesTag = text.match(/<input[^>]*\bid="add-files"[^>]*>/)?.[0] ?? "";
    expect(addFilesTag).toContain("multiple");
    expect(addFilesTag).not.toContain("webkitdirectory");
    // …while a separate #add-folder picker keeps folder upload (relative paths).
    const addFolderTag = text.match(/<input[^>]*\bid="add-folder"[^>]*>/)?.[0] ?? "";
    expect(addFolderTag).toContain("multiple");
    expect(addFolderTag).toContain("webkitdirectory");
    // The add-files form script reads the union of both pickers.
    expect(text).toContain("getElementById('add-folder')");
    expect(text).toContain("concat(Array.from(addFolderInput.files || []))");
    // Empty-union guard message is regression-pinned.
    expect(text).toContain("Choose at least one file or folder.");
  });

  it("GET /admin/edit/:id returns 404 for a missing page", async () => {
    const res = await fetchAdmin("/admin/edit/missing00", await validToken());
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET /admin/edit/:id with an invalid id format returns 400", async () => {
    const res = await fetchAdmin("/admin/edit/bad.id", await validToken());
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "invalid_id", message: "Invalid page id." });
  });

  it("GET /admin/edit/:id/ with trailing slash returns the edit form", async () => {
    const db = env.DB;
    const pageId = "page000004";
    await insertPage(db, {
      id: pageId,
      slug: "trailing",
      title: "Trailing Slash",
      kind: "html",
      visibility: "public",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html; charset=utf-8",
      size: 200,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}/`, await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("Trailing Slash");
  });

  it("GET /admin/upload/ with trailing slash returns the upload form", async () => {
    const res = await fetchAdmin("/admin/upload/", await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("Upload a page");
    expect(text).toContain('action="/api/pages"');
    expect(text).toContain('href="/admin"');
  });

  it("dashboard with pages does not show the empty-state CTA", async () => {
    const db = env.DB;
    await insertPage(db, {
      id: "page000005",
      slug: "non-empty",
      title: "Non Empty",
      kind: "html",
      created_at: "2026-01-03T00:00:00.000Z",
      updated_at: "2026-01-03T00:00:00.000Z",
    });

    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Non Empty");
    expect(text).not.toContain("Upload your first page");
    expect(text).not.toContain("No pages yet");
  });

  it("upload form contains the inline entry-picker script logic", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    const text = await res.text();
    expect(text).toContain("documentExts");
    expect(text).toContain("function isDocument(name)");
    expect(text).toContain("function isImage(name)");
    expect(text).toContain("function updateEntryPicker()");
    expect(text).toContain("function selectedFiles()");
    expect(text).toContain("entry-field");
    expect(text).toContain('id="entry"');
    // AC4: the inline script reads the UNION of both pickers, not #files alone.
    expect(text).toContain("getElementById('files')");
    expect(text).toContain("getElementById('folder')");
    expect(text).toContain("concat(Array.from(folderInput.files || []))");
    // Empty-union guard message is regression-pinned.
    expect(text).toContain("Choose at least one file or folder.");
  });

  it("dashboard displays the verified email from the Access token", async () => {
    const token = await signJwt(
      privateKey,
      "access-key-1",
      buildAccessPayload({ email: "operator@pagelively.test" }),
    );
    const res = await fetchAdmin("/admin", token);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("operator@pagelively.test");
  });

  it("T2 AC6/7: edit page hides Delete buttons for protected entry files and shows a hint", async () => {
    const db = env.DB;
    const cases: Array<{
      pageId: string;
      kind: string;
      entryPath: string;
      rawMdPath?: string | null;
      protectedPaths: string[];
      unprotectedPaths: string[];
    }> = [
      {
        pageId: "page0000mdui",
        kind: "markdown",
        entryPath: "index.html",
        rawMdPath: "source.md",
        protectedPaths: ["index.html", "source.md"],
        unprotectedPaths: ["style.css"],
      },
      {
        pageId: "page0000htmlui",
        kind: "html",
        entryPath: "index.html",
        protectedPaths: ["index.html"],
        unprotectedPaths: ["script.js"],
      },
      {
        pageId: "page0000imgui",
        kind: "image",
        entryPath: "photo.jpg",
        protectedPaths: ["photo.jpg"],
        unprotectedPaths: ["thumb.png"],
      },
    ];

    for (const c of cases) {
      await insertPage(db, {
        id: c.pageId,
        slug: `edit-${c.kind}`,
        title: `${c.kind} edit`,
        kind: c.kind,
        entry_path: c.entryPath,
        raw_md_path: c.rawMdPath ?? null,
        visibility: "public",
      });
      const allPaths = [...c.protectedPaths, ...c.unprotectedPaths];
      for (const path of allPaths) {
        const contentType = path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".js")
            ? "application/javascript"
            : path.endsWith(".jpg") || path.endsWith(".jpeg")
              ? "image/jpeg"
              : path.endsWith(".png")
                ? "image/png"
                : path.endsWith(".md")
                  ? "text/markdown"
                  : "text/html; charset=utf-8";
        await insertFile(db, {
          page_id: c.pageId,
          path,
          r2_key: `pages/${c.pageId}/1/${path}`,
          content_type: contentType,
          size: 100,
        });
      }

      const res = await fetchAdmin(`/admin/edit/${c.pageId}`, await validToken());
      expect(res.status).toBe(200);
      const text = await res.text();

      for (const path of c.protectedPaths) {
        expect(text).not.toContain(
          `data-delete-file="/api/pages/${c.pageId}/files/${encodeURIComponent(path)}"`,
        );
      }
      for (const path of c.unprotectedPaths) {
        expect(text).toContain(
          `data-delete-file="/api/pages/${c.pageId}/files/${encodeURIComponent(path)}"`,
        );
      }
      expect(text).toContain(
        "Rendered page files are protected — use Delete page above to remove the page.",
      );
      expect(text).toContain(`data-delete="/api/pages/${c.pageId}"`);
    }
  });
});
