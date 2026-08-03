# 01 — System overview

This is the _built_ shape of the spec's architecture (§2, §3, §5, §11): a single Worker on a
custom domain for entry/admin traffic, an R2 bucket on a second custom domain for asset bytes,
D1 for metadata, Cloudflare Access in front of admin/api, and an optional KV namespace for
caching Access JWKS.

## Topology

```
                          ┌─────────────────────────────────────────────┐
   browser ──┬─ GET pages.acme.com/{slug}/ ──►  Cloudflare Access ──────┐ │
             │                                   (admin* / api* only)  ▼ │
             │                                         ┌────────────────┴───────────────┐
             │                                         │  Worker  (pages.acme.com)       │
             │                                         │  one entrypoint (default)      │
             │                                         │                                │
             │                                         │  router → handlers              │
             │                                         │    public: home/slug/id/health │
             │                                         │            unlock/asset (S23)  │
             │                                         │    admin: /admin UI             │
             │                                         │    api:   /api/* (JWT-gated)   │
             │                                         │                                │
             │                                         │  D1  pages/files/page_unlocks  │
             │                                         │  R2  pages/{id}/{rev}/… write   │
             │                                         │  KV  access-jwks (optional)     │
             │                                         │  ctx.cache.purge on mutations   │
             │                                         └───────────────▲────────────────┘
             │                                           Workers Caching (entry responses
             │                                           cached at the edge, tagged page-{id};
             │                                           protected responses never stored —
             │                                           Cf-Cache-Status: BYPASS)
             │
             └─── GET cdn.pages.acme.com/pages/{id}/{rev}/…  ───►  R2 custom domain
                                                           (CDN serves bytes directly —
                                                           no Worker, no Worker requests)
                                                           NOTE (S23): this path is only
                                                           reachable for non-protected pages —
                                                           protected pages reference the
                                                           Worker origin, never this host
```

- **One Worker, one entrypoint.** All request classes — public, admin UI, admin API — share the
  single default entrypoint of one module Worker. This is a hard constraint: `ctx.cache.purge`
  is scoped to the calling entrypoint (see ADR 0006), and splitting entrypoints would break
  purge-on-publish. Do not add named entrypoints or per-entrypoint cache configuration
  (verified docs: purge modes are per entrypoint).
- **Two custom domains** (§2): the Worker host (`pages.acme.com`) and the R2 CDN host
  (`cdn.pages.acme.com`). Both require `acme.com` to be an active zone in the same account
  (verified docs: custom domains require an active zone and no existing CNAME on the hostname;
  `[[routes]] pattern = "…" custom_domain = true` in wrangler.toml).
- **Cloudflare Access** protects `/admin*` and `/api/*` at the edge (§9). The Worker
  independently verifies the Access JWT on those paths as defense in depth — Access is _not_
  trusted by default inside the Worker (see ADR 0005, fail-closed).
- **KV is optional** (§2, §9): the Worker must work with no KV binding. When present, KV caches
  the Access JWKS with a 1-hour TTL to stay far under the 1,000 writes/day free quota
  (verified pricing).

## Request flows

### Entry request — `GET /{slug}/` or `GET /p/{id}/`

1. Worker runs (Workers Caching miss or stale-within-SWR window; see 04).
2. `classifyPath` (pure) resolves the path to a route; unknown → clean 404 (`no-store`).
3. PagesRepository resolves slug/id → `PageRecord` (`rev`, `entry_path`, kind). Miss → 404.
4. **Password gate (S23, ADR 0041)**: if `page.password_hash !== null` and no valid
   `pl_unlock` cookie → **200 prompt page** (inline HTML, escaped error slot, `no-store`,
   no `Cache-Tag`; entry bytes are never read from R2). With a valid cookie → proceed to
   kind dispatch in the protected variants below.
5. Kind dispatch:
   - `html` / `markdown` / `bundle` → read the entry bytes from R2
     `pages/{id}/{rev}/{entry_path}`, inject the `<base>` tag pointing at the entry file
     itself (serve-time, ADR 0008), return `text/html; charset=utf-8` with entry cache
     headers + `Cache-Tag: page-{id}`. **Protected variant (S23)**: the `<base>` points at
     the **Worker origin** `/assets/pages/{id}/{rev}/{entry_path}` (never
     `config.assetBaseUrl`), and the response is `no-store` with no `Cache-Tag`.
   - `image` / raw single-file → **unprotected:** 301 to
     `{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}`, same caching policy as entry
     responses (the redirect target embeds `rev`, so it is stable per rev; tag purge
     refreshes it on mutation). **Protected:** never redirected — image bytes are served
     from the Worker with their stored content type and `no-store` (for image pages the
     entry URL _is_ the gate).
6. The response is stored by Workers Caching; repeat opens skip D1/R2/CPU
   (spec §3's "repeat opens skip D1/render/CPU"). Protected responses are **never stored**
   (verified: `no-store`/`private` → `Cf-Cache-Status: BYPASS`, Worker runs on every
   request) — protected repeat opens always hit D1+R2 (see §"Why this stays free" below).

### Unlock — `POST /p/{id}/unlock[/]` (S23)

Public route (no Access). Wrong password → **200** re-render of the prompt with the inline
error HTML-escaped. Unknown or unprotected page → 404. Invalid id → 400. Correct password →
set `pl_unlock={pageId}.{token}` (`Path=/; HttpOnly; SameSite=Lax; Secure`), upsert the
SHA-256 token hash row in D1 `page_unlocks`, **303 to `/p/{id}/`** (no `next` param — zero
open-redirect surface). GET → prompt or clean 404; other methods → 405. Every response on
this route is `no-store`. (Details: ADR 0041, 02.)

### Worker asset route — `GET /assets/pages/{id}/{rev}/{path…}` (S23)

Public route (no Access). Serves the stored object bytes from R2 with the stored content
type and `no-store`, for the protected entry's `base` href. Path validation reuses the
write-side rules (decoded `..`, leading `/`, `%`, empty segments → 400; never sibling
keys). Invalid id → 400; non-integer/zero rev → 400 `invalid_rev`; missing object or
malformed percent-encoding → clean 404. No D1 read, no cookie check — asset bytes are
URL-obscured, not individually gated (threat boundary, ADR 0041).

### Asset request — `GET cdn.pages.acme.com/pages/{id}/{rev}/…`

No Worker. The R2 custom domain serves the object with the `httpMetadata` stored at upload
(content type + `Cache-Control: public, max-age=31536000, immutable`; verified: R2 stores and
echoes httpMetadata). URLs are rev-stable and immutable → no purge ever needed for assets
(ADR 0006). The `<base>` tag guarantees every relative reference resolves into this rev folder
(ADR 0008). Missing asset → R2's own default 404 (OQ-07, human decision pending).

### Admin / API — `GET /admin`, `/api/*`

1. Access authenticates at the edge (no in-app login).
2. The Worker's JWT gate verifies `Cf-Access-Jwt-Assertion` (signature vs team JWKS, `iss`,
   `aud`, `exp`; see 02/06). Failure → 403, fail closed (ADR 0005). Unset `ACCESS_AUD` →
   fail closed.
3. Handlers read/write D1 + R2; every mutating handler calls the CacheService purge adapter
   with `{ tags: ["page-{id}"] }` (04 — purge matrix). All admin/api responses are `no-store`.

### Health — `GET /health`

Public, always 200, no bindings dependency beyond the Phase-0 contract; kept as the liveness
probe (§5; S12 AC keeps it).

## Why this stays free at scale (the "1 + 3" model, as built)

- Assets are served by the CDN host: free bandwidth, no egress, **not** Worker requests
  (§3). The Worker only ever sees entry requests (one per page-open) and admin traffic.
- Workers Caching absorbs repeat entry opens (the "1"): 100,000 requests/day on the free plan
  (verified limits) buys ~100k page-opens/day even before caching; cached hits cost no CPU.
- **Protected pages are the exception (S23, R24, accepted):** every entry _and_ asset
  request for a protected page is a billed Worker request (`no-store` → BYPASS, never
  cached), so the free-plan request ceiling is the real cap for protected traffic. The
  admin UI surfaces this with the verbatim notice "All access will bypass the CDN which
  may increase usage." whenever a password is set (ADR 0041).
- Everything else (D1 rows, KV ops, R2 ops) stays within verified free quotas by design:
  index-covered D1 lookups (03), JWKS KV cache with 1h TTL, rev folders sized to personal use
  (OQ-10 — no GC in v1, human decision pending). Protected views add one D1 PK lookup per
  page-open; D1 free reads (5 M rows/day) stay far under the Workers request ceiling.

## Deployments and cache

Each deploy starts with a **cold cache**: the Worker version is part of the Workers Caching key
by default; we do not enable `cache.cross_version_cache` (verified docs). This is acceptable for
a personal publisher (a republish warms in one request) and avoids stale-content-after-deploy
complexity (ADR 0006). `setup.mjs` provisions everything (spec §13); deploying is always a
deliberate, human-run step (`npm run setup` or the manual-dispatch GitHub Actions workflow),
never automated as part of building or testing the code.

## Cross-references

- Spec: §2 architecture, §3 cost/caching, §5 URLs, §6 base tag, §8 storage, §11 serving,
  §12 config, §17 per-page password.
- Docs: [02 — Module boundaries](02-module-boundaries-contracts.md),
  [03 — Data model](03-data-model.md), [04 — Caching & rev](04-caching-rev-model.md).
- ADRs: 0006 (caching/rev), 0008 (base), 0005 (auth fail-closed),
  0041 (S23 password protection — gate, prompt, no-store surface).
