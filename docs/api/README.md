# API (`docs/api/`)

The request/response contracts for the admin surface.

- [`admin-api.md`](admin-api.md) — the JSON API behind the admin UI: listing, publishing
  (upload or paste), editing metadata, adding/replacing/deleting files, and deleting pages,
  with every request/response shape and error code.
- [`admin-ui.md`](admin-ui.md) — the server-rendered admin HTML pages (`/admin`,
  `/admin/upload`, `/admin/edit/:id`) that consume this API.

If you're looking for how to _use_ the admin UI rather than its wire format, see the
[user guide](../guide/README.md) instead — these two docs are written for someone integrating
with or maintaining the API, not for day-to-day use.

The public entry routes (`/{slug}/`, `/p/{id}/`, `/health`, `/`) are covered in
`docs/product-spec.md` §5 and §11, and exercised end-to-end in
`docs/operations/smoke-test-checklist.md`.
