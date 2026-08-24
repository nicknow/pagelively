import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { verifyPassword } from "../src/password";
import {
  ACCESS_AUD,
  createMockFetch,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

// S17 — Paste content API (application/json publish path).

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

function pasteJson(body: Record<string, unknown>): {
  body: string;
  headers: Record<string, string>;
} {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  };
}

async function textFromObject(bucket: R2Bucket, key: string): Promise<string | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return new Response(obj.body).text();
}

describe("S17 paste — POST /api/pages application/json", () => {
  const db = env.DB;
  const bucket = env.BUCKET;

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

  it("AC1: JSON HTML paste creates an html page, 201, one index.html, served at slug", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({
      content: "<h1>Hi</h1>",
      format: "html",
      slug: "html-paste",
      title: "Pasted HTML",
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);

    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const bodyJson = (await res.json()) as Record<string, unknown>;
    expect(bodyJson.kind).toBe("html");
    expect(bodyJson.slug).toBe("html-paste");
    expect(bodyJson.title).toBe("Pasted HTML");
    expect(bodyJson.entry_path).toBe("index.html");
    expect(bodyJson.raw_md_path).toBeNull();
    expect(bodyJson.rev).toBe(1);
    expect(bodyJson.files).toHaveLength(1);
    expect((bodyJson.files as Record<string, unknown>[])[0]).toMatchObject({
      path: "index.html",
      content_type: "text/html; charset=utf-8",
    });

    const pageId = bodyJson.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual([`pages/${pageId}/1/index.html`]);
    const html = await textFromObject(bucket, `pages/${pageId}/1/index.html`);
    expect(html).toContain("<h1>Hi</h1>");

    const pageRes = await worker.fetch(
      new Request("https://pages.example.com/html-paste/"),
      env,
      createExecutionContext(),
    );
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain("<h1>Hi</h1>");
  });

  it("AC2: JSON Markdown paste creates a markdown page, 201, source.md + index.html, source link", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({
      content: "# Hi\n\nWorld.",
      format: "markdown",
      slug: "md-paste",
      title: "Pasted Markdown",
      showSource: true,
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);

    expect(res.status).toBe(201);
    const bodyJson = (await res.json()) as Record<string, unknown>;
    expect(bodyJson.kind).toBe("markdown");
    expect(bodyJson.slug).toBe("md-paste");
    expect(bodyJson.title).toBe("Pasted Markdown");
    expect(bodyJson.entry_path).toBe("index.html");
    expect(bodyJson.raw_md_path).toBe("source.md");
    expect(bodyJson.show_source).toBe(1);
    expect(bodyJson.files).toHaveLength(2);
    expect(bodyJson.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "index.html", content_type: "text/html; charset=utf-8" }),
        expect.objectContaining({ path: "source.md", content_type: "text/markdown" }),
      ]),
    );

    const pageId = bodyJson.id as string;
    const keys = await listKeys(bucket, `pages/${pageId}/1/`);
    expect(keys).toEqual(
      expect.arrayContaining([`pages/${pageId}/1/index.html`, `pages/${pageId}/1/source.md`]),
    );

    const html = await textFromObject(bucket, `pages/${pageId}/1/index.html`);
    expect(html).toContain("<h1>Hi</h1>");
    expect(html).toContain("View source");

    const md = await textFromObject(bucket, `pages/${pageId}/1/source.md`);
    expect(md).toBe("# Hi\n\nWorld.");

    const pageRes = await worker.fetch(
      new Request("https://pages.example.com/md-paste/"),
      env,
      createExecutionContext(),
    );
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain("<h1>Hi</h1>");
  });

  it("AC3: JSON manifest fields slug/title/visibility/showSource behave like multipart", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({
      content: "# V",
      format: "markdown",
      slug: "  visibility paste  ",
      title: "Visibility Paste",
      visibility: "unlisted",
      showSource: false,
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);

    expect(res.status).toBe(201);
    const bodyJson = (await res.json()) as Record<string, unknown>;
    expect(bodyJson.slug).toBe("visibility-paste");
    expect(bodyJson.title).toBe("Visibility Paste");
    expect(bodyJson.visibility).toBe("unlisted");
    expect(bodyJson.show_source).toBe(0);
  });

  it("AC4: invalid JSON returns 400 invalid_json", async () => {
    const token = await validToken();
    const res = await fetchApi("/api/pages", "POST", "not-json", token, {
      "Content-Type": "application/json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_json",
      message: "Request body must be valid JSON.",
    });
  });

  it("AC4: missing content returns 400 invalid_content", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({ format: "html" });
    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_content",
      message: "content must be a non-empty string.",
    });
  });

  it("AC4: empty content returns 400 invalid_content", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({ content: "", format: "html" });
    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_content",
      message: "content must be a non-empty string.",
    });
  });

  it("AC4: non-string content returns 400 invalid_content", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({ content: 123, format: "html" });
    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_content",
      message: "content must be a non-empty string.",
    });
  });

  it("AC4: invalid format returns 400 invalid_format", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({ content: "# Hi", format: "txt" });
    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_format",
      message: "format must be 'html' or 'markdown'.",
    });
  });

  it("AC4: missing format returns 400 invalid_format", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({ content: "# Hi" });
    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_format",
      message: "format must be 'html' or 'markdown'.",
    });
  });

  it("AC5: content > 1 MB returns 413 content_too_large", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({
      content: "x".repeat(1_000_001),
      format: "html",
    });
    const res = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "content_too_large",
      message: "content exceeds the 1 MB paste limit.",
    });

    const count = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(await listKeys(bucket, "pages/")).toEqual([]);
  });

  it("AC6: multipart upload path still works after JSON path is added", async () => {
    const token = await validToken();
    const form = new FormData();
    form.append("manifest", JSON.stringify({ slug: "multipart-still-works", title: "Multipart" }));
    form.append(
      "file:page.html",
      new File([new TextEncoder().encode("<h1>Multipart</h1>")], "page.html", {
        type: "text/html",
      }),
    );
    const res = await fetchApi("/api/pages", "POST", form, token);
    expect(res.status).toBe(201);
    const bodyJson = (await res.json()) as Record<string, unknown>;
    expect(bodyJson.kind).toBe("html");
    expect(bodyJson.slug).toBe("multipart-still-works");
  });

  it("AC7: paste markdown output is byte-identical to uploading the same markdown as a file", async () => {
    const token = await validToken();
    const md = "# Hello\n\n- a\n- b\n\n`code`";

    const { body, headers } = pasteJson({
      content: md,
      format: "markdown",
      slug: "paste-equivalence",
    });
    const pasteRes = await fetchApi("/api/pages", "POST", body, token, headers);
    expect(pasteRes.status).toBe(201);
    const pasteBody = (await pasteRes.json()) as Record<string, unknown>;
    const pasteId = pasteBody.id as string;

    const form = new FormData();
    form.append("manifest", JSON.stringify({ slug: "file-equivalence" }));
    form.append(
      "file:note.md",
      new File([new TextEncoder().encode(md)], "note.md", { type: "text/markdown" }),
    );
    const fileRes = await fetchApi("/api/pages", "POST", form, token);
    expect(fileRes.status).toBe(201);
    const fileBody = (await fileRes.json()) as Record<string, unknown>;
    const fileId = fileBody.id as string;

    const pasteHtml = await textFromObject(bucket, `pages/${pasteId}/1/index.html`);
    const fileHtml = await textFromObject(bucket, `pages/${fileId}/1/index.html`);
    expect(pasteHtml).toBe(fileHtml);

    const pasteSource = await textFromObject(bucket, `pages/${pasteId}/1/source.md`);
    const fileSource = await textFromObject(bucket, `pages/${fileId}/1/source.md`);
    expect(pasteSource).toBe(fileSource);
    expect(pasteSource).toBe(md);
  });

  it("returns 403 when unauthenticated", async () => {
    const { body, headers } = pasteJson({ content: "# Hi", format: "markdown" });
    const res = await fetchApi("/api/pages", "POST", body, undefined, headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("S23: JSON paste with a password creates a protected page — has_password true, hash stored, never leaked", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({
      content: "# Hi",
      format: "markdown",
      slug: "protected-paste",
      password: "s3cret-word",
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);

    expect(res.status).toBe(201);
    const bodyJson = (await res.json()) as Record<string, unknown>;
    expect(bodyJson.has_password).toBe(true);
    // R19: the hash and the raw password never appear in any response surface.
    expect(bodyJson).not.toHaveProperty("password_hash");
    expect(bodyJson).not.toHaveProperty("password");
    expect(JSON.stringify(bodyJson)).not.toContain("pbkdf2");
    expect(JSON.stringify(bodyJson)).not.toContain("s3cret-word");

    const row = await db
      .prepare("SELECT password_hash FROM pages WHERE id = ?")
      .bind(bodyJson.id as string)
      .first<{ password_hash: string | null }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$10000\$/);
    expect(row?.password_hash).not.toBe("s3cret-word");
    expect(await verifyPassword("s3cret-word", row!.password_hash!)).toBe(true);
    expect(await verifyPassword("wrong-password", row!.password_hash!)).toBe(false);
  });

  it("S23: JSON paste without a password is unprotected (has_password false, NULL stored)", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({ content: "# Hi", format: "markdown" });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);

    expect(res.status).toBe(201);
    const bodyJson = (await res.json()) as Record<string, unknown>;
    expect(bodyJson.has_password).toBe(false);
    expect(bodyJson).not.toHaveProperty("password_hash");
    expect(JSON.stringify(bodyJson)).not.toContain("pbkdf2");

    const row = await db
      .prepare("SELECT password_hash FROM pages WHERE id = ?")
      .bind(bodyJson.id as string)
      .first<{ password_hash: string | null }>();
    expect(row?.password_hash).toBeNull();
  });

  it("S23: JSON paste with a too-short password returns 400 invalid_password and stores nothing", async () => {
    const token = await validToken();
    const { body, headers } = pasteJson({
      content: "# Hi",
      format: "markdown",
      password: "1234",
    });

    const res = await fetchApi("/api/pages", "POST", body, token, headers);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_password",
      message: "Password must be at least 5 characters.",
    });
    const count = await db.prepare("SELECT COUNT(*) AS n FROM pages").first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(await listKeys(bucket, "pages/")).toEqual([]);
  });

  // S24-B (OQ-32): the paste endpoint accepts kind:"raw-markdown" and flows
  // into the same raw branch as multipart uploads — one verbatim source.md,
  // content type text/plain; charset=utf-8, no rendering, no index.html.
  describe("S24-B — raw-markdown paste", () => {
    it("stores pasted markdown verbatim as source.md with no template wrapper or html", async () => {
      const token = await validToken();
      const content = "# Raw paste\n\nVerbatim *content* — <script>kept</script>";
      const { body, headers } = pasteJson({
        content,
        format: "markdown",
        kind: "raw-markdown",
        slug: "raw-paste",
        title: "Raw Paste",
      });

      const res = await fetchApi("/api/pages", "POST", body, token, headers);

      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as Record<string, unknown>;
      expect(bodyJson.kind).toBe("raw-markdown");
      expect(bodyJson.entry_path).toBe("source.md");
      expect(bodyJson.raw_md_path).toBeNull();
      expect(bodyJson.show_source).toBe(0);
      const files = bodyJson.files as Record<string, unknown>[];
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: "source.md",
        content_type: "text/plain; charset=utf-8",
      });

      const pageId = bodyJson.id as string;
      expect(await listKeys(bucket, `pages/${pageId}/`)).toEqual([`pages/${pageId}/1/source.md`]);
      const obj = await bucket.get(`pages/${pageId}/1/source.md`);
      const stored = await new Response(obj!.body).text();
      // Byte-for-byte verbatim — no markdown template wrapper, no rendered html.
      expect(stored).toBe(content);
      expect(stored).not.toContain("<html");
      expect(obj!.httpMetadata).toMatchObject({ contentType: "text/plain; charset=utf-8" });
    });

    it("ignores showSource in a raw paste body and normalizes it to 0", async () => {
      const token = await validToken();
      const { body, headers } = pasteJson({
        content: "# Raw\n",
        format: "markdown",
        kind: "raw-markdown",
        showSource: true,
      });

      const res = await fetchApi("/api/pages", "POST", body, token, headers);

      expect(res.status).toBe(201);
      const bodyJson = (await res.json()) as Record<string, unknown>;
      expect(bodyJson.kind).toBe("raw-markdown");
      expect(bodyJson.show_source).toBe(0);
      const pageId = bodyJson.id as string;
      // No rendering happened for the ignored flag.
      expect(await listKeys(bucket, `pages/${pageId}/`)).toEqual([`pages/${pageId}/1/source.md`]);
    });
  });
});
