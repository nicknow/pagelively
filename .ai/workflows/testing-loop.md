# Workflow: the testing loop

The test-first discipline in practice. Applies to every slice.

## Order of writing

1. Read the slice's acceptance criteria; enumerate the cases:
   - happy path;
   - edge cases (boundaries, empties, collisions, unicode, casing);
   - failure modes (404s, invalid input, missing bindings, malformed tokens).
2. Write the failing tests — one assertion per meaningful behavior, named for the behavior,
   not the implementation.
3. Run them: **confirm they fail** (a test that passes before implementation is either
   redundant or not actually exercising the behavior).
4. Implement the minimum to pass; resist gold-plating beyond the criteria.
5. Run the full suite + coverage; then hand to the validator for independent edge/regression
   tests.

## Gates (run before any slice closes)

```
npm test               # full suite (Vitest Workers pool — runs inside workerd)
npm run test:coverage  # coverage report + threshold
npm run typecheck      # src + test
npm run lint           # ESLint
npm run format:check   # Prettier
```

## Local emulation (this project)

- D1: real migrations applied per test file; assert against the real schema.
- R2: local object emulation; assert puts/gets and the `pages/{id}/{rev}/…` layout.
- Access/JWT: local keypairs + mock JWKS; cover valid / expired / wrong-`aud` / tampered.
- `setup.mjs`: Cloudflare API and Wrangler calls **mocked**; assert idempotency and correct
  parameters; the real run is a documented manual checklist.
- Infra seams that can't be unit-tested: extend `docs/operations/` smoke-test checklist, never
  fake a test.
