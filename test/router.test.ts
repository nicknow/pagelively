import { describe, expect, it } from "vitest";
import { classifyPath } from "../src/router";

// S01 AC 4 — route classification (spec §5, architecture 02 contract,
// ADR 0007 decision 3, ADR 0010). The Route union uses the architecture's
// `health` member — this supersedes the roadmap's planned `system` type.

describe("classifyPath", () => {
  // --- home ---
  it("classifies the root as home", () => {
    expect(classifyPath("/")).toEqual({ type: "home" });
  });

  // --- health (leaf route, never redirected — S08) ---
  it("classifies /health as health", () => {
    expect(classifyPath("/health")).toEqual({ type: "health" });
    expect(classifyPath("/health/")).toEqual({ type: "health" });
  });

  it("matches health case-insensitively", () => {
    expect(classifyPath("/HEALTH")).toEqual({ type: "health" });
    expect(classifyPath("/Health")).toEqual({ type: "health" });
  });

  it("does not classify deeper paths under /health as health", () => {
    expect(classifyPath("/health/extra")).toEqual({ type: "unknown" });
  });

  // --- slug ---
  it("classifies single-segment paths as slug routes, lowercasing the slug", () => {
    expect(classifyPath("/hello")).toEqual({ type: "slug", slug: "hello" });
    expect(classifyPath("/hello/")).toEqual({ type: "slug", slug: "hello" });
    expect(classifyPath("/Hello")).toEqual({ type: "slug", slug: "hello" });
    expect(classifyPath("/MY-POST/")).toEqual({ type: "slug", slug: "my-post" });
  });

  it("tolerates multiple trailing slashes", () => {
    expect(classifyPath("/hello///")).toEqual({ type: "slug", slug: "hello" });
    expect(classifyPath("/p/abc123///")).toEqual({ type: "id", id: "abc123" });
  });

  it("classifies deeper paths under a slug as unknown (only /{slug}[/] is defined)", () => {
    expect(classifyPath("/hello/world")).toEqual({ type: "unknown" });
  });

  // --- id ---
  it("classifies /p/{id} as an id route, leaving the id raw (case-sensitive namespace)", () => {
    expect(classifyPath("/p/abc123")).toEqual({ type: "id", id: "abc123" });
    expect(classifyPath("/p/abc123/")).toEqual({ type: "id", id: "abc123" });
    expect(classifyPath("/p/AbC_1-x")).toEqual({ type: "id", id: "AbC_1-x" });
  });

  it("matches the reserved id prefix case-insensitively but keeps the id raw", () => {
    expect(classifyPath("/P/abc123")).toEqual({ type: "id", id: "abc123" });
  });

  it("classifies /p with a missing or empty id as unknown", () => {
    expect(classifyPath("/p")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/")).toEqual({ type: "unknown" });
    expect(classifyPath("/p//")).toEqual({ type: "unknown" });
  });

  it("classifies deeper paths under /p/{id} as unknown (spec defines only /p/{id}/)", () => {
    expect(classifyPath("/p/abc123/foo")).toEqual({ type: "unknown" });
  });

  // --- admin / api (prefix routes) ---
  it("classifies /admin and anything under it as admin", () => {
    expect(classifyPath("/admin")).toEqual({ type: "admin" });
    expect(classifyPath("/admin/")).toEqual({ type: "admin" });
    expect(classifyPath("/admin/pages")).toEqual({ type: "admin" });
    expect(classifyPath("/admin/x/y/z")).toEqual({ type: "admin" });
    expect(classifyPath("/ADMIN/pages")).toEqual({ type: "admin" });
  });

  it("classifies /api and anything under it as api", () => {
    expect(classifyPath("/api")).toEqual({ type: "api" });
    expect(classifyPath("/api/")).toEqual({ type: "api" });
    expect(classifyPath("/api/pages")).toEqual({ type: "api" });
    expect(classifyPath("/api/pages/abc")).toEqual({ type: "api" });
    expect(classifyPath("/API/x")).toEqual({ type: "api" });
  });

  // --- reserved words → unknown, never slug (ADR 0007 decision 3) ---
  it("classifies reserved first segments with no dedicated route as unknown", () => {
    for (const path of [
      "/assets",
      "/assets/foo.png",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml",
      "/_private",
      "/_x",
      "/_",
    ]) {
      expect(classifyPath(path)).toEqual({ type: "unknown" });
    }
  });

  it("matches reserved words case-insensitively", () => {
    expect(classifyPath("/ASSETS/x.png")).toEqual({ type: "unknown" });
    expect(classifyPath("/FAVICON.ICO")).toEqual({ type: "unknown" });
    expect(classifyPath("/_Private")).toEqual({ type: "unknown" });
  });

  // --- malformed paths → unknown, never throw ---
  it("never throws and returns unknown for malformed paths", () => {
    const malformed = [
      "",
      "hello", // no leading slash
      "//", // empty segments
      "/a//b", // internal empty segment
      "/hello/%2F", // encoded slash (S08: no redirect loops)
      "/p/a%2Fb",
      "/p/a%2fb", // lowercase hex spelling
      "/%2F",
    ];
    for (const path of malformed) {
      expect(classifyPath(path)).toEqual({ type: "unknown" });
    }
  });
});

// --- validator additions (edge/regression, S01) ---

describe("classifyPath — validator edge cases", () => {
  it("strips any number of trailing slashes from every route class", () => {
    expect(classifyPath("/health///")).toEqual({ type: "health" });
    expect(classifyPath("/admin///")).toEqual({ type: "admin" });
    expect(classifyPath("/api///")).toEqual({ type: "api" });
    expect(classifyPath("/p/abc///")).toEqual({ type: "id", id: "abc" });
    expect(classifyPath("/hello///")).toEqual({ type: "slug", slug: "hello" });
  });

  it("accepts reserved-word near-misses as slugs (exact whole-segment match, ADR 0007/OQ-02)", () => {
    expect(classifyPath("/adminx")).toEqual({ type: "slug", slug: "adminx" });
    expect(classifyPath("/admin2")).toEqual({ type: "slug", slug: "admin2" });
    expect(classifyPath("/api2")).toEqual({ type: "slug", slug: "api2" });
    expect(classifyPath("/pages")).toEqual({ type: "slug", slug: "pages" });
  });

  it("treats a deeper path under a near-miss slug as unknown", () => {
    expect(classifyPath("/adminx/foo")).toEqual({ type: "unknown" });
  });

  it("keeps the id namespace separate from reserved words: /p/{reserved} is still an id", () => {
    // ADR 0007 decision 3: slug lookups never query a reserved word — the
    // /p prefix guarantees it by construction; the store 404s the miss.
    expect(classifyPath("/p/admin")).toEqual({ type: "id", id: "admin" });
    expect(classifyPath("/p/health")).toEqual({ type: "id", id: "health" });
  });

  it("returns unknown for the reserved prefix with no id, even in uppercase", () => {
    expect(classifyPath("/P")).toEqual({ type: "unknown" });
    expect(classifyPath("/P/")).toEqual({ type: "unknown" });
    expect(classifyPath("/P/abc/")).toEqual({ type: "id", id: "abc" });
  });

  it("leaves the id segment raw — dots and other non-id chars are not routed away", () => {
    // Structural id validation is S15's job (id → 400); routing only splits.
    expect(classifyPath("/p/a.b")).toEqual({ type: "id", id: "a.b" });
    expect(classifyPath("/p/a%20b")).toEqual({ type: "id", id: "a%20b" });
  });

  it("classifies reserved names with trailing slashes as unknown (never slug)", () => {
    for (const path of [
      "/assets/",
      "/favicon.ico/",
      "/robots.txt/",
      "/sitemap.xml/",
      "/_private/",
    ]) {
      expect(classifyPath(path)).toEqual({ type: "unknown" });
    }
  });

  it("does not validate slug charset — dots pass through lowercased (D1 lookup 404s later)", () => {
    expect(classifyPath("/my.post")).toEqual({ type: "slug", slug: "my.post" });
  });

  it("rejects encoded slashes in slug position too", () => {
    expect(classifyPath("/hello%2Fworld")).toEqual({ type: "unknown" });
    expect(classifyPath("/hello%2fworld/")).toEqual({ type: "unknown" });
  });

  it("returns unknown for a path of only slashes", () => {
    expect(classifyPath("///")).toEqual({ type: "unknown" });
    expect(classifyPath("////")).toEqual({ type: "unknown" });
  });

  it("never throws on adversarial input (total function)", () => {
    const adversarial = [
      "/%",
      "/%2",
      "/%2g",
      "/p/%",
      "/p/%2F/extra",
      "/a/b/c/d",
      "/-",
      "/_",
      "/.",
      "/..",
      "/...",
    ];
    for (const path of adversarial) {
      expect(() => classifyPath(path)).not.toThrow();
    }
  });
});
