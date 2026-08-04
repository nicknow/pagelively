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
    password_hash?: string | null;
    created_at?: string;
    updated_at?: string;
  },
) {
  const now = new Date().toISOString();
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
    expect(text).toContain("Preserves relative paths");
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

  it("edit page delete handlers use showToast instead of alert for API errors — T1/OQ-15", async () => {
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
    // Delete-file and delete-page handlers both use the shared toast helper and
    // keep the public message precedence (data.message || data.error || ...).
    expect(text).toContain("function showToast(");
    expect(text).toContain("showToast(data.message || data.error || 'Delete failed', 'error');");
    expect(text).toContain("confirm('Delete this file?')");
    expect(text).toContain("confirm('Delete this page and all its files? This cannot be undone.')");
    expect(text).not.toContain("alert(");
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

  it("upload page has a Paste content tab with textarea, format radios, and publish button", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Paste content");
    expect(text).toContain('id="paste-content"');
    expect(text).toContain('name="content"');
    expect(text).toContain('type="radio"');
    expect(text).toContain('name="paste-format"');
    expect(text).toContain('value="html"');
    expect(text).toContain('value="markdown"');
    expect(text).toContain('id="publish-paste"');
    expect(text).toContain('action="/api/pages"');
  });

  it("upload page defaults paste format to Markdown", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    const text = await res.text();
    const markdownRadio =
      text.match(/<input[^>]*\bname="paste-format"[^>]*\bvalue="markdown"[^>]*>/)?.[0] ?? "";
    expect(markdownRadio).toContain("checked");
    const htmlRadio =
      text.match(/<input[^>]*\bname="paste-format"[^>]*\bvalue="html"[^>]*>/)?.[0] ?? "";
    expect(htmlRadio).not.toContain("checked");
  });

  it("paste form posts JSON to /api/pages", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    const text = await res.text();
    expect(text).toContain("'Content-Type': 'application/json'");
    expect(text).toContain("JSON.stringify(");
    expect(text).toContain("content: pasteContent.value");
    expect(text).toContain("format: pasteFormat");
    expect(text).toContain("method: 'POST'");
    expect(text).toContain("/api/pages");
  });

  it("paste form surfaces errors in the same #upload-error box", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    const text = await res.text();
    expect(text).toContain('id="upload-error"');
    expect(text).toContain("body.message || body.error || 'Publish failed'");
  });

  it("upload page enforces that either files or paste content is provided, not both", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    const text = await res.text();
    expect(text).toContain("Provide either files or paste content");
    expect(text).toContain("files.length === 0 && pasteContent.value.trim() === ''");
    expect(text).toContain("files.length > 0 && pasteContent.value.trim() !== ''");
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
    // Empty-union guard message is regression-pinned (now unified with paste).
    expect(text).toContain("Provide either files or paste content.");
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
      expect(text).toContain("Protected");
      for (const path of c.protectedPaths) {
        const row =
          text.match(new RegExp(`<li[^>]*>.*?${path.replace(/\./g, "\\.")}.*?</li>`, "s"))?.[0] ??
          "";
        expect(row).toContain("Protected");
      }
    }
  });

  it("T3: layout includes a toast container for non-blocking notifications", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('id="toast-container"');
    expect(text).toContain('role="status"');
    expect(text).toContain("function showToast(");
  });

  it("T3: dashboard delete handler uses showToast instead of alert for API errors", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("showToast(body.message || body.error || 'Delete failed', 'error');");
    expect(text).toContain("confirm('Delete this page and all its files? This cannot be undone.')");
    expect(text).not.toContain("alert(");
  });

  it("T3: upload and edit pages include slug previews below the slug input", async () => {
    const uploadRes = await fetchAdmin("/admin/upload", await validToken());
    const uploadText = await uploadRes.text();
    expect(uploadText).toContain('id="slug-preview"');
    expect(uploadText).toContain('id="slug"');
    expect(uploadText).toContain('id="paste-slug-preview"');
    expect(uploadText).toContain('id="paste-slug"');
    expect(uploadText).toContain("function updateSlugPreview(");

    const db = env.DB;
    const pageId = "page0000slug";
    await insertPage(db, { id: pageId, slug: "my-page", title: "My Page", kind: "html" });
    const editRes = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    const editText = await editRes.text();
    expect(editText).toContain('id="edit-slug-preview"');
    expect(editText).toContain('id="edit-slug"');
    expect(editText).toContain("function updateSlugPreview(");
  });

  it("T3: CSS uses design tokens and has no inline style attributes", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toMatch(/:root\s*\{/);
    expect(text).toMatch(/--color-bg:/);
    expect(text).toMatch(/--color-primary:/);
    expect(text).toMatch(/--color-surface:/);
    expect(text).toMatch(/@media\s*\(max-width:/);
    expect(text).not.toContain("style=");
  });

  it("T3: upload page has visually distinct tabs with ARIA attributes", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    const text = await res.text();
    expect(text).toContain('data-tab="upload"');
    expect(text).toContain('data-tab="paste"');
    expect(text).toContain('role="tab"');
    expect(text).toContain("Upload files");
    expect(text).toContain("Paste content");
  });

  it("T3: dashboard shows kind and visibility badges", async () => {
    const db = env.DB;
    await insertPage(db, {
      id: "page0000html",
      slug: "hello",
      title: "Hello",
      kind: "html",
      visibility: "public",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await insertPage(db, {
      id: "page0000md",
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
    expect(text).toMatch(/class="[^"]*badge kind[^"]*"/);
    expect(text).toMatch(/class="[^"]*badge visibility[^"]*"/);
    expect(text).toContain("kind-html");
    expect(text).toContain("kind-markdown");
    expect(text).toContain("visibility-public");
    expect(text).toContain("visibility-unlisted");
  });

  it("T3: dashboard empty state is friendly and includes the Upload CTA", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("No pages yet");
    expect(text).toContain("Upload your first page");
    expect(text).toContain('href="/admin/upload"');
  });

  it("S23: upload form has a password input and the CDN-bypass notice", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    const text = await res.text();
    expect(text).toContain('type="password"');
    expect(text).toContain('id="password"');
    expect(text).toContain('minlength="5"');
    expect(text).toContain("All access will bypass the CDN which may increase usage.");
    expect(text).toContain('id="password-notice"');
    expect(text).toContain('style="display:none"');
    // Password is included in the manifest JSON
    expect(text).toContain("password: pwd || undefined");
  });

  it("S23: paste form has a password input and the CDN-bypass notice", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    const text = await res.text();
    expect(text).toContain('id="paste-password"');
    expect(text).toContain('minlength="5"');
    expect(text).toContain("All access will bypass the CDN which may increase usage.");
    expect(text).toContain('id="paste-password-notice"');
    expect(text).toContain("password: pastePwd || undefined");
  });

  it("S23: edit page for a password-protected page shows 'Password: set' and the CDN-bypass notice", async () => {
    const db = env.DB;
    const pageId = "page0000pwui";
    await insertPage(db, {
      id: pageId,
      slug: "pw-page",
      title: "PW Page",
      kind: "html",
      password_hash: "pbkdf2$10000$salt$hash",
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
    expect(text).toContain("Password:</strong> set");
    expect(text).toContain("All access will bypass the CDN which may increase usage.");
    expect(text).toContain('id="clear-password"');
    expect(text).toContain('id="edit-password"');
    expect(text).toContain('id="edit-password-notice"');
  });

  it("S23: edit page for an unprotected page shows no password state or clear control", async () => {
    const db = env.DB;
    const pageId = "page0000nopw";
    await insertPage(db, {
      id: pageId,
      slug: "no-pw",
      title: "No PW",
      kind: "html",
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
    expect(text).not.toContain("Password:</strong> set");
    expect(text).not.toContain("clear-password");
  });

  it("T3: edit page surfaces a protected badge for entry files and a delete button for assets", async () => {
    const db = env.DB;
    const pageId = "page0000prot";
    await insertPage(db, {
      id: pageId,
      slug: "md-prot",
      title: "MD Prot",
      kind: "markdown",
      entry_path: "index.html",
      raw_md_path: "source.md",
    });
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
    await insertFile(db, {
      page_id: pageId,
      path: "style.css",
      r2_key: `pages/${pageId}/1/style.css`,
      content_type: "text/css",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Protected");
    const indexRow = text.match(/<li[^>]*>.*?index\.html.*?<\/li>/s)?.[0] ?? "";
    expect(indexRow).toContain("Protected");
    expect(indexRow).not.toContain("data-delete-file");
    const sourceRow = text.match(/<li[^>]*>.*?source\.md.*?<\/li>/s)?.[0] ?? "";
    expect(sourceRow).toContain("Protected");
    expect(sourceRow).not.toContain("data-delete-file");
    const cssRow = text.match(/<li[^>]*>.*?style\.css.*?<\/li>/s)?.[0] ?? "";
    expect(cssRow).toContain("data-delete-file");
  });

  it("T3: upload page keeps all existing form fields and shared error box", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('id="files"');
    expect(text).toContain('id="folder"');
    expect(text).toContain('id="paste-content"');
    expect(text).toContain('name="content"');
    expect(text).toContain('name="paste-format"');
    expect(text).toContain('id="upload-error"');
    expect(text).toContain("multipart/form-data");
    expect(text).toContain('action="/api/pages"');
    expect(text).toContain('id="title"');
    expect(text).toContain('id="show_source"');
    expect(text).toContain("Provide either files or paste content");
  });

  it("T3: shared script helpers are defined before inline page scripts call them", async () => {
    const uploadRes = await fetchAdmin("/admin/upload", await validToken());
    const uploadText = await uploadRes.text();
    const helperDef = uploadText.indexOf("function initSlugPreview(");
    const uploadCall = uploadText.indexOf("initSlugPreview('slug'");
    expect(helperDef).toBeGreaterThan(-1);
    expect(uploadCall).toBeGreaterThan(-1);
    expect(helperDef).toBeLessThan(uploadCall);

    const db = env.DB;
    const pageId = "page0000order";
    await insertPage(db, { id: pageId, slug: "order", title: "Order", kind: "html" });
    const editRes = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    const editText = await editRes.text();
    const editHelperDef = editText.indexOf("function initSlugPreview(");
    const editCall = editText.indexOf("initSlugPreview('edit-slug'");
    expect(editHelperDef).toBeGreaterThan(-1);
    expect(editCall).toBeGreaterThan(-1);
    expect(editHelperDef).toBeLessThan(editCall);
  });

  // ── WI-1: HTML escaping adversarial test coverage ────────────────────────

  it("WI-1: dashboard escapes HTML in page title (XSS prevention)", async () => {
    const db = env.DB;
    const maliciousTitle = '<script>alert(1)</script>';
    await insertPage(db, {
      id: "page000xss1",
      slug: "xss-test",
      title: maliciousTitle,
      kind: "html",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Must contain the escaped form, not the raw tag
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).not.toContain("<script>alert(1)</script>");
  });

  it("WI-1: dashboard escapes HTML in slug containing double quotes", async () => {
    const db = env.DB;
    await insertPage(db, {
      id: "page000xss2",
      slug: 'test"onclick="evil',
      title: "Quoted Slug",
      kind: "html",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // The slug value should be entity-escaped in the rendered HTML
    expect(text).toContain("&quot;");
    expect(text).not.toContain('test"onclick=');
  });

  it("WI-1: edit view escapes HTML in page title (XSS prevention)", async () => {
    const db = env.DB;
    const maliciousTitle = '<script>alert(1)</script>';
    const pageId = "page000xss3";
    await insertPage(db, {
      id: pageId,
      slug: "xss-edit",
      title: maliciousTitle,
      kind: "html",
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
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).not.toContain("<script>alert(1)</script>");
  });

  // ── WI-11: empty-id-segment edge case for /admin/edit/ ───────────────────

  it("WI-11: GET /admin/edit/ (empty segment) returns 404 (unknown admin path — trailing slash stripped to /admin/edit)", async () => {
    const res = await fetchAdmin("/admin/edit/", await validToken());
    // The router strips the trailing slash, producing /admin/edit which does not
    // match the startsWith("/admin/edit/") guard in index.ts, so it falls through
    // to the "unknown admin path" handler that returns a clean 404.
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  // ── WI-19: null-slug rendering in admin UI ───────────────────────────────

  it("WI-19: dashboard renders a page with null slug without error", async () => {
    const db = env.DB;
    await insertPage(db, {
      id: "page000null",
      slug: null,
      title: "Null Slug Page",
      kind: "html",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Page title should be rendered
    expect(text).toContain("Null Slug Page");
    // Null slug → view URL should use the /p/:id/ fallback (not a slug-based URL)
    expect(text).toContain("/p/page000null/");
  });

  it("WI-19: edit view renders a page with null slug without error", async () => {
    const db = env.DB;
    const pageId = "page000null2";
    await insertPage(db, {
      id: pageId,
      slug: null,
      title: "Null Slug Edit",
      kind: "html",
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
    expect(text).toContain("Null Slug Edit");
    // Slug value attribute should be empty (null → "" fallback)
    expect(text).toContain('value=""');
  });
});
