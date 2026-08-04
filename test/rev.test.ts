import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors";
import { validateId } from "../src/ids";
import { buildR2Key, nextRev, shouldBumpRev } from "../src/rev";

// S03 AC 1–5 — rev bump policy and key layout (spec §8, ADR 0006/0012,
// architecture 04 purge matrix). Pure unit tests; no bindings.

/** Asserts that `fn` throws an AppError with the exact code/status. */
function expectAppError(fn: () => unknown, code: string, status: number, message?: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
  expect((caught as AppError).status).toBe(status);
  if (message !== undefined) {
    expect((caught as AppError).publicMessage).toMatch(message);
  }
}

describe("nextRev (S03 AC 1)", () => {
  it("increments a positive integer rev by 1", () => {
    expect(nextRev(1)).toBe(2);
    expect(nextRev(2)).toBe(3);
    expect(nextRev(3)).toBe(4);
    expect(nextRev(41)).toBe(42);
  });

  it("rejects 0 (rev starts at 1 per §8 DEFAULT 1)", () => {
    expectAppError(() => nextRev(0), "invalid_rev", 500, /positive integer/);
  });

  it("rejects negative revs", () => {
    expectAppError(() => nextRev(-1), "invalid_rev", 500);
    expectAppError(() => nextRev(-100), "invalid_rev", 500);
  });

  it("rejects fractional revs", () => {
    expectAppError(() => nextRev(1.5), "invalid_rev", 500);
    expectAppError(() => nextRev(0.1), "invalid_rev", 500);
  });

  it("rejects NaN", () => {
    expectAppError(() => nextRev(NaN), "invalid_rev", 500);
  });

  it("rejects Infinity and -Infinity", () => {
    expectAppError(() => nextRev(Infinity), "invalid_rev", 500);
    expectAppError(() => nextRev(-Infinity), "invalid_rev", 500);
  });

  it("rejects non-number values (runtime guard for JS interop)", () => {
    // TS forbids these; the cast documents the runtime contract.
    for (const bad of ["2", null, undefined, {}] as unknown[]) {
      expectAppError(() => nextRev(bad as number), "invalid_rev", 500);
    }
  });

  it("never mutates or clamps: a valid rev always returns rev + 1", () => {
    expect(nextRev(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("buildR2Key (S03 AC 2 & 3, spec §8 layout)", () => {
  it("emits the canonical pages/{id}/{rev}/{path} layout (§8)", () => {
    expect(buildR2Key("abc123", 3, "images/pic.png")).toBe("pages/abc123/3/images/pic.png");
  });

  it("places root-level files directly under the rev folder", () => {
    expect(buildR2Key("abc123", 1, "index.html")).toBe("pages/abc123/1/index.html");
    expect(buildR2Key("abc123", 1, "source.md")).toBe("pages/abc123/1/source.md");
  });

  it("normalizes duplicate slashes (images//pic.png → images/pic.png)", () => {
    expect(buildR2Key("abc123", 3, "images//pic.png")).toBe("pages/abc123/3/images/pic.png");
    expect(buildR2Key("abc123", 3, "a//b///c.png")).toBe("pages/abc123/3/a/b/c.png");
  });

  it("normalizes ./ segments (./style.css → style.css)", () => {
    expect(buildR2Key("abc123", 3, "./style.css")).toBe("pages/abc123/3/style.css");
    expect(buildR2Key("abc123", 3, "images/./pic.png")).toBe("pages/abc123/3/images/pic.png");
  });

  it("collapses non-escaping .. segments (a/../b → b)", () => {
    // AC-literal escape rejection: only paths that ESCAPE the prefix are
    // rejected; a cancelling `..` is normalized away by popping the previous
    // segment (ADR 0012 decision 4).
    expect(buildR2Key("abc123", 3, "a/../b")).toBe("pages/abc123/3/b");
    expect(buildR2Key("abc123", 3, "images/../style.css")).toBe("pages/abc123/3/style.css");
  });

  it("strips trailing slashes (normalization family of `//`)", () => {
    expect(buildR2Key("abc123", 3, "images/")).toBe("pages/abc123/3/images");
    expect(buildR2Key("abc123", 3, "images/pic.png/")).toBe("pages/abc123/3/images/pic.png");
  });

  it("rejects leading-.. escapes: ../x", () => {
    expectAppError(() => buildR2Key("abc123", 3, "../x"), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "../"), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, ".."), "path_traversal", 400);
  });

  it("rejects escapes from deeper paths: a/../../b", () => {
    expectAppError(() => buildR2Key("abc123", 3, "a/../../b"), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "a/b/../../../x"), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "./../x"), "path_traversal", 400);
  });

  it("rejects absolute paths", () => {
    expectAppError(() => buildR2Key("abc123", 3, "/etc/passwd"), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "/images/pic.png"), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "//double-slash-absolute"), "path_traversal", 400);
  });

  it("rejects empty paths and paths that normalize to empty", () => {
    expectAppError(() => buildR2Key("abc123", 3, ""), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "./"), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "."), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "a/.."), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "a/./../b/.."), "path_traversal", 400);
  });

  it("guards rev with the same positive-integer invariant as nextRev", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      expectAppError(() => buildR2Key("abc123", bad, "x"), "invalid_rev", 500);
    }
  });

  it("treats ..-lookalike segments literally (exact-segment matching)", () => {
    expect(buildR2Key("abc123", 3, "a..b")).toBe("pages/abc123/3/a..b");
    expect(buildR2Key("abc123", 3, "...")).toBe("pages/abc123/3/...");
    expect(buildR2Key("abc123", 3, ".hidden")).toBe("pages/abc123/3/.hidden");
    expect(buildR2Key("abc123", 3, "..hidden/file.png")).toBe("pages/abc123/3/..hidden/file.png");
  });

  it("treats paths as already-decoded strings: %-sequences are literal, never decoded", () => {
    // Keys are built from already-decoded strings (task note + ADR 0012 d5):
    // the builder is not a decoder. A literal "%2e%2e" cannot traverse — the
    // decoded request path at the CDN resolves to a key that was never
    // written, so it 404s; write-side `../` rejection is S17's front line.
    expect(buildR2Key("abc123", 3, "%2e%2e/x")).toBe("pages/abc123/3/%2e%2e/x");
    expect(buildR2Key("abc123", 3, "a/%2e%2e/b")).toBe("pages/abc123/3/a/%2e%2e/b");
    expect(buildR2Key("abc123", 3, "%2e%2e")).toBe("pages/abc123/3/%2e%2e");
  });

  it("treats backslashes as literal characters, not separators", () => {
    // R2 keys are `/`-separated only; `\` in a filename is a literal char.
    expect(buildR2Key("abc123", 3, "..\\x")).toBe("pages/abc123/3/..\\x");
  });

  it("passes spaces and unicode through unchanged", () => {
    expect(buildR2Key("abc123", 3, "my images/café.png")).toBe("pages/abc123/3/my images/café.png");
  });
});

describe("shouldBumpRev (S03 AC 4 & 5, architecture 04 purge matrix, OQ-04)", () => {
  it("returns true for content-affecting actions (file add/replace)", () => {
    expect(shouldBumpRev({ type: "file-add" })).toBe(true);
  });

  it("returns true for content-affecting actions (file delete)", () => {
    expect(shouldBumpRev({ type: "file-delete" })).toBe(true);
  });

  it("returns true for content-affecting actions (entry change)", () => {
    expect(shouldBumpRev({ type: "entry-change" })).toBe(true);
  });

  it("returns true for content-affecting actions (markdown re-render)", () => {
    expect(shouldBumpRev({ type: "re-render" })).toBe(true);
  });

  it("returns false for metadata edits (slug-edit, meta-edit)", () => {
    expect(shouldBumpRev({ type: "slug-edit" })).toBe(false);
    expect(shouldBumpRev({ type: "meta-edit" })).toBe(false);
  });

  it("returns false for create (rev starts at 1, §8 DEFAULT 1)", () => {
    expect(shouldBumpRev({ type: "create" })).toBe(false);
  });

  it("returns false for password-edit (metadata — ADR 0041)", () => {
    expect(shouldBumpRev({ type: "password-edit" })).toBe(false);
  });

  it("throws AppError unknown_action on an unknown action type (fail-fast)", () => {
    expectAppError(
      () => shouldBumpRev({ type: "banana" } as never),
      "unknown_action",
      500,
      /banana/,
    );
  });

  it("throws AppError unknown_action on a missing action type", () => {
    expectAppError(() => shouldBumpRev({} as never), "unknown_action", 500);
  });

  it("throws AppError unknown_action on a non-string action type", () => {
    expectAppError(() => shouldBumpRev({ type: 42 } as never), "unknown_action", 500);
  });

  it("throws a typed AppError (never a raw TypeError) for non-object input", () => {
    // TS forbids these; the casts document the runtime fail-fast contract —
    // never silently no-bump (planner AC failure case).
    for (const bad of [null, "file-add", 7, undefined] as unknown[]) {
      expectAppError(() => shouldBumpRev(bad as never), "unknown_action", 500);
    }
  });
});

// ---------------------------------------------------------------------------
// Validator edge suite (S03, independent of the implementer) — appended by the
// validator. Covers: remaining task-mandated traversal inputs, the stack-based
// `..` normalization invariant as a deterministic property test, literalness of
// `%`-sequences/`\`/Unicode lookalikes, id boundary contracts, and the closed
// union's fail-fast surface. ADR 0012 d4/d5 + ADR 0010 (id charset) pin these.
// ---------------------------------------------------------------------------

describe("validator: buildR2Key adversarial traversal family (task list)", () => {
  it("rejects escapes that pop below the root from depth (a/b/../../..)", () => {
    expectAppError(() => buildR2Key("abc123", 3, "a/b/../../.."), "path_traversal", 400);
  });

  it("rejects //../x (absolute-rejection path, not a normalization slip)", () => {
    // Starts with "/" → absolute rejection fires before any segment walk;
    // the `..` never gets a chance to escape silently.
    expectAppError(() => buildR2Key("abc123", 3, "//../x"), "path_traversal", 400);
    expectAppError(() => buildR2Key("abc123", 3, "/../x"), "path_traversal", 400);
  });

  it("collapses non-escaping `..` at depth without rejecting (a/b/.. → a)", () => {
    expect(buildR2Key("abc123", 3, "a/b/..")).toBe("pages/abc123/3/a");
    expect(buildR2Key("abc123", 3, "a/b/../c/../d")).toBe("pages/abc123/3/a/d");
    expect(buildR2Key("abc123", 3, "a/./../b")).toBe("pages/abc123/3/b");
  });

  it("never emits `..`, `.`, or empty segments in an accepted key's path", () => {
    const keys = [
      "a/../b",
      "a//b",
      "././x",
      "a/./b",
      "a/b/..",
      "a/b/../c/../d",
      "images/./../style.css",
      "a/%2e%2e/b",
    ].map((p) => buildR2Key("abc123", 3, p));
    for (const key of keys) {
      const suffix = key.slice("pages/abc123/3/".length);
      const segments = suffix.split("/");
      expect(segments.some((s) => s === ".." || s === "." || s === "")).toBe(false);
    }
  });
});

describe("validator: buildR2Key normalization invariants (property test)", () => {
  // Deterministic LCG — reproducible by construction, no flaky randomness.
  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  const SEGMENT_POOL = [
    "a",
    "b",
    "index.html",
    "images",
    "x.png",
    "..hidden",
    ".hidden",
    "...",
    "a..b",
    "%2e%2e",
    "..\\x",
    "café",
    "日本語",
    "style.css",
    ".",
    "..",
    "",
    "..\\",
  ];

  it("any accepted input yields pages/{validId}/{rev}/… with no `..` segment, is deterministic, and normalizes idempotently", () => {
    const rand = lcg(0x5eed_03_03); // fixed seed
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 10_000; i++) {
      const id = Array.from(
        { length: 1 + Math.floor(rand() * 10) },
        () => ID_CHARS[Math.floor(rand() * ID_CHARS.length)],
      ).join("");
      const rev = 1 + Math.floor(rand() * 10_000);
      const nSeg = 1 + Math.floor(rand() * 8);
      const segments: string[] = [];
      for (let s = 0; s < nSeg; s++) {
        segments.push(SEGMENT_POOL[Math.floor(rand() * SEGMENT_POOL.length)]);
      }
      // Occasionally make the path absolute to exercise that gate.
      let path = segments.join("/");
      if (rand() < 0.02) path = "/" + path;

      let key: string;
      try {
        key = buildR2Key(id, rev, path);
      } catch (e) {
        // Rejections must be the typed 400, never a raw error.
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe("path_traversal");
        expect((e as AppError).status).toBe(400);
        rejected++;
        continue;
      }
      accepted++;
      // Invariant 1: key stays inside pages/{id}/{rev}/ — id and rev interpolate
      // exactly (ids drawn from the closed validateId charset, ADR 0010).
      expect(key).toMatch(new RegExp(`^pages/${id}/${rev}/`));
      // Invariant 2: the normalized suffix has no `..` / `.` / empty segments.
      const suffix = key.slice(`pages/${id}/${rev}/`.length);
      const segs = suffix.split("/");
      expect(segs.some((s) => s === ".." || s === "." || s === "")).toBe(false);
      // Invariant 3: deterministic — same input, same key.
      expect(buildR2Key(id, rev, path)).toBe(key);
      // Invariant 4: idempotent — the key's own path suffix is a fixed point
      // of normalization (a second build from the suffix yields the same key).
      expect(buildR2Key(id, rev, suffix)).toBe(key);
    }
    // Both gates must have been exercised meaningfully (deterministic seed:
    // measured ~86% accepted / ~14% rejected on the pool above).
    expect(accepted).toBeGreaterThan(5_000);
    expect(rejected).toBeGreaterThan(1_000);
  });
});

describe("validator: buildR2Key literalness & boundary contracts", () => {
  it("treats Unicode lookalikes of `/` and `.` as literal (no Unicode normalization)", () => {
    // Only ASCII exact `..` / `.` / `/` are special; fullwidth forms are data.
    expect(buildR2Key("abc123", 3, "ａ/．./b")).toBe("pages/abc123/3/ａ/．./b");
    expect(buildR2Key("abc123", 3, "．/x")).toBe("pages/abc123/3/．/x");
  });

  it("passes 64+-char segments through (no artificial length limit in the builder)", () => {
    // The builder imposes no length bound; R2's hard 1,024-byte key limit
    // (verified, R2 limits docs) is a write-side concern for S17, whose
    // validation is the front line (ADR 0012 d5).
    const longSegment = "seg-" + "x".repeat(300);
    expect(buildR2Key("abc123", 3, longSegment)).toBe(`pages/abc123/3/${longSegment}`);
  });

  it("passes control characters through literally (no sanitization here)", () => {
    expect(buildR2Key("abc123", 3, "a\nb\tc.png")).toBe("pages/abc123/3/a\nb\tc.png");
  });

  it("interpolates a rev at the top of the integer range exactly", () => {
    // 2^53-1 is a valid positive integer; the builder must not mangle it.
    expect(buildR2Key("abc123", Number.MAX_SAFE_INTEGER, "x.png")).toBe(
      `pages/abc123/${Number.MAX_SAFE_INTEGER}/x.png`,
    );
  });

  it("documented contract: pageId is not re-validated (validateId owns that)", () => {
    // ADR 0012 d4: ids from the closed validateId charset cannot traverse —
    // the charset has no `.` or `/`. The key stays inside the namespace for
    // every valid-charset id, including the 64-char bound.
    const id64 = "A".repeat(64);
    expect(buildR2Key(id64, 1, "x.png")).toBe(`pages/${id64}/1/x.png`);
    // And the boundary contract: unvalidated ids are the caller's
    // responsibility (S15/S17 must call validateId before buildR2Key).
    expect(validateId(id64)).toBe(true);
  });
});

describe("validator: nextRev boundary", () => {
  it("documents the safe-integer ceiling behavior", () => {
    // Guard is per AC (positive integer); the value beyond MAX_SAFE_INTEGER
    // loses integer precision in JS. Unreachable in practice (rev starts at 1
    // and increments per publish), but the behavior is pinned here so a future
    // change is deliberate. D1 stores rev as a 64-bit INTEGER, which
    // accommodates values past 2^53-1 — the precision loss is JS-side only.
    expect(nextRev(Number.MAX_SAFE_INTEGER)).toBe(9007199254740992);
    expect(Number.isSafeInteger(nextRev(Number.MAX_SAFE_INTEGER))).toBe(false);
  });
});

describe("validator: shouldBumpRev closed-union fail-fast surface", () => {
  it("throws unknown_action for an empty-string type", () => {
    expectAppError(() => shouldBumpRev({ type: "" } as never), "unknown_action", 500);
  });

  it("throws unknown_action for a different-case type (union is case-sensitive)", () => {
    expectAppError(() => shouldBumpRev({ type: "FILE-ADD" } as never), "unknown_action", 500);
    expectAppError(() => shouldBumpRev({ type: "Slug-Edit" } as never), "unknown_action", 500);
  });

  it("throws unknown_action for a Symbol type", () => {
    expectAppError(
      () => shouldBumpRev({ type: Symbol("file-add") } as never),
      "unknown_action",
      500,
    );
  });

  it("tolerates extra payload fields (union is structural, bare {type} today)", () => {
    expect(shouldBumpRev({ type: "file-add", path: "images/pic.png" } as never)).toBe(true);
    expect(shouldBumpRev({ type: "meta-edit", fields: ["title"] } as never)).toBe(false);
  });

  it("handles null-prototype objects with a valid type", () => {
    const action = Object.assign(Object.create(null), { type: "create" });
    expect(shouldBumpRev(action as never)).toBe(false);
  });
});
