# 06 — Test strategy

Everything runs **locally, no cloud account** (brief testing requirements; ADR 0003). Tests run
inside `workerd` via the Workers Vitest integration (`@cloudflare/vitest-pool-workers`), the
same pool for pure logic and binding integration — one runner, one config, real bindings
emulated per test file. What cannot be emulated is covered by **contract tests + the operator
smoke-test checklist** — never faked (test standards #5).

## The emulation stack (what "local" means here)

| Binding / API                   | How it's provided in tests                                                       | Notes                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker runtime                  | Vitest Workers pool (`workerd` via Miniflare)                                    | `cloudflareTest()` plugin reading `wrangler.toml` (verified docs: `wrangler.configPath`)                                                                         |
| D1                              | Real migrations applied per test file                                            | `readD1Migrations(migrations/)` in `vitest.config.mts` → `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` in `test/apply-migrations.ts` (already wired, Phase 0) |
| R2                              | Pool's local object emulation                                                    | Real `R2Bucket` API: put/get/delete/list, httpMetadata round-trips (S11)                                                                                         |
| KV                              | Pool's local namespace emulation                                                 | Present in tests even though the prod binding is optional — plus tests with `KV` absent (env without it)                                                         |
| Vars                            | `wrangler.toml [vars]`                                                           | Tests override via the pool's per-test env where needed (e.g. `HOME_MODE` matrix)                                                                                |
| Worker under test               | `exports.default.fetch(...)` from `cloudflare:workers`                           | Integration tests dispatch through the real entry handler (verified pattern in the migration guide)                                                              |
| Access JWKS                     | **No network**: `jose`'s `createLocalJWKSet` with locally generated RSA keypairs | The verifier depends on a `JwksProvider` (02); prod wraps `createRemoteJWKSet`, tests inject the local set — the crypto matrix is fully covered (below)          |
| Workers Caching                 | **Not emulated** (spike evidence → ADR 0009)                                     | Contract tests on `CacheService` (recording fake) + header assertions; live purge/HITs → operator checklist                                                      |
| `setup.mjs` Cloudflare API      | Mocked `fetch`-shaped API client (injected)                                      | Idempotency + parameter assertions (S20)                                                                                                                         |
| `setup.mjs` wrangler subprocess | Mocked process runner (injected)                                                 | Asserted command lines, no real CLI                                                                                                                              |

Isolation: the pool provides per-test-file isolated storage; migrations re-apply per file.
The `[cache] enabled = true` block is added to `wrangler.toml` in S13 with types regenerated
— the pool ignores it (no purge emulation), so existing tests are unaffected (spike-verified).

## JWT verification — the mock-JWKS matrix (S16 AC)

Test helper `test/helpers/jwt.ts`:

- `generateKeyPair()` → `crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign","verify"])`, exported as JWK.
- `buildJwks(keys)` → `{ keys: [...] }` (public JWKs only).
- `signToken({ key, kid, iss, aud, exp, email })` → compact JWS via `jose`'s `SignJWT`.

Matrix — every case must produce **403** (fail closed), plus the valid case → verified
identity with `email`:

| Case           | Construction                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------- |
| valid          | correct key/kid, `iss = https://{team}`, `aud = ACCESS_AUD`, `exp = now + 1h`, `email` claim |
| expired        | same, `exp = now - 1h`                                                                       |
| wrong-aud      | same, `aud = "other-app"`                                                                    |
| tampered       | valid token, flip one character in the payload segment                                       |
| unknown-kid    | signed with a second keypair _not_ in the JWKS                                               |
| missing header | request with no `Cf-Access-Jwt-Assertion`                                                    |
| malformed      | `"not-a-jwt"`                                                                                |

Plus: `ACCESS_AUD` unset/placeholder → 403; JWKS fetch failure (provider throws) → 403; KV
miss/corrupt → refetch succeeds → valid passes (S14); KV absent → fetch every time (still
passes valid, 403s everything else).

## Layer coverage (what tests what)

| Layer               | How                                                 | Covers                                                                                                                                                                                         |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure unit           | direct imports of `src/*` pure modules              | S01–S09: ids, slugify/reserved, rev, base injection, markdown pipeline, content types, cache headers, redirects, home mode — exhaustive table tests, malformed-input cases                     |
| Repository          | pool D1/R2 emulation                                | S10/S11: real schema, index-covered queries, key layout, httpMetadata, paginated delete                                                                                                        |
| Handler/integration | `exports.default.fetch` with real emulated bindings | S12–S19: full request pipeline, purge adapter call shapes, JWT gate end-to-end, multipart uploads, rev bumps                                                                                   |
| Contract (seams)    | injected fakes                                      | CacheService purge calls (ADR 0009); JwksProvider; setup.mjs API/CLI mocks (S20)                                                                                                               |
| E2E local           | one journey test (S22)                              | create html page → slug+id URLs serve → bundle with nested assets → markdown with show-source → edit slug → delete (rows+objects gone); home modes; reserved slug rejection through UI→API→4xx |

## Slice → module map (implementer's guide)

| Slice | Modules under test                                                                  |
| ----- | ----------------------------------------------------------------------------------- |
| S01   | router.ts, ids.ts, slug.ts (classify/generate/validate)                             |
| S02   | slug.ts (reserved words)                                                            |
| S03   | rev.ts                                                                              |
| S04   | base-inject.ts                                                                      |
| S05   | markdown.ts, template.ts (+ bundle-size gate `npm run build`)                       |
| S06   | content-type.ts                                                                     |
| S07   | cache-headers.ts                                                                    |
| S08   | redirects.ts, router.ts                                                             |
| S09   | home.ts                                                                             |
| S10   | pages-repository.ts, files-repository.ts                                            |
| S11   | object-store.ts                                                                     |
| S12   | index.ts, entry-serve.ts, errors.ts, config.ts                                      |
| S13   | cache-service.ts (contract), cache-headers.ts, index.ts (header assertions)         |
| S14   | jwks-provider.ts (KV-backed)                                                        |
| S15   | admin-api.ts (list/detail), index.ts (gate end-to-end)                              |
| S16   | access-verify.ts, jwks-provider.ts, helpers/jwt.ts matrix                           |
| S17   | admin-api.ts (create), form-parser.ts, object-store.ts, errors.ts (413/400/409)     |
| S18   | admin-api.ts (patch/delete/files), rev.ts, pages-repository.ts, files-repository.ts |
| S19   | admin-ui.ts (handler-level HTML assertions)                                         |
| S20   | setup.mjs (mocked API + CLI), wrappers exist                                        |
| S21   | workflow YAML parse + README content                                                |
| S22   | E2E journey + `docs/operations/smoke-test-checklist.md`                             |

## Infra seams that cannot be unit-tested — operator checklist (S22 deliverable)

These are verified against the real deployment by the human (via the `deployer` agent), not
pretended-tested:

1. **R2-CDN public serving**: `GET https://cdn.pages.acme.com/pages/{id}/{rev}/…` returns the
   object with the stored content type + `Cache-Control: public, max-age=31536000, immutable`;
   a second request shows `cf-cache-status: HIT` on the CDN host; non-default asset types
   (fonts etc.) served cached — if not, the Cache Everything rule is required (verified: R2
   custom-domain caching covers only default file types unless a rule exists).
2. **Worker custom domain + DNS**: `pages.acme.com` resolves, cert issued, `{slug}` URLs work.
3. **Live Access**: login flow appears on `/admin`; after login the dashboard loads and the
   Worker's JWT gate verified (email shown); `/api/pages` with a forged/expired token → 403.
4. **Entry `Cf-Cache-Status`**: second hit on the same entry URL → `HIT`; during the SWR
   window after max-age expiry → `UPDATING` (needs wrangler ≥ 4.69.0 and `cache.enabled` in the
   deployed config — verified).
5. **Purge-on-publish freshness**: publish an edit, immediately re-fetch the entry URL → new
   content (tag purge worked); both `/{slug}/` and `/p/{id}/` refreshed.
6. **Free-tier quota verification**: Workers 100k req/day, D1 5 M rows read / 100 k written per
   day, R2 10 GB / 1 M + 10 M ops, KV 100 k reads / 1 k writes / 1 k deletes per day — confirm
   the plan values still hold at launch (spec §3 "verify before launch"; roadmap §6).
7. **`setup.mjs` provisioning**: real run is idempotent (double-run creates nothing), Access
   app over `/admin*` + `/api/*` with the email policy, AUD captured, CDN domain connected,
   `ASSET_BASE_URL` written.

The checklist document lives at `docs/operations/smoke-test-checklist.md` (produced in S22;
`docs/operations/README.md` already reserves it).

## Coverage & gates

- Threshold (ADR 0003, doc 08): **lines 85, statements 85, functions 85, branches 80** over
  `src/**` (istanbul provider — the pool rejects v8 coverage; verified in pool source, ADR 0001).
- Per-slice gates: `npm test` (full suite), `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run test:coverage` (threshold), `npm run build` (bundle-size
  gate from S05; 3 MB compressed free limit — verified).
- `setup.mjs` is excluded from coverage (`include: ["src/**"]`) — its tests are mock-based
  (S20) by necessity, and the coverage bar applies to Worker code.

## Cross-references

- Spec: §9 (JWT), §11 (caching), §13 (setup), §15 (limits).
- Docs: [02 — Module boundaries](02-module-boundaries-contracts.md) (seams),
  [08 — Coverage threshold](08-coverage-threshold.md).
- ADRs: 0003 (test framework/emulation), 0009 (cache seam outcome).
- Test standards: `.ai/standards/test-standards.md` (rules 1–5).
