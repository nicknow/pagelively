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
      with `no-store`; with a valid token `/admin` returns the dashboard HTML and `/api/*` returns
      the API responses (S16 + S19).
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
      header returns the admin dashboard HTML.
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

## S15 — Admin API: list & detail

The endpoints are unit-tested locally with the JWT gate; the operator verifies the
live behavior behind Cloudflare Access:

- [ ] `GET /api/pages` without a `Cf-Access-Jwt-Assertion` header returns `403`
      JSON `{ error: "Forbidden" }` with `Cache-Control: no-store`.
- [ ] `GET /api/pages` with a valid Access token returns `200` JSON array with
      `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.
- [ ] Each object in the list contains: `id`, `slug`, `title`, `kind`, `rev`,
      `entry_path`, `raw_md_path`, `show_source`, `visibility`, `created_at`,
      `updated_at`. The list does **not** contain a `files` property.
- [ ] `GET /api/pages/{id}` with a valid token returns `200` JSON with the same
      page fields plus `files: FileRecord[]`.
- [ ] `GET /api/pages/{id}` for an unknown id returns `404` JSON `{ error: "not_found" }`
      with `no-store`.
- [ ] `GET /api/pages/{id}` for an invalid id format (e.g., `bad.id`) returns `400`
      JSON `{ error: "invalid_id" }` with `no-store`.
- [ ] `POST /api/pages` with a valid token returns `201` JSON `{ error: ... }` with `no-store`
      (the upload UI posts to this endpoint; S17).
- [ ] `GET /admin` with a valid token returns the dashboard HTML; `GET /admin/dashboard` returns a
      clean `404` HTML page because it is not a known admin route.

## S20 — Setup and provisioning

The setup script is unit-tested with mocks, but these human-run checks verify the real provisioned state:

- [ ] `npm install` completes with no errors.
- [ ] `CLOUDFLARE_API_TOKEN` is exported (or `wrangler login` has been run) and has the scopes listed in `docs/operations/README.md`.
- [ ] Cloudflare Zero Trust is initialized for the account (`https://one.dash.cloudflare.com/` shows a team name).
- [ ] `npm run setup` completes and prints the Worker URL, admin URL, and CDN URL.
- [ ] `wrangler.toml` contains the real `database_id`, `bucket_name`, `ASSET_BASE_URL`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, and an uncommented `[[kv_namespaces]]` block if KV was created.
- [ ] `wrangler.toml` contains a `[[routes]]` block with `pattern = "pages.example.com"` and `custom_domain = true`.
- [ ] The R2 bucket, D1 database, and (optional) KV namespace exist in the Cloudflare dashboard.
- [ ] A Cloudflare Access application named `{project} admin` exists and protects `pages.example.com/admin*` and `pages.example.com/api/*`.
- [ ] The Access policy allows the admin email(s) provided during setup.
- [ ] The R2 bucket is connected to the CDN domain (`cdn.pages.example.com`) under the bucket's Custom Domains settings.
- [ ] Re-running `npm run setup` is idempotent: no new resources are created, no errors, and it still deploys.
- [ ] If the target zone is removed, re-running `npm run setup` logs a clear "zone not found" error and exits before deploying.

## S22 — End-to-end / DoD closeout (pending)

- [ ] Worker custom domain DNS resolution
- [ ] Free-tier quota verification
- [ ] Reserved-name / traversal CDN 404 behavior (verify live CDN)

## S17 — Upload & publish API

- [ ] `POST /api/pages` with a valid Access token returns `201` JSON with the same page fields
      plus `files: FileRecord[]`.
- [ ] A single `.html` upload creates an `html` page with `entry_path = "index.html"` and the
      file stored under `pages/{id}/1/index.html`.
- [ ] A single `.md` upload creates a `markdown` page with rendered `index.html` and raw
      `source.md` in R2, and `raw_md_path = "source.md"`.
- [ ] A single image upload creates an `image` page with `entry_path = <filename>`.
- [ ] A bundle upload with multiple documents/images and a `manifest.entry` creates a `bundle`
      page with all relative paths preserved under `pages/{id}/1/`.
- [ ] A missing or ambiguous `manifest.entry` when there are multiple candidates returns `400`
      with code `ambiguous_entry`.
- [ ] Auto-generated slugs are derived from the filename; collisions get deterministic `-2`, `-3`
      suffixes.
- [ ] Reserved/invalid slugs return `400` with code `invalid_slug`; user-provided taken slugs
      return `409` with code `slug_conflict`.
- [ ] Files with `../`, leading `/`, `%`, or `\` in the path are rejected with `400`.
- [ ] A request with `Content-Length` above the ~95 MB guard is rejected with `413`.
- [ ] Publishing purges the page's cache tag (`page-{id}`); the entry URL returns fresh content.
- [ ] A D1 write failure after R2 writes does not leave orphaned `pages/{id}/` objects in R2
      (best-effort rollback).

## S18 — Edit & delete API

- [ ] `PATCH /api/pages/{id}` with a valid token updates slug/title/visibility/show_source and
      returns `200` with the page + files. The `rev` does not change.
- [ ] `PATCH /api/pages/{id}` with a taken slug returns `409` `{ error: "slug_conflict" }`.
- [ ] `PATCH /api/pages/{id}` with a reserved slug returns `400` `{ error: "invalid_slug" }`.
- [ ] `PATCH /api/pages/{id}` toggling `showSource` on a Markdown page re-renders `index.html` at
      the same rev (the link to `source.md` appears/disappears) and purges the cache.
- [ ] `POST /api/pages/{id}/files` with a valid token adds a new file, bumps `rev`, and copies
      all existing files to `pages/{id}/{newRev}/`.
- [ ] `POST /api/pages/{id}/files` replacing a Markdown entry re-renders `index.html` +
      `source.md` at the new rev.
- [ ] `DELETE /api/pages/{id}/files/{path}` with a valid token removes a file, bumps `rev`, and
      copies remaining files to the new rev.
- [ ] `DELETE /api/pages/{id}/files/index.html` returns `400` `{ error: "entry_not_deletable" }`
      for document pages.
- [ ] `DELETE /api/pages/{id}/files/{image-filename}` returns `400` `{ error: "entry_not_deletable" }`
      for image pages.
- [ ] `DELETE /api/pages/{id}` returns `204`, removes the `pages` row and `files` rows, and
      deletes all objects under `pages/{id}/`.
- [ ] All S18 endpoints return `403` `{ error: "Forbidden" }` without a valid token.
- [ ] A D1 write failure after R2 writes for file add/replace/delete removes the partial new-rev
      folder best-effort.

## S19 — Admin UI (buildless dashboard/upload/edit)

The UI is unit-tested for HTML structure and index.ts dispatch; the operator verifies the live
end-to-end flows behind Cloudflare Access:

- [ ] After a successful Access login, `GET /admin` returns `200` HTML with `Cache-Control: no-store`
      and `Content-Type: text/html; charset=utf-8`.
- [ ] The dashboard shows the product name "Pagelively" and the verified email address from the
      Access JWT.
- [ ] The dashboard lists existing pages (id, title, slug, kind, created_at, visibility) with
      working View, Edit, and Delete links.
- [ ] When no pages exist, the dashboard shows an "Upload your first page" CTA that links to
      `/admin/upload`.
- [ ] `GET /admin/upload` returns a form with file input (`multiple` + `webkitdirectory`), slug,
      title, visibility radios, show-source checkbox, and an entry picker that appears when the
      entry is ambiguous.
- [ ] Uploading a single `.html` file creates a page; the browser is redirected back to `/admin`.
- [ ] Uploading a single `.md` file creates a Markdown page; the show-source checkbox toggles the
      `source.md` link in the rendered page.
- [ ] Uploading a folder with multiple files (one `.html` entry) preserves relative paths and the
      page is served correctly.
- [ ] Uploading multiple entry candidates without selecting the entry shows an inline error from
      the API (`ambiguous_entry`).
- [ ] `GET /admin/edit/:id` pre-fills slug, title, visibility, and show-source, lists the current
      files, and allows deleting individual files (with confirmation) or updating metadata.
- [ ] Replacing a Markdown entry file or toggling show-source re-renders the page and the change is
      visible at the slug/id URL after a short cache-propagation window.
- [ ] The Delete page button removes the page and all its files from R2 and D1; the slug/id URLs
      return 404.
- [ ] `GET /admin/edit/:id` for a non-existent page returns a 404 page.
- [ ] All admin UI responses carry `Cache-Control: no-store` and no admin UI path is reachable
      without a valid Access token.

## Pending sections (to be filled by S20/S22)

- Worker custom domain DNS resolution
- Free-tier quota verification
- Reserved-name / traversal CDN 404 behavior (partially covered above; verify live CDN)

See `docs/operations/README.md` for the full provisioning and deploy guide.
