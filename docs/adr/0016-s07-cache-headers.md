# 0016: S07 cache-header construction

- Status: accepted
- Date: 2026-07-31

## Context

The cache model was decided in ADR 0006 and detailed in `docs/architecture/04-caching-rev-model.md`.
The values are locked by OQ-01 (roadmap §5): entry/redirect responses use `Cache-Control: public,
max-age=300, stale-while-revalidate=3600` plus `Cache-Tag: page-{id}`; asset responses use
`public, max-age=31536000, immutable`; admin, 404, and error responses use `no-store`. The spec
§11 originally mentioned `s-maxage` + Cache API, but current Cloudflare docs (and RFC 9111) show
that `s-maxage`, `must-revalidate`, and `proxy-revalidate` disable stale-while-revalidate, so
they are forbidden.

S07's job is to turn that table into a typed, pure, unit-testable function that later slices
(S12, S13, S15) consume through the `CacheService` seam.

## Decision

1. New module `src/cache-headers.ts` exports:
   - `CacheRouteClass` union: `"entry" | "redirect" | "asset" | "admin" | "notFound" | "error"`.
   - `headersFor(routeClass, pageId?): Headers` — returns a fresh Web API `Headers` object.
2. The policy is a data table (`Record<CacheRouteClass, CachePolicy>`), not a long if-chain.
   Entry and redirect share the same SWR policy and both require `pageId` to form `Cache-Tag`.
3. Exact values (locked by OQ-01):
   - entry/redirect: `public, max-age=300, stale-while-revalidate=3600` + `Cache-Tag: page-{id}`
   - asset: `public, max-age=31536000, immutable`, no tag
   - admin, notFound, error: `no-store`, no tag
4. Defensive failures:
   - `entry` or `redirect` without `pageId` → `AppError("missing_page_id", 500)` (caller bug).
   - Unknown `routeClass` → `AppError("unknown_route_class", 500)` (fail-fast, ADR 0005).
   - Invalid `pageId` format is **not** this function's job; callers validate before calling
     (S15/S17/S18 caller discipline).
5. The function never emits `s-maxage`, `must-revalidate`, `proxy-revalidate`, or `private` on
   any class. Tests assert both the exact directives and the absence of the forbidden ones.
6. `CacheService.headersFor` (architecture 02) accepts the same `CacheRouteClass` union and
   delegates to the pure function; handlers in S12/S13/S15 use the seam, not the raw module.

## Consequences

- The cache policy lives in one auditable table and is fully unit-tested (32 tests in
  `test/cache-headers.test.ts`).
- Later slices have a stable source for response headers and can focus on routing/purge logic.
- The fail-fast errors protect against caller bugs (missing pageId) while keeping the function
  pure and Cloudflare-agnostic.
- The forbidden-directive tests make the SWR-killing semantics explicit and regression-proof.

## References

- Spec: §11 (public serving behavior), §3 (cost/caching/scaling).
- ADR 0006: caching model and `rev` cache-busting scheme.
- Architecture 04: route-class header policy table.
- Architecture 02: `CacheService` seam contract.
