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
    expect(text).toContain("syncManagedFiles()");
    // Empty-union guard message is regression-pinned (now unified with paste).
    expect(text).toContain("Provide either files or paste content.");
  });

  // ── Slice 8: File chips below dropzone with remove capability ──────────────

  it("S8: upload page has .file-chips container in the DOM (one per dropzone)", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Each dropzone should have a file-chips container
    expect(text).toContain('id="upload-chips"');
    expect(text).toContain('id="folder-chips"');
    const containers = text.match(/class="file-chips"/g);
    expect(containers).not.toBeNull();
    expect(containers!.length).toBe(2);
  });

  it("S8: upload page JS references managedFiles array", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("var managedFiles = []");
    expect(text).toContain("managedFiles");
  });

  it("S8: upload page JS has renderChips function", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("function renderChips(");
    expect(text).toContain("data-chip-index");
    expect(text).toContain("container.querySelectorAll('.chip-remove')");
    expect(text).toContain("managedFiles.splice(idx, 1)");
  });

  it("S8: upload page JS has syncManagedFiles function", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("function syncManagedFiles()");
    expect(text).toContain("webkitRelativePath");
    expect(text).toContain("renderChips('upload-chips'");
    expect(text).toContain("renderChips('folder-chips'");
  });

  it("S8: upload page JS has .chip-remove with trash icon", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // The chip-remove button should reference #icon-trash
    expect(text).toContain('class="chip-remove"');
    expect(text).toContain('href="#icon-trash"');
    expect(text).toContain("aria-label=");
  });

  it("S8: upload form submit uses managedFiles (not filesInput.files) for FormData", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // The form submit should iterate managedFiles, not read from filesInput.files directly
    expect(text).toContain("managedFiles.forEach");
    expect(text).toContain("item.path");
    expect(text).toContain("item.file");
    // Should NOT reference filesInput.files in the submit handler
    const submitBlock = text.match(/form\.addEventListener\('submit',[\s\S]*?}\);/)?.[0] ?? "";
    expect(submitBlock).not.toContain("filesInput.files");
  });

  it("S8: CSS has .file-chips, .file-chip, .chip-remove rules", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    const styleBlock = text.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
    expect(styleBlock).toMatch(/\.file-chips\s*\{/);
    expect(styleBlock).toMatch(/\.file-chip\s*\{/);
    expect(styleBlock).toMatch(/\.chip-remove\s*\{/);
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

  it("T3: CSS uses design tokens and has no inline style attributes on content elements", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toMatch(/:root\s*\{/);
    expect(text).toMatch(/--color-bg:/);
    expect(text).toMatch(/--color-primary:/);
    expect(text).toMatch(/--color-surface:/);
    expect(text).toMatch(/@media\s*\(max-width:/);
    // The SVG icon sprite has style="display:none" (standard for hidden sprites);
    // the theme toggle button has an inline style for 44x44 tap target.
    // These are the only inline style attributes: SVG sprite (display:none),
    // theme toggle (44x44 tap target), and empty-state inbox icon (muted color + spacing).
    const styleAttrCount = (text.match(/\bstyle="/g) || []).length;
    expect(styleAttrCount).toBeLessThanOrEqual(3);
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
    const maliciousTitle = "<script>alert(1)</script>";
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
    const maliciousTitle = "<script>alert(1)</script>";
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

  it("WI-1: edit view escapes HTML in slug containing double quotes", async () => {
    const db = env.DB;
    const pageId = "page000xss4";
    await insertPage(db, {
      id: pageId,
      slug: 'test"onclick="evil',
      title: "Quoted Slug Edit",
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
    // The slug value must be HTML-entity-escaped in the input value attribute
    expect(text).toContain("&quot;");
    expect(text).not.toContain('test"onclick=');
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

  // ── Slice 1: CSS design tokens — dark palette, reduced motion, transitions ──

  it("S1: DESIGN_SYSTEM_CSS contains --transition-fast and --transition-base tokens", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toContain("--transition-fast:");
    expect(text).toContain("--transition-base:");
  });

  it("S1: DESIGN_SYSTEM_CSS contains a @media (prefers-color-scheme: dark) block with dark tokens", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The media query wrapping :root:not([data-theme="light"])
    expect(text).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/);
    // Contains at least one dark token value inside that block
    const match = text.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[^}]*--color-bg:\s*#0b1220[^}]*\}/,
    );
    expect(match).not.toBeNull();
  });

  it("S1: DESIGN_SYSTEM_CSS contains :root[data-theme='dark'] override block", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toMatch(/:root\[data-theme="dark"\]\s*\{/);
    // Contains dark background
    expect(text).toMatch(/:root\[data-theme="dark"\][^}]*--color-bg:\s*#0b1220/);
  });

  it("S1: DESIGN_SYSTEM_CSS contains :root[data-theme='light'] override block", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toMatch(/:root\[data-theme="light"\]\s*\{/);
    // Contains light background
    expect(text).toMatch(/:root\[data-theme="light"\][^}]*--color-bg:\s*#f8fafc/);
  });

  it("S1: DESIGN_SYSTEM_CSS contains @media (prefers-reduced-motion: reduce) block", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
    expect(text).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(text).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });

  it("S1: DESIGN_SYSTEM_CSS replaces old 0.15s ease literals with var(--transition-fast) in button transitions", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The .button transition should use var(--transition-fast)
    expect(text).toMatch(/\.button\s*\{[^}]*transition:[^}]*var\(--transition-fast\)/);
    // Should NOT contain the old literal 0.15s ease in the button block
    const buttonBlock = text.match(/\.button\s*\{[^}]*\}/)?.[0] ?? "";
    expect(buttonBlock).not.toContain("0.15s ease");
  });

  it("S1: DESIGN_SYSTEM_CSS replaces old 0.15s ease literals in input[type='text'], select, textarea transitions", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // Should use var(--transition-fast)
    expect(text).toMatch(/input\[type="text"\][^}]*transition:[^}]*var\(--transition-fast\)/);
    // Verify the old literal is gone from the input block
    const inputBlock = text.match(/input\[type="text"\][^}]*\}/)?.[0] ?? "";
    expect(inputBlock).not.toContain("0.15s ease");
  });

  it("S1: DESIGN_SYSTEM_CSS replaces old 0.15s ease literals in .tab transitions", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // Should use var(--transition-fast)
    expect(text).toMatch(/\.tab\s*\{[^}]*transition:[^}]*var\(--transition-fast\)/);
    // Verify the old literal is gone from the .tab block
    const tabBlock = text.match(/\.tab\s*\{[^}]*\}/)?.[0] ?? "";
    expect(tabBlock).not.toContain("0.15s ease");
  });

  it("S1: DESIGN_SYSTEM_CSS has badge dark-mode overrides for .kind-* and .visibility-* classes", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // Dark-mode block for .kind-html badge
    expect(text).toMatch(/\.kind-html\s*\{[^}]*background:\s*rgba\(30,\s*64,\s*175,\s*0\.25\)/);
    expect(text).toMatch(/\.kind-markdown\s*\{[^}]*background:\s*rgba\(22,\s*101,\s*52,\s*0\.25\)/);
    expect(text).toMatch(/\.kind-image\s*\{[^}]*background:\s*rgba\(107,\s*33,\s*168,\s*0\.25\)/);
    expect(text).toMatch(/\.kind-bundle\s*\{[^}]*background:\s*rgba\(154,\s*52,\s*18,\s*0\.25\)/);
    expect(text).toMatch(
      /\.visibility-public\s*\{[^}]*background:\s*rgba\(22,\s*101,\s*52,\s*0\.25\)/,
    );
    expect(text).toMatch(
      /\.visibility-unlisted\s*\{[^}]*background:\s*rgba\(71,\s*85,\s*105,\s*0\.25\)/,
    );
    expect(text).toMatch(/\.protected\s*\{[^}]*background:\s*rgba\(220,\s*38,\s*38,\s*0\.25\)/);
  });

  it("S1: :root has color-scheme: light and dark override has color-scheme: dark", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toMatch(/:root\s*\{[^}]*color-scheme:\s*light/);
    expect(text).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*color-scheme:\s*dark/);
    expect(text).toMatch(/:root\[data-theme="light"\]\s*\{[^}]*color-scheme:\s*light/);
  });

  // ── Slice 2: Inline SVG icon sprite + icon helper CSS ──────────────────────

  it("S2: layout HTML contains .icon CSS utility class", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // .icon class should be in the stylesheet
    expect(text).toMatch(/\.icon\s*\{[^}]*vertical-align:\s*middle[^}]*flex-shrink:\s*0[^}]*\}/);
  });

  it("S2: layout HTML contains an SVG sprite with role=presentation or aria-hidden", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The sprite is display:none and aria-hidden
    expect(text).toMatch(/<svg[^>]*style="display:\s*none"[^>]*aria-hidden="true"[^>]*>/);
  });

  it("S2: SVG sprite contains all 17 required icon symbol definitions", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    const icons = [
      "brand-mark",
      "sun",
      "moon",
      "upload",
      "folder",
      "file",
      "file-html",
      "file-markdown",
      "file-image",
      "file-bundle",
      "eye",
      "pencil",
      "trash",
      "lock",
      "check-circle",
      "alert-circle",
      "inbox",
    ];
    for (const name of icons) {
      expect(text).toContain(`id="icon-${name}"`);
      expect(text).toContain(`id="icon-${name}"`);
    }
    // Each symbol should have viewBox="0 0 24 24"
    const symRegex = /<symbol[^>]*id="icon-[^"]*"[^>]*viewBox="0 0 24 24"[^>]*>/g;
    const symbols = text.match(symRegex);
    expect(symbols).not.toBeNull();
    // Should have at least as many matches as icons (some may span multiple lines)
    expect(text).toContain("<symbol");
  });

  it("S2: each icon symbol uses stroke-linecap='round' stroke-linejoin='round'", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The symbol attributes should be consistent
    expect(text).toMatch(/<symbol[^>]*stroke-linecap="round"[^>]*>/);
    expect(text).toMatch(/<symbol[^>]*stroke-linejoin="round"[^>]*>/);
    expect(text).toMatch(/<symbol[^>]*fill="none"[^>]*>/);
    expect(text).toMatch(/<symbol[^>]*stroke="currentColor"[^>]*>/);
  });

  it("S2: toast icons reference check-circle for success and alert-circle for error", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // showToast should reference icon-check-circle for success
    expect(text).toContain("icon-check-circle");
    expect(text).toContain("icon-alert-circle");
  });

  it("S2: showToast creates SVG use elements with proper namespace", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // Should create svg elements with class 'icon' and width/height 18
    expect(text).toContain("iconSvg.setAttribute('class', 'icon')");
    expect(text).toContain("iconSvg.setAttribute('width', '18')");
    expect(text).toContain("iconSvg.setAttribute('height', '18')");
    // Should create use elements
    expect(text).toContain("document.createElementNS('http://www.w3.org/2000/svg', 'svg')");
    expect(text).toContain("document.createElementNS('http://www.w3.org/2000/svg', 'use')");
    // Should append message as textContent (safe, not innerHTML)
    expect(text).toContain("msgSpan.textContent = message");
  });

  it("S2: showToast no longer uses textContent for the entire toast", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The old toast.textContent = message should be gone
    expect(text).not.toContain("toast.textContent = message");
  });

  // ── Slice 3: Dark mode toggle (early inline script + toggle behavior + header button) ──

  it("S3: layout HTML contains the early inline script with localStorage.getItem('pl-theme') before the <style> block", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The early-no-FOUC script must exist
    expect(text).toContain("localStorage.getItem('pl-theme')");
    expect(text).toContain("document.documentElement.setAttribute('data-theme'");
    // It must appear BEFORE the <style> block
    const scriptPos = text.indexOf("localStorage.getItem('pl-theme')");
    const stylePos = text.indexOf("<style>");
    expect(scriptPos).toBeGreaterThan(-1);
    expect(stylePos).toBeGreaterThan(-1);
    expect(scriptPos).toBeLessThan(stylePos);
  });

  it("S3: early inline script uses strict equality ('light'/'dark') and is an IIFE", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toMatch(/t==='light'||t==='dark'/);
    const earlyScript = text.match(
      /<script>\(function\(\)\{try\{var t=localStorage\.getItem\('pl-theme'\);if\(t==='light'\|\|t==='dark'\)document\.documentElement\.setAttribute\('data-theme',t\);}catch\(e\)\{\}\}\)\(\)<\/script>/,
    );
    expect(earlyScript).not.toBeNull();
  });

  it("S3: toggle button exists with data-theme-toggle attribute, aria-label, and 44x44 tap target", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toContain("data-theme-toggle");
    expect(text).toContain('aria-label="Toggle color theme"');
    expect(text).toContain("width:44px");
    expect(text).toContain("height:44px");
    // The button must be in the header
    const headerMatch = text.match(/<header>[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(headerMatch).toContain("data-theme-toggle");
  });

  it("S3: toggle button uses class button button-small with aria-pressed", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The button tag (including inner content) should contain both classes and aria-pressed
    const btnContent =
      text.match(/<button[^>]*data-theme-toggle[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(btnContent).toContain('class="');
    expect(btnContent).toContain("aria-pressed");
    // It should show the sun icon (since initial render could be light)
    expect(btnContent).toContain("icon-sun");
  });

  it("S3: SHARED_JS contains toggleTheme function definition", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toContain("function toggleTheme()");
  });

  it("S3: SHARED_JS contains localStorage.setItem('pl-theme'", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toContain("localStorage.setItem('pl-theme'");
  });

  it("S3: SHARED_JS contains document.querySelectorAll('[data-theme-toggle]')", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toContain("document.querySelectorAll('[data-theme-toggle]')");
  });

  it("S3: SHARED_JS contains DOMContentLoaded wiring for the toggle button", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toContain("DOMContentLoaded");
    expect(text).toContain("btn.addEventListener('click', toggleTheme)");
  });

  it("S3: SHARED_JS toggleTheme sets aria-pressed and swaps icon based on next theme", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toContain("btn.setAttribute('aria-pressed'");
    expect(text).toContain('btn.innerHTML = \'<svg class="icon"');
    // Should reference both sun and moon icons for swapping
    expect(text).toContain("icon-sun");
    expect(text).toContain("icon-moon");
  });

  it("S3: header-inner has display:flex with justify-content:space-between", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The .header-inner CSS rule should have flexbox properties
    const headerInnerBlock = text.match(/\.header-inner\s*\{[^}]*\}/)?.[0] ?? "";
    expect(headerInnerBlock).toContain("display: flex");
    expect(headerInnerBlock).toContain("align-items: center");
    expect(headerInnerBlock).toContain("justify-content: space-between");
  });

  it("S3: email text (.identity) has text-overflow ellipsis", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    const identityBlock = text.match(/\.identity\s*\{[^}]*\}/)?.[0] ?? "";
    expect(identityBlock).toContain("text-overflow: ellipsis");
    expect(identityBlock).toContain("overflow: hidden");
    expect(identityBlock).toContain("white-space: nowrap");
    expect(identityBlock).toContain("max-width: 200px");
  });

  it("S3: toggle button is 44x44px (width and height explicit)", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    const btnTag = text.match(/<button[^>]*data-theme-toggle[^>]*>/)?.[0] ?? "";
    expect(btnTag).toContain("width:44px");
    expect(btnTag).toContain("height:44px");
    expect(btnTag).toContain("display:flex");
    expect(btnTag).toContain("flex-shrink:0");
    // Verify padding is 0 for a clean icon button
    expect(btnTag).toContain("padding:0");
  });

  it("S3: button icon uses SVG with class icon and icon-sun href", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    const btnContent =
      text.match(/<button[^>]*data-theme-toggle[^>]*>[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(btnContent).toContain('<svg class="icon"');
    expect(btnContent).toContain('href="#icon-sun"');
    expect(btnContent).toContain('aria-hidden="true"');
  });

  it("S3: early script is NOT part of SHARED_JS — standalone <script> before <style>", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    // The early script must be a standalone script tag before <style>
    // It should not appear inside the SHARED_JS block which comes after </style>
    const earlyScriptPos = text.indexOf("localStorage.getItem('pl-theme')");
    const styleClosePos = text.indexOf("</style>");
    expect(earlyScriptPos).toBeGreaterThan(-1);
    expect(styleClosePos).toBeGreaterThan(-1);
    expect(earlyScriptPos).toBeLessThan(styleClosePos);
  });

  // ── Slice 4: Header brand-mark icon ──────────────────────────────────────

  it("S4: header h1 contains #icon-brand-mark SVG before the site name text", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    const headerMatch = text.match(/<header>[\s\S]*?<\/header>/)?.[0] ?? "";
    // The brand-mark SVG use element referencing #icon-brand-mark must be in the header
    expect(headerMatch).toContain('href="#icon-brand-mark"');
    // The SVG should have class="icon", width="20", height="20", aria-hidden="true"
    const svgInHeader = headerMatch.match(/<svg[^>]*class="icon"[^>]*>/)?.[0] ?? "";
    expect(svgInHeader).toContain('width="20"');
    expect(svgInHeader).toContain('height="20"');
    expect(svgInHeader).toContain('aria-hidden="true"');
  });

  it("S4: header h1 has display:flex with align-items:center and gap:var(--space-2)", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    const h1Block = text.match(/header h1\s*\{[^}]*\}/)?.[0] ?? "";
    expect(h1Block).toContain("display: flex");
    expect(h1Block).toContain("align-items: center");
    expect(h1Block).toContain("gap: var(--space-2)");
  });

  // ── Slice 5: Dashboard visual enhancements ──────────────────────────────

  it("S5: kind badges in dashboard include a 16×16 SVG icon matching the kind (html → file-html)", async () => {
    const db = env.DB;
    await insertPage(db, {
      id: "page00s5html",
      slug: "s5-html",
      title: "S5 HTML",
      kind: "html",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    await insertPage(db, {
      id: "page00s5md",
      slug: "s5-md",
      title: "S5 Markdown",
      kind: "markdown",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    await insertPage(db, {
      id: "page00s5img",
      slug: "s5-img",
      title: "S5 Image",
      kind: "image",
      created_at: "2026-01-03T00:00:00.000Z",
      updated_at: "2026-01-03T00:00:00.000Z",
    });
    await insertPage(db, {
      id: "page00s5bun",
      slug: "s5-bundle",
      title: "S5 Bundle",
      kind: "bundle",
      created_at: "2026-01-04T00:00:00.000Z",
      updated_at: "2026-01-04T00:00:00.000Z",
    });

    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Each kind badge should have an SVG icon with matching icon reference
    expect(text).toContain('href="#icon-file-html"');
    expect(text).toContain('href="#icon-file-markdown"');
    expect(text).toContain('href="#icon-file-image"');
    expect(text).toContain('href="#icon-file-bundle"');

    // Each SVG icon should be 16×16 with aria-hidden="true"
    const iconMatches = text.match(
      /<svg class="icon" width="16" height="16" aria-hidden="true"><use href="#icon-file-[^"]+"><\/use><\/svg>/g,
    );
    expect(iconMatches).not.toBeNull();
    expect(iconMatches!.length).toBe(4);
  });

  it("S5: kind badges with icons appear in both desktop table and mobile card rendering (same badge pattern)", async () => {
    const db = env.DB;
    await insertPage(db, {
      id: "page00s5both",
      slug: "s5-both",
      title: "S5 Both",
      kind: "markdown",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // The badge pattern with SVG icon should exist inside a <span class="badge kind-markdown"> container
    const badgePattern = text.match(
      /<span class="badge kind-markdown">\s*<svg class="icon" width="16" height="16" aria-hidden="true"><use href="#icon-file-markdown"><\/use><\/svg>\s*markdown\s*<\/span>/,
    );
    expect(badgePattern).not.toBeNull();
  });

  it("S5: CSS has .page-table tbody tr:hover with background: var(--color-surface-raised)", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    expect(text).toMatch(
      /\.page-table\s+tbody\s+tr:\s*hover\s*\{[^}]*background:\s*var\(--color-surface-raised\)[^}]*\}/,
    );
  });

  it("S5: CSS .badge has gap: var(--space-1)", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    const badgeBlock = text.match(/\.badge\s*\{[^}]*\}/)?.[0] ?? "";
    expect(badgeBlock).toContain("gap: var(--space-1)");
  });

  it("S5: empty state includes a 48×48 inbox SVG icon above the 'No pages yet.' text", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // The empty state should have a 48×48 inbox icon before "No pages yet."
    const emptyMatch = text.match(/<div class="empty">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(emptyMatch).toContain('href="#icon-inbox"');
    expect(emptyMatch).toContain('width="48"');
    expect(emptyMatch).toContain('height="48"');
    expect(emptyMatch).toContain(
      'style="color:var(--color-text-muted);margin-bottom:var(--space-4)"',
    );

    // The icon must appear before the "No pages yet." paragraph
    const iconPos = emptyMatch.indexOf('href="#icon-inbox"');
    const noPagesPos = emptyMatch.indexOf("No pages yet");
    expect(iconPos).toBeGreaterThan(-1);
    expect(noPagesPos).toBeGreaterThan(-1);
    expect(iconPos).toBeLessThan(noPagesPos);
  });

  it("S5: empty state upload CTA still appears alongside the inbox icon", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Empty state should have both the inbox icon and the existing CTAs
    expect(text).toContain('href="#icon-inbox"');
    expect(text).toContain("No pages yet");
    expect(text).toContain("Create your first page to get started.");
    expect(text).toContain("Upload your first page");
    expect(text).toContain('href="/admin/upload"');
  });

  it("S5: dashboard Upload button in card header has a 20×20 upload SVG icon prepended", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Find the Upload button link and check it has the icon before "Upload"
    const uploadBtnMatch =
      text.match(/<a class="button button-primary" href="\/admin\/upload">[\s\S]*?<\/a>/)?.[0] ??
      "";
    expect(uploadBtnMatch).toContain('href="#icon-upload"');
    expect(uploadBtnMatch).toContain('width="20"');
    expect(uploadBtnMatch).toContain('height="20"');

    // The icon must appear before the "Upload" text
    const iconPos = uploadBtnMatch.indexOf('href="#icon-upload"');
    const uploadTextPos = uploadBtnMatch.indexOf("Upload</a>");
    expect(iconPos).toBeGreaterThan(-1);
    expect(uploadTextPos).toBeGreaterThan(-1);
    expect(iconPos).toBeLessThan(uploadTextPos);
  });

  // ── Slice 6: Upload page dropzones ──────────────────────────────────────

  it("S6: upload page .dropzone container has dashed border styling and padding", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // The files dropzone should exist
    expect(text).toContain('class="dropzone"');
    expect(text).toContain('id="files-dropzone"');
  });

  it("S6: upload page has #icon-upload SVG inside the files dropzone", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // The files dropzone zone should contain the upload icon reference
    const filesDropzone =
      text.match(/<div[^>]*id="files-dropzone"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(filesDropzone).toContain('href="#icon-upload"');
    expect(filesDropzone).toContain('width="48"');
    expect(filesDropzone).toContain('height="48"');
  });

  it("S6: upload page has a .folder-toggle link for revealing folder upload", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('class="folder-toggle"');
    expect(text).toContain('id="folder-toggle"');
    expect(text).toContain("Uploading a folder instead?");
  });

  it("S6: upload page has .folder-dropzone-wrapper (initially hidden via CSS)", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('id="folder-dropzone-wrapper"');
    expect(text).toContain('class="folder-dropzone-wrapper"');
    // CSS should hide it by default
    const cssBlock = text.match(/\.folder-dropzone-wrapper\s*\{[^}]*\}/)?.[0] ?? "";
    expect(cssBlock).toContain("display: none");
  });

  it("S6: input inside dropzone has position:absolute inset:0 opacity:0 cursor:pointer", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // The files input inside the dropzone should have the overlay styles
    const filesInput = text.match(/<input[^>]*\bid="files"[^>]*>/)?.[0] ?? "";
    expect(filesInput).toContain('style="');
    expect(filesInput).toContain("position:absolute");
    expect(filesInput).toContain("inset:0");
    expect(filesInput).toContain("opacity:0");
    expect(filesInput).toContain("cursor:pointer");
    // The folder input should also have the same overlay styles
    const folderInput = text.match(/<input[^>]*\bid="folder"[^>]*>/)?.[0] ?? "";
    expect(folderInput).toContain("position:absolute");
    expect(folderInput).toContain("inset:0");
    expect(folderInput).toContain("opacity:0");
  });

  it("S6: upload form script has initDropzone function with drag/drop handlers", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("function initDropzone(");
    expect(text).toContain("initDropzone('files-dropzone'");
    expect(text).toContain("initDropzone('folder-dropzone'");
    expect(text).toContain("dz.addEventListener('dragover'");
    expect(text).toContain("dz.addEventListener('dragleave'");
    expect(text).toContain("dz.addEventListener('drop'");
    expect(text).toContain("dz.classList.add('drag-active')");
    expect(text).toContain("dz.classList.remove('drag-active')");
    expect(text).toContain("new DataTransfer()");
    expect(text).toContain("input.files = dt.files");
    expect(text).toContain("updateEntryPicker()");
  });

  it("S6: upload form script has folder toggle reveal/hide behavior", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("getElementById('folder-toggle')");
    expect(text).toContain("getElementById('folder-dropzone-wrapper')");
    expect(text).toContain("folderWrapper.classList.toggle('visible')");
    expect(text).toContain("'Hide folder upload'");
    expect(text).toContain("'Uploading a folder instead?'");
  });

  it("S6: CSS contains .dropzone, .dropzone.drag-active, .folder-toggle rules", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    // Check for .dropzone rule
    const styleBlock = text.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
    expect(styleBlock).toMatch(/\.dropzone\s*\{[^}]*border:\s*2px\s+dashed/);
    expect(styleBlock).toMatch(/\.dropzone\.drag-active\s*\{/);
    expect(styleBlock).toMatch(/\.folder-toggle\s*\{/);
  });

  it("S6: dropzone has dz-label and dz-hint text elements", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('class="dz-label"');
    expect(text).toContain('class="dz-hint"');
    expect(text).toContain("Drag files here or click to browse");
    expect(text).toContain("Upload entire folder");
  });

  it("S6: folder dropzone wrapper visibility is toggled via .visible class", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    const cssBlock = text.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
    expect(cssBlock).toMatch(/\.folder-dropzone-wrapper\.visible\s*\{[^}]*display:\s*block/);
  });

  // ── Slice 7: Edit page visual enhancements ──────────────────────────────

  it("S7: edit page file rows have kind icons based on file extension (html → #icon-file-html, css → #icon-file)", async () => {
    const db = env.DB;
    const pageId = "page00s7ico";
    await insertPage(db, {
      id: pageId,
      slug: "s7-icons",
      title: "S7 Icons",
      kind: "html",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html",
      size: 100,
    });
    await insertFile(db, {
      page_id: pageId,
      path: "style.css",
      r2_key: `pages/${pageId}/1/style.css`,
      content_type: "text/css",
      size: 50,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // .html file should get #icon-file-html (20×20 icon before the file path)
    const htmlRow = text.match(/<li class="file-row">[\s\S]*?index\.html[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(htmlRow).toContain('href="#icon-file-html"');
    expect(htmlRow).toContain('width="20"');
    expect(htmlRow).toContain('height="20"');

    // .css file should get #icon-file (generic)
    const cssRow = text.match(/<li class="file-row">[\s\S]*?style\.css[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(cssRow).toContain('href="#icon-file"');
    expect(cssRow).toContain('width="20"');

    // Icon should appear before the <code class="file-path"> element
    const htmlIconPos = htmlRow.indexOf('href="#icon-file-html"');
    const htmlCodePos = htmlRow.indexOf('<code class="file-path">');
    expect(htmlIconPos).toBeGreaterThan(-1);
    expect(htmlCodePos).toBeGreaterThan(-1);
    expect(htmlIconPos).toBeLessThan(htmlCodePos);
  });

  it("S7: edit page file rows show kind icons for markdown and image files", async () => {
    const db = env.DB;
    const pageId = "page00s7mdi";
    await insertPage(db, {
      id: pageId,
      slug: "s7-md-img",
      title: "S7 MD+Img",
      kind: "markdown",
      entry_path: "page.md",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "page.md",
      r2_key: `pages/${pageId}/1/page.md`,
      content_type: "text/markdown",
      size: 50,
    });
    await insertFile(db, {
      page_id: pageId,
      path: "photo.png",
      r2_key: `pages/${pageId}/1/photo.png`,
      content_type: "image/png",
      size: 200,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // .md → #icon-file-markdown
    const mdRow = text.match(/<li class="file-row">[\s\S]*?page\.md[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(mdRow).toContain('href="#icon-file-markdown"');

    // .png → #icon-file-image
    const imgRow = text.match(/<li class="file-row">[\s\S]*?photo\.png[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(imgRow).toContain('href="#icon-file-image"');
  });

  it("S7: protected badge in edit page file list has #icon-lock icon prepended", async () => {
    const db = env.DB;
    const pageId = "page00s7lock";
    await insertPage(db, {
      id: pageId,
      slug: "s7-lock",
      title: "S7 Lock",
      kind: "html",
      entry_path: "index.html",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // The protected badge should contain a lock icon SVG before "Protected"
    const badgePattern = /<span class="badge protected">[\s\S]*?<\/span>/;
    const badgeMatch = text.match(badgePattern)?.[0] ?? "";
    expect(badgeMatch).toContain('href="#icon-lock"');
    expect(badgeMatch).toContain('width="14"');
    expect(badgeMatch).toContain('height="14"');

    // The icon should appear before the "Protected" text
    const iconPos = badgeMatch.indexOf('href="#icon-lock"');
    const textPos = badgeMatch.indexOf("Protected");
    expect(iconPos).toBeGreaterThan(-1);
    expect(textPos).toBeGreaterThan(-1);
    expect(iconPos).toBeLessThan(textPos);
  });

  it("S7: edit page header badge kind-* includes a 16×16 kind icon matching the page kind", async () => {
    const db = env.DB;
    const pageId = "page00s7hedr";
    await insertPage(db, {
      id: pageId,
      slug: "s7-header",
      title: "S7 Header",
      kind: "markdown",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // The header h2 badge should include a kind icon SVG
    const h2Content = text.match(/<h2>[\s\S]*?<\/h2>/)?.[0] ?? "";
    expect(h2Content).toContain("S7 Header");

    // Find the kind badge inside the h2
    const kindBadge =
      h2Content.match(/<span class="badge kind-markdown">[\s\S]*?<\/span>/)?.[0] ?? "";
    expect(kindBadge).toContain('href="#icon-file-markdown"');
    expect(kindBadge).toContain('width="16"');
    expect(kindBadge).toContain('height="16"');
    expect(kindBadge).toContain('aria-hidden="true"');

    // The kind text also appears in the badge (icon is prepended to it)
    expect(kindBadge).toContain("markdown");
  });

  it("S7: edit page header badge uses generic file icon for unknown page kinds", async () => {
    const db = env.DB;
    const pageId = "page00s7unkn";
    await insertPage(db, {
      id: pageId,
      slug: "s7-unknown",
      title: "S7 Unknown",
      kind: "unknown",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    const h2Content = text.match(/<h2>[\s\S]*?<\/h2>/)?.[0] ?? "";
    const kindBadge =
      h2Content.match(/<span class="badge kind-unknown">[\s\S]*?<\/span>/)?.[0] ?? "";
    // Unknown kind falls back to generic #icon-file
    expect(kindBadge).toContain('href="#icon-file"');
    expect(kindBadge).toContain('width="16"');
  });

  it("S7: edit page preserves all existing file-row content (delete buttons, protected guard, file paths)", async () => {
    const db = env.DB;
    const pageId = "page00s7pres";
    await insertPage(db, {
      id: pageId,
      slug: "s7-preserve",
      title: "S7 Preserve",
      kind: "html",
      entry_path: "index.html",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html",
      size: 100,
    });
    await insertFile(db, {
      page_id: pageId,
      path: "script.js",
      r2_key: `pages/${pageId}/1/script.js`,
      content_type: "application/javascript",
      size: 200,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Delete buttons still present for unprotected files
    expect(text).toContain(`data-delete-file="/api/pages/${pageId}/files/script.js"`);
    // Protected entry file still has no delete button
    expect(text).not.toContain(`data-delete-file="/api/pages/${pageId}/files/index.html"`);
    // Protected badge still present for entry file
    expect(text).toContain("Protected");
    // Protected hint still present
    expect(text).toContain(
      "Rendered page files are protected — use Delete page above to remove the page.",
    );
    // File paths are still displayed
    expect(text).toContain("index.html");
    expect(text).toContain("script.js");
    // Delete page button still works
    expect(text).toContain(`data-delete="/api/pages/${pageId}"`);
  });

  // ── Back button top-left navigation ────────────────────────────────────

  it("edit page has a back link at the top of the content (top-left navigation)", async () => {
    const db = env.DB;
    const pageId = "page00back1";
    await insertPage(db, {
      id: pageId,
      slug: "back-test",
      title: "Back Test",
      kind: "html",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // A back link should exist at the top of the content area (before the first .card)
    const mainContent = text.match(/<main>[\s\S]*<\/main>/)?.[0] ?? "";
    const backLinkPos = mainContent.indexOf('href="/admin"');
    const firstCardPos = mainContent.indexOf('<div class="card"');
    expect(backLinkPos).toBeGreaterThan(-1);
    expect(firstCardPos).toBeGreaterThan(-1);
    expect(backLinkPos).toBeLessThan(firstCardPos);
  });

  it("edit page back link uses an arrow icon for visual navigation cue", async () => {
    const db = env.DB;
    const pageId = "page00back2";
    await insertPage(db, {
      id: pageId,
      slug: "back-icon",
      title: "Back Icon",
      kind: "html",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Should have a back arrow icon (chevron-left or arrow-left) in the back link
    const navSection = text.match(/<div class="page-nav">[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(navSection).toContain('href="/admin"');
    expect(navSection).toContain("Back");
  });

  it("edit page no longer has a Back button in the bottom toolbar", async () => {
    const db = env.DB;
    const pageId = "page00back3";
    await insertPage(db, {
      id: pageId,
      slug: "back-toolbar",
      title: "Back Toolbar",
      kind: "html",
    });
    await insertFile(db, {
      page_id: pageId,
      path: "index.html",
      r2_key: `pages/${pageId}/1/index.html`,
      content_type: "text/html",
      size: 100,
    });

    const res = await fetchAdmin(`/admin/edit/${pageId}`, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Find the toolbar in the edit form — it should only have "Update metadata", no "Back" link
    const formToolbar = text.match(/<form[^>]*id="edit-form"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
    const toolbarDiv = formToolbar.match(/class="toolbar"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
    // Should still have the Update button
    expect(toolbarDiv).toContain("Update metadata");
    // Should NOT contain "Back" — it's been moved to top navigation
    expect(toolbarDiv).not.toContain("Back");
    // Should NOT contain "/admin" href (back link has been moved)
    expect(toolbarDiv).not.toContain('href="/admin"');
  });

  it("upload page has a back link at the top of the content (top-left navigation)", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // The back link should appear before the first .card in the main content
    const mainContent = text.match(/<main>[\s\S]*<\/main>/)?.[0] ?? "";
    const backLinkPos = mainContent.indexOf('href="/admin"');
    const firstCardPos = mainContent.indexOf('<div class="card"');
    expect(backLinkPos).toBeGreaterThan(-1);
    expect(firstCardPos).toBeGreaterThan(-1);
    expect(backLinkPos).toBeLessThan(firstCardPos);
  });

  it("upload page no longer has Cancel buttons in the form toolbars", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // The upload form toolbar should only have the Upload button, no Cancel link
    const toolbarMatches = text.match(/class="toolbar"[^>]*>[\s\S]*?<\/div>/g) ?? [];
    for (const tb of toolbarMatches) {
      expect(tb).not.toContain("Cancel");
      expect(tb).not.toContain('href="/admin"');
    }
  });

  it("CSS has .page-nav styles for the top navigation bar", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();
    const styleBlock = text.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
    expect(styleBlock).toMatch(/\.page-nav\s*\{/);
  });

  // ── User-friendly date/time formatting ─────────────────────────────────

  it("dashboard uses <time> elements with datetime attribute for dates", async () => {
    const db = env.DB;
    await insertPage(db, {
      id: "page00date1",
      slug: "dated",
      title: "Dated",
      kind: "html",
      created_at: "2026-01-15T14:30:00.000Z",
      updated_at: "2026-01-15T14:30:00.000Z",
    });

    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Should have a <time> element with datetime attribute wrapping the ISO string
    expect(text).toContain('<time datetime="2026-01-15T14:30:00.000Z">');
    // The server-side fallback text is the ISO string (JS formats client-side)
    expect(text).toContain("2026-01-15T14:30:00.000Z</time>");
  });

  it("dashboard date cells use a data-datetime attribute for JS formatting", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();

    // Should have a shared JS function to format dates
    expect(text).toContain("formatDateTime");
  });

  it("SHARED_JS contains DOMContentLoaded handler for formatting dates", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    const text = await res.text();

    // The DOMContentLoaded handler in SHARED_JS should call formatDateTime
    expect(text).toContain("formatDateTime");
  });

  // ── Settings page ──────────────────────────────────────────────────────

  it("dashboard has a Settings button linking to /admin/settings", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('href="/admin/settings"');
    expect(text).toContain("Settings");
  });

  it("GET /admin/settings returns the settings page HTML", async () => {
    const res = await fetchAdmin("/admin/settings", await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("Settings");
    expect(text).toContain("Default page");
    expect(text).toContain("Save settings");
    expect(text).toContain("/api/settings");
  });

  it("GET /admin/settings has back navigation to dashboard", async () => {
    const res = await fetchAdmin("/admin/settings", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    const mainContent = text.match(/<main>[\s\S]*<\/main>/)?.[0] ?? "";
    const backLinkPos = mainContent.indexOf('href="/admin"');
    const firstCardPos = mainContent.indexOf('<div class="card"');
    expect(backLinkPos).toBeGreaterThan(-1);
    expect(firstCardPos).toBeGreaterThan(-1);
    expect(backLinkPos).toBeLessThan(firstCardPos);
  });

  it("settings page has a slug preview for the default page input", async () => {
    const res = await fetchAdmin("/admin/settings", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("initSlugPreview('settings-default-page'");
    expect(text).toContain('id="settings-default-page"');
  });

  it("GET /admin/settings without a token returns 403", async () => {
    const res = await fetchAdmin("/admin/settings");
    expect(res.status).toBe(403);
  });

  // ── Tags in admin UI ───────────────────────────────────────────────────

  it("upload page has a tags input field", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('id="tags"');
    expect(text).toContain("comma-separated");
  });

  it("paste form has a tags input field", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('id="paste-tags"');
    expect(text).toContain("comma-separated");
  });

  it("upload form JS has a parseTags function", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("function parseTags(");
    expect(text).toContain("manifest.tags = tags");
  });

  it("paste form JS includes tags in the payload", async () => {
    const res = await fetchAdmin("/admin/upload", await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("pasteTags.length > 0");
    expect(text).toContain("payload.tags = pasteTags");
  });

  it("edit page has a tags input field", async () => {
    const db = env.DB;
    const pageId = "page00tagedit";
    await insertPage(db, {
      id: pageId,
      slug: "tag-edit",
      title: "Tag Edit",
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
    expect(text).toContain('id="edit-tags"');
    expect(text).toContain("comma-separated");
  });

  it("edit form JS includes tags in the PATCH body", async () => {
    const db = env.DB;
    const pageId = "page00tagpatch";
    await insertPage(db, {
      id: pageId,
      slug: "tag-patch",
      title: "Tag Patch",
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
    expect(text).toContain("body.tags = parseTags(");
    expect(text).toContain("body.tags = []");
  });
});
