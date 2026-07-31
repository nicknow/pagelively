# 0018: S09 — Home-mode behavior

- Status: accepted
- Date: 2026-07-31

## Context

The spec §11 says the root path (`GET /`) is configurable via `HOME_MODE`:

- `page` → serve a designated page by slug (`HOME_PAGE_SLUG`).
- `404` (default) → return the not-found page.

Open question OQ-08 asked whether `HOME_MODE=page` should be implemented as a
301 redirect to `/{slug}/` or as direct serve at `/`. The spec reads "serve a
designated page" literally, and the human-approved Phase 2 decision chose direct
serve. This slice (S09) therefore records the concrete pure decision function
that S12 will consume.

## Decision

1. **Direct serve at `/`** (spec-literal, OQ-08): S09 returns a `{ type: "page",
slug: string }` decision. S12 treats that decision as a synthetic slug route
   and serves the same entry HTML at `/` that it would serve at `/{slug}/`.
   There is no redirect, no `Location` header, and no status change.

2. **Pure, bindingless resolution** in `src/home.ts`: `resolveHome(homeMode,
homePageSlug)` is a total function over `string | null | undefined` inputs.
   It normalizes `homeMode` by trimming whitespace and lowercasing, then
   accepts only the exact value `"page"`. All other values (including empty,
   null, undefined, whitespace-only, `"404"`, or garbage) result in
   `{ type: "404" }`.

3. **Slug validation is delegated to S02's `validateSlug`**: `homePageSlug` is
   passed through unchanged. If it is missing, empty, or invalid (reserved word,
   wrong charset, too long, uppercase, etc.), the function returns
   `{ type: "404" }`. The specific `AppError` message from `validateSlug` is
   deliberately not exposed to the caller or to the user.

4. **Missing page at serve time is S12's concern**: S09 does not query D1. If
   the resolved slug does not exist when S12 serves the request, S12 produces a
   `clean404Response` (S08) exactly as it would for an unknown slug.

## Consequences

- **No redirect loop risk**: because `/` never returns a 301, a valid home mode
  cannot interact with trailing-slash logic to create a loop.
- **Uniform 404 handling**: a bad mode or invalid slug is indistinguishable from
  a missing page at the response level; there is no information leakage about
  reserved words or configuration mistakes.
- **S12 treats home as a synthetic slug route**: the entry-serve pipeline can
  reuse the same slug-resolution, base-injection, and cache-header logic for
  `/` and `/{slug}/`.
- **Home-mode semantics stay minimal**: future home behaviors (e.g. a public
  listing at `/`) are explicit new modes or new slices, not hidden fallbacks.
- **Config normalization is duplicated defensively**: `config.ts` (S12) will
  also trim/lowercase `HOME_MODE`; `home.ts` is defensive so it remains testable
  and correct even if called with raw env values.

## Cross-references

- Spec: §11 (public serving behavior), §12 (configuration vars).
- ADRs: 0007 (slugs/reserved words), 0011 (S02 `validateSlug`), 0017 (S08 clean
  404), 0006/0016 (cache headers for entry routes).
- Code: `src/home.ts`, `src/slug.ts`, `src/redirects.ts`, `src/router.ts`.
- Roadmap: S09; depends on S01, S02, S08.
