# 0028: S19 admin UI — buildless HTML dashboard wired behind the Access JWT gate

- Status: accepted
- Date: 2026-08-01

## Context

Slice S19 implements the operator-facing admin UI. The spec §10 calls for a "minimal,
buildless admin (server-rendered HTML + a little vanilla JS — no framework needed, keeps the
Worker small)" and requires the product name "Pagelively" to be visible. S15/S17/S18 had
already implemented the JSON admin API; S16 wired the Access JWT gate in `src/index.ts`.

Two decisions needed resolution:

1. **Where to keep the HTML?** A framework or separate template files would add a build step
   and a dependency, contradicting the "buildless" requirement. Inline HTML strings in
   TypeScript keep the Worker self-contained but risk inflating the bundle.
2. **How does the edit page fetch page details?** The UI could call `GET /api/pages/:id` via a
   second HTTP request, or it could compose the same repositories server-side. The latter is
   simpler locally but bypasses the API boundary.

## Decision

### 1. Buildless, inline HTML/CSS/JS in `src/admin-ui.ts`

All three admin routes (`/admin`, `/admin/upload`, `/admin/edit/:id`) are served as
`text/html; charset=utf-8` from inline strings. No framework, no CDN, no bundler. The inline
styles are minimal and the client-side JS is vanilla JS, also inline.

- **Trade-off:** the file is large. To keep the Worker bundle under the free-tier 3 MB
  compressed limit (spec §15), the markup is intentionally small. The dry-run build reports
  ~34 KiB gzip, so the inline UI is well within budget.
- **Safety:** all dynamic values are HTML-escaped through `escapeHtml` (reused from
  `utils.ts`) before interpolation, matching the same defense-in-depth rule used by the base
  injector (ADR 0008, risk R12).

### 2. Admin UI handlers are thin shells over the API repositories

The edit page loads the page record and files list directly from `pagesRepository.getById` and
`filesRepository.listForPage` rather than issuing an internal HTTP request. This is simpler,
keeps the UI handler synchronous with the API handler error conventions, and avoids the
overhead of an extra request. The JSON API remains the canonical source of truth for the
shape; the UI only renders it.

### 3. Route mapping in `src/index.ts`

`classifyPath` (router.ts) returns a single `admin` type for every `/admin*` path. After the
Access JWT gate passes, `src/index.ts` dispatches by exact/normalized pathname:

- `/admin` or `/admin/` → `handleAdminDashboard`
- `/admin/upload` → `handleAdminUpload`
- `/admin/edit/:id` → `handleAdminEdit`
- any other `/admin*` path → `clean404Response`

`GET /admin` (no trailing slash) is served directly; the router strips trailing slashes before
classification, so `/admin` and `/admin/` are equivalent.

### 4. Client-side multipart convention

The upload form builds a `multipart/form-data` body identical to the S17 API contract:

- one JSON `manifest` field (`{ slug?, title?, showSource?, visibility?, entry? }`), and
- one file part per file keyed `file:<relative-path>`.

Browser uploads come from **two separate file pickers**: the primary `#files` input is
`multiple`-only (so the user can pick one or more loose files), and folder upload — which
preserves relative paths — is an opt-in `#add-folder`/`#folder` input with `webkitdirectory`.
Putting `webkitdirectory` on the same input as `multiple` forces directory-only selection in
browsers, so the split is required to support both spec §10 behaviors. The JS unifies both
sources via `webkitRelativePath || name` and falls back to `file.name` for loose files. The
entry picker is shown only when the entry is ambiguous (more than one document/image
candidate). If exactly one HTML/MD file is present, the picker is hidden and the entry is
auto-detected.

> **Field fix 2026-08-01:** the original S19 implementation combined `multiple` and
> `webkitdirectory` on one input (`#files`, `#add-files`), which forced directory-only
> selection — users could not pick loose files. Split into a `multiple`-only files input plus
> a separate `webkitdirectory` folder input on both the upload and edit pages; the inline JS
> reads the union of both inputs. Pinned by regression tests in `test/admin-ui.test.ts` (see
> the field-fix entry in `docs/development/roadmap.md`).

### 5. Forms use `fetch` for PATCH/DELETE and multipart

Simple navigation links use plain `<a>` tags. The edit form uses `fetch` with `PATCH
/api/pages/:id` for metadata updates, `POST /api/pages/:id/files` for file uploads, and
`DELETE /api/pages/:id/files/:path` and `DELETE /api/pages/:id` for deletions, all with a
confirmation prompt. This keeps the client-side routing small and reuses the API endpoints.

### 6. Responses carry `Cache-Control: no-store`

All admin UI responses use the `cacheService.headersFor("admin")` helper, which returns
`no-store`.

## Consequences

- The UI is fully self-contained: no build step, no external dependencies, no framework.
- The bundle size remains small (~34 KiB gzip after S19).
- The UI surfaces the verified email and product name as required by spec §9 and §10.
- The edit page bypasses the HTTP API boundary for its initial load; future SPA or API-only
  consumers can still use the JSON endpoints.
- The inline-JS approach is readable but not unit-tested for DOM behavior; coverage checks the
  HTML string generation and the index.ts dispatch. The operator checklist covers the
  end-to-end upload/edit/delete flows.

## Cross-references

- Spec: §5 (URL scheme), §9 (auth), §10 (admin UI & upload flows), §12 (config), §15 (bundle size).
- Docs: `docs/api/admin-api.md`, `docs/api/admin-ui.md`, `docs/architecture/02-module-boundaries-contracts.md`.
- ADRs: 0024 (S16 JWT gate), 0025 (S15 admin API), 0026 (S17 upload), 0027 (S18 edit/delete).
- Code: `src/admin-ui.ts`, `src/index.ts`.
