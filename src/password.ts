/**
 * S23-A — Password primitives (ADR 0041 decisions 1–2, OQ-21).
 * Pure Web Crypto module — no bindings, no Node APIs.
 *
 * Storage format: `pbkdf2$<iter>$<salt-b64url>$<hash-b64url>` — self-describing,
 * so verification uses the stored salt and iteration count (hashes created at
 * any count — e.g. the previous 100k default — still verify; forward-compat is
 * tested). The default count is 10,000, the S23-A benchmark outcome (~4 ms ≈
 * 40% of the Free-plan 10 ms CPU budget; ADR 0041 decision 2 amendment); any
 * future change is an ADR amendment, never a silent tweak.
 *
 * The base64url helpers live here (encoding raw bytes is a crypto primitive)
 * and are shared with `password-token.ts`. Encoding is unpadded.
 */

export const PBKDF2_ITERATIONS = 10_000;
const MAX_STORED_ITERATIONS = 1_000_000; // absurdity cap — above this the stored string is malformed
const SALT_BYTES = 16;
const KEY_BITS = 256;
const KEY_BYTES = KEY_BITS / 8;
const MIN_PASSWORD_LENGTH = 5;
const MAX_PASSWORD_LENGTH = 256;
const STORED_PARTS = 4;

export type PasswordValidationCode = "not-a-string" | "too-short" | "too-long";

/**
 * Typed result of `validatePassword`. `not-set` covers empty/whitespace-only/
 * null/undefined — the "no password" state, valid for clearing (PATCH ""/null,
 * ADR 0041 decision 2). `valid` carries the trimmed value the caller should
 * hash. `invalid` carries a stable code plus an actionable message.
 */
export type PasswordValidationResult =
  | { status: "not-set" }
  | { status: "valid"; value: string }
  | { status: "invalid"; code: PasswordValidationCode; message: string };

/**
 * Validates a password against the OQ-21 rules: min 5 chars after trim,
 * max 256 chars (bounds the PBKDF2 input). Total — never throws.
 */
export function validatePassword(pw: unknown): PasswordValidationResult {
  if (typeof pw !== "string") {
    if (pw === null || pw === undefined) {
      return { status: "not-set" };
    }
    return {
      status: "invalid",
      code: "not-a-string",
      message: "Password must be a string.",
    };
  }
  const value = pw.trim();
  if (value === "") {
    return { status: "not-set" };
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    return {
      status: "invalid",
      code: "too-short",
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (value.length > MAX_PASSWORD_LENGTH) {
    return {
      status: "invalid",
      code: "too-long",
      message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  return { status: "valid", value };
}

/**
 * Encodes bytes as unpadded base64url (RFC 4648 §5).
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Decodes unpadded base64url back to bytes. Returns `null` (never throws) for
 * empty, non-base64url, or otherwise malformed input.
 */
export function base64UrlDecode(value: string): Uint8Array | null {
  if (value === "" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

async function importPasswordKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
}

/**
 * PBKDF2-HMAC-SHA256 with a fresh random 16-byte salt per call and the
 * default iteration count. Returns the self-describing storage format.
 *
 * Does NOT self-validate length rules — the caller runs `validatePassword`
 * first (call-site semantics, OQ-21); hashing any string is by contract.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  const key = await importPasswordKey(password);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    KEY_BITS,
  );
  const hash = new Uint8Array(derived);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${base64UrlEncode(salt)}$${base64UrlEncode(hash)}`;
}

/**
 * Verifies a password against a stored PBKDF2 string, deriving with the
 * stored salt and iteration count. Total: any malformed stored value (wrong
 * segment count, non-decimal/absurd iteration count, bad base64url, wrong
 * key length) returns `false` — never throws (ADR 0041 decision 2).
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== "string" || typeof stored !== "string") {
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== STORED_PARTS || parts[0] !== "pbkdf2") {
    return false;
  }
  if (!/^\d+$/.test(parts[1])) {
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_STORED_ITERATIONS) {
    return false;
  }
  const salt = base64UrlDecode(parts[2]);
  const expected = base64UrlDecode(parts[3]);
  if (salt === null || salt.length === 0 || expected === null || expected.length !== KEY_BYTES) {
    return false;
  }
  const key = await importPasswordKey(password);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BITS,
  );
  return constantTimeEqual(new Uint8Array(derived), expected);
}

/**
 * Constant-time byte-array equality: xor-accumulates over the longer input
 * with no early exit, and folds the length mismatch into the accumulator
 * (`a.length ^ b.length`) — a length mismatch is never a separate fast path.
 * Length-safe: never throws on any input.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const maxLength = a.length > b.length ? a.length : b.length;
  for (let i = 0; i < maxLength; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
