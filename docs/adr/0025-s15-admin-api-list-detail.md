# 0025: S15 admin API — list & detail response shape and dispatch

- Status: accepted
- Date: 2026-08-01

## Context

Slice S15 wires the first real admin API endpoints (`GET /api/pages`,
`GET /api/pages/:id`) behind the S16 Access JWT gate. Two design details were
not fully specified by the spec or previous ADRs:

1. Should the list endpoint include the files array for each page? The spec §10
   dashboard implies a compact list, but does not explicitly rule out nested
   files.
2. What should unimplemented `/api/*` routes and `/admin*` routes return while
   S17–S19 are pending? The S16 placeholder was a JSON `{ error: "not implemented" }`
   404 for both.

## Decision

1. **List response omits files.** `GET /api/pages` returns the same fields as a
   `PageRecord` (id, slug, title, kind, rev, entry_path, raw_md_path,
   show_source, visibility, created_at, updated_at) in `created_at DESC` order,
   but does not include a `files` property. The detail endpoint
   (`GET /api/pages/:id`) includes `files: FileRecord[]`. This keeps the list
   payload small and avoids a nested join or N+1 query in a single D1 table; the
   detail endpoint fetches files with a second index-covered query on the
   `files` table's `page_id` column (the PK is `(page_id, path)`).

2. **Detail id validation happens in the handler.** `handleGetPage` extracts the
   id from the URL and calls `validateId` before delegating to
   `pagesRepository.getById`. The repository also validates defensively, but the
   handler owns the 400 response shape for malformed API input.

3. **Unimplemented API routes return JSON 404/405 with `no-store`.** `POST /api/pages`
   (and other methods on `/api/pages`) returns `405 method_not_allowed`;
   unknown `/api/*` paths return `404 not_found`. Both use the same JSON error
   shape as the rest of the app (via `toErrorResponse`). This is consistent with
   the spec §5 placeholder behavior and the S16 test contract.

4. **`/admin*` placeholder remains a 404, but rendered as HTML.** The S19 dashboard
   will be HTML; returning a minimal HTML 404 placeholder now means the existing
   S16 tests only need to update their expected body, not the content type.

5. **Handlers throw `AppError`; the top-level error boundary converts them.** Both
   `handleListPages` and `handleGetPage` throw typed errors for failure modes
   (invalid id, not found). `src/index.ts` awaits these handlers so its single
   `try/catch` maps them to responses via `toErrorResponse`. This avoids
   duplicating error-response construction in the handlers and keeps the
   handler code focused on the success path.

## Consequences

- The list endpoint is a thin delegation to `pagesRepository.list()`; the detail
  endpoint composes `pagesRepository.getById` + `filesRepository.listForPage`.
- The `AdminApiDeps` interface explicitly includes `verifiedIdentity` so future
  S17/S18 handlers have the authenticated email available without changing the
  contract.
- `src/index.ts` passes both `pages` (for `serveEntry`) and `pagesRepository`
  (for admin-api) in the same deps object, plus a `cacheService` alias for the
  cache seam. This keeps the public entry pipeline unchanged while satisfying the
  admin-api contract.
- The `ErrorStatus` type was extended to include `405`, matching the HTTP status
  used for the unimplemented method placeholder.

## Cross-references

- Spec: §5 (URL & routing), §8 (storage schema), §9 (auth), §10 (admin UI &
  upload flows), §11 (caching).
- Docs: `docs/architecture/02-module-boundaries-contracts.md`,
  `docs/architecture/03-data-model.md`.
- ADRs: 0010 (id validation), 0019 (pages repository), 0024 (JWT gate).
- Code: `src/admin-api.ts`, `src/files-repository.ts`, `src/index.ts`.
