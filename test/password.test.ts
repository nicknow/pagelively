import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  hashPassword,
  PBKDF2_ITERATIONS,
  validatePassword,
  verifyPassword,
} from "../src/password";

// S23-A AC 1–4 — password validation, PBKDF2-HMAC-SHA256 hashing, verification,
// and constant-time comparison (ADR 0041 decisions 1–2, OQ-21). Pure Web
// Crypto module; every test runs in the plain workerd unit pool (AC 10).

// 16-byte salt + 32-byte hash, unpadded base64url: 22 and 43 chars.
const HASH_FORMAT = /^pbkdf2\$10000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------------------
// AC 1 — validatePassword: typed result, min 5 after trim, max 256, total.
// ---------------------------------------------------------------------------

describe("validatePassword (S23-A AC 1)", () => {
  it("accepts a password at the 5-char minimum after trim", () => {
    expect(validatePassword("abcde")).toEqual({ status: "valid", value: "abcde" });
  });

  it("accepts a password at the 256-char maximum", () => {
    const pw = "a".repeat(256);
    expect(validatePassword(pw)).toEqual({ status: "valid", value: pw });
  });

  it("trims surrounding whitespace before validating and returns the trimmed value", () => {
    expect(validatePassword("  abcde  ")).toEqual({ status: "valid", value: "abcde" });
    expect(validatePassword("\tabcde\n")).toEqual({ status: "valid", value: "abcde" });
  });

  it("rejects passwords shorter than 5 chars after trim with an actionable message", () => {
    expect(validatePassword("abcd")).toEqual({
      status: "invalid",
      code: "too-short",
      message: "Password must be at least 5 characters.",
    });
  });

  it("rejects passwords longer than 256 chars with an actionable message", () => {
    expect(validatePassword("a".repeat(257))).toEqual({
      status: "invalid",
      code: "too-long",
      message: "Password must be at most 256 characters.",
    });
  });

  it("treats empty, whitespace-only, null, and undefined as not-set (valid for clearing)", () => {
    expect(validatePassword("")).toEqual({ status: "not-set" });
    expect(validatePassword("   ")).toEqual({ status: "not-set" });
    expect(validatePassword(null)).toEqual({ status: "not-set" });
    expect(validatePassword(undefined)).toEqual({ status: "not-set" });
  });

  it("rejects non-string inputs as invalid with an actionable message", () => {
    for (const bad of [123, true, {}, [], 1.5, Symbol("x") as unknown]) {
      expect(validatePassword(bad)).toEqual({
        status: "invalid",
        code: "not-a-string",
        message: "Password must be a string.",
      });
    }
  });

  it("is total — never throws on any input", () => {
    for (const input of [
      "",
      "  ",
      "abcd",
      "a".repeat(1000),
      42,
      null,
      undefined,
      ["x"],
      { a: 1 },
    ]) {
      expect(() => validatePassword(input as never)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// AC 2 — hashPassword: PBKDF2-HMAC-SHA256, self-describing, random salt.
// ---------------------------------------------------------------------------

describe("hashPassword (S23-A AC 2)", () => {
  it("exports the default iteration count (10,000 — ADR 0041 decision 2 amendment)", () => {
    expect(PBKDF2_ITERATIONS).toBe(10_000);
  });

  it("returns the self-describing pbkdf2 format with the default iteration count", async () => {
    await expect(hashPassword("hunter2-secret")).resolves.toMatch(HASH_FORMAT);
  });

  it("uses a random 16-byte salt per call — two hashes of the same password differ", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("does not self-validate — hashing is the caller's job after validatePassword", async () => {
    // The min/max rules live in validatePassword (call-site semantics, OQ-21);
    // hashPassword accepts any string input.
    await expect(hashPassword("x")).resolves.toMatch(HASH_FORMAT);
  });
});

// ---------------------------------------------------------------------------
// AC 3 — verifyPassword: total, derives with stored salt+iterations, false
// on malformed stored strings, constant-time comparison.
// ---------------------------------------------------------------------------

describe("verifyPassword (S23-A AC 3)", () => {
  it("returns true for the correct password", async () => {
    const hash = await hashPassword("correct horse");
    await expect(verifyPassword("correct horse", hash)).resolves.toBe(true);
  });

  it("returns false for a wrong password", async () => {
    const hash = await hashPassword("correct horse");
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("derives with the stored salt and iteration count, not the module defaults", async () => {
    // Build a stored string manually with a fixed salt and a custom iteration
    // count; verifyPassword must use those exact parameters.
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("custom-iter-pw"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 12345 },
      key,
      256,
    );
    const stored = `pbkdf2$12345$${base64UrlEncode(salt)}$${base64UrlEncode(new Uint8Array(bits))}`;
    await expect(verifyPassword("custom-iter-pw", stored)).resolves.toBe(true);
    await expect(verifyPassword("nope", stored)).resolves.toBe(false);
  });

  it("forward-compat — a hash stored at 100,000 iterations (the old default) still verifies", async () => {
    // The default was lowered 100k → 10k (ADR 0041 amendment). The format is
    // self-describing, so existing hashes created at the old count must keep
    // verifying — verification derives with the count stored in the string,
    // never with the module default.
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("legacy-100k-pw"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
      key,
      256,
    );
    const stored = `pbkdf2$100000$${base64UrlEncode(salt)}$${base64UrlEncode(new Uint8Array(bits))}`;
    await expect(verifyPassword("legacy-100k-pw", stored)).resolves.toBe(true);
    await expect(verifyPassword("wrong-pw", stored)).resolves.toBe(false);
    // Sanity: freshly hashed passwords still verify at the new default.
    const fresh = await hashPassword("legacy-100k-pw");
    await expect(verifyPassword("legacy-100k-pw", fresh)).resolves.toBe(true);
    expect(fresh).toMatch(HASH_FORMAT);
  });

  it("returns false for malformed stored strings, never throwing", async () => {
    const salt16 = base64UrlEncode(new Uint8Array(16));
    const hash32 = base64UrlEncode(new Uint8Array(32));
    const malformed = [
      "",
      "garbage",
      "pbkdf2",
      "pbkdf2$100000$only-salt",
      "pbkdf2$100000$salt$hash$extra", // wrong segment count
      "bcrypt$100000$salt$hash", // wrong scheme
      "pbkdf2$abc$salt$hash", // non-numeric iterations
      "pbkdf2$-5$salt$hash", // negative iterations
      "pbkdf2$0$salt$hash", // zero iterations
      "pbkdf2$1000001$salt$hash", // above the 1_000_000 cap → false, never derives
      "pbkdf2$99999999999999999999$salt$hash", // not a safe integer
      "pbkdf2$1e5$salt$hash", // not plain decimal digits
      `pbkdf2$100000$!!!$${hash32}`, // bad base64url salt
      `pbkdf2$100000$${salt16}$!!!`, // bad base64url hash
      `pbkdf2$100000$${salt16}$${base64UrlEncode(new Uint8Array(16))}`, // 16-byte hash, not 32
      `pbkdf2$100000$${base64UrlEncode(new Uint8Array(0))}$${hash32}`, // empty salt
    ];
    for (const stored of malformed) {
      await expect(verifyPassword("any-pw", stored)).resolves.toBe(false);
    }
  });

  it("returns false for non-string inputs without throwing", async () => {
    await expect(verifyPassword("x", undefined as unknown as string)).resolves.toBe(false);
    await expect(verifyPassword("x", null as unknown as string)).resolves.toBe(false);
    await expect(verifyPassword(undefined as unknown as string, "pbkdf2$1000$a$b")).resolves.toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// AC 4 — constantTimeEqual: length-safe, xor-accumulate, no early exit.
// ---------------------------------------------------------------------------

describe("constantTimeEqual (S23-A AC 4)", () => {
  it("returns true for identical byte arrays", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array())).toBe(true);
    expect(constantTimeEqual(new Uint8Array([0]), new Uint8Array([0]))).toBe(true);
  });

  it("returns false for same-length arrays with differing bytes", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([0]), new Uint8Array([1]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([255]), new Uint8Array([0]))).toBe(false);
  });

  it("returns false for length-mismatched arrays without throwing", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array(), new Uint8Array([1]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array())).toBe(false);
  });

  it("returns false when the common prefix is equal but lengths differ (no early exit on length)", () => {
    // The length XOR must fold into the accumulator — a naive loop over the
    // shorter input would wrongly return true here.
    expect(constantTimeEqual(new Uint8Array([7, 7, 7]), new Uint8Array([7, 7, 7, 7]))).toBe(false);
  });

  it("is length-safe on empty input", () => {
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array([1]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Base64url helpers (shared with password-token) — AC 2/3 rely on them.
// ---------------------------------------------------------------------------

describe("base64UrlEncode / base64UrlDecode", () => {
  it("encodes unpadded base64url that decodes back to the same bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlDecode(encoded)).toEqual(bytes);
  });

  it("returns null for malformed base64url input, never throwing", () => {
    expect(base64UrlDecode("")).toBeNull();
    expect(base64UrlDecode("!!")).toBeNull();
    expect(base64UrlDecode("a+b")).toBeNull();
    expect(base64UrlDecode("a/b")).toBeNull();
    expect(base64UrlDecode("ab==")).toBeNull();
  });
});
