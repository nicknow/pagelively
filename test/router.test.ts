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

// --- S23-A AC 9 — unlock and asset route families (ADR 0041 decision 6) ---

describe("classifyPath — S23 unlock route (/p/{id}/unlock[/])", () => {
  it("classifies /p/{id}/unlock and /p/{id}/unlock/ as unlock, keeping the id raw", () => {
    expect(classifyPath("/p/abc123/unlock")).toEqual({ type: "unlock", id: "abc123" });
    expect(classifyPath("/p/abc123/unlock/")).toEqual({ type: "unlock", id: "abc123" });
    expect(classifyPath("/p/AbC_1-x/unlock")).toEqual({ type: "unlock", id: "AbC_1-x" });
  });

  it("matches the unlock literal case-insensitively", () => {
    expect(classifyPath("/p/abc/UNLOCK")).toEqual({ type: "unlock", id: "abc" });
    expect(classifyPath("/p/abc/Unlock")).toEqual({ type: "unlock", id: "abc" });
  });

  it("tolerates multiple trailing slashes on unlock paths", () => {
    expect(classifyPath("/p/abc/unlock///")).toEqual({ type: "unlock", id: "abc" });
  });

  it("classifies only exactly that depth as unlock — deeper paths are unknown", () => {
    expect(classifyPath("/p/abc/unlock/x")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/abc/unlock/x/y")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/unlock/extra")).toEqual({ type: "unknown" });
  });

  it("keeps the id namespace separate: /p/{id} with id 'unlock' stays an id route", () => {
    expect(classifyPath("/p/unlock")).toEqual({ type: "id", id: "unlock" });
    expect(classifyPath("/p/unlock/unlock")).toEqual({ type: "unlock", id: "unlock" });
  });

  it("leaves /p/{id} and /p unchanged (regression)", () => {
    expect(classifyPath("/p/abc123")).toEqual({ type: "id", id: "abc123" });
    expect(classifyPath("/p/abc123/")).toEqual({ type: "id", id: "abc123" });
    expect(classifyPath("/p")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/")).toEqual({ type: "unknown" });
  });

  it("still rejects encoded slashes on unlock paths (unchanged rule)", () => {
    expect(classifyPath("/p/a%2Fb/unlock")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/abc/unl%2Fock")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/a%2fb/unlock")).toEqual({ type: "unknown" });
  });
});

describe("classifyPath — S23 asset route (/assets/pages/{id}/{rev}/{path…})", () => {
  it("classifies /assets/pages/{id}/{rev}/{path…} as asset, joining remaining raw segments", () => {
    expect(classifyPath("/assets/pages/abc/1/index.html")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "index.html",
    });
    expect(classifyPath("/assets/pages/abc/2/images/pic.png")).toEqual({
      type: "asset",
      id: "abc",
      rev: "2",
      path: "images/pic.png",
    });
    expect(classifyPath("/assets/pages/abc/3/a/b/c/d.txt")).toEqual({
      type: "asset",
      id: "abc",
      rev: "3",
      path: "a/b/c/d.txt",
    });
  });

  it("keeps the id and rev segments raw (routing only splits)", () => {
    expect(classifyPath("/assets/pages/AbC_1-x/12/foo.png")).toEqual({
      type: "asset",
      id: "AbC_1-x",
      rev: "12",
      path: "foo.png",
    });
  });

  it("matches the assets prefix and the pages literal case-insensitively", () => {
    expect(classifyPath("/ASSETS/pages/abc/1/x.png")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "x.png",
    });
    expect(classifyPath("/assets/PAGES/abc/1/x.png")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "x.png",
    });
  });

  it("classifies any other /assets/… path as unknown (reserved, ADR 0007)", () => {
    const reserved = [
      "/assets",
      "/assets/",
      "/assets/foo.png",
      "/assets/pages",
      "/assets/pages/",
      "/assets/pages/abc",
      "/assets/pages/abc/1", // no path segment — not an object URL
      "/assets/pages/abc/1/",
      "/assets/pagesx/abc/1/x",
      "/assets/other/x",
      "/assets/ADMIN/1/x",
    ];
    for (const path of reserved) {
      expect(classifyPath(path)).toEqual({ type: "unknown" });
    }
  });

  it("rejects empty segments and encoded slashes in asset paths", () => {
    expect(classifyPath("/assets//pages/abc/1/x")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages//abc/1/x")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages/abc/1/a//b")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages/abc/1/a%2Fb")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages/a%2Fb/1/x")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages/abc/1/x%2fy")).toEqual({ type: "unknown" });
  });

  it("never throws on adversarial asset paths (total function)", () => {
    for (const path of [
      "/assets/pages/%/1/x",
      "/assets/pages/abc/%2/1/x",
      "/assets/pages/abc/1/%",
      "/assets/pages/./1/x",
      "/assets/pages/abc/../x",
    ]) {
      expect(() => classifyPath(path)).not.toThrow();
    }
  });
});
