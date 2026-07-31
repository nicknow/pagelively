/**
 * Slug generation (spec §4, ADR 0007/0010). Pure: the empty-result failure is
 * returned as a typed result, not thrown — the API layer (S17) maps it to a
 * 400 response later.
 *
 * Rules (ADR 0007 decision 1):
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
 *    the AC trims only dashes; S02's reserved check rejects `_`-prefixed
 *    slugs.
 * 5. An empty result (e.g. a fully non-Latin title) is a typed failure:
 *    AppError with code `invalid_slug`, status 400 (architecture 05 taxonomy).
 */

import { AppError } from "./errors";
import { isReservedName, RESERVED_NAMES } from "./reserved";

// Re-export for S02 (slug validation) so the reserved list stays single-source.
export { isReservedName, RESERVED_NAMES };

export type SlugifyResult = { ok: true; slug: string } | { ok: false; error: AppError };

/** Strips a trailing filename extension: `.` followed by 1+ ASCII letters. */
function stripExtension(name: string): string {
  return name.replace(/\.([a-zA-Z]+)$/, "");
}

export function slugify(input: string): SlugifyResult {
  const slug = stripExtension(input)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-") // runs of junk → single "-"
    .replace(/-+/g, "-") // canonicalize dash runs
    .replace(/^-+|-+$/g, ""); // trim edge dashes

  if (slug === "") {
    return {
      ok: false,
      error: new AppError("invalid_slug", 400, "Name contains no characters that can form a slug."),
    };
  }
  return { ok: true, slug };
}
