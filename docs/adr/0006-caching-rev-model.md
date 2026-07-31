# 0006: Caching model and the `rev` cache-busting scheme

- Status: accepted
- Date: 2026-07-31

## Context

The spec (§11) requires stale-while-revalidate caching of `/{slug}/` and `/p/{id}/`, per-page
`Cache-Tag` purge, `cache.cross_version_cache` kept off (cold cache per deploy), and requires
the Worker to issue `Cache-Control` headers at serve time (no CDN rules). It prescribes
`rev` in the data model for immutable content delivery. The roadmap (§8) asks for an ADR on
the caching model + `rev` semantics. Verified platform constraints: Workers Caching is
configured via `[cache] enabled = true` in `wrangler.toml` (needs Wrangler ≥ 4.69.0) and
applies to every `fetch()` from the Worker
(<https://developers.cloudflare.com/workers/cache/configuration/>); purging uses
`ctx.cache.purge({ tags: [...] })` (<https://developers.cloudflare.com/workers/cache/>);
**the Cache API is not available for Workers fronted by Cloudflare Access**, so the Workers
Caching config + `Cache-Control` headers are the only Worker-side caching surface
(<https://developers.cloudflare.com/workers/runtime-apis/cache/>); and `s-maxage` combined
with revalidation directives disables SWR per RFC 9111 §5.2.2.10
(<https://developers.cloudflare.com/cache/concepts/revalidation/#controlling-stale-behavior>).
The Phase-2 spike proved the pool does not emulate Workers Caching purge (ADR 0009).

## Decision

1. **Entry responses** (`/{slug}/`, `/p/{id}/`, home): `Cache-Control: public, max-age=300,
stale-while-revalidate=3600` + `Cache-Tag: page-{id}` (+ home tag). **Never emit
   `s-maxage`** — it disables SWR. Other route classes (redirects, admin, API, 404) have
   their own headers — full table in `docs/architecture/04`.
2. **Config**: `[cache] enabled = true` added to `wrangler.toml` in S13, then
   `npm run types` regenerates `worker-configuration.d.ts` (ADR 0001 discipline). Requires
   Wrangler ≥ 4.69.0 (already 4.116.0 — verified no upgrade needed).
3. **Purge-on-publish via `ctx.cache.purge({ tags: ["page-{id}"] })`** after every content
   mutation: create, slug PATCH, add/replace file, delete file, delete page, re-render
   (matrix in `docs/architecture/04`). Purge is best-effort (ADR 0005 rule 6).
4. **Cold cache per deploy**: keep `cache.cross_version_cache` off per spec; deployments
   accept a brief re-warm. Documented; operator checklist notes the expected cold-cache
   behavior after deploys.
5. **`rev` semantics** (spec §8):
   - `rev` is a monotonically increasing integer, bumped **only on content-affecting
     mutations** — adding/replacing/removing a file, editing markdown or entry (slug PATCH
     bumps; metadata-only edits do not).
   - **No page with `rev > 0` is ever mutated in place on R2**: every content change writes a
     fresh `pages/{id}/{rev}/…` object tree and atomically updates the row (S18 AC). This is
     what makes `rev` a safe cache-buster (immutable URLs).
   - R2 objects are stored with `httpMetadata`: `content_type` + `Cache-Control: public,
max-age=31536000, immutable` (S11 AC) — CDN-cached objects never need revalidation, which
     is why deleting old revs only matters for storage (spec §12; GC deferred to OQ-10).
   - Serve-time URL construction uses the row's current `rev`; no `<base>` interplay with rev
     (ADR 0008).
6. **Seam for testability**: `CacheService` (interface in `docs/architecture/02`) wraps tag
   purge + header policy; injected into handlers. Tests assert the contract (purge call
   shape `{ tags: ["page-{id}"] }` + headers) because the pool doesn't emulate purge (ADR
   0009). Live purge/HIT behavior is operator-checklist item 5.

## Consequences

- Entries get SWR freshness + fast purge invalidation with zero CDN-rule dependency (spec
  §11's "no rules" requirement holds); the Worker owns caching entirely.
- `rev` guarantees immutable object URLs for the CDN, so `immutable` caching is sound and
  object deletions are safe under the SWR window (only reachable via stale entry HTML, which
  itself self-heals).
- Deploys are cold-cache by design (spec-mandated); accepted cost: one re-warm per deploy.
- No unit test can prove purge/HIT — that is a documented operator step, not a gap
  (ADR 0009 consequences).
