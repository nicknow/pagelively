# Admin API (`docs/api/admin-api.md`)

The admin API is protected by Cloudflare Access at the edge and independently
verifies the `Cf-Access-Jwt-Assertion` token in the Worker (S16). All responses
are `Cache-Control: no-store`.

Error responses are JSON `{ "error": "<code>", "message": "<human-readable hint>" }`
(OQ-15/T1, ADR 0036): `error` is the stable snake_case code for programmatic
handling; `message` is a safe, actionable human string that the admin UI shows
verbatim (`message || error` fallback). Internal details and stack traces are
never included.

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

**Slug handling (OQ-15/T1, ADR 0036):** a user-supplied `manifest.slug` is cleaned before
validation and storage: surrounding whitespace and case are normalized (`"  My Post "` →
`my-post`), runs of non-slug characters collapse to `-`, and the result is truncated to 64
characters. Reserved names are rejected with `400 invalid_slug` — exact names like
`favicon.ico`/`robots.txt` are rejected intact (never renamed by dot mangling), and decorations
of reserved names (`" Admin! "` → `admin`) are rejected after cleaning. Empty or whitespace-only
slugs are treated as "not provided" and auto-generated from the title. The cleaned slug is stored
and echoed in the `201` response.

**Response:** `201 Created`
`Content-Type: application/json; charset=utf-8`

The body is the same shape as `GET /api/pages/:id` (page + `files[]`). The page's cache tag is
purged on success.

**Error responses:**

- `400` `{ error: "no_files" }` — no file parts were uploaded.
- `400` `{ error: "ambiguous_entry" }` — multiple entry candidates and no `manifest.entry`.
- `400` `{ error: "invalid_entry" }` — `manifest.entry` does not match an uploaded file.
- `400` `{ error: "invalid_slug" }` — reserved name (rejected intact or after cleaning),
  non-empty slug that cleans to nothing, or invalid slug characters.
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

### `PATCH /api/pages/:id`

Edit a page's metadata: `slug`, `title`, `visibility`, or `showSource`.

**Request body:** `application/json`

```json
{
  "slug": "new-slug",
  "title": "New Title",
  "visibility": "unlisted",
  "showSource": true
}
```

All fields are optional. `slug` may be `null` to remove the slug. `title` is capped at 256
characters (same limit as publish). Metadata edits do **not** bump `rev` (ADR 0012). For
Markdown pages, toggling `showSource` re-renders the stored `index.html` at the current rev and
purges the cache.

**Slug handling:** the same cleaning as publish applies (OQ-15/T1, ADR 0036) — `"  New Slug "`
is stored and echoed as `new-slug`. `slug: null` clears the slug; a whitespace-only string is
rejected with `400 invalid_slug` and leaves the stored slug untouched.

**Response:** `200 OK` with the same page + `files` shape as `GET /api/pages/:id`.

**Error responses:**

- `400` `{ error: "invalid_id" }` — id format is invalid.
- `400` `{ error: "invalid_json" }` — body is not valid JSON.
- `400` `{ error: "invalid_slug" }` — slug not a string/null, reserved name (rejected intact or
  after cleaning), empty/whitespace-only, or invalid slug characters.
- `400` `{ error: "invalid_title" }` — title is not a string.
- `400` `{ error: "title_too_long" }` — title exceeds 256 characters.
- `400` `{ error: "invalid_visibility" }` — visibility is not `public`/`unlisted`.
- `400` `{ error: "invalid_show_source" }` — `showSource` is not a boolean.
- `404` `{ error: "not_found" }` — page id does not exist.
- `404` `{ error: "entry_not_found" }` — `showSource` toggled but `source.md` is missing.
- `409` `{ error: "slug_conflict" }` — slug is already used by another page.
- `403` `{ error: "Forbidden" }` — missing or invalid `Cf-Access-Jwt-Assertion`.

### `POST /api/pages/:id/files`

Add or replace files on a page. The request body is `multipart/form-data` with one file part per
file: `file:<relative-path>` (same convention as `POST /api/pages`).

- Adding a new file bumps `rev` (content-affecting).
- Replacing the entry file is allowed:
  - `index.html` for HTML pages is stored as `index.html`.
  - `.md` uploads for Markdown pages re-render to `index.html` + `source.md`.
  - `.md` uploads matching a bundle's Markdown entry re-render to `index.html` + `source.md`.
  - The bundle's HTML entry path is stored as-is.

Invalid paths (`%`, `../`, leading `/`, `\`) are rejected.

**Response:** `200 OK` with the updated page + `files`.

**Error responses:**

- `400` `{ error: "invalid_id" }` — id format is invalid.
- `400` `{ error: "no_files" }` — no file parts were uploaded.
- `400` `{ error: "path_traversal" }` — a path contains `../`, starts with `/`, or uses `\`.
- `400` `{ error: "invalid_filename" }` — a filename contains `%`.
- `404` `{ error: "not_found" }` — page id does not exist.
- `500` `{ error: "db_write_failed" }` — D1 write failed after R2 writes; new rev folder is
  removed best-effort.
- `403` `{ error: "Forbidden" }` — missing or invalid `Cf-Access-Jwt-Assertion`.

### `DELETE /api/pages/:id/files/:path`

Remove a file from a page. The path is URL-encoded; nested paths (`style.css`, `images/pic.png`)
are supported.

- File delete bumps `rev` (ADR 0012).
- Remaining files are copied to the new rev folder.
- Deleting the entry file is rejected. The whole page must be deleted instead (`DELETE /api/pages/{id}`):
  - `index.html` for markdown pages and for bundle pages whose entry is Markdown.
  - The original HTML path for HTML pages and for bundle pages whose entry is HTML (e.g.
    `site/index.html` in a bundle with that entry).
  - The raw Markdown source (`source.md`/`pages.raw_md_path`) for markdown/bundle-with-md
    pages is also protected.
  - The image filename (`pages.entry_path`) for image pages.

**Response:** `200 OK` with the updated page + `files`.

**Error responses:**

- `400` `{ error: "invalid_id" }` — id format is invalid.
- `400` `{ error: "entry_not_deletable" }` — the path is the page entry. The error message
  explains the protected path(s) and tells the operator to delete the whole page (e.g.,
  "The rendered page files (index.html and source.md) are part of the page and cannot be
  deleted individually. Delete the page to remove it." for rendered pages; for image pages it
  names the image file). The response body is still `{ error: "entry_not_deletable" }`.
- `404` `{ error: "not_found" }` — page id or file path does not exist.
- `500` `{ error: "db_write_failed" }` — D1 write failed after R2 writes; new rev folder is
  removed best-effort.
- `403` `{ error: "Forbidden" }` — missing or invalid `Cf-Access-Jwt-Assertion`.

### `DELETE /api/pages/:id`

Delete a page and all its stored objects.

- Deletes the `pages` row (cascade deletes `files` rows).
- Deletes all R2 objects under `pages/{id}/`.
- Purges the page's cache tag.

**Response:** `204 No Content`.

**Error responses:**

- `400` `{ error: "invalid_id" }` — id format is invalid.
- `404` `{ error: "not_found" }` — page id does not exist.
- `403` `{ error: "Forbidden" }` — missing or invalid `Cf-Access-Jwt-Assertion`.

### Unmatched admin/API paths

- Other `/api/*` paths → `404 Not Found` `{ error: "not_found" }`
- Unknown `/admin*` paths (e.g. `/admin/dashboard`) → `404 Not Found` HTML page (S19 wires
  `/admin`, `/admin/upload`, and `/admin/edit/:id` to the buildless admin UI; everything else
  falls through to the clean 404 handler).

## Spec references

- §5 — URL & routing scheme
- §8 — Storage schema (`pages` and `files` tables)
- §9 — Authentication
- §10 — Admin UI & upload flows
- §11 — Caching (`no-store` for admin/API)
