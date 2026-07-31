# Test standards

How we test Pagelively. All tests run **locally, no cloud account**, using the Workers Vitest
integration (tests run inside `workerd` via Miniflare) — see the toolchain ADR and
`docs/development/README.md`.

## The rules

1. **Test-first.** For every slice, write failing tests derived from the acceptance criteria
   (happy path + edge cases + failure modes) _before_ implementing. The implementer never adds
   behavior without a test that exercises it.
2. **No skipped/failing tests at the gate.** A slice is not done with a skipped or failing test,
   or with reduced coverage, to move faster.
3. **Assert against the real schema.** D1 tests run the actual `migrations/*.sql` into each test
   file's isolated local database (`test/apply-migrations.ts`) and assert against it.
4. **Emulate, don't mock the platform.** R2/D1/KV come from the pool's local emulation. Mock
   only what cannot be emulated: the Access JWKS endpoint (mock JWKS + locally generated
   keypairs), `setup.mjs`'s Cloudflare API and Wrangler calls, and the edge cache.
5. **Infra seams are not faked.** R2-CDN serving, live Access, and custom domains are covered by
   the operator smoke-test checklist in `docs/operations/`, not by pretending to test them.

## Coverage targets

- Logic-heavy, infra-light units get the most coverage: slug/id resolution, reserved-word
  validation, `rev` handling, `<base>`-tag injection, Markdown rendering, content-type mapping,
  cache-header construction, trailing-slash redirects, home-mode behavior.
- The project coverage threshold is agreed in the architecture phase (placeholder 80% in
  `vitest.config.mts`); `npm run test:coverage` reports it.

## JWT / Access testing

Do **not** require real Cloudflare Access. Verify the Worker's JWT check with locally generated
keypairs and a mock JWKS covering: valid, expired, wrong-`aud`, and tampered tokens.

## Where tests live

- `test/*.test.ts` — suite run by `npm test` (Vitest Workers pool).
- `test/apply-migrations.ts` — setup: applies D1 migrations per test file.
- `test/env.d.ts` — augments the pool's `ProvidedEnv` with the project's `Env`.
