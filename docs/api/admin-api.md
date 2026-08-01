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

## Placeholders

Until S17/S18 implement write endpoints:

- `POST /api/pages` → `405 Method Not Allowed` `{ error: "method_not_allowed" }`
- Other `/api/*` paths → `404 Not Found` `{ error: "not_found" }`

Until S19 implements the admin UI:

- `/admin*` with a valid token → placeholder `404` HTML page.

## Spec references

- §5 — URL & routing scheme
- §8 — Storage schema (`pages` and `files` tables)
- §9 — Authentication
- §10 — Admin UI & upload flows
- §11 — Caching (`no-store` for admin/API)
