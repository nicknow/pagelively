import { describe, expect, it, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { createObjectStore } from "../src/object-store";
import { createPagesRepository } from "../src/pages-repository";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { hashPassword } from "../src/password";
import { generateToken, hashToken, formatUnlockCookie } from "../src/password-token";
import { serveEntry, type EntryServeDependencies } from "../src/entry-serve";
import { createConfig } from "../src/config";
import { createTestCacheService } from "../src/cache-service";

// ===========================================================================
// S23-C validator adversarial probes — written independently of the
// implementer's own tests (test/unlock.test.ts, test/asset-serve.test.ts and
// the extensions to entry-serve/index/form-parser tests). Each probe targets
// an acceptance criterion 1–11 from .work/planner/password-protect-plan.md
// (authoritative), the ADR 0041 decisions, or one of the orchestrator's
// suspected-defect probes (A–I), with a shape the implementer may not have
// covered. Everything observable is asserted through the FULL worker.fetch
// boundary where possible (index.ts dispatch + error boundary), except AC1's
// R2-read-absence which is proven at both layers (landmine bucket at the
// index level, recording spy at the serveEntry level).
// ===========================================================================

const HOST = "https://pages.example.com";
const CDN_HOST = "cdn.example.com";
const isoNow = () => new Date().toISOString();

// --- helpers (raw-SQL seeding, mirroring the pool's real D1) -----------------

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
): Promise<void> {
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

async function clearAll(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM page_unlocks").run();
  await db.prepare("DELETE FROM pages").run();
  await db.prepare("DELETE FROM files").run();
}

async function clearBucket(bucket: R2Bucket): Promise<void> {
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
  return worker.fetch(new Request(`${HOST}${path}`), customEnv ?? env, createExecutionContext());
}

async function fetchRequest(request: Request, customEnv?: Env): Promise<Response> {
  return worker.fetch(request, customEnv ?? env, createExecutionContext());
}

/** Seeds a protected page with a stored entry and an optional unlock row. */
async function seedProtectedEntry(opts: {
  id: string;
  slug?: string | null;
  kind?: string;
  rev?: number;
  entryPath?: string;
  password: string;
  entryBody?: string;
  contentType?: string;
  token?: string;
}): Promise<void> {
  const db = env.DB;
  await insertPage(db, {
    id: opts.id,
    slug: opts.slug,
    kind: opts.kind ?? "html",
    rev: opts.rev ?? 1,
    entry_path: opts.entryPath ?? "index.html",
  });
  const pages = createPagesRepository(db);
  await pages.setPasswordHash(opts.id, await hashPassword(opts.password));
  if (opts.token !== undefined) {
    await createUnlocksRepository(db).create(opts.id, await hashToken(opts.token));
  }
  if (opts.entryBody !== undefined) {
    await createObjectStore(env.BUCKET).put(
      opts.id,
      opts.rev ?? 1,
      opts.entryPath ?? "index.html",
      opts.entryBody,
      opts.contentType ?? "text/html; charset=utf-8",
    );
  }
}

/** Fires an unlock POST with an arbitrary request shape and captures everything. */
async function postUnlockRaw(
  id: string,
  init: { headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string; contentType: string | null }> {
  const res = await fetchRequest(
    new Request(`${HOST}/p/${id}/unlock`, {
      method: "POST",
      headers: init.headers,
      body: init.body,
    }),
  );
  return {
    status: res.status,
    body: await res.text(),
    contentType: res.headers.get("Content-Type"),
  };
}

/** Assert the protected-surface invariants: no-store and NEVER a Cache-Tag. */
function expectProtected(res: Response): void {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Cache-Tag")).toBeNull();
}

/** Assert the CDN host appears nowhere in the body OR any header value. */
function expectNoCdnHost(res: Response, body: string): void {
  expect(body).not.toContain(CDN_HOST);
  for (const [name, value] of res.headers.entries()) {
    expect(`${name}: ${value}`, `header ${name} must not reference the CDN host`).not.toContain(
      CDN_HOST,
    );
  }
}

// ===========================================================================
// AC 1 — no-cookie GET → 200 prompt, no-store, no Cache-Tag, NO R2 read
// ===========================================================================

describe("AC1 — no-cookie prompt and R2-read absence", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("serves the prompt from /{slug}/ and /p/{id}/ with a LANDMINE bucket (R2 get() would explode)", async () => {
    // The bucket throws on ANY get(): if the gate so much as touches R2 the
    // prompt would turn into a 500. A 200 prompt proves no R2 read.
    const landmine = {
      get: () => {
        throw new Error("R2 get() must not be called on the no-cookie prompt path");
      },
    } as unknown as R2Bucket;
    const envL = makeEnv({ BUCKET: landmine });

    await seedProtectedEntry({ id: "pageC000001", slug: "locked", password: "secret1" });

    const viaSlug = await fetchIndex("/locked/", envL);
    expect(viaSlug.status).toBe(200);
    expect(viaSlug.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectProtected(viaSlug);
    const slugText = await viaSlug.text();
    expect(slugText).toContain("This page is password protected.");
    expect(slugText).toContain('action="/p/pageC000001/unlock"');

    const viaId = await fetchIndex("/p/pageC000001/", envL);
    expect(viaId.status).toBe(200);
    expect(viaId.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectProtected(viaId);
    expect(await viaId.text()).toContain("This page is password protected.");
  });

  it("records ZERO objects.get() calls through the serveEntry seam for every not-unlocked cookie state", async () => {
    const real = createObjectStore(env.BUCKET);
    const calls: Array<[string, number, string]> = [];
    const objects = {
      get: vi.fn(async (id: string, rev: number, path: string) => {
        calls.push([id, rev, path]);
        return real.get(id, rev, path);
      }),
    };

    function deps(): EntryServeDependencies {
      return {
        config: {
          ...createConfig(env),
          siteName: "Pagelively",
          assetBaseUrl: `https://${CDN_HOST}`,
        },
        pages: createPagesRepository(env.DB),
        unlocks: createUnlocksRepository(env.DB),
        objects,
        cache: createTestCacheService(),
      };
    }

    await seedProtectedEntry({
      id: "pageC000002",
      slug: "locked2",
      password: "secret1",
      entryBody: "<!doctype html><p>Unlocked</p>",
    });

    // No cookie.
    await serveEntry(new Request(`${HOST}/locked2/`), deps());
    // Malformed cookie.
    await serveEntry(
      new Request(`${HOST}/locked2/`, { headers: { Cookie: "pl_unlock=garbage" } }),
      deps(),
    );
    // Valid-format cookie for a DIFFERENT page (no row for this page).
    await serveEntry(
      new Request(`${HOST}/locked2/`, {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC999999", generateToken())}` },
      }),
      deps(),
    );
    // Stale cookie — syntactically valid for THIS page, but no unlock row.
    await serveEntry(
      new Request(`${HOST}/locked2/`, {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC000002", generateToken())}` },
      }),
      deps(),
    );

    expect(calls).toHaveLength(0);

    // Control: a valid cookie DOES read R2 exactly once (the entry object).
    const token = generateToken();
    await createUnlocksRepository(env.DB).create("pageC000002", await hashToken(token));
    const res = await serveEntry(
      new Request(`${HOST}/locked2/`, {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC000002", token)}` },
      }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([["pageC000002", 1, "index.html"]]);
  });
});

// ===========================================================================
// AC 2 — valid-cookie entry: Worker-origin base href, CDN host nowhere,
//        no-store
// ===========================================================================

describe("AC2 — unlocked entry, Worker-origin base, zero CDN references", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("injects the exact protected base href and never leaks the CDN host in body or headers", async () => {
    const token = generateToken();
    await seedProtectedEntry({
      id: "pageC000003",
      slug: "secured",
      rev: 4,
      password: "secret1",
      entryBody: "<!doctype html><html><head></head><body><h1>Secret</h1></body></html>",
      token,
    });

    const res = await fetchIndex(
      "/secured/",
      makeEnv({ SITE_NAME: "Pagelively", ASSET_BASE_URL: `https://${CDN_HOST}` }),
    );
    // Valid-cookie variant must be requested separately with the Cookie header.
    const unlocked = await fetchRequest(
      new Request(`${HOST}/secured/`, {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC000003", token)}` },
      }),
      makeEnv({ SITE_NAME: "Pagelively", ASSET_BASE_URL: `https://${CDN_HOST}` }),
    );

    expect(unlocked.status).toBe(200);
    expect(unlocked.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectProtected(unlocked);
    const text = await unlocked.text();
    expect(text).toContain(`<base href="${HOST}/assets/pages/pageC000003/4/index.html">`);
    expect(text).toContain("<h1>Secret</h1>");
    expectNoCdnHost(unlocked, text);

    // The locked prompt is equally CDN-free.
    expect(res.status).toBe(200);
    expectNoCdnHost(res, await res.text());
  });
});

// ===========================================================================
// AC 3 — malformed / foreign-page / stale cookie → prompt, never error/crash
// ===========================================================================

describe("AC3 — hostile cookie states always produce the prompt", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("prompts (200, no 500, no entry content) for malformed/foreign/stale cookies", async () => {
    const token = generateToken();
    await seedProtectedEntry({
      id: "pageC000004",
      slug: "gated",
      password: "secret1",
      entryBody: "<!doctype html><p>MUST NOT LEAK</p>",
      token,
    });

    const cases: Array<{ label: string; cookie: string }> = [
      { label: "no cookie", cookie: "" },
      { label: "garbage", cookie: "pl_unlock=not-a-cookie" },
      {
        label: "wrong page id",
        cookie: `pl_unlock=${formatUnlockCookie("pageC000004", generateToken())}`,
      },
      {
        label: "other page id",
        cookie: `pl_unlock=${formatUnlockCookie("pageC999999", generateToken())}`,
      },
      {
        label: "stale (row deleted)",
        cookie: `pl_unlock=${formatUnlockCookie("pageC000004", token)}`,
      },
      { label: "double-dot token", cookie: "pl_unlock=pageC000004.aaa.bbb" },
      { label: "bad id charset", cookie: "pl_unlock=bad.id!tokenvalue" },
      { label: "wrong length token", cookie: "pl_unlock=pageC000004.short" },
    ];

    for (const c of cases) {
      // "stale": the row is deleted for exactly that case, after a valid row exists.
      if (c.label === "stale (row deleted)") {
        await createUnlocksRepository(db).create("pageC000004", await hashToken(token));
        await createUnlocksRepository(db).deleteByPageId("pageC000004");
      }
      const headers: Record<string, string> = {};
      if (c.cookie !== "") headers.Cookie = c.cookie;
      const res = await fetchRequest(new Request(`${HOST}/gated/`, { headers }));

      expect(res.status, `${c.label}: expected prompt 200, got ${res.status}`).toBe(200);
      expectProtected(res);
      const text = await res.text();
      expect(text, c.label).toContain("This page is password protected.");
      expect(text, c.label).not.toContain("MUST NOT LEAK");
    }
  });
});

// ===========================================================================
// AC 4 — protected image bytes (no 301) vs public image 301 (regression)
// ===========================================================================

describe("AC4 — protected images serve bytes; public images keep the 301", () => {
  const db = env.DB;
  const bucket = env.BUCKET;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(bucket);
  });

  it("protected image: prompt without cookie, image/* bytes with cookie, never 301", async () => {
    const token = generateToken();
    await seedProtectedEntry({
      id: "pageC000005",
      slug: "pict",
      kind: "image",
      entryPath: "photo.jpg",
      password: "secret1",
      entryBody: "fake-jpeg-bytes",
      contentType: "image/jpeg",
      token,
    });

    const locked = await fetchIndex("/pict/");
    expect(locked.status).toBe(200);
    expect(locked.headers.get("Location")).toBeNull();
    expectProtected(locked);
    expect(await locked.text()).toContain("This page is password protected.");

    const unlocked = await fetchRequest(
      new Request(`${HOST}/pict/`, {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC000005", token)}` },
      }),
    );
    expect(unlocked.status).toBe(200);
    expect(unlocked.headers.get("Location")).toBeNull();
    expect(unlocked.headers.get("Content-Type")).toBe("image/jpeg");
    expectProtected(unlocked);
    expect(await unlocked.text()).toBe("fake-jpeg-bytes");
  });

  it("regression: UNPROTECTED image still 301s to the CDN with a page Cache-Tag", async () => {
    await insertPage(db, {
      id: "pageC000006",
      slug: "public-img",
      kind: "image",
      entry_path: "photo.jpg",
      rev: 2,
    });
    await createObjectStore(bucket).put("pageC000006", 2, "photo.jpg", "bytes", "image/jpeg");

    const res = await fetchIndex("/public-img/");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`https://${CDN_HOST}/pages/pageC000006/2/photo.jpg`);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(res.headers.get("Cache-Tag")).toBe("page-pageC000006");
  });
});

// ===========================================================================
// AC 5 — home mode pointing at a protected slug
// ===========================================================================

describe("AC5 — home-mode protected page", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("serves the prompt at / and the entry at / with a valid cookie", async () => {
    const token = generateToken();
    await seedProtectedEntry({
      id: "pageC000007",
      slug: "homesec",
      password: "secret1",
      entryBody: "<!doctype html><h1>Home Secured</h1>",
      token,
    });
    const envHome = makeEnv({ HOME_MODE: "page", HOME_PAGE_SLUG: "homesec" });

    const locked = await fetchIndex("/", envHome);
    expect(locked.status).toBe(200);
    expectProtected(locked);
    expect(await locked.text()).toContain("This page is password protected.");

    const unlocked = await fetchRequest(
      new Request(`${HOST}/`, {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC000007", token)}` },
      }),
      envHome,
    );
    expect(unlocked.status).toBe(200);
    expectProtected(unlocked);
    const text = await unlocked.text();
    expect(text).toContain("<h1>Home Secured</h1>");
    expect(text).toContain(`<base href="${HOST}/assets/pages/pageC000007/1/index.html">`);
    expectNoCdnHost(unlocked, text);
  });
});

// ===========================================================================
// AC 6 — unlock POST → 303 + exact cookie; rotation kills the old cookie
// ===========================================================================

describe("AC6 — unlock POST, exact cookie, and rotation", () => {
  const db = env.DB;
  const bucket = env.BUCKET;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(bucket);
  });

  it("303 → /p/{id}/ with the exact cookie; a second unlock invalidates the first cookie end-to-end", async () => {
    await seedProtectedEntry({
      id: "pageC000008",
      slug: "rotate",
      password: "secret1",
      entryBody: "<!doctype html><p>Unlocked</p>",
    });

    const cookieFrom = (res: Response): string => {
      const header = res.headers.get("Set-Cookie");
      expect(header).toMatch(
        /^pl_unlock=pageC000008\.[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure$/,
      );
      return header!.slice("pl_unlock=".length, header!.indexOf(";"));
    };

    const first = await fetchRequest(
      new Request(`${HOST}/p/pageC000008/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=secret1",
      }),
    );
    expect(first.status).toBe(303);
    expect(first.headers.get("Location")).toBe("/p/pageC000008/");
    expectProtected(first);
    const cookie1 = cookieFrom(first);

    // Cookie 1 unlocks the page.
    const with1 = await fetchRequest(
      new Request(`${HOST}/p/pageC000008/`, { headers: { Cookie: `pl_unlock=${cookie1}` } }),
    );
    expect(with1.status).toBe(200);
    expect(await with1.text()).toContain("<p>Unlocked</p>");

    // Second unlock (same password) rotates the token.
    const second = await fetchRequest(
      new Request(`${HOST}/p/pageC000008/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=secret1",
      }),
    );
    expect(second.status).toBe(303);
    const cookie2 = cookieFrom(second);
    expect(cookie2).not.toBe(cookie1);

    // OLD cookie no longer unlocks; NEW cookie does.
    const stale = await fetchRequest(
      new Request(`${HOST}/p/pageC000008/`, { headers: { Cookie: `pl_unlock=${cookie1}` } }),
    );
    expect(stale.status).toBe(200);
    expect(await stale.text()).toContain("This page is password protected.");

    const fresh = await fetchRequest(
      new Request(`${HOST}/p/pageC000008/`, { headers: { Cookie: `pl_unlock=${cookie2}` } }),
    );
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain("<p>Unlocked</p>");

    // Exactly one row, holding the SHA-256 of the newest token only.
    const unlocks = createUnlocksRepository(db);
    const row = await unlocks.getByPageId("pageC000008");
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBe(await hashToken(cookie2.split(".")[1]));
    expect(row!.tokenHash).not.toBe(await hashToken(cookie1.split(".")[1]));
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM page_unlocks WHERE page_id = ?")
      .bind("pageC000008")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

// ===========================================================================
// AC 7 — wrong password: 200 prompt with escaped error; XSS payload probe
// ===========================================================================

describe("AC7 — wrong password renders an escaped inline error", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("a hostile password never appears unescaped and no script element is rendered", async () => {
    await seedProtectedEntry({ id: "pageC000009", slug: "xss", password: "secret1" });

    const payload = `"><script>window.__xssProbe=1</script><img src=x onerror=window.__xssProbe=2>`;
    const res = await fetchRequest(
      new Request(`${HOST}/p/pageC000009/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `password=${encodeURIComponent(payload)}`,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectProtected(res);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const text = await res.text();
    expect(text).toContain("Incorrect password.");
    expect(text).toContain('role="alert"');
    // The hostile payload must not appear raw, and no <script> element may exist.
    expect(text).not.toContain(payload);
    expect(text).not.toContain("<script");
    expect(text).not.toContain("__xssProbe");
    // No unlock row was created by a wrong guess.
    expect(await createUnlocksRepository(db).getByPageId("pageC000009")).toBeNull();
  });

  it("a hostile SITE_NAME is escaped in the prompt document", async () => {
    await seedProtectedEntry({ id: "pageC000010", slug: "sitexss", password: "secret1" });
    const envHostile = makeEnv({ SITE_NAME: `</title><script>window.__x=1</script>` });

    const res = await fetchIndex("/sitexss/", envHostile);
    expect(res.status).toBe(200);
    const text = await res.text();
    // No raw breakout sequence may survive: the <title> context cannot be
    // closed and no element may be created. The payload's inert text (e.g.
    // "window.__x=1") remaining inside an escaped entity is fine.
    expect(text).not.toContain("<script");
    expect(text).not.toContain("</title><script>");
    expect(text).toContain("&lt;/title&gt;");
    expect(text).toContain("&lt;script&gt;");
  });
});

// ===========================================================================
// AC 8 — POST/GET/method matrix, all errors through the JSON error boundary
// ===========================================================================

describe("AC8 — unlock route error matrix via the full boundary", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  function urlencoded(password: string): string {
    return `password=${encodeURIComponent(password)}`;
  }

  it("POST invalid id format → 400 JSON invalid_id (no-store)", async () => {
    const res = await fetchRequest(
      new Request(`${HOST}/p/bad.id/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: urlencoded("secret1"),
      }),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expectProtected(res);
    expect(await res.json()).toMatchObject({ error: "invalid_id" });
  });

  it("POST unknown id → clean 404 (no protection-state disclosure)", async () => {
    const res = await fetchRequest(
      new Request(`${HOST}/p/Unknown000/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: urlencoded("secret1"),
      }),
    );
    expect(res.status).toBe(404);
    expectProtected(res);
  });

  it("POST missing / blank / 4-char / 257-char passwords → 400 invalid_password", async () => {
    await seedProtectedEntry({ id: "pageC000011", slug: "pw", password: "secret1" });

    for (const body of [
      "foo=bar",
      "password=",
      "password=%20%20",
      urlencoded("abcd"),
      urlencoded("x".repeat(257)),
    ]) {
      const res = await fetchRequest(
        new Request(`${HOST}/p/pageC000011/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
      expect(res.status, `body=${body.slice(0, 30)}…`).toBe(400);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expectProtected(res);
      const json = (await res.json()) as { error: string };
      expect(json.error, body).toBe("invalid_password");
    }
    expect(await createUnlocksRepository(db).getByPageId("pageC000011")).toBeNull();
  });

  it("POST 5-char and 256-char passwords are accepted (303)", async () => {
    // OQ-21 boundary rule (src/password.ts): min 5 / max 256 after trim. Each
    // page is seeded with the exact password under test, so a 303 proves the
    // bound is accepted end-to-end (a 200 would mean "wrong password").
    const cases: Array<{ id: string; slug: string; password: string }> = [
      { id: "pageC000011", slug: "pw5", password: "abcde" },
      { id: "pageC000011b", slug: "pw256", password: "x".repeat(256) },
    ];
    for (const { id, slug, password } of cases) {
      await seedProtectedEntry({ id, slug, password });
      const res = await fetchRequest(
        new Request(`${HOST}/p/${id}/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: urlencoded(password),
        }),
      );
      expect(res.status, `password length ${password.length}`).toBe(303);
      expect(res.headers.get("Location")).toBe(`/p/${id}/`);
    }
  });

  it("POST on an UNPROTECTED page → clean 404 (no state disclosure)", async () => {
    await insertPage(db, { id: "pageC000012", slug: "open", kind: "html" });
    const res = await fetchRequest(
      new Request(`${HOST}/p/pageC000012/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: urlencoded("secret1"),
      }),
    );
    expect(res.status).toBe(404);
    expectProtected(res);
    expect(await res.text()).toContain("Not Found");
  });

  it("GET unlock → prompt for protected, clean 404 for unknown/unprotected", async () => {
    await seedProtectedEntry({ id: "pageC000011", slug: "pw", password: "secret1" });
    await insertPage(db, { id: "pageC000012", slug: "open", kind: "html" });

    const protectedGet = await fetchIndex("/p/pageC000011/unlock");
    expect(protectedGet.status).toBe(200);
    expect(protectedGet.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectProtected(protectedGet);
    expect(await protectedGet.text()).toContain("This page is password protected.");

    for (const path of ["/p/pageC000012/unlock", "/p/Unknown000/unlock"]) {
      const res = await fetchIndex(path);
      expect(res.status, path).toBe(404);
      expectProtected(res);
    }
  });

  it("PUT/PATCH/DELETE/HEAD on the unlock route → 405 JSON method_not_allowed, no-store", async () => {
    await seedProtectedEntry({ id: "pageC000011", slug: "pw", password: "secret1" });
    // Also 405 for an UNKNOWN id — the method check must not disclose page state.
    for (const target of ["/p/pageC000011/unlock", "/p/Unknown000/unlock"]) {
      for (const method of ["PUT", "PATCH", "DELETE", "HEAD"]) {
        const res = await fetchRequest(new Request(`${HOST}${target}`, { method }));
        expect(res.status, `${method} ${target}`).toBe(405);
        expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
        expectProtected(res);
        expect(await res.json()).toMatchObject({ error: "method_not_allowed" });
      }
    }
  });
});

// ===========================================================================
// AC 9 — serveAsset matrix: rev rules, traversal, malformed encodings
// ===========================================================================

describe("AC9 — serveAsset rev/path/encoding matrix", () => {
  const db = env.DB;
  const bucket = env.BUCKET;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(bucket);
  });

  it("valid GET → stored bytes + stored content type + no-store; missing → 404; invalid id → 400", async () => {
    await createObjectStore(bucket).put(
      "pageC000013",
      1,
      "index.html",
      "<p>asset</p>",
      "text/html; charset=utf-8",
    );

    const ok = await fetchIndex("/assets/pages/pageC000013/1/index.html");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expectProtected(ok);
    expect(await ok.text()).toContain("<p>asset</p>");

    const missing = await fetchIndex("/assets/pages/pageC000013/1/absent.html");
    expect(missing.status).toBe(404);
    expectProtected(missing);

    const badId = await fetchIndex("/assets/pages/bad.id/1/index.html");
    expect(badId.status).toBe(400);
    expect(await badId.json()).toMatchObject({ error: "invalid_id" });
    expectProtected(badId);
  });

  it("rev matrix: 0/-1/abc/1.5/1e2/+1/999999999999999999999999 → 400 invalid_rev; '01' → accepted as rev 1 (decision, documented)", async () => {
    await createObjectStore(bucket).put("pageC000014", 1, "index.html", "v1", "text/html");

    for (const rev of ["0", "-1", "abc", "1.5", "2e2", "+1", "1e0", "999999999999999999999999"]) {
      const res = await fetchIndex(`/assets/pages/pageC000014/${rev}/index.html`);
      expect(res.status, `rev=${rev}`).toBe(400);
      expect(await res.json(), `rev=${rev}`).toMatchObject({ error: "invalid_rev" });
      expectProtected(res);
    }

    // DECISION (documented in the validator report): "01" is a positive
    // integer string and parses to rev 1; leading zeros are accepted and
    // normalize to the same R2 key (no ambiguity — keys always use the
    // decimal form of the integer).
    const leadingZero = await fetchIndex("/assets/pages/pageC000014/01/index.html");
    expect(leadingZero.status).toBe(200);
    expect(await leadingZero.text()).toBe("v1");
  });

  it("traversal shapes never serve a NON-target sibling; reachable shapes are 400", async () => {
    const store = createObjectStore(bucket);
    // Two sibling keys: root-level (the normalized target) and nested under
    // foo/ (the key a raw ".." request would aim at).
    await store.put("pageC000015", 1, "sibling.html", "ROOT-SIBLING", "text/html");
    await store.put("pageC000015", 1, "foo/sibling.html", "FOO-SIBLING", "text/html");

    // Encoded shapes that REACH the server are rejected (400/404) and never
    // serve either sibling key.
    const expectNoSiblingLeak = async (path: string): Promise<void> => {
      const res = await fetchIndex(`/assets/pages/pageC000015/1/${path}`);
      expect(res.status, `path=${path} (got ${res.status})`).toBeLessThan(500);
      const text = await res.text();
      expect(text, `path=${path}`).not.toContain("SIBLING");
    };

    // Reachable decoded-".." via backslash → typed 400 path_traversal.
    const bs = await fetchIndex("/assets/pages/pageC000015/1/%2e%2e%5csibling.html");
    expect(bs.status).toBe(400);
    expect(await bs.json()).toMatchObject({ error: "path_traversal" });

    // Embedded dot-dot in a segment (foo%2e%2e/…) is NOT a URL dot-segment,
    // survives normalization, and decodes to "../" → 400 path_traversal.
    const embedded = await fetchIndex("/assets/pages/pageC000015/1/foo%2e%2e/sibling.html");
    expect(embedded.status).toBe(400);
    expect(await embedded.json()).toMatchObject({ error: "path_traversal" });

    // Raw "foo/../sibling.html" — the WHATWG URL parser collapses the dot
    // segment BEFORE the Worker sees it, so the server can only ever see the
    // normalized path "/sibling.html". It must therefore serve EXACTLY the
    // root sibling (the normalized target), never the foo/ sibling it was
    // aimed at. (Documented: the 400 path_traversal branch is unreachable
    // for literal dot segments — the client normalizes them away.)
    const raw = await fetchIndex("/assets/pages/pageC000015/1/foo/../sibling.html");
    expect(raw.status).toBe(200);
    const rawText = await raw.text();
    expect(rawText, "raw .. may only resolve to its normalized target").toBe("ROOT-SIBLING");
    expect(rawText).not.toContain("FOO-SIBLING");

    // %2e%2e is treated as a dot segment by the URL parser (it pops the
    // preceding "1" segment, leaving a path that no longer matches the asset
    // route shape) → clean 404, fail-closed, never sibling content.
    const encDot = await fetchIndex("/assets/pages/pageC000015/1/%2e%2e/sibling.html");
    expect(encDot.status).toBe(404);
    expect(await encDot.text()).not.toContain("SIBLING");

    // Encoded dots + encoded slash → one opaque segment; the router's
    // encoded-slash rule → unknown → clean 404.
    await expectNoSiblingLeak("%2e%2e%2fsibling.html");
    await expectNoSiblingLeak("%2E%2E%2Fetc/passwd");

    // ".." alone as the last segment → normalized away → no file path → 404.
    await expectNoSiblingLeak("%2e%2e");

    // Control: the nested sibling is served normally at its own path.
    const control = await fetchIndex("/assets/pages/pageC000015/1/foo/sibling.html");
    expect(control.status).toBe(200);
    expect(await control.text()).toBe("FOO-SIBLING");
  });

  it("malformed percent-encoding → clean 404, never 500", async () => {
    for (const path of ["bad%2.html", "bad%zz.html", "a%2", "%"]) {
      const res = await fetchIndex(`/assets/pages/pageC000016/1/${path}`);
      expect(res.status, `path=${path}`).toBe(404);
      expectProtected(res);
      expect(await res.text()).toContain("Not Found");
    }
  });

  it("encoded slash in an asset path → classified unknown → clean 404", async () => {
    const res = await fetchIndex("/assets/pages/pageC000016/1/a%2Fb.html");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Not Found");
  });
});

// ===========================================================================
// AC 10 — no-store + no Cache-Tag on EVERY surface response
// ===========================================================================

describe("AC10 — protected-surface header sweep (no-store, never a Cache-Tag)", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("every surface response carries no-store and no Cache-Tag", async () => {
    const token = generateToken();
    await seedProtectedEntry({
      id: "pageC000017",
      slug: "sweep",
      kind: "image",
      entryPath: "photo.jpg",
      password: "secret1",
      entryBody: "bytes",
      contentType: "image/jpeg",
      token,
    });
    await createObjectStore(env.BUCKET).put(
      "pageC000017",
      1,
      "index.html",
      "<p>entry</p>",
      "text/html",
    );

    const responses: Array<{ label: string; res: Response }> = [];

    responses.push({ label: "prompt", res: await fetchIndex("/sweep/") });
    responses.push({
      label: "unlocked entry",
      res: await fetchRequest(
        new Request(`${HOST}/sweep/`, {
          headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC000017", token)}` },
        }),
      ),
    });
    responses.push({
      label: "protected image bytes",
      res: await fetchRequest(
        new Request(`${HOST}/photo/`, {
          headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC000017", token)}` },
        }),
      ).catch(() => null as unknown as Response),
    });
    responses.push({
      label: "asset bytes",
      res: await fetchIndex("/assets/pages/pageC000017/1/photo.jpg"),
    });
    responses.push({
      label: "unlock 303",
      res: await fetchRequest(
        new Request(`${HOST}/p/pageC000017/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "password=secret1",
        }),
      ),
    });
    responses.push({
      label: "400 invalid_rev",
      res: await fetchIndex("/assets/pages/pageC000017/abc/photo.jpg"),
    });
    responses.push({
      label: "404 missing object",
      res: await fetchIndex("/assets/pages/pageC000017/1/nope.jpg"),
    });
    responses.push({
      label: "405 on unlock",
      res: await fetchRequest(new Request(`${HOST}/p/pageC000017/unlock`, { method: "PUT" })),
    });
    responses.push({ label: "GET-unlock prompt", res: await fetchIndex("/p/pageC000017/unlock") });

    for (const { label, res } of responses) {
      expect(res, label).toBeDefined();
      expect(res.status, label).toBeLessThan(500);
      expect(res.headers.get("Cache-Control"), `${label}: Cache-Control`).toBe("no-store");
      expect(res.headers.get("Cache-Tag"), `${label}: Cache-Tag`).toBeNull();
    }
  });
});

// ===========================================================================
// AC 11 — cookie parsing total: garbage, duplicates, huge values
// ===========================================================================

describe("AC11 — cookie parsing is total (never throws, never 500s)", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("garbage, duplicate and huge Cookie headers produce the prompt, not a 500", async () => {
    const token = generateToken();
    await seedProtectedEntry({
      id: "pageC000018",
      slug: "cookies",
      password: "secret1",
      entryBody: "<!doctype html><p>Unlocked</p>",
      token,
    });
    const good = formatUnlockCookie("pageC000018", token);

    // "Huge" cookie: 200 kB of junk in the value (far beyond any real cookie).
    const huge = `${"x".repeat(200_000)}`;
    const cases: Array<{ label: string; cookie: string }> = [
      { label: "single garbage", cookie: "pl_unlock=!!!not-a-cookie" },
      // NOTE: "duplicate, first valid" and "many cookies around a good one"
      // are intentionally NOT here — first-wins means a valid first cookie
      // unlocks (asserted in the next test).
      { label: "duplicate, first garbage", cookie: `pl_unlock=garbage; pl_unlock=${good}` },
      { label: "huge value", cookie: `pl_unlock=${huge}` },
      { label: "name with no value", cookie: "pl_unlock" },
      { label: "empty parts", cookie: ";;;pl_unlock=;;;" },
    ];

    for (const c of cases) {
      const res = await fetchRequest(
        new Request(`${HOST}/cookies/`, { headers: { Cookie: c.cookie } }),
      );
      expect(res.status, `${c.label}: expected prompt 200, got ${res.status}`).toBe(200);
      expectProtected(res);
      expect(await res.text(), c.label).toContain("This page is password protected.");
    }
  });

  it("first-pl_unlock-wins: a duplicate header is resolved deterministically, never throwing", async () => {
    const token = generateToken();
    await seedProtectedEntry({
      id: "pageC000018",
      slug: "cookies",
      password: "secret1",
      entryBody: "<!doctype html><p>Unlocked</p>",
      token,
    });
    const good = formatUnlockCookie("pageC000018", token);

    // First pl_unlock wins: valid first → unlocked.
    const unlocked = await fetchRequest(
      new Request(`${HOST}/cookies/`, {
        headers: { Cookie: `pl_unlock=${good}; pl_unlock=garbage` },
      }),
    );
    expect(unlocked.status).toBe(200);
    expect(await unlocked.text()).toContain("<p>Unlocked</p>");

    // Garbage first → prompt (the second, valid cookie is ignored — first-wins).
    const locked = await fetchRequest(
      new Request(`${HOST}/cookies/`, {
        headers: { Cookie: `pl_unlock=garbage; pl_unlock=${good}` },
      }),
    );
    expect(locked.status).toBe(200);
    expect(await locked.text()).toContain("This page is password protected.");

    // A valid cookie surrounded by unrelated cookies still resolves to it.
    const surrounded = await fetchRequest(
      new Request(`${HOST}/cookies/`, {
        headers: { Cookie: `a=1; b=2; pl_unlock=${good}; c=3; d=4` },
      }),
    );
    expect(surrounded.status).toBe(200);
    expect(await surrounded.text()).toContain("<p>Unlocked</p>");
  });
});

// ===========================================================================
// Adversarial probe A–D — unlock POST with non-form bodies must not 500
// ===========================================================================

describe("Adversarial A–D — unlock POST body/content-type matrix (spec AC8: all errors via toErrorResponse)", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("A: Content-Type text/plain on the unlock POST must not produce a 500", async () => {
    await seedProtectedEntry({ id: "pageC000019", slug: "ct", password: "secret1" });
    const r = await postUnlockRaw("pageC000019", {
      headers: { "Content-Type": "text/plain" },
      body: "password=secret1",
    });
    // Spec AC8: everything goes through toErrorResponse — a user-craftable
    // request must yield a typed 4xx, never the generic 500 boundary.
    expect(
      r.status,
      `text/plain unlock: expected <500, got ${r.status} body=${r.body} ct=${r.contentType}`,
    ).toBeLessThan(500);
  });

  it("A2: Content-Type application/json on the unlock POST must not produce a 500", async () => {
    await seedProtectedEntry({ id: "pageC000019", slug: "ct", password: "secret1" });
    const r = await postUnlockRaw("pageC000019", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "secret1" }),
    });
    expect(
      r.status,
      `json unlock: expected <500, got ${r.status} body=${r.body} ct=${r.contentType}`,
    ).toBeLessThan(500);
  });

  it("B: no Content-Type with a urlencoded body must not produce a 500", async () => {
    await seedProtectedEntry({ id: "pageC000019", slug: "ct", password: "secret1" });
    const r = await postUnlockRaw("pageC000019", { body: "password=secret1" });
    expect(
      r.status,
      `no-content-type unlock: expected <500, got ${r.status} body=${r.body} ct=${r.contentType}`,
    ).toBeLessThan(500);
  });

  it("C: empty POST body (no Content-Type) must not produce a 500", async () => {
    await seedProtectedEntry({ id: "pageC000019", slug: "ct", password: "secret1" });
    const r = await postUnlockRaw("pageC000019", { body: "" });
    expect(
      r.status,
      `empty-body unlock: expected <500, got ${r.status} body=${r.body} ct=${r.contentType}`,
    ).toBeLessThan(500);
  });

  it("D: multipart/form-data with a malformed boundary must not produce a 500", async () => {
    await seedProtectedEntry({ id: "pageC000019", slug: "ct", password: "secret1" });
    const r = await postUnlockRaw("pageC000019", {
      headers: { "Content-Type": "multipart/form-data; boundary=does-not-exist-in-body" },
      body: '--not-the-boundary\r\nContent-Disposition: form-data; name="password"\r\n\r\nsecret1\r\n--not-the-boundary--',
    });
    expect(
      r.status,
      `malformed-multipart unlock: expected <500, got ${r.status} body=${r.body} ct=${r.contentType}`,
    ).toBeLessThan(500);
  });
});

// ===========================================================================
// Adversarial probe E — `..` inside a path, not at segment start
// ===========================================================================

describe("Adversarial E — `..` inside a path never serves a sibling", () => {
  const bucket = env.BUCKET;

  beforeEach(async () => {
    await clearAll(env.DB);
    await clearBucket(bucket);
  });

  it("foo/../index.html (raw and encoded shapes) can never read a NON-target key", async () => {
    const store = createObjectStore(bucket);
    await store.put("pageC000020", 1, "index.html", "ENTRY-INDEX", "text/html");
    await store.put("pageC000020", 1, "sibling.html", "ROOT-SIBLING", "text/html");
    // Canary key "aimed at" by the raw dot-segment shapes below.
    await store.put("pageC000020", 1, "foo/sibling.html", "FOO-SIBLING", "text/html");

    // Raw / percent-encoded dot segments are collapsed by the URL parser
    // BEFORE the Worker sees them. "foo/…" shapes resolve to /sibling.html
    // (the normalized target) — never to the foo/ key they were aimed at.
    for (const shape of ["foo/../sibling.html", "foo/%2e%2e/sibling.html"]) {
      const res = await fetchIndex(`/assets/pages/pageC000020/1/${shape}`);
      expect(res.status, `shape=${shape} (got ${res.status})`).toBe(200);
      const text = await res.text();
      expect(text, `shape=${shape}`).toBe("ROOT-SIBLING");
      expect(text).not.toContain("FOO-SIBLING");
      expect(text).not.toContain("internal_error");
    }

    // "%2e%2e" at segment start pops the preceding "1" rev segment, leaving a
    // path that no longer matches the asset route shape → clean 404.
    const bare = await fetchIndex("/assets/pages/pageC000020/1/%2e%2e/sibling.html");
    expect(bare.status).toBe(404);
    expect(await bare.text()).not.toContain("SIBLING");

    // Embedded dot-dot (NOT at segment start) survives URL parsing and is
    // rejected by the server: typed 400, never sibling content.
    for (const shape of ["foo%2e%2e/sibling.html", "foo%2E%2E/sibling.html"]) {
      const res = await fetchIndex(`/assets/pages/pageC000020/1/${shape}`);
      expect(res.status, `shape=${shape}`).toBe(400);
      expect(await res.json()).toMatchObject({ error: "path_traversal" });
    }
  });
});

// ===========================================================================
// Adversarial probe F — cookie for a DIFFERENT but valid page
// ===========================================================================

describe("Adversarial F — a valid cookie for another page does not unlock", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("page B's valid token never unlocks page A", async () => {
    const tokenB = generateToken();
    await seedProtectedEntry({
      id: "pageC000021",
      slug: "a",
      password: "secret1",
      entryBody: "<p>A</p>",
    });
    await seedProtectedEntry({
      id: "pageC000022",
      slug: "b",
      password: "secret1",
      entryBody: "<p>B</p>",
      token: tokenB,
    });

    const res = await fetchRequest(
      new Request(`${HOST}/a/`, {
        headers: { Cookie: `pl_unlock=${formatUnlockCookie("pageC000022", tokenB)}` },
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("This page is password protected.");
    expect(text).not.toContain("<p>A</p>");
  });
});

// ===========================================================================
// Adversarial probe G — trailing-slash 301 regression matrix
// ===========================================================================

describe("Adversarial G — trailing-slash 301 regression matrix", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("/p/{id}/unlock and /assets/... never 301; /p/{id} and /{slug} still 301", async () => {
    await seedProtectedEntry({ id: "pageC000023", slug: "noredir", password: "secret1" });
    await createObjectStore(env.BUCKET).put(
      "pageC000023",
      1,
      "index.html",
      "<p>x</p>",
      "text/html",
    );

    // Unlock GET without trailing slash → prompt, NOT a 301.
    const unlock = await fetchIndex("/p/pageC000023/unlock");
    expect(unlock.status).toBe(200);
    expect(unlock.headers.get("Location")).toBeNull();
    expect(await unlock.text()).toContain("This page is password protected.");

    // Asset without trailing slash → bytes, NOT a 301.
    const asset = await fetchIndex("/assets/pages/pageC000023/1/index.html");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Location")).toBeNull();

    // /p/{id} (no slash) → 301 to /p/{id}/ (unchanged).
    const idNoSlash = await fetchIndex("/p/pageC000023");
    expect(idNoSlash.status).toBe(301);
    expect(idNoSlash.headers.get("Location")).toBe(`${HOST}/p/pageC000023/`);

    // /{slug} (no slash) → 301 to /{slug}/ (unchanged).
    const slugNoSlash = await fetchIndex("/noredir");
    expect(slugNoSlash.status).toBe(301);
    expect(slugNoSlash.headers.get("Location")).toBe(`${HOST}/noredir/`);
  });
});

// ===========================================================================
// Adversarial probe H — dispatch order: unlock/asset public, admin/api 403
// ===========================================================================

describe("Adversarial H — public routes before the Access gate; admin/api fail closed", () => {
  const db = env.DB;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(env.BUCKET);
  });

  it("unlock and asset serve WITHOUT any Access JWT; /admin and /api 403 fail-closed", async () => {
    await seedProtectedEntry({ id: "pageC000024", slug: "pub", password: "secret1" });
    await createObjectStore(env.BUCKET).put(
      "pageC000024",
      1,
      "index.html",
      "<p>x</p>",
      "text/html",
    );

    // No Cf-Access-Jwt-Assertion header anywhere in these requests.
    const unlock = await fetchIndex("/p/pageC000024/unlock");
    expect(unlock.status).toBe(200);
    expect(await unlock.text()).toContain("This page is password protected.");

    const asset = await fetchIndex("/assets/pages/pageC000024/1/index.html");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("<p>x</p>");

    const admin = await fetchIndex("/admin");
    expect(admin.status).toBe(403);

    const api = await fetchIndex("/api/pages");
    expect(api.status).toBe(403);

    // A POST to the unlock route with a valid password also needs no JWT.
    const unlockPost = await fetchRequest(
      new Request(`${HOST}/p/pageC000024/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "password=secret1",
      }),
    );
    expect(unlockPost.status).toBe(303);
  });
});

// ===========================================================================
// Adversarial probe I — public (unprotected) pages fully unchanged
// ===========================================================================

describe("Adversarial I — public pages fully unchanged", () => {
  const db = env.DB;
  const bucket = env.BUCKET;

  beforeEach(async () => {
    await clearAll(db);
    await clearBucket(bucket);
  });

  it("public html entry keeps public max-age=300 + Cache-Tag page-{id} and the CDN base href", async () => {
    await insertPage(db, { id: "pageC000025", slug: "pubpage", kind: "html", rev: 2 });
    await createObjectStore(bucket).put(
      "pageC000025",
      2,
      "index.html",
      "<!doctype html><html><head></head><body><p>Public</p></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await fetchIndex("/pubpage/");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
    expect(res.headers.get("Cache-Tag")).toBe("page-pageC000025");
    const text = await res.text();
    expect(text).toContain(`<base href="https://${CDN_HOST}/pages/pageC000025/2/index.html">`);
    expect(text).toContain("<p>Public</p>");
  });

  it("public image still 301s; a public page never shows the prompt", async () => {
    await insertPage(db, {
      id: "pageC000026",
      slug: "pubimg",
      kind: "image",
      entry_path: "a.jpg",
      rev: 1,
    });
    await createObjectStore(bucket).put("pageC000026", 1, "a.jpg", "j", "image/jpeg");

    const res = await fetchIndex("/pubimg/");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`https://${CDN_HOST}/pages/pageC000026/1/a.jpg`);
    expect(await fetchIndex("/pubpage/").then((r) => r.text())).not.toContain("password");
  });
});
