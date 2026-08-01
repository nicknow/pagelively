# 0022: S13 — Entry-HTML edge cache integration

- Status: accepted
- Date: 2026-07-31

## Context

Slice S13 wires the production `CacheService` to the Workers Caching `ctx.cache.purge()` API
and enables caching in `wrangler.toml`. The decisions are small but worth recording because
they affect the deploy-time cache key, the test seam, and the operator checklist.

## Decision

1. **`[cache] enabled = true` is added to `wrangler.toml` at the top level.**
   The app has a single default entrypoint that serves both public entry pages and the admin
   API (architecture 02 enforces this). Because entry pages need caching and the admin/API
   responses carry `Cache-Control: no-store`, enabling caching on the default entrypoint is
   correct. Keeping admin and entry on the same entrypoint also satisfies the purge scope
   requirement: `ctx.cache.purge()` is entrypoint-scoped, so admin mutations must share the
   entrypoint with the public pages they invalidate.

2. **`CacheService.purgePage` calls `ctx.cache.purge({ tags: ["page-{id}"] })`.**
   The tag shape matches the `Cache-Tag: page-{id}` header that `headersFor("entry", pageId)`
   already emits (S07). `purgePages` maps the ids to the same tag shape and calls the same
   internal helper, so the batch is recorded as a single `purge` call.

3. **Purge failures are swallowed and logged.**
   The mutation that triggered the purge has already committed (D1/R2), so throwing here would
   turn a successful publish into a 500 for the operator. Instead, a failed or rejected purge
   is logged to `console.error` and the promise resolves. A missing `ctx.cache` (e.g., local
   Vitest pool) is handled the same way: logged, no throw.

4. **Local tests use a `createTestCacheService()` recording double.**
   The Vitest Workers pool does not emulate tag-based purges or HITs (ADR 0009). The test
   double exposes `getPurgeTags()` so tests can assert the exact purge contract without
   pretending to exercise the real cache.

5. **Live HITs remain an operator checklist item.**
   `Cf-Cache-Status: HIT` and purge-on-publish freshness cannot be asserted locally; they are
   covered by the operator smoke-test checklist (docs/operations/smoke-test-checklist.md).

## Consequences

- Deploys start with a cold cache per version (default cache key includes the Worker version;
  `cache.cross_version_cache` is intentionally left off). This is accepted per the spec and the
  operator checklist.
- The single-entrypoint rule is now a hard deploy constraint: splitting admin and entry into
  separate entrypoints would break purge-on-publish for entry pages unless each mutation
  called `purge()` from every cached entrypoint.
- The `CacheService` interface stays the same, so later slices (S15–S18) can call the same
  `purgePage`/`purgePages` methods without knowing about `ctx.cache`.

## Cross-references

- Spec: §11 (caching), §5 (single Worker host).
- Docs: `docs/development/roadmap.md` S13, `docs/operations/smoke-test-checklist.md` S13.
- ADRs: 0006 (caching/rev model), 0009 (cache emulation seam), 0021 (S12 entry pipeline).
- Code: `src/cache-service.ts`, `src/cache-headers.ts`, `src/entry-serve.ts`, `src/index.ts`,
  `wrangler.toml`.
