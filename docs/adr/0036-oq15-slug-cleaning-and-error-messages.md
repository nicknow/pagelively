# 0036: OQ-15 — slug auto-clean and actionable error messages (T1)

- Status: accepted
- Date: 2026-08-02

## Context

OQ-15 asked whether a user-entered slug on create/edit should be **cleaned** instead of
**rejected**. Before T1, `validateSlug` (ADR 0011, S02) rejected anything that was not already
a canonical slug: `"  My Post "` → 400 `invalid_slug`. Since users type titles, filenames, and
human phrases, `invalid_slug` was common and the message told the user nothing actionable.

Separately, every error response body was `{ "error": "<code>" }` — stable and machine
readable, but the admin UI (S19, ADR 0028) had to hardcode a human string per code and showed
a generic "Upload failed"/"Update failed" banner. The T1 acceptance criteria asked for an
actionable `message` field on every error and for the UI to display it.

Options considered:

1. **Reject everything invalid** (status quo): zero ambiguity, but hostile UX and no signal.
2. **Clean where fixable, reject only what remains invalid**: trim, lowercase, disallowed runs
   → `-`, truncate to 64 — and echo the cleaned slug so the user sees what was stored. Reject
   only empty/reserved-after-cleaning/structurally-invalid input, with an actionable message.

## Decision

1. **`cleanSlug` (src/slug.ts)** — a pure pipeline, applied on create (`manifest.slug`) and on
   PATCH (`slug`):
   - trim → **reserved-name pre-check on the raw input** (exact names like `favicon.ico` and
     `robots.txt` are rejected intact — never dot-mangled into `favicon-ico`), `_`-prefix
     names rejected → shared `normalizeSegment` (lowercase; runs of non-slug characters → `-`;
     `-+` → `-`; strip leading/trailing `-`) → a non-empty input that cleans to empty is a
     typed failure (`"Name contains no characters that can form a slug."`) → truncate to
     `MAX_SLUG_LENGTH` (64), stripping a trailing `-` introduced by the cut → **reserved-name
     re-check on the cleaned result** (so `" Admin! "` → `admin` is rejected) → `validateSlug`
     as an unreachable-by-construction safety net.
   - `slugify` is **unchanged byte-for-byte** (same `normalizeSegment` helper, but it strips
     extensions first and never truncates); `cleanSlug` deliberately does **not** strip
     extensions (`"my.md"` → `my-md`, never `my`).
2. **Error bodies are `{ error, message }`** — additive: `error` stays the stable code;
   `message` is a safe, actionable string chosen at the throw site (`toErrorResponse`), never
   containing internal detail or stack traces (ADR 0005 safety rule 2). The two hardcoded
   `internal_error` bodies (entry pipeline, dispatcher) also carry `message: "Internal error."`.
   The admin UI renders `message || error` in all six error display sites (upload form, edit
   form, add-files form, dashboard delete, file delete, page delete), so no code hardcoding
   remains for these paths.
3. **Create vs edit asymmetry** (pinned by tests): a whitespace-only `manifest.slug` is treated
   as "not provided" → auto-generated from the title (no slug was intended); a whitespace-only
   PATCH `slug` is a `400 invalid_slug` (the user explicitly edited a field to whitespace) and
   leaves the stored slug untouched. PATCH `slug: null` still clears the slug.
4. **No migration** (AC16): stored slugs are never rewritten; cleaning applies only at
   write time on user input.

## Consequences

- `invalid_slug` on create/edit is now rare: only reserved names (intact or after cleaning),
  non-empty input that cleans to nothing, and structurally invalid strings. Everything else is
  cleaned, stored, and echoed to the UI (`"  My Post "` → stored `my-post`).
- Every API error the UI can hit carries a `message`; the UI shows it verbatim. Consumers must
  still key off `error` — `message` is not a contract for programmatic handling.
- Reserved-name handling is now two-stage (intact raw names + cleaned decorations), which is
  strictly stricter than S02 alone and keeps the `favicon.ico`/`robots.txt` invariants from
  ADR 0007/0011.
- The `validateSlug` tail inside `cleanSlug` is defensive and uncovered by design (one
  uncovered branch in the coverage report); removing it would re-introduce risk on future
  edits to the pipeline.
- Verification: 26 new tests (13 `cleanSlug` unit, 5 create, 4 PATCH, 1 error-shape, 3 UI
  literal pins — the third pin, added in the validator fix round, asserts both the file-delete
  and page-delete alert handlers use `data.message || data.error`) plus mechanical
  `{ error, message }` assertion updates across 7 test files; full suite 1113 tests /
  38 files; coverage 99.54 % stmts / 97.11 % branch / 97.87 % funcs / 99.76 % lines.
- Related decisions: ADR 0007 (slugs + reserved words), ADR 0011 (`validateSlug`), ADR 0005
  (error handling), ADR 0026/0027 (publish/edit APIs), ADR 0028 (admin UI).
