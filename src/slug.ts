/**
 * Slug generation and validation (spec §4/§5, ADR 0007/0010). Pure: failures
 * are returned as typed results, not thrown — the API layer (S17) maps them
 * to a 400 response later.
 *
 * Generation rules (ADR 0007 decision 1):
 * 1. Filename extension stripped first: a trailing `.` + 1+ ASCII letters is
 *    an extension (`.md`, `.html`, `.png`, …). Digit-suffixed titles such as
 *    "Chapter 1.5" are left intact — ".5" is not an extension.
 * 2. Lowercase.
 * 3. The output alphabet is [a-z0-9_-]: `_` is a first-class slug character
 *    (the §5.1 `_`-reservation only makes sense if slugs can bear `_`; ADR
 *    0007's "`_pages` is reserved" example presumes it). Runs of any OTHER
 *    character collapse to a single `-`.
 * 4. Dash runs canonicalize to a single `-` (`-` is the canonical separator),
 *    and leading/trailing `-` are trimmed. Edge underscores are NOT trimmed —
 *    the AC trims only dashes; the reserved check (below) rejects `_`-prefixed
 *    slugs.
 * 5. An empty result (e.g. a fully non-Latin title) is a typed failure:
 *    AppError with code `invalid_slug`, status 400 (architecture 05 taxonomy).
 *
 * Validation rules (S02, ADR 0007 decision 2, OQ-02) — `validateSlug` is the
 * API-boundary predicate: user-supplied slugs must pass it before the create/
 * edit API stores them (S17/S18). It never throws. Rejection order:
 * empty → >64 chars → non-lowercase → reserved → charset. Reserved runs
 * before charset so list entries containing `.` (`favicon.ico`, `robots.txt`)
 * report the reserved reason, while decorations of reserved names (`admin.`,
 * `favicon.ico2`, `p/p`) fall through to the charset rule — proving the
 * reserved comparison is exact on the whole segment. The slug namespace is
 * separate from the id namespace (§4, ADR 0007 decision 4): a slug equal to
 * another page's id is NOT an error here — per-namespace uniqueness is the
 * store's job (S10).
 */

import { AppError } from "./errors";
import { isReservedName, RESERVED_NAMES } from "./reserved";

// Re-export for S02 (slug validation) so the reserved list stays single-source.
export { isReservedName, RESERVED_NAMES };

export type SlugifyResult = { ok: true; slug: string } | { ok: false; error: AppError };
export type SlugValidationResult = { ok: true } | { ok: false; error: AppError };

const MAX_SLUG_LENGTH = 64; // consistent with the validateId bound (ADR 0010)
const SLUG_CHARSET = /^[a-z0-9_-]+$/; // ADR 0007 decision 1 alphabet

/** Strips a trailing filename extension: `.` followed by 1+ ASCII letters. */
function stripExtension(name: string): string {
  return name.replace(/\.([a-zA-Z]+)$/, "");
}

/**
 * The shared collapse chain (ADR 0007 decision 1 steps 2-4): lowercase, collapse
 * runs of non-alphabet characters to a single `-`, canonicalize dash runs, and
 * trim edge dashes. Used by both `slugify` (after extension stripping) and
 * `cleanSlug` (which never strips extensions).
 */
function normalizeSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function slugify(input: string): SlugifyResult {
  const slug = normalizeSegment(stripExtension(input));

  if (slug === "") {
    return {
      ok: false,
      error: new AppError("invalid_slug", 400, "Name contains no characters that can form a slug."),
    };
  }
  return { ok: true, slug };
}

function invalidSlug(message: string): { ok: false; error: AppError } {
  return { ok: false, error: new AppError("invalid_slug", 400, message) };
}

/** Reserved-name rejection message (ADR 0007 decision 2), shared by the
 * `_`-prefix rule and the exact whole-segment list. The list lookup and the
 * echoed name are lowercased because `isReservedName` is case-insensitive
 * (raw pre-checks in `cleanSlug` run before normalization). */
function reservedNameMessage(name: string): string {
  const lower = name.toLowerCase();
  return RESERVED_NAMES.has(lower)
    ? `"${lower}" is a reserved name and cannot be used as a slug.`
    : "Slugs starting with `_` are reserved for internal names.";
}

/** API-boundary validation for user-supplied slugs (S02). Pure; never throws. */
export function validateSlug(slug: string): SlugValidationResult {
  if (slug.length === 0) {
    return invalidSlug("Slug cannot be empty.");
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    return invalidSlug(`Slug must be at most ${MAX_SLUG_LENGTH} characters.`);
  }
  if (slug !== slug.toLowerCase()) {
    return invalidSlug("Slug must be lowercase.");
  }
  if (isReservedName(slug)) {
    // One predicate, two reserved rules (ADR 0007 decision 2): the exact
    // whole-segment list and the `_` prefix. The check below only refines the
    // user-facing message — the list itself stays single-source in reserved.ts.
    return invalidSlug(reservedNameMessage(slug));
  }
  if (!SLUG_CHARSET.test(slug)) {
    return invalidSlug("Slug may only contain lowercase letters, digits, `-`, and `_`.");
  }
  return { ok: true };
}

/**
 * Clean a user-entered slug before validation (OQ-15, T1, ADR 0036). Pure;
 * never throws. The create and edit APIs run this on user-supplied slugs so
 * stored slugs are canonical and the boundary rejects reserved names with
 * actionable messages.
 *
 * Pipeline:
 * 1. Trim surrounding whitespace; empty/whitespace-only input fails with an
 *    actionable message (the API layer treats it as "not provided" on create).
 * 2. Reserved pre-check on the raw input: exact reserved names (`favicon.ico`,
 *    `robots.txt`, …) are rejected INTACT — before dot mangling could rename
 *    them — and the `_` prefix rule applies here too.
 * 3. Same collapse chain as `slugify` (lowercase, junk runs → `-`, dash
 *    canonicalization, edge-dash trim), but WITHOUT extension stripping:
 *    "my.md" → "my-md", never "my".
 * 4. A non-empty input that cleans to nothing is a typed failure.
 * 5. Truncate to the 64-char bound; a cut that lands on `-` strips the
 *    trailing dash so the result stays canonical.
 * 6. Reserved re-check on the cleaned result (" Admin! " → reserved "admin").
 * 7. `validateSlug` as a final safety net (cannot fail after 3-6).
 */
export function cleanSlug(input: string): SlugifyResult {
  const trimmed = input.trim();

  if (trimmed === "") {
    return invalidSlug("Slug cannot be empty.");
  }

  if (isReservedName(trimmed)) {
    return invalidSlug(reservedNameMessage(trimmed));
  }

  let slug = normalizeSegment(trimmed);

  if (slug === "") {
    return invalidSlug("Name contains no characters that can form a slug.");
  }

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
  }

  if (isReservedName(slug)) {
    return invalidSlug(reservedNameMessage(slug));
  }

  const validation = validateSlug(slug);
  /* istanbul ignore next -- reason: validateSlug cannot fail after cleanSlug steps 3-5 (lowercase, charset, truncation, reserved re-check) */
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  return { ok: true, slug };
}
