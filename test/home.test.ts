import { describe, expect, it } from "vitest";
import { resolveHome, type HomeResolution } from "../src/home";

// S09 — Home-mode behavior (spec §11, OQ-08, ADR 0018).
// `resolveHome` is a pure decision function: it returns either a designated slug
// to serve at `/` or a 404 decision. It does not build a Response and does not
// touch bindings; the actual page lookup and 404 rendering happen in S12.

const page = (slug: string): HomeResolution => ({ type: "page" as const, slug });
const notFound: HomeResolution = { type: "404" as const };

describe("resolveHome — happy path", () => {
  it("returns the designated slug when HOME_MODE is page and slug is valid", () => {
    expect(resolveHome("page", "hello")).toEqual(page("hello"));
    expect(resolveHome("page", "my-post")).toEqual(page("my-post"));
    expect(resolveHome("page", "a")).toEqual(page("a"));
    expect(resolveHome("page", "a".repeat(64))).toEqual(page("a".repeat(64)));
  });

  it("normalizes HOME_MODE by trimming whitespace and lowercasing", () => {
    expect(resolveHome("PAGE", "hello")).toEqual(page("hello"));
    expect(resolveHome("Page", "hello")).toEqual(page("hello"));
    expect(resolveHome(" page ", "hello")).toEqual(page("hello"));
    expect(resolveHome("page\t", "hello")).toEqual(page("hello"));
    expect(resolveHome("\npage", "hello")).toEqual(page("hello"));
    expect(resolveHome(" PaGe ", "hello")).toEqual(page("hello"));
  });
});

describe("resolveHome — fail-safe 404 for non-page modes", () => {
  it.each([
    ["404"],
    [""],
    [null],
    [undefined],
    ["unlisted"],
    ["redirect"],
    ["home"],
    ["garbage"],
    ["   "],
    ["\t"],
    ["\n"],
    ["404\n"],
    [" 404 "],
  ])("returns 404 for HOME_MODE=%o", (mode) => {
    expect(resolveHome(mode, "hello")).toEqual(notFound);
  });
});

describe("resolveHome — invalid or missing slug when mode is page", () => {
  it.each([
    [""],
    [null],
    [undefined],
    [" "],
    ["\t"],
    ["hello world"],
    ["HELLO"],
    ["My-Post"],
    ["admin"],
    ["api"],
    ["p"],
    ["assets"],
    ["favicon.ico"],
    ["robots.txt"],
    ["sitemap.xml"],
    ["health"],
    ["_draft"],
    ["_"],
    ["my.post"],
    ["my/post"],
    ["my\\post"],
    ["a".repeat(65)],
    ["😀"],
    ["café"],
  ])("returns 404 for HOME_PAGE_SLUG=%o", (slug) => {
    expect(resolveHome("page", slug)).toEqual(notFound);
  });
});

describe("resolveHome — direct serve (no redirect)", () => {
  it("returns a page decision, not a redirect", () => {
    const result = resolveHome("page", "hello");
    expect(result.type).toBe("page");
    if (result.type === "page") {
      expect(result.slug).toBe("hello");
    }
  });

  it("does not include a status or Location header in the decision", () => {
    const result = resolveHome("page", "hello");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("location");
  });
});

describe("resolveHome — safety and failure modes", () => {
  it("never throws for any combination of mode and slug", () => {
    const modes = ["page", "404", "", "   ", null, undefined, "garbage"];
    const slugs = ["", "hello", "admin", "😀", null, undefined, "a".repeat(1000)];
    for (const mode of modes) {
      for (const slug of slugs) {
        expect(() =>
          resolveHome(mode as unknown as string, slug as unknown as string),
        ).not.toThrow();
      }
    }
  });

  it("never throws for exotic non-string mode and slug inputs", () => {
    const exotic = [
      Symbol("mode"),
      {},
      [],
      new Date(),
      42,
      new String("page"),
      new String("hello"),
    ];
    for (const mode of exotic) {
      for (const slug of exotic) {
        expect(() =>
          resolveHome(mode as unknown as string, slug as unknown as string),
        ).not.toThrow();
      }
    }
    // Sanity: every exotic combination resolves to 404.
    expect(resolveHome("page", Symbol("slug") as unknown as string)).toEqual(notFound);
    expect(resolveHome(Symbol("mode") as unknown as string, "hello")).toEqual(notFound);
    expect(resolveHome(new String("page") as unknown as string, "hello")).toEqual(notFound);
    expect(resolveHome("page", new String("hello") as unknown as string)).toEqual(notFound);
  });

  it("does not leak the reserved-word error message to the consumer", () => {
    const result = resolveHome("page", "admin");
    expect(result).toEqual(notFound);
    if (result.type === "404") {
      expect(result).not.toHaveProperty("error");
      expect(result).not.toHaveProperty("message");
    }
  });

  it("does not leak the invalid-slug error message for malformed slugs", () => {
    const result = resolveHome("page", "hello world");
    expect(result).toEqual(notFound);
    if (result.type === "404") {
      expect(result).not.toHaveProperty("error");
    }
  });

  it("returns 404 for slugs with leading, trailing, or internal whitespace", () => {
    expect(resolveHome("page", " hello")).toEqual(notFound);
    expect(resolveHome("page", "hello ")).toEqual(notFound);
    expect(resolveHome("page", "hello\tworld")).toEqual(notFound);
    expect(resolveHome("page", "hello\nworld")).toEqual(notFound);
  });

  it("returns the slug exactly as provided, without normalization", () => {
    // A valid slug that contains underscores and dashes is preserved verbatim.
    expect(resolveHome("page", "my_slug-1")).toEqual(page("my_slug-1"));
    // A valid slug that is already 64 chars is preserved exactly.
    const long = "a".repeat(64);
    expect(resolveHome("page", long)).toEqual(page(long));
  });
});

describe("resolveHome — validator edge cases", () => {
  it("accepts a slug that equals a page id (separate namespaces, spec §4)", () => {
    expect(resolveHome("page", "a1b2c3d4e5")).toEqual(page("a1b2c3d4e5"));
  });

  it("accepts near-reserved slugs that are not exact reserved names", () => {
    expect(resolveHome("page", "admin2")).toEqual(page("admin2"));
    expect(resolveHome("page", "p-2")).toEqual(page("p-2"));
    expect(resolveHome("page", "healthz")).toEqual(page("healthz"));
    expect(resolveHome("page", "favicon")).toEqual(page("favicon"));
    expect(resolveHome("page", "robots")).toEqual(page("robots"));
  });
});
