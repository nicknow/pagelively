/**
 * S23-D validator adversarial probe tests (independent of the implementer's suite).
 *
 * Probes cover every AC 1–6 and the orchestrator's specific adversarial probes a–e.
 * These tests are written by the validator, not by the implementer.
 *
 * Covers:
 *   PROBE A — Whitespace-only PATCH (orchestrator probe a)
 *   PROBE B — Create then PATCH absent then PATCH clear (orchestrator probe b)
 *   PROBE C — Notice string rendered verbatim in HTML source (orchestrator probe c)
 *   PROBE D — Read-after-patch-list via worker.fetch (orchestrator probe d)
 *   PROBE E — Purge recording (orchestrator probe e, reinforcing implementer's tests)
 *   PROBE F — Boundary: exactly 5 chars and exactly 256 chars accepted (multipart + paste)
 *   PROBE G — Empty-string password on create (multipart + paste)
 *   PROBE H — Non-string password on create (multipart + paste) — documents actual behavior
 *   PROBE I — Multiple PATCH: set → clear → set
 *   PROBE J — toPageJson defensive copy (no mutation)
 *   PROBE K — R19 regression: grep response bodies for password_hash, "password":, pbkdf2$
 *   PROBE L — Read-after-patch-detail via worker.fetch
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { handlePatchPage, toPageJson } from "../src/admin-api";
import type { PageRecord } from "../src/pages-repository";
import { createTestCacheService } from "../src/cache-service";
import { createConfig } from "../src/config";
import { createPagesRepository } from "../src/pages-repository";
import { createFilesRepository } from "../src/files-repository";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { createObjectStore } from "../src/object-store";
import { createSettingsRepository } from "../src/settings-repository";
import { verifyPassword } from "../src/password";
import {
  ACCESS_AUD,
  createMockFetch,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

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

async function insertUnlock(db: D1Database, pageId: string, tokenHash: string) {
  await db
    .prepare(
      "INSERT OR REPLACE INTO page_unlocks (page_id, token_hash, created_at) VALUES (?, ?, ?)",
    )
    .bind(pageId, tokenHash, isoNow())
    .run();
}

async function unlockCount(db: D1Database, pageId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM page_unlocks WHERE page_id = ?")
    .bind(pageId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function storedPasswordHash(db: D1Database, pageId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT password_hash FROM pages WHERE id = ?")
    .bind(pageId)
    .first<{ password_hash: string | null }>();
  return row?.password_hash ?? null;
}

async function pageRev(db: D1Database, pageId: string): Promise<number> {
  const row = await db
    .prepare("SELECT rev FROM pages WHERE id = ?")
    .bind(pageId)
    .first<{ rev: number }>();
  return row?.rev ?? -1;
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

function appendManifest(form: FormData, manifest: Record<string, unknown>): void {
  form.append("manifest", JSON.stringify(manifest));
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
    unlocks: createUnlocksRepository(env.DB),
    settingsRepository: createSettingsRepository(env.DB),
  };
}

function pasteJson(body: Record<string, unknown>): {
  body: string;
  headers: Record<string, string>;
} {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

describe("S23-D validator adversarial probes", () => {
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

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE A — Whitespace-only PATCH (orchestrator probe a)
  // validatePassword("   ") trims to "" → "not-set". The handler at admin-api.ts
  // L719 sets pwdHash = null when validation returns "not-set", which means
  // CLEAR (not unchanged). This probe documents and verifies that behavior.
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE A: PATCH with whitespace-only password clears the stored hash", async () => {
    const pageId = "prob0000a";
    await insertPage(db, {
      id: pageId,
      slug: "probe-a",
      title: "Probe A",
      kind: "html",
      password_hash: "pbkdf2$10000$test-salt$test-hash",
    });

    const token = await validToken();
    const res = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "   " }),
      token,
      { "Content-Type": "application/json" },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(false);
    expect(body.rev).toBe(1);
    // The hash is cleared
    expect(await storedPasswordHash(db, pageId)).toBeNull();

    // Documented actual behavior: whitespace-only password clears (does not
    // leave unchanged). This is the correct/sane interpretation: a user who
    // enters spaces in the clear-password checkbox sends empty, not spaces,
    // but if they did send spaces the hash is gone rather than unchanged.
    // The spec does not mandate one direction; this documents the actual path.
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE B — Create with password, then PATCH absent, then PATCH clear
  // (orchestrator probe b)
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE B1: create with password, PATCH absent password keeps has_password true", async () => {
    const token = await validToken();
    // Create
    const form = new FormData();
    appendManifest(form, { slug: "probe-b1", password: "s3cret-word" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>B1</h1>", "text/html"));

    const createRes = await fetchApi("/api/pages", "POST", form, token);
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as Record<string, unknown>;
    expect(createBody.has_password).toBe(true);

    const pageId = createBody.id as string;

    // PATCH with title only (no password field) → has_password unchanged
    const patchRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ title: "Renamed B1" }),
      token,
      { "Content-Type": "application/json" },
    );

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as Record<string, unknown>;
    expect(patchBody.has_password).toBe(true);
    expect(patchBody.title).toBe("Renamed B1");
    expect(patchBody.rev).toBe(1); // no rev bump
    // Hash still in DB
    const hash = await storedPasswordHash(db, pageId);
    expect(hash).toMatch(/^pbkdf2\$10000\$/);
    expect(await verifyPassword("s3cret-word", hash!)).toBe(true);
  });

  it("PROBE B2: then PATCH with empty string clears the password", async () => {
    const token = await validToken();
    // Create protected
    const form = new FormData();
    appendManifest(form, { slug: "probe-b2", password: "s3cret-word" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>B2</h1>", "text/html"));

    const createRes = await fetchApi("/api/pages", "POST", form, token);
    expect(createRes.status).toBe(201);
    const pageId = ((await createRes.json()) as Record<string, unknown>).id as string;

    // Clear
    const clearRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "" }),
      token,
      { "Content-Type": "application/json" },
    );

    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as Record<string, unknown>;
    expect(clearBody.has_password).toBe(false);
    expect(await storedPasswordHash(db, pageId)).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE C — Notice string rendered verbatim in HTML source
  // (orchestrator probe c)
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE C: CDN-bypass notice string appears verbatim in upload form HTML including punctuation", async () => {
    const res = await fetchApi("/admin/upload", "GET", null, await validToken());
    expect(res.status).toBe(200);
    const text = await res.text();

    // The exact string with punctuation must appear in the HTML source.
    // It must NOT be only inside a JS string or comment — it must be in the
    // rendered HTML template itself.
    const expectedNotice = "All access will bypass the CDN which may increase usage.";
    expect(text).toContain(expectedNotice);

    // It appears twice: once in the upload-pane AND once in the paste-pane.
    const firstIndex = text.indexOf(expectedNotice);
    const lastIndex = text.lastIndexOf(expectedNotice);
    expect(firstIndex).toBeGreaterThan(-1);
    expect(lastIndex).toBeGreaterThan(firstIndex);

    // It is NOT escaped (no &quot; &gt; &lt; etc.)
    expect(text).not.toContain("All access will bypass the CDN &");

    // It is in HTML elements (<p>), not in a JS comment or string
    // Actually the notice is inside a <p> element with style="display:none"
    const pNotice = text.match(
      /<p[^>]*>All access will bypass the CDN which may increase usage\.<\/p>/g,
    );
    expect(pNotice).not.toBeNull();
    expect(pNotice!.length).toBe(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE D — Read-after-patch-list via worker.fetch (orchestrator probe d)
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE D1: after PATCH setting a password, GET /api/pages returns has_password: true", async () => {
    const pageId = "prob0000d1";
    await insertPage(db, { id: pageId, slug: "probe-d1", title: "Probe D1", kind: "html" });

    const token = await validToken();
    // Set password
    const patchRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "new-secret" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as Record<string, unknown>;
    expect(patchBody.has_password).toBe(true);

    // List via worker.fetch
    const listRes = await fetchApi("/api/pages", "GET", null, token);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as Record<string, unknown>[];
    const found = listBody.find((p: Record<string, unknown>) => p.id === pageId);
    expect(found).toBeDefined();
    expect(found!.has_password).toBe(true);
    expect(JSON.stringify(listBody)).not.toContain("pbkdf2");
    expect(JSON.stringify(listBody)).not.toContain("password_hash");
  });

  it("PROBE D2: after clearing, GET /api/pages returns has_password: false", async () => {
    const pageId = "prob0000d2";
    await insertPage(db, {
      id: pageId,
      slug: "probe-d2",
      title: "Probe D2",
      kind: "html",
      password_hash: "pbkdf2$10000$salt$hash",
    });

    const token = await validToken();
    // Clear password
    const patchRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as Record<string, unknown>;
    expect(patchBody.has_password).toBe(false);

    // List via worker.fetch
    const listRes = await fetchApi("/api/pages", "GET", null, token);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as Record<string, unknown>[];
    const found = listBody.find((p: Record<string, unknown>) => p.id === pageId);
    expect(found).toBeDefined();
    expect(found!.has_password).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE E — Purge recording (reinforcing orchestrator probe e)
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE E: PATCH setting a password calls cache.purgePage and clears unlocks", async () => {
    const pageId = "prob0000e1";
    await insertPage(db, { id: pageId, slug: "probe-e1", kind: "html" });
    await insertUnlock(db, pageId, "some-token-hash");

    const objectStore = createObjectStore(bucket);
    const cacheService = createTestCacheService();
    const deps = {
      ...makeAdminDeps(objectStore),
      cacheService,
      unlocks: createUnlocksRepository(db),
    };
    const req = new Request(`https://pages.example.com/api/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ password: "s3cret-word" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await handlePatchPage(req, ctx, deps);
    expect(res.status).toBe(200);
    expect(cacheService.getPurgeTags()).toContain(`page-${pageId}`);
    expect(await unlockCount(db, pageId)).toBe(0);
    expect(await pageRev(db, pageId)).toBe(1);
  });

  it("PROBE E2: PATCH clearing a password calls cache.purgePage and clears unlocks", async () => {
    const pageId = "prob0000e2";
    await insertPage(db, {
      id: pageId,
      slug: "probe-e2",
      kind: "html",
      password_hash: "pbkdf2$10000$salt$hash",
    });
    await insertUnlock(db, pageId, "some-token-hash");

    const objectStore = createObjectStore(bucket);
    const cacheService = createTestCacheService();
    const deps = {
      ...makeAdminDeps(objectStore),
      cacheService,
      unlocks: createUnlocksRepository(db),
    };
    const req = new Request(`https://pages.example.com/api/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ password: "" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await handlePatchPage(req, ctx, deps);
    expect(res.status).toBe(200);
    expect(cacheService.getPurgeTags()).toContain(`page-${pageId}`);
    expect(await unlockCount(db, pageId)).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE F — Boundary: exactly 5 chars and exactly 256 chars accepted
  // (AC 5 edge cases — min/max boundary)
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE F1: multipart create with exactly 5-char password is accepted", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "probe-f1", password: "12345" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>F1</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(true);

    const hash = await storedPasswordHash(db, body.id as string);
    expect(hash).toMatch(/^pbkdf2\$10000\$/);
    expect(await verifyPassword("12345", hash!)).toBe(true);
  });

  it("PROBE F2: multipart create with exactly 256-char password is accepted", async () => {
    const token = await validToken();
    const longPw = "x".repeat(256);
    const form = new FormData();
    appendManifest(form, { slug: "probe-f2", password: longPw });
    appendFile(form, "index.html", makeFile("index.html", "<h1>F2</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(true);

    const hash = await storedPasswordHash(db, body.id as string);
    expect(hash).toMatch(/^pbkdf2\$10000\$/);
    expect(await verifyPassword(longPw, hash!)).toBe(true);
  });

  it("PROBE F3: JSON paste create with exactly 5-char password is accepted", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({
      content: "# F3",
      format: "markdown",
      slug: "probe-f3",
      password: "12345",
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(201);
    const resBody = (await res.json()) as Record<string, unknown>;
    expect(resBody.has_password).toBe(true);

    const hash = await storedPasswordHash(db, resBody.id as string);
    expect(await verifyPassword("12345", hash!)).toBe(true);
  });

  it("PROBE F4: JSON paste create with exactly 256-char password is accepted", async () => {
    const token = await validToken();
    const longPw = "x".repeat(256);
    const { body, headers } = pasteJson({
      content: "# F4",
      format: "markdown",
      slug: "probe-f4",
      password: longPw,
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(201);
    const resBody = (await res.json()) as Record<string, unknown>;
    expect(resBody.has_password).toBe(true);

    const hash = await storedPasswordHash(db, resBody.id as string);
    expect(await verifyPassword(longPw, hash!)).toBe(true);
  });

  it("PROBE F5: 4-char password returns 400 on create (multipart)", async () => {
    const token = await validToken();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    const form = new FormData();
    appendManifest(form, { slug: "probe-f5", password: "1234" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>F5</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_password",
      message: "Password must be at least 5 characters.",
    });
    const after = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("PROBE F6: 257-char password returns 400 on create (multipart)", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "probe-f6", password: "x".repeat(257) });
    appendFile(form, "index.html", makeFile("index.html", "<h1>F6</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_password",
      message: "Password must be at most 256 characters.",
    });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE G — Empty-string password on create
  // (AC 5 edge cases)
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE G1: multipart create with empty-string password creates unprotected page", async () => {
    const token = await validToken();
    const form = new FormData();
    appendManifest(form, { slug: "probe-g1", password: "" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>G1</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(false);
    expect(await storedPasswordHash(db, body.id as string)).toBeNull();
  });

  it("PROBE G2: JSON paste with empty-string password creates unprotected page", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({
      content: "# G2",
      format: "markdown",
      slug: "probe-g2",
      password: "",
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(201);
    const resBody = (await res.json()) as Record<string, unknown>;
    expect(resBody.has_password).toBe(false);
    expect(await storedPasswordHash(db, resBody.id as string)).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE H — Non-string password on create
  // AC 1: non-string → 400 invalid_password. Both parseManifestField
  // (multipart) and parsePublishJson (paste) now reject non-string password
  // values with a typed 400; no page is created. Regression guard.
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE H1: multipart manifest with non-string password (number) returns 400 invalid_password", async () => {
    const token = await validToken();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    const form = new FormData();
    // password as number in manifest JSON
    appendManifest(form, { slug: "probe-h1", password: 123 });
    appendFile(form, "index.html", makeFile("index.html", "<h1>H1</h1>", "text/html"));

    const res = await fetchApi("/api/pages", "POST", form, token);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_password",
      message: "Password must be a string if provided.",
    });
    // Nothing was stored
    const after = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("PROBE H2: JSON paste with non-string password (number) returns 400 invalid_password", async () => {
    const token = await validToken();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    const { body, headers } = pasteJson({
      content: "# H2",
      format: "markdown",
      slug: "probe-h2",
      password: 123,
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_password",
      message: "Password must be a string if provided.",
    });
    const after = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE I — Multiple PATCH: set → clear → set
  // (AC 5 edge cases)
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE I: PATCH set → clear → set — unlocks deleted each time, last set works", async () => {
    const pageId = "prob0000i";
    await insertPage(db, { id: pageId, slug: "probe-i", title: "Probe I", kind: "html" });

    const token = await validToken();

    // Step 1: Set password
    const set1Res = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "first-secret" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(set1Res.status).toBe(200);
    expect(((await set1Res.json()) as Record<string, unknown>).has_password).toBe(true);
    let hash = await storedPasswordHash(db, pageId);
    expect(await verifyPassword("first-secret", hash!)).toBe(true);
    expect(await pageRev(db, pageId)).toBe(1);

    // Step 2: Clear
    const clearRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(clearRes.status).toBe(200);
    expect(((await clearRes.json()) as Record<string, unknown>).has_password).toBe(false);
    expect(await storedPasswordHash(db, pageId)).toBeNull();
    expect(await pageRev(db, pageId)).toBe(1);

    // Step 3: Set again (different password)
    const set2Res = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "second-secret" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(set2Res.status).toBe(200);
    expect(((await set2Res.json()) as Record<string, unknown>).has_password).toBe(true);
    hash = await storedPasswordHash(db, pageId);
    expect(await verifyPassword("second-secret", hash!)).toBe(true);
    expect(await verifyPassword("first-secret", hash!)).toBe(false);
    expect(await pageRev(db, pageId)).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE J — toPageJson defensive copy (no mutation)
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE J: toPageJson does not mutate the original record", () => {
    // Direct test: call toPageJson with a known object reference and verify
    // the original object is unchanged after the call. Destructuring creates
    // a new object; the source reference is never modified.
    const record: PageRecord = {
      id: "test-id-001",
      slug: "test-slug",
      title: "Test",
      kind: "html",
      rev: 1,
      entry_path: "index.html",
      raw_md_path: null,
      show_source: 0 as const,
      visibility: "public",
      password_hash: "pbkdf2$10000$test-salt$test-hash",
      match_tags: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const snapshot = { ...record };

    const result = toPageJson(record);

    // The result must strip password_hash and add has_password.
    expect(result).not.toHaveProperty("password_hash");
    expect(result.has_password).toBe(true);

    // The original record must be unchanged.
    expect(record).toEqual(snapshot);
    expect(record.password_hash).toBe("pbkdf2$10000$test-salt$test-hash");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE K — R19 regression: deep grep of response bodies
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE K: all response surfaces exclude password_hash, pbkdf2$, and password leakage", async () => {
    const token = await validToken();

    // Create a protected page via multipart
    const form = new FormData();
    appendManifest(form, { slug: "probe-k", password: "s3cret-word" });
    appendFile(form, "index.html", makeFile("index.html", "<h1>K</h1>", "text/html"));

    const createRes = await fetchApi("/api/pages", "POST", form, token);
    expect(createRes.status).toBe(201);
    const createBody = await createRes.text();
    expect(createBody).not.toContain("password_hash");
    expect(createBody).not.toContain("pbkdf2");
    expect(createBody).not.toContain('"password"'); // the only "password": should be "has_password":true
    // R19: Check that the response body does not contain "password": "pbkdf2..." or similar
    expect(createBody).toMatch(/"has_password":true/);
    // Make sure there isn't a "password":"pbkdf2$..." or "password": "s3cret-word"
    const parsed = JSON.parse(createBody);
    for (const key of Object.keys(parsed)) {
      expect(key).not.toBe("password");
      expect(key).not.toBe("password_hash");
    }

    // Get detail
    const pageId = parsed.id;
    const getRes = await fetchApi(`/api/pages/${pageId}`, "GET", null, token);
    expect(getRes.status).toBe(200);
    const getBody = await getRes.text();
    expect(getBody).not.toContain("password_hash");
    expect(getBody).not.toContain("pbkdf2");
    expect(getBody).toMatch(/"has_password":true/);

    // List
    const listRes = await fetchApi("/api/pages", "GET", null, token);
    expect(listRes.status).toBe(200);
    const listBody = await listRes.text();
    expect(listBody).not.toContain("password_hash");
    expect(listBody).not.toContain("pbkdf2");
    expect(listBody).toMatch(/"has_password":true/);

    // PATCH response
    const patchRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "new-secret" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.text();
    expect(patchBody).not.toContain("password_hash");
    expect(patchBody).not.toContain("pbkdf2");
    expect(patchBody).not.toContain("new-secret");
    expect(patchBody).toMatch(/"has_password":true/);

    // PATCH clear response
    const clearRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(clearRes.status).toBe(200);
    const clearBody = await clearRes.text();
    expect(clearBody).not.toContain("password_hash");
    expect(clearBody).not.toContain("pbkdf2");
    expect(clearBody).toMatch(/"has_password":false/);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE L — Read-after-patch-detail via worker.fetch
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE L1: after PATCH setting a password, GET /api/pages/:id returns has_password: true", async () => {
    const pageId = "prob0000l1";
    await insertPage(db, { id: pageId, slug: "probe-l1", title: "Probe L1", kind: "html" });

    const token = await validToken();
    const patchRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "set-via-patch" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(patchRes.status).toBe(200);

    const getRes = await fetchApi(`/api/pages/${pageId}`, "GET", null, token);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(true);
    expect(body).not.toHaveProperty("password_hash");
    expect(JSON.stringify(body)).not.toContain("pbkdf2");
    expect(JSON.stringify(body)).not.toContain("set-via-patch");
  });

  it("PROBE L2: after clearing, GET /api/pages/:id returns has_password: false", async () => {
    const pageId = "prob0000l2";
    await insertPage(db, {
      id: pageId,
      slug: "probe-l2",
      title: "Probe L2",
      kind: "html",
      password_hash: "pbkdf2$10000$salt$hash",
    });

    const token = await validToken();
    const patchRes = await fetchApi(
      `/api/pages/${pageId}`,
      "PATCH",
      JSON.stringify({ password: "" }),
      token,
      { "Content-Type": "application/json" },
    );
    expect(patchRes.status).toBe(200);

    const getRes = await fetchApi(`/api/pages/${pageId}`, "GET", null, token);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as Record<string, unknown>;
    expect(body.has_password).toBe(false);
    expect(body).not.toHaveProperty("password_hash");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PROBE M — Create JSON paste with non-string password (object, array)
  // Additional edge: non-string types beyond number
  // ─────────────────────────────────────────────────────────────────────────
  it("PROBE M1: JSON paste with non-string password (object) returns 400 invalid_password", async () => {
    const token = await validToken();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    const { body, headers } = pasteJson({
      content: "# M1",
      format: "markdown",
      slug: "probe-m1",
      password: { foo: "bar" },
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_password",
      message: "Password must be a string if provided.",
    });
    const after = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});
