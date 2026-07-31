import { describe, expect, it } from "vitest";
import { headersFor } from "../src/cache-headers";
import { AppError } from "../src/errors";

// S07 AC — Cache-header construction (spec §11, ADR 0006, architecture 04).
// Pure function: returns a Web API Headers object. No bindings, no Cloudflare API.

const PAGE_ID = "abc123_01";

/** Read a header value, coercing null to undefined for simpler assertions. */
function getHeader(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined;
}

/** True if the header is present with a non-empty value. */
function hasHeader(headers: Headers, name: string): boolean {
  const value = headers.get(name);
  return value !== null && value !== "";
}

/**
 * Assert the exact Cache-Control value and that a class never emits the
 * SWR-killing or privacy directives that the architecture forbids.
 */
function expectCacheControl(headers: Headers, expected: string): void {
  expect(getHeader(headers, "Cache-Control")).toBe(expected);
  const value = getHeader(headers, "Cache-Control") ?? "";
  expect(value).not.toMatch(/s-maxage/i);
  expect(value).not.toMatch(/must-revalidate/i);
  expect(value).not.toMatch(/proxy-revalidate/i);
  expect(value).not.toMatch(/private/i);
}

// ---------------------------------------------------------------------------
// Happy path: exact headers per route class.
// ---------------------------------------------------------------------------

describe("headersFor — happy path (S07 AC 1–6)", () => {
  it("entry: public SWR entry + page tag", () => {
    const headers = headersFor("entry", PAGE_ID);
    expectCacheControl(headers, "public, max-age=300, stale-while-revalidate=3600");
    expect(getHeader(headers, "Cache-Tag")).toBe(`page-${PAGE_ID}`);
  });

  it("redirect: public SWR entry + page tag (same as entry)", () => {
    const headers = headersFor("redirect", PAGE_ID);
    expectCacheControl(headers, "public, max-age=300, stale-while-revalidate=3600");
    expect(getHeader(headers, "Cache-Tag")).toBe(`page-${PAGE_ID}`);
  });

  it("asset: immutable long-cache, no tag", () => {
    const headers = headersFor("asset");
    expectCacheControl(headers, "public, max-age=31536000, immutable");
    expect(getHeader(headers, "Cache-Tag")).toBeUndefined();
  });

  it("admin: no-store, no tag", () => {
    const headers = headersFor("admin");
    expectCacheControl(headers, "no-store");
    expect(getHeader(headers, "Cache-Tag")).toBeUndefined();
  });

  it("notFound: no-store, no tag", () => {
    const headers = headersFor("notFound");
    expectCacheControl(headers, "no-store");
    expect(getHeader(headers, "Cache-Tag")).toBeUndefined();
  });

  it("error: no-store, no tag", () => {
    const headers = headersFor("error");
    expectCacheControl(headers, "no-store");
    expect(getHeader(headers, "Cache-Tag")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases: pageId semantics and ignored arguments.
// ---------------------------------------------------------------------------

describe("headersFor — pageId edge cases (S07 AC 1, 3, 7)", () => {
  it("entry ignores extra pageId-like params beyond the first (assert second arg shape)", () => {
    // The function signature is `headersFor(routeClass, pageId?)`; verify the
    // optional second argument is what forms the tag.
    const headers = headersFor("entry", PAGE_ID);
    expect(getHeader(headers, "Cache-Tag")).toBe(`page-${PAGE_ID}`);
  });

  it("pageId is ignored for asset, admin, notFound, and error", () => {
    for (const routeClass of ["asset", "admin", "notFound", "error"] as const) {
      const headers = headersFor(routeClass, PAGE_ID);
      expect(getHeader(headers, "Cache-Tag")).toBeUndefined();
    }
  });

  it("entry and redirect tag the page id, even if it looks like an id of another page", () => {
    const id = "x-y_zA1";
    expect(getHeader(headersFor("entry", id), "Cache-Tag")).toBe(`page-${id}`);
    expect(getHeader(headersFor("redirect", id), "Cache-Tag")).toBe(`page-${id}`);
  });
});

// ---------------------------------------------------------------------------
// Failure modes: typed AppError for caller bugs.
// ---------------------------------------------------------------------------

describe("headersFor — failure modes (S07 AC 7, 8)", () => {
  it("throws a typed AppError when entry is called without pageId", () => {
    expect(() => headersFor("entry")).toThrow(AppError);
    try {
      headersFor("entry");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("missing_page_id");
      expect((err as AppError).status).toBe(500);
    }
  });

  it("throws a typed AppError when entry is called with explicit undefined", () => {
    expect(() => headersFor("entry", undefined)).toThrow(AppError);
    try {
      headersFor("entry", undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("missing_page_id");
      expect((err as AppError).status).toBe(500);
    }
  });

  it("throws a typed AppError when entry is called with an empty string pageId", () => {
    // An empty string produces the invalid Cache-Tag `page-`; treat it as missing.
    expect(() => headersFor("entry", "")).toThrow(AppError);
    try {
      headersFor("entry", "");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("missing_page_id");
      expect((err as AppError).status).toBe(500);
    }
  });

  it("throws a typed AppError when redirect is called without pageId", () => {
    expect(() => headersFor("redirect")).toThrow(AppError);
    try {
      headersFor("redirect");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("missing_page_id");
      expect((err as AppError).status).toBe(500);
    }
  });

  it("throws a typed AppError when redirect is called with explicit undefined", () => {
    expect(() => headersFor("redirect", undefined)).toThrow(AppError);
    try {
      headersFor("redirect", undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("missing_page_id");
      expect((err as AppError).status).toBe(500);
    }
  });

  it("throws a typed AppError when redirect is called with an empty string pageId", () => {
    expect(() => headersFor("redirect", "")).toThrow(AppError);
    try {
      headersFor("redirect", "");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("missing_page_id");
      expect((err as AppError).status).toBe(500);
    }
  });

  it("throws AppError(unknown_route_class, 500) for unknown route classes", () => {
    expect(() => headersFor("unknown" as "entry")).toThrow(AppError);
    try {
      headersFor("unknown" as "entry");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe("unknown_route_class");
      expect((err as AppError).status).toBe(500);
    }
  });

  it("does not validate pageId format — that is the caller's responsibility", () => {
    // S07 explicitly says invalid pageId is NOT this function's job.
    const bad = "../../evil";
    expect(() => headersFor("entry", bad)).not.toThrow();
    expect(getHeader(headersFor("entry", bad), "Cache-Tag")).toBe(`page-${bad}`);
  });
});

// ---------------------------------------------------------------------------
// Forbidden directives: never emit SWR-killing or privacy directives.
// ---------------------------------------------------------------------------

describe("headersFor — never emits forbidden directives (S07 AC 7)", () => {
  const CLASSES = ["entry", "redirect", "asset", "admin", "notFound", "error"] as const;

  it.each(CLASSES)(
    "%s: no s-maxage, must-revalidate, proxy-revalidate, or private",
    (routeClass) => {
      const headers =
        routeClass === "entry" || routeClass === "redirect"
          ? headersFor(routeClass, PAGE_ID)
          : headersFor(routeClass);
      const cc = getHeader(headers, "Cache-Control") ?? "";
      const directives = cc.split(",").map((d) => d.trim().toLowerCase());
      expect(directives).not.toContainEqual(expect.stringMatching(/^s-maxage/));
      expect(directives).not.toContain("must-revalidate");
      expect(directives).not.toContain("proxy-revalidate");
      expect(directives).not.toContain("private");
    },
  );

  it.each(CLASSES)("%s: no ETag or Last-Modified is added by this function", (routeClass) => {
    const headers =
      routeClass === "entry" || routeClass === "redirect"
        ? headersFor(routeClass, PAGE_ID)
        : headersFor(routeClass);
    expect(hasHeader(headers, "ETag")).toBe(false);
    expect(hasHeader(headers, "Last-Modified")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contract shape: Headers object behavior.
// ---------------------------------------------------------------------------

describe("headersFor — Headers object contract", () => {
  it("returns a fresh Headers instance each call", () => {
    const a = headersFor("entry", PAGE_ID);
    const b = headersFor("entry", PAGE_ID);
    expect(a).not.toBe(b);
    expect(a.get("Cache-Control")).toBe(b.get("Cache-Control"));
  });

  it("mutating one returned Headers does not affect another", () => {
    const a = headersFor("entry", PAGE_ID);
    const b = headersFor("entry", PAGE_ID);
    a.set("X-Custom", "a");
    expect(getHeader(a, "X-Custom")).toBe("a");
    expect(hasHeader(b, "X-Custom")).toBe(false);
    b.delete("Cache-Control");
    expect(hasHeader(a, "Cache-Control")).toBe(true);
    expect(getHeader(a, "Cache-Control")).toBe("public, max-age=300, stale-while-revalidate=3600");
  });

  it("returns mutable headers (callers can append other response headers)", () => {
    const headers = headersFor("entry", PAGE_ID);
    headers.set("Content-Type", "text/html; charset=utf-8");
    expect(getHeader(headers, "Content-Type")).toBe("text/html; charset=utf-8");
    expect(getHeader(headers, "Cache-Control")).toBe(
      "public, max-age=300, stale-while-revalidate=3600",
    );
  });
});
