/**
 * Page ids (spec §4, ADR 0002/0010).
 *
 * `generateId` uses Web Crypto (`crypto.getRandomValues`) — no nanoid
 * dependency (ADR 0002). Ids are fixed at 10 chars from a 64-char URL-safe
 * alphabet. The alphabet length divides 256 evenly (256 % 64 === 0), so the
 * plain modulo mapping is unbiased — no rejection sampling needed. Uniqueness
 * is by entropy: 64^10 ≈ 2^60, collision probability across 10k samples is
 * ~4e-11; the 10k-sample uniqueness test guards the implementation.
 *
 * `validateId` is a structural predicate: 1–64 URL-safe chars. It deliberately
 * does NOT re-check that an id was system-generated (8–10 chars) — the store's
 * primary key owns uniqueness, and the range is a sanity bound, not a
 * generation contract (ADR 0010). The charset (no `.`, no `/`, no `%`) is what
 * makes ids safe to interpolate into URL paths (`../` cannot be an id).
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const ID_LENGTH = 10;
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function generateId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return id;
}

export function validateId(id: string): boolean {
  return VALID_ID.test(id);
}
