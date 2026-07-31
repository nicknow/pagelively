import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors";
import { RESERVED_NAMES } from "../src/reserved";
import { validateSlug } from "../src/slug";

// S02 AC — reserved-word validation (spec §5, ADR 0007/0010, OQ-02).
// `validateSlug` is the API-boundary predicate: any slug that reaches the
// create/edit API (S17/S18) must pass it. Pure, total (never throws), and it
// consumes the single RESERVED_NAMES source in reserved.ts — no copy here.

const okResult = { ok: true as const };

/** Asserts a rejected result whose message contains `word` (distinctive per rule). */
function expectFailure(input: string, word: string): void {
  const result = validateSlug(input);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeInstanceOf(AppError);
    expect(result.error.code).toBe("invalid_slug");
    expect(result.error.status).toBe(400);
    expect(result.error.publicMessage.toLowerCase()).toContain(word);
  }
}

describe("validateSlug — reserved names rejected (AC 1, ADR 0007 decision 2)", () => {
  it("rejects every name in the RESERVED_NAMES source with the reserved message", () => {
    for (const name of RESERVED_NAMES) {
      expectFailure(name, "reserved name");
    }
  });

  it("rejects case variants of reserved names (case is moot at the API boundary, OQ-02)", () => {
    for (const name of RESERVED_NAMES) {
      expect(validateSlug(name.toUpperCase()).ok).toBe(false);
      expect(validateSlug(name.charAt(0).toUpperCase() + name.slice(1)).ok).toBe(false);
    }
  });

  it("reports the reserved reason even when the name contains dots (favicon.ico, robots.txt)", () => {
    // The reserved check runs before the charset check, so the dots in these
    // two list entries do not mask the true rejection reason.
    expectFailure("favicon.ico", "reserved name");
    expectFailure("robots.txt", "reserved name");
  });
});

describe("validateSlug — `_` prefix rejected (AC 2; the only prefix rule)", () => {
  it("rejects every underscore-prefixed slug, including the bare underscore", () => {
    for (const slug of ["_", "_draft", "_pages", "__init", "_x", "_private"]) {
      expectFailure(slug, "internal");
    }
  });
});

describe("validateSlug — near-misses accepted (AC 3, exact whole-segment match)", () => {
  it("accepts every near-miss named in the AC", () => {
    for (const slug of ["admin2", "p-2", "my-post", "p2", "favicon", "healthz"]) {
      expect(validateSlug(slug)).toEqual(okResult);
    }
  });

  it("accepts other names not in the exact list", () => {
    for (const slug of [
      "pages", // `pages` is NOT reserved — only `_pages` is (ADR 0007 decision 2)
      "api2",
      "robots",
      "sitemap",
      "assets2",
      "health-check",
      "my_posts",
      "notes",
      "a",
    ]) {
      expect(validateSlug(slug)).toEqual(okResult);
    }
  });
});

describe("validateSlug — lowercase-only (AC 4, OQ-02; defense at the API boundary)", () => {
  it("rejects any slug containing uppercase letters", () => {
    for (const slug of ["Admin", "ADMIN", "My-Post", "myPost", "P", "A", "xYz", "p-2X"]) {
      expectFailure(slug, "lowercase");
    }
  });

  it("rejects an uppercase near-miss too — case is moot before the reserved comparison", () => {
    // "Assets" is not in the list, but uppercase input is rejected by the
    // lowercase rule regardless (slugify would have lowercased it first; the
    // normalized form "assets" IS reserved — both paths reject).
    expectFailure("Assets", "lowercase");
    expectFailure("Admin2", "lowercase");
  });
});

describe("validateSlug — id and slug namespaces are separate (AC 5, spec §4)", () => {
  it("accepts a slug equal to another page's id", () => {
    // §4: the id URL and the slug URL are separate namespaces pointing at the
    // same Page; ADR 0007 decision 4: id-only routes are slug-agnostic. The
    // predicate has no cross-namespace knowledge — per-namespace uniqueness
    // is the store's job (S10, `slug` unique index). Not an error.
    expect(validateSlug("a1b2c3d4e5")).toEqual(okResult);
    expect(validateSlug("x9y8z7")).toEqual(okResult);
  });
});

describe("validateSlug — length bounds (consistent with validateId, ADR 0010)", () => {
  it("accepts slugs of 1 and 64 characters and rejects 65+", () => {
    expect(validateSlug("a")).toEqual(okResult);
    expect(validateSlug("a".repeat(64))).toEqual(okResult);
    expectFailure("a".repeat(65), "64");
    expectFailure("a".repeat(1000), "64");
  });
});

describe("validateSlug — slug charset [a-z0-9_-] (ADR 0007 decision 1)", () => {
  it("accepts every character class of the slug alphabet", () => {
    expect(validateSlug("a_z-09")).toEqual(okResult); // lower, _, dash, digits
  });

  it("rejects characters outside the slug alphabet with the charset message", () => {
    for (const bad of [
      "my post",
      "my.post",
      "my%post",
      "my#post",
      "café",
      "😀",
      "a\nb",
      "a\tb",
      "a+b",
      "a@b",
      "a?b",
      "a&b",
      "a/b",
      "a\\b",
      "a'b",
      "a.b",
    ]) {
      expectFailure(bad, "letters");
    }
  });

  it("rejects control characters and line terminators at any position ($ is end-of-input)", () => {
    expectFailure("abc\n", "letters");
    expectFailure("abc\r", "letters");
    expectFailure("abc\t", "letters");
    expectFailure("hello\n", "letters"); // within the 64 bound — regex must still reject
  });
});

describe("validateSlug — whole-segment exactness (ADR 0007 decision 2)", () => {
  it("rejects decorations of reserved names for the CHARSET reason, not the reserved reason", () => {
    // The reserved comparison is exact on the whole segment, so "admin.",
    // "favicon.ico2" and "p/p" are NOT reserved matches — they are rejected
    // by the charset rule (`.`, `/` are outside [a-z0-9_-]). Asserting the
    // charset message proves the reserved check did not fire on them.
    for (const slug of ["admin.", "admin/", "favicon.ico2", "robots.txt2", "p/p"]) {
      expectFailure(slug, "letters");
    }
  });
});

describe("validateSlug — failure modes", () => {
  it("rejects the empty slug", () => {
    expectFailure("", "empty");
  });

  it("returns { ok: true } with no payload on success", () => {
    expect(validateSlug("hello")).toEqual({ ok: true });
  });

  it("never throws on malformed input and always returns a typed failure", () => {
    for (const input of ["", "!!!", "日本語", "😀", "a".repeat(1000), "A".repeat(70), "a\nb"]) {
      expect(() => validateSlug(input)).not.toThrow();
      expect(validateSlug(input).ok).toBe(false);
    }
  });
});

// --- validator additions (edge/regression, S02) ---

describe("validateSlug — validator edge cases (S02)", () => {
  it("treats dotted reserved names as literal strings, not patterns (dot→underscore variants accepted)", () => {
    // Only the exact strings "favicon.ico"/"robots.txt"/"sitemap.xml" are
    // reserved; underscore substitutions are different whole segments and
    // underscores are first-class slug characters (ADR 0010).
    for (const slug of ["favicon_ico", "robots_txt", "sitemap_xml", "faviconico", "robotstxt"]) {
      expect(validateSlug(slug)).toEqual(okResult);
    }
  });

  it("never reports the reserved reason for any decoration of any reserved name", () => {
    // Whole-segment exactness pin across the entire list (ADR 0007 decision 2):
    // a decoration of a reserved name is either accepted (charset-valid, e.g.
    // "admin2", "p2") or rejected by the charset rule (dotted entries, e.g.
    // "favicon.ico2") — never by the reserved rule.
    for (const name of RESERVED_NAMES) {
      for (const deco of ["2", "-x", "_x", "x", "."]) {
        const result = validateSlug(name + deco);
        if (!result.ok) {
          expect(result.error.publicMessage.toLowerCase()).not.toContain("reserved name");
        }
      }
    }
  });

  it("accepts charset-valid decorations of reserved names (exact whole-segment match)", () => {
    // `admin-`/`api-` are Worker-accepted, but the edge Access app protects
    // /admin* and /api* (spec §9) — such a slug is Access-challenged before
    // the Worker classifies it: more restrictive, not a security hole
    // (roadmap S02 NOTE; recorded for the S20/S22 ops/smoke docs).
    for (const slug of ["p-", "-p", "p_", "p2-", "admin-", "api-", "health_", "assets-1"]) {
      expect(validateSlug(slug)).toEqual(okResult);
    }
  });

  it("rejects underscore-prefixed near-misses too — the prefix rule is not list-scoped", () => {
    for (const slug of ["_p", "_admin", "_api", "_" + "a".repeat(63)]) {
      expectFailure(slug, "internal");
    }
  });

  it("rejects line-terminator/dot decorations of reserved names by the charset rule — no $ bypass", () => {
    // JS `$` without /m is absolute end-of-input, so trailing newlines must
    // not sneak a reserved name past the exact-match check (and cannot pass
    // the charset either).
    for (const slug of ["favicon.ico\n", "favicon.ico.", "admin\n", "robots.txt\r", "health\t"]) {
      expectFailure(slug, "letters");
    }
  });

  it("rejects traversal-shaped slugs (charset has no `.` or `/`)", () => {
    for (const slug of [".", "..", "./x", "../x", "a/.."]) {
      expectFailure(slug, "letters");
    }
  });

  it("rejects an uppercase id-shaped slug by the lowercase rule — no id-namespace bypass", () => {
    // Cross-namespace tolerance (AC 5) means no id-collision check exists;
    // the lowercase rule still applies to any uppercase input (ids are a
    // case-sensitive namespace; slugs are lowercase-only).
    expectFailure("A1b2C3d4E5", "lowercase");
  });

  it("rejects a 64-char body plus a line terminator by the length rule first (order: length → charset)", () => {
    expectFailure("a".repeat(64) + "\n", "64");
  });
});
