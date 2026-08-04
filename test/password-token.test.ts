import { describe, expect, it } from "vitest";
import { base64UrlDecode } from "../src/password";
import {
  formatUnlockCookie,
  generateToken,
  hashToken,
  parseUnlockCookie,
} from "../src/password-token";

// S23-A AC 5–6 — unlock token generation/hashing and cookie
// format/parse (ADR 0041 decision 1, OQ-19 option c). Pure Web Crypto module.

// ---------------------------------------------------------------------------
// AC 5 — generateToken: 32 random bytes, unpadded base64url.
// ---------------------------------------------------------------------------

describe("generateToken (S23-A AC 5)", () => {
  it("returns 32 random bytes as unpadded base64url (43 chars)", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toContain("=");
  });

  it("decodes back to exactly 32 bytes", () => {
    expect(base64UrlDecode(generateToken())?.length).toBe(32);
  });

  it("produces unique tokens (randomness across samples)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateToken());
    }
    expect(seen.size).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// AC 5 — hashToken: lowercase hex SHA-256.
// ---------------------------------------------------------------------------

describe("hashToken (S23-A AC 5)", () => {
  it("returns a 64-char lowercase hex SHA-256 digest", async () => {
    await expect(hashToken(generateToken())).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the well-known SHA-256 vector for 'abc'", async () => {
    await expect(hashToken("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic for the same token", async () => {
    const token = generateToken();
    expect(await hashToken(token)).toBe(await hashToken(token));
  });

  it("differs for different tokens", async () => {
    const a = await hashToken("token-a");
    const b = await hashToken("token-b");
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// AC 6 — formatUnlockCookie / parseUnlockCookie: total, malformed == absent.
// ---------------------------------------------------------------------------

describe("formatUnlockCookie / parseUnlockCookie (S23-A AC 6)", () => {
  it("formats as {pageId}.{token}", () => {
    expect(formatUnlockCookie("abc123", "tok")).toBe("abc123.tok");
  });

  it("round-trips a generated token", () => {
    const pageId = "abc123";
    const token = generateToken();
    expect(parseUnlockCookie(formatUnlockCookie(pageId, token))).toEqual({ pageId, token });
  });

  it("accepts ids from the full URL-safe id charset", () => {
    const token = generateToken();
    const parsed = parseUnlockCookie(formatUnlockCookie("A-Z_09a", token));
    expect(parsed).toEqual({ pageId: "A-Z_09a", token });
  });

  it("keeps a valid 1-char id and a 64-char id at the policy bounds", () => {
    const token = generateToken();
    expect(parseUnlockCookie(formatUnlockCookie("a", token))?.pageId).toBe("a");
    expect(parseUnlockCookie(formatUnlockCookie("a".repeat(64), token))?.pageId).toBe(
      "a".repeat(64),
    );
  });

  it("rejects malformed values, never throwing (malformed == absent)", () => {
    const token = generateToken();
    const malformed = [
      "",
      "no-dot",
      ".token-only", // empty page id
      "abc123.", // empty token
      `abc123.${token}.extra`, // wrong segment count
      `a.b.${token}`, // dot inside the id part
      `ab$cd.${token}`, // characters outside the id charset
      `abc123.${token.slice(0, 10)}!!!`, // characters outside base64url
      `abc123.${token.slice(0, 10)}++`, // standard-base64 chars, not base64url
      `abc123.${token.slice(0, 10)}=`, // padding is not part of the format
      "abc123.too-short-token", // valid charset but decodes to 11 bytes, not 32
      `abc123.${"a".repeat(44)}`, // valid charset but 44 chars decode to 33 bytes, not 32
      `x${"x".repeat(64)}.${token}`, // id longer than 64 chars
    ];
    for (const value of malformed) {
      expect(() => parseUnlockCookie(value)).not.toThrow();
      expect(parseUnlockCookie(value)).toBeNull();
    }
  });

  it("rejects non-string inputs, never throwing", () => {
    expect(parseUnlockCookie(undefined as unknown as string)).toBeNull();
    expect(parseUnlockCookie(null as unknown as string)).toBeNull();
    expect(parseUnlockCookie(42 as unknown as string)).toBeNull();
  });
});
