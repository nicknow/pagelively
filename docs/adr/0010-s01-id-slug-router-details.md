# 0010: S01 implementation details — id generation, slugify, route classification

- Status: accepted
- Date: 2026-07-31

## Context

Slice S01 ("Slug & id resolution primitives") implements `generateId`/`validateId`
(`src/ids.ts`), `slugify` (`src/slug.ts`), the reserved-word source (`src/reserved.ts`),
and `classifyPath` (`src/router.ts`). ADR 0007 and `docs/architecture/02` fix the frame
(slug rules, reserved semantics, the `Route` union), but several concrete details were
left open by the ACs and needed a decision: the id-length distribution, the exact
`validateId` bounds, the meaning of "runs of non-alphanumeric collapse" for `_`, the
filename-extension rule, the routing surface of `health` vs `admin`/`api`, and how the
"empty result → error" requirement of ADR 0007 is represented in a pure module.

## Decision

1. **Ids are fixed at 10 chars** (within the spec's "8–10 char nanoid", §4) from the
   64-char URL-safe alphabet `[A-Za-z0-9_-]`, via `crypto.getRandomValues` (ADR 0002).
   The alphabet length divides 256 evenly (`256 % 64 === 0`), so the plain modulo
   mapping is **unbiased — no rejection sampling needed** (the planner's draft suggested
   rejection sampling; it is unnecessary here). Uniqueness is by entropy: 64^10 ≈ 2^60,
   so the 10k-sample uniqueness AC (collision odds ≈ 4e-11) is satisfied with margin.
2. **`validateId` is a structural predicate**: `1–64` URL-safe chars
   (`/^[A-Za-z0-9_-]{1,64}$/`), never throws. It deliberately does _not_ re-check that an
   id was system-generated (8–10 chars) — the store's primary key owns uniqueness, and
   the range is a sanity bound, not a generation contract. The charset (no `.`, `/`, or
   `%`) is what makes ids safe to interpolate into URL paths: `../` cannot be a valid id.
3. **`slugify`** (all per ADR 0007 decision 1, concretized):
   - Filename extension = a trailing `.` + 1+ **ASCII letters only** (`.md`, `.html`,
     `.png`, …). Digit-suffixed titles such as "Chapter 1.5" are left intact — ".5" is
     not an extension.
   - Output alphabet is `[a-z0-9_-]`: `_` is a **first-class slug character** (preserved,
     including runs). Evidence: §5.1 reserves `_`-prefixed segments, and ADR 0007
     decision 2's "`_pages` is reserved" example only makes sense if slugs can bear `_`.
     "Runs of non-alphanumeric collapse to a single `-`" therefore governs characters
     _outside_ the alphabet; additionally, existing dash runs canonicalize to a single
     `-` (`-` is the canonical separator — "My - Post" → `my-post`).
   - Leading/trailing **dashes** are trimmed; edge underscores are not (the AC trims
     only dashes; S02's reserved check rejects `_`-prefixed slugs).
   - Empty result (e.g. a fully non-Latin title) is a **typed failure**, not a throw:
     `{ ok: false, error: AppError }` with code `invalid_slug`, status `400` (the
     architecture-05 taxonomy lists `invalid_slug` under 400). The module stays pure;
     the API layer (S17) maps the failure to a 400 response. To type this, a minimal
     `src/errors.ts` (the `AppError` class exactly per architecture 05) is created in
     S01; `toErrorResponse` arrives with the S12 error boundary.
4. **`classifyPath`** (architecture 02 contract, ADR 0007 decision 3, concretized):
   - The `Route` union uses the architecture's `health` member — this **supersedes the
     roadmap's planned `system` type** (recorded in `docs/development/roadmap.md`).
   - `health` is a **leaf** route: only `/health[/]` (spec §5 lists `GET /health` alone);
     `/health/extra` → `unknown`. `admin` and `api` are **prefix** routes (`/admin[/…]`,
     `/api[/…]`). `/p/{id}` is exactly two segments: `/p`, `/p/`, and `/p/{id}/foo` →
     `unknown` (spec defines only `/p/{id}/`).
   - Reserved first segments → `unknown` (never a slug — slug lookups never query a
     reserved word, guaranteed by construction). Reserved comparison is
     case-insensitive; the slug segment is **lowercased** (slugs are lowercase-only,
     OQ-02); the id segment is left **raw** (ids are a case-sensitive namespace).
   - Any number of trailing slashes is stripped before classification (`/hello///` →
     slug `hello`); the 301 trailing-slash step is a separate later slice (S08).
   - Encoded slashes (`%2F`/`%2f` anywhere) → `unknown`: they must never be interpreted
     as separators (S08: no redirect loops on encoded slashes). Paths not starting with
     `/`, or containing empty internal segments (`//`, `/a//b`) → `unknown`.
   - `classifyPath` is total: malformed input returns `unknown`, never throws.

## Consequences

- The URL surface is deterministic and exhaustively table-tested (S01 suite: 77 tests
  across 5 files); S08's redirect logic only has to handle the classified routes.
- `reserved.ts` is the single source of the list + predicate (ADR 0007's "no duplicated
  constants"): `router.ts` consumes it, `slug.ts` re-exports it for S02.
- Fixed 10-char ids and the 1–64 `validateId` bound mean later slices (S15 id → 400)
  can rely on one structural check; the 8–10 generation range is an ADR-documented
  contract, not re-verified by validation.
- The `_`-preserving slugify means auto-slugs can be `_`-prefixed (e.g. `_draft`); S02's
  reserved check rejects those — consistent with ADR 0007 decision 2.
- Non-ASCII titles degrade to dash-collapsed slugs or the typed `invalid_slug` failure;
  the admin UI's slug override (S17/S19) is the escape hatch (ADR 0007 consequences).
- Open question noted (deferred to S08): percent-encoded characters other than slashes
  (e.g. `%20` from user-typed spaces) are not decoded by `classifyPath`; such paths
  classify with the raw segment and will 404 at the store. Deciding decode-then-classify
  belongs with the S08 redirect work, not S01.

## Cross-references

- Spec: §4 (ids/slugs), §5 (URL & routing).
- Docs: `docs/architecture/02` (contracts — `Route` union, module layout),
  `docs/architecture/05` (error taxonomy).
- ADRs: 0002 (Web Crypto ids), 0007 (slugs and reserved words), 0005 (errors).
