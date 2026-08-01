# 0019: S10 D1 pages repository — read-only surface

- Status: accepted
- Date: 2026-07-31

## Context

Slice S10 implements the read-only half of `src/pages-repository.ts` against the
real D1 schema from `migrations/0001_init.sql`. The architecture 02 contract
specifies the `PageRecord` interface and the repository's methods; the slice
acceptance criteria add validation and index-covered query rules. A few
concrete details were left open and needed a decision.

## Decision

1. **Field naming follows architecture 02 as the authoritative interface.** The
   slice AC text parenthetically says "all camelCase fields", but architecture 02
   explicitly lists `entry_path`, `raw_md_path`, `show_source`, `created_at`, and
   `updated_at` — the same names as the SQL columns. The repository uses the
   exact SQL column names in `SELECT` and the resulting object is a typed
   `PageRecord` with those snake_case names. This is the minimal change that
   matches the existing schema and the module-boundary contract; the AC text is
   treated as a copy-paste inconsistency.

2. **Validation before SQL.** `getById` and `slugTaken` call `validateId`
   (S01/ADR 0010) before any `prepare`/`bind`; `getBySlug` and `slugTaken` call
   `validateSlug` (S02/ADR 0011) first. Malformed ids/slugs never reach the D1
   layer and surface as `AppError("invalid_id", 400)` or
   `AppError("invalid_slug", 400)`.

3. **Index-covered queries.** `getBySlug` and `slugTaken` use
   `SELECT ... FROM pages WHERE slug = ? LIMIT 1`, which is covered by
   `idx_pages_slug` (schema 0001). `getById` uses the primary key. No
   non-indexed public reads are introduced.

4. **Deterministic admin list.** `list()` orders by `created_at DESC, id DESC`.
   The tie-breaker on `id` makes the order deterministic when multiple pages are
   created in the same millisecond.

5. **Defensive row mapping.** `toPageRecord` validates the SQLite row values:
   `rev` must be an integer >= 1, `show_source` must be `0` or `1`, and
   `visibility` must be `public` or `unlisted`. Any violation throws
   `AppError("db_read_failed", 500)` with the original value as internal detail
   — the raw message never reaches the caller.

6. **No write methods in this slice.** `create`, `updateMeta`, `applyRevBump`,
   and `delete` are left out, keeping the repository read-only. The full
   `PagesRepository` interface from architecture 02 will be completed in S17/S18.

7. **Error handling contract.** All unexpected D1 errors are wrapped in
   `AppError("db_read_failed", 500)` with the original error as internal detail.
   The public message is generic.

## Consequences

- Tests run against the real migrated schema via the Workers-pool D1 emulation;
  no fixture schema is copied.
- `slugTaken` with `exceptId` is implemented as `WHERE slug = ? AND id != ?`,
  satisfying the uniqueness check required by S17's upload API.
- `filterVisible` is a pure helper that treats `null`/`undefined` visibility as
  `public`, matching the schema default.
- The repository depends only on the injected `D1Database`; no runtime bindings.

## Cross-references

- Spec: §8 (storage schema), §12 (visibility).
- Docs: `docs/architecture/02-module-boundaries-contracts.md`,
  `docs/architecture/03-data-model.md`.
- ADRs: 0010 (S01 id validation), 0011 (S02 slug validation), 0012 (S03 rev
  policy).
- Code: `src/pages-repository.ts`, `test/pages-repository.test.ts`.
