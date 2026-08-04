import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
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

// S23 password helpers (used in the end-to-end journey below).
import { verifyPassword } from "../src/password";
import { hashToken } from "../src/password-token";

// S22 — full local end-to-end journey (extended 2026-08-01 — ADR 0032).
//
// One uninterrupted sequence against the running Worker (worker.fetch with the
// real D1 + R2 emulation and a mock JWKS for the Access gate), exercising the
// whole public+admin surface in order — the roadmap's full journey: health →
// fail-closed gate → publish → home mode → trailing-slash redirect → serve
// (slug / id / base tag / R2 asset objects) → bundle with nested assets →
// markdown with show-source (rendered entry + CDN raw source + Worker 404 on
// the raw path) → admin UI → edit metadata → rev-bump file replace →
// rev-bump file delete → edit slug (new slug serves, old slug 404s clean, id
// still serves, no rev bump) → page delete (rows + objects gone) → reserved
// slug through UI → API → 4xx (no orphan rows/objects) → home 404 mode.
//
// The journey mirrors the operator checklist (docs/operations/) and closes the
// loop the per-slice unit tests each prove in isolation. Where the checklist's
// live checks cannot be emulated locally (R2 CDN serving, custom domains, real
// cache HITs), the test asserts the emulated equivalent and the checklist
// documents the live variant (see ADR 0031).

// Unique markers so a test can never accidentally match stale content.
const HOME_MARKER = "pagelively-e2e-home-marker";
const BUNDLE_MARKER = "pagelively-e2e-bundle-marker";
const V2_MARKER = "pagelively-e2e-bundle-v2-marker";
const MD_MARKER = "pagelively-e2e-md-marker";
// The slug the home page is renamed to in the edit-slug leg (step 13). Picked
// to be unambiguously journey-specific and valid (lowercase, non-reserved).
const RENAMED_SLUG = "home-renamed";

describe("S22 — full local end-to-end journey", () => {
  // Journey state shared across the sequential steps.
  let homeId = "";
  let bundleId = "";
  let imageId = "";
  let mdId = "";
  let privateKey: CryptoKey;
  let fetchMock: ReturnType<typeof createMockFetch>;

  beforeAll(async () => {
    const keys = await generateKeyPair("access-key-1");
    privateKey = keys.privateKey;
    fetchMock = createMockFetch({ keys: [keys.jwk] });
    vi.stubGlobal("fetch", fetchMock.fetchFn);

    // Start from a clean slate (each test file gets its own isolated D1 + R2
    // emulation, but clear anyway so the journey is self-contained).
    await env.DB.prepare("DELETE FROM files").run();
    await env.DB.prepare("DELETE FROM pages").run();
    let cursor: string | undefined;
    do {
      const list = await env.BUCKET.list({ cursor, limit: 1000 });
      const keys = list.objects.map((o) => o.key);
      if (keys.length > 0) await env.BUCKET.delete(keys);
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

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

  async function validToken(): Promise<string> {
    return signJwt(privateKey, "access-key-1", buildAccessPayload());
  }

  async function fetchPublic(path: string, envOverrides: Record<string, unknown> = {}) {
    return worker.fetch(
      new Request(`https://pages.example.com${path}`),
      makeEnv(envOverrides),
      createExecutionContext(),
    );
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
    return worker.fetch(
      new Request(`https://pages.example.com${path}`, { method, body, headers }),
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
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

  it("step 1: GET /health is public and reports ok", async () => {
    const res = await fetchPublic("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, service: "pagelively" });
    expect(body).not.toHaveProperty("bindings");
  });

  it("step 2: the admin API fails closed without a signed Access token", async () => {
    const form = new FormData();
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));
    const res = await fetchApi("/api/pages", "POST", form);
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("step 3: publish the home page via the admin API (201 + body)", async () => {
    const form = new FormData();
    form.append("manifest", JSON.stringify({ slug: "home", title: "Home" }));
    appendFile(
      form,
      "index.html",
      makeFile(
        "index.html",
        `<!doctype html><html><head></head><body><main><p>${HOME_MARKER}</p></main></body></html>`,
        "text/html",
      ),
    );
    appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));

    const res = await fetchApi("/api/pages", "POST", form, await validToken());

    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("html");
    expect(body.slug).toBe("home");
    expect(body.title).toBe("Home");
    expect(body.rev).toBe(1);
    expect(body.entry_path).toBe("index.html");
    expect(body.files).toHaveLength(2);
    homeId = body.id as string;
    expect(homeId).toMatch(/^[A-Za-z0-9_-]{8,10}$/);
  });

  it("step 4: HOME_MODE=page serves the home page at /", async () => {
    const res = await fetchPublic("/", {
      HOME_MODE: "page",
      HOME_PAGE_SLUG: "home",
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_AUD: ACCESS_AUD,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain(HOME_MARKER);
    expect(text).toContain(`<base href="https://cdn.example.com/pages/${homeId}/1/index.html">`);
  });

  it("step 5: GET /home (no trailing slash) 301s to /home/", async () => {
    const res = await fetchPublic("/home");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://pages.example.com/home/");
  });

  it("step 6: slug and id URLs serve the entry with the injected base tag", async () => {
    const slugRes = await fetchPublic("/home/");
    expect(slugRes.status).toBe(200);
    expect(slugRes.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const slugText = await slugRes.text();
    expect(slugText).toContain(HOME_MARKER);
    expect(slugText).toContain(
      `<base href="https://cdn.example.com/pages/${homeId}/1/index.html">`,
    );

    const idRes = await fetchPublic(`/p/${homeId}/`);
    expect(idRes.status).toBe(200);
    const idText = await idRes.text();
    expect(idText).toContain(HOME_MARKER);
    expect(idText).toContain(`<base href="https://cdn.example.com/pages/${homeId}/1/index.html">`);

    // Assets are served by the R2 CDN host, not by the Worker (spec §6); the
    // emulated equivalent is the object existing under the page's rev folder
    // with the upload-time httpMetadata, plus the API detail surface.
    const entryObj = await env.BUCKET.get(`pages/${homeId}/1/index.html`);
    expect(entryObj).not.toBeNull();
    expect(await new Response(entryObj!.body).text()).toContain(HOME_MARKER);
    expect(entryObj!.httpMetadata).toMatchObject({
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    });
    const cssObj = await env.BUCKET.get(`pages/${homeId}/1/style.css`);
    expect(cssObj).not.toBeNull();

    const detail = await fetchApi(`/api/pages/${homeId}`, "GET", null, await validToken());
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as Record<string, unknown>;
    expect(detailBody.id).toBe(homeId);
    expect((detailBody.files as Record<string, unknown>[]).map((f) => f.path)).toEqual(
      expect.arrayContaining(["index.html", "style.css"]),
    );
  });

  it("step 7: publish a bundle with nested assets", async () => {
    const form = new FormData();
    form.append(
      "manifest",
      JSON.stringify({ entry: "site/index.html", slug: "bundle-site", title: "Bundle Site" }),
    );
    appendFile(
      form,
      "site/index.html",
      makeFile(
        "index.html",
        `<!doctype html><html><head></head><body><main><p>${BUNDLE_MARKER}</p></main></body></html>`,
        "text/html",
      ),
    );
    // A bundle needs at least two documents (or an image + other assets) for
    // the kind detector; one HTML document alone is classified as `html`.
    appendFile(form, "site/about.html", makeFile("about.html", "<h1>About</h1>", "text/html"));
    appendFile(form, "site/images/pic.png", makeFile("pic.png", "PNG-BYTES", "image/png"));
    appendFile(form, "style.css", makeFile("style.css", "body{}", "text/css"));

    const res = await fetchApi("/api/pages", "POST", form, await validToken());

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("bundle");
    expect(body.slug).toBe("bundle-site");
    expect(body.entry_path).toBe("site/index.html");
    bundleId = body.id as string;

    // Nested relative paths are preserved under the rev folder.
    const keys = await listKeys(env.BUCKET, `pages/${bundleId}/1/`);
    expect(keys).toEqual(
      expect.arrayContaining([
        `pages/${bundleId}/1/site/index.html`,
        `pages/${bundleId}/1/site/images/pic.png`,
        `pages/${bundleId}/1/style.css`,
      ]),
    );
    const pic = await env.BUCKET.get(`pages/${bundleId}/1/site/images/pic.png`);
    expect(pic).not.toBeNull();
    expect(await new Response(pic!.body).text()).toBe("PNG-BYTES");

    const serve = await fetchPublic("/bundle-site/");
    expect(serve.status).toBe(200);
    const text = await serve.text();
    expect(text).toContain(BUNDLE_MARKER);
    expect(text).toContain(
      `<base href="https://cdn.example.com/pages/${bundleId}/1/site/index.html">`,
    );
  });

  it("step 8: publish an image-kind page (single image file) and serve it via 301 redirect to the CDN", async () => {
    const form = new FormData();
    form.append("manifest", JSON.stringify({ slug: "photo", title: "Photo" }));
    appendFile(form, "sunset.jpg", makeFile("sunset.jpg", "FAKE-JPEG-BYTES", "image/jpeg"));

    const res = await fetchApi("/api/pages", "POST", form, await validToken());

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("image");
    expect(body.slug).toBe("photo");
    expect(body.title).toBe("Photo");
    expect(body.entry_path).toBe("sunset.jpg");
    expect(body.rev).toBe(1);
    expect(body.files).toHaveLength(1);
    imageId = body.id as string;
    expect(imageId).toMatch(/^[A-Za-z0-9_-]{8,10}$/);

    // The image object is stored under the rev folder with upload-time metadata.
    const stored = await env.BUCKET.get(`pages/${imageId}/1/sunset.jpg`);
    expect(stored).not.toBeNull();
    expect(await new Response(stored!.body).text()).toBe("FAKE-JPEG-BYTES");
    expect(stored!.httpMetadata).toMatchObject({ contentType: "image/jpeg" });

    // The public slug URL 301s to the CDN object (spec §6: image pages redirect).
    const serve = await fetchPublic("/photo/");
    expect(serve.status).toBe(301);
    expect(serve.headers.get("Location")).toBe(
      `https://cdn.example.com/pages/${imageId}/1/sunset.jpg`,
    );
    expect(serve.headers.get("Cache-Control")).toMatch(/^public, max-age=/);
    expect(serve.headers.get("Cache-Tag")).toBe(`page-${imageId}`);

    // The id URL also 301s.
    const idServe = await fetchPublic(`/p/${imageId}/`);
    expect(idServe.status).toBe(301);
    expect(idServe.headers.get("Location")).toBe(
      `https://cdn.example.com/pages/${imageId}/1/sunset.jpg`,
    );
  });

  it("step 9: publish a markdown page with show_source; the rendered entry serves, the raw source lives on the CDN path", async () => {
    const form = new FormData();
    form.append("manifest", JSON.stringify({ showSource: true }));
    appendFile(form, "notes.md", makeFile("notes.md", `# ${MD_MARKER}\n\nWorld.`, "text/markdown"));

    const res = await fetchApi("/api/pages", "POST", form, await validToken());

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.kind).toBe("markdown");
    expect(body.slug).toBe("notes");
    expect(body.entry_path).toBe("index.html");
    expect(body.raw_md_path).toBe("source.md");
    expect(body.show_source).toBe(1);
    expect(body.rev).toBe(1);
    mdId = body.id as string;

    // The rendered entry and the raw source both live under the rev folder;
    // `source.md` is served by the R2 CDN host (spec §6 — the Worker is not in
    // the asset path), emulated here exactly like the step-6 asset objects:
    // the object exists with the upload-time bytes and httpMetadata.
    const keys = await listKeys(env.BUCKET, `pages/${mdId}/1/`);
    expect(keys).toEqual([`pages/${mdId}/1/index.html`, `pages/${mdId}/1/source.md`]);
    const mdObj = await env.BUCKET.get(`pages/${mdId}/1/source.md`);
    expect(mdObj).not.toBeNull();
    expect(await new Response(mdObj!.body).text()).toBe(`# ${MD_MARKER}\n\nWorld.`);
    expect(mdObj!.httpMetadata).toMatchObject({ contentType: "text/markdown" });

    // The slug URL serves the rendered HTML with the injected base and the
    // relative View-source link (resolved by the base to the CDN path).
    const serve = await fetchPublic("/notes/");
    expect(serve.status).toBe(200);
    expect(serve.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    const text = await serve.text();
    expect(text).toContain(`<h1>${MD_MARKER}</h1>`);
    expect(text).toContain(`<base href="https://cdn.example.com/pages/${mdId}/1/index.html">`);
    expect(text).toContain('<p class="source-link"><a href="source.md">View source</a></p>');

    // No raw-source route exists on the Worker (spec §6 — assets bypass the
    // Worker, so `/notes/source.md` is an unknown path): it 404s cleanly.
    const raw404 = await fetchPublic("/notes/source.md");
    expect(raw404.status).toBe(404);
    expect(raw404.headers.get("Cache-Control")).toBe("no-store");
  });

  it("step 10: the admin dashboard renders and lists the published pages", async () => {
    const res = await fetchApi("/admin", "GET", null, await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("Pagelively");
    expect(text).toContain("admin@example.com");
    expect(text).toContain("Home");
    expect(text).toContain("Bundle Site");
    expect(text).toContain("/home/");
    expect(text).toContain("/bundle-site/");
    expect(text).toContain(`/admin/edit/${homeId}`);
    expect(text).toContain(`/api/pages/${homeId}`);
    expect(text).toContain("/admin/upload");
  });

  it("step 11: PATCH edits metadata without a rev bump", async () => {
    const res = await fetchApi(
      `/api/pages/${bundleId}`,
      "PATCH",
      JSON.stringify({ title: "Bundle Renamed" }),
      await validToken(),
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.title).toBe("Bundle Renamed");
    expect(body.slug).toBe("bundle-site");
    expect(body.rev).toBe(1);
  });

  it("step 12: replacing the entry file bumps rev; the new rev serves, the old is immutable", async () => {
    const form = new FormData();
    appendFile(
      form,
      "site/index.html",
      makeFile(
        "index.html",
        `<!doctype html><html><head></head><body><main><p>${V2_MARKER}</p></main></body></html>`,
        "text/html",
      ),
    );

    const res = await fetchApi(`/api/pages/${bundleId}/files`, "POST", form, await validToken());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rev).toBe(2);

    // New rev 200s: the served entry points at rev 2 and carries the new
    // marker; the rev-2 object exists with the new bytes.
    const serve = await fetchPublic("/bundle-site/");
    expect(serve.status).toBe(200);
    const text = await serve.text();
    expect(text).toContain(V2_MARKER);
    expect(text).not.toContain(BUNDLE_MARKER);
    expect(text).toContain(
      `<base href="https://cdn.example.com/pages/${bundleId}/2/site/index.html">`,
    );
    const rev2Obj = await env.BUCKET.get(`pages/${bundleId}/2/site/index.html`);
    expect(rev2Obj).not.toBeNull();
    expect(await new Response(rev2Obj!.body).text()).toContain(V2_MARKER);

    // Revisions are immutable (ADR 0006): the rev-1 object still holds the
    // original bytes, but the public page no longer references rev 1.
    const rev1Obj = await env.BUCKET.get(`pages/${bundleId}/1/site/index.html`);
    expect(rev1Obj).not.toBeNull();
    expect(await new Response(rev1Obj!.body).text()).toContain(BUNDLE_MARKER);
  });

  it("step 13: deleting a file bumps rev; the deleted asset 404s at the current rev", async () => {
    const res = await fetchApi(
      `/api/pages/${bundleId}/files/style.css`,
      "DELETE",
      null,
      await validToken(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rev).toBe(3);
    expect((body.files as Record<string, unknown>[]).map((f) => f.path)).not.toContain("style.css");

    // Old asset rev 404s at the current rev: the deleted file is absent from
    // the rev-3 folder while the surviving files 200 at the new rev.
    const deletedAtCurrentRev = await env.BUCKET.get(`pages/${bundleId}/3/style.css`);
    expect(deletedAtCurrentRev).toBeNull();
    const survivingAtCurrentRev = await env.BUCKET.get(`pages/${bundleId}/3/site/index.html`);
    expect(survivingAtCurrentRev).not.toBeNull();

    // The page still serves with the base pointing at rev 3.
    const serve = await fetchPublic("/bundle-site/");
    expect(serve.status).toBe(200);
    const text = await serve.text();
    expect(text).toContain(V2_MARKER);
    expect(text).toContain(
      `<base href="https://cdn.example.com/pages/${bundleId}/3/site/index.html">`,
    );
  });

  it("step 14: PATCH edits the home page's slug; the new slug serves, the old 404s clean, the id serves, rev is unchanged", async () => {
    // The page created for the html leg (step 3) is the one whose slug is
    // edited — no new page needed. The slug edit is metadata-only (ADR 0012 /
    // admin-api-edit.test.ts): rev stays 1 and the R2 objects are untouched.
    const res = await fetchApi(
      `/api/pages/${homeId}`,
      "PATCH",
      JSON.stringify({ slug: RENAMED_SLUG }),
      await validToken(),
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe(RENAMED_SLUG);
    expect(body.rev).toBe(1);

    // The new slug serves the same entry with the same rev-1 base.
    const newSlug = await fetchPublic(`/${RENAMED_SLUG}/`);
    expect(newSlug.status).toBe(200);
    const newText = await newSlug.text();
    expect(newText).toContain(HOME_MARKER);
    expect(newText).toContain(`<base href="https://cdn.example.com/pages/${homeId}/1/index.html">`);

    // The old slug is gone: a clean 404 with no-store, and no rename redirect
    // exists (slug.test.ts / redirects.test.ts semantics — there is no
    // redirect table to map old → new).
    const oldSlug = await fetchPublic("/home/");
    expect(oldSlug.status).toBe(404);
    expect(oldSlug.headers.get("Cache-Control")).toBe("no-store");
    const oldText = await oldSlug.text();
    expect(oldText).toContain("Not Found");
    expect(oldText).toContain("<code>/home/</code>");

    // The id URL still serves the page.
    const idRes = await fetchPublic(`/p/${homeId}/`);
    expect(idRes.status).toBe(200);
    expect(await idRes.text()).toContain(HOME_MARKER);
  });

  it("step 15: DELETE removes the page, its rows, and its R2 objects", async () => {
    const res = await fetchApi(`/api/pages/${bundleId}`, "DELETE", null, await validToken());
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();

    const slug404 = await fetchPublic("/bundle-site/");
    expect(slug404.status).toBe(404);
    expect(slug404.headers.get("Cache-Control")).toBe("no-store");

    const id404 = await fetchPublic(`/p/${bundleId}/`);
    expect(id404.status).toBe(404);

    const keys = await listKeys(env.BUCKET, `pages/${bundleId}/`);
    expect(keys).toEqual([]);

    const row = await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(bundleId).first();
    expect(row).toBeNull();
    const files = await env.DB.prepare("SELECT * FROM files WHERE page_id = ?")
      .bind(bundleId)
      .all();
    expect(files.results).toHaveLength(0);
  });

  it("step 16: a reserved slug is rejected through UI → API → 4xx with zero orphan rows/objects", async () => {
    // UI leg: the admin upload page carries the S19 error-surfacing box that
    // surfaces API errors to the operator (`#upload-error`, role="alert" —
    // pre-existing markup on /admin/upload; the dashboard /admin does not
    // render it, see ADR 0032). The dashboard itself is still served.
    const upload = await fetchApi("/admin/upload", "GET", null, await validToken());
    expect(upload.status).toBe(200);
    const uploadText = await upload.text();
    expect(uploadText).toContain('id="upload-error"');
    expect(uploadText).toContain('role="alert"');

    const dashboard = await fetchApi("/admin", "GET", null, await validToken());
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("Pagelively");

    // Snapshot the DB + bucket so the rejection can be proven to leave
    // nothing behind (the 400 fires before any id is generated or any R2
    // object is written — validateManifest precedes generateId/put, ADR 0032).
    const countRows = async (table: string): Promise<number> => {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      return row?.n ?? 0;
    };
    const pagesBefore = await countRows("pages");
    const filesBefore = await countRows("files");
    const keysBefore = await listKeys(env.BUCKET, "pages/");

    // API leg: POST with a reserved slug → 400 invalid_slug.
    const form = new FormData();
    form.append("manifest", JSON.stringify({ slug: "admin" }));
    appendFile(form, "x.html", makeFile("x.html", "<h1>X</h1>", "text/html"));
    const res = await fetchApi("/api/pages", "POST", form, await validToken());
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "invalid_slug",
      message: '"admin" is a reserved name and cannot be used as a slug.',
    });

    // Zero orphan rows/objects: nothing was created by the rejected publish.
    const pagesAfter = await countRows("pages");
    const filesAfter = await countRows("files");
    const keysAfter = await listKeys(env.BUCKET, "pages/");
    expect(pagesAfter).toBe(pagesBefore);
    expect(filesAfter).toBe(filesBefore);
    expect(keysAfter).toEqual(keysBefore);
    const reservedRow = await env.DB.prepare("SELECT * FROM pages WHERE slug = ?")
      .bind("admin")
      .first();
    expect(reservedRow).toBeNull();
  });

  it("step 17: HOME_MODE=404 returns the clean 404 at /", async () => {
    const res = await fetchPublic("/", { HOME_MODE: "404", HOME_PAGE_SLUG: "" });
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("Not Found");
    expect(text).toContain("<code>/</code>");
  });
});

// =============================================================================
// S23 — Password-protected page end-to-end journey (ADR 0041).
// =============================================================================

const PW_SLUG = "protected-page";
const PW_PASSWORD = "s3cret-word";
const PW_MARKER = "pagelively-e2e-pw-marker";
const PW_ASSET_CONTENT = "pagelively-e2e-pw-asset";
const PW_ASSET_FILENAME = "helper.js";

describe("S23 — Password-protected page", () => {
  let pageId = "";
  let unlockCookie = "";
  let privateKey: CryptoKey;
  let fetchMock: ReturnType<typeof createMockFetch>;

  beforeAll(async () => {
    const keys = await generateKeyPair("access-key-2");
    privateKey = keys.privateKey;
    fetchMock = createMockFetch({ keys: [keys.jwk] });
    vi.stubGlobal("fetch", fetchMock.fetchFn);

    // Clean slate.
    await env.DB.prepare("DELETE FROM page_unlocks").run();
    await env.DB.prepare("DELETE FROM files").run();
    await env.DB.prepare("DELETE FROM pages").run();
    let cursor: string | undefined;
    do {
      const list = await env.BUCKET.list({ cursor, limit: 1000 });
      const keys = list.objects.map((o) => o.key);
      if (keys.length > 0) await env.BUCKET.delete(keys);
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

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

  async function validToken(): Promise<string> {
    return signJwt(privateKey, "access-key-2", buildAccessPayload());
  }

  async function fetchPublic(path: string, envOverrides: Record<string, unknown> = {}) {
    return worker.fetch(
      new Request(`https://pages.example.com${path}`),
      makeEnv(envOverrides),
      createExecutionContext(),
    );
  }

  async function fetchPublicWithCookie(
    path: string,
    cookieValue: string,
    envOverrides: Record<string, unknown> = {},
  ) {
    return worker.fetch(
      new Request(`https://pages.example.com${path}`, {
        headers: { Cookie: `pl_unlock=${cookieValue}` },
      }),
      makeEnv(envOverrides),
      createExecutionContext(),
    );
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
    return worker.fetch(
      new Request(`https://pages.example.com${path}`, { method, body, headers }),
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
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

  it("step 1: publish a page with a password via multipart API", async () => {
    const form = new FormData();
    form.append(
      "manifest",
      JSON.stringify({
        slug: PW_SLUG,
        title: "Protected Page",
        password: PW_PASSWORD,
      }),
    );
    appendFile(
      form,
      "index.html",
      makeFile(
        "index.html",
        `<!doctype html><html><head></head><body><main><p>${PW_MARKER}</p><script src="${PW_ASSET_FILENAME}"></script></main></body></html>`,
        "text/html",
      ),
    );
    appendFile(
      form,
      PW_ASSET_FILENAME,
      makeFile(PW_ASSET_FILENAME, PW_ASSET_CONTENT, "application/javascript"),
    );

    const res = await fetchApi("/api/pages", "POST", form, await validToken());

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.slug).toBe(PW_SLUG);
    expect(body.has_password).toBe(true);
    // R19: hash and password never leak.
    expect(body).not.toHaveProperty("password_hash");
    expect(body).not.toHaveProperty("password");
    expect(body.rev).toBe(1);
    pageId = body.id as string;
    expect(pageId).toMatch(/^[A-Za-z0-9_-]{8,10}$/);

    // Confirm the hash is stored in D1.
    const row = await env.DB.prepare("SELECT password_hash FROM pages WHERE id = ?")
      .bind(pageId)
      .first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$/);
    expect(await verifyPassword(PW_PASSWORD, row!.password_hash)).toBe(true);
  });

  it("step 2: GET the protected page without a cookie → prompt (200, no-store, no Cache-Tag, no page content)", async () => {
    const res = await fetchPublic(`/${PW_SLUG}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    const text = await res.text();
    // The prompt shows the site name and generic text, not the page title/content.
    expect(text).toContain("Pagelively");
    expect(text).toContain("This page is password protected.");
    expect(text).toContain(`action="/p/${pageId}/unlock"`);
    expect(text).not.toContain(PW_MARKER);
    expect(text).not.toContain("Protected Page");
    // The CDN host must never appear in the prompt (it is not a page view).
    expect(text).not.toContain("cdn.example.com");
  });

  it("step 3: POST wrong password → 200 prompt with escaped error, no Set-Cookie", async () => {
    // The unlock endpoint is public (doesn't need ACCESS env vars).
    const unlockRes = await worker.fetch(
      new Request(`https://pages.example.com/p/${pageId}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=wrongpw",
      }),
      env,
      createExecutionContext(),
    );
    expect(unlockRes.status).toBe(200);
    expect(unlockRes.headers.get("Cache-Control")).toBe("no-store");
    expect(unlockRes.headers.get("Set-Cookie")).toBeNull();
    const text = await unlockRes.text();
    expect(text).toContain("Incorrect password.");
    expect(text).toContain("This page is password protected.");
    // No page content leaked.
    expect(text).not.toContain(PW_MARKER);
  });

  it("step 4: POST correct password → 303 to /p/{id}/ with the unlock cookie", async () => {
    const res = await worker.fetch(
      new Request(`https://pages.example.com/p/${pageId}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `password=${PW_PASSWORD}`,
      }),
      env,
      createExecutionContext(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/p/${pageId}/`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toMatch(
      new RegExp(
        `^pl_unlock=${pageId}\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; SameSite=Lax; Secure$`,
      ),
    );
    // Extract the raw cookie value for subsequent requests.
    unlockCookie = setCookie!.match(/^pl_unlock=([^;]+)/)![1];
    expect(unlockCookie).toMatch(new RegExp(`^${pageId}\\.[A-Za-z0-9_-]{43}$`));

    // Verify the unlock row was created in D1 with a token hash (never the raw token).
    const row = await env.DB.prepare("SELECT token_hash FROM page_unlocks WHERE page_id = ?")
      .bind(pageId)
      .first<{ token_hash: string }>();
    expect(row).not.toBeNull();
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const token = unlockCookie.split(".")[1];
    expect(row!.token_hash).toBe(await hashToken(token));
  });

  it("step 5: follow the 303 → entry with Worker-origin base href, no-store, no Cache-Tag", async () => {
    const res = await fetchPublicWithCookie(`/p/${pageId}/`, unlockCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    const text = await res.text();
    expect(text).toContain(PW_MARKER);
    // The base href must point at the Worker origin, not the CDN host.
    expect(text).toContain(
      `<base href="https://pages.example.com/assets/pages/${pageId}/1/index.html">`,
    );
    expect(text).not.toContain("cdn.example.com");
  });

  it("step 6: fetch a relative asset through the Worker asset route → 200, correct content type, no-store", async () => {
    // The entry references `helper.js` which the base resolves to
    // /assets/pages/{id}/1/helper.js on the Worker origin.
    const res = await fetchPublicWithCookie(
      `/assets/pages/${pageId}/1/${PW_ASSET_FILENAME}`,
      unlockCookie,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    const text = await res.text();
    expect(text).toBe(PW_ASSET_CONTENT);
  });

  it("step 7: PATCH the page to clear the password", async () => {
    // Before clearing, verify the password hash exists.
    const before = await env.DB.prepare("SELECT password_hash FROM pages WHERE id = ?")
      .bind(pageId)
      .first<{ password_hash: string }>();
    expect(before?.password_hash).toMatch(/^pbkdf2\$/);

    const res = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "" }),
      await validToken(),
      { "Content-Type": "application/json" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(false);
    expect(body).not.toHaveProperty("password_hash");

    // Confirm the hash is gone from D1.
    const after = await env.DB.prepare("SELECT password_hash FROM pages WHERE id = ?")
      .bind(pageId)
      .first<{ password_hash: string | null }>();
    // password_hash column should be NULL (D1 stores null for TEXT when set to null).
    if (after !== null) {
      // If D1 returned the row, password_hash should be null.
      expect(after.password_hash).toBeNull();
    }

    // Confirm the unlock row was deleted (ADR 0041 decision 12).
    const unlockRow = await env.DB.prepare("SELECT token_hash FROM page_unlocks WHERE page_id = ?")
      .bind(pageId)
      .first();
    expect(unlockRow).toBeNull();
  });

  it("step 8: GET the unprotected page → entry with CDN base href + public Cache-Control", async () => {
    const res = await fetchPublicWithCookie(`/p/${pageId}/`, unlockCookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    // Public entry has SWR caching, not no-store.
    expect(res.headers.get("Cache-Control")).toMatch(/^public, max-age=/);
    expect(res.headers.get("Cache-Tag")).toBe(`page-${pageId}`);
    const text = await res.text();
    expect(text).toContain(PW_MARKER);
    // The base href points back at the CDN host.
    expect(text).toContain(`<base href="https://cdn.example.com/pages/${pageId}/1/index.html">`);
  });

  it("step 9: stale unlock cookie (no unlock row) → the cookie is ignored, page serves entry (no prompt)", async () => {
    // The unlock row was deleted in step 7. The gate finds password_hash is null,
    // so it serves the entry regardless of the cookie.
    const res = await fetchPublicWithCookie(`/p/${pageId}/`, unlockCookie);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(PW_MARKER);
    expect(text).toContain("cdn.example.com");
    expect(text).not.toContain("This page is password protected.");
  });

  it("step 10: no cookie without a password → public entry serves", async () => {
    const res = await fetchPublic(`/p/${pageId}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain(PW_MARKER);
    // CDN base href confirms it's public.
    expect(text).toContain(`<base href="https://cdn.example.com/pages/${pageId}/1/index.html">`);
    expect(text).not.toContain("This page is password protected.");
  });
});
