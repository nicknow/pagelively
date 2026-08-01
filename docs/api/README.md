# API (`docs/api/`)

The request/response contracts for the public routes and the admin API.

- `admin-api.md` — protected admin API endpoints (`GET /api/pages`, `GET /api/pages/:id`).

The public entry routes (`/{slug}/`, `/p/{id}/`, `/health`, `/`) are covered in
the spec §5 and §11 and in the operator smoke-test checklist.

The intended full API surface is specified in `docs/product-spec.md` §5 (URL &
routing scheme) and §10 (admin UI & upload flows).
