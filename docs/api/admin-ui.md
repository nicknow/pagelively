# Admin UI

The admin UI is a buildless HTML interface served by the Worker at `/admin*`. It is protected by
Cloudflare Access at the edge and independently by the Access JWT verifier in the Worker (S16,
ADR 0024). All responses are `text/html; charset=utf-8` with `Cache-Control: no-store`.

The UI is implemented in `src/admin-ui.ts` as inline HTML/CSS/JS. No framework, no CDN, no
build step is required. It posts to the JSON admin API endpoints defined in `docs/api/admin-api.md`.

## Routes

### `GET /admin`

The dashboard lists all pages (id, title, slug, kind, created_at, visibility) with links to:

- View the public page at `/{slug}/` (or `/p/{id}/` when no slug is set).
- Edit the page at `/admin/edit/:id`.
- Delete the page via `DELETE /api/pages/:id` (with a confirmation prompt).

It also shows the verified operator email and an "Upload" button linking to `/admin/upload`. The
empty state displays an "Upload your first page" call to action.

### `GET /admin/upload`

The upload form contains:

- Files input (`multiple`-only) for picking one or more loose files.
- A separate folder input with `webkitdirectory` for folder uploads (preserves relative
  paths). The two pickers are split because `webkitdirectory` on the same input as `multiple`
  forces directory-only selection; the inline JS reads the union of both inputs and keys file
  parts by `webkitRelativePath || name`.
- Optional slug input.
- Optional title input (auto-generated from the filename if omitted).
- Visibility radio buttons (`public` / `unlisted`, default `public`).
- Show-source checkbox (meaningful for Markdown pages).
- Entry picker, shown only when the entry is ambiguous (multiple documents/images).

On submit, the client builds a `multipart/form-data` body with:

- a `manifest` part containing JSON `{ slug?, title?, showSource?, visibility?, entry? }`, and
- one `file:<path>` part per file.

This is the same convention as `POST /api/pages` (S17, ADR 0026). API errors are shown inline.

### `GET /admin/edit/:id`

The edit form:

- Fetches the page detail server-side.
- Pre-fills slug, title, visibility, and show-source.
- Lists current files with delete links (confirmation, then `DELETE /api/pages/:id/files/:path`).
- Provides a file upload form that posts to `POST /api/pages/:id/files`.
- Submits metadata updates via `PATCH /api/pages/:id`.
- Provides a Delete page button that calls `DELETE /api/pages/:id`.

Missing pages return `404`.

## Authentication

Every `/admin*` route requires a valid `Cf-Access-Jwt-Assertion` header. Without it, the Worker
returns `403` JSON `{ error: "Forbidden" }` with `no-store`. The verified email is displayed in
the dashboard header.

## Response headers

- `Content-Type: text/html; charset=utf-8`
- `Cache-Control: no-store`

## Relationship to the API

The UI is a consumer of the admin API:

| UI action         | API endpoint                 | Method   |
| ----------------- | ---------------------------- | -------- |
| Create page       | `/api/pages`                 | `POST`   |
| Update metadata   | `/api/pages/:id`             | `PATCH`  |
| Add/replace files | `/api/pages/:id/files`       | `POST`   |
| Delete a file     | `/api/pages/:id/files/:path` | `DELETE` |
| Delete a page     | `/api/pages/:id`             | `DELETE` |

See `docs/api/admin-api.md` for request/response shapes and error codes.

## Spec references

- §5 — URL & routing scheme
- §9 — Cloudflare Access authentication
- §10 — Admin UI & upload flows
- §11 — Caching (`no-store` for admin/API)
- §15 — Worker bundle size constraint

## Cross-references

- ADRs: 0024 (S16 JWT gate), 0025 (S15 admin API), 0026 (S17 upload), 0027 (S18 edit/delete), 0028 (S19 admin UI).
- Code: `src/admin-ui.ts`, `src/index.ts`, `src/admin-api.ts`.
