import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createPagesRepository } from "../src/pages-repository";
import { createUnlocksRepository } from "../src/unlocks-repository";
import { createTestCacheService } from "../src/cache-service";
import { createConfig, type AppConfig } from "../src/config";
import { serveUnlock, hasValidUnlockCookie, type UnlockDependencies } from "../src/unlock";
import { hashPassword } from "../src/password";
import { generateToken, hashToken, formatUnlockCookie } from "../src/password-token";

// S23-C — Public unlock surface (ADR 0041 decisions 3, 4, 6; architecture 02).
// serveUnlock is exercised against the real D1 emulation through the injected
// repository + cache seam, before it is wired into index.ts. The cookie-check
// helper (hasValidUnlockCookie) is the gate predicate used by serveEntry.

const TEST_CONFIG: AppConfig = {
  siteName: "Pagelively",
  assetBaseUrl: "https://cdn.example.com",
  homeMode: "404",
  homePageSlug: null,
  allowRawHtmlInMd: true,
  access: {
    teamDomainUrl: "https://yourteam.cloudflareaccess.com",
    aud: null,
  },
};

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

async function clearAll(db: D1Database) {
  await db.prepare("DELETE FROM page_unlocks").run();
  await db.prepare("DELETE FROM pages").run();
}

function makeDeps(): UnlockDependencies {
  const config = createConfig(env);
  return {
    config: { ...config, ...TEST_CONFIG },
    pages: createPagesRepository(env.DB),
    unlocks: createUnlocksRepository(env.DB),
    cache: createTestCacheService(),
  };
}

function unlockUrl(id: string): string {
  return `https://pages.example.com/p/${id}/unlock`;
}

function postUnlock(id: string, body: string): Request {
  return new Request(unlockUrl(id), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

const COOKIE_ATTRS = "Path=/; HttpOnly; SameSite=Lax; Secure";

describe("serveUnlock", () => {
  const db = env.DB;
  const pages = createPagesRepository(db);
  const unlocks = createUnlocksRepository(db);

  beforeEach(async () => {
    await clearAll(db);
  });

  /** Seeds a protected html page with the given password and returns its id. */
  async function seedProtected(id: string, slug: string, password: string): Promise<void> {
    await insertPage(db, { id, slug, kind: "html" });
    await pages.setPasswordHash(id, await hashPassword(password));
  }

  // --- GET (prompt / clean 404) ---

  it("GET on a protected id renders the prompt (no-store, no Cache-Tag)", async () => {
    await seedProtected("page100001", "secret", "secret1");

    const res = await serveUnlock(new Request(unlockUrl("page100001")), makeDeps());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    const text = await res.text();
    expect(text).toContain("This page is password protected.");
    expect(text).toContain("Pagelively");
    expect(text).toContain('action="/p/page100001/unlock"');
    // The prompt never discloses the page title or content (ADR 0041 d5).
    expect(text).not.toContain("secret-page-title");
  });

  it("GET on an unknown id returns a clean 404", async () => {
    const res = await serveUnlock(new Request(unlockUrl("Unknown000")), makeDeps());
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("GET on an unprotected page returns a clean 404 (no protection-state disclosure)", async () => {
    await insertPage(db, { id: "page100002", slug: "open", kind: "html" });

    const res = await serveUnlock(new Request(unlockUrl("page100002")), makeDeps());
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("GET with an invalid id format rejects with invalid_id (400)", async () => {
    await expect(serveUnlock(new Request(unlockUrl("bad.id")), makeDeps())).rejects.toMatchObject({
      code: "invalid_id",
      status: 400,
    });
  });

  // --- POST (unlock) ---

  it("POST with the correct password → 303 to /p/{id}/ with the exact cookie; row stores only the token hash", async () => {
    await seedProtected("page100003", "secret", "secret1");

    const res = await serveUnlock(postUnlock("page100003", "password=secret1"), makeDeps());

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/p/page100003/");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();

    const setCookie = res.headers.get("Set-Cookie");
    expect(setCookie).toMatch(
      new RegExp(`^pl_unlock=page100003\\.[A-Za-z0-9_-]{43}; ${COOKIE_ATTRS}$`),
    );
    const token = setCookie!.match(/^pl_unlock=page100003\.([A-Za-z0-9_-]{43});/)![1];

    // The unlock row exists with exactly the SHA-256 hex of the cookie token.
    const row = await unlocks.getByPageId("page100003");
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).toBe(await hashToken(token));
    // The raw token never appears in the row.
    expect(Object.values(row!).some((v) => String(v).includes(token))).toBe(false);
  });

  it("a second unlock rotates the token (upsert keeps one row, old hash gone)", async () => {
    await seedProtected("page100003", "secret", "secret1");

    const first = await serveUnlock(postUnlock("page100003", "password=secret1"), makeDeps());
    const firstToken = first.headers.get("Set-Cookie")!.match(/\.([A-Za-z0-9_-]{43});/)![1];

    const second = await serveUnlock(postUnlock("page100003", "password=secret1"), makeDeps());
    const secondToken = second.headers.get("Set-Cookie")!.match(/\.([A-Za-z0-9_-]{43});/)![1];
    expect(secondToken).not.toBe(firstToken);

    const row = await unlocks.getByPageId("page100003");
    expect(row!.tokenHash).toBe(await hashToken(secondToken));
    expect(row!.tokenHash).not.toBe(await hashToken(firstToken));

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM page_unlocks WHERE page_id = ?")
      .bind("page100003")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("POST with the wrong password → 200 prompt with escaped inline error, no Set-Cookie, no token row", async () => {
    await seedProtected("page100003", "secret", "secret1");

    const res = await serveUnlock(postUnlock("page100003", "password=wrongpw"), makeDeps());

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const text = await res.text();
    expect(text).toContain('role="alert"');
    expect(text).toContain("Incorrect password.");
    expect(await unlocks.getByPageId("page100003")).toBeNull();
  });

  it("POST with a missing or blank password → 400 invalid_password", async () => {
    await seedProtected("page100003", "secret", "secret1");

    for (const body of ["foo=bar", "password=", "password=%20"]) {
      await expect(serveUnlock(postUnlock("page100003", body), makeDeps())).rejects.toMatchObject({
        code: "invalid_password",
        status: 400,
        publicMessage: "Password is required.",
      });
      expect(await unlocks.getByPageId("page100003")).toBeNull();
    }
  });

  it("POST with a too-short password → 400 invalid_password, nothing stored", async () => {
    await seedProtected("page100003", "secret", "secret1");

    await expect(
      serveUnlock(postUnlock("page100003", "password=1234"), makeDeps()),
    ).rejects.toMatchObject({
      code: "invalid_password",
      status: 400,
      publicMessage: "Password must be at least 5 characters.",
    });
    expect(await unlocks.getByPageId("page100003")).toBeNull();
  });

  it("POST with a too-long password → 400 invalid_password, nothing stored", async () => {
    await seedProtected("page100003", "secret", "secret1");

    await expect(
      serveUnlock(postUnlock("page100003", `password=${"x".repeat(257)}`), makeDeps()),
    ).rejects.toMatchObject({
      code: "invalid_password",
      status: 400,
      publicMessage: "Password must be at most 256 characters.",
    });
    expect(await unlocks.getByPageId("page100003")).toBeNull();
  });

  it("POST with an invalid id format → 400 JSON invalid_id", async () => {
    await expect(
      serveUnlock(postUnlock("bad.id", "password=secret1"), makeDeps()),
    ).rejects.toMatchObject({ code: "invalid_id", status: 400 });
  });

  it("POST with an unknown id → clean 404 (no protection-state disclosure)", async () => {
    const res = await serveUnlock(postUnlock("Unknown000", "password=secret1"), makeDeps());
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("POST on an unprotected page → clean 404", async () => {
    await insertPage(db, { id: "page100004", slug: "open", kind: "html" });

    const res = await serveUnlock(postUnlock("page100004", "password=secret1"), makeDeps());
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("unknown/unprotected ids 404 even when the password field is blank (no state leak)", async () => {
    const unknown = await serveUnlock(postUnlock("Unknown000", "password="), makeDeps());
    expect(unknown.status).toBe(404);
    await insertPage(db, { id: "page100005", slug: "open2", kind: "html" });
    const open = await serveUnlock(postUnlock("page100005", "password="), makeDeps());
    expect(open.status).toBe(404);
  });

  it("other methods → 405 method_not_allowed", async () => {
    await seedProtected("page100003", "secret", "secret1");

    for (const method of ["PUT", "PATCH", "DELETE", "HEAD"]) {
      await expect(
        serveUnlock(new Request(unlockUrl("page100003"), { method }), makeDeps()),
      ).rejects.toMatchObject({ code: "method_not_allowed", status: 405 });
    }
  });

  // --- POST body/content-type guard (validator A–D; AC 8: never a 500) ---

  it("POST with a non-form Content-Type → 400 invalid_form_data, never a 500", async () => {
    await seedProtected("page100003", "secret", "secret1");

    for (const contentType of ["text/plain", "application/json", "application/xml"]) {
      await expect(
        serveUnlock(
          new Request(unlockUrl("page100003"), {
            method: "POST",
            headers: { "Content-Type": contentType },
            body: "password=secret1",
          }),
          makeDeps(),
        ),
      ).rejects.toMatchObject({
        code: "invalid_form_data",
        status: 400,
        publicMessage:
          "Unlock requests must be sent as an HTML form (application/x-www-form-urlencoded or multipart/form-data).",
      });
    }
  });

  it("POST with no Content-Type, an empty body, or a malformed multipart boundary → 400 invalid_form_data, never a 500", async () => {
    await seedProtected("page100003", "secret", "secret1");

    const requests: Request[] = [
      // No Content-Type: workerd synthesizes text/plain for string bodies.
      new Request(unlockUrl("page100003"), { method: "POST", body: "password=secret1" }),
      // Empty string body (also synthesized text/plain).
      new Request(unlockUrl("page100003"), { method: "POST", body: "" }),
      // No body and no Content-Type at all.
      new Request(unlockUrl("page100003"), { method: "POST" }),
      // Multipart whose boundary does not appear in the body.
      new Request(unlockUrl("page100003"), {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=does-not-exist" },
        body: "--not-the-boundary\r\n",
      }),
    ];

    for (const request of requests) {
      await expect(serveUnlock(request, makeDeps())).rejects.toMatchObject({
        code: "invalid_form_data",
        status: 400,
      });
    }
  });

  it("POST as a valid multipart/form-data form still unlocks (303) — the guard never breaks the happy path", async () => {
    await seedProtected("page100003", "secret", "secret1");
    const form = new FormData();
    form.append("password", "secret1");

    const res = await serveUnlock(
      new Request(unlockUrl("page100003"), { method: "POST", body: form }),
      makeDeps(),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/p/page100003/");
  });

  it("non-unlock routes passed directly return a clean 404", async () => {
    const res = await serveUnlock(new Request("https://pages.example.com/some-slug/"), makeDeps());

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });
});

describe("hasValidUnlockCookie (gate predicate)", () => {
  const db = env.DB;
  const unlocks = createUnlocksRepository(db);

  beforeEach(async () => {
    await clearAll(db);
  });

  function requestWithCookie(value: string | null): Request {
    const headers = value === null ? undefined : { Cookie: `pl_unlock=${value}` };
    return new Request("https://pages.example.com/secret/", { headers });
  }

  it("is total and false for no / malformed cookies (never throws)", async () => {
    await insertPage(db, { id: "page100006", slug: "secret", kind: "html" });
    for (const value of [null, "garbage", "no-dot", "bad.id.token", "page100006.short", ""]) {
      await expect(
        hasValidUnlockCookie(requestWithCookie(value), "page100006", unlocks),
      ).resolves.toBe(false);
    }
  });

  it("ignores malformed cookie headers and unrelated cookie names (never throws)", async () => {
    await insertPage(db, { id: "page100006", slug: "secret", kind: "html" });
    const token = generateToken();
    await unlocks.create("page100006", await hashToken(token));
    const good = formatUnlockCookie("page100006", token);

    for (const header of [";;", "=novalue", "other=1", "pl_unlock", "pl_unlock="]) {
      await expect(
        hasValidUnlockCookie(
          new Request("https://pages.example.com/secret/", { headers: { Cookie: header } }),
          "page100006",
          unlocks,
        ),
      ).resolves.toBe(false);
    }

    // A valid cookie alongside other cookies is still honored.
    await expect(
      hasValidUnlockCookie(
        new Request("https://pages.example.com/secret/", {
          headers: { Cookie: `other=1; pl_unlock=${good}` },
        }),
        "page100006",
        unlocks,
      ),
    ).resolves.toBe(true);
  });

  it("is false for a valid-format cookie belonging to a different page", async () => {
    await insertPage(db, { id: "page100006", slug: "secret", kind: "html" });
    const token = generateToken();
    await unlocks.create("page100006", await hashToken(token));

    const foreign = formatUnlockCookie("page999999", token);
    await expect(
      hasValidUnlockCookie(requestWithCookie(foreign), "page100006", unlocks),
    ).resolves.toBe(false);
  });

  it("is false for a stale cookie (no unlock row) and for a wrong token", async () => {
    await insertPage(db, { id: "page100006", slug: "secret", kind: "html" });
    const token = generateToken();
    await unlocks.create("page100006", await hashToken(token));

    // Stale: a syntactically valid cookie for this page, but the row was deleted.
    await unlocks.deleteByPageId("page100006");
    await expect(
      hasValidUnlockCookie(
        requestWithCookie(formatUnlockCookie("page100006", token)),
        "page100006",
        unlocks,
      ),
    ).resolves.toBe(false);

    // Wrong token: row exists for token A, cookie carries token B.
    await unlocks.create("page100006", await hashToken(token));
    const other = generateToken();
    await expect(
      hasValidUnlockCookie(
        requestWithCookie(formatUnlockCookie("page100006", other)),
        "page100006",
        unlocks,
      ),
    ).resolves.toBe(false);
  });

  it("is true only for the exact token whose hash is stored", async () => {
    await insertPage(db, { id: "page100006", slug: "secret", kind: "html" });
    const token = generateToken();
    await unlocks.create("page100006", await hashToken(token));

    await expect(
      hasValidUnlockCookie(
        requestWithCookie(formatUnlockCookie("page100006", token)),
        "page100006",
        unlocks,
      ),
    ).resolves.toBe(true);
  });
});
