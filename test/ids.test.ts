import { describe, expect, it } from "vitest";
import { generateId, validateId } from "../src/ids";

// S01 AC 1 & 2 — id generation and validation (spec §4, ADR 0002/0010).

describe("generateId", () => {
  const URL_SAFE = /^[A-Za-z0-9_-]+$/;

  it("returns ids of exactly 10 URL-safe chars (§4, ADR 0002)", () => {
    for (let i = 0; i < 200; i++) {
      const id = generateId();
      expect(id.length).toBe(10);
      expect(URL_SAFE.test(id)).toBe(true);
    }
  });

  it("is unique across 10k samples (uniqueness by entropy, ADR 0002)", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => generateId()));
    expect(ids.size).toBe(10_000);
  });
});

describe("validateId", () => {
  it("accepts generated ids", () => {
    for (let i = 0; i < 50; i++) {
      expect(validateId(generateId())).toBe(true);
    }
  });

  it("rejects empty ids", () => {
    expect(validateId("")).toBe(false);
  });

  it("rejects ids longer than 64 chars and accepts exactly 64 (policy: 1–64, ADR 0010)", () => {
    expect(validateId("a".repeat(65))).toBe(false);
    expect(validateId("a".repeat(64))).toBe(true);
  });

  it("accepts 1-char ids at the lower bound of the length policy", () => {
    expect(validateId("a")).toBe(true);
    expect(validateId("_")).toBe(true);
    expect(validateId("-")).toBe(true);
  });

  it("rejects non-URL-safe characters", () => {
    for (const bad of [
      "abc$",
      "abc def",
      "abc/def",
      "a.b",
      "café",
      "a%2Fb",
      "a+b",
      "a?b",
      "a#b",
      "a&b",
      "a\nb",
      "😀",
    ]) {
      expect(validateId(bad)).toBe(false);
    }
  });

  it("accepts every character class of the URL-safe alphabet", () => {
    expect(validateId("A_Z-09a")).toBe(true); // upper, _, dash, digits, lower
  });

  it("never throws on malformed input", () => {
    expect(() => validateId("")).not.toThrow();
    expect(() => validateId("!!!")).not.toThrow();
    expect(() => validateId("x".repeat(1000))).not.toThrow();
  });
});

// --- validator additions (edge/regression, S01) ---

describe("validateId — validator edge cases", () => {
  it("rejects control characters and line terminators at any position", () => {
    // JS `$` without /m is absolute end-of-input, so trailing line
    // terminators must NOT pass the structural check.
    expect(validateId("abc\n")).toBe(false);
    expect(validateId("abc\r")).toBe(false);
    expect(validateId("abc\r\n")).toBe(false);
    expect(validateId("abc\t")).toBe(false);
    expect(validateId("\n")).toBe(false);
  });

  it("rejects a 64-char body plus a line terminator (length escape via $)", () => {
    expect(validateId("a".repeat(64) + "\n")).toBe(false);
  });

  it("rejects ids made only of reserved-route characters (they are not URL-safe by content)", () => {
    // "." and "/" can never appear in an id — the `../` traversal property.
    expect(validateId(".")).toBe(false);
    expect(validateId("..")).toBe(false);
    expect(validateId("a.b")).toBe(false);
    expect(validateId("a/b")).toBe(false);
  });

  it("accepts ids that mix every alphabet class at the 10-char generation length", () => {
    expect(validateId("A-B_C9xYz")).toBe(true);
    expect(validateId("-".repeat(10))).toBe(true);
    expect(validateId("_".repeat(10))).toBe(true);
    expect(validateId("1".repeat(10))).toBe(true);
  });
});
