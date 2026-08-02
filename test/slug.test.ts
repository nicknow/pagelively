import { describe, expect, it } from "vitest";
import { cleanSlug, slugify } from "../src/slug";

// S01 AC 3 — slugify (spec §4, ADR 0007/0010). Empty result is a typed
// failure (AppError-style, code invalid_slug, 400 at the API layer later);
// the module stays pure — no throwing.

const ok = (slug: string) => ({ ok: true as const, slug });
const err = { ok: false as const, error: { code: "invalid_slug", status: 400 } };

describe("slugify", () => {
  // --- happy path ---
  it('slugifies "My Post 1.md" to "my-post-1" (§4)', () => {
    expect(slugify("My Post 1.md")).toEqual(ok("my-post-1"));
  });

  it("lowercases the input", () => {
    expect(slugify("MY POST")).toEqual(ok("my-post"));
  });

  it("keeps ASCII letters, digits, dashes and underscores", () => {
    expect(slugify("a_b-c9")).toEqual(ok("a_b-c9"));
  });

  it("strips the extension from filenames", () => {
    expect(slugify("README.md")).toEqual(ok("readme"));
    expect(slugify("photo.PNG")).toEqual(ok("photo"));
    expect(slugify("notes.txt")).toEqual(ok("notes"));
  });

  it("strips only the final extension (archive.tar.gz → archive-tar)", () => {
    expect(slugify("archive.tar.gz")).toEqual(ok("archive-tar"));
  });

  it("keeps digit-suffixed titles intact (Chapter 1.5 → chapter-1-5)", () => {
    expect(slugify("Chapter 1.5")).toEqual(ok("chapter-1-5"));
  });

  it("works without an extension", () => {
    expect(slugify("My Post 1")).toEqual(ok("my-post-1"));
  });

  // --- edge cases ---
  it("collapses runs of characters outside the slug alphabet to a single dash", () => {
    expect(slugify("My  -  Post")).toEqual(ok("my-post"));
    // NB: avoid a trailing ".letters" in these inputs — that is an extension
    // and is stripped (filename semantics, ADR 0010).
    expect(slugify("a!!!b...c!")).toEqual(ok("a-b-c"));
  });

  it("canonicalizes runs of dashes to a single dash", () => {
    expect(slugify("a--b")).toEqual(ok("a-b"));
    expect(slugify("my - post")).toEqual(ok("my-post"));
  });

  it("maps non-ASCII letters to dashes and trims the result", () => {
    expect(slugify("Café")).toEqual(ok("caf"));
    expect(slugify("Über Café.md")).toEqual(ok("ber-caf"));
  });

  it("trims leading and trailing dashes", () => {
    expect(slugify("-hello-")).toEqual(ok("hello"));
    expect(slugify("-- hello world --")).toEqual(ok("hello-world"));
  });

  it("preserves underscores — first-class slug characters (ADR 0007)", () => {
    expect(slugify("My_Notes.txt")).toEqual(ok("my_notes"));
  });

  // --- failure modes ---
  it("returns an invalid_slug AppError failure when the result would be empty", () => {
    const result = slugify("日本語");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_slug");
      expect(result.error.status).toBe(400);
      expect(result.error.publicMessage.length).toBeGreaterThan(0);
    }
  });

  it("fails for input with no slugifiable characters", () => {
    expect(slugify("---")).toMatchObject(err);
    expect(slugify("!!!")).toMatchObject(err);
    expect(slugify("")).toMatchObject(err);
  });

  it("never throws, even on input that cannot form a slug", () => {
    expect(() => slugify("日本語")).not.toThrow();
    expect(() => slugify("")).not.toThrow();
    expect(() => slugify("😀😀")).not.toThrow();
  });
});

// --- validator additions (edge/regression, S01) ---

describe("slugify — validator edge cases", () => {
  it("preserves runs of underscores — first-class slug characters (ADR 0007 alphabet)", () => {
    expect(slugify("a__b")).toEqual(ok("a__b"));
    expect(slugify("A__B.md")).toEqual(ok("a__b"));
  });

  it("keeps a dash flanked by underscores (mixed separators are not a dash run)", () => {
    expect(slugify("a - _ - b")).toEqual(ok("a-_-b"));
  });

  it("returns a pure-underscore slug for underscore-only input (S02 rejects it: _-prefix)", () => {
    // Documented ADR 0010 consequence: slugify only fails on EMPTY results;
    // `_`-prefixed slugs are rejected by the S02 reserved check, not here.
    expect(slugify("___")).toEqual(ok("___"));
    expect(slugify("_draft")).toEqual(ok("_draft"));
  });

  it("degrades a non-Latin title with an underscore to a bare underscore (S02 rejects)", () => {
    expect(slugify("日本語_メモ")).toEqual(ok("_"));
  });

  it("fails for a bare extension ('.md' has no slugifiable base)", () => {
    expect(slugify(".md")).toMatchObject(err);
    expect(slugify(".HTML")).toMatchObject(err);
  });

  it("treats a trailing dot without letters as a separator, not an extension", () => {
    expect(slugify("hello.")).toEqual(ok("hello"));
    expect(slugify("a..md")).toEqual(ok("a"));
  });

  it("strips a mixed-case extension but only the final one", () => {
    expect(slugify("README.Md")).toEqual(ok("readme"));
    expect(slugify("notes.v2.md")).toEqual(ok("notes-v2"));
  });

  it("returns an AppError instance for empty results (architecture 05 contract)", () => {
    const result = slugify("日本語");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.code).toBe("invalid_slug");
      expect(result.error.status).toBe(400);
    }
  });
});

// --- T1 / OQ-15 — cleanSlug: user-entered slug cleaning (ADR 0036) ---

describe("cleanSlug", () => {
  function expectClean(input: string, expected: string): void {
    expect(cleanSlug(input)).toEqual(ok(expected));
  }

  function expectFailure(input: string, word: string): void {
    const result = cleanSlug(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_slug");
      expect(result.error.status).toBe(400);
      expect(result.error.publicMessage.toLowerCase()).toContain(word);
    }
  }

  it("trims surrounding whitespace and lowercases (AC 1: '  My Post  ' → 'my-post')", () => {
    expectClean("  My Post  ", "my-post");
  });

  it("collapses junk runs, canonicalizes dashes, and trims edge dashes (AC 2)", () => {
    expectClean("My - - Post!!", "my-post");
  });

  it("treats a dotted title as a separator, not an extension (AC 3)", () => {
    expectClean("Chapter 1.5", "chapter-1-5");
  });

  it("does NOT strip extensions — 'my.md' → 'my-md' (AC 3, contrast slugify)", () => {
    expectClean("my.md", "my-md");
    // regression pin: slugify still strips the extension
    expect(slugify("my.md")).toEqual(ok("my"));
  });

  it("rejects a raw `_`-prefixed name intact (AC 4)", () => {
    expectFailure("_hidden", "internal");
    expectFailure(" _draft ", "internal");
  });

  it("rejects an exact reserved name intact — 'favicon.ico' is never renamed (AC 5)", () => {
    expectFailure("favicon.ico", "reserved name");
    expectFailure("robots.txt", "reserved name");
  });

  it("rejects a reserved name that only appears after cleaning (AC 6: ' Admin! ' → 'admin')", () => {
    expectFailure(" Admin! ", "reserved name");
  });

  it("fails for empty and whitespace-only input (AC 7)", () => {
    expectFailure("", "empty");
    expectFailure("   ", "empty");
  });

  it("fails with an actionable message when non-empty input cleans to nothing (AC 8)", () => {
    const result = cleanSlug("!!!");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_slug");
      expect(result.error.status).toBe(400);
      expect(result.error.publicMessage).toBe("Name contains no characters that can form a slug.");
    }
  });

  it("truncates to 64 characters (AC 9)", () => {
    expectClean("a".repeat(65), "a".repeat(64));
    expectClean("a".repeat(63), "a".repeat(63));
    expectClean("a".repeat(64), "a".repeat(64));
  });

  it("strips a trailing dash when the 64-char cut lands on one (AC 9)", () => {
    // "a"×63 + "-bc" cleans to 66 chars; slice(0,64) = "a"×63 + "-" → strip → "a"×63
    expectClean("a".repeat(63) + "-bc", "a".repeat(63));
  });

  it("is idempotent — cleaning a cleaned slug is a no-op (AC 10)", () => {
    for (const input of [
      "  My Post  ",
      "My - - Post!!",
      "Chapter 1.5",
      "my.md",
      "a".repeat(65),
      "a".repeat(63) + "-bc",
    ]) {
      const once = cleanSlug(input);
      expect(once.ok).toBe(true);
      if (once.ok) {
        expect(cleanSlug(once.slug)).toEqual(ok(once.slug));
      }
    }
  });

  it("never throws and always returns a typed result (AC 11)", () => {
    expect(() => cleanSlug("")).not.toThrow();
    expect(() => cleanSlug("!!!")).not.toThrow();
    expect(() => cleanSlug("日本語")).not.toThrow();
    expect(() => cleanSlug("_hidden")).not.toThrow();
  });
});
