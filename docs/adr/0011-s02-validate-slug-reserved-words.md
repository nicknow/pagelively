# 0011: S02 implementation details — `validateSlug` reserved-word validation

- Status: accepted
- Date: 2026-07-31

## Context

Slice S02 ("Reserved-word validation") delivers the API-boundary slug predicate the
roadmap's S02 AC call for: every §5 reserved name rejected, `_`-prefixed slugs rejected,
near-misses accepted, lowercase-only, and the reserved list consumed as extensible data
from `src/reserved.ts`. ADR 0007 fixed the reserved semantics (exact whole-segment
match + `_` prefix, case-insensitive); architecture 02 fixed the module slot
(`slug.ts — slugify(), reserved-word check, collision suffixes`); S01 (ADR 0010)
established the codebase conventions (typed results, `invalid_slug`/400, single-source
`reserved.ts`, `slug.ts` re-exporting `isReservedName`/`RESERVED_NAMES`). Several concrete
details were left open by the ACs and needed a decision: the exact predicate surface, its
home module, the rejection order (and thus which public message wins for inputs that
violate multiple rules, e.g. `favicon.ico` is reserved _and_ contains `.`), the length
bound, and how the "slug == another page's id is allowed" AC is represented in a pure
module.

## Decision

1. **`validateSlug(slug: string): SlugValidationResult` lives in `src/slug.ts`** next to
   `slugify`, where `SlugValidationResult = { ok: true } | { ok: false; error: AppError }`
   — the same typed-result shape as `slugify` (ADR 0010). This fills the architecture-02
   "reserved-word check" slot and honors ADR 0010's "`slug.ts` re-exports `reserved.ts`
   for S02" note. The reserved list is **not** moved: validation consumes
   `isReservedName`/`RESERVED_NAMES` from `reserved.ts` (ADR 0007: no duplicated
   constants). All rejections use code `invalid_slug`, status `400` (architecture-05
   taxonomy — `invalid_slug` is already listed under 400).
2. **Distinct, actionable `publicMessage` per rejection rule** — these messages become
   user-visible 400 responses at the API layer (S17/S18): empty / too-long / must-be-
   lowercase / `_`-prefix-reserved / reserved-name / bad-charset. The reserved branch
   refines its message with `RESERVED_NAMES.has(slug)` (list entry vs `_` prefix) but the
   guard is the single `isReservedName` predicate.
3. **Rejection order: empty → `>64` chars → non-lowercase → reserved → charset.**
   - _Reserved before charset_ so list entries containing `.` (`favicon.ico`,
     `robots.txt`) report the reserved reason rather than a charset error, and so
     decorations of reserved names (`admin.`, `favicon.ico2`, `p/p`) fall through to the
     charset rule — which is how the tests prove the reserved comparison is exact on the
     whole segment (ADR 0007 decision 2).
   - _Non-lowercase before reserved_: any input containing uppercase is rejected by the
     lowercase rule first. Per OQ-02 "slugs lowercase-only so case is moot", the
     case-insensitivity of reserved matching is a property of `isReservedName` itself
     (S01 tests), not re-exercised inside `validateSlug`; at the API boundary every
     uppercase variant is rejected either way.
4. **Bounds: `1–64` chars, charset `[a-z0-9_-]`** — consistent with `validateId`'s 1–64
   bound (ADR 0010) and ADR 0007 decision 1's slug alphabet. `_`-prefixed and reserved
   slugs are additionally rejected; a bare `_` is rejected by the prefix rule. The
   predicate is total and never throws (same discipline as `validateId`/`classifyPath`).
5. **No cross-namespace check with ids.** A slug equal to another page's id string is
   valid: §4 defines id and slug as separate namespaces pointing at the same Page, and
   ADR 0007 decision 4 makes id-only routes slug-agnostic. The pure predicate has no
   cross-namespace knowledge; per-namespace uniqueness is the store's job (S10, `slug`
   unique index). This is documented in the `slug.ts` module docstring and pinned by a
   test.
6. **`slugify` is unchanged** (generation path still lowercases/normalizes; empty result
   still the typed `invalid_slug` failure). `validateSlug` is the API-boundary predicate
   for explicit user slugs and post-normalization checks; S17/S18 compose the two. No
   routing changes: `classifyPath` already routes reserved first segments to `unknown`
   (S01, ADR 0007 decision 3), so validation and routing stay in sync through the same
   `reserved.ts` source.

## Consequences

- S17/S18 get one total, never-throwing predicate for explicit slugs; extending the
  reserved list means editing `RESERVED_NAMES` only — validation and routing both follow
  (ADR 0007's "single source of truth" holds).
- The planner's draft AC "`Assets` accepted" resolves to **rejected**: uppercase input
  fails the lowercase rule (case is moot), and the normalized form `assets` is reserved —
  both the explicit-slug path and the auto-slug path reject. Roadmap and slices-full are
  updated to say so.
- The roadmap S02 NOTE stands: a Worker-accepted near-miss slug such as `adminx` is still
  Access-challenged at the edge (`/admin*` scope, spec §9) — more restrictive, not a
  security hole; the S20/S22 ops/smoke docs will record the path rules.
- Out of scope preserved: collision suffixes (`-2`/`-3`, OQ-03) land with S17's
  uniqueness checks; routing behavior is untouched.
- Coverage: `validateSlug` is fully branch-covered by the S02 table tests (suite total
  102; coverage 100% on `src/**`, thresholds 85/85/80/85).

## Cross-references

- Spec: §4 (ids/slugs), §5 (URL & routing scheme, reserved names).
- Docs: `docs/architecture/02` (module layout — `slug.ts` reserved-word check),
  `docs/architecture/05` (error taxonomy — `invalid_slug` under 400),
  `docs/architecture/06` (slice→module map — S02 → slug.ts).
- ADRs: 0005 (errors), 0007 (slugs and reserved words), 0010 (S01 details).
- Roadmap: S02 AC; `.work/planner/slices-full.md` S02 section.
