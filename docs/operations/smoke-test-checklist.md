# Operator smoke-test checklist

**Status:** living document — started during S06 validation; completed in S22.

This checklist covers the infrastructure seams that cannot be unit-tested locally (R2 CDN
public serving, live Cloudflare Access, custom domains, real cache HITs). The build team
never fakes these in code; the human operator verifies them against the real deployment.

## S06 — Content-type mapping (added during validation)

After publishing a page with a representative asset bundle, verify from the CDN host
(`cdn.pages.acme.com/pages/{id}/{rev}/…`) that each whitelisted extension is served with the
correct `Content-Type` header:

- [ ] `.png` → `image/png`
- [ ] `.jpg` and `.jpeg` → `image/jpeg`
- [ ] `.gif` → `image/gif`
- [ ] `.webp` → `image/webp`
- [ ] `.svg` → `image/svg+xml`
- [ ] `.avif` → `image/avif`
- [ ] `.css` → `text/css`
- [ ] `.js` → `text/javascript`
- [ ] `.woff` → `font/woff`, `.woff2` → `font/woff2`, `.ttf` → `font/ttf`, `.otf` → `font/otf`, `.eot` → `application/vnd.ms-fontobject`
- [ ] `.md` (raw source) → `text/markdown`
- [ ] `.html`/`.htm` entry document served by Worker → `text/html; charset=utf-8`
- [ ] Unknown extension (e.g. `.txt`, `.json`) → `application/octet-stream` (R2 serves the bytes, browser treats as download)
- [ ] Case-insensitive: `.PNG`, `.HTML`, `.Md` all resolve to the same MIME type as lowercase.
- [ ] Query string / fragment on asset URL (e.g. `file.png?cache=1#x`) still maps to the correct MIME type.

## S09 — Home-mode behavior (added during validation)

`resolveHome` is fully unit-tested, but the operator must confirm the deployed Worker wires the
home configuration into the entry-serve pipeline (S12) without a redirect loop and with the
correct 404 fallback:

- [ ] With `HOME_MODE=page` and `HOME_PAGE_SLUG=hello` published, `GET /` returns the same entry
      HTML as `GET /hello/` (same body, `text/html; charset=utf-8`, no `Location` header, status 200).
- [ ] With `HOME_MODE=404` (or unset), `GET /` returns the clean 404 page (status 404,
      `Cache-Control: no-store`).
- [ ] With `HOME_MODE=page` and an invalid `HOME_PAGE_SLUG` (e.g., reserved word, uppercase, or
      empty), `GET /` returns the clean 404 page and does **not** leak a validation error message.
- [ ] With `HOME_MODE=page` and a valid slug that does not exist in D1, `GET /` returns the clean
      404 page (S12 handles missing pages, not S09).
- [ ] `GET /` with a trailing slash (`GET /` only, root has no slash variant) is handled correctly
      — there is no 301 redirect for the root path.

## S10 — D1 pages repository (reads) (added during validation)

The local D1 emulation verifies the schema, SQL, and row mapping; the operator checks the
production D1 behavior for index coverage and the agreed error surface:

- [ ] `GET /{slug}/` and `GET /p/{id}/` resolve pages with a single-row D1 lookup (no full-table
      scan for public reads). Confirm via D1 query metrics or `EXPLAIN` that slug lookups use
      `idx_pages_slug` and id lookups use the primary key.
- [ ] `GET /admin` (or `GET /api/pages`) list is ordered newest-first; when multiple pages share
      the same `created_at` timestamp, ordering is deterministic (tie-breaker `id DESC`).
- [ ] Malformed ids (`/p/bad/id/`) and slugs (`/Admin/`) return 400 with code `invalid_id` or
      `invalid_slug`; no raw SQLite error text is leaked in the response body.
- [ ] Internal D1 failures (e.g., unavailable DB) return 500 with code `db_read_failed` and a
      generic public message; logs contain the original detail but the client does not.

## Pending sections (to be filled by S20/S22)

- Cloudflare Access login/logout flow
- Worker custom domain DNS resolution
- R2 CDN serving and bandwidth egress
- Edge-cache HIT / purge-on-publish freshness
- Free-tier quota verification
- Reserved-name / traversal CDN 404 behavior

See `docs/operations/README.md` for the full provisioning and deploy guide.
