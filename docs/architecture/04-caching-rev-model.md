# 04 — Caching & `rev` model

The spec's §11 "Cache API + `s-maxage` + SWR" description contradicts current platform
semantics (verified: `s-maxage`/`must-revalidate`/`proxy-revalidate` disable
stale-while-revalidate per RFC 9111 §4.2.4, and the Cache API has no SWR). OQ-01 resolved this:
**Workers Caching** (`[cache] enabled = true` + `Cache-Control` + `Cache-Tag` +
`ctx.cache.purge`). This document is the working model; ADR 0006 records the decision, ADR 0009
the testability seam.

## Configuration

- `wrangler.toml` gains (in S13, with `npm run types`):
  ```toml
  [cache]
  enabled = true
  ```
  Requires Wrangler ≥ 4.69.0 (verified; we run 4.116.0). Workers Caching applies to every
  `fetch()` invocation of the Worker; the entire configuration surface is the flag + response
  headers (verified docs).
- `cache.cross_version_cache` stays **off** (default): each deploy starts cold, which is
  acceptable for a personal publisher and avoids stale-content-after-deploy handling (verified
  docs: version is part of the cache key by default).
- **No per-entrypoint cache config**: one default entrypoint, caching enabled everywhere
  (admin/api are excluded by `no-store`, not by config). Purge is entrypoint-scoped, so the
  admin handlers' purges reach the entry responses they share an entrypoint with (verified
  docs: purge modes are per entrypoint) — this is why the "one entrypoint" rule in 01 is a
  hard constraint.

## Route-class header policy

| Route class                         | Response                                                                                   | `Cache-Control`                                                | `Cache-Tag` | Stored?        |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ----------- | -------------- |
| Entry (`/{slug}/`, `/p/{id}/`, `/`) | HTML with injected `<base>`                                                                | `public, max-age=300, stale-while-revalidate=3600`             | `page-{id}` | Yes            |
| Image/raw 301 (→ CDN object)        | 301 redirect                                                                               | `public, max-age=300, stale-while-revalidate=3600`             | `page-{id}` | Yes            |
| Assets (R2 CDN host)                | object bytes                                                                               | `public, max-age=31536000, immutable` (stored as httpMetadata) | —           | Yes (CDN host) |
| Protected (S23, ADR 0041)           | prompt / unlocked entry / protected image bytes / worker asset bytes / unlock 303 & errors | `no-store`                                                     | —           | **No**         |
| Admin UI + API                      | HTML/JSON                                                                                  | `no-store`                                                     | —           | No             |
| 404 (Worker host)                   | clean 404                                                                                  | `no-store`                                                     | —           | No             |
| 500                                 | generic error                                                                              | `no-store`                                                     | —           | No             |

Notes:

- **Never emit `s-maxage`, `must-revalidate`, or `proxy-revalidate` on cacheable responses** —
  any of them kills SWR (verified docs; S07 AC asserts this). The entry freshness window is
  `max-age=300` with a 1-hour SWR tail: repeat opens inside 5 min skip the Worker entirely
  (HIT), stale opens for up to 1 h are served immediately while revalidation runs
  (UPDATING), then a fresh Worker response replaces them (verified: SWR is asynchronous).
- **Protected responses are never stored** (S23): `no-store` (and, on the unlock 303, the
  `Set-Cookie` header) make Workers Caching bypass the response entirely — verified
  `Cf-Cache-Status: BYPASS` for `no-store`/`private`, and bypass when a response carries
  `Set-Cookie`. Consequences: (1) a password change can never leave a stale protected copy at
  the edge — the `page-{id}` purge on password change only needs to evict the **pre-protection
  public** entry; (2) every protected request runs the Worker — the accepted S23 cost
  (R24), surfaced to admins by the verbatim CDN-bypass notice; (3) the stale-on-error
  fallback below does **not** apply to protected pages — a Worker failure surfaces as an
  error, never a stale protected page, which is the correct security posture.
- **Assets are immutable by URL construction** (`{rev}` in the path): `max-age=31536000,
immutable`, and republish changes the URL so no purge is ever needed for asset bytes
  (spec §11; ADR 0006). The CDN host is R2's public-bucket custom domain; note (verified) that
  by default only certain file types are cached by the zone CDN — non-default asset types
  (e.g. fonts) may need a Cache Everything rule, which is an **operator checklist item**, not
  something the build can fix locally (OQ-07-adjacent; see 06).
- **Admin/API `no-store`** per spec §11; Access-fronted admin responses must never be cached.
- **Worker 404s are `no-store`** (architecture decision, 05): a cached 404 could outlive a
  page creation with the same slug (untagged — no id to purge by), and 404 traffic is trivial
  at personal scale. Correctness wins.
- The 301 redirect is cacheable _with_ the page tag: its target embeds `rev`, so it's stable
  per rev, and tag purge refreshes it on mutation. Caching it keeps repeat image-page opens
  off the Worker (§3's "repeat opens skip CPU").

## The purge matrix (which mutation purges what)

`ctx.cache.purge({ tags: ["page-{id}"] })` (or `cache.purge` imported from
`cloudflare:workers` — identical; ADR 0009 picks the `ctx` form inside CacheService). Purge
matches **case-insensitively** and clears every cached response carrying the tag — and since
both `/{slug}/` and `/p/{id}/` responses carry `page-{id}`, **one tag purge refreshes both
URLs** (cache key = path + entrypoint + version; host is not part of the key — verified).

| Admin action                            | D1/R2 effect                                                                 | Rev bump?                   | Purge                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------- |
| Create page                             | rows + rev-1 folder                                                          | (rev = 1)                   | `page-{id}` (harmless no-op until first hit)                                                    |
| PATCH slug/title/visibility/show_source | rows only                                                                    | **No**                      | `page-{id}` (refreshes entry HTML under old _and_ new slug URLs)                                |
| **Set/clear password (S23)**            | `pages.password_hash` + **delete `page_unlocks` row** (existing cookies die) | **No** (`password-edit`)    | `page-{id}` — evicts the pre-protection **public** entry; protected responses were never stored |
| Add/replace file(s)                     | new rev folder, rows re-pointed                                              | **Yes**                     | `page-{id}` (entry HTML + 301)                                                                  |
| Delete a file                           | object + row removed; entry re-served                                        | **Yes** (content-affecting) | `page-{id}`                                                                                     |
| Delete page                             | rows (cascade, incl. page_unlocks) + all objects                             | —                           | `page-{id}`                                                                                     |
| Re-render markdown (future, OQ-13)      | rewrite/bump + render                                                        | Yes                         | `page-{id}`                                                                                     |

- Purge is **post-write and non-fatal**: the mutation is already committed; a purge failure is
  logged, not surfaced as a 500 (S13 AC; stale-for-SWR-window max is bounded by headers).
- Read-only routes never purge. Purge rate limits are those of the zone purge API (verified) —
  a handful of purges per mutation at personal scale is trivially within them.
- Deploy purge: none needed (cold cache per deploy; verified).

## The `rev` model (ADR 0006/OQ-04)

- `rev` starts at 1 and increments by 1 per content-affecting publish: `nextRev(n) = n + 1`.
- **Bump policy** — `shouldBumpRev` is true only for: file add/replace, file delete, entry
  change, markdown (re-)render. False for: slug/title/visibility/show_source/password
  edits (`password-edit` added for S23 — the `page-{id}` purge covers protection changes, and
  protected responses are never stored, so no cache-busting is needed for them).
  Implemented in S03 with the concrete `RevAction` union and fail-fast throws; the
  ADR-0006-vs-this-matrix conflict over "slug PATCH bumps" is reconciled in favor of
  **no bump** — see ADR 0012.
  Rationale: metadata edits are invalidated by tag purge at zero storage cost; bumping them
  would copy the whole rev folder per typo (R2 free tier is 10 GB — bounded, but churn is
  waste; OQ-04 A).
- `show_source` toggle does **not** bump because the template links are relative and the
  `<base>` is injected serve-time (ADR 0008) — flipping the toggle only changes the rendered
  entry HTML, which purge refreshes. (If show_source were baked at render, every toggle would
  force a re-render + bump — that was OQ-14's deciding factor.)
- Old rev folders are retained for GC deferral (OQ-10, human decision pending): the free-tier
  math (10 GB; typical page + assets ≪ 1 GB) makes dozens of revs fine for personal use;
  manual cleanup guidance goes in docs/operations.

## Failure semantics (boundary)

- Worker error while refreshing a stale entry: with no `s-maxage`/`must-revalidate`/
  `proxy-revalidate` on the response, Cloudflare's default serves the last good cached entry
  (verified: stale-on-error default is on unless those directives are present). We rely on the
  default — a transient Worker failure degrades to serving the previous entry, not a 5xx.
  **Except protected pages (S23):** never cached, so a Worker failure surfaces as an error —
  the correct posture for gated content (a stale protected page must never be served).
- 5xx responses themselves are `no-store` and never poison the cache.

## Cross-references

- Spec: §3 (1+3 model), §8 (`rev`), §11 (caching behavior), §12 (vars), §17 (per-page password).
- Docs: [03 — Data model](03-data-model.md) (rev semantics, key layout, page_unlocks),
  [05 — Error handling](05-error-handling.md), [06 — Test strategy](06-test-strategy.md).
- ADRs: 0006 (caching/rev decision), 0009 (cache seam / testability),
  0041 (S23 — `protected` route class, no-store surface, purge-on-password-change).
