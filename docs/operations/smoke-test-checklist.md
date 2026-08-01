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

## S11 — R2 object store (key layout + metadata) (added during implementation)

The local Vitest Workers-pool emulation verifies put/get/delete, key layout, metadata
round-trip, and pagination. The operator checks the real R2 CDN-host path and the immutable
header contract:

- [ ] After publishing a page, objects are stored under `pages/{id}/{rev}/…` (visible in R2 or
      via the dashboard) and the layout matches the spec §8 schema exactly.
- [ ] `GET cdn.pages.acme.com/pages/{id}/{rev}/{path}` returns the correct bytes for assets
      (images, CSS, JS, fonts, raw `.md`) and the CDN host serves them without a Worker
      invocation.
- [ ] Assets served from the CDN host carry `Cache-Control: public, max-age=31536000, immutable`
      because the object `httpMetadata` was set at upload.
- [ ] Folder paths are preserved: `pages/{id}/{rev}/images/pic.png` is the key, and the relative
      reference `images/pic.png` resolves through the injected `<base>` tag.
- [ ] A page with multiple revisions (e.g. after a file edit) has objects under each `{rev}`
      folder; `deletePageObjects` removes the whole `pages/{id}/` namespace.
- [ ] R2 CDN traversal-ish requests (`/pages/{id}/{rev}/../…`, `/%2e%2e/…`) return the bucket's
      own 404 rather than resolving to a sibling key (ADR 0012, S03).

## S12 — Entry request pipeline (added during implementation)

The public entry pipeline is fully unit-tested locally; the operator checks that the
deployed Worker behaves the same way on the real edge:

- [ ] `GET /health` returns `200` JSON `{ ok: true, service: "pagelively" }` with no
      binding details, no auth, and `Cache-Control: no-store`.
- [ ] `GET /` with `HOME_MODE=404` returns the clean 404 page (status 404, `no-store`).
- [ ] `GET /` with `HOME_MODE=page` and `HOME_PAGE_SLUG=hello` returns the same entry
      HTML as `GET /hello/` (no `Location` header, `text/html; charset=utf-8`).
- [ ] `GET /hello` → `301` to `GET /hello/` (absolute `Location` preserving host/scheme/port).
- [ ] `GET /hello/` on an html page returns the entry HTML with `<base href="{ASSET_BASE_URL}/pages/{id}/{rev}/">`
      injected as the first element of `<head>`.
- [ ] `GET /p/{id}/` returns the same page by canonical id, with the same base tag.
- [ ] Image pages return `301` to `{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}` with
      `Cache-Control: public, max-age=300, stale-while-revalidate=3600` and `Cache-Tag: page-{id}`.
- [ ] Markdown pages serve the stored rendered HTML with the same base tag and `text/html; charset=utf-8`.
- [ ] Unknown slugs, unknown ids, and unknown paths return the clean 404 page with `no-store`.
- [ ] `/admin*` and `/api/*` without a valid Access token return `403` JSON `{ error: "Forbidden" }`
      with `no-store`; with a valid token they return the placeholder `404` JSON
      `{ error: "not implemented" }` with `no-store` (S16).
- [ ] Internal failures (e.g., D1 unavailable) return `500` JSON `{ error: "db_read_failed" }`
      with `no-store` and no stack trace or internal detail in the body.
- [ ] A real browser load of an entry page resolves relative assets (`<img src="images/pic.png">`,
      `<link rel="stylesheet" href="style.css">`) through the injected base tag to the CDN host.
      Verify in browser dev tools that the asset request URL is
      `https://cdn.pages.acme.com/pages/{id}/{rev}/{asset-path}` and that it returns 200 from the
      CDN host, not the Worker host. Root-relative references (`/images/pic.png`) are expected to
      fail because the base tag points to the CDN host (spec §6).

## S13 — Entry-HTML edge cache integration

The cache header contract and purge shape are unit-tested locally; the operator verifies the
real Workers Caching behavior at the edge:

- [ ] `wrangler.toml` contains `[cache] enabled = true` and no `cache.cross_version_cache`
      (deploys start cold per version, which is the accepted default).
- [ ] `GET /{slug}/` on an HTML page returns `Cache-Control: public, max-age=300, stale-while-revalidate=3600`
      and `Cache-Tag: page-{id}`.
- [ ] `GET /p/{id}/` for the same page returns the same `Cache-Tag` value.
- [ ] Image/raw page redirects (`301`) carry the same `Cache-Control` and `Cache-Tag: page-{id}`.
- [ ] A second identical `GET /{slug}/` within `max-age` returns `Cf-Cache-Status: HIT` (or `HIT`
      after the first warm request) and the same body, proving the entry is cached.
- [ ] Publish or edit a page, then immediately request its slug and id URLs; within a short
      propagation window both return the fresh content (no stale entry), confirming
      `ctx.cache.purge({ tags: ["page-{id}"] })` took effect.
- [ ] `GET /admin*` and `/api/*` responses carry `Cache-Control: no-store` and are never served
      from cache (confirm `Cf-Cache-Status` is absent or `BYPASS`/`DYNAMIC` for those paths).
- [ ] The Worker has a single default entrypoint (`src/index.ts` is the only `fetch` export);
      admin mutations and entry pages share it so that `purge()` is entrypoint-scoped.

## S14 — KV-backed JWKS cache

The provider is unit-tested locally with mock JWKS endpoints and a fake KV; the operator
verifies the real Cloudflare Access JWKS endpoint and optional KV behavior:

- [ ] `GET https://{yourteam}.cloudflareaccess.com/cdn-cgi/access/certs` returns a valid JWKS
      JSON object with a `keys` array containing at least one RSA key with a `kid`.
- [ ] With the KV binding provisioned and uncommented in `wrangler.toml`, the first admin/API
      request after a cold start fetches the JWKS and stores it under KV key `access-jwks`.
- [ ] Subsequent admin/API requests within the TTL read the JWKS from KV without re-fetching
      the remote endpoint (confirm via KV read metrics or tail logs).
- [ ] With the KV binding still absent/commented out, the Worker still works: every admin/API
      request fetches the JWKS remotely and serves requests successfully.
- [ ] A key rotation at the Access endpoint is reflected within the TTL bound (1 hour) or sooner
      if the cached value is manually deleted; the provider refetches and overwrites KV.
- [ ] A corrupt/missing `access-jwks` value in KV is treated as a cache miss: the provider
      fetches fresh and overwrites KV.

## S16 — Access JWT verification (defense-in-depth gate)

The JWT gate is fully unit-tested locally with generated keypairs and a mock JWKS. The operator
verifies the real end-to-end Access flow on the deployed Worker:

- [ ] After a successful Cloudflare Access login, `GET /admin` with the `Cf-Access-Jwt-Assertion`
      header returns the admin dashboard (or the placeholder response while S19 is pending).
- [ ] The verified email from the JWT is available to the admin/dashboard code (S19).
- [ ] `GET /admin` and `GET /api/pages` **without** the `Cf-Access-Jwt-Assertion` header return
      `403` JSON `{ error: "Forbidden" }` with `Cache-Control: no-store`.
- [ ] A forged or tampered JWT (e.g., changed payload, invalid signature) returns `403` with the
      same generic error — the Worker never exposes the verification failure reason.
- [ ] An expired Access token (older than the 60-second skew window) returns `403`.
- [ ] A token issued for a different Access application (wrong `aud`) or a different Zero Trust
      team (wrong `iss`) returns `403`.
- [ ] Public routes (`/health`, `/`, `/{slug}/`, `/p/{id}/`) remain reachable without any
      `Cf-Access-Jwt-Assertion` header.
- [ ] With `ACCESS_AUD` unset or still a placeholder (e.g., all zeros), every admin/API request
      fails closed with `403`.

## Pending sections (to be filled by S20/S22)

- Worker custom domain DNS resolution
- Free-tier quota verification
- Reserved-name / traversal CDN 404 behavior (partially covered above; verify live CDN)

See `docs/operations/README.md` for the full provisioning and deploy guide.
