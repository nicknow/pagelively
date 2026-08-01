# Admin API (`docs/api/admin-api.md`)

The admin API is protected by Cloudflare Access at the edge and independently
verifies the `Cf-Access-Jwt-Assertion` token in the Worker (S16). All responses
are `Cache-Control: no-store`.

## Endpoints

### `GET /api/pages`

List all pages, newest first (`created_at DESC`, `id DESC` tie-breaker).

**Response:** `200 OK`
`Content-Type: application/json; charset=utf-8`

```json
[
  {
    "id": "page000002",
    "slug": "beta",
    "title": "Beta",
    "kind": "markdown",
    "rev": 1,
    "entry_path": "index.html",
    "raw_md_path": "source.md",
    "show_source": 1,
    "visibility": "public",
    "created_at": "2026-01-02T00:00:00.000Z",
    "updated_at": "2026-01-02T00:00:00.000Z"
  }
]
```

The list response does **not** include a `files` property (see detail).

### `GET /api/pages/:id`

Get a single page and its files.

**Response:** `200 OK`
`Content-Type: application/json; charset=utf-8`

```json
{
  "id": "page000001",
  "slug": "alpha",
  "title": "Alpha",
  "kind": "html",
  "rev": 1,
  "entry_path": "index.html",
  "raw_md_path": null,
  "show_source": 0,
  "visibility": "public",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z",
  "files": [
    {
      "page_id": "page000001",
      "path": "style.css",
      "r2_key": "pages/page000001/1/style.css",
      "content_type": "text/css",
      "size": 100
    }
  ]
}
```

**Error responses:**

- `400` `{ error: "invalid_id" }` — id format is invalid (e.g., contains `.`, `/`, or `%`).
- `404` `{ error: "not_found" }` — no page with that id.
- `403` `{ error: "Forbidden" }` — missing or invalid `Cf-Access-Jwt-Assertion`.

### `POST /api/pages`

Upload and publish a page. The request body must be `multipart/form-data`.

**Multipart fields:**

- `manifest` (optional, JSON string): `{ slug?, title?, showSource?, entry?, visibility? }`
  - `slug`: optional friendly URL name. If omitted, derived from the entry filename.
  - `title`: optional page title. If omitted, derived from the entry filename.
  - `showSource`: boolean, only meaningful for Markdown entries. Adds a link to the raw `.md`.
  - `entry`: required when the entry is ambiguous (e.g., multiple documents/images). The
    relative path of the file that serves as the entry point.
  - `visibility`: `"public"` (default) or `"unlisted"`.
- `file:<path>` (one per file): the binary content. The part name is the canonical relative
  path (e.g., `file:images/pic.png`). The browser filename is ignored except for diagnostics.

**Page kind detection:**

- One `.html`/`.htm` document (with optional assets) → `html`, stored as `index.html`.
- One `.md`/`.markdown` document (with optional assets) → `markdown`, rendered to
  `index.html`, raw stored as `source.md`.
- One image, no documents → `image`, stored under its original filename.
- Multiple documents, multiple images, or a manifest entry → `bundle`, paths preserved.
- A bundle whose entry is Markdown is rendered like a Markdown page but `kind` stays `bundle`
  (OQ-05).

**Response:** `201 Created`
`Content-Type: application/json; charset=utf-8`

The body is the same shape as `GET /api/pages/:id` (page + `files[]`). The page's cache tag is
purged on success.

**Error responses:**

- `400` `{ error: "no_files" }` — no file parts were uploaded.
- `400` `{ error: "ambiguous_entry" }` — multiple entry candidates and no `manifest.entry`.
- `400` `{ error: "invalid_entry" }` — `manifest.entry` does not match an uploaded file.
- `400` `{ error: "invalid_slug" }` — reserved word or invalid slug characters.
- `400` `{ error: "invalid_visibility" }` — visibility is not `public` or `unlisted`.
- `400` `{ error: "title_too_long" }` — title exceeds 256 characters.
- `400` `{ error: "path_traversal" }` — a path contains `../`, starts with `/`, or uses `\`.
- `400` `{ error: "invalid_filename" }` — a filename contains `%`.
- `400` `{ error: "invalid_manifest" }` — manifest is missing or invalid JSON.
- `400` `{ error: "invalid_form_data" }` — body is not valid multipart form data.
- `409` `{ error: "slug_conflict" }` — a user-provided slug is already taken.
- `413` `{ error: "request_too_large" }` — `Content-Length` exceeds the ~95 MB guard.
- `500` `{ error: "db_write_failed" }` — D1 write failed after R2 writes; R2 objects are rolled
  back best-effort.
- `403` `{ error: "Forbidden" }` — missing or invalid `Cf-Access-Jwt-Assertion`.

## Placeholders

Until S18 implements edit/delete endpoints:

- `PATCH /api/pages/:id` → `405 Method Not Allowed` `{ error: "method_not_allowed" }`
- `DELETE /api/pages/:id` → `405 Method Not Allowed` `{ error: "method_not_allowed" }`
- Other `/api/*` paths → `404 Not Found` `{ error: "not_found" }`

Until S19 implements the admin UI:

- `/admin*` with a valid token → placeholder `404` HTML page.

## Spec references

- §5 — URL & routing scheme
- §8 — Storage schema (`pages` and `files` tables)
- §9 — Authentication
- §10 — Admin UI & upload flows
- §11 — Caching (`no-store` for admin/API)
