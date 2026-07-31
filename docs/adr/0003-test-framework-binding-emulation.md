# 0003: Test framework and binding emulation

- Status: accepted
- Date: 2026-07-31

## Context

The brief's testing requirements are strict: everything runs **locally with no cloud
account**, emulating Worker + R2 + D1 + KV, real D1 migrations in test setup, Access/JWT
verification with mock JWKS, and infra seams covered by an operator checklist rather than
faked. The roadmap (§8) names this as a Phase-2 ADR and asks for the final coverage threshold
(placeholder 80%).

Options considered: (a) Vitest + `@cloudflare/vitest-pool-workers` (Cloudflare-recommended,
seeded in Phase 0); (b) `wrangler dev` + `unstable_dev`-style spawned-Worker testing;
(c) plain Vitest with hand-mocked bindings (no real emulation).

## Decision

1. **Vitest 4.1.10 + `@cloudflare/vitest-pool-workers` 0.19.1** (latest at verification).
   Tests run inside `workerd` via Miniflare, fully locally, with **real emulated R2/D1/KV
   bindings** and per-test-file isolated storage. Configuration via the `cloudflareTest()`
   Vite plugin reading `wrangler.toml` (`wrangler.configPath`); integration tests dispatch
   through `exports.default.fetch(...)` from `cloudflare:workers`.
   Sources: <https://developers.cloudflare.com/workers/testing/vitest-integration/>,
   <https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/>,
   <https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-unstable-dev/>
2. **D1: real migrations in test setup.** `readD1Migrations(migrations/)` in
   `vitest.config.mts`, `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` in
   `test/apply-migrations.ts` (wired in Phase 0; ADR 0001). Tests assert against the actual
   schema, never a fixture copy.
3. **R2/KV: pool emulation, no mocks.** Real object-store round-trips incl. `httpMetadata`
   (S11); KV presence/absence both exercised (S14).
4. **Access/JWT: mock JWKS, no network.** The verifier depends on a `JwksProvider` (see
   `docs/architecture/02`); tests inject `jose`'s `createLocalJWKSet` built from locally
   generated RSA keypairs and run the full token matrix — valid, expired, wrong-`aud`,
   tampered, unknown-`kid`, missing, malformed — all failing closed (S16 AC; ADR 0005).
5. **`setup.mjs`: mocked API + CLI seams.** Its Cloudflare-API calls (injected `fetch`-shaped
   client) and wrangler subprocess invocations (injected runner) are mocked; idempotency and
   parameter correctness are asserted (S20 AC). It cannot be integration-tested without an
   account — the real run is the operator checklist (S22).
6. **Workers Caching is a contract seam, not an emulation target** — the pool does not emulate
   purge/HITs (spike evidence; ADR 0009). `CacheService` is dependency-injected; tests assert
   the contract; live behavior is the operator checklist.
7. **Coverage: istanbul provider** (the pool rejects the v8 provider — verified in pool
   source; ADR 0001) with **thresholds lines 85 / statements 85 / functions 85 / branches 80**
   over `src/**`. Rationale in `docs/architecture/08`; the placeholder 80% in
   `vitest.config.mts` is updated by this ADR. Current suite passes the new bar (100% at
   Phase 2 — verified by `npm run test:coverage`).

## Consequences

- One test runner and one runtime (workerd) for pure logic and binding integration — no dual
  configs, no drift between "unit" and "integration" environments.
- All gates run with zero accounts: `npm test`, `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run test:coverage`, `npm run build` (bundle-size gate).
- The JWKS mock keeps the crypto matrix honest without network flakiness; the emulation
  boundary (what the pool provides vs what is contracted) is documented in
  `docs/architecture/06` so future agents don't re-litigate it.
- Risk R13 (tooling drift) is mitigated by pinned versions and the "re-verify on upgrade"
  rule in the roadmap.
