# Operator smoke-test checklist

Run this checklist against your real deployment after `npm run setup` (or any time you want to
confirm a live instance is fully working). It covers the infrastructure seams that can't be
unit-tested locally — R2 CDN public serving, live Cloudflare Access, custom domains, and real
edge-cache hits — none of which are faked in the automated test suite; they're verified here
against the real deployment instead.

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
- [ ] `GET /hello/` on an html page returns the entry HTML with `<base href="{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}">`
      (e.g. `.../index.html`) injected as the first element of `<head>`.
- [ ] `GET /p/{id}/` returns the same page by canonical id, with the same base tag.
- [ ] Image pages return `301` to `{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}` with
      `Cache-Control: public, max-age=300, stale-while-revalidate=3600` and `Cache-Tag: page-{id}`.
- [ ] Markdown pages serve the stored rendered HTML with the same base tag and `text/html; charset=utf-8`.
- [ ] Unknown slugs, unknown ids, and unknown paths return the clean 404 page with `no-store`.
- [ ] `/admin*` and `/api/*` without a valid Access token return `403` JSON
      `{ error: "Forbidden", message: "Forbidden" }`
      with `no-store`; with a valid token `/admin` returns the dashboard HTML and `/api/*` returns
      the API responses (S16 + S19).
- [ ] Internal failures (e.g., D1 unavailable) return `500` JSON
      `{ error: "db_read_failed", message: "Database read failed." }`
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
      `403` JSON `{ error: "Forbidden", message: "Forbidden" }` with `Cache-Control: no-store`.
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
      JSON `{ error: "Forbidden", message: "Forbidden" }` with `Cache-Control: no-store`.
- [ ] `GET /api/pages` with a valid Access token returns `200` JSON array with
      `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.
- [ ] Each object in the list contains: `id`, `slug`, `title`, `kind`, `rev`,
      `entry_path`, `raw_md_path`, `show_source`, `visibility`, `created_at`,
      `updated_at`. The list does **not** contain a `files` property.
- [ ] `GET /api/pages/{id}` with a valid token returns `200` JSON with the same
      page fields plus `files: FileRecord[]`.
- [ ] `GET /api/pages/{id}` for an unknown id returns `404` JSON
      `{ error: "not_found", message: "Page not found." }`
      with `no-store`.
- [ ] `GET /api/pages/{id}` for an invalid id format (e.g., `bad.id`) returns `400`
      JSON `{ error: "invalid_id", message: "Invalid page id." }` with `no-store`.
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
- [ ] **Team domain resolution:** with `SETUP_ACCESS_TEAM_DOMAIN` unset and a token that has
      "Access: Organizations, Identity Providers, and Groups: Read", setup resolves
      `ACCESS_TEAM_DOMAIN` in `wrangler.toml` from the organizations endpoint without
      prompting. With that scope missing (or the token revoked from it), setup must NOT crash —
      it falls back to the interactive "Zero Trust team domain" prompt.
- [ ] **Headless team domain:** run setup with `SETUP_NON_INTERACTIVE=1` and
      `SETUP_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com` — it proceeds without prompting.
      Omit the env var (and the org scope) and the run fails with an error naming
      `SETUP_ACCESS_TEAM_DOMAIN`.
- [ ] **OAuth-only path fails at Access, as expected (confirmed live, see
      `docs/operations/README.md` "Token vs interactive auth"):** with `CLOUDFLARE_API_TOKEN`
      unset, run `npm run setup` interactively; after `wrangler login` opens the browser and you
      authorize, the run fails when it lists/creates Access apps — Wrangler's OAuth login has no
      Access/Zero Trust scope, so this is expected, not a bug to chase. This item exists as a
      regression check: confirm the failure still happens and still points at
      `CLOUDFLARE_API_TOKEN` as the fix, rather than resurfacing as a confusing raw HTTP error.
      (You can still confirm `wrangler login` itself completed: the plaintext token file should
      exist at `~/.config/.wrangler/config/default.toml` on Linux,
      `~/Library/Preferences/.wrangler/config/default.toml` on macOS, or
      `%APPDATA%\xdg.config\.wrangler\config\default.toml` on Windows, containing
      `oauth_token = "..."`.) Then set `CLOUDFLARE_API_TOKEN` and re-run to actually complete
      provisioning.
- [ ] **Keyring fail-fast (ADR 0033):** after `wrangler login --use-keyring`, re-run `npm run setup` with no `CLOUDFLARE_API_TOKEN`; it must fail immediately with the "Found an encrypted wrangler OAuth credential… re-run `wrangler login --no-use-keyring`" message (never a confusing HTTP 400). Then run `wrangler login --no-use-keyring` and confirm setup succeeds.
- [ ] `wrangler.toml` contains the real `database_id`, `bucket_name`, `ASSET_BASE_URL`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, and an uncommented `[[kv_namespaces]]` block if KV was created.
- [ ] `wrangler.toml` contains a `[[routes]]` block with `pattern = "pages.example.com"` and `custom_domain = true`.
- [ ] The R2 bucket, D1 database, and (optional) KV namespace exist in the Cloudflare dashboard.
- [ ] A Cloudflare Access application named `{project} admin` exists with primary `domain` = `pages.example.com/admin` and `destinations` exactly `pages.example.com/admin` and `pages.example.com/api` (the bare hostname must NOT appear — that scopes the app to the whole domain).
- [ ] **Access path-scope regression (field fix 2026-08-01):** in a real browser, `https://pages.example.com/sadds-sdsd/` (an arbitrary public URL) and an asset on the CDN host load with **no** Access login prompt, while `https://pages.example.com/admin` and `https://pages.example.com/api/pages` DO prompt for Access. If public URLs prompt, the app is whole-domain-scoped; re-run `npm run setup` to reconcile it in place (the app id and `ACCESS_AUD` stay the same).
- [ ] The Access policy allows the admin email(s) provided during setup.
- [ ] The R2 bucket is connected to the CDN domain (`cdn.pages.example.com`) under the bucket's Custom Domains settings.
- [ ] Re-running `npm run setup` is idempotent: no new resources are created, no errors, and it still deploys.
- [ ] If the target zone is removed, re-running `npm run setup` logs a clear "zone not found" error and exits before deploying.
- [ ] **Multi-domain isolation (v1.1.0):** after deploying a second domain with a distinct `projectName`, verify that the two deployments are fully independent: navigate to both admin dashboards and publish a test page on each; confirm each domain serves its own content, has its own R2 bucket (check the Cloudflare dashboard → R2), and has its own Access application (Cloudflare dashboard → Zero Trust → Access → Applications). A page published on one domain must not appear on the other.
- [ ] **Collision guard triggers correctly:** run `npm run setup` with the same `projectName` as an existing deployment but a different `workerDomain`/`cdnDomain`. The script must abort with the multi-domain collision error before modifying any resources.
- [ ] **`SETUP_ALLOW_REPOINT` override:** run the same collision-test scenario with `SETUP_ALLOW_REPOINT=1` set; the script must proceed and repoint the existing resources at the new domain.
- [ ] **Covering-zone resolution:** a subdomain worker/CDN domain (e.g. `n.3a8r.com` /
      `cdn.n.3a8r.com` under the `3a8r.com` zone) provisions successfully and setup logs
      `Resolved zone for <domain>: 3a8r.com`. A domain with no covering zone in the account
      logs a clear error and stops before deploying (no throw, exit 0).
- [ ] **R2 not enabled (error `[10042]`):** on an account without R2, setup fails with
      "R2 is not enabled on this Cloudflare account. Enable it in the Cloudflare dashboard
      (R2 > Overview), then re-run." — not a bare HTTP status.
- [ ] **D1 permission missing (error `[10000]`):** with a token lacking D1, setup fails with
      "The Cloudflare API token is missing the D1 permission. Add Account → D1: Edit …" —
      not a bare HTTP status.

## S21 — GitHub Actions deploy (headless path)

The workflow and headless failures are unit-tested with mocks; these checks verify the real
GitHub Actions run against the operator's account:

- [ ] The three repo secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_EMAILS`)
      exist and the manual-dispatch run (Actions → "Deploy Pagelively to Cloudflare" → Run
      workflow) completes with exit 0 and prints the Worker/admin/CDN URLs.
- [ ] A workflow run with a deliberately invalid token fails fast with the
      "No CLOUDFLARE_API_TOKEN found" / API error and does **not** hang waiting for input
      (headless never prompts, never opens a browser).
- [ ] If Zero Trust is not initialized, the run prints the one-time steps
      (`one.dash.cloudflare.com`) and fails the job (non-zero exit) — it does not pause or
      deploy.
- [ ] **Known limitation (ADR 0030):** if the worker or CDN domain is not a zone in the
      account, the run logs a "zone not found" error but the job still **exits 0** without
      deploying. Check the workflow log for this message before assuming success.
- [ ] The workflow is manual-dispatch only: it is not listed under push/PR-triggered checks
      (no `on.push`/`on.pull_request`), so it never runs without a human clicking Run.

## S22 — End-to-end / DoD closeout (completed during S22)

The **local** half of the end-to-end journey is automated: `test/e2e.test.ts` runs the full
loop (health → fail-closed gate → publish → home mode → trailing-slash redirect → serve with
base tag → nested-asset bundle → admin UI → metadata edit → rev-bump file replace/delete →
page delete → home 404) against the emulated Worker, and `test/build-size.test.ts` gates the
bundle against the free-tier size limits. The checks below are the **live** half that local
emulation cannot prove (test standards #5 — infra seams are never faked). Run them once
after the first real deploy, in order. Quota numbers below are re-verified 2026-08-01
(citations in ADR 0031 and roadmap §6); re-verify before relying on them again.

### Worker custom domain DNS resolution

- [ ] `wrangler.toml` has a `[[routes]]` block with `pattern = "pages.example.com"` and
      `custom_domain = true` for the Worker domain, and the same for the CDN domain
      (`setup.mjs` writes both). Custom Domains create the DNS record and issue the
      certificate automatically — no manual DNS edits (verified Cloudflare behavior).
- [ ] In the Cloudflare dashboard → DNS, a proxied record exists for each custom domain,
      created by the domain attach (not a pre-existing CNAME — custom domains cannot be
      attached over an existing CNAME record).
- [ ] `dig +short pages.example.com` and `dig +short cdn.pages.example.com` resolve
      (proxied → Cloudflare anycast addresses) once the records propagate (typically
      seconds to a minute).
- [ ] `curl -sI https://pages.example.com/health` returns `200` with a valid TLS
      certificate (issuance takes a few minutes on first attach) and the
      `{ok:true,…}` liveness JSON — the Worker is reachable on its own domain.
- [ ] `curl -sI https://cdn.pages.example.com/` returns the **R2 bucket's** own response
      (empty bucket → bucket 404) — proof the CDN domain is wired to the bucket, and the
      Worker is not in the asset path.
- [ ] The entry page loads over `https://` without mixed-content warnings: relative asset
      references resolve through the injected `<base>` tag to the CDN host (spec §6).

### Free-tier quota verification

These are limits, not expected usage — the checks confirm the deployment sits far below
them and that the dashboard surface exists to watch them.

- [ ] **Workers requests — 100,000/day** (Free; Error 1027 beyond): Workers → analytics
      after a normal traffic day shows a small fraction of the daily ceiling; entry-HTML
      caching (S13) keeps Worker-host requests to one per entry page per cache window.
- [ ] **Worker size — 3 MB compressed / 64 MB raw** (Free): the deploy output prints
      `Total Upload: … KiB / gzip: … KiB`; confirm it matches the gate in
      `test/build-size.test.ts` (currently ~146 KiB raw / ~35 KiB gzip — ADR 0031).
- [ ] **R2 — 10 GB-month storage, 1 M Class A + 10 M Class B ops/month, egress free**:
      dashboard → R2 → bucket usage after a normal day; asset bytes are CDN-served
      (no egress cost) and rev-folders grow slowly for a single-user site (OQ-10: no v1 GC).
- [ ] **D1 — 5 M rows read / 100 k rows written per day, 5 GB storage**: dashboard → D1 →
      database → Metrics > Row Metrics after a normal day; public reads are index-covered
      (S10) and a publish writes a handful of rows — expect counts in the low hundreds at
      most for a personal site.
- [ ] **KV (optional, JWKS cache only)** — well within the 100 k reads/day free allowance
      (roadmap §6, verified 2026-07-30): confirm the KV namespace shows negligible usage.
- [ ] **Workers memory (128 MB) / CPU (10 ms)** ceilings: no `exceededMemory` /
      `exceededCpu` invocations in Workers analytics after the first day (small bundle,
      single entry-point rendering).

### Reserved-name / traversal CDN 404 behavior (live CDN)

- [ ] Traversal-ish requests against the **CDN host** return the bucket's own 404 and never
      resolve to a sibling key: `https://cdn.pages.example.com/pages/{id}/{rev}/../…` and
      `…/%2e%2e/…` variants (ADR 0012, S03; the Worker is not in the asset path, so only the
      bucket answers).
- [ ] The same traversal-ish paths against the **Worker host**
      (`https://pages.example.com/pages/{id}/{rev}/../…`, `/p/{id}/..`) return the clean
      404 page with `Cache-Control: no-store` (router classifies them `unknown`; S08).
- [ ] Literal-`%` filenames never reach the bucket: `POST /api/pages` with a `%` filename
      returns `400 { error: "invalid_filename", message: "Percent signs are not allowed in filenames: \"<name>\"." }`
      (S17) and no such key exists in R2 (the
      edge would percent-decode the path and the lookup would miss — unservable).
- [ ] Reserved slugs are rejected end-to-end: `POST /api/pages` with slug `admin`, `api`,
      `assets`, `health`, `p`, `robots.txt`, `sitemap.xml`, `favicon.ico`, or a
      `_`-prefixed name returns `400 { error: "invalid_slug", message: "\"<name>\" is a reserved name and cannot be used as a slug." }`
      behind Access (the local
      journey asserts the API path; the live check confirms the same response with the real
      token), and the upload UI surfaces the API error to the operator.

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
- [ ] `POST /api/pages` with `Content-Type: application/json` and
      `{ content: "<h1>Hi</h1>", format: "html" }` creates an `html` page, stores one
      `index.html` file, and serves it at the slug (OQ-17/T4).
- [ ] `POST /api/pages` with `Content-Type: application/json` and
      `{ content: "# Hi", format: "markdown", showSource: true }` creates a `markdown` page,
      renders `index.html` with a `source.md` link, and stores the raw `source.md` (OQ-17/T4).
- [ ] JSON paste supports the same manifest fields as multipart: `slug`, `title`, `visibility`, and
      `showSource`; invalid/missing `content`, missing/invalid `format`, and content > 1 MB return
      `400`/`413` with codes `invalid_json`, `invalid_content`, `invalid_format`, or
      `content_too_large` (OQ-17/T4).
- [ ] The `/admin/upload` page has a **Paste content** tab with a textarea, HTML/Markdown format
      radio (Markdown default), and a Publish button; it posts JSON to `/api/pages` and shows
      API errors in the same error box as the file upload form.
- [ ] The UI prevents a mixed submission: when both files are selected and paste content is
      entered, the active Publish/Upload button surfaces an error instead of submitting.

## S18 — Edit & delete API

- [ ] `PATCH /api/pages/{id}` with a valid token updates slug/title/visibility/show_source and
      returns `200` with the page + files. The `rev` does not change.
- [ ] `PATCH /api/pages/{id}` with a taken slug returns `409`
      `{ error: "slug_conflict", message: "Slug \"<slug>\" is already taken." }`.
- [ ] `PATCH /api/pages/{id}` with a reserved slug returns `400`
      `{ error: "invalid_slug", message: "\"<name>\" is a reserved name and cannot be used as a slug." }`.
- [ ] `PATCH /api/pages/{id}` toggling `showSource` on a Markdown page re-renders `index.html` at
      the same rev (the link to `source.md` appears/disappears) and purges the cache.
- [ ] `POST /api/pages/{id}/files` with a valid token adds a new file, bumps `rev`, and copies
      all existing files to `pages/{id}/{newRev}/`.
- [ ] `POST /api/pages/{id}/files` replacing a Markdown entry re-renders `index.html` +
      `source.md` at the new rev.
- [ ] **Known defect (found 2026-08-04, not yet fixed):** `POST /api/pages/{id}/files`
      replacing `source.md` on a **bundle**-kind page whose entry is Markdown does NOT
      re-render `index.html` — the new Markdown is saved but the old rendered HTML keeps
      serving (silent staleness). `isEntryReplacement`/`prepareEntryFiles` in `src/admin-api.ts`
      key off `page.entry_path`/`isMarkdownPath(page.entry_path)` instead of
      `page.raw_md_path !== null` (the check `servedEntryPath` already uses correctly). Confirm
      this is fixed before relying on bundle+Markdown entry replacement in production.
- [ ] `DELETE /api/pages/{id}/files/{path}` with a valid token removes a file, bumps `rev`, and
      copies remaining files to the new rev.
- [ ] `DELETE /api/pages/{id}/files/index.html` returns `400`
      `{ error: "entry_not_deletable", message: "..." }` for document pages.
- [ ] `DELETE /api/pages/{id}/files/source.md` returns `400`
      `{ error: "entry_not_deletable", message: "..." }` for Markdown pages.
- [ ] `DELETE /api/pages/{id}/files/{image-filename}` returns `400`
      `{ error: "entry_not_deletable", message: "..." }` for image pages.
- [ ] The `entry_not_deletable` message is actionable: it names the protected
      entry file(s) and instructs the operator to delete the whole page via the
      **Delete page** button.
- [ ] `GET /admin/edit/{id}` does not show a Delete button for protected entry files
      (`index.html`/`source.md` for Markdown, `index.html` for HTML, the image file for image
      pages) but does show Delete buttons for other files, and it shows the hint
      "Rendered page files are protected — use Delete page above to remove the page.".
- [ ] `DELETE /api/pages/{id}` returns `204`, removes the `pages` row and `files` rows, and
      deletes all objects under `pages/{id}/`.
- [ ] All S18 endpoints return `403` `{ error: "Forbidden", message: "Forbidden" }` without a
      valid token.
- [ ] A D1 write failure after R2 writes for file add/replace/delete removes the partial new-rev
      folder best-effort.

## S19 — Admin UI (buildless dashboard/upload/edit)

The UI is unit-tested for HTML structure and index.ts dispatch; the operator verifies the live
end-to-end flows behind Cloudflare Access:

- [ ] After a successful Access login, `GET /admin` returns `200` HTML with `Cache-Control: no-store`
      and `Content-Type: text/html; charset=utf-8`.
- [ ] The dashboard shows the product name "Pagelively" and the verified email address from the
      Access JWT.
- [ ] The dashboard lists existing pages with kind badges (`html`, `markdown`, `image`, `bundle`) and
      visibility badges (`public`, `unlisted`), plus working View, Edit, and Delete links.
- [ ] When no pages exist, the dashboard shows a friendly empty state and an "Upload your first page"
      CTA that links to `/admin/upload`.
- [ ] The layout is responsive: on a narrow viewport, the dashboard table becomes readable stacked
      cards and form controls remain usable.
- [ ] `GET /admin/upload` returns a form with two distinct tabs: **Upload files** and
      **Paste content**. The active tab is visually highlighted and the shared error box is hidden
      when switching tabs.
- [ ] The upload tab has a `multiple`-only files input (`#files`), a separate folder input
      (`#folder`, `webkitdirectory`), slug, title, visibility radios, show-source checkbox, and an
      entry picker that appears when the entry is ambiguous.
- [ ] Typing a slug in the upload or edit form shows a live preview (e.g., `URL: /my-page/`) below
      the slug input.
- [ ] Uploading a single `.html` file creates a page; the browser is redirected back to `/admin`.
- [ ] Uploading a single `.md` file creates a Markdown page; the show-source checkbox toggles the
      `source.md` link in the rendered page.
- [ ] Uploading a folder with multiple files (one `.html` entry) preserves relative paths and the
      page is served correctly.
- [ ] Admin → Upload: with both the loose-files picker and the folder picker in use, a deploy
      succeeds (validates the files + folder union end-to-end in a real browser).
- [ ] Uploading multiple entry candidates without selecting the entry shows an inline error from
      the API (`ambiguous_entry`).
- [ ] The paste tab has a textarea, HTML/Markdown format radios (Markdown default), the same
      slug/title/visibility/show-source fields, and a Publish button that posts JSON to `/api/pages`.
- [ ] API errors from the upload/paste forms and the edit metadata/add-files forms are shown in a
      styled error box (not a browser `alert`).
- [ ] `GET /admin/edit/:id` pre-fills slug, title, visibility, and show-source, lists the current
      files, and allows deleting individual files (with confirmation) or updating metadata.
- [ ] In the edit page file list, entry files (`index.html` and `source.md` for Markdown pages, the
      image file for image pages) display a **Protected** badge and have no per-file Delete button;
      non-entry files still show a Delete button.
- [ ] API errors from delete actions (file delete, page delete, dashboard page delete) are shown as
      a non-blocking toast notification. Destructive actions still use a browser `confirm()` prompt.
- [ ] Replacing a Markdown entry file or toggling show-source re-renders the page and the change is
      visible at the slug/id URL after a short cache-propagation window.
- [ ] The Delete page button removes the page and all its files from R2 and D1; the slug/id URLs
      return 404.
- [ ] `GET /admin/edit/:id` for a non-existent page returns a 404 page.
- [ ] All admin UI responses carry `Cache-Control: no-store` and no admin UI path is reachable
      without a valid Access token.

## Pending sections

None — all sections through S22 are complete.

See `docs/operations/README.md` for the full provisioning and deploy guide.

## S23 — Per-page password protection (added during validation of S23-C)

The protected surface (`/p/{id}/unlock`, `/assets/...`, the prompt, and the unlocked entry) is
exercised by unit tests against workerd, but these live checks cover the seams those can't: real
Cloudflare Access placement, the real R2 CDN host, and real edge caching. Run against the real
deployment (S23-C AC 1–11; ADR 0041).

Publish a page with a password set, plus one public page with an image. Replace `{id}` below with
the protected page's id.

- [ ] Locked prompt: `curl https://pages.acme.com/p/{id}/` returns `200`, `text/html; charset=utf-8`,
      `Cache-Control: no-store`, and **no** `Cache-Tag` header; the body is the prompt ("This page is
      password protected.") and contains **no** page title/content and **no** CDN host string.
- [ ] Repeated prompt requests re-render every time (no edge cache): `Cf-Cache-Status` is
      `BYPASS` (per Cloudflare docs for `no-store` responses; if the live edge reports
      `DYNAMIC` or absent, that is also acceptable) on every hit — never `HIT`.
- [ ] The prompt form posts to `/p/{id}/unlock` (no Access challenge: unlock is public, before the
      Access gate — a plain `curl -X POST … -d password=…` without a `CF-Authorization` header
      works; it must NOT 403).
- [ ] Wrong password: `curl -X POST https://pages.acme.com/p/{id}/unlock -H 'Content-Type:
application/x-www-form-urlencoded' --data 'password=wrong'` returns `200` with an inline
      escaped "Incorrect password." error and **no** `Set-Cookie`.
- [ ] Correct password in a real browser: submit the form → `303` to `/p/{id}/`; the browser stores
      the `pl_unlock` cookie (`HttpOnly`, `SameSite=Lax`, `Secure`) and the entry renders with
      `<base href="https://pages.acme.com/assets/pages/{id}/{rev}/index.html">` (Worker origin —
      the CDN host never appears in the HTML).
- [ ] Relative assets in a protected entry resolve through the base href and are served by the
      Worker (`/assets/pages/{id}/{rev}/...` → `200` + `no-store`, `Cf-Cache-Status: BYPASS`
      per Cloudflare docs for `no-store`; `DYNAMIC`/absent is also acceptable — never `HIT`),
      not by the CDN.
- [ ] Asset URLs never redirect: `/assets/pages/{id}/{rev}/...` returns bytes with no `Location`
      header; `/p/{id}/unlock` returns `200` with no `Location`.
- [ ] Rotation: unlocking the page again in a second browser (or after deleting cookies) issues a
      new cookie; the previous cookie no longer unlocks the page (prompt instead of entry).
- [ ] Public pages are unchanged: a public page's image still `301`s to the CDN host
      (`cdn.pages.acme.com/pages/{id}/{rev}/...`) and its HTML keeps `Cache-Control:
public, max-age=300, stale-while-revalidate=3600` with a `Cache-Tag: page-{id}`; the prompt
      never appears for it.
- [ ] Access still gates admin: `/admin` and `/api/pages` require a valid Access JWT (`403` /
      `Forbidden` JSON without one) while the protected surface stays open.
- [ ] No cache pollution after setting/clearing a password: republish a page after removing its
      password — the public entry (with CDN base href + Cache-Tag) is served, not a stale cached
      protected prompt; setting a password makes the public entry unreadable immediately (purge
      `page-{id}` works).
- [ ] Hostile inputs against the live edge: a garbage `pl_unlock=...` cookie, a `Cookie: pl_unlock`
      with no value, and an unlock POST with a non-form `Content-Type` (`application/json`,
      `text/plain`) all return clean responses (prompt/typed 4xx), never a `500
{"error":"internal_error"}`. Regression canary (S23-C validator probes A–D): a
      `Content-Type: application/json` unlock POST must return a typed `400 {"error":
"invalid_form_data", ...}` with `Cache-Control: no-store` and no `Cache-Tag`; same for a
      `multipart/form-data` POST whose boundary does not appear in the body, and for a POST with
      no Content-Type at all. A valid       `multipart/form-data` unlock POST must still `303` (the
      guard is not over-broad).

## Listing page UI (upload and paste forms)

- [ ] The upload form has a "Page kind" radio with Regular/Listing options; selecting Listing shows "Match tags" input and hides content/entry/tag fields; selecting Regular restores them.
- [ ] The paste form has the same "Page kind" radio with the same toggle behavior.
- [ ] Creating a listing page (Listing kind + match tags) via upload and visiting its URL shows a dynamic list of matching public pages.
- [ ] Creating a listing page via the paste form works the same way.
- [ ] Editing a listing page shows the "Match tags" input pre-filled; changing it updates the listing content on save.
- [ ] Editing a regular page does not show the "Match tags" input.
