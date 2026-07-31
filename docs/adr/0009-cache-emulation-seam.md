# 0009: Cache emulation seam — Workers Caching contract tests

- Status: accepted
- Date: 2026-07-31

## Context

The test strategy requires everything to run locally with no cloud account (brief; ADR 0003),
and ADR 0006 commits to `Cache-Tag` + `ctx.cache.purge` for invalidation. The question: how
do tests verify purge behavior when there is no real Workers Caching locally?

A Phase-2 spike probed the emulation surface (full evidence:
`.work/architect/spike-cache-emulation.md`):

1. `cloudflare:workers` `cache` is **empty in the Vitest pool** — no purge/noop interface.
2. Miniflare exposes only the Cache API plugin (`cache?: boolean`), which does not cover the
   Workers Caching `ctx.cache.purge` surface.
3. A loopback `fetch` probe crashed workerd — not a usable path.
4. No pool option exposes tag purge.

## Decision

1. **`CacheService` is a dependency-injected seam** (interface in
   `docs/architecture/02`): `purgePage(id)`, `purgePages(ids)`, plus `headersFor(routeClass)`
   policy. Handlers receive it via factory; production wires
   `ctx.cache.purge({ tags: [...] })`; **tests inject a recording fake**.
2. **Contract tests** (S13 AC) assert, per mutation in the purge matrix (ADR 0006):
   - purge calls made with exactly `{ tags: ["page-{id}"] }` for the mutated page(s) (and
     only the mutated page(s));
   - purge **not** called for metadata-only edits (no rev bump, no purge);
   - `Cache-Control`/`Cache-Tag` headers on served responses (entry classes, 404 no-store,
     5xx no-store — ADR 0005);
   - purge failure is swallowed (non-fatal post-write rule, ADR 0005 rule 6) and logged.
3. **What is NOT claimed by tests**: actual cache HITs, tag-match invalidation, SWR behavior
   at the edge. These are inherently platform behaviors (Workers Caching at the edge, CDN
   rules, SWR semantics) and are covered by the **operator smoke-test checklist**
   (`docs/operations/smoke-test-checklist.md`, S22; index in `docs/architecture/06`).
4. **`[cache] enabled = true` is inert for tests**: the pool ignores it (spike-verified), so
   the S13 config change does not break the existing suite; it affects only real deploys and
   the operator checklist.

## Consequences

- The purge contract is fully tested locally with no accounts; the seam keeps tests honest
  (no pretend testing — test standards #5) and gives implementers an exact interface.
- Live invalidation correctness is an explicit, human-run verification step — a documented
  residual gap (brief's "cannot be unit-tested" list), not a hidden one.
- If Miniflare ever adds tag-purge emulation, only the `CacheService` factory and the S13
  contract tests change — the module boundary absorbs the tooling improvement.
