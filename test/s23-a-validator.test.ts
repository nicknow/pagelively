import { describe, expect, it } from "vitest";
import { validateId } from "../src/ids";
import {
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEqual,
  hashPassword,
  validatePassword,
  verifyPassword,
} from "../src/password";
import { generateToken, hashToken, parseUnlockCookie } from "../src/password-token";
import { renderPasswordPrompt } from "../src/password-prompt";
import { classifyPath } from "../src/router";

// S23-A validator adversarial edge/regression probes (independent of the
// implementer's test files). Scratch: .work/validator/. These document actual
// behavior; assertions follow the ADR 0041/0042 contracts, not the
// implementer's wording.

// ---------------------------------------------------------------------------
// validatePassword — whitespace, boundary lengths, exotic inputs
// ---------------------------------------------------------------------------

describe("validator: validatePassword adversarial", () => {
  it("treats any whitespace-only string (spaces/tabs/newlines/mixed) as not-set", () => {
    for (const s of ["   ", "\t\t", "\n", "\r\n \t ", " \t \r \n "]) {
      expect(validatePassword(s)).toEqual({ status: "not-set" });
    }
  });

  it("4 chars plus a trailing space trims to 4 and is too-short", () => {
    expect(validatePassword("abcd ")).toEqual({
      status: "invalid",
      code: "too-short",
      message: "Password must be at least 5 characters.",
    });
  });

  it("5 chars with surrounding whitespace trims to a valid 5-char value", () => {
    expect(validatePassword(" abcde ")).toEqual({ status: "valid", value: "abcde" });
  });

  it("exactly 256 is valid and exactly 257 is too-long", () => {
    expect(validatePassword("a".repeat(256))).toEqual({ status: "valid", value: "a".repeat(256) });
    expect(validatePassword("a".repeat(257)).status).toBe("invalid");
  });

  it('the single char "0" is too-short (not some falsy special case)', () => {
    expect(validatePassword("0")).toEqual({
      status: "invalid",
      code: "too-short",
      message: "Password must be at least 5 characters.",
    });
  });

  it("String objects are objects, not primitives → not-a-string (informational)", () => {
    // Documents behavior: new String(...) has typeof "object", so it lands in
    // the not-a-string branch even when empty. Callers must pass primitives.
    expect(validatePassword(new String("abcde"))).toEqual({
      status: "invalid",
      code: "not-a-string",
      message: "Password must be a string.",
    });
    expect(validatePassword(new String(""))).toEqual({
      status: "invalid",
      code: "not-a-string",
      message: "Password must be a string.",
    });
  });

  it("surrogate pairs count as 2 length units (UTF-16 semantics, informational)", () => {
    // "😀" is a surrogate pair: .length === 2. So 3 emoji = 6 units → valid,
    // 2 emoji = 4 units → too-short. Documented, not a defect: JS .length
    // semantics are the codebase norm and the PBKDF2 input bound is not
    // byte-exact for astral chars (max 256 units ≈ ≤1024 UTF-8 bytes).
    expect(validatePassword("😀😀😀")).toEqual({ status: "valid", value: "😀😀😀" });
    expect(validatePassword("😀😀")).toEqual({
      status: "invalid",
      code: "too-short",
      message: "Password must be at least 5 characters.",
    });
    expect(validatePassword("a".repeat(255) + "😀")).toEqual({
      status: "invalid",
      code: "too-long",
      message: "Password must be at most 256 characters.",
    });
  });

  it("embedded NUL is an ordinary character — no crash, value preserved", () => {
    expect(validatePassword("a\u0000bcde")).toEqual({ status: "valid", value: "a\u0000bcde" });
    const v = validatePassword("a\u0000bcde");
    expect(v.status === "valid" && v.value.includes("\u0000")).toBe(true);
  });

  it("never throws on exotic inputs: NaN, Infinity, functions, bigint, arrays, objects", () => {
    const exotic: unknown[] = [
      NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      () => "x",
      /re/,
      new Date(),
      new Uint8Array(4),
      [""],
      [[]],
      {},
      { valueOf: () => "abcde" },
    ];
    for (const input of exotic) {
      expect(() => validatePassword(input)).not.toThrow();
      const r = validatePassword(input);
      expect(r.status === "invalid" || r.status === "not-set").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// verifyPassword — stored-string adversarial probes
// ---------------------------------------------------------------------------

describe("validator: verifyPassword adversarial", () => {
  async function storedWith(iterStr: string, salt: Uint8Array, hash: Uint8Array): Promise<string> {
    return `pbkdf2$${iterStr}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
  }

  it("leading-zero iteration counts are accepted and derive with that value (lenient, documented)", async () => {
    // ADR 0042 decision 2: plain decimal digits /^\d+$/; leading zeros pass
    // the regex and Number() normalizes them. Behavior documented here.
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("pw"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: 10_000 },
      key,
      256,
    );
    const stored = await storedWith("00010000", salt, new Uint8Array(bits));
    expect(await verifyPassword("pw", stored)).toBe(true);
  });

  it("empty salt segment and empty hash segment are false, never throw", async () => {
    const salt16 = base64UrlEncode(new Uint8Array(16));
    const hash32 = base64UrlEncode(new Uint8Array(32));
    // "pbkdf2$10000$$hash32" → empty salt
    expect(await verifyPassword("pw", `pbkdf2$10000$${hash32}`)).toBe(false);
    // "pbkdf2$10000$salt16$" → empty hash
    expect(await verifyPassword("pw", `pbkdf2$10000${salt16}$`)).toBe(false);
    // both empty
    expect(await verifyPassword("pw", "pbkdf2$10000$$")).toBe(false);
    // split is exact: a trailing $ after the hash makes 5 parts
    expect(await verifyPassword("pw", `pbkdf2$10000$${salt16}$${hash32}$`)).toBe(false);
  });

  it("rejects scheme case variants and whitespace/sign in the iteration count", async () => {
    const salt16 = base64UrlEncode(new Uint8Array(16));
    const hash32 = base64UrlEncode(new Uint8Array(32));
    for (const stored of [
      `PBKDF2$10000$${salt16}$${hash32}`, // uppercase scheme
      `pbkdf2$+10000$${salt16}$${hash32}`, // plus sign
      `pbkdf2$ 10000$${salt16}$${hash32}`, // leading space
      `pbkdf2$10000 $$${salt16}$${hash32}`, // space before separator
      `pbkdf2$1e5$${salt16}$${hash32}`, // scientific (regression)
      `pbkdf2$0$${salt16}$${hash32}`, // zero (regression)
      `pbkdf2$1000001$${salt16}$${hash32}`, // over the cap (regression)
    ]) {
      expect(await verifyPassword("pw", stored)).toBe(false);
    }
  });

  it("verifies passwords that contain $ and dots (only the stored string is split)", async () => {
    const weird = "a$b$c$d.e_f-g";
    const stored = await hashPassword(weird);
    expect(await verifyPassword(weird, stored)).toBe(true);
    expect(await verifyPassword("a$b$c", stored)).toBe(false);
  });

  it("treats a String object stored value as not-a-string → false", async () => {
    const hash = await hashPassword("pw");
    expect(await verifyPassword("pw", new String(hash) as unknown as string)).toBe(false);
  });

  it("128-bit hash (16 bytes) is malformed → false (regression)", async () => {
    const salt16 = base64UrlEncode(new Uint8Array(16));
    const hash16 = base64UrlEncode(new Uint8Array(16));
    expect(await verifyPassword("pw", `pbkdf2$10000$${salt16}$${hash16}`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// constantTimeEqual — empty/len/prefix adversarial
// ---------------------------------------------------------------------------

describe("validator: constantTimeEqual adversarial", () => {
  it("empty vs empty is true; one-empty cases are false without throwing", () => {
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array([0]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([0]), new Uint8Array(0))).toBe(false);
  });

  it("longer array whose prefix equals the shorter is still false (no early exit)", () => {
    expect(constantTimeEqual(new Uint8Array([9, 9, 9]), new Uint8Array([9, 9, 9, 9]))).toBe(false);
    expect(constantTimeEqual(new Uint8Array([9, 9, 9, 9]), new Uint8Array([9, 9, 9]))).toBe(false);
  });

  it("matches a naive equality oracle over 200 random arrays", () => {
    for (let i = 0; i < 200; i++) {
      const len = Math.floor(Math.random() * 16);
      const a = crypto.getRandomValues(new Uint8Array(len));
      const b = new Uint8Array(a);
      expect(constantTimeEqual(a, b)).toBe(true);
      if (len > 0) {
        const c = new Uint8Array(a);
        c[0] = (c[0] + 1) % 256;
        expect(constantTimeEqual(a, c)).toBe(false);
      }
      const d = new Uint8Array(len + 1);
      d.set(a);
      expect(constantTimeEqual(a, d)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// parseUnlockCookie — charset/format adversarial + id-validator agreement
// ---------------------------------------------------------------------------

describe("validator: parseUnlockCookie adversarial", () => {
  it("rejects tokens containing =, +, or / (invalid base64url), never throwing", () => {
    const token = generateToken();
    for (const bad of [token.slice(0, 42) + "+", token.slice(0, 42) + "/", token + "="]) {
      expect(() => parseUnlockCookie(`abc123.${bad}`)).not.toThrow();
      expect(parseUnlockCookie(`abc123.${bad}`)).toBeNull();
    }
  });

  it("agrees with validateId on the id charset — uppercase and underscore are legal ids", () => {
    for (const id of ["ABC", "A-Z_09a", "a_b-C", "UPPERCASE_ID_1"]) {
      expect(validateId(id)).toBe(true);
      const token = generateToken();
      expect(parseUnlockCookie(`${id}.${token}`)).toEqual({ pageId: id, token });
    }
  });

  it("rejects ids outside the charset that validateId also rejects (no parser drift)", () => {
    const token = generateToken();
    for (const id of ["a.b", "a b", "a%b", "a/b", "a:b", "a#b"]) {
      expect(validateId(id)).toBe(false);
      expect(parseUnlockCookie(`${id}.${token}`)).toBeNull();
    }
  });

  it("rejects a 42-char token (valid base64url but decodes to 31 bytes)", () => {
    const token = generateToken().slice(0, 42);
    expect(base64UrlDecode(token)?.length).toBe(31);
    expect(parseUnlockCookie(`abc123.${token}`)).toBeNull();
  });

  it("rejects an id of 65 chars and a 44-char token (regression)", () => {
    const token = generateToken();
    expect(parseUnlockCookie(`${"x".repeat(65)}.${token}`)).toBeNull();
    expect(parseUnlockCookie(`abc123.${token}aa`)).toBeNull();
  });

  it("round-trips the full cookie contract and keeps id case exactly", () => {
    const token = generateToken();
    const value = `MiXeD_CaSe-Id.${token}`;
    const parsed = parseUnlockCookie(value);
    expect(parsed).not.toBeNull();
    expect(parsed!.pageId).toBe("MiXeD_CaSe-Id");
    expect(parsed!.token).toBe(token);
  });
});

// ---------------------------------------------------------------------------
// classifyPath — unlock/asset adversarial
// ---------------------------------------------------------------------------

describe("validator: classifyPath unlock/asset adversarial", () => {
  it("unlock: trailing slash forms and multi-slash all classify; empty internal segments don't", () => {
    expect(classifyPath("/p/abc/unlock")).toEqual({ type: "unlock", id: "abc" });
    expect(classifyPath("/p/abc/unlock/")).toEqual({ type: "unlock", id: "abc" });
    expect(classifyPath("/p/abc/unlock//")).toEqual({ type: "unlock", id: "abc" });
    expect(classifyPath("/p/abc/unlock///")).toEqual({ type: "unlock", id: "abc" });
    expect(classifyPath("/p//unlock")).toEqual({ type: "unknown" });
    expect(classifyPath("/p//unlock/")).toEqual({ type: "unknown" });
  });

  it("unlock: uppercase prefix and literal, id preserved exactly", () => {
    expect(classifyPath("/P/ABC/UNLOCK")).toEqual({ type: "unlock", id: "ABC" });
    expect(classifyPath("/P/a_b-1/UnLoCk/")).toEqual({ type: "unlock", id: "a_b-1" });
  });

  it("unlock: deeper and sibling paths stay unknown", () => {
    expect(classifyPath("/p/abc/unlock/x")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/abc/unlock/..")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/abc/unlock%20x")).toEqual({ type: "unknown" });
    expect(classifyPath("/p/abc/unlockx")).toEqual({ type: "unknown" });
  });

  it("asset: no path segment (rev only) is unknown; multi-segment paths are joined raw", () => {
    expect(classifyPath("/assets/pages/abc/1")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages/abc/1/")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages/abc/1/x/")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "x",
    });
    expect(classifyPath("/assets/pages/abc/1/x/y/z")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "x/y/z",
    });
  });

  it("asset: trailing dots and dot-dot segments stay raw for the handler to reject", () => {
    // Routing only splits; S23-C's shared path rules 400 decoded traversal.
    expect(classifyPath("/assets/pages/abc/1/x/..")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "x/..",
    });
    expect(classifyPath("/assets/pages/abc/1/../x")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "../x",
    });
  });

  it("asset: case-insensitive prefix and literal", () => {
    expect(classifyPath("/Assets/PAGES/abc/1/x")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "x",
    });
    expect(classifyPath("/ASSETS/pages/abc/1/x")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "x",
    });
  });

  it("encoded slashes anywhere → unknown, including traversal attempts in the path", () => {
    expect(classifyPath("/p/a%2Fb/unlock")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages/abc/1/..%2F..%2Fx")).toEqual({ type: "unknown" });
    expect(classifyPath("/assets/pages/abc/1/a%2fb")).toEqual({ type: "unknown" });
  });

  it("encoded dot-dot is NOT an encoded slash — passed through raw for the handler to reject", () => {
    // The router's only %-rule is encoded slashes (%2F/%2f) → unknown (ADR 0041
    // decision 6). Encoded traversal (%2E%2E) is rejected later by the S23-C
    // shared path rules on the DECODED path (ADR 0041 decision 8: `..` → 400).
    expect(classifyPath("/assets/pages/abc/1/%2E%2E/x")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "%2E%2E/x",
    });
    expect(classifyPath("/assets/pages/abc/1/a%2Eb")).toEqual({
      type: "asset",
      id: "abc",
      rev: "1",
      path: "a%2Eb",
    });
  });

  it("never throws on adversarial unlock/asset paths (total)", () => {
    const paths = [
      "/p/%2F/unlock",
      "/p/abc/unlock/%2F",
      "/assets/pages/",
      "/assets/pages///",
      "/assets//pages/abc/1/x",
      "/assets/pages/abc/1/x//",
      "/assets/pages/%/1/x",
      "/assets/pages/abc/%/x",
      "/p/abc/unlock/../..",
    ];
    for (const p of paths) {
      expect(() => classifyPath(p)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// renderPasswordPrompt — XSS / attribute-breakout adversarial
// ---------------------------------------------------------------------------

describe("validator: renderPasswordPrompt adversarial", () => {
  it("escapes an error payload containing HTML/JS", () => {
    const html = renderPasswordPrompt({
      siteName: "Acme",
      action: "/p/abc/unlock",
      error: "<img src=x onerror=alert(1)><script>alert(1)</script>",
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes an error containing quotes, brackets, and URL chars", () => {
    const html = renderPasswordPrompt({
      siteName: "Acme",
      action: "/p/abc/unlock",
      error: `"><script>alert(1)</script> https://evil.example/?a=1&b=2'x`,
    });
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp;b=2&#39;x");
    // no raw breakout sequence anywhere
    expect(html).not.toContain('"><script>');
    expect(html).not.toContain("<script>");
  });

  it("escapes a site name that would otherwise close </title> or inject markup", () => {
    const html = renderPasswordPrompt({
      siteName: "</title><script>alert(1)</script>",
      action: "/p/abc/unlock",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    // The only literal </title> is the document's own legitimate closing tag.
    expect(html.match(/<\/title>/g)?.length).toBe(1);
    expect(html).toMatch(/<title>Password required/);
  });

  it("escapes a site name with double quotes and ampersands", () => {
    const html = renderPasswordPrompt({
      siteName: 'Bob "The & Builder"',
      action: "/p/abc/unlock",
    });
    expect(html).toContain("Bob &quot;The &amp; Builder&quot;");
    expect(html).not.toContain('Bob "The');
  });

  it("escapes an action attribute to prevent attribute breakout", () => {
    const html = renderPasswordPrompt({
      siteName: "Acme",
      action: '/p/abc/unlock" onmouseover="alert(1)',
    });
    expect(html).toContain('action="/p/abc/unlock&quot; onmouseover=&quot;alert(1)"');
    expect(html).not.toMatch(/action="[^"]*"[^>]* onmouseover=/);
  });

  it("emits exactly one form and one password input even with adversarial options", () => {
    const html = renderPasswordPrompt({
      siteName: "<svg onload=alert(1)>",
      action: '/x" y="z',
      error: "<b>x</b>",
    });
    expect(html.match(/<form\b/g)?.length).toBe(1);
    // The CSS rule `input[type="password"]` also contains `type="password"`,
    // so scope the match to the actual <input> element.
    expect(html.match(/<input[^>]*\btype="password"/g)?.length).toBe(1);
    expect(html).not.toContain("<svg");
  });

  it("error text appears at most once, escaped, inside the role=alert paragraph", () => {
    const html = renderPasswordPrompt({
      siteName: "Acme",
      action: "/p/abc/unlock",
      error: "Too short & silly",
    });
    const occurrences = html.split("Too short &amp; silly").length - 1;
    expect(occurrences).toBe(1);
    expect(html).toContain('<p class="error" role="alert">Too short &amp; silly</p>');
  });
});

// ---------------------------------------------------------------------------
// hashToken — extra known vector
// ---------------------------------------------------------------------------

describe("validator: hashToken extra vectors", () => {
  it("matches SHA-256 of the empty string (64 lowercase hex chars)", async () => {
    await expect(hashToken("")).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    await expect(hashToken("")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});
