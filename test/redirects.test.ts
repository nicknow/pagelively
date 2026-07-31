import { describe, expect, it } from "vitest";
import { clean404Response, trailingSlashRedirect } from "../src/redirects";
import type { Route } from "../src/router";

// S08 — Trailing-slash redirects & clean 404 (spec §5, §11; architecture 02
// redirects.ts contract). Pure functions: no bindings, no Cloudflare API.

function makeUrl(href: string): URL {
  return new URL(href);
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("trailingSlashRedirect — happy path", () => {
  it("301s a slug route without trailing slash to an absolute /{slug}/ URL", () => {
    const route: Route = { type: "slug", slug: "hello" };
    const url = makeUrl("https://pages.example.com/hello");
    const response = trailingSlashRedirect(route, url);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(301);
    expect(response!.headers.get("Location")).toBe("https://pages.example.com/hello/");
  });

  it("301s an id route without trailing slash to an absolute /p/{id}/ URL", () => {
    const route: Route = { type: "id", id: "abc123" };
    const url = makeUrl("https://pages.example.com/p/abc123");
    const response = trailingSlashRedirect(route, url);

    expect(response).not.toBeNull();
    expect(response!.status).toBe(301);
    expect(response!.headers.get("Location")).toBe("https://pages.example.com/p/abc123/");
  });

  it("preserves scheme, host, port, query string, and hash", () => {
    const route: Route = { type: "slug", slug: "hello" };
    const url = makeUrl("https://pages.example.com:8787/hello?foo=bar&baz=qux#section");
    const response = trailingSlashRedirect(route, url);

    expect(response!.headers.get("Location")).toBe(
      "https://pages.example.com:8787/hello/?foo=bar&baz=qux#section",
    );
  });

  it("preserves an id route query string and hash", () => {
    const route: Route = { type: "id", id: "abc_123" };
    const url = makeUrl("https://pages.example.com/p/abc_123?preview=1#top");
    const response = trailingSlashRedirect(route, url);

    expect(response!.headers.get("Location")).toBe(
      "https://pages.example.com/p/abc_123/?preview=1#top",
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("trailingSlashRedirect — edge cases", () => {
  it("returns null when a slug/id route already ends with a slash", () => {
    expect(
      trailingSlashRedirect(
        { type: "slug", slug: "hello" },
        makeUrl("https://pages.example.com/hello/"),
      ),
    ).toBeNull();
    expect(
      trailingSlashRedirect(
        { type: "id", id: "abc123" },
        makeUrl("https://pages.example.com/p/abc123/"),
      ),
    ).toBeNull();
  });

  it("returns null when a slug/id route ends with multiple slashes", () => {
    // classifyPath strips these before this function sees them, but the
    // predicate is pathname-based and must not redirect already-slash paths.
    expect(
      trailingSlashRedirect(
        { type: "slug", slug: "hello" },
        makeUrl("https://pages.example.com/hello///"),
      ),
    ).toBeNull();
    expect(
      trailingSlashRedirect(
        { type: "id", id: "abc123" },
        makeUrl("https://pages.example.com/p/abc123///"),
      ),
    ).toBeNull();
  });

  it("returns null for non-redirectable routes", () => {
    const routes: Route[] = [
      { type: "home" },
      { type: "health" },
      { type: "admin" },
      { type: "api" },
      { type: "unknown" },
    ];
    for (const route of routes) {
      expect(
        trailingSlashRedirect(route, makeUrl("https://pages.example.com/anything")),
      ).toBeNull();
    }
  });

  it("returns null for unknown routes even when the path lacks a trailing slash", () => {
    // Encoded slashes (%2F / %2f) classify as unknown (S01), so this function
    // must not redirect them — otherwise the slash would be appended and the
    // path could be reinterpreted as a slug/id, creating a loop.
    const routes: Route[] = [{ type: "unknown" }, { type: "admin" }, { type: "api" }];
    for (const route of routes) {
      expect(
        trailingSlashRedirect(route, makeUrl("https://pages.example.com/hello%2F")),
      ).toBeNull();
      expect(
        trailingSlashRedirect(route, makeUrl("https://pages.example.com/hello%2f")),
      ).toBeNull();
    }
  });

  it("does not mutate the original URL", () => {
    const url = makeUrl("https://pages.example.com/hello?x=1");
    trailingSlashRedirect({ type: "slug", slug: "hello" }, url);
    expect(url.pathname).toBe("/hello");
    expect(url.search).toBe("?x=1");
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("trailingSlashRedirect — failure modes", () => {
  it("returns null for a slug with a path that already has a trailing slash", () => {
    const route: Route = { type: "slug", slug: "hello" };
    expect(trailingSlashRedirect(route, makeUrl("https://pages.example.com/hello/"))).toBeNull();
  });

  it("returns null for an id with a path that already has a trailing slash", () => {
    const route: Route = { type: "id", id: "abc123" };
    expect(trailingSlashRedirect(route, makeUrl("https://pages.example.com/p/abc123/"))).toBeNull();
  });

  it("HEAD requests produce a null body", () => {
    const route: Route = { type: "slug", slug: "hello" };
    const response = trailingSlashRedirect(
      route,
      makeUrl("https://pages.example.com/hello"),
      "HEAD",
    );
    expect(response).not.toBeNull();
    expect(response!.body).toBeNull();
  });

  it("GET requests include a small informational body", async () => {
    const route: Route = { type: "slug", slug: "hello" };
    const url = makeUrl("https://pages.example.com/hello");
    const response = trailingSlashRedirect(route, url, "GET");
    expect(response).not.toBeNull();
    expect(response!.status).toBe(301);
    const text = await response!.text();
    expect(text).toContain("https://pages.example.com/hello/");
  });
});

// ---------------------------------------------------------------------------
// clean404Response
// ---------------------------------------------------------------------------

describe("clean404Response — happy path", () => {
  it("returns a 404 HTML response with no-store cache control", () => {
    const url = makeUrl("https://pages.example.com/missing");
    const response = clean404Response(url);

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns a valid HTML document with a title and a message", async () => {
    const url = makeUrl("https://pages.example.com/gone");
    const response = clean404Response(url);
    const body = await response.text();

    expect(body).toContain("<!doctype html>");
    expect(body).toContain("<title>Not Found</title>");
    expect(body).toContain("<h1>Not Found</h1>");
    expect(body).toContain("<code>/gone</code>");
  });

  it("decodes and escapes the requested path to prevent XSS", async () => {
    const url = makeUrl("https://pages.example.com/%3Cscript%3Ealert(1)%3C/script%3E");
    const response = clean404Response(url);
    const body = await response.text();

    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("</script>");
  });
});

describe("clean404Response — edge cases", () => {
  it("escapes ampersands in the decoded path", async () => {
    const url = makeUrl("https://pages.example.com/foo&bar");
    const body = await clean404Response(url).text();
    expect(body).toContain("<code>/foo&amp;bar</code>");
    expect(body).not.toContain("<code>/foo&bar</code>");
  });

  it("escapes quotes in the decoded path", async () => {
    const url = makeUrl('https://pages.example.com/"onclick"');
    const body = await clean404Response(url).text();
    expect(body).toContain("&quot;onclick&quot;");
    expect(body).not.toContain('"onclick"');
  });

  it("handles the root path", async () => {
    const url = makeUrl("https://pages.example.com/");
    const body = await clean404Response(url).text();
    expect(body).toContain("<code>/</code>");
  });

  it("does not include query string or hash in the displayed path", async () => {
    const url = makeUrl("https://pages.example.com/missing?x=1#y");
    const body = await clean404Response(url).text();
    expect(body).toContain("<code>/missing</code>");
    expect(body).not.toContain("?x=1");
    expect(body).not.toContain("#y");
  });

  it("falls back to the encoded pathname if decoding fails", async () => {
    const url = makeUrl("https://pages.example.com/%ZZ");
    const body = await clean404Response(url).text();
    expect(body).toContain("<code>");
    expect(body).toContain("%ZZ");
  });

  it("returns a fresh Headers object each call", () => {
    const a = clean404Response(makeUrl("https://pages.example.com/a"));
    const b = clean404Response(makeUrl("https://pages.example.com/b"));
    expect(a.headers).not.toBe(b.headers);
  });
});

describe("clean404Response — failure modes / safety", () => {
  it("does not leak stack traces or internal details", async () => {
    const url = makeUrl("https://pages.example.com/secret");
    const body = await clean404Response(url).text();

    const lower = body.toLowerCase();
    expect(lower).not.toContain("stack");
    expect(lower).not.toContain("trace");
    expect(lower).not.toContain("internal");
    expect(lower).not.toContain("error:");
    expect(lower).not.toContain("exception");
  });
});
