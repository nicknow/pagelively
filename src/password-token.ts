/**
 * S23-A — Unlock token & cookie primitives (ADR 0041 decision 1, OQ-19
 * option c). Pure Web Crypto module — no bindings, no Node APIs.
 *
 * Cookie format: `pl_unlock={pageId}.{token}` where `token` is 32 random
 * bytes, unpadded base64url. Only the hex SHA-256 of the token is ever stored
 * (`page_unlocks.token_hash`); the raw token is never stored or logged.
 *
 * `parseUnlockCookie` is total: malformed cookies are indistinguishable from
 * an absent cookie (return `null`, never throw) — an attacker can only ever
 * reach the "prompt again" path.
 */

import { base64UrlDecode, base64UrlEncode } from "./password";
import { validateId } from "./ids";

const TOKEN_BYTES = 32;
const TOKEN_B64URL_LENGTH = 43; // ceil(32 / 3) * 4 − 1, unpadded

/**
 * Returns 32 cryptographically random bytes as an unpadded base64url string.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Lowercase hex SHA-256 of the token — the only form ever persisted.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * `pl_unlock` cookie value: `{pageId}.{token}` (ADR 0041 decision 1).
 * Caller discipline: both arguments are validated upstream (S23-C checks the
 * token hash; the id was already resolved from a valid route).
 */
export function formatUnlockCookie(pageId: string, token: string): string {
  return `${pageId}.${token}`;
}

/**
 * Parses a `pl_unlock` cookie value into its parts. Returns `null` — never
 * throws — for wrong segment counts, empty segments, ids outside the id
 * charset, tokens outside base64url, or tokens that do not decode to exactly
 * 32 bytes (malformed == absent, ADR 0041).
 */
export function parseUnlockCookie(value: string): { pageId: string; token: string } | null {
  if (typeof value !== "string") {
    return null;
  }
  const dot = value.indexOf(".");
  if (dot <= 0) {
    return null;
  }
  const pageId = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (token === "" || token.includes(".")) {
    return null;
  }
  if (!validateId(pageId)) {
    return null;
  }
  if (token.length !== TOKEN_B64URL_LENGTH) {
    return null;
  }
  const decoded = base64UrlDecode(token);
  if (decoded === null || decoded.length !== TOKEN_BYTES) {
    return null;
  }
  return { pageId, token };
}
